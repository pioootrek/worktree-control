import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { remoteBackupPolicySchema, type RemoteBackupSource } from "@/server/modules/backups";
import { ResticBackupTransport } from "./restic-transport";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(mode = "healthy", repository = "rest:https://example.test/repo/", timeoutSeconds = 1) {
  const root = mkdtempSync(join(tmpdir(), "restic-adapter-")), script = join(root, "restic"), statePath = join(root, "state.json");
  const manifest = "{\"fixture\":true}";
  writeFileSync(statePath, JSON.stringify({ mode, snapshots: [], calls: [], manifest }));
  writeFileSync(script, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
import {once} from 'node:events';
const statePath=${JSON.stringify(statePath)};
const state=JSON.parse(readFileSync(statePath,'utf8')),args=process.argv.slice(2);
state.calls.push({args,environment:process.env});
const save=()=>writeFileSync(statePath,JSON.stringify(state));
const command=args.find(x=>['cat','snapshots','backup','dump','ls'].includes(x));
if(state.mode==='timeout') {save();setTimeout(()=>process.exit(0),10000);}
else if(state.mode==='oversized') {save();process.stdout.write('x'.repeat(2*1024*1024));}
else if(command==='cat') {save();console.log(JSON.stringify({id:state.mode==='wrong-repository'?'c'.repeat(64):'a'.repeat(64)}));}
else if(command==='snapshots') {save();console.log(JSON.stringify(state.snapshots));}
else if(command==='backup') {
 if(state.mode==='progress')for(let i=0;i<12000;i++)process.stdout.write(JSON.stringify({message_type:'status',current_files:['x'.repeat(100)]})+'\\n');
 const snapshot={id:String(state.snapshots.length+1).padStart(64,'0'),tree:'b'.repeat(64),hostname:args[args.indexOf('--host')+1],paths:[process.cwd()],tags:args[args.indexOf('--tag')+1].split(','),partial:state.mode==='partial'};
 state.snapshots.push(snapshot);save();console.log(JSON.stringify({message_type:'summary',snapshot_id:snapshot.id}));if(snapshot.partial||state.mode==='lost-upload-reply')process.exit(3);
}
else if(command==='dump') {save();process.stdout.write(state.mode==='wrong-manifest'?'{}':state.manifest);if(state.mode==='dump-failure')process.exit(1);}
else if(command==='ls') {
 const snapshot=state.snapshots.find(x=>x.id===args[args.indexOf('ls')+1]);save();
 console.log(JSON.stringify({struct_type:'snapshot',id:snapshot.id}));
 console.log(JSON.stringify({type:'dir',path:'/attachments'}));
 console.log(JSON.stringify({type:'file',path:'/manifest.json',size:Buffer.byteLength(state.manifest)}));
 if(!snapshot.partial)console.log(JSON.stringify({type:'file',path:'/state.sqlite3',size:4}));
 if(state.mode==='big-tree')for(let i=0;i<24000;i++){const line=JSON.stringify({type:'dir',path:'/extra-'+i+'-'+('x'.repeat(1600))})+'\\n';if(!process.stdout.write(line))await once(process.stdout,'drain');}
 if(state.mode==='ls-failure')process.exit(1);
 if(state.mode==='truncated-ls')process.stdout.write('{');
}
else {save();process.exit(1);}
`, { mode: 0o700 });
  const transport = new ResticBackupTransport({ configuration: { executable: script, repository, repositoryId: "a".repeat(64), passwordFile: join(root, "key"), credentialsFile: join(root, "credentials"), uploadKiBPerSecond: 20, policy: remoteBackupPolicySchema.parse({ timeoutSeconds }) }, credentials: { username: "fixture-user", password: "fixture-secret" } });
  const source: RemoteBackupSource = { source: root, installationId: crypto.randomUUID(), backupId: `backup-${crypto.randomUUID()}`, manifestSha256: createHash("sha256").update(manifest).digest("hex"), files: [{ path: "/manifest.json", size: Buffer.byteLength(manifest) }, { path: "/state.sqlite3", size: 4 }] };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const change = (mode: string) => { writeFileSync(statePath, JSON.stringify({ ...state(), mode })); };
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => transport.close());
  return { root, transport, source, state, change };
}
describe("shell-free restic adapter", () => {
  it("streams over 1 MiB of valid progress without retaining it or losing the summary", async () => {
    const f = fixture("progress"); const result = await f.transport.upload(f.source); expect("snapshotId" in result && result.snapshotId).toBe("1".padStart(64, "0"));
    expect(f.state().snapshots).toHaveLength(1);
  });
  it("binds the fence to repository identity across normalized or changed HTTPS locators", () => {
    const original = fixture();
    for (const locator of ["rest:https://EXAMPLE.test:443/repo", "rest:https://moved.test:9443/new-path/"]) {
      expect(fixture("healthy", locator).transport.destinationId).toBe(original.transport.destinationId);
    }
  });
  it("reconciles the stable complete identity and authenticates both manifest and full inventory", async () => {
    const f = fixture(); const first = await f.transport.upload(f.source), retry = await f.transport.upload(f.source);
    expect(retry).toEqual(first); expect(f.state().snapshots).toHaveLength(1);
    const commands = f.state().calls.map((value: { args: string[] }) => value.args);
    expect(commands.filter((args: string[]) => args.includes("backup"))).toHaveLength(1);
    expect(commands.some((args: string[]) => args.includes("dump"))).toBe(true); expect(commands.some((args: string[]) => args.includes("ls"))).toBe(true);
  });
  it("does not confirm a partial snapshot after exit3 and can retry to one complete point", async () => {
    const f = fixture("partial"); await expect(f.transport.upload(f.source)).rejects.toThrow("remote_failed");
    expect(f.state().snapshots).toHaveLength(1); f.change("healthy");
    const complete = await f.transport.upload(f.source); expect("snapshotId" in complete && complete.snapshotId).toBe("2".padStart(64, "0"));
    expect(f.state().snapshots).toHaveLength(2); expect(await f.transport.upload(f.source)).toEqual(complete); expect(f.state().snapshots).toHaveLength(2);
  });
  it.each([false, true])("continues >32 authenticated partials without deleting history (older complete=%s)", async olderComplete => {
    const f = fixture("healthy", undefined, 15);
    const tags = [`wts-installation:${f.source.installationId}`, `wts-backup:${f.source.backupId}`, `wts-manifest:${f.source.manifestSha256}`];
    const candidates = Array.from({ length: 40 }, (_, index) => ({ id: String(index + 1).padStart(64, "0"), tree: "b".repeat(64), hostname: `wts-${f.source.installationId}`, paths: [f.source.source], tags, partial: !olderComplete || index !== 0 }));
    writeFileSync(join(f.root, "state.json"), JSON.stringify({ ...f.state(), snapshots: candidates.reverse() }));
    const first = await f.transport.upload(f.source); expect("progress" in first).toBe(true);
    if (!("progress" in first)) throw new Error("Expected continuation");
    expect(first.proofs).toHaveLength(32); expect(first.uploadAttempted).toBe(false);
    // Persisted proof order survives a reordered inventory between invocations.
    writeFileSync(join(f.root, "state.json"), JSON.stringify({ ...f.state(), snapshots: candidates.reverse() }));
    const second = await f.transport.upload({ ...f.source, reconciliation: { passes: 2, readReservedBytes: 512 * 1024 * 1024, proofs: first.proofs, inventoryHash: first.inventoryHash } });
    expect("snapshotId" in second).toBe(true);
    if (!("snapshotId" in second)) throw new Error("Expected confirmation");
    expect(second.snapshotId).toBe(String(olderComplete ? 1 : 41).padStart(64, "0"));
    expect(f.state().snapshots).toHaveLength(olderComplete ? 40 : 41);
    expect(f.state().calls.filter((call: { args: string[] }) => call.args.includes("backup"))).toHaveLength(olderComplete ? 0 : 1);
    expect(f.state().calls.some((call: { args: string[] }) => call.args.includes("forget") || call.args.includes("prune"))).toBe(false);
  }, 30000);
  it.each(["duplicate", "multiple-complete", "overflow"])("refuses unsafe inventory before creating another point: %s", async mode => {
    const f = fixture("healthy", undefined, 15);
    const snapshot = { id: "1".padStart(64, "0"), tree: "b".repeat(64), hostname: `wts-${f.source.installationId}`, paths: [f.source.source], tags: [`wts-installation:${f.source.installationId}`, `wts-backup:${f.source.backupId}`, `wts-manifest:${f.source.manifestSha256}`], partial: false };
    const snapshots = mode === "duplicate" ? [snapshot, snapshot] : Array.from({ length: mode === "overflow" ? 257 : 2 }, (_, index) => ({ ...snapshot, id: String(index + 1).padStart(64, "0") }));
    writeFileSync(join(f.root, "state.json"), JSON.stringify({ ...f.state(), snapshots }));
    await expect(f.transport.upload(f.source)).rejects.toThrow("remote_failed");
    expect(f.state().calls.some((call: { args: string[] }) => call.args.includes("backup"))).toBe(false);
  });
  it.each(["ls-failure", "truncated-ls", "dump-failure"])("never returns partial proof or writes after an unknown authenticated read: %s", async mode => {
    const f = fixture(); await f.transport.upload(f.source); f.change(mode);
    await expect(f.transport.upload(f.source)).rejects.toThrow(/^remote_failed$/);
    expect(f.state().snapshots).toHaveLength(1);
    expect(f.state().calls.filter((call: { args: string[] }) => call.args.includes("backup"))).toHaveLength(1);
  });
  it("reconciles a lost upload reply after a durable inventory fence only through explicit renewal", async () => {
    const f = fixture("lost-upload-reply", undefined, 15);
    const tags = [`wts-installation:${f.source.installationId}`, `wts-backup:${f.source.backupId}`, `wts-manifest:${f.source.manifestSha256}`];
    const snapshots = Array.from({ length: 33 }, (_, index) => ({ id: String(index + 1).padStart(64, "0"), tree: "b".repeat(64), hostname: `wts-${f.source.installationId}`, paths: [f.source.source], tags, partial: true }));
    writeFileSync(join(f.root, "state.json"), JSON.stringify({ ...f.state(), snapshots }));
    const first = await f.transport.upload(f.source); if (!("progress" in first)) throw new Error("Expected progress");
    const source = { ...f.source, reconciliation: { passes: 2, readReservedBytes: 512 * 1024 * 1024, proofs: first.proofs, inventoryHash: first.inventoryHash } };
    await expect(f.transport.upload(source)).rejects.toThrow("remote_failed");
    expect(f.state().snapshots).toHaveLength(34);
    await expect(f.transport.upload(source, { reconcileOnly: true })).rejects.toThrow("remote_inventory_changed");
    const renewed = await f.transport.upload({ ...source, reconciliation: { ...source.reconciliation, inventoryHash: undefined } });
    expect("snapshotId" in renewed && renewed.snapshotId).toBe("34".padStart(64, "0"));
    expect(f.state().calls.filter((call: { args: string[] }) => call.args.includes("backup"))).toHaveLength(1);
  }, 30000);
  it("supports >32MiB authenticated listings while bounding aggregate reads and returning continuation", async () => {
    const f = fixture("big-tree", undefined, 30);
    const tags = [`wts-installation:${f.source.installationId}`, `wts-backup:${f.source.backupId}`, `wts-manifest:${f.source.manifestSha256}`];
    const snapshots = Array.from({ length: 10 }, (_, index) => ({ id: String(index + 1).padStart(64, "0"), tree: "b".repeat(64), hostname: `wts-${f.source.installationId}`, paths: [f.source.source], tags, partial: true }));
    writeFileSync(join(f.root, "state.json"), JSON.stringify({ ...f.state(), snapshots }));
    const result = await f.transport.upload(f.source); if (!("progress" in result)) throw new Error("Expected bounded continuation");
    expect(result.proofs.length).toBeGreaterThan(0); expect(result.proofs.length).toBeLessThan(10);
    expect(result.uploadAttempted).toBe(false);
    expect(f.state().calls.some((call: { args: string[] }) => call.args.includes("backup"))).toBe(false);
  }, 45000);
  it("reserves global evidence slots before any upload", async () => {
    const f = fixture(); await expect(f.transport.upload({ ...f.source, proofLimit: 0 })).rejects.toThrow("remote_failed");
    expect(f.state().calls.some((call: { args: string[] }) => call.args.includes("backup"))).toBe(false);
  });
  it("never authorizes a new snapshot during read-only final-attempt reconciliation", async () => {
    const f = fixture(); await expect(f.transport.upload(f.source, { reconcileOnly: true })).rejects.toThrow("remote_failed");
    expect(f.state().snapshots).toHaveLength(0);
  });
  it.each(["wrong-repository", "wrong-manifest", "timeout", "oversized"])("bounds failures and returns no raw stderr, credentials or commands: %s", async mode => {
    const f = fixture(mode); await expect(f.transport.upload(f.source)).rejects.toThrow(/^remote_failed$/);
    if (mode === "wrong-repository") expect(f.state().snapshots).toHaveLength(0);
  });
  it("does not inherit ambient repository/password commands/proxy/hooks and hides credentials from argv", async () => {
    const f = fixture(); const previous = process.env.RESTIC_PASSWORD_COMMAND; process.env.RESTIC_PASSWORD_COMMAND = "bad command";
    try { await f.transport.upload(f.source); }
    finally { if (previous === undefined) delete process.env.RESTIC_PASSWORD_COMMAND; else process.env.RESTIC_PASSWORD_COMMAND = previous; }
    const calls = f.state().calls;
    expect(Object.keys(calls[0].environment).sort()).toEqual(["GOMAXPROCS", "NODE_ENV", "RESTIC_PROGRESS_FPS", "RESTIC_PASSWORD_FILE", "RESTIC_REPOSITORY", "RESTIC_REST_PASSWORD", "RESTIC_REST_USERNAME"].sort());
    expect(calls[0].environment.RESTIC_PROGRESS_FPS).toBe("1");
    expect(calls.some((value: { args: string[] }) => value.args.join(" ").includes("fixture-secret"))).toBe(false);
  });
  it("cancels only the active child and waits for exit", async () => {
    const f = fixture("timeout"); const pending = f.transport.upload(f.source); const rejected = expect(pending).rejects.toThrow("remote_failed");
    await f.transport.close(); await rejected;
    await expect(f.transport.upload(f.source)).rejects.toThrow("remote_failed");
  });
});
