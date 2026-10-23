import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { emptyTelemetry } from "@/server/modules/verification";
import type { TestRun } from "@/shared/contracts";
import { OwnedSqliteDatabase, SqliteStateStore, inspectSchema } from "./index";
import { TEST_SUMMARY_POLICY, TestSummaryQueries } from "./test-summary-queries";
import { initializeSchema } from "./migrations";
import { telemetryChecksum, telemetryMigration } from "./test-summary-migration";

const roots: string[] = [];
const stores: SqliteStateStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-summary-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const owned = new OwnedSqliteDatabase(path, true);
  const store = new SqliteStateStore(path, owned); stores.push(store);
  const project = store.addProject({ name: "App", repositoryPath: root, port: 3210, executable: "node", args: [] });
  const other = store.addProject({ name: "Other", repositoryPath: join(root, "other"), port: 3211, executable: "node", args: [] });
  const run = (overrides: Partial<TestRun> = {}): TestRun => ({
    id: randomUUID(), projectId: project.id, worktreePath: root, worktreeHead: "aaa", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "local-user", phase: "passed", queuePosition: null,
    executable: "node", args: ["--token=command-secret"], cwd: root,
    queuedAt: new Date().toISOString(), startedAt: null, finishedAt: new Date().toISOString(), exitCode: 0, signal: null,
    error: "free-form-secret", logs: ["log-secret"], environmentMode: "clean", environmentProfile: "private-profile-secret",
    inheritedServerProfile: "server-profile-secret", environmentVariableNames: ["ENV_SECRET"], source: legacySourceEvidence(), ...overrides,
  });
  return { root, path, owned, store, project, other, run, summaries: new TestSummaryQueries(owned.database) };
}

