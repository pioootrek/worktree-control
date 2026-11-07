import { createHash } from "node:crypto";
import { admissionOf, databaseAdmissionFailure, type DatabaseAdmissionOptions } from "@/server/database-admission";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import { ReservationError, type StateStore } from "@/server/state-store";
import type { Reservation } from "@/shared/contracts";
import { runtimeMutateSchema, type RuntimeMutateRequest, type RuntimeMutateResult } from "@/shared/contracts/runtime-mutate";
import type { RuntimeAction, ScopedOwnClaim } from "@/shared/contracts/runtime-access";
import type { HumanRuntimeAuthority, ProviderSessionActor } from "../identity";
import type { LifecycleAccess, OperationActor } from "../lifecycle";
import type { HumanRuntimeStore } from "./human-runtime-store";
import { RuntimeAccessDenied, ScopedRuntimeError } from "./runtime-errors";
import type { RuntimeService } from "./runtime-service";

export interface HumanRuntimeAuthorizer {
  resolveHumanRuntimeAuthority(actor: ProviderSessionActor, projectId: string, actions: readonly RuntimeAction[]): HumanRuntimeAuthority;
}
/** Shared human operations, independent of HTTP and deliberately separate from the agent secret ledger. */
export class HumanRuntimeService {
  constructor(private readonly authorizer: HumanRuntimeAuthorizer,
    private readonly store: Pick<StateStore, "getProject" | "getActiveReservation">,
    private readonly leases: HumanRuntimeStore,
    private readonly git: Pick<GitWorktreeReader, "list">,
    private readonly lifecycle: LifecycleAccess,
    private readonly runtime: Pick<RuntimeService, "operateClaimed" | "placeClaimed">) {}

  execute(value: unknown, actor: ProviderSessionActor, options?: DatabaseAdmissionOptions, deliver?: (result: RuntimeMutateResult) => void) {
    const parsed = runtimeMutateSchema.safeParse(value);
    if (!parsed.success) return Promise.reject(new ScopedRuntimeError("invalid_request", "Invalid runtime mutation request."));
    const input = parsed.data, actions = required(input);
    return admissionOf(this.store).run(async () => {
      const original = this.authorizer.resolveHumanRuntimeAuthority(actor, input.projectId, actions);
      const current = () => {
        const a = this.authorizer.resolveHumanRuntimeAuthority(actor, input.projectId, actions);
        if (!sameAuthority(a, original)) throw new RuntimeAccessDenied();
        return a;
      };
      if (input.operation !== "claim") this.requireLease(current(), input.projectId, input.reservationId, actions, input.operation === "release");
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = this.leases.begin(original, input.projectId, input.idempotencyKey, fingerprint);
      let result: RuntimeMutateResult;
      let reservationId: string;
      if (prior) {
        if (prior.membershipRevision !== original.membershipRevision) throw new RuntimeAccessDenied();
        if (!prior.reservationId) throw unknownOutcome();
        this.requireLease(current(), input.projectId, prior.reservationId, actions, input.operation === "release");
        if (prior.state !== "complete") throw unknownOutcome();
        reservationId = prior.reservationId;
        result = replay(prior.result as RuntimeMutateResult);
      } else if (input.operation === "claim") {
        const claimed = await this.lifecycle.serialized(input.projectId, async () => {
          current();
          const project = this.store.getProject(input.projectId);
          if (!project) throw new RuntimeAccessDenied();
          if (project.launchPreset === "none") throw new ScopedRuntimeError("no_managed_server", "This project has no managed development server.");
          let worktrees;
          try { worktrees = await admissionOf(this.store).idle(() => this.git.list(project.repositoryPath), options); }
          catch (error) {
            if (databaseAdmissionFailure(error)) throw error;
            current();
            throw new ScopedRuntimeError("worktree_unavailable", "The requested worktree is unavailable.");
          }
          const a = current();
          if (options?.signal?.aborted) throw new ScopedRuntimeError("cancelled", "Runtime request cancelled.");
          let selected;
          try { selected = this.lifecycle.resolveWorktree(project, worktrees, input.worktreePath); }
          catch { throw new ScopedRuntimeError("worktree_unavailable", "The requested worktree is unavailable."); }
          let claim;
          try { claim = this.leases.claim(a, { projectId: input.projectId, worktreePath: selected.path, reason: input.reason,
            ttlSeconds: input.ttlSeconds, key: input.idempotencyKey, fingerprint }); }
          catch (error) {
            if (error instanceof ReservationError) throw new ScopedRuntimeError("claim_conflict", "The project already has an active claim.");
            throw error;
          }
          const verify = () => this.requireLease(current(), input.projectId, claim.id, actions);
          const error = input.start ? await this.runtime.placeClaimed(input.projectId, selected.path, `human:${actor.principalId}`, verify) : null;
          verify();
          return { operation: "claim" as const, projectId: input.projectId, claim: own(claim), startRequested: input.start, error, replayed: false };
        });
        result = claimed; reservationId = claimed.claim.reservationId;
      } else {
        reservationId = input.reservationId;
        this.leases.attach(original, input.idempotencyKey, reservationId);
        if (input.operation === "renew" || input.operation === "release") {
          result = await this.lifecycle.serialized(input.projectId, async () => {
            const claim = this.requireLease(current(), input.projectId, input.reservationId, actions);
            if (input.operation === "release") {
              this.leases.release(claim.id, `human:${actor.principalId}`);
              return { operation: "release" as const, projectId: input.projectId, reservationId: claim.id, released: true as const, replayed: false };
            }
            const end = Math.min(Date.now() + input.ttlSeconds * 1000, Date.parse(claim.maximumExpiresAt!), Date.parse(original.deadline));
            if (end - Date.now() < 30_000) throw new ScopedRuntimeError("claim_stale", "Insufficient remaining lease lifetime.");
            return { operation: "renew" as const, projectId: input.projectId, claim: own(this.leases.renew(claim.id, new Date(end).toISOString())), replayed: false };
          });
        } else {
          const operator: OperationActor = { owner: `human:${actor.principalId}`,
            humanClaim: (projectId, id) => this.requireLease(current(), projectId, id, actions) };
          const receipt = await this.runtime.operateClaimed(input.projectId, input.reservationId, input.operation, operator,
            options?.signal, undefined, () => { this.requireLease(current(), input.projectId, input.reservationId, actions); });
          result = { operation: input.operation, replayed: false, receipt: {
            schemaVersion: 1, operationId: receipt.operationId, action: receipt.action, projectId: receipt.projectId,
            reservationId: receipt.reservationId, outcome: receipt.outcome, replayed: false, observedAt: receipt.observedAt,
            port: receipt.port, claimedWorktreePath: receipt.claimedWorktreePath,
            runtime: { phase: receipt.runtime.phase, worktreePath: receipt.runtime.worktreePath === receipt.claimedWorktreePath ? receipt.runtime.worktreePath : null, startedAt: receipt.runtime.startedAt },
            error: receipt.error ? { code: receipt.error.code, message: receipt.error.message } : null, leaseHeld: receipt.leaseHeld,
          } };
        }
      }
      this.requireLease(current(), input.projectId, reservationId, actions, input.operation === "release");
      if (!prior) this.leases.finish(original, input.idempotencyKey, result);
      // A disconnect never rolls back the intent/effect. Cached delivery still needs original current authority.
      if (options?.signal?.aborted) throw new ScopedRuntimeError("cancelled", "Runtime request cancelled.");
      this.requireLease(current(), input.projectId, reservationId, actions, input.operation === "release");
      deliver?.(result);
      return result;
    }, options);
  }

