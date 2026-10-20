import type { TestProcessOutcome, TestRunResources, TestRunSummary, TestSourceAttribution } from "@/shared/contracts";
import type {
  TestDurationKey, TestDurationStatistic, TestHistoryFilter, TestMetricPopulation, TestResourceComparison, TestResourceStatistic, TestRunComparison,
} from "@/shared/contracts/verification-history";

/** Server bounds: 31-day enqueue window, 1–50 rows per page, 2,048-character cursor. */
export const HISTORY_PAGE_SIZE = 25;
export const MAX_WINDOW_DAYS = 31;
/** Statistics from fewer valid observations are labelled as indicative only. */
export const SMALL_SAMPLE = 5;

export const PERIODS = ["24h", "7d", "30d"] as const;
export type Period = (typeof PERIODS)[number];
const periodMs: Record<Period, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export const DURATION_KEYS: TestDurationKey[] = ["queueMs", "prepareMs", "processMs", "cleanupMs", "finalizationMs", "totalMs"];
/** Sequential phases; total and runner wait are not segments. */
export const PHASE_KEYS = ["queueMs", "prepareMs", "processMs", "cleanupMs", "finalizationMs"] as const satisfies readonly TestDurationKey[];
export const POPULATIONS: TestMetricPopulation[] = ["completed_execution", "cancelled", "timed_out", "interrupted", "in_progress", "rejected", "other_incomplete"];
export const PROCESS_OUTCOMES: Array<TestProcessOutcome | "unknown"> = ["passed", "failed", "cancelled", "timed_out", "interrupted", "unknown"];
export const ATTRIBUTIONS: TestSourceAttribution[] = ["observed_match", "changed", "uncertain", "pending", "legacy_unknown"];

export interface TelemetryFilters {
  period: Period;
  presetId: string | null;
  worktreePath: string | null;
  processOutcome: TestProcessOutcome | "unknown" | null;
  attribution: TestSourceAttribution | null;
}
export const DEFAULT_FILTERS: TelemetryFilters = { period: "7d", presetId: null, worktreePath: null, processOutcome: null, attribution: null };

/** An explicit, anchored window: passive re-renders never move it. */
export function historyWindow(period: Period, anchorMs: number): { from: string; to: string } {
  const to = new Date(Math.floor(anchorMs));
  return { from: new Date(to.getTime() - periodMs[period]).toISOString(), to: to.toISOString() };
}

export function historyFilter(projectId: string, filters: TelemetryFilters, anchorMs: number): TestHistoryFilter {
  const filter: TestHistoryFilter = { projectId, ...historyWindow(filters.period, anchorMs) };
  if (filters.presetId) filter.presetId = filters.presetId;
  if (filters.worktreePath) filter.worktreePath = filters.worktreePath;
  if (filters.processOutcome) filter.processOutcome = filters.processOutcome;
  if (filters.attribution) filter.attribution = filters.attribution;
  return filter;
}

/** Query string for the HTTP routes; projectId travels only in the path. */
export function filterQuery(filter: TestHistoryFilter, page?: { limit: number; cursor: string | null }): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (key === "projectId" || value === undefined) continue;
    query.set(key, typeof value === "boolean" ? String(value) : String(value));
  }
  if (page) {
    query.set("limit", String(Math.min(50, Math.max(1, Math.trunc(page.limit)))));
    if (page.cursor) query.set("cursor", page.cursor);
  }
  return query;
}

export function activeFilterCount(filters: TelemetryFilters): number {
  return [filters.presetId, filters.worktreePath, filters.processOutcome, filters.attribution].filter((value) => value !== null).length;
}

