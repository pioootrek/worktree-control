import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { DashboardQueryService } from "./modules/dashboard";
import { EnvironmentService, redactProject } from "./modules/environments";
import type { AuthenticatedPrincipal } from "./modules/identity";
import { KnowledgeService, type KnowledgeHistoryEntry, type KnowledgeHistoryOptions, type KnowledgePageOptions, type KnowledgeRecordKind, type KnowledgeTaskPriority, type KnowledgeTaskStatus, type KnowledgeWriteOptions } from "./modules/knowledge";
import { leaseTokenHash, type OperationActor, ProjectLifecycle } from "./modules/lifecycle";
import { RuntimeService } from "./modules/runtime";
import { StatusService, type CompactProjectStatus, type CompactTestStatus, type CompactEnvelope } from "./modules/status";
import { VerificationService } from "./modules/verification";

import type {
  CacheDeletionResult,
  DashboardLiveResponse,
  DashboardResponse,
  DashboardSection,
  ProjectSnapshot,
  ClaimedRuntimeAction,
  ClaimedRuntimeReceipt,
  ProjectSummary,
  ProjectView,
  RedactedTestEnvironmentProfile,
  Reservation,
  RuntimeMetricsResponse,
  SafeCacheKind,
  ServerCapacitySettings,
  ServerCapacityStatus,
  TestEnvironmentProfile,
  TestQueueStatus,
  TestRun,
} from "@/shared/contracts";
import type { GitWorktreeReader } from "./git-worktrees";
import { type LaunchCommandResolver, type NextTlsConfiguration, ProjectLaunchCommandResolver } from "./launch-command";
import { type LogWriter, nullLogWriter } from "./log-writer";
import { ProcessManager } from "./process-manager";
import type { NewProject, ReservationRequest, StateStore } from "./state-store";
import { ProjectTestCommandResolver } from "./test-command";
import type { TestJobManager } from "./test-job-manager";
import { AllowlistedWorktreeCacheCleaner, type WorktreeCacheCleaner, type WorktreeStorageManager } from "./worktree-storage";

const AGENT_LEASE_DEFAULT_SECONDS = 30 * 60;
const AGENT_LEASE_MAX_SECONDS = 8 * 60 * 60;
export interface AgentClaimRequest {
  projectId: string;
  worktreePath: string;
  owner: string;
  reason: string;
  idempotencyKey: string;
  ttlSeconds?: number;
}

export interface AgentClaimResult {
  reservation: Reservation;
  leaseToken: string;
  snapshot: ProjectSnapshot | null;
  operationError: string | null;
  operationErrorCode: string | null;
}

export class ControlService {
  private readonly lifecycle: ProjectLifecycle;
  private readonly runtime: RuntimeService;
  private readonly environments: EnvironmentService;
  private readonly verification: VerificationService;
  private readonly dashboardQueries: DashboardQueryService;
  private readonly statusQueries: StatusService;

  constructor(
    private readonly store: StateStore,
    private readonly git: GitWorktreeReader,
    private readonly processes: ProcessManager,
    private readonly logs: LogWriter = nullLogWriter,
    private readonly commands: LaunchCommandResolver = new ProjectLaunchCommandResolver(),
    private readonly storage?: WorktreeStorageManager,
    private readonly cacheCleaner: WorktreeCacheCleaner = new AllowlistedWorktreeCacheCleaner(),
    testCommands: ProjectTestCommandResolver = new ProjectTestCommandResolver(),
    private readonly tests?: TestJobManager,
    lifecycle?: ProjectLifecycle,
    private readonly knowledge?: KnowledgeService,
  ) {
    this.lifecycle = lifecycle ?? new ProjectLifecycle(store, processes);
    this.storage?.assertLifecycle(this.lifecycle);
    this.runtime = new RuntimeService(store, git, processes, logs, commands, this.lifecycle);
    this.environments = new EnvironmentService(store, logs, this.lifecycle, this.runtime);
    this.verification = new VerificationService(store, git, logs, testCommands, this.lifecycle, tests);
    this.dashboardQueries = new DashboardQueryService({
      store,
      git,
      processes,
      storage,
      discoverPresets: (project, worktreePath) => this.verification.discoverPresets(project, worktreePath),
      capacity: (projects) => this.lifecycle.capacityStatus(projects),
      testQueue: () => this.testQueueStatus(),
    });
    this.statusQueries = new StatusService(store, processes,
      () => this.lifecycle.capacityStatusCompact(), () => this.testQueueStatus());
  }

