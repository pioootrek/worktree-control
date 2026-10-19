import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { StateStore, TestHistoryPosition } from "@/server/state-store";
import type { TestRunSummary } from "@/shared/contracts";
import type { TestHistoryFilter, TestHistoryPage, TestMetrics, TestMetricPopulation, TestDurationKey, TestRunComparison } from "@/shared/contracts/verification-history";
import { resourceMetrics, compareResources } from "./resource-statistics";
import { parseHistoryInput, testComparisonSchema, testHistorySchema, testMetricsSchema, testSummarySchema } from "./history-input";

const PAGE_SCAN_LIMIT = 1000;
const METRIC_SCAN_LIMIT = 5000;
const ORDER = "queuedAt_desc_runId_desc";
const durations: TestDurationKey[] = ["queueMs", "prepareMs", "processMs", "cleanupMs", "finalizationMs", "totalMs"];
const populationNames: TestMetricPopulation[] = ["completed_execution", "cancelled", "timed_out", "interrupted", "in_progress", "rejected", "other_incomplete"];

const finiteDuration = (value: number | null) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function metricPopulation(s: TestRunSummary): TestMetricPopulation {
  const t = s.telemetry;
  // Recovery/cancellation can retain a passed process outcome. Its run is still censored.
  // Match the summary writer's terminal rule. Legacy timing gaps cannot tell us
  // that a historical terminal run still has finalization work outstanding.
  if (s.phase === "queued" || s.phase === "running"
    || (t.availability !== "legacy_unknown" && !t.finalizedAt && !t.recoveredAt)) return "in_progress";
  if (s.phase === "cancelled" || s.phase === "timed_out" || s.phase === "interrupted") return s.phase;
  if (t.termination === "rejected" || t.termination === "spawn_error") return "rejected";
  if ((s.processOutcome === "passed" || s.processOutcome === "failed") && t.termination === "exit"
    && t.spawnedAt && t.exitedAt && t.finalizedAt && t.cleanup === "confirmed") return "completed_execution";
  return "other_incomplete";
}
function matches(s: TestRunSummary, f: TestHistoryFilter): boolean {
  return (f.presetId === undefined || s.presetId === f.presetId)
    && (f.worktreePath === undefined || s.worktreePath === f.worktreePath)
    && (f.head === undefined || s.sourceIdentity.head === f.head)
    && (f.statusDigest === undefined || s.sourceIdentity.statusDigest === f.statusDigest)
    && (f.dirty === undefined || s.sourceIdentity.dirty === f.dirty)
    && (f.processOutcome === undefined || (s.processOutcome ?? "unknown") === f.processOutcome)
    && (f.attribution === undefined || s.attribution === f.attribution);
}
function scope(filter: TestHistoryFilter): string {
  return createHash("sha256").update(JSON.stringify([ORDER, ...Object.entries(filter).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
}
interface Cursor { version: 1; scope: string; before: TestHistoryPosition; ceiling: TestHistoryPosition }

/** Runtime transports admit only installation/runtime authority, just as for testRun.
 * This service validates project-scoped lookups before touching any run identity.
 */
export class VerificationHistoryService {
  private readonly cursorKey = randomBytes(32);
  constructor(
    private readonly store: Pick<StateStore, "getProject" | "scanTestHistory" | "getTestSummary" | "getTestHistoryCoverage">,
  ) {}

  private project(projectId: string): void {
    if (!this.store.getProject(projectId)) throw new Error("Nie znaleziono projektu.");
  }
  private cursor(value: Cursor): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.cursorKey).update(payload).digest("base64url")}`;
  }
  private readCursor(token: string, filter: TestHistoryFilter): Cursor {
    try {
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw Error();
      const actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", this.cursorKey).update(payload).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Cursor;
      if (value.version !== 1 || value.scope !== scope(filter) || !value.before || !value.ceiling) throw Error();
      return value;
    } catch { throw new Error("Invalid verification history cursor."); }
  }

  list(input: unknown): TestHistoryPage {
    const { cursor, limit = 50, ...filter } = parseHistoryInput(testHistorySchema, input);
    this.project(filter.projectId);
    const c = cursor ? this.readCursor(cursor, filter) : undefined;
    const scan = this.store.scanTestHistory({ ...filter, before: c?.before, ceiling: c?.ceiling }, PAGE_SCAN_LIMIT, e => matches(e.summary, filter), limit);
    return {
      items: scan.items, nextCursor: scan.more && scan.last && scan.ceiling ? this.cursor({ version: 1, scope: scope(filter), before: scan.last, ceiling: scan.ceiling }) : null,
      order: ORDER, selection: { filter, scanned: scan.scanned, scanLimit: PAGE_SCAN_LIMIT, scanLimitReached: scan.more && scan.scanned === PAGE_SCAN_LIMIT, consistency: "live_keyset_not_snapshot" },
      coverage: this.store.getTestHistoryCoverage(filter.projectId),
    };
  }

  summary(input: unknown) {
    const { projectId, runId } = parseHistoryInput(testSummarySchema, input);
    this.project(projectId);
    const entry = this.store.getTestSummary(projectId, runId);
    if (!entry) throw new Error("Nie znaleziono uruchomienia testu.");
    return entry;
  }

  metrics(input: unknown): TestMetrics {
    const filter = parseHistoryInput(testMetricsSchema, input);
    this.project(filter.projectId);
    const scan = this.store.scanTestHistory(filter, METRIC_SCAN_LIMIT, e => matches(e.summary, filter), METRIC_SCAN_LIMIT);
    const processOutcomes: TestMetrics["processOutcomes"] = { passed: 0, failed: 0, cancelled: 0, timed_out: 0, interrupted: 0, unknown: 0 };
    const sourceAttributions: TestMetrics["sourceAttributions"] = { pending: 0, observed_match: 0, changed: 0, uncertain: 0, legacy_unknown: 0 };
    const populations = {} as TestMetrics["populations"];
    const groups = {} as Record<TestMetricPopulation, TestRunSummary[]>;
    for (const name of populationNames) {
      const summaries = scan.items.map(e => e.summary).filter(s => metricPopulation(s) === name);
      groups[name] = summaries;
      const statistics = {} as TestMetrics["populations"][TestMetricPopulation]["durations"];
      for (const key of durations) {
        const values = summaries.map(s => finiteDuration(s.telemetry.durations[key])).filter((v): v is number => v !== null).sort((a, b) => a - b);
        const n = values.length;
        statistics[key] = { medianMs: n ? values[Math.floor((n - 1) / 2)] / 2 + values[Math.floor(n / 2)] / 2 : null,
          p95Ms: n ? values[Math.ceil(0.95 * n) - 1] : null, valid: n, missing: summaries.length - n, denominator: summaries.length };
      }
      populations[name] = { count: summaries.length, durations: statistics };
    }
    for (const { summary: s } of scan.items) { processOutcomes[s.processOutcome ?? "unknown"]++; sourceAttributions[s.attribution]++; }
    return { selection: { filter, scanned: scan.scanned, scanLimit: METRIC_SCAN_LIMIT, truncated: scan.more, matched: scan.items.length, order: ORDER },
      processOutcomes, sourceAttributions, populations,
      method: { median: "sorted_midpoint_mean", p95: "nearest_rank_ceil_0.95_n", missing: "excluded_not_zero", population: "per_run_not_daily_percentiles" },
      resources: resourceMetrics(groups), coverage: this.store.getTestHistoryCoverage(filter.projectId) };
  }

  compare(input: unknown): TestRunComparison {
    const { projectId, leftRunId, rightRunId } = parseHistoryInput(testComparisonSchema, input);
    const left = this.summary({ projectId, runId: leftRunId }), right = this.summary({ projectId, runId: rightRunId });
    const a = left.summary, b = right.summary;
    const differences = { source: JSON.stringify(a.sourceIdentity) !== JSON.stringify(b.sourceIdentity), command: a.commandDigest !== b.commandDigest,
      profile: a.profileDigest !== b.profileDigest, preset: a.presetId !== b.presetId, worktree: a.worktreePath !== b.worktreePath };
    const caveats = ["Git identities do not prove identical files, environment, tools or external services; matching runs do not prove unnecessary duplication or flakiness.",
      "Profile digests identify policy selection, not environment values; process time includes unobserved runner wait."];
    if (Object.values(differences).some(Boolean)) caveats.push("Run identities differ; timing deltas are descriptive, not a controlled regression comparison.");
    if (a.attribution !== "observed_match" || b.attribution !== "observed_match" || !a.sourceIdentity.head || !b.sourceIdentity.head || !a.sourceIdentity.statusDigest || !b.sourceIdentity.statusDigest) caveats.push("Source observations are missing or do not qualify as observed_match.");
    const populations = { left: metricPopulation(a), right: metricPopulation(b) };
    if (populations.left !== "completed_execution" || populations.right !== "completed_execution") caveats.push("At least one run is censored, rejected, in progress or incompletely observed; do not compare as completed execution.");
    const timings = {} as TestRunComparison["timings"];
    for (const key of durations) {
      const leftMs = finiteDuration(a.telemetry.durations[key]), rightMs = finiteDuration(b.telemetry.durations[key]);
      timings[key] = { leftMs, rightMs, deltaMs: leftMs === null || rightMs === null ? null : rightMs - leftMs };
    }
    if (durations.some(k => timings[k].deltaMs === null)) caveats.push("Missing timing observations remain null; no duration is inferred from wall timestamps.");
    caveats.push("Resources are sampled peaks of summed RSS and observed per-generation CPU deltas (100% = one core), not complete job totals. Shared pages, missed processes/peaks and variable coverage limit comparisons. Partial, missing, incompatible-cadence and censored runs have null resource deltas.");
    return { left, right, differences, timings, populations, caveats,
      resources: compareResources(a, b, populations.left === "completed_execution" && populations.right === "completed_execution") };
  }
}
