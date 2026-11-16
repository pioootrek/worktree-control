import type { PendingTestRun, TestRunStatusRecord, TestRunRequester, HumanTestRunRequester, VerificationRequester } from "@/server/state-store";
import type { TestEnvironmentMode, TestRun, TestRunPhase } from "@/shared/contracts";
import Database from "better-sqlite3";
import { humanTestRequesterSchema, emptyTelemetry, emptyRunResources, resourceReason, type TestRunAdministrationAuditEntry, type TestRunAdministrationRecord } from "@/server/modules/verification";
import {
  EVICT_COVERAGE_SQL, EVICT_SUMMARY_SQL, evictCoverageParameters, evictSummaryParameters, pruneSummaries, SAVE_COVERAGE_SQL, SAVE_SUMMARY_SQL, saveCoverageParameters,
  saveSummary, saveSummaryParameters, TEST_SUMMARY_POLICY, TestSummaryQueries, type StoredSummary, type SummaryLedger, type TerminalSummary,
} from "./test-summary-queries";
import { legacySourceEvidence } from "@/server/test-source-attribution";

export type TestRunRow = {
  id: string;
  project_id: string;
  worktree_path: string;
  worktree_head: string;
  worktree_branch: string | null;
  worktree_dirty: number;
  preset_id: string;
  preset_name: string;
  adapter: TestRun["adapter"];
  actor: string;
  phase: TestRunPhase;
  queue_position: number | null;
  executable: string;
  args_json: string;
  cwd: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  logs_json: string;
  idempotency_key: string | null;
  environment_mode: TestEnvironmentMode;
  environment_profile: string;
  inherited_server_profile: string | null;
  environment_variable_names_json: string;
  source_json: string | null;
  telemetry_json: string | null;
};

export function mapTestRun(row: TestRunRow): TestRun {
  const telemetry = row.telemetry_json ? JSON.parse(row.telemetry_json) as NonNullable<TestRun["telemetry"]> : emptyTelemetry();
  telemetry.resources ??= emptyRunResources();
  return {
    id: row.id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    worktreeHead: row.worktree_head,
    worktreeBranch: row.worktree_branch,
    worktreeDirty: row.worktree_dirty === 1,
    presetId: row.preset_id,
    presetName: row.preset_name,
    adapter: row.adapter,
    actor: row.actor,
    phase: row.phase,
    queuePosition: row.queue_position,
    executable: row.executable,
    args: JSON.parse(row.args_json) as string[],
    cwd: row.cwd,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    signal: row.signal,
    error: row.error,
    logs: JSON.parse(row.logs_json) as string[],
    environmentMode: row.environment_mode,
    environmentProfile: row.environment_profile,
    inheritedServerProfile: row.inherited_server_profile,
    environmentVariableNames: JSON.parse(row.environment_variable_names_json) as string[],
    telemetry,
    source: row.source_json ? JSON.parse(row.source_json) as TestRun["source"] : legacySourceEvidence(),
  };
}

/** A receipt whose remote completion evidence pins its run until the immutable report is durable. */
const PINNING_RECEIPT = `json_extract(payload_json, '$.localRunId') IS NOT NULL
    AND coalesce(json_extract(payload_json, '$.reports[#-1].phase'), '')
      NOT IN ('succeeded', 'failed', 'cancelled', 'uncertain')`;
/** The runs pinned by {@link PINNING_RECEIPT}. */
const PINNED_RUNS = `SELECT json_extract(payload_json, '$.localRunId') FROM remote_worker_receipts
    WHERE ${PINNING_RECEIPT}`;
/** One project's finished runs beyond its newest 50. Keeps remote completion
 * evidence until its immutable report is durable, even if networking is
 * stalled; at most 1000 receipts can pin extra rows. */
const PROJECT_RETENTION_EXCESS = `
  SELECT id FROM test_runs WHERE id IN (
    SELECT id FROM test_runs WHERE project_id = ? AND phase NOT IN ('queued', 'running')
    AND NOT EXISTS (SELECT 1 FROM test_run_summaries s WHERE s.run_id=test_runs.id AND s.terminal=0)
    ORDER BY queued_at DESC, id DESC LIMIT -1 OFFSET 50
  )
  AND id NOT IN (
    ${PINNED_RUNS}
  )`;