/** Finite nonnegative measurement or null; null is never rendered as zero. */
export function measured(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatDuration(ms: number | null | undefined, locale: string): string | null {
  const value = measured(ms);
  if (value === null) return null;
  const number = (n: number, digits: number) => n.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  if (value < 1000) return `${number(Math.round(value), 0)} ms`;
  if (value < 60_000) return `${number(value / 1000, value < 10_000 ? 2 : 1)} s`;
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours} h ${minutes} min` : `${minutes} min ${seconds} s`;
}

export function formatSignedDuration(ms: number | null, locale: string): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms === 0) return formatDuration(0, locale);
  return `${ms > 0 ? "+" : "−"}${formatDuration(Math.abs(ms), locale)}`;
}

export function formatBytes(value: number | null | undefined): string | null {
  let size = measured(value);
  if (size === null) return null;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatSignedBytes(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value === 0) return formatBytes(0);
  return `${value > 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

/** 100% is one logical core; values above 100% are expected for parallel work. */
export function formatCpu(value: number | null | undefined, locale: string): string | null {
  const percent = measured(value);
  return percent === null ? null : `${percent.toLocaleString(locale, { maximumFractionDigits: percent >= 100 ? 0 : 1 })}%`;
}

export function formatSignedCpu(value: number | null, locale: string): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const text = Math.abs(value).toLocaleString(locale, { maximumFractionDigits: 1 });
  return value === 0 ? `${text} pp` : `${value > 0 ? "+" : "−"}${text} pp`;
}

export function shortIdentity(value: string | null, length = 8): string | null {
  if (!value) return null;
  return value.startsWith("sha256:") ? `sha256:${value.slice(7, 7 + length)}` : value.slice(0, length);
}

export function worktreeLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

export type CommandResult = TestProcessOutcome | "unknown";
export type RunVerdictNote = "source_overrode_command" | "finalization_overrode_command" | "command_not_started" | null;

/** Command outcome and source attribution are separate axes; the run phase combines them. */
export function runFacts(summary: TestRunSummary) {
  const command: CommandResult = summary.processOutcome ?? "unknown";
  // A passed command still fails its run when the source is unconfirmed, or when its result could not be saved.
  const note: RunVerdictNote = summary.phase === "failed" && command === "passed"
    ? summary.attribution === "observed_match" ? "finalization_overrode_command" : "source_overrode_command"
    : summary.processOutcome === null && !summary.telemetry.spawnedAt && !["queued", "running"].includes(summary.phase) ? "command_not_started" : null;
  return { phase: summary.phase, command, source: summary.attribution, note,
    failed: ["failed", "timed_out", "interrupted"].includes(summary.phase) };
}

export type ResourceStatus = TestRunResources["status"];
/** Missing resources in an older summary are reported as a legacy gap, never as zero. */
export function runResources(summary: TestRunSummary): TestRunResources | null {
  return summary.telemetry.resources ?? null;
}
export function resourceStatus(summary: TestRunSummary): ResourceStatus {
  return summary.telemetry.resources?.status ?? "legacy_unknown";
}

export interface PhaseSegment { key: (typeof PHASE_KEYS)[number]; ms: number | null; share: number | null }
/** Proportional phase segments when every phase is measured; otherwise shares stay null. */
export function phaseSegments(summary: TestRunSummary): { segments: PhaseSegment[]; complete: boolean } {
  const values = PHASE_KEYS.map((key) => ({ key, ms: measured(summary.telemetry.durations[key]) }));
  const complete = values.every((value) => value.ms !== null);
  const sum = complete ? values.reduce((total, value) => total + (value.ms ?? 0), 0) : 0;
  return { complete, segments: values.map((value) => ({ ...value, share: complete && sum > 0 ? (value.ms ?? 0) / sum : null })) };
}

/** The phase that consumed most of a fully measured run, when it is a clear majority. */
export function dominantPhase(summary: TestRunSummary): PhaseSegment["key"] | null {
  const { segments, complete } = phaseSegments(summary);
  if (!complete) return null;
  const top = [...segments].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  return top && (top.share ?? 0) >= 0.5 ? top.key : null;
}

export type SampleSize = "none" | "small" | "ok";
export function sampleSize(valid: number): SampleSize {
  return valid === 0 ? "none" : valid < SMALL_SAMPLE ? "small" : "ok";
}

export function statisticCoverage(statistic: Pick<TestDurationStatistic, "valid" | "missing" | "denominator">) {
  return { valid: statistic.valid, missing: statistic.missing, denominator: statistic.denominator, size: sampleSize(statistic.valid) };
}

/** Status counts in a stable order, without empty statuses. */
export function resourceStatusCounts(statistic: TestResourceStatistic): Array<[ResourceStatus, number]> {
  const order: ResourceStatus[] = ["sampled", "partial", "pending", "unavailable", "unsupported", "legacy_unknown"];
  return order.map((status): [ResourceStatus, number] => [status, statistic.statuses[status] ?? 0]).filter(([, count]) => count > 0);
}

export type ResourceComparability = "comparable" | "missing_left" | "missing_right" | "missing_both" | "excluded";
/** Explains a null resource delta from the observed values; the server decides comparability. */
export function resourceComparability(comparison: TestResourceComparison): ResourceComparability {
  if (comparison.delta !== null && Number.isFinite(comparison.delta)) return "comparable";
  const left = measured(comparison.left), right = measured(comparison.right);
  if (left === null && right === null) return "missing_both";
  if (left === null) return "missing_left";
  if (right === null) return "missing_right";
  return "excluded";
}

export type TimingComparability = "comparable" | "missing_left" | "missing_right" | "missing_both";
export function timingComparability(row: TestRunComparison["timings"][TestDurationKey]): TimingComparability {
  if (row.deltaMs !== null) return "comparable";
  const left = measured(row.leftMs), right = measured(row.rightMs);
  return left === null && right === null ? "missing_both" : left === null ? "missing_left" : right === null ? "missing_right" : "comparable";
}

/** Relative change only when the baseline is measured and nonzero. */
export function relativeChange(left: number | null, delta: number | null): number | null {
  if (delta === null || left === null || !Number.isFinite(left) || left <= 0) return null;
  return delta / left;
}

export type CaveatKey = "identity" | "profile" | "differs" | "source" | "censored" | "timing" | "resources";
const caveatPrefixes: Array<[CaveatKey, string]> = [
  ["identity", "Git identities do not prove identical files"],
  ["profile", "Profile digests identify policy selection"],
  ["differs", "Run identities differ"],
  ["source", "Source observations are missing"],
  ["censored", "At least one run is censored"],
  ["timing", "Missing timing observations remain null"],
  ["resources", "Resources are sampled peaks"],
];
/** Known server caveats get translated text; unknown ones are shown verbatim. */
export function caveatKey(text: string): CaveatKey | null {
  return caveatPrefixes.find(([, prefix]) => text.startsWith(prefix))?.[0] ?? null;
}

export const KNOWN_SOURCE_REASONS = ["dirty_source", "source_evidence_incomplete", "source_changed_before_start", "source_changed_during_execution", "legacy_evidence_unavailable", "source_preflight_failed", "source_finish_failed"] as const;
export type KnownSourceReason = (typeof KNOWN_SOURCE_REASONS)[number];
export function knownSourceReason(code: string): code is KnownSourceReason {
  return (KNOWN_SOURCE_REASONS as readonly string[]).includes(code);
}
export const KNOWN_RESOURCE_REASONS = ["not_started", "legacy_unknown", "unsupported", "identity_unavailable", "identity_lost", "read_failed", "incomplete_scan", "membership_changed", "counter_gap", "no_cpu_interval", "inflight_discarded", "controller_interrupted", "process_churn", "group_exited"] as const;
export function knownResourceReason(code: string): code is (typeof KNOWN_RESOURCE_REASONS)[number] {
  return (KNOWN_RESOURCE_REASONS as readonly string[]).includes(code);
}

/** Forward-only signed cursors; earlier pages are revisited by their recorded cursor. */
export interface PageTrail { cursors: Array<string | null>; index: number }
export const firstPage = (): PageTrail => ({ cursors: [null], index: 0 });
export function nextPage(trail: PageTrail, nextCursor: string | null): PageTrail {
  if (!nextCursor) return trail;
  return { cursors: [...trail.cursors.slice(0, trail.index + 1), nextCursor], index: trail.index + 1 };
}
export function previousPage(trail: PageTrail): PageTrail {
  return trail.index > 0 ? { ...trail, index: trail.index - 1 } : trail;
}
export const currentCursor = (trail: PageTrail) => trail.cursors[trail.index] ?? null;

/** Two-run comparison selection: newest choice replaces the oldest beyond two. */
export function toggleSelection(selected: string[], runId: string): string[] {
  if (selected.includes(runId)) return selected.filter((id) => id !== runId);
  return [...selected, runId].slice(-2);
}

/** Orders a pair chronologically so deltas read as later minus earlier. */
export function chronologicalPair(entries: Array<{ runId: string; queuedAt: string }>): [string, string] | null {
  if (entries.length !== 2) return null;
  const [a, b] = [...entries].sort((x, y) => Date.parse(x.queuedAt) - Date.parse(y.queuedAt) || x.runId.localeCompare(y.runId));
  return [a.runId, b.runId];
}
