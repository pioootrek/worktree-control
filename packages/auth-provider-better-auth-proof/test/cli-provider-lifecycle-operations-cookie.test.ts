import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerAuthentication, CONTROLLER_AUTHENTICATION_POLICY } from "@/server/bootstrap/authentication";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { createControllerServer } from "@/server/http-server";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { authenticationAdminHandler } from "@/server/authentication-admin";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { acquireControllerLock } from "@/server/controller-lock";
import type { ProofFaultInjection } from "../src/index";
import { EventStream } from "@/server/events";
import { createBoundaryDriver, assertCookieOrigin, operationRoute } from "@/server/modules/operations/http-boundary-driver";
import { PROVIDER_ENTRY, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD } from "./fixture";
import { aroundBrowser } from "./browser-authentication-fixture";

let peers = 20;
const closes: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const expectProviderUnavailable = (reply: { status: number; body: Record<string, unknown>; headers: Record<string, unknown> }) => {
  expect(reply.status).toBe(503);
  expect(reply.body).toEqual({ error: { category: "unavailable", status: 503, reason: "provider_session_unavailable", retry: "retry", effect: null } });
  expect(reply.headers["retry-after"]).toBe("1");
};
const gate = () => { let open!: () => void; const promise = new Promise<void>(r => { open = r; }); return { promise, open }; };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "operations-provider-")); closes.push(() => rmSync(root, { recursive: true, force: true }));
  let store = new SqliteStateStore(join(root, "state.sqlite3"));
  const owner = new IdentityService(store).bootstrapOwnerSession();
  const setup = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
  const installation = setup.generateToken("fixture").token; setup.setMode("token", "fixture");
  let authentication = new AuthenticationService(store);
  let administration = createControllerAuthentication({ store, authentication, dataDirectory: root, actor: "local-cli" });
  const entry = join(root, "provider.mjs"); writeFileSync(entry, `export { authenticationProvider } from ${JSON.stringify(PROVIDER_ENTRY)};`, { mode: 0o600 });
  await administration.execute({ command: "auth-provider", action: "configure", input: { module: entry, origin: ORIGIN, signingSecret: { kind: "generate" } } });
  await administration.execute({ command: "auth-provider", action: "enroll", principalId: owner.principalId, input: { email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD } });
  await authenticationAdminHandler({ authentication, closeMcpSessions: async () => {}, disconnectEvents() {} })({ command: "mode set", value: "better-auth" });
  await administration.dispose(); await store.closeAfterDrain();
  store = new SqliteStateStore(join(root, "state.sqlite3"), undefined, { admission: "strict" });
  authentication = await store.admission.run(() => new AuthenticationService(store));
  const faults: ProofFaultInjection = {};
  let maintenance = false, runtime: AuthenticationProviderRuntime | undefined;
  administration = createControllerAuthentication({ store, authentication, dataDirectory: root, actor: "local-cli", maintenance: () => maintenance,
    loadProvider: async input => { runtime = await loadAuthenticationProvider({ ...input, options: { ...input.options, faultInjection: faults } as typeof input.options }); return runtime; } });
  const database = ownedFixtureDatabase(store);
  await store.admission.run(() => {
    const at = new Date().toISOString();
    store.saveKnowledgeProject({ id: "cookie-project", name: "Cookie project", status: "active", revision: 1, createdAt: at, updatedAt: at }, "fixture");
    database.prepare("INSERT OR IGNORE INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,'reader','project','cookie-project',?)").run(owner.principalId, at);
  });
  const clock = { offset: 0 };
  const operations = buildOperationsRuntime({ store, activeMode: authentication.mode(), now: () => Date.now() + clock.offset, logs: { controller() {} },
    eligibility: administration, provider: administration.operationSessionAuthority(), requestBudget: administration.requestBudget, listeners: { api: () => server.server.listening } });
  const httpOptions: Parameters<typeof createControllerServer>[0] = { service: {} as never, directoryBrowser: {} as never, events: new EventStream(),
    mcpStatus: () => ({} as never), webRoot: root, host: "127.0.0.1", port: 0, accessToken: "synthetic", authentication, admission: store.admission,
    operations, publicOrigin: ORIGIN, maintenance: () => maintenance, operationsCookieBoundary: { origin: ORIGIN, cookieBytes: CONTROLLER_AUTHENTICATION_POLICY.limits.cookieBytes } };
  const server = createControllerServer(httpOptions);
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  closes.push(async () => { administration.stop(); await server.close(); await administration.dispose(); await store.closeAfterDrain(); });
  const driver = createBoundaryDriver({ kind: "api", localAddress: `127.0.0.${peers++}`, server: server.server, close: () => server.close(), legacyPath: "/api/auth/get-session", acceptedCredentials: ["cookie"] });
  let cookie = "__Secure-wtc.session_token=unresolved";
  const send = (path = operationRoute, body = "{}", headers: Record<string, string> = {}) => driver.send({ path, body, headers: { Host: "controller.test", Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie, ...headers } });
  const call = async (path = operationRoute, body = "{}", headers: Record<string, string> = {}) => {
    const reply = await send(path, body, headers).reply;
    for (const line of reply.headers["set-cookie"] ?? []) if (line.startsWith("__Secure-wtc.session_token=")) cookie = line.split(";")[0];
    return reply;
  };
  const ready = async () => { httpOptions.browserAuthentication = await administration.prepareBrowserAuthentication({ origin: ORIGIN, knowledge: new KnowledgeService(store, administration.identity) }); };
  const login = () => call("/api/auth/sign-in/email", JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }));
  return { root, store, database, faults, administration, operations, server, driver, ready, login, call, send, installation, owner, clock,
    cookie: () => cookie, runtime: () => { if (!runtime) throw new Error("not ready"); return runtime; }, maintenance: () => { maintenance = true; } };
}

