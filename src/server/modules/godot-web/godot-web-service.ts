import { join } from "node:path";

import { admissionOf, admitNowOrLater, admitWithRetry, type DatabaseAdmission } from "@/server/database-admission";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import { webWorktreeKey, type LaunchCommandResolver } from "@/server/launch-command";
import type { LogWriter } from "@/server/log-writer";
import type { ProcessManager } from "@/server/process-manager";
import type { StateStore } from "@/server/state-store";
import type { ProjectView, TestRun } from "@/shared/contracts";
import { GODOT_WEB_EXPORT_PRESET_ID, parseGodotWebConfig, type GodotWebConfig, type WebExportStatus } from "@/shared/contracts/godot-web";
import { redactProject, resolveTestEnvironment, testProfileFor } from "../environments";
import type { LifecycleAccess, OperationActor } from "../lifecycle";
import { projectTestPreset, type VerificationJobs } from "../verification";
import { GodotWebConfigurationError, resolveWebExport, type ResolvedWebExport } from "./export-command";
import { GenerationOutputError, GenerationStore, GenerationSupersededError, type GenerationLimits } from "./generation-store";
import { SourceWatcher, type WatchFactory } from "./source-watcher";
import { WebExportSession } from "./web-export-session";

/** Owner recorded on automatic export runs; local-user may still cancel them. */
export const GODOT_WEB_ACTOR = "worktree-control:godot-web";
const DRAIN_TIMEOUT_MS = 30_000;

export interface GodotWebServiceOptions {
  /** Controller-owned root; each project gets `<root>/<projectId>`. */
  storeRoot: string;
  store: Pick<StateStore, "getProject" | "getTestRun" | "setProjectGodotWeb" | "recordProjectEvent">;
  git: Pick<GitWorktreeReader, "list" | "observe"> & Partial<Pick<GitWorktreeReader, "checkIgnoredPaths">>;
  processes: Pick<ProcessManager, "statusSummary">;
  jobs: Pick<VerificationJobs, "enqueue" | "cancel">;
  lifecycle: LifecycleAccess & { isProjectActive(projectId: string): boolean };
  commands: LaunchCommandResolver;
  logs: Pick<LogWriter, "controller">;
  notify(projectId: string): void;
  limits?: GenerationLimits;
  watch?: WatchFactory;
  /** The store's connection gate; defaults to the store's own admission. */
  admission?: DatabaseAdmission;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof GodotWebConfigurationError || error instanceof GenerationOutputError ? error.message : fallback;
}

/**
 * Managed Godot Web previews. A session exists only while the project's owned
 * static-server runtime is running; exports are finite jobs in the shared queue.
 *
 * Database admission: transport calls (configure, rebuild, status, drain from
 * removal) run inside the caller's admitted operation. Runtime events, watcher
 * timers, queue settlement and follow-up exports are background flows: they
 * never inherit a caller's admission and take their own for each store call.
 * Waits for export settlement release admission.
 */
export class GodotWebService {
  private readonly sessions = new Map<string, { session: WebExportSession; watcher: SourceWatcher | null }>();
  /** Ended sessions whose export may still be finishing in the queue; drained by removal and shutdown. */
  private readonly ending = new Map<string, { session: WebExportSession; runId: string }>();
  /** Last status after a session ends, so the dashboard keeps the served generation. */
  private readonly stopped = new Map<string, WebExportStatus>();
  /** Runtime keys already known not to be Godot Web, avoiding a store read per log line. */
  private readonly ignoredRuntimes = new Map<string, string>();
  private closed = false;
  private readonly admission: DatabaseAdmission;

  constructor(private readonly options: GodotWebServiceOptions) {
    this.admission = options.admission ?? admissionOf(options.store);
  }

  publicDirectory(projectId: string): string { return this.generationStore(projectId).publicDirectory; }

  /** Registration-time prerequisite check; nothing is installed or exported. */
  validate(config: GodotWebConfig, worktreePath: string): void {
    resolveWebExport(config, worktreePath, join(this.options.storeRoot, "validation", "staging"));
  }

