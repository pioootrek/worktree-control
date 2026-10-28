import { knowledgePermissions, type AuthorizationAction, type AuthorizationResource, type KnowledgePermission, type KnowledgeRole, type KnowledgeRoleBinding, type SubjectKind } from "@/shared/contracts/authorization";
import { isRuntimeAction, runtimeActions, type RuntimeAction, type RuntimeCredentialScope, type RuntimeDelegation } from "@/shared/contracts/runtime-access";

export interface AuthorizationSubject {
  id: string;
  kind: SubjectKind;
  humanSession: boolean;
}
const rolePermissions: Record<KnowledgeRole, readonly KnowledgePermission[]> = {
  reader: ["knowledge:read", "knowledge:export", "attachments:read"],
  operator: ["knowledge:read", "knowledge:write", "knowledge:export", "knowledge:import", "attachments:read", "attachments:write"],
  manager: knowledgePermissions,
};
export interface KnowledgeAuthority {
  grant: { principalId: string; projectId: string; permissions: readonly KnowledgePermission[]; revokedAt: string | null } | null;
  binding: KnowledgeRoleBinding | null;
}

/** Trusted application facts only. Roles restrict grants; they never create access. */
export function effectiveKnowledgePermissions(subject: AuthorizationSubject, projectId: string, authority: KnowledgeAuthority): KnowledgePermission[] {
  const { grant, binding } = authority;
  if (subject.kind !== "human" && subject.kind !== "agent") return [];
  if (!grant || grant.principalId !== subject.id || grant.projectId !== projectId || grant.revokedAt !== null) return [];
  if (binding && (binding.principalId !== subject.id || binding.projectId !== projectId || binding.revokedAt !== null
    || (binding.role === "manager" && subject.kind !== "human"))) return [];
  return knowledgePermissions.filter(permission => grant.permissions.includes(permission)
    && (!binding || rolePermissions[binding.role]?.includes(permission))
    && (permission !== "knowledge:approve" || (subject.kind === "human" && subject.humanSession)));
}

/** Trusted runtime facts for one credential and one registered project, read at decision time. */
export interface RuntimeAuthority {
  now: string;
  credentialId: string;
  project: { id: string } | null;
  delegation: RuntimeDelegation | null;
  scope: RuntimeCredentialScope | null;
  /** Current state of the stored sponsor, normalized to a subject kind. */
  sponsor: { id: string; kind: SubjectKind; status: "active" | "revoked" } | null;
}

/**
 * Agent-only delegation: the credential ceiling and the sponsored delegation both
 * have to allow an action. Neither creates access alone; there is no installation
 * or human fallback here, and workers are executors rather than operators.
 */
export function effectiveRuntimeActions(subject: AuthorizationSubject, projectId: string, authority: RuntimeAuthority): RuntimeAction[] {
  const { delegation, scope, sponsor, project, now } = authority;
  if (subject.kind !== "agent" || !project || project.id !== projectId) return [];
  if (!delegation || delegation.principalId !== subject.id || delegation.projectId !== projectId
    || delegation.revokedAt !== null || (delegation.expiresAt !== null && delegation.expiresAt <= now)) return [];
  if (!sponsor || sponsor.id !== delegation.sponsorId || sponsor.kind !== "human" || sponsor.status !== "active") return [];
  if (!scope || scope.credentialId !== authority.credentialId || scope.projectId !== projectId) return [];
  return runtimeActions.filter(action => delegation.actions.includes(action) && scope.actions.includes(action));
}

export function isAuthorized(
  subject: AuthorizationSubject,
  action: AuthorizationAction,
  resource: AuthorizationResource,
  context: KnowledgeAuthority & { project: { id: string; status: "active" | "archived" } | null; allowArchived?: boolean; runtime?: RuntimeAuthority },
): boolean {
  if (resource.kind === "runtime-project") {
    return isRuntimeAction(action) && !!context.runtime && effectiveRuntimeActions(subject, resource.id, context.runtime).includes(action);
  }
  if (resource.kind !== "knowledge-project" || !knowledgePermissions.includes(action as KnowledgePermission)) return false;
  if (!context.project || context.project.id !== resource.id
    || (context.project.status !== "active" && action !== "knowledge:read" && !context.allowArchived)) return false;
  // Compatibility for explicit open/token modes. Account mode must remove this in A5.
  if (subject.kind === "installation") return true;
  return effectiveKnowledgePermissions(subject, resource.id, context).includes(action as KnowledgePermission);
}
