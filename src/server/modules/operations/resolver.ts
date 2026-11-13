import type { AccountId, ProjectId } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import { isSlotName, resourceKinds, type ResolvedResource, type ResolvedResources, type ResourceRef, type ResourceRelation } from "./requirements";

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

const invalidSlots = () => new OperationError("internal", "invalid_resource_slot");

/** Data value of an own property, never an accessor and never anything inherited. */
function own(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Slot names of a plain record: every own key, validated. Throws `internal`/`invalid_resource_slot`. */
function slotsOf(record: unknown): string[] {
  if (typeof record !== "object" || record === null) throw invalidSlots();
  const prototype: unknown = Object.getPrototypeOf(record);
  // A `__proto__` literal key makes the reference the prototype; it would otherwise vanish from every check.
  if (prototype !== null && prototype !== Object.prototype) throw invalidSlots();
  const keys = Reflect.ownKeys(record);
  if (!keys.every(isSlotName)) throw invalidSlots();
  return keys as string[];
}

/**
 * Resolves every slot and verifies the adapter answered for the same
 * namespace and ID. A wrong or malformed answer is treated as not-found,
 * never as a hint to try another namespace. Slot names must match
 * `SLOT_NAME`; the result is a deep, frozen, null-prototype copy.
 */
export function resolveAll(resolver: ResourceResolver, refs: Readonly<Record<string, ResourceRef>>): ResolvedResources {
  const resolved = Object.create(null) as Record<string, ResolvedResource>;
  for (const name of slotsOf(refs)) {
    const ref = own(refs, name);
    if (typeof ref !== "object" || ref === null) throw new OperationError("invalid_request", "invalid_resource_reference");
    const kind = own(ref, "kind"), id = own(ref, "id");
    if (!(resourceKinds as readonly unknown[]).includes(kind)) throw new OperationError("invalid_request", "unknown_resource_kind");
    if (!isText(id)) throw new OperationError("invalid_request", "invalid_resource_id");
    const reference = Object.freeze({ kind: kind as ResourceRef["kind"], id });
    const copy = copyResolved(resolver.resolve({ ...reference }));
    if (!copy || copy.ref.kind !== reference.kind || copy.ref.id !== reference.id) throw new OperationError("not_found", "resource_not_found");
    Object.defineProperty(resolved, name, { value: copy, enumerable: true });
  }
  return Object.freeze(resolved);
}

/** Validated, frozen copy of one resolution; `null` when malformed. */
function copyResolved(value: unknown): ResolvedResource | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const ref = source.ref, projectId = source.projectId, version = source.version;
  if (typeof ref !== "object" || ref === null) return null;
  const kind = (ref as Record<string, unknown>).kind, id = (ref as Record<string, unknown>).id;
  if (!(resourceKinds as readonly unknown[]).includes(kind) || !isText(id) || !isText(projectId) || !Number.isSafeInteger(version)) return null;
  const relation = copyRelation(source.relation);
  if (relation === undefined) return null;
  return Object.freeze({ ref: Object.freeze({ kind: kind as ResourceRef["kind"], id }), projectId: projectId as ProjectId, version: version as number, relation });
}

/**
 * Validated deep copy of a resources record read back from a store (for
 * example a retained idempotency record). `null` when anything is malformed.
 */
export function copyResolution(value: unknown): ResolvedResources | null {
  try {
    const copy = Object.create(null) as Record<string, ResolvedResource>;
    for (const name of slotsOf(value)) {
      const resource = copyResolved(own(value as object, name));
      if (!resource) return null;
      Object.defineProperty(copy, name, { value: resource, enumerable: true });
    }
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

/**
 * Whether every slot still maps to the same reference, project and relation
 * version. Compares every own slot of both records, whatever its name.
 */
export function sameResolution(before: ResolvedResources, after: ResolvedResources): boolean {
  let left: string[], right: string[];
  try { left = slotsOf(before); right = slotsOf(after); } catch { return false; }
  if (left.length !== right.length) return false;
  return left.every(name => {
    if (!right.includes(name)) return false;
    const a = own(before, name) as ResolvedResource | undefined, b = own(after, name) as ResolvedResource | undefined;
    return !!a && !!b && a.ref.kind === b.ref.kind && a.ref.id === b.ref.id && a.projectId === b.projectId && a.version === b.version;
  });
}
