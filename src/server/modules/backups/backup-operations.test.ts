import { mkdtempSync, existsSync, rmSync, renameSync, symlinkSync, writeFileSync, readFileSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService } from "@/server/modules/authentication";
import { BackupOperations } from "./backup-operations";
import { backupPolicySchema } from "./policy";
import { recordHash } from "./records";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { evaluateBackupMonitor, parseBackupMonitorOptions } from "@/cli/backup-monitor";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture(options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "backup-operations-"));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  const authentication = new AuthenticationService(store); const token = authentication.generateToken("fixture").token;
  const actor = authentication.authenticateInstallation(token)!;
  let now = Date.parse("2026-10-01T00:00:00Z"), maintenance = false;
  const policy = backupPolicySchema.parse({ directory: join(root, "copies"), uiActions: ["create", "restore"], ...options });
  const deps = { databasePath: join(root, "state.sqlite3"), attachmentDirectory: join(root, "attachments"), applicationVersion: "fixture", source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: (actor: AuthenticatedPrincipal) => authentication.isCurrentInstallationActor(actor), maintenance: () => maintenance, clock: () => now };
  const operations = new BackupOperations(policy, deps);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => operations.close());
  return { root, store, authentication, actor, operations, policy, deps, advance: (ms: number) => { now += ms; }, maintain: () => { maintenance = true; } };
}

