import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CredentialAuthenticationRecord,
  AuthenticatedPrincipal,
  IdentityStore,
  InstallationAuthority,
  KnowledgeProject,
  KnowledgeProjectGrant,
  KnowledgeProjectRuntimeLink,
  Principal,
} from "./contracts";
import { IdentityError, IdentityService } from "./identity-service";

const NOW = "2026-09-13T12:00:00.000Z";
const OWNER_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_TOKEN = `wts_${OWNER_CREDENTIAL_ID}_${"a".repeat(64)}`;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fixture(installationAuthority?: InstallationAuthority) {
  const principals = new Map<string, Principal>([
    ["owner-1", { id: "owner-1", kind: "owner", status: "active" }],
    ["agent-1", { id: "agent-1", kind: "agent", status: "active" }],
    ["installation", { id: "installation", kind: "installation", status: "active" }],
  ]);
  const credentials = new Map<string, CredentialAuthenticationRecord>([[OWNER_CREDENTIAL_ID, {
    id: OWNER_CREDENTIAL_ID,
    principalId: "owner-1",
    kind: "owner_session",
    label: "Owner session",
    tokenPrefix: "wts_owner",
    verifierHash: hash(OWNER_TOKEN),
    status: "active",
    expiresAt: null,
    createdAt: NOW,
    revokedAt: null,
    lastUsedAt: null,
  }]]);
  const projects = new Map<string, KnowledgeProject>([
    ["project-a", { id: "project-a", name: "A", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW }],
    ["project-b", { id: "project-b", name: "B", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW }],
  ]);
  const grants = new Map<string, KnowledgeProjectGrant>();
  const links = new Map<string, KnowledgeProjectRuntimeLink>();
  const store: IdentityStore = {
    getPrincipal: (id) => principals.get(id) ?? null,
    getOwnerPrincipal: () => [...principals.values()].find(({ kind }) => kind === "owner") ?? null,
    listPrincipals: (kind) => [...principals.values()].filter((principal) => !kind || principal.kind === kind),
    savePrincipal: (principal) => { principals.set(principal.id, principal); },
    getCredentialForAuthentication: (id) => credentials.get(id) ?? null,
    saveCredential: (credential) => { credentials.set(credential.id, credential); },
    createFirstOwner: (principal, credential) => {
      if ([...principals.values()].some(({ kind }) => kind === "owner")) return false;
      principals.set(principal.id, principal);
      credentials.set(credential.id, credential);
      return true;
    },
    listPrincipalCredentials: (principalId) => [...credentials.values()]
      .filter((credential) => credential.principalId === principalId)
      .map((credential) => ({
        id: credential.id,
        principalId: credential.principalId,
        kind: credential.kind,
        label: credential.label,
        tokenPrefix: credential.tokenPrefix,
        status: credential.status,
        expiresAt: credential.expiresAt,
        createdAt: credential.createdAt,
        revokedAt: credential.revokedAt,
        lastUsedAt: credential.lastUsedAt,
      })),
    revokeCredential: (id, revokedAt) => {
      const credential = credentials.get(id);
      if (!credential || credential.status === "revoked") return false;
      credentials.set(id, { ...credential, status: "revoked", revokedAt });
      return true;
    },
    recordCredentialUsed: (id, usedAt) => {
      credentials.set(id, { ...credentials.get(id)!, lastUsedAt: usedAt });
    },
    getKnowledgeProject: (id) => projects.get(id) ?? null,
    saveKnowledgeProject: (project) => { projects.set(project.id, project); },
    getKnowledgeProjectGrant: (principalId, projectId) => grants.get(`${principalId}:${projectId}`) ?? null,
    listKnowledgeProjectGrants: (principalId) => [...grants.values()].filter((grant) => grant.principalId === principalId),
    saveKnowledgeProjectGrant: (grant) => { grants.set(`${grant.principalId}:${grant.projectId}`, grant); },
    getKnowledgeProjectRuntimeLink: (projectId) => links.get(projectId) ?? null,
    saveKnowledgeProjectRuntimeLink: (link) => { links.set(link.projectId, link); },
  };
  const service = new IdentityService(store, () => NOW, () => AGENT_CREDENTIAL_ID, () => "b".repeat(64), installationAuthority);
  return { service, principals, credentials, projects, grants };
}