describe("durable bounded test summary history", () => {
  it("survives pruning 50 detailed runs, contains no tails, args or profile values, and retries idempotently", () => {
    const f = fixture(); const runs = Array.from({ length: 60 }, (_, i) => f.run({ queuedAt: new Date(Date.now() + i).toISOString() }));
    for (const run of runs) f.store.saveTestRun(run);
    expect(f.store.listTestRuns(f.project.id)).toHaveLength(50);
    expect(f.store.getTestRun(runs[0].id)).toBeNull();
    expect(f.summaries.get(runs[0].id)).toMatchObject({ version: 1, runId: runs[0].id, telemetry: { availability: "legacy_unknown", durations: { processMs: null } } });
    const json = JSON.stringify(f.summaries.get(runs[0].id));
    for (const secret of ["command-secret", "free-form-secret", "log-secret", "private-profile-secret", "server-profile-secret", "ENV_SECRET"]) expect(json).not.toContain(secret);
    const usage = f.summaries.coverage(f.project.id);
    f.store.saveTestRun(runs[59]); f.store.saveTestRun(runs[59]);
    expect(f.summaries.coverage(f.project.id)).toEqual(usage);
    expect(usage.records).toBe(60);
    expect(usage.bytes).toBeGreaterThan(0);
  });

  it("migrates a real v28 database, backfills honest legacy data and records checked provenance", () => {
    const f = fixture(); const run = f.run(); f.store.saveTestRun(run);
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const old = new Database(f.path);
    old.exec("DROP TABLE test_run_summaries; DROP TABLE test_summary_coverage; ALTER TABLE test_runs DROP COLUMN telemetry_json; DELETE FROM schema_migrations WHERE version>=29;");
    expect(inspectSchema(old).version).toBe(28); old.close();
    const owned = new OwnedSqliteDatabase(f.path);
    const reopened = new SqliteStateStore(f.path, owned); stores.push(reopened);
    expect(reopened.schemaVersion()).toBe(31);
    expect(reopened.getTestRun(run.id)?.telemetry).toMatchObject({ availability: "legacy_unknown", admittedAt: null, exitedAt: null });
    expect(new TestSummaryQueries(owned.database).get(run.id)?.telemetry.durations.processMs).toBeNull();
    expect(owned.database.prepare("SELECT name,checksum FROM schema_migrations WHERE version=29").get()).toEqual({ name: telemetryMigration.name, checksum: telemetryChecksum });
    expect(inspectSchema(owned.database).version).toBe(31);
  });

  it("rolls migration 29 and its backfill back together, and rejects changed provenance", () => {
    const f = fixture(); const run = f.run(); f.store.saveTestRun(run);
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const old = new Database(f.path);
    old.exec("DROP TABLE test_run_summaries; DROP TABLE test_summary_coverage; ALTER TABLE test_runs DROP COLUMN telemetry_json; DELETE FROM schema_migrations WHERE version>=29;");
    expect(() => initializeSchema(old, false, () => { throw Error("injected migration validation failure"); })).toThrow("injected migration");
    expect(inspectSchema(old).version).toBe(28);
    expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name='test_run_summaries'").get()).toBeUndefined();
    expect(old.prepare("SELECT id FROM test_runs").get()).toEqual({ id: run.id });
    old.close();
    const reopened = new SqliteStateStore(f.path); reopened.close();
    const tampered = new Database(f.path);
    tampered.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=29"); tampered.close();
    expect(() => new SqliteStateStore(f.path)).toThrow("migration checksum or name");
  });

  it("reconciles queued, active and unfinished-finalization rows once without fabricating exit/cleanup times", () => {
    const f = fixture();
    const queued = f.run({ phase: "queued", finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") });
    const running = f.run({ phase: "running", finishedAt: null, exitCode: 0, telemetry: { ...emptyTelemetry("observed"), admittedAt: "2026-10-19T00:00:00.000Z", spawnedAt: "2026-10-19T00:00:01.000Z", exitedAt: "2026-10-19T00:00:02.000Z", durations: { ...emptyTelemetry().durations, processMs: 1000 } }, source: { ...legacySourceEvidence(), processOutcome: "passed" } });
    const finalizing = f.run({ phase: "cancelled", telemetry: emptyTelemetry("observed") });
    for (const run of [queued, running, finalizing]) f.store.saveTestRun(run);
    f.store.markInterruptedTestRuns();
    for (const run of [queued, running, finalizing]) expect(f.summaries.get(run.id)).toMatchObject({ phase: "interrupted", telemetry: { availability: "partial", termination: "interruption", recoveredAt: expect.any(String), cleanupFinishedAt: null, finalizedAt: null, durations: { totalMs: null } } });
    expect(f.summaries.get(running.id)).toMatchObject({ processOutcome: "passed", exitCode: 0, telemetry: { durations: { processMs: 1000 } } });
    const before = [queued, running, finalizing].map(run => f.summaries.get(run.id));
    f.store.markInterruptedTestRuns();
    expect([queued, running, finalizing].map(run => f.summaries.get(run.id))).toEqual(before);
    expect(f.summaries.coverage(f.project.id).records).toBe(3);
  });

  it("rolls back detail and summary together when primary summary durability fails", () => {
    const f = fixture(); const run = f.run();
    f.owned.database.exec("CREATE TEMP TRIGGER fail_summary BEFORE INSERT ON test_run_summaries BEGIN SELECT RAISE(ABORT,'summary disk failure'); END");
    expect(() => f.store.saveTestRun(run)).toThrow("summary disk failure");
    expect(f.store.getTestRun(run.id)).toBeNull();
    expect(f.summaries.coverage(f.project.id).records).toBe(0);
  });

  it("bounds oversized identities and refuses oversized records instead of silently dropping durable history", () => {
    const f = fixture(); const run = f.run({ worktreePath: "x".repeat(9000), presetId: "p".repeat(9000), source: { ...legacySourceEvidence(), reasonCodes: ["reason-secret"] } });
    f.store.saveTestRun(run);
    expect(f.summaries.get(run.id)?.worktreePath).toMatch(/^sha256:/);
    expect(f.summaries.get(run.id)?.sourceReasonCodes).toEqual(["source_evidence_incomplete"]);
    expect(JSON.stringify(f.summaries.get(run.id))).not.toContain("reason-secret");
    const tiny = new TestSummaryQueries(f.owned.database, { ...TEST_SUMMARY_POLICY, maxRecordBytes: 100 });
    expect(() => f.owned.database.transaction(() => tiny.save(f.run()))()).toThrow("record budget");
  });

  it("enforces per-project and global count caps without deleting active summaries or detail state", () => {
    const f = fixture(); const q = new TestSummaryQueries(f.owned.database, { ...TEST_SUMMARY_POLICY, perProjectRecords: 3, globalRecords: 4 });
    const active = f.run({ phase: "running", finishedAt: null, telemetry: emptyTelemetry("observed") });
    f.store.saveTestRun(active);
    for (let i = 0; i < 5; i++) f.owned.database.transaction(() => q.save(f.run({ queuedAt: new Date(Date.now() + i).toISOString() })))();
    f.owned.database.transaction(() => q.prune(f.project.id))();
    expect(q.coverage(f.project.id)).toMatchObject({ records: 3, evicted: 3 });
    for (let i = 0; i < 3; i++) f.owned.database.transaction(() => q.save(f.run({ projectId: f.other.id, queuedAt: new Date(Date.now() + 100 + i).toISOString() })))();
    f.owned.database.transaction(() => q.prune(f.other.id))();
    expect(q.coverage(f.project.id).records + q.coverage(f.other.id).records).toBe(4);
    expect(q.get(active.id)?.phase).toBe("running");
    expect(f.store.getTestRun(active.id)?.phase).toBe("running");
  });

  it.each(["per-project", "global"])("enforces logical byte budgets: %s", mode => {
    const f = fixture(); const q = new TestSummaryQueries(f.owned.database, { ...TEST_SUMMARY_POLICY,
      perProjectBytes: mode === "per-project" ? 2500 : TEST_SUMMARY_POLICY.perProjectBytes,
      globalBytes: mode === "global" ? 2500 : TEST_SUMMARY_POLICY.globalBytes });
    for (let i = 0; i < 6; i++) f.owned.database.transaction(() => q.save(f.run()))();
    f.owned.database.transaction(() => q.prune(f.project.id))();
    expect(q.coverage(f.project.id).bytes).toBeLessThanOrEqual(2500);
    expect(q.coverage(f.project.id).evicted).toBeGreaterThan(0);
  });

  it("prunes expired history incrementally, reports coverage and never expires active state", () => {
    const f = fixture(); const expired = "2000-01-01T00:00:00.000Z";
    const active = f.run({ phase: "queued", queuedAt: expired, finishedAt: null, telemetry: emptyTelemetry("observed") });
    f.store.saveTestRun(active);
    for (let i = 0; i < 130; i++) f.owned.database.transaction(() => f.summaries.save(f.run({ queuedAt: expired })))();
    expect(f.summaries.coverage(f.project.id).maintenancePending).toBe(true);
    expect(f.store.pruneTestSummaryHistory()).toBe(64);
    expect(f.summaries.coverage(f.project.id)).toMatchObject({ records: 67, evicted: 64, maintenancePending: true });
    expect(f.store.pruneTestSummaryHistory()).toBe(64);
    expect(f.store.pruneTestSummaryHistory()).toBe(2);
    expect(f.summaries.coverage(f.project.id)).toMatchObject({ records: 1, evicted: 130, oldestQueuedAt: expired, maintenancePending: false });
    expect(f.store.getTestRun(active.id)?.phase).toBe("queued");
  });

  it("cascades summaries and coverage with authorized project deletion, leaving other projects intact", () => {
    const f = fixture(); const first = f.run(), other = f.run({ projectId: f.other.id });
    f.store.saveTestRun(first); f.store.saveTestRun(other);
    f.store.removeProject(f.project.id, "local-user");
    expect(f.summaries.get(first.id)).toBeNull();
    expect(f.summaries.coverage(f.project.id).records).toBe(0);
    expect(f.summaries.get(other.id)).not.toBeNull();
  });
});
