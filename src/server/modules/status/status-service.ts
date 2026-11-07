import { createHash, randomBytes, randomUUID } from "node:crypto";

import { admitNowOrLater, admissionOf, type DatabaseAdmission } from "@/server/database-admission";
import type { ProcessManager, RuntimeStatusSummary } from "@/server/process-manager";
import type { StateStore, TestRunStatusRecord } from "@/server/state-store";
import type { Project, Reservation, ServerCapacityStatus, TestQueueStatus } from "@/shared/contracts";
import type { ScopedProjectStatus } from "@/shared/contracts/runtime-access";

const SAMPLE_MS = 1_000;
const DEFAULT_WAIT_MS = 10_000;
const MAX_WAIT_MS = 20_000;
const MAX_WAITERS = 128;
const MAX_SESSION_WAITERS = 4;
const MAX_TARGETS = 64;

export type OwnerRelation = "self" | "other" | "human";

export interface CompactEnvelope<T> {
  schemaVersion: 1;
  epoch: string;
  cursor: string;
  observedAt: string;
  retryAfterMs: number | null;
  status: T;
}

export interface CompactProjectStatus {
  projectId: string;
  name: string;
  port: number;
  selectedWorktreePath: string | null;
  runtimeWorktreePath: string | null;
  runtimePhase: RuntimeStatusSummary["phase"];
  runtimeStartedAt: string | null;
  failureCode: string | null;
  reservation: null | {
    id: string;
    kind: Reservation["kind"];
    worktreePath: string;
    expiresAt: string | null;
    ownerRelation: OwnerRelation;
    ownerLabel: string;
  };
  serverCapacity: Pick<ServerCapacityStatus, "enabled" | "limit" | "used" | "available">;
  testQueue: TestQueueStatus & { projectRunning: number; projectQueued: number };
}

export interface CompactTestStatus {
  runId: string;
  projectId: string;
  presetId: string;
  worktreePath: string;
  phase: TestRunStatusRecord["phase"];
  queuePosition: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  source: {
    queuedHead: string | null;
    preflightHead: string | null;
    finishHead: string | null;
    attribution: TestRunStatusRecord["source"]["attribution"];
    queueComparison: TestRunStatusRecord["source"]["queueComparison"];
    executionComparison: TestRunStatusRecord["source"]["executionComparison"];
    processOutcome: TestRunStatusRecord["source"]["processOutcome"];
    reasonCodes: string[];
  };
}

type Target = { kind: "project"; id: string } | { kind: "run"; id: string }
  | { kind: "scoped-project"; id: string; read: () => CompactEnvelope<ScopedProjectStatus> };
type AnyEnvelope = CompactEnvelope<CompactProjectStatus | CompactTestStatus | ScopedProjectStatus>;

interface Waiter {
  read: () => AnyEnvelope;
  sessionKey: string;
  initialCursor: string;
  resolve: (value: AnyEnvelope) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

interface TargetWaiters {
  target: Target;
  waiters: Set<Waiter>;
}

interface ProjectObservation {
  observedAt: string;
  project: Project;
  runtime: RuntimeStatusSummary;
  reservation: Reservation | null;
  capacity: ServerCapacityStatus;
  queue: TestQueueStatus;
  projectRunning: number;
  projectQueued: number;
}

export class StatusService {
  readonly epoch = randomUUID();
  private readonly ownerSalt = randomBytes(32);
  private readonly targets = new Map<string, TargetWaiters>();
  private readonly sessionCounts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private closed = false;
  private readonly admission: DatabaseAdmission;

  constructor(
    private readonly store: Pick<StateStore,
      "getProject" | "getEffectiveReservation" | "getTestRunStatus" | "countTestRuns" | "getTestQueueSettings"
    >,
    private readonly processes: Pick<ProcessManager, "statusSummary" | "logTail">,
    private readonly capacity: () => ServerCapacityStatus,
    private readonly queue: () => TestQueueStatus,
  ) {
    this.admission = admissionOf(store);
  }

  project(projectId: string, owner: string): CompactEnvelope<CompactProjectStatus> {
    return this.projectEnvelope(this.observeProject(projectId), owner);
  }

  /** The application supplies an authorized allowlist, never a raw snapshot. */
  scopedProject(status: ScopedProjectStatus, binding: string): CompactEnvelope<ScopedProjectStatus> {
    return this.envelope(`scoped-project:${status.id}:${binding}`, new Date().toISOString(), status, this.projectRetry(status.phase));
  }

