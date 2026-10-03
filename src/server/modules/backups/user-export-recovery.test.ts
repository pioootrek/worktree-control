import * as sqliteValidation from "@/server/infrastructure/sqlite";
import { userScheduleMutationKey } from "@/shared/contracts/user-backups";
import { randomUUID } from "node:crypto";
import fs, { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { BackupOperations, backupPolicySchema, UserSchedules, userBackupPolicySchema } from "./index";
import { readRecord, recordHash, writeRecord } from "./records";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(root = mkdtempSync(join(tmpdir(), "user-recovery-")), bodySize = 700_000) {
  let now = Date.now(), maintenance = false;
  const backups = new BackupOperations(backupPolicySchema.parse({}), { databasePath: join(root, "state.sqlite3"), attachmentDirectory: join(root, "attachments"), applicationVersion: "test", source: { backup: async () => {} }, estimateBytes: () => 1, authorize: () => true, maintenance: () => maintenance, clock: () => now });
  const policy = userBackupPolicySchema.parse({ enabled: true, scopes: ["knowledge-discussions"], projects: ["project"], targets: [{ id: "local", directory: join(root, "exports") }], minIntervalSeconds: 60, maxBytes: 1024 ** 2 });
  const deps = { authorize: () => {}, projectName: () => "Fixture", exportDiscussions: () => ({ body: "x".repeat(bodySize) }), clock: () => now };
  let schedules = new UserSchedules(policy, backups, deps);
  const actor = (principalId = "owner") => ({ principalId, principalKind: "owner" as const, credentialId: "fixture", authenticationMethod: "owner_session" as const });
  const save = (owner = "owner") => { const id = randomUUID(); return schedules.command(actor(owner), { action: "save", id, version: 0, idempotencyKey: userScheduleMutationKey(schedules.overview(actor(owner)).mutationGeneration, id, 0, randomUUID()), configuration: { projectId: "project", scope: "knowledge-discussions", targetId: "local", enabled: true, intervalSeconds: 60, retainCount: 1, retainDays: 1 } }); };
  const path = join(backups.recordDirectory, "user-schedules.json");
  const ledger = () => readRecord(path, z.any())!;
  const restart = () => { schedules.close(); schedules = new UserSchedules(policy, backups, deps); };
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => backups.close(), () => schedules.close());
  return { root, backups, deps, policy, actor, save, path, ledger, restart, advance: (ms = 60_000) => { now += ms; }, maintain: () => { maintenance = true; }, get schedules() { return schedules; } };
}

it("operator reclaims expired interrupted publication, frees owner quota and preserves other user and outcome", async () => {
  const timings = { readMs: 0, readCount: 0, syncMs: 0, syncCount: 0 };
  const read = sqliteValidation.readBoundedJson, sync = fs.fsyncSync;
  vi.spyOn(sqliteValidation, "readBoundedJson").mockImplementation((...args) => {
    const start = performance.now(); try { return read(...args); } finally { timings.readMs += performance.now() - start; timings.readCount++; }
  });
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { const start = performance.now(); try { sync(fd); } finally { timings.syncMs += performance.now() - start; timings.syncCount++; } });
  syncBuiltinESMExports();
  const start = performance.now();
  const f = fixture(); f.save(); f.advance(); f.schedules.tick(); await f.backups.drain();
  const ledger = f.ledger(), execution = ledger.executions[0], original = readFileSync(execution.destination);
  execution.state = "running"; execution.hash = null; execution.bytes = 0; execution.finishedAt = null;
  writeRecord(f.path, ledger); f.advance(600_000); f.restart();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("interrupted");
  f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0]).toMatchObject({ state: "failed", reason: "limit" });
  f.save("other"); f.advance(); f.schedules.tick(); await f.backups.drain();
  const other = f.ledger().executions.find((value: typeof execution) => value.configuration.ownerId === "other");
  const otherBytes = readFileSync(other.destination);
  expect(readFileSync(execution.destination).equals(original)).toBe(true);
  // The operator confirms the exact preview, retaining the original execution outcome.
  const recovery = { recover: async (actor: "local-admin", input: unknown) => await f.schedules.recover(actor, input) as View };
  const preview = await recovery.recover("local-admin", { action: "preview", executionId: execution.executionId });
  const done = await recovery.recover("local-admin", { action: "cleanup", executionId: execution.executionId, confirmation: preview.confirmation });
  expect(done.state).toBe("completed"); expect(existsSync(execution.destination)).toBe(false);
  expect(readFileSync(other.destination).equals(otherBytes)).toBe(true);
  expect(f.ledger().executions.find((value: typeof execution) => value.executionId === execution.executionId).state).toBe("interrupted");
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded");
  console.info("[DEBUG-pr73-recovery]", { ...timings, totalMs: performance.now() - start });
});


