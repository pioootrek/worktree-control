import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TestRun, TestRunSummary } from "@/shared/contracts";
import { emptyTelemetry, emptyRunResources } from "@/server/modules/verification";

// Local stage-1 defaults, to be calibrated. Caps can shorten the time horizon.
export const TEST_SUMMARY_POLICY = {
  maxAgeMs: 30 * 24 * 60 * 60_000,
  perProjectRecords: 5_000,
  perProjectBytes: 16 * 1024 * 1024,
  globalRecords: 50_000,
  globalBytes: 128 * 1024 * 1024,
  maxRecordBytes: 8_192,
  pruneBatch: 64,
} as const;
export type TestSummaryPolicy = { [K in keyof typeof TEST_SUMMARY_POLICY]: number };
const SOURCE_REASON_CODES = new Set([
  "dirty_source", "source_changed_before_start", "source_changed_during_execution",
  "source_preflight_failed", "source_finish_failed", "legacy_evidence_unavailable",
  "controller_interrupted", "source_evidence_incomplete", "missing_worktree",
  "status_limit_exceeded", "source_observation_failed", "run_directory_cleanup_failed",
]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (value: string, max: number) => value.length <= max ? value : `sha256:${digest(value)}`;

export function summarizeTestRun(run: TestRun): TestRunSummary {
  const source = run.source.enqueue;
  return {
    version: 1, runId: run.id, projectId: run.projectId,
    presetId: identity(run.presetId, 160), worktreePath: identity(run.worktreePath, 1024),
    commandDigest: digest([run.executable, run.args, run.cwd]),
    // Policy identity only: environment values are deliberately excluded.
    profileDigest: digest([run.environmentMode, run.environmentProfile, run.inheritedServerProfile]),
    sourceIdentity: { head: source?.head ? identity(source.head, 128) : null,
      statusDigest: source?.statusDigest ? identity(source.statusDigest, 128) : null, dirty: source?.dirty ?? null },
    queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
    phase: run.phase, processOutcome: run.source.processOutcome, attribution: run.source.attribution,
    sourceReasonCodes: [...new Set(run.source.reasonCodes.map(code => SOURCE_REASON_CODES.has(code) ? code : "source_evidence_incomplete"))].slice(0, 12),
    exitCode: run.exitCode, signal: run.signal?.slice(0, 32) ?? null,
    telemetry: { ...(run.telemetry ?? emptyTelemetry()), resources: run.telemetry?.resources ?? emptyRunResources() },
  };
}

/** Older version-1 JSON has no resource field; absence always means unknown. */
export function parseTestSummary(json: string): TestRunSummary {
  const summary = JSON.parse(json) as TestRunSummary;
  summary.telemetry.resources ??= emptyRunResources();
  return summary;
}

/** The summary row `save` compares with, as stored. */
export interface StoredSummary { project_id: string; bytes: number; summary_json: string }
/** A terminal summary `prune` may evict. */
export interface TerminalSummary { run_id: string; project_id: string; bytes: number }

export const SAVE_SUMMARY_SQL = `INSERT INTO test_run_summaries(run_id, project_id, queued_at, terminal, bytes, summary_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET
      terminal=excluded.terminal, bytes=excluded.bytes, summary_json=excluded.summary_json`;
export const SAVE_COVERAGE_SQL = `INSERT INTO test_summary_coverage(project_id, records, bytes) VALUES (?, 1, ?)
      ON CONFLICT(project_id) DO UPDATE SET records=records+?, bytes=bytes+?`;
export const EVICT_SUMMARY_SQL = "DELETE FROM test_run_summaries WHERE run_id=?";
export const EVICT_COVERAGE_SQL = `UPDATE test_summary_coverage SET records=records-1,bytes=bytes-?,evicted=evicted+1,last_pruned_at=? WHERE project_id=?`;
/** The parameters of {@link SAVE_SUMMARY_SQL} and {@link SAVE_COVERAGE_SQL}. */
export const saveSummaryParameters = (run: TestRun, terminal: boolean, bytes: number, json: string) => [run.id, run.projectId, run.queuedAt, terminal ? 1 : 0, bytes, json];
export const saveCoverageParameters = (run: TestRun, bytes: number, old: StoredSummary | undefined) => [run.projectId, bytes, old ? 0 : 1, bytes - (old?.bytes ?? 0)];
/** The parameters of {@link EVICT_SUMMARY_SQL} and {@link EVICT_COVERAGE_SQL}. */
export const evictSummaryParameters = (row: TerminalSummary) => [row.run_id];
export const evictCoverageParameters = (row: TerminalSummary, now: string) => [row.bytes, now, row.project_id];

/**
 * What the summary rules read and write. {@link TestSummaryQueries} runs each
 * statement against the database at once; the test-run recovery's preparation
 * (`test-run-queries.ts`) answers the same reads from the state its earlier
 * writes would leave and records the writes without making them. Both run the
 * one rule of {@link saveSummary} and {@link pruneSummaries}.
 */
export interface SummaryLedger {
  /** `SELECT project_id, bytes, summary_json FROM test_run_summaries WHERE run_id = ?` */
  stored(runId: string): StoredSummary | undefined;
  /** {@link SAVE_SUMMARY_SQL}, then {@link SAVE_COVERAGE_SQL}. */
  saved(run: TestRun, terminal: boolean, bytes: number, json: string, old: StoredSummary | undefined): void;
  /** Terminal summaries matching `condition`, oldest first by queue time and run ID, at most `limit`. */
  terminal(condition: string, parameters: Array<string | number>, limit: number): TerminalSummary[];
  /** {@link EVICT_SUMMARY_SQL}, then {@link EVICT_COVERAGE_SQL}. */
  evicted(row: TerminalSummary, now: string): void;
  /** One project's accounting, or every project's summed. */
  usage(projectId?: string): { records: number; bytes: number };
  /** The first project, by ID, over either per-project cap. */
  overCap(records: number, bytes: number): string | undefined;
}

/** Saves the run's summary and its accounting, unless the stored summary is already the same. */
export function saveSummary(ledger: SummaryLedger, run: TestRun, policy: TestSummaryPolicy): void {
  const summary = summarizeTestRun(run);
  const json = JSON.stringify(summary);
  const bytes = Buffer.byteLength(json);
  if (bytes > policy.maxRecordBytes) throw new Error("Test summary exceeds its bounded record budget.");
  const old = ledger.stored(run.id);
  if (old && old.project_id !== run.projectId) throw new Error("Test summary project identity cannot change.");
  if (old?.summary_json === json) return;
  const terminal = run.phase !== "queued" && run.phase !== "running"
    && (!run.telemetry || run.telemetry.availability === "legacy_unknown" || !!run.telemetry.finalizedAt || !!run.telemetry.recoveredAt);
  ledger.saved(run, terminal, bytes, json, old);
}

/** At most pruneBatch deletes per maintenance call. Active summaries are never candidates. */
export function pruneSummaries(ledger: SummaryLedger, policy: TestSummaryPolicy, projectId: string | undefined, now: string): number {
  const cutoff = new Date(Date.parse(now) - policy.maxAgeMs).toISOString();
  let deleted = 0;
  const remove = (condition: string, args: (string | number)[], limit: number, requiredBytes = 0) => {
    let removedBytes = 0, removedRecords = 0;
    const rows = ledger.terminal(condition, args, Math.min(requiredBytes ? policy.pruneBatch : limit, policy.pruneBatch - deleted));
    for (const row of rows) {
      ledger.evicted(row, now);
      deleted++; removedRecords++; removedBytes += row.bytes;
      if (removedRecords >= limit && removedBytes >= requiredBytes) break;
    }
  };
  remove("queued_at < ?", [cutoff], policy.pruneBatch);
  projectId ??= ledger.overCap(policy.perProjectRecords, policy.perProjectBytes);
  const local = projectId ? ledger.usage(projectId) : { records: 0, bytes: 0 };
  if (projectId && deleted < policy.pruneBatch && (local.records > policy.perProjectRecords || local.bytes > policy.perProjectBytes)) {
    const excess = Math.max(0, local.records - policy.perProjectRecords);
    remove("project_id=?", [projectId], excess, Math.max(0, local.bytes - policy.perProjectBytes));
  }
  const global = ledger.usage();
  if (deleted < policy.pruneBatch && (global.records > policy.globalRecords || global.bytes > policy.globalBytes)) {
    const excess = Math.max(0, global.records - policy.globalRecords);
    remove("1=1", [], excess, Math.max(0, global.bytes - policy.globalBytes));
  }
  return deleted;
}

/** The ledger of the database itself: every read and write at once, on the borrowed connection. */
class DatabaseSummaryLedger implements SummaryLedger {
  constructor(private readonly database: Database.Database) {}
  stored(runId: string): StoredSummary | undefined {
    return this.database.prepare("SELECT project_id, bytes, summary_json FROM test_run_summaries WHERE run_id = ?").get(runId) as StoredSummary | undefined;
  }
  saved(run: TestRun, terminal: boolean, bytes: number, json: string, old: StoredSummary | undefined): void {
    this.database.prepare(SAVE_SUMMARY_SQL).run(...saveSummaryParameters(run, terminal, bytes, json));
    this.database.prepare(SAVE_COVERAGE_SQL).run(...saveCoverageParameters(run, bytes, old));
  }
  terminal(condition: string, parameters: Array<string | number>, limit: number): TerminalSummary[] {
    return this.database.prepare(`SELECT run_id,project_id,bytes FROM test_run_summaries
        WHERE terminal=1 AND ${condition} ORDER BY queued_at,run_id LIMIT ?`).all(...parameters, limit) as TerminalSummary[];
  }
  evicted(row: TerminalSummary, now: string): void {
    this.database.prepare(EVICT_SUMMARY_SQL).run(...evictSummaryParameters(row));
    this.database.prepare(EVICT_COVERAGE_SQL).run(...evictCoverageParameters(row, now));
  }
  usage(projectId?: string): { records: number; bytes: number } {
    // Aggregate the small project accounting table, never scan summary payloads.
    return this.database.prepare(projectId ? "SELECT records,bytes FROM test_summary_coverage WHERE project_id=?"
      : "SELECT coalesce(sum(records),0) records,coalesce(sum(bytes),0) bytes FROM test_summary_coverage")
      .get(...(projectId ? [projectId] : [])) as { records: number; bytes: number } ?? { records: 0, bytes: 0 };
  }
  overCap(records: number, bytes: number): string | undefined {
    return (this.database.prepare("SELECT project_id FROM test_summary_coverage WHERE records>? OR bytes>? ORDER BY project_id LIMIT 1")
      .get(records, bytes) as { project_id: string } | undefined)?.project_id;
  }
}

/** Borrows the existing owner connection. All mutations run inside its caller's transaction. */
export class TestSummaryQueries {
  private readonly ledger: DatabaseSummaryLedger;
  constructor(private readonly database: Database.Database, private readonly policy: TestSummaryPolicy = TEST_SUMMARY_POLICY) {
    this.ledger = new DatabaseSummaryLedger(database);
  }

  save(run: TestRun): void {
    saveSummary(this.ledger, run, this.policy);
  }

  get(runId: string): TestRunSummary | null {
    const row = this.database.prepare("SELECT summary_json FROM test_run_summaries WHERE run_id=?").get(runId) as { summary_json: string } | undefined;
    return row ? parseTestSummary(row.summary_json) : null;
  }

  coverage(projectId: string) {
    const usage = this.database.prepare("SELECT * FROM test_summary_coverage WHERE project_id=?").get(projectId) as {
      project_id: string; records: number; bytes: number; evicted: number; last_pruned_at: string | null;
    } | undefined;
    const edge = (direction: "ASC" | "DESC") => (this.database.prepare(`SELECT queued_at FROM test_run_summaries WHERE project_id=? ORDER BY queued_at ${direction},run_id ${direction} LIMIT 1`).get(projectId) as { queued_at: string } | undefined)?.queued_at ?? null;
    return { records: usage?.records ?? 0, bytes: usage?.bytes ?? 0, evicted: usage?.evicted ?? 0,
      lastPrunedAt: usage?.last_pruned_at ?? null, oldestQueuedAt: edge("ASC"), newestQueuedAt: edge("DESC"),
      policy: this.policy, maintenancePending: this.needsPruning(projectId, new Date().toISOString()) };
  }

  needsPruning(projectId: string, now: string): boolean {
    const local = this.ledger.usage(projectId), global = this.ledger.usage();
    return local.records > this.policy.perProjectRecords || local.bytes > this.policy.perProjectBytes
      || global.records > this.policy.globalRecords || global.bytes > this.policy.globalBytes
      || !!this.database.prepare("SELECT 1 FROM test_run_summaries WHERE terminal=1 AND queued_at < ? LIMIT 1")
        .get(new Date(Date.parse(now) - this.policy.maxAgeMs).toISOString());
  }

  /** At most pruneBatch deletes per maintenance call. Active summaries are never candidates. */
  prune(projectId?: string, now = new Date().toISOString()): number {
    return pruneSummaries(this.ledger, this.policy, projectId, now);
  }
}
