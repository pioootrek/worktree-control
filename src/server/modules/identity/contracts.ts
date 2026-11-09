import type { KnowledgePermission, KnowledgeRoleBinding } from "@/shared/contracts/authorization";
import type { KnowledgeProject } from "@/shared/contracts/knowledge";
import type { RuntimeAccessEntry, RuntimeAction, RuntimeCredentialScope, RuntimeDelegation } from "@/shared/contracts/runtime-access";
/** `installation` is the single installation-wide authority; it never holds credentials or grants. */
export type PrincipalKind = "owner" | "human" | "agent" | "worker" | "installation";
export type IdentityStatus = "active" | "revoked";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  status: IdentityStatus;
}

export type CredentialKind = "owner_session" | "agent_token" | "worker_token";
/** Stored credentials, installation authority, or a distinct in-process provider session. */
export type AuthenticationMethod = CredentialKind | "installation_token" | "none" | "provider_session";

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

export interface CredentialAuthenticatedPrincipal {
  principalId: string;
  principalKind: Exclude<PrincipalKind, "human">;
  credentialId: string;
  authenticationMethod: Exclude<AuthenticationMethod, "provider_session">;
}

declare const providerSessionActor: unique symbol;
/** Server-only opaque reference. Only the issuing runtime can authenticate this exact object. */
export interface ProviderSessionActor {
  readonly [providerSessionActor]: true;
  readonly principalId: string;
  readonly principalKind: "owner" | "human";
  readonly credentialId: null;
  readonly authenticationMethod: "provider_session";
}
export type AuthenticatedPrincipal = CredentialAuthenticatedPrincipal | ProviderSessionActor;

/** Server-only non-secret identity digest. Never part of an identity/HTTP projection. */
export interface ProviderRuntimeSession {
  readonly principalId: string;
  readonly sessionKey: string;
  readonly evidenceKey: string;
  readonly generation: number;
  readonly deadline: string;
}
export interface RetainedProviderSession extends ProviderRuntimeSession {
  readonly nativeSessionId: string;
}
export interface HumanRuntimeAuthority extends ProviderRuntimeSession {
  readonly membershipRevision: number;
  readonly permissions: readonly RuntimeAction[];
}
export interface HumanVerificationAuthorizer {
  captureHumanVerificationAuthority(actor: ProviderSessionActor, projectId: string): { authority: HumanRuntimeAuthority; reference: RetainedProviderSession };
  validateHumanVerificationAuthority(authority: HumanRuntimeAuthority, reference: RetainedProviderSession, projectId: string): void;
}
/** Synchronous current-state checks on the admitted connection; never borrows the provider. */
export interface ProviderSessionAuthority {
  isCurrentProviderSession(actor: ProviderSessionActor, now: string): boolean;
  resolveRuntimeSession?(actor: ProviderSessionActor, now: string): ProviderRuntimeSession | null;
  captureRuntimeSession?(actor: ProviderSessionActor, now: string): RetainedProviderSession | null;
  validateRetainedRuntimeSession?(reference: RetainedProviderSession, now: string): boolean;
}

export type ControllerAuthentication =
  | { kind: "legacy" }
  | { kind: "installation"; actor: CredentialAuthenticatedPrincipal }
  | { kind: "principal"; actor: CredentialAuthenticatedPrincipal };

/** Confirms that an installation actor still matches the active authentication policy. */
export interface InstallationAuthority {
  isCurrentInstallationActor(actor: AuthenticatedPrincipal): boolean;
  permitsCredential?(actor: AuthenticatedPrincipal): boolean;
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
  /** Null for installation authority and provider sessions; neither has a stored A2 credential. */
  credential: PrincipalCredential | null;
  knowledgeGrants: Array<Pick<KnowledgeProjectGrant, "projectId" | "permissions">>;
  /** Current effective scope for scoped agents and provider-session humans. */
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
  /** Bounded first-owner inspection, including revoked owners. */
  ownerPrincipals(): Principal[];
  createFirstOwnerPrincipal(principal: Principal, actor: string): boolean;
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
