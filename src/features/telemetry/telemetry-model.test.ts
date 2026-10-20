import { describe, expect, it } from "vitest";
import {
  activeFilterCount, caveatKey, chronologicalPair, currentCursor, DEFAULT_FILTERS, dominantPhase, filterQuery, firstPage, formatBytes, formatCpu,
  formatDuration, formatSignedBytes, formatSignedDuration, historyFilter, historyWindow, nextPage, phaseSegments, previousPage, relativeChange,
  resourceComparability, resourceStatus, resourceStatusCounts, runFacts, sampleSize, timingComparability, toggleSelection,
} from "./telemetry-model";
import { pilotComparison, pilotSummary } from "./telemetry-fixtures.test-support";

const anchor = Date.parse("2026-10-19T20:00:00.000Z");

describe("telemetry request bounds", () => {
  it("anchors a canonical window no longer than the server's 31-day limit", () => {
    expect(historyWindow("24h", anchor)).toEqual({ from: "2026-10-18T20:00:00.000Z", to: "2026-10-19T20:00:00.000Z" });
    const { from, to } = historyWindow("30d", anchor + 0.7);
    expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(31 * 86_400_000);
    expect(to).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("sends only set exact filters, never the project ID, and clamps page size", () => {
    const filter = historyFilter("17493a1a-8027-4c7d-81c4-b307541ac845", { ...DEFAULT_FILTERS, presetId: "node:typecheck", processOutcome: "unknown" }, anchor);
    const query = filterQuery(filter, { limit: 500, cursor: "abc.def" });
    expect([...query.keys()]).toEqual(["from", "to", "presetId", "processOutcome", "limit", "cursor"]);
    expect(query.get("limit")).toBe("50");
    expect(query.get("processOutcome")).toBe("unknown");
    expect(filterQuery(filter, { limit: 0, cursor: null }).get("limit")).toBe("1");
    expect(filterQuery(filter).has("limit")).toBe(false);
    expect(filterQuery({ ...filter, dirty: false }).get("dirty")).toBe("false");
    expect(activeFilterCount({ ...DEFAULT_FILTERS, presetId: "x", attribution: "changed" })).toBe(2);
  });

  it("revisits earlier pages by recorded cursor and ignores a missing next cursor", () => {
    let trail = firstPage();
    expect(currentCursor(trail)).toBeNull();
    expect(nextPage(trail, null)).toBe(trail);
    trail = nextPage(trail, "c1");
    trail = nextPage(trail, "c2");
    expect(currentCursor(trail)).toBe("c2");
    trail = previousPage(trail);
    expect(currentCursor(trail)).toBe("c1");
    trail = nextPage(trail, "c2b");
    expect(trail.cursors).toEqual([null, "c1", "c2b"]);
    expect(previousPage(firstPage())).toEqual(firstPage());
  });
});

describe("telemetry semantics", () => {
  it("keeps null and missing measurements distinct from zero", () => {
    expect(formatDuration(null, "en")).toBeNull();
    expect(formatDuration(Number.NaN, "en")).toBeNull();
    expect(formatDuration(-1, "en")).toBeNull();
    expect(formatDuration(0, "en")).toBe("0 ms");
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBe("0 B");
    expect(formatCpu(undefined, "en")).toBeNull();
    const legacy = pilotSummary({ telemetry: { ...pilotSummary().telemetry, resources: undefined } });
    expect(resourceStatus(legacy)).toBe("legacy_unknown");
  });

  it("formats the pilot's sampled peaks without inventing totals; CPU may exceed one core", () => {
    const summary = pilotSummary();
    expect(formatBytes(summary.telemetry.resources!.peakSampledRssBytes)).toBe("2.7 GiB");
    expect(formatCpu(summary.telemetry.resources!.peakSampledCpuPercent, "en")).toBe("191%");
    expect(formatDuration(summary.telemetry.durations.processMs, "en")).toBe("33.1 s");
    expect(formatDuration(16 * 60_000 + 13_000, "en")).toBe("16 min 13 s");
    expect(formatSignedDuration(-3214.38, "en")).toBe("−3.21 s");
    expect(formatSignedBytes(-1150906368)).toBe("−1.1 GiB");
  });

  it("separates command outcome from source attribution", () => {
    expect(runFacts(pilotSummary())).toMatchObject({ command: "passed", source: "observed_match", note: null, failed: false });
    const sourceFailed = runFacts(pilotSummary({ phase: "failed", attribution: "changed", sourceReasonCodes: ["source_changed_during_execution"] }));
    expect(sourceFailed).toMatchObject({ phase: "failed", command: "passed", source: "changed", note: "source_overrode_command", failed: true });
    expect(runFacts(pilotSummary({ phase: "failed" })).note).toBe("finalization_overrode_command");
    const rejected = pilotSummary({ phase: "failed", processOutcome: null, exitCode: null, telemetry: { ...pilotSummary().telemetry, spawnedAt: null, termination: "rejected" } });
    expect(runFacts(rejected)).toMatchObject({ command: "unknown", note: "command_not_started" });
    expect(runFacts(pilotSummary({ phase: "failed", processOutcome: "failed", exitCode: 1 })).note).toBeNull();
  });

  it("draws phase proportions only when every phase was measured", () => {
    const full = phaseSegments(pilotSummary());
    expect(full.complete).toBe(true);
    expect(full.segments.reduce((sum, segment) => sum + (segment.share ?? 0), 0)).toBeCloseTo(1);
    expect(dominantPhase(pilotSummary())).toBe("processMs");
    const durations = { ...pilotSummary().telemetry.durations, cleanupMs: null };
    const partial = phaseSegments(pilotSummary({ telemetry: { ...pilotSummary().telemetry, durations } }));
    expect(partial.complete).toBe(false);
    expect(partial.segments.every((segment) => segment.share === null)).toBe(true);
    expect(dominantPhase(pilotSummary({ telemetry: { ...pilotSummary().telemetry, durations } }))).toBeNull();
  });

  it("labels small samples and orders quality counts", () => {
    expect(sampleSize(0)).toBe("none");
    expect(sampleSize(2)).toBe("small");
    expect(sampleSize(5)).toBe("ok");
    const statistic = { median: 1, p95: 1, valid: 2, missing: 0, denominator: 2, sampleCount: 43, cpuIntervalCount: 41,
      statuses: { pending: 0, sampled: 0, partial: 2, unavailable: 0, unsupported: 0, legacy_unknown: 1 } };
    expect(resourceStatusCounts(statistic)).toEqual([["partial", 2], ["legacy_unknown", 1]]);
  });
});

describe("comparison", () => {
  it("keeps partial membership_changed deltas comparable per metric", () => {
    const comparison = pilotComparison();
    expect(resourceComparability(comparison.resources.rss)).toBe("comparable");
    expect(resourceComparability(comparison.resources.cpu)).toBe("comparable");
    // A counter gap excludes only CPU: RSS stays comparable.
    expect(resourceComparability({ ...comparison.resources.cpu, delta: null })).toBe("excluded");
    expect(resourceComparability({ ...comparison.resources.cpu, left: null, delta: null })).toBe("missing_left");
    expect(resourceComparability({ ...comparison.resources.cpu, left: null, right: null, delta: null })).toBe("missing_both");
    expect(timingComparability(comparison.timings.processMs)).toBe("comparable");
    expect(timingComparability({ leftMs: 1, rightMs: null, deltaMs: null })).toBe("missing_right");
  });

  it("computes relative change only from a measured nonzero baseline", () => {
    expect(relativeChange(100, -25)).toBe(-0.25);
    expect(relativeChange(0, 5)).toBeNull();
    expect(relativeChange(null, 5)).toBeNull();
    expect(relativeChange(10, null)).toBeNull();
  });

  it("maps known server caveats and leaves unknown text verbatim", () => {
    const [identity, profile, resources] = pilotComparison().caveats;
    expect([caveatKey(identity), caveatKey(profile), caveatKey(resources)]).toEqual(["identity", "profile", "resources"]);
    expect(caveatKey("Run identities differ; timing deltas are descriptive.")).toBe("differs");
    expect(caveatKey("A new server caveat")).toBeNull();
  });

  it("selects at most two runs and orders a pair earlier-first", () => {
    expect(toggleSelection([], "a")).toEqual(["a"]);
    expect(toggleSelection(["a", "b"], "c")).toEqual(["b", "c"]);
    expect(toggleSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(chronologicalPair([{ runId: "late", queuedAt: "2026-10-19T17:47:49.952Z" }, { runId: "early", queuedAt: "2026-10-19T17:46:38.204Z" }])).toEqual(["early", "late"]);
    expect(chronologicalPair([{ runId: "only", queuedAt: "2026-10-19T17:47:49.952Z" }])).toBeNull();
  });
});
