import type { GitWorktreeReader } from "@/server/git-worktrees";
import { type LogWriter } from "@/server/log-writer";
import { resolveTestEnvironment } from "@/server/modules/environments";
import type { StateStore } from "@/server/state-store";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import type { VerificationJobs } from "./verification-jobs";
import type { Project, TestQueueStatus, TestRun, WorktreeTestPresets } from "@/shared/contracts";
import { testProfileFor } from "../environments";
import { type LifecycleAccess, type OperationActor } from "../lifecycle";

export class VerificationService {
  constructor(
    private readonly store: Pick<StateStore, "getTestQueueSettings" | "countTestRuns" | "getTestRun">,
    private readonly git: Pick<GitWorktreeReader, "list"> & Partial<Pick<GitWorktreeReader, "observe">>,
    private readonly logs: Pick<LogWriter, "controller">,
    private readonly testCommands: Pick<ProjectTestCommandResolver, "resolve" | "discover">,
    private readonly lifecycle: LifecycleAccess,
    private readonly tests?: VerificationJobs,
  ) {
    if (this.git.observe && this.tests?.configureSourceObserver) {
      this.tests.configureSourceObserver(async (run) => this.lifecycle.serialized(run.projectId, async () => {
        const project = this.lifecycle.requireProject(run.projectId);
        const worktrees = await this.git.list(project.repositoryPath);
        const worktree = this.lifecycle.resolveWorktree(project, worktrees, run.worktreePath);
        const command = this.testCommands.resolve(worktree.path, run.presetId);
        if (command.cwd !== run.cwd || command.executable !== run.executable || JSON.stringify(command.args) !== JSON.stringify(run.args)) {
          throw new Error("Definicja polecenia testowego zmieniła się po dodaniu do kolejki.");
        }
        return this.git.observe!(worktree.path);
      }));
    }
  }

  testQueueStatus(): TestQueueStatus {
    if (this.tests) return this.tests.status();
    return {
      ...this.store.getTestQueueSettings(),
      running: this.store.countTestRuns(["running"]),
      queued: this.store.countTestRuns(["queued"]),
    };
  }

  setTestQueueLimit(limit: number): TestQueueStatus {
    const status = this.requireTests().setLimit(limit);
    this.logs.controller("test_queue.updated", { limit });
    return status;
  }

  async enqueueTest(
    projectId: string,
    worktreePath: string,
    presetId: string,
    actor: OperationActor = { owner: "local-user" },
    idempotencyKey?: string,
  ): Promise<TestRun> {
    return this.lifecycle.serialized(projectId, async () => {
      const project = this.lifecycle.requireProject(projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const worktree = this.lifecycle.resolveWorktree(project, worktrees, worktreePath);
      this.lifecycle.assertReservationAllows(projectId, worktree.path, actor);
      if (idempotencyKey && this.tests?.replay) {
        const repeated = this.tests.replay(actor.owner, idempotencyKey, projectId, worktree.path, presetId);
        if (repeated) return repeated;
      }
      const command = this.testCommands.resolve(worktree.path, presetId);
      const environment = resolveTestEnvironment({
        project,
        worktree,
        profile: testProfileFor(project, command.preset),
      });
      const sourceObservation = this.git.observe ? await this.git.observe(worktree.path) : undefined;
      const run = this.requireTests().enqueue({
        projectId,
        worktree,
        command,
        environment,
        actor: actor.owner,
        idempotencyKey,
        sourceObservation,
      });
      this.logs.controller("test_run.queued", {
        runId: run.id,
        projectId,
        worktreePath: worktree.path,
        presetId,
        actor: actor.owner,
        environmentMode: environment.mode,
        environmentProfile: environment.profile,
        inheritedServerProfile: environment.inheritedServerProfile,
        variableNames: environment.variableNames,
      });
      return run;
    });
  }

  async cancelTest(runId: string, actor: OperationActor = { owner: "local-user" }): Promise<TestRun> {
    const run = this.store.getTestRun(runId);
    if (!run) throw new Error("Nie znaleziono uruchomienia testu.");
    this.lifecycle.requireProject(run.projectId);
    const cancelled = await this.requireTests().cancel(runId, actor.owner);
    this.logs.controller("test_run.cancelled", { runId, projectId: run.projectId, actor: actor.owner });
    return cancelled;
  }

  testRun(runId: string): TestRun {
    const run = this.store.getTestRun(runId);
    if (!run) throw new Error("Nie znaleziono uruchomienia testu.");
    return run;
  }

  private requireTests(): NonNullable<VerificationService["tests"]> {
    if (!this.tests) throw new Error("Kolejka testów nie jest dostępna w tym trybie kontrolera.");
    return this.tests;
  }

  discoverPresets(project: Project, worktreePath: string): WorktreeTestPresets {
    try {
      const presets = this.testCommands.discover(worktreePath)
        .map((preset) => ({ ...preset, profile: testProfileFor(project, preset).name }));
      return { worktreePath, presets, error: null };
    } catch (error) {
      return { worktreePath, presets: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
}
