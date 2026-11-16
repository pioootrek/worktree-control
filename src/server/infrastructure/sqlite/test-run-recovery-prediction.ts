import type Database from "better-sqlite3";
import type { TestRun } from "@/shared/contracts";
import { emptyTelemetry, resourceReason } from "@/server/modules/verification";
import { mapTestRun, type TestRunRow } from "./test-run-queries";
import { summarizeTestRun, TEST_SUMMARY_POLICY, type TestSummaryPolicy } from "./test-summary-queries";
import { readsBack } from "./stored-text";

/**
 * A read-only predictor of the test-run recovery (`markInterruptedTestRuns` in
 * `test-run-queries.ts`, with the summary `save` and `prune` of
 * `test-summary-queries.ts`), used only by the upgrade's authority acts
 * (`authority-upgrade-acts.ts`): their proposal refuses what the recovery
 * could fail on, and their `release_running_work` act runs the original
 * recovery and checks its outcome against a prediction made just before it,
 * in the same transaction.
 *
 * The recovery itself is the product's sequential code, unchanged; this module
 * never writes and is not called by it. It carries its own copies of the
 * rules it needs (the selection of runs to interrupt, the changes made to each
 * of them, the summary's save, the pruning by age and by the caps, and both
 * history trims), so the rules exist twice. `test-run-recovery.test.ts` ties
 * them together: it runs the real recovery on a copy of a rich fixture and
 * compares every table the recovery writes with this prediction, by storage
 * class and bytes, with a fixed clock.
 *
 * Limits (each is either refused by {@link recoveryRefusals} or does not reach
 * what the act compares):
 * - Every identifier and every ordered text it reads (run, project and
 *   summary IDs, requester run IDs, queue times, phases) must be text whose
 *   bytes are the UTF-8 encoding of the string read back, so that JavaScript
 *   equality and the byte order of {@link compareBytes} are SQLite's own
 *   `BINARY` comparisons; anything else is refused.
 * - Counters and byte totals are JavaScript numbers: every one and every sum
 *   the recovery can reach must be a safe integer; anything else is refused.
 * - It samples one instant for the whole recovery, where the recovery samples
 *   the clock at its start and again at each pruning; with a moving clock only
 *   time-dependent results can differ (summary evictions by age and what the
 *   caps evict after them, `finished_at`, `recoveredAt`, `last_pruned_at`),
 *   and the act compares none of them.
 * - It predicts the values the recovery binds for an interrupted run's
 *   columns; the conversion SQLite's column affinity applies to a value of an
 *   unusual class is not modelled (the act compares only IDs and phases).
 * - It predicts rows by their keys, not their rowids.
 * - Trigger and foreign-key effects are not modelled: the upgrade runs the
 *   recovery with foreign keys off, and the fence triggers on `test_runs` and
 *   the requester tables do not change the rows predicted here.
 */

// ---------------------------------------------------------------------------
// Copies of the recovery's rules (test-run-queries.ts and test-summary-queries.ts at 27e79d1e)

/** The runs the recovery interrupts, in the order it reads them (`markInterruptedTestRuns`). */
export const PENDING_RUNS_SQL = "SELECT * FROM test_runs WHERE phase IN ('queued', 'running') OR id IN (SELECT run_id FROM test_run_summaries WHERE terminal=0)";
/** The receipts' pinning rule of the per-project trim (`PROJECT_RETENTION_EXCESS`). */
export const PINNED_RUNS_SQL = `
    SELECT json_extract(payload_json, '$.localRunId') FROM remote_worker_receipts
    WHERE json_extract(payload_json, '$.localRunId') IS NOT NULL
    AND coalesce(json_extract(payload_json, '$.reports[#-1].phase'), '')
      NOT IN ('succeeded', 'failed', 'cancelled', 'uncertain')`;
/** Finished runs each trim keeps per project. */
const RETAINED_RUNS = 50;
const ACTIVE_PHASES: readonly string[] = ["queued", "running"];
const CLOSING_PHASES: readonly string[] = ["passed", "failed", "cancelled", "timed_out", "interrupted"];
/** The longest spelling `toISOString` produces (an extended year): a summary's budget is counted with it. */
export const LONGEST_INSTANT = "+275760-09-13T00:00:00.000Z";

