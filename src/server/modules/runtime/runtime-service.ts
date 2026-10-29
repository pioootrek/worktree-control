import type { GitWorktreeReader } from "@/server/git-worktrees";
import { NO_SERVER_MESSAGE, type LaunchCommandResolver, type NextTlsConfiguration } from "@/server/launch-command";
import { type LogWriter } from "@/server/log-writer";
import type { ProcessManager } from "@/server/process-manager";
import { ReservationError, type StateStore } from "@/server/state-store";
import type { ClaimedRuntimeAction, ClaimedRuntimeReceipt } from "@/shared/contracts";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeCapacity } from "../lifecycle";
import { type LifecycleAccess, type OperationActor } from "../lifecycle";
import { RuntimeAccessDenied, ScopedRuntimeError } from "./runtime-errors";

class ClaimedRuntimeOperationError extends Error {
  constructor(readonly code: string, readonly safeMessage: string) {
    super(safeMessage);
  }
}

export class RuntimeService {
  constructor(
    private readonly store: Pick<StateStore, "setSelectedWorktree" | "updateProjectLaunch" | "recordProjectEvent">,
    private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly processes: Pick<ProcessManager, "snapshot" | "start" | "stop">,
    private readonly logs: Pick<LogWriter, "controller">,
    private readonly commands: LaunchCommandResolver,
    private readonly lifecycle: LifecycleAccess & Pick<RuntimeCapacity, "acquireCapacity" | "releaseCapacity" | "capacityStatus">,
  ) {}

