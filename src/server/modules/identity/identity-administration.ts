import type { IdentityService } from "./identity-service";
import type { AuthenticatedPrincipal, KnowledgePermission } from "./contracts";

type JsonRecord = Record<string, unknown>;
function strictRecord(value: unknown, allowed: readonly string[]): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Oczekiwano obiektu JSON.");
  const record = value as JsonRecord;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Żądanie zawiera nieobsługiwane pole.");
  return record;
}

function requiredString(record: JsonRecord, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Nieprawidłowe pole ${key}.`);
  return value;
}

function optionalString(record: JsonRecord, key: string, max: number): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`Nieprawidłowe pole ${key}.`);
  return value;
}

export function identityAdministration(
  service: IdentityService,
  actor: AuthenticatedPrincipal,
  value: unknown,
): unknown {
  const record = strictRecord(value, ["action", "principalId", "credentialId", "projectId", "label", "expiresAt", "name", "permissions", "sessionLifetimeSeconds", "role", "expectedRevision", "actions", "projects"]);
  const action = requiredString(record, "action", 80);
  // Runtime administration validates its own strict schemas and requires a current owner session.
  const runtimeInput = () => Object.fromEntries(Object.entries(record).filter(([key]) => key !== "action"));
  switch (action) {
    case "set-runtime-delegation":
      return { delegation: service.setRuntimeDelegation(runtimeInput(), actor) };
    case "revoke-runtime-delegation":
      return { delegation: service.revokeRuntimeDelegation(runtimeInput(), actor) };
    case "list-runtime-access":
      return service.listRuntimeAccess(runtimeInput(), actor);
    case "issue-runtime-credential":
      return service.issueRuntimeCredential(runtimeInput(), actor);
    case "rotate-runtime-credential":
      return service.rotateRuntimeCredential(runtimeInput(), actor);
    case "set-knowledge-role":
    case "revoke-knowledge-role":
    case "list-knowledge-roles": {
      const input = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "action"));
      if (action === "list-knowledge-roles") return { roles: service.listKnowledgeRoles(input, actor) };
      return { binding: action === "set-knowledge-role" ? service.setKnowledgeRole(input, actor) : service.revokeKnowledgeRole(input, actor) };
    }
    case "renew-owner": {
      const lifetime = record.sessionLifetimeSeconds;
      if (lifetime !== undefined && typeof lifetime !== "number") throw new Error("Nieprawidłowe pole sessionLifetimeSeconds.");
      return service.renewOwnerSession({
        label: optionalString(record, "label", 120),
        sessionLifetimeSeconds: lifetime,
      }, actor);
    }
    case "create-agent":
      return { principal: service.createAgent(actor) };
    case "list-agents":
      return { principals: service.listAgents(actor) };
    case "revoke-agent":
      return { principal: service.revokeAgent(requiredString(record, "principalId", 160), actor) };
    case "issue-agent-token":
      return service.issueAgentToken({
        principalId: requiredString(record, "principalId", 160),
        label: requiredString(record, "label", 120),
        expiresAt: optionalString(record, "expiresAt", 40),
      }, actor);
    case "list-agent-tokens":
      return { credentials: service.listAgentCredentials(requiredString(record, "principalId", 160), actor) };
    case "revoke-token":
      service.revokeCredential(requiredString(record, "credentialId", 160), actor);
      return { revoked: true };
    case "create-knowledge-project":
      return { project: service.createKnowledgeProject({ name: requiredString(record, "name", 120) }, actor) };
    case "grant-knowledge": {
      if (!Array.isArray(record.permissions) || record.permissions.some((permission) => typeof permission !== "string")) {
        throw new Error("Nieprawidłowe pole permissions.");
      }
      return { grant: service.setKnowledgeGrant({
        principalId: requiredString(record, "principalId", 160),
        projectId: requiredString(record, "projectId", 160),
        permissions: record.permissions as KnowledgePermission[],
      }, actor) };
    }
    case "list-knowledge-grants":
      return { grants: service.listKnowledgeGrants(requiredString(record, "principalId", 160), actor) };
    case "revoke-knowledge-grant":
      return { grant: service.revokeKnowledgeGrant(
        requiredString(record, "principalId", 160), requiredString(record, "projectId", 160), actor,
      ) };
    default:
      throw new Error("Nieobsługiwana operacja zarządzania tożsamością.");
  }
}
