import { join } from "node:path";
import { createControllerServer } from "@/server/http-server";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import type { ControlService } from "@/server/control-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSessionActor } from "@/server/modules/identity";
import { ORIGIN, OWNER_PASSWORD, OWNER_EMAIL, count, readCommitted } from "./fixture";
import { aroundBrowser, BrowserClient, browserFixture, write, type BrowserFixture } from "./browser-authentication-fixture";
import { cleanupStrictRoots, gate } from "./strict-fixture";
import type { ProofFaultInjection } from "../src/index";

afterEach(cleanupStrictRoots);
async function sql(f: BrowserFixture, statement: string, args: unknown[] = []) {
  const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
  try { await storage.borrow(async () => { connection.prepare(statement).run(args); }); } finally { connection.close(); }
}
const sessionCookie = (value: string) => new Headers({ cookie: value });

describe("actual controller browser adapter with pinned Better Auth", () => {
  it("logs in with cookie, projects a safe session and executes grant-limited Knowledge over the same Unix HTTP listener", async () => {
    const f = await browserFixture(), client = f.client();
    try {
      const login = await client.login();
      expect(login).toMatchObject({ status: 200, body: { authenticated: true }, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      expect(Object.keys(login.body)).toEqual(["authenticated"]);
      expect(client.cookie).toMatch(/^__Secure-wtc.session_token=/);
      const session = await client.session();
      expect(session).toMatchObject({ status: 200, body: { authenticated: true, principal: { id: f.owner.principalId, kind: "owner" }, authentication: { method: "password", factors: 1 } } });
      expect(Object.keys(session.body).sort()).toEqual(["authenticated", "authentication", "expiresAt", "principal"]);
      expect(await client.call("/api/knowledge", { body: write(f) })).toMatchObject({ status: 403, body: { code: "knowledge_forbidden" } });
      await f.grant();
      expect(await client.call("/api/knowledge", { body: write(f) })).toMatchObject({ status: 200, body: { replayed: false } });
      expect(await client.call("/api/knowledge", { body: write(f) })).toMatchObject({ status: 200, body: { replayed: true } });
      expect((await f.run(() => f.store.listTasks(f.project.id, 10, 0))).items).toHaveLength(1);
      expect(await client.call("/api/auth/status", { method: "GET" })).toMatchObject({ status: 200, body: { mode: "open", loginAvailable: true } });
      for (const path of ["/api/dashboard", "/api/projects/x/reservation", "/api/projects/x/start", "/api/config", "/api/identity", "/api/identity/admin", "/api/dev-vault", "/api/backups", "/api/user-backups", "/api/downloads/secret", "/api/events", "/mcp"]) {
        expect(await client.call(path, { body: {} })).toMatchObject({ status: 401, body: { code: "invalid_credential" } });
      }
      const native = readCommitted(f.path, db => db.prepare('SELECT token FROM authentication_ba_session LIMIT 1').get() as { token: string });
      const audit = readCommitted(f.path, db => db.prepare("SELECT * FROM controller_audit_events").all());
      const serialized = JSON.stringify({ login: login.body, session: session.body, logs: f.evidence.logs, audit });
      for (const secret of [OWNER_PASSWORD, OWNER_EMAIL, client.cookie, native.token, f.root]) expect(serialized).not.toContain(secret);
    } finally { await f.close(); }
  });

  it("preserves Knowledge validation and conflict responses without repeating effects", async () => {
    const f = await browserFixture(), client = await f.client().authenticated();
    try {
      await f.grant();
      expect(await client.call("/api/knowledge", { body: {} })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
      const created = await client.call("/api/knowledge", { body: write(f) });
      expect(created.status).toBe(200);
      const task = created.body.value as { id: string; revision: number };
      const update = { operation: "update_task", input: { projectId: f.project.id, taskId: task.id,
        title: "Updated", description: "One update", priority: "now", status: "in_progress",
        expectedRevision: task.revision, idempotencyKey: "browser-update" } };
      expect((await client.call("/api/knowledge", { body: update })).status).toBe(200);
      expect(await client.call("/api/knowledge", { body: { ...update, input: { ...update.input, idempotencyKey: "stale-update" } } }))
        .toMatchObject({ status: 409, body: { code: "revision_conflict", currentRevision: task.revision + 1 } });
      expect(await client.call("/api/knowledge", { body: { ...write(f), input: { ...write(f).input, title: "Different" } } }))
        .toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
      const tasks = await f.run(() => f.store.listTasks(f.project.id, 10, 0));
      expect(tasks.items).toHaveLength(1);
      expect(tasks.items[0]).toMatchObject({ id: task.id, title: "Updated", revision: task.revision + 1 });
    } finally { await f.close(); }
  });

  it("keeps production composition login unavailable and rejects provider cookies with open active and token pending", async () => {
    const f = await browserFixture(), client = await f.client().authenticated();
    const browserCalls = vi.spyOn(f.runtime, "browser");
    const prod = createControllerServer({ ...f.httpOptions, browserAuthentication: undefined });
    try {
      const socketPath = join(f.root, "production-shape.sock");
      await new Promise<void>(resolve => prod.server.listen(socketPath, resolve));
      const production = new BrowserClient(socketPath); production.cookie = client.cookie;
      await f.run(() => { f.authentication.generateToken("local-cli"); f.authentication.setMode("token", "local-cli"); });
      const status = await production.call("/api/auth/status", { method: "GET" });
      expect(status.status).toBe(200); expect(status.body).toEqual({ mode: "open", loginAvailable: false });
      expect((await production.call("/api/auth/sign-in/email", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD } })).status).toBe(401);
      expect((await production.call("/api/knowledge", { body: write(f) })).status).toBe(401);
      expect((await production.call("/api/projects", { method: "GET" })).status).toBe(401);
      expect(browserCalls).not.toHaveBeenCalled();
    } finally { await prod.close(); await f.close(); }
  });

  it("denies a provider cookie on the actual separate MCP HTTP listener even in open mode", async () => {
    const f = await browserFixture(), client = await f.client().authenticated();
    const mcp = createMcpControllerServer({ service: { admission: f.store.admission } as unknown as ControlService,
      identity: f.identity, authentication: f.authentication, accessToken: "fixture", port: 0 });
    try {
      const socketPath = join(f.root, "mcp-browser.sock");
      await new Promise<void>(resolve => mcp.server.listen(socketPath, resolve));
      const machine = new BrowserClient(socketPath); machine.cookie = client.cookie;
      expect((await machine.call("/mcp", { omitOrigin: true, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } })).status).toBe(401);
      expect((await mcp.diagnosticsSnapshot()).sessions).toEqual([]);
    } finally { await mcp.close(); await f.close(); }
  });

  it.each(["unmapped", "revoked-mapping", "revoked-principal"])("denies %s login uniformly and deletes its unreleased native session", async state => {
    const f = await browserFixture(), client = f.client();
    try {
      const wrong = await client.login("sentinel-wrong-password");
      if (state === "unmapped") await sql(f, "DELETE FROM authentication_provider_subjects");
      else if (state === "revoked-mapping") await f.runtime.revokeSubject({ principalId: f.owner.principalId, actor: "test" });
      else await sql(f, "UPDATE remote_principals SET status='revoked' WHERE id=?", [f.owner.principalId]);
      const denied = await client.login();
      expect(denied.status).toBe(401); expect(denied.body).toEqual(wrong.body);
      expect(denied.headers["set-cookie"]).toBeUndefined(); expect(client.cookie).toBe("");
      expect(count(f.path, "authentication_ba_session")).toBe(0);
    } finally { await f.close(); }
  });

  it("rejects nonallowlisted native routes, methods, fields, queries and raw path aliases before invoking the provider", async () => {
    const f = await browserFixture(), client = f.client(), invoke = vi.spyOn(f.runtime, "browser");
    try {
      for (const path of ["sign-up/email", "request-password-reset", "reset-password", "sign-in/social", "callback/x", "link-social", "update-user", "revoke-sessions", "two-factor/enable", "config", "admin/create-user", "sign-in/email/", "sign-in//email", "%73ign-in/email", "./sign-in/email", "get-session?disableCookieCache=true"]) {
        expect((await client.call(`/api/auth/${path}`, { body: {} })).status).toBeGreaterThanOrEqual(400);
      }
      for (const method of ["GET", "PUT", "OPTIONS", "DELETE"]) expect((await client.call("/api/auth/sign-in/email", { method })).status).toBe(405);
      for (const extra of [{ callbackURL: "https://sentinel.invalid" }, { rememberMe: true }, { revokeOtherSessions: false }]) {
        expect((await client.call("/api/auth/sign-in/email", { body: { email: OWNER_EMAIL, password: OWNER_PASSWORD, ...extra } })).status).toBe(400);
      }
      expect(invoke).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("validates original Host, absolute form, mandatory Origin and fetch metadata before provider dispatch", async () => {
    const f = await browserFixture(), client = f.client(), invoke = vi.spyOn(f.runtime, "browser");
    try {
      for (const host of ["sentinel.invalid", "controller.test:443", "attacker@controller.test", "controller.test."]) {
        expect((await client.call("/api/auth/sign-in/email", { body: {}, headers: { host } })).status).toBe(421);
      }
      for (const origin of ["null", "https://sentinel.invalid", `${ORIGIN}/`, "http://controller.test"]) expect((await client.call("/api/auth/sign-in/email", { body: {}, headers: { origin } })).status).toBe(403);
      expect((await client.call("/api/auth/sign-in/email", { body: {}, omitOrigin: true })).status).toBe(403);
      expect((await client.call("/api/auth/sign-in/email", { body: {}, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
      expect((await client.call(`${ORIGIN}/api/auth/sign-in/email`, { body: {} })).status).toBe(400);
      expect(invoke).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("strips spoofed IP, forwarding and installation authority and preserves the actual native per-peer login limiter", async () => {
    const f = await browserFixture(), client = f.client(), invoke = vi.spyOn(f.runtime, "browser");
    try {
      let last;
      for (let i = 0; i < 6; i++) last = await client.call("/api/auth/sign-in/email", { body: { email: OWNER_EMAIL, password: "sentinel-password-wrong" },
        headers: { "x-worktree-control-client-ip": `203.0.113.${i}`, "x-forwarded-for": `203.0.113.${i}`, forwarded: `for=203.0.113.${i}`, authorization: "Bearer sentinel-token", "x-worktree-control-token": "sentinel-token" } });
      expect(last).toMatchObject({ status: 429, headers: { "retry-after": "60" }, body: { code: "rate_limited" } });
      const native = invoke.mock.calls[0][1];
      expect(native.headers.get("x-worktree-control-client-ip")).toBe(f.peer);
      for (const header of ["authorization", "forwarded", "x-forwarded-for", "x-worktree-control-token"]) expect(native.headers.has(header)).toBe(false);
      expect(JSON.stringify(last)).not.toContain("sentinel");
      expect(f.evidence.logs.join("\n")).not.toContain("sentinel");
    } finally { await f.close(); }
  });

  it("bounds body and in-flight reads without holding core admission", async () => {
    const f = await browserFixture({}, {}, 1), client = f.client();
    const dispatch = vi.spyOn(f.adapter, "handle");
    const held = client.start("/api/auth/sign-in/email");
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      expect(await client.login()).toMatchObject({ status: 503, body: { code: "database_busy" } });
      expect(await f.run(() => f.store.listProjects())).toEqual([]);
      held.send(JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }));
      expect((await held.completed).status).toBe(200);
      const overflow = await client.call("/api/auth/sign-in/email", { raw: JSON.stringify({ email: OWNER_EMAIL, password: "x".repeat(5000) }) });
      expect(overflow.status).toBe(413);
    } finally { held.abort(); await f.close(); }
  });

  it("rechecks Knowledge grants after a real HTTP body wait, including retained write replay", async () => {
    const f = await browserFixture(), client = await f.client().authenticated();
    try {
      await f.grant();
      expect((await client.call("/api/knowledge", { body: write(f) })).status).toBe(200);
      const dispatch = vi.spyOn(f.adapter, "handle"), held = client.start("/api/knowledge");
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      await f.run(() => f.identity.revokeKnowledgeGrant(f.owner.principalId, f.project.id, f.ownerActor));
      held.send(JSON.stringify(write(f)));
      expect((await held.completed).status).toBe(403);
      expect((await f.run(() => f.store.listTasks(f.project.id, 10, 0))).items).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("preserves validated refresh Set-Cookie and denies structural actor copies", async () => {
    const f = await browserFixture(), client = await f.client().authenticated();
    try {
      const actor = (await f.runtime.authenticate(sessionCookie(client.cookie)))!;
      await expect(f.app.describeIdentity(Object.freeze({ ...actor }) as ProviderSessionActor)).rejects.toMatchObject({ code: "invalid_credential" });
      const resolved = (await f.runtime.resolve(sessionCookie(client.cookie)))!;
      const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await sql(f, 'UPDATE authentication_ba_session SET "createdAt"=?, "updatedAt"=?, "expiresAt"=? WHERE id=?', [old, old, new Date(Date.now() + 2 * 60 * 60_000).toISOString(), resolved.session.sessionId]);
      const refreshed = await client.session();
      expect(refreshed.status).toBe(200); expect(refreshed.headers["set-cookie"]?.some(line => line.startsWith("__Secure-wtc.session_token="))).toBe(true);
    } finally { await f.close(); }
  });

  it("durably logs out only the caller and remains idempotent without a cookie", async () => {
    const f = await browserFixture(), one = await f.client().authenticated(), two = await f.client().authenticated();
    try {
      const old = one.cookie;
      expect(await one.call("/api/auth/sign-out", { body: {} })).toMatchObject({ status: 200, body: { authenticated: false } });
      expect(await one.call("/api/auth/get-session", { method: "GET", cookie: old })).toMatchObject({ body: { authenticated: false } });
      expect(await two.session()).toMatchObject({ body: { authenticated: true } });
      expect(await f.client().call("/api/auth/sign-out", { body: {} })).toMatchObject({ status: 200, body: { authenticated: false } });
    } finally { await f.close(); }
  });

  it("does not report successful logout when the real sanctioned session delete fails", async () => {
    const faults: ProofFaultInjection = {}, f = await browserFixture(faults), client = await f.client().authenticated();
    try {
      faults.beforeSessionDelete = async () => { throw new Error("sentinel-delete-error"); };
      const result = await client.call("/api/auth/sign-out", { body: {} });
      expect(result.status).toBeGreaterThanOrEqual(500); expect(result.body).not.toHaveProperty("authenticated");
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(await client.session()).toMatchObject({ body: { authenticated: true } });
      expect(JSON.stringify({ result, logs: f.evidence.logs })).not.toContain("sentinel-delete-error");
    } finally { delete faults.beforeSessionDelete; await f.close(); }
  });

  it("changes the password, replaces its own cookie, revokes every old session and supports protected recovery while mode selection is pending", async () => {
    const f = await browserFixture(), one = await f.client().authenticated(), two = await f.client().authenticated();
    try {
      const old = one.cookie;
      await f.run(() => { f.authentication.generateToken("local-cli"); f.authentication.setMode("token", "local-cli"); });
      expect(await one.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } })).toMatchObject({ status: 200, body: { changed: true } });
      expect(one.cookie).not.toBe(old);
      expect(await one.call("/api/auth/get-session", { method: "GET", cookie: old })).toMatchObject({ body: { authenticated: false } });
      expect(await two.session()).toMatchObject({ body: { authenticated: false } });
      expect(await one.session()).toMatchObject({ body: { authenticated: true } });
      await f.runtime.recoverLocal({ principalId: f.owner.principalId, newPassword: "fixture-recovered-password-3", actor: "local-cli" });
      expect(await one.session()).toMatchObject({ body: { authenticated: false } });
      expect((await f.client().login("fixture-recovered-password-3")).status).toBe(200);
      expect(await f.run(() => f.authentication.status())).toMatchObject({ activeMode: "open", configuredMode: "token", restartRequired: true });
    } finally { await f.close(); }
  });

  it("returns one replacement cookie when native refresh is due during an actual HTTP password change", async () => {
    const f = await browserFixture(), client = await f.client().authenticated();
    const old = client.cookie;
    try {
      const original = await client.session();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
      const changed = await client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } });
      expect(changed.status).toBe(200); expect(changed.body).toEqual({ changed: true });
      const cookies = changed.headers["set-cookie"];
      expect(Array.isArray(cookies)).toBe(true);
      expect((cookies as string[]).filter(line => line.startsWith("__Secure-wtc.session_token=")).length).toBe(1);
      expect(client.cookie === old).toBe(false);
      const session = await client.session();
      expect(session.status).toBe(200); expect(session.body.authenticated).toBe(true);
      expect(session.body.expiresAt).toBe(original.body.expiresAt);
      const retained = await client.call("/api/auth/get-session", { method: "GET", cookie: old });
      expect(retained.body.authenticated).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it("rechecks current session after the HTTP body wait before sensitive password work", async () => {
    const wrote = vi.fn(), faults: ProofFaultInjection = { beforePasswordWrite: async () => { wrote(); } };
    const f = await browserFixture(faults), client = await f.client().authenticated();
    try {
      const dispatch = vi.spyOn(f.adapter, "handle");
      const held = client.start("/api/auth/change-password");
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
      await f.runtime.revokePrincipalSessions(f.owner.principalId);
      held.send(JSON.stringify({ currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" }));
      expect((await held.completed).status).toBe(401); expect(wrote).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rechecks exact actor inside a queued provider borrow before password mutation", async () => {
    const wrote = vi.fn(), faults: ProofFaultInjection = { beforePasswordWrite: async () => { wrote(); } };
    const f = await browserFixture(faults), client = await f.client().authenticated();
    const entered = gate(), release = gate();
    const original = f.runtime.browser.bind(f.runtime);
    let hold: Promise<unknown> | undefined, revoke: Promise<void> | undefined;
    vi.spyOn(f.runtime, "browser").mockImplementation((...args) => aroundBrowser(async () => {
      hold = f.run(async () => { entered.open(); await release.opened; });
      await entered.opened;
      revoke = f.runtime.revokePrincipalSessions(f.owner.principalId);
      return original(...args);
    }));
    try {
      const mutation = client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } });
      await entered.opened;
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(2));
      release.open(); await hold; await revoke;
      expect((await mutation).status).toBe(401);
      expect(wrote).not.toHaveBeenCalled();
    } finally { release.open(); await hold; await revoke; await f.close(); }
  });

  it("denies a login result revoked while final admission waits and cleans up its unreleased cookie", async () => {
    const f = await browserFixture(), client = f.client(), original = f.runtime.browser.bind(f.runtime);
    let revoke: Promise<void> | undefined;
    const entered = gate(), release = gate();
    let hold: Promise<unknown> | undefined;
    vi.spyOn(f.runtime, "browser").mockImplementation((...args) => aroundBrowser(async () => {
      const lifetime = original(...args);
      await lifetime.result;
      hold = f.run(async () => { entered.open(); await release.opened; });
      await entered.opened;
      revoke = f.runtime.revokePrincipalSessions(f.owner.principalId);
      return lifetime;
    }));
    try {
      const pending = client.login();
      await entered.opened;
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThan(0));
      release.open(); await hold; await revoke;
      const result = await pending;
      expect(result.status).toBe(401); expect(result.headers["set-cookie"]).toBeUndefined();
      expect(count(f.path, "authentication_ba_session")).toBe(0);
    } finally { release.open(); await hold; await revoke; await f.close(); }
  });

  it("reports committed notification failure honestly and never replays password effects", async () => {
    const faults: ProofFaultInjection = {}, f = await browserFixture(faults), client = await f.client().authenticated();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrote = vi.fn(); faults.beforePasswordWrite = async () => { wrote(); };
    try {
      f.evidence.failInvalidation = true;
      const result = await client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } });
      expect(result).toMatchObject({ status: 500, body: { code: "committed_notification_failed", committed: true } });
      expect(result.headers["set-cookie"]).toBeUndefined(); expect(wrote).toHaveBeenCalledOnce();
      expect(stderr).not.toHaveBeenCalled();
      expect(await client.session()).toMatchObject({ body: { authenticated: false } });
      f.evidence.failInvalidation = false;
      expect((await f.client().login("fixture-new-password-2")).status).toBe(200);
    } finally { stderr.mockRestore(); f.evidence.failInvalidation = false; await f.close(); }
  });

  it("returns 503 plus Retry-After for refused provider admission without replaying sensitive work", async () => {
    const f = await browserFixture({}, { admissionTimeoutMs: 60 }), client = f.client(), entered = gate(), release = gate();
    const held = f.run(async () => { entered.open(); await release.opened; });
    try {
      await entered.opened;
      expect(await client.login()).toMatchObject({ status: 503, body: { code: "database_busy" }, headers: { "retry-after": "1" } });
    } finally { release.open(); await held; await f.close(); }
  });
});
