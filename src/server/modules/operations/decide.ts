import { FRESH_LOGIN_WINDOW_MS, type ErrorCategory, type FreshLoginState, type ProjectId } from "@/shared/contracts/operations";
import { isFullAuthority, type CurrentAuthority } from "./authentication-context";
import { effectivePermissions, type EffectivePermissions, type GrantsSnapshot } from "./grants";
import type { OperationRequirement, PredicateName, Requirement, ResolvedResource, ResolvedResources } from "./requirements";
import { isSlotName, requiredSlots } from "./requirements";

export interface DecisionInput {
  authority: CurrentAuthority;
  requirement: OperationRequirement;
  /** Every resource the operation references, resolved in this phase. */
  resources: ResolvedResources;
  grants: GrantsSnapshot;
  /** Milliseconds since the epoch. */
  now: number;
}

/**
 * A decision input whose effective permissions were computed beforehand. The
 * runner computes them before it resolves any reference (decision Y), so the
 * decision itself reads no adapter.
 */
export interface PermittedDecisionInput {
  authority: CurrentAuthority;
  requirement: OperationRequirement;
  resources: ResolvedResources;
  permissions: EffectivePermissions;
  now: number;
}

export type Denial = { readonly allowed: false; category: Extract<ErrorCategory, "forbidden" | "login_stale" | "not_found" | "claim_held" | "conflict">; reason: string };
export type Decision = Readonly<{ allowed: true; permissions: EffectivePermissions }> | Denial;

/** Every denial is a fresh frozen value: nothing a holder does to one can change another decision. */
const deny = (category: Denial["category"], reason: string): Denial => Object.freeze({ allowed: false, category, reason });
const notFound = (): Denial => deny("not_found", "resource_not_found");

/** Own slot of a resources record, never anything inherited. */
function slot(resources: ResolvedResources, name: string): ResolvedResource | undefined {
  return Object.prototype.hasOwnProperty.call(resources, name) ? resources[name] : undefined;
}

/**
 * Every resource of a well-formed resources record, or `null` when the record
 * is malformed (a non-plain prototype, a symbol key, an invalid slot name or a
 * non-object entry). A malformed record fails closed as `not_found`.
 */
function everyResource(resources: ResolvedResources): ResolvedResource[] | null {
  if (typeof resources !== "object" || resources === null) return null;
  const prototype: unknown = Object.getPrototypeOf(resources);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const found: ResolvedResource[] = [];
  for (const key of Reflect.ownKeys(resources)) {
    if (!isSlotName(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(resources, key);
    const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof value !== "object" || value === null || typeof (value as ResolvedResource).projectId !== "string") return null;
    found.push(value as ResolvedResource);
  }
  return found;
}

/** Fresh-login state from current provider evidence only. Missing or malformed evidence is stale. */
export function freshLoginState(authority: CurrentAuthority, now: number): FreshLoginState {
  if (isFullAuthority(authority.actor)) return "exempt";
  if (authority.actor.kind !== "human") return "unavailable";
  const at = authority.evidence?.authenticatedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || !Number.isFinite(now)) return "stale";
  const age = now - at;
  return age >= 0 && age < FRESH_LOGIN_WINDOW_MS ? "satisfied" : "stale";
}

/**
 * Visibility (decision M): a project is visible to full authority, to an
 * account holding `admin`, and to an account holding at least one active
 * project role on it. Visibility grants no permission.
 */
export function projectVisible(authority: CurrentAuthority, permissions: EffectivePermissions, projectId: ProjectId): boolean {
  return isFullAuthority(authority.actor) || permissions.visible(projectId);
}