  executeKnowledge(input: unknown, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().execute(input, actor);
  }

  knowledgeThreads(projectId: string, actor: AuthenticatedPrincipal, options?: KnowledgePageOptions) {
    return this.requireKnowledge().listThreads(projectId, actor, options);
  }

  knowledgeThread(projectId: string, threadId: string, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().thread(projectId, threadId, actor);
  }

  knowledgeReplies(projectId: string, threadId: string, actor: AuthenticatedPrincipal, options?: KnowledgePageOptions) {
    return this.requireKnowledge().listReplies(projectId, threadId, actor, options);
  }

  knowledgeTasks(projectId: string, actor: AuthenticatedPrincipal, options?: KnowledgePageOptions) {
    return this.requireKnowledge().listTasks(projectId, actor, options);
  }

  knowledgeTask(projectId: string, taskId: string, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().task(projectId, taskId, actor);
  }

  knowledgeRelations(projectId: string, recordKind: KnowledgeRecordKind, recordId: string, actor: AuthenticatedPrincipal, options?: KnowledgePageOptions) {
    return this.requireKnowledge().relations(projectId, recordKind, recordId, actor, options);
  }

  knowledgeHistory(projectId: string, recordKind: KnowledgeHistoryEntry["recordKind"], recordId: string, actor: AuthenticatedPrincipal, options?: KnowledgeHistoryOptions) {
    return this.requireKnowledge().history(projectId, recordKind, recordId, actor, options);
  }

  createKnowledgeThread(projectId: string, input: { title: string; body: string }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().createThread(projectId, input, options, actor);
  }

  createKnowledgeReply(projectId: string, threadId: string, input: { body: string }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().createReply(projectId, threadId, input, options, actor);
  }

  createKnowledgeTaskFromThread(projectId: string, threadId: string, input: { title: string; description: string; priority?: KnowledgeTaskPriority }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().createTaskFromThread(projectId, threadId, input, options, actor);
  }

  updateKnowledgeTask(projectId: string, taskId: string, input: { title: string; description: string; status: KnowledgeTaskStatus; priority: KnowledgeTaskPriority; expectedRevision: number }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().updateTask(projectId, taskId, input, options, actor);
  }

  archiveKnowledgeProject(projectId: string, expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().archiveProject(projectId, expectedRevision, options, actor);
  }

  restoreKnowledgeProject(projectId: string, expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().restoreProject(projectId, expectedRevision, options, actor);
  }

  setKnowledgeProjectRuntimeLink(projectId: string, runtimeProjectId: string | null, expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().setRuntimeLink(projectId, runtimeProjectId, expectedRevision, options, actor);
  }

  private requireKnowledge(): KnowledgeService {
    if (!this.knowledge) throw new Error("Serwis wiedzy nie jest dostępny.");
    return this.knowledge;
  }

  async dashboard(): Promise<DashboardResponse> {
    return this.dashboardQueries.dashboard();
  }

  dashboardLive(projectIds: string[], sections: DashboardSection[]): DashboardLiveResponse {
    return this.dashboardQueries.live(projectIds, sections);
  }

  projectSummaries(): ProjectSummary[] {
    return this.dashboardQueries.projectSummaries();
  }

  serverCapacity(): ServerCapacityStatus {
    return this.lifecycle.capacityStatus();
  }

  runtimeMetrics(): RuntimeMetricsResponse {
    return {
      projects: this.store.listProjects().map((project) => ({
        projectId: project.id,
        resources: this.processes.snapshot(project.id).resources,
      })),
    };
  }