/** Every project's finished runs beyond its newest 50, after recovery. */
const RECOVERY_RETENTION_EXCESS = `
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY queued_at DESC, id DESC) AS rank
    FROM test_runs WHERE phase NOT IN ('queued', 'running')
  ) WHERE rank > 50`;

/**
 * The statements that delete the selected runs and, first, their requester
 * rows. The rows go explicitly rather than by ON DELETE CASCADE, so trimming is
 * the same with foreign keys on and with them off (as inside the schema
 * transaction, where resume recovers runs). The selection reads no requester
 * table, so all three statements select the same runs.
 */
const deleteRunStatements = (selection: string) => [
  `DELETE FROM test_run_requesters WHERE run_id IN (${selection})`,
  `DELETE FROM human_test_run_requesters WHERE run_id IN (${selection})`,
  `DELETE FROM test_runs WHERE id IN (${selection})`,
];
/** Deletes the selected runs and their requester rows ({@link deleteRunStatements}). */
function deleteTestRuns(database: Database.Database, selection: string, ...parameters: string[]): void {
  for (const sql of deleteRunStatements(selection)) database.prepare(sql).run(...parameters);
}

const SAVE_RUN_SQL = `
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
    `;
const saveRunParameters = (run: TestRun, idempotencyKey?: string) => [
  run.id, run.projectId, run.worktreePath, run.worktreeHead, run.worktreeBranch,
  run.worktreeDirty ? 1 : 0, run.presetId, run.presetName, run.adapter, run.actor,
  run.phase, run.queuePosition, run.executable, JSON.stringify(run.args), run.cwd, run.queuedAt,
  run.startedAt, run.finishedAt, run.exitCode, run.signal, run.error,
  JSON.stringify(run.logs), idempotencyKey ?? null, run.environmentMode, run.environmentProfile,
  run.inheritedServerProfile, JSON.stringify(run.environmentVariableNames), JSON.stringify(run.source), JSON.stringify(run.telemetry ?? emptyTelemetry()),
];
/** A finished run whose telemetry is final: its save prunes summaries and trims the project's history. */
const closesHistory = (run: TestRun) => ["passed", "failed", "cancelled", "timed_out", "interrupted"].includes(run.phase)
  && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || !!run.telemetry.finalizedAt || !!run.telemetry.recoveredAt);
/** The runs recovery interrupts. */
const PENDING_RUNS = "SELECT * FROM test_runs WHERE phase IN ('queued', 'running') OR id IN (SELECT run_id FROM test_run_summaries WHERE terminal=0)";

// ---------------------------------------------------------------------------
// The recovery of interrupted runs: a read-only preparation, then its writes

/** One write of the recovery: a statement and its parameters, run as `prepare(sql).run(...parameters)`. */
export interface RecoveryWrite { readonly sql: string; readonly parameters: readonly unknown[] }
/** A write the database would refuse, or stored evidence that a trim of this recovery does not read but a later one would. */
export interface RecoveryHazard { readonly table: string; readonly id: string; readonly problem: string }
/** The most hazards a preparation lists; the rest are counted. */
export const RECOVERY_HAZARD_LIMIT = 100;
/**
 * Everything {@link TestRunQueries.markInterruptedTestRuns} writes, computed
 * without writing: every read, parse and computation is done, so a database on
 * which the recovery would throw makes the preparation throw the same error.
 */
export interface InterruptedRunsPreparation {
  /** The recovery's own time (`finished_at`, `recoveredAt`). */
  readonly now: string;
  /** The runs it interrupts, in its order, with the values it writes. */
  readonly runs: readonly TestRun[];
  /** The summaries it saves (a stored summary that is already the same is not saved again), in order. */
  readonly summaries: ReadonlyArray<{ readonly runId: string; readonly terminal: boolean; readonly bytes: number; readonly json: string }>;
  /** Each history trim: after a run's save (that run's project) or the final one (every project), and the runs it deletes. */
  readonly trims: ReadonlyArray<{ readonly selection: "project" | "recovery"; readonly projectId: string | null; readonly runs: readonly string[] }>;
  /** Every run deleted, in the order of the trims. */
  readonly trimmed: readonly string[];
  /** Every write, in order; the write phase runs exactly these. */
  readonly writes: readonly RecoveryWrite[];
  /** At most {@link RECOVERY_HAZARD_LIMIT}; `hazardCount` counts all. */
  readonly hazards: readonly RecoveryHazard[];
  readonly hazardCount: number;
}
/** Where a preparation was when it threw: the row whose values it could not use. */
export interface RecoveryPosition { current: { table: string; id: string } | null }

