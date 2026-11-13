import {
  isInstallationPermission, isProjectPermission,
  type AccountId, type InstallationPermission, type ProjectId, type ProjectPermission,
} from "@/shared/contracts/operations";
import type { CoordinationSessionRef } from "./authentication-context";

/**
 * Typed reference to something an operation acts on. Each kind resolves in its
 * own namespace to exactly one project or to not-found.
 */
export type ResourceKind =
  | "project" | "registration" | "claim" | "test_run" | "profile" | "vault_entry" | "knowledge_record" | "worker_attempt"
  | "project_claim" | "schedule" | "remote_request" | "test_intent";
export const resourceKinds: readonly ResourceKind[] = Object.freeze([
  "project", "registration", "claim", "test_run", "profile", "vault_entry", "knowledge_record", "worker_attempt",
  "project_claim", "schedule", "remote_request", "test_intent",
]);
/**
 * A typed reference. Kinds added by the slice 4 contract extensions:
 *
 * - `project_claim`: the claim slot of one project; its ID is the project ID.
 *   It resolves while the project exists, to that project, with a `claim`
 *   relation whose holder is `null` when no claim exists. Absence of a claim is
 *   therefore a resolved, versioned fact, never a missing resource.
 * - `schedule`: an export schedule, execution or artifact, with its durable owner.
 * - `remote_request`: a remote verification request, with its stored submitter.
 * - `test_intent`: a saved original test-run intent, with its origin.
 */
export interface ResourceRef { kind: ResourceKind; id: string }

/**
 * A principal stored durably with a resource (a schedule owner, a request
 * submitter, an intent origin). Never a session: an account, or one of the two
 * full-authority actor kinds.
 */
export type StoredPrincipal = { kind: "account"; accountId: AccountId } | { kind: "installation" } | { kind: "operator" };

/**
 * Origin of a saved test-run intent (I1, `intent_origin`). The digest binds the
 * other fields under an explicit digest version (`intentOriginDigest`).
 */
export interface IntentOrigin {
  principal: StoredPrincipal;
  credentialId: string;
  credentialGeneration: number;
  projectId: ProjectId;
  worktree: string;
  preset: string;
  key: string;
  digest: string;
  digestVersion: number;
}

/** Relation facts used by ownership and assignment predicates. */
export type ResourceRelation =
  | { kind: "claim"; holder: CoordinationSessionRef | null }
  | { kind: "test_run"; origin: { sessionId: string; credentialId: string } | null }
  | { kind: "worker_attempt"; assignee: { accountId: AccountId | null; sessionId: string } | null }
  | { kind: "schedule"; owner: StoredPrincipal }
  | { kind: "remote_request"; submitter: StoredPrincipal }
  | { kind: "test_intent"; origin: IntentOrigin };

export interface ResolvedResource {
  readonly ref: ResourceRef;
  readonly projectId: ProjectId;
  /**
   * Changes whenever the resource's project mapping or relation changes, and is
   * never reused for the same reference, including after delete and recreate.
   * Replay and every recheck compare it.
   */
  readonly version: number;
  readonly relation: ResourceRelation | null;
}
/**
 * Resolved resources by slot name. Built by `resolveAll` as a frozen
 * null-prototype record, so no slot name can reach a prototype.
 */
export type ResolvedResources = Readonly<Record<string, ResolvedResource>>;

/**
 * Resource slot names: an identifier of at most 64 characters. Rejects
 * `__proto__`, `constructor` look-alikes with leading underscores, empty names
 * and anything that is not a plain identifier. Checked when an operation is
 * registered and again whenever resources are resolved or compared. The
 * pattern is private and created per call, so no caller can reach or change
 * a shared `RegExp` (its `lastIndex`, flags or methods).
 */
export const isSlotName = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);

export type PredicateName =
  | "claim_holder" | "run_originating_session" | "worker_assignment"
  | "claim_holder_if_claimed" | "schedule_owner" | "request_submitter" | "intent_origin";

export type Requirement =
  | { kind: "authenticated" }
  | { kind: "installation"; permission: InstallationPermission }
  | { kind: "project"; permission: ProjectPermission; resource: string }
  | { kind: "all"; of: readonly Requirement[] }
  /** A query over many projects: items are released per project holding `permission`. */
  | { kind: "collection"; permission: ProjectPermission }
  /**
   * An aggregate: `permission` on at least one current project. Decided at
   * every decision point, independently of collection filtering. Full
   * authority passes, also on an installation without projects.
   */
  | { kind: "any_project"; permission: ProjectPermission }
  /** Every named slot resolves to one and the same project; otherwise `not_found`. */
  | { kind: "same_project"; resources: readonly string[] }
  | { kind: "predicate"; predicate: PredicateName; resource: string };

/** The complete requirement of an operation, evaluated at every decision point. */
export interface OperationRequirement {
  require: Requirement;
  /** `false`: agents may never run it, whatever their grants. */
  agents?: false;
  /** Requires a human login within the fresh-login window, from provider evidence. */
  freshLogin?: true;
}