type Fixture = ReturnType<typeof fixture>;
type View = { executionId: string; confirmation: string; state: string; eligible: boolean; staging?: boolean; bytes: number };
const preview = async (f: Fixture, id: string) => await f.schedules.recover("local-admin", { action: "preview", executionId: id }) as View;
const reclaim = async (f: Fixture, view: View) => await f.schedules.recover("local-admin", { action: "cleanup", executionId: view.executionId, confirmation: view.confirmation }) as View;
async function interrupted(f: Fixture) {
  f.save(); f.advance(); f.schedules.tick(); await f.backups.drain();
  const ledger = f.ledger(), execution = ledger.executions[0];
  execution.state = "running"; execution.finishedAt = null; execution.hash = null; execution.bytes = 0;
  writeRecord(f.path, ledger); f.advance(600_000); f.restart();
  return execution;
}

it("reclaims a complete publication that finishes after its cooperative deadline without changing failed outcome", async () => {
  const f = fixture(); f.save();
  const remove = fs.rmSync;
  vi.spyOn(fs, "rmSync").mockImplementation((...args) => { remove(...args); if (String(args[0]).endsWith(".partial")) f.advance(31_000); }); syncBuiltinESMExports();
  f.advance(); f.schedules.tick(); await f.backups.drain();
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const execution = f.ledger().executions[0];
  expect(execution).toMatchObject({ state: "failed", reason: "limit" }); expect(existsSync(execution.destination)).toBe(true);
  f.advance(); f.schedules.tick(); await f.backups.drain(); expect(f.schedules.overview(f.actor()).artifacts[0].reason).toBe("limit");
  const original = f.ledger().executions.find((value: { executionId: string }) => value.executionId === execution.executionId);
  const view = await preview(f, execution.executionId); expect((await reclaim(f, view)).state).toBe("completed");
  expect(f.ledger().executions.find((value: { executionId: string }) => value.executionId === execution.executionId)).toEqual(original);
  f.advance(); f.schedules.tick(); await f.backups.drain(); expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded");
});

it("preserves both publication aliases after uncertain fsync, then reclaims exactly those two names", async () => {
  const f = fixture(); f.save(); const synchronize = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const directory = fs.fstatSync(fd);
    const ledger = readRecordWithoutSync(f.path), execution = ledger.executions[0];
    if (directory.isDirectory() && execution && existsSync(execution.destination) && existsSync(join(f.root, "exports", `.user-export-${execution.executionId}.partial`)) && directory.ino === lstatSync(join(f.root, "exports")).ino) throw new Error("injected publication fsync");
    synchronize(fd);
  }); syncBuiltinESMExports();
  f.advance(); f.schedules.tick(); await f.backups.drain();
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const execution = f.ledger().executions[0], staging = join(f.root, "exports", `.user-export-${execution.executionId}.partial`);
  expect(execution.state).toBe("failed"); expect(lstatSync(execution.destination).nlink).toBe(2); expect(existsSync(staging)).toBe(true);
  const view = await preview(f, execution.executionId); expect(view.staging).toBe(true);
  expect((await reclaim(f, view)).state).toBe("completed"); expect(existsSync(staging)).toBe(false); expect(existsSync(execution.destination)).toBe(false);
});

