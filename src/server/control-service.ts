import { createHash, randomBytes } from "node:crypto";
import { basename, resolve } from "node:path";

import type { CacheDeletionResult, DashboardResponse, Project, ProjectSnapshot, Reservation, RuntimeMetricsResponse, SafeCacheKind, ServerCapacitySettings, ServerCapacityStatus, Worktree } from "@/shared/contracts";
import type { GitWorktreeReader } from "./git-worktrees";
import { type LaunchCommandResolver, type NextTlsConfiguration, NodeLaunchCommandResolver } from "./launch-command";
import { type LogWriter, nullLogWriter } from "./log-writer";
import { ProcessManager } from "./process-manager";
import type { NewProject, ReservationRequest, StateStore } from "./state-store";
import { AllowlistedWorktreeCacheCleaner, type WorktreeCacheCleaner, type WorktreeStorageManager } from "./worktree-storage";

const AGENT_LEASE_DEFAULT_SECONDS = 30 * 60;
const AGENT_LEASE_MAX_SECONDS = 8 * 60 * 60;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENVIRONMENT_NAMES = new Set(["PORT", "NODE_ENV"]);
const ENVIRONMENT_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface OperationActor {
  owner: string;
  leaseToken?: string;
}

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
  snapshot: ProjectSnapshot;
  operationError: string | null;
}

function leaseTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class ControlService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly pendingStarts = new Set<string>();

  constructor(
    private readonly store: StateStore,
    private readonly git: GitWorktreeReader,
    private readonly processes: ProcessManager,
    private readonly logs: LogWriter = nullLogWriter,
    private readonly commands: LaunchCommandResolver = new NodeLaunchCommandResolver(),
    private readonly storage?: WorktreeStorageManager,
    private readonly cacheCleaner: WorktreeCacheCleaner = new AllowlistedWorktreeCacheCleaner(),
  ) {}

  async dashboard(): Promise<DashboardResponse> {
    const projects = await Promise.all(this.store.listProjects().map((project) => this.snapshot(project, true)));
    return { projects, capacity: this.capacityStatus(projects) };
  }

  serverCapacity(): ServerCapacityStatus {
    return this.capacityStatus();
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
    return this.capacityStatus();
  }

  async addProject(input: NewProject): Promise<Project> {
    if (!input.name.trim()) throw new Error("Nazwa projektu jest wymagana.");
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
      throw new Error("Port musi być liczbą od 1024 do 65535.");
    }
    const repositoryPath = await this.git.canonicalRepositoryPath(resolve(input.repositoryPath));
    const worktrees = await this.git.list(repositoryPath);
    const selected = worktrees[0];
    if (!selected) throw new Error("Repozytorium nie ma dostępnego worktree.");
    const command = this.commands.resolve(selected.path, input.port);
    const project = this.store.addProject({
      ...input,
      name: input.name.trim(),
      repositoryPath,
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
    return this.requireProject(project.id);
  }

  async operate(
    projectId: string,
    operation: "start" | "stop" | "restart" | "switch",
    worktreePath?: string,
    actor: OperationActor = { owner: "local-user" },
  ): Promise<void> {
    try {
      await this.serialized(projectId, async () => {
        const project = this.requireProject(projectId);
        if (operation === "stop") {
          this.assertReservationAllows(
            projectId,
            this.processes.snapshot(projectId).worktreePath ?? project.selectedWorktreePath,
            actor,
          );
          await this.processes.stop(projectId);
          this.logs.controller("project.stopped", { projectId });
          return;
        }
        const worktrees = await this.git.list(project.repositoryPath);
        const selected = this.resolveWorktree(project, worktrees, worktreePath);
        this.assertReservationAllows(projectId, selected.path, actor);
        this.acquireCapacity(project);
        try {
          if (operation === "restart" || operation === "switch") await this.processes.stop(projectId);
          if (operation === "switch") this.store.setSelectedWorktree(projectId, selected.path);
          await this.processes.start(this.requireProject(projectId), selected.path);
        } finally {
          this.pendingStarts.delete(projectId);
        }
        this.logs.controller(`project.${operation}`, { projectId, worktreePath: selected.path });
      });
    } catch (error) {
      this.logs.controller("project.operation_failed", {
        projectId,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setProjectTls(projectId: string, input: NextTlsConfiguration): Promise<void> {
    await this.serialized(projectId, async () => {
      const project = this.requireProject(projectId);
      const phase = this.processes.snapshot(projectId).phase;
      if (phase === "running" || phase === "starting" || phase === "stopping") {
        throw new Error("Zatrzymaj serwer przed zmianą ustawień HTTPS.");
      }
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.resolveWorktree(project, worktrees);
      this.assertReservationAllows(projectId, selected.path, { owner: "local-user" });
      const command = this.commands.resolve(selected.path, project.port, input);
      this.store.updateProjectLaunch(projectId, {
        tlsMode: command.tls.mode,
        tlsKeyPath: command.tls.keyPath,
        tlsCertPath: command.tls.certPath,
        tlsCaPath: command.tls.caPath,
        executable: command.executable,
        args: command.args,
      });
      this.logs.controller("project.tls_changed", {
        projectId,
        mode: command.tls.mode,
        keyPath: command.tls.keyPath,
        certPath: command.tls.certPath,
        caPath: command.tls.caPath,
      });
    });
  }

  setProjectEnvironment(projectId: string, environment: Record<string, string>, actor = "local-user"): Project {
    const project = this.requireProject(projectId);
    const phase = this.processes.snapshot(projectId).phase;
    if (phase === "running" || phase === "starting" || phase === "stopping") {
      throw new Error("Zatrzymaj serwer przed zmianą zmiennych środowiskowych.");
    }
    const normalized = this.validateEnvironment(environment);
    this.store.updateProjectEnvironment(project.id, normalized, actor);
    this.logs.controller("project.environment_updated", { projectId, variableNames: Object.keys(normalized), actor });
    return this.requireProject(projectId);
  }

  async saveEnvironmentProfile(projectId: string, name: string, environment: Record<string, string>, actor = "local-user", restart = false): Promise<Project> {
    const project = this.requireProject(projectId);
    const profileName = this.validateProfileName(name);
    const normalized = this.validateEnvironment(environment);
    const active = this.isProjectActive(projectId);
    const changesActiveProfile = project.selectedEnvironmentProfile === profileName;
    if (active && changesActiveProfile && !restart) throw new Error("Zatrzymaj serwer lub wybierz zapis z restartem.");
    if (active && changesActiveProfile) await this.operate(projectId, "stop");
    this.store.saveProjectEnvironmentProfile(projectId, { name: profileName, environment: normalized }, actor);
    this.logs.controller("project.environment_profile_saved", { projectId, profileName, variableNames: Object.keys(normalized), actor });
    if (active && changesActiveProfile) await this.operate(projectId, "start");
    return this.requireProject(projectId);
  }

  async selectEnvironmentProfile(projectId: string, name: string, actor = "local-user", restart = false): Promise<Project> {
    const project = this.requireProject(projectId);
    const profileName = this.validateProfileName(name);
    if (!project.environmentProfiles.some((profile) => profile.name === profileName)) throw new Error("Nie znaleziono profilu środowiska.");
    if (project.selectedEnvironmentProfile === profileName) return project;
    const active = this.isProjectActive(projectId);
    if (active && !restart) throw new Error("Zatrzymaj serwer lub wybierz profil z restartem.");
    if (active) await this.operate(projectId, "stop");
    this.store.selectProjectEnvironmentProfile(projectId, profileName, actor);
    this.logs.controller("project.environment_profile_selected", { projectId, profileName, actor });
    if (active) await this.operate(projectId, "start");
    return this.requireProject(projectId);
  }

  deleteEnvironmentProfile(projectId: string, name: string, actor = "local-user"): Project {
    const project = this.requireProject(projectId);
    const profileName = this.validateProfileName(name);
    if (profileName === "default") throw new Error("Profilu default nie można usunąć.");
    if (project.selectedEnvironmentProfile === profileName) throw new Error("Nie można usunąć aktywnego profilu środowiska.");
    if (!project.environmentProfiles.some((profile) => profile.name === profileName)) throw new Error("Nie znaleziono profilu środowiska.");
    this.store.deleteProjectEnvironmentProfile(projectId, profileName, actor);
    this.logs.controller("project.environment_profile_deleted", { projectId, profileName, actor });
    return this.requireProject(projectId);
  }

  private validateEnvironment(environment: Record<string, string>): Record<string, string> {
    const entries = Object.entries(environment);
    if (entries.length > 100) throw new Error("Można ustawić maksymalnie 100 zmiennych środowiskowych.");
    for (const [name, value] of entries) {
      if (!ENVIRONMENT_NAME.test(name) || name.length > 128) throw new Error(`Nieprawidłowa nazwa zmiennej środowiskowej: ${name}.`);
      if (RESERVED_ENVIRONMENT_NAMES.has(name)) throw new Error(`Zmienna ${name} jest zarządzana przez kontroler.`);
      if (typeof value !== "string" || value.length > 8192 || value.includes("\0")) throw new Error(`Nieprawidłowa wartość zmiennej ${name}.`);
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
  }

  private validateProfileName(name: string): string {
    const normalized = name.trim();
    if (!ENVIRONMENT_PROFILE_NAME.test(normalized) || normalized.length > 40) throw new Error("Nieprawidłowa nazwa profilu środowiska.");
    return normalized;
  }

  private isProjectActive(projectId: string): boolean {
    const phase = this.processes.snapshot(projectId).phase;
    return phase === "running" || phase === "starting" || phase === "stopping";
  }

  async reserve(input: ReservationRequest): Promise<void> {
    await this.serialized(input.projectId, async () => {
      const project = this.requireProject(input.projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.resolveWorktree(project, worktrees, input.worktreePath);
      this.store.acquireReservation({ ...input, worktreePath: selected.path });
      this.logs.controller("reservation.acquired", { projectId: input.projectId, worktreePath: selected.path, owner: input.owner });
    });
  }

  async release(projectId: string, force = false): Promise<void> {
    await this.serialized(projectId, async () => {
      this.requireProject(projectId);
      this.store.releaseReservation(projectId, "local-user", force);
      this.logs.controller(force ? "reservation.force_released" : "reservation.released", { projectId });
    });
  }

  async claimProject(input: AgentClaimRequest, existingLeaseToken?: string): Promise<AgentClaimResult> {
    return this.serialized(input.projectId, async () => {
      const ttlSeconds = input.ttlSeconds ?? AGENT_LEASE_DEFAULT_SECONDS;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > AGENT_LEASE_DEFAULT_SECONDS) {
        throw new Error(`Agent lease TTL must be between 30 and ${AGENT_LEASE_DEFAULT_SECONDS} seconds.`);
      }
      if (!input.owner.startsWith("agent:mcp:")) throw new Error("Invalid MCP agent owner.");
      if (!input.reason.trim()) throw new Error("A claim reason is required.");
      if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 120) throw new Error("Invalid idempotency key.");

      const project = this.requireProject(input.projectId);
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.resolveWorktree(project, worktrees, input.worktreePath);
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
      try {
        this.assertReservationAllows(input.projectId, selected.path, { owner: input.owner, leaseToken });
        const runtime = this.processes.snapshot(input.projectId);
        if (runtime.phase !== "running" || runtime.worktreePath !== selected.path) {
          this.acquireCapacity(project);
          try {
            if (runtime.phase !== "stopped") await this.processes.stop(input.projectId);
            if (project.selectedWorktreePath !== selected.path) this.store.setSelectedWorktree(input.projectId, selected.path);
            await this.processes.start(this.requireProject(input.projectId), selected.path);
          } finally {
            this.pendingStarts.delete(input.projectId);
          }
        }
      } catch (error) {
        operationError = error instanceof Error ? error.message : String(error);
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
        snapshot: await this.snapshot(this.requireProject(input.projectId)),
        operationError,
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

  releaseAgentClaim(projectId: string, reservationId: string, owner: string, leaseToken: string): void {
    this.store.releaseAgentReservation(projectId, reservationId, owner, leaseTokenHash(leaseToken));
    this.logs.controller("agent.claim_released", { projectId, reservationId, owner });
  }

  async projectSnapshot(projectId: string): Promise<ProjectSnapshot> {
    return this.snapshot(this.requireProject(projectId));
  }

  async refreshWorktreeStorage(projectId: string, worktreePath: string): Promise<void> {
    const project = this.requireProject(projectId);
    const worktrees = await this.git.list(project.repositoryPath);
    const selected = this.resolveWorktree(project, worktrees, worktreePath);
    this.storage?.queue(project.id, selected.path, true);
    this.logs.controller("worktree_storage.refresh_requested", { projectId, worktreePath: selected.path });
  }

  async deleteWorktreeCache(projectId: string, worktreePath: string, cache: SafeCacheKind): Promise<CacheDeletionResult> {
    const project = this.requireProject(projectId);
    const worktrees = await this.git.list(project.repositoryPath);
    const selected = this.resolveWorktree(project, worktrees, worktreePath);
    const auditDetails = { worktreePath: selected.path, cache, target: `${selected.path}/.next` };
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
      const result = await this.cacheCleaner.remove(selected.path, cache);
      this.store.recordProjectEvent(projectId, "worktree_cache.delete_succeeded", "local-user", { ...auditDetails, removed: result.removed });
      this.storage?.queue(projectId, selected.path, true);
      this.logs.controller("worktree_cache.deleted", { projectId, ...auditDetails, removed: result.removed });
      return result;
    } catch (error) {
      this.store.recordProjectEvent(projectId, "worktree_cache.delete_failed", "local-user", {
        ...auditDetails,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    await this.processes.stopAll();
    await this.storage?.close();
    this.store.close();
    await this.logs.close();
  }

  private async snapshot(project: Project, scheduleStorage = false): Promise<ProjectSnapshot> {
    try {
      const worktrees = await this.git.list(project.repositoryPath);
      const worktreePaths = worktrees.map(({ path }) => path);
      if (scheduleStorage) this.storage?.ensureFresh(project.id, worktreePaths);
      return {
        project,
        runtime: this.processes.snapshot(project.id),
        reservation: this.store.getActiveReservation(project.id),
        worktrees,
        storage: this.storage?.snapshots(project.id, worktreePaths) ?? [],
      };
    } catch (error) {
      return {
        project,
        runtime: this.processes.snapshot(project.id),
        reservation: this.store.getActiveReservation(project.id),
        worktrees: [],
        storage: [],
        discoveryError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveWorktree(project: Project, worktrees: Worktree[], requested?: string): Worktree {
    const path = requested ?? project.selectedWorktreePath ?? worktrees[0]?.path;
    const selected = worktrees.find((worktree) => worktree.path === path);
    if (!selected) throw new Error("Worktree nie należy do zarejestrowanego repozytorium lub już nie istnieje.");
    if (selected.prunable) throw new Error("Nie można uruchomić uszkodzonego worktree oznaczonego jako prunable.");
    return selected;
  }

  private assertReservationAllows(projectId: string, worktreePath: string | null, actor: OperationActor): void {
    const reservation = this.store.authorizeReservation(
      projectId,
      actor.owner,
      actor.leaseToken ? leaseTokenHash(actor.leaseToken) : undefined,
    );
    if (reservation && reservation.worktreePath !== worktreePath) {
      throw new Error(`Projekt jest zablokowany na ${basename(reservation.worktreePath)} przez ${reservation.owner}.`);
    }
  }

  private requireProject(id: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw new Error("Nie znaleziono projektu.");
    return project;
  }

  private acquireCapacity(project: Project): void {
    const status = this.capacityStatus();
    if (status.holders.some(({ projectId }) => projectId === project.id)) {
      this.pendingStarts.add(project.id);
      return;
    }
    if (status.enabled && status.used >= status.limit) {
      const holders = status.holders.map(({ projectName }) => projectName).join(", ");
      throw new Error(`Osiągnięto limit ${status.limit} uruchomionych serwerów. Aktywne: ${holders || "brak"}.`);
    }
    this.pendingStarts.add(project.id);
  }

  private capacityStatus(snapshots?: ProjectSnapshot[]): ServerCapacityStatus {
    const settings = this.store.getServerCapacitySettings();
    const projects: Array<Pick<ProjectSnapshot, "project" | "runtime">> = snapshots
      ?? this.store.listProjects().map((project) => ({
        project,
        runtime: this.processes.snapshot(project.id),
      }));
    const holders = projects.flatMap(({ project, runtime }) => {
      const pending = this.pendingStarts.has(project.id);
      if (!pending && runtime.phase !== "starting" && runtime.phase !== "running" && runtime.phase !== "stopping") return [];
      const phase: ServerCapacityStatus["holders"][number]["phase"] = runtime.phase === "running" || runtime.phase === "stopping"
        ? runtime.phase
        : "starting";
      return [{
        projectId: project.id,
        projectName: project.name,
        phase,
      }];
    });
    return {
      ...settings,
      used: holders.length,
      available: settings.enabled ? Math.max(0, settings.limit - holders.length) : null,
      holders,
    };
  }

  private async serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(projectId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(projectId) === current) this.locks.delete(projectId);
    }
  }
}
