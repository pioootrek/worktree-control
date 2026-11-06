import { join } from "node:path";

import type { GitWorktreeReader } from "@/server/git-worktrees";
import { detectLaunchPreset, webWorktreeKey, type LaunchCommandResolver } from "@/server/launch-command";
import type { LogWriter } from "@/server/log-writer";
import type { ProcessManager } from "@/server/process-manager";
import type { StateStore } from "@/server/state-store";
import type { ProjectView, TestRun } from "@/shared/contracts";
import { GODOT_WEB_EXPORT_PRESET_ID, parseGodotWebConfig, type GodotWebConfig, type WebExportStatus } from "@/shared/contracts/godot-web";
import { redactProject, resolveTestEnvironment, testProfileFor } from "../environments";
import type { LifecycleAccess, OperationActor } from "../lifecycle";
import { projectTestPreset, type VerificationJobs } from "../verification";
import { assertGodotProject, GodotWebConfigurationError, resolveWebExport, type ResolvedWebExport } from "./export-command";
import { GenerationOutputError, GenerationStore, type GenerationLimits } from "./generation-store";
import { SourceWatcher, type WatchFactory } from "./source-watcher";
import { WebExportSession } from "./web-export-session";

/** Owner recorded on automatic export runs; local-user may still cancel them. */
export const GODOT_WEB_ACTOR = "worktree-control:godot-web";
const DRAIN_TIMEOUT_MS = 30_000;

export interface GodotWebServiceOptions {
  /** Controller-owned root; each project gets `<root>/<projectId>`. */
  storeRoot: string;
  store: Pick<StateStore, "getProject" | "getTestRun" | "setProjectGodotWeb" | "recordProjectEvent">;
  git: Pick<GitWorktreeReader, "list" | "observe"> & Partial<Pick<GitWorktreeReader, "ignoredPaths">>;
  processes: Pick<ProcessManager, "statusSummary">;
  jobs: Pick<VerificationJobs, "enqueue" | "cancel">;
  lifecycle: LifecycleAccess & { isProjectActive(projectId: string): boolean };
  commands: LaunchCommandResolver;
  logs: Pick<LogWriter, "controller">;
  notify(projectId: string): void;
  limits?: GenerationLimits;
  watch?: WatchFactory;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof GodotWebConfigurationError || error instanceof GenerationOutputError ? error.message : fallback;
}

/**
 * Managed Godot Web previews. A session exists only while the project's owned
 * static-server runtime is running; exports are finite jobs in the shared queue.
 */
export class GodotWebService {
  private readonly sessions = new Map<string, { session: WebExportSession; watcher: SourceWatcher | null }>();
  /** Last status after a session ends, so the dashboard keeps the served generation. */
  private readonly stopped = new Map<string, WebExportStatus>();
  /** Runtime keys already known not to be Godot Web, avoiding a store read per log line. */
  private readonly ignoredRuntimes = new Map<string, string>();
  private closed = false;

