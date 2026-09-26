import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AuthenticatedIdentity,
  AuthenticatedPrincipal,
  CredentialAuthenticationRecord,
  IdentityStore,
  KnowledgePermission,
  KnowledgeProject,
  KnowledgeProjectGrant,
  Principal,
  PrincipalCredential,
} from "./contracts";

export type IdentityErrorCode =
  | "invalid_credential"
  | "owner_authentication_required"
  | "owner_already_initialized"
  | "principal_forbidden"
  | "knowledge_forbidden"
  | "invalid_request";

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
const KNOWLEDGE_PERMISSIONS = new Set<KnowledgePermission>([
  "knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export", "knowledge:import",
  "attachments:read", "attachments:write",
]);

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
    this.requireOwnerSession(actor);
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
    const credential = this.store.getCredentialForAuthentication(actor.credentialId)!;
    return {
      principal,
      credential: publicCredential(credential),
      knowledgeGrants: this.store.listKnowledgeProjectGrants(actor.principalId)
        .filter((grant) => grant.revokedAt === null)
        .map(({ projectId, permissions }) => ({ projectId, permissions })),
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
    this.requireCurrentAuthentication(actor);
    const project = this.store.getKnowledgeProject(projectId);
    const grant = this.store.getKnowledgeProjectGrant(actor.principalId, projectId);
    if (
      !project
      || (project.status !== "active" && permission !== "knowledge:read" && !options.allowArchived)
      || !grant
      || grant.revokedAt !== null
      || !grant.permissions.includes(permission)
      || (permission === "knowledge:approve"
        && (actor.principalKind !== "owner" || actor.authenticationMethod !== "owner_session"))
    ) {
      throw new IdentityError("knowledge_forbidden", "Brak dostępu do projektu wiedzy.");
    }
  }

  requireOwnerSession(actor: AuthenticatedPrincipal): void {
    this.requireCurrentAuthentication(actor);
    if (actor.principalKind !== "owner" || actor.authenticationMethod !== "owner_session") {
      throw new IdentityError("owner_authentication_required", "Ta operacja wymaga uwierzytelnionej sesji właściciela.");
    }
  }

  private requireCurrentAuthentication(actor: AuthenticatedPrincipal): void {
    const principal = this.store.getPrincipal(actor.principalId);
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
