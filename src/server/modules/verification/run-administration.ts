import { admitWithRetry, type DatabaseAdmission } from "@/server/database-admission";
import type { TestRun } from "@/shared/contracts";
import {
  administrativeStopAction, nextStep, resolveRun, type AdministrableTestJobs, type AdministrativeStopAction, type RunResolutionReason,
  type RunPersistenceState, type RunResolutionState, type TestRunOwnershipEvidence,
} from "./run-ownership";

/** The local OS account behind the owner-only admin socket, as seen by the controller itself. */
export interface AdministrativeOperator {
  kind: "local-admin-socket";
  uid: number | null;
  user: string | null;
}

export interface TestRunAdministrationAuditEntry {
  event: "test_run.admin_stop_requested" | "test_run.admin_stop_result";
  requestId: string;
  runId: string;
  projectId: string | null;
  operator: AdministrativeOperator;
  reason: string;
  action?: StopAction;
  outcome?: RunResolutionState;
  outcomeReason?: RunResolutionReason | "stop_request_failed";
  phaseBefore?: TestRun["phase"] | null;
  /** Live phase and cleanup held by the owner after the wait. */
  phaseAfter?: TestRun["phase"] | null;
  cleanupAfter?: string | null;
  /** The committed record after the wait and the state of the run's newest write. */
  durablePhaseAfter?: TestRun["phase"] | null;
  persistenceAfter?: RunPersistenceState | null;
}

export interface TestRunAdministrationRecord extends Omit<TestRunAdministrationAuditEntry, "operator"> {
  at: string;
  operator: AdministrativeOperator | null;
}

/** Append-only controller audit; written with the same single store connection. */
export interface TestRunAdministrationAudit {
  recordTestRunAdministration(entry: TestRunAdministrationAuditEntry): void;
  listTestRunAdministration(runId: string, limit: number): TestRunAdministrationRecord[];
}

const MAX_WAIT_MS = 120_000;
const POLL_MS = 100;
const MAX_POLL_MS = 500;
const AUDIT_READ_LIMIT = 10;

/** `undetermined`: the owner did not answer within the budget; its decision is logged when it does. */
export type StopAction = AdministrativeStopAction | "undetermined";

export interface TestRunInspection {
  version: 1;
  runId: string;
  found: boolean;
  run: RunProjection | null;
  ownership: OwnershipProjection | null;
  durableRecord: DurableProjection | null;
  resolution: { state: RunResolutionState; reason: RunResolutionReason; nextStep: string; stopEffect: AdministrativeStopAction };
  audit: TestRunAdministrationRecord[];
}

export interface TestRunStopResult {
  version: 1;
  requestId: string;
  runId: string;
  action: StopAction;
  outcome: RunResolutionState;
  reason: RunResolutionReason | "stop_request_failed";
  nextStep: string;
  waitedMs: number;
  before: { phase: TestRun["phase"]; cleanup: string | null } | null;
  /** Newest state held by the owner; see `durableRecord` for what is committed. */
  run: RunProjection | null;
  durableRecord: DurableProjection | null;
}

type RunProjection = ReturnType<typeof runProjection>;
type OwnershipProjection = ReturnType<typeof ownershipProjection>;
type DurableProjection = ReturnType<typeof durableProjection>;

export class TestRunAdministrationError extends Error {
  constructor(readonly code: "project_mismatch" | "maintenance", message: string) {
    super(message);
    this.name = "TestRunAdministrationError";
  }
}

