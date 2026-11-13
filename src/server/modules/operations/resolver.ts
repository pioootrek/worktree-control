import type { AccountId, ProjectId } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import { resourceKinds, type ResolvedResource, type ResolvedResources, type ResourceRef, type ResourceRelation } from "./requirements";

/**
 * Port mapping typed references to their current project. Called inside an
 * admitted phase. Each kind is looked up only in its own namespace: an ID that
 * happens to exist in another namespace is not found here.
 */
export interface ResourceResolver {
  /** Exactly one current mapping, or `null` for not-found. */
  resolve(ref: ResourceRef): ResolvedResource | null;
  /** Every current project, for collection queries. Released only after per-item filtering. */
  listProjects(): readonly ProjectId[];
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function copySession(value: unknown): { id: string; generation: number; credentialId: string } | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) return undefined;
  const { id, generation, credentialId } = value as Record<string, unknown>;
  return isText(id) && Number.isSafeInteger(generation) && isText(credentialId) ? Object.freeze({ id, generation: generation as number, credentialId }) : undefined;
}

/** Deep, frozen copy of a relation; `undefined` when malformed. */
function copyRelation(value: unknown): ResourceRelation | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  switch (source.kind) {
    case "claim": {
      const holder = copySession(source.holder);
      return holder === undefined ? undefined : Object.freeze({ kind: "claim", holder });
    }
    case "test_run": {
      if (source.origin === null) return Object.freeze({ kind: "test_run", origin: null });
      if (typeof source.origin !== "object" || source.origin === undefined) return undefined;
      const { sessionId, credentialId } = source.origin as Record<string, unknown>;
      return isText(sessionId) && isText(credentialId) ? Object.freeze({ kind: "test_run", origin: Object.freeze({ sessionId, credentialId }) }) : undefined;
    }
    case "worker_attempt": {
      if (source.assignee === null) return Object.freeze({ kind: "worker_attempt", assignee: null });
      if (typeof source.assignee !== "object" || source.assignee === undefined) return undefined;
      const { accountId, sessionId } = source.assignee as Record<string, unknown>;
      if (!(accountId === null || isText(accountId)) || !isText(sessionId)) return undefined;
      return Object.freeze({ kind: "worker_attempt", assignee: Object.freeze({ accountId: accountId as AccountId | null, sessionId }) });
    }
    default: return undefined;
  }
}

/**
 * Resolves every slot and verifies the adapter answered for the same
 * namespace and ID. A wrong or malformed answer is treated as not-found,
 * never as a hint to try another namespace. The result is a deep, frozen copy.
 */
export function resolveAll(resolver: ResourceResolver, refs: Readonly<Record<string, ResourceRef>>): ResolvedResources {
  const resolved: Record<string, ResolvedResource> = {};
  for (const [slot, ref] of Object.entries(refs)) {
    if (!resourceKinds.includes(ref.kind)) throw new OperationError("invalid_request", "unknown_resource_kind");
    if (!isText(ref.id)) throw new OperationError("invalid_request", "invalid_resource_id");
    const own = Object.freeze({ kind: ref.kind, id: ref.id });
    const result = resolver.resolve({ ...own });
    const relation = result ? copyRelation(result.relation) : undefined;
    if (!result || result.ref?.kind !== own.kind || result.ref?.id !== own.id || !isText(result.projectId)
      || !Number.isSafeInteger(result.version) || relation === undefined) {
      throw new OperationError("not_found", "resource_not_found");
    }
    resolved[slot] = Object.freeze({ ref: own, projectId: result.projectId, version: result.version, relation });
  }
  return Object.freeze(resolved);
}

/** Whether every slot still maps to the same reference, project and relation version. */
export function sameResolution(before: ResolvedResources, after: ResolvedResources): boolean {
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  return keys.every(key => {
    const left = before[key], right = after[key];
    return !!right && left.ref.kind === right.ref.kind && left.ref.id === right.ref.id
      && right.projectId === left.projectId && right.version === left.version;
  });
}