/** The run as the recovery writes it, from its stored row (the body of `markInterruptedTestRuns`'s loop). */
export function interruptedRun(row: TestRunRow, now: string): TestRun {
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
  return run;
}

/** The columns the run's upsert changes (its `ON CONFLICT(id) DO UPDATE SET`), with the values it binds. */
export function interruptedRunColumns(run: TestRun): Record<string, string | number | null> {
  return {
    phase: run.phase, queue_position: run.queuePosition, executable: run.executable, args_json: JSON.stringify(run.args), cwd: run.cwd,
    environment_variable_names_json: JSON.stringify(run.environmentVariableNames), started_at: run.startedAt, finished_at: run.finishedAt,
    exit_code: run.exitCode, signal: run.signal, error: run.error, logs_json: JSON.stringify(run.logs), source_json: JSON.stringify(run.source),
    telemetry_json: JSON.stringify(run.telemetry ?? emptyTelemetry()),
  };
}

/** The summary JSON and its size, as `TestSummaryQueries.save` computes them. */
function summaryOf(run: TestRun): { json: string; bytes: number } {
  const json = JSON.stringify(summarizeTestRun(run));
  return { json, bytes: Buffer.byteLength(json) };
}
/** Whether the run's save closes its history (prunes summaries and trims the project), as `saveRunAndSummary` decides. */
const closesHistory = (run: TestRun) => CLOSING_PHASES.includes(run.phase)
  && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || !!run.telemetry.finalizedAt || !!run.telemetry.recoveredAt);

/** SQLite's `BINARY` order of two texts that are valid UTF-8: the order of their bytes. */
export function compareBytes(a: Buffer, b: Buffer): number { return Buffer.compare(a, b); }
const utf8 = (value: string) => Buffer.from(value, "utf8");

// ---------------------------------------------------------------------------
// Refusals: what the prediction cannot represent, or what the recovery could fail on at some clock

/** One stored row the proposal refuses. `id` is the row's printable key, or `rowid N`. */
export interface RecoveryRefusal { readonly table: string; readonly id: string; readonly problem: string }

/** Every column the predictor reads, with its storage class; the text ones must also be valid UTF-8. */
export const PREDICTOR_COLUMNS: ReadonlyArray<{ readonly table: string; readonly key: string; readonly columns: ReadonlyArray<readonly [string, "text" | "integer"]> }> = Object.freeze([
  { table: "test_runs", key: "id", columns: [["id", "text"], ["project_id", "text"], ["phase", "text"], ["queued_at", "text"]] },
  { table: "test_run_summaries", key: "run_id", columns: [["run_id", "text"], ["project_id", "text"], ["queued_at", "text"], ["terminal", "integer"], ["bytes", "integer"]] },
  { table: "test_summary_coverage", key: "project_id", columns: [["project_id", "text"], ["records", "integer"], ["bytes", "integer"], ["evicted", "integer"]] },
  { table: "test_run_requesters", key: "run_id", columns: [["run_id", "text"]] },
  { table: "human_test_run_requesters", key: "run_id", columns: [["run_id", "text"]] },
] as const);
/** The CHECK constraints of `test_runs` that the run's upsert evaluates on a stored value it keeps. */
export const RUN_UPSERT_CHECKS = "worktree_dirty IN (0, 1) AND adapter IN ('node', 'django', 'godot') AND environment_mode IN ('clean', 'inherit-server-profile') AND provider_bound IN (0,1)";