  test(runId: string): CompactEnvelope<CompactTestStatus> {
    const observedAt = new Date().toISOString();
    const run = this.store.getTestRunStatus(runId);
    if (!run) throw new Error("STATUS_NOT_FOUND");
    const status: CompactTestStatus = {
      runId: run.id, projectId: run.projectId, presetId: run.presetId,
      worktreePath: run.worktreePath, phase: run.phase, queuePosition: run.queuePosition,
      queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      exitCode: run.exitCode, signal: run.signal,
      errorCode: run.error ? "test_error" : null,
      source: {
        queuedHead: run.source.enqueue?.head ?? run.worktreeHead,
        preflightHead: run.source.preflight?.head ?? null,
        finishHead: run.source.finish?.head ?? null,
        attribution: run.source.attribution,
        queueComparison: run.source.queueComparison,
        executionComparison: run.source.executionComparison,
        processOutcome: run.source.processOutcome,
        reasonCodes: run.source.reasonCodes.slice(0, 12),
      },
    };
    const terminal = ["passed", "failed", "cancelled", "timed_out", "interrupted"].includes(run.phase);
    return this.envelope(`run:${runId}`, observedAt, status, terminal ? null : 1_000);
  }

  logs(projectId: string, limit = 40) {
    if (!this.store.getProject(projectId)) throw new Error("STATUS_NOT_FOUND");
    const tail = this.processes.logTail(projectId, limit);
    let lines = tail.lines;
    let contentTruncated = false;
    const result = () => ({ projectId, lines, retainedLines: tail.retainedLines, truncated: tail.truncated || contentTruncated || lines.length < tail.lines.length });
    while (Buffer.byteLength(JSON.stringify(result()), "utf8") > 16 * 1024 && lines.length > 1) lines = lines.slice(1);
    if (Buffer.byteLength(JSON.stringify(result()), "utf8") > 16 * 1024) {
      const value = lines[0]!;
      let low = 0;
      let high = value.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        lines = [value.slice(0, middle)];
        if (Buffer.byteLength(JSON.stringify(result()), "utf8") <= 16 * 1024) low = middle;
        else high = middle - 1;
      }
      lines = [value.slice(0, low)];
      contentTruncated = lines[0]!.length < value.length;
    }
    return result();
  }

  /**
   * Long poll. The initial read and registration run in the caller's admitted
   * operation; the wait itself holds no admission. Timeout reads and sampling
   * are admitted independently.
   */
  async wait(target: Target, cursor: string, sessionKey: string, timeoutMs = DEFAULT_WAIT_MS, signal?: AbortSignal): Promise<{ changed: boolean; result?: AnyEnvelope; epoch: string; cursor: string; retryAfterMs: number; errorCode?: "status_wait_busy" }> {
    if (this.closed) throw new Error("STATUS_CLOSED");
    return this.admission.run(async () => {
      const outcome = await this.waitAdmitted(target, cursor, sessionKey, timeoutMs, signal);
      if (target.kind !== "scoped-project") return outcome;
      // idle() re-admits after sampling/timeout. Authority may have changed
      // while that admission was queued: never deliver the retained result.
      if (this.closed) throw new Error("STATUS_CLOSED");
      if (signal?.aborted) throw new Error("STATUS_WAIT_CANCELLED");
      const current = target.read();
      return { ...outcome, changed: current.cursor !== cursor,
        result: current.cursor !== cursor ? current : undefined,
        cursor: current.cursor, retryAfterMs: outcome.errorCode ? outcome.retryAfterMs : current.retryAfterMs ?? 2_000 };
    });
  }

