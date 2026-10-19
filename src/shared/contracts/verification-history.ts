import type { TestProcessOutcome, TestRunSummary, TestSourceAttribution, TestRunTelemetry } from "../contracts";

/** Enqueue-time interval [from,to], at most 31 days. Filters are exact identities. */
export interface TestHistoryFilter {
  projectId: string;
  from: string;
  to: string;
  presetId?: string;
  worktreePath?: string;
  head?: string;
  statusDigest?: string;
  dirty?: boolean;
  processOutcome?: TestProcessOutcome | "unknown";
  attribution?: TestSourceAttribution;
}
export interface TestHistoryRequest extends TestHistoryFilter { limit?: number; cursor?: string }
export interface TestSummaryEntry { summary: TestRunSummary; detailAvailable: boolean }
export interface TestHistoryCoverage {
  records: number;
  bytes: number;
  evicted: number;
  lastPrunedAt: string | null;
  oldestQueuedAt: string | null;
  newestQueuedAt: string | null;
  policy: { maxAgeMs: number; perProjectRecords: number; perProjectBytes: number; globalRecords: number; globalBytes: number; maxRecordBytes: number; pruneBatch: number };
  maintenancePending: boolean;
  historicalCompleteness: "not_guaranteed";
}
export interface TestHistoryPage {
  items: TestSummaryEntry[];
  nextCursor: string | null;
  order: "queuedAt_desc_runId_desc";
  selection: { filter: TestHistoryFilter; scanned: number; scanLimit: number; scanLimitReached: boolean; consistency: "live_keyset_not_snapshot" };
  coverage: TestHistoryCoverage;
}
export type TestDurationKey = Exclude<keyof TestRunTelemetry["durations"], "runnerWaitMs">;
export type TestMetricPopulation = "completed_execution" | "cancelled" | "timed_out" | "interrupted" | "in_progress" | "rejected" | "other_incomplete";
export interface TestDurationStatistic { medianMs: number | null; p95Ms: number | null; valid: number; missing: number; denominator: number }
export interface TestMetrics {
  selection: { filter: TestHistoryFilter; scanned: number; scanLimit: number; truncated: boolean; matched: number; order: "queuedAt_desc_runId_desc" };
  processOutcomes: Record<TestProcessOutcome | "unknown", number>;
  sourceAttributions: Record<TestSourceAttribution, number>;
  populations: Record<TestMetricPopulation, { count: number; durations: Record<TestDurationKey, TestDurationStatistic> }>;
  method: { median: "sorted_midpoint_mean"; p95: "nearest_rank_ceil_0.95_n"; missing: "excluded_not_zero"; population: "per_run_not_daily_percentiles" };
  resources: { cpu: "unavailable"; rss: "unavailable"; runnerWait: "unavailable" };
  coverage: TestHistoryCoverage;
}
export interface TestRunComparison {
  left: TestSummaryEntry;
  right: TestSummaryEntry;
  differences: { source: boolean; command: boolean; profile: boolean; preset: boolean; worktree: boolean };
  timings: Record<TestDurationKey, { leftMs: number | null; rightMs: number | null; deltaMs: number | null }>;
  populations: { left: TestMetricPopulation; right: TestMetricPopulation };
  caveats: string[];
  resources: { cpu: "unavailable"; rss: "unavailable"; runnerWait: "unavailable" };
}