const display = (value: unknown) => typeof value === "string" ? value : `<${value === null ? "null" : Buffer.isBuffer(value) ? "blob" : typeof value}>`;
const jsonIds = (ids: Iterable<string>) => JSON.stringify([...ids]);
/** SQLite's `a + b`, for a stored value of any class (a number is added as JavaScript adds). */
function sqlAdd(database: Database.Database, a: unknown, b: number): unknown {
  return typeof a === "number" ? a + b : database.prepare("SELECT ? + ?").pluck().get(a, b);
}
const nonNegative = (value: unknown) => typeof value === "number" && value >= 0;

type SummaryState = { project_id: string; bytes: number; summary_json: string; terminal: boolean; origin: "summary" | "run" } | null;
type CoverageState = { records: unknown; bytes: unknown; evicted: unknown } | null;

/**
 * The state the recovery's earlier writes would leave, over the unchanged
 * database: summaries saved or evicted, accounting changed, runs interrupted
 * and runs deleted. Reads are answered from it with the statements' own
 * conditions, ordering and storage classes taken from the stored rows; writes
 * are recorded, never made. IDs are compared as SQLite text (every run, summary
 * and project ID the product writes is text).
 */
class RecoveryProjection implements SummaryLedger {
  readonly writes: RecoveryWrite[] = [];
  readonly summaries: Array<{ runId: string; terminal: boolean; bytes: number; json: string }> = [];
  readonly trims: Array<{ selection: "project" | "recovery"; projectId: string | null; runs: string[] }> = [];
  readonly hazards: RecoveryHazard[] = [];
  hazardCount = 0;
  private readonly interrupted = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly summary = new Map<string, SummaryState>();
  private readonly coverage = new Map<string, CoverageState>();
  private receiptsRead = false;

  constructor(private readonly database: Database.Database, private readonly position: RecoveryPosition) {}

  private write(sql: string, parameters: readonly unknown[]): void { this.writes.push({ sql, parameters }); }
  private hazard(table: string, id: string, problem: string): void {
    this.hazardCount++;
    if (this.hazards.length < RECOVERY_HAZARD_LIMIT) this.hazards.push({ table, id, problem });
  }
  /** The summary overlay as JSON rows `[run_id, terminal (null when evicted), bytes, origin]`. */
  private summaryOverlay(): string {
    return JSON.stringify([...this.summary].map(([id, state]) => state ? [id, state.terminal ? 1 : 0, state.bytes, state.origin] : [id, null, null, null]));
  }
  /** Every summary row as the recovery's earlier writes would leave it (two parameters: the overlay, twice). */
  private static readonly SUMMARIES = `
    SELECT run_id, project_id, queued_at, terminal, bytes FROM test_run_summaries WHERE run_id NOT IN (SELECT o.value->>0 FROM json_each(?) o)
    UNION ALL
    SELECT o.value->>0, CASE o.value->>3 WHEN 'summary' THEN s.project_id ELSE r.project_id END,
      CASE o.value->>3 WHEN 'summary' THEN s.queued_at ELSE r.queued_at END, o.value->>1, o.value->>2
    FROM json_each(?) o LEFT JOIN test_run_summaries s ON s.run_id=o.value->>0 LEFT JOIN test_runs r ON r.id=o.value->>0
    WHERE o.value->>1 IS NOT NULL`;
  /** The accounting overlay as JSON rows `[project_id, records, bytes]` (absent rows left out). */
  private coverageOverlay(): string {
    return JSON.stringify([...this.coverage].flatMap(([id, state]) => state ? [[id, state.records, state.bytes]] : []));
  }
  /** Every accounting row as the earlier writes would leave it (two parameters: the touched IDs, the overlay). */
  private static readonly COVERAGE = `
    SELECT project_id, records, bytes FROM test_summary_coverage WHERE project_id NOT IN (SELECT value FROM json_each(?))
    UNION ALL SELECT o.value->>0, o.value->>1, o.value->>2 FROM json_each(?) o`;
  private coverageOf(projectId: string): CoverageState {
    if (this.coverage.has(projectId)) return this.coverage.get(projectId)!;
    const row = this.database.prepare("SELECT records, bytes, evicted FROM test_summary_coverage WHERE project_id=?").get(projectId) as CoverageState | undefined;
    return row ?? null;
  }
  private accounting(projectId: string, next: CoverageState): void {
    this.coverage.set(projectId, next);
    if (next && !(nonNegative(next.records) && nonNegative(next.bytes) && nonNegative(next.evicted))) {
      this.hazard("test_summary_coverage", projectId, "the summary accounting would leave the range its CHECK allows");
    }
  }