  constructor(private readonly options: GodotWebServiceOptions) {}

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
    const project = this.options.store.getProject(projectId);
    if (project?.launchPreset !== "godot-web" || !project.godotWeb) { this.ignoredRuntimes.set(projectId, runtimeKey); return; }
    this.ignoredRuntimes.delete(projectId);
    void this.beginSession(projectId, wanted, project.godotWeb).catch((error: unknown) => {
      this.options.logs.controller("godot_web.session_failed", { projectId, error: String(error) });
    });
  }

  status(projectId: string): WebExportStatus | null {
    const entry = this.sessions.get(projectId);
    if (!entry) return this.stopped.get(projectId) ?? null;
    const run = entry.session.activeRunId ? this.options.store.getTestRun(entry.session.activeRunId) : null;
    return entry.session.status(run?.phase ?? null);
  }

  async configure(projectId: string, input: unknown, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const config = input === null ? null : parseGodotWebConfig(input);
    return this.options.lifecycle.serialized(projectId, async () => {
      const project = this.options.lifecycle.requireProject(projectId);
      if (this.options.lifecycle.isProjectActive(projectId)) throw new Error("Stop the server before changing the Godot Web configuration.");
      const worktrees = await this.options.git.list(project.repositoryPath);
      const worktree = this.options.lifecycle.resolveWorktree(project, worktrees);
      this.options.lifecycle.assertReservationAllows(projectId, worktree.path, actor);
      assertGodotProject(worktree.path);
      const launchPreset = config ? "godot-web" as const : detectLaunchPreset(worktree.path);
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
    const entry = this.sessions.get(projectId);
    if (!entry) return;
    this.endSession(projectId, "drain");
    await entry.session.settled(DRAIN_TIMEOUT_MS);
  }

  async forget(projectId: string): Promise<void> {
    await this.drain(projectId);
    this.stopped.delete(projectId);
    this.ignoredRuntimes.delete(projectId);
    await this.generationStore(projectId).remove();
  }

  async close(): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()].map(({ session }) => session);
    for (const projectId of [...this.sessions.keys()]) this.endSession(projectId, "shutdown");
    await Promise.all(sessions.map((session) => session.settled(DRAIN_TIMEOUT_MS)));
  }

  private async beginSession(projectId: string, worktreePath: string, config: GodotWebConfig): Promise<void> {
    const session = new WebExportSession(projectId, worktreePath);
    this.sessions.set(projectId, { session, watcher: null });
    this.stopped.delete(projectId);
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
    try {
      for (const path of await this.options.git.ignoredPaths?.(worktreePath) ?? []) ignore.push(path.replace(/\/+$/, ""));
    } catch { /* Watch without Git exclusions; configured ignores still apply. */ }
    if (session.disposed) return;
    const watcher = new SourceWatcher({
      root: worktreePath, paths: config.watch.paths, ignore, debounceMs: config.watch.debounceMs,
      watch: this.options.watch,
      onChange: () => this.request(session, "change"),
      onState: (state) => { session.watcher = state; this.options.notify(projectId); },
    });
    this.sessions.set(projectId, { session, watcher });
    await watcher.start();
    if (session.disposed) { watcher.dispose(); return; }
    session.watcher = watcher.state;
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
      // Cancellation follows the queue's own rules; a late settle is ignored because the session is disposed.
      void this.options.jobs.cancel(runId, GODOT_WEB_ACTOR).catch((error: unknown) => {
        this.options.logs.controller("godot_web.cancel_failed", { projectId, runId, error: String(error) });
      });
    }
    this.options.logs.controller("godot_web.session_ended", { projectId, reason, cancelledRunId: runId });
    this.options.notify(projectId);
  }

  private request(session: WebExportSession, reason: "start" | "change" | "manual"): void {
    const start = session.request(reason);
    this.options.notify(session.projectId);
    if (start) void this.enqueue(session);
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
        void this.enqueue(session);
      }
    }
  }

  /** Runs inside the queue slot after owned-process cleanup. */
  private async settle(session: WebExportSession, resolved: ResolvedWebExport, worktreePath: string, run: TestRun, log: (line: string) => void): Promise<void> {
    const store = this.generationStore(session.projectId);
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
          if (session.disposed) throw new Error("session_ended");
          const { generation, skipped } = await store.publish(resolved.outputDirectory, containment, {
            runId: run.id, head: run.source.finish?.head ?? run.worktreeHead, dirty: run.source.finish?.dirty ?? run.worktreeDirty, worktreePath,
          }, webWorktreeKey(session.worktreePath));
          const { worktreePath: _omitted, ...current } = generation;
          void _omitted;
          session.current = current;
          log(`web_export.published generation=${generation.id} files=${generation.files} bytes=${generation.bytes} skipped=${skipped}`);
          this.options.store.recordProjectEvent(session.projectId, "godot_web.published", GODOT_WEB_ACTOR, { generation: generation.id, runId: run.id, files: generation.files, bytes: generation.bytes });
        } catch (error) {
          if (error instanceof Error && error.message === "session_ended") { log("web_export.publication=suppressed reason=session_ended"); decision = { kind: "ignored" }; }
          else {
            const code = error instanceof GenerationOutputError ? "output_invalid" : "publication_failed";
            decision = { kind: "failed", code, message: safeMessage(error, "The completed export could not be published.") };
          }
        }
      }
      if (decision.kind === "superseded") log("web_export.publication=skipped reason=source_changed_during_export");
      if (decision.kind === "failed") {
        session.fail(decision.code, decision.message, run.id);
        log(`web_export.publication=skipped reason=${decision.code}`);
        if (!session.disposed) await store.writeState({ build: "failed", failureCode: decision.code });
      }
    } finally {
      const rerun = session.finish(decision);
      this.options.notify(session.projectId);
      if (rerun) void this.enqueue(session);
    }
  }
}
