import { AuthenticationProviderError } from "./modules/authentication";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import type { TestQueueStatus, TestRun } from "@/shared/contracts";
import type { LogWriter } from "./log-writer";
import type { StateStore, VerificationRequester } from "./state-store";
import { admissionOf, admitWithRetry, type DatabaseAdmission } from "./database-admission";

import { OwnedProcessGroup } from "./owned-process-group";
import { emptyTelemetry, emptyRunResources, resourceReason, observeRunResources, TEST_RESOURCE_INTERVAL_MS, type RunResourceObservation, type RunResourceOptions, RunTelemetryRecorder, verificationClock, PreparationSession, PreparationError, type VerificationClock, type EnqueueTestInput } from "./modules/verification";
import { compareSource, legacySourceEvidence, pendingSourceEvidence, qualifySource, type TestSourceObserver } from "./test-source-attribution";

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_LENGTH = 2_000;
const MAX_QUEUED_RUNS = 100;
const LOG_PERSISTENCE_INTERVAL_MS = 250;
const PROCESS_GROUP_CLEANUP_ATTEMPTS = 3;
const PROCESS_GROUP_CLEANUP_RETRY_MS = 100;
const OUTPUT_CLOSE_GRACE_MS = 1_000;

interface ActiveRun {
  child: ChildProcess;
  resources: RunResourceObservation | null;
  group: OwnedProcessGroup;
  closed: Promise<void>;
  completion: Promise<void> | null;
  executionError: string | null;
  exited: boolean;
  run: TestRun;
  timeout: NodeJS.Timeout;
  /** Settles once spawn evidence (and any preparation `started` record) is durable. */
  started: Promise<void> | null;
  cancellationRequested: boolean;
  timedOut: boolean;
  worktreePath: string;
}

export type { EnqueueTestInput } from "./modules/verification";

/**
 * At most one outstanding durable write per run. A newer state replaces an
 * unwritten older one (log and resource snapshots coalesce); writes for one run
 * never reorder, and readers see the newest state before it is durable.
 */
interface RunWrite { latest: TestRun; dirty: boolean; chain: Promise<void> | null }

export class TestJobManager {
  private readonly telemetry: RunTelemetryRecorder;
  private readonly summaryMaintenance: NodeJS.Timeout;
  private persistenceFailure: unknown = null;
  private readonly active = new Map<string, ActiveRun>();
  private readonly finalizations = new Map<string, Promise<void>>();
  private readonly preparing = new Set<string>();
  private readonly preparationPromises = new Map<string, Promise<void>>();
  private readonly preparations = new Map<string, NonNullable<EnqueueTestInput["preparation"]>>();
  private readonly preparationSessions = new Map<string, PreparationSession>();
  private readonly observers = new Map<string, TestSourceObserver>();
  private readonly settlements = new Map<string, NonNullable<EnqueueTestInput["settle"]>>();
  private pathAdmission: (paths: string[]) => void = () => undefined;
  private requesterAuthorizer: ((run: TestRun, requester: VerificationRequester) => void) | null = null;
  private sourceObserver: TestSourceObserver | null = null;
  private logMaintenance: Promise<void> = Promise.resolve();
  private pruneOperation: Promise<void> | null = null;
  private pumping = false;
  private closed = false;
  private admissionBlock: string | null = null;
  private outputNotification: NodeJS.Timeout | null = null;
  private readonly outputProjects = new Set<string>();
  private readonly logPersistence = new Map<string, NodeJS.Timeout>();
  private readonly writes = new Map<string, RunWrite>();
  private readonly admission: DatabaseAdmission;

  constructor(
    private readonly store: StateStore,
    private readonly logs: LogWriter,
    private readonly onChange: (projectId?: string) => void = () => undefined,
    private readonly clock: VerificationClock = verificationClock,
    private readonly resourceOptions: RunResourceOptions = {},
  ) {
    this.telemetry = new RunTelemetryRecorder(clock);
    this.admission = admissionOf(store);
    // Bootstrap work: callers using strict admission construct the manager inside an admitted operation.
    this.store.markInterruptedTestRuns();
    this.pruneSummaries();
    this.summaryMaintenance = setInterval(() => this.pruneSummaries(), 60_000);
    this.summaryMaintenance.unref();
    void this.pruneLogs();
  }

  /** Fail closed after unconfirmed remote process recovery; only an explicit future reconciliation may release it. */
  blockAdmission(reason: string): void {
    this.admissionBlock ??= reason;
    this.logs.controller("test_queue.admission_blocked", { reason: this.admissionBlock });
  }

  /** Installation recovery exclusions apply at enqueue and again before work. */
  configurePathAdmission(check: (paths: string[]) => void): void { this.pathAdmission = check; }

  configureRequesterAuthorizer(authorize: (run: TestRun, requester: VerificationRequester) => void): void {
    if (this.requesterAuthorizer) throw new Error("Test requester authorizer is already configured.");
    this.requesterAuthorizer = authorize;
  }

  revalidateRequester(runId: string): void { this.authorizeRequester(this.requireRun(runId)); }

