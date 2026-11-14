import {
  isInstallationPermission, isProjectPermission,
  type AccountId, type InstallationPermission, type ProjectId, type ProjectPermission,
} from "@/shared/contracts/operations";
import type { CoordinationSessionRef } from "./authentication-context";

/**
 * Typed reference to something an operation acts on. Each kind resolves in its
 * own namespace to exactly one project or to not-found.
 */
export type ResourceKind = "project" | "registration" | "claim" | "test_run" | "profile" | "vault_entry" | "knowledge_record" | "worker_attempt";
export const resourceKinds: readonly ResourceKind[] = Object.freeze([
  "project", "registration", "claim", "test_run", "profile", "vault_entry", "knowledge_record", "worker_attempt",
]);
export interface ResourceRef { kind: ResourceKind; id: string }

/** Relation facts used by ownership and assignment predicates. */
export type ResourceRelation =
  | { kind: "claim"; holder: CoordinationSessionRef | null }
  | { kind: "test_run"; origin: { sessionId: string; credentialId: string } | null }
  | { kind: "worker_attempt"; assignee: { accountId: AccountId | null; sessionId: string } | null };

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

export type PredicateName = "claim_holder" | "run_originating_session" | "worker_assignment";

export type Requirement =
  | { kind: "authenticated" }
  | { kind: "installation"; permission: InstallationPermission }
  | { kind: "project"; permission: ProjectPermission; resource: string }
  | { kind: "all"; of: readonly Requirement[] }
  /** A query over many projects: items are released per project holding `permission`. */
  | { kind: "collection"; permission: ProjectPermission }
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

const PREDICATES: readonly PredicateName[] = Object.freeze(["claim_holder", "run_originating_session", "worker_assignment"]);

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
