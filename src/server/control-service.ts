import { HumanRuntimeService } from "./modules/runtime";
import type { ProviderSessionActor } from "./modules/identity";
import type { DatabaseAdmissionOptions } from "./database-admission";
import type { RuntimeMutateResult } from "@/shared/contracts/runtime-mutate";
import { scopedWaitSchema } from "@/shared/contracts/scoped-verification";
import { randomBytes } from "node:crypto";
import { DashboardQueryService } from "./modules/dashboard";
import { EnvironmentService, redactProject, ScopedConfigurationService, type ScopedConfigurationSession } from "./modules/environments";
import type { AuthenticatedPrincipal } from "./modules/identity";
import { KnowledgeService, type KnowledgeHistoryEntry, type KnowledgeHistoryOptions, type KnowledgePageOptions, type KnowledgeRecordKind, type KnowledgeTaskPriority, type KnowledgeTaskStatus, type KnowledgeWriteOptions } from "./modules/knowledge";
import { leaseTokenHash, type OperationActor, ProjectLifecycle } from "./modules/lifecycle";
import { AGENT_LEASE_DEFAULT_SECONDS, AGENT_LEASE_MAX_SECONDS, RuntimeService, ScopedRuntimeService, ScopedRuntimeError, RuntimeAccessDenied, type RuntimeAuthorizer, type ScopedClaimRequest, type ScopedSession } from "./modules/runtime";
import { StatusService, type CompactProjectStatus, type CompactTestStatus, type CompactEnvelope } from "./modules/status";
import { VerificationService, VerificationHistoryService, ScopedVerificationService } from "./modules/verification";
import type { RemoteVerificationController } from "./modules/remote-verification";
import type { GodotWebService } from "./modules/godot-web";
import { DEFAULT_GODOT_WEB_CONFIG, parseGodotWebConfig, type WebExportStatus } from "@/shared/contracts/godot-web";

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
import { NO_SERVER_MESSAGE, type LaunchCommandResolver, type NextTlsConfiguration, ProjectLaunchCommandResolver } from "./launch-command";
import { type LogWriter, nullLogWriter } from "./log-writer";
import { ProcessManager } from "./process-manager";
import { discoverProjectRegistrationTarget } from "./project-registration";
import type { NewProject, ReservationRequest, StateStore } from "./state-store";
import { admissionOf, type DatabaseAdmission } from "./database-admission";
import { ProjectTestCommandResolver } from "./test-command";
import type { TestJobManager } from "./test-job-manager";
import { AllowlistedWorktreeCacheCleaner, type WorktreeCacheCleaner, type WorktreeStorageManager } from "./worktree-storage";

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
  private readonly verificationHistory: VerificationHistoryService;
  private readonly dashboardQueries: DashboardQueryService;
  private readonly statusQueries: StatusService;
  private readonly scopedVerification?: ScopedVerificationService;
  private readonly humanRuntime?: HumanRuntimeService;
  private readonly scopedRuntime?: ScopedRuntimeService;
  private readonly scopedConfiguration?: ScopedConfigurationService;

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
    private readonly remoteVerification?: RemoteVerificationController,
    runtimeAuthorizer?: RuntimeAuthorizer,
    private readonly godotWeb?: GodotWebService,
  ) {
    this.lifecycle = lifecycle ?? new ProjectLifecycle(store, processes);
    this.storage?.assertLifecycle(this.lifecycle);
    this.runtime = new RuntimeService(store, git, processes, logs, commands, this.lifecycle);
    this.environments = new EnvironmentService(store, logs, this.lifecycle, this.runtime);
    this.verificationHistory = new VerificationHistoryService(store);
    this.verification = new VerificationService(store, git, logs, testCommands, this.lifecycle, tests);
    this.dashboardQueries = new DashboardQueryService({
      store,
      git,
      processes,
      storage,
      discoverPresets: (project, worktreePath) => this.verification.discoverPresets(project, worktreePath),
      capacity: (projects) => this.lifecycle.capacityStatus(projects),
      testQueue: () => this.testQueueStatus(),
      webExport: (projectId) => this.godotWeb?.status(projectId) ?? null,
    });
    this.statusQueries = new StatusService(store, processes,
      () => this.lifecycle.capacityStatusCompact(), () => this.testQueueStatus());
    if (runtimeAuthorizer?.resolveHumanRuntimeAuthority && store.humanRuntime) {
      this.humanRuntime = new HumanRuntimeService({ resolveHumanRuntimeAuthority: runtimeAuthorizer.resolveHumanRuntimeAuthority.bind(runtimeAuthorizer) },
        store, store.humanRuntime(), git, this.lifecycle, this.runtime);
    }
    if (runtimeAuthorizer) {
      this.scopedVerification = new ScopedVerificationService(runtimeAuthorizer, store, git, testCommands, this.verification, tests);
      this.scopedRuntime = new ScopedRuntimeService(runtimeAuthorizer, store, git, processes, this.lifecycle, this.runtime, logs);
      this.scopedConfiguration = new ScopedConfigurationService(runtimeAuthorizer, store, git, processes, this.lifecycle,
        worktreePath => testCommands.discover(worktreePath), logs);
    }
  }

  /** Core admission of the store this facade operates on; transports admit each request with it. */
  get admission(): DatabaseAdmission { return admissionOf(this.store); }

  /** Scoped agent runtime access; enforcement and safe views live in the runtime module. */
  scopedRuntimeEnabled(): boolean { return !!this.scopedRuntime; }
  scopedProjects(actor: AuthenticatedPrincipal, session: ScopedSession | null) { return this.requireScopedRuntime().listProjects(actor, session).map(project => actor.authenticationMethod === "provider_session"
    && this.humanRuntime?.ownClaim(actor, project.id) ? { ...project, claim: "own" as const } : project); }
  scopedProjectStatus(actor: AuthenticatedPrincipal, session: ScopedSession | null, projectId: string) { const status = this.requireScopedRuntime().projectStatus(actor, session, projectId);
    const ownClaim = actor.authenticationMethod === "provider_session" ? this.humanRuntime?.ownClaim(actor, projectId) : null;
    return ownClaim ? { ...status, claim: "own" as const, ownClaim } : status; }
  mutateHumanRuntime(actor: ProviderSessionActor, value: unknown, options?: DatabaseAdmissionOptions, deliver?: (result: RuntimeMutateResult) => void): Promise<RuntimeMutateResult> {
    if (!this.humanRuntime) return Promise.reject(new RuntimeAccessDenied());
    return this.humanRuntime.execute(value, actor, options, deliver);
  }
  scopedCompactProjectStatus(actor: AuthenticatedPrincipal, session: ScopedSession, projectId: string) {
    // Cursor/wait binding remains the established machine session contract.
    if (actor.authenticationMethod === "provider_session") throw new RuntimeAccessDenied();
    const status = this.requireScopedRuntime().compactProjectStatus(actor, session, projectId);
    return this.statusQueries.scopedProject(status, JSON.stringify([actor.principalId, actor.credentialId, session.owner]));
  }
  waitForScopedStatusChange(actor: AuthenticatedPrincipal, session: ScopedSession,
    input: { projectId: string; cursor: string; timeoutMs?: number }, signal?: AbortSignal, sessionClosed?: () => boolean) {
    if (actor.authenticationMethod === "provider_session") throw new RuntimeAccessDenied();
    return this.statusQueries.wait({ kind: "scoped-project", id: input.projectId, read: () => {
      if (sessionClosed?.()) throw new Error("STATUS_CLOSED");
      return this.scopedCompactProjectStatus(actor, session, input.projectId);
    } }, input.cursor, session.owner, input.timeoutMs, signal);
  }
  scopedWorktrees(actor: AuthenticatedPrincipal, projectId: string, signal?: AbortSignal) { return this.requireScopedRuntime().worktrees(actor, projectId, signal); }
  claimScopedProject(actor: AuthenticatedPrincipal, session: ScopedSession, input: ScopedClaimRequest, existingLeaseToken?: string) {
    return this.requireScopedRuntime().claim(actor, session, input, existingLeaseToken);
  }
  renewScopedClaim(actor: AuthenticatedPrincipal, session: ScopedSession, projectId: string, reservationId: string, leaseToken: string, ttlSeconds?: number) {
    return this.requireScopedRuntime().renew(actor, session, projectId, reservationId, leaseToken, ttlSeconds);
  }
  releaseScopedClaim(actor: AuthenticatedPrincipal, session: ScopedSession, projectId: string, reservationId: string, leaseToken: string) {
    return this.requireScopedRuntime().release(actor, session, projectId, reservationId, leaseToken);
  }
  operateScopedRuntime(actor: AuthenticatedPrincipal, session: ScopedSession, leaseToken: string, projectId: string, reservationId: string, action: ClaimedRuntimeAction, signal?: AbortSignal, sessionClosed?: () => boolean) {
    return this.requireScopedRuntime().operate(actor, session, leaseToken, projectId, reservationId, action, signal, sessionClosed);
  }
  authorizeScopedRuntimeReplay(...args: Parameters<ScopedRuntimeService["authorizeReplay"]>): void {
    this.requireScopedRuntime().authorizeReplay(...args);
  }
  scopedTestPresets(actor: AuthenticatedPrincipal, input: unknown) { return this.requireScopedVerification().presets(actor, input); }
  enqueueScopedTest(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, input: unknown) {
    return this.requireScopedVerification().enqueue(actor, session, input);
  }
  scopedTestRun(actor: AuthenticatedPrincipal, session: ScopedSession, input: unknown) {
    const status = this.requireScopedVerification().status(actor, input);
    return this.statusQueries.scopedTest(status, JSON.stringify([actor.principalId, actor.credentialId, session.owner]));
  }
  async cancelScopedTest(actor: AuthenticatedPrincipal, session: ScopedSession, input: unknown) {
    await this.requireScopedVerification().cancel(actor, session, input);
    return this.scopedTestRun(actor, session, input);
  }
  waitForScopedTestChange(actor: AuthenticatedPrincipal, session: ScopedSession,
    value: unknown, signal?: AbortSignal, sessionClosed?: () => boolean) {
    const parsed = scopedWaitSchema.safeParse(value);
    if (!parsed.success || !parsed.data.runId) throw new ScopedRuntimeError("invalid_request", "Exactly one run status target is required.");
    const input = { ...parsed.data, runId: parsed.data.runId };
    return this.statusQueries.wait({ kind: "scoped-run", id: input.runId, read: () => {
      if (sessionClosed?.()) throw new Error("STATUS_CLOSED");
      return this.scopedTestRun(actor, session, { runId: input.runId });
    } }, input.cursor, session.owner, input.timeoutMs, signal);
  }
  private requireScopedVerification(): ScopedVerificationService {
    if (!this.scopedVerification) throw new Error("Scoped verification is unavailable.");
    return this.scopedVerification;
  }

  /** Scoped profile selection and configuration; enforcement, revision CAS and safe views live in the environments module. */
  scopedEnvironmentProfiles(actor: AuthenticatedPrincipal, input: unknown) { return this.requireScopedConfiguration().listEnvironmentProfiles(actor, input); }
  selectScopedEnvironmentProfile(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, input: unknown) {
    return this.requireScopedConfiguration().selectEnvironmentProfile(actor, session, input);
  }
  scopedProjectConfiguration(actor: AuthenticatedPrincipal, input: unknown) { return this.requireScopedConfiguration().projectConfiguration(actor, input); }
  async setScopedTestPresetTimeout(actor: AuthenticatedPrincipal, session: ScopedConfigurationSession, input: unknown) {
    const receipt = await this.requireScopedConfiguration().setTestPresetTimeout(actor, session, input);
    if (receipt.outcome === "completed") this.invalidateDashboardMetadata(receipt.projectId);
    return receipt;
  }
  authorizeScopedConfiguration(...args: Parameters<ScopedConfigurationService["authorize"]>): void {
    this.requireScopedConfiguration().authorize(...args);
  }
  authorizeScopedConfigurationReplay(...args: Parameters<ScopedConfigurationService["authorizeReplay"]>): void {
    this.requireScopedConfiguration().authorizeReplay(...args);
  }
  private requireScopedConfiguration(): ScopedConfigurationService {
    if (!this.scopedConfiguration) throw new Error("Scoped agent configuration is unavailable.");
    return this.scopedConfiguration;
  }
  private requireScopedRuntime(): ScopedRuntimeService {
    if (!this.scopedRuntime) throw new Error("Scoped agent runtime access is unavailable.");
    return this.scopedRuntime;
  }

  executeKnowledge(input: unknown, actor: AuthenticatedPrincipal) {
    return this.requireKnowledge().execute(input, actor);
  }

  remoteVerificationEnabled(): boolean { return !!this.remoteVerification; }
  submitRemoteVerification(input: unknown, actor: AuthenticatedPrincipal) { return this.requireRemoteVerification().submit(input, actor); }
  getRemoteVerification(requestId: string, actor: AuthenticatedPrincipal) { return this.requireRemoteVerification().status(requestId, actor); }
  cancelRemoteVerification(requestId: string, actor: AuthenticatedPrincipal) { return this.requireRemoteVerification().cancel(requestId, actor); }
  private requireRemoteVerification(): RemoteVerificationController {
    if (!this.remoteVerification) throw new Error("Remote verification is not enabled.");
    return this.remoteVerification;
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

  listTestHistory(input: unknown) { return this.verificationHistory.list(input); }
  testRunSummary(input: unknown) { return this.verificationHistory.summary(input); }
  testMetrics(input: unknown) { return this.verificationHistory.metrics(input); }
  compareTestRuns(input: unknown) { return this.verificationHistory.compare(input); }

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

  statusWaitDiagnostics(owner?: string) { return this.statusQueries.diagnostics(owner); }
  cancelStatusWaits(owner: string) { this.statusQueries.cancelSession(owner); }

  waitForStatusChange(input: { projectId?: string; runId?: string; cursor: string; timeoutMs?: number }, owner: string, signal?: AbortSignal) {
    const target = input.projectId ? { kind: "project" as const, id: input.projectId } : { kind: "run" as const, id: input.runId! };
    return this.statusQueries.wait(target, input.cursor, owner, input.timeoutMs, signal);
  }

  async addProject(input: NewProject): Promise<ProjectView> {
    if (!input.name.trim()) throw new Error("Nazwa projektu jest wymagana.");
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
      throw new Error("Port musi być liczbą od 1024 do 65535.");
    }
    const { repositoryPath, selectedWorktree: selected } = await discoverProjectRegistrationTarget(this.git, input.repositoryPath);
    const launchPreset = input.launchPreset ?? "auto";
    // Godot Web is explicit opt-in; auto detection never selects it.
    const godotWeb = launchPreset === "godot-web" ? parseGodotWebConfig(input.godotWeb ?? DEFAULT_GODOT_WEB_CONFIG) : null;
    if (input.godotWeb && launchPreset !== "godot-web") throw new Error("Godot Web configuration requires the godot-web preset.");
    if (godotWeb) this.requireGodotWeb().validate(godotWeb, selected.path);
    const command = this.commands.resolve(selected.path, input.port, launchPreset, undefined, { godotWeb });
    const project = this.store.addProject({
      ...input,
      name: input.name.trim(),
      repositoryPath,
      launchPreset: command.preset,
      godotWeb,
      executable: command.executable,
      args: command.args,
    });
    if (godotWeb) {
      const launch = this.commands.resolve(selected.path, input.port, "godot-web", undefined, { projectId: project.id, godotWeb });
      this.store.updateProjectLaunch(project.id, { tlsMode: "off", tlsKeyPath: null, tlsCertPath: null, tlsCaPath: null, executable: launch.executable, args: launch.args });
    }
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
      if (project.launchPreset === "godot-web" && this.godotWeb) {
        // Only the runtime's own export may be cancelled by removal. Refuse
        // unrelated queued/running verification before changing the runtime.
        if (this.store.listPendingTestRuns().some((run) => run.projectId === projectId && !this.godotWeb!.ownsExportRun(projectId, run.id))) {
          throw new Error("Anuluj testy projektu przed jego usunięciem.");
        }
        // Automatic exports belong to the runtime: stop it, cancel its export, then apply the normal test check.
        this.lifecycle.assertReservationAllows(projectId, this.processes.snapshot(projectId).worktreePath ?? project.selectedWorktreePath, actor);
        this.store.assertProjectRemovalAllowed(projectId);
        await this.processes.stop(projectId);
        await this.godotWeb.drain(projectId);
      }
      if (this.store.countTestRuns(["queued", "running"], projectId) > 0) {
        throw new Error("Anuluj testy projektu przed jego usunięciem.");
      }
      this.lifecycle.assertReservationAllows(
        projectId,
        this.processes.snapshot(projectId).worktreePath ?? project.selectedWorktreePath,
        actor,
      );
      this.store.assertProjectRemovalAllowed(projectId);
      await this.processes.stop(projectId);
      this.store.removeProject(projectId, actor.owner);
      // A disabled preview can still have cached generations and staging files.
      await this.godotWeb?.forget(projectId).catch((error: unknown) => {
        this.logs.controller("godot_web.store_cleanup_failed", { projectId, error: String(error) });
      });
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

  async configureGodotWeb(projectId: string, input: unknown, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const project = await this.requireGodotWeb().configure(projectId, input, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  rebuildWebExport(projectId: string, actor: OperationActor = { owner: "local-user" }): Promise<WebExportStatus> {
    return this.requireGodotWeb().rebuild(projectId, actor);
  }

  webExportStatus(projectId: string): WebExportStatus | null {
    this.lifecycle.requireProject(projectId);
    return this.godotWeb?.status(projectId) ?? null;
  }

  private requireGodotWeb(): GodotWebService {
    if (!this.godotWeb) throw new Error("The Godot Web runtime is unavailable in this controller mode.");
    return this.godotWeb;
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

  async setTestPresetTimeout(projectId: string, presetId: string, timeoutMs: number | null, actor: OperationActor = { owner: "local-user" }): Promise<ProjectView> {
    const project = await this.verification.setTestPresetTimeout(projectId, presetId, timeoutMs, actor);
    this.invalidateDashboardMetadata(projectId);
    return project;
  }

  async reserve(input: ReservationRequest, revalidate?: () => void): Promise<void> {
    await this.lifecycle.serialized(input.projectId, async () => {
      revalidate?.();
      const project = this.lifecycle.requireProject(input.projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.lifecycle.resolveWorktree(project, worktrees, input.worktreePath);
      revalidate?.();
      this.store.acquireReservation({ ...input, worktreePath: selected.path });
      this.logs.controller("reservation.acquired", { projectId: input.projectId, worktreePath: selected.path, owner: input.owner });
    });
  }

  async release(projectId: string, force = false, revalidate?: () => void): Promise<void> {
    await this.lifecycle.serialized(projectId, async () => {
      revalidate?.();
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
      if (project.launchPreset === "none") throw new Error(`${NO_SERVER_MESSAGE} Queue tests without a runtime claim.`);
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
            // The lease can expire or be force-released while stop is awaited; never spawn on a stale claim.
            const claimed = { owner: input.owner, leaseToken };
            if (runtime.phase !== "stopped") {
              await this.processes.stop(input.projectId);
              this.lifecycle.requireAgentClaim(input.projectId, reservation.id, claimed);
            }
            if (project.selectedWorktreePath !== selected.path) this.store.setSelectedWorktree(input.projectId, selected.path);
            if (project.launchPreset === "godot-web") {
              // The static server is bound to its worktree; resolve its command for the claimed one.
              const launch = this.commands.resolve(selected.path, project.port, "godot-web", undefined, { projectId: project.id, godotWeb: project.godotWeb });
              if (project.executable !== launch.executable || JSON.stringify(project.args) !== JSON.stringify(launch.args)) {
                this.store.updateProjectLaunch(project.id, { tlsMode: "off", tlsKeyPath: null, tlsCertPath: null, tlsCaPath: null, executable: launch.executable, args: launch.args }, input.owner);
              }
            }
            await this.processes.start(this.lifecycle.requireProject(input.projectId), selected.path,
              () => { this.lifecycle.requireAgentClaim(input.projectId, reservation.id, claimed); });
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
        // Deletion is SQL-free and may be long; the maintenance permit keeps the worktree reserved meanwhile.
        const result = await this.admission.idle(() => this.cacheCleaner.remove(selected.path, cache));
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

  closeAdmission(): void {
    this.lifecycle.closeAdmission();
    this.processes.closeAdmission?.();
  }

  async shutdown(): Promise<void> {
    this.closeAdmission();
    const failures: unknown[] = [];
    // Ending preview sessions first suppresses late publication; the queue then cancels their exports.
    const previews = this.godotWeb?.close();
    const cleanup = await Promise.allSettled([this.lifecycle.closeAndDrain(), this.tests?.shutdown(), this.processes.stopAll(), previews]);
    failures.push(...cleanup.filter((result) => result.status === "rejected").map((result) => result.reason));
    try {
      await this.storage?.close();
    } catch (error) {
      failures.push(error);
    }
    this.statusQueries.close();
    this.dashboardQueries.close();
    this.git.close?.();
    // Unconfirmed process/job/storage cleanup may still need the owned database.
    if (!failures.length) try {
      // Accepted database work, backups and provider executions settle first; a failed drain keeps ownership.
      const owner = this.store as StateStore & { closeAfterDrain?: () => Promise<void> };
      if (owner.closeAfterDrain) await owner.closeAfterDrain();
      else this.store.close();
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
