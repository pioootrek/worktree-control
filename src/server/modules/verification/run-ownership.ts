import type { TestRun } from "@/shared/contracts";

/** What a protected administrator stop did; `none` and `join` add no effect of their own. */
export type AdministrativeStopAction = "cancel" | "cleanup_retry" | "join" | "none";

/**
 * State of this run's own newest write. `committed`: the store holds the newest
 * state. `pending`: a write is ordered behind database admission. `failed`: the
 * write was refused and remains staged only in memory (the queue is closed).
 */
export type RunPersistenceState = "committed" | "pending" | "failed";

/** Live ownership evidence of one run, as seen by the manager that may own it. */
export interface TestRunOwnershipEvidence {
  /**
   * Snapshot of the newest state this manager holds, including a write that is
   * still waiting or that failed. It describes live work and is never, alone,
   * proof of durable finalization.
   */
  run: TestRun;
  /** The record as last committed to the store: the only basis for `confirmed`. */
  durable: TestRun | null;
  persistence: RunPersistenceState;
  /** Present only for a process group this manager spawned itself in this controller lifetime. */
  ownedProcess: { exited: boolean; stopping: boolean; cancellationRequested: boolean; timedOut: boolean } | null;
  /** Holds a finite-queue slot for source preflight or remote preparation. */
  preparing: boolean;
  /** The admitted preparation flow is still running. */
  preparationActive: boolean;
  preparationCleanupUnconfirmed: boolean;
  /** Terminal persistence (disposal, settlement, log close) is in progress. */
  finalizing: boolean;
  queueClosed: boolean;
  admissionBlockReason: string | null;
}

/** The finite-job owner's protected administration port. */
export interface AdministrableTestJobs {
  /** Caller holds admission. */
  administrativeEvidence(runId: string): TestRunOwnershipEvidence | null;
  administrativeStop(runId: string): Promise<{ action: AdministrativeStopAction; before: TestRunOwnershipEvidence | null }>;
}

/**
 * Effect of an administrator stop for the evidence. A cancellation is only
 * requested where the existing owned cancellation path applies; a terminal,
 * recovered or unowned record never gets an effect.
 */
export function administrativeStopAction(evidence: TestRunOwnershipEvidence): AdministrativeStopAction {
  const { run, ownedProcess } = evidence;
  if (evidence.finalizing) return "join";
  if (run.phase === "queued") {
    if (evidence.preparationCleanupUnconfirmed) return "none";
    return run.telemetry?.stopRequestedAt ? "join" : "cancel";
  }
  if (cancelledPreparationPending(evidence)) return "join";
  if (ownedProcess?.stopping) return "join";
  if (run.phase !== "running" || !ownedProcess) return "none";
  // Exited or already stopping without an in-flight completion means an earlier
  // cleanup attempt failed: retry the same owned group without changing the cause.
  if (ownedProcess.exited || ownedProcess.cancellationRequested || ownedProcess.timedOut || run.telemetry?.cleanup === "failed") return "cleanup_retry";
  return "cancel";
}

export type RunResolutionState = "pending" | "confirmed" | "unresolved";

export type RunResolutionReason =
  | "queued" | "preparing" | "running" | "stop_in_progress" | "finalizing"
  | "finalized"
  | "process_cleanup_unconfirmed" | "preparation_cleanup_unconfirmed" | "workspace_cleanup_failed"
  | "finalization_not_durable"
  | "ownership_lost_after_restart" | "ownership_unknown" | "cleanup_evidence_unavailable"
  | "run_not_found";

export interface RunResolution {
  /**
   * `pending`: owned work or its cleanup is still in progress under this controller.
   * `confirmed`: terminal, cleanup confirmed (or provably not required) and finalization durable.
   * `unresolved`: this controller cannot prove quiescence; an operator decision is required.
   */
  state: RunResolutionState;
  reason: RunResolutionReason;
}

const TERMINAL = new Set<TestRun["phase"]>(["passed", "failed", "cancelled", "timed_out", "interrupted"]);

/** A cancelled local preflight still owns its slot until its observer returns. */
function cancelledPreparationPending(evidence: TestRunOwnershipEvidence): boolean {
  const { run } = evidence;
  return run.phase === "cancelled" && evidence.preparationActive && evidence.persistence !== "failed"
    && !evidence.preparationCleanupUnconfirmed && !run.telemetry?.recoveredAt && run.telemetry?.cleanup !== "failed"
    && run.error !== "workspace_cleanup_failed" && run.error !== "preparation_cleanup_unconfirmed";
}

/**
 * Release-safety of one run from durable and live evidence. Live state decides
 * whether work is still pending; only the committed record can confirm. A
 * terminal phase or finalization timestamp held in memory never confirms
 * cleanup, and a missing record is never evidence of quiescence.
 */
