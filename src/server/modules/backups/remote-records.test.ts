import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { privateDirectory } from "@/server/private-storage";
import { acquireDatabaseOwnership, getOwnedRestoreStatus, prepareOwnedRestore } from "@/server/infrastructure/sqlite";
import { SqliteStateStore } from "@/server/sqlite-store";
import { createControllerBackup } from "@/server/controller-backup";
import { requestControllerRestore, assertNoUnfinishedControllerRestoreRequests } from "@/server/restore-requests";
import { recordHash, writeRecord } from "./records";
import { readRemoteLedger, rebindRemoteLedger, writeRemoteLedger, type RemoteLedger, type Receipt } from "./remote-records";
import { rebindRemoteBackup } from "./remote-rebind";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-rebind-")); roots.push(root);
  const database = join(root, "state.sqlite3"), directory = privateDirectory(`${database}.backup-operations`), path = join(directory, "remote.json");
  const receipt: Receipt = { backupId: `backup-${randomUUID()}`, manifestHash: "a".repeat(64), manifestSha256: "b".repeat(64), dataAt: new Date(0).toISOString(), sizeBytes: 10, state: "failed", attempts: 1, nextAt: null, confirmedAt: null, snapshotId: null, error: "remote_failed", retryGeneration: 0 };
  const ledger: RemoteLedger = { format: 2, installationId: randomUUID(), destinationId: "a".repeat(64), receipts: [receipt], lastConfirmed: null, archives: [], rebindGeneration: 0, lastRebind: null };
  writeRemoteLedger(path, ledger);
  const input = { controllerLockPath: join(root, "controller.lock"), databasePath: database, from: ledger.destinationId, destinationId: "b".repeat(64), generation: 1 };
  return { root, database, path, receipt, ledger, input };
}
describe("atomic remote rebind evidence", () => {
  it("migrates checksummed format1 without rewriting or dropping an uncertain receipt", () => {
    const f = fixture(); const { archives, rebindGeneration, lastRebind, ...legacy } = f.ledger; void archives; void rebindGeneration; void lastRebind;
    writeRecord(f.path, { ...legacy, format: 1 }); const before = readFileSync(f.path);
    expect(readRemoteLedger(f.path)).toEqual(f.ledger); expect(readFileSync(f.path)).toEqual(before);
    const next = rebindRemoteLedger(f.path, "a".repeat(64), "b".repeat(64), 1);
    expect(next.archives[0].receipts).toEqual([f.receipt]); expect(next.receipts).toEqual([]); expect(next.lastConfirmed).toBeNull();
    expect(next.installationId).toBe(f.ledger.installationId);
  });
  it("fences matching retries and conflicts and refuses the fifth archive without mutation", () => {
    const f = fixture(); let from = f.ledger.destinationId;
    for (let generation = 1; generation <= 4; generation++) {
      const target = String(generation + 1).repeat(64), next = rebindRemoteLedger(f.path, from, target, generation), before = readFileSync(f.path);
      expect(rebindRemoteLedger(f.path, from, target, generation)).toEqual(next); expect(readFileSync(f.path)).toEqual(before);
      expect(() => rebindRemoteLedger(f.path, from, "f".repeat(64), generation)).toThrow("backup_invalid"); from = target;
    }
    const before = readFileSync(f.path);
    expect(() => rebindRemoteLedger(f.path, from, "f".repeat(64), 5)).toThrow("backup_limit");
    expect(() => rebindRemoteLedger(f.path, "a".repeat(64), "b".repeat(64), 1)).toThrow("backup_invalid");
    expect(readFileSync(f.path)).toEqual(before);
  });
  it("refuses byte/proof limits before publishing a replacement", () => {
    const f = fixture();
    const proofs = Array.from({ length: 256 }, (_, i) => ({ snapshotId: i.toString(16).padStart(64, "0"), tree: "e".repeat(64), state: "partial" as const }));
    const receipt = { ...f.receipt, reconciliation: { passes: 1, readReservedBytes: 256 * 1024 * 1024, proofs } };
    const before = readFileSync(f.path);
    expect(() => writeRemoteLedger(f.path, { ...f.ledger, receipts: Array.from({ length: 5 }, () => ({ ...receipt, backupId: `backup-${randomUUID()}` })) })).toThrow();
    expect(() => writeRecord(f.path, { oversized: "x".repeat(4 * 1024 * 1024) })).toThrow("size limit");
    expect(readFileSync(f.path)).toEqual(before);
  });
  it("refuses a canonical data alias with a different state lock while the owner is active", async () => {
    const f = fixture(), alias = join(f.root, "alias"); symlinkSync(f.root, alias, "dir");
    const ownership = acquireDatabaseOwnership(f.database);
    const before = readFileSync(f.path); let authenticated = false;
    try { await expect(rebindRemoteBackup({ ...f.input, databasePath: join(alias, "state.sqlite3"), controllerLockPath: join(f.root, "other-controller.lock") }, async () => { authenticated = true; })).rejects.toThrow(); }
    finally { ownership.lock.release(); }
    expect(authenticated).toBe(false); expect(readFileSync(f.path)).toEqual(before);
  });
  it("refuses prepared restore under inspection ownership without changing database or journal", async () => {
    const f = fixture(), store = new SqliteStateStore(f.database), backup = join(f.root, "copy"), attachments = join(f.root, "attachments");
    await createControllerBackup(store, backup, { applicationVersion: "fixture", attachmentDirectory: attachments }); store.close();
    const ownership = acquireDatabaseOwnership(f.database);
    try { prepareOwnedRestore(backup, ownership.path, attachments, { actorId: "operator", backupId: "copy", idempotencyKey: "restore" }); } finally { ownership.lock.release(); }
    const journal = `${f.database}.restore/journal.json`, before = [readFileSync(f.database), readFileSync(journal), readFileSync(f.path)];
    expect(() => acquireDatabaseOwnership(f.database, { inspectOnly: true })).toThrow("Unfinished restore");
    await expect(rebindRemoteBackup(f.input, async () => {})).rejects.toThrow("Unfinished restore");
    expect(getOwnedRestoreStatus(f.database)?.state).toBe("prepared");
    expect([readFileSync(f.database), readFileSync(journal), readFileSync(f.path)]).toEqual(before);
    // Explicit ordinary recovery completes the fixture; completed journals must
    // remain compatible with supported canonical parent aliases during rebind.
    const recovered = acquireDatabaseOwnership(f.database); recovered.lock.release();
    const alias = join(f.root, "alias"); symlinkSync(f.root, alias, "dir");
    expect((await rebindRemoteBackup({ ...f.input, databasePath: join(alias, "state.sqlite3") }, async () => {})).generation).toBe(1);
  });
  it("does not repair an interrupted request alias before refusing offline rebind", async () => {
    const f = fixture(), store = new SqliteStateStore(f.database), backup = join(f.root, "copy");
    await createControllerBackup(store, backup, { applicationVersion: "fixture", attachmentDirectory: join(f.root, "attachments") }); store.close();
    const actor = { actorId: "operator", backupId: "copy", idempotencyKey: "request" };
    const result = requestControllerRestore(f.database, actor.actorId, { backupId: actor.backupId, idempotencyKey: actor.idempotencyKey, confirmation: "replace-entire-installation" }, { authorize: () => {}, resolveBackup: () => backup });
    // Restore requests deliberately use a different (ordinary JSON) digest.
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update(JSON.stringify([actor.actorId, actor.idempotencyKey])).digest("hex");
    const path = `${f.database}.restore-requests/${key}.json`, alias = `${f.database}.restore-requests/.request-${result.operationId}`;
    linkSync(path, alias); const before = readFileSync(path);
    expect(() => assertNoUnfinishedControllerRestoreRequests(f.database)).toThrow("publication");
    await expect(rebindRemoteBackup(f.input, async () => {})).rejects.toThrow("publication");
    expect(lstatSync(path).nlink).toBe(2); expect(readFileSync(alias)).toEqual(before); expect(readFileSync(path)).toEqual(before);
  });
  it.each(["before", "after"])("SIGKILL %s publication preserves one generation and idempotent replay", async point => {
    const f = fixture(); writeFileSync(join(f.root, "input.json"), JSON.stringify(f.input), { mode: 0o600 });
    const child = fork(fileURLToPath(new URL("./fixtures/remote-rebind-crash-worker.ts", import.meta.url)), [f.root, point], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr?.on("data", value => { stderr += value.toString(); });
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10000);
    try {
      await Promise.race([once(child, "message", { signal: abort.signal }), once(child, "exit").then(() => { throw new Error(`Missed publication boundary: ${stderr}`); })]);
      const exit = once(child, "exit"); child.kill("SIGKILL"); expect((await exit)[1]).toBe("SIGKILL");
      expect(readRemoteLedger(f.path)?.rebindGeneration).toBe(point === "before" ? 0 : 1);
      await rebindRemoteBackup(f.input, async () => {}); const before = readFileSync(f.path);
      await rebindRemoteBackup(f.input, async () => {}); expect(readFileSync(f.path)).toEqual(before);
      expect(readRemoteLedger(f.path)?.archives[0].receipts).toEqual([f.receipt]);
      expect(JSON.parse(before.toString()).sha256).toBe(recordHash(JSON.parse(before.toString()).payload));
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; } }
  }, 20000);
});