it("rejects queued and running executions at admission, without waiting for them to finish", async () => {
  const f = fixture(); let release!: () => void;
  f.backups.enqueueExport("blocker", 1, () => new Promise<void>(resolve => { release = resolve; }), () => {}); await Promise.resolve();
  f.save(); f.advance(); f.schedules.tick(); const queued = f.ledger().executions[0];
  await expect(preview(f, queued.executionId)).rejects.toThrow("changed");
  release(); await f.backups.drain();
  let running: Promise<unknown> | undefined;
  f.deps.exportDiscussions = () => { const id = f.ledger().executions.at(-1).executionId; running = preview(f, id).catch(error => error); return { body: "small" }; };
  f.advance(); f.schedules.tick(); await f.backups.drain(); expect(await running).toMatchObject({ code: "changed" });
  expect(await preview(f, f.ledger().executions.at(-1).executionId)).toMatchObject({ eligible: true, state: "succeeded" });
});

for (const field of ["ownerId", "scope", "projectId", "targetId", "scheduleId", "version", "executionId", "dueAt", "source", "checksum"]) it(`refuses a foreign or damaged ${field} in a historical publication`, async () => {
  const f = fixture(undefined, 32), execution = await interrupted(f), envelope = JSON.parse(readFileSync(execution.destination, "utf8"));
  unlinkSync(join(f.backups.recordDirectory, "user-export-recovery.json")); // Legacy artifact without a publication stamp.
  if (field === "checksum") envelope.sha256 = "0".repeat(64);
  else { envelope.payload[field] = field === "version" ? 999 : field.endsWith("Id") ? randomUUID() : "foreign"; envelope.sha256 = (await import("./records")).recordHash(envelope.payload); }
  writeFileSync(execution.destination, JSON.stringify(envelope)); const bytes = readFileSync(execution.destination); f.restart();
  await expect(preview(f, execution.executionId)).rejects.toThrow(); expect(readFileSync(execution.destination).equals(bytes)).toBe(true);
});

for (const kind of ["symlink", "hardlink", "extra-hardlink", "foreign-staging", "staging-symlink", "replacement", "corrupt", "directory-symlink", "directory-replacement"]) it(`refuses ${kind} and preserves every unrecognized name`, async () => {
  const f = fixture(), execution = await interrupted(f), view = await preview(f, execution.executionId), bytes = readFileSync(execution.destination);
  const target = join(f.root, "exports"), staging = join(target, `.user-export-${execution.executionId}.partial`), extra = join(f.root, "unknown.json");
  if (kind === "symlink") { renameSync(execution.destination, extra); symlinkSync(extra, execution.destination); }
  if (kind === "hardlink") linkSync(execution.destination, extra);
  if (kind === "extra-hardlink") { linkSync(execution.destination, extra); linkSync(execution.destination, staging); }
  if (kind === "foreign-staging") writeFileSync(staging, "foreign staging", { mode: 0o600 });
  if (kind === "staging-symlink") symlinkSync(execution.destination, staging);
  if (kind === "replacement") { renameSync(execution.destination, extra); writeFileSync(execution.destination, bytes, { mode: 0o600 }); }
  if (kind === "corrupt") writeFileSync(execution.destination, "corrupt");
  if (kind === "directory-symlink") { renameSync(target, join(f.root, "moved")); symlinkSync(join(f.root, "moved"), target); }
  if (kind === "directory-replacement") { renameSync(target, join(f.root, "moved")); fs.mkdirSync(target, { mode: 0o700 }); renameSync(join(f.root, "moved", `user-export-${execution.executionId}.json`), execution.destination); }
  await expect(reclaim(f, view)).rejects.toThrow(); expect(existsSync(execution.destination)).toBe(true);
  if (kind === "foreign-staging") expect(readFileSync(staging, "utf8")).toBe("foreign staging");
  if (kind === "replacement") expect(readFileSync(extra).equals(bytes)).toBe(true);
});