export function resolveRun(evidence: TestRunOwnershipEvidence | null): RunResolution {
  if (!evidence) return { state: "unresolved", reason: "run_not_found" };
  const { run, ownedProcess } = evidence;
  const telemetry = run.telemetry;
  if (evidence.finalizing) return { state: "pending", reason: "finalizing" };
  if (run.error === "workspace_cleanup_failed") return { state: "unresolved", reason: "workspace_cleanup_failed" };
  if (evidence.preparationCleanupUnconfirmed || run.error === "preparation_cleanup_unconfirmed") {
    return { state: "unresolved", reason: "preparation_cleanup_unconfirmed" };
  }
  if (run.phase === "queued") {
    if (telemetry?.stopRequestedAt) return { state: "pending", reason: "stop_in_progress" };
    return { state: "pending", reason: evidence.preparing ? "preparing" : "queued" };
  }
  if (run.phase === "running") {
    if (!ownedProcess) return { state: "unresolved", reason: "ownership_unknown" };
    if (ownedProcess.stopping) return { state: "pending", reason: "stop_in_progress" };
    if (telemetry?.cleanup === "failed") return { state: "unresolved", reason: "process_cleanup_unconfirmed" };
    if (ownedProcess.exited || ownedProcess.cancellationRequested || ownedProcess.timedOut) return { state: "pending", reason: "stop_in_progress" };
    return { state: "pending", reason: "running" };
  }
  if (!TERMINAL.has(run.phase)) return { state: "unresolved", reason: "cleanup_evidence_unavailable" };
  // Source qualification of an exited process runs before finalization begins.
  if (ownedProcess?.stopping) return { state: "pending", reason: "finalizing" };
  if (telemetry?.recoveredAt) return { state: "unresolved", reason: "ownership_lost_after_restart" };
  if (cancelledPreparationPending(evidence)) return { state: "pending", reason: "stop_in_progress" };
  // The terminal write is still ordered behind admission: the owner is finishing.
  if (evidence.persistence === "pending") return { state: "pending", reason: "finalizing" };
  // A failed terminal write leaves the state only in memory, and an owner that
  // still holds the group after finalization ended never released its slot.
  if (evidence.persistence === "failed" || ownedProcess) return { state: "unresolved", reason: "finalization_not_durable" };
  const durable = evidence.durable;
  if (!durable || durable.phase !== run.phase) return { state: "unresolved", reason: "finalization_not_durable" };
  const saved = durable.telemetry;
  if (saved?.recoveredAt) return { state: "unresolved", reason: "ownership_lost_after_restart" };
  if (!saved || saved.availability === "legacy_unknown" || !saved.finalizedAt) {
    return { state: "unresolved", reason: "cleanup_evidence_unavailable" };
  }
  if (saved.cleanup === "failed") return { state: "unresolved", reason: "process_cleanup_unconfirmed" };
  if (saved.cleanup === "confirmed") return { state: "confirmed", reason: "finalized" };
  if (saved.cleanup === "not_required" && !saved.spawnedAt) return { state: "confirmed", reason: "finalized" };
  return { state: "unresolved", reason: "cleanup_evidence_unavailable" };
}

/** Operator guidance for each reason; never contains secrets or requester identifiers. */
export function nextStep(reason: RunResolutionReason, runId: string): string {
  switch (reason) {
    case "queued":
    case "preparing":
    case "running":
      return `Run 'worktree-control test-run stop ${runId} --reason TEXT' to cancel it through the controller that owns it.`;
    case "stop_in_progress":
    case "finalizing":
      return `Cleanup is in progress under controller ownership; re-check with 'worktree-control test-run inspect ${runId}' or repeat the stop request.`;
    case "finalized":
      return "Nothing to do: cleanup is confirmed and the terminal state is durable.";
    case "process_cleanup_unconfirmed":
      return "The controller still owns this process group and keeps its queue slot. Repeat 'test-run stop' to retry cleanup; if it keeps failing, inspect the process group of the command shown and the controller log. Do not restart the controller to clear it.";
    case "preparation_cleanup_unconfirmed":
    case "workspace_cleanup_failed":
      return "Remote preparation or workspace disposal was not confirmed, so new test admission stays blocked. Reconcile the remote worker with its recovery procedure; this command neither disposes the workspace nor clears the block.";
    case "finalization_not_durable":
      return "The controller holds a terminal state for this run only in memory: writing it to the database failed, so finalization is not durable. The run keeps its queue slot and the test queue stays closed until the controller restarts (see test_run.persistence_failed in the controller log). This command does not retry the write, release the slot or signal anything. Check database health and free space before a planned restart; after it, recovery records the run as interrupted, not as finished.";
    case "ownership_lost_after_restart":
      return "The controller that started this run stopped before observing its cleanup. This controller never owned its process group and will not signal a saved PID. Check the host for processes of the command and working directory shown, and stop them manually only after verifying them.";
    case "ownership_unknown":
      return "The record says running, but this controller holds no owned process group for it. No process will be signalled; check the controller log before acting on the host.";
    case "cleanup_evidence_unavailable":
      return "The record lacks durable cleanup evidence (legacy or incomplete finalization). Treat any remaining process of the command shown as unverified and inspect the host manually.";
    case "run_not_found":
      return "No record has this exact run ID. A missing record is not evidence that no process remains: check the ID and the project's history; retention may have removed old records.";
  }
}
