import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestRun } from "@/shared/contracts";
import { emptyRunResources, emptyTelemetry, resourceReason } from "@/server/modules/verification";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { SqliteStateStore } from "./sqlite-state-store";
import { mapTestRun, prepareInterruptedTestRuns, TestRunQueries, type RecoveryPosition, type TestRunRow } from "./test-run-queries";
import { summarizeTestRun, TEST_SUMMARY_POLICY, type TestSummaryPolicy } from "./test-summary-queries";
import { exact } from "./fixtures/exact-rows";

/**
 * The recovery of interrupted runs (`markInterruptedTestRuns`) after its split
 * into a read-only preparation and a write phase: for every input the
 * recovery handled before, it writes the same rows, values and statements in
 * the same order; where the recovery threw, the preparation throws the same
 * error before anything is written, and names the row.
 */

const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// The recovery before the split, copied as a literal from the integration
// branch at 27e79d1e (`test-run-queries.ts` and `test-summary-queries.ts`):
// `markInterruptedTestRuns`, the `saveRunAndSummary` it called, the history
// trimming, and the summary `save` and `prune` with their accounting.

const BEFORE_PROJECT_RETENTION_EXCESS = `
  SELECT id FROM test_runs WHERE id IN (
    SELECT id FROM test_runs WHERE project_id = ? AND phase NOT IN ('queued', 'running')
    AND NOT EXISTS (SELECT 1 FROM test_run_summaries s WHERE s.run_id=test_runs.id AND s.terminal=0)
    ORDER BY queued_at DESC, id DESC LIMIT -1 OFFSET 50
  )
  AND id NOT IN (
    SELECT json_extract(payload_json, '$.localRunId') FROM remote_worker_receipts
    WHERE json_extract(payload_json, '$.localRunId') IS NOT NULL
    AND coalesce(json_extract(payload_json, '$.reports[#-1].phase'), '')
      NOT IN ('succeeded', 'failed', 'cancelled', 'uncertain')
  )`;
