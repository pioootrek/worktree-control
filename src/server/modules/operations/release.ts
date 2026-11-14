import { types } from "node:util";
import {
  effectStates, errorCategoryStatus, retryDispositions,
  type ActorKind, type InstallationPermission, type ProjectId, type ProjectPermission, type PublicOperationError,
} from "@/shared/contracts/operations";
import { isFullAuthority, type CoordinationSessionRef, type CurrentAuthority } from "./authentication-context";
import { projectVisible } from "./decide";
import { OperationError } from "./errors";
import type { EffectivePermissions } from "./grants";
import type { ResolvedResources } from "./requirements";

export const MAX_PAGE_SIZE = 100;
/** Nesting bound of a released value. */
export const MAX_RELEASE_DEPTH = 32;
/** Bound of the number of values (objects, arrays and primitives) in one released value. */
export const MAX_RELEASE_NODES = 100_000;

export interface Page<T> { items: T[]; nextCursor: string | null }

/**
 * Everything a projector may consult to release data. Built from the decision
 * of the same admitted phase; it carries no credential, session secret or
 * verifier, only the facts a projection needs.
 */
export interface ReleaseContext {
  readonly actorKind: ActorKind;
  readonly fullAuthority: boolean;
  readonly resources: ResolvedResources;
  /** The caller's coordination session ID, for "own claim/run" projections. Never released itself. */
  ownsSession(session: Pick<CoordinationSessionRef, "id" | "credentialId"> | null): boolean;
  can(permission: ProjectPermission, projectId: ProjectId): boolean;
  canInstallation(permission: InstallationPermission): boolean;
  visible(projectId: ProjectId): boolean;
  /**
   * Per-item filter: keeps items whose project is visible and grants
   * `permission` and every collection permission of the operation's requirement.
   */
  filter<T>(items: readonly T[], projectOf: (item: T) => ProjectId, permission: ProjectPermission): T[];
  /**
   * Filters per item first (as `filter`), then paginates by a stable key. The
   * cursor only encodes the key of the last released item, and there is no
   * total count, so invisible items affect neither the page, the cursor nor its absence.
   */
  page<T>(items: readonly T[], options: {
    projectOf: (item: T) => ProjectId; keyOf: (item: T) => string; permission: ProjectPermission; limit: number; cursor: string | null;
  }): Page<T>;
}

function encodeCursor(key: string): string { return Buffer.from(JSON.stringify({ k: key }), "utf8").toString("base64url"); }
function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { k?: unknown }).k === "string") return (parsed as { k: string }).k;
  } catch { /* fall through */ }
  throw new OperationError("invalid_request", "invalid_cursor");
}

export function createReleaseContext(authority: CurrentAuthority, permissions: EffectivePermissions, resources: ResolvedResources,
  collectionPermissions: readonly ProjectPermission[] = []): ReleaseContext {
  const full = isFullAuthority(authority.actor);
  const session = authority.coordinationSession;
  const required = Object.freeze([...collectionPermissions]);
  const can = (permission: ProjectPermission, projectId: ProjectId) => full || permissions.project(projectId).has(permission);
  const visible = (projectId: ProjectId) => projectVisible(authority, permissions, projectId);
  const releasable = (projectId: ProjectId, permission: ProjectPermission) =>
    visible(projectId) && can(permission, projectId) && required.every(each => can(each, projectId));
  const context: ReleaseContext = {
    actorKind: authority.actor.kind,
    fullAuthority: full,
    resources,
    ownsSession: other => !!other && !!session && other.id === session.id && other.credentialId === session.credentialId,
    can,
    canInstallation: permission => full || permissions.installation.has(permission),
    visible,
    filter: (items, projectOf, permission) => items.filter(item => releasable(projectOf(item), permission)),
    page(items, options) {
      const limit = options.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new OperationError("invalid_request", "invalid_limit");
      const after = options.cursor === null ? null : decodeCursor(options.cursor);
      const released = context.filter(items, options.projectOf, options.permission)
        .map(item => ({ item, key: options.keyOf(item) }))
        .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
        .filter(entry => after === null || entry.key > after);
      const pageItems = released.slice(0, limit);
      const last = pageItems.at(-1);
      return { items: pageItems.map(entry => entry.item), nextCursor: released.length > limit && last ? encodeCursor(last.key) : null };
    },
  };
  return Object.freeze(context);
}

/** Copies only allowlisted keys. Used by projectors so new internal fields are never released by default. */
export function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  // Defined, not assigned: a key named `__proto__` becomes an own property that the serializer then rejects.
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) Object.defineProperty(result, key, { value: value[key], enumerable: true, writable: true, configurable: true });
  }
  return result;
}

