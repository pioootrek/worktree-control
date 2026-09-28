import { describe, expect, it } from "vitest";
import { dashboardFixture, testRunFixture } from "../../../tests/ui/dashboard-fixture";
import { executionResult, latestTestResults, testResults } from "./test-results-model";

describe("test result presentation", () => {
  it("separates successful execution from a failed queue assessment", () => {
    const run = testRunFixture({ phase: "failed" });
    expect(executionResult(run)).toBe("passed");
    expect(executionResult({ ...run, phase: "running" })).toBe("running");
    expect(executionResult({ ...run, source: { ...run.source, processOutcome: null } })).toBe("failed");
  });
  it("keeps project-qualified latest completed results and does not hide failures behind cancellation", () => {
    const data = dashboardFixture();
    const failed = testRunFixture({ id: "failed", phase: "failed", source: { ...testRunFixture().source, processOutcome: "failed" } });
    const passed = testRunFixture({ id: "passed", queuedAt: "2026-01-02T12:00:00Z" });
    data.projects[0].testRuns = [failed, passed, testRunFixture({ id: "cancel", phase: "cancelled", queuedAt: "2026-01-03T12:00:00Z", source: { ...failed.source, processOutcome: "cancelled" } })];
    const other = structuredClone(data.projects[0]); other.project.id = "other"; other.testRuns = [{ ...failed, id: "other-failure", projectId: "other" }];
    data.projects.push(other);
    const latest = latestTestResults(testResults(data.projects));
    expect(latest.map((r) => r.run.id)).toEqual(["passed", "other-failure"]);
    expect(latest.filter((r) => r.failed)).toHaveLength(1);
  });
  it("only calls source current with clean matching evidence and fresh metadata", () => {
    const snapshot = dashboardFixture().projects[0];
    const run = testRunFixture();
    run.source.attribution = "observed_match";
    const observation = { head: snapshot.worktrees[0].head, branch: "main", dirty: false, observedAt: run.finishedAt!,
      statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null };
    run.source.enqueue = { ...observation };
    run.source.preflight = { ...observation };
    run.source.finish = { ...observation };
    snapshot.testRuns = [run];
    expect(testResults([snapshot])[0].freshness).toBe("current");
    snapshot.worktrees[0].dirty = true;
    expect(testResults([snapshot])[0]).toMatchObject({ freshness: "unknown", reasons: ["current_dirty"] });
    snapshot.worktrees[0].dirty = false; snapshot.worktrees[0].head = "new-head";
    expect(testResults([snapshot])[0]).toMatchObject({ freshness: "older", reasons: ["head_changed"] });
    snapshot.worktrees[0].head = run.source.finish.head!; snapshot.metadata!.status = "stale";
    expect(testResults([snapshot])[0]).toMatchObject({ freshness: "unknown", reasons: ["metadata_stale"], sourceAtRun: "observed_match" });
    snapshot.metadata!.status = "fresh"; snapshot.worktrees[0].statusError = "git timeout";
    expect(testResults([snapshot])[0]).toMatchObject({ freshness: "unknown", reasons: ["status_error"] });
    delete snapshot.worktrees[0].statusError; run.source.finish!.complete = false;
    expect(testResults([snapshot])[0]).toMatchObject({ freshness: "unknown", reasons: ["incomplete_observation"] });
  });
  it("keeps queued and pre-start observations separate when a run never starts", () => {
    const snapshot = dashboardFixture().projects[0];
    const run = testRunFixture({ phase: "failed", startedAt: null, exitCode: null });
    run.source.attribution = "changed";
    run.source.processOutcome = null;
    run.source.preflight = { observedAt: run.finishedAt!, head: "other-head", branch: "main", dirty: false,
      statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null };
    snapshot.testRuns = [run];
    const row = testResults([snapshot])[0];
    expect(row).toMatchObject({ result: "failed", preflightHead: "other-head", freshness: "older", reasons: ["head_changed", "source_changed"] });
    expect(row.run.worktreeHead).not.toBe(row.preflightHead);
  });
  it("does not describe cancelled pre-start or legacy runs as pending forever", () => {
    const snapshot = dashboardFixture().projects[0];
    const cancelled = testRunFixture({ id: "cancelled", phase: "cancelled", startedAt: null, source: { ...testRunFixture().source, attribution: "pending", processOutcome: "cancelled" } });
    const legacy = testRunFixture({ id: "legacy", source: { ...testRunFixture().source, attribution: "legacy_unknown", processOutcome: null } });
    snapshot.testRuns = [cancelled, legacy];
    const rows = testResults([snapshot]);
    expect(rows.find((row) => row.run.id === "cancelled")).toMatchObject({ result: "cancelled", freshness: "unknown", sourceAtRun: "not_started", reasons: ["not_started"] });
    expect(rows.find((row) => row.run.id === "legacy")).toMatchObject({ result: "passed", freshness: "unknown", sourceAtRun: "legacy_unknown" });
    expect(rows.find((row) => row.run.id === "legacy")!.reasons).toContain("legacy_source");
  });
  it("shows both known local changes and missing current metadata without certifying freshness", () => {
    const snapshot = dashboardFixture().projects[0];
    const run = testRunFixture();
    run.source.attribution = "observed_match";
    const observation = { observedAt: run.finishedAt!, head: snapshot.worktrees[0].head, branch: "main", dirty: false,
      statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null };
    run.source.enqueue = { ...observation };
    run.source.preflight = { ...observation };
    run.source.finish = { ...observation };
    snapshot.worktrees[0].dirty = true;
    delete snapshot.metadata;
    snapshot.testRuns = [run];
    expect(testResults([snapshot])[0]).toMatchObject({ freshness: "unknown", reasons: ["current_dirty", "metadata_missing"] });
    snapshot.worktrees = [];
    expect(testResults([snapshot])[0].reasons).toContain("missing_worktree");
  });
});
