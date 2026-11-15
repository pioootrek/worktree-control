import { createHash } from "node:crypto";
import { FRESH_LOGIN_WINDOW_MS, type ErrorCategory, type FreshLoginState, type ProjectId } from "@/shared/contracts/operations";
import { isFullAuthority, type CredentialRef, type CurrentAuthority } from "./authentication-context";
import { effectivePermissions, type EffectivePermissions, type GrantsSnapshot } from "./grants";
import type { IntentOrigin, OperationRequirement, PredicateName, Requirement, ResolvedResource, ResolvedResources, StoredPrincipal } from "./requirements";
import { isSlotName, predicatesOf, requiredSlots } from "./requirements";

/**
 * Facts besides the resources that some requirement forms need. Both are read
 * in the same admitted phase as the decision, before resolution (decision Y).
 */
interface DecisionFacts {
  /**
   * Every current project, read only when the requirement has an `any_project`
   * part. Absent: an `any_project` part is denied (fail closed).
   */
  projects?: readonly ProjectId[];
  /** The credential the caller's context was minted from (`intent_origin`). Absent or `null`: no credential. */
  credential?: CredentialRef | null;
}

export interface DecisionInput extends DecisionFacts {
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
export interface PermittedDecisionInput extends DecisionFacts {
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
 * is malformed (a non-plain prototype, a symbol key, an invalid slot name, a
 * non-object entry, or a project that is neither a non-empty string nor the
 * explicit parentless `null`). A malformed record fails closed as `not_found`.
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
    if (typeof value !== "object" || value === null) return null;
    const projectId: unknown = (value as ResolvedResource).projectId;
    if (projectId !== null && (typeof projectId !== "string" || projectId.length === 0)) return null;
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
 *
 * `null` is "no project" (a parentless resource or item): visible to full
 * authority only. No account sees it, whatever it holds; in particular an
 * installation-scope grant (`admin`), which makes every project visible,
 * does not reach a resource without a project.
 */
export function projectVisible(authority: CurrentAuthority, permissions: EffectivePermissions, projectId: ProjectId | null): boolean {
  if (isFullAuthority(authority.actor)) return true;
  return isProjectId(projectId) && permissions.visible(projectId);
}

/** A project ID as this module accepts one: a non-empty string. `null` (no project) and anything else are not. */
export const isProjectId = (value: unknown): value is ProjectId => typeof value === "string" && value.length > 0;

/**
 * The principal recorded for a caller's durable ownership (schedule owner,
 * request submitter, intent origin): the account for a human or agent; for
 * full authority `installation`, except the operator in better-auth mode,
 * which is recorded as `operator` (`46672ea8`, `fb1567d5`). In open and token
 * mode the operator and the installation are one principal.
 */
export function durablePrincipal(authority: CurrentAuthority): StoredPrincipal {
  const actor = authority.actor;
  if (actor.kind === "human" || actor.kind === "agent") return Object.freeze({ kind: "account", accountId: actor.accountId });
  if (actor.kind === "operator" && authority.mode === "better-auth") return Object.freeze({ kind: "operator" });
  return Object.freeze({ kind: "installation" });
}

function samePrincipal(left: StoredPrincipal, right: StoredPrincipal): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind !== "account" || (right.kind === "account" && left.accountId === right.accountId);
}

/** Digest versions `intent_origin` accepts. A record under any other version is never adopted. */
export const INTENT_DIGEST_VERSIONS: readonly number[] = Object.freeze([1]);

/**
 * The project of an intent origin as this module accepts one: a project ID or
 * the explicit parentless `null`. A missing (`undefined`) or any other value
 * is not.
 */
const isOriginProject = (value: unknown): value is ProjectId | null => value === null || isProjectId(value);

/**
 * The saved origin digest of a test-run intent under an explicit version.
 * Version 1: SHA-256 (hex) of a JSON array binding the principal, the
 * credential identity and generation, the project, worktree, preset and key.
 * A parentless origin binds its project as JSON `null`, which no project ID
 * (a string, also `"null"`) produces, so a non-null origin's digest is the one
 * it always had. Throws `TypeError` for an unknown version and for an origin
 * project that is neither a project ID nor `null`: `JSON.stringify` would
 * write a missing (`undefined`) project as `null` and so bind it as if it
 * were parentless.
 */
export function intentOriginDigest(version: number, origin: Omit<IntentOrigin, "digest" | "digestVersion">): string {
  if (version !== 1) throw new TypeError("Unknown intent digest version.");
  if (!isOriginProject(origin.projectId)) throw new TypeError("Invalid intent origin project.");
  const principal = origin.principal;
  const text = JSON.stringify(["intent-origin-v1", principal.kind, principal.kind === "account" ? principal.accountId : null,
    origin.credentialId, origin.credentialGeneration, origin.projectId, origin.worktree, origin.preset, origin.key]);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Masking-level ownership (decided before the human-only flag and the
 * requirement, so its answer never depends on the order of conjunction
 * branches): a schedule of another owner, an intent of another principal or
 * credential or of another project (or of no project, against a project),
 * and slots that `same_project` binds but that do not all resolve to one
 * value are all `not_found`, as a missing resource is.
 */
function ownershipMasked(requirement: Requirement, input: PermittedDecisionInput): boolean {
  const { authority, resources } = input;
  const full = isFullAuthority(authority.actor);
  if (!sameProjects(requirement, resources)) return true;
  for (const { predicate, resource: name } of predicatesOf(requirement)) {
    const resource = slot(resources, name);
    const relation = resource?.relation;
    if (!resource || !relation) continue;
    if (predicate === "schedule_owner" && relation.kind === "schedule" && !full && !samePrincipal(relation.owner, durablePrincipal(authority))) return true;
    if (predicate === "intent_origin" && relation.kind === "test_intent") {
      // Strict project equality: a parentless origin (`null`) matches only a parentless resolution, a project only the same project.
      // An origin project that is neither (a missing value included) is masked before it can reach the digest.
      const origin = relation.origin, credential = input.credential ?? null;
      if (!samePrincipal(origin.principal, durablePrincipal(authority)) || !credential || credential.credentialId !== origin.credentialId
        || credential.generation !== origin.credentialGeneration || !isOriginProject(origin.projectId) || origin.projectId !== resource.projectId) return true;
    }
  }
  return false;
}

/**
 * `same_project` holds when every named slot is present and all resolve to
 * the same value: one project ID, or all `null` (parentless). A missing slot,
 * slots in different projects and a mix of parentless and project slots do
 * not satisfy it. Only full authority can reach an all-parentless binding:
 * for an account, visibility masking answers `not_found` for any parentless
 * slot before this runs.
 */
function sameProjects(requirement: Requirement, resources: ResolvedResources): boolean {
  if (requirement.kind === "all") return requirement.of.every(part => sameProjects(part, resources));
  if (requirement.kind !== "same_project") return true;
  const projects = new Set<ProjectId | null>();
  for (const name of requirement.resources) {
    const resource = slot(resources, name);
    if (!resource) return false;
    projects.add(resource.projectId);
  }
  return projects.size === 1 && [...projects].every(projectId => projectId === null || isProjectId(projectId));
}

function predicateHolds(name: PredicateName, authority: CurrentAuthority, resource: ResolvedResource): Denial | null {
  const session = authority.coordinationSession;
  const relation = resource.relation;
  switch (name) {
    case "claim_holder_if_claimed": {
      // Owner decision 42019833: no claim, anyone holding the permission; a claim, only its holder. Full authority is not exempt.
      if (relation?.kind !== "claim") return deny("forbidden", "relation_unavailable");
      if (!relation.holder) return null;
      if (!session || session.id !== relation.holder.id || session.generation !== relation.holder.generation
        || session.credentialId !== relation.holder.credentialId) return deny("claim_held", "claim_held_by_another_session");
      return null;
    }
    case "schedule_owner":
      // The ownership itself is decided by masking; only the relation's presence is left to check.
      return relation?.kind === "schedule" ? null : deny("forbidden", "relation_unavailable");
    case "request_submitter":
      if (relation?.kind !== "remote_request") return deny("forbidden", "relation_unavailable");
      return samePrincipal(relation.submitter, durablePrincipal(authority)) ? null : deny("forbidden", "not_submitter");
    case "intent_origin": {
      if (relation?.kind !== "test_intent") return deny("forbidden", "relation_unavailable");
      const { digest, digestVersion, ...origin } = relation.origin;
      if (!INTENT_DIGEST_VERSIONS.includes(digestVersion)) return deny("forbidden", "intent_digest_unsupported");
      return intentOriginDigest(digestVersion, origin) === digest ? null : deny("forbidden", "intent_digest_mismatch");
    }
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
    case "same_project":
      return null;
    case "any_project": {
      if (full) return null;
      const projects = input.projects;
      if (!projects) return deny("forbidden", "project_list_unavailable");
      // Only real projects count; a stray `null` or malformed entry is never a project the account holds anything on.
      return projects.some(projectId => isProjectId(projectId) && permissions.visible(projectId) && permissions.project(projectId).has(requirement.permission))
        ? null : deny("forbidden", "permission_denied");
    }
    case "installation":
      return full || permissions.installation.has(requirement.permission) ? null : deny("forbidden", "permission_denied");
    case "project": {
      const resource = slot(resources, requirement.resource);
      if (!resource) return notFound();
      if (full) return null;
      // Masking already answered `not_found` for a parentless slot; this keeps an account from ever reading permissions for "no project".
      if (!isProjectId(resource.projectId)) return notFound();
      return permissions.project(resource.projectId).has(requirement.permission) ? null : deny("forbidden", "permission_denied");
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
 * effect, before replay, before release and per stream event. Computes the
 * effective permissions from the snapshot (its only adapter calls), then runs
 * the pure `decideWith`; the runner calls `decideWith` directly (decision Y).
 *
 * Masking comes first: before the human-only flag, fresh login and any
 * requirement branch, every slot the requirement names must be resolved and
 * every referenced resource must be visible. Otherwise the decision is
 * `not_found`/`resource_not_found`, identical for a missing and an invisible
 * resource, independent of flags and of the order of conjunction branches.
 * A parentless resource (`projectId: null`) is visible to full authority
 * only, so for an account any parentless slot, whichever slot the
 * requirement names, masks the whole call as `not_found`.
 * Only then can `forbidden`, `login_stale`, `claim_held` or `conflict` reveal
 * anything, and only about a resource the caller can already see.
 *
 * Ownership masking follows visibility: a foreign schedule (`schedule_owner`),
 * a foreign intent (`intent_origin`) and slots bound by `same_project` that
 * do not all resolve to one project or all to no project are `not_found` as
 * well.
 *
 * Full authority passes permissions, `any_project`, the human-only flag and
 * fresh login, and manages every schedule. It does not pass resource
 * resolution or the predicates that protect foreign claims (including
 * `claim_holder_if_claimed`), runs, assignments, submitted requests and
 * intents.
 */
export function decide(input: DecisionInput): Decision {
  const { authority, requirement, resources, grants, now, projects, credential } = input;
  return decideWith({ authority, requirement, resources, now, projects, credential, permissions: effectivePermissions(authority.actor, grants) });
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
  // Every own slot, whatever its name: nothing referenced escapes masking. A parentless slot is visible to full authority only.
  for (const resource of all) if (!projectVisible(authority, permissions, resource.projectId)) return notFound();
  if (ownershipMasked(requirement.require, input)) return notFound();
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
