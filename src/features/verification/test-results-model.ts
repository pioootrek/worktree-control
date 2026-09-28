import type { ProjectSnapshot, TestRun } from "@/shared/contracts";

export type FreshnessReason = "not_started" | "source_changed" | "source_uncertain" | "legacy_source" | "source_pending"
  | "missing_observation" | "incomplete_observation" | "observed_dirty" | "missing_worktree" | "status_error"
  | "current_dirty" | "missing_head" | "metadata_missing" | "metadata_stale" | "metadata_refreshing" | "metadata_unavailable" | "head_changed";

export function executionResult(run: TestRun) {
  return run.phase === "queued" || run.phase === "running" ? run.phase : run.source.processOutcome ?? run.phase;
}

export function testResults(snapshots: ProjectSnapshot[]) {
  return snapshots.flatMap((snapshot) => snapshot.testRuns.map((run) => {
    const result = executionResult(run);
    const active = result === "queued" || result === "running";
    const worktree = snapshot.worktrees.find((w) => w.path === run.worktreePath);
    const observed = run.source.finish ?? run.source.preflight;
    const current = !active && run.source.attribution === "observed_match" && observed?.complete && observed.dirty === false
      && observed.head === worktree?.head && worktree?.dirty === false && !worktree.statusError && snapshot.metadata?.status === "fresh";
    const freshness: "pending" | "current" | "older" | "unknown" = active ? "pending" : current ? "current"
      : observed?.head && worktree?.head && observed.head !== worktree.head ? "older" : "unknown";
    const reasons: FreshnessReason[] = [];
    const add = (condition: boolean, reason: FreshnessReason) => { if (condition) reasons.push(reason); };
    if (!active && !current && !run.startedAt && run.source.attribution === "pending") {
      reasons.push("not_started");
    } else if (!active && !current) {
      add(freshness === "older", "head_changed");
      add(run.source.attribution === "changed", "source_changed");
      add(run.source.attribution === "legacy_unknown", "legacy_source");
      add(run.source.attribution === "uncertain", "source_uncertain");
      add(run.source.attribution === "pending" && !!run.startedAt, "source_pending");
      add(!!run.startedAt && (!run.source.preflight || !run.source.finish), "missing_observation");
      add([run.source.enqueue, run.source.preflight, run.source.finish].some((sample) => !!sample && !sample.complete), "incomplete_observation");
      add([run.source.enqueue, run.source.preflight, run.source.finish].some((sample) => sample?.dirty === true), "observed_dirty");
      add(!worktree, "missing_worktree");
      add(!!worktree?.statusError, "status_error");
      add(worktree?.dirty === true, "current_dirty");
      add(!!worktree && !worktree.head || !!observed && !observed.head, "missing_head");
      add(!snapshot.metadata, "metadata_missing");
      add(snapshot.metadata?.status === "stale", "metadata_stale");
      add(snapshot.metadata?.status === "refreshing", "metadata_refreshing");
      add(snapshot.metadata?.status === "unavailable", "metadata_unavailable");
    }
    return { snapshot, run, result, active, freshness, reasons, observed, worktree,
      sourceAtRun: !active && run.source.attribution === "pending" ? run.startedAt ? "unfinished" : "not_started" : run.source.attribution,
      preflightHead: run.source.preflight?.head ?? null,
      failed: ["failed", "timed_out", "interrupted"].includes(result) };
  })).sort((a, b) => Date.parse(b.run.queuedAt) - Date.parse(a.run.queuedAt) || b.run.id.localeCompare(a.run.id));
}
export type TestResult = ReturnType<typeof testResults>[number];

/** Latest completed, non-cancelled run per project/worktree/preset. */
export function latestTestResults(rows: TestResult[]) {
  const latest = new Map<string, TestResult>();
  for (const row of rows) {
    if (row.active || row.result === "cancelled") continue;
    const key = JSON.stringify([row.snapshot.project.id, row.run.worktreePath, row.run.presetId]);
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()];
}

export function testDuration(run: TestRun, now: number) {
  if (!run.startedAt) return "—";
  const seconds = Math.max(0, Math.floor(((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