  stored(runId: string): StoredSummary | undefined {
    if (this.summary.has(runId)) {
      const state = this.summary.get(runId);
      return state ? { project_id: state.project_id, bytes: state.bytes, summary_json: state.summary_json } : undefined;
    }
    return this.database.prepare("SELECT project_id, bytes, summary_json FROM test_run_summaries WHERE run_id = ?").get(runId) as StoredSummary | undefined;
  }
  saved(run: TestRun, terminal: boolean, bytes: number, json: string, old: StoredSummary | undefined): void {
    this.write(SAVE_SUMMARY_SQL, saveSummaryParameters(run, terminal, bytes, json));
    this.write(SAVE_COVERAGE_SQL, saveCoverageParameters(run, bytes, old));
    this.summaries.push({ runId: run.id, terminal, bytes, json });
    // An update keeps the stored project and queue time; an insert takes the run's.
    this.summary.set(run.id, { project_id: old ? old.project_id : run.projectId, bytes, summary_json: json, terminal, origin: old ? "summary" : "run" });
    const [, , added, change] = saveCoverageParameters(run, bytes, old) as [string, number, number, number];
    const current = this.coverageOf(run.projectId);
    this.accounting(run.projectId, current
      ? { records: sqlAdd(this.database, current.records, added), bytes: sqlAdd(this.database, current.bytes, change), evicted: current.evicted }
      : { records: 1, bytes, evicted: 0 });
  }
  terminal(condition: string, parameters: Array<string | number>, limit: number): TerminalSummary[] {
    const overlay = this.summaryOverlay();
    return this.database.prepare(`SELECT run_id,project_id,bytes FROM (${RecoveryProjection.SUMMARIES})
        WHERE terminal=1 AND ${condition} ORDER BY queued_at,run_id LIMIT ?`).all(overlay, overlay, ...parameters, limit) as TerminalSummary[];
  }
  evicted(row: TerminalSummary, now: string): void {
    this.write(EVICT_SUMMARY_SQL, evictSummaryParameters(row));
    this.write(EVICT_COVERAGE_SQL, evictCoverageParameters(row, now));
    this.summary.set(row.run_id, null);
    const current = this.coverageOf(row.project_id);
    if (current) {
      this.accounting(row.project_id, { records: sqlAdd(this.database, current.records, -1), bytes: sqlAdd(this.database, current.bytes, -row.bytes), evicted: sqlAdd(this.database, current.evicted, 1) });
    }
  }
  usage(projectId?: string): { records: number; bytes: number } {
    const touched = jsonIds(this.coverage.keys()), overlay = this.coverageOverlay();
    return this.database.prepare(projectId ? `SELECT records,bytes FROM (${RecoveryProjection.COVERAGE}) WHERE project_id=?`
      : `SELECT coalesce(sum(records),0) records,coalesce(sum(bytes),0) bytes FROM (${RecoveryProjection.COVERAGE})`)
      .get(touched, overlay, ...(projectId ? [projectId] : [])) as { records: number; bytes: number } ?? { records: 0, bytes: 0 };
  }
  overCap(records: number, bytes: number): string | undefined {
    return (this.database.prepare(`SELECT project_id FROM (${RecoveryProjection.COVERAGE}) WHERE records>? OR bytes>? ORDER BY project_id LIMIT 1`)
      .get(jsonIds(this.coverage.keys()), this.coverageOverlay(), records, bytes) as { project_id: string } | undefined)?.project_id;
  }