export interface TestRunAdministrationDependencies {
  jobs: AdministrableTestJobs;
  audit: TestRunAdministrationAudit;
  admission: DatabaseAdmission;
  operator(): AdministrativeOperator;
  log?(event: string, details: Record<string, unknown>): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

/**
 * Protected local-operator inspection and stop of one exact test run. It is
 * reached only through the owner-only admin socket and never through the public
 * HTTP or MCP transports. It relies on the finite-job owner's live ownership
 * evidence: nothing is adopted, no saved PID is signalled, no record is rewritten
 * or removed, and queue capacity is released only by the owner's own finalization.
 */
export class TestRunAdministration {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly dependencies: TestRunAdministrationDependencies) {
    this.now = dependencies.now ?? (() => performance.now());
    this.sleep = dependencies.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }));
  }

  async inspect(input: { runId: string; projectId?: string }): Promise<TestRunInspection> {
    return this.dependencies.admission.run(() => {
      const evidence = this.dependencies.jobs.administrativeEvidence(input.runId);
      this.assertProject(evidence, input.projectId);
      return this.inspection(input.runId, evidence, this.dependencies.audit.listTestRunAdministration(input.runId, AUDIT_READ_LIMIT));
    });
  }

  async stop(input: { runId: string; projectId?: string; reason: string; waitMs: number; requestId: string }): Promise<TestRunStopResult> {
    const { jobs, audit, admission } = this.dependencies;
    const waitMs = Math.min(Math.max(0, Math.trunc(input.waitMs)), MAX_WAIT_MS);
    const operator = this.dependencies.operator();
    const started = this.now();
    const deadline = started + waitMs;
    const base = { requestId: input.requestId, runId: input.runId, operator, reason: input.reason };
    // The request is durable before any effect. A refused project binding has no effect and no audit.
    const before = await admission.run(() => {
      const evidence = jobs.administrativeEvidence(input.runId);
      this.assertProject(evidence, input.projectId);
      audit.recordTestRunAdministration({ ...base, event: "test_run.admin_stop_requested", projectId: evidence?.run.projectId ?? null,
        phaseBefore: evidence?.run.phase ?? null });
      return evidence;
    });
    let action: StopAction = "none";
    let failure: unknown = null;
    let latest: TestRunOwnershipEvidence | null = before;
    if (before) {
      // The owner decides and applies the effect in one admitted phase. A slow
      // finalization of a queued run must not hold this request past its budget.
      const effect = jobs.administrativeStop(input.runId);
      const settled = await this.within(effect, deadline);
      if (settled === "timeout") {
        action = "undetermined";
        void effect.then(
          value => this.dependencies.log?.("test_run.admin_stop_effect", { runId: input.runId, requestId: input.requestId, action: value.action }),
          error => this.dependencies.log?.("test_run.admin_stop_failed", { runId: input.runId, requestId: input.requestId, error: String(error) }),
        );
      } else if (settled.ok) {
        action = settled.value.action;
      } else {
        failure = settled.error;
      }
      latest = await this.evidence(input.runId);
      for (let delay = POLL_MS; !failure && resolveRun(latest).state === "pending" && this.now() < deadline; delay = Math.min(delay * 2, MAX_POLL_MS)) {
        await this.sleep(Math.min(delay, Math.max(1, deadline - this.now())));
        latest = await this.evidence(input.runId);
      }
    }
    const resolution = resolveRun(latest);
    const outcome: RunResolutionState = failure ? "unresolved" : resolution.state;
    const reason = failure ? "stop_request_failed" as const : resolution.reason;
    const result: TestRunStopResult = {
      version: 1,
      requestId: input.requestId,
      runId: input.runId,
      action,
      outcome,
      reason,
      nextStep: failure
        ? `The controller refused or failed the stop request (${failureMessage(failure)}). Inspect the run with 'worktree-control test-run inspect ${input.runId}' before retrying.`
        : nextStep(resolution.reason, input.runId),
      waitedMs: Math.max(0, Math.round(this.now() - started)),
      before: before ? { phase: before.run.phase, cleanup: before.run.telemetry?.cleanup ?? null } : null,
      run: latest ? runProjection(latest.run) : null,
      durableRecord: latest ? durableProjection(latest) : null,
    };
    await admitWithRetry(admission, () => audit.recordTestRunAdministration({
      ...base, event: "test_run.admin_stop_result", projectId: latest?.run.projectId ?? before?.run.projectId ?? null,
      action, outcome, outcomeReason: reason, phaseBefore: before?.run.phase ?? null,
      phaseAfter: latest?.run.phase ?? null, cleanupAfter: latest?.run.telemetry?.cleanup ?? null,
      durablePhaseAfter: latest?.durable?.phase ?? null, persistenceAfter: latest?.persistence ?? null,
    }), { reserved: true, deadlineMs: 10_000 });
    this.dependencies.log?.("test_run.admin_stop", { runId: input.runId, requestId: input.requestId, action, outcome, reason });
    return result;
  }

  private evidence(runId: string): Promise<TestRunOwnershipEvidence | null> {
    return admitWithRetry(this.dependencies.admission, () => this.dependencies.jobs.administrativeEvidence(runId), { reserved: true, deadlineMs: 10_000 });
  }

  private async within<T>(promise: Promise<T>, deadline: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | "timeout"> {
    const settled = promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    let timer: NodeJS.Timeout | undefined;
    // The decision is admitted synchronously or very soon; give it a short floor even with --wait-seconds 0.
    const remaining = Math.max(1_000, deadline - this.now());
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), remaining); timer.unref?.(); });
    try { return await Promise.race([settled, timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private assertProject(evidence: TestRunOwnershipEvidence | null, projectId: string | undefined): void {
    if (projectId !== undefined && evidence && evidence.run.projectId !== projectId) {
      throw new TestRunAdministrationError("project_mismatch", "The run does not belong to the specified project.");
    }
  }

  private inspection(runId: string, evidence: TestRunOwnershipEvidence | null, records: TestRunAdministrationRecord[]): TestRunInspection {
    const resolution = resolveRun(evidence);
    return {
      version: 1,
      runId,
      found: evidence !== null,
      run: evidence ? runProjection(evidence.run) : null,
      ownership: evidence ? ownershipProjection(evidence) : null,
      durableRecord: evidence ? durableProjection(evidence) : null,
      resolution: {
        ...resolution,
        nextStep: nextStep(resolution.reason, runId),
        // Mirrors the owner's decision; a real stop re-decides atomically.
        stopEffect: evidence ? administrativeStopAction(evidence) : "none",
      },
      audit: records,
    };
  }
}

const bounded = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit)}…` : value;

function failureMessage(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error), 300);
}

/** Coarse requester class only; raw actors can carry MCP session or principal identifiers. */
export function requesterKind(actor: string): "installation" | "human" | "agent" | "remote_worker" | "controller" | "other" {
  if (actor === "local-user") return "installation";
  if (actor.startsWith("human:")) return "human";
  if (actor.startsWith("agent:")) return "agent";
  if (actor.startsWith("remote-worker:")) return "remote_worker";
  if (actor.startsWith("worktree-control:")) return "controller";
  return "other";
}

/** Allowlisted run fields: no log tail, environment values, requester or session identifiers. */
function runProjection(run: TestRun) {
  const telemetry = run.telemetry;
  return {
    id: run.id,
    projectId: run.projectId,
    worktreePath: run.worktreePath,
    worktreeHead: run.worktreeHead,
    presetId: run.presetId,
    presetName: run.presetName,
    requesterKind: requesterKind(run.actor),
    phase: run.phase,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error === null ? null : bounded(run.error, 500),
    command: { executable: bounded(run.executable, 500), args: run.args.slice(0, 32).map(arg => bounded(arg, 500)), cwd: run.cwd },
    telemetry: telemetry ? {
      availability: telemetry.availability,
      termination: telemetry.termination,
      cleanup: telemetry.cleanup,
      spawnedAt: telemetry.spawnedAt,
      exitedAt: telemetry.exitedAt,
      stopRequestedAt: telemetry.stopRequestedAt,
      cleanupFinishedAt: telemetry.cleanupFinishedAt,
      finalizedAt: telemetry.finalizedAt,
      recoveredAt: telemetry.recoveredAt,
    } : null,
    source: {
      attribution: run.source.attribution,
      processOutcome: run.source.processOutcome,
      reasonCodes: run.source.reasonCodes.slice(0, 12),
    },
  };
}

/** What the store has committed for the run, apart from the owner's newest in-memory state. */
function durableProjection(evidence: TestRunOwnershipEvidence) {
  const durable = evidence.durable;
  return {
    write: evidence.persistence,
    phase: durable?.phase ?? null,
    cleanup: durable?.telemetry?.cleanup ?? null,
    finalizedAt: durable?.telemetry?.finalizedAt ?? null,
  };
}

function ownershipProjection(evidence: TestRunOwnershipEvidence) {
  return {
    processGroup: evidence.ownedProcess ? (evidence.ownedProcess.exited ? "owned_exited" : "owned_live") : "not_owned",
    stopping: evidence.ownedProcess?.stopping ?? false,
    preparing: evidence.preparing,
    preparationActive: evidence.preparationActive,
    preparationCleanupUnconfirmed: evidence.preparationCleanupUnconfirmed,
    finalizing: evidence.finalizing,
    queueClosed: evidence.queueClosed,
    admissionBlockReason: evidence.admissionBlockReason,
  } as const;
}
