import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "./controller-backup";
import { acquireDatabaseOwnership, SqliteStateStore } from "./infrastructure/sqlite";
import { IdentityService } from "./modules/identity";
import { KnowledgeAttachmentService, KnowledgeService } from "./modules/knowledge";
import { BACKUP_LIMITS, hashFile } from "./infrastructure/sqlite";
import { getOwnedRestoreStatus, prepareOwnedRestore, recoverOwnedRestore, restoreRoot } from "./infrastructure/sqlite";
import { executeControllerRestoreRequest, getControllerRestoreRequestStatus, requestControllerRestore } from "./restore-requests";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const actor = { actorId: "operator", backupId: "catalog-one", idempotencyKey: "confirmed-one" };
const bytes = Buffer.from("new attachment bytes"), sha = createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = mkdtempSync(join(dirname(process.cwd()), ".restore-crash-")); roots.push(root);
  const source = join(root, "source.sqlite3"), database = join(root, "state.sqlite3"), attachments = join(root, "attachments"), backup = join(root, "backup");
  const store = new SqliteStateStore(source);
  try {
    const identity = new IdentityService(store), owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
    const project = identity.createKnowledgeProject({ name: "New knowledge" }, owner);
    identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "attachments:write"] }, owner);
    const task = new KnowledgeService(store, identity).createTask(project.id, { title: "New task", description: "body", priority: "later" }, { idempotencyKey: "task" }, owner).value;
    new KnowledgeAttachmentService(store, identity, join(root, "source-attachments")).upload(project.id, "task", task.id, { filename: "proof.txt", mediaType: "text/plain", data: bytes, idempotencyKey: "attachment" }, owner);
    store.addProject({ name: "New runtime", repositoryPath: root, port: 4567, executable: "pnpm", args: ["dev"] });
    await createControllerBackup(store, backup, { applicationVersion: "test", attachmentDirectory: join(root, "source-attachments") });
  } finally { store.close(); }
  const old = new SqliteStateStore(database); old.addProject({ name: "Old runtime", repositoryPath: root, port: 4568, executable: "pnpm", args: ["dev"] }); old.close();
  mkdirSync(attachments, { mode: 0o700 }); writeFileSync(join(attachments, "retained-orphan"), "old bytes", { mode: 0o600 });
  for (const suffix of ["-wal", "-shm", "-journal", ".initializing"]) writeFileSync(`${database}${suffix}`, `old${suffix}`, { mode: 0o600 });
  return { root, database, attachments, backup, before: readFileSync(database) };
}
async function kill(f: Awaited<ReturnType<typeof fixture>>, point: string, mode = "restore") {
  const child = fork(fileURLToPath(new URL("./infrastructure/sqlite/fixtures/restore-crash-worker.ts", import.meta.url)), [f.root, point, mode], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", data => { stderr += data.toString(); });
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10_000);
  try {
    const message = once(child, "message", { signal: abort.signal });
    const early = once(child, "exit").then(() => { throw new Error(`Restore fixture exited early: ${stderr}`); });
    expect((await Promise.race([message, early]))[0]).toEqual({ point });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); expect((await ended)[1]).toBe("SIGKILL"); }
  }
}
function assertNew(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new SqliteStateStore(f.database);
  try { expect(store.listProjects().map(project => project.name)).toEqual(["New runtime"]); }
  finally { store.close(); }
  expect(readFileSync(join(f.attachments, sha.slice(0, 2), sha))).toEqual(bytes);
  expect(existsSync(join(f.attachments, "retained-orphan"))).toBe(false);
  const previous = join(restoreRoot(f.database), "previous");
  expect(readFileSync(join(previous, "0"))).toEqual(f.before);
  for (let i = 1; i <= 4; i++) expect(readFileSync(join(previous, String(i)), "utf8")).toMatch(/^old/);
  expect(readFileSync(join(previous, "5", "retained-orphan"), "utf8")).toBe("old bytes");
  const ownership = acquireDatabaseOwnership(f.database);
  try { expect(getOwnedRestoreStatus(ownership.path)?.state).toBe("verified"); recoverOwnedRestore(ownership.path); recoverOwnedRestore(ownership.path); }
  finally { ownership.lock.release(); }
  expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
}
function changeManifest(f: Awaited<ReturnType<typeof fixture>>, change: (manifest: { database: { size: number | string; sha256: string; schemaVersion: number }; attachments: Array<{ file: string; size: number; sha256: string }>; command?: string; applicationVersion: string }) => void) {
  const path = join(f.backup, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8")); change(manifest); writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
}

describe("recoverable multi-file restore", () => {
  for (let step = 0; step < 8; step++) {
    it.each(["before", "after"])(`SIGKILL %s replacement ${step} recovers once and repeatedly`, async timing => {
      const f = await fixture(); await kill(f, `${timing}-${step}`); assertNew(f);
    }, 20_000);
  }
  it.each(["published", "verified"])("recovers at durable protocol boundary %s", async point => { const f = await fixture(); await kill(f, point); assertNew(f); }, 20_000);
  it("keeps active old data after interruption before publishing prepared intent", async () => {
    const f = await fixture(); await kill(f, "prepared");
    expect(readFileSync(f.database)).toEqual(f.before); expect(existsSync(restoreRoot(f.database))).toBe(false);
    restoreControllerBackup(f.backup, f.database, f.attachments); assertNew(f);
  }, 20_000);
  it("recovers again when recovery itself is killed between rename and journal result", async () => {
    const f = await fixture(); await kill(f, "after-0"); await kill(f, "after-6", "recovery"); assertNew(f);
  }, 30_000);
  it("does not apply an already verified backup over subsequent application writes", async () => {
    const f = await fixture(); restoreControllerBackup(f.backup, f.database, f.attachments); assertNew(f);
    const store = new SqliteStateStore(f.database); store.addProject({ name: "After restore", repositoryPath: join(f.root, "another"), port: 4569, executable: "pnpm", args: ["dev"] }); store.close();
    const reopened = new SqliteStateStore(f.database); expect(reopened.listProjects()).toHaveLength(2); reopened.close();
  });
  it("restores an initially absent target, including a crash after new database rename", async () => {
    const f = await fixture(); rmSync(f.database); for (const suffix of ["-wal", "-shm", "-journal", ".initializing"]) rmSync(`${f.database}${suffix}`); rmSync(f.attachments, { recursive: true });
    await kill(f, "after-6"); const store = new SqliteStateStore(f.database); expect(store.listProjects()[0]?.name).toBe("New runtime"); store.close(); expect(readFileSync(join(f.attachments, sha.slice(0, 2), sha))).toEqual(bytes);
  }, 20_000);
  it.each(["invalid-json", "checksum", "missing-file", "conflicting-file"])("refuses %s without losing recovery material", async damage => {
    const f = await fixture(); await kill(f, "after-0"); const root = restoreRoot(f.database), journal = join(root, "journal.json");
    if (damage === "invalid-json") writeFileSync(journal, "{");
    if (damage === "checksum") { const record = JSON.parse(readFileSync(journal, "utf8")); record.payload.completed = 8; writeFileSync(journal, JSON.stringify(record)); }
    if (damage === "missing-file") rmSync(join(root, "new", "state.sqlite3"));
    if (damage === "conflicting-file") writeFileSync(f.database, "unexpected", { mode: 0o600 });
    expect(() => new SqliteStateStore(f.database)).toThrow(/recovery stopped/);
    expect(readFileSync(join(root, "previous", "0"))).toEqual(f.before); expect(existsSync(root)).toBe(true); expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  }, 20_000);
  it.each(["ENOSPC", "EACCES", "EIO"])("retains intent after %s during replacement and resumes after the cause is removed", async code => {
    const f = await fixture(), rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { if (String(from) === `${f.database}-shm`) throw Object.assign(new Error(code), { code }); rename(from, to); });
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(code);
    expect(existsSync(join(restoreRoot(f.database), "previous", "0"))).toBe(true); vi.restoreAllMocks(); assertNew(f);
  });
  it("retains durable intent on a directory fsync error after rename", async () => {
    const f = await fixture(), sync = fs.fsyncSync; let fired = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (!fired && existsSync(join(restoreRoot(f.database), "previous", "0")) && fs.fstatSync(fd).isDirectory()) { fired = true; throw Object.assign(new Error("EIO"), { code: "EIO" }); } sync(fd);
    });
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow("EIO"); vi.restoreAllMocks(); assertNew(f);
  });
});

