/**
 * Browser-safe vocabulary of the unified authorization contract (Knowledge
 * task 040062b4, contract v1). Unreleased: nothing in the product reads it yet.
 *
 * The permission list and the six roles are closed. There are no wildcards and
 * no custom roles; changing either is a contract change, not configuration.
 * Every exported list and table is frozen, so no holder can widen it.
 */

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** Durable project identity. Never interchangeable with a registration ID. */
export type ProjectId = Brand<string, "ProjectId">;
/** One machine registration of a project. */
export type RegistrationId = Brand<string, "RegistrationId">;
/** A human or agent account. */
export type AccountId = Brand<string, "AccountId">;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function brandId<T extends string>(value: unknown, kind: string): T {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError(`Invalid ${kind}.`);
  return value as T;
}
export const projectId = (value: unknown): ProjectId => brandId<ProjectId>(value, "project ID");
export const registrationId = (value: unknown): RegistrationId => brandId<RegistrationId>(value, "registration ID");
export const accountId = (value: unknown): AccountId => brandId<AccountId>(value, "account ID");

export const projectPermissions = Object.freeze([
  "project:read", "project:manage",
  "logs:read", "storage:read", "storage:manage",
  "config:read", "config:write", "profiles:select",
  "claims:manage", "runtime:control", "runtime:administer",
  "tests:run", "tests:read",
  "knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export", "knowledge:import",
  "attachments:read", "attachments:write",
  "secrets:read", "secrets:write",
  "roles:manage", "worker:execute",
] as const);
export type ProjectPermission = typeof projectPermissions[number];

export const installationPermissions = Object.freeze([
  "accounts:manage", "projects:create", "projects:remove",
  "capacity:read", "capacity:write", "settings:write",
  "backups:manage", "workers:manage", "diagnostics:read", "vault:recover",
] as const);
export type InstallationPermission = typeof installationPermissions[number];

export type Permission = ProjectPermission | InstallationPermission;
export const permissions: readonly Permission[] = Object.freeze([...projectPermissions, ...installationPermissions]);
export type PermissionScope = "project" | "installation";

export function permissionScope(permission: Permission): PermissionScope {
  return (installationPermissions as readonly string[]).includes(permission) ? "installation" : "project";
}
export function isProjectPermission(value: unknown): value is ProjectPermission {
  return typeof value === "string" && (projectPermissions as readonly string[]).includes(value);
}
export function isInstallationPermission(value: unknown): value is InstallationPermission {
  return typeof value === "string" && (installationPermissions as readonly string[]).includes(value);
}

export const roles = Object.freeze(["reader", "operator", "maintainer", "secrets", "executor", "admin"] as const);
export type Role = typeof roles[number];
/** Which account kind may hold a role. Checked when granting and again on every evaluation. */
export type RoleRecipient = "any" | "human" | "agent";

export interface RoleDefinition {
  /** A project role is granted on one project; the installation role on the installation. */
  scope: PermissionScope;
  recipient: RoleRecipient;
  /**
   * For a project role: its permissions on that project. For `admin`: its
   * installation permissions plus the project permissions it holds on every
   * project. A project grant never yields an installation permission.
   */
  permissions: readonly Permission[];
}

const reader = ["project:read", "logs:read", "storage:read", "config:read", "tests:read", "knowledge:read", "attachments:read"] as const;
const operator = [...reader, "claims:manage", "runtime:control", "tests:run", "profiles:select", "knowledge:write", "attachments:write"] as const;
const maintainer = [...operator, "config:write", "storage:manage", "roles:manage", "knowledge:approve", "knowledge:export",
  "knowledge:import", "project:manage", "runtime:administer"] as const;

/** Contract v1 role table. `admin` inherits maintainer everywhere but never `secrets`. */
export const roleDefinitions: Readonly<Record<Role, Readonly<RoleDefinition>>> = Object.freeze({
  reader: Object.freeze({ scope: "project", recipient: "any", permissions: Object.freeze([...reader]) }),
  operator: Object.freeze({ scope: "project", recipient: "any", permissions: Object.freeze([...operator]) }),
  maintainer: Object.freeze({ scope: "project", recipient: "human", permissions: Object.freeze([...maintainer]) }),
  secrets: Object.freeze({ scope: "project", recipient: "any", permissions: Object.freeze(["secrets:read", "secrets:write"] as const) }),
  executor: Object.freeze({ scope: "project", recipient: "agent", permissions: Object.freeze(["worker:execute"] as const) }),
  admin: Object.freeze({ scope: "installation", recipient: "human", permissions: Object.freeze([...installationPermissions, ...maintainer]) }),
});

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (roles as readonly string[]).includes(value);
}