  async operateClaimed(
    projectId: string,
    reservationId: string,
    action: ClaimedRuntimeAction,
    actor: OperationActor,
    signal?: AbortSignal,
    sessionClosed: () => boolean = () => false,
    /** Scoped callers re-read current credential authority; a denial throws RuntimeAccessDenied. */
    authority: () => void = () => undefined,
  ): Promise<ClaimedRuntimeReceipt> {
    return this.lifecycle.serialized(projectId, async () => {
      if (signal?.aborted || sessionClosed()) throw new ScopedRuntimeError("cancelled", "The runtime operation was cancelled before it started.");
      authority();
      const operationId = randomUUID();
      const project = this.lifecycle.requireProject(projectId);
      const claim = this.lifecycle.requireAgentClaim(projectId, reservationId, actor);
      const verify = () => { this.revalidateClaim(projectId, reservationId, actor); authority(); };
      const actorRef = `mcp:${createHash("sha256").update(actor.owner).digest("hex").slice(0, 12)}`;
      this.store.recordProjectEvent(projectId, "agent.runtime_accepted", actorRef, { operationId, reservationId, action });
      this.logs.controller("agent.runtime_accepted", { operationId, projectId, reservationId, action, actor: actorRef });
      const initial = this.processes.snapshot(projectId);
      // Scoped claims can reserve without placing the server. Their explicit
      // runtime operation controls the project under the validated bound lease.
      const scopedPlacement = actor.binding !== undefined && initial.worktreePath !== claim.worktreePath;

      let outcome: ClaimedRuntimeReceipt["outcome"] = "completed";
      let operationError: ClaimedRuntimeReceipt["error"] = null;
      try {
        if (project.launchPreset === "none") throw new ClaimedRuntimeOperationError("no_managed_server", NO_SERVER_MESSAGE);
        if (initial.pid && initial.worktreePath !== claim.worktreePath && !scopedPlacement) {
          throw new ClaimedRuntimeOperationError("runtime_worktree_mismatch", "The managed runtime does not match the claimed worktree.");
        }
        if (action === "stop") {
          if (!initial.pid && initial.phase !== "starting" && initial.phase !== "stopping") outcome = "noop";
          else { verify(); await this.stopRuntime(projectId); }
        } else if (action === "start" && initial.phase === "running" && initial.worktreePath === claim.worktreePath) {
          outcome = "noop";
        } else {
          let selected;
          try {
            const worktrees = await this.git.list(project.repositoryPath);
            selected = this.lifecycle.resolveWorktree(project, worktrees, claim.worktreePath);
          } catch {
            throw new ClaimedRuntimeOperationError("worktree_unavailable", "The claimed worktree is unavailable.");
          }
          verify();
          try {
            this.lifecycle.acquireCapacity(project);
          } catch {
            throw new ClaimedRuntimeOperationError("capacity_exhausted", "Managed server capacity is exhausted.");
          }
          try {
            if ((action === "restart" && initial.pid) || (scopedPlacement && initial.phase !== "stopped")) {
              verify();
              await this.stopRuntime(projectId);
              verify();
            } else if (action === "start" && (initial.pid || initial.phase === "starting" || initial.phase === "stopping")) {
              throw new ClaimedRuntimeOperationError("runtime_busy", "The managed runtime is busy.");
            }
            const launch = this.commands.resolve(selected.path, project.port, project.launchPreset, {
              mode: project.tlsMode, keyPath: project.tlsKeyPath, certPath: project.tlsCertPath, caPath: project.tlsCaPath,
            });
            if (project.executable !== launch.executable || JSON.stringify(project.args) !== JSON.stringify(launch.args)) {
              this.store.updateProjectLaunch(projectId, {
                tlsMode: launch.tls.mode, tlsKeyPath: launch.tls.keyPath, tlsCertPath: launch.tls.certPath,
                tlsCaPath: launch.tls.caPath, executable: launch.executable, args: launch.args,
              }, actorRef);
            }
            if (project.selectedWorktreePath !== selected.path) this.store.setSelectedWorktree(projectId, selected.path, actorRef);
            await this.startRuntime(projectId, selected.path, actorRef, verify);
          } finally {
            this.lifecycle.releaseCapacity(projectId);
          }
        }
      } catch (error) {
        if (error instanceof RuntimeAccessDenied) {
          this.recordDenied(projectId, operationId, reservationId, action, actorRef);
          throw error;
        }
        outcome = "failed";
        operationError = this.safeOperationError(error);
      }
      const runtime = this.processes.snapshot(projectId);
      let leaseHeld = false;
      try { this.lifecycle.requireAgentClaim(projectId, reservationId, actor); leaseHeld = true; }
      catch (error) { if (!(error instanceof ReservationError)) throw error; }
      const capacity = this.lifecycle.capacityStatus();
      const receipt: ClaimedRuntimeReceipt = {
        schemaVersion: 1, operationId, action, projectId, reservationId, outcome, replayed: false,
        observedAt: new Date().toISOString(), port: project.port, claimedWorktreePath: claim.worktreePath,
        runtime: { phase: runtime.phase, worktreePath: runtime.worktreePath, startedAt: runtime.startedAt },
        error: operationError, leaseHeld,
        occupiesCapacity: capacity.holders.some((holder) => holder.projectId === projectId),
        capacity: { enabled: capacity.enabled, limit: capacity.limit, used: capacity.used, available: capacity.available },
      };
      this.logs.controller(`agent.runtime_${outcome}`, {
        operationId, projectId, reservationId, action, outcome, actor: actorRef, errorCode: operationError?.code ?? null,
      });
      this.store.recordProjectEvent(projectId, `agent.runtime_${outcome}`, actorRef, {
        operationId, reservationId, action, outcome, errorCode: operationError?.code ?? null,
      });
      // Effects already happened are audited above; revoked callers still receive no status.
      authority();
      return receipt;
    });
  }