function predicateHolds(name: PredicateName, authority: CurrentAuthority, resource: ResolvedResource): Denial | null {
  const session = authority.coordinationSession;
  const relation = resource.relation;
  switch (name) {
    case "claim_holder": {
      if (relation?.kind !== "claim") return deny("forbidden", "relation_unavailable");
      if (!relation.holder) return deny("conflict", "claim_not_held");
      if (!session || session.id !== relation.holder.id || session.generation !== relation.holder.generation
        || session.credentialId !== relation.holder.credentialId) return deny("claim_held", "claim_held_by_another_session");
      return null;
    }
    case "run_originating_session": {
      // Cancel from the originating session only. This is NOT the I1 original-intent lookup.
      if (relation?.kind !== "test_run") return deny("forbidden", "relation_unavailable");
      if (!relation.origin || !session || session.id !== relation.origin.sessionId || session.credentialId !== relation.origin.credentialId) {
        return deny("forbidden", "not_originating_session");
      }
      return null;
    }
    case "worker_assignment": {
      if (relation?.kind !== "worker_attempt") return deny("forbidden", "relation_unavailable");
      const assignee = relation.assignee;
      if (!assignee || !session || session.id !== assignee.sessionId) return deny("forbidden", "not_assigned");
      if (authority.actor.kind === "agent" && assignee.accountId !== authority.actor.accountId) return deny("forbidden", "not_assigned");
      if (authority.actor.kind === "human") return deny("forbidden", "not_assigned");
      return null;
    }
  }
}

/** Runs only after masking: every referenced resource exists and is visible. */
function evaluate(requirement: Requirement, input: PermittedDecisionInput, permissions: EffectivePermissions): Denial | null {
  const { authority, resources } = input;
  const full = isFullAuthority(authority.actor);
  switch (requirement.kind) {
    case "authenticated":
    case "collection":
      return null;
    case "installation":
      return full || permissions.installation.has(requirement.permission) ? null : deny("forbidden", "permission_denied");
    case "project": {
      const resource = slot(resources, requirement.resource);
      if (!resource) return notFound();
      return full || permissions.project(resource.projectId).has(requirement.permission) ? null : deny("forbidden", "permission_denied");
    }
    case "predicate": {
      const resource = slot(resources, requirement.resource);
      if (!resource) return notFound();
      return predicateHolds(requirement.predicate, authority, resource);
    }
    case "all":
      for (const part of requirement.of) {
        const denial = evaluate(part, input, permissions);
        if (denial) return denial;
      }
      return null;
  }
}

/**
 * The single authorization decision, used at admission, before each new
 * effect, before replay, before release and per stream event. Pure.
 *
 * Masking comes first: before the human-only flag, fresh login and any
 * requirement branch, every slot the requirement names must be resolved and
 * every referenced resource must be visible. Otherwise the decision is
 * `not_found`/`resource_not_found`, identical for a missing and an invisible
 * resource, independent of flags and of the order of conjunction branches.
 * Only then can `forbidden`, `login_stale`, `claim_held` or `conflict` reveal
 * anything, and only about a resource the caller can already see.
 *
 * Full authority passes permissions, the human-only flag and fresh login, but
 * not resource resolution or the predicates that protect foreign claims, runs
 * and assignments.
 */
export function decide(input: DecisionInput): Decision {
  const { authority, requirement, resources, grants, now } = input;
  return decideWith({ authority, requirement, resources, now, permissions: effectivePermissions(authority.actor, grants) });
}

/**
 * `decide` on effective permissions computed beforehand. Pure module code: it
 * calls no adapter and reads only the frozen authority, the frozen requirement,
 * the frozen resolution copies and the permission set's closures, so a
 * decision after resolution can only end in one of its own answers (decision Y).
 */
export function decideWith(input: PermittedDecisionInput): Decision {
  const { authority, requirement, resources, permissions, now } = input;
  const all = everyResource(resources);
  if (!all) return notFound();
  for (const name of requiredSlots(requirement.require)) if (!isSlotName(name) || !slot(resources, name)) return notFound();
  // Every own slot, whatever its name: nothing referenced escapes masking.
  for (const resource of all) if (!projectVisible(authority, permissions, resource.projectId)) return notFound();
  if (requirement.agents === false && authority.actor.kind === "agent") return deny("forbidden", "human_only");
  const denial = evaluate(requirement.require, input, permissions);
  if (denial) return denial;
  if (requirement.freshLogin) {
    const state = freshLoginState(authority, now);
    if (state === "unavailable") return deny("forbidden", "fresh_login_unavailable");
    if (state === "stale") return deny("login_stale", "fresh_login_required");
  }
  return Object.freeze({ allowed: true, permissions });
}