  private waitAdmitted(target: Target, cursor: string, sessionKey: string, timeoutMs: number, signal?: AbortSignal): Promise<{ changed: boolean; result?: AnyEnvelope; epoch: string; cursor: string; retryAfterMs: number; errorCode?: "status_wait_busy" }> {
    if (signal?.aborted) throw new Error("STATUS_WAIT_CANCELLED");
    const current = this.read(target, sessionKey);
    if (current.cursor !== cursor) return Promise.resolve({ changed: true, result: current, epoch: this.epoch, cursor: current.cursor, retryAfterMs: current.retryAfterMs ?? 0 });
    if (this.waiterCount() >= MAX_WAITERS || (this.sessionCounts.get(sessionKey) ?? 0) >= MAX_SESSION_WAITERS) {
      return Promise.resolve({ changed: false, epoch: this.epoch, cursor: current.cursor, retryAfterMs: 2_000, errorCode: "status_wait_busy" as const });
    }
    const key = `${target.kind}:${target.id}`;
    if (!this.targets.has(key) && this.targets.size >= MAX_TARGETS) {
      return Promise.resolve({ changed: false, epoch: this.epoch, cursor: current.cursor, retryAfterMs: 2_000, errorCode: "status_wait_busy" as const });
    }
    const boundedTimeout = Math.max(1, Math.min(MAX_WAIT_MS, timeoutMs));
    const waiting = new Promise<{ changed: boolean; result?: AnyEnvelope; epoch: string; cursor: string; retryAfterMs: number }>((resolve, reject) => {
      const waiter: Waiter = {
        read: () => this.read(target, sessionKey),
        sessionKey, initialCursor: cursor, reject,
        resolve: (result) => resolve({ changed: true, result, epoch: this.epoch, cursor: result.cursor, retryAfterMs: result.retryAfterMs ?? 0 }),
        timer: setTimeout(() => {
          this.remove(key, waiter);
          // A timer is detached from the request that registered it.
          admitNowOrLater(this.admission, () => this.read(target, sessionKey), latest => {
            resolve({ changed: latest.cursor !== cursor, result: latest.cursor !== cursor ? latest : undefined,
              epoch: this.epoch, cursor: latest.cursor, retryAfterMs: latest.retryAfterMs ?? 2_000 });
          }, error => reject(error instanceof Error ? error : new Error(String(error))));
        }, boundedTimeout),
        signal,
      };
      waiter.timer.unref();
      waiter.abort = () => {
        if (signal?.aborted && !this.targets.get(key)?.waiters.has(waiter)) clearTimeout(waiter.timer);
        this.remove(key, waiter);
        reject(new Error("STATUS_WAIT_CANCELLED"));
      };
      if (signal?.aborted) return waiter.abort();
      signal?.addEventListener("abort", waiter.abort, { once: true });
      const group = this.targets.get(key) ?? { target, waiters: new Set<Waiter>() };
      group.waiters.add(waiter);
      this.targets.set(key, group);
      this.sessionCounts.set(sessionKey, (this.sessionCounts.get(sessionKey) ?? 0) + 1);
      this.ensureTimer();
      try {
        const rechecked = this.read(target, sessionKey);
        if (rechecked.cursor !== cursor) { this.remove(key, waiter); waiter.resolve(rechecked); }
      } catch (error) {
        this.remove(key, waiter);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return this.admission.idle(() => waiting);
  }

  diagnostics(sessionKey?: string) {
    if (sessionKey !== undefined) {
      const waiters = this.sessionCounts.get(sessionKey) ?? 0;
      return { waiters, waiterTimers: waiters };
    }
    const waiters = this.waiterCount();
    return { waiters, waiterTimers: waiters, targets: this.targets.size, samplerTimers: this.timer ? 1 : 0 };
  }

  close(): void {
    this.closed = true;
    for (const [key, group] of this.targets) for (const waiter of group.waiters) {
      this.remove(key, waiter);
      waiter.reject(new Error("STATUS_CLOSED"));
    }
  }

  cancelSession(sessionKey: string): void {
    for (const [key, group] of this.targets) for (const waiter of group.waiters) {
      if (waiter.sessionKey !== sessionKey) continue;
      this.remove(key, waiter);
      waiter.reject(new Error("STATUS_WAIT_CANCELLED"));
    }
  }

  private observeProject(projectId: string): ProjectObservation {
    const observedAt = new Date().toISOString();
    const project = this.store.getProject(projectId);
    if (!project) throw new Error("STATUS_NOT_FOUND");
    return {
      observedAt, project,
      runtime: this.processes.statusSummary(projectId),
      reservation: this.store.getEffectiveReservation(projectId, observedAt),
      capacity: this.capacity(), queue: this.queue(),
      projectRunning: this.store.countTestRuns(["running"], project.id),
      projectQueued: this.store.countTestRuns(["queued"], project.id),
    };
  }

  private projectEnvelope(observation: ProjectObservation, owner: string): CompactEnvelope<CompactProjectStatus> {
    const { project, runtime, reservation, capacity, queue } = observation;
    const status: CompactProjectStatus = {
      projectId: project.id, name: project.name.slice(0, 160), port: project.port,
      selectedWorktreePath: project.selectedWorktreePath, runtimeWorktreePath: runtime.worktreePath,
      runtimePhase: runtime.phase, runtimeStartedAt: runtime.startedAt, failureCode: runtime.failureCode,
      reservation: reservation ? {
        id: reservation.id, kind: reservation.kind, worktreePath: reservation.worktreePath,
        expiresAt: reservation.expiresAt,
        ownerRelation: reservation.kind === "human" ? "human" : reservation.owner === owner ? "self" : "other",
        ownerLabel: reservation.kind === "human" ? "human" : `agent-${createHash("sha256").update(this.ownerSalt).update(reservation.owner).digest("hex").slice(0, 10)}`,
      } : null,
      serverCapacity: { enabled: capacity.enabled, limit: capacity.limit, used: capacity.used, available: capacity.available },
      testQueue: { ...queue,
        projectRunning: observation.projectRunning, projectQueued: observation.projectQueued },
    };
    const meaningful = {
      ...status,
      serverCapacity: { enabled: status.serverCapacity.enabled, limit: status.serverCapacity.limit },
      testQueue: { limit: status.testQueue.limit, projectRunning: status.testQueue.projectRunning, projectQueued: status.testQueue.projectQueued },
    };
    return this.envelope(`project:${project.id}`, observation.observedAt, status, this.projectRetry(runtime.phase), meaningful);
  }

  private envelope<T>(target: string, observedAt: string, status: T, retryAfterMs: number | null, meaningful: unknown = status): CompactEnvelope<T> {
    const cursor = createHash("sha256").update(this.epoch).update(target).update(JSON.stringify(meaningful)).digest("base64url");
    return { schemaVersion: 1, epoch: this.epoch, cursor, observedAt, retryAfterMs, status };
  }

  private read(target: Target, owner: string): AnyEnvelope {
    if (target.kind === "scoped-project") return target.read();
    return target.kind === "project" ? this.project(target.id, owner) : this.test(target.id);
  }

  private projectRetry(phase: RuntimeStatusSummary["phase"]): number { return ["starting", "stopping"].includes(phase) ? 1_000 : 5_000; }
  private waiterCount(): number { let count = 0; for (const group of this.targets.values()) count += group.waiters.size; return count; }
  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }
  private sample(): void {
    if (this.sampling) return;
    this.sampling = true;
    // Each sampling pass is its own bounded admission. Contention skips this
    // pass; waiters keep waiting for the next one or their own timeout.
    const done = () => { this.sampling = false; };
    admitNowOrLater(this.admission, () => this.sampleAdmitted(), done, done);
  }

  private sampleAdmitted(): void {
    {
      for (const [key, group] of [...this.targets]) {
        let sharedProject: ProjectObservation | null = null;
        let sharedTest: AnyEnvelope | null = null;
        try {
          if (group.target.kind === "project") sharedProject = this.observeProject(group.target.id);
          else if (group.target.kind === "run") sharedTest = this.test(group.target.id);
        } catch (error) {
          for (const waiter of [...group.waiters]) {
            this.remove(key, waiter);
            waiter.reject(error instanceof Error ? error : new Error(String(error)));
          }
          continue;
        }
        for (const waiter of [...group.waiters]) {
          try {
            // Scoped readers authorize each waiter separately, including when
            // its visible status has not changed. No installation observation.
            const result = group.target.kind === "scoped-project" ? waiter.read()
              : sharedProject ? this.projectEnvelope(sharedProject, waiter.sessionKey) : sharedTest!;
            // Each waiter supplied the cursor represented by the group state at registration.
            // Resolve only when the caller-visible projection changed.
            if (result.cursor !== waiter.initialCursor) { this.remove(key, waiter); waiter.resolve(result); }
          } catch (error) { this.remove(key, waiter); waiter.reject(error instanceof Error ? error : new Error(String(error))); }
        }
      }
    }
  }
  private remove(key: string, waiter: Waiter): void {
    const group = this.targets.get(key);
    if (!group?.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    const count = (this.sessionCounts.get(waiter.sessionKey) ?? 1) - 1;
    if (count > 0) this.sessionCounts.set(waiter.sessionKey, count); else this.sessionCounts.delete(waiter.sessionKey);
    if (group.waiters.size === 0) this.targets.delete(key);
    if (this.targets.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

}
