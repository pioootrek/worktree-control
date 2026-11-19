import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { AuthenticationService } from "@/server/modules/authentication";
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
import { createOperationsHttp, operationsFailure, OPERATIONS_HTTP_LIMITS } from "@/server/transports/operations-http";
import { parseOperationsPath } from "@/server/transports/operations-path";
import { hash, iso, NOW, token } from "./adapters/credential-verifier-fixture";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const route = "/api/operations/session.describe";
const pause = () => { let done!: () => void; const promise = new Promise<void>(r => { done = r; }); return { promise, done }; };
type Headers = Record<string, string> | string[];
type Reply = { status: number; body: Record<string, any>; headers: IncomingMessage["headers"] }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fixture(mode = "open", limits?: Parameters<typeof createOperationsHttp>[0]["limits"], fault?: "omit_guard" | "early_release" | "unmounted") {
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
  const provider = { isSessionAuthorityEligible: vi.fn(() => true) };
  const built = buildOperationsRuntime({ store, activeMode: mode, now: () => Date.now() + clock.offset, logs: { controller() {} },
    eligibility, provider: mode === "better-auth" ? provider : null, listeners: { api: () => apiOpen, unix: () => unixOpen } });
  const hooks: { beforeMint?: (signal: AbortSignal | undefined) => void; afterMint?: () => void | Promise<void>; legacy?: (body: unknown) => unknown } = {};
  const runtime = { ...built, mint: async (...args: Parameters<Extract<typeof built, { supported: true }>["mint"]>) => {
    hooks.beforeMint?.(args[3].signal);
    const result = built.supported ? await built.mint(...args) : await built.mint(); if (result.ok) await hooks.afterMint?.(); return result;
  } };
  const authentication = await store.admission.run(() => new AuthenticationService(store));
  const oldAuthentication = { mode: () => authentication.mode(),
    authenticateInstallation: vi.fn((secret: string) => authentication.authenticateInstallation(secret)),
    anonymousInstallation: vi.fn(() => authentication.anonymousInstallation()) };
  const addProject = vi.fn(async () => ({ id: "fixture" }));
  const legacy = vi.fn((body: unknown) => { if (state.maintenance) throw new Error("Controller is in maintenance."); return hooks.legacy ? hooks.legacy(body) : { echo: body }; });
  writeFileSync(join(root, "index.html"), "fixture");
  const controller = createControllerServer({ service: { addProject } as unknown as ControlService, directoryBrowser: new DirectoryBrowser(root),
    events: new EventStream(), webRoot: root, host: "127.0.0.1", port: 0, accessToken: "synthetic-pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "none", activeSessions: 0 }),
    authentication: oldAuthentication, operations: fault === "unmounted" ? undefined : runtime, maintenance: () => state.maintenance, admission: store.admission });
  await new Promise<void>(r => controller.server.listen(0, "127.0.0.1", r));
  cleanups.push(() => { apiOpen = false; return controller.close(); });
  const admin = await listenAdminSocket(socketPath, legacy, fault === "unmounted" ? undefined : runtime);
  cleanups.push(() => { unixOpen = false; return admin.close(); });
  // A short-limit adapter uses the actual API listener too, never calls handle directly.
  if (limits) {
    const adapter = createOperationsHttp({ runtime, listener: "api", limits, externallyOwned: fault === "early_release" });
    controller.server.removeAllListeners("request");
    let active = 0;
    controller.server.on("request", (req, res) => {
      if (fault === "early_release") {
        if (active >= 1) { operationsFailure(res, { category: "busy", status: 503, reason: "listener_capacity", retry: "retry", effect: null }); return; }
        active++;
        // Deliberately broken owner: releases on disconnect while application work is pending.
        res.once("close", () => { active--; });
      }
      void adapter.handle(req, res);
    });
    cleanups.push(async () => { adapter.stop(); await adapter.drain(); });
  }
  const send = (listener: "api" | "unix", options: { path?: string; method?: string; headers?: Headers; body?: string; slow?: boolean } = {}) => {
    let call!: ClientRequest;
    const reply = new Promise<Reply>((resolve, reject) => {
      call = request({ ...(listener === "unix" ? { socketPath } : { hostname: "127.0.0.1", port: (controller.server.address() as AddressInfo).port }),
        path: options.path ?? route, method: options.method ?? "POST",
        headers: options.headers ?? { "Content-Type": "application/json" } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("error", reject);
        res.on("end", () => { try { resolve({ status: res.statusCode!, headers: res.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} }); } catch (e) { reject(e); } });
      });
      call.on("error", reject);
      if (options.slow) { call.flushHeaders(); call.write("{"); } else call.end(options.body ?? "{}");
    });
    // Some cancellation assertions only inspect server-side evidence.
    void reply.catch(() => undefined);
    return { call, reply };
  };
  const grant = () => store.admission.run(() => db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent','reader','project','project-a',?)").run(iso(NOW)));
  return { store, state, db, built, runtime, send, hooks, oldAuthentication, legacy, controller, admin, installation, agent, credentialId, grant, clock, socketPath, provider, addProject };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const h2c = { Connection: "Upgrade, HTTP2-Settings", Upgrade: "h2c", "HTTP2-Settings": "" };
async function wire(f: Fixture, listener: "api" | "unix", path: string, method = "GET", upgrade = false) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const call = request({ ...(listener === "unix" ? { socketPath: f.socketPath }
      : { hostname: "127.0.0.1", port: (f.controller.server.address() as AddressInfo).port }),
      path, method, headers: { "Content-Type": "application/json", ...(upgrade ? h2c : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    call.setTimeout(2000, () => call.destroy(new Error("Wire response timed out")));
    call.on("error", reject); call.end(method === "POST" ? '{"command":"status"}' : undefined);
  });
}
async function protocolWire(f: Fixture, listener: "api" | "unix", path: string, method: "CONNECT" | "GET") {
  return new Promise<string>((resolve, reject) => {
    const socket = listener === "unix" ? createConnection(f.socketPath)
      : createConnection((f.controller.server.address() as AddressInfo).port, "127.0.0.1");
    cleanups.push(() => { socket.destroy(); });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Protocol response timed out")); });
    const chunks: Buffer[] = [];
    socket.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.on("error", reject); socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("connect", () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close${method === "GET" ? ", Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings:" : ""}\r\n\r\n`));
  });
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
          : listener === "unix" ? "credential_on_local_listener" : credential === "header" ? "legacy_credential" : credential === "unknown" ? "unrecognized_credential"
          : mode === "open" ? "credential_in_open_mode" : credential === "none" ? "credential_required"
          : mode === "better-auth" && credential === "installation" ? "installation_token_in_account_mode"
          : mode === "better-auth" ? "invalid_credential" : "credential_not_accepted_here";
        expect(r.body).toEqual(refusal(reason));
      }
    }
    expect(f.oldAuthentication.authenticateInstallation.mock.calls.length).toBe(0); expect(f.oldAuthentication.anonymousInstallation.mock.calls.length).toBe(0); expect(f.legacy).not.toHaveBeenCalled();
    await f.store.admission.run(() => expect(f.store.getCredentialForAuthentication(f.credentialId)?.lastUsedAt).toBeNull());
  });

  it("preserves legacy h2c status and bodies against listeners without the operations mount", async () => {
    const old = await fixture("open", undefined, "unmounted"), mounted = await fixture();
    for (const listener of ["api", "unix"] as const) {
      const targets = listener === "api" ? [["/", "GET"], ["/index.html", "GET"], ["/api/auth/status", "GET"], ["/api/status", "GET"]]
        : [["/auth", "POST"], ["/api/status", "GET"], ["/unknown", "GET"]];
      for (const [path, method] of targets) {
        const baseline = await wire(old, listener, path, method);
        expect(await wire(old, listener, path, method, true)).toEqual(baseline);
        expect(await wire(mounted, listener, path, method)).toEqual(baseline);
        expect(await wire(mounted, listener, path, method, true)).toEqual(baseline);
      }
      for (const path of ["/auth", "/api/status", "example.invalid:443"]) {
        expect(await protocolWire(old, listener, path, "CONNECT")).toBe("");
        expect(await protocolWire(mounted, listener, path, "CONNECT")).toBe("");
      }
      const response = await protocolWire(mounted, listener, route, "GET");
      expect(response).toContain("400 Bad Request");
      expect(response).toContain(JSON.stringify(refusal("method_not_allowed", "invalid_request", 400, "none")));
    }
  });

  it.each(["api", "unix"] as const)("negative control: the old %s Upgrade listener fails legacy parity", async listener => {
    const f = await fixture();
    const path = listener === "api" ? "/api/auth/status" : "/auth", method = listener === "api" ? "GET" : "POST";
    const baseline = await wire(f, listener, path, method);
    // Reproduce the old listener exactly for unclaimed targets, on the real mount.
    f[listener === "api" ? "controller" : "admin"].server.on("upgrade", (_request, socket) => socket.destroy());
    const broken = await wire(f, listener, path, method, true).catch(() => null);
    expect(() => expect(broken).toEqual(baseline)).toThrow();
  });

  it("refuses normalized aliases before all legacy work, with cookie refusal first", async () => {
    const f = await fixture("better-auth");
    const admission = vi.spyOn(f.store.admission, "run"), mint = vi.spyOn(f.runtime, "mint");
    let reads = 0;
    for (const server of [f.controller.server, f.admin.server]) server.prependListener("request", req => {
      req.on("newListener", event => { if (event === "data") reads++; });
    });
    const aliases: string[] = [];
    for (const namespace of ["/api/operations", "/mcp/operations"]) {
      aliases.push(`/./${namespace.slice(1)}`, `/x/../${namespace.slice(1)}`, `/${namespace}`, `/\\${namespace.slice(1)}`,
        namespace.replace("/operations", "//operations"), namespace.replace("/operations", "\\operations"),
        namespace.replace("/operations", "%2foperations"), namespace.replace("/operations", "%5Coperations"),
        namespace.replace("operations", "%6fperations"), `${namespace}/%2e`, `${namespace}/x/%2e%2e`);
      for (const dot of [".", "%2e", "%2E"]) {
        aliases.push(`/${dot}/${namespace.slice(1)}`, namespace.replace("/operations", `/${dot}/operations`),
          `/\\${dot}%2f${namespace.slice(1).replace("/", "//")}`);
      }
      for (const dots of ["..", ".%2e", "%2e.", "%2e%2E"]) {
        aliases.push(`/x/${dots}/${namespace.slice(1)}`, namespace.replace("/operations", `/x/${dots}/operations`));
      }
    }
    for (const listener of ["api", "unix"] as const) for (const alias of aliases) {
      for (const method of ["GET", "POST", "OPTIONS"]) for (const cookie of [false, true]) {
        const headers = { "Content-Type": "application/json", ...(cookie ? { Cookie: "wtc.session=x" } : {}) };
        const reply = await f.send(listener, { path: alias + "/session.describe", method, headers }).reply;
        expect(reply.status, `${listener} ${method} ${alias} cookie=${cookie}`).toBe(cookie ? 401 : 404);
        expect(reply.body).toEqual(cookie ? refusal("provider_cookie_not_supported") : refusal("operation_not_found", "not_found", 404, "none"));
      }
    }
    expect(admission).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled(); expect(reads).toBe(0);
    expect(f.oldAuthentication.authenticateInstallation).not.toHaveBeenCalled();
    expect(f.oldAuthentication.anonymousInstallation).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
    expect(f.provider.isSessionAuthorityEligible).not.toHaveBeenCalled();
  }, 30000);

  it("keeps near-prefix legacy targets identical to the unmounted listeners", async () => {
    const old = await fixture("open", undefined, "unmounted"), mounted = await fixture();
    const targets = ["/api/operationsX", "/api/operations.json", "/api/operations-old/session.describe", "/api/operations_",
      "/api/operation", "/api/status", "/mcp/operationsX", "/mcp/operations.json", "/mcp/operations-old", "/mcp/operation",
      "/./api/operationsX", "/api/x/../operations.json", "/%2e/api/operationsX", "//api/operationsX", "/api%2foperationsX"];
    for (const listener of ["api", "unix"] as const) for (const path of targets) {
      expect(parseOperationsPath(path, ["session.describe"])).toEqual({ claimed: false });
      for (const method of ["GET", "POST", "OPTIONS"]) {
        expect(await wire(mounted, listener, path, method)).toEqual(await wire(old, listener, path, method));
      }
    }
  });

  it("always answers unsupported mode even if mint unexpectedly succeeds", async () => {
    const f = await fixture("legacy");
    const mint = vi.spyOn(f.runtime, "mint").mockResolvedValue({ ok: true, context: {} } as never);
    for (const listener of ["api", "unix"] as const) {
      expect((await f.send(listener).reply).body).toEqual(refusal("unknown_mode"));
    }
    expect(mint).toHaveBeenCalledTimes(2); expect(f.legacy).not.toHaveBeenCalled();
    expect(f.oldAuthentication.authenticateInstallation).not.toHaveBeenCalled();
    expect(f.oldAuthentication.anonymousInstallation).not.toHaveBeenCalled();
  });

  it("preserves duplicate and mixed raw credentials", async () => {
    const f = await fixture("token");
    for (const headers of [
      ["Host", "localhost", "Content-Type", "application/json", "Content-Length", "2", "Authorization", `Bearer ${f.installation}`, "Authorization", `Bearer ${f.installation}`],
      { ...auth(f.installation), "X-Worktree-Control-Token": f.installation },
      { ...auth(f.installation), "X-Worktree-Switcher-Token": f.installation },
    ]) expect((await f.send("api", { headers }).reply).body).toEqual(refusal("mixed_credentials"));
    expect((await f.send("api", { headers: { ...auth(f.installation), Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("provider_cookie_not_supported"));
  });

  it("cookie refusal precedes body, admission and even saturated unix capacity", async () => {
    const f = await fixture("better-auth"), release = pause(), entered = pause();
    let count = 0;
    f.hooks.legacy = async () => { if (++count === 32) entered.done(); await release.promise; return {}; };
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
      expect(dataListeners).toBe(0); expect(mint.mock.calls.length).toBe(0); expect(f.provider.isSessionAuthorityEligible.mock.calls.length).toBe(0);
    } finally { release.done(); await Promise.all(held.map(h => h.reply)); }
  });

  it.each(["token", "better-auth"])("accepts bearer-like token headers in %s without invoking the old resolver", async mode => {
    const f = await fixture(mode);
    for (const name of ["X-Worktree-Control-Token", "X-Worktree-Switcher-Token"]) {
      expect((await f.send("api", { headers: { "Content-Type": "application/json", [name]: mode === "token" ? f.installation : f.agent } }).reply).status).toBe(200);
    }
    expect(f.oldAuthentication.authenticateInstallation.mock.calls.length).toBe(0);
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
    expect(f.legacy).not.toHaveBeenCalled(); expect(f.oldAuthentication.anonymousInstallation.mock.calls.length).toBe(0);
  });

  it("answers HEAD, CONNECT and Upgrade inside the namespace on both actual listeners", async () => {
    const f = await fixture();
    for (const listener of ["api", "unix"] as const) {
      expect((await f.send(listener, { method: "HEAD" }).reply).status).toBe(400);
      for (const method of ["CONNECT", "GET"]) {
        const raw = await new Promise<string>((resolve, reject) => {
          const socket = listener === "unix" ? createConnection(f.socketPath) : createConnection((f.controller.server.address() as AddressInfo).port, "127.0.0.1");
          cleanups.push(() => { socket.destroy(); });
          socket.setTimeout(1000, () => { socket.destroy(); reject(new Error(`${listener} ${method} protocol response timed out`)); });
          const chunks: Buffer[] = []; socket.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))); socket.on("error", reject);
          socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
          socket.on("connect", () => socket.write(`${method} ${route} HTTP/1.1\r\nHost: localhost\r\n${method === "GET" ? "Connection: Upgrade\r\nUpgrade: websocket\r\n" : ""}\r\n`));
        });
        expect(raw).toContain("400 Bad Request"); expect(raw).toContain('"reason":"method_not_allowed"');
      }
    }
    expect(f.oldAuthentication.authenticateInstallation.mock.calls.length).toBe(0); expect(f.legacy.mock.calls.length).toBe(0);
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
    // Run the same outcome assertion against the existing neighbour.
    const effect = vi.fn(); f.hooks.legacy = effect;
    const old = await f.send(listener, { path: listener === "api" ? "/api/projects" : "/auth" }).reply;
    assertRefused(old, listener === "api" ? f.addProject.mock.calls.length : effect.mock.calls.length);
    f.state.maintenance = false;
    if (listener === "api") assertRefused(await f.send(listener, { headers: { "Content-Type": "application/json", Origin: "https://foreign.example" } }).reply, mint.mock.calls.length);
    // Configuration belongs to provider sessions. No provider call is permitted in 5a.
    f.state.configChanged = true;
    expect((await f.send(listener).reply).status).toBe(200);
  });

  it.each(["api", "unix"] as const)("%s enforces byte ceilings before mint", async listener => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    const body = JSON.stringify({ padding: "x".repeat(listener === "api" ? 65536 : 16384) });
    assertRefused(await f.send(listener, { body }).reply, mint.mock.calls.length);
    const effect = vi.fn(); f.hooks.legacy = effect;
    assertRefused(await f.send(listener, { path: listener === "api" ? "/api/projects" : "/auth", body }).reply,
      listener === "api" ? f.addProject.mock.calls.length : effect.mock.calls.length);
  });

  it("bounds a slow body and response on real HTTP", async () => {
    const f = await fixture("open", { deadlineMs: 50, responseBytes: 32 });
    expect((await f.send("api", { slow: true }).reply).status).toBeGreaterThanOrEqual(400);
    expect((await f.send("api").reply).body).toEqual(refusal("response_too_large", "payload_too_large", 413, "none"));
  });

  it("commits exactly one 413 envelope for an oversized response", async () => {
    const f = await fixture("open", { responseBytes: 32 });
    if (!f.runtime.supported) throw new Error("Expected a supported fixture");
    const runner = vi.spyOn(f.runtime.runner, "readRelease");
    const writes: ReturnType<typeof vi.spyOn>[] = [], ends: ReturnType<typeof vi.spyOn>[] = [];
    f.controller.server.prependListener("request", (_req, res) => {
      writes.push(vi.spyOn(res, "writeHead")); ends.push(vi.spyOn(res, "end"));
    });
    const reply = await f.send("api").reply;
    expect(reply.status).toBe(413);
    expect(reply.body).toEqual(refusal("response_too_large", "payload_too_large", 413, "none"));
    expect(writes).toHaveLength(1); expect(writes[0]).toHaveBeenCalledOnce();
    expect(ends).toHaveLength(1); expect(ends[0]).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledOnce(); expect(await runner.mock.results[0].value).toMatchObject({ status: "committed" });
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

  it("keeps the API's 32-request bound before body reads, with cookies excluded", async () => {
    const f = await fixture(); let reading = 0; const ready = pause();
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data" && ++reading === 32) ready.done(); }));
    const held = Array.from({ length: 32 }, () => f.send("api", { slow: true }));
    await ready.promise;
    try {
      expect((await f.send("api").reply).body).toEqual(refusal("listener_capacity", "busy", 503, "retry"));
      expect((await f.send("api", { slow: true, headers: { Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("provider_cookie_not_supported"));
      expect(reading).toBe(32);
    } finally { for (const pending of held) pending.call.destroy(); }
  });

  it("refuses admission contention while real provider storage is pending, and cancels a queued disconnected request", async () => {
    const f = await fixture(), entered = pause(), release = pause();
    const borrow = f.store.authenticationProviderStorage().borrow(async () => { entered.done(); await release.promise; });
    await entered.promise;
    const effect = vi.fn(); f.hooks.afterMint = effect;
    try {
      const reply = await f.send("api").reply;
      expect(reply.body).toEqual(refusal("admission_refused", "busy", 503, "retry"));
      assertRefused(reply, effect.mock.calls.length);
      const queued = pause(), cancelled = pause();
      f.hooks.beforeMint = signal => { queued.done(); signal?.addEventListener("abort", cancelled.done, { once: true }); };
      const pending = f.send("api"); await queued.promise;
      pending.call.destroy(); await cancelled.promise;
      await expect(pending.reply).rejects.toThrow();
    } finally { release.done(); await borrow; }
    expect(effect.mock.calls.length).toBe(0);
    expect((await f.send("api").reply).status).toBe(200);
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
    const entered = pause(), release = pause(), disconnected = pause(); let first = true;
    f.hooks.beforeMint = signal => { if (first) signal?.addEventListener("abort", disconnected.done, { once: true }); };
    f.hooks.afterMint = async () => { if (first) { first = false; entered.done(); await release.promise; } };
    const pending = f.send("api"); await entered.promise;
    pending.call.destroy(); await expect(pending.reply).rejects.toThrow();
    // Observe the exact abort propagated to the pending request rather than a timer tick.
    await disconnected.promise;
    try { expect((await f.send("api").reply).status).toBe(503); }
    finally { release.done(); }
  }
  it("retains API capacity until disconnected work settles", async () => {
    await disconnectedCapacity(await fixture("open", { maxInFlight: 1 }));
  });
  it("negative control: the same capacity assertion fails when its owner releases early", async () => {
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

  it.each(["api", "unix"] as const)("%s writes success only inside real core admission and hides credential IDs", async listener => {
    const f = await fixture("token"); let admittedWrite = false;
    const server = listener === "api" ? f.controller.server : f.admin.server;
    server.prependListener("request", (_req, response) => {
      const writeHead = response.writeHead.bind(response);
      response.writeHead = ((...args: Parameters<ServerResponse["writeHead"]>) => {
        if (args[0] === 200) { f.store.getAuthenticationPolicy(); admittedWrite = true; }
        return writeHead(...args);
      }) as ServerResponse["writeHead"];
    });
    const reply = await f.send(listener, { headers: listener === "api" ? auth(f.installation) : undefined }).reply;
    expect(reply.status).toBe(200); expect(admittedWrite).toBe(true);
    expect(JSON.stringify(reply.body).includes(f.credentialId)).toBe(false);
    expect(JSON.stringify(reply.body).includes(f.installation.slice(4, 40))).toBe(false);
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