  /** The run's upsert; from here on its phase is `interrupted`. */
  savedRun(run: TestRun): void {
    this.write(SAVE_RUN_SQL, saveRunParameters(run));
    this.interrupted.add(run.id);
  }
  /** Runs still present, with their phase after the earlier writes: the condition is true for a run not queued or running. */
  private static readonly FINISHED = "id NOT IN (SELECT value FROM json_each(?)) AND (id IN (SELECT value FROM json_each(?)) OR phase NOT IN ('queued', 'running'))";
  /**
   * The trim after a run's save ({@link PROJECT_RETENTION_EXCESS}): the
   * project's finished runs without an unfinished summary beyond its newest 50,
   * less the runs receipts pin. The receipts are read only when there is a
   * candidate, as SQLite reads them; a receipt it cannot read throws its error.
   */
  trimProject(projectId: string): void {
    const overlay = this.summaryOverlay();
    const candidates = this.database.prepare(`SELECT id FROM test_runs WHERE project_id = ? AND ${RecoveryProjection.FINISHED}
      AND NOT (EXISTS (SELECT 1 FROM test_run_summaries s WHERE s.run_id=test_runs.id AND s.terminal=0 AND s.run_id NOT IN (SELECT o.value->>0 FROM json_each(?) o))
        OR id IN (SELECT o.value->>0 FROM json_each(?) o WHERE o.value->>1 = 0))
      ORDER BY queued_at DESC, id DESC LIMIT -1 OFFSET 50`).pluck().all(projectId, jsonIds(this.deleted), jsonIds(this.interrupted), overlay, overlay) as string[];
    let runs: string[] = [];
    if (candidates.length > 0) {
      this.receiptsRead = true;
      let kept: Set<string>;
      try {
        kept = new Set(this.database.prepare(`SELECT id FROM test_runs WHERE id IN (SELECT value FROM json_each(?)) AND id NOT IN (${PINNED_RUNS})`).pluck().all(jsonIds(candidates)) as string[]);
      } catch (error) {
        const [first] = this.unreadableReceipts();
        if (first) this.position.current = { table: "remote_worker_receipts", id: first };
        throw error;
      }
      runs = candidates.filter(id => kept.has(id));
    }
    this.trimmed("project", projectId, PROJECT_RETENTION_EXCESS, [projectId], runs);
  }
  /** The final trim ({@link RECOVERY_RETENTION_EXCESS}): every project's finished runs beyond its newest 50. */
  trimRecovery(): void {
    const runs = this.database.prepare(`SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY queued_at DESC, id DESC) AS rank
      FROM test_runs WHERE ${RecoveryProjection.FINISHED}
    ) WHERE rank > 50`).pluck().all(jsonIds(this.deleted), jsonIds(this.interrupted)) as string[];
    this.trimmed("recovery", null, RECOVERY_RETENTION_EXCESS, [], runs);
  }
  private trimmed(selection: "project" | "recovery", projectId: string | null, sql: string, parameters: string[], runs: string[]): void {
    for (const statement of deleteRunStatements(sql)) this.write(statement, parameters);
    for (const id of runs) this.deleted.add(id);
    this.trims.push({ selection, projectId, runs });
  }
  /** The receipts whose payload the pinning selection cannot read, by attempt ID. */
  private unreadableReceipts(): string[] {
    const rows = this.database.prepare("SELECT rowid, attempt_id FROM remote_worker_receipts ORDER BY attempt_id").raw().all() as Array<[number, unknown]>;
    const probe = this.database.prepare(`SELECT json_extract(payload_json, '$.localRunId') FROM remote_worker_receipts WHERE rowid = ? AND ${PINNING_RECEIPT}`);
    return rows.flatMap(([rowid, id]) => { try { probe.all(rowid); return []; } catch { return [display(id)]; } });
  }
  /** Receipts no trim of this recovery read: a later trim would read them and fail. */
  checkUnreadReceipts(): void {
    if (this.receiptsRead) return;
    for (const id of this.unreadableReceipts()) this.hazard("remote_worker_receipts", id, "its payload is not JSON the history trimming can read");
  }
}

/**
 * The recovery of {@link TestRunQueries.markInterruptedTestRuns}, read-only:
 * the same reads, parses and computations in the same order, with every write
 * recorded instead of made. It throws exactly where the recovery would throw;
 * `position` then names the row. Runs inside the caller's transaction or read.
 */