describe("strict restore validation before replacement", () => {
  it.each(["path", "duplicate", "type", "unknown", "version", "size", "hash", "incomplete"])("rejects manifest %s and preserves old bytes", async invalid => {
    const f = await fixture(); changeManifest(f, manifest => {
      if (invalid === "path") manifest.attachments[0].file = `ab/../${sha.slice(0, 2)}/${sha}`;
      if (invalid === "duplicate") manifest.attachments.push(manifest.attachments[0]);
      if (invalid === "type") manifest.database.size = String(manifest.database.size);
      if (invalid === "unknown") manifest.command = "unexpected";
      if (invalid === "version") manifest.database.schemaVersion = 29;
      if (invalid === "size") manifest.database.size = BACKUP_LIMITS.fileBytes + 1;
      if (invalid === "hash") manifest.database.sha256 = "0".repeat(64);
      if (invalid === "incomplete") manifest.attachments = [];
    });
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before); expect(existsSync(restoreRoot(f.database))).toBe(false);
  });
  it.each(["database-link", "shard-link", "special-file", "sidecar", "missing-attachment"])("rejects %s in the backup tree", async invalid => {
    const f = await fixture(), file = join(f.backup, "attachments", sha.slice(0, 2), sha);
    if (invalid === "database-link") { rmSync(join(f.backup, "state.sqlite3")); symlinkSync(join(f.root, "source.sqlite3"), join(f.backup, "state.sqlite3")); }
    if (invalid === "shard-link") { const shard = dirname(file); rmSync(shard, { recursive: true }); symlinkSync(join(f.root, "source-attachments", sha.slice(0, 2)), shard); }
    if (invalid === "special-file") { rmSync(file); mkdirSync(file); }
    if (invalid === "sidecar") writeFileSync(join(f.backup, "state.sqlite3-wal"), "stale");
    if (invalid === "missing-attachment") rmSync(file);
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it.each(["foreign-key", "domain", "sqlite-corruption"])("rejects %s even with a matching manifest hash", async invalid => {
    const f = await fixture(), path = join(f.backup, "state.sqlite3");
    if (invalid === "sqlite-corruption") writeFileSync(path, "not sqlite", { mode: 0o600 });
    else { const db = new Database(path); db.pragma("foreign_keys=OFF");
      if (invalid === "foreign-key") db.exec("UPDATE knowledge_attachments SET project_id='missing'");
      else db.exec("UPDATE knowledge_attachments SET record_id='missing'"); db.close(); }
    changeManifest(f, manifest => { Object.assign(manifest.database, hashFile(path)); });
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it("rechecks staged bytes if source changes after initial validation", async () => {
    const f = await fixture(), open = fs.openSync; let changed = false;
    vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (!changed && String(path).includes(".restore-stage-") && String(path).endsWith("/new/state.sqlite3")) { changed = true; writeFileSync(join(f.backup, "state.sqlite3"), "changed"); }
      return open(path, flags, mode);
    });
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(/integrity|size changed/); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it.each(["ENOSPC", "EACCES", "EIO"])("preserves active data after %s staging write refusal", async code => {
    const f = await fixture();
    vi.spyOn(fs, "writeSync").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(code); expect(readFileSync(f.database)).toEqual(f.before); expect(existsSync(restoreRoot(f.database))).toBe(false);
  });
  it("refuses real filesystem permission denial before replacement", async () => {
    const f = await fixture(), file = join(f.backup, "attachments", sha.slice(0, 2), sha); chmodSync(file, 0);
    try { expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before); }
    finally { chmodSync(file, 0o600); }
  });
  it("refuses low disk capacity before creating the staging directory", async () => {
    const f = await fixture(), original = fs.statfsSync;
    vi.spyOn(fs, "statfsSync").mockImplementation(path => ({ ...original(path), bavail: 0 }));
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(/space/); expect(readFileSync(f.database)).toEqual(f.before); expect(existsSync(restoreRoot(f.database))).toBe(false);
  });
  it("refuses actual different-device attachments before replacing data", async () => {
    const f = await fixture(), elsewhere = mkdtempSync("/tmp/restore-other-device-"); roots.push(elsewhere);
    expect(lstatSync(elsewhere).dev).not.toBe(lstatSync(f.root).dev);
    expect(() => restoreControllerBackup(f.backup, f.database, join(elsewhere, "attachments"))).toThrow(/filesystem/); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it("refuses an unsupported filesystem type and target path overlap", async () => {
    const f = await fixture(), original = fs.statfsSync;
    vi.spyOn(fs, "statfsSync").mockImplementation(path => ({ ...original(path), type: 0x6969 }));
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(/filesystem/); vi.restoreAllMocks();
    expect(() => restoreControllerBackup(f.backup, f.database, `${f.database}.restore`)).toThrow(/overlap/); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it("refuses a private staging file whose permissions changed before recovery", async () => {
    const f = await fixture(), ownership = acquireDatabaseOwnership(f.database);
    try { prepareOwnedRestore(f.backup, ownership.path, f.attachments, actor); chmodSync(join(restoreRoot(f.database), "new", "state.sqlite3"), 0o644); expect(() => recoverOwnedRestore(ownership.path)).toThrow(/private/); expect(readFileSync(f.database)).toEqual(f.before); }
    finally { ownership.lock.release(); }
  });
});

describe("controlled restore request handoff", () => {
  it("admits without replacing an open database, requires lock handoff, persists status and deduplicates retries", async () => {
    const f = await fixture(); for (const suffix of ["-wal", "-shm", "-journal", ".initializing"]) rmSync(`${f.database}${suffix}`);
    const store = new SqliteStateStore(f.database), policy = { authorize: vi.fn(), resolveBackup: () => f.backup };
    const input = { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" };
    const accepted = requestControllerRestore(f.database, actor.actorId, input, policy);
    expect(accepted.state).toBe("requested"); expect(store.listProjects()[0]?.name).toBe("Old runtime");
    expect(() => executeControllerRestoreRequest(f.database, f.attachments, actor, policy)).toThrow("already running"); store.close();
    expect(requestControllerRestore(f.database, actor.actorId, input, policy)).toEqual(accepted);
    const result = executeControllerRestoreRequest(f.database, f.attachments, actor, policy); expect(result).toMatchObject({ operationId: accepted.operationId, state: "verified" });
    const before = readFileSync(f.database); expect(executeControllerRestoreRequest(f.database, f.attachments, actor, policy)).toEqual(result); expect(readFileSync(f.database)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain(f.root);
  });
  it("rejects missing confirmation, client paths, denied operators and idempotency conflicts", async () => {
    const f = await fixture(), policy = { authorize: () => {}, resolveBackup: () => f.backup }, input = { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" };
    expect(() => requestControllerRestore(f.database, actor.actorId, { ...input, confirmation: undefined }, policy)).toThrow();
    expect(() => requestControllerRestore(f.database, actor.actorId, { ...input, source: f.backup }, policy)).toThrow();
    expect(() => requestControllerRestore(f.database, actor.actorId, input, { ...policy, authorize: () => { throw new Error("denied"); } })).toThrow("denied");
    requestControllerRestore(f.database, actor.actorId, input, policy);
    expect(() => requestControllerRestore(f.database, actor.actorId, { ...input, backupId: "different" }, policy)).toThrow(/conflict/);
    expect(() => executeControllerRestoreRequest(f.database, f.attachments, actor, { ...policy, authorize: () => { throw new Error("revoked"); } })).toThrow("revoked"); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it("rejects a changed catalog snapshot after confirmation", async () => {
    const f = await fixture(), policy = { authorize: () => {}, resolveBackup: () => f.backup };
    requestControllerRestore(f.database, actor.actorId, { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" }, policy);
    changeManifest(f, manifest => { manifest.applicationVersion = "different"; });
    expect(() => executeControllerRestoreRequest(f.database, f.attachments, actor, policy)).toThrow(/changed since confirmation/); expect(readFileSync(f.database)).toEqual(f.before);
  });
});

describe("restore durability and historical snapshots", () => {
  it("normalizes historical WAL snapshots in staging while preserving source bytes and metadata", async () => {
    const f = await fixture(), databaseFile = join(f.backup, "state.sqlite3"), source = new Database(databaseFile);
    source.pragma("journal_mode=WAL"); source.close();
    changeManifest(f, manifest => { Object.assign(manifest.database, hashFile(databaseFile)); });
    writeFileSync(`${databaseFile}-wal`, "", { mode: 0o600 }); writeFileSync(`${databaseFile}-shm`, Buffer.alloc(32768), { mode: 0o600 });
    const before = readFileSync(databaseFile), metadata = readFileSync(join(f.backup, "manifest.json"));
    restoreControllerBackup(f.backup, f.database, f.attachments); assertNew(f);
    expect(readFileSync(databaseFile)).toEqual(before); expect(readFileSync(join(f.backup, "manifest.json"))).toEqual(metadata);
    expect(lstatSync(`${databaseFile}-wal`).size).toBe(0);
    const journal = JSON.parse(readFileSync(join(restoreRoot(f.database), "journal.json"), "utf8"));
    expect(journal.payload.sourceManifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("preserves interrupted attachment publication aliases as part of the complete old set", async () => {
    const f = await fixture(); mkdirSync(join(f.attachments, ".object-retained"), { mode: 0o700 });
    fs.linkSync(join(f.attachments, "retained-orphan"), join(f.attachments, ".object-retained", "content"));
    restoreControllerBackup(f.backup, f.database, f.attachments); assertNew(f);
    expect(lstatSync(join(restoreRoot(f.database), "previous", "5", "retained-orphan")).nlink).toBe(2);
  });
  it.each(["duplicate-keys", "oversized-json", "deep-json"])("rejects %s before installing data", async kind => {
    const f = await fixture(), path = join(f.backup, "manifest.json"), before = readFileSync(path, "utf8");
    if (kind === "duplicate-keys") writeFileSync(path, before.replace('"formatVersion":1', '"formatVersion":1,"formatVersion":1'));
    if (kind === "oversized-json") writeFileSync(path, " ".repeat(BACKUP_LIMITS.manifestBytes + 1));
    if (kind === "deep-json") writeFileSync(path, '['.repeat(33) + '0' + ']'.repeat(33));
    expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before);
  });
  it("records durable intent and both directory syncs before the completion record of every replacement", async () => {
    const f = await fixture(), rename = fs.renameSync, sync = fs.fsyncSync;
    const checked: number[] = []; let pending: { step: number; directories: Set<number> } | null = null;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const target = String(to), journalPath = join(restoreRoot(f.database), "journal.json");
      if (target.startsWith(join(restoreRoot(f.database), "previous") + "/") || [join(restoreRoot(f.database), "new", "state.sqlite3"), join(restoreRoot(f.database), "new", "attachments")].includes(String(from))) {
        const journal = JSON.parse(readFileSync(journalPath, "utf8")).payload;
        expect(journal.intent).toBe(journal.completed); pending = { step: journal.intent, directories: new Set() };
      }
      if (pending && target === journalPath) {
        const next = JSON.parse(readFileSync(String(from), "utf8")).payload;
        if (next.completed === pending.step + 1) { expect(pending.directories.size).toBeGreaterThanOrEqual(2); checked.push(pending.step); pending = null; }
      }
      rename(from, to);
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { const stat = fs.fstatSync(fd); if (pending && stat.isDirectory()) pending.directories.add(stat.ino); sync(fd); });
    restoreControllerBackup(f.backup, f.database, f.attachments); expect(checked).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("refuses corrupt journal types even with a recomputed checksum", async () => {
    const f = await fixture(); await kill(f, "after-0");
    const path = join(restoreRoot(f.database), "journal.json"), envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.payload.attachmentDirectory = "../escape"; envelope.payload.completed = "1";
    envelope.sha256 = createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex"); writeFileSync(path, JSON.stringify(envelope));
    expect(() => new SqliteStateStore(f.database)).toThrow(/recovery stopped/); expect(readFileSync(join(restoreRoot(f.database), "previous", "0"))).toEqual(f.before);
  }, 20_000);
  it("uses an archived verification receipt after a later restore and never reapplies an old request", async () => {
    const f = await fixture(), policy = { authorize: () => {}, resolveBackup: () => f.backup };
    const accepted = requestControllerRestore(f.database, actor.actorId, { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" }, policy);
    // Simulate death after the restore's verified marker but before updating request status.
    const ownership = acquireDatabaseOwnership(f.database);
    try {
      const manifest = JSON.parse(readFileSync(join(f.backup, "manifest.json"), "utf8"));
      prepareOwnedRestore(f.backup, ownership.path, f.attachments, actor, { operationId: accepted.operationId, manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") });
      recoverOwnedRestore(ownership.path);
    } finally { ownership.lock.release(); }
    expect(getControllerRestoreRequestStatus(f.database, actor, policy).state).toBe("verified");
    restoreControllerBackup(f.backup, f.database, f.attachments);
    const store = new SqliteStateStore(f.database); store.addProject({ name: "After", repositoryPath: join(f.root, "after"), port: 5678, executable: "pnpm", args: ["dev"] }); store.close();
    expect(executeControllerRestoreRequest(f.database, f.attachments, actor, policy).state).toBe("verified");
    const reopened = new SqliteStateStore(f.database); expect(reopened.listProjects()).toHaveLength(2); reopened.close();
  });
});


it.each(["permissions", "extra-file", "changed-manifest"])("refuses private staging %s before any old-set rename", async damage => {
  const f = await fixture(), ownership = acquireDatabaseOwnership(f.database);
  try {
    prepareOwnedRestore(f.backup, ownership.path, f.attachments, actor);
    const root = join(restoreRoot(f.database), "new");
    if (damage === "permissions") chmodSync(join(root, "attachments"), 0o755);
    if (damage === "extra-file") writeFileSync(join(root, "extra"), "unexpected", { mode: 0o600 });
    if (damage === "changed-manifest") { const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")); manifest.createdAt = "2000-01-01T00:00:00Z"; writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest)); }
    expect(() => recoverOwnedRestore(ownership.path)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before);
  } finally { ownership.lock.release(); }
});

it("repairs only its own interrupted request publication alias and rejects unknown hardlinks", async () => {
  const f = await fixture(), policy = { authorize: () => {}, resolveBackup: () => f.backup };
  const accepted = requestControllerRestore(f.database, actor.actorId, { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" }, policy);
  const directory = `${f.database}.restore-requests`, path = join(directory, fs.readdirSync(directory)[0]);
  const temporary = join(directory, `.request-${accepted.operationId}`); fs.linkSync(path, temporary);
  expect(getControllerRestoreRequestStatus(f.database, actor, policy)).toEqual(accepted); expect(existsSync(temporary)).toBe(false); expect(lstatSync(path).nlink).toBe(1);
  fs.linkSync(path, join(directory, "unknown-alias")); expect(() => getControllerRestoreRequestStatus(f.database, actor, policy)).toThrow(); expect(readFileSync(f.database)).toEqual(f.before);
});

it("refuses a different mount ID even when device numbers match", async () => {
  const f = await fixture(), read = fs.readSync;
  vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offsetOrOptions?: number | fs.ReadOptions, length?: number, position?: number | bigint | null) => {
    const offset = typeof offsetOrOptions === "number" ? offsetOrOptions : offsetOrOptions?.offset ?? 0;
    const path = fs.readlinkSync(`/proc/self/fd/${fd}`), source = path.match(/\/proc\/(?:self|\d+)\/fdinfo\/(\d+)$/)?.[1];
    if (source && fs.readlinkSync(`/proc/self/fd/${source}`) === f.attachments) {
      const data = Buffer.from("mnt_id:\t999999999\n"); new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(data, offset); return data.length;
    }
    return read(fd, buffer, offset, length ?? buffer.byteLength - offset, position ?? null);
  }) as typeof fs.readSync);
  expect(() => restoreControllerBackup(f.backup, f.database, f.attachments)).toThrow(/filesystem/); expect(readFileSync(f.database)).toEqual(f.before); expect(existsSync(restoreRoot(f.database))).toBe(false);
});

it("preserves the old set on a real quarantine-directory write denial, then resumes", async () => {
  const f = await fixture(), ownership = acquireDatabaseOwnership(f.database), previous = join(restoreRoot(f.database), "previous");
  try {
    prepareOwnedRestore(f.backup, ownership.path, f.attachments, actor); chmodSync(previous, 0o500);
    expect(() => recoverOwnedRestore(ownership.path)).toThrow(/EACCES/); expect(readFileSync(f.database)).toEqual(f.before);
  } finally { chmodSync(previous, 0o700); ownership.lock.release(); }
  assertNew(f);
});