  private generationStore(projectId: string): GenerationStore {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(projectId)) throw new Error("Invalid project identifier.");
    return new GenerationStore(join(this.options.storeRoot, projectId), this.options.limits);
  }

  /** Called on every runtime change; only phase/worktree transitions do work. */
  runtimeChanged(projectId: string): void {
    if (this.closed) return;
    const runtime = this.options.processes.statusSummary(projectId);
    const entry = this.sessions.get(projectId);
    const wanted = runtime.phase === "running" && runtime.worktreePath ? runtime.worktreePath : null;
    if (entry && entry.session.worktreePath !== wanted) this.endSession(projectId, "runtime_changed");
    if (!wanted || this.sessions.has(projectId)) return;
    const runtimeKey = `${wanted}\0${runtime.startedAt}`;
    if (this.ignoredRuntimes.get(projectId) === runtimeKey) return;
    // Process callbacks may fire inside or outside an admitted operation; the read is synchronous when admission is free.
    admitNowOrLater(this.admission, () => this.options.store.getProject(projectId), (project) => {
      if (this.closed || this.sessions.has(projectId)) return;
      // A deferred read may observe a runtime that has since changed; a later event handles the new one.
      const current = this.options.processes.statusSummary(projectId);
      if (current.phase !== "running" || current.worktreePath !== wanted || `${current.worktreePath}\0${current.startedAt}` !== runtimeKey) return;
      if (project?.launchPreset !== "godot-web" || !project.godotWeb) { this.ignoredRuntimes.set(projectId, runtimeKey); return; }
      this.ignoredRuntimes.delete(projectId);
      const config = project.godotWeb;
      // A background flow: it must never join (or idle) the operation that triggered this runtime event.
      void this.admission.outside(() => this.beginSession(projectId, wanted, config)).catch((error: unknown) => {
        this.options.logs.controller("godot_web.session_failed", { projectId, error: String(error) });
      });
    }, (error: unknown) => {
      this.options.logs.controller("godot_web.session_failed", { projectId, error: String(error) });
    });
  }

  status(projectId: string): WebExportStatus | null {
    const entry = this.sessions.get(projectId);
    if (!entry) return this.stopped.get(projectId) ?? null;
    const run = entry.session.activeRunId ? this.options.store.getTestRun(entry.session.activeRunId) : null;
    return entry.session.status(run?.phase ?? null);
  }

  /** Exact runtime-owned job, including cancellation still draining after stop. */
  ownsExportRun(projectId: string, runId: string): boolean {
    return this.sessions.get(projectId)?.session.activeRunId === runId || this.ending.get(projectId)?.runId === runId;
  }

  async configure(projectId: string, input: unknown, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const config = input === null ? null : parseGodotWebConfig(input);
    return this.options.lifecycle.serialized(projectId, async () => {
      const project = this.options.lifecycle.requireProject(projectId);
      if (this.options.lifecycle.isProjectActive(projectId)) throw new Error("Stop the server before changing the Godot Web configuration.");
      const worktrees = await this.options.git.list(project.repositoryPath);
      const worktree = this.options.lifecycle.resolveWorktree(project, worktrees);
      this.options.lifecycle.assertReservationAllows(projectId, worktree.path, actor);
      const launchPreset = config ? "godot-web" as const : "none" as const;
      if (config) resolveWebExport(config, worktree.path, this.generationStore(projectId).stagingDirectory);
      const launch = this.options.commands.resolve(worktree.path, project.port, launchPreset, undefined, { projectId, godotWeb: config });
      this.options.store.setProjectGodotWeb(projectId, { launchPreset, godotWeb: config, executable: launch.executable, args: launch.args }, actor.owner);
      this.ignoredRuntimes.delete(projectId);
      if (!config) this.stopped.delete(projectId);
      this.options.logs.controller("project.godot_web_configured", { projectId, launchPreset, exporter: config?.exporter.kind ?? null, actor: actor.owner });
      return redactProject(this.options.lifecycle.requireProject(projectId));
    });
  }

  async rebuild(projectId: string, actor: OperationActor = { owner: "local-user" }): Promise<WebExportStatus> {
    const entry = await this.options.lifecycle.serialized(projectId, async () => {
      const project = this.options.lifecycle.requireProject(projectId);
      if (project.launchPreset !== "godot-web") throw new Error("The project does not use the godot-web preset.");
      const current = this.sessions.get(projectId);
      if (!current) throw new Error("Start the Godot Web server before requesting a rebuild.");
      this.options.lifecycle.assertReservationAllows(projectId, current.session.worktreePath, actor);
      return current;
    });
    // Enqueue outside this lock: the export takes the project lock itself.
    this.request(entry.session, "manual");
    return this.status(projectId)!;
  }

  /** Ends the session and waits (bounded) until its export no longer runs. */
  async drain(projectId: string): Promise<void> {
    this.endSession(projectId, "drain");
    await this.drainEnding(projectId);
  }

  /** A replacement runtime must not touch shared export storage until cleanup is confirmed. */
  private async drainEnding(projectId: string): Promise<void> {
    const ended = this.ending.get(projectId);
    if (!ended) return;
    const { session, runId } = ended;
    // Never hold database admission while waiting: the queue needs it to settle this very run.
    await this.admission.idle(() => session.settled(DRAIN_TIMEOUT_MS));
    const read = () => this.admission.run(() => this.options.store.getTestRun(runId), { reserved: true });
    // Cancellation may persist a terminal phase before preflight settles.
    // Wait for the queue's durable finalization receipt as well as its phase.
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (runId && Date.now() < deadline) {
      const run = await read();
      if (!run || (run.phase !== "queued" && run.phase !== "running" && run.telemetry?.finalizedAt)) break;
      await this.admission.idle(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    const run = await read();
    if (session.activeRunId || !run?.telemetry?.finalizedAt || run.phase === "queued" || run.phase === "running"
      || (run && run.telemetry?.cleanup !== "confirmed" && run.telemetry?.cleanup !== "not_required")) {
      throw new Error("The previous Web export has not confirmed process cleanup; retry after it finishes.");
    }
    if (this.ending.get(projectId)?.session === session) this.ending.delete(projectId);
  }

  async forget(projectId: string): Promise<void> {
    await this.drain(projectId);
    this.stopped.delete(projectId);
    this.ignoredRuntimes.delete(projectId);
    await this.generationStore(projectId).remove();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const projectId of [...this.sessions.keys()]) this.endSession(projectId, "shutdown");
    await Promise.all([...this.ending.keys()].map((projectId) => this.drain(projectId)));
  }

  private async beginSession(projectId: string, worktreePath: string, config: GodotWebConfig): Promise<void> {
    const session = new WebExportSession(projectId, worktreePath);
    session.initializing = true;
    this.sessions.set(projectId, { session, watcher: null });
    this.stopped.delete(projectId);
    try {
      await this.drainEnding(projectId);
      if (session.disposed) return;
      await this.initializeSession(session, config);
    } catch (error) {
      if (this.sessions.get(projectId)?.session === session) {
        this.sessions.get(projectId)?.watcher?.dispose();
        session.dispose();
        session.initializing = false;
        session.watcher = "stopped";
        session.fail("configuration_invalid", "The preview could not initialize. Check storage and previous export cleanup, then restart the preview.", null);
        this.sessions.delete(projectId);
        this.stopped.set(projectId, session.status(null));
        this.options.notify(projectId);
      }
      throw error;
    }
  }

  private async initializeSession(session: WebExportSession, config: GodotWebConfig): Promise<void> {
    const { projectId, worktreePath } = session;
    const store = this.generationStore(projectId);
    await store.initialize();
    const state = await store.readState();
    const meta = state.generation ? await store.readMeta(state.generation) : null;
    if (session.disposed) return;
    if (meta && meta.worktreePath === worktreePath) {
      const { worktreePath: _omitted, ...generation } = meta;
      void _omitted;
      session.current = generation;
    }
    const ignore = [...config.watch.ignore];
    if (config.exporter.kind === "command") ignore.push(config.exporter.outputDirectory);
    if (session.disposed) return;
    const watcher = new SourceWatcher({
      root: worktreePath, paths: config.watch.paths, ignore, debounceMs: config.watch.debounceMs,
      checkIgnoredPaths: this.options.git.checkIgnoredPaths
        ? (paths, signal) => this.options.git.checkIgnoredPaths!(worktreePath, paths, signal) : undefined,
      watch: this.options.watch,
      onInvalidate: () => session.sourceChanged(),
      onChange: () => this.request(session, "change"),
      onState: (state) => { session.watcher = state; this.options.notify(projectId); },
    });
    this.sessions.set(projectId, { session, watcher });
    await watcher.start();
    if (session.disposed) { watcher.dispose(); return; }
    session.watcher = watcher.state;
    session.initializing = false;
    session.pending = session.manualPending = false;
    this.request(session, "start");
  }

  private endSession(projectId: string, reason: string): void {
    const entry = this.sessions.get(projectId);
    if (!entry) return;
    this.sessions.delete(projectId);
    const { session, watcher } = entry;
    watcher?.dispose();
    const runId = session.activeRunId;
    session.watcher = "stopped";
    this.stopped.set(projectId, { ...session.status(null), state: "stopped", activeRunId: null, pendingRebuild: false, currentStale: false });
    session.dispose();
    if (runId) {
      this.ending.set(projectId, { session, runId });
      // At most one entry per project; drain removes it once the run is terminal.
      // Cancellation follows the queue's own rules; a late settle is ignored because the session is disposed.
      // It takes its own admission instead of joining whichever operation ended the session.
      void this.admission.outside(() => this.options.jobs.cancel(runId, GODOT_WEB_ACTOR)).catch((error: unknown) => {
        this.options.logs.controller("godot_web.cancel_failed", { projectId, runId, error: String(error) });
      });
    }
    this.options.logs.controller("godot_web.session_ended", { projectId, reason, cancelledRunId: runId });
    this.options.notify(projectId);
  }

  private request(session: WebExportSession, reason: "start" | "change" | "manual"): void {
    const start = session.request(reason);
    this.options.notify(session.projectId);
    if (start) this.startEnqueue(session);
  }

  /** Exports are enqueued by a background flow with fresh admissions, never inside the requester's operation. */
  private startEnqueue(session: WebExportSession): void {
    void this.admission.outside(() => this.enqueue(session));
  }

  private async enqueue(session: WebExportSession): Promise<void> {
    session.enqueueing = true;
    const { projectId } = session;
    const store = this.generationStore(projectId);
    try {
      await this.options.lifecycle.serialized(projectId, async () => {
        if (session.disposed) return;
        const project = this.options.lifecycle.requireProject(projectId);
        const runtime = this.options.processes.statusSummary(projectId);
        if (project.launchPreset !== "godot-web" || !project.godotWeb || runtime.phase !== "running" || runtime.worktreePath !== session.worktreePath) return;
        const worktrees = await this.options.git.list(project.repositoryPath);
        const worktree = this.options.lifecycle.resolveWorktree(project, worktrees, session.worktreePath);
        let resolved: ResolvedWebExport;
        try {
          if (project.godotWeb.exporter.kind === "preset") await store.resetStaging();
          resolved = resolveWebExport(project.godotWeb, worktree.path, store.stagingDirectory);
        } catch (error) {
          session.fail("configuration_invalid", safeMessage(error, "The Godot Web export configuration is invalid."), null);
          await store.writeState({ build: "failed", failureCode: "configuration_invalid" });
          return;
        }
        const preset = projectTestPreset(project, { id: GODOT_WEB_EXPORT_PRESET_ID, name: "web-export", adapter: "godot", timeoutMs: 15 * 60_000 });
        const environment = resolveTestEnvironment({ project, worktree, profile: testProfileFor(project, preset) });
        const sourceObservation = await this.options.git.observe(worktree.path);
        if (session.disposed) return;
        const run = this.options.jobs.enqueue({
          projectId, worktree, environment, actor: GODOT_WEB_ACTOR, sourceObservation,
          command: { preset, executable: resolved.executable, args: resolved.args, cwd: resolved.cwd },
          // Plain Git observation without the project lock: stop/drain may hold it while this run finishes.
          observe: (target) => this.options.git.observe(target.worktreePath),
          settle: (settled, log) => this.settle(session, resolved, worktree.path, settled, log),
        });
        session.activeRunId = run.id;
        session.lastRunId = run.id;
        await store.writeState({ build: "building", failureCode: null });
      });
    } catch (error) {
      if (!session.disposed) {
        session.fail("queue_rejected", error instanceof Error ? error.message : "The export could not be queued.", null);
        await store.writeState({ build: "failed", failureCode: "queue_rejected" }).catch(() => undefined);
      }
    } finally {
      session.enqueueing = false;
      this.options.notify(projectId);
      // A request coalesced while enqueueing still needs its single follow-up.
      if (!session.activeRunId && session.pending && !session.disposed) {
        session.pending = false;
        session.manualPending = false;
        this.startEnqueue(session);
      }
    }
  }

  /** Runs inside the queue slot after owned-process cleanup. */
  private async settle(session: WebExportSession, resolved: ResolvedWebExport, worktreePath: string, run: TestRun, log: (line: string) => void): Promise<void> {
    const store = this.generationStore(session.projectId);
    const watcher = this.sessions.get(session.projectId)?.session === session ? this.sessions.get(session.projectId)?.watcher : null;
    await watcher?.flush();
    let decision = session.decide(run);
    if (decision.kind === "ignored") {
      log("web_export.publication=suppressed reason=session_ended");
      if (session.activeRunId === run.id) session.finish(decision);
      return;
    }
    try {
      if (decision.kind === "publish") {
        try {
          const containment = resolved.outputDirectory === store.stagingDirectory ? store.stagingDirectory : resolved.cwd;
          if (session.disposed) throw new GenerationSupersededError();
          const { generation, skipped } = await store.publish(resolved.outputDirectory, containment, {
            runId: run.id, head: run.source.finish?.head ?? run.worktreeHead, dirty: run.source.finish?.dirty ?? run.worktreeDirty, worktreePath,
          }, webWorktreeKey(session.worktreePath), async () => {
            await watcher?.flush();
            return session.decide(run).kind === "publish";
          });
          const { worktreePath: _omitted, ...current } = generation;
          void _omitted;
          session.current = current;
          log(`web_export.published generation=${generation.id} files=${generation.files} bytes=${generation.bytes} skipped=${skipped}`);
          // Settlement runs outside any admitted operation; completion of accepted work uses reserved admission.
          await admitWithRetry(this.admission, () => this.options.store.recordProjectEvent(session.projectId, "godot_web.published", GODOT_WEB_ACTOR, {
            generation: generation.id, runId: run.id, files: generation.files, bytes: generation.bytes,
          }), { reserved: true });
        } catch (error) {
          if (error instanceof GenerationSupersededError) {
            decision = session.disposed ? { kind: "ignored" } : { kind: "superseded" };
            if (session.disposed) log("web_export.publication=suppressed reason=session_ended");
          }
          else {
            const code = error instanceof GenerationOutputError ? "output_invalid" : "publication_failed";
            decision = { kind: "failed", code, message: safeMessage(error, "The completed export could not be published.") };
          }
        }
      }
      if (decision.kind === "superseded") {
        log("web_export.publication=skipped reason=source_changed_during_export");
        // Write before finish releases the run: a manual rebuild during this write is
        // coalesced, and its newer building state will be written afterwards.
        if (!session.disposed && session.willPause(decision)) await store.writeState({ build: "failed", failureCode: "superseded" });
      }
      if (decision.kind === "failed") {
        session.fail(decision.code, decision.message, run.id);
        log(`web_export.publication=skipped reason=${decision.code}`);
        if (!session.disposed) await store.writeState({ build: "failed", failureCode: decision.code });
      }
    } finally {
      const rerun = session.finish(decision);
      this.options.notify(session.projectId);
      if (rerun) this.startEnqueue(session);
    }
  }
}
