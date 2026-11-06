import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityError, IdentityService, type AuthenticatedPrincipal } from "@/server/modules/identity";
import { SqliteStateStore } from "./sqlite-state-store";

// Real SQLite and the real IdentityService: every decision re-reads persisted
// credential, agent, delegation, credential ceiling and sponsor state.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runtime-access-policy-")); roots.push(root);
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  let now = Date.parse("2026-10-28T12:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const installation = { isCurrentInstallationActor: () => true };
  const identity = new IdentityService(store, clock, undefined, undefined, installation, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const add = (name: string, port: number) => store.addProject({ name, repositoryPath: `/code/${name}`, port, executable: "pnpm", args: ["run", "dev"] });
  const a = add("alpha", 3401);
  const b = add("beta", 3402);
  const agent = identity.createAgent(owner);
  const delegate = (projectId: string, actions: string[], expectedRevision = 0, expiresAt?: string, principalId = agent.id) =>
    identity.setRuntimeDelegation({ principalId, projectId, actions, expectedRevision, ...(expiresAt ? { expiresAt } : {}) }, owner);
  const issue = (projects: Array<{ projectId: string; actions: string[] }>, expiresAt?: string, principalId = agent.id) => {
    const issued = identity.issueRuntimeCredential({ principalId, label: "runtime", projects, ...(expiresAt ? { expiresAt } : {}) }, owner);
    return { issued, actor: identity.authenticateBearer(issued.token) };
  };
  const allowed = (actor: AuthenticatedPrincipal, projectId: string, action: "projects:read" | "claims:manage" | "runtime:control") => {
    try { identity.authorizeRuntime(actor, projectId, action); return true; } catch { return false; }
  };
  const installationActor: AuthenticatedPrincipal = { principalId: "installation", principalKind: "installation", credentialId: "installation", authenticationMethod: "installation_token" };
  return { root, store, identity, owner, a, b, agent, delegate, issue, allowed, installationActor, advance: (ms: number) => { now += ms; }, clock };
}

const all = ["projects:read", "claims:manage", "runtime:control"];

describe("scoped runtime authorization", () => {
  it("intersects the exact credential ceiling with the per-project delegation and denies every other subject", () => {
    const f = fixture();
    f.delegate(f.a.id, all);
    const { actor } = f.issue([{ projectId: f.a.id, actions: ["projects:read", "claims:manage"] }]);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(true);
    expect(f.allowed(actor, f.a.id, "claims:manage")).toBe(true);
    // Delegated, but outside this credential's ceiling.
    expect(f.allowed(actor, f.a.id, "runtime:control")).toBe(false);
    // Cross-project and nonexistent projects are denied with one identical safe error.
    const errors = [f.b.id, "00000000-0000-4000-8000-00000000dead"].map((projectId) => {
      try { f.identity.authorizeRuntime(actor, projectId, "projects:read"); return null; } catch (error) { return error as IdentityError; }
    });
    expect(errors.map(error => [error?.code, error?.message])).toEqual([
      ["runtime_forbidden", errors[0]!.message], ["runtime_forbidden", errors[0]!.message],
    ]);
    // A generic agent token of the same principal keeps no runtime access.
    const generic = f.identity.authenticateBearer(f.identity.issueAgentToken({ principalId: f.agent.id, label: "generic" }, f.owner).token);
    expect(f.allowed(generic, f.a.id, "projects:read")).toBe(false);
    expect(f.identity.describeIdentity(generic).runtimeAccess).toEqual([]);
    // Another agent cannot borrow the delegation, and humans/installation get nothing from this policy.
    const other = f.identity.createAgent(f.owner);
    expect(() => f.issue([{ projectId: f.a.id, actions: ["projects:read"] }], undefined, other.id)).toThrow(/no active delegation/);
    expect(f.allowed(f.owner, f.a.id, "projects:read")).toBe(false);
    expect(f.allowed(f.installationActor, f.a.id, "projects:read")).toBe(false);
    expect(f.identity.describeIdentity(actor).runtimeAccess).toEqual([{ projectId: f.a.id, actions: ["projects:read", "claims:manage"], expiresAt: null }]);
    f.store.close();
  });

  it("allows only an owner session to sponsor and refuses unsupported actions, workers and other principal kinds", () => {
    const f = fixture();
    f.delegate(f.a.id, ["projects:read"]);
    const { actor } = f.issue([{ projectId: f.a.id, actions: ["projects:read"] }]);
    for (const subject of [f.installationActor, actor]) {
      expect(() => f.identity.setRuntimeDelegation({ principalId: f.agent.id, projectId: f.b.id, actions: all, expectedRevision: 0 }, subject))
        .toThrow(expect.objectContaining({ code: "owner_authentication_required" }));
      expect(() => f.identity.issueRuntimeCredential({ principalId: f.agent.id, label: "x", projects: [{ projectId: f.a.id, actions: ["projects:read"] }] }, subject)).toThrow(IdentityError);
      expect(() => f.identity.listRuntimeAccess({ principalId: f.agent.id }, subject)).toThrow(IdentityError);
    }
    for (const unsupported of ["tests:run", "logs:read", "env:read", "env:use", "knowledge:read"]) {
      expect(() => f.delegate(f.b.id, ["projects:read", unsupported])).toThrow(/Unsupported runtime action/);
    }
    expect(() => f.identity.setRuntimeDelegation({ principalId: f.agent.id, projectId: f.b.id, actions: all, expectedRevision: 0, sponsorId: "someone" }, f.owner)).toThrow(/Invalid runtime delegation/);
    const worker = f.identity.createWorker(f.owner);
    expect(() => f.delegate(f.a.id, all, 0, undefined, worker.id)).toThrow(/active agent/);
    expect(() => f.delegate(f.a.id, all, 0, undefined, f.owner.principalId)).toThrow(/active agent/);
    expect(() => f.delegate("00000000-0000-4000-8000-00000000dead", all)).toThrow(/not found/);
    // Generic issuance remains available and unchanged.
    expect(f.identity.issueAgentToken({ principalId: f.agent.id, label: "generic" }, f.installationActor).credential.kind).toBe("agent_token");
    // The sponsor is derived from the authenticated owner, never from input.
    expect(f.store.getRuntimeDelegation(f.agent.id, f.a.id)?.sponsorId).toBe(f.owner.principalId);
    f.store.close();
  });

  it("enforces explicit delegation and credential expiry without defaults and reports the earlier one", () => {
    const f = fixture();
    const hour = 3_600_000;
    const delegationExpiry = new Date(Date.parse(f.clock()) + 2 * hour).toISOString();
    const credentialExpiry = new Date(Date.parse(f.clock()) + hour).toISOString();
    f.delegate(f.a.id, all, 0, delegationExpiry);
    f.delegate(f.b.id, all);
    expect(f.store.getRuntimeDelegation(f.agent.id, f.b.id)?.expiresAt).toBeNull();
    const unbounded = f.issue([{ projectId: f.b.id, actions: all }]);
    expect(unbounded.issued.credential.expiresAt).toBeNull();
    const { actor } = f.issue([{ projectId: f.a.id, actions: all }, { projectId: f.b.id, actions: ["projects:read"] }], credentialExpiry);
    expect(f.identity.describeIdentity(actor).runtimeAccess).toEqual([
      { projectId: f.a.id, actions: all, expiresAt: credentialExpiry },
      { projectId: f.b.id, actions: ["projects:read"], expiresAt: credentialExpiry },
    ].sort((x, y) => x.projectId.localeCompare(y.projectId)));
    expect(f.identity.runtimeAccessFor(unbounded.actor)).toEqual([{ projectId: f.b.id, actions: all, expiresAt: null }]);
    f.advance(hour);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    expect(f.allowed(unbounded.actor, f.b.id, "runtime:control")).toBe(true);
    const late = f.issue([{ projectId: f.a.id, actions: ["projects:read"] }]);
    expect(f.allowed(late.actor, f.a.id, "projects:read")).toBe(true);
    f.advance(hour);
    expect(f.allowed(late.actor, f.a.id, "projects:read")).toBe(false);
    expect(() => f.issue([{ projectId: f.a.id, actions: ["projects:read"] }])).toThrow(/no active delegation/);
    expect(() => f.delegate(f.b.id, all, 1, f.clock())).toThrow(/future/);
    f.store.close();
  });

  it("preserves an omitted delegation expiry on updates, including an already expired bound", () => {
    const f = fixture();
    const expiry = new Date(Date.parse(f.clock()) + 60_000).toISOString();
    f.delegate(f.a.id, all, 0, expiry);
    const { actor } = f.issue([{ projectId: f.a.id, actions: all }]);
    expect(f.delegate(f.a.id, ["projects:read"], 1).expiresAt).toBe(expiry);
    f.advance(60_000);
    expect(f.delegate(f.a.id, ["projects:read"], 2).expiresAt).toBe(expiry);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    const cleared = f.identity.setRuntimeDelegation({ principalId: f.agent.id, projectId: f.a.id, actions: ["projects:read"], expectedRevision: 3, expiresAt: null }, f.owner);
    expect(cleared.expiresAt).toBeNull();
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(true);
    f.store.close();
  });

  it("applies CAS revocation tombstones, credential revocation and sponsor disablement immediately", () => {
    const f = fixture();
    f.delegate(f.a.id, all);
    const { actor, issued } = f.issue([{ projectId: f.a.id, actions: all }]);
    expect(() => f.identity.revokeRuntimeDelegation({ principalId: f.agent.id, projectId: f.a.id, expectedRevision: 0 }, f.owner))
      .toThrow(expect.objectContaining({ code: "runtime_revision_conflict" }));
    expect(() => f.delegate(f.a.id, ["projects:read"], 0)).toThrow(expect.objectContaining({ code: "runtime_revision_conflict" }));
    const tombstone = f.identity.revokeRuntimeDelegation({ principalId: f.agent.id, projectId: f.a.id, expectedRevision: 1 }, f.owner);
    expect(tombstone).toMatchObject({ revision: 2, revokedAt: expect.any(String) });
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    expect(f.identity.listRuntimeAccess({ principalId: f.agent.id }, f.owner)).toMatchObject({
      delegations: [{ projectId: f.a.id, revision: 2, revokedAt: expect.any(String) }],
      credentials: [{ credential: { id: issued.credential.id }, scopes: [{ projectId: f.a.id, actions: all }], effective: [] }],
    });
    // Re-delegation is a new revision; the unchanged ceiling limits it again.
    f.delegate(f.a.id, ["projects:read"], 2);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(true);
    expect(f.allowed(actor, f.a.id, "runtime:control")).toBe(false);
    // Sponsor disablement blocks the delegation without rewriting it.
    const ownerPrincipal = f.store.getPrincipal(f.owner.principalId)!;
    f.store.savePrincipal({ ...ownerPrincipal, status: "revoked" }, "test");
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    f.store.savePrincipal(ownerPrincipal, "test");
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(true);
    f.identity.revokeAgent(f.agent.id, f.owner);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    f.store.savePrincipal({ ...f.agent, status: "active" }, "test");
    f.identity.revokeCredential(issued.credential.id, f.owner);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    expect(() => f.identity.describeIdentity(actor)).toThrow(IdentityError);
    f.store.close();
  });

  it("rotates atomically, keeps or narrows scope and expiry, and never copies credential-bound grants", () => {
    const f = fixture();
    const expiry = new Date(Date.parse(f.clock()) + 3_600_000).toISOString();
    f.delegate(f.a.id, all);
    f.delegate(f.b.id, all);
    const { issued, actor } = f.issue([{ projectId: f.a.id, actions: all }, { projectId: f.b.id, actions: ["projects:read"] }], expiry);
    expect(() => f.identity.rotateRuntimeCredential({ credentialId: issued.credential.id, projects: [{ projectId: f.b.id, actions: all }] }, f.owner)).toThrow(/narrow/);
    expect(() => f.identity.rotateRuntimeCredential({ credentialId: issued.credential.id, expiresAt: new Date(Date.parse(expiry) + 1000).toISOString() }, f.owner)).toThrow(/extend/);
    expect(() => f.identity.rotateRuntimeCredential({ credentialId: issued.credential.id }, actor)).toThrow(expect.objectContaining({ code: "owner_authentication_required" }));
    expect(f.allowed(actor, f.a.id, "runtime:control")).toBe(true);
    const rotated = f.identity.rotateRuntimeCredential({ credentialId: issued.credential.id, projects: [{ projectId: f.a.id, actions: ["projects:read", "claims:manage"] }] }, f.owner);
    expect(rotated).toMatchObject({ replacedCredentialId: issued.credential.id, credential: { expiresAt: expiry, label: "runtime" } });
    expect(() => f.identity.authenticateBearer(issued.token)).toThrow(IdentityError);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    const next = f.identity.authenticateBearer(rotated.token);
    expect(f.identity.runtimeAccessFor(next)).toEqual([{ projectId: f.a.id, actions: ["projects:read", "claims:manage"], expiresAt: expiry }]);
    expect(f.allowed(next, f.b.id, "projects:read")).toBe(false);
    // Only the new credential's own ceiling rows exist. Vault grants bind the exact
    // (old) credential ID inside encrypted vault state and are therefore not carried over.
    expect(rotated.credential.id).not.toBe(issued.credential.id);
    expect(f.store.listRuntimeCredentialScopes(rotated.credential.id)).toHaveLength(1);
    // The replaced credential cannot be rotated twice.
    expect(() => f.identity.rotateRuntimeCredential({ credentialId: issued.credential.id }, f.owner)).toThrow(/active scoped runtime credential/);
    f.store.close();
  });

  it("deletes delegations and ceilings with the registered project and never resurrects them", () => {
    const f = fixture();
    f.delegate(f.a.id, all);
    const { actor, issued } = f.issue([{ projectId: f.a.id, actions: all }]);
    f.store.removeProject(f.a.id, "test");
    expect(f.store.getRuntimeDelegation(f.agent.id, f.a.id)).toBeNull();
    expect(f.store.listRuntimeCredentialScopes(issued.credential.id)).toEqual([]);
    expect(f.allowed(actor, f.a.id, "projects:read")).toBe(false);
    const again = f.store.addProject({ name: "alpha", repositoryPath: "/code/alpha", port: 3401, executable: "pnpm", args: ["run", "dev"] });
    expect(again.id).not.toBe(f.a.id);
    expect(f.allowed(actor, again.id, "projects:read")).toBe(false);
    expect(f.identity.runtimeAccessFor(actor)).toEqual([]);
    f.store.close();
  });
});