  setServerCapacity(settings: ServerCapacitySettings): ServerCapacityStatus {
    if (typeof settings.enabled !== "boolean" || !Number.isInteger(settings.limit) || settings.limit < 1 || settings.limit > 64) {
      throw new Error("Limit serwerów musi być liczbą całkowitą od 1 do 64.");
    }
    this.store.setServerCapacitySettings(settings);
    this.logs.controller("server_capacity.updated", { ...settings });
    return this.lifecycle.capacityStatus();
  }

  testQueueStatus(): TestQueueStatus {
    return this.verification.testQueueStatus();
  }

  setTestQueueLimit(limit: number): TestQueueStatus {
    return this.verification.setTestQueueLimit(limit);
  }

  async enqueueTest(
    projectId: string,
    worktreePath: string,
    presetId: string,
    actor: OperationActor = { owner: "local-user" },
    idempotencyKey?: string,
  ): Promise<TestRun> {
    return this.verification.enqueueTest(projectId, worktreePath, presetId, actor, idempotencyKey);
  }

  cancelTest(runId: string, actor: OperationActor = { owner: "local-user" }): Promise<TestRun> {
    return this.verification.cancelTest(runId, actor);
  }

  testRun(runId: string): TestRun {
    return this.verification.testRun(runId);
  }

  compactProjectStatus(projectId: string, owner: string): CompactEnvelope<CompactProjectStatus> {
    return this.statusQueries.project(projectId, owner);
  }

  compactTestRunStatus(runId: string): CompactEnvelope<CompactTestStatus> {
    return this.statusQueries.test(runId);
  }

  runtimeLogs(projectId: string, limit?: number) {
    return this.statusQueries.logs(projectId, limit);
  }

  waitForStatusChange(input: { projectId?: string; runId?: string; cursor: string; timeoutMs?: number }, owner: string, signal?: AbortSignal) {
    const target = input.projectId ? { kind: "project" as const, id: input.projectId } : { kind: "run" as const, id: input.runId! };
    return this.statusQueries.wait(target, input.cursor, owner, input.timeoutMs, signal);
  }