describe("operations cookies through production bootstrap and real Better Auth", () => {
  it("supports late readiness without rebuilding the operations boundary; real login, mixed-cookie failure, sign-out, maintenance and changed pinned configuration", async () => {
    const f = await fixture();
    expectProviderUnavailable(await f.call());
    await f.ready(); expect((await f.login()).status).toBe(200);
    expect((await f.call()).body).toMatchObject({ actor: { kind: "human", accountId: f.owner.principalId }, mode: "better-auth", listener: "api" });
    expect((await f.call(undefined, undefined, { Authorization: `Bearer ${f.installation}` })).body.error.reason).toBe("mixed_credentials");
    const old = f.cookie(); expect((await f.call("/api/auth/sign-out")).status).toBe(200);
    const signedOut = await f.call(undefined, undefined, { Cookie: old });
    expect(signedOut.status).toBe(401); expect(signedOut.body.error).toMatchObject({ category: "unauthenticated", reason: "invalid_credential" });
    expect((await f.call(undefined, undefined, { Cookie: old, Authorization: `Bearer ${f.installation}` })).body.error.reason).toBe("mixed_credentials");
    expect((await f.login()).status).toBe(200);
    await f.administration.execute({ command: "auth-provider", action: "configure", input: { module: join(f.root, "provider.mjs"), origin: "https://changed.test", signingSecret: { kind: "preserve" } } });
    expectProviderUnavailable(await f.call());
    f.maintenance(); expect((await f.call()).body.error.reason).toBe("release_not_eligible");
  });

  it("lost eligibility during real provider resolution is unavailable after the accessor delivery check returns null", async () => {
    const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200);
    const entered = gate(), release = gate(), runtime = f.runtime(), resolve = runtime.resolveRequest.bind(runtime);
    const resolution = vi.spyOn(runtime, "resolveRequest").mockImplementation((...args) => {
      const work = resolve(...args);
      return { result: work.result.then(async value => { expect(value).not.toBeNull(); entered.open(); await release.promise; return value; }), settled: work.settled };
    });
    const pending = f.send(); await entered.promise;
    try {
      await f.administration.execute({ command: "auth-provider", action: "configure", input: { module: join(f.root, "provider.mjs"), origin: "https://changed.test", signingSecret: { kind: "preserve" } } });
    } finally { release.open(); }
    expectProviderUnavailable(await pending.reply);
    expect(resolution).toHaveBeenCalledTimes(1);
  });

  it("closes D1a-5a reserve deferral: sign-out and an accepted login completion succeed with operations initiating cap saturated", async () => {
    const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200);
    const entered = gate(), release = gate(), runtime = f.runtime(), browser = runtime.browser.bind(runtime);
    vi.spyOn(runtime, "browser").mockImplementation((...args) => args[0] !== "sign-in" ? browser(...args) : aroundBrowser(async () => {
      const work = browser(...args); const result = await work.result; entered.open(); await release.promise;
      return { result: Promise.resolve(result), settled: work.settled };
    }));
    const revokedCookie = f.cookie();
    const completion = f.login(); await entered.promise;
    const held = Array.from({ length: 11 }, () => f.driver.send({ slow: true, headers: { Host: "controller.test", Origin: ORIGIN, "Content-Type": "application/json", Cookie: f.cookie() } }));
    // This request is ordered after slow bodies on the real local listener.
    try {
      const overflow = await f.call(); expect(overflow.body.error).toMatchObject({ category: "busy", reason: "listener_capacity", retry: "retry" });
      expect((await f.call("/api/auth/sign-out")).status).toBe(200);
      release.open(); expect((await completion).status).toBe(200);
      expect((await f.call(undefined, undefined, { Cookie: revokedCookie })).body.error.reason).toBe("invalid_credential");
      expect((await f.call()).body.actor.kind).toBe("human");
    } finally { release.open(); for (const h of held) h.call.destroy(); }
  });

  it.each(["maintenance", "configuration", "sign-out", "revoke", "grants", "deadline", "disconnect"])("real provider release after runner completion rechecks %s", async change => {
    const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200); if (!f.operations.supported) throw new Error("supported runtime required");
    const runner = f.operations.runner, release = gate(), entered = gate(), readRelease = runner.readRelease.bind(runner);
    vi.spyOn(runner, "readRelease").mockImplementation(async (operation, context, input, options) => {
      if (operation.kind === "stream") throw new Error("read required");
      const prior = await runner.run(operation, context, input); expect(prior.ok).toBe(true); entered.open(); await release.promise;
      return readRelease(operation, context, input, options);
    });
    const pending = f.send(); await entered.promise;
    try {
      if (change === "maintenance") f.maintenance();
      if (change === "configuration") await f.administration.execute({ command: "auth-provider", action: "configure", input: { module: join(f.root, "provider.mjs"), origin: "https://changed.test", signingSecret: { kind: "preserve" } } });
      if (change === "sign-out") expect((await f.call("/api/auth/sign-out")).status).toBe(200);
      if (change === "revoke") await f.administration.execute({ command: "auth-provider", action: "recover", principalId: f.owner.principalId, input: { newPassword: "replacement-provider-password-123" } });
      if (change === "grants") await f.store.admission.run(() => f.database.prepare("DELETE FROM account_grants WHERE account_id=?").run(f.owner.principalId));
      if (change === "deadline") f.clock.offset = 10001;
      if (change === "disconnect") { pending.call.destroy(); await new Promise<void>(r => setImmediate(r)); }
    } finally { release.open(); }
    if (change === "disconnect") await expect(pending.reply).rejects.toMatchObject({ code: "ECONNRESET" });
    else { const reply = await pending.reply; if (change === "grants") { expect(reply.status).toBe(200); expect(reply.body.projects).toEqual([]); } else { expect(reply.status).toBeGreaterThanOrEqual(400); expect(reply.body).not.toHaveProperty("actor"); } }
  });

  it.each(["/api/auth/sign-out", operationRoute])("shared browser origin conformance on %s using shared boundary assertion", async path => {
    const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200);
    const reply = await f.call(path, "{}", { Origin: "https://other.test" });
    assertCookieOrigin(reply);
  });
});