  /**
   * Places the managed server on a freshly claimed worktree. The caller holds the
   * project lock; `verify` runs before stopping, after the awaited stop and
   * immediately before spawn. Denials propagate; other failures are safe codes.
   */
  async placeClaimed(projectId: string, worktreePath: string, actorRef: string, verify: () => void): Promise<{ code: string; message: string } | null> {
    try {
      verify();
      const project = this.lifecycle.requireProject(projectId);
      if (project.launchPreset === "none") throw new ClaimedRuntimeOperationError("no_managed_server", NO_SERVER_MESSAGE);
      const runtime = this.processes.snapshot(projectId);
      if (runtime.phase === "running" && runtime.worktreePath === worktreePath) return null;
      try {
        this.lifecycle.acquireCapacity(project);
      } catch {
        throw new ClaimedRuntimeOperationError("capacity_exhausted", "Managed server capacity is exhausted.");
      }
      try {
        if (runtime.phase !== "stopped") {
          await this.stopRuntime(projectId);
          verify();
        }
        const launch = this.commands.resolve(worktreePath, project.port, project.launchPreset, {
          mode: project.tlsMode, keyPath: project.tlsKeyPath, certPath: project.tlsCertPath, caPath: project.tlsCaPath,
        });
        if (project.executable !== launch.executable || JSON.stringify(project.args) !== JSON.stringify(launch.args)) {
          this.store.updateProjectLaunch(projectId, {
            tlsMode: launch.tls.mode, tlsKeyPath: launch.tls.keyPath, tlsCertPath: launch.tls.certPath,
            tlsCaPath: launch.tls.caPath, executable: launch.executable, args: launch.args,
          }, actorRef);
        }
        if (project.selectedWorktreePath !== worktreePath) this.store.setSelectedWorktree(projectId, worktreePath, actorRef);
        await this.startRuntime(projectId, worktreePath, actorRef, verify);
      } finally {
        this.lifecycle.releaseCapacity(projectId);
      }
      return null;
    } catch (error) {
      if (error instanceof RuntimeAccessDenied) throw error;
      return this.safeOperationError(error);
    }
  }

  private recordDenied(projectId: string, operationId: string, reservationId: string, action: ClaimedRuntimeAction, actorRef: string): void {
    try {
      this.store.recordProjectEvent(projectId, "agent.runtime_denied", actorRef, { operationId, reservationId, action });
      this.logs.controller("agent.runtime_denied", { operationId, projectId, reservationId, action, actor: actorRef });
    } catch { /* the denial itself is authoritative */ }
  }

  private safeOperationError(error: unknown): { code: string; message: string } {
    if (error instanceof ClaimedRuntimeOperationError) return { code: error.code, message: error.safeMessage };
    if (error instanceof ScopedRuntimeError) return { code: error.code, message: error.message };
    return { code: "runtime_operation_failed", message: "The managed runtime operation failed." };
  }

  private revalidateClaim(projectId: string, reservationId: string, actor: OperationActor): void {
    try {
      this.lifecycle.requireAgentClaim(projectId, reservationId, actor);
    } catch (error) {
      if (!(error instanceof ReservationError)) throw error;
      throw new ClaimedRuntimeOperationError("claim_stale", "The MCP claim is stale, expired, or no longer active.");
    }
  }

  private async stopRuntime(projectId: string): Promise<void> {
    try {
      await this.processes.stop(projectId);
    } catch (error) {
      if (error instanceof ClaimedRuntimeOperationError || error instanceof ScopedRuntimeError || error instanceof RuntimeAccessDenied) throw error;
      const code = this.processes.snapshot(projectId).failure?.code ?? "cleanup_unconfirmed";
      throw new ClaimedRuntimeOperationError(code, "The managed runtime could not be stopped safely.");
    }
  }

  private async startRuntime(projectId: string, worktreePath: string, actorRef: string, beforeSpawn: () => void): Promise<void> {
    try {
      await this.processes.start(this.lifecycle.requireProject(projectId), worktreePath, beforeSpawn);
    } catch (error) {
      if (error instanceof ClaimedRuntimeOperationError || error instanceof ScopedRuntimeError || error instanceof RuntimeAccessDenied) throw error;
      const code = this.processes.snapshot(projectId).failure?.code ?? "launch_failed";
      throw new ClaimedRuntimeOperationError(code, "The managed runtime could not be started.");
    }
    this.recordLaunch(projectId, worktreePath, actorRef);
  }