export function prepareInterruptedTestRuns(database: Database.Database, position: RecoveryPosition = { current: null }): InterruptedRunsPreparation {
  const now = new Date().toISOString();
  const projection = new RecoveryProjection(database, position);
  const runs: TestRun[] = [];
  const pending = database.prepare(PENDING_RUNS).all() as TestRunRow[];
  for (const row of pending) {
    position.current = { table: "test_runs", id: display(row.id) };
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
    // Recovery cannot observe the lost process's exit, cleanup or monotonic intervals.
    projection.savedRun(run);
    saveSummary(projection, run, TEST_SUMMARY_POLICY);
    if (closesHistory(run)) {
      pruneSummaries(projection, TEST_SUMMARY_POLICY, run.projectId, new Date().toISOString());
      projection.trimProject(run.projectId);
    }
    runs.push(run);
  }
  position.current = null;
  projection.trimRecovery();
  projection.checkUnreadReceipts();
  return {
    now, runs, summaries: projection.summaries, trims: projection.trims, trimmed: projection.trims.flatMap(trim => trim.runs),
    writes: projection.writes, hazards: projection.hazards, hazardCount: projection.hazardCount,
  };
}

/** The recovery's writes, exactly as prepared, inside the caller's transaction. */
export function writeInterruptedTestRuns(database: Database.Database, prepared: InterruptedRunsPreparation): void {
  for (const write of prepared.writes) database.prepare(write.sql).run(...write.parameters);
}

/** Borrows the owner connection; never opens or closes a database. */
export class TestRunQueries {
  constructor(private readonly database: Database.Database) {}