it("refuses a substituted inode before preview when publication identity is recorded", async () => {
  const f = fixture(), execution = await interrupted(f), bytes = readFileSync(execution.destination);
  renameSync(execution.destination, join(f.root, "original.json")); writeFileSync(execution.destination, bytes, { mode: 0o600 });
  await expect(preview(f, execution.executionId)).rejects.toThrow("changed");
});

it("accepts a valid historical publication only after exact preview, without touching protected backups", async () => {
  const f = fixture(), execution = await interrupted(f);
  unlinkSync(join(f.backups.recordDirectory, "user-export-recovery.json")); f.restart();
  const protectedNames = ["manual-backup.json", "pre-migration-v1.json", "service-backup.json", "restore-material.json", `user-export-${randomUUID()}.json`];
  for (const name of protectedNames) writeFileSync(join(f.root, "exports", name), "protected", { mode: 0o600 });
  const listed = await f.schedules.recover("local-admin", { action: "list" }) as View[];
  expect(listed.map(value => value.executionId)).toEqual([execution.executionId]);
  await expect(f.schedules.recover("local-admin", { action: "cleanup", executionId: execution.executionId, confirmation: "0".repeat(64), path: execution.destination })).rejects.toThrow("invalid");
  await reclaim(f, await preview(f, execution.executionId));
  for (const name of protectedNames) expect(readFileSync(join(f.root, "exports", name), "utf8")).toBe("protected");
});

it("rejects unauthorized actors, unknown IDs, unsafe permissions, unknown ledger paths and maintenance", async () => {
  const f = fixture(), execution = await interrupted(f);
  for (const actor of [f.actor(), { ...f.actor(), principalKind: "installation" as const, authenticationMethod: "installation_token" as const }, "scheduler" as const]) await expect(f.schedules.recover(actor, { action: "list" })).rejects.toMatchObject({ code: "forbidden", status: 403 });
  await expect(preview(f, randomUUID())).rejects.toMatchObject({ code: "invalid", status: 404 });
  chmodSync(execution.destination, 0o644); await expect(preview(f, execution.executionId)).rejects.toThrow(); chmodSync(execution.destination, 0o600);
  const ledger = f.ledger(); ledger.executions[0].destination = join(f.root, "restore-material.json"); writeRecord(f.path, ledger); f.restart();
  await expect(preview(f, execution.executionId)).rejects.toThrow();
  f.maintain(); await expect(f.schedules.recover("local-admin", { action: "list" })).rejects.toThrow("busy");
});

for (const boundary of ["intent", "unlink", "settlement"]) it(`keeps quota fenced on uncertain ${boundary} fsync and recovers after restart`, async () => {
  const f = fixture(), execution = await interrupted(f), view = await preview(f, execution.executionId), receiptPath = join(f.backups.recordDirectory, "user-export-recovery.json");
  const synchronize = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      const receipt = readRecordWithoutSync(receiptPath);
      if ((boundary === "unlink" && stat.ino === lstatSync(join(f.root, "exports")).ino && !existsSync(execution.destination))
        || (stat.ino === lstatSync(f.backups.recordDirectory).ino && receipt?.entries[0]?.phase === (boundary === "intent" ? "pending" : boundary === "settlement" ? "completed" : "never"))) throw new Error("injected fsync");
    }
    synchronize(fd);
  }); syncBuiltinESMExports();
  await expect(reclaim(f, view)).rejects.toThrow("injected fsync");
  vi.restoreAllMocks(); syncBuiltinESMExports();
  if (boundary !== "unlink") await expect(f.schedules.recover("local-admin", { action: "list" })).rejects.toThrow("busy");
  else { f.advance(); f.schedules.tick(); await f.backups.drain(); expect(f.schedules.overview(f.actor()).artifacts[0].reason).toBe("limit"); }
  f.restart(); const done = await reclaim(f, view); expect(done.state).toBe("completed"); expect(await reclaim(f, view)).toEqual(done);
  f.restart(); expect(await reclaim(f, view)).toEqual(done);
  f.advance(); f.schedules.tick(); await f.backups.drain(); expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded");
});
function readRecordWithoutSync(path: string) { return JSON.parse(readFileSync(path, "utf8")).payload; }

