import type { KnowledgePermission, KnowledgeRoleBinding } from "@/shared/contracts/authorization";
import type { KnowledgeProject } from "@/shared/contracts/knowledge";
import type { RuntimeAccessEntry, RuntimeCredentialScope, RuntimeDelegation } from "@/shared/contracts/runtime-access";
/** `installation` is the single installation-wide authority; it never holds credentials or grants. */
export type PrincipalKind = "owner" | "agent" | "worker" | "installation";
export type IdentityStatus = "active" | "revoked";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  status: IdentityStatus;
}

export type CredentialKind = "owner_session" | "agent_token" | "worker_token";
/** Stored credentials plus the installation-wide token and the unauthenticated `open` mode. */
export type AuthenticationMethod = CredentialKind | "installation_token" | "none";

export interface PrincipalCredential {
  id: string;
  principalId: string;
  kind: CredentialKind;
  label: string;
  tokenPrefix: string;
  status: IdentityStatus;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** Server-only authentication material. Never return this shape from a transport. */
export interface CredentialAuthenticationRecord extends PrincipalCredential {
  verifierHash: string;
}

export interface AuthenticatedPrincipal {
  principalId: string;
  principalKind: PrincipalKind;
  credentialId: string;
  authenticationMethod: AuthenticationMethod;
}

export type ControllerAuthentication =
  | { kind: "legacy" }
  | { kind: "installation"; actor: AuthenticatedPrincipal }
  | { kind: "principal"; actor: AuthenticatedPrincipal };

/** Confirms that an installation actor still matches the active authentication policy. */
export interface InstallationAuthority {
  isCurrentInstallationActor(actor: AuthenticatedPrincipal): boolean;
}

export type { KnowledgePermission } from "@/shared/contracts/authorization";

export type { KnowledgeProject } from "@/shared/contracts/knowledge";
export interface KnowledgeProjectGrant {
  principalId: string;
  projectId: string;
  permissions: KnowledgePermission[];
  revokedAt: string | null;
}

export interface AuthenticatedIdentity {
  principal: Principal;
  /** Null for the installation authority, which has no stored credential or grants. */
  credential: PrincipalCredential | null;
  knowledgeGrants: Array<Pick<KnowledgeProjectGrant, "projectId" | "permissions">>;
  /** Present for agents: the credential's current effective runtime scope. */
  runtimeAccess?: RuntimeAccessEntry[];
  installationAuthority?: true;
}

export interface KnowledgeProjectRuntimeLink {
  projectId: string;
  runtimeProjectId: string | null;
  linkedAt: string;
  unlinkedAt: string | null;
}

export interface IdentityStore {
  getPrincipal(id: string): Principal | null;
  getOwnerPrincipal(): Principal | null;
  listPrincipals(kind?: PrincipalKind): Principal[];
  savePrincipal(principal: Principal, actor: string): void;
  getCredentialForAuthentication(id: string): CredentialAuthenticationRecord | null;
  saveCredential(credential: CredentialAuthenticationRecord, actor: string): void;
  createFirstOwner(principal: Principal, credential: CredentialAuthenticationRecord, actor: string): boolean;
  listPrincipalCredentials(principalId: string): PrincipalCredential[];
  revokeCredential(id: string, revokedAt: string, actor: string): boolean;
  recordCredentialUsed(id: string, usedAt: string): void;
  getKnowledgeProject(id: string): KnowledgeProject | null;
  saveKnowledgeProject(project: KnowledgeProject, actor: string): void;
  getKnowledgeProjectGrant(principalId: string, projectId: string): KnowledgeProjectGrant | null;
  listKnowledgeProjectGrants(principalId: string): KnowledgeProjectGrant[];
  saveKnowledgeProjectGrant(grant: KnowledgeProjectGrant, actor: string): void;
  getKnowledgeRoleBinding(principalId: string, projectId: string): KnowledgeRoleBinding | null;
  listKnowledgeRoleBindings(principalId: string): KnowledgeRoleBinding[];
  saveKnowledgeRoleBinding(binding: KnowledgeRoleBinding, expectedRevision: number, actor: string): boolean;
  getKnowledgeProjectRuntimeLink(projectId: string): KnowledgeProjectRuntimeLink | null;
  saveKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, actor: string): void;
}

/**
 * Runtime delegation and credential ceilings on the controller-owned connection.
 * Multi-row writes are atomic; revisions are compare-and-set.
 */
export interface RuntimeAccessStore {
  hasRuntimeProject(projectId: string): boolean;
  getRuntimeDelegation(principalId: string, projectId: string): RuntimeDelegation | null;
  listRuntimeDelegations(principalId: string): RuntimeDelegation[];
  saveRuntimeDelegation(delegation: RuntimeDelegation, expectedRevision: number, actor: string): boolean;
  getRuntimeCredentialScope(credentialId: string, projectId: string): RuntimeCredentialScope | null;
  listRuntimeCredentialScopes(credentialId: string): RuntimeCredentialScope[];
  issueScopedCredential(credential: CredentialAuthenticationRecord, scopes: RuntimeCredentialScope[], actor: string): void;
  /** Inserts the replacement and revokes the still-active original in one transaction; false if it was no longer active. */
  rotateScopedCredential(replacedId: string, revokedAt: string, credential: CredentialAuthenticationRecord, scopes: RuntimeCredentialScope[], actor: string): boolean;
}