  private recordLaunch(projectId: string, worktreePath: string, actor: string): void {
    // Launch history is optional evidence, not part of process success or ownership.
    const actorRef = actor.startsWith("agent:mcp:") ? `mcp:${createHash("sha256").update(actor).digest("hex").slice(0, 12)}` : actor;
    try {
      this.store.recordProjectEvent(projectId, "worktree.launched", actorRef, { worktreePath });
    } catch {
      // Do not expose database errors or turn a healthy runtime into a failed receipt.
      try { this.logs.controller("worktree.launch_history_unavailable", { projectId, worktreePath, actor: actorRef }); } catch { /* diagnostics cannot change runtime outcome */ }
    }
  }

  async operate(
    projectId: string,
    operation: "start" | "stop" | "restart" | "switch",
    worktreePath?: string,
    actor: OperationActor = { owner: "local-user" },
  ): Promise<void> {
    try {
      await this.lifecycle.serialized(projectId, () => this.operateLocked(projectId, operation, worktreePath, actor));
    } catch (error) {
      this.logs.controller("project.operation_failed", {
        projectId,
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async operateLocked(
    projectId: string,
    operation: "start" | "stop" | "restart" | "switch",
    worktreePath: string | undefined,
    actor: OperationActor,
  ): Promise<void> {
    const project = this.lifecycle.requireProject(projectId);
    if (project.launchPreset === "none") throw new Error(NO_SERVER_MESSAGE);
    if (operation === "stop") {
      this.lifecycle.assertReservationAllows(
        projectId,
        this.processes.snapshot(projectId).worktreePath ?? project.selectedWorktreePath,
        actor,
      );
      await this.processes.stop(projectId);
      this.logs.controller("project.stopped", { projectId });
      return;
    }
    const worktrees = await this.git.list(project.repositoryPath);
    const selected = this.lifecycle.resolveWorktree(project, worktrees, worktreePath);
    this.lifecycle.assertReservationAllows(projectId, selected.path, actor);
    this.lifecycle.acquireCapacity(project);
    try {
      if (operation === "restart" || operation === "switch") await this.processes.stop(projectId);
      if (operation === "switch") this.store.setSelectedWorktree(projectId, selected.path);
      const launch = this.commands.resolve(selected.path, project.port, project.launchPreset, {
        mode: project.tlsMode,
        keyPath: project.tlsKeyPath,
        certPath: project.tlsCertPath,
        caPath: project.tlsCaPath,
      });
      if (project.executable !== launch.executable || JSON.stringify(project.args) !== JSON.stringify(launch.args)) {
        this.store.updateProjectLaunch(projectId, {
          tlsMode: launch.tls.mode,
          tlsKeyPath: launch.tls.keyPath,
          tlsCertPath: launch.tls.certPath,
          tlsCaPath: launch.tls.caPath,
          executable: launch.executable,
          args: launch.args,
        });
      }
      await this.processes.start(this.lifecycle.requireProject(projectId), selected.path);
      this.recordLaunch(projectId, selected.path, actor.owner);
    } finally {
      this.lifecycle.releaseCapacity(projectId);
    }
    this.logs.controller(`project.${operation}`, { projectId, worktreePath: selected.path });
  }

  async setProjectTls(projectId: string, input: NextTlsConfiguration): Promise<void> {
    await this.lifecycle.serialized(projectId, async () => {
      const project = this.lifecycle.requireProject(projectId);
      if (project.launchPreset === "none") throw new Error(NO_SERVER_MESSAGE);
      const phase = this.processes.snapshot(projectId).phase;
      if (phase === "running" || phase === "starting" || phase === "stopping") {
        throw new Error("Zatrzymaj serwer przed zmianą ustawień HTTPS.");
      }
      const worktrees = await this.git.list(project.repositoryPath);
      const selected = this.lifecycle.resolveWorktree(project, worktrees);
      this.lifecycle.assertReservationAllows(projectId, selected.path, { owner: "local-user" });
      if (project.launchPreset === "django") throw new Error("HTTPS zarządzany przez Worktree Control jest obecnie obsługiwany tylko dla Next.js.");
      const command = this.commands.resolve(selected.path, project.port, project.launchPreset, input);
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
}
