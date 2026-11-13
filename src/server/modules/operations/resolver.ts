import type { ProjectId } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import { resourceKinds, type ResolvedResource, type ResolvedResources, type ResourceRef } from "./requirements";

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

/**
 * Resolves every slot and verifies the adapter answered for the same
 * namespace and ID. A wrong answer is treated as not-found, never as a hint
 * to try another namespace.
 */
export function resolveAll(resolver: ResourceResolver, refs: Readonly<Record<string, ResourceRef>>): ResolvedResources {
  const resolved: Record<string, ResolvedResource> = {};
  for (const [slot, ref] of Object.entries(refs)) {
    if (!resourceKinds.includes(ref.kind)) throw new OperationError("invalid_request", "unknown_resource_kind");
    const result = resolver.resolve(ref);
    if (!result || result.ref.kind !== ref.kind || result.ref.id !== ref.id || typeof result.projectId !== "string") {
      throw new OperationError("not_found", "resource_not_found");
    }
    resolved[slot] = Object.freeze({ ...result, ref: Object.freeze({ ...ref }) });
  }
  return Object.freeze(resolved);
}

/** Whether every slot still maps to the same project and relation version. */
export function sameResolution(before: ResolvedResources, after: ResolvedResources): boolean {
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  return keys.every(key => after[key] && after[key].projectId === before[key].projectId && after[key].version === before[key].version);
}