  countTestRuns(phases: TestRunPhase[], projectId?: string, worktreePath?: string): number {
    if (phases.length === 0) return 0;
    const conditions = [`phase IN (${phases.map(() => "?").join(", ")})`];
    const parameters: string[] = [...phases];
    if (projectId) {
      conditions.push("project_id = ?");
      parameters.push(projectId);
    }
    if (worktreePath) {
      conditions.push("worktree_path = ?");
      parameters.push(worktreePath);
    }
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM test_runs WHERE ${conditions.join(" AND ")}`)
      .get(...parameters) as { count: number };
    return row.count;
  }

  listPendingTestRuns(): PendingTestRun[] {
    return this.database.prepare(`
      SELECT id, project_id AS projectId, worktree_path AS worktreePath, phase,
             queue_position AS queuePosition, queued_at AS queuedAt
      FROM test_runs
      WHERE phase IN ('queued', 'running')
      ORDER BY queued_at ASC, id ASC
    `).all() as PendingTestRun[];
  }

  listTestRuns(projectId?: string, limit = 50): TestRun[] {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = projectId
      ? this.database.prepare("SELECT * FROM test_runs WHERE project_id = ? ORDER BY CASE WHEN phase IN ('queued', 'running') THEN 0 ELSE 1 END, queued_at DESC, id DESC LIMIT ?").all(projectId, boundedLimit)
      : this.database.prepare("SELECT * FROM test_runs ORDER BY CASE WHEN phase IN ('queued', 'running') THEN 0 ELSE 1 END, queued_at DESC, id DESC LIMIT ?").all(boundedLimit);
    return (rows as TestRunRow[]).map(mapTestRun);
  }

  hasTestRun(id: string): boolean {
    return this.database.prepare("SELECT 1 FROM test_runs WHERE id = ?").get(id) !== undefined;
  }

  getTestRun(id: string): TestRun | null {
    const row = this.database.prepare("SELECT * FROM test_runs WHERE id = ?").get(id) as TestRunRow | undefined;
    return row ? mapTestRun(row) : null;
  }

  getTestRunStatus(id: string): TestRunStatusRecord | null {
    const row = this.database.prepare(`
      SELECT id, project_id AS projectId, worktree_path AS worktreePath,
             worktree_head AS worktreeHead, worktree_branch AS worktreeBranch,
             worktree_dirty AS worktreeDirty, preset_id AS presetId, phase,
             queue_position AS queuePosition, queued_at AS queuedAt,
             started_at AS startedAt, finished_at AS finishedAt,
             exit_code AS exitCode, signal, error, source_json AS sourceJson
      FROM test_runs WHERE id = ?
    `).get(id) as (Omit<TestRunStatusRecord, "worktreeDirty" | "source"> & { worktreeDirty: number; sourceJson: string | null }) | undefined;
    if (!row) return null;
    const { sourceJson, ...status } = row;
    return {
      ...status,
      worktreeDirty: row.worktreeDirty === 1,
      source: sourceJson ? JSON.parse(sourceJson) as TestRun["source"] : legacySourceEvidence(),
    };
  }

  findTestRunByIdempotency(actor: string, idempotencyKey: string): TestRun | null {
    const row = this.database.prepare("SELECT * FROM test_runs WHERE actor = ? AND idempotency_key = ?")
      .get(actor, idempotencyKey) as TestRunRow | undefined;
    if (!row && actor.startsWith("human:test:") && this.database.prepare("SELECT 1 FROM human_test_run_intents WHERE principal_id=? AND idempotency_key=? AND retain_until>?")
      .get(actor.slice("human:test:".length), idempotencyKey, new Date().toISOString())) throw new Error("Original test intent is retained without run details.");
    return row ? mapTestRun(row) : null;
  }

  getTestRunRequester(id: string): TestRunRequester | null {
    return this.database.prepare(`SELECT principal_id AS principalId, credential_id AS credentialId,
      project_id AS projectId, session_owner AS sessionOwner, reservation_id AS reservationId,
      lease_token_hash AS leaseTokenHash FROM test_run_requesters WHERE run_id=?`).get(id) as TestRunRequester | undefined ?? null;
  }

  getHumanTestRunRequester(id: string): HumanTestRunRequester | null {
    const run = this.database.prepare("SELECT provider_bound,actor,project_id,idempotency_key FROM test_runs WHERE id=?").get(id) as {provider_bound:number;actor:string;project_id:string;idempotency_key:string|null} | undefined;
    const row = this.database.prepare(`SELECT project_id AS projectId,session_owner AS sessionOwner,principal_id AS principalId,
      authority_json AS authority,reference_json AS reference,reservation_id AS reservationId,fingerprint
      FROM human_test_run_requesters WHERE run_id=?`).get(id) as {projectId:string;sessionOwner:string;principalId:string;authority:string;reference:string;reservationId:string|null;fingerprint:string} | undefined;
    if (!row && !run?.provider_bound) return null;
    try {
      if (!row || run?.provider_bound !== 1 || run.actor !== row.sessionOwner || run.project_id !== row.projectId
        || this.getTestRunRequester(id)) throw new Error();
      const parsed = humanTestRequesterSchema.parse({ kind: "human", projectId: row.projectId, sessionOwner: row.sessionOwner,
        authority: JSON.parse(row.authority), reference: JSON.parse(row.reference), reservationId: row.reservationId, fingerprint: row.fingerprint });
      const intent = this.database.prepare("SELECT principal_id,session_key,fingerprint,retain_until,idempotency_key FROM human_test_run_intents WHERE run_id=?").get(id) as {principal_id:string;session_key:string;fingerprint:string;retain_until:string;idempotency_key:string} | undefined;
      if (parsed.authority.principalId !== row.principalId || (!intent && parsed.authority.deadline > new Date().toISOString())
        || (intent && (intent.principal_id !== row.principalId || intent.session_key !== parsed.authority.sessionKey
          || intent.fingerprint !== parsed.fingerprint || intent.retain_until !== parsed.authority.deadline || intent.idempotency_key !== run.idempotency_key))) throw new Error();
      return parsed;
    } catch { throw new Error("Human test attribution is unavailable."); }
  }

  saveTestRun(run: TestRun, idempotencyKey?: string, requester?: VerificationRequester): void {
    this.database.transaction(() => {
      // Attribution is insert-only and atomic with the first run write.
      if (requester && this.hasTestRun(run.id)) throw new Error("Test requester is immutable.");
      this.saveRunAndSummary(run, idempotencyKey);
      if (requester && "kind" in requester) {
        const parsed = humanTestRequesterSchema.parse(requester);
        if (parsed.projectId !== run.projectId || parsed.sessionOwner !== run.actor) throw new Error("Invalid test requester.");
        if (!idempotencyKey || idempotencyKey.length > 120) throw new Error("Human test intent requires an idempotency key.");
        this.database.prepare("DELETE FROM human_test_run_intents WHERE retain_until<=?").run(new Date().toISOString());
        const total = (this.database.prepare("SELECT count(*) n FROM human_test_run_intents").get() as {n:number}).n;
        const session = (this.database.prepare("SELECT count(*) n FROM human_test_run_intents WHERE session_key=?").get(parsed.authority.sessionKey) as {n:number}).n;
        if (total >= 4096 || session >= 128) throw new Error("Human test intent capacity is exhausted.");
        this.database.prepare(`INSERT INTO human_test_run_intents(principal_id,idempotency_key,session_key,run_id,fingerprint,retain_until) VALUES(?,?,?,?,?,?)`)
          .run(parsed.authority.principalId,idempotencyKey,parsed.authority.sessionKey,run.id,parsed.fingerprint,parsed.authority.deadline);
        this.database.prepare("UPDATE test_runs SET provider_bound=1 WHERE id=?").run(run.id);
        this.database.prepare(`INSERT INTO human_test_run_requesters
          (run_id,project_id,principal_id,session_owner,authority_json,reference_json,reservation_id,fingerprint)
          VALUES (?,?,?,?,?,?,?,?)`).run(run.id,parsed.projectId,parsed.authority.principalId,parsed.sessionOwner,
            JSON.stringify(parsed.authority),JSON.stringify(parsed.reference),parsed.reservationId,parsed.fingerprint);
      } else if (requester) {
        if (requester.projectId !== run.projectId || requester.sessionOwner !== run.actor) throw new Error("Invalid test requester.");
        this.database.prepare(`INSERT INTO test_run_requesters
          (run_id,principal_id,credential_id,project_id,session_owner,reservation_id,lease_token_hash)
          VALUES (?,?,?,?,?,?,?)`).run(run.id, requester.principalId, requester.credentialId,
            requester.projectId, requester.sessionOwner, requester.reservationId, requester.leaseTokenHash);
      }
    })();
  }

  private saveRunAndSummary(run: TestRun, idempotencyKey?: string): void {
    this.database.prepare(SAVE_RUN_SQL).run(...saveRunParameters(run, idempotencyKey));
    const summaries = new TestSummaryQueries(this.database);
    summaries.save(run);
    if (closesHistory(run)) {
      summaries.prune(run.projectId);
      deleteTestRuns(this.database, PROJECT_RETENTION_EXCESS, run.projectId);
    }
  }

  pruneTestSummaryHistory(): number {
    return this.database.transaction(() => new TestSummaryQueries(this.database).prune())();
  }

  /** Append-only local-administrator audit in the shared controller audit table. Details are bounded by the caller's validation. */
  recordTestRunAdministration(entry: TestRunAdministrationAuditEntry): void {
    const { event, ...details } = entry;
    this.database.prepare("INSERT INTO controller_audit_events(event_type, actor, details_json, created_at) VALUES (?, 'local-admin', ?, ?)")
      .run(event, JSON.stringify(details), new Date().toISOString());
  }

  /** Newest administrator events for one exact run ID; bounded by `limit`. */
  listTestRunAdministration(runId: string, limit: number): TestRunAdministrationRecord[] {
    const rows = this.database.prepare(`
      SELECT event_type, details_json, created_at FROM controller_audit_events
      WHERE event_type IN ('test_run.admin_stop_requested', 'test_run.admin_stop_result')
        AND json_valid(details_json) AND json_extract(details_json, '$.runId') = ?
      ORDER BY id DESC LIMIT ?
    `).all(runId, Math.max(1, Math.min(limit, 50))) as { event_type: TestRunAdministrationAuditEntry["event"]; details_json: string; created_at: string }[];
    return rows.map(row => {
      const details = JSON.parse(row.details_json) as Omit<TestRunAdministrationAuditEntry, "event">;
      return { ...details, operator: details.operator ?? null, event: row.event_type, at: row.created_at };
    });
  }

  /** Recovery after an unclean stop: {@link prepareInterruptedTestRuns}, then {@link writeInterruptedTestRuns}, in one transaction. */
  markInterruptedTestRuns(): void {
    this.recoverInterruptedTestRuns();
  }

  /** {@link markInterruptedTestRuns}, returning what it prepared and wrote. */
  recoverInterruptedTestRuns(): InterruptedRunsPreparation {
    return this.database.transaction(() => {
      const prepared = prepareInterruptedTestRuns(this.database);
      writeInterruptedTestRuns(this.database, prepared);
      return prepared;
    })();
  }
}
