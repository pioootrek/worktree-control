import { effectiveKnowledgePermissions, effectiveRuntimeActions, isAuthorized, type AuthorizationSubject, type RuntimeAuthority } from "@/server/modules/authorization";
import { knowledgePermissions, setKnowledgeRoleSchema, revokeKnowledgeRoleSchema, listKnowledgeRolesSchema, type AuthorizationAction, type AuthorizationResource, type KnowledgeRoleBinding, type SubjectKind } from "@/shared/contracts/authorization";
import {
  issueRuntimeCredentialSchema, listRuntimeAccessSchema, revokeRuntimeDelegationSchema, rotateRuntimeCredentialSchema,
  runtimeActions, setRuntimeDelegationSchema,
  type RuntimeAccessEntry, type RuntimeAction, type RuntimeCredentialScope, type RuntimeDelegation,
} from "@/shared/contracts/runtime-access";
import type { ZodType } from "zod";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AuthenticatedIdentity,
  AuthenticatedPrincipal,
  CredentialAuthenticationRecord,
  IdentityStore,
  InstallationAuthority,
  KnowledgePermission,
  KnowledgeProject,
  KnowledgeProjectGrant,
  Principal,
  PrincipalCredential,
  PrincipalKind,
  RuntimeAccessStore,
} from "./contracts";

export type IdentityErrorCode =
  | "invalid_credential"
  | "owner_authentication_required"
  | "owner_already_initialized"
  | "principal_forbidden"
  | "knowledge_forbidden"
  | "invalid_request"
  | "role_revision_conflict"
  | "runtime_forbidden"
  | "runtime_revision_conflict";

