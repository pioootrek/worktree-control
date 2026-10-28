import { setKnowledgeRoleSchema, revokeKnowledgeRoleSchema, listKnowledgeRolesSchema } from "../shared/contracts/authorization";
import {
  issueRuntimeCredentialSchema, listRuntimeAccessSchema, revokeRuntimeDelegationSchema,
  rotateRuntimeCredentialSchema, setRuntimeDelegationSchema,
} from "../shared/contracts/runtime-access";
import type { AppPaths } from "../server/paths";
import { acquireControllerLock } from "../server/controller-lock";
import { IdentityService, type KnowledgePermission } from "../server/modules/identity";
import { SqliteStateStore } from "../server/sqlite-store";
import { cliCredential, OWNER_CREDENTIAL_REQUIRED, OWNER_CREDENTIAL_VARIABLES } from "./credentials";
import { authenticateOfflineActor } from "./offline-actor";
import { localDashboardEndpoint, readServiceAccess } from "./service-access";

export interface IdentityCommandDependencies {
  write?: (line: string) => void;
  environment?: Readonly<Record<string, string | undefined>>;
}

const KNOWLEDGE_PERMISSIONS = new Set<KnowledgePermission>([
  "knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export", "knowledge:import",
  "attachments:read", "attachments:write",
]);
const AVAILABLE_COMMANDS = [
  "bootstrap-owner", "recover-owner", "renew-owner", "create-agent", "list-agents", "revoke-agent",
  "issue-agent-token", "list-agent-tokens", "revoke-token", "create-knowledge-project",
  "grant-knowledge", "list-knowledge-grants", "revoke-knowledge-grant",
  "set-knowledge-role", "list-knowledge-roles", "revoke-knowledge-role",
  "set-runtime-delegation", "revoke-runtime-delegation", "list-runtime-access",
  "issue-runtime-credential", "rotate-runtime-credential",
].join(", ");

const RUNTIME_OPTIONS: Record<string, readonly string[]> = {
  "set-runtime-delegation": ["--principal-id", "--project-id", "--actions", "--expires-at", "--expected-revision"],
  "revoke-runtime-delegation": ["--principal-id", "--project-id", "--expected-revision"],
  "list-runtime-access": ["--principal-id"],
  "issue-runtime-credential": ["--principal-id", "--label", "--expires-at", "--projects-json"],
  "rotate-runtime-credential": ["--credential-id", "--label", "--expires-at", "--projects-json"],
};