  ownClaim(actor: ProviderSessionActor, projectId: string): ScopedOwnClaim | null {
    const active = this.store.getActiveReservation(projectId);
    if (!active) return null;
    try {
      const a = this.authorizer.resolveHumanRuntimeAuthority(actor, projectId, ["projects:read"]);
      return own(this.requireLease(a, projectId, active.id, []));
    } catch { return null; }
  }

  private requireLease(a: HumanRuntimeAuthority, projectId: string, id: string, actions: readonly RuntimeAction[], allowReleased = false): Reservation {
    const lease = this.leases.lease(id), now = new Date().toISOString();
    if (!lease || !sameAuthority(a, lease.authority) || lease.reservation.projectId !== projectId
      || !lease.reservation.expiresAt || lease.reservation.expiresAt <= now
      || actions.some(action => !lease.authority.permissions.includes(action))) throw stale();
    const active = this.store.getActiveReservation(projectId);
    if (lease.released) {
      if (!allowReleased || active) throw stale();
    } else if (!active || active.id !== id) throw stale();
    return lease.reservation;
  }
}
function sameAuthority(a: HumanRuntimeAuthority, b: HumanRuntimeAuthority) {
  return a.principalId === b.principalId && a.sessionKey === b.sessionKey && a.evidenceKey === b.evidenceKey
    && a.generation === b.generation && a.membershipRevision === b.membershipRevision && a.deadline === b.deadline
    && JSON.stringify(a.permissions) === JSON.stringify(b.permissions);
}
function required(input: RuntimeMutateRequest): RuntimeAction[] {
  return input.operation === "claim" ? input.start ? ["claims:manage", "runtime:control"] : ["claims:manage"]
    : input.operation === "renew" || input.operation === "release" ? ["claims:manage"] : ["runtime:control"];
}
function own(r: Reservation): ScopedOwnClaim {
  return { reservationId: r.id, worktreePath: r.worktreePath, expiresAt: r.expiresAt, maximumExpiresAt: r.maximumExpiresAt };
}
function stale() { return new ScopedRuntimeError("claim_stale", "The claim is stale, expired, or no longer active."); }
function unknownOutcome() { return new ScopedRuntimeError("outcome_unknown", "The previous outcome is unknown. Inspect the runtime before issuing a new intent."); }
function replay(result: RuntimeMutateResult): RuntimeMutateResult {
  return "receipt" in result ? { ...result, replayed: true, receipt: { ...result.receipt, replayed: true } } : { ...result, replayed: true };
}