export class IdentityError extends Error {
  constructor(readonly code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export interface IssueAgentTokenInput {
  principalId: string;
  label: string;
  expiresAt?: string;
}

export interface IssuedAgentToken {
  credential: PrincipalCredential;
  token: string;
}

export interface IssuedRuntimeCredential extends IssuedAgentToken {
  scopes: RuntimeCredentialScope[];
}

export interface RotatedRuntimeCredential extends IssuedRuntimeCredential {
  /** Revoked in the same transaction. Its credential-bound vault grants are not copied. */
  replacedCredentialId: string;
}

export interface RuntimeAccessReport {
  principal: Principal;
  /** Every stored delegation, including revocation tombstones and expired rows. */
  delegations: RuntimeDelegation[];
  /** Credentials with a runtime ceiling; `effective` is evaluated against current state. */
  credentials: Array<{ credential: PrincipalCredential; scopes: RuntimeCredentialScope[]; effective: RuntimeAccessEntry[] }>;
}

/** Identical for missing and unauthorized projects so denials do not reveal registration. */
export const RUNTIME_ACCESS_DENIED = "The project does not exist or this credential is not authorized for the requested action.";

export interface BootstrapOwnerInput {
  label?: string;
  sessionLifetimeSeconds?: number;
}

export interface BootstrappedOwner {
  principalId: string;
  credential: PrincipalCredential;
  token: string;
}

export interface CreateKnowledgeProjectInput {
  name: string;
}

export interface SetKnowledgeGrantInput {
  principalId: string;
  projectId: string;
  permissions: KnowledgePermission[];
}

const TOKEN_PREFIX = "wts";
const DUMMY_HASH = Buffer.alloc(32);
const KNOWLEDGE_PERMISSIONS = new Set<KnowledgePermission>(knowledgePermissions);

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function parseToken(token: string): { id: string; hash: Buffer } | null {
  const match = /^wts_([0-9a-f-]{36})_([0-9a-f]{64})$/.exec(token);
  return match ? { id: match[1]!, hash: hashToken(token) } : null;
}

function publicCredential(record: CredentialAuthenticationRecord): PrincipalCredential {
  return {
    id: record.id,
    principalId: record.principalId,
    kind: record.kind,
    label: record.label,
    tokenPrefix: record.tokenPrefix,
    status: record.status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function credentialMatchesPrincipal(
  credential: CredentialAuthenticationRecord,
  principalKind: AuthenticatedPrincipal["principalKind"],
): boolean {
  return (credential.kind === "owner_session" && principalKind === "owner")
    || (credential.kind === "agent_token" && principalKind === "agent")
    || (credential.kind === "worker_token" && principalKind === "worker");
}

export class IdentityService {
  constructor(
    private readonly store: IdentityStore,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
    private readonly secret: () => string = () => randomBytes(32).toString("hex"),
    private readonly installationAuthority?: InstallationAuthority,
    private readonly runtimeAccess?: RuntimeAccessStore,
  ) {}

  bootstrapOwnerSession(input: BootstrapOwnerInput = {}): BootstrappedOwner {
    const now = this.clock();
    const principal = { id: this.id(), kind: "owner" as const, status: "active" as const };
    const issued = this.createOwnerSessionToken(principal.id, input, now, "Local owner bootstrap");
    if (!this.store.createFirstOwner(principal, issued.record, "local-bootstrap")) {
      throw new IdentityError("owner_already_initialized", "Właściciel został już zainicjalizowany.");
    }
    return { principalId: principal.id, credential: publicCredential(issued.record), token: issued.token };
  }

  recoverOwnerSession(input: BootstrapOwnerInput = {}): BootstrappedOwner {
    const principal = this.store.getOwnerPrincipal();
    if (!principal || principal.status !== "active") {
      throw new IdentityError("principal_forbidden", "Brak aktywnego właściciela do odzyskania sesji.");
    }
    const now = this.clock();
    const issued = this.createOwnerSessionToken(principal.id, input, now, "Local owner recovery");
    this.store.saveCredential(issued.record, "local-recovery");
    return { principalId: principal.id, credential: publicCredential(issued.record), token: issued.token };
  }

  renewOwnerSession(input: BootstrapOwnerInput, actor: AuthenticatedPrincipal): BootstrappedOwner {
    this.requireCurrentAuthentication(actor);
    if (!isOwnerSession(actor)) {
      throw new IdentityError("owner_authentication_required", "Ta operacja wymaga uwierzytelnionej sesji właściciela.");
    }
    const now = this.clock();
    const issued = this.createOwnerSessionToken(actor.principalId, input, now, "Local owner renewal");
    this.store.saveCredential(issued.record, actor.principalId);
    return { principalId: actor.principalId, credential: publicCredential(issued.record), token: issued.token };
  }

  authenticateBearer(token: string): AuthenticatedPrincipal {
    const parsed = parseToken(token);
    const record = parsed ? this.store.getCredentialForAuthentication(parsed.id) : null;
    const expected = record && /^[0-9a-f]{64}$/.test(record.verifierHash)
      ? Buffer.from(record.verifierHash, "hex")
      : DUMMY_HASH;
    const supplied = parsed?.hash ?? hashToken(token);
    const matches = timingSafeEqual(expected, supplied);
    const principal = record ? this.store.getPrincipal(record.principalId) : null;
    const now = this.clock();

    if (
      !matches
      || !record
      || record.status !== "active"
      || record.revokedAt !== null
      || (record.expiresAt !== null && record.expiresAt <= now)
      || !principal
      || principal.status !== "active"
      || !credentialMatchesPrincipal(record, principal.kind)
    ) {
      throw new IdentityError("invalid_credential", "Nieprawidłowe lub nieaktywne poświadczenie.");
    }

    this.store.recordCredentialUsed(record.id, now);
    return {
      principalId: principal.id,
      principalKind: principal.kind,
      credentialId: record.id,
      authenticationMethod: record.kind,
    };
  }

  describeIdentity(actor: AuthenticatedPrincipal): AuthenticatedIdentity {
    this.requireCurrentAuthentication(actor);
    const principal = this.store.getPrincipal(actor.principalId)!;
    if (principal.kind === "installation") {
      return { principal, credential: null, knowledgeGrants: [], installationAuthority: true };
    }
    const credential = this.store.getCredentialForAuthentication(actor.credentialId)!;
    return {
      principal,
      credential: publicCredential(credential),
      ...(principal.kind === "agent" && this.runtimeAccess ? { runtimeAccess: this.currentRuntimeAccess(actor, credential) } : {}),
      knowledgeGrants: this.store.listKnowledgeProjectGrants(actor.principalId)
        .filter((grant) => grant.revokedAt === null)
        .map(grant => ({ projectId: grant.projectId, permissions: effectiveKnowledgePermissions(this.subject(actor), grant.projectId, {
          grant, binding: this.store.getKnowledgeRoleBinding(actor.principalId, grant.projectId),
        }) }))
        .filter(grant => grant.permissions.length > 0),
    };
  }

  issueAgentToken(input: IssueAgentTokenInput, actor: AuthenticatedPrincipal): IssuedAgentToken {
    this.requireOwnerSession(actor);
    const principal = this.store.getPrincipal(input.principalId);
    if (!principal || principal.kind !== "agent" || principal.status !== "active") {
      throw new IdentityError("principal_forbidden", "Token można wydać wyłącznie aktywnemu agentowi.");
    }
    const label = input.label.trim();
    if (!label || label.length > 120) {
      throw new IdentityError("invalid_request", "Etykieta tokenu musi mieć od 1 do 120 znaków.");
    }
    const now = this.clock();
    const expiresAtTimestamp = input.expiresAt === undefined ? null : Date.parse(input.expiresAt);
    if (expiresAtTimestamp !== null && !Number.isFinite(expiresAtTimestamp)) {
      throw new IdentityError("invalid_request", "Nieprawidłowa data wygaśnięcia.");
    }
    const expiresAt = expiresAtTimestamp === null ? null : new Date(expiresAtTimestamp).toISOString();
    if (expiresAt !== null && expiresAt <= now) {
      throw new IdentityError("invalid_request", "Data wygaśnięcia musi być w przyszłości.");
    }

    const issued = this.createTokenRecord(principal.id, "agent_token", label, now, expiresAt);
    this.store.saveCredential(issued.record, actor.principalId);
    return { credential: publicCredential(issued.record), token: issued.token };
  }

  createWorker(actor: AuthenticatedPrincipal): Principal {
    this.requireOwnerSession(actor);
    const principal: Principal = { id: this.id(), kind: "worker", status: "active" };
    this.store.savePrincipal(principal, actor.principalId);
    return principal;
  }

  issueWorkerToken(input: IssueAgentTokenInput, actor: AuthenticatedPrincipal): IssuedAgentToken {
    this.requireOwnerSession(actor);
    const principal = this.store.getPrincipal(input.principalId);
    if (principal?.kind !== "worker" || principal.status !== "active") throw new IdentityError("principal_forbidden", "Active worker required.");
    if (!input.label.trim() || input.label.length > 120) throw new IdentityError("invalid_request", "Invalid token label.");
    const now = this.clock();
    const expiresAt = input.expiresAt === undefined ? null : new Date(input.expiresAt).toISOString();
    if (expiresAt && expiresAt <= now) throw new IdentityError("invalid_request", "Token expiry must be in the future.");
    const issued = this.createTokenRecord(principal.id, "worker_token", input.label.trim(), now, expiresAt);
    this.store.saveCredential(issued.record, actor.principalId);
    return { credential: publicCredential(issued.record), token: issued.token };
  }

  createAgent(actor: AuthenticatedPrincipal): Principal {
    this.requireOwnerSession(actor);
    const principal: Principal = { id: this.id(), kind: "agent", status: "active" };
    this.store.savePrincipal(principal, actor.principalId);
    return principal;
  }

  listAgents(actor: AuthenticatedPrincipal): Principal[] {
    this.requireOwnerSession(actor);
    return this.store.listPrincipals("agent");
  }

  revokeAgent(principalId: string, actor: AuthenticatedPrincipal): Principal {
    this.requireOwnerSession(actor);
    const principal = this.store.getPrincipal(principalId);
    if (!principal || principal.kind !== "agent" || principal.status !== "active") {
      throw new IdentityError("invalid_request", "Nie znaleziono aktywnego agenta.");
    }
    const revoked: Principal = { ...principal, status: "revoked" };
    this.store.savePrincipal(revoked, actor.principalId);
    return revoked;
  }

  listAgentCredentials(principalId: string, actor: AuthenticatedPrincipal): PrincipalCredential[] {
    this.requireOwnerSession(actor);
    const principal = this.store.getPrincipal(principalId);
    if (!principal || principal.kind !== "agent") {
      throw new IdentityError("invalid_request", "Nie znaleziono agenta.");
    }
    return this.store.listPrincipalCredentials(principalId);
  }

  createKnowledgeProject(input: CreateKnowledgeProjectInput, actor: AuthenticatedPrincipal): KnowledgeProject {
    this.requireOwnerSession(actor);
    const name = input.name.trim();
    if (!name || name.length > 120) {
      throw new IdentityError("invalid_request", "Nazwa projektu wiedzy musi mieć od 1 do 120 znaków.");
    }
    const now = this.clock();
    const project: KnowledgeProject = {
      id: this.id(), name, status: "active", revision: 1, createdAt: now, updatedAt: now,
    };
    this.store.saveKnowledgeProject(project, actor.principalId);
    return project;
  }

  setKnowledgeGrant(input: SetKnowledgeGrantInput, actor: AuthenticatedPrincipal): KnowledgeProjectGrant {
    this.requireOwnerSession(actor);
    const principal = this.store.getPrincipal(input.principalId);
    const project = this.store.getKnowledgeProject(input.projectId);
    const permissions = [...new Set(input.permissions)].sort();
    if (!principal || principal.status !== "active" || principal.kind === "worker" || principal.kind === "installation") {
      throw new IdentityError("invalid_request", "Grant można nadać wyłącznie aktywnemu właścicielowi lub agentowi.");
    }
    if (!project || project.status !== "active") {
      throw new IdentityError("invalid_request", "Nie znaleziono aktywnego projektu wiedzy.");
    }
    if (permissions.length === 0 || permissions.some((permission) => !KNOWLEDGE_PERMISSIONS.has(permission))) {
      throw new IdentityError("invalid_request", "Grant musi zawierać co najmniej jedno prawidłowe uprawnienie.");
    }
    if (permissions.includes("knowledge:approve") && principal.kind !== "owner") {
      throw new IdentityError("invalid_request", "Uprawnienie zatwierdzania może otrzymać wyłącznie właściciel.");
    }
    const grant: KnowledgeProjectGrant = {
      principalId: principal.id, projectId: project.id, permissions, revokedAt: null,
    };
    this.store.saveKnowledgeProjectGrant(grant, actor.principalId);
    return grant;
  }

  listKnowledgeGrants(principalId: string, actor: AuthenticatedPrincipal): KnowledgeProjectGrant[] {
    this.requireOwnerSession(actor);
    const principal = this.store.getPrincipal(principalId);
    if (!principal || principal.kind === "worker" || principal.kind === "installation") throw new IdentityError("invalid_request", "Nie znaleziono właściciela ani agenta.");
    return this.store.listKnowledgeProjectGrants(principalId);
  }

  revokeKnowledgeGrant(principalId: string, projectId: string, actor: AuthenticatedPrincipal): KnowledgeProjectGrant {
    this.requireOwnerSession(actor);
    const grant = this.store.getKnowledgeProjectGrant(principalId, projectId);
    if (!grant || grant.revokedAt !== null) throw new IdentityError("invalid_request", "Nie znaleziono aktywnego grantu.");
    const revoked = { ...grant, revokedAt: this.clock() };
    this.store.saveKnowledgeProjectGrant(revoked, actor.principalId);
    return revoked;
  }

  revokeCredential(credentialId: string, actor: AuthenticatedPrincipal): void {
    this.requireOwnerSession(actor);
    if (!this.store.revokeCredential(credentialId, this.clock(), actor.principalId)) {
      throw new IdentityError("invalid_request", "Nie znaleziono poświadczenia.");
    }
  }

  authorizeKnowledge(
    actor: AuthenticatedPrincipal,
    projectId: string,
    permission: KnowledgePermission,
    options: { allowArchived?: boolean } = {},
  ): void {
    this.authorize(actor, permission, { kind: "knowledge-project", id: projectId }, options);
  }

  /** The application boundary re-reads authentication and authority on every operation. */
  authorize(actor: AuthenticatedPrincipal, action: AuthorizationAction, resource: AuthorizationResource, context: { allowArchived?: boolean } = {}): void {
    this.requireCurrentAuthentication(actor);
    if (resource.kind === "runtime-project") {
      if (!isAuthorized(this.subject(actor), action, resource, {
        project: null, grant: null, binding: null, runtime: this.runtimeAuthority(actor, resource.id),
      })) throw new IdentityError("runtime_forbidden", RUNTIME_ACCESS_DENIED);
      return;
    }
    const knowledge = resource.kind === "knowledge-project";
    if (!isAuthorized(this.subject(actor), action, resource, {
      project: knowledge ? this.store.getKnowledgeProject(resource.id) : null,
      grant: knowledge ? this.store.getKnowledgeProjectGrant(actor.principalId, resource.id) : null,
      binding: knowledge ? this.store.getKnowledgeRoleBinding(actor.principalId, resource.id) : null,
      allowArchived: context.allowArchived,
    })) throw new IdentityError("knowledge_forbidden", "Brak dostępu do projektu wiedzy.");
  }

  private subject(actor: AuthenticatedPrincipal): AuthorizationSubject {
    return { id: actor.principalId, kind: subjectKind(actor.principalKind), humanSession: isOwnerSession(actor) };
  }

  /** Re-reads credential, agent, delegation, ceiling and sponsor; throws one safe denial for every failure. */
  authorizeRuntime(actor: AuthenticatedPrincipal, projectId: string, action: RuntimeAction): void {
    try {
      this.authorize(actor, action, { kind: "runtime-project", id: projectId });
    } catch (error) {
      if (error instanceof IdentityError) throw new IdentityError("runtime_forbidden", RUNTIME_ACCESS_DENIED);
      throw error;
    }
  }

  /** Current effective runtime scope of the authenticated credential. */
  runtimeAccessFor(actor: AuthenticatedPrincipal): RuntimeAccessEntry[] {
    this.requireCurrentAuthentication(actor);
    if (actor.principalKind !== "agent" || !this.runtimeAccess) return [];
    return this.currentRuntimeAccess(actor, this.store.getCredentialForAuthentication(actor.credentialId)!);
  }

  setRuntimeDelegation(value: unknown, actor: AuthenticatedPrincipal): RuntimeDelegation {
    const store = this.requireRuntimeAdministration(actor);
    const input = parseRuntimeInput(setRuntimeDelegationSchema, value, "Invalid runtime delegation.");
    const principal = this.store.getPrincipal(input.principalId);
    if (principal?.kind !== "agent" || principal.status !== "active") {
      throw new IdentityError("invalid_request", "Runtime delegation requires an active agent principal.");
    }
    if (!store.hasRuntimeProject(input.projectId)) throw new IdentityError("invalid_request", "Registered runtime project not found.");
    const now = this.clock();
    const current = store.getRuntimeDelegation(input.principalId, input.projectId);
    if ((current?.revision ?? 0) !== input.expectedRevision) throw runtimeConflict();
    // Omission preserves the existing ceiling; only explicit null removes it.
    const expiresAt = input.expiresAt === undefined
      ? current?.expiresAt ?? null
      : futureTimestamp(input.expiresAt ?? undefined, now);
    const delegation: RuntimeDelegation = {
      principalId: input.principalId, projectId: input.projectId, sponsorId: actor.principalId,
      actions: canonicalActions(input.actions), revision: input.expectedRevision + 1,
      expiresAt, updatedAt: now, revokedAt: null,
    };
    if (!store.saveRuntimeDelegation(delegation, input.expectedRevision, actor.principalId)) throw runtimeConflict();
    return delegation;
  }

  revokeRuntimeDelegation(value: unknown, actor: AuthenticatedPrincipal): RuntimeDelegation {
    const store = this.requireRuntimeAdministration(actor);
    const input = parseRuntimeInput(revokeRuntimeDelegationSchema, value, "Invalid runtime delegation.");
    const current = store.getRuntimeDelegation(input.principalId, input.projectId);
    if (!current || current.revokedAt !== null || current.revision !== input.expectedRevision) throw runtimeConflict();
    const now = this.clock();
    const tombstone: RuntimeDelegation = { ...current, revision: current.revision + 1, updatedAt: now, revokedAt: now };
    if (!store.saveRuntimeDelegation(tombstone, input.expectedRevision, actor.principalId)) throw runtimeConflict();
    return tombstone;
  }

  listRuntimeAccess(value: unknown, actor: AuthenticatedPrincipal): RuntimeAccessReport {
    const store = this.requireRuntimeAdministration(actor);
    const input = parseRuntimeInput(listRuntimeAccessSchema, value, "Invalid principal.");
    const principal = this.store.getPrincipal(input.principalId);
    if (principal?.kind !== "agent") throw new IdentityError("invalid_request", "Agent principal not found.");
    return {
      principal,
      delegations: store.listRuntimeDelegations(principal.id),
      credentials: this.store.listPrincipalCredentials(principal.id).flatMap((credential) => {
        const scopes = store.listRuntimeCredentialScopes(credential.id);
        if (!scopes.length) return [];
        const record = this.store.getCredentialForAuthentication(credential.id)!;
        const usable = principal.status === "active" && record.kind === "agent_token" && record.status === "active"
          && record.revokedAt === null && (record.expiresAt === null || record.expiresAt > this.clock());
        const effective = usable ? this.currentRuntimeAccess({
          principalId: principal.id, principalKind: "agent", credentialId: credential.id, authenticationMethod: "agent_token",
        }, record) : [];
        return [{ credential, scopes, effective }];
      }),
    };
  }

  issueRuntimeCredential(value: unknown, actor: AuthenticatedPrincipal): IssuedRuntimeCredential {
    const store = this.requireRuntimeAdministration(actor);
    const input = parseRuntimeInput(issueRuntimeCredentialSchema, value, "Invalid runtime credential request.");
    const principal = this.store.getPrincipal(input.principalId);
    if (principal?.kind !== "agent" || principal.status !== "active") {
      throw new IdentityError("principal_forbidden", "A runtime credential can be issued only to an active agent.");
    }
    const label = input.label.trim();
    if (!label) throw new IdentityError("invalid_request", "Credential label must contain 1 to 120 characters.");
    const now = this.clock();
    const expiresAt = futureTimestamp(input.expiresAt, now);
    const requested = uniqueScopes(input.projects);
    for (const scope of requested) {
      const delegation = store.getRuntimeDelegation(principal.id, scope.projectId);
      const sponsor = delegation ? this.store.getPrincipal(delegation.sponsorId) : null;
      if (!store.hasRuntimeProject(scope.projectId) || !delegation || delegation.revokedAt !== null
        || (delegation.expiresAt !== null && delegation.expiresAt <= now)
        || sponsor?.kind !== "owner" || sponsor.status !== "active"
        || scope.actions.some(action => !delegation.actions.includes(action))) {
        throw new IdentityError("invalid_request", `Project ${scope.projectId} has no active delegation covering the requested actions.`);
      }
    }
    const issued = this.createTokenRecord(principal.id, "agent_token", label, now, expiresAt);
    const scopes = requested.map(scope => ({ credentialId: issued.record.id, projectId: scope.projectId, actions: scope.actions, createdAt: now }));
    store.issueScopedCredential(issued.record, scopes, actor.principalId);
    return { credential: publicCredential(issued.record), token: issued.token, scopes };
  }

  rotateRuntimeCredential(value: unknown, actor: AuthenticatedPrincipal): RotatedRuntimeCredential {
    const store = this.requireRuntimeAdministration(actor);
    const input = parseRuntimeInput(rotateRuntimeCredentialSchema, value, "Invalid runtime credential rotation.");
    const now = this.clock();
    const replaced = this.store.getCredentialForAuthentication(input.credentialId);
    const principal = replaced ? this.store.getPrincipal(replaced.principalId) : null;
    const previous = replaced ? store.listRuntimeCredentialScopes(replaced.id) : [];
    if (!replaced || replaced.kind !== "agent_token" || replaced.status !== "active" || replaced.revokedAt !== null
      || (replaced.expiresAt !== null && replaced.expiresAt <= now)
      || principal?.kind !== "agent" || principal.status !== "active" || !previous.length) {
      throw new IdentityError("invalid_request", "An active scoped runtime credential of an active agent is required.");
    }
    const expiresAt = input.expiresAt === undefined ? replaced.expiresAt : futureTimestamp(input.expiresAt, now);
    if (replaced.expiresAt !== null && (expiresAt === null || expiresAt > replaced.expiresAt)) {
      throw new IdentityError("invalid_request", "Rotation cannot extend the replaced credential's expiry.");
    }
    const narrowed = input.projects ? uniqueScopes(input.projects) : previous.map(({ projectId, actions }) => ({ projectId, actions }));
    for (const scope of narrowed) {
      const prior = previous.find(entry => entry.projectId === scope.projectId);
      if (!prior || scope.actions.some(action => !prior.actions.includes(action))) {
        throw new IdentityError("invalid_request", "Rotation can only keep or narrow the replaced credential's scope.");
      }
    }
    const label = input.label?.trim() ?? replaced.label;
    if (!label) throw new IdentityError("invalid_request", "Credential label must contain 1 to 120 characters.");
    const issued = this.createTokenRecord(principal.id, "agent_token", label, now, expiresAt);
    const scopes = narrowed.map(scope => ({ credentialId: issued.record.id, projectId: scope.projectId, actions: scope.actions, createdAt: now }));
    if (!store.rotateScopedCredential(replaced.id, now, issued.record, scopes, actor.principalId)) {
      throw new IdentityError("invalid_request", "An active scoped runtime credential of an active agent is required.");
    }
    return { credential: publicCredential(issued.record), token: issued.token, scopes, replacedCredentialId: replaced.id };
  }

  /**
   * Strictly a current owner session of the stored owner. Installation authority
   * cannot sponsor agents, so the sponsor is always an authenticated human.
   */
  private requireRuntimeAdministration(actor: AuthenticatedPrincipal): RuntimeAccessStore {
    this.requireCurrentAuthentication(actor);
    if (!isOwnerSession(actor) || this.store.getOwnerPrincipal()?.id !== actor.principalId) {
      throw new IdentityError("owner_authentication_required", "Runtime delegation requires an authenticated owner session; the installation token cannot sponsor agents.");
    }
    if (!this.runtimeAccess) throw new IdentityError("invalid_request", "Runtime access administration is unavailable.");
    return this.runtimeAccess;
  }

  private runtimeAuthority(actor: AuthenticatedPrincipal, projectId: string): RuntimeAuthority | undefined {
    const store = this.runtimeAccess;
    if (!store || actor.principalKind !== "agent") return undefined;
    const delegation = store.getRuntimeDelegation(actor.principalId, projectId);
    const sponsor = delegation ? this.store.getPrincipal(delegation.sponsorId) : null;
    return {
      now: this.clock(),
      credentialId: actor.credentialId,
      project: store.hasRuntimeProject(projectId) ? { id: projectId } : null,
      delegation,
      scope: store.getRuntimeCredentialScope(actor.credentialId, projectId),
      sponsor: sponsor ? { id: sponsor.id, kind: subjectKind(sponsor.kind), status: sponsor.status } : null,
    };
  }

  private currentRuntimeAccess(actor: AuthenticatedPrincipal, credential: CredentialAuthenticationRecord): RuntimeAccessEntry[] {
    const store = this.runtimeAccess;
    if (!store) return [];
    return store.listRuntimeCredentialScopes(actor.credentialId).flatMap((scope) => {
      const authority = this.runtimeAuthority(actor, scope.projectId);
      const actions = authority ? effectiveRuntimeActions(this.subject(actor), scope.projectId, authority) : [];
      if (!actions.length) return [];
      return [{ projectId: scope.projectId, actions, expiresAt: earliest(credential.expiresAt, authority!.delegation!.expiresAt) }];
    });
  }

  setKnowledgeRole(value: unknown, actor: AuthenticatedPrincipal): KnowledgeRoleBinding {
    this.requireOwnerSession(actor);
    const parsed = setKnowledgeRoleSchema.safeParse(value);
    if (!parsed.success) throw new IdentityError("invalid_request", "Nieprawidłowe przypisanie roli.");
    const input = parsed.data;
    const principal = this.store.getPrincipal(input.principalId);
    const project = this.store.getKnowledgeProject(input.projectId);
    const grant = this.store.getKnowledgeProjectGrant(input.principalId, input.projectId);
    if (!principal || principal.status !== "active" || !["owner", "agent"].includes(principal.kind)
      || (input.role === "manager" && principal.kind !== "owner")
      || project?.status !== "active" || !grant || grant.revokedAt !== null) {
      throw new IdentityError("invalid_request", "Rola wymaga aktywnego grantu; manager wymaga człowieka.");
    }
    const binding: KnowledgeRoleBinding = { principalId: input.principalId, projectId: input.projectId,
      role: input.role, revision: input.expectedRevision + 1, updatedAt: this.clock(), revokedAt: null };
    if (!this.store.saveKnowledgeRoleBinding(binding, input.expectedRevision, actor.principalId)) {
      throw new IdentityError("role_revision_conflict", "Nieaktualna rewizja przypisania roli.");
    }
    return binding;
  }

  listKnowledgeRoles(value: unknown, actor: AuthenticatedPrincipal): KnowledgeRoleBinding[] {
    this.requireOwnerSession(actor);
    const parsed = listKnowledgeRolesSchema.safeParse(value);
    if (!parsed.success) throw new IdentityError("invalid_request", "Nieprawidłowy podmiot.");
    return this.store.listKnowledgeRoleBindings(parsed.data.principalId);
  }

  revokeKnowledgeRole(value: unknown, actor: AuthenticatedPrincipal): KnowledgeRoleBinding {
    this.requireOwnerSession(actor);
    const parsed = revokeKnowledgeRoleSchema.safeParse(value);
    if (!parsed.success) throw new IdentityError("invalid_request", "Nieprawidłowe przypisanie roli.");
    const input = parsed.data;
    const current = this.store.getKnowledgeRoleBinding(input.principalId, input.projectId);
    if (!current || current.revokedAt !== null || current.revision !== input.expectedRevision) {
      throw new IdentityError("role_revision_conflict", "Nieaktualna rewizja przypisania roli.");
    }
    const now = this.clock();
    const binding = { ...current, revision: current.revision + 1, updatedAt: now, revokedAt: now };
    if (!this.store.saveKnowledgeRoleBinding(binding, input.expectedRevision, actor.principalId)) {
      throw new IdentityError("role_revision_conflict", "Nieaktualna rewizja przypisania roli.");
    }
    return binding;
  }

  /** Owner-level authority: an owner session or the current installation authority. */
  requireOwnerSession(actor: AuthenticatedPrincipal): void {
    this.requireCurrentAuthentication(actor);
    if (!isOwnerSession(actor) && actor.principalKind !== "installation") {
      throw new IdentityError("owner_authentication_required", "Ta operacja wymaga uwierzytelnionej sesji właściciela.");
    }
  }

  private requireCurrentAuthentication(actor: AuthenticatedPrincipal): void {
    const principal = this.store.getPrincipal(actor.principalId);
    if (actor.principalKind === "installation") {
      if (
        principal?.kind !== "installation"
        || principal.status !== "active"
        || !this.installationAuthority?.isCurrentInstallationActor(actor)
      ) {
        throw new IdentityError("invalid_credential", "Nieprawidłowe lub nieaktywne poświadczenie.");
      }
      return;
    }
    const credential = this.store.getCredentialForAuthentication(actor.credentialId);
    const now = this.clock();
    if (
      !principal
      || principal.status !== "active"
      || principal.kind !== actor.principalKind
      || !credential
      || credential.principalId !== principal.id
      || credential.kind !== actor.authenticationMethod
      || !credentialMatchesPrincipal(credential, principal.kind)
      || credential.status !== "active"
      || credential.revokedAt !== null
      || (credential.expiresAt !== null && credential.expiresAt <= now)
    ) {
      throw new IdentityError("invalid_credential", "Nieprawidłowe lub nieaktywne poświadczenie.");
    }
  }

  private createTokenRecord(
    principalId: string,
    kind: CredentialAuthenticationRecord["kind"],
    label: string,
    createdAt: string,
    expiresAt: string | null,
  ): { record: CredentialAuthenticationRecord; token: string } {
    const credentialId = this.id();
    const secret = this.secret();
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("Generator tokenu nie zwrócił 256-bitowego sekretu.");
    const token = `${TOKEN_PREFIX}_${credentialId}_${secret}`;
    return {
      token,
      record: {
        id: credentialId,
        principalId,
        kind,
        label,
        tokenPrefix: `${TOKEN_PREFIX}_${credentialId}`,
        verifierHash: hashToken(token).toString("hex"),
        status: "active",
        expiresAt,
        createdAt,
        revokedAt: null,
        lastUsedAt: null,
      },
    };
  }

  private createOwnerSessionToken(
    principalId: string,
    input: BootstrapOwnerInput,
    now: string,
    defaultLabel: string,
  ): { record: CredentialAuthenticationRecord; token: string } {
    const lifetime = input.sessionLifetimeSeconds;
    if (lifetime !== undefined && (!Number.isInteger(lifetime) || lifetime < 60 || lifetime > 3600)) {
      throw new IdentityError("invalid_request", "Sesja właściciela musi trwać od 60 do 3600 sekund.");
    }
    const label = (input.label ?? defaultLabel).trim();
    if (!label || label.length > 120) {
      throw new IdentityError("invalid_request", "Etykieta sesji musi mieć od 1 do 120 znaków.");
    }
    const expiresAt = lifetime === undefined ? null : new Date(Date.parse(now) + lifetime * 1000).toISOString();
    return this.createTokenRecord(principalId, "owner_session", label, now, expiresAt);
  }
}

function subjectKind(kind: PrincipalKind): SubjectKind {
  // Stored `owner` principals keep their IDs and kind; policy treats them as humans.
  return kind === "owner" ? "human" : kind;
}

function canonicalActions(actions: readonly RuntimeAction[]): RuntimeAction[] {
  return runtimeActions.filter(action => actions.includes(action));
}

function uniqueScopes(scopes: Array<{ projectId: string; actions: RuntimeAction[] }>): Array<{ projectId: string; actions: RuntimeAction[] }> {
  if (new Set(scopes.map(scope => scope.projectId)).size !== scopes.length) {
    throw new IdentityError("invalid_request", "Each project may appear only once in a credential scope.");
  }
  return scopes.map(scope => ({ projectId: scope.projectId, actions: canonicalActions(scope.actions) }));
}

function earliest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function futureTimestamp(value: string | undefined, now: string): string | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new IdentityError("invalid_request", "Invalid expiry timestamp.");
  const normalized = new Date(parsed).toISOString();
  if (normalized <= now) throw new IdentityError("invalid_request", "Expiry must be in the future.");
  return normalized;
}

function runtimeConflict(): IdentityError {
  return new IdentityError("runtime_revision_conflict", "Stale runtime delegation revision.");
}

function parseRuntimeInput<T>(schema: ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Unsupported grants are refused explicitly rather than stored for a later slice.
  if (parsed.error.issues.some(issue => issue.path.includes("actions"))) {
    throw new IdentityError("invalid_request", `Unsupported runtime action. Supported actions: ${runtimeActions.join(", ")}.`);
  }
  throw new IdentityError("invalid_request", message);
}

function isOwnerSession(actor: AuthenticatedPrincipal): boolean {
  return actor.principalKind === "owner" && actor.authenticationMethod === "owner_session";
}
