import { FRESH_LOGIN_WINDOW_MS, type ErrorCategory, type FreshLoginState, type ProjectId } from "@/shared/contracts/operations";
import { isFullAuthority, type CurrentAuthority } from "./authentication-context";
import { effectivePermissions, type EffectivePermissions, type GrantsSnapshot } from "./grants";
import type { OperationRequirement, PredicateName, Requirement, ResolvedResource, ResolvedResources } from "./requirements";
import { requiredSlots } from "./requirements";

export interface DecisionInput {
  authority: CurrentAuthority;
  requirement: OperationRequirement;
  /** Every resource the operation references, resolved in this phase. */
  resources: ResolvedResources;
  grants: GrantsSnapshot;
  /** Milliseconds since the epoch. */
  now: number;
}

export type Denial = { allowed: false; category: Extract<ErrorCategory, "forbidden" | "login_stale" | "not_found" | "claim_held" | "conflict">; reason: string };
export type Decision = { allowed: true; permissions: EffectivePermissions } | Denial;

const deny = (category: Denial["category"], reason: string): Denial => ({ allowed: false, category, reason });
const NOT_FOUND = deny("not_found", "resource_not_found");

/** Fresh-login state from current provider evidence only. Missing or malformed evidence is stale. */
export function freshLoginState(authority: CurrentAuthority, now: number): FreshLoginState {
  if (isFullAuthority(authority.actor)) return "exempt";
  if (authority.actor.kind !== "human") return "unavailable";
  const at = authority.evidence?.authenticatedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || !Number.isFinite(now)) return "stale";
  const age = now - at;
  return age >= 0 && age < FRESH_LOGIN_WINDOW_MS ? "satisfied" : "stale";
}

/** A project is visible to an actor holding `project:read` on it, or to full authority. */
export function projectVisible(authority: CurrentAuthority, permissions: EffectivePermissions, projectId: ProjectId): boolean {
  return isFullAuthority(authority.actor) || permissions.project(projectId).has("project:read");
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
function evaluate(requirement: Requirement, input: DecisionInput, permissions: EffectivePermissions): Denial | null {
  const { authority, resources } = input;
  const full = isFullAuthority(authority.actor);
  switch (requirement.kind) {
    case "authenticated":
    case "collection":
      return null;
    case "installation":
      return full || permissions.installation.has(requirement.permission) ? null : deny("forbidden", "permission_denied");
    case "project": {
      const resource = resources[requirement.resource];
      if (!resource) return NOT_FOUND;
      return full || permissions.project(resource.projectId).has(requirement.permission) ? null : deny("forbidden", "permission_denied");
    }
    case "predicate": {
      const resource = resources[requirement.resource];
      if (!resource) return NOT_FOUND;
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
  const permissions = effectivePermissions(authority.actor, grants);
  for (const slot of requiredSlots(requirement.require)) if (!Object.prototype.hasOwnProperty.call(resources, slot)) return NOT_FOUND;
  for (const resource of Object.values(resources)) if (!projectVisible(authority, permissions, resource.projectId)) return NOT_FOUND;
  if (requirement.agents === false && authority.actor.kind === "agent") return deny("forbidden", "human_only");
  const denial = evaluate(requirement.require, input, permissions);
  if (denial) return denial;
  if (requirement.freshLogin) {
    const state = freshLoginState(authority, now);
    if (state === "unavailable") return deny("forbidden", "fresh_login_unavailable");
    if (state === "stale") return deny("login_stale", "fresh_login_required");
  }
  return { allowed: true, permissions };
}
