import type { ActorKind, InstallationPermission, ProjectId, ProjectPermission } from "@/shared/contracts/operations";
import { isFullAuthority, type CoordinationSessionRef, type CurrentAuthority } from "./authentication-context";
import { projectVisible } from "./decide";
import { OperationError } from "./errors";
import type { EffectivePermissions } from "./grants";
import type { ResolvedResources } from "./requirements";

export const MAX_PAGE_SIZE = 100;

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
  /** Per-item filter: keeps items whose project grants `permission`. */
  filter<T>(items: readonly T[], projectOf: (item: T) => ProjectId, permission: ProjectPermission): T[];
  /**
   * Filters per item first, then paginates by a stable key. The cursor only
   * encodes the key of the last released item, and there is no total count,
   * so invisible items affect neither the page, the cursor nor its absence.
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

export function createReleaseContext(authority: CurrentAuthority, permissions: EffectivePermissions, resources: ResolvedResources): ReleaseContext {
  const full = isFullAuthority(authority.actor);
  const session = authority.coordinationSession;
  const can = (permission: ProjectPermission, projectId: ProjectId) => full || permissions.project(projectId).has(permission);
  const context: ReleaseContext = {
    actorKind: authority.actor.kind,
    fullAuthority: full,
    resources,
    ownsSession: other => !!other && !!session && other.id === session.id && other.credentialId === session.credentialId,
    can,
    canInstallation: permission => full || permissions.installation.has(permission),
    visible: projectId => projectVisible(authority, permissions, projectId),
    filter: (items, projectOf, permission) => items.filter(item => can(permission, projectOf(item))),
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
