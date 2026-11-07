import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { AuthenticationProviderError, AuthenticationService, loadAuthenticationProvider, resolveControllerAuthentication } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { BASE_URL, cleanupRoots, Client, count, IP_HEADER, loadProof, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, proofFixture, PROVIDER_ENTRY, readCommitted, SECRET, SESSION_POLICY, storeFixture } from "./fixture";

afterEach(() => { vi.useRealTimers(); cleanupRoots(); });

const NEW_PASSWORD = "fixture-replacement-password-2";
const fixtureModule = (name: string) => fileURLToPath(new URL(`./loader-fixtures/${name}`, import.meta.url));
const errorCode = async (operation: () => Promise<unknown>) => {
  try { await operation(); } catch (error) { return (error as { code?: string }).code ?? String(error); }
  return undefined;
};
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}
async function provisioned(faultInjection?: ProofFaultInjection) {
  const f = await proofFixture(faultInjection);
  const { subject } = await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "local-bootstrap" });
  return { ...f, subject };
}
const packageVersion = (directory: string, name: string) => JSON.parse(readFileSync(join(realpathSync(join(directory, "node_modules", name)), "package.json"), "utf8")).version;

describe("Better Auth 1.7.14 proof on the controller-owned SQLite connection", () => {
  it("loads the exact pinned library from an explicit path, awaits schema-verified readiness and leaves account mode unavailable", async () => {
    const f = await proofFixture();
    try {
      const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
      expect({
        betterAuth: packageVersion(packageDirectory, "better-auth"),
        core: packageVersion(packageDirectory, "@better-auth/core"),
        kysely: packageVersion(packageDirectory, "kysely"),
        driver: packageVersion(join(packageDirectory, "../.."), "better-sqlite3"),
      }).toEqual({ betterAuth: "1.7.14", core: "1.7.14", kysely: "0.28.17", driver: "13.0.3" });
      expect(f.runtime.readiness).toEqual({ providerId: "better-auth", implementationVersion: "0.0.0-proof.5", library: { name: "better-auth", version: "1.7.14" }, schema: "verified" });
      const authentication = new AuthenticationService(f.store);
      expect(() => authentication.setMode("better-auth", "test")).toThrow(expect.objectContaining({ code: "auth_provider_unavailable" }));
      expect(resolveControllerAuthentication(
        { authentication: { mode: () => "better-auth", authenticateInstallation: () => null, anonymousInstallation: () => null }, identity: f.identity },
        { bearer: f.owner.token, legacySecretValid: () => true },
      )).toBeNull();
      expect(count(f.path, "authentication_provider_subjects")).toBe(0);
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("fails closed for missing, remote, relative and incompatible modules without touching core storage", async () => {
    const f = storeFixture();
    try {
      for (const entry of [join(f.root, "missing.mjs"), "https://example.invalid/provider.mjs", "relative/provider.mjs", fixtureModule("no-export.mjs"), fixtureModule("wrong-contract.mjs"), fixtureModule("wrong-storage.mjs")]) {
        expect(await errorCode(() => loadProof(f.store, undefined, entry))).toBe("provider_unavailable");
      }
      const thrown = await loadProof(f.store, undefined, fixtureModule("create-throws.mjs")).then(() => new Error("loaded"), (error: unknown) => error as Error);
      expect(thrown).toBeInstanceOf(AuthenticationProviderError);
      expect(thrown.message).not.toContain("fixture-secret");
      const probe = () => (globalThis as unknown as { __loaderProbe: { host: { connection: { prepare(sql: string): unknown } }; disposed?: number; statements?: Array<{ all(parameters: unknown[]): unknown }> } }).__loaderProbe;
      expect(() => probe().host.connection.prepare("SELECT 1")).toThrow(/closed/);
      expect(await errorCode(() => loadProof(f.store, undefined, fixtureModule("incomplete-instance.mjs")))).toBe("provider_unavailable");
      expect(probe().disposed).toBe(1);
      // The real library rejects storage that lacks a column its configuration expects.
      expect(await errorCode(() => loadProof(f.store, { expectUnmigratedColumn: true }))).toBe("provider_unavailable");
      f.store.addProject({ name: "core-after-failures", repositoryPath: join(f.root, "p"), port: 3701, executable: "node", args: [] });
      expect(f.store.listProjects()).toHaveLength(1);
    } finally { f.store.close(); }
  });

  it("refuses the previous host protocol before creating a contract-3 provider", async () => {
    const f = storeFixture();
    const probe = globalThis as unknown as { __legacyProviderCreated?: boolean };
    delete probe.__legacyProviderCreated;
    try {
      expect(await errorCode(() => loadProof(f.store, undefined, fixtureModule("legacy-contract-3.mjs")))).toBe("provider_unavailable");
      expect(probe.__legacyProviderCreated).toBeUndefined();
      // A refused module did not consume or poison the owner's provider facade.
      const { runtime: current } = await loadProof(f.store);
      expect(current.implementationVersion).toBe("0.0.0-proof.5");
      await current.dispose();
    } finally { delete probe.__legacyProviderCreated; f.store.close(); }
  });

  it.each(["legacy-contract-4.mjs", "legacy-contract-4-storage-3.mjs", "wrong-storage.mjs"])("refuses the mixed identity %s before creating it", async name => {
    const f = storeFixture();
    const probe = globalThis as unknown as { __legacyProviderCreated?: boolean };
    delete probe.__legacyProviderCreated;
    try {
      expect(await errorCode(() => loadProof(f.store, undefined, fixtureModule(name)))).toBe("provider_unavailable");
      expect(probe.__legacyProviderCreated).toBeUndefined();
    } finally { delete probe.__legacyProviderCreated; f.store.close(); }
  });

  it("is refused by the previous host's frozen rule, while that rule still accepted its own provider", async () => {
    const frozen = (name: string) => import(/* @vite-ignore */ pathToFileURL(fixtureModule(name)).href);
    const { previousHostAccepts } = await frozen("frozen-host-contract-4.mjs") as { previousHostAccepts(provider: unknown): boolean };
    const { authenticationProvider: legacy } = await frozen("legacy-contract-4.mjs") as { authenticationProvider: unknown };
    const { authenticationProvider: current } = await import("../src/index");
    expect(previousHostAccepts(legacy)).toBe(true);
    expect(previousHostAccepts(current)).toBe(false);
    expect(current).toMatchObject({ contractVersion: 5, storageRevision: 3, implementationVersion: "0.0.0-proof.5" });
  });

  it("disposes a provider whose initialization fails inside its borrow, rolls back what it began and stops further provider admission", async () => {
    const f = storeFixture();
    try {
      expect(await errorCode(() => loadProof(f.store, undefined, fixtureModule("initialize-throws.mjs")))).toBe("provider_unavailable");
      const probe = (globalThis as unknown as { __loaderProbe: { disposed: number; statements: Array<{ all(parameters: unknown[]): unknown }> } }).__loaderProbe;
      expect(probe.disposed).toBe(1);
      expect(() => probe.statements[0]!.all([])).toThrow(/closed|finished/);
      expect(await errorCode(() => loadProof(f.store))).toBe("provider_unavailable");
      expect(await errorCode(() => f.store.authenticationProviderStorage().borrow(async () => undefined))).toBe("provider_closed");
      f.store.addProject({ name: "core-still-usable", repositoryPath: join(f.root, "p"), port: 3702, executable: "node", args: [] });
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
    } finally { f.store.close(); }
  });

  it.each(["dispose-throws.mjs", "partial-dispose-throws.mjs"])("closes the facade and reports unconfirmed synchronous loader disposal failures: %s", async name => {
    const f = storeFixture();
    try {
      const error = await loadProof(f.store, undefined, fixtureModule(name)).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "disposal_unconfirmed" });
      expect(String(error)).not.toContain("fixture-secret");
      const probe = (globalThis as unknown as { __loaderProbe: { disposed: number; host: { connection: { prepare(sql: string): unknown } } } }).__loaderProbe;
      expect(probe.disposed).toBe(1);
      expect(() => probe.host.connection.prepare("SELECT 1")).toThrow(/closed/);
      expect(f.store.listProjects()).toEqual([]);
      const loaded = await loadProof(f.store);
      await loaded.runtime.dispose();
    } finally { f.store.close(); }
  });

  it.each(["admin", "change-password", "reset-password", "recovery", "revoke-sessions"] as const)("invalidates every session beyond the library's 100-row hook snapshot: %s", async operation => {
    const f = await provisioned();
    try {
      const client = new Client(f.runtime, `203.0.113.${110 + ["admin", "change-password", "reset-password", "recovery", "revoke-sessions"].indexOf(operation)}`);
      expect((await client.signIn()).status).toBe(200);
      // Use the same owner connection to seed volume without 100 password hashes.
      // Revocation itself runs through the real library and actual HTTP handlers.
      const storage = f.store.authenticationProviderStorage();
      const connection = storage.createProviderConnection();
      await storage.borrow(async () => {
        const insert = connection.prepare('INSERT INTO authentication_ba_session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)');
        for (let index = 0; index < 100; index++) insert.run([`extra-${index}`, `fixture-session-${index}`, f.subject, Date.now() + 60_000, Date.now(), Date.now()]);
      });
      expect(count(f.path, "authentication_ba_session")).toBe(101);
      const originalIds = readCommitted(f.path, db => db.prepare("SELECT id FROM authentication_ba_session").all() as Array<{ id: string }>);
      if (operation === "admin") await f.runtime.revokePrincipalSessions(f.owner.principalId);
      else if (operation === "recovery") await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "fixture" });
      else if (operation === "reset-password") {
        expect((await client.call("/request-password-reset", { body: { email: OWNER_EMAIL } })).status).toBe(200);
        expect((await client.call("/reset-password", { body: { token: f.evidence.resets[0]!.token, newPassword: NEW_PASSWORD } })).status).toBe(200);
      } else if (operation === "change-password") {
        expect((await client.call("/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true } })).status).toBe(200);
      } else expect((await client.call("/revoke-sessions", { body: {} })).status).toBe(200);
      const remaining = readCommitted(f.path, db => db.prepare("SELECT id FROM authentication_ba_session").all() as Array<{ id: string }>);
      expect(remaining).toHaveLength(operation === "change-password" ? 1 : 0);
      for (const { id } of originalIds) {
        expect(remaining.some(row => row.id === id)).toBe(false);
        expect(f.evidence.events.some(event => event.subject === f.subject && (event.kind === "subject" || event.sessionId === id))).toBe(true);
      }
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it.each([false, true])("cleans up a loaded provider's synchronous failure (open transaction: %s)", async openTransaction => {
    const f = storeFixture();
    const { runtime } = await loadProof(f.store, undefined, fixtureModule("synchronous-handle.mjs"));
    try {
      const error = await runtime.handle(new Request(`${ORIGIN}/${openTransaction ? "transaction" : "plain"}`)).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: openTransaction ? "provider_closed" : "provider_failed" });
      expect(String(error)).not.toContain("fixture-secret");
      expect(count(f.path, "authentication_ba_verification")).toBe(0);
      expect(f.store.listProjects()).toEqual([]);
      if (openTransaction) expect(await errorCode(() => runtime.resolve(new Headers()))).toBe("provider_closed");
      else expect(await runtime.resolve(new Headers())).toBeNull();
    } finally { await runtime.dispose(); f.store.close(); }
  });

  it("provisions through library hashing and account operations with an atomic subject mapping and ID-only audit", async () => {
    const f = await provisioned();
    try {
      const rows = readCommitted(f.path, db => ({
        users: db.prepare('SELECT "id","email" FROM "authentication_ba_user"').all(),
        accounts: db.prepare('SELECT "userId","providerId","accountId","password" FROM "authentication_ba_account"').all() as Array<{ password: string }>,
        mappings: db.prepare("SELECT provider_id, subject, principal_id, status FROM authentication_provider_subjects").all(),
        audit: db.prepare("SELECT actor, details_json FROM controller_audit_events WHERE event_type = 'authentication.provider.account_provisioned'").all(),
      }));
      expect(rows.users).toEqual([{ id: f.subject, email: OWNER_EMAIL }]);
      expect(rows.accounts).toEqual([{ userId: f.subject, providerId: "credential", accountId: f.subject, password: expect.any(String) }]);
      expect(rows.accounts[0]!.password).not.toContain(OWNER_PASSWORD);
      expect(rows.mappings).toEqual([{ provider_id: "better-auth", subject: f.subject, principal_id: f.owner.principalId, status: "active" }]);
      expect(rows.audit).toEqual([{ actor: "local-bootstrap", details_json: JSON.stringify({ providerId: "better-auth", subject: f.subject, principalId: f.owner.principalId }) }]);
      const client = new Client(f.runtime);
      const signUp = await client.call("/sign-up/email", { body: { email: "new@fixture.invalid", password: NEW_PASSWORD, name: "New" } });
      expect(signUp.status).toBeGreaterThanOrEqual(400);
      expect(count(f.path, "authentication_ba_user")).toBe(1);
      expect(await errorCode(() => f.runtime.provisionLocal({ principalId: f.owner.principalId, email: "again@fixture.invalid", name: "Again", password: NEW_PASSWORD, actor: "test" }))).toBe("subject_conflict");
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("rolls provisioning back when mapping or a library step fails after the account rows were written", async () => {
    const faults: ProofFaultInjection = {};
    const f = await proofFixture(faults);
    try {
      const agent = f.identity.createAgent(f.ownerActor);
      expect(await errorCode(() => f.runtime.provisionLocal({ principalId: agent.id, email: "agent@fixture.invalid", name: "Agent", password: NEW_PASSWORD, actor: "test" }))).toBe("principal_unavailable");
      faults.afterProvisionedUser = async () => { throw new Error("library failure after user write"); };
      expect(await errorCode(() => f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" }))).toBe("provider_failed");
      for (const table of ["authentication_ba_user", "authentication_ba_account", "authentication_provider_subjects"]) expect(count(f.path, table)).toBe(0);
      expect(readCommitted(f.path, db => db.prepare("SELECT count(*) n FROM controller_audit_events WHERE event_type LIKE 'authentication.provider.%'").get())).toEqual({ n: 0 });
      faults.afterProvisionedUser = undefined;
      await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
      expect(count(f.path, "authentication_provider_subjects")).toBe(1);
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("signs in with real secure cookies and resolves current storage on every call", async () => {
    const f = await provisioned();
    try {
      const client = new Client(f.runtime);
      const wrong = await client.signIn("not-the-fixture-password");
      expect(wrong.status).toBe(401);
      expect(wrong.headers.getSetCookie()).toEqual([]);
      expect(count(f.path, "authentication_ba_session")).toBe(0);
      const signedIn = await client.signIn();
      expect(signedIn.status).toBe(200);
      const [cookie] = signedIn.headers.getSetCookie();
      expect(cookie).toMatch(/^__Secure-wtc\.session_token=[^;]+; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
      const resolved = await client.resolve();
      expect(resolved).toEqual({
        principalId: f.owner.principalId,
        session: { providerId: "better-auth", sessionId: expect.any(String), subject: f.subject, createdAt: expect.any(String), expiresAt: expect.any(String), authentication: { method: "password", factors: 1 } },
      });
      const session = await client.call("/get-session", { method: "GET" });
      expect((await session.json()).user.id).toBe(f.subject);
      const value = client.cookies.get("__Secure-wtc.session_token")!;
      const tampered = `${value.slice(0, -4)}${value.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
      expect(await client.resolve(`__Secure-wtc.session_token=${tampered}`)).toBeNull();
      expect(await client.resolve("__Secure-wtc.session_token=unknown.signature")).toBeNull();
      expect(await client.resolve("")).toBeNull();
      // Sessions live in the database: a new provider instance resolves the retained cookie.
      await f.runtime.dispose();
      const restarted = await loadProof(f.store);
      try { expect((await new Client(restarted.runtime).resolve(client.cookieHeader()))?.session.sessionId).toBe(resolved!.session.sessionId); }
      finally { await restarted.runtime.dispose(); }
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("invalidates retained cookies after sign-out, individual and all-session revocation, notifying only after commit", async () => {
    const f = await provisioned();
    try {
      const [a, b, c, d] = await Promise.all(["203.0.113.21", "203.0.113.22", "203.0.113.23", "203.0.113.24"].map(async ip => { const client = new Client(f.runtime, ip); await client.signIn(); return client; }));
      const sessionA = (await a!.resolve())!.session.sessionId;
      const retainedA = a!.cookieHeader();
      expect((await a!.call("/sign-out", { body: {} })).status).toBe(200);
      expect(await a!.resolve(retainedA)).toBeNull();
      await a!.call("/sign-out", { body: {}, cookie: retainedA });
      expect(await a!.resolve(retainedA)).toBeNull();
      const sessionB = (await b!.resolve())!.session.sessionId;
      await f.runtime.revokeSession(sessionB);
      expect(await b!.resolve()).toBeNull();
      expect(await c!.resolve()).not.toBeNull();
      await f.runtime.revokePrincipalSessions(f.owner.principalId);
      expect(await c!.resolve()).toBeNull();
      expect(await d!.resolve()).toBeNull();
      expect(count(f.path, "authentication_ba_session")).toBe(0);
      const sessionEvents = f.evidence.events.filter(event => event.kind === "session");
      expect(sessionEvents.slice(0, 2)).toEqual([
        { kind: "session", providerId: "better-auth", sessionId: sessionA, subject: f.subject },
        { kind: "session", providerId: "better-auth", sessionId: sessionB, subject: f.subject },
      ]);
      expect(sessionEvents).toHaveLength(4);
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("rejects a correctly signed cookie after the stored session expires, without reusing cached evidence", async () => {
    const f = await provisioned();
    try {
      const client = new Client(f.runtime);
      expect((await client.signIn()).status).toBe(200);
      const session = (await client.resolve())!.session;
      const retained = client.cookieHeader();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(session.expiresAt).getTime() + 1);
      expect(await client.resolve(retained)).toBeNull();
      expect(await (await client.call("/get-session", { method: "GET", cookie: retained })).json()).toBeNull();
    } finally { vi.useRealTimers(); await f.runtime.dispose(); f.store.close(); }
  });

  it("denies a retained cookie once the mapping or the owner principal is no longer current", async () => {
    const f = await provisioned();
    const client = new Client(f.runtime);
    await client.signIn();
    await f.runtime.revokeSubject({ principalId: f.owner.principalId, actor: "test" });
    expect(await client.resolve()).toBeNull();
    expect(f.evidence.events[0]).toEqual({ kind: "subject", providerId: "better-auth", subject: f.subject });
    expect(readCommitted(f.path, db => db.prepare("SELECT status FROM authentication_provider_subjects").get())).toEqual({ status: "revoked" });
    await f.runtime.dispose(); f.store.close();

    const g = await provisioned();
    const retained = new Client(g.runtime);
    await retained.signIn();
    await g.runtime.dispose(); g.store.close();
    // Revoke the owner offline, as no current controller operation revokes owners.
    const writer = new Database(g.path);
    try { writer.prepare("UPDATE remote_principals SET status='revoked' WHERE id=?").run(g.owner.principalId); } finally { writer.close(); }
    const reopened = new SqliteStateStore(g.path);
    const reloaded = await loadProof(reopened);
    try {
      expect(count(g.path, "authentication_ba_session")).toBe(1);
      expect(await new Client(reloaded.runtime).resolve(retained.cookieHeader())).toBeNull();
    } finally { await reloaded.runtime.dispose(); reopened.close(); }
  });

  it("changes passwords only with the current password and full session revocation, rolling back failed writes", async () => {
    const faults: ProofFaultInjection = {};
    const f = await provisioned(faults);
    try {
      const a = new Client(f.runtime, "203.0.113.31"), b = new Client(f.runtime, "203.0.113.32");
      await a.signIn(); await b.signIn();
      const change = (client: Client, body: Record<string, unknown>) => client.call("/change-password", { body });
      expect((await change(a, { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(400);
      expect((await change(a, { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false })).status).toBe(400);
      expect((await change(a, { currentPassword: "wrong-current-password", newPassword: NEW_PASSWORD, revokeOtherSessions: true })).status).toBe(400);
      faults.beforePasswordWrite = async () => { throw new Error("password write failure"); };
      expect((await change(a, { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true })).status).toBeGreaterThanOrEqual(500);
      faults.beforePasswordWrite = undefined;
      // Every failed attempt left both sessions and the old password intact, and announced nothing.
      expect(f.evidence.events).toEqual([]);
      expect(await a.resolve()).not.toBeNull();
      expect(await b.resolve()).not.toBeNull();
      expect((await new Client(f.runtime, "203.0.113.33").signIn()).status).toBe(200);
      const retainedA = a.cookieHeader();
      const changed = await change(a, { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true });
      expect(changed.status).toBe(200);
      expect(a.cookieHeader()).not.toBe(retainedA);
      expect(await a.resolve(retainedA)).toBeNull();
      expect(await b.resolve()).toBeNull();
      expect((await a.resolve())?.session.subject).toBe(f.subject);
      expect((await new Client(f.runtime, "203.0.113.34").signIn()).status).toBe(401);
      expect((await new Client(f.runtime, "203.0.113.35").signIn(NEW_PASSWORD)).status).toBe(200);
      expect((await a.call("/update-user", { body: { name: "Renamed Owner" } })).status).toBe(200);
      expect(await a.resolve()).toMatchObject({ principalId: f.owner.principalId, session: { subject: f.subject } });
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("recovers locally by replacing the password and revoking sessions atomically, without touching machine credentials", async () => {
    const faults: ProofFaultInjection = {};
    const f = await provisioned(faults);
    try {
      const agent = f.identity.createAgent(f.ownerActor);
      const agentToken = f.identity.issueAgentToken({ principalId: agent.id, label: "worker" }, f.ownerActor).token;
      const client = new Client(f.runtime);
      await client.signIn();
      faults.beforeRecoveryCommit = async () => { throw new Error("recovery failure"); };
      expect(await errorCode(() => f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "local-recovery" }))).toBe("provider_failed");
      expect(await client.resolve()).not.toBeNull();
      expect(f.evidence.events).toEqual([]);
      expect(readCommitted(f.path, db => db.prepare("SELECT count(*) n FROM controller_audit_events WHERE event_type='authentication.provider.password_recovered'").get())).toEqual({ n: 0 });
      faults.beforeRecoveryCommit = undefined;
      await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "local-recovery" });
      expect(await client.resolve()).toBeNull();
      expect((await new Client(f.runtime, "203.0.113.41").signIn()).status).toBe(401);
      expect((await new Client(f.runtime, "203.0.113.42").signIn(NEW_PASSWORD)).status).toBe(200);
      expect(f.evidence.events).toEqual([
        { kind: "subject", providerId: "better-auth", subject: f.subject },
        { kind: "session", providerId: "better-auth", sessionId: expect.any(String), subject: f.subject },
      ]);
      expect(f.identity.authenticateBearer(agentToken).principalId).toBe(agent.id);
      expect(f.identity.authenticateBearer(f.owner.token).principalId).toBe(f.owner.principalId);
      const unlinked = storeFixture();
      const other = await loadProof(unlinked.store);
      try { expect(await errorCode(() => other.runtime.recoverLocal({ principalId: unlinked.owner.principalId, newPassword: NEW_PASSWORD, actor: "test" }))).toBe("not_linked"); }
      finally { await other.runtime.dispose(); unlinked.store.close(); }
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("redeems native reset tokens once, stores them hashed, expires them and keeps them retryable after a failed write", async () => {
    const faults: ProofFaultInjection = {};
    const f = await provisioned(faults);
    try {
      const signedIn = new Client(f.runtime, "203.0.113.50");
      await signedIn.signIn();
      const request = async (ip: string, email = OWNER_EMAIL) => (await new Client(f.runtime, ip).call("/request-password-reset", { body: { email } })).status;
      const reset = (ip: string, token: string, newPassword = NEW_PASSWORD) => new Client(f.runtime, ip).call("/reset-password", { body: { token, newPassword } });
      expect(await request("203.0.113.51", "nobody@fixture.invalid")).toBe(200);
      expect(f.evidence.resets).toEqual([]);
      expect(await request("203.0.113.52")).toBe(200);
      const token = f.evidence.resets[0]!.token;
      expect(f.evidence.resets[0]!.subject).toBe(f.subject);
      const identifiers = readCommitted(f.path, db => db.prepare('SELECT "identifier", "value" FROM "authentication_ba_verification"').all() as Array<{ identifier: string; value: string }>);
      expect(identifiers).toHaveLength(1);
      expect(identifiers[0]!.identifier).not.toContain(token);
      expect((await reset("203.0.113.53", "not-a-valid-token")).status).toBe(400);
      faults.beforePasswordWrite = async () => { throw new Error("password write failure"); };
      expect((await reset("203.0.113.54", token)).status).toBeGreaterThanOrEqual(500);
      faults.beforePasswordWrite = undefined;
      expect(await signedIn.resolve()).not.toBeNull();
      expect((await reset("203.0.113.55", token)).status).toBe(200);
      expect(await signedIn.resolve()).toBeNull();
      expect((await reset("203.0.113.56", token, "another-replacement-password")).status).toBe(400);
      expect((await new Client(f.runtime, "203.0.113.57").signIn(NEW_PASSWORD)).status).toBe(200);

      expect(await request("203.0.113.58")).toBe(200);
      const contested = f.evidence.resets[1]!.token;
      const outcomes = await Promise.all([reset("203.0.113.59", contested, "contested-password-one"), reset("203.0.113.60", contested, "contested-password-two")]);
      expect(outcomes.map(response => response.status).sort()).toEqual([200, 400]);

      expect(await request("203.0.113.61")).toBe(200);
      const expiring = f.evidence.resets[2]!.token;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      expect((await reset("203.0.113.62", expiring)).status).toBe(400);
    } finally { vi.useRealTimers(); await f.runtime.dispose(); f.store.close(); }
  });

  it("enforces Host, Origin, cross-site navigation and per-IP rate limits despite test-mode defaults", async () => {
    const f = await provisioned();
    try {
      const client = new Client(f.runtime, "203.0.113.70");
      await client.signIn();
      expect((await client.call("/sign-out", { body: {}, origin: "https://evil.invalid" })).status).toBe(403);
      expect((await client.call("/sign-out", { body: {}, origin: null })).status).toBe(403);
      expect(await client.resolve()).not.toBeNull();
      expect((await client.call("/sign-in/email", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD }, url: "https://other.invalid/api/auth/sign-in/email" })).status).toBe(421);
      const navigation = new Client(f.runtime, "203.0.113.71");
      expect((await navigation.call("/sign-in/email", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD }, origin: null, headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } })).status).toBe(403);
      const redirect = await new Client(f.runtime, "203.0.113.74").call("/sign-in/email", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD, callbackURL: "https://evil.invalid/collect" } });
      expect(redirect.status).toBe(403);
      expect(redirect.headers.getSetCookie()).toEqual([]);
      expect(count(f.path, "authentication_ba_session")).toBe(1);
      const attacker = new Client(f.runtime, "203.0.113.72");
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt++) statuses.push((await attacker.signIn(`wrong-password-${attempt}`)).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      expect((await new Client(f.runtime, "203.0.113.73").signIn()).status).toBe(200);
      expect(ORIGIN).toBe("https://controller.test");
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("reports a failed after-commit notification as committed rather than rolled back", async () => {
    const f = await provisioned();
    try {
      const client = new Client(f.runtime);
      await client.signIn();
      const { sessionId } = (await client.resolve())!.session;
      f.evidence.failInvalidation = true;
      const error = await f.runtime.revokeSession(sessionId).catch((reason: unknown) => reason as AuthenticationProviderError);
      expect(error).toMatchObject({ code: "invalidation_failed", committed: true });
      f.evidence.failInvalidation = false;
      expect(await client.resolve()).toBeNull();
      expect(count(f.path, "authentication_ba_session")).toBe(0);
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("preserves committed handler revocation when the library catches a failed notification", async () => {
    const f = await provisioned();
    try {
      const client = new Client(f.runtime);
      await client.signIn();
      const retained = client.cookieHeader();
      f.evidence.failInvalidation = true;
      const error = await client.call("/sign-out", { body: {} }).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "invalidation_failed", committed: true, message: "A committed change could not notify active sessions." });
      f.evidence.failInvalidation = false;
      expect(count(f.path, "authentication_ba_session")).toBe(0);
      expect(await client.resolve(retained)).toBeNull();
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("refuses competing core work while a real library transaction is paused after its write, then commits or rolls back cleanly", async () => {
    const faults: ProofFaultInjection = {};
    const f = await proofFixture(faults);
    try {
      const earlier = f.store.addProject({ name: "earlier", repositoryPath: join(f.root, "earlier"), port: 3711, executable: "node", args: [] });
      const prepared = (f.store as unknown as { database: { prepare(sql: string): { get(): unknown } } }).database.prepare("SELECT count(*) n FROM projects");
      const paused = gate(), resume = gate();
      let failAfterResume = true;
      faults.afterProvisionedUser = async () => { paused.open(); await resume.opened; if (failAfterResume) throw new Error("abort after write"); };
      const pending = f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" }).catch((error: unknown) => error);
      await paused.opened;
      const attempts = {
        read: (() => { try { f.store.listProjects(); } catch (error) { return (error as { code?: string }).code; } })(),
        write: (() => { try { f.store.addProject({ name: "competing", repositoryPath: join(f.root, "c"), port: 3712, executable: "node", args: [] }); } catch (error) { return (error as { code?: string }).code; } })(),
        prepared: (() => { try { prepared.get(); } catch (error) { return (error as { code?: string }).code; } })(),
        identity: (() => { try { f.identity.authenticateBearer(f.owner.token); } catch (error) { return (error as { code?: string }).code; } })(),
        backup: await errorCode(() => createControllerBackup(f.store, join(f.root, "blocked"), { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") })),
      };
      expect(attempts).toEqual({ read: "busy", write: "busy", prepared: "busy", identity: "busy", backup: "busy" });
      resume.open();
      expect(await pending).toMatchObject({ code: "provider_failed" });
      expect(count(f.path, "authentication_ba_user")).toBe(0);
      expect(f.store.getProject(earlier.id)?.name).toBe("earlier");
      expect(f.store.listProjects()).toHaveLength(1);
      failAfterResume = false;
      const second = gate(), release = gate();
      faults.afterProvisionedUser = async () => { second.open(); await release.opened; };
      const committing = f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
      await second.opened;
      expect(count(f.path, "authentication_ba_user")).toBe(0);
      release.open();
      await committing;
      expect(count(f.path, "authentication_ba_user")).toBe(1);
      expect((await new Client(f.runtime).signIn()).status).toBe(200);
    } finally { await f.runtime.dispose(); f.store.close(); }
  });

  it("drains admitted work on disposal, keeps ownership and core use, and carries provider rows through backup and restore", async () => {
    const faults: ProofFaultInjection = {};
    const f = await provisioned(faults);
    const client = new Client(f.runtime);
    await client.signIn();
    const knowledge = f.identity.createKnowledgeProject({ name: "Separate" }, f.ownerActor);
    const backup = join(f.root, "backup");
    try {
      const inFlight = gate(), finish = gate();
      faults.beforePasswordWrite = async () => { inFlight.open(); await finish.opened; };
      const changing = client.call("/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true } });
      await inFlight.opened;
      // These operations enter the runtime before disposal but wait behind its active borrow.
      const queuedSignIn = new Client(f.runtime, "203.0.113.81").signIn(NEW_PASSWORD);
      const queuedResolution = client.resolve(client.cookieHeader());
      let disposed = false;
      const disposal = f.runtime.dispose().then(() => { disposed = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(disposed).toBe(false);
      expect(await errorCode(() => f.runtime.resolve(new Headers()))).toBe("provider_disposed");
      finish.open();
      expect((await changing).status).toBe(200);
      expect((await queuedSignIn).status).toBe(200);
      expect(await queuedResolution).toBeNull();
      await disposal;
      await f.runtime.dispose();
      expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      f.store.addProject({ name: "after-disposal", repositoryPath: join(f.root, "after"), port: 3721, executable: "node", args: [] });
      const exported = JSON.stringify(f.store.exportKnowledgeProject(knowledge.id));
      for (const secret of ["authentication_ba", OWNER_EMAIL, f.subject]) expect(exported).not.toContain(secret);
      await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    } finally { f.store.close(); }
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
    const restoredPath = join(f.root, "restored", "state.sqlite3");
    restoreControllerBackup(backup, restoredPath, join(f.root, "restored-attachments"));
    const restored = new SqliteStateStore(restoredPath);
    try {
      expect(restored.schemaVersion()).toBe(47);
      expect(count(restoredPath, "authentication_provider_subjects")).toBe(1);
      expect(restored.listProjects().map(project => project.name)).toEqual(["after-disposal"]);
      // Its marked rows may be older than what was published, so this owner never gets issuance bounds.
      await expect(restored.recoverIssuedSessions(SESSION_POLICY)).rejects.toThrow("provenance");
      await expect(loadProof(restored)).rejects.toThrow();
      const reloaded = await loadAuthenticationProvider({ entry: PROVIDER_ENTRY, providerId: "better-auth", storage: restored.authenticationProviderStorage(),
        options: { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER } });
      try {
        // A restored snapshot brings back its sessions; external revocation fences are A5 work.
        expect((await new Client(reloaded).resolve(client.cookieHeader()))?.principalId).toBe(f.owner.principalId);
        expect((await new Client(reloaded, "203.0.113.80").signIn(NEW_PASSWORD)).status).toBe(503);
      } finally { await reloaded.dispose(); }
    } finally { restored.close(); }
  });

  it("keeps passwords, cookies, session and reset tokens out of logs, audit rows and errors", async () => {
    const faults: ProofFaultInjection = {};
    const f = await provisioned(faults);
    try {
      const client = new Client(f.runtime, "203.0.113.90");
      const signedIn = await client.signIn();
      const sessionToken = (await signedIn.json()).token as string;
      await new Client(f.runtime, "203.0.113.91").signIn("a-wrong-secret-password");
      await new Client(f.runtime, "203.0.113.92").call("/request-password-reset", { body: { email: OWNER_EMAIL } });
      const errors: string[] = [];
      faults.beforeRecoveryCommit = async () => { throw new Error(`leak ${NEW_PASSWORD}`); };
      await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "local" }).catch((error: Error) => errors.push(error.message));
      faults.beforeRecoveryCommit = undefined;
      await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: NEW_PASSWORD, actor: "local" });
      await client.call("/sign-out", { body: {}, origin: "https://evil.invalid" });
      const audit = readCommitted(f.path, db => JSON.stringify(db.prepare("SELECT * FROM controller_audit_events").all()));
      const haystack = [...f.evidence.logs, ...errors, audit, JSON.stringify(f.evidence.events)].join("\n");
      const cookie = client.cookies.get("__Secure-wtc.session_token")!;
      for (const secret of [OWNER_PASSWORD, NEW_PASSWORD, "a-wrong-secret-password", sessionToken, cookie, decodeURIComponent(cookie), f.evidence.resets[0]!.token, OWNER_EMAIL]) {
        expect(haystack).not.toContain(secret);
      }
      expect(errors).toEqual(["The authentication provider operation failed."]);
    } finally { await f.runtime.dispose(); f.store.close(); }
  });
});