it("refuses replacements during pending recovery and does not unlink new data on completed replay", async () => {
  const f = fixture(), execution = await interrupted(f), view = await preview(f, execution.executionId), remove = fs.unlinkSync;
  vi.spyOn(fs, "unlinkSync").mockImplementation(path => { if (String(path) === execution.destination) throw new Error("injected stop"); remove(path); }); syncBuiltinESMExports();
  await expect(reclaim(f, view)).rejects.toThrow("injected stop"); vi.restoreAllMocks(); syncBuiltinESMExports();
  const original = join(f.root, "original.json"); renameSync(execution.destination, original); writeFileSync(execution.destination, "new data", { mode: 0o600 }); f.restart();
  await expect(reclaim(f, view)).rejects.toThrow("changed"); expect(readFileSync(execution.destination, "utf8")).toBe("new data");
  unlinkSync(execution.destination); renameSync(original, execution.destination); await reclaim(f, view);
  writeFileSync(execution.destination, "new data", { mode: 0o600 }); f.restart(); expect((await reclaim(f, view)).state).toBe("completed"); expect(readFileSync(execution.destination, "utf8")).toBe("new data");
});

for (const boundary of ["before-intent", "after-intent", "before-unlink", "after-unlink", "before-settle", "after-settle", "after-durable"]) it(`SIGKILL cleanup at ${boundary} resumes without double settlement`, async () => {
  const root = mkdtempSync(join(tmpdir(), "cleanup-crash-"));
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", new URL("./fixtures/user-cleanup-crash-worker.ts", import.meta.url).pathname, root, boundary], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });
  const f = fixture(root); expect(outcome, outcome.output).toMatchObject({ code: null, signal: "SIGKILL" });
  const [view] = JSON.parse(readFileSync(join(root, "confirmation.json"), "utf8")) as View[];
  const completed = ["after-settle", "after-durable"].includes(boundary);
  f.advance(600_000); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0]).toMatchObject(completed ? { state: "succeeded" } : { state: "failed", reason: "limit" });
  const before = f.ledger().executions.find((value: { executionId: string }) => value.executionId === view.executionId);
  const done = await reclaim(f, view); expect(done.state).toBe("completed"); expect(await reclaim(f, view)).toEqual(done);
  f.restart(); expect(await reclaim(f, view)).toEqual(done);
  expect(f.ledger().executions.find((value: { executionId: string }) => value.executionId === view.executionId)).toEqual(before);
  const mutationReceipts = f.ledger().mutations;
  if (!completed) { f.advance(); f.schedules.tick(); await f.backups.drain(); expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded"); }
  expect(f.ledger().mutations).toEqual(mutationReceipts);
});


it("bounds the recovery journal and refuses new intent without eviction or unlink at capacity", async () => {
  const f = fixture(undefined, 32), execution = await interrupted(f), view = await preview(f, execution.executionId), path = join(f.backups.recordDirectory, "user-export-recovery.json");
  const ledger = readRecordWithoutSync(path), original = ledger.entries[0];
  ledger.entries = Array.from({ length: 2048 }, () => ({ ...original, executionId: randomUUID(), phase: "pending" })); writeRecord(path, ledger); f.restart();
  await expect(reclaim(f, view)).rejects.toThrow("limit"); expect(existsSync(execution.destination)).toBe(true); expect(readRecordWithoutSync(path)).toEqual(ledger);
});

