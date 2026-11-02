import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { ProviderKnowledgeApplication, resolveControllerAuthentication } from "@/server/modules/authentication";
import { KnowledgeService } from "@/server/modules/knowledge";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { ProcessManager } from "@/server/process-manager";
import { DevVaultService, Ed25519DevVaultOwnerVerifier } from "@/server/modules/dev-vault";
import type { ProviderSqliteConnection } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { Client, loadProof, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { cleanupStrictRoots, closeStrictProof, gate, strictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
let ip = 100;
async function fixture(faults: ProofFaultInjection = {}, options = {}, clock?: () => string) {
  const f = await strictProof(faults, options);
  const { subject } = await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL,
    name: "Owner", password: OWNER_PASSWORD, actor: "test" });
  const client = new Client(f.runtime, `198.51.100.${ip++}`);
  expect((await client.signIn()).status).toBe(200);
  const evidence = (await client.resolve())!;
  const actor = (await f.runtime.authenticate(new Headers({ cookie: client.cookieHeader() })))!;
  expect(actor).not.toBeNull();
  const identity = new IdentityService(f.store, clock, undefined, undefined, undefined, f.store, f.runtime);
  const project = await f.run(() => f.identity.createKnowledgeProject({ name: "Granted" }, f.ownerActor));
  const changed = vi.fn();
  const knowledge = new KnowledgeService(f.store, identity, undefined, undefined, changed);
  const app = new ProviderKnowledgeApplication(f.store.admission, identity, knowledge);
  const grant = () => f.run(() => f.identity.setKnowledgeGrant({ principalId: actor.principalId, projectId: project.id,
    permissions: ["knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export"] }, f.ownerActor));
  return { ...f, subject, client, sessionId: evidence.session.sessionId, actor, identity, project, changed, knowledge, app, grant };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const write = (f: Fixture, key = "provider-write") => ({ operation: "create_task", input: {
  projectId: f.project.id, title: "Provider task", description: "One effect", idempotencyKey: key,
} });
const read = (f: Fixture) => ({ operation: "tasks", input: { projectId: f.project.id } });
const denied = (pending: Promise<unknown>, code = "invalid_credential") => expect(pending).rejects.toMatchObject({ code });

/** A deterministic FIFO fence on the sole connection. The mutation uses the guarded provider facade. */
async function fence(f: Fixture, mutation?: (connection: ProviderSqliteConnection) => void, rollback = false) {
  const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
  const entered = gate(), release = gate();
  const pending = storage.borrow(async () => {
    connection.prepare("BEGIN IMMEDIATE").run([]);
    mutation?.(connection);
    entered.open(); await release.opened;
    connection.prepare(rollback ? "ROLLBACK" : "COMMIT").run([]);
  }).finally(() => connection.close());
  await entered.opened;
  return { release: release.open, pending };
}

describe("runtime-issued provider-session Knowledge application", () => {
  it("caps an actor at its original expiry even if the stored session extends; a fresh sign-in gets fresh evidence", async () => {
    let now = new Date().toISOString();
    const f = await fixture({}, {}, () => now);
    try {
      await f.grant();
      const evidence = (await f.client.resolve())!;
      now = new Date(Date.parse(evidence.session.expiresAt) + 1).toISOString();
      const hold = await fence(f, connection => connection.prepare('UPDATE authentication_ba_session SET expiresAt=? WHERE id=?')
        .run([new Date(Date.parse(now) + 60_000).toISOString(), f.sessionId]));
      hold.release(); await hold.pending;
      await denied(f.app.execute(write(f), f.actor));
      // The stored extension changes nothing: the original deadline is immutable evidence.
      const extended = (await f.runtime.authenticate(new Headers({ cookie: f.client.cookieHeader() })))!;
      await denied(f.app.execute(write(f), extended));
      const signedIn = new Client(f.runtime, "198.51.100.250");
      expect((await signedIn.signIn()).status).toBe(200);
      const fresh = (await f.runtime.authenticate(new Headers({ cookie: signedIn.cookieHeader() })))!;
      expect(fresh).not.toBeNull();
      expect(await f.app.execute(write(f), fresh)).toMatchObject({ replayed: false });
      expect(f.changed).toHaveBeenCalledOnce();
    } finally { await closeStrictProof(f); }
  });

  it("fails closed without the issuing authority and when the sole owner begins drain", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    let holding: Promise<unknown> | undefined, closing: Promise<void> | undefined;
    try {
      await f.grant();
      const missing = new IdentityService(f.store);
      const app = new ProviderKnowledgeApplication(f.store.admission, missing, new KnowledgeService(f.store, missing));
      await denied(app.execute(write(f), f.actor));
      holding = f.run(async () => { entered.open(); await release.opened; });
      await entered.opened;
      closing = f.store.closeAfterDrain();
      await denied(f.app.execute(write(f), f.actor));
      expect(f.changed).not.toHaveBeenCalled();
    } finally { release.open(); await holding; await closing; await closeStrictProof(f); }
  });

  it("requires explicit grants, writes once, replays once, and exposes only safe identity/audit metadata", async () => {
    const f = await fixture();
    try {
      await denied(f.app.execute(write(f), f.actor), "knowledge_forbidden");
      await f.grant();
      await denied(f.app.execute({ operation: "approve_memory", input: { projectId: f.project.id,
        memoryId: "unavailable", expectedRevision: 1, idempotencyKey: "approval" } }, f.actor), "knowledge_forbidden");
      const result = await f.app.execute(write(f), f.actor);
      expect(result).toMatchObject({ replayed: false, value: { createdBy: f.owner.principalId } });
      expect(await f.app.execute(write(f), f.actor)).toMatchObject({ replayed: true });
      expect(f.changed).toHaveBeenCalledTimes(1);
      const metadata = await f.app.describeIdentity(f.actor);
      expect(metadata).toMatchObject({ principal: { id: f.owner.principalId, kind: "owner" }, credential: null });
      expect(metadata.knowledgeGrants[0]?.permissions).not.toContain("knowledge:approve");
      const history = await f.app.execute({ operation: "history", input: { projectId: f.project.id,
        recordKind: "task", recordId: (result as { value: { id: string } }).value.id } }, f.actor);
      expect(history).toMatchObject({ items: [expect.objectContaining({ principalId: f.owner.principalId, authenticationMethod: "provider_session" })] });
      const publicData = JSON.stringify({ metadata, history, actor: f.actor, logs: f.evidence.logs });
      for (const secret of [OWNER_EMAIL, OWNER_PASSWORD, f.client.cookieHeader(), f.sessionId, f.subject]) expect(publicData).not.toContain(secret);
      expect(Object.isFrozen(f.actor)).toBe(true);
      expect(f.actor.credentialId).toBeNull();
    } finally { await closeStrictProof(f); }
  });

  it("keeps project and role ceilings and privileged approval separate from the mapped owner", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const other = await f.run(() => f.identity.createKnowledgeProject({ name: "Other" }, f.ownerActor));
      await denied(f.app.execute({ operation: "tasks", input: { projectId: other.id } }, f.actor), "knowledge_forbidden");
      await f.run(() => f.identity.setKnowledgeRole({ principalId: f.actor.principalId, projectId: f.project.id,
        role: "reader", expectedRevision: 0 }, f.ownerActor));
      expect(await f.app.execute(read(f), f.actor)).toMatchObject({ items: [] });
      await denied(f.app.execute(write(f), f.actor), "knowledge_forbidden");
      await f.run(() => {
        expect(() => f.identity.authorizeKnowledge(f.actor, f.project.id, "knowledge:approve")).toThrow(expect.objectContaining({ code: "knowledge_forbidden" }));
        for (const operation of [
          () => f.identity.createAgent(f.actor),
          () => f.identity.issueAgentToken({ principalId: "missing", label: "forbidden" }, f.actor),
          () => f.identity.renewOwnerSession({}, f.actor),
          () => f.identity.setRuntimeDelegation({}, f.actor),
          () => f.identity.issueRuntimeCredential({}, f.actor),
        ]) expect(operation).toThrow(expect.objectContaining({ code: "owner_authentication_required" }));
        expect(() => f.identity.authorizeRuntime(f.actor, "any", "runtime:control")).toThrow(expect.objectContaining({ code: "runtime_forbidden" }));
      });
      expect(f.changed).not.toHaveBeenCalled();
      const verifier = new Ed25519DevVaultOwnerVerifier(() => { throw new Error("A provider actor must never reach the external key."); });
      const command = { operation: "list" as const, projectId: randomUUID(), environment: "DEV" as const, operationId: randomUUID() };
      expect(verifier.verify(command, f.actor, { issuedAt: new Date().toISOString(), signature: "invalid" }, new Date().toISOString())).toBe("invalid");
      const vault = new DevVaultService(f.store.devVault, { key: () => Buffer.alloc(32) }, f.identity, { verify: () => "valid" });
      await expect(f.run(() => vault.execute({ command }, f.actor))).rejects.toMatchObject({ code: "vault_denied" });
      // Account mode and compatibility transports gain no session-cookie path.
      expect(resolveControllerAuthentication({ authentication: { mode: () => "better-auth",
        authenticateInstallation: () => null, anonymousInstallation: () => null }, identity: f.identity },
      { bearer: f.owner.token, legacySecretValid: () => true })).toBeNull();
    } finally { await closeStrictProof(f); }
  });

  it("rejects raw evidence, cloned references, substituted actor fields and actors issued by another runtime", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const raw = await f.client.resolve();
      for (const forged of [raw, { ...f.actor }, structuredClone(f.actor), { ...f.actor, principalId: "installation" },
        { ...f.actor, authenticationMethod: "owner_session" }, { ...f.actor, principalKind: "installation", authenticationMethod: "none" }]) {
        await denied(f.app.execute(write(f), forged as ProviderSessionActor));
      }
      expect(() => Object.assign(f.actor, { principalId: "installation" })).toThrow();
      const other = await loadProof(f.store);
      try {
        const foreign = (await other.runtime.authenticate(new Headers({ cookie: f.client.cookieHeader() })))!;
        await denied(f.app.execute(write(f), foreign));
        const foreignIdentity = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store, other.runtime);
        const foreignApp = new ProviderKnowledgeApplication(f.store.admission, foreignIdentity, new KnowledgeService(f.store, foreignIdentity));
        await denied(foreignApp.execute(write(f), f.actor));
      } finally { await other.runtime.dispose(); }
      expect(f.changed).not.toHaveBeenCalled();
    } finally { await closeStrictProof(f); }
  });

  it("refuses an unverified validity adapter and never accepts old actors after runtime replacement", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const incompatible = await loadProof(f.store, undefined, fileURLToPath(new URL("./loader-fixtures/synchronous-handle.mjs", import.meta.url)));
      try { await expect(incompatible.runtime.authenticate(new Headers())).rejects.toMatchObject({ code: "provider_unavailable" }); }
      finally { await incompatible.runtime.dispose(); }
      await f.runtime.dispose();
      const replacement = await loadProof(f.store);
      try {
        const currentIdentity = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store, replacement.runtime);
        const app = new ProviderKnowledgeApplication(f.store.admission, currentIdentity, new KnowledgeService(f.store, currentIdentity));
        const current = (await replacement.runtime.authenticate(new Headers({ cookie: f.client.cookieHeader() })))!;
        expect(await app.execute(read(f), current)).toMatchObject({ items: [] });
        await denied(app.execute(write(f), f.actor));
        await denied(f.app.execute(write(f), f.actor));
      } finally { await replacement.runtime.dispose(); }
    } finally { await closeStrictProof(f); }
  });

  it.each(["session", "all", "recovery", "reset", "signout"])("denies a retained actor after actual pinned-provider %s revocation commits, even with failed notification", async kind => {
    const f = await fixture();
    try {
      await f.grant();
      await f.app.execute(write(f), f.actor);
      f.evidence.failInvalidation = true;
      const hold = await fence(f);
      let revocation: Promise<unknown>;
      if (kind === "session") revocation = f.runtime.revokeSession(f.sessionId);
      else if (kind === "all") revocation = f.runtime.revokePrincipalSessions(f.owner.principalId);
      else if (kind === "recovery") revocation = f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: "fixture-recovered-password-2", actor: "local-test" });
      else if (kind === "signout") revocation = f.client.call("/sign-out");
      else {
        // Reset delivery and its request are library operations, queued before the application.
        revocation = (async () => {
          await f.client.call("/request-password-reset", { body: { email: OWNER_EMAIL } });
          return f.client.call("/reset-password", { body: { token: f.evidence.resets[0]!.token, newPassword: "fixture-reset-password-2" } });
        })();
      }
      const revoked = revocation.catch(error => error);
      // For reset, finish the request/reset pair before queuing the application; other paths prove FIFO admission.
      if (kind === "reset") { hold.release(); await hold.pending; await revoked; }
      const pending = f.app.execute(write(f), f.actor);
      const rejection = denied(pending);
      if (kind !== "reset") {
        expect(f.store.admissionSnapshot()).toMatchObject({ queuedProviders: 1, queuedCore: 1 });
        hold.release(); await hold.pending; await revoked;
      }
      await rejection;
      await denied(f.app.execute(write(f, "fresh-after-session-revocation"), f.actor));
      expect(f.changed).toHaveBeenCalledTimes(1);
      await denied(f.app.describeIdentity(f.actor));
    } finally { await closeStrictProof(f); }
  });

  it.each(["mapping", "principal", "grant", "role", "subject", "principal-substitution"])("rechecks committed %s authority before an admitted effect or receipt", async kind => {
    const f = await fixture();
    try {
      await f.grant();
      await f.app.execute(write(f), f.actor);
      await f.run(() => f.identity.setKnowledgeRole({ principalId: f.actor.principalId, projectId: f.project.id,
        role: "operator", expectedRevision: 0 }, f.ownerActor));
      const hold = await fence(f, connection => {
        if (kind === "mapping") connection.prepare("UPDATE authentication_provider_subjects SET status='revoked',revoked_at=? WHERE subject=?").run([new Date().toISOString(), f.subject]);
        if (kind === "principal") connection.prepare("UPDATE remote_principals SET status='revoked' WHERE id=?").run([f.actor.principalId]);
        if (kind === "grant") connection.prepare("UPDATE knowledge_project_grants SET revoked_at=? WHERE principal_id=?").run([new Date().toISOString(), f.actor.principalId]);
        if (kind === "role") connection.prepare("UPDATE knowledge_role_bindings SET revoked_at=? WHERE principal_id=?").run([new Date().toISOString(), f.actor.principalId]);
        if (kind === "subject") {
          connection.prepare('INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)').run(["swapped", "Other", "other@fixture.invalid", new Date().toISOString(), new Date().toISOString()]);
          // Even a new active subject mapped to the SAME granted principal cannot
          // replace the originally verified session subject.
          connection.prepare("UPDATE authentication_provider_subjects SET status='revoked',revoked_at=? WHERE subject=?").run([new Date().toISOString(), f.subject]);
          connection.prepare("INSERT INTO authentication_provider_subjects VALUES('better-auth','swapped',?,'active',?,NULL)").run([f.actor.principalId, new Date().toISOString()]);
          connection.prepare('UPDATE authentication_ba_session SET userId=? WHERE id=?').run(["swapped", f.sessionId]);
        }
        if (kind === "principal-substitution") {
          connection.prepare("INSERT INTO remote_principals VALUES('other-owner','owner','active')").run([]);
          connection.prepare("UPDATE authentication_provider_subjects SET principal_id='other-owner' WHERE subject=?").run([f.subject]);
        }
      });
      const pending = f.app.execute(write(f), f.actor);
      const rejection = denied(pending, kind === "grant" || kind === "role" ? "knowledge_forbidden" : "invalid_credential");
      expect(f.store.admissionSnapshot()).toMatchObject({ queuedCore: 1 });
      hold.release(); await hold.pending; await rejection;
      await denied(f.app.execute(write(f, "fresh-after-policy-revocation"), f.actor), kind === "grant" || kind === "role" ? "knowledge_forbidden" : "invalid_credential");
      expect(f.changed).toHaveBeenCalledTimes(1);
    } finally { await closeStrictProof(f); }
  });

  it("does not invent a committed revocation when actual recovery rolls back", async () => {
    const faults: ProofFaultInjection = {}, f = await fixture(faults), entered = gate(), release = gate();
    try {
      await f.grant();
      faults.beforeRecoveryCommit = async () => { entered.open(); await release.opened; throw new Error("rollback"); };
      const recovery = f.runtime.recoverLocal({ principalId: f.actor.principalId, newPassword: "fixture-rollback-password-2", actor: "test" }).catch(error => error);
      await entered.opened;
      const pending = f.app.execute(write(f), f.actor);
      expect(f.store.admissionSnapshot()).toMatchObject({ queuedCore: 1 });
      release.open(); expect(await recovery).toMatchObject({ code: "provider_failed" });
      expect(await pending).toMatchObject({ replayed: false });
      expect(f.evidence.events).toEqual([]);
      expect(f.changed).toHaveBeenCalledTimes(1);
    } finally { release.open(); await closeStrictProof(f); }
  });

  it.each(["malformed", "numeric", "expired", "created-substitution"])("rejects %s stored timestamps instead of permissive date parsing", async kind => {
    const f = await fixture();
    try {
      await f.grant();
      const hold = await fence(f, connection => {
        if (kind === "created-substitution") connection.prepare('UPDATE authentication_ba_session SET createdAt=? WHERE id=?').run(["2026-01-01T00:00:00.000Z", f.sessionId]);
        else connection.prepare('UPDATE authentication_ba_session SET expiresAt=? WHERE id=?')
          .run([kind === "malformed" ? "2026-99-99T00:00:00.000Z" : kind === "numeric" ? Date.now() + 100_000 : "2026-01-01T00:00:00.000Z", f.sessionId]);
      });
      const rejection = denied(f.app.execute(write(f), f.actor));
      hold.release(); await hold.pending; await rejection;
      expect(f.changed).not.toHaveBeenCalled();
    } finally { await closeStrictProof(f); }
  });

  it("denies expiry and disposal during admission waits", async () => {
    let now = new Date().toISOString();
    const f = await fixture({}, {}, () => now);
    try {
      await f.grant();
      const hold = await fence(f);
      const rejection = denied(f.app.execute(write(f), f.actor));
      now = new Date(Date.now() + 9 * 60 * 60_000).toISOString();
      hold.release(); await hold.pending; await rejection;
      now = new Date().toISOString();
      const next = await fence(f);
      const disposed = denied(f.app.execute(write(f), f.actor));
      const disposing = f.runtime.dispose();
      next.release(); await next.pending; await disposing; await disposed;
      expect(f.changed).not.toHaveBeenCalled();
    } finally { await closeStrictProof(f); }
  });

  it("rejects previously issued authority after a provider borrow times out and after replacement", async () => {
    const faults: ProofFaultInjection = {}, f = await fixture(faults, { borrowTimeoutMs: 1000 });
    const release = gate(), entered = gate();
    try {
      await f.grant();
      faults.beforeRecoveryCommit = async () => { entered.open(); await release.opened; };
      const recovery = f.runtime.recoverLocal({ principalId: f.actor.principalId, newPassword: "fixture-timeout-password-2", actor: "test" }).catch(error => error);
      await entered.opened;
      const rejection = denied(f.app.execute(write(f), f.actor));
      expect(await recovery).toMatchObject({ code: "expired" });
      await rejection;
      release.open();
      expect(f.changed).not.toHaveBeenCalled();
    } finally { release.open(); await closeStrictProof(f); }
  });

  it("revalidates after idle and an actual project-lock wait before the next write or retained result", async () => {
    const f = await fixture();
    const lifecycle = new ProjectLifecycle(f.store, new ProcessManager());
    const entered = gate(), release = gate();
    try {
      await f.grant();
      await f.app.execute(write(f), f.actor);
      const first = lifecycle.serialized("test-lock", async () => {
        entered.open(); await f.store.admission.idle(() => release.opened);
      });
      await entered.opened;
      const pending = lifecycle.serialized("test-lock", () => f.app.execute(write(f), f.actor));
      const rejection = denied(pending);
      expect(f.store.admissionSnapshot().coreActive).toBe(0);
      await f.runtime.revokeSession(f.sessionId);
      release.open(); await first; await rejection;
      expect(f.changed).toHaveBeenCalledTimes(1);
      // A fresh actor is valid until the idle phase commits another revocation.
      expect((await f.client.signIn()).status).toBe(200);
      const actor = (await f.runtime.authenticate(new Headers({ cookie: f.client.cookieHeader() })))!;
      await denied(f.run(async () => {
        await f.app.execute(read(f), actor);
        await f.store.admission.idle(() => f.runtime.revokePrincipalSessions(actor.principalId));
        return f.app.execute(write(f), actor);
      }));
      expect(f.changed).toHaveBeenCalledTimes(1);
    } finally { release.open(); await lifecycle.closeAndDrain(); await closeStrictProof(f); }
  });
});