const invalid = () => new OperationError("internal", "invalid_projection");

/**
 * Strict serializer of released data. Accepts only plain objects (prototype
 * `Object.prototype` or `null`), dense arrays, strings, finite numbers,
 * booleans and `null`. Rejects `toJSON` (own or inherited, enumerable or not,
 * whatever its value), accessors (also on array indices), non-enumerable or
 * symbol keys, `__proto__` keys, functions, symbols, bigints, `undefined`,
 * proxies, typed arrays and any other prototype, cycles, nesting beyond
 * `MAX_RELEASE_DEPTH` and more than `MAX_RELEASE_NODES` values. Every property
 * is read once from its data descriptor, so the result cannot differ from what
 * was checked. `-0` becomes `0`. Returns a fresh value made only of plain data.
 */
export function serializeRelease(value: unknown): unknown {
  return serializeValue(value, 0, new Set(), { nodes: 0 });
}

function serializeValue(value: unknown, depth: number, ancestors: Set<object>, budget: { nodes: number }): unknown {
  if (++budget.nodes > MAX_RELEASE_NODES) throw invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw invalid(); return value === 0 ? 0 : value; }
  if (typeof value !== "object") throw invalid();
  if (depth >= MAX_RELEASE_DEPTH || ancestors.has(value) || types.isProxy(value)) throw invalid();
  if ("toJSON" in value) throw invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw invalid();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length: unknown = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
      if (typeof length !== "number" || keys.length !== length + 1) throw invalid();
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw invalid();
        result.push(serializeValue(descriptor.value, depth + 1, ancestors, budget));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw invalid();
      result[key] = serializeValue(descriptor.value, depth + 1, ancestors, budget);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Canonical text of a JSON-domain value (decision V): the strict serializer
 * first, then JSON with object keys sorted by code unit. Two values have the
 * same canonical text exactly when the serializer produces equal plain data.
 * Throws `internal`/`invalid_projection` for anything outside the domain.
 */
export function canonicalJson(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  };
  return encode(serializeRelease(value));
}

/**
 * The release point of every success, replay and stream event: serialize
 * strictly first, then check the top-level allowlist on the serialized value.
 */
export function releaseValue<T extends object>(value: unknown, keys: readonly string[]): T {
  const serialized = serializeRelease(value);
  if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)) throw invalid();
  for (const key of Object.keys(serialized)) if (!keys.includes(key)) throw new OperationError("internal", "unlisted_public_field");
  return serialized as T;
}

const errorKeys = ["category", "status", "reason", "retry", "effect"] as const;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** Whether a serialized error is one the contract can produce: closed vocabularies and the outcome rules. */
function wellFormed(value: PublicOperationError): boolean {
  const { category, status, reason, retry, effect } = value;
  if (Object.keys(value).length !== errorKeys.length) return false;
  if (!Object.prototype.hasOwnProperty.call(errorCategoryStatus, category) || errorCategoryStatus[category] !== status) return false;
  if (typeof reason !== "string" || !REASON.test(reason) || !(retryDispositions as readonly string[]).includes(retry)) return false;
  if (effect !== null && !(effectStates as readonly string[]).includes(effect)) return false;
  const began = effect !== null && effect !== "not_started";
  if ((effect === "unknown") !== (category === "outcome_unknown")) return false;
  if (began && (category === "busy" || retry === "retry")) return false;
  return !((effect === "unknown" || effect === "cleanup_unconfirmed") && retry !== "inspect_first");
}

/**
 * The release point of every error: the same strict serializer and allowlist,
 * plus the closed vocabularies and the outcome rules. Total: whatever `error`
 * is or does, the result is a fresh well-formed error. A value that fails is
 * replaced by a generic error that keeps a known effect state; the effect is
 * read only from an own data property, inside a guard.
 */
export function releaseError(error: unknown): PublicOperationError {
  try {
    const value = releaseValue<PublicOperationError>(error, errorKeys);
    if (wellFormed(value)) return value;
  } catch { /* fall through */ }
  let effect: unknown = null;
  try {
    const descriptor = typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "effect") : undefined;
    effect = descriptor && "value" in descriptor ? descriptor.value : null;
  } catch { effect = null; }
  if (effect === "unknown") return { category: "outcome_unknown", status: 409, reason: "unexpected_failure", retry: "inspect_first", effect };
  if (effect === "committed") return { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect };
  if (effect === "cleanup_unconfirmed") return { category: "internal", status: 500, reason: "unexpected_failure", retry: "inspect_first", effect };
  if (effect === "not_started") return { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect };
  return { category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null };
}
