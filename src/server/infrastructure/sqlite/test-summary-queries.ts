import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TestRun, TestRunSummary } from "@/shared/contracts";
import { emptyTelemetry } from "@/server/modules/verification";

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
  "status_limit_exceeded", "source_observation_failed",
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
    telemetry: run.telemetry ?? emptyTelemetry(),
  };
}

/** Borrows the existing owner connection. All mutations run inside its caller's transaction. */
export class TestSummaryQueries {
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

  get(runId: string): TestRunSummary | null {
    const row = this.database.prepare("SELECT summary_json FROM test_run_summaries WHERE run_id=?").get(runId) as { summary_json: string } | undefined;
    return row ? JSON.parse(row.summary_json) as TestRunSummary : null;
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

  private usage(projectId?: string): { records: number; bytes: number } {
    // Aggregate the small project accounting table, never scan summary payloads.
    return this.database.prepare(projectId ? "SELECT records,bytes FROM test_summary_coverage WHERE project_id=?"
      : "SELECT coalesce(sum(records),0) records,coalesce(sum(bytes),0) bytes FROM test_summary_coverage")
      .get(...(projectId ? [projectId] : [])) as { records: number; bytes: number } ?? { records: 0, bytes: 0 };
  }
  needsPruning(projectId: string, now: string): boolean {
    const local = this.usage(projectId), global = this.usage();
    return local.records > this.policy.perProjectRecords || local.bytes > this.policy.perProjectBytes
      || global.records > this.policy.globalRecords || global.bytes > this.policy.globalBytes
      || !!this.database.prepare("SELECT 1 FROM test_run_summaries WHERE terminal=1 AND queued_at < ? LIMIT 1")
        .get(new Date(Date.parse(now) - this.policy.maxAgeMs).toISOString());
  }

  /** At most pruneBatch deletes per maintenance call. Active summaries are never candidates. */
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