describe("service backup operations", () => {
  it("explains a scheduled catalog-budget refusal and preserves its evidence across restart", async () => {
    const f = fixture({ intervalSeconds: 60, maxBytes: 6_442_450_944 });
    // Catalog and nearby snapshot sizes from the incident, with no production data.
    vi.spyOn(f.deps, "estimateBytes").mockReturnValue(765_765_197);
    const list = vi.spyOn(f.operations.catalog, "list").mockReturnValue([
      { id: `backup-${crypto.randomUUID()}`, createdAt: null, sizeBytes: 6_361_245_145, compatibility: "supported", verification: "verified", protected: true },
    ]);
    const backup = vi.spyOn(f.store, "backup");
    vi.mocked(statfsSync).mockReturnValueOnce({ ...statfsSync(f.root), bavail: 10_000_000, bsize: 4096 });
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    const expected = {
      state: "failed", error: "backup_limit",
      limit: { reason: "catalog_bytes", current: 6_361_245_145, required: 765_765_197, maximum: 6_442_450_944 },
    };
    expect(f.operations.overview(f.actor).schedule.lastOperation).toMatchObject(expected);
    expect(backup).not.toHaveBeenCalled();
    list.mockRestore();
    await f.operations.close();
    const restarted = new BackupOperations(f.policy, f.deps);
    try {
      expect(restarted.overview(f.actor).schedule.lastOperation).toMatchObject(expected);
      expect(restarted.create("scheduler", `service:${f.deps.clock()}`)).toMatchObject(expected);
      expect(backup).not.toHaveBeenCalled();
    } finally { await restarted.close(); }
  });
  it("distinguishes disk headroom from catalog budget and succeeds at the next scheduled deadline", async () => {
    const f = fixture({ intervalSeconds: 60 });
    const required = f.deps.estimateBytes() + 16 * 1024 ** 2;
    vi.mocked(statfsSync).mockReturnValueOnce({ ...statfsSync(f.root), bavail: required - 1, bsize: 1 });
    const backup = vi.spyOn(f.store, "backup");
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    const failed = f.operations.overview(f.actor).schedule.lastOperation!;
    expect(failed).toMatchObject({ state: "failed", error: "backup_limit", limit: { reason: "filesystem_space", current: 0, required, maximum: required - 1 } });
    expect(backup).not.toHaveBeenCalled();
    // Exactly enough destination space passes; the failed deadline is never replayed.
    vi.mocked(statfsSync).mockReturnValueOnce({ ...statfsSync(f.root), bavail: required, bsize: 1 });
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    const overview = f.operations.overview(f.actor);
    expect(overview.schedule.lastOperation).toMatchObject({ state: "succeeded", error: null });
    expect(overview.schedule.lastOperation).not.toHaveProperty("limit");
    expect(overview.schedule.retention).toBe("succeeded");
    expect(overview.operations.find(op => op.operationId === failed.operationId)).toEqual(failed);
    expect(backup).toHaveBeenCalledOnce();
    expect(overview.copies).toHaveLength(1);
    await expect(f.operations.catalog.verifyAsync(overview.copies[0].id)).resolves.toMatchObject({ formatVersion: 1 });
  });
  it("preserves existing manual and scheduled recovery points when the next snapshot cannot fit", async () => {
    const f = fixture({ intervalSeconds: 60, retainCount: 1 });
    f.operations.create(f.actor, "protected-manual"); await f.operations.drain();
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    const before = f.operations.overview(f.actor).copies;
    const current = before.reduce((sum, copy) => sum + copy.sizeBytes!, 0);
    vi.spyOn(f.deps, "estimateBytes").mockReturnValue(f.policy.maxBytes - current + 1);
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    expect(f.operations.overview(f.actor).schedule.lastOperation).toMatchObject({ state: "failed", limit: { reason: "catalog_bytes" } });
    expect(f.operations.overview(f.actor).copies).toEqual(before);
    expect(f.operations.status(f.actor, "protected-manual").state).toBe("succeeded");
  });
  it("reports a later manual failure when scheduled priority overtakes its older admission", async () => {
    const f = fixture({ intervalSeconds: 60 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.operations.enqueueExport("monitor-gate", 1, () => gate, () => release());
    const backup = f.store.backup.bind(f.store);
    let count = 0;
    vi.spyOn(f.store, "backup").mockImplementation(async (...args) => { f.advance(1000); if (++count === 2) throw new Error("Manual backup failed."); return backup(...args); });
    f.operations.create(f.actor, "older-manual"); f.advance(60_000); f.operations.tick();
    release(); await f.operations.drain();
    expect(f.operations.overview(f.actor).schedule.lastOperation?.state).toBe("succeeded");
    expect(f.operations.status(f.actor, "older-manual").state).toBe("failed");
    const metadata = f.operations.monitorMetadata();
    expect(metadata.local).toMatchObject({ dataAt: "2026-10-01T00:01:00.000Z", lastAttempt: { dataAt: "2026-10-01T00:00:00.000Z", state: "failed", error: "backup_failed" } });
    expect(evaluateBackupMonitor(metadata, parseBackupMonitorOptions(["--enabled"]), f.deps.clock())).toMatchObject({ severity: "critical", alerts: ["local_failed"] });
  });
  it("projects bounded CLI metadata without scans and distinguishes missing recorded copies", async () => {
    const f = fixture({ intervalSeconds: 60 });
    const created = f.operations.create(f.actor, "monitor-copy"); await f.operations.drain();
    const scan = vi.spyOn(f.operations.catalog, "list").mockImplementation(() => { throw new Error("Monitor must not scan."); });
    const hydrate = vi.spyOn(f.operations.catalog, "manifest").mockImplementation(() => { throw new Error("Monitor must not hydrate."); });
    expect(f.operations.monitorMetadata()).toMatchObject({ scheduleEnabled: true, local: { dataAt: "2026-10-01T00:00:00.000Z", lastAttempt: { state: "succeeded" }, error: null }, remote: { enabled: false, dataAt: null } });
    expect(JSON.stringify(f.operations.monitorMetadata())).not.toContain(f.root);
    expect(JSON.stringify(f.operations.monitorMetadata())).not.toContain(f.actor.credentialId);
    const copy = join(f.policy.directory!, created.backupId);
    renameSync(join(copy, "state.sqlite3"), join(copy, "state.saved"));
    symlinkSync(join(copy, "state.saved"), join(copy, "state.sqlite3"));
    expect(f.operations.monitorMetadata().local).toMatchObject({ dataAt: null, error: "metadata_unavailable" });
    rmSync(copy, { recursive: true });
    expect(f.operations.monitorMetadata().local).toMatchObject({ dataAt: null, error: "metadata_unavailable" });
    expect(scan).not.toHaveBeenCalled(); expect(hydrate).not.toHaveBeenCalled();
  });
  it("distinguishes an unrecorded valid migration copy from a failed verification", async () => {
    const f = fixture(); const created = f.operations.create(f.actor, "migration-fixture"); await f.operations.drain();
    const id = `pre-migration-v1-${crypto.randomUUID()}`;
    renameSync(join(f.policy.directory!, created.backupId), join(f.policy.directory!, id));
    expect(f.operations.overview(f.actor).copies).toEqual([expect.objectContaining({ id, compatibility: "supported", verification: "unverified", protected: true })]);
    await expect(f.operations.catalog.verifyAsync(id)).resolves.toMatchObject({ formatVersion: 1 });
    writeFileSync(join(f.policy.directory!, id, "manifest.json"), "corrupt", { mode: 0o600 });
    expect(f.operations.overview(f.actor).copies[0]).toMatchObject({ verification: "failed", protected: true });
  });
  it("keeps the schedule usable with a full manual idempotency history across restart", async () => {
    const f = fixture({ intervalSeconds: 60 }); await f.operations.close();
    const path = join(f.operations.recordDirectory, "ledger.json"), envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.payload.operations = Array.from({ length: 1024 }, (_, index) => ({ operationId: crypto.randomUUID(), backupId: `backup-${crypto.randomUUID()}`, actorId: `installation:${f.actor.credentialId}`, key: `manual:${index}`, state: "failed", createdAt: new Date(f.deps.clock()).toISOString(), finishedAt: new Date(f.deps.clock()).toISOString(), error: "backup_failed", destination: join(f.policy.directory!, `absent-${index}`), scheduled: false, manifestHash: null }));
    envelope.sha256 = recordHash(envelope.payload); writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    const firstId = envelope.payload.operations[0].operationId;
    const restarted = new BackupOperations(f.policy, f.deps);
    try {
      expect(restarted.create(f.actor, "manual:0").operationId).toBe(firstId);
      expect(() => restarted.create(f.actor, "new-manual")).toThrow("backup_limit");
      try { restarted.create(f.actor, "new-manual"); } catch (error) {
        expect(error).toMatchObject({ limit: { reason: "manual_history", current: 1024, required: 1, maximum: 1024 } });
      }
      expect(restarted.create(f.actor, "manual:0")).not.toHaveProperty("limit");
      f.advance(60_000); restarted.tick(); await restarted.drain();
      expect(restarted.overview(f.actor).schedule.lastOperation?.state).toBe("succeeded");
      expect(restarted.overview(f.actor).schedule.error).toBeNull();
    } finally { await restarted.close(); }
    const again = new BackupOperations(f.policy, f.deps);
    try {
      expect(again.create(f.actor, "manual:0").operationId).toBe(firstId);
      f.advance(60_000); again.tick(); await again.drain();
      expect(again.overview(f.actor).schedule.lastOperation?.state).toBe("succeeded");
    } finally { await again.close(); }
  });
  it("serializes live backups on the controller connection and persists idempotency across restart", async () => {
    const f = fixture();
    const a = f.operations.create(f.actor, "same"), duplicate = f.operations.create(f.actor, "same");
    expect(duplicate.operationId).toBe(a.operationId);
    f.operations.create(f.actor, "second"); await f.operations.drain();
    expect(f.operations.overview(f.actor).copies).toHaveLength(2);
    expect(f.operations.status(f.actor, "same").state).toBe("succeeded");
    await f.operations.close();
    const restarted = new BackupOperations(f.policy, f.deps);
    try { expect(restarted.create(f.actor, "same").operationId).toBe(a.operationId); expect(restarted.overview(f.actor).copies).toHaveLength(2); }
    finally { await restarted.close(); }
    expect(() => new SqliteStateStore(f.deps.databasePath)).toThrow(/already running/);
  });
  it("denies project, legacy, open and revoked operator credentials at invocation and execution", async () => {
    const f = fixture({ queueLimit: 2 });
    for (const principalKind of ["owner", "agent", "worker"] as const) expect(() => f.operations.overview({ ...f.actor, principalKind })).toThrow("backup_forbidden");
    expect(() => f.operations.create({ ...f.actor, authenticationMethod: "none" }, "open")).toThrow("backup_forbidden");
    f.operations.create(f.actor, "first"); f.operations.create(f.actor, "revoked-in-queue");
    f.authentication.rotateToken("fixture");
    await f.operations.drain();
    expect(() => f.operations.status(f.actor, "first")).toThrow("backup_forbidden");
    const overview = f.operations.overview("local-admin");
    expect(overview.operations.find(op => op.backupId !== overview.operations[1]?.backupId)?.state).toBe("failed");
  });
  it("caps admission and history and keeps manual creation separate from the next deadline", async () => {
    const f = fixture({ intervalSeconds: 60, queueLimit: 1 });
    const next = f.operations.overview(f.actor).schedule.nextAt;
    f.operations.create(f.actor, "manual");
    expect(() => f.operations.create(f.actor, "full")).toThrow("backup_limit");
    expect(f.operations.overview(f.actor).schedule.nextAt).toBe(next);
    await f.operations.drain();
  });
  it("admits only one overdue attempt after a long outage and does not run retention when disabled", async () => {
    const f = fixture({ intervalSeconds: 60, retainCount: 1 });
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    expect(f.operations.overview(f.actor).copies).toHaveLength(1);
    await f.operations.close(); f.advance(10 * 86400_000);
    const restarted = new BackupOperations(f.policy, f.deps);
    restarted.tick(); restarted.tick(); await restarted.drain();
    expect(restarted.overview(f.actor).operations).toHaveLength(3);
    expect(Date.parse(restarted.overview(f.actor).schedule.nextAt!)).toBeGreaterThan(f.deps.clock());
    await restarted.close();
    const disabled = new BackupOperations({ ...f.policy, intervalSeconds: null }, f.deps);
    try { disabled.start(); disabled.tick(); expect(disabled.overview(f.actor).schedule.nextAt).toBeNull(); expect(disabled.overview(f.actor).copies).toHaveLength(1); }
    finally { await disabled.close(); }
  });
  it("retains unknown/manual/pre-migration files and refuses altered or symlinked candidates", async () => {
    const f = fixture({ intervalSeconds: 60, retainCount: 1 });
    f.operations.create(f.actor, "manual"); await f.operations.drain();
    writeFileSync(join(f.policy.directory!, "unrelated"), "keep");
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    const first = f.operations.overview(f.actor).schedule.lastOperation!;
    const path = join(f.policy.directory!, first.backupId), original = join(path, "manifest.json");
    writeFileSync(original, "corrupt", { mode: 0o600 });
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    expect(existsSync(original)).toBe(true); expect(existsSync(join(f.policy.directory!, "unrelated"))).toBe(true);
    expect(f.operations.overview(f.actor).copies).toHaveLength(3);
    expect(f.operations.overview(f.actor).schedule.retention).toBe("failed");
    rmSync(path, { recursive: true }); symlinkSync(f.root, path);
    f.advance(60_000); f.operations.tick(); await f.operations.drain();
    expect(readFileSync(join(f.policy.directory!, "unrelated"), "utf8")).toBe("keep");
  });
  it("accounts for durable queued/running interruption and never repeats failed keys", async () => {
    const f = fixture(); await f.operations.close();
    const path = join(f.operations.recordDirectory, "ledger.json"), envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.payload.operations.push({ operationId: crypto.randomUUID(), backupId: `backup-${crypto.randomUUID()}`, actorId: `installation:${f.actor.credentialId}`, key: "interrupted", state: "running", createdAt: new Date(f.deps.clock()).toISOString(), finishedAt: null, error: null, destination: join(f.policy.directory!, "absent"), scheduled: false, manifestHash: null });
    envelope.sha256 = recordHash(envelope.payload); writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    const restarted = new BackupOperations(f.policy, f.deps);
    try { expect(restarted.create(f.actor, "interrupted").state).toBe("interrupted"); expect(restarted.overview(f.actor).copies).toHaveLength(0); }
    finally { await restarted.close(); }
  });
  it("surfaces backup failures while leaving the controller store usable", async () => {
    const f = fixture({ maxBytes: 1024 ** 2 });
    f.deps.source.backup = async () => { throw new Error("fixture ENOSPC"); };
    f.operations.create(f.actor, "fails"); await f.operations.drain();
    expect(f.operations.status(f.actor, "fails")).toMatchObject({ state: "failed", error: "backup_failed" });
    expect(f.operations.overview(f.actor).copies).toHaveLength(0);
    expect(f.store.listProjects()).toEqual([]);
  });
  it("refuses publication after its cooperative execution deadline", async () => {
    const f = fixture({ timeoutSeconds: 1 });
    const copy = f.store.backup.bind(f.store);
    f.deps.source.backup = async destination => { await copy(destination); f.advance(1001); };
    f.operations.create(f.actor, "expired"); await f.operations.drain();
    expect(f.operations.status(f.actor, "expired").state).toBe("failed");
    expect(f.operations.overview(f.actor).copies).toHaveLength(0);
    expect(f.store.listProjects()).toEqual([]);
  });
  it("bounds retired service history without losing the durable replay watermark", async () => {
    const f = fixture({ intervalSeconds: 60 }); await f.operations.close();
    const path = join(f.operations.recordDirectory, "ledger.json"), envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.payload.scheduledThrough = 1024;
    envelope.payload.operations = Array.from({ length: 1024 }, (_, index) => ({ operationId: crypto.randomUUID(), backupId: `backup-${crypto.randomUUID()}`, actorId: "scheduler", key: `service:${index + 1}`, state: "failed", createdAt: new Date(f.deps.clock()).toISOString(), finishedAt: new Date(f.deps.clock()).toISOString(), error: "backup_failed", destination: join(f.policy.directory!, `absent-${index}`), scheduled: true, manifestHash: null }));
    envelope.sha256 = recordHash(envelope.payload); writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    const restarted = new BackupOperations(f.policy, f.deps);
    try {
      expect(restarted.create("scheduler", "service:1").state).toBe("failed");
      restarted.create(f.actor, "manual-after-history"); await restarted.drain();
      expect(JSON.parse(readFileSync(path, "utf8")).payload.operations).toHaveLength(51);
      expect(() => restarted.create("scheduler", "service:1")).toThrow("backup_invalid");
    } finally { await restarted.close(); }
    const again = new BackupOperations(f.policy, f.deps);
    try { expect(() => again.create("scheduler", "service:1")).toThrow("backup_invalid"); }
    finally { await again.close(); }
  });
  it("reports missed scheduled admission separately from retention", async () => {
    const f = fixture({ intervalSeconds: 60, queueLimit: 1 });
    f.operations.create(f.actor, "occupies-slot"); f.advance(60_000); f.operations.tick();
    const expected = { error: "backup_limit", limit: { reason: "queue", current: 1, required: 1, maximum: 1 }, retention: "idle" };
    expect(f.operations.overview(f.actor).schedule).toMatchObject(expected);
    await f.operations.drain(); await f.operations.close();
    const restarted = new BackupOperations(f.policy, f.deps);
    try {
      expect(restarted.overview(f.actor).schedule).toMatchObject(expected);
      f.advance(60_000); restarted.tick(); await restarted.drain();
      expect(restarted.overview(f.actor).schedule.error).toBeNull();
      expect(restarted.overview(f.actor).schedule).not.toHaveProperty("limit");
      expect(restarted.overview(f.actor).schedule.lastOperation?.state).toBe("succeeded");
    } finally { await restarted.close(); }
  });
  it("blocks new admission during maintenance and drains accepted backup material", async () => {
    const f = fixture(); f.operations.create(f.actor, "accepted"); f.maintain();
    expect(() => f.operations.create(f.actor, "new")).toThrow("backup_busy");
    await f.operations.close(); expect(f.operations.status(f.actor, "accepted").state).toBe("succeeded");
  });
  it("preserves the service deadline during an offline explicit backup and reconciles its published receipt", async () => {
    const f = fixture({ intervalSeconds: 60 });
    const next = f.operations.overview(f.actor).schedule.nextAt; await f.operations.close();
    const offlinePolicy = { ...f.policy, directory: undefined, intervalSeconds: null, uiActions: [] };
    const offline = new BackupOperations(offlinePolicy, { ...f.deps, manageSchedule: false });
    const destination = join(f.root, "explicit-copy");
    const operation = offline.create("local-admin", "offline", destination); await offline.drain(); await offline.close();
    const path = join(offline.recordDirectory, "ledger.json"), envelope = JSON.parse(readFileSync(path, "utf8"));
    expect(new Date(envelope.payload.nextAt).toISOString()).toBe(next);
    const row = envelope.payload.operations.find((item: { operationId: string }) => item.operationId === operation.operationId);
    row.state = "running"; row.finishedAt = null; row.manifestHash = null;
    envelope.sha256 = recordHash(envelope.payload); writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    const restarted = new BackupOperations(f.policy, f.deps);
    try {
      expect(restarted.status("local-admin", "offline").state).toBe("succeeded");
      expect(restarted.overview(f.actor).schedule.nextAt).toBe(next);
    } finally { await restarted.close(); }
  });
});