function expectCode(operation: () => unknown, code: IdentityError["code"]): void {
  expect(operation).toThrowError(expect.objectContaining<Partial<IdentityError>>({ code }));
}

describe("IdentityService", () => {
  it("keeps the default owner session active until explicit rotation or revocation", () => {
    const { service, principals, credentials } = fixture();
    principals.delete("owner-1");
    credentials.delete(OWNER_CREDENTIAL_ID);

    const result = service.bootstrapOwnerSession();
    expect(result.credential.expiresAt).toBeNull();
    expect(service.authenticateBearer(result.token)).toMatchObject({
      principalId: result.principalId, authenticationMethod: "owner_session",
    });
  });

  it("bootstraps exactly one short-lived owner session", () => {
    const { service, principals, credentials } = fixture();
    principals.delete("owner-1");
    credentials.delete(OWNER_CREDENTIAL_ID);

    const result = service.bootstrapOwnerSession({ label: "First owner", sessionLifetimeSeconds: 300 });
    expect(result).toMatchObject({
      principalId: AGENT_CREDENTIAL_ID,
      credential: { kind: "owner_session", label: "First owner", expiresAt: "2026-09-13T12:05:00.000Z" },
    });
    expect(result.token).toMatch(/^wts_[0-9a-f-]{36}_[0-9a-f]{64}$/);
    expect(credentials.get(result.credential.id)?.verifierHash).toBe(hash(result.token));
    expectCode(() => service.bootstrapOwnerSession(), "owner_already_initialized");
  });

  it("recovers a new owner session after the previous credential expires", () => {
    const { service, credentials } = fixture();
    credentials.set(OWNER_CREDENTIAL_ID, { ...credentials.get(OWNER_CREDENTIAL_ID)!, expiresAt: NOW });
    expectCode(() => service.authenticateBearer(OWNER_TOKEN), "invalid_credential");

    const recovered = service.recoverOwnerSession({ label: "Recovery", sessionLifetimeSeconds: 300 });
    expect(recovered).toMatchObject({
      principalId: "owner-1",
      credential: { kind: "owner_session", label: "Recovery", expiresAt: "2026-09-13T12:05:00.000Z" },
    });
    expect(service.authenticateBearer(recovered.token)).toMatchObject({
      principalId: "owner-1", authenticationMethod: "owner_session",
    });
  });

  it("renews an authenticated owner session without offline database access", () => {
    const { service } = fixture();
    const renewed = service.renewOwnerSession(
      { label: "Rotated owner", sessionLifetimeSeconds: 300 },
      service.authenticateBearer(OWNER_TOKEN),
    );
    expect(renewed).toMatchObject({
      principalId: "owner-1",
      credential: { label: "Rotated owner", expiresAt: "2026-09-13T12:05:00.000Z" },
    });
    expect(service.authenticateBearer(renewed.token)).toMatchObject({ principalId: "owner-1" });
  });

  it("authenticates a bearer and gives malformed or unknown values one error", () => {
    const { service, credentials } = fixture();
    expect(service.authenticateBearer(OWNER_TOKEN)).toEqual({
      principalId: "owner-1",
      principalKind: "owner",
      credentialId: OWNER_CREDENTIAL_ID,
      authenticationMethod: "owner_session",
    });
    expect(credentials.get(OWNER_CREDENTIAL_ID)?.lastUsedAt).toBe(NOW);
    expectCode(() => service.authenticateBearer(`${OWNER_TOKEN}0`), "invalid_credential");
    expectCode(() => service.authenticateBearer("not-a-token"), "invalid_credential");
    credentials.set(OWNER_CREDENTIAL_ID, { ...credentials.get(OWNER_CREDENTIAL_ID)!, kind: "agent_token" });
    expectCode(() => service.authenticateBearer(OWNER_TOKEN), "invalid_credential");
  });

  it("issues a 256-bit agent token once and persists only its verifier", () => {
    const { service, credentials } = fixture();
    const owner = service.authenticateBearer(OWNER_TOKEN);
    const issued = service.issueAgentToken({ principalId: "agent-1", label: "Codex" }, owner);
    expect(issued.token).toBe(`wts_${AGENT_CREDENTIAL_ID}_${"b".repeat(64)}`);
    expect(issued.credential).not.toHaveProperty("verifierHash");
    expect(credentials.get(AGENT_CREDENTIAL_ID)).toMatchObject({
      principalId: "agent-1",
      kind: "agent_token",
      tokenPrefix: `wts_${AGENT_CREDENTIAL_ID}`,
      verifierHash: hash(issued.token),
    });
    expect(JSON.stringify(credentials.get(AGENT_CREDENTIAL_ID))).not.toContain("b".repeat(8));
  });

  it("accepts and normalizes an RFC3339 expiry without fractional seconds", () => {
    const { service } = fixture();
    const owner = service.authenticateBearer(OWNER_TOKEN);
    const issued = service.issueAgentToken({
      principalId: "agent-1", label: "Codex", expiresAt: "2027-01-01T00:00:00Z",
    }, owner);
    expect(issued.credential.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("rechecks credential and grant revocation for every knowledge operation", () => {
    const { service, credentials, grants } = fixture();
    const owner = service.authenticateBearer(OWNER_TOKEN);
    const issued = service.issueAgentToken({ principalId: "agent-1", label: "Codex" }, owner);
    grants.set("agent-1:project-a", {
      principalId: "agent-1", projectId: "project-a", permissions: ["knowledge:read"], revokedAt: null,
    });
    const agent = service.authenticateBearer(issued.token);
    expect(() => service.authorizeKnowledge(agent, "project-a", "knowledge:read")).not.toThrow();
    expectCode(() => service.authorizeKnowledge(agent, "project-b", "knowledge:read"), "knowledge_forbidden");
    expectCode(() => service.authorizeKnowledge(agent, "project-a", "knowledge:write"), "knowledge_forbidden");
    grants.set(`agent-1:project-a`, { ...grants.get(`agent-1:project-a`)!, revokedAt: NOW });
    expectCode(() => service.authorizeKnowledge(agent, "project-a", "knowledge:read"), "knowledge_forbidden");
    grants.set(`agent-1:project-a`, { ...grants.get(`agent-1:project-a`)!, revokedAt: null });
    credentials.set(AGENT_CREDENTIAL_ID, { ...credentials.get(AGENT_CREDENTIAL_ID)!, status: "revoked", revokedAt: NOW });
    expectCode(() => service.authorizeKnowledge(agent, "project-a", "knowledge:read"), "invalid_credential");
  });

  it("allows archived reads but denies writes unless the caller explicitly handles archived state", () => {
    const { service, projects, grants } = fixture();
    const owner = service.authenticateBearer(OWNER_TOKEN);
    grants.set("owner-1:project-a", {
      principalId: "owner-1", projectId: "project-a", permissions: ["knowledge:read", "knowledge:write"], revokedAt: null,
    });
    projects.set("project-a", { ...projects.get("project-a")!, status: "archived" });

    expect(() => service.authorizeKnowledge(owner, "project-a", "knowledge:read")).not.toThrow();
    expectCode(() => service.authorizeKnowledge(owner, "project-a", "knowledge:write"), "knowledge_forbidden");
    expect(() => service.authorizeKnowledge(owner, "project-a", "knowledge:write", { allowArchived: true })).not.toThrow();
  });

  it("describes only the current credential and active grants of its principal", () => {
    const { service, grants } = fixture();
    grants.set("owner-1:project-a", {
      principalId: "owner-1", projectId: "project-a", permissions: ["knowledge:read"], revokedAt: null,
    });
    grants.set("owner-1:project-b", {
      principalId: "owner-1", projectId: "project-b", permissions: ["knowledge:write"], revokedAt: NOW,
    });
    grants.set("agent-1:project-a", {
      principalId: "agent-1", projectId: "project-a", permissions: ["knowledge:write"], revokedAt: null,
    });

    expect(service.describeIdentity(service.authenticateBearer(OWNER_TOKEN))).toEqual({
      principal: { id: "owner-1", kind: "owner", status: "active" },
      credential: expect.objectContaining({ id: OWNER_CREDENTIAL_ID, kind: "owner_session" }),
      knowledgeGrants: [{ projectId: "project-a", permissions: ["knowledge:read"] }],
    });
  });

  it("does not treat a human-looking agent label as owner approval", () => {
    const { service, grants } = fixture();
    const owner = service.authenticateBearer(OWNER_TOKEN);
    const issued = service.issueAgentToken({ principalId: "agent-1", label: "human:owner" }, owner);
    grants.set("agent-1:project-a", {
      principalId: "agent-1", projectId: "project-a", permissions: ["knowledge:approve"], revokedAt: null,
    });
    const agent = service.authenticateBearer(issued.token);
    expectCode(() => service.authorizeKnowledge(agent, "project-a", "knowledge:approve"), "knowledge_forbidden");
  });

  it("lets only an owner session manage agents, credentials and knowledge grants", () => {
    const { service, grants } = fixture();
    const owner = service.authenticateBearer(OWNER_TOKEN);
    const agent = service.createAgent(owner);
    const project = service.createKnowledgeProject({ name: "Shared knowledge" }, owner);
    const grant = service.setKnowledgeGrant({
      principalId: agent.id,
      projectId: project.id,
      permissions: ["knowledge:write", "knowledge:read", "knowledge:read"],
    }, owner);
    expect(grant.permissions).toEqual(["knowledge:read", "knowledge:write"]);
    expect(service.listKnowledgeGrants(agent.id, owner)).toEqual([grant]);

    const issued = service.issueAgentToken({ principalId: agent.id, label: "Codex" }, owner);
    expect(service.listAgentCredentials(agent.id, owner)).toEqual([issued.credential]);
    const agentActor = service.authenticateBearer(issued.token);
    expectCode(() => service.createAgent(agentActor), "owner_authentication_required");
    expectCode(() => service.setKnowledgeGrant({
      principalId: agent.id, projectId: project.id, permissions: ["knowledge:approve"],
    }, owner), "invalid_request");
    expectCode(() => service.setKnowledgeGrant({
      principalId: agent.id, projectId: project.id, permissions: ["runtime:start" as never],
    }, owner), "invalid_request");
    service.revokeCredential(issued.credential.id, owner);
    expectCode(() => service.authenticateBearer(issued.token), "invalid_credential");
    expect(service.revokeKnowledgeGrant(agent.id, project.id, owner).revokedAt).toBe(NOW);
    expect(grants.get(`${agent.id}:${project.id}`)?.revokedAt).toBe(NOW);
    expect(service.revokeAgent(agent.id, owner).status).toBe("revoked");
    expect(service.listAgents(owner)).toContainEqual(expect.objectContaining({ id: agent.id, status: "revoked" }));
  });

  it("gives the current installation authority owner-level access but never an owner session", () => {
    let current = true;
    const { service, projects } = fixture({ isCurrentInstallationActor: () => current });
    const installation: AuthenticatedPrincipal = {
      principalId: "installation", principalKind: "installation", credentialId: "token-1", authenticationMethod: "installation_token",
    };
    const agent = service.createAgent(installation);
    const project = service.createKnowledgeProject({ name: "Installation project" }, installation);
    expect(service.issueAgentToken({ principalId: agent.id, label: "worker" }, installation).token).toMatch(/^wts_/);
    expect(() => service.authorizeKnowledge(installation, project.id, "knowledge:approve")).not.toThrow();
    expectCode(() => service.authorizeKnowledge(installation, "missing", "knowledge:read"), "knowledge_forbidden");
    projects.set(project.id, { ...projects.get(project.id)!, status: "archived" });
    expectCode(() => service.authorizeKnowledge(installation, project.id, "knowledge:write"), "knowledge_forbidden");
    expectCode(() => service.renewOwnerSession({}, installation), "owner_authentication_required");
    expectCode(() => service.setKnowledgeGrant({
      principalId: "installation", projectId: project.id, permissions: ["knowledge:read"],
    }, installation), "invalid_request");
    expect(service.describeIdentity(installation)).toEqual({
      principal: { id: "installation", kind: "installation", status: "active" },
      credential: null,
      knowledgeGrants: [],
      installationAuthority: true,
    });

    current = false;
    expectCode(() => service.createAgent(installation), "invalid_credential");
    expectCode(() => service.authorizeKnowledge(installation, project.id, "knowledge:read"), "invalid_credential");
  });

  it("rejects an installation actor when no installation authority is wired", () => {
    const { service } = fixture();
    expectCode(() => service.listAgents({
      principalId: "installation", principalKind: "installation", credentialId: "token-1", authenticationMethod: "installation_token",
    }), "invalid_credential");
  });
});
