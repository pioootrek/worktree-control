import {
  installationPermissions, isRole, permissionScope, projectPermissions, roleDefinitions,
  type AccountId, type InstallationPermission, type ProjectId, type ProjectPermission, type Role, type RoleDefinition,
} from "@/shared/contracts/operations";
import type { Actor } from "./authentication-context";
import { synchronous } from "./synchronous";

export type GrantScope = { kind: "project"; projectId: ProjectId } | { kind: "installation" };
/** One stored role assignment. Stored data is re-validated on every evaluation. */
export interface StoredGrant { accountId: AccountId; role: Role; scope: GrantScope }

/**
 * Current grants and stored account kinds, read inside the admitted phase that decides.
 *
 * Grants in this model do not expire: revocation is removal. The snapshot
 * therefore contains active grants only, and returning nothing else is the
 * snapshot adapter's obligation (to be tested with the adapter, slice 3). A
 * stored grant has no expiry field and this module never filters by time.
 * Coordination-session leases do expire; they are not part of this slice.
 */
export interface GrantsSnapshot {
  /** Stored kind of an account, never a request claim. `null` when unknown or disabled. */
  accountKind(accountId: AccountId): "human" | "agent" | null;
  grantsFor(accountId: AccountId): readonly StoredGrant[];
}

export interface EffectivePermissions {
  installation: ReadonlySet<InstallationPermission>;
  /** Project permissions held on every project (from the installation role). */
  everyProject: ReadonlySet<ProjectPermission>;
  /** Permissions held on one project; a fresh immutable set on every call. */
  project(projectId: ProjectId): ReadonlySet<ProjectPermission>;
  /**
   * Visibility (decision M): at least one active project role on this project,
   * an active `admin` grant, or full authority. Visibility grants no permission.
   */
  visible(projectId: ProjectId): boolean;
}

const SECRETS: readonly ProjectPermission[] = Object.freeze(["secrets:read", "secrets:write"]);

/** Whether a role may be granted to an account of this kind in this scope. Used by grant operations too. */
export function grantAllowed(role: Role, recipientKind: "human" | "agent", scope: GrantScope): boolean {
  const definition: RoleDefinition | undefined = roleDefinitions[role];
  if (!definition || definition.scope !== scope.kind) return false;
  return definition.recipient === "any" || definition.recipient === recipientKind;
}

/**
 * An immutable set: no mutating method exists, the storage is private and the
 * instance and its prototype are frozen. `Set.prototype.add.call(...)` on it
 * throws, because it is not a `Set`.
 */
class FrozenSet<T> implements ReadonlySet<T> {
  readonly #items: Set<T>;
  constructor(items: Iterable<T>) {
    this.#items = new Set(items);
    Object.freeze(this);
  }
  get size(): number { return this.#items.size; }
  has(value: T): boolean { return this.#items.has(value); }
  forEach(callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#items) callback.call(thisArg, value, value, this);
  }
  entries(): SetIterator<[T, T]> { return this.#items.entries(); }
  keys(): SetIterator<T> { return this.#items.keys(); }
  values(): SetIterator<T> { return this.#items.values(); }
  [Symbol.iterator](): SetIterator<T> { return this.#items.values(); }
}
Object.freeze(FrozenSet.prototype);

function permissionsOf(installation: Iterable<InstallationPermission>, everyProject: readonly ProjectPermission[],
  byProject: ReadonlyMap<ProjectId, readonly ProjectPermission[]>, visible: (projectId: ProjectId) => boolean): EffectivePermissions {
  // Every call builds new frozen values; nothing mutable is shared between decisions.
  return Object.freeze({
    installation: new FrozenSet(installation),
    everyProject: new FrozenSet(everyProject),
    project: (projectId: ProjectId): ReadonlySet<ProjectPermission> => new FrozenSet([...everyProject, ...(byProject.get(projectId) ?? [])]),
    visible: (projectId: ProjectId): boolean => visible(projectId),
  });
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Effective permissions of an actor. Full authority holds everything. For a
 * human or agent, each stored grant counts only if the account's stored kind
 * matches the actor, the role is known, its scope matches the grant's scope
 * and its recipient kind allows the account. A project grant yields only
 * project permissions on that project; the installation role yields its
 * installation permissions and its project permissions on every project, never
 * `secrets:*`. Every call returns fresh, frozen values.
 */
export function effectivePermissions(actor: Actor, grants: GrantsSnapshot): EffectivePermissions {
  if (actor.kind === "installation" || actor.kind === "operator") {
    return permissionsOf(installationPermissions, [...projectPermissions], new Map(), () => true);
  }
  const none = () => permissionsOf([], [], new Map(), () => false);
  // The snapshot is synchronous (decision W): a thenable is `internal`, never an empty or partial grant set.
  const storedKind = synchronous(grants.accountKind(actor.accountId), "grants_not_synchronous");
  if (storedKind === null || storedKind !== actor.kind) return none();
  const installation = new Set<InstallationPermission>();
  const everyProject = new Set<ProjectPermission>();
  const byProject = new Map<ProjectId, ProjectPermission[]>();
  const visibleProjects = new Set<ProjectId>();
  let everywhere = false;
  for (const grant of synchronous(grants.grantsFor(actor.accountId), "grants_not_synchronous")) {
    if (grant.accountId !== actor.accountId || !isRole(grant.role) || !grantAllowed(grant.role, storedKind, grant.scope)) continue;
    const scopeKind = grant.scope.kind;
    const grantProject = scopeKind === "project" ? grant.scope.projectId : null;
    if (scopeKind === "project" && !isText(grantProject)) continue;
    if (scopeKind === "installation") everywhere = true;
    else visibleProjects.add(grantProject as ProjectId);
    for (const permission of roleDefinitions[grant.role].permissions) {
      const scope = permissionScope(permission);
      if (scopeKind === "installation") {
        if (scope === "installation") installation.add(permission as InstallationPermission);
        else if (!SECRETS.includes(permission as ProjectPermission)) everyProject.add(permission as ProjectPermission);
      } else if (scope === "project") {
        const list = byProject.get(grantProject as ProjectId) ?? [];
        if (!list.includes(permission as ProjectPermission)) list.push(permission as ProjectPermission);
        byProject.set(grantProject as ProjectId, list);
      }
    }
  }
  const every = [...everyProject];
  return permissionsOf(installation, every, byProject, projectId => everywhere || visibleProjects.has(projectId));
}
