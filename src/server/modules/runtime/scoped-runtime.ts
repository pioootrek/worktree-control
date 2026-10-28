import type { GitWorktreeReader } from "@/server/git-worktrees";
import type { LogWriter } from "@/server/log-writer";
import type { ProcessManager } from "@/server/process-manager";
import type { ReservationBinding, StateStore } from "@/server/state-store";
import type { ClaimedRuntimeAction, ClaimedRuntimeReceipt, Project, Reservation } from "@/shared/contracts";
import type {
  RuntimeAccessEntry, RuntimeAction, ScopedClaimResult, ScopedOwnClaim, ScopedProjectStatus, ScopedProjectSummary,
  ScopedRuntimeReceipt, ScopedWorktree,
} from "@/shared/contracts/runtime-access";
import { createHash, randomBytes } from "node:crypto";
import type { AuthenticatedPrincipal } from "../identity";
import { leaseTokenHash, type LifecycleAccess, type OperationActor } from "../lifecycle";
import { RuntimeAccessDenied, ScopedRuntimeError } from "./runtime-errors";
import type { RuntimeService } from "./runtime-service";

export const AGENT_LEASE_DEFAULT_SECONDS = 30 * 60;
export const AGENT_LEASE_MAX_SECONDS = 8 * 60 * 60;

/** Current-authority port; IdentityService re-reads credential, agent, delegation, ceiling and sponsor. */
export interface RuntimeAuthorizer {
  authorizeRuntime(actor: AuthenticatedPrincipal, projectId: string, action: RuntimeAction): void;
  runtimeAccessFor(actor: AuthenticatedPrincipal): RuntimeAccessEntry[];
}

/** The transport session that owns secrets; its owner string is never returned to other callers. */
export interface ScopedSession {
  owner: string;
}

export interface ScopedClaimRequest {
  projectId: string;
  worktreePath: string;
  reason: string;
  idempotencyKey: string;
  ttlSeconds?: number;
  /** Explicit: starting requires runtime:control and is never inferred from a claim. */
  start?: boolean;
}

/**
 * Scoped agent runtime use cases. Every operation is authorized here, not in a
 * transport, and every result is built from an explicit field allowlist.
 */
export class ScopedRuntimeService {
  constructor(
    private readonly authorizer: RuntimeAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getActiveReservation" | "acquireReservation" | "renewAgentReservation" | "releaseAgentReservation">,
    private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly processes: Pick<ProcessManager, "snapshot">,
    private readonly lifecycle: LifecycleAccess,
    private readonly runtime: Pick<RuntimeService, "operateClaimed" | "placeClaimed">,
    private readonly logs: Pick<LogWriter, "controller">,
  ) {}

  listProjects(actor: AuthenticatedPrincipal, session: ScopedSession): ScopedProjectSummary[] {
    let access: RuntimeAccessEntry[];
    try { access = this.authorizer.runtimeAccessFor(actor); } catch { throw new RuntimeAccessDenied(); }
    return access.filter(entry => entry.actions.includes("projects:read")).flatMap((entry) => {
      const project = this.store.getProject(entry.projectId);
      return project ? [this.summary(project, entry.actions, session)] : [];
    });
  }

  projectStatus(actor: AuthenticatedPrincipal, session: ScopedSession, projectId: string): ScopedProjectStatus {
    this.check(actor, projectId, ["projects:read"]);
    return this.status(this.requireProject(projectId), actor, session);
  }

  async worktrees(actor: AuthenticatedPrincipal, projectId: string): Promise<ScopedWorktree[]> {
    this.check(actor, projectId, ["projects:read"]);
    const project = this.requireProject(projectId);
    let worktrees;
    try { worktrees = await this.git.list(project.repositoryPath); }
    catch { throw new ScopedRuntimeError("worktree_unavailable", "Worktree discovery is unavailable."); }
    this.check(actor, projectId, ["projects:read"]);
    return worktrees.map(worktree => ({
      path: worktree.path, branch: worktree.branch, head: worktree.head, shortHead: worktree.shortHead,
      detached: worktree.detached, locked: worktree.locked, prunable: worktree.prunable, dirty: worktree.dirty,
    }));
  }