  async addProject(input: NewProject): Promise<ProjectView> {
    if (!input.name.trim()) throw new Error("Nazwa projektu jest wymagana.");
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
      throw new Error("Port musi być liczbą od 1024 do 65535.");
    }
    const repositoryPath = await this.git.canonicalRepositoryPath(resolve(input.repositoryPath));
    const worktrees = await this.git.list(repositoryPath);
    const selected = worktrees[0];
    if (!selected) throw new Error("Repozytorium nie ma dostępnego worktree.");
    const launchPreset = input.launchPreset ?? "auto";
    const command = this.commands.resolve(selected.path, input.port, launchPreset);
    const project = this.store.addProject({
      ...input,
      name: input.name.trim(),
      repositoryPath,
      launchPreset: command.preset,
      executable: command.executable,
      args: command.args,
    });
    this.store.setSelectedWorktree(project.id, selected.path);
    this.logs.controller("project.added", {
      projectId: project.id,
      repositoryPath,
      port: input.port,
      executable: command.executable,
      args: command.args,
      portMethod: command.portMethod,
    });
    return redactProject(this.lifecycle.requireProject(project.id));
  }

  async removeProject(projectId: string, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    return this.lifecycle.serialized(projectId, async () => {
      const project = this.lifecycle.requireProject(projectId);
      if (this.store.countTestRuns(["queued", "running"], projectId) > 0) {
        throw new Error("Anuluj testy projektu przed jego usunięciem.");
      }
      this.lifecycle.assertReservationAllows(
        projectId,
        this.processes.snapshot(projectId).worktreePath ?? project.selectedWorktreePath,
        actor,
      );
      await this.processes.stop(projectId);
      this.store.removeProject(projectId, actor.owner);
      await this.tests?.pruneLogs();
      this.logs.controller("project.removed", {
        projectId: project.id,
        repositoryPath: project.repositoryPath,
        port: project.port,
        actor: actor.owner,
      });
      this.dashboardQueries.remove(project.repositoryPath);
      return redactProject(project);
    });
  }

  async operate(
    projectId: string,
    operation: "start" | "stop" | "restart" | "switch",
    worktreePath?: string,
    actor: OperationActor = { owner: "local-user" },
  ): Promise<void> {
    return this.runtime.operate(projectId, operation, worktreePath, actor);
  }

  async operateClaimedRuntime(
    projectId: string, reservationId: string, action: ClaimedRuntimeAction, actor: OperationActor,
    signal?: AbortSignal, sessionClosed?: () => boolean,
  ): Promise<ClaimedRuntimeReceipt> {
    return this.runtime.operateClaimed(projectId, reservationId, action, actor, signal, sessionClosed);
  }

  async setProjectTls(projectId: string, input: NextTlsConfiguration): Promise<void> {
    await this.runtime.setProjectTls(projectId, input);
    this.invalidateDashboardMetadata(projectId);
  }

  async setProjectEnvironment(projectId: string, environment: Record<string, string>, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const project = await this.environments.setProjectEnvironment(projectId, environment, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async saveEnvironmentProfile(projectId: string, name: string, environment: Record<string, string>, actor: OperationActor = { owner: "local-user" }, restart = false): Promise<ProjectView> {
    const project = await this.environments.saveEnvironmentProfile(projectId, name, environment, actor, restart);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async selectEnvironmentProfile(projectId: string, name: string, actor: OperationActor = { owner: "local-user" }, restart = false): Promise<ProjectView> {
    const project = await this.environments.selectEnvironmentProfile(projectId, name, actor, restart);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async deleteEnvironmentProfile(projectId: string, name: string, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const project = await this.environments.deleteEnvironmentProfile(projectId, name, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  testEnvironmentProfiles(projectId: string): {
    profiles: RedactedTestEnvironmentProfile[];
    presetProfiles: Record<string, string>;
    systemVariableNames: string[];
  }{
    return this.environments.testEnvironmentProfiles(projectId);
  }

  async saveTestEnvironmentProfile(
    projectId: string,
    input: { name: string; environment: Record<string, string>; mode?: TestEnvironmentProfile["policy"]["mode"]; serverProfile?: string | null; nodeEnv?: TestEnvironmentProfile["nodeEnv"]; requiredVariables?: string[] },
    actor: OperationActor = { owner: "local-user" },
  ): Promise<ProjectView> {
    const project = await this.environments.saveTestEnvironmentProfile(projectId, input, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async deleteTestEnvironmentProfile(projectId: string, name: string, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const project = await this.environments.deleteTestEnvironmentProfile(projectId, name, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async assignTestPresetProfile(projectId: string, presetId: string, name: string | null, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const project = await this.environments.assignTestPresetProfile(projectId, presetId, name, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async reserve(input: ReservationRequest): Promise<void> {
    await this.lifecycle.serialized(input.projectId, async () => {
      const project = this.lifecycle.requireProject(input.projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.lifecycle.resolveWorktree(project, worktrees, input.worktreePath);
      this.store.acquireReservation({ ...input, worktreePath: selected.path });
      this.logs.controller("reservation.acquired", { projectId: input.projectId, worktreePath: selected.path, owner: input.owner });
    });
  }

  async release(projectId: string, force = false): Promise<void> {
    await this.lifecycle.serialized(projectId, async () => {
      this.lifecycle.requireProject(projectId);
      this.store.releaseReservation(projectId, "local-user", force);
      this.logs.controller(force ? "reservation.force_released" : "reservation.released", { projectId });
    });
  }

  async claimProject(input: AgentClaimRequest, existingLeaseToken?: string, includeSnapshot = true): Promise<AgentClaimResult> {
    return this.lifecycle.serialized(input.projectId, async () => {
      const ttlSeconds = input.ttlSeconds ?? AGENT_LEASE_DEFAULT_SECONDS;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > AGENT_LEASE_DEFAULT_SECONDS) {
        throw new Error(`Agent lease TTL must be between 30 and ${AGENT_LEASE_DEFAULT_SECONDS} seconds.`);
      }
      if (!input.owner.startsWith("agent:mcp:")) throw new Error("Invalid MCP agent owner.");
      if (!input.reason.trim()) throw new Error("A claim reason is required.");
      if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 120) throw new Error("Invalid idempotency key.");

      const project = this.lifecycle.requireProject(input.projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.lifecycle.resolveWorktree(project, worktrees, input.worktreePath);
      const leaseToken = existingLeaseToken ?? randomBytes(32).toString("base64url");
      const reservation = this.store.acquireReservation({
        projectId: input.projectId,
        worktreePath: selected.path,
        kind: "agent",
        owner: input.owner,
        reason: input.reason.trim(),
        ttlSeconds,
        maximumLifetimeSeconds: AGENT_LEASE_MAX_SECONDS,
        leaseTokenHash: leaseTokenHash(leaseToken),
        idempotencyKey: input.idempotencyKey,
      });

      let operationError: string | null = null;
      let operationErrorCode: string | null = null;
      let operationStage: "reservation" | "capacity" | "runtime" = "reservation";
      try {
        this.lifecycle.assertReservationAllows(input.projectId, selected.path, { owner: input.owner, leaseToken });
        const runtime = this.processes.snapshot(input.projectId);
        if (runtime.phase !== "running" || runtime.worktreePath !== selected.path) {
          operationStage = "capacity";
          this.lifecycle.acquireCapacity(project);
          try {
            operationStage = "runtime";
            if (runtime.phase !== "stopped") await this.processes.stop(input.projectId);
            if (project.selectedWorktreePath !== selected.path) this.store.setSelectedWorktree(input.projectId, selected.path);
            await this.processes.start(this.lifecycle.requireProject(input.projectId), selected.path);
          } finally {
            this.lifecycle.releaseCapacity(input.projectId);
          }
        }
      } catch (error) {
        operationError = error instanceof Error ? error.message : String(error);
        operationErrorCode = (this.processes.statusSummary?.(input.projectId).failureCode
          ?? this.processes.snapshot(input.projectId).failure?.code)
          ?? (operationStage === "capacity" ? "capacity_exhausted"
            : operationStage === "reservation" ? "reservation_conflict" : "runtime_operation_failed");
        this.logs.controller("agent.claim_switch_failed", {
          projectId: input.projectId,
          reservationId: reservation.id,
          owner: input.owner,
          error: operationError,
        });
      }
      this.logs.controller("agent.claimed", {
        projectId: input.projectId,
        reservationId: reservation.id,
        owner: input.owner,
        worktreePath: selected.path,
      });
      return {
        reservation,
        leaseToken,
        snapshot: includeSnapshot ? await this.dashboardQueries.projectSnapshot(this.lifecycle.requireProject(input.projectId)) : null,
        operationError,
        operationErrorCode,
      };
    });
  }

  renewAgentClaim(projectId: string, reservationId: string, owner: string, leaseToken: string, ttlSeconds = AGENT_LEASE_DEFAULT_SECONDS): Reservation {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > AGENT_LEASE_DEFAULT_SECONDS) {
      throw new Error(`Agent lease TTL must be between 30 and ${AGENT_LEASE_DEFAULT_SECONDS} seconds.`);
    }
    const reservation = this.store.renewAgentReservation(
      projectId,
      reservationId,
      owner,
      leaseTokenHash(leaseToken),
      ttlSeconds,
    );
    this.logs.controller("agent.claim_renewed", { projectId, reservationId, owner, expiresAt: reservation.expiresAt });
    return reservation;
  }

  async releaseAgentClaim(projectId: string, reservationId: string, owner: string, leaseToken: string): Promise<void> {
    await this.lifecycle.serialized(projectId, async () => {
      this.lifecycle.requireProject(projectId);
      this.lifecycle.requireAgentClaim(projectId, reservationId, { owner, leaseToken });
      this.store.releaseAgentReservation(projectId, reservationId, owner, leaseTokenHash(leaseToken));
      this.logs.controller("agent.claim_released", { projectId, reservationId, owner });
    });
  }

  async projectSnapshot(projectId: string): Promise<ProjectSnapshot> {
    return this.dashboardQueries.projectSnapshot(this.lifecycle.requireProject(projectId));
  }

  async refreshProjectMetadata(projectId: string): Promise<ProjectSnapshot> {
    return this.dashboardQueries.refresh(this.lifecycle.requireProject(projectId));
  }

  async refreshWorktreeStorage(projectId: string, worktreePath: string): Promise<void> {
    await this.lifecycle.serialized(projectId, async () => {
      const project = this.lifecycle.requireProject(projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.lifecycle.resolveWorktree(project, worktrees, worktreePath);
      this.storage?.queue(project.id, selected.path, true);
      this.logs.controller("worktree_storage.refresh_requested", { projectId, worktreePath: selected.path });
    });
  }

  async deleteWorktreeCache(projectId: string, worktreePath: string, cache: SafeCacheKind): Promise<CacheDeletionResult> {
    return this.lifecycle.serialized(projectId, async () => {
      const project = this.lifecycle.requireProject(projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.lifecycle.resolveWorktree(project, worktrees, worktreePath);
      const auditDetails = { worktreePath: selected.path, cache, target: `${selected.path}/.next` };
      let releaseMaintenance: (() => void) | null = null;
      try {
        const runtime = this.processes.snapshot(projectId);
        if (
          runtime.worktreePath === selected.path
          && (runtime.phase === "starting" || runtime.phase === "running" || runtime.phase === "stopping")
        ) {
          throw new Error("Zatrzymaj serwer tego worktree przed usunięciem katalogu .next.");
        }
        const reservation = this.store.getActiveReservation(projectId);
        if (reservation?.worktreePath === selected.path) {
          throw new Error("Zwolnij blokadę tego worktree przed usunięciem katalogu .next.");
        }
        if (this.storage?.isBusy(projectId, selected.path)) {
          throw new Error("Poczekaj na zakończenie pomiaru dysku przed usunięciem katalogu .next.");
        }
        if (this.store.countTestRuns(["queued", "running"], projectId, selected.path) > 0) {
          throw new Error("Poczekaj na zakończenie testów tego worktree przed usunięciem katalogu .next.");
        }
        releaseMaintenance = this.lifecycle.acquireMaintenance(projectId, selected.path);
        if (!releaseMaintenance) {
          throw new Error("Poczekaj na zakończenie pomiaru dysku przed usunięciem katalogu .next.");
        }
        const result = await this.cacheCleaner.remove(selected.path, cache);
        this.store.recordProjectEvent(projectId, "worktree_cache.delete_succeeded", "local-user", { ...auditDetails, removed: result.removed });
        releaseMaintenance();
        releaseMaintenance = null;
        this.storage?.queue(projectId, selected.path, true);
        this.logs.controller("worktree_cache.deleted", { projectId, ...auditDetails, removed: result.removed });
        return result;
      } catch (error) {
        this.store.recordProjectEvent(projectId, "worktree_cache.delete_failed", "local-user", {
          ...auditDetails,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        releaseMaintenance?.();
      }
    });
  }

  async shutdown(): Promise<void> {
    const failures: unknown[] = [];
    await this.lifecycle.closeAndDrain();
    const cleanup = await Promise.allSettled([this.tests?.shutdown(), this.processes.stopAll()]);
    failures.push(...cleanup.filter((result) => result.status === "rejected").map((result) => result.reason));
    try {
      await this.storage?.close();
    } catch (error) {
      failures.push(error);
    }
    this.statusQueries.close();
    this.dashboardQueries.close();
    this.git.close?.();
    try {
      this.store.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.logs.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Nie zakończono poprawnie wszystkich zasobów kontrolera.");
  }

  private invalidateDashboardMetadata(projectId: string): void {
    this.dashboardQueries.invalidate(this.lifecycle.requireProject(projectId).repositoryPath);
  }

}
