import type { TestRun } from "@/shared/contracts";
import type { WebExportFailureCode, WebExportGeneration, WebExportStatus, WebExportWatcherState } from "@/shared/contracts/godot-web";

/** Consecutive superseded exports before automatic rebuilds pause (self-trigger guard). */
export const MAX_CONSECUTIVE_SUPERSEDED = 3;

export type SettlementDecision =
  | { kind: "publish" }
  | { kind: "superseded" }
  | { kind: "failed"; code: WebExportFailureCode; message: string }
  | { kind: "ignored" };

/**
 * State of one active Godot Web runtime: at most one export in flight and
 * at most one coalesced follow-up. A disposed session never publishes.
 */
export class WebExportSession {
  disposed = false;
  watcher: WebExportWatcherState = "stopped";
  current: WebExportGeneration | null = null;
  activeRunId: string | null = null;
  enqueueing = false;
  initializing = false;
  /** Set when a request arrives while an export is queued, running or being enqueued. */
  pending = false;
  manualPending = false;
  autoPaused = false;
  consecutiveSuperseded = 0;
  lastRunId: string | null = null;
  lastChangeAt: number | null = null;
  lastFailure: WebExportStatus["lastFailure"] = null;
  private settledWaiters: Array<() => void> = [];

  constructor(readonly projectId: string, readonly worktreePath: string, private readonly now: () => number = Date.now) {}

  get busy(): boolean { return this.initializing || this.enqueueing || this.activeRunId !== null; }

  /** Invalidate immediately; scheduling a replacement remains debounced. */
  sourceChanged(): void {
    if (!this.disposed) this.lastChangeAt = this.now();
  }

  /** Returns true when the caller should enqueue a new export now. */
  request(reason: "start" | "change" | "manual"): boolean {
    if (this.disposed) return false;
    if (reason === "change") this.sourceChanged();
    if (reason === "manual") { this.autoPaused = false; this.consecutiveSuperseded = 0; }
    if (reason === "change" && this.autoPaused) return false;
    if (this.busy) {
      this.pending = true;
      if (reason === "manual") this.manualPending = true;
      return false;
    }
    return true;
  }

  /** Classifies a settled export run. Source edits after process start supersede its output. */
  decide(run: TestRun): SettlementDecision {
    if (this.disposed || run.id !== this.activeRunId) return { kind: "ignored" };
    const startedAt = run.startedAt ? Date.parse(run.startedAt) : null;
    const changedDuring = this.lastChangeAt !== null && startedAt !== null && this.lastChangeAt >= startedAt;
    if (run.telemetry?.termination === "rejected") {
      return run.source.queueComparison === "changed"
        ? { kind: "superseded" }
        : { kind: "failed", code: "queue_rejected", message: "The export was rejected before start because its source could not be confirmed." };
    }
    const outcome = run.source.processOutcome ?? (run.phase === "passed" ? "passed" : run.phase === "running" || run.phase === "queued" ? null : run.phase);
    if (outcome === "cancelled") return { kind: "failed", code: "export_cancelled", message: "The export was cancelled." };
    if (outcome === "timed_out") return { kind: "failed", code: "export_timed_out", message: "The export exceeded its preset timeout." };
    if (outcome !== "passed") {
      return { kind: "failed", code: "export_failed", message: run.exitCode === null ? "The export command could not run; inspect its run log." : `The export command exited with code ${run.exitCode}.` };
    }
    // Process success is not clean-source verification; edits during the export invalidate its output.
    return changedDuring || run.source.executionComparison === "changed" ? { kind: "superseded" } : { kind: "publish" };
  }

  /** Predict the terminal pause while the run still owns settlement and public state. */
  willPause(decision: SettlementDecision): boolean {
    return decision.kind === "superseded" && this.consecutiveSuperseded + 1 >= MAX_CONSECUTIVE_SUPERSEDED && !this.manualPending;
  }

  /** Clears the in-flight run and reports whether one coalesced follow-up export should start. */
  finish(decision: SettlementDecision): boolean {
    const pause = this.willPause(decision);
    this.activeRunId = null;
    const manual = this.manualPending;
    this.manualPending = false;
    let rerun = this.pending;
    this.pending = false;
    if (decision.kind === "publish") { this.consecutiveSuperseded = 0; }
    if (decision.kind === "superseded") {
      this.consecutiveSuperseded += 1;
      rerun = true;
      if (pause) {
        this.autoPaused = true;
        rerun = false;
        this.lastFailure = {
          code: "superseded", runId: this.lastRunId, at: new Date(this.now()).toISOString(),
          message: `Sources changed during ${MAX_CONSECUTIVE_SUPERSEDED} consecutive exports. Automatic rebuilds are paused; check that the exporter does not write into watched paths, then rebuild.`,
        };
      }
    }
    for (const resolve of this.settledWaiters.splice(0)) resolve();
    return !this.disposed && (rerun || manual) && (!this.autoPaused || manual);
  }

  fail(code: WebExportFailureCode, message: string, runId: string | null): void {
    this.lastFailure = { code, message, runId, at: new Date(this.now()).toISOString() };
  }

  dispose(): void {
    this.disposed = true;
    if (!this.activeRunId) for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  /** Resolves once no export of this session remains in flight, or after the bound. */
  settled(timeoutMs: number): Promise<void> {
    if (!this.activeRunId) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.settledWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  status(runPhase: TestRun["phase"] | null): WebExportStatus {
    const active = this.busy;
    const failedLatest = this.lastFailure !== null && (!this.current || this.lastFailure.at >= this.current.publishedAt);
    const state: WebExportStatus["state"] = active ? (runPhase === "running" ? "building" : "queued")
      : failedLatest ? "failed" : this.current ? "ready" : "idle";
    const changedAfterPublish = this.lastChangeAt !== null && (!this.current || this.lastChangeAt > Date.parse(this.current.publishedAt));
    return {
      state,
      watcher: this.watcher,
      worktreePath: this.worktreePath,
      current: this.current,
      currentStale: this.current !== null && (active || changedAfterPublish),
      activeRunId: this.activeRunId,
      pendingRebuild: this.pending,
      lastRunId: this.lastRunId,
      lastChangeAt: this.lastChangeAt === null ? null : new Date(this.lastChangeAt).toISOString(),
      lastFailure: failedLatest ? this.lastFailure : null,
    };
  }
}