it("pins pending charge and execution beyond the ordinary recent-result pruning window", async () => {
  const f = fixture(), execution = await interrupted(f), view = await preview(f, execution.executionId), synchronize = fs.fsyncSync;
  vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory() && fs.fstatSync(fd).ino === lstatSync(join(f.root, "exports")).ino && !existsSync(execution.destination)) throw new Error("injected unlink fsync"); synchronize(fd);
  }); syncBuiltinESMExports(); await expect(reclaim(f, view)).rejects.toThrow("injected unlink fsync"); vi.restoreAllMocks(); syncBuiltinESMExports();
  const ledger = f.ledger();
  for (let i = 0; i < 60; i++) { const id = randomUUID(); ledger.executions.push({ ...execution, executionId: id, state: "failed", reason: "limit", destination: join(f.root, "exports", `user-export-${id}.json`) }); }
  writeRecord(f.path, ledger); f.restart(); f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.ledger().executions.some((value: { executionId: string }) => value.executionId === execution.executionId)).toBe(true); expect(f.schedules.overview(f.actor()).artifacts[0].reason).toBe("limit");
  expect((await reclaim(f, view)).state).toBe("completed"); f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded"); await expect(reclaim(f, view)).rejects.toMatchObject({ code: "invalid", status: 404 });
});


it("lists candidate metadata without reading artifact bodies or issuing a confirmation", async () => {
  const f = fixture(undefined, 32), execution = await interrupted(f), read = fs.readSync;
  vi.spyOn(fs, "readSync").mockImplementation((...args) => { if (fs.fstatSync(args[0]).ino === lstatSync(execution.destination).ino) throw new Error("list must not read artifact bodies"); return read(...args); }); syncBuiltinESMExports();
  expect(await f.schedules.recover("local-admin", { action: "list" })).toEqual([expect.objectContaining({ executionId: execution.executionId, requiresPreview: true })]);
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const view = await preview(f, execution.executionId); expect(view.confirmation).toMatch(/^[a-f0-9]{64}$/); await reclaim(f, view);
  expect(await f.schedules.recover("local-admin", { action: "list" })).toEqual([]);
});

it("charges timed-out staging across repeated attempts, history pruning and restart, then reclaims it explicitly", async () => {
  const f = fixture(); f.save();
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
    rename(...args);
    if (String(args[1]).endsWith(".partial")) f.advance(31_000);
  }); syncBuiltinESMExports();
  f.advance(); f.schedules.tick(); await f.backups.drain();
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const execution = f.ledger().executions[0], staging = join(f.root, "exports", `.user-export-${execution.executionId}.partial`);
  expect(execution).toMatchObject({ state: "failed", reason: "limit" });
  expect(existsSync(staging)).toBe(true); expect(existsSync(execution.destination)).toBe(false);
  const bytes = readFileSync(staging);
  for (let attempt = 0; attempt < 55; attempt++) {
    if (attempt === 2) f.restart();
    f.advance(); f.schedules.tick(); await f.backups.drain();
    expect(f.schedules.overview(f.actor()).artifacts[0]).toMatchObject({ state: "failed", reason: "limit" });
  }
  expect(f.ledger().executions.some((value: { executionId: string }) => value.executionId === execution.executionId)).toBe(true);
  expect(fs.readdirSync(join(f.root, "exports"))).toEqual([`.user-export-${execution.executionId}.partial`]);
  expect(readFileSync(staging).equals(bytes)).toBe(true);
  expect(await f.schedules.recover("local-admin", { action: "list" })).toEqual([expect.objectContaining({ executionId: execution.executionId, requiresPreview: true })]);
  const view = await preview(f, execution.executionId); expect(view.staging).toBe(true);
  expect((await reclaim(f, view)).state).toBe("completed"); expect(existsSync(staging)).toBe(false);
  f.restart(); expect((await reclaim(f, view)).state).toBe("completed");
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded");
});