export const actorKinds = Object.freeze(["installation", "operator", "human", "agent"] as const);
export type ActorKind = typeof actorKinds[number];
/** `installation` and `operator` hold full authority; human and agent are evaluated by grants. */
export const fullAuthorityKinds: readonly ActorKind[] = Object.freeze(["installation", "operator"]);

/** Target modes. The former `legacy` mode is not part of the contract and accepts nothing. */
export const authenticationModes = Object.freeze(["open", "token", "better-auth"] as const);
export type AuthenticationMode = typeof authenticationModes[number];
/**
 * Listener boundaries. `api` is the TCP HTTP API (including the browser), `mcp`
 * the TCP MCP endpoint, `worker` the remote-worker protocol, `unix` the local
 * socket, `offline` a CLI invocation holding the exclusive controller lock.
 */
export const listenerKinds = Object.freeze(["api", "mcp", "worker", "unix", "offline"] as const);
export type ListenerKind = typeof listenerKinds[number];

/** Fresh-login window: `0 <= now - authenticatedAt < 600000` from current provider evidence. */
export const FRESH_LOGIN_WINDOW_MS = 600_000;

export const errorCategories = Object.freeze([
  "unauthenticated", "forbidden", "login_stale", "not_found", "invalid_request", "conflict", "claim_held",
  "rate_limited", "busy", "unavailable", "internal", "payload_too_large", "gone", "outcome_unknown",
] as const);
export type ErrorCategory = typeof errorCategories[number];

/**
 * Default status per category. Transport-boundary statuses (405, media type,
 * framing, provider 502) stay in the adapter and are not categories.
 * `outcome_unknown` uses 409 so that generic clients never retry it as a 503.
 */
export const errorCategoryStatus: Readonly<Record<ErrorCategory, number>> = Object.freeze({
  unauthenticated: 401, forbidden: 403, login_stale: 403, not_found: 404, invalid_request: 400, conflict: 409,
  claim_held: 409, rate_limited: 429, busy: 503, unavailable: 503, internal: 500, payload_too_large: 413, gone: 410,
  outcome_unknown: 409,
});

/**
 * - `retry`: the same request may be repeated; execution never began.
 * - `reauthenticate`: authenticate again, then repeat.
 * - `inspect_first`: an effect may have happened or its cleanup is unconfirmed; inspect before any retry.
 * - `none`: repeating the same request will not succeed or must not be done.
 */
export const retryDispositions = Object.freeze(["retry", "reauthenticate", "inspect_first", "none"] as const);
export type RetryDisposition = typeof retryDispositions[number];

/** For mutations. Reads report `null`. */
export const effectStates = Object.freeze(["not_started", "committed", "unknown", "cleanup_unconfirmed"] as const);
export type EffectState = typeof effectStates[number];

/** The released shape of every error, on every transport. */
export interface PublicOperationError {
  category: ErrorCategory;
  status: number;
  /** Machine-readable, stable, never a localized message. */
  reason: string;
  retry: RetryDisposition;
  effect: EffectState | null;
}

/**
 * `exempt`: installation and operator need no fresh login. `satisfied` /
 * `stale`: current provider evidence of a human session. `unavailable`: an
 * agent can never satisfy a fresh-login requirement.
 */
export type FreshLoginState = "exempt" | "satisfied" | "stale" | "unavailable";

/** Result of `session.describe`: a hint for clients, never a cached authorization decision. */
export interface SessionDescription {
  actor: { kind: ActorKind; accountId: AccountId | null };
  mode: AuthenticationMode;
  listener: ListenerKind;
  fullAuthority: boolean;
  installationPermissions: InstallationPermission[];
  /**
   * Every project visible to the caller, sorted by ID: a project on which the
   * account holds at least one active role (any of the five project roles), every
   * project for `admin`, every project for full authority. Visibility grants no
   * permission: `permissions` lists what is actually held there, which may be
   * only `worker:execute` or `secrets:*`.
   */
  projects: { projectId: ProjectId; permissions: ProjectPermission[] }[];
  /** True when more visible projects exist than this bounded description lists. */
  projectsTruncated: boolean;
  freshLogin: { state: FreshLoginState; validUntil: string | null };
}
