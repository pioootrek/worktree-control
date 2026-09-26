import type { KnowledgeProject } from "@/shared/contracts/knowledge";
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

export type KnowledgePermission =
  | "knowledge:read"
  | "knowledge:write"
  | "knowledge:approve"
  | "knowledge:export"
  | "knowledge:import"
  | "attachments:read"
  | "attachments:write";

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
  getKnowledgeProjectRuntimeLink(projectId: string): KnowledgeProjectRuntimeLink | null;
  saveKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, actor: string): void;
}
