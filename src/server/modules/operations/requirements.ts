import type { AccountId, InstallationPermission, ProjectId, ProjectPermission } from "@/shared/contracts/operations";
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
export type ResolvedResources = Readonly<Record<string, ResolvedResource>>;

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

export const authenticated = (): Requirement => ({ kind: "authenticated" });
export const installation = (permission: InstallationPermission): Requirement => ({ kind: "installation", permission });
export const onProject = (permission: ProjectPermission, resource: string): Requirement => ({ kind: "project", permission, resource });
export const allOf = (...of: Requirement[]): Requirement => ({ kind: "all", of });
export const collection = (permission: ProjectPermission): Requirement => ({ kind: "collection", permission });
export const claimHolder = (resource: string): Requirement => ({ kind: "predicate", predicate: "claim_holder", resource });
export const runOriginatingSession = (resource: string): Requirement => ({ kind: "predicate", predicate: "run_originating_session", resource });
export const workerAssignment = (resource: string): Requirement => ({ kind: "predicate", predicate: "worker_assignment", resource });

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