// Every constructor returns a frozen value, so a requirement shared by an operation cannot be changed by a holder.
export const authenticated = (): Requirement => Object.freeze({ kind: "authenticated" });
export const installation = (permission: InstallationPermission): Requirement => Object.freeze({ kind: "installation", permission });
export const onProject = (permission: ProjectPermission, resource: string): Requirement => Object.freeze({ kind: "project", permission, resource });
export const allOf = (...of: Requirement[]): Requirement => Object.freeze({ kind: "all", of: Object.freeze([...of]) });
export const collection = (permission: ProjectPermission): Requirement => Object.freeze({ kind: "collection", permission });
export const claimHolder = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "claim_holder", resource });
export const runOriginatingSession = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "run_originating_session", resource });
export const workerAssignment = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "worker_assignment", resource });
export const claimHolderIfClaimed = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "claim_holder_if_claimed", resource });
export const scheduleOwner = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "schedule_owner", resource });
export const requestSubmitter = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "request_submitter", resource });
export const intentOrigin = (resource: string): Requirement => Object.freeze({ kind: "predicate", predicate: "intent_origin", resource });
export const anyProject = (permission: ProjectPermission): Requirement => Object.freeze({ kind: "any_project", permission });
export const sameProject = (...resources: string[]): Requirement => Object.freeze({ kind: "same_project", resources: Object.freeze([...resources]) });

const PREDICATES: readonly PredicateName[] = Object.freeze([
  "claim_holder", "run_originating_session", "worker_assignment",
  "claim_holder_if_claimed", "schedule_owner", "request_submitter", "intent_origin",
]);

/**
 * Validates a requirement and returns a deeply frozen copy. Throws `TypeError`
 * for an unknown kind, permission or predicate, a malformed slot name, an
 * empty conjunction or nesting deeper than 16. Used at registration.
 */
export function frozenRequirement(value: unknown, depth = 0): Requirement {
  if (depth > 16 || typeof value !== "object" || value === null) throw new TypeError("Invalid requirement.");
  const source = value as Record<string, unknown>;
  switch (source.kind) {
    case "authenticated": return authenticated();
    case "installation":
      if (!isInstallationPermission(source.permission)) throw new TypeError("Unknown installation permission in requirement.");
      return installation(source.permission);
    case "project":
      if (!isProjectPermission(source.permission)) throw new TypeError("Unknown project permission in requirement.");
      if (!isSlotName(source.resource)) throw new TypeError("Invalid resource slot name in requirement.");
      return onProject(source.permission, source.resource);
    case "collection":
      if (!isProjectPermission(source.permission)) throw new TypeError("Unknown project permission in requirement.");
      return collection(source.permission);
    case "any_project":
      if (!isProjectPermission(source.permission)) throw new TypeError("Unknown project permission in requirement.");
      return anyProject(source.permission);
    case "same_project": {
      const names: unknown = source.resources;
      if (!Array.isArray(names) || names.length < 2 || names.length > 16 || !names.every(isSlotName) || new Set(names).size !== names.length) {
        throw new TypeError("`same_project` needs two to sixteen distinct valid slot names.");
      }
      return sameProject(...(names as string[]));
    }
    case "predicate":
      if (!(PREDICATES as readonly unknown[]).includes(source.predicate)) throw new TypeError("Unknown predicate in requirement.");
      if (!isSlotName(source.resource)) throw new TypeError("Invalid resource slot name in requirement.");
      return Object.freeze({ kind: "predicate", predicate: source.predicate as PredicateName, resource: source.resource });
    case "all": {
      if (!Array.isArray(source.of) || source.of.length === 0) throw new TypeError("A conjunction needs at least one requirement.");
      return allOf(...source.of.map(part => frozenRequirement(part, depth + 1)));
    }
    default: throw new TypeError("Unknown requirement kind.");
  }
}

/** Validated, deeply frozen copy of a complete operation requirement. */
export function frozenOperationRequirement(value: unknown): OperationRequirement {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid operation requirement.");
  const source = value as Record<string, unknown>;
  if (source.agents !== undefined && source.agents !== false) throw new TypeError("`agents` is either absent or false.");
  if (source.freshLogin !== undefined && source.freshLogin !== true) throw new TypeError("`freshLogin` is either absent or true.");
  return Object.freeze({
    require: frozenRequirement(source.require),
    ...(source.agents === false ? { agents: false as const } : {}),
    ...(source.freshLogin === true ? { freshLogin: true as const } : {}),
  });
}

/** Resource slots a requirement refers to. Every slot must be resolved before a decision. */
export function requiredSlots(requirement: Requirement): string[] {
  switch (requirement.kind) {
    case "project": case "predicate": return [requirement.resource];
    case "same_project": return [...requirement.resources];
    case "all": return [...new Set(requirement.of.flatMap(requiredSlots))];
    default: return [];
  }
}

/**
 * Every collection permission of a requirement. Release of a collection item
 * requires all of them on the item's project, plus visibility.
 */
export function collectionPermissions(requirement: Requirement): ProjectPermission[] {
  if (requirement.kind === "collection") return [requirement.permission];
  if (requirement.kind === "all") return [...new Set(requirement.of.flatMap(collectionPermissions))];
  return [];
}

/** Whether a requirement contains an `any_project` part (the runner then reads the current project list). */
export function usesAnyProject(requirement: Requirement): boolean {
  if (requirement.kind === "any_project") return true;
  return requirement.kind === "all" && requirement.of.some(usesAnyProject);
}

/** Every predicate part of a requirement (a requirement is a conjunction, so each one must hold). */
export function predicatesOf(requirement: Requirement): { predicate: PredicateName; resource: string }[] {
  if (requirement.kind === "predicate") return [{ predicate: requirement.predicate, resource: requirement.resource }];
  if (requirement.kind === "all") return requirement.of.flatMap(predicatesOf);
  return [];
}