  private authorizeRequester(run: TestRun): void {
    const requester = this.store.getHumanTestRunRequester?.(run.id) ?? this.store.getTestRunRequester(run.id);
    if (!requester) {
      if (run.actor.startsWith("human:test:")) throw new Error("Human test attribution is unavailable.");
      return; // Historical/installation and remote execution retain their existing policy.
    }
    if (!this.requesterAuthorizer) throw new Error("Scoped test authorization is unavailable.");
    this.requesterAuthorizer(run, requester);
  }

  configureSourceObserver(observer: TestSourceObserver): void {
    this.sourceObserver = observer;
  }

  replay(actor: string, idempotencyKey: string, projectId: string, worktreePath: string, presetId: string): TestRun | null {
    const repeated = this.store.findTestRunByIdempotency(actor, idempotencyKey);
    if (!repeated) return null;
    if (repeated.projectId !== projectId || repeated.worktreePath !== worktreePath || repeated.presetId !== presetId) {
      throw new Error("Klucz idempotencji jest już używany przez inne uruchomienie testu.");
    }
    this.authorizeRequester(repeated);
    return repeated;
  }

  status(): TestQueueStatus {
    const settings = this.store.getTestQueueSettings();
    const queuedPreparations = [...this.preparing].filter(id => this.read(id)?.phase === "queued").length;
    return {
      ...settings,
      ...(this.admissionBlock ? { admissionBlockReason: this.admissionBlock } : {}),
      running: this.active.size + this.preparing.size,
      queued: Math.max(0, this.store.countTestRuns(["queued"]) - queuedPreparations),
    };
  }

  setLimit(limit: number): TestQueueStatus {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("Limit równoległych testów musi być liczbą całkowitą od 1 do 16.");
    this.store.setTestQueueSettings({ limit });
    this.pump();
    this.onChange();
    return this.status();
  }

