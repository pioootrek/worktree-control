import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStateStore } from "@/server/sqlite-store";
import { BackupOperations } from "./backup-operations";
import { backupPolicySchema } from "./policy";
import { remoteBackupPolicySchema, type RemoteBackupTransport } from "./remote-policy";
import { readRecord, writeRecord } from "./records";
import { z } from "zod";
import { rebindRemoteLedger } from "./remote-records";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(enabled = true, transportPolicy: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "remote-backup-")), databasePath = join(root, "state.sqlite3"), store = new SqliteStateStore(databasePath);
  let now = Date.now();
  const transport: RemoteBackupTransport = { destinationId: "a".repeat(64), policy: remoteBackupPolicySchema.parse({ attemptLimit: 1, ...transportPolicy }), upload: vi.fn(async () => ({ snapshotId: "b".repeat(64) })), close: vi.fn(async () => {}) };
  const policy = backupPolicySchema.parse({ directory: join(root, "copies"), intervalSeconds: 60, retainCount: 1 });
  const deps = { databasePath, attachmentDirectory: join(root, "attachments"), applicationVersion: "test", source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: () => false, maintenance: () => false, clock: () => now, remoteTransport: enabled ? transport : undefined };
  const operations = new BackupOperations(policy, deps);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => operations.close());
  return { root, operations, policy, deps, transport, advance: () => { now += 60_000; } };
}
describe("optional installation transfer", () => {
  it("opens historical local operation records without changing their checksum or enabling transfer", async () => {
    const f = fixture(false); f.operations.create("local-admin", "historical"); await f.operations.drain(); await f.operations.close();
    const path = join(f.operations.recordDirectory, "ledger.json"), ledger = readRecord(path, z.any());
    for (const operation of ledger.operations) delete operation.remoteRequired;
    writeRecord(path, ledger);
    const restarted = new BackupOperations(f.policy, { ...f.deps, remoteTransport: f.transport });
    try { restarted.start(); await restarted.drain(); expect(restarted.status("local-admin", "historical").state).toBe("succeeded"); expect(f.transport.upload).not.toHaveBeenCalled(); }
    finally { await restarted.close(); }
  });
  it("does not create remote records, timers, connections or alarms by default", async () => {
    const f = fixture(false); f.operations.start();
    f.operations.create("local-admin", "local"); await f.operations.drain();
    expect(f.operations.remote.status()).toEqual({ enabled: false, pending: 0, error: null, lastConfirmed: null, recovery: "not-measured", destinationId: null, rebindGeneration: 0, archives: [], transfers: [] });
    expect(existsSync(join(f.operations.recordDirectory, "remote.json"))).toBe(false);
    expect(f.transport.upload).not.toHaveBeenCalled();
  });
  it("keeps local success, remote confirmation and recovery evidence separate", async () => {
    const f = fixture(); const createdAt = new Date(f.deps.clock()).toISOString();
    const copy = f.operations.create("local-admin", "now"); await f.operations.drain();
    expect(f.operations.status("local-admin", "now").state).toBe("succeeded");
    expect(f.operations.remote.status()).toMatchObject({ enabled: true, pending: 0, lastConfirmed: { backupId: copy.backupId, dataAt: createdAt, snapshotId: "b".repeat(64) }, recovery: "not-measured" });
    expect(f.transport.upload).toHaveBeenCalledOnce();
    expect(f.operations.remote.retry(copy.backupId, 1).lastConfirmed?.backupId).toBe(copy.backupId);
    expect(f.transport.upload).toHaveBeenCalledOnce();
    const input = vi.mocked(f.transport.upload).mock.calls[0][0];
    expect(input.files.map(file => file.path)).toEqual(["/manifest.json", "/state.sqlite3"]);
    expect(JSON.stringify(f.operations.remote.status())).not.toContain(f.root);
  });
  it("bounds pending admission before creating copies and preserves all pending sources when disabled", async () => {
    const f = fixture(true, { pendingLimit: 2 }); vi.mocked(f.transport.upload).mockRejectedValue(new Error("fixture-password and private-path"));
    const a = f.operations.create("local-admin", "first"); const b = f.operations.create("local-admin", "second");
    expect(() => f.operations.create("local-admin", "third")).toThrow("backup_limit");
    await f.operations.drain();
    expect(f.operations.remote.status()).toMatchObject({ pending: 2, error: "remote_failed", lastConfirmed: null });
    expect(() => f.operations.create("local-admin", "third")).toThrow("backup_limit");
    expect(JSON.stringify(f.operations.remote.status())).not.toContain("fixture-password");
    await f.operations.close();
    const disabled = new BackupOperations(f.policy, { ...f.deps, remoteTransport: undefined });
    try {
      disabled.start(); f.advance(); disabled.tick(); await disabled.drain();
      expect(disabled.remote.status()).toMatchObject({ enabled: false, pending: 2, error: null });
      for (const id of [a.backupId, b.backupId]) expect(existsSync(join(f.policy.directory!, id))).toBe(true);
      expect(f.transport.upload).toHaveBeenCalledTimes(2);
    } finally { await disabled.close(); }
  });
  it("gives an explicit fenced retry a fresh bounded budget after an outage", async () => {
    const f = fixture(); vi.mocked(f.transport.upload).mockRejectedValueOnce(new Error("outage"));
    const copy = f.operations.create("local-admin", "outage"); await f.operations.drain();
    expect(f.operations.remote.status().transfers[0]).toMatchObject({ state: "failed", attempts: 1, retryGeneration: 0 });
    expect(() => f.operations.remote.retry(copy.backupId, 2)).toThrow("backup_invalid");
    f.operations.remote.retry(copy.backupId, 1); f.operations.remote.retry(copy.backupId, 1); await f.operations.drain();
    expect(f.operations.remote.status().transfers[0]).toMatchObject({ state: "confirmed", attempts: 1, retryGeneration: 1 });
    expect(f.transport.upload).toHaveBeenCalledTimes(2);
    await f.operations.close(); const restarted = new BackupOperations(f.policy, f.deps);
    try { restarted.start(); restarted.remote.retry(copy.backupId, 1); await restarted.drain(); expect(f.transport.upload).toHaveBeenCalledTimes(2); }
    finally { await restarted.close(); }
  });
  it("reconciles an interrupted final attempt without authorizing another upload", async () => {
    const f = fixture(); f.operations.create("local-admin", "lost-reply"); await f.operations.drain(); await f.operations.close();
    const path = join(f.operations.recordDirectory, "remote.json"), ledger = readRecord(path, z.any());
    ledger.receipts[0].state = "running"; ledger.receipts[0].confirmedAt = null; ledger.receipts[0].snapshotId = null; ledger.lastConfirmed = null; writeRecord(path, ledger);
    const restarted = new BackupOperations(f.policy, f.deps);
    try { restarted.start(); await restarted.drain(); expect(vi.mocked(f.transport.upload).mock.calls[1][1]).toEqual({ reconcileOnly: true }); expect(restarted.remote.status().transfers[0].state).toBe("confirmed"); }
    finally { await restarted.close(); }
  });
  it("reconciles a local publication whose remote receipt was not saved before restart", async () => {
    const f = fixture(); const copy = f.operations.create("local-admin", "intent"); await f.operations.drain(); await f.operations.close();
    const path = join(f.operations.recordDirectory, "remote.json"), ledger = readRecord(path, z.any()); ledger.receipts = []; ledger.lastConfirmed = null; writeRecord(path, ledger);
    const restarted = new BackupOperations(f.policy, f.deps);
    try { restarted.start(); await restarted.drain(); expect(restarted.remote.status().lastConfirmed?.backupId).toBe(copy.backupId); }
    finally { await restarted.close(); }
  });
  it("never transports unrecorded/migration/manual-path copies or a changed verified source", async () => {
    const f = fixture(); f.operations.create("local-admin", "explicit", join(f.root, "explicit")); await f.operations.drain();
    expect(f.transport.upload).not.toHaveBeenCalled();
    vi.mocked(f.transport.upload).mockRejectedValueOnce(new Error("outage"));
    const copy = f.operations.create("local-admin", "altered"); await f.operations.drain();
    writeFileSync(join(f.policy.directory!, copy.backupId, "unexpected"), "not in manifest");
    f.operations.remote.retry(copy.backupId, 1); await f.operations.drain();
    expect(f.transport.upload).toHaveBeenCalledOnce(); expect(f.operations.remote.status().lastConfirmed).toBeNull();
  });
  it("rejects a replacement repository and preserves external receipts across store data changes", async () => {
    const f = fixture(); vi.mocked(f.transport.upload).mockRejectedValue(new Error("lost repository"));
    const pending = f.operations.create("local-admin", "repository"); await f.operations.drain(); await f.operations.close();
    expect(() => new BackupOperations(f.policy, { ...f.deps, remoteTransport: { ...f.transport, destinationId: "c".repeat(64) } })).toThrow("backup_invalid");
    const disabled = new BackupOperations(f.policy, { ...f.deps, remoteTransport: undefined });
    try {
      disabled.start(); await disabled.drain();
      expect(disabled.remote.status()).toMatchObject({ enabled: false, pending: 1, error: null });
      expect(disabled.remote.protectedIds().has(pending.backupId)).toBe(true);
      disabled.create("local-admin", "rescue", join(f.root, "rescue")); await disabled.drain();
      expect(disabled.status("local-admin", "rescue").state).toBe("succeeded");
      expect(f.transport.upload).toHaveBeenCalledOnce();
      expect(readFileSync(join(f.operations.recordDirectory, "remote.json"), "utf8")).toContain(pending.backupId);
    } finally { await disabled.close(); }
  });
  it("compacts confirmed retired service receipts beyond 1024 while preserving latest evidence and pending work", async () => {
    const f = fixture(); f.operations.create("local-admin", "seed"); await f.operations.drain(); await f.operations.close();
    const path = join(f.operations.recordDirectory, "remote.json"), ledger = readRecord(path, z.any());
    const seed = ledger.receipts[0];
    ledger.receipts.push(...Array.from({ length: 1100 }, () => ({ ...seed, backupId: `backup-${crypto.randomUUID()}` })));
    const pending = { ...seed, backupId: `backup-${crypto.randomUUID()}`, state: "failed", confirmedAt: null, snapshotId: null, error: "remote_failed" }; ledger.receipts.push(pending); writeRecord(path, ledger);
    const restarted = new BackupOperations(f.policy, f.deps);
    try {
      restarted.create("local-admin", "after-1100"); await restarted.drain();
      const persisted = readRecord(path, z.any()); expect(persisted.receipts).toHaveLength(3);
      expect(persisted.receipts.some((value: { backupId: string }) => value.backupId === pending.backupId)).toBe(true);
      expect(persisted.lastConfirmed).not.toBeNull();
    } finally { await restarted.close(); }
  });
  it("preserves archived pins when disabled and admits only one explicit new-target transfer with original age", async () => {
    const f = fixture(); vi.mocked(f.transport.upload).mockRejectedValueOnce(new Error("old uncertain outcome"));
    const copy = f.operations.create("local-admin", "old-target"); await f.operations.drain(); await f.operations.close();
    const path = join(f.operations.recordDirectory, "remote.json"); rebindRemoteLedger(path, f.transport.destinationId, "c".repeat(64), 1);
    const transport = { ...f.transport, destinationId: "c".repeat(64) };
    const disabled = new BackupOperations(f.policy, { ...f.deps, remoteTransport: undefined });
    expect(disabled.remote.protectedIds().has(copy.backupId)).toBe(true); await disabled.close();
    const restarted = new BackupOperations(f.policy, { ...f.deps, remoteTransport: transport });
    try {
      restarted.start(); await restarted.drain(); expect(transport.upload).toHaveBeenCalledOnce();
      expect(restarted.remote.status()).toMatchObject({ lastConfirmed: null, pending: 0, archives: [{ pinned: 1, receipts: 1 }] });
      expect(() => restarted.remote.reupload(`backup-${crypto.randomUUID()}`)).toThrow("backup_invalid");
      restarted.remote.reupload(copy.backupId); restarted.remote.reupload(copy.backupId); await restarted.drain();
      expect(transport.upload).toHaveBeenCalledTimes(2);
      expect(restarted.remote.status().lastConfirmed).toMatchObject({ backupId: copy.backupId, dataAt: copy.createdAt });
      expect(restarted.remote.protectedIds().has(copy.backupId)).toBe(true);
      expect(readRecord(path, z.any()).archives[0].receipts[0].error).toBe("remote_failed");
    } finally { await restarted.close(); }
  });
  it("persists continuation budgets through restart without spending another write attempt", async () => {
    const f = fixture(true, { retrySeconds: 60 });
    const proof = { snapshotId: "d".repeat(64), tree: "e".repeat(64), state: "partial" as const };
    vi.mocked(f.transport.upload).mockResolvedValue({ progress: true, proofs: [proof], uploadAttempted: false });
    const copy = f.operations.create("local-admin", "progress"); await f.operations.drain();
    expect(f.operations.remote.status().transfers[0]).toMatchObject({ state: "pending", attempts: 0, reconciliation: { passes: 1, classified: 1, readReservedBytes: 256 * 1024 * 1024 } });
    await f.operations.close(); const restarted = new BackupOperations(f.policy, f.deps);
    try {
      restarted.start(); await restarted.drain(); expect(f.transport.upload).toHaveBeenCalledOnce();
      for (let i = 1; i < 8; i++) { f.advance(); restarted.remote.tick(); await restarted.drain(); }
      expect(f.transport.upload).toHaveBeenCalledTimes(8);
      expect(restarted.remote.status().transfers[0]).toMatchObject({ state: "failed", attempts: 0, reconciliation: { passes: 8, classified: 1, readReservedBytes: 2 * 1024 ** 3 } });
      f.advance(); restarted.remote.tick(); await restarted.drain(); expect(f.transport.upload).toHaveBeenCalledTimes(8);
      vi.mocked(f.transport.upload).mockResolvedValue({ snapshotId: "f".repeat(64) }); restarted.remote.retry(copy.backupId, 1); await restarted.drain();
      expect(vi.mocked(f.transport.upload).mock.calls[8][0].reconciliation?.proofs).toEqual([proof]);
      expect(restarted.remote.status().transfers[0]).toMatchObject({ state: "confirmed", attempts: 1, retryGeneration: 1, reconciliation: { passes: 1 } });
    } finally { await restarted.close(); }
  });

});