class Refusals {
  readonly items: RecoveryRefusal[] = [];
  count = 0;
  constructor(private readonly limit: number) {}
  add(table: string, id: string, problem: string): void {
    this.count++;
    if (this.items.length < this.limit) this.items.push({ table, id, problem });
  }
}
const ERROR_KINDS = new Set(["SyntaxError", "TypeError", "RangeError", "SqliteError", "Error"]);
const errorKind = (error: unknown) => error instanceof Error && ERROR_KINDS.has(error.name) ? error.name : "error";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Storage classes of every predictor column, row by row, and every text one read back exactly (`readsBack`, shared with the upgrade's acts). */
function storedValues(database: Database.Database, refused: Refusals): void {
  for (const entry of PREDICTOR_COLUMNS) {
    const select = entry.columns.map(([column]) => `typeof("${column}"),CAST("${column}" AS BLOB),"${column}"`).join(",");
    const keyIndex = entry.columns.findIndex(([column]) => column === entry.key);
    for (const row of database.prepare(`SELECT rowid,${select} FROM "${entry.table}" ORDER BY rowid`).raw().safeIntegers(true).iterate() as Iterable<unknown[]>) {
      const problems: string[] = [];
      let keyPrintable = false;
      entry.columns.forEach(([column, rule], index) => {
        const type = row[1 + index * 3], bytes = row[2 + index * 3], value = row[3 + index * 3];
        if (type !== rule) { problems.push(`${column} is ${String(type)}, expected ${rule}`); return; }
        if (rule === "text" && !readsBack(value, bytes)) { problems.push(`${column} is not valid UTF-8 text`); return; }
        if (index === keyIndex) keyPrintable = true;
      });
      if (problems.length === 0) continue;
      refused.add(entry.table, keyPrintable ? row[3 + keyIndex * 3] as string : `rowid ${String(row[0])}`, problems.join("; "));
    }
  }
}
/** Each row a bounded query selects, named by its first column. */
function listed(database: Database.Database, refused: Refusals, table: string, sql: string, problem: string): void {
  for (const id of database.prepare(sql).pluck().iterate() as Iterable<unknown>) refused.add(table, typeof id === "string" ? id : `<${typeof id}>`, problem);
}

/**
 * Everything on which the prediction could differ from the recovery, or the
 * recovery could fail, for some clock: the conditions are sufficient for the
 * recovery to succeed at every clock and for the prediction to be exact, so
 * none of them depends on the time. Bounded to `limit` refusals; `count`
 * counts all. Read-only.
 *
 * 1. Every {@link PREDICTOR_COLUMNS} value of its storage class, text valid
 *    UTF-8 (when any fails, nothing further is checked).
 * 2. Summaries within their CHECK (`terminal` 0 or 1, `bytes` 1 to 8192) and
 *    accounting counters between 0 and 2^53 - 1 (when any fails, nothing
 *    further is checked).
 * 3. For every run the recovery interrupts: its stored JSON can be read and
 *    changed as the recovery changes it; its summary, counted at the longest
 *    instant spelling, is within the record budget; no stored summary of its
 *    ID belongs to another registration (whether the recovery would reach it
 *    depends on what the age pruning evicts first); the stored summary is not
 *    the one the recovery would write at one instant (then whether it is
 *    rewritten would depend on the clock); and the values its upsert keeps
 *    satisfy the table's CHECK constraints.
 * 4. Sums the recovery can reach within the safe range: all records plus one
 *    per run it interrupts, all bytes plus a full summary per run, and each
 *    project's evictions plus one per summary that could be evicted.
 * 5. Accounting that covers its summaries: every project with summaries has
 *    an accounting row whose records and bytes are at least theirs. Then no
 *    eviction, whichever the clock selects, can take it below its CHECK.
 * 6. Every receipt payload the pinning rule can read, whether or not a trim
 *    of this recovery has a candidate that makes SQLite read it.
 */
export function recoveryRefusals(database: Database.Database, limit: number, policy: TestSummaryPolicy = TEST_SUMMARY_POLICY): { refusals: RecoveryRefusal[]; count: number } {
  const refused = new Refusals(limit);
  const result = () => ({ refusals: refused.items, count: refused.count });
  storedValues(database, refused);
  if (refused.count) return result();

  listed(database, refused, "test_run_summaries", "SELECT run_id FROM test_run_summaries WHERE terminal NOT IN (0,1) OR bytes NOT BETWEEN 1 AND 8192 ORDER BY run_id",
    "a summary outside its CHECK (terminal 0 or 1, bytes 1 to 8192)");
  listed(database, refused, "test_summary_coverage", `SELECT project_id FROM test_summary_coverage WHERE records NOT BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
    OR bytes NOT BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} OR evicted NOT BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} ORDER BY project_id`,
  "an accounting counter that is not a safe non-negative integer");
  if (refused.count) return result();

  const stored = database.prepare("SELECT project_id, summary_json FROM test_run_summaries WHERE run_id = ?");
  for (const row of database.prepare(PENDING_RUNS_SQL).all() as TestRunRow[]) {
    let longest: { json: string; bytes: number };
    try { longest = summaryOf(interruptedRun(row, LONGEST_INSTANT)); } catch (error) {
      refused.add("test_runs", row.id, `the test-run recovery cannot be carried out on this row (${errorKind(error)})`);
      continue;
    }
    if (longest.bytes > policy.maxRecordBytes) refused.add("test_runs", row.id, "the summary the recovery writes for it exceeds the record budget");
    const old = stored.get(row.id) as { project_id: string; summary_json: unknown } | undefined;
    if (old && old.project_id !== row.project_id) refused.add("test_runs", row.id, "a stored summary of its ID belongs to another registration");
    if (old && typeof old.summary_json === "string") {
      // The summary the recovery writes contains the instant twice (finishedAt, recoveredAt): it can equal the stored one at that one instant only.
      let at: unknown;
      try { at = (JSON.parse(old.summary_json) as { finishedAt?: unknown } | null)?.finishedAt; } catch { at = undefined; }
      if (typeof at === "string" && !Number.isNaN(Date.parse(at)) && new Date(at).toISOString() === at && summaryOf(interruptedRun(row, at)).json === old.summary_json) {
        refused.add("test_runs", row.id, "its stored summary is the one the recovery writes at one instant, so whether the recovery rewrites it depends on the clock");
      }
    }
  }
  listed(database, refused, "test_runs", `SELECT id FROM (${PENDING_RUNS_SQL}) WHERE NOT (${RUN_UPSERT_CHECKS}) ORDER BY id`,
    "a run to be interrupted keeps a value its upsert's CHECK refuses");

  const pending = BigInt(database.prepare(`SELECT count(*) FROM (${PENDING_RUNS_SQL})`).pluck().get() as number);
  const summaries = BigInt(database.prepare("SELECT count(*) FROM test_run_summaries").pluck().get() as number);
  let records = 0n, bytes = 0n;
  for (const [projectId, rowRecords, rowBytes, evicted] of database.prepare("SELECT project_id,records,bytes,evicted FROM test_summary_coverage ORDER BY project_id").raw().safeIntegers(true).iterate() as Iterable<[string, bigint, bigint, bigint]>) {
    records += rowRecords; bytes += rowBytes;
    if (evicted + summaries + pending > MAX_SAFE) refused.add("test_summary_coverage", projectId, "its eviction counter could leave the safe integer range");
  }
  if (records + pending > MAX_SAFE) refused.add("test_summary_coverage", "total", "the records of all projects could leave the safe integer range");
  if (bytes + pending * BigInt(policy.maxRecordBytes) > MAX_SAFE) refused.add("test_summary_coverage", "total", "the bytes of all projects could leave the safe integer range");

  listed(database, refused, "test_summary_coverage", `SELECT s.project_id FROM test_run_summaries s LEFT JOIN test_summary_coverage c ON c.project_id=s.project_id
    GROUP BY s.project_id HAVING max(c.project_id IS NULL) ORDER BY s.project_id`, "summaries are stored without their project's accounting");
  listed(database, refused, "test_summary_coverage", `SELECT c.project_id FROM test_summary_coverage c JOIN test_run_summaries s ON s.project_id=c.project_id
    GROUP BY c.project_id HAVING max(c.records) < count(*) OR max(c.bytes) < sum(s.bytes) ORDER BY c.project_id`,
  "the accounting is below its summaries: an eviction could take it below its CHECK");

  const probe = database.prepare(`SELECT 1 FROM remote_worker_receipts WHERE rowid = ? AND json_extract(payload_json, '$.localRunId') IS NOT NULL
    AND coalesce(json_extract(payload_json, '$.reports[#-1].phase'), '') NOT IN ('succeeded', 'failed', 'cancelled', 'uncertain')`);
  for (const [rowid, attempt] of database.prepare("SELECT rowid, attempt_id FROM remote_worker_receipts ORDER BY attempt_id").raw().all() as Array<[number, unknown]>) {
    try { probe.all(rowid); } catch {
      refused.add("remote_worker_receipts", typeof attempt === "string" ? attempt : `rowid ${rowid}`, "its payload is not JSON the history trimming can read");
    }
  }
  return result();
}

// ---------------------------------------------------------------------------
// The prediction

/** A summary row as the recovery leaves it. */
export interface PredictedSummary { readonly run_id: string; readonly project_id: string; readonly queued_at: string; readonly terminal: 0 | 1; readonly bytes: number; readonly summary_json: string | null }
/** An accounting row as the recovery leaves it; `last_pruned_at` undefined when the recovery does not write it. */
export interface PredictedCoverage { readonly project_id: string; readonly records: number; readonly bytes: number; readonly evicted: number; readonly last_pruned_at: string | null | undefined; readonly inserted: boolean }
export type EvictionRule = "age" | "project" | "global";
export interface RecoveryPrediction {
  /** The one instant of the prediction. */
  readonly now: string;
  /** The runs the recovery interrupts, in its order, with the columns their upsert changes. */
  readonly interrupted: ReadonlyArray<{ readonly id: string; readonly projectId: string; readonly columns: Readonly<Record<string, string | number | null>> }>;
  /** Each history trim (after a run's save, then the final one) and the runs it deletes, in order. */
  readonly trims: ReadonlyArray<{ readonly selection: "project" | "recovery"; readonly projectId: string | null; readonly runs: readonly string[] }>;
  /** Every run deleted, in the order of the trims. */
  readonly trimmed: readonly string[];
  /** The requester rows the trims delete, by run ID. */
  readonly requesters: { readonly agent: readonly string[]; readonly human: readonly string[] };
  /** Every summary the recovery writes or deletes, as it leaves it (null: deleted). */
  readonly summaries: ReadonlyMap<string, PredictedSummary | null>;
  /** Each summary eviction, in order, with the rule that selected it. */
  readonly evictions: ReadonlyArray<{ readonly runId: string; readonly projectId: string; readonly rule: EvictionRule }>;
  /** Every accounting row the recovery writes, as it leaves it. */
  readonly coverage: ReadonlyMap<string, PredictedCoverage>;
}

interface SummaryState { runId: string; projectId: string; queuedAt: string; terminal: 0 | 1; bytes: number; json: unknown; key: [Buffer, Buffer]; alive: boolean }
interface CoverageState { records: number; bytes: number; evicted: number; lastPrunedAt: string | null | undefined; inserted: boolean; touched: boolean }
interface RunState { id: string; projectId: string; phase: string; queuedAt: string; key: [Buffer, Buffer] }
const compareKeys = (a: [Buffer, Buffer], b: [Buffer, Buffer]) => compareBytes(a[0], b[0]) || compareBytes(a[1], b[1]);

/** The summaries and their accounting, as the recovery's earlier writes leave them. */
class SummaryLedger {
  private readonly byRun = new Map<string, SummaryState>();
  /** Every summary ever present, by queue time and run ID; evicted ones stay, marked. */
  private readonly ordered: SummaryState[] = [];
  readonly coverage = new Map<string, CoverageState>();
  private totalRecords = 0;
  private totalBytes = 0;
  readonly touched = new Set<string>();
  readonly evictions: Array<{ runId: string; projectId: string; rule: EvictionRule }> = [];

  constructor(database: Database.Database, pendingIds: ReadonlySet<string>) {
    const rows = database.prepare("SELECT run_id,project_id,queued_at,terminal,bytes FROM test_run_summaries").raw().all() as Array<[string, string, string, 0 | 1, number]>;
    const json = database.prepare("SELECT summary_json FROM test_run_summaries WHERE run_id = ?").pluck();
    for (const [runId, projectId, queuedAt, terminal, bytes] of rows) {
      const state: SummaryState = { runId, projectId, queuedAt, terminal, bytes, json: pendingIds.has(runId) ? json.get(runId) : undefined, key: [utf8(queuedAt), utf8(runId)], alive: true };
      this.byRun.set(runId, state);
      this.ordered.push(state);
    }
    this.ordered.sort((a, b) => compareKeys(a.key, b.key));
    for (const [projectId, records, bytes, evicted] of database.prepare("SELECT project_id,records,bytes,evicted FROM test_summary_coverage").raw().all() as Array<[string, number, number, number]>) {
      this.coverage.set(projectId, { records, bytes, evicted, lastPrunedAt: undefined, inserted: false, touched: false });
      this.totalRecords += records; this.totalBytes += bytes;
    }
  }

  stored(runId: string): SummaryState | undefined { const state = this.byRun.get(runId); return state?.alive ? state : undefined; }
  /** Whether the run has an unfinished summary (the per-project trim leaves such a run alone). */
  unfinished(runId: string): boolean { return this.stored(runId)?.terminal === 0; }

  /** `TestSummaryQueries.save`: the summary and its accounting, unless the stored one is the same. */
  save(run: TestRun, policy: TestSummaryPolicy): void {
    const { json, bytes } = summaryOf(run);
    if (bytes > policy.maxRecordBytes) throw new Error("Test summary exceeds its bounded record budget.");
    const old = this.stored(run.id);
    if (old && old.projectId !== run.projectId) throw new Error("Test summary project identity cannot change.");
    if (old?.json === json) return;
    const terminal = run.phase !== "queued" && run.phase !== "running"
      && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || !!run.telemetry.finalizedAt || !!run.telemetry.recoveredAt);
    const oldBytes = old?.bytes;
    if (old) { old.terminal = terminal ? 1 : 0; old.bytes = bytes; old.json = json; } else {
      // An insert takes the run's project and queue time; an update keeps the stored ones.
      const state: SummaryState = { runId: run.id, projectId: run.projectId, queuedAt: run.queuedAt, terminal: terminal ? 1 : 0, bytes, json, key: [utf8(run.queuedAt), utf8(run.id)], alive: true };
      this.byRun.set(run.id, state);
      this.insertOrdered(state);
    }
    this.touched.add(run.id);
    // The accounting's upsert: a new row holds one record of this summary's bytes; an existing one is adjusted.
    const coverage = this.coverage.get(run.projectId);
    if (coverage) {
      const records = old ? 0 : 1, change = bytes - (oldBytes ?? 0);
      coverage.records += records; coverage.bytes += change; coverage.touched = true;
      this.totalRecords += records; this.totalBytes += change;
    } else {
      this.coverage.set(run.projectId, { records: 1, bytes, evicted: 0, lastPrunedAt: null, inserted: true, touched: true });
      this.totalRecords += 1; this.totalBytes += bytes;
    }
  }
  private insertOrdered(state: SummaryState): void {
    let low = 0, high = this.ordered.length;
    while (low < high) { const middle = (low + high) >> 1; if (compareKeys(this.ordered[middle].key, state.key) <= 0) low = middle + 1; else high = middle; }
    this.ordered.splice(low, 0, state);
  }

  /** Terminal summaries matching `accept`, oldest first by queue time and run ID, at most `limit` (a negative limit is none, as in SQLite). */
  private terminal(accept: (state: SummaryState) => boolean, limit: number): SummaryState[] {
    const rows: SummaryState[] = [];
    if (limit === 0) return rows;
    for (const state of this.ordered) {
      if (!state.alive || state.terminal !== 1 || !accept(state)) continue;
      rows.push(state);
      if (limit > 0 && rows.length >= limit) break;
    }
    return rows;
  }
  private evict(state: SummaryState, now: string, rule: EvictionRule): void {
    state.alive = false;
    this.byRun.delete(state.runId);
    this.touched.add(state.runId);
    this.evictions.push({ runId: state.runId, projectId: state.projectId, rule });
    const coverage = this.coverage.get(state.projectId);
    if (!coverage) return;
    coverage.records -= 1; coverage.bytes -= state.bytes; coverage.evicted += 1; coverage.lastPrunedAt = now; coverage.touched = true;
    this.totalRecords -= 1; this.totalBytes -= state.bytes;
    if (coverage.records < 0 || coverage.bytes < 0) throw new Error("The prediction met accounting its refusals should have stopped.");
  }
  private usage(projectId?: string): { records: number; bytes: number } {
    if (projectId === undefined) return { records: this.totalRecords, bytes: this.totalBytes };
    const coverage = this.coverage.get(projectId);
    return coverage ? { records: coverage.records, bytes: coverage.bytes } : { records: 0, bytes: 0 };
  }

  /** `TestSummaryQueries.prune(projectId)` as the run's save calls it (the project is always given), at `now`. */
  prune(projectId: string, policy: TestSummaryPolicy, now: string): void {
    const cutoff = utf8(new Date(Date.parse(now) - policy.maxAgeMs).toISOString());
    let deleted = 0;
    const remove = (rule: EvictionRule, accept: (state: SummaryState) => boolean, limit: number, requiredBytes = 0) => {
      let removedBytes = 0, removedRecords = 0;
      const rows = this.terminal(accept, Math.min(requiredBytes ? policy.pruneBatch : limit, policy.pruneBatch - deleted));
      for (const row of rows) {
        this.evict(row, now, rule);
        deleted++; removedRecords++; removedBytes += row.bytes;
        if (removedRecords >= limit && removedBytes >= requiredBytes) break;
      }
    };
    remove("age", state => compareBytes(state.key[0], cutoff) < 0, policy.pruneBatch);
    // An empty project ID is falsy there: the per-project step is skipped.
    const local = projectId ? this.usage(projectId) : { records: 0, bytes: 0 };
    if (projectId && deleted < policy.pruneBatch && (local.records > policy.perProjectRecords || local.bytes > policy.perProjectBytes)) {
      const excess = Math.max(0, local.records - policy.perProjectRecords);
      remove("project", state => state.projectId === projectId, excess, Math.max(0, local.bytes - policy.perProjectBytes));
    }
    const global = this.usage();
    if (deleted < policy.pruneBatch && (global.records > policy.globalRecords || global.bytes > policy.globalBytes)) {
      const excess = Math.max(0, global.records - policy.globalRecords);
      remove("global", () => true, excess, Math.max(0, global.bytes - policy.globalBytes));
    }
  }

  summaries(): Map<string, PredictedSummary | null> {
    return new Map([...this.touched].sort().map(runId => {
      const state = this.stored(runId);
      return [runId, state ? { run_id: state.runId, project_id: state.projectId, queued_at: state.queuedAt, terminal: state.terminal, bytes: state.bytes, summary_json: state.json as string } : null];
    }));
  }
  coverageRows(): Map<string, PredictedCoverage> {
    return new Map([...this.coverage].filter(([, state]) => state.touched).sort(([a], [b]) => compareBytes(utf8(a), utf8(b))).map(([projectId, state]) => [projectId,
      { project_id: projectId, records: state.records, bytes: state.bytes, evicted: state.evicted, last_pruned_at: state.lastPrunedAt, inserted: state.inserted }]));
  }
}

