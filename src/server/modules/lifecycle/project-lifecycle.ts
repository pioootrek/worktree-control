import type { ProcessManager } from "@/server/process-manager";
import type { StateStore } from "@/server/state-store";
import type { Project, ProjectSnapshot, ServerCapacityStatus, Worktree } from "@/shared/contracts";
import { createHash } from "node:crypto";
import { basename } from "node:path";

export interface OperationActor {
  owner: string;
  leaseToken?: string;
}

export function leaseTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The facade creates one authority and shares it across application modules. */
export class ProjectLifecycle {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly pendingStarts = new Set<string>();
  private readonly maintenance = new Set<string>();
  private readonly scans = new Set<string>();
  private closing = false;

  constructor(
    private readonly store: Pick<StateStore, "getProject" | "listProjects" | "authorizeReservation" | "getServerCapacitySettings">,
    private readonly processes: Pick<ProcessManager, "snapshot"> & Partial<Pick<ProcessManager, "statusSummary">>,
  ) {}

  resolveWorktree(project: Project, worktrees: Worktree[], requested?: string): Worktree {
    const path = requested ?? project.selectedWorktreePath ?? worktrees[0]?.path;
    const selected = worktrees.find((worktree) => worktree.path === path);
    if (!selected) throw new Error("Worktree nie należy do zarejestrowanego repozytorium lub już nie istnieje.");
    if (selected.prunable) throw new Error("Nie można uruchomić uszkodzonego worktree oznaczonego jako prunable.");
    return selected;
  }

  assertReservationAllows(projectId: string, worktreePath: string | null, actor: OperationActor): void {
    const reservation = this.store.authorizeReservation(
      projectId,
      actor.owner,
      actor.leaseToken ? leaseTokenHash(actor.leaseToken) : undefined,
    );
    if (reservation && reservation.worktreePath !== worktreePath) {
      throw new Error(`Projekt jest zablokowany na ${basename(reservation.worktreePath)} przez ${reservation.owner}.`);
    }
  }

  requireAgentClaim(projectId: string, reservationId: string, actor: OperationActor): import("@/shared/contracts").Reservation {
    if (!actor.owner.startsWith("agent:mcp:") || !actor.leaseToken) {
      throw new Error("An active MCP agent claim is required.");
    }
    let reservation;
    try {
      reservation = this.store.authorizeReservation(projectId, actor.owner, leaseTokenHash(actor.leaseToken));
    } catch {
      throw new Error("The MCP claim is stale, expired, or no longer active.");
    }
    if (!reservation || reservation.kind !== "agent" || reservation.id !== reservationId || reservation.projectId !== projectId) {
      throw new Error("The MCP claim is stale, expired, or no longer active.");
    }
    return reservation;
  }

  requireProject(id: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw new Error("Nie znaleziono projektu.");
    return project;
  }

  acquireCapacity(project: Project): void {
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

  capacityStatus(snapshots?: ProjectSnapshot[]): ServerCapacityStatus {
    const settings = this.store.getServerCapacitySettings();
    const projects: Array<{ project: Pick<Project, "id" | "name">; runtime: ProjectSnapshot["runtime"] }> = snapshots
      ?? this.store.listProjects().map((project) => ({
        project,
        runtime: this.processes.snapshot(project.id),
      }));
    const holders = projects.flatMap(({ project, runtime }) => {
      const pending = this.pendingStarts.has(project.id);
      if (!pending && !runtime.pid && runtime.phase !== "starting" && runtime.phase !== "running" && runtime.phase !== "stopping") return [];
      const phase: ServerCapacityStatus["holders"][number]["phase"] = runtime.phase === "starting" || runtime.phase === "running" || runtime.phase === "stopping"
        ? runtime.phase
        : runtime.pid ? "stopping" : "starting";
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

  capacityStatusCompact(): ServerCapacityStatus {
    const settings = this.store.getServerCapacitySettings();
    const holders = this.store.listProjects().flatMap((project) => {
      const runtime = this.processes.statusSummary?.(project.id) ?? this.processes.snapshot(project.id);
      const pending = this.pendingStarts.has(project.id);
      const ownsProcess = "ownsProcess" in runtime ? runtime.ownsProcess : "pid" in runtime && Boolean(runtime.pid);
      if (!pending && !ownsProcess && runtime.phase !== "starting" && runtime.phase !== "running" && runtime.phase !== "stopping") return [];
      const phase: ServerCapacityStatus["holders"][number]["phase"] =
        runtime.phase === "starting" || runtime.phase === "running" || runtime.phase === "stopping"
          ? runtime.phase : ownsProcess ? "stopping" : "starting";
      return [{ projectId: project.id, projectName: project.name, phase }];
    });
    return { ...settings, used: holders.length,
      available: settings.enabled ? Math.max(0, settings.limit - holders.length) : null, holders };
  }

  async serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error("Kontroler jest zamykany i nie przyjmuje nowych operacji.");
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(projectId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(projectId) === current) this.locks.delete(projectId);
    }
  }

  acquireMaintenance(projectId: string, worktreePath: string): (() => void) | null {
    if (this.closing) return null;
    const key = this.worktreeKey(projectId, worktreePath);
    if (this.maintenance.has(key) || this.scans.has(key)) return null;
    this.maintenance.add(key);
    return this.releaseFrom(this.maintenance, key);
  }

  acquireScan(projectId: string, worktreePath: string): (() => void) | null {
    if (this.closing) return null;
    const key = this.worktreeKey(projectId, worktreePath);
    if (this.maintenance.has(key) || this.scans.has(key)) return null;
    this.scans.add(key);
    return this.releaseFrom(this.scans, key);
  }

  closeAdmission(): void { this.closing = true; }

  async closeAndDrain(): Promise<void> {
    this.closeAdmission();
    await Promise.allSettled([...this.locks.values()]);
  }

  isProjectActive(projectId: string): boolean {
    const phase = this.processes.snapshot(projectId).phase;
    return phase === "running" || phase === "starting" || phase === "stopping";
  }

  releaseCapacity(projectId: string): void {
    this.pendingStarts.delete(projectId);
  }

  private releaseFrom(owners: Set<string>, key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      owners.delete(key);
    };
  }

  private worktreeKey(projectId: string, worktreePath: string): string {
    return `${projectId}\0${worktreePath}`;
  }
}

export type LifecycleAccess = Pick<ProjectLifecycle, "serialized" | "requireProject" | "resolveWorktree" | "assertReservationAllows" | "requireAgentClaim">;
export type RuntimeCapacity = Pick<ProjectLifecycle, "acquireCapacity" | "releaseCapacity" | "capacityStatus" | "isProjectActive">;
export type WorktreeMaintenanceAccess = Pick<ProjectLifecycle, "acquireMaintenance" | "acquireScan">;