for (const kind of ["corrupt", "foreign", "hardlink", "symlink"]) it(`preserves unsafe staging-only ${kind} during operator preview`, async () => {
  const f = fixture(), execution = await interrupted(f);
  const staging = join(f.root, "exports", `.user-export-${execution.executionId}.partial`);
  renameSync(execution.destination, staging);
  if (kind === "corrupt") writeFileSync(staging, "corrupt");
  if (kind === "foreign") {
    const envelope = JSON.parse(readFileSync(staging, "utf8")); envelope.payload.ownerId = "foreign";
    writeRecord(staging, envelope.payload);
  }
  if (kind === "hardlink") linkSync(staging, join(f.root, "unknown"));
  if (kind === "symlink") { renameSync(staging, join(f.root, "unknown")); symlinkSync(join(f.root, "unknown"), staging); }
  const bytes = readFileSync(staging);
  await expect(preview(f, execution.executionId)).rejects.toThrow();
  expect(readFileSync(staging).equals(bytes)).toBe(true);
});

it("lets the operator release succeeded copies at full owner quota without changing their outcome", async () => {
  const f = fixture(); f.save(); f.advance(); f.schedules.tick(); await f.backups.drain();
  const original = f.ledger().executions[0];
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0]).toMatchObject({ state: "failed", reason: "limit" });
  const view = await preview(f, original.executionId);
  expect(view).toMatchObject({ state: "succeeded", eligible: true });
  expect((await reclaim(f, view)).state).toBe("completed");
  expect(f.ledger().executions.find((value: { executionId: string }) => value.executionId === original.executionId)).toEqual(original);
  f.restart(); expect((await reclaim(f, view)).state).toBe("completed");
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor()).artifacts[0].state).toBe("succeeded");
});

it("releases the global execution cap through confirmed cleanup of succeeded history", async () => {
  const f = fixture(undefined, 32); f.save(); f.advance(); f.schedules.tick(); await f.backups.drain();
  f.save("other");
  const ledger = f.ledger(), original = ledger.executions[0];
  const envelope = JSON.parse(readFileSync(original.destination, "utf8"));
  // Model 2048 distinct retained publications, with complete matching envelopes.
  for (let index = 1; index < 2048; index++) {
    const executionId = randomUUID(), destination = join(f.root, "exports", `user-export-${executionId}.json`);
    const payload = { ...envelope.payload, executionId };
    const hash = recordHash(payload);
    writeFileSync(destination, JSON.stringify({ payload, sha256: hash }), { mode: 0o600 });
    ledger.executions.push({ ...original, executionId, destination, hash });
  }
  writeRecord(f.path, ledger); f.restart();
  // Stop the filling schedule; disabling must keep its copies until explicit cleanup.
  const schedule = f.schedules.overview(f.actor()).schedules[0];
  f.schedules.command(f.actor(), { action: "save", id: schedule.id, version: schedule.version,
    idempotencyKey: userScheduleMutationKey(f.schedules.overview(f.actor()).mutationGeneration, schedule.id, schedule.version, randomUUID()),
    configuration: { projectId: schedule.projectId, scope: schedule.scope, targetId: schedule.targetId, enabled: false,
      intervalSeconds: schedule.intervalSeconds, retainCount: schedule.retainCount, retainDays: schedule.retainDays } });
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor("other")).schedules[0].reason).toBe("limit");
  expect(f.ledger().executions).toHaveLength(2048);
  await reclaim(f, await preview(f, original.executionId));
  f.advance(); f.schedules.tick(); await f.backups.drain();
  expect(f.schedules.overview(f.actor("other")).artifacts[0].state).toBe("succeeded");
  expect(f.ledger().executions).toHaveLength(2048);
});