/**
 * The outcome of `markInterruptedTestRuns` on this database at `now`,
 * computed without writing. It assumes {@link recoveryRefusals} found nothing
 * (it throws if it meets a value they refuse); its result then is exactly the
 * recovery's at a fixed clock `now`. Runs inside the caller's transaction or
 * read.
 */
export function predictRecovery(database: Database.Database, now: string, policy: TestSummaryPolicy = TEST_SUMMARY_POLICY): RecoveryPrediction {
  const pending = database.prepare(PENDING_RUNS_SQL).all() as TestRunRow[];
  const ledger = new SummaryLedger(database, new Set(pending.map(row => row.id)));
  const runs = new Map<string, RunState>();
  const byProject = new Map<string, RunState[]>();
  for (const [id, projectId, phase, queuedAt] of database.prepare("SELECT id,project_id,phase,queued_at FROM test_runs").raw().all() as Array<[string, string, string, string]>) {
    const state: RunState = { id, projectId, phase, queuedAt, key: [utf8(queuedAt), utf8(id)] };
    runs.set(id, state);
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId)!.push(state);
  }
  const pinned = new Set(database.prepare(`SELECT id FROM test_runs WHERE id IN (${PINNED_RUNS_SQL})`).pluck().all() as string[]);
  const deleted = new Set<string>();
  const trims: Array<{ selection: "project" | "recovery"; projectId: string | null; runs: string[] }> = [];
  /** Finished runs still present, newest first by queue time and ID. */
  const finished = (states: readonly RunState[], skip: (state: RunState) => boolean) => states
    .filter(state => !deleted.has(state.id) && !ACTIVE_PHASES.includes(state.phase) && !skip(state))
    .sort((a, b) => compareKeys(b.key, a.key));
  const trim = (selection: "project" | "recovery", projectId: string | null, selected: string[]) => {
    for (const id of selected) deleted.add(id);
    trims.push({ selection, projectId, runs: selected });
  };

  const interrupted: Array<{ id: string; projectId: string; columns: Record<string, string | number | null> }> = [];
  for (const row of pending) {
    const run = interruptedRun(row, now);
    const state = runs.get(run.id);
    if (!state || deleted.has(run.id)) throw new Error("The prediction lost a run the recovery interrupts.");
    state.phase = run.phase;
    interrupted.push({ id: run.id, projectId: run.projectId, columns: interruptedRunColumns(run) });
    ledger.save(run, policy);
    if (closesHistory(run)) {
      ledger.prune(run.projectId, policy, now);
      // PROJECT_RETENTION_EXCESS: beyond the newest 50 finished runs without an unfinished summary, less the runs receipts pin.
      const candidates = finished(byProject.get(run.projectId) ?? [], candidate => ledger.unfinished(candidate.id)).slice(RETAINED_RUNS);
      trim("project", run.projectId, candidates.map(candidate => candidate.id).filter(id => !pinned.has(id)));
    }
  }
  // RECOVERY_RETENTION_EXCESS: every project's finished runs beyond its newest 50.
  const excess: string[] = [];
  for (const states of byProject.values()) excess.push(...finished(states, () => false).slice(RETAINED_RUNS).map(state => state.id));
  trim("recovery", null, excess);

  const trimmed = trims.flatMap(entry => entry.runs);
  const removed = (sql: string) => (database.prepare(sql).pluck().all() as string[]).filter(id => deleted.has(id)).sort();
  return {
    now, interrupted, trims, trimmed,
    requesters: { agent: removed("SELECT run_id FROM test_run_requesters"), human: removed("SELECT run_id FROM human_test_run_requesters") },
    summaries: ledger.summaries(), evictions: ledger.evictions, coverage: ledger.coverageRows(),
  };
}

