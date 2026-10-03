import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { remoteBackupPolicySchema, type RemoteBackupSource } from "@/server/modules/backups";
import { ResticBackupTransport } from "./restic-transport";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(mode = "healthy", repository = "rest:https://example.test/repo/") {
  const root = mkdtempSync(join(tmpdir(), "restic-adapter-")), script = join(root, "restic"), statePath = join(root, "state.json");
  const manifest = "{\"fixture\":true}";
  writeFileSync(statePath, JSON.stringify({ mode, snapshots: [], calls: [], manifest }));
  writeFileSync(script, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
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
 state.snapshots.push(snapshot);save();console.log(JSON.stringify({message_type:'summary',snapshot_id:snapshot.id}));if(snapshot.partial)process.exit(3);
}
else if(command==='dump') {save();process.stdout.write(state.mode==='wrong-manifest'?'{}':state.manifest);}
else if(command==='ls') {
 const snapshot=state.snapshots.find(x=>x.id===args[args.indexOf('ls')+1]);save();
 console.log(JSON.stringify({struct_type:'snapshot',id:snapshot.id}));
 console.log(JSON.stringify({type:'dir',path:'/attachments'}));
 console.log(JSON.stringify({type:'file',path:'/manifest.json',size:Buffer.byteLength(state.manifest)}));
 if(!snapshot.partial)console.log(JSON.stringify({type:'file',path:'/state.sqlite3',size:4}));
}
else {save();process.exit(1);}
`, { mode: 0o700 });
  const transport = new ResticBackupTransport({ configuration: { executable: script, repository, repositoryId: "a".repeat(64), passwordFile: join(root, "key"), credentialsFile: join(root, "credentials"), uploadKiBPerSecond: 20, policy: remoteBackupPolicySchema.parse({ timeoutSeconds: 1 }) }, credentials: { username: "fixture-user", password: "fixture-secret" } });
  const source: RemoteBackupSource = { source: root, installationId: crypto.randomUUID(), backupId: `backup-${crypto.randomUUID()}`, manifestSha256: createHash("sha256").update(manifest).digest("hex"), files: [{ path: "/manifest.json", size: Buffer.byteLength(manifest) }, { path: "/state.sqlite3", size: 4 }] };
  const state = () => JSON.parse(readFileSync(statePath, "utf8"));
  const change = (mode: string) => { writeFileSync(statePath, JSON.stringify({ ...state(), mode })); };
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => transport.close());
  return { root, transport, source, state, change };
}
describe("shell-free restic adapter", () => {
  it("streams over 1 MiB of valid progress without retaining it or losing the summary", async () => {
    const f = fixture("progress"); expect((await f.transport.upload(f.source)).snapshotId).toBe("1".padStart(64, "0"));
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
    const complete = await f.transport.upload(f.source); expect(complete.snapshotId).toBe("2".padStart(64, "0"));
    expect(f.state().snapshots).toHaveLength(2); expect(await f.transport.upload(f.source)).toEqual(complete); expect(f.state().snapshots).toHaveLength(2);
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