const BEFORE_RECOVERY_RETENTION_EXCESS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY queued_at DESC, id DESC) AS rank
    FROM test_runs WHERE phase NOT IN ('queued', 'running')
  ) WHERE rank > 50`;
function beforeDeleteTestRuns(database: Database.Database, selection: string, ...parameters: string[]): void {
  database.prepare(`DELETE FROM test_run_requesters WHERE run_id IN (${selection})`).run(...parameters);
  database.prepare(`DELETE FROM human_test_run_requesters WHERE run_id IN (${selection})`).run(...parameters);
  database.prepare(`DELETE FROM test_runs WHERE id IN (${selection})`).run(...parameters);
}
class SummariesBefore {
  constructor(private readonly database: Database.Database, private readonly policy: TestSummaryPolicy = TEST_SUMMARY_POLICY) {}
  save(run: TestRun): void {
    const summary = summarizeTestRun(run);
    const json = JSON.stringify(summary);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.policy.maxRecordBytes) throw new Error("Test summary exceeds its bounded record budget.");
    const old = this.database.prepare("SELECT project_id, bytes, summary_json FROM test_run_summaries WHERE run_id = ?").get(run.id) as { project_id: string; bytes: number; summary_json: string } | undefined;
    if (old && old.project_id !== run.projectId) throw new Error("Test summary project identity cannot change.");
    if (old?.summary_json === json) return;
    const terminal = run.phase !== "queued" && run.phase !== "running"
      && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || !!run.telemetry.finalizedAt || !!run.telemetry.recoveredAt);
    this.database.prepare(`INSERT INTO test_run_summaries(run_id, project_id, queued_at, terminal, bytes, summary_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET
      terminal=excluded.terminal, bytes=excluded.bytes, summary_json=excluded.summary_json`)
      .run(run.id, run.projectId, run.queuedAt, terminal ? 1 : 0, bytes, json);
    this.database.prepare(`INSERT INTO test_summary_coverage(project_id, records, bytes) VALUES (?, 1, ?)
      ON CONFLICT(project_id) DO UPDATE SET records=records+?, bytes=bytes+?`)
      .run(run.projectId, bytes, old ? 0 : 1, bytes - (old?.bytes ?? 0));
  }
  private usage(projectId?: string): { records: number; bytes: number } {
    return this.database.prepare(projectId ? "SELECT records,bytes FROM test_summary_coverage WHERE project_id=?"
      : "SELECT coalesce(sum(records),0) records,coalesce(sum(bytes),0) bytes FROM test_summary_coverage")
      .get(...(projectId ? [projectId] : [])) as { records: number; bytes: number } ?? { records: 0, bytes: 0 };
  }
  prune(projectId?: string, now = new Date().toISOString()): number {
    const cutoff = new Date(Date.parse(now) - this.policy.maxAgeMs).toISOString();
    let deleted = 0;
    const remove = (condition: string, args: (string | number)[], limit: number, requiredBytes = 0) => {
      let removedBytes = 0, removedRecords = 0;
      const rows = this.database.prepare(`SELECT run_id,project_id,bytes FROM test_run_summaries
        WHERE terminal=1 AND ${condition} ORDER BY queued_at,run_id LIMIT ?`).all(...args, Math.min(requiredBytes ? this.policy.pruneBatch : limit, this.policy.pruneBatch - deleted)) as Array<{ run_id: string; project_id: string; bytes: number }>;
      for (const row of rows) {
        this.database.prepare("DELETE FROM test_run_summaries WHERE run_id=?").run(row.run_id);
        this.database.prepare(`UPDATE test_summary_coverage SET records=records-1,bytes=bytes-?,evicted=evicted+1,last_pruned_at=? WHERE project_id=?`)
          .run(row.bytes, now, row.project_id);
        deleted++; removedRecords++; removedBytes += row.bytes;
        if (removedRecords >= limit && removedBytes >= requiredBytes) break;
      }
    };
    remove("queued_at < ?", [cutoff], this.policy.pruneBatch);
    projectId ??= (this.database.prepare("SELECT project_id FROM test_summary_coverage WHERE records>? OR bytes>? ORDER BY project_id LIMIT 1")
      .get(this.policy.perProjectRecords, this.policy.perProjectBytes) as { project_id: string } | undefined)?.project_id;
    const local = projectId ? this.usage(projectId) : { records: 0, bytes: 0 };
    if (projectId && deleted < this.policy.pruneBatch && (local.records > this.policy.perProjectRecords || local.bytes > this.policy.perProjectBytes)) {
      const excess = Math.max(0, local.records - this.policy.perProjectRecords);
      remove("project_id=?", [projectId], excess, Math.max(0, local.bytes - this.policy.perProjectBytes));
    }
    const global = this.usage();
    if (deleted < this.policy.pruneBatch && (global.records > this.policy.globalRecords || global.bytes > this.policy.globalBytes)) {
      const excess = Math.max(0, global.records - this.policy.globalRecords);
      remove("1=1", [], excess, Math.max(0, global.bytes - this.policy.globalBytes));
    }
    return deleted;
  }
}
function beforeSaveRunAndSummary(database: Database.Database, run: TestRun, idempotencyKey?: string): void {
  database.prepare(`
      INSERT INTO test_runs (
        id, project_id, worktree_path, worktree_head, worktree_branch, worktree_dirty,
        preset_id, preset_name, adapter, actor, phase, queue_position, executable,
        args_json, cwd, queued_at, started_at, finished_at, exit_code, signal, error,
        logs_json, idempotency_key, environment_mode, environment_profile,
        inherited_server_profile, environment_variable_names_json, source_json, telemetry_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phase = excluded.phase, queue_position = excluded.queue_position,
        executable = excluded.executable, args_json = excluded.args_json, cwd = excluded.cwd,
        environment_variable_names_json = excluded.environment_variable_names_json,
        started_at = excluded.started_at, finished_at = excluded.finished_at,
        exit_code = excluded.exit_code, signal = excluded.signal, error = excluded.error,
        logs_json = excluded.logs_json, source_json = excluded.source_json, telemetry_json = excluded.telemetry_json
    `).run(
    run.id, run.projectId, run.worktreePath, run.worktreeHead, run.worktreeBranch,
    run.worktreeDirty ? 1 : 0, run.presetId, run.presetName, run.adapter, run.actor,
    run.phase, run.queuePosition, run.executable, JSON.stringify(run.args), run.cwd, run.queuedAt,
    run.startedAt, run.finishedAt, run.exitCode, run.signal, run.error,
    JSON.stringify(run.logs), idempotencyKey ?? null, run.environmentMode, run.environmentProfile,
    run.inheritedServerProfile, JSON.stringify(run.environmentVariableNames), JSON.stringify(run.source), JSON.stringify(run.telemetry ?? emptyTelemetry()),
  );
  const summaries = new SummariesBefore(database);
  summaries.save(run);
  if (["passed", "failed", "cancelled", "timed_out", "interrupted"].includes(run.phase)
    && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || run.telemetry.finalizedAt || run.telemetry.recoveredAt)) {
    summaries.prune(run.projectId);
    beforeDeleteTestRuns(database, BEFORE_PROJECT_RETENTION_EXCESS, run.projectId);
  }
}
function markInterruptedTestRunsBefore(database: Database.Database): void {
  const now = new Date().toISOString();
  database.transaction(() => {
    const pending = database.prepare("SELECT * FROM test_runs WHERE phase IN ('queued', 'running') OR id IN (SELECT run_id FROM test_run_summaries WHERE terminal=0)").all() as TestRunRow[];
    for (const row of pending) {
      const run = mapTestRun(row);
      run.source.processOutcome ??= "interrupted";
      if (run.source.attribution === "pending") run.source.attribution = "uncertain";
      run.source.reasonCodes = [...new Set([...run.source.reasonCodes, "controller_interrupted"])].slice(0, 12);
      run.phase = "interrupted";
      run.finishedAt = now;
      run.queuePosition = null;
      run.error = "Kontroler został zatrzymany przed zakończeniem testu.";
      run.telemetry ??= emptyTelemetry();
      if (run.telemetry.availability !== "legacy_unknown") run.telemetry.availability = "partial";
      if (run.telemetry.resources && run.telemetry.resources.status !== "legacy_unknown") {
        const resources = run.telemetry.resources;
        if (resources.status !== "unsupported") resources.status = resources.sampleCount ? "partial" : "unavailable";
        resourceReason(resources, "controller_interrupted");
      }
      run.telemetry.termination = "interruption";
      run.telemetry.recoveredAt = now;
      beforeSaveRunAndSummary(database, run);
    }
    beforeDeleteTestRuns(database, BEFORE_RECOVERY_RETENTION_EXCESS);
  })();
}

// ---------------------------------------------------------------------------
// A populated installation

/** The fixed clock of every recovery here; history is dated relative to it. */
const NOW = "2025-06-01T12:00:00.000Z";
const ago = (days: number, index = 0) => new Date(Date.parse(NOW) - days * 86_400_000 + index * 1000).toISOString();
const FINGERPRINT = "f".repeat(64);

/**
 * Three registrations, written through the store (`saveTestRun` saves each
 * run with its summary and accounting, prunes and trims as the product does),
 * then history the product's own trimming would not leave, added raw:
 * - A: 50 kept runs and 14 older ones beyond them (some with summaries, half
 *   of all of them older than the 30-day summary horizon), two queued runs
 *   (one with legacy NULL source and telemetry), a running run with sampled
 *   resources, a cancelled run whose summary is not final, receipts that pin
 *   two old runs and two that do not, and requester rows (agent and human) on
 *   runs that are trimmed and on runs that are kept;
 * - B: ten finished runs and a queued one, its accounting over the
 *   per-project record cap;
 * - C: a running run, its accounting putting the installation a little over
 *   the global byte cap.
 */
function populated(): { path: string; ids: { a: string; b: string; c: string } } {
  const root = mkdtempSync(join(tmpdir(), "recovery-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  let ids: { a: string; b: string; c: string };
  try {
    const a = store.addProject({ name: "alpha", repositoryPath: join(root, "a"), port: 4901, executable: "node", args: [] }).id;
    const b = store.addProject({ name: "beta", repositoryPath: join(root, "b"), port: 4902, executable: "node", args: [] }).id;
    const c = store.addProject({ name: "gamma", repositoryPath: join(root, "c"), port: 4903, executable: "node", args: [] }).id;
    ids = { a, b, c };
    const run = (id: string, projectId: string, queuedAt: string, overrides: Partial<TestRun> = {}): TestRun => ({
      id, projectId, worktreePath: root, worktreeHead: "a".repeat(40), worktreeBranch: "main", worktreeDirty: false,
      presetId: "node:test", presetName: "test", adapter: "node", actor: "local-cli", phase: "passed", queuePosition: null,
      executable: "pnpm", args: ["test"], cwd: root, queuedAt, startedAt: queuedAt, finishedAt: queuedAt, exitCode: 0, signal: null,
      error: null, logs: ["ok"], environmentMode: "clean", environmentProfile: "default", inheritedServerProfile: null, environmentVariableNames: [],
      source: legacySourceEvidence(), ...overrides,
    });
    // A: 50 finished runs, the older 25 beyond the summary horizon.
    const save = (value: TestRun) => { vi.setSystemTime(new Date(ago(70))); store.saveTestRun(value); };
    for (let index = 0; index < 50; index++) save(run(`a-${String(index).padStart(2, "0")}`, a, index < 25 ? ago(40, index) : ago(5, index)));
    for (let index = 0; index < 10; index++) save(run(`b-${index}`, b, ago(index < 5 ? 45 : 2, index)));
    // Pending work.
    save(run("a-queued", a, ago(0, 1), { phase: "queued", queuePosition: 1, startedAt: null, finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
    save(run("a-legacy", a, ago(0, 2), { phase: "queued", queuePosition: 2, startedAt: null, finishedAt: null, exitCode: null }));
    save(run("a-running", a, ago(0, 3), { phase: "running", finishedAt: null, exitCode: null, source: { ...legacySourceEvidence(), attribution: "pending", processOutcome: "passed" },
      telemetry: { ...emptyTelemetry("observed"), admittedAt: ago(0, 3), spawnedAt: ago(0, 4), resources: { ...emptyRunResources("sampled", 1000), sampleCount: 3 } } as TestRun["telemetry"] }));
    save(run("a-finalizing", a, ago(0, 5), { phase: "cancelled", telemetry: emptyTelemetry("observed") }));
    save(run("b-queued", b, ago(0, 6), { phase: "queued", queuePosition: 1, startedAt: null, finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
    save(run("c-running", c, ago(0, 7), { phase: "running", finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
  } finally { store.close(); }
  vi.setSystemTime(new Date(NOW));
  const database = unmanagedFixtureDatabase(path);
  try {
    database.pragma("foreign_keys = OFF");
    const copyRun = database.prepare(`INSERT INTO test_runs(id,project_id,worktree_path,worktree_head,worktree_branch,worktree_dirty,preset_id,preset_name,adapter,actor,phase,queue_position,executable,args_json,cwd,queued_at,started_at,finished_at,exit_code,signal,error,logs_json,idempotency_key,environment_mode,environment_profile,inherited_server_profile,environment_variable_names_json,source_json,telemetry_json,provider_bound)
      SELECT ?,project_id,worktree_path,worktree_head,worktree_branch,worktree_dirty,preset_id,preset_name,adapter,actor,phase,queue_position,executable,args_json,cwd,?,started_at,finished_at,exit_code,signal,error,logs_json,idempotency_key,environment_mode,environment_profile,inherited_server_profile,environment_variable_names_json,source_json,telemetry_json,provider_bound FROM test_runs WHERE id='a-00'`);
    const copySummary = database.prepare(`INSERT INTO test_run_summaries(run_id,project_id,queued_at,terminal,bytes,summary_json) SELECT ?,project_id,?,terminal,bytes,summary_json FROM test_run_summaries WHERE run_id='a-00'`);
    for (let index = 0; index < 14; index++) {
      const id = `a-old-${String(index).padStart(2, "0")}`, queuedAt = ago(60, index);
      copyRun.run(id, queuedAt);
      if (index % 2 === 0) copySummary.run(id, queuedAt);
    }
    database.exec(`UPDATE test_summary_coverage SET records=records+7,bytes=bytes+7*(SELECT bytes FROM test_run_summaries WHERE run_id='a-00') WHERE project_id='${ids!.a}'`);
    // Telemetry and source of a run written before either existed.
    database.exec("UPDATE test_runs SET source_json=NULL,telemetry_json=NULL WHERE id='a-legacy'");
    database.prepare("INSERT INTO remote_worker_receipts(attempt_id,payload_json) VALUES(?,?)").run("receipt-pin-1", JSON.stringify({ localRunId: "a-old-00", reports: [{ phase: "running" }] }));
    database.prepare("INSERT INTO remote_worker_receipts(attempt_id,payload_json) VALUES(?,?)").run("receipt-pin-2", JSON.stringify({ localRunId: "a-old-03", reports: [] }));
    database.prepare("INSERT INTO remote_worker_receipts(attempt_id,payload_json) VALUES(?,?)").run("receipt-done", JSON.stringify({ localRunId: "a-old-01", reports: [{ phase: "running" }, { phase: "succeeded" }] }));
    database.prepare("INSERT INTO remote_worker_receipts(attempt_id,payload_json) VALUES(?,?)").run("receipt-none", JSON.stringify({ reports: [] }));
    const agent = database.prepare("INSERT INTO test_run_requesters(run_id,principal_id,credential_id,project_id,session_owner,reservation_id,lease_token_hash) VALUES(?,'agent-1','credential-1',?,'agent:mcp:fixture',NULL,NULL)");
    const human = database.prepare(`INSERT INTO human_test_run_requesters(run_id,project_id,principal_id,session_owner,authority_json,reference_json,reservation_id,fingerprint) VALUES(?,?,'human-1','human:test:human-1','{}','{}',NULL,'${FINGERPRINT}')`);
    for (const id of ["a-old-02", "a-40", "a-queued"]) agent.run(id, ids!.a);
    for (const id of ["a-old-04", "a-45"]) human.run(id, ids!.a);
    database.exec(`UPDATE test_summary_coverage SET records=5003 WHERE project_id='${ids!.b}'`);
    database.exec(`UPDATE test_summary_coverage SET bytes=${TEST_SUMMARY_POLICY.globalBytes}+3000-(SELECT sum(bytes) FROM test_summary_coverage WHERE project_id<>'${ids!.c}') WHERE project_id='${ids!.c}'`);
  } finally { database.close(); }
  return { path, ids: ids! };
}

// ---------------------------------------------------------------------------

/** A copy of the fixture file. */
function twin(path: string): string {
  const target = join(mkdtempSync(join(tmpdir(), "recovery-twin-")), "state.sqlite3");
  roots.push(join(target, ".."));
  copyFileSync(path, target);
  return target;
}
/**
 * An unmanaged connection whose `randomblob` counts (the fence triggers write
 * the checkpoint's epoch from it on every covered row), so both twins write
 * the same bytes, and whose `prepare(...).run(...)` calls are recorded.
 */
function connection(path: string, foreignKeys: boolean, writes: Array<[string, unknown[]]> = []): Database.Database {
  const database = unmanagedFixtureDatabase(path);
  let counter = 0;
  database.function("randomblob", (size: unknown) => Buffer.alloc(Number(size), counter++ % 256));
  database.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  const prepare = database.prepare.bind(database);
  Object.assign(database, { prepare: (sql: string) => {
    const statement = prepare(sql), run = statement.run.bind(statement);
    return Object.assign(statement, { run: (...parameters: unknown[]) => { writes.push([sql, parameters]); return run(...parameters); } });
  } });
  return database;
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Both recoveries on twins of `path`: every table compared by storage class and bytes, and every write in order. */
function differential(path: string, foreignKeys: boolean) {
  const beforeWrites: Array<[string, unknown[]]> = [], afterWrites: Array<[string, unknown[]]> = [];
  const left = connection(twin(path), foreignKeys, beforeWrites), right = connection(twin(path), foreignKeys, afterWrites);
  try {
    markInterruptedTestRunsBefore(left);
    const prepared = new TestRunQueries(right).recoverInterruptedTestRuns();
    return { before: exact(left), after: exact(right), beforeWrites, afterWrites, prepared };
  } finally { left.close(); right.close(); }
}
/** One failure, as the caller sees it. */
function failure(operation: () => unknown): { name: string; message: string } | null {
  try { operation(); return null; } catch (error) { return { name: (error as Error).name, message: (error as Error).message }; }
}

describe("test-run recovery: the same writes as before the split", () => {
  it.each([[true], [false]])("writes every row, value and statement the pre-split recovery wrote (foreign keys on: %s)", foreignKeys => {
    const { path, ids } = populated();
    const { before, after, beforeWrites, afterWrites, prepared } = differential(path, foreignKeys);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
    expect(afterWrites).toEqual(beforeWrites);
    // The write phase ran exactly what was prepared.
    expect(afterWrites).toEqual(prepared.writes.map(write => [write.sql, write.parameters]));
    // The fixture reaches every part of the recovery.
    expect(prepared.runs.map(run => run.id).sort()).toEqual(["a-finalizing", "a-legacy", "a-queued", "a-running", "b-queued", "c-running"]);
    const kinds = new Set(beforeWrites.map(([sql]) => sql.trim().split(/\s+/).slice(0, 3).join(" ")));
    for (const kind of ["INSERT INTO test_runs", "DELETE FROM test_run_summaries", "UPDATE test_summary_coverage", "DELETE FROM test_run_requesters", "DELETE FROM human_test_run_requesters", "DELETE FROM test_runs"]) {
      expect(kinds, kind).toContain(kind);
    }
    // Summaries evicted by age, and (newer than the 30-day horizon) by the per-project and global caps.
    const evicted = beforeWrites.filter(([sql]) => sql.startsWith("DELETE FROM test_run_summaries")).map(([, [runId]]) => runId as string);
    expect(evicted.some(id => /^a-(0\d|1\d|2[0-4])$/.test(id)), "an eviction by age").toBe(true);
    expect(evicted.some(id => /^b-[5-9]$|^a-(2[5-9]|[34]\d)$/.test(id)), "an eviction by a cap").toBe(true);
    // Receipts pin two old runs through the per-project trims; the final trim deletes them all the same.
    expect(prepared.trims.filter(trim => trim.selection === "project").flatMap(trim => trim.runs)).not.toEqual(expect.arrayContaining(["a-old-00"]));
    expect(prepared.trims.at(-1)).toMatchObject({ selection: "recovery", runs: expect.arrayContaining(["a-old-00", "a-old-03"]) });
    expect(prepared.trimmed).toHaveLength(new Set(prepared.trimmed).size);
    expect(prepared.hazards).toEqual([]);
    // Requester rows go with trimmed runs and stay with kept ones.
    expect(Object.values(after.test_run_requesters).length).toBeLessThan(Object.values(before.test_run_requesters).length + 1);
    void ids;
  });

  it("writes the same for a run already recovered whose summary was left unfinished, and for a second recovery", () => {
    const { path } = populated();
    // The values the recovery writes for a-queued, planted back with an unfinished summary: its save finds the same JSON and writes no summary.
    const scratch = connection(twin(path), true);
    let row: Record<string, unknown>, summary: string;
    try {
      new TestRunQueries(scratch).markInterruptedTestRuns();
      row = scratch.prepare("SELECT phase,finished_at,queue_position,error,source_json,telemetry_json FROM test_runs WHERE id='a-queued'").get() as Record<string, unknown>;
      summary = scratch.prepare("SELECT summary_json FROM test_run_summaries WHERE run_id='a-queued'").pluck().get() as string;
    } finally { scratch.close(); }
    const planted = connection(path, false);
    try {
      planted.prepare("UPDATE test_runs SET phase=?,finished_at=?,queue_position=?,error=?,source_json=?,telemetry_json=? WHERE id='a-queued'")
        .run(row.phase, row.finished_at, row.queue_position, row.error, row.source_json, row.telemetry_json);
      planted.prepare("UPDATE test_run_summaries SET summary_json=?,terminal=0,bytes=? WHERE run_id='a-queued'").run(summary, Buffer.byteLength(summary));
    } finally { planted.close(); }
    const first = differential(path, true);
    expect(first.prepared.summaries.map(entry => entry.runId)).not.toContain("a-queued");
    expect(first.prepared.runs.map(run => run.id)).toContain("a-queued");
    for (const table of Object.keys(first.before)) expect(first.after[table], table).toEqual(first.before[table]);
    expect(first.afterWrites).toEqual(first.beforeWrites);
    // A second recovery: nothing is pending, the final trim still runs.
    const recovered = twin(path);
    const once = connection(recovered, true);
    try { new TestRunQueries(once).markInterruptedTestRuns(); } finally { once.close(); }
    const second = differential(recovered, true);
    expect(second.prepared.runs).toEqual([]);
    for (const table of Object.keys(second.before)) expect(second.after[table], table).toEqual(second.before[table]);
    expect(second.afterWrites).toEqual(second.beforeWrites);
  });

  it("prepares on a read-only connection and writes nothing", () => {
    const { path } = populated();
    const before = sha(path);
    const database = unmanagedFixtureDatabase(path, { readonly: true });
    try {
      const state = exact(database);
      const prepared = prepareInterruptedTestRuns(database);
      expect(prepared.writes.length).toBeGreaterThan(50);
      expect(prepared.now).toBe(NOW);
      expect(exact(database)).toEqual(state);
    } finally { database.close(); }
    expect(sha(path)).toBe(before);
  });
});

describe("test-run recovery: failures found by the preparation", () => {
  /** Stored values the recovery cannot use, each on a run it interrupts or a row its trimming reads. */
  const FAILING: ReadonlyArray<[string, (ids: { a: string; b: string }) => string, { table: string; id: string }]> = [
    ["a source of JSON null", () => "UPDATE test_runs SET source_json='null' WHERE id='a-queued'", { table: "test_runs", id: "a-queued" }],
    ["a source of an empty object", () => "UPDATE test_runs SET source_json='{}' WHERE id='a-queued'", { table: "test_runs", id: "a-queued" }],
    ["a source of a number", () => "UPDATE test_runs SET source_json='5' WHERE id='a-queued'", { table: "test_runs", id: "a-queued" }],
    ["a source of an array", () => "UPDATE test_runs SET source_json='[]' WHERE id='a-queued'", { table: "test_runs", id: "a-queued" }],
    ["a source whose reason codes are not a list", () => `UPDATE test_runs SET source_json='{"reasonCodes":5}' WHERE id='a-queued'`, { table: "test_runs", id: "a-queued" }],
    ["telemetry of JSON null", () => "UPDATE test_runs SET telemetry_json='null' WHERE id='a-running'", { table: "test_runs", id: "a-running" }],
    ["telemetry of a number", () => "UPDATE test_runs SET telemetry_json='5' WHERE id='a-running'", { table: "test_runs", id: "a-running" }],
    ["telemetry whose summary exceeds the record budget", () => `UPDATE test_runs SET telemetry_json='{"padding":"${"x".repeat(9000)}"}' WHERE id='a-running'`, { table: "test_runs", id: "a-running" }],
    ["arguments that are not JSON", () => "UPDATE test_runs SET args_json='not json' WHERE id='b-queued'", { table: "test_runs", id: "b-queued" }],
    ["a stored summary of another registration", ids => `UPDATE test_run_summaries SET project_id='${ids.b}' WHERE run_id='a-queued'`, { table: "test_runs", id: "a-queued" }],
    ["a receipt payload that is not JSON, read by a trim", () => "UPDATE remote_worker_receipts SET payload_json='{not json' WHERE attempt_id='receipt-done'", { table: "remote_worker_receipts", id: "receipt-done" }],
    ["a receipt payload that is a BLOB, read by a trim", () => "UPDATE remote_worker_receipts SET payload_json=x'00ff' WHERE attempt_id='receipt-done'", { table: "remote_worker_receipts", id: "receipt-done" }],
  ];
  it.each(FAILING)("throws for %s exactly as the recovery does, names the row and writes nothing", (_name, sql, row) => {
    const { path, ids } = populated();
    const tampered = connection(path, false);
    try { tampered.exec(sql(ids)); } finally { tampered.close(); }
    const left = connection(twin(path), true), right = connection(twin(path), true);
    try {
      const state = exact(right);
      const expected = failure(() => markInterruptedTestRunsBefore(left));
      expect(expected).not.toBeNull();
      const position: RecoveryPosition = { current: null };
      expect(failure(() => prepareInterruptedTestRuns(right, position))).toEqual(expected);
      expect(position.current).toEqual(row);
      expect(failure(() => new TestRunQueries(right).markInterruptedTestRuns())).toEqual(expected);
      expect(exact(right)).toEqual(state);
    } finally { left.close(); right.close(); }
  });

  it.each([
    ["accounting bytes below a stored summary's", (ids: { a: string }) => `UPDATE test_summary_coverage SET bytes=0 WHERE project_id='${ids.a}'`, "CHECK constraint failed: bytes >= 0"],
    ["accounting records below the summaries an eviction removes", (ids: { a: string }) => `UPDATE test_summary_coverage SET records=0 WHERE project_id='${ids.a}'`, "CHECK constraint failed: records >= 0"],
  ])("lists %s as the row the database would refuse, and the recovery fails as before", (_name, sql, message) => {
    const { path, ids } = populated();
    const tampered = connection(path, false);
    try { tampered.exec(sql(ids)); } finally { tampered.close(); }
    const left = connection(twin(path), true), right = connection(twin(path), true);
    try {
      const prepared = prepareInterruptedTestRuns(right);
      expect(prepared.hazards).toEqual([{ table: "test_summary_coverage", id: ids.a, problem: expect.stringContaining("CHECK") }]);
      expect(prepared.hazardCount).toBe(1);
      const expected = failure(() => markInterruptedTestRunsBefore(left));
      expect(expected).toEqual({ name: "SqliteError", message });
      expect(failure(() => new TestRunQueries(right).markInterruptedTestRuns())).toEqual(expected);
    } finally { left.close(); right.close(); }
  });

  it("lists a receipt no trim of this recovery reads, and the recovery succeeds exactly as before", () => {
    const { path } = populated();
    const tampered = connection(path, false);
    try {
      // Registration A keeps at most 50 finished runs after the interruption: no per-project trim has a candidate, so none reads the receipts.
      tampered.exec("DELETE FROM test_runs WHERE id LIKE 'a-old-%' OR id IN ('a-00','a-01','a-02','a-03','a-04','a-05','a-06','a-07','a-08','a-09')");
      tampered.exec("UPDATE remote_worker_receipts SET payload_json='{not json' WHERE attempt_id='receipt-none'");
    } finally { tampered.close(); }
    const { before, after, beforeWrites, afterWrites, prepared } = differential(path, true);
    expect(prepared.hazards).toEqual([{ table: "remote_worker_receipts", id: "receipt-none", problem: expect.stringContaining("not JSON") }]);
    for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
    expect(afterWrites).toEqual(beforeWrites);
  });

  it("finds nothing in healthy defaults: empty lists and SQL NULL source and telemetry", () => {
    const { path } = populated();
    const tampered = connection(path, false);
    try { tampered.exec("UPDATE test_runs SET args_json='[]',logs_json='[]',environment_variable_names_json='[]',source_json=NULL,telemetry_json=NULL WHERE phase IN ('queued','running')"); } finally { tampered.close(); }
    const { before, after, prepared } = differential(path, true);
    expect(prepared.hazards).toEqual([]);
    for (const table of Object.keys(before)) expect(after[table], table).toEqual(before[table]);
  });
});