  enqueue(input: EnqueueTestInput): TestRun {
    if (this.closed) throw new Error("Kolejka testów jest zamknięta.");
    if (this.admissionBlock) throw new Error(this.admissionBlock);
    this.pathAdmission([input.worktree.path, input.command.cwd]);
    const preparationTimeout = input.preparation?.timeoutMs;
    if (preparationTimeout !== undefined && (!Number.isInteger(preparationTimeout) || preparationTimeout < 1 || preparationTimeout > 30 * 60_000)) throw new Error("invalid_preparation_timeout");
    if (input.idempotencyKey) {
      const repeated = this.replay(input.actor, input.idempotencyKey, input.projectId, input.worktree.path, input.command.preset.id);
      if (repeated) return repeated;
    }
    if (input.runId && this.store.hasTestRun(input.runId)) throw new Error("Execution identity is already accepted.");
    if (this.store.countTestRuns(["queued"]) >= MAX_QUEUED_RUNS) {
      throw new Error(`Kolejka testów może zawierać najwyżej ${MAX_QUEUED_RUNS} oczekujących zadań.`);
    }
    const run: TestRun = {
      id: input.runId ?? randomUUID(),
      projectId: input.projectId,
      worktreePath: input.worktree.path,
      worktreeHead: input.worktree.head,
      worktreeBranch: input.worktree.branch,
      worktreeDirty: input.worktree.dirty,
      presetId: input.command.preset.id,
      presetName: input.command.preset.name,
      adapter: input.command.preset.adapter,
      actor: input.actor,
      phase: "queued",
      queuePosition: null,
      executable: input.command.executable,
      args: input.command.args,
      cwd: input.command.cwd,
      queuedAt: this.clock.wallNow(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      logs: [],
      environmentMode: input.environment.mode,
      environmentProfile: input.environment.profile,
      inheritedServerProfile: input.environment.inheritedServerProfile,
      environmentVariableNames: input.environment.variableNames,
      telemetry: { ...emptyTelemetry("observed"), resources: emptyRunResources("pending", this.resourceOptions.intervalMs ?? TEST_RESOURCE_INTERVAL_MS) },
      source: input.sourceObservation ? pendingSourceEvidence(input.sourceObservation) : legacySourceEvidence(),
    };
    this.telemetry.mark(run, "queuedAt");
    try { this.store.saveTestRun(run, input.idempotencyKey, input.requester); }
    catch (error) { this.telemetry.forget(run.id); throw error; }
    this.environments.set(run.id, input.environment.environment);
    if (input.preparation) this.preparations.set(run.id, input.preparation);
    if (input.observe) this.observers.set(run.id, input.observe);
    if (input.settle) this.settlements.set(run.id, input.settle);
    this.timeouts.set(run.id, input.command.preset.timeoutMs);
    this.logs.openTest(run.id);
    this.write(run, `$ ${run.executable} ${run.args.join(" ")}`);
    this.persistNow(run);
    this.pump();
    this.onChange(run.projectId);
    return this.requireRun(run.id);
  }

  /** Admitted as one operation; waits for other finalization without holding admission. */
  cancel(runId: string, actor: string, revalidate?: () => void): Promise<TestRun> {
    return this.admission.run(() => { revalidate?.(); return this.cancelAdmitted(runId, actor); });
  }

  private async cancelAdmitted(runId: string, actor: string): Promise<TestRun> {
    const persisted = this.requireRun(runId);
    const active = this.active.get(runId);
    const run = active?.run ?? persisted;
    if (actor !== "local-user" && run.actor !== actor) throw new Error("Tylko autor testu może go anulować.");
    const session = this.preparationSessions.get(runId);
    if (run.phase === "queued" && session) {
      session.cancel();
      // The abort listener updates the live preparation record, not this persisted snapshot.
      return this.requireRun(runId);
    }
    if (run.phase === "queued") {
      run.telemetry ??= emptyTelemetry();
      run.telemetry.termination = "cancel";
      run.telemetry.cleanup = "not_required";
      this.telemetry.mark(run, "stopRequestedAt");
      run.phase = "cancelled";
      run.finishedAt = this.clock.wallNow();
      const preparation = this.preparationPromises.get(run.id);
      if (preparation) {
        this.persistNow(run);
        this.onChange(run.projectId);
      } else {
        await this.admission.idle(() => this.finish(run));
      }
      return this.read(run.id) ?? run;
    }
    if (!active || run.phase !== "running") return run;
    // A timeout that already initiated teardown remains the stop cause, even
    // when cancellation or shutdown arrives before the process exits.
    if (!active.exited && !active.timedOut) {
      active.cancellationRequested = true;
      active.run.telemetry!.termination = "cancel";
      this.telemetry.mark(active.run, "stopRequestedAt");
      this.checkpoint(active.run);
    }
    void this.complete(active);
    if (this.persistenceFailure) throw this.persistenceFailure;
    this.onChange(run.projectId);
    return run;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.summaryMaintenance);
    if (this.outputNotification) clearTimeout(this.outputNotification);
    this.outputNotification = null;
    try {
      // Cancellation is requested synchronously when admission is free, before any exit can race it.
      const listed = this.admission.tryRun(() => this.store.listPendingTestRuns());
      const unfinished = listed.ran ? listed.value : await admitWithRetry(this.admission, () => this.store.listPendingTestRuns(), { reserved: true });
      const cancellations = await Promise.allSettled(unfinished.map((run) => this.cancel(run.id, "local-user")));
      await Promise.allSettled(this.preparationPromises.values());
      await Promise.all([...this.active.values()].map((active) => this.complete(active)));
      await Promise.all(this.finalizations.values());
      await this.logMaintenance;
      if ((this.active.size || this.preparing.size) && !this.persistenceFailure) throw new Error("Nie potwierdzono zakończenia wszystkich grup procesów testowych.");
      const failures = cancellations.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "Nie zakończono poprawnie anulowania zadań testowych.");
      if (this.persistenceFailure) throw this.persistenceFailure;
    } catch (error) {
      const isFence=(failure:unknown,depth=0):boolean=>depth<4 && (failure instanceof AuthenticationProviderError
        ? failure.code.startsWith("security_fence_") : failure instanceof AggregateError && failure.errors.slice(0,128).some(value=>isFence(value,depth+1)));
      if(!isFence(error))throw error;
      // Loss of SQLite/fence authority must never prevent termination of process
      // groups already verified and owned by this manager. No requester is
      // reauthenticated and no new job is adopted from the restored database.
      for (const session of this.preparationSessions.values()) session.cancel();
      const stopped=await Promise.allSettled([...this.active.values()].map(async active=>{
        active.cancellationRequested=true;
        clearTimeout(active.timeout);
        await this.stopWithRetries(active.group);
        active.resources?.stop();
      }));
      const failures=stopped.filter(result=>result.status==="rejected").map(result=>result.reason);
      if(failures.length)throw new AggregateError([error,...failures],`${error instanceof Error?error.message:"Security fence refusal"}; owned process cleanup remains unconfirmed.`);
      throw error;
    } finally {
      // Even failed shutdown closes observation before ControlService closes the
      // store. Process ownership/occupied slots remain intact for cleanup retry.
      for (const active of this.active.values()) {
        active.resources?.stop();
        const resources = active.run.telemetry?.resources;
        if (resources && !active.run.telemetry?.finalizedAt
          && resources.status !== "legacy_unknown" && resources.status !== "unsupported") {
          resourceReason(resources, "controller_interrupted");
          resources.status = resources.sampleCount ? "partial" : "unavailable";
        }
        this.checkpoint(active.run);
      }
      // Accepted checkpoints settle before the owner may close the store.
      await Promise.allSettled([...this.writes.values()].map(write => write.chain));
    }
  }

  private readonly environments = new Map<string, Record<string, string>>();
  private readonly timeouts = new Map<string, number>();

  private pump(): void {
    if (this.pumping || this.closed || this.admissionBlock) return;
    this.pumping = true;
    queueMicrotask(() => {
      // A fresh admission, never one inherited from whoever requested the pump.
      void admitWithRetry(this.admission, () => this.pumpAdmitted(), { reserved: true }).catch(error => {
        this.pumping = false;
        this.persistenceFailure ??= error;
        this.closed = true;
        this.logs.controller("test_queue.persistence_failed", { error: String(error) });
      });
    });
  }

  private pumpAdmitted(): void {
    try {
      if (this.closed || this.admissionBlock) return;
      const limit = this.store.getTestQueueSettings().limit;
      const queued = this.queuedRuns();
      const occupiedWorktrees = new Set([...this.active.values()].map(({ worktreePath }) => worktreePath));
      for (const id of this.preparing) occupiedWorktrees.add(this.requireRun(id).worktreePath);
      while (this.active.size + this.preparing.size < limit) {
        const next = queued.find(({ worktreePath }) => !occupiedWorktrees.has(worktreePath));
        if (!next) break;
        queued.splice(queued.indexOf(next), 1);
        occupiedWorktrees.add(next.worktreePath);
        const run = this.requireRun(next.id);
        this.preparing.add(run.id);
        this.telemetry.mark(run, "admittedAt");
        this.persistNow(run);
        // Preparation is a background flow; it must never inherit (or suspend) this pump's admission.
        const preparation = this.admission.outside(() => this.prepare(run));
        this.preparationPromises.set(run.id, preparation);
        void preparation.finally(() => this.preparationPromises.delete(run.id)).catch(error => this.recordPersistenceFailure(run, error));
      }
      this.updateQueuePositions();
    } catch (error) {
      this.persistenceFailure ??= error;
      this.closed = true;
      this.logs.controller("test_queue.persistence_failed", { error: String(error) });
    } finally {
      this.pumping = false;
    }
  }

  /** Queued runs in queue order, as seen with not yet durable state applied. */
  private queuedRuns() {
    return this.store.listPendingTestRuns()
      .map(row => { const write = this.writes.get(row.id); return write?.dirty ? write.latest : row; })
      .filter(({ id, phase }) => phase === "queued" && !this.finalizations.has(id))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
  }

  private async prepare(run: TestRun): Promise<void> {
    const preparation = this.preparations.get(run.id);
    const session = preparation ? new PreparationSession(preparation.timeoutMs ?? 10 * 60_000) : null;
    if (session) this.preparationSessions.set(run.id, session);
    const preparationStopped = () => {
      if (run.phase !== "queued") return;
      run.telemetry!.termination = session!.signal.reason?.code === "preparation_timeout" ? "timeout" : "cancel";
      run.telemetry!.cleanup = "pending";
      this.telemetry.mark(run, "stopRequestedAt");
      this.telemetry.mark(run, "cleanupStartedAt");
      this.checkpoint(run);
      this.onChange(run.projectId);
    };
    session?.signal.addEventListener("abort", preparationStopped, { once: true });
    try {
      await this.admission.run(() => { this.authorizeRequester(run); this.pathAdmission([run.worktreePath, run.cwd]); });
      if (preparation) {
        const input = await preparation.prepare(session!);
        session!.throwIfAborted();
        if (this.closed || (await this.current(run.id))?.phase !== "queued") return;
        run.executable = input.command.executable;
        run.args = input.command.args;
        run.cwd = input.command.cwd;
        run.worktreeHead = input.worktree.head;
        run.environmentVariableNames = input.environment.variableNames;
        run.source = pendingSourceEvidence(input.sourceObservation);
        this.environments.set(run.id, input.environment.environment);
        this.timeouts.set(run.id, input.command.preset.timeoutMs);
      }
      const observer = preparation?.observe ?? this.observers.get(run.id) ?? this.sourceObserver;
      if (!observer || !run.source.enqueue) {
        if (!preparation) this.preparing.delete(run.id);
        await this.admission.run(() => this.start(run));
        return;
      }
      run.source.preflight = await observer(run, "preflight");
      session?.throwIfAborted();
      run.source.queueComparison = compareSource(run.source.enqueue, run.source.preflight);
      const checkpoint = await this.admission.run(() => {
        // A cancellation can be admitted immediately after this callback. Never
        // split reading the phase from persisting the preflight checkpoint.
        if (this.closed || this.read(run.id)?.phase !== "queued") return false;
        if (run.source.queueComparison !== "match") {
          run.source = qualifySource(run.source);
          this.telemetry.mark(run, "prepareFinishedAt");
          run.telemetry!.termination = "rejected";
          run.telemetry!.cleanup = "not_required";
          run.phase = "failed";
          run.finishedAt = this.clock.wallNow();
          run.error = run.source.queueComparison === "changed" ? "Źródło testu zmieniło się podczas oczekiwania w kolejce." : "Nie udało się potwierdzić źródła testu przed uruchomieniem.";
        }
        this.persistNow(run);
        return true;
      });
      if (!checkpoint) return;
      if (run.source.queueComparison !== "match") {
        if (!preparation) this.preparing.delete(run.id);
        await this.finish(run);
        return;
      }
      // Recheck, commit `starting` provenance, persist running state and spawn in one admitted phase.
      await this.admission.run(() => {
        if (this.closed || this.read(run.id)?.phase !== "queued") return;
        if (!preparation) this.preparing.delete(run.id);
        this.start(run);
      });
    } catch (error) {
      if (this.persistenceFailure) throw error;
      if (session?.cleanupUnconfirmed || error instanceof PreparationError && error.cleanupUnconfirmed) {
        // Keep the occupied slot and workspace permits. No automatic retry or disposal.
        if (session) session.cleanupUnconfirmed = true;
        run.telemetry!.cleanup = "failed";
        run.telemetry!.termination = "unknown";
        run.phase = "interrupted";
        run.error = "preparation_cleanup_unconfirmed";
        run.source.reasonCodes = [...new Set([...run.source.reasonCodes, "preparation_cleanup_unconfirmed"])];
        this.telemetry.mark(run, "finalizedAt");
        await this.persist(run);
        this.blockAdmission("remote_execution_cleanup_unconfirmed");
        this.onChange(run.projectId);
        return;
      }
      const failed = await this.admission.run(() => {
        if (this.read(run.id)?.phase !== "queued") return false;
        run.source.reasonCodes = [...new Set([...run.source.reasonCodes, "source_preflight_failed"])];
        run.source = qualifySource(run.source);
        this.telemetry.mark(run, "prepareFinishedAt");
        const cause = session?.signal.aborted ? session.signal.reason : error;
        const code = cause instanceof PreparationError ? cause.code : "preparation_failed";
        run.source.reasonCodes = [...new Set([...run.source.reasonCodes, code])];
        run.telemetry!.termination = code === "preparation_cancelled" ? "cancel" : code === "preparation_timeout" ? "timeout" : "rejected";
        run.telemetry!.cleanup = session ? "confirmed" : "not_required";
        if (session?.signal.aborted) this.telemetry.mark(run, "cleanupFinishedAt");
        run.phase = code === "preparation_cancelled" ? "cancelled" : code === "preparation_timeout" ? "timed_out" : "failed";
        run.finishedAt = this.clock.wallNow();
        run.error = session ? code : `Nie udało się sprawdzić źródła testu: ${String(error)}`;
        this.persistNow(run);
        return true;
      });
      if (failed) await this.finish(run);
    } finally {
      session?.close();
      session?.signal.removeEventListener("abort", preparationStopped);
      const cancelled = await this.current(run.id);
      if (cancelled?.phase === "cancelled" && !cancelled.telemetry?.finalizedAt) {
        this.telemetry.mark(cancelled, "prepareFinishedAt");
        await this.finish(cancelled);
      }
      if (!session?.cleanupUnconfirmed && (await this.current(run.id))?.telemetry?.cleanup !== "failed") {
        this.preparing.delete(run.id);
        this.preparationSessions.delete(run.id);
      }
      this.pump();
    }
  }

  /** Must run admitted: `starting` provenance and the running state are durable before spawn. */
  private start(run: TestRun): void {
    if (this.closed || this.read(run.id)?.phase !== "queued") return;
    this.authorizeRequester(run);
    this.pathAdmission([run.worktreePath, run.cwd]);
    this.preparationSessions.get(run.id)?.throwIfAborted();
    this.preparations.get(run.id)?.starting?.();
    this.telemetry.mark(run, "prepareFinishedAt");
    run.phase = "running";
    run.startedAt = this.clock.wallNow();
    run.queuePosition = null;
    this.persistNow(run);
    let child: ChildProcess;
    try {
      child = spawn(run.executable, run.args, {
        cwd: run.cwd,
        // The resolved policy is the complete environment: nothing of the controller's own
        // process environment reaches a test unless its profile asked for it. Next.js declares
        // ProcessEnv.NODE_ENV as required, but Node child processes permit it to be omitted.
        env: (this.environments.get(run.id) ?? {}) as NodeJS.ProcessEnv,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      run.telemetry!.termination = "spawn_error";
      run.telemetry!.cleanup = "not_required";
      run.phase = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.finishedAt = this.clock.wallNow();
      void this.finish(run).catch((error: unknown) => {
        this.logs.controller("test_run.finalization_failed", { runId: run.id, error: String(error) });
        this.recordPersistenceFailure(run, error);
      });
      return;
    }
    const timeout = setTimeout(() => {
      const active = this.active.get(run.id);
      if (!active || active.exited) return;
      if (active.cancellationRequested) return;
      active.timedOut = true;
      run.telemetry!.termination = "timeout";
      this.telemetry.mark(run, "stopRequestedAt");
      this.checkpoint(run);
      this.complete(active);
    }, this.timeouts.get(run.id) ?? 15 * 60_000);
    timeout.unref();
    const active: ActiveRun = {
      child, run, timeout, resources: null, started: null, cancellationRequested: false, timedOut: false,
      worktreePath: run.worktreePath, group: new OwnedProcessGroup(child), completion: null,
      executionError: null, exited: false,
      closed: new Promise<void>((resolve) => child.once("close", () => resolve())),
    };
    this.active.set(run.id, active);
    child.once("spawn", () => {
      this.telemetry.mark(run, "spawnedAt");
      active.started = this.recordStarted(active);
    });
    child.stdout?.on("data", (chunk: Buffer) => this.appendChunk(run, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendChunk(run, chunk));
    child.once("error", (error) => {
      if (!run.telemetry!.spawnedAt) run.telemetry!.termination = "spawn_error";
      active.executionError = error.message;
      run.error = error.message;
      this.complete(active);
    });
    child.once("exit", (code, signal) => {
      active.exited = true;
      clearTimeout(active.timeout);
      run.exitCode = code;
      run.signal = signal;
      run.source.processOutcome = active.cancellationRequested ? "cancelled" : active.timedOut ? "timed_out"
        : code === 0 && !active.executionError ? "passed" : "failed";
      this.telemetry.mark(run, "exitedAt");
      this.telemetry.mark(run, "cleanupStartedAt");
      if (run.telemetry!.termination === "unknown") run.telemetry!.termination = "exit";
      this.checkpoint(run);
      this.complete(active);
    });
    this.onChange(run.projectId);
  }

  /** Running evidence is persisted with its own admission; finalization waits for it. */
  private async recordStarted(active: ActiveRun): Promise<void> {
    const { run, child } = active;
    const started = this.preparations.get(run.id)?.started;
    if (started) {
      try { await admitWithRetry(this.admission, () => started(), { reserved: true }); }
      catch (error) {
        this.recordPersistenceFailure(run, error);
        active.executionError = "Execution acceptance could not be persisted.";
        void this.complete(active);
        return;
      }
    }
    if (child.pid && !active.completion) {
      let checkpointAt: number | null = null;
      active.resources = observeRunResources(run.telemetry!.resources!, child.pid,
        () => !active.exited && child.exitCode === null && child.signalCode === null,
        () => {
          // At most one resource-only checkpoint per ten seconds. Existing
          // log/lifecycle checkpoints and finalization also retain the summary.
          if (checkpointAt !== null && performance.now() - checkpointAt < 10_000) return;
          checkpointAt = performance.now(); this.checkpoint(run);
        }, { ...this.resourceOptions, wallNow: this.resourceOptions.wallNow ?? this.clock.wallNow });
    }
    this.checkpoint(run);
  }

  private complete(active: ActiveRun): Promise<void> {
    if (active.completion) return active.completion;
    active.completion = this.admission.outside(() => (async () => {
      const { run } = active;
      // Finalization has already prepared an immutable result. A failed durable
      // write may retry that snapshot, never rerun source/log qualification.
      if (run.telemetry?.finalizedAt) {
        await active.started;
        try { await this.finish(run); }
        finally { active.completion = null; }
        return;
      }
      try {
        if (active.exited || run.telemetry!.termination === "spawn_error") this.telemetry.mark(run, "cleanupStartedAt");
        run.telemetry!.cleanup = "pending";
        this.checkpoint(run);
        await this.stopWithRetries(active.group);
        active.resources?.stop();
        this.telemetry.mark(run, "cleanupFinishedAt");
        run.telemetry!.cleanup = "confirmed";
        // Database contention must not delay stopping an owned process. Keep
        // spawn evidence ordered before finalization and releasing the slot.
        await active.started;
        this.telemetry.mark(run, "finalizationStartedAt");
        await this.waitForOutputClose(active);
      } catch (error) {
        if (this.persistenceFailure) { active.completion = null; throw error; }
        run.telemetry!.cleanup = "failed";
        run.error = `Nie potwierdzono sprzątania procesów: ${error instanceof Error ? error.message : String(error)}`;
        active.completion = null;
        await this.persist(run);
        this.onChange(run.projectId);
        return;
      }
      try {
        this.telemetry.mark(run, "finalizationStartedAt");
        run.error = active.executionError;
        run.finishedAt = this.clock.wallNow();
        run.phase = active.cancellationRequested ? "cancelled" : active.timedOut ? "timed_out"
          : run.exitCode === 0 && !run.error ? "passed" : "failed";
        run.source.processOutcome = run.phase;
        const observer = this.preparations.get(run.id)?.observe ?? this.observers.get(run.id) ?? this.sourceObserver;
        if (observer && run.source.enqueue) {
          try {
            run.source.finish = await observer(run, "finish");
          } catch (error) {
            if (error instanceof PreparationError && error.cleanupUnconfirmed) {
              run.phase = "interrupted";
              run.error = "preparation_cleanup_unconfirmed";
              run.telemetry!.cleanup = "failed";
              this.telemetry.mark(run, "finalizedAt");
              await this.persist(run);
              this.blockAdmission("remote_execution_cleanup_unconfirmed");
              return;
            }
            run.source.finish = {
              observedAt: this.clock.wallNow(), head: null, branch: null, dirty: null,
              statusDigest: null, statusEntries: null, complete: false, errorCode: "source_finish_failed",
            };
          }
          run.source = qualifySource(run.source);
          if (run.phase === "passed" && run.source.attribution !== "observed_match") {
            run.phase = "failed";
            run.error = "Polecenie zakończyło się powodzeniem, ale źródło nie zostało potwierdzone.";
          }
        }
        if (run.phase === "failed" && !run.error) run.error = `Proces testowy zakończył się z kodem ${run.exitCode ?? run.signal ?? "unknown"}.`;
        await this.finish(run);
      } catch (error) {
        this.recordPersistenceFailure(run, error);
        throw error;
      } finally {
        active.completion = null;
      }
    })());
    // Event handlers cannot await; shutdown still reports the latched durability failure.
    void active.completion.catch(error => this.recordPersistenceFailure(active.run, error));
    return active.completion;
  }

  private async stopWithRetries(group: OwnedProcessGroup): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PROCESS_GROUP_CLEANUP_ATTEMPTS; attempt += 1) {
      try {
        await group.stop();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < PROCESS_GROUP_CLEANUP_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_CLEANUP_RETRY_MS));
        }
      }
    }
    throw lastError;
  }

  private async waitForOutputClose(active: ActiveRun): Promise<void> {
    let timeout: NodeJS.Timeout | null = null;
    const closed = await Promise.race([
      active.closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), OUTPUT_CLOSE_GRACE_MS);
        timeout.unref();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (closed) return;
    active.child.stdout?.removeAllListeners("data");
    active.child.stderr?.removeAllListeners("data");
    active.child.stdout?.destroy();
    active.child.stderr?.destroy();
  }

  private pruneSummaries(): void {
    // Maintenance only deletes terminal summaries. Retry at the next bounded
    // interval; durable run writes still fail closed through persistNow.
    void admitWithRetry(this.admission, () => this.store.pruneTestSummaryHistory())
      .catch((error: unknown) => { this.logs.controller("test_summary.retention_failed", { error: String(error) }); });
  }

  pruneLogs(): Promise<void> {
    // Each retention answer is admitted on its own while the directory scan runs outside admission.
    // A refused admission fails this pass instead of deleting anything.
    const pruning = this.logs.pruneTests((id) => this.writes.get(id)?.dirty
      || admitWithRetry(this.admission, () => this.store.hasTestRun(id), { deadlineMs: 10_000 }));
    // The writer coalesces overlapping scans; keep only one maintenance waiter.
    if (pruning !== this.pruneOperation) {
      this.pruneOperation = pruning;
      this.logMaintenance = pruning.catch((error: unknown) => {
        this.logs.controller("test_log.cleanup_failed", { error: String(error) });
      });
    }
    return this.logMaintenance;
  }

  private finish(run: TestRun): Promise<void> {
    const existing = this.finalizations.get(run.id);
    if (existing) return existing;
    const active = this.active.get(run.id);
    if (active) { clearTimeout(active.timeout); active.resources?.stop(); }
    if (run.telemetry?.resources?.status === "pending") {
      run.telemetry.resources.status = "unavailable";
      resourceReason(run.telemetry.resources, "not_started");
    }
    this.cleanup(run.id);
    this.telemetry.mark(run, "finalizationStartedAt");
    const completion = this.admission.outside(() => (async () => {
      const preparation = this.preparations.get(run.id);
      if (preparation) {
        try { await preparation.dispose(); }
        catch {
          const session = this.preparationSessions.get(run.id);
          if (session) session.cleanupUnconfirmed = true;
          run.phase = "interrupted";
          run.error = "workspace_cleanup_failed";
          run.telemetry!.cleanup = "failed";
          this.telemetry.mark(run, "finalizedAt");
          await this.persist(run);
          this.blockAdmission("remote_execution_cleanup_unconfirmed");
          return;
        }
        this.preparations.delete(run.id);
      }
      const settle = this.settlements.get(run.id);
      this.settlements.delete(run.id);
      this.observers.delete(run.id);
      if (settle && !run.telemetry!.finalizedAt) {
        try { await settle(run, (line) => this.write(run, line)); }
        catch (error) { this.logs.controller("test_run.settle_failed", { runId: run.id, error: String(error) }); }
      }
      if (!run.telemetry!.finalizedAt) {
        try {
          await this.logs.finishTest(run.id);
        } catch (error) {
          const message = `Nie udało się zapisać lub zamknąć logu testu: ${String(error)}`;
          run.error = run.error ? `${run.error} ${message}` : message;
          if (run.phase === "passed") run.phase = "failed";
          this.logs.controller("test_log.finalization_failed", { runId: run.id, error: String(error) });
        }
        this.telemetry.mark(run, "finalizedAt");
      }
      // Terminal barrier: the final state is durable before the slot is released or success reported.
      await this.persist(run);
      this.telemetry.forget(run.id);
      this.active.delete(run.id);
      if (!this.preparationPromises.has(run.id)) this.preparing.delete(run.id);
      this.logs.controller("test_run.finished", { runId: run.id, projectId: run.projectId, phase: run.phase, exitCode: run.exitCode });
      void this.pruneLogs();
    })()).finally(() => {
      this.finalizations.delete(run.id);
      this.pump();
      this.onChange(run.projectId);
    });
    this.finalizations.set(run.id, completion);
    return completion;
  }

  private recordPersistenceFailure(run: TestRun, error: unknown): void {
    this.persistenceFailure ??= error;
    this.closed = true;
    this.logs.controller("test_run.persistence_failed", { runId: run.id, error: String(error) });
  }

  private appendChunk(run: TestRun, chunk: Buffer): void {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) this.write(run, line);
  }

  private write(run: TestRun, line: string): void {
    const bounded = line.slice(0, MAX_LOG_LINE_LENGTH);
    run.logs.push(bounded);
    if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
    this.logs.test(run.id, bounded);
    this.schedulePersistence(run);
    this.notifyOutput(run.projectId);
  }

  private updateQueuePositions(): void {
    this.queuedRuns().forEach((run, index) => {
      const position = index + 1;
      if (run.queuePosition === position) return;
      const persisted = this.requireRun(run.id);
      persisted.queuePosition = position;
      this.persistNow(persisted);
    });
  }

  private cleanup(runId: string): void {
    const pendingPersistence = this.logPersistence.get(runId);
    if (pendingPersistence) clearTimeout(pendingPersistence);
    this.logPersistence.delete(runId);
    this.environments.delete(runId);
    this.timeouts.delete(runId);
  }

  /** Newest state of a run, including a write still waiting for admission. Caller holds admission. */
  private read(id: string): TestRun | null {
    const write = this.writes.get(id);
    return write?.dirty ? write.latest : this.store.getTestRun(id);
  }

  /** `read` from any context: admitted immediately when possible, otherwise waits. */
  private async current(id: string): Promise<TestRun | null> {
    const write = this.writes.get(id);
    if (write?.dirty) return write.latest;
    const attempt = this.admission.tryRun(() => this.read(id));
    return attempt.ran ? attempt.value : admitWithRetry(this.admission, () => this.read(id), { reserved: true });
  }

  private requireRun(id: string): TestRun {
    const run = this.read(id);
    if (!run) throw new Error("Nie znaleziono uruchomienia testu.");
    return run;
  }

  private schedulePersistence(run: TestRun): void {
    if (this.logPersistence.has(run.id)) return;
    const timeout = setTimeout(() => {
      this.logPersistence.delete(run.id);
      if (run.phase !== "queued" && run.phase !== "running" && this.active.has(run.id)) return;
      this.checkpoint(run);
    }, LOG_PERSISTENCE_INTERVAL_MS);
    timeout.unref();
    this.logPersistence.set(run.id, timeout);
  }

  /** Fire-and-forget durable checkpoint; a genuine failure is latched and surfaced by shutdown. */
  private checkpoint(run: TestRun): void {
    this.persist(run).catch(() => undefined);
  }

  /**
   * Durable write of `run` inside an operation that already holds admission.
   * Throws (and latches) on failure.
   */
  private persistNow(run: TestRun): void {
    const write = this.stage(run);
    try { this.writeStaged(write); } catch (error) { this.recordPersistenceFailure(run, error); throw error; }
    this.forgetClean(write);
  }

  /**
   * Durable write of `run` from any context. Written before returning when
   * admission is free; otherwise ordered behind the run's pending write and
   * coalesced with it. Contention waits; only a genuine failure (or admission
   * that stays unavailable past its deadline) latches and rejects.
   */
  private persist(run: TestRun): Promise<void> {
    const write = this.stage(run);
    let attempt: { ran: boolean };
    try { attempt = this.admission.tryRun(() => this.writeStaged(write)); }
    catch (error) { this.recordPersistenceFailure(run, error); return Promise.reject(error); }
    if (attempt.ran) { this.forgetClean(write); return Promise.resolve(); }
    if (!write.chain) {
      write.chain = (async () => {
        try {
          while (write.dirty) await admitWithRetry(this.admission, () => this.writeStaged(write), { reserved: true });
        } catch (error) {
          this.recordPersistenceFailure(write.latest, error);
          throw error;
        } finally {
          write.chain = null;
          this.forgetClean(write);
        }
      })();
      write.chain.catch(() => undefined);
    }
    return write.chain;
  }

  private stage(run: TestRun): RunWrite {
    const pending = this.logPersistence.get(run.id);
    if (pending) clearTimeout(pending);
    this.logPersistence.delete(run.id);
    let write = this.writes.get(run.id);
    if (!write) { write = { latest: run, dirty: true, chain: null }; this.writes.set(run.id, write); }
    else { write.latest = run; write.dirty = true; }
    return write;
  }

  private writeStaged(write: RunWrite): void {
    if (!write.dirty) return;
    write.dirty = false;
    try { this.store.saveTestRun(write.latest); } catch (error) { write.dirty = true; throw error; }
  }

  private forgetClean(write: RunWrite): void {
    if (!write.dirty && !write.chain && this.writes.get(write.latest.id) === write) this.writes.delete(write.latest.id);
  }

  private notifyOutput(projectId: string): void {
    if (this.outputProjects.size < 128) this.outputProjects.add(projectId);
    if (this.outputNotification || this.closed) return;
    this.outputNotification = setTimeout(() => {
      this.outputNotification = null;
      if (!this.closed) {
        if (this.outputProjects.size >= 128) this.onChange();
        else for (const id of this.outputProjects) this.onChange(id);
      }
      this.outputProjects.clear();
    }, 500);
    this.outputNotification.unref();
  }
}