/** Parse only named values. Never accept tokens, file paths to read, or caller-supplied sponsors. */
function runtimeInput(args: string[]): Record<string, unknown> {
  const action = args[0];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    if (!RUNTIME_OPTIONS[action].includes(name) || seen.has(name)) throw new Error("Unknown or repeated runtime option.");
    seen.add(name);
    requiredOption(args, name);
  }
  if (action === "list-runtime-access") return listRuntimeAccessSchema.parse({ principalId: requiredOption(args, "--principal-id") });
  if (action === "set-runtime-delegation" || action === "revoke-runtime-delegation") {
    const revision = requiredOption(args, "--expected-revision");
    if (!/^(0|[1-9][0-9]*)$/.test(revision)) throw new Error("Invalid --expected-revision: use a nonnegative integer.");
    const target = {
      principalId: requiredOption(args, "--principal-id"), projectId: requiredOption(args, "--project-id"),
      expectedRevision: Number(revision),
    };
    if (action === "revoke-runtime-delegation") return revokeRuntimeDelegationSchema.parse(target);
    const actions = requiredOption(args, "--actions").split(",");
    if (new Set(actions).size !== actions.length) throw new Error("Repeated --actions value.");
    const expiry = option(args, "--expires-at");
    return setRuntimeDelegationSchema.parse({ ...target, actions, ...(expiry === undefined ? {} : { expiresAt: expiry === "none" ? null : expiry }) });
  }
  const json = option(args, "--projects-json");
  let projects: unknown;
  if (json !== undefined) {
    try { projects = JSON.parse(json); }
    catch { throw new Error("Invalid --projects-json: expected a JSON array of projectId/actions objects."); }
  }
  const optional = {
    ...(option(args, "--label") === undefined ? {} : { label: option(args, "--label") }),
    ...(option(args, "--expires-at") === undefined ? {} : { expiresAt: option(args, "--expires-at") }),
    ...(json === undefined ? {} : { projects }),
  };
  if (action === "rotate-runtime-credential") return rotateRuntimeCredentialSchema.parse({ credentialId: requiredOption(args, "--credential-id"), ...optional });
  requiredOption(args, "--projects-json");
  return issueRuntimeCredentialSchema.parse({ principalId: requiredOption(args, "--principal-id"), ...optional });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing value for ${name}.`);
  return value;
}

/**
 * An owner session, or in token mode the installation token, administers identity. Absence is
 * resolved by the active mode: open mode administers as the anonymous installation authority.
 */
function administratorToken(dependencies: IdentityCommandDependencies): string | undefined {
  return cliCredential(dependencies.environment ?? process.env, OWNER_CREDENTIAL_VARIABLES);
}

function sessionInput(args: string[]) {
  const lifetimeValue = option(args, "--lifetime-seconds");
  return {
    label: option(args, "--label"),
    sessionLifetimeSeconds: lifetimeValue === undefined ? undefined : Number(lifetimeValue),
  };
}

function permissions(args: string[]): KnowledgePermission[] {
  const values = requiredOption(args, "--permissions").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => !KNOWLEDGE_PERMISSIONS.has(value as KnowledgePermission))) {
    throw new Error(`Invalid --permissions. Allowed values: ${[...KNOWLEDGE_PERMISSIONS].join(", ")}.`);
  }
  return values as KnowledgePermission[];
}

function roleInput(args: string[]): Record<string, unknown> {
  const action = args[0];
  const allowed = action === "list-knowledge-roles" ? ["--principal-id"]
    : ["--principal-id", "--project-id", "--expected-revision", ...(action === "set-knowledge-role" ? ["--role"] : [])];
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || seen.has(args[i])) throw new Error("Unknown or repeated role option.");
    seen.add(args[i]);
  }
  const input = { principalId: requiredOption(args, "--principal-id") };
  if (action === "list-knowledge-roles") return listKnowledgeRolesSchema.parse(input);
  const target = { ...input, projectId: requiredOption(args, "--project-id"), expectedRevision: Number(requiredOption(args, "--expected-revision")) };
  return action === "set-knowledge-role" ? setKnowledgeRoleSchema.parse({ ...target, role: requiredOption(args, "--role") }) : revokeKnowledgeRoleSchema.parse(target);
}

function administrationPayload(args: string[]): Record<string, unknown> {
  const action = args[0]!;
  if (Object.hasOwn(RUNTIME_OPTIONS, action)) return { action, ...runtimeInput(args) };
  switch (action) {
    case "set-knowledge-role":
    case "revoke-knowledge-role":
    case "list-knowledge-roles":
      return { action, ...roleInput(args) };
    case "renew-owner":
      return { action, ...sessionInput(args) };
    case "create-agent":
    case "list-agents":
      return { action };
    case "revoke-agent":
    case "list-agent-tokens":
    case "list-knowledge-grants":
      return { action, principalId: requiredOption(args, "--principal-id") };
    case "issue-agent-token":
      return {
        action,
        principalId: requiredOption(args, "--principal-id"),
        label: requiredOption(args, "--label"),
        expiresAt: option(args, "--expires-at"),
      };
    case "revoke-token":
      return { action, credentialId: requiredOption(args, "--credential-id") };
    case "create-knowledge-project":
      return { action, name: requiredOption(args, "--name") };
    case "grant-knowledge":
      return {
        action,
        principalId: requiredOption(args, "--principal-id"),
        projectId: requiredOption(args, "--project-id"),
        permissions: permissions(args),
      };
    case "revoke-knowledge-grant":
      return {
        action,
        principalId: requiredOption(args, "--principal-id"),
        projectId: requiredOption(args, "--project-id"),
      };
    default:
      throw new Error(`Available identity commands: ${AVAILABLE_COMMANDS}`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runThroughController(
  args: string[],
  endpoint: string,
  dependencies: IdentityCommandDependencies,
  write: (line: string) => void,
): Promise<void> {
  const token = administratorToken(dependencies);
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/identity/admin`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(administrationPayload(args)),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { error?: string } & Record<string, unknown>;
  if (response.status === 401 && !token) throw new Error(OWNER_CREDENTIAL_REQUIRED);
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  write(JSON.stringify(body, null, 2));
}

