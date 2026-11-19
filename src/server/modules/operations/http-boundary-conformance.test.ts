import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { createControllerOperationEligibility } from "@/server/bootstrap/authentication-provider-lifetime";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { createControllerServer } from "@/server/http-server";
import { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import type { ControlService } from "@/server/control-service";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { resolveAppPaths } from "@/server/paths";
import { createOperationsHttp, OPERATIONS_HTTP_LIMITS } from "@/server/transports/operations-http";
import { parseOperationsPath } from "@/server/transports/operations-path";
import { hash, iso, NOW, token } from "./adapters/credential-verifier-fixture";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const route = "/api/operations/session.describe";
const pause = () => { let done!: () => void; const promise = new Promise<void>(r => { done = r; }); return { promise, done }; };
type Headers = Record<string, string> | string[];
type Reply = { status: number; body: Record<string, any>; headers: IncomingMessage["headers"] }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fixture(mode = "open", limits?: Parameters<typeof createOperationsHttp>[0]["limits"], fault?: "omit_guard" | "early_release") {
  const root = mkdtempSync(join(tmpdir(), "operations-http-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath, undefined, { admission: "strict", admissionTimeoutMs: 100 });
  cleanups.push(() => store.close());
  const clock = { offset: 0 };
  const db = ownedFixtureDatabase(store), state = { maintenance: false, stopping: false, configChanged: false };
  const installation = token("wsi"), agent = token("wts"), credentialId = agent.slice(4, 40);
  await store.admission.run(() => {
    const policy = store.getAuthenticationPolicy();
    store.saveAuthenticationPolicy({ ...policy, mode: mode as "open", token: { id: installation.slice(4, 40), prefix: installation.slice(0, 40), verifierHash: hash(installation), createdAt: iso(NOW) } }, "fixture", "fixture");
    store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "fixture");
    store.saveCredential({ id: credentialId, principalId: "agent", kind: "agent_token", label: "fixture", tokenPrefix: agent.slice(0, 40), verifierHash: hash(agent), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
    for (const id of ["project-a", "project-b"]) store.saveKnowledgeProject({ id, name: id, status: "active", revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW) }, "fixture");
  });
  const socketPath = join(root, "admin.sock");
  let apiOpen = true, unixOpen = true;
  const eligibility = createControllerOperationEligibility({ maintenance: () => fault === "omit_guard" ? false : state.maintenance, stopping: () => state.stopping,
    configurationRestartRequired: () => state.configChanged, runtime: () => undefined });
  const built = buildOperationsRuntime({ store, activeMode: mode, now: () => Date.now() + clock.offset, logs: { controller() {} },
    eligibility, provider: null, listeners: { api: () => apiOpen, unix: () => unixOpen } });
  const hooks: { afterMint?: () => void | Promise<void>; legacy?: (body: unknown) => unknown } = {};
  const runtime = { ...built, mint: async (...args: Parameters<Extract<typeof built, { supported: true }>["mint"]>) => {
    const result = built.supported ? await built.mint(...args) : await built.mint(); if (result.ok) await hooks.afterMint?.(); return result;
  } };
  const oldAuthentication = { mode: () => mode as "open", authenticateInstallation: vi.fn(() => null), anonymousInstallation: vi.fn(() => null) };
  const legacy = vi.fn((body: unknown) => hooks.legacy ? hooks.legacy(body) : { echo: body });
  writeFileSync(join(root, "index.html"), "fixture");
  const controller = createControllerServer({ service: {} as ControlService, directoryBrowser: new DirectoryBrowser(root),
    events: new EventStream(), webRoot: root, host: "127.0.0.1", port: 0, accessToken: "synthetic-pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "none", activeSessions: 0 }),
    authentication: oldAuthentication, operations: runtime, maintenance: () => state.maintenance, admission: store.admission });
  await new Promise<void>(r => controller.server.listen(0, "127.0.0.1", r));
  cleanups.push(() => { apiOpen = false; return controller.close(); });
  const admin = await listenAdminSocket(socketPath, legacy, runtime);
  cleanups.push(() => { unixOpen = false; return admin.close(); });
  // A short-limit adapter uses the actual API listener too, never calls handle directly.
  if (limits) {
    const adapter = createOperationsHttp({ runtime, listener: "api", limits, externallyOwned: fault === "early_release" });
    controller.server.removeAllListeners("request");
    controller.server.on("request", (req, res) => { void adapter.handle(req, res); });
    cleanups.push(async () => { adapter.stop(); await adapter.drain(); });
  }
  const send = (listener: "api" | "unix", options: { path?: string; method?: string; headers?: Headers; body?: string; slow?: boolean } = {}) => {
    let call!: ClientRequest;
    const reply = new Promise<Reply>((resolve, reject) => {
      call = request({ ...(listener === "unix" ? { socketPath } : { hostname: "127.0.0.1", port: (controller.server.address() as AddressInfo).port }),
        path: options.path ?? route, method: options.method ?? "POST",
        headers: options.headers ?? { "Content-Type": "application/json" } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("error", reject);
        res.on("end", () => { try { resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); } });
      });
      call.on("error", reject);
      if (options.slow) { call.flushHeaders(); call.write("{"); } else call.end(options.body ?? "{}");
    });
    // Some cancellation assertions only inspect server-side evidence.
    void reply.catch(() => undefined);
    return { call, reply };
  };
  const grant = () => store.admission.run(() => db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent','reader','project','project-a',?)").run(iso(NOW)));
  return { store, state, db, built, runtime, send, hooks, oldAuthentication, legacy, controller, admin, installation, agent, credentialId, grant, clock };
}
const auth = (secret: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${secret}` });
const refusal = (reason: string, category = "unauthenticated", status = 401, retry = "reauthenticate") => ({ error: { category, status, reason, retry, effect: null } });

/** Shared outcome assertions, usable by later listener mounts and deliberate broken controls. */
function assertRefused(reply: Reply, prohibitedWork: number) { expect(reply.status).toBeGreaterThanOrEqual(400); expect(reply.body).not.toHaveProperty("actor"); expect(prohibitedWork).toBe(0); }
function assertOwned(owned: boolean) { expect(owned).toBe(true); }

describe("raw operations namespace", () => {
  it("claims malformed targets without normalizing them and reserves the later MCP path", () => {
    for (const suffix of ["../session.describe", "%2e%2e/session.describe", "session%2edescribe", "session.describe/", "/session.describe", "session.describe?x=1", "session%2fdescribe", "session%5cdescribe", "unknown.operation"]) {
      expect(parseOperationsPath(`/api/operations/${suffix}`, ["session.describe"])).toEqual({ claimed: true, surface: "api", operation: null });
    }
    for (const target of ["/api/operations?session.describe", "/api/operations%session.describe", "/api/operations%2fsession.describe"]) expect(parseOperationsPath(target, ["session.describe"])).toMatchObject({ claimed: true, operation: null });
    expect(parseOperationsPath(route, ["session.describe"])).toMatchObject({ operation: "session.describe" });
    expect(parseOperationsPath("/mcp/operations", [])).toMatchObject({ claimed: true, surface: "mcp" });
    expect(parseOperationsPath("/api/operations-old/session.describe", [])).toEqual({ claimed: false });
  });
});

describe("real API and unix acceptance", () => {
  it.each(["open", "token", "better-auth", "legacy"])("full wire matrix in %s, with no old authentication or usage write", async mode => {
    const f = await fixture(mode);
    const rows = ["none", "installation", "agent", "owner", "worker", "unknown", "cookie", "header"];
    for (const listener of ["api", "unix"] as const) for (const credential of rows) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (credential === "cookie") headers.Cookie = "__Secure-wtc.session=synthetic";
      else if (credential === "header") headers["X-Worktree-Control-Token"] = "synthetic-pairing";
      else if (credential !== "none") headers.Authorization = `Bearer ${credential === "installation" ? f.installation : credential === "agent" ? f.agent : credential === "owner" || credential === "worker" ? token("wts") : "unrecognized"}`;
      const r = await f.send(listener, { headers }).reply;
      const accepted = mode !== "legacy" && credential === "none" && (listener === "unix" || mode === "open")
        || listener === "api" && (mode === "token" && credential === "installation" || mode === "better-auth" && credential === "agent");
      if (accepted) {
        expect(r.status).toBe(200); expect(r.body).toMatchObject({ mode, listener, actor: { kind: listener === "unix" ? "operator" : mode === "better-auth" ? "agent" : "installation" } });
        expect(r.headers["cache-control"]).toBe("no-store");
      } else {
        const reason = credential === "cookie" ? "provider_cookie_not_supported" : mode === "legacy" ? "unknown_mode"
          : listener === "unix" ? "credential_on_local_listener" : credential === "unknown" || credential === "header" ? "unrecognized_credential"
          : mode === "open" ? "credential_in_open_mode" : credential === "none" ? "credential_required"
          : mode === "better-auth" && credential === "installation" ? "installation_token_in_account_mode"
          : mode === "better-auth" ? "invalid_credential" : "credential_not_accepted_here";
        expect(r.body).toEqual(refusal(reason));
      }
    }
    expect(f.oldAuthentication.authenticateInstallation).not.toHaveBeenCalled(); expect(f.oldAuthentication.anonymousInstallation).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
    await f.store.admission.run(() => expect(f.store.getCredentialForAuthentication(f.credentialId)?.lastUsedAt).toBeNull());
  });

  it("preserves duplicate and mixed raw credentials", async () => {
    const f = await fixture("token");
    for (const headers of [
      ["Content-Type", "application/json", "Authorization", `Bearer ${f.installation}`, "Authorization", `Bearer ${f.installation}`],
      { ...auth(f.installation), "X-Worktree-Control-Token": f.installation },
      { ...auth(f.installation), "X-Worktree-Switcher-Token": f.installation },
    ]) expect((await f.send("api", { headers }).reply).body).toEqual(refusal("mixed_credentials"));
    expect((await f.send("api", { headers: { ...auth(f.installation), Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("provider_cookie_not_supported"));
  });

  it("cookie refusal precedes body, admission and even saturated unix capacity", async () => {
    const f = await fixture("better-auth"), release = pause(), entered = pause();
    f.hooks.legacy = async () => { entered.done(); await release.promise; return {}; };
    const held = Array.from({ length: 32 }, () => f.send("unix", { path: "/auth" }));
    await entered.promise;
    let dataListeners = 0;
    const observe = (req: IncomingMessage) => req.on("newListener", event => { if (event === "data") dataListeners++; });
    f.admin.server.prependListener("request", observe);
    const mint = vi.spyOn(f.runtime, "mint");
    try {
      for (let i = 0; i < 35; i++) {
        expect((await f.send("unix", { slow: true, headers: { "Content-Type": "application/json", Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("provider_cookie_not_supported"));
      }
      expect(dataListeners).toBe(0); expect(mint).not.toHaveBeenCalled();
    } finally { release.done(); await Promise.all(held.map(h => h.reply)); }
  });

  it("refuses browser headers and every credential on unix", async () => {
    const f = await fixture();
    for (const headers of [{ Origin: "https://fixture.example" }, { "Sec-Fetch-Site": "none" }, { Cookie: "unrelated=x" }] as Record<string, string>[]) {
      expect((await f.send("unix", { headers: { "Content-Type": "application/json", ...headers } }).reply).body).toEqual(refusal("browser_headers_on_unix"));
    }
  });

  it("agent sees zero roles, then only its one project; body and headers grant no authority", async () => {
    const f = await fixture("better-auth");
    expect((await f.send("api", { headers: auth(f.agent) }).reply).body.projects).toEqual([]);
    await f.grant();
    const r = await f.send("api", { headers: { ...auth(f.agent), "X-Actor": "operator", "X-Session": "forged", "X-Listener": "unix" } }).reply;
    expect(r.body.actor.kind).toBe("agent"); expect(r.body.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["project-a"]);
    for (const body of ['{"actor":"operator"}', '{"session":"forged"}', '{"listener":"unix"}']) expect((await f.send("api", { headers: auth(f.agent), body }).reply).body).toEqual(refusal("unexpected_input", "invalid_request", 400, "none"));
  });

  it("strict JSON, content type, path and all method refusals remain terminal on both listeners", async () => {
    const f = await fixture();
    for (const listener of ["api", "unix"] as const) {
      for (const body of ['{"x":1,"x":2}', '{} {}', '[]', 'null', '1', '"text"']) expect((await f.send(listener, { body }).reply).status).toBe(400);
      expect((await f.send(listener, { headers: { "Content-Type": "text/plain" } }).reply).status).toBe(400);
      for (const path of [route + "/", route + "?x=1", "/api/operations//session.describe", "/api/operations/../session.describe", "/api/operations/%2e/session.describe", "/api/operations/session%2edescribe", "/api/operations/unknown.operation"]) {
        expect((await f.send(listener, { path }).reply).body).toEqual(refusal("operation_not_found", "not_found", 404, "none"));
      }
      for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) expect((await f.send(listener, { method }).reply).body).toEqual(refusal("method_not_allowed", "invalid_request", 400, "none"));
    }
    expect(f.legacy).not.toHaveBeenCalled(); expect(f.oldAuthentication.anonymousInstallation).not.toHaveBeenCalled();
  });

  it("keeps legacy paths working in legacy mode, five per listener", async () => {
    const f = await fixture("legacy");
    for (const command of ["status", "project", "backup", "identity-admin", "auth-provider"]) {
      expect((await f.send("unix", { path: "/auth", body: JSON.stringify({ command }) }).reply).body).toEqual({ result: { echo: { command } } });
    }
    for (const path of ["/", "/index.html", "/api/auth/status", "/api/unknown", "/api/operations-old/session.describe"]) {
      const reply = await new Promise<number>((resolve, reject) => {
        const call = request({ hostname: "127.0.0.1", port: (f.controller.server.address() as AddressInfo).port, path }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }); call.on("error", reject); call.end();
      });
      expect(reply).toBe(path === "/" || path === "/index.html" || path === "/api/auth/status" ? 200 : 401);
    }
  });
});

describe("boundary conformance through real listeners", () => {
  it.each(["api", "unix"] as const)("%s keeps maintenance refusal and origin policy without application work", async listener => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    f.state.maintenance = true;
    assertRefused(await f.send(listener).reply, mint.mock.calls.length);
    f.state.maintenance = false;
    if (listener === "api") assertRefused(await f.send(listener, { headers: { "Content-Type": "application/json", Origin: "https://foreign.example" } }).reply, mint.mock.calls.length);
    // Configuration belongs to provider sessions. No provider call is permitted in 5a.
    f.state.configChanged = true;
    expect((await f.send(listener).reply).status).toBe(200);
  });

  it.each(["api", "unix"] as const)("%s enforces byte ceilings before mint", async listener => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    assertRefused(await f.send(listener, { body: JSON.stringify({ padding: "x".repeat(listener === "api" ? 65536 : 16384) }) }).reply, mint.mock.calls.length);
  });

  it("bounds a slow body and response on real HTTP", async () => {
    const f = await fixture("open", { deadlineMs: 50, responseBytes: 32 });
    expect((await f.send("api", { slow: true }).reply).status).toBeGreaterThanOrEqual(400);
    expect((await f.send("api").reply).body).toEqual(refusal("response_too_large", "payload_too_large", 413, "none"));
  });

  it.each(["grant", "revoke", "rotate", "maintenance", "shutdown", "disconnect", "deadline"])("revalidates %s between mint and actual write", async change => {
    const f = await fixture(change === "rotate" ? "token" : "better-auth");
    await f.grant();
    const entered = pause(), release = pause();
    f.hooks.afterMint = async () => { entered.done(); await release.promise; };
    const r = f.send("api", { headers: auth(change === "rotate" ? f.installation : f.agent) });
    await entered.promise;
    if (change === "grant") await f.store.admission.run(() => f.db.prepare("DELETE FROM account_grants WHERE account_id='agent'").run());
    if (change === "revoke") await f.store.admission.run(() => f.db.prepare("UPDATE principal_credentials SET status='revoked' WHERE id=?").run(f.credentialId));
    if (change === "rotate") await f.store.admission.run(() => { const p = f.store.getAuthenticationPolicy(); f.store.saveAuthenticationPolicy({ ...p, token: { ...p.token!, verifierHash: hash(token("wsi")) } }, "fixture", "fixture"); });
    if (change === "maintenance") f.state.maintenance = true;
    if (change === "shutdown") f.state.stopping = true;
    if (change === "disconnect") { r.call.destroy(); await new Promise<void>(done => setImmediate(done)); }
    if (change === "deadline") f.clock.offset = OPERATIONS_HTTP_LIMITS.deadlineMs + 1;
    release.done();
    if (change === "disconnect") await expect(r.reply).rejects.toThrow();
    else {
      const reply = await r.reply;
      if (change === "grant") { expect(reply.status).toBe(200); expect(reply.body.projects).toEqual([]); }
      else expect(reply.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("shares the unix ceiling with /auth and drains started work after disconnect", async () => {
    const f = await fixture(), entered = pause(), release = pause();
    let active = 0;
    f.hooks.legacy = async () => { active++; if (active === 16) entered.done(); await release.promise; return {}; };
    const held = Array.from({ length: 16 }, () => f.send("unix", { path: "/auth" }));
    const bodies = Array.from({ length: 16 }, () => f.send("unix", { slow: true }));
    await entered.promise;
    // A final request is ordered after the slow bodies on this local listener.
    expect((await f.send("unix").reply).status).toBe(503);
    expect((await f.send("unix", { path: "/auth" }).reply).status).toBe(503);
    for (const h of [...held, ...bodies]) h.call.destroy();
    let drained = false;
    const closing = f.admin.close().then(() => { drained = true; });
    await new Promise<void>(r => setImmediate(r)); assertOwned(!drained);
    release.done(); await closing; expect(drained).toBe(true);
  });

  it("shutdown retains database and lock until an admitted request settles", async () => {
    const f = await fixture(), entered = pause(), release = pause();
    f.hooks.afterMint = async () => { entered.done(); await release.promise; };
    const pending = f.send("api"); await entered.promise;
    const closedStore = vi.fn(), releasedLock = vi.fn();
    const shutdown = createControllerShutdown({ service: { closeAdmission() {}, shutdown: async () => { closedStore(); } },
      stopping: () => { f.state.stopping = true; }, userSchedules: undefined, backups: { close() {} }, remoteVerification: null, mcp: null,
      controller: f.controller, adminSocket: f.admin, removeServiceAccess() {}, controllerLock: { release: releasedLock } as never });
    const stopping = shutdown();
    expect(f.state.stopping).toBe(true); expect(closedStore).not.toHaveBeenCalled(); expect(releasedLock).not.toHaveBeenCalled();
    release.done(); expect((await pending.reply).status).toBeGreaterThanOrEqual(400);
    await stopping; expect(closedStore).toHaveBeenCalledOnce(); expect(releasedLock).toHaveBeenCalledOnce();
  });

  it("negative control: the same maintenance assertion fails when eligibility is omitted", async () => {
    const f = await fixture("open", undefined, "omit_guard");
    f.state.maintenance = true;
    const reply = await f.send("api").reply;
    expect(() => assertRefused(reply, reply.status === 200 ? 1 : 0)).toThrow();
  });

  async function disconnectedCapacity(f: Awaited<ReturnType<typeof fixture>>) {
    const entered = pause(), release = pause(); let first = true;
    f.hooks.afterMint = async () => { if (first) { first = false; entered.done(); await release.promise; } };
    const pending = f.send("api"); await entered.promise;
    pending.call.destroy(); await new Promise<void>(done => setImmediate(done));
    try { expect((await f.send("api").reply).status).toBe(503); }
    finally { release.done(); }
  }
  it("retains API capacity until disconnected work settles", async () => {
    await disconnectedCapacity(await fixture("open", { maxInFlight: 1 }));
  });
  it("negative control: the same capacity assertion fails with an unowned early release", async () => {
    await expect(disconnectedCapacity(await fixture("open", { maxInFlight: 1 }, "early_release"))).rejects.toThrow();
  });

  it("negative control: the same release assertion fails on a buffered premature success", async () => {
    const f = await fixture(), entered = pause(), release = pause();
    if (!f.built.supported) throw new Error("supported runtime required");
    const runner = f.built.runner;
    vi.spyOn(runner, "readRelease").mockImplementation(async (operation, context, raw, options) => {
      if (operation.kind === "stream") throw new Error("read required");
      const result = await runner.run(operation, context, raw, { signal: options.signal });
      entered.done(); await release.promise;
      if (!result.ok) return { status: "refused", error: result.error };
      options.commit(result.value); return { status: "committed" };
    });
    const pending = f.send("api"); await entered.promise;
    f.state.maintenance = true; release.done();
    const reply = await pending.reply;
    expect(() => assertRefused(reply, 0)).toThrow();
  });

  it("holds capacity through response completion, after admitted work returns", async () => {
    const f = await fixture("open", { maxInFlight: 1 }), intercepted = pause();
    let finish: (() => void) | undefined;
    const hold = (_req: IncomingMessage, response: ServerResponse) => {
      f.controller.server.off("request", hold);
      const end = response.end.bind(response);
      response.end = ((...args: Parameters<ServerResponse["end"]>) => { finish = () => { end(...args); }; intercepted.done(); return response; }) as ServerResponse["end"];
    };
    f.controller.server.prependListener("request", hold);
    const pending = f.send("api"); await intercepted.promise;
    try { expect((await f.send("api").reply).status).toBe(503); }
    finally { finish?.(); }
    expect((await pending.reply).status).toBe(200);
    expect((await f.send("api").reply).status).toBe(200);
  });

  it("uses the socket's real ten second deadline for a slow operations body", async () => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    const reply = await f.send("unix", { slow: true }).reply;
    assertRefused(reply, mint.mock.calls.length);
  }, 15_000);
});