it("production shutdown retains SQLite and controller lock during a blocked real provider delete and repeated cookie disconnects", async () => {
  const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200);
  const entered = gate(), release = gate();
  f.faults.beforeSessionDelete = async () => { entered.open(); await release.promise; };
  const pending = f.send("/api/auth/sign-out"); await entered.promise;
  const resolutions = vi.spyOn(f.runtime(), "resolveRequest");
  const lockPath = join(f.root, "controller.lock"), lock = acquireControllerLock(lockPath);
  closes.push(() => lock.release());
  const shutdown = createControllerShutdown({ service: { closeAdmission() {}, shutdown: () => f.store.closeAfterDrain() },
    stopping: f.administration.stop, userSchedules: undefined, backups: { close() {} }, remoteVerification: null, mcp: null,
    controller: f.server, adminSocket: { close() {} }, authenticationProvider: f.administration, removeServiceAccess() {}, controllerLock: lock });
  try {
    for (let i = 0; i < 16; i++) {
      const reply = await f.call(); expect(reply.body.error).toMatchObject({ category: "busy", reason: "admission_refused" });
    }
    for (let i = 0; i < 16; i++) {
      const refusing = gate();
      // Hold only the finite refusal's end, so the real socket disconnect is
      // observed while the real provider delete remains blocked.
      f.server.server.prependOnceListener("request", (_req, response) => {
        response.end = (() => { refusing.open(); return response; }) as ServerResponse["end"];
      });
      const disconnected = f.send(); await refusing.promise; disconnected.call.destroy();
      await expect(disconnected.reply).rejects.toMatchObject({ code: "ECONNRESET" });
      await vi.waitFor(() => expect(f.administration.requestBudget.active).toBe(1));
    }
    expect(resolutions).not.toHaveBeenCalled();
    pending.call.destroy(); await expect(pending.reply).rejects.toMatchObject({ code: "ECONNRESET" });
    let finished = false; const closing = shutdown().then(() => { finished = true; });
    expect(f.administration.requestBudget.acquire("initiating")).toBeNull();
    expect(f.administration.requestBudget.acquire("completion")).toBeNull();
    await new Promise<void>(r => setImmediate(r));
    expect(finished).toBe(false); expect(f.database.open).toBe(true); expect(existsSync(lockPath)).toBe(true);
    release.open(); await closing; expect(f.database.open).toBe(false); expect(existsSync(lockPath)).toBe(false);
  } finally { release.open(); }
});


it("disposed real provider refuses the cookie path", async () => {
  const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200);
  await f.runtime().dispose();
  expectProviderUnavailable(await f.call());
});


it.each(["/api/auth/sign-out", operationRoute])("shared browser maintenance and configuration fences on %s", async path => {
  const f = await fixture(); await f.ready(); expect((await f.login()).status).toBe(200);
  const browser = vi.spyOn(f.runtime(), "browser"), resolution = vi.spyOn(f.runtime(), "resolveRequest");
  await f.administration.execute({ command: "auth-provider", action: "configure", input: { module: join(f.root, "provider.mjs"), origin: "https://changed.test", signingSecret: { kind: "preserve" } } });
  const changed = await f.call(path);
  if (path === operationRoute) expectProviderUnavailable(changed);
  else { expect(changed.status).toBe(503); expect(changed.body.code).toBe("database_unavailable"); }
  f.maintenance(); const stopped = await f.call(path); expect(stopped.status).toBe(503);
  expect(browser).not.toHaveBeenCalled(); expect(resolution).not.toHaveBeenCalled();
});
