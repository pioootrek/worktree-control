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
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  return result;
}

const invalid = () => new OperationError("internal", "invalid_projection");

/**
 * Strict serializer of released data. Accepts only plain objects (prototype
 * `Object.prototype` or `null`), dense arrays, strings, finite numbers,
 * booleans and `null`. Rejects `toJSON` (own or inherited, enumerable or not),
 * accessors, non-enumerable or symbol keys, `__proto__` keys, functions,
 * symbols, bigints, `undefined`, proxies, any other prototype, cycles and
 * nesting beyond `MAX_RELEASE_DEPTH`. Every property is read once from its
 * data descriptor, so the result cannot differ from what was checked. Returns
 * a fresh value made only of plain data.
 */
export function serializeRelease(value: unknown, depth = 0, ancestors: Set<object> = new Set()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw invalid(); return value; }
  if (typeof value !== "object") throw invalid();
  if (depth >= MAX_RELEASE_DEPTH || ancestors.has(value) || types.isProxy(value)) throw invalid();
  if ("toJSON" in value) throw invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw invalid();
      const length = value.length;
      if (keys.length !== length + 1) throw invalid();
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw invalid();
        result.push(serializeRelease(descriptor.value, depth + 1, ancestors));
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw invalid();
      result[key] = serializeRelease(descriptor.value, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
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
const fallbackError: PublicOperationError = Object.freeze({ category: "internal", status: 500, reason: "unexpected_failure", retry: "none", effect: null });

/**
 * The release point of every error: the same strict serializer and allowlist,
 * plus the closed vocabularies. A value that fails is replaced by a generic
 * `internal` error that keeps a known effect state.
 */
export function releaseError(error: PublicOperationError): PublicOperationError {
  try {
    const value = releaseValue<PublicOperationError>(error, errorKeys);
    const valid = Object.keys(value).length === errorKeys.length
      && Object.prototype.hasOwnProperty.call(errorCategoryStatus, value.category) && errorCategoryStatus[value.category] === value.status
      && typeof value.reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.reason)
      && (retryDispositions as readonly string[]).includes(value.retry)
      && (value.effect === null || (effectStates as readonly string[]).includes(value.effect));
    if (valid) return value;
  } catch { /* fall through */ }
  const effect = (error as { effect?: unknown } | null)?.effect;
  if (effect === "unknown") return { category: "outcome_unknown", status: 409, reason: "unexpected_failure", retry: "inspect_first", effect };
  if (effect === "committed") return { ...fallbackError, effect };
  if (effect === "cleanup_unconfirmed") return { ...fallbackError, retry: "inspect_first", effect };
  if (effect === "not_started") return { ...fallbackError, effect };
  return { ...fallbackError };
}