// ---------------------------------------------------------------------------
// The act's check of the real recovery

/** What the act records before the recovery runs: run IDs and requester run IDs. */
export interface RecoveryBaseline { readonly runs: ReadonlySet<string>; readonly agent: ReadonlySet<string>; readonly human: ReadonlySet<string> }
const idSet = (database: Database.Database, sql: string) => new Set(database.prepare(sql).pluck().all() as string[]);
export function recoveryBaseline(database: Database.Database): RecoveryBaseline {
  return { runs: idSet(database, "SELECT id FROM test_runs"), agent: idSet(database, "SELECT run_id FROM test_run_requesters"), human: idSet(database, "SELECT run_id FROM human_test_run_requesters") };
}
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every(value => b.has(value));
const minus = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a].filter(value => !b.has(value)));

/**
 * The clock-independent facts on which the real recovery, run after
 * `baseline` was taken, disagrees with `prediction` (empty when it agrees):
 * the runs deleted are exactly the predicted ones; every interrupted run that
 * remains is `interrupted` with no queue position; no queued or running run
 * and no run with an unfinished summary remains; and the requester rows of
 * the deleted runs are gone while every other one remains.
 */
export function recoveryDisagreements(database: Database.Database, prediction: RecoveryPrediction, baseline: RecoveryBaseline): string[] {
  const found: string[] = [];
  const trimmed = new Set(prediction.trimmed);
  const after = idSet(database, "SELECT id FROM test_runs");
  if (minus(after, baseline.runs).size > 0) found.push("runs appeared");
  if (!sameSet(minus(baseline.runs, after), trimmed)) found.push("the runs deleted are not the predicted ones");
  const phase = database.prepare("SELECT phase, queue_position FROM test_runs WHERE id = ?");
  for (const run of prediction.interrupted) {
    if (trimmed.has(run.id)) continue;
    const row = phase.get(run.id) as { phase: unknown; queue_position: unknown } | undefined;
    if (!row || row.phase !== "interrupted" || row.queue_position !== null) found.push("an interrupted run is not in its predicted phase");
  }
  if (database.prepare(`SELECT 1 FROM (${PENDING_RUNS_SQL}) LIMIT 1`).get()) found.push("a run remains to be interrupted");
  for (const [table, before] of [["test_run_requesters", baseline.agent], ["human_test_run_requesters", baseline.human]] as const) {
    const left = idSet(database, `SELECT run_id FROM ${table}`);
    if (!sameSet(left, minus(before, trimmed))) found.push(`the requester rows of ${table} are not the predicted ones`);
  }
  return found;
}