  async claim(actor: AuthenticatedPrincipal, session: ScopedSession, input: ScopedClaimRequest, existingLeaseToken?: string): Promise<{ result: ScopedClaimResult; leaseToken: string }> {
    const start = input.start === true;
    const required: RuntimeAction[] = start ? ["claims:manage", "runtime:control"] : ["claims:manage"];
    this.check(actor, input.projectId, required);
    const ttlSeconds = validTtl(input.ttlSeconds);
    if (!session.owner.startsWith("agent:mcp:")) throw new ScopedRuntimeError("invalid_request", "An initialized MCP session is required.");
    const reason = input.reason.trim();
    if (!reason || reason.length > 240) throw new ScopedRuntimeError("invalid_request", "A claim reason of 1 to 240 characters is required.");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 120) throw new ScopedRuntimeError("invalid_request", "Invalid idempotency key.");
    return this.lifecycle.serialized(input.projectId, async () => {
      this.check(actor, input.projectId, required);
      const project = this.requireProject(input.projectId);
      if (project.launchPreset === "none") throw new ScopedRuntimeError("no_managed_server", "This project has no managed development server.");
      let worktrees;
      try { worktrees = await this.git.list(project.repositoryPath); }
      catch { throw new ScopedRuntimeError("worktree_unavailable", "The requested worktree is unavailable."); }
      // Git discovery awaited; authority may have changed meanwhile.
      this.check(actor, input.projectId, required);
      let selectedPath: string;
      try { selectedPath = this.lifecycle.resolveWorktree(project, worktrees, input.worktreePath).path; }
      catch { throw new ScopedRuntimeError("worktree_unavailable", "The requested worktree is unavailable."); }
      const leaseToken = existingLeaseToken ?? randomBytes(32).toString("base64url");
      const binding = bindingOf(actor);
      let reservation: Reservation;
      try {
        // Synchronous with the preceding check: no await separates the decision from the write.
        reservation = this.store.acquireReservation({
          projectId: project.id, worktreePath: selectedPath, kind: "agent", owner: session.owner, reason, ttlSeconds,
          maximumLifetimeSeconds: AGENT_LEASE_MAX_SECONDS, leaseTokenHash: leaseTokenHash(leaseToken),
          idempotencyKey: input.idempotencyKey, binding,
          requestFingerprint: createHash("sha256").update(JSON.stringify({ worktreePath: selectedPath, reason, ttlSeconds, start })).digest("hex"),
        });
      } catch (error) {
        const idempotency = error instanceof Error && /idempotencji|idempotency/i.test(error.message);
        throw idempotency
          ? new ScopedRuntimeError("idempotency_conflict", "The idempotency key is already used by a different claim.")
          : new ScopedRuntimeError("claim_conflict", "The project is claimed by another holder.");
      }
      const actorRef = this.actorRef(session.owner);
      this.logs.controller("agent.claimed", { projectId: project.id, reservationId: reservation.id, owner: session.owner, credentialId: actor.credentialId, worktreePath: selectedPath });
      const operator: OperationActor = { owner: session.owner, leaseToken, binding };
      const verify = () => {
        this.check(actor, project.id, required);
        try { this.lifecycle.requireAgentClaim(project.id, reservation.id, operator); }
        catch { throw new ScopedRuntimeError("claim_stale", "The claim is stale, expired, or no longer active."); }
      };
      const error = start
        ? await this.runtime.placeClaimed(project.id, selectedPath, actorRef, verify)
        : null;
      // The lease stays held with its TTL; a revoked caller simply receives no result.
      verify();
      return {
        leaseToken,
        result: {
          projectId: project.id, reservationId: reservation.id, worktreePath: reservation.worktreePath,
          expiresAt: reservation.expiresAt, maximumExpiresAt: reservation.maximumExpiresAt, startRequested: start,
          error, leaseHeld: true, status: this.readable(actor, project.id) ? this.status(this.requireProject(project.id), actor, session) : null,
        },
      };
    });
  }

  renew(actor: AuthenticatedPrincipal, session: ScopedSession, projectId: string, reservationId: string, leaseToken: string, ttlSeconds?: number): ScopedOwnClaim {
    this.check(actor, projectId, ["claims:manage"]);
    const ttl = validTtl(ttlSeconds);
    let reservation: Reservation;
    try {
      reservation = this.store.renewAgentReservation(projectId, reservationId, session.owner, leaseTokenHash(leaseToken), ttl, bindingOf(actor));
    } catch {
      throw new ScopedRuntimeError("claim_stale", "The claim is stale, expired, or no longer active.");
    }
    this.logs.controller("agent.claim_renewed", { projectId, reservationId, owner: session.owner, credentialId: actor.credentialId, expiresAt: reservation.expiresAt });
    return ownClaim(reservation);
  }

  async release(actor: AuthenticatedPrincipal, session: ScopedSession, projectId: string, reservationId: string, leaseToken: string): Promise<void> {
    this.check(actor, projectId, ["claims:manage"]);
    await this.lifecycle.serialized(projectId, async () => {
      this.check(actor, projectId, ["claims:manage"]);
      const operator: OperationActor = { owner: session.owner, leaseToken, binding: bindingOf(actor) };
      try { this.lifecycle.requireAgentClaim(projectId, reservationId, operator); }
      catch { throw new ScopedRuntimeError("claim_stale", "The claim is stale, expired, or no longer active."); }
      this.store.releaseAgentReservation(projectId, reservationId, session.owner, leaseTokenHash(leaseToken), operator.binding);
      this.logs.controller("agent.claim_released", { projectId, reservationId, owner: session.owner, credentialId: actor.credentialId });
    });
  }

  async operate(
    actor: AuthenticatedPrincipal, session: ScopedSession, leaseToken: string, projectId: string, reservationId: string,
    action: ClaimedRuntimeAction, signal?: AbortSignal, sessionClosed?: () => boolean,
  ): Promise<ScopedRuntimeReceipt> {
    this.check(actor, projectId, ["runtime:control"]);
    let receipt: ClaimedRuntimeReceipt;
    try {
      receipt = await this.runtime.operateClaimed(
        projectId, reservationId, action, { owner: session.owner, leaseToken, binding: bindingOf(actor) }, signal, sessionClosed,
        () => this.check(actor, projectId, ["runtime:control"]),
      );
    } catch (error) {
      if (error instanceof RuntimeAccessDenied || error instanceof ScopedRuntimeError) throw error;
      if (error instanceof Error && /cancelled/.test(error.message)) throw new ScopedRuntimeError("cancelled", "The runtime operation was cancelled before it started.");
      throw new ScopedRuntimeError("claim_stale", "The claim is stale, expired, or no longer active.");
    }
    return {
      schemaVersion: 1, operationId: receipt.operationId, action: receipt.action, projectId: receipt.projectId,
      reservationId: receipt.reservationId, outcome: receipt.outcome, replayed: receipt.replayed, observedAt: receipt.observedAt,
      port: receipt.port, claimedWorktreePath: receipt.claimedWorktreePath,
      runtime: { phase: receipt.runtime.phase, worktreePath: receipt.runtime.worktreePath, startedAt: receipt.runtime.startedAt },
      error: receipt.error ? { code: receipt.error.code, message: receipt.error.message } : null,
      leaseHeld: receipt.leaseHeld,
    };
  }

  /** Cached receipts and other retained results are released only to current authority. */
  authorize(actor: AuthenticatedPrincipal, projectId: string, action: RuntimeAction): void {
    this.check(actor, projectId, [action]);
  }

  private check(actor: AuthenticatedPrincipal, projectId: string, actions: readonly RuntimeAction[]): void {
    try {
      for (const action of actions) this.authorizer.authorizeRuntime(actor, projectId, action);
    } catch {
      throw new RuntimeAccessDenied();
    }
  }

  private readable(actor: AuthenticatedPrincipal, projectId: string): boolean {
    try { this.authorizer.authorizeRuntime(actor, projectId, "projects:read"); return true; } catch { return false; }
  }

  /** Authorized callers only: a missing project after authorization is the same denial. */
  private requireProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new RuntimeAccessDenied();
    return project;
  }

  private summary(project: Project, actions: RuntimeAction[], session: ScopedSession): ScopedProjectSummary {
    const runtime = this.processes.snapshot(project.id);
    return {
      id: project.id, name: project.name, port: project.port, actions: [...actions], phase: runtime.phase,
      worktreePath: runtime.worktreePath ?? project.selectedWorktreePath ?? null,
      claim: this.relation(this.store.getActiveReservation(project.id), session),
    };
  }

  private status(project: Project, actor: AuthenticatedPrincipal, session: ScopedSession): ScopedProjectStatus {
    const actions = this.authorizer.runtimeAccessFor(actor).find(entry => entry.projectId === project.id)?.actions ?? [];
    const runtime = this.processes.snapshot(project.id);
    const reservation = this.store.getActiveReservation(project.id);
    const claim = this.relation(reservation, session);
    return {
      id: project.id, name: project.name, port: project.port, actions: [...actions], phase: runtime.phase,
      worktreePath: runtime.worktreePath ?? project.selectedWorktreePath ?? null, claim,
      selectedWorktreePath: project.selectedWorktreePath ?? null, startedAt: runtime.startedAt,
      managedServer: project.launchPreset !== "none",
      ownClaim: claim === "own" && reservation ? ownClaim(reservation) : null,
    };
  }

  private relation(reservation: Reservation | null, session: ScopedSession): ScopedProjectSummary["claim"] {
    if (!reservation) return "none";
    return reservation.kind === "agent" && reservation.owner === session.owner ? "own" : "other";
  }

  private actorRef(owner: string): string {
    return `mcp:${createHash("sha256").update(owner).digest("hex").slice(0, 12)}`;
  }
}

function bindingOf(actor: AuthenticatedPrincipal): ReservationBinding {
  return { principalId: actor.principalId, credentialId: actor.credentialId };
}

function ownClaim(reservation: Reservation): ScopedOwnClaim {
  return {
    reservationId: reservation.id, worktreePath: reservation.worktreePath,
    expiresAt: reservation.expiresAt, maximumExpiresAt: reservation.maximumExpiresAt,
  };
}

function validTtl(value: number | undefined): number {
  const ttl = value ?? AGENT_LEASE_DEFAULT_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > AGENT_LEASE_DEFAULT_SECONDS) {
    throw new ScopedRuntimeError("invalid_request", `Agent lease TTL must be between 30 and ${AGENT_LEASE_DEFAULT_SECONDS} seconds.`);
  }
  return ttl;
}
