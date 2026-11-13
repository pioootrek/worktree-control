import type { AccountId, ProjectId } from "@/shared/contracts/operations";
import { OperationError } from "./errors";
import { isSlotName, resourceKinds, type ResolvedResource, type ResolvedResources, type ResourceRef, type ResourceRelation } from "./requirements";
import { absorb, isThenable } from "./synchronous";

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

/** Syntax errors of a reference, most general first. The reported reason is the first one any reference has. */
const SYNTAX_REASONS = Object.freeze(["invalid_resource_reference", "unknown_resource_kind", "invalid_resource_id"] as const);
type SyntaxReason = typeof SYNTAX_REASONS[number];

/** A frozen copy of a well-formed reference, or the reason it is malformed. Reads own data properties only. */
function referenceOf(value: unknown): ResourceRef | SyntaxReason {
  if (typeof value !== "object" || value === null) return "invalid_resource_reference";
  const kind = own(value, "kind"), id = own(value, "id");
  if (!(resourceKinds as readonly unknown[]).includes(kind)) return "unknown_resource_kind";
  if (!isText(id)) return "invalid_resource_id";
  return Object.freeze({ kind: kind as ResourceRef["kind"], id });
}

/** Slots in code-unit order, so no answer depends on the order in which an operation listed its references. */
const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Resolves every slot and verifies the adapter answered for the same
 * namespace and ID. A wrong or malformed answer is treated as not-found,
 * never as a hint to try another namespace. Slot names must satisfy
 * `isSlotName`; the result is a deep, frozen, null-prototype copy.
 *
 * Decision X, three passes, so that no answer depends on the order of the
 * references or on whether a resource the caller cannot see exists:
 *
 * 1. Syntax of every reference, before any lookup. Any malformed reference is
 *    `invalid_request`, whatever exists; with several, the reason is the first
 *    of `SYNTAX_REASONS` that any of them has.
 * 2. Every reference is resolved, without stopping at a miss or a failure.
 * 3. One answer. A failed lookup (the resolver threw or returned a thenable)
 *    wins over a miss: the failure of the first failing slot in code-unit
 *    order is thrown, so a fault is never hidden as `not_found` and never
 *    depends on what the other references are. Otherwise any miss is
 *    `not_found`/`resource_not_found`, the same value `decide` gives when it
 *    masks an invisible resource.
 */
export function resolveAll(resolver: ResourceResolver, refs: Readonly<Record<string, ResourceRef>>): ResolvedResources {
  const names = slotsOf(refs).sort(byName);
  // 1. Syntax.
  const references: ResourceRef[] = [];
  const malformed = new Set<SyntaxReason>();
  for (const name of names) {
    const reference = referenceOf(own(refs, name));
    if (typeof reference === "string") malformed.add(reference); else references.push(reference);
  }
  const reason = SYNTAX_REASONS.find(candidate => malformed.has(candidate));
  if (reason) throw new OperationError("invalid_request", reason);

  // 2. Every lookup.
  const answers = references.map((reference): { found: ResolvedResource | null } | { failed: unknown } => {
    try {
      const answer: unknown = resolver.resolve({ ...reference });
      if (isThenable(answer)) { absorb(answer); return { failed: new OperationError("internal", "resolver_not_synchronous") }; }
      const copy = copyResolved(answer);
      return { found: copy && copy.ref.kind === reference.kind && copy.ref.id === reference.id ? copy : null };
    } catch (error) {
      return { failed: error };
    }
  });

  // 3. One answer.
  const failure = answers.find(answer => "failed" in answer);
  if (failure && "failed" in failure) throw failure.failed;
  if (answers.some(answer => !("found" in answer) || !answer.found)) throw new OperationError("not_found", "resource_not_found");
  const resolved = Object.create(null) as Record<string, ResolvedResource>;
  answers.forEach((answer, index) => {
    if ("found" in answer && answer.found) Object.defineProperty(resolved, names[index], { value: answer.found, enumerable: true });
  });
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