async function bootstrapThroughController(
  args: string[],
  endpoint: string,
  accessUrl: string,
  write: (line: string) => void,
): Promise<void> {
  const parsed = new URL(accessUrl);
  const token = new URLSearchParams(parsed.hash.slice(1)).get("token");
  if (!token) throw new Error("The running controller access record has no pairing token.");
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/identity/bootstrap`, {
    method: "POST",
    headers: { "X-Worktree-Control-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(sessionInput(args)),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  write(JSON.stringify(body, null, 2));
}

export async function runIdentityCommand(
  args: string[],
  paths: AppPaths,
  dependencies: IdentityCommandDependencies = {},
): Promise<void> {
  const action = args[0];
  if (!action || !AVAILABLE_COMMANDS.split(", ").includes(action)) {
    throw new Error(`Available identity commands: ${AVAILABLE_COMMANDS}`);
  }
  const write = dependencies.write ?? console.log;
  // Reject malformed options before touching a service endpoint, lock or database.
  const runtime = Object.hasOwn(RUNTIME_OPTIONS, action) ? runtimeInput(args) : undefined;
  const access = readServiceAccess(paths.serviceAccessPath);
  if (access && processExists(access.pid)) {
    if (action === "bootstrap-owner") {
      await bootstrapThroughController(args, localDashboardEndpoint(access), access.accessUrl, write);
      return;
    }
    if (action !== "recover-owner") {
      await runThroughController(args, localDashboardEndpoint(access), dependencies, write);
      return;
    }
  }
  const lock = acquireControllerLock(paths.controllerLockPath);
  let store: SqliteStateStore | null = null;
  try {
    store = new SqliteStateStore(paths.databasePath);
    const service = new IdentityService(store);
    if (action === "bootstrap-owner" || action === "recover-owner") {
      const result = action === "bootstrap-owner"
        ? service.bootstrapOwnerSession(sessionInput(args))
        : service.recoverOwnerSession(sessionInput(args));
      write(JSON.stringify(result, null, 2));
      return;
    }

    const { identity, actor } = authenticateOfflineActor(store, administratorToken(dependencies), OWNER_CREDENTIAL_REQUIRED);
    let result: unknown;
    switch (action) {
      case "set-runtime-delegation":
        result = { delegation: identity.setRuntimeDelegation(runtime, actor) };
        break;
      case "revoke-runtime-delegation":
        result = { delegation: identity.revokeRuntimeDelegation(runtime, actor) };
        break;
      case "list-runtime-access":
        result = identity.listRuntimeAccess(runtime, actor);
        break;
      case "issue-runtime-credential":
        result = identity.issueRuntimeCredential(runtime, actor);
        break;
      case "rotate-runtime-credential":
        result = identity.rotateRuntimeCredential(runtime, actor);
        break;
      case "set-knowledge-role":
        result = { binding: identity.setKnowledgeRole(roleInput(args), actor) };
        break;
      case "revoke-knowledge-role":
        result = { binding: identity.revokeKnowledgeRole(roleInput(args), actor) };
        break;
      case "list-knowledge-roles":
        result = { roles: identity.listKnowledgeRoles(roleInput(args), actor) };
        break;
      case "create-agent":
        result = { principal: identity.createAgent(actor) };
        break;
      case "renew-owner":
        result = identity.renewOwnerSession(sessionInput(args), actor);
        break;
      case "list-agents":
        result = { principals: identity.listAgents(actor) };
        break;
      case "revoke-agent":
        result = { principal: identity.revokeAgent(requiredOption(args, "--principal-id"), actor) };
        break;
      case "issue-agent-token":
        result = identity.issueAgentToken({
          principalId: requiredOption(args, "--principal-id"),
          label: requiredOption(args, "--label"),
          expiresAt: option(args, "--expires-at"),
        }, actor);
        break;
      case "list-agent-tokens":
        result = { credentials: identity.listAgentCredentials(requiredOption(args, "--principal-id"), actor) };
        break;
      case "revoke-token":
        identity.revokeCredential(requiredOption(args, "--credential-id"), actor);
        result = { revoked: true };
        break;
      case "create-knowledge-project":
        result = { project: identity.createKnowledgeProject({ name: requiredOption(args, "--name") }, actor) };
        break;
      case "grant-knowledge":
        result = { grant: identity.setKnowledgeGrant({
          principalId: requiredOption(args, "--principal-id"),
          projectId: requiredOption(args, "--project-id"),
          permissions: permissions(args),
        }, actor) };
        break;
      case "list-knowledge-grants":
        result = { grants: identity.listKnowledgeGrants(requiredOption(args, "--principal-id"), actor) };
        break;
      case "revoke-knowledge-grant":
        result = { grant: identity.revokeKnowledgeGrant(
          requiredOption(args, "--principal-id"), requiredOption(args, "--project-id"), actor,
        ) };
        break;
      default:
        throw new Error(`Available identity commands: ${AVAILABLE_COMMANDS}`);
    }
    write(JSON.stringify(result, null, 2));
  } finally {
    store?.close();
    lock.release();
  }
}
