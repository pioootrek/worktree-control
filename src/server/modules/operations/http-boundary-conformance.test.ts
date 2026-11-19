import { execFileSync } from "node:child_process";
import { IdentityService } from "@/server/modules/identity";
import type { RemoteVerificationController } from "@/server/modules/remote-verification";
import { createRemoteVerificationServer } from "@/server/transports/remote-verification-http";
import { createRemoteVerificationRuntime } from "@/cli/remote-verification-runtime";
import { createProviderWorld } from "./adapters/provider-session-fixture";
import { AuthenticationRequestBudget } from "@/server/bootstrap/authentication-request-budget";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { AuthenticationProviderError, AuthenticationService } from "@/server/modules/authentication";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import * as authenticationHttp from "@/server/transports/authentication-http";
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
import { acquireControllerLock } from "@/server/controller-lock";
import { createBoundaryDriver, assertCookieOrigin, assertCookieRequiredOrigin, assertCookieCapacity, assertCookieRelease, conform, ConformanceFailure, operationRoute, type BoundaryDriver, type Reply, type WireReply } from "./http-boundary-driver";
import { hash, iso, NOW, token } from "./adapters/credential-verifier-fixture";

/** Neighbour checklist from PR #161 (source lines at its mounting review).
 * Each row names an executable test below; controlled seams are labelled there.
 * API (12 rows):
 * :410 raw target                  | strict JSON, content type, path and all method refusals; normalized aliases
 * :418 mixed credentials           | preserves duplicate and mixed raw credentials
 * :423 browser/cookie hand-off     | cookie refusal precedes body, admission and even saturated unix capacity
 * :430 admission/safe failures     | matches legacy Retry-After during real provider-storage contention
 * :219 body ceiling                | %s enforces production byte ceilings before mint
 * :383/:445 maintenance after wait | %s keeps maintenance refusal; revalidates maintenance before releasing a buffered response
 * :337 origin                     | %s keeps maintenance refusal and origin policy without application work
 * :630 credential revalidation     | revalidates grant/revoke/rotate/maintenance/shutdown/disconnect/deadline between mint and actual write
 * :236 no-store/JSON/security      | full wire matrix; uses security headers and terminal finite JSON replies
 * provider-lifetime.ts:20 reserve  | closes D1a-5a reserve deferral (real-provider CLI lifecycle cookie proof)
 * :673 SSE lifetime                | uses security headers and terminal finite JSON replies (finite read ends, no SSE owner applies)
 * :952 listener close/drain        | shutdown retains the real open SQLite handle and lock record; half-open and reset protocol clients
 * Unix (9 rows):
 * :32 directory/socket privacy     | keeps real admin directory/socket permissions private
 * :56 POST /auth                   | keeps legacy paths working in legacy mode (unix executor stubbed); preserves legacy h2c status and bodies
 * :35 work/closing/32              | shares the real unix ceiling and drain with a stubbed /auth executor; shutdown retains the real open SQLite handle
 * :65 body/project exception       | %s enforces production byte ceilings; refuses project-command exception on operations
 * :59 body deadline                | uses the socket's real ten second deadline; revalidates deadline between mint and actual write (real runtime clock)
 * :69 UTF-8/protected JSON         | rejects malformed UTF-8 and duplicate singleton headers; strict JSON, content type, path and all method refusals
 * :84 provider response ceiling    | controlled adapter: commits exactly one 413 envelope (DTO bound, provider-only ceiling does not apply)
 * :102 disconnect/close drain      | shares the real unix ceiling and drain; real socket backpressure; controlled adapter/end hook
 * shutdown.ts:58 storage/lock       | shutdown retains the real open SQLite handle and lock record until an admitted request settles
 * Total: 21 rows mapped to executable assertions, including real-provider completion reserve on API.
 * Worker assertions below extend the shared driver/helpers. MCP/CLI remain deferred.
 */
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const route = operationRoute;
const pause = () => { let done!: () => void; const promise = new Promise<void>(r => { done = r; }); return { promise, done }; };

async function fixture(mode = "open", limits?: Parameters<typeof createOperationsHttp>[0]["limits"], fault?: "omit_guard" | "early_release" | "unmounted", cookieMount = false) {
  const root = mkdtempSync(join(tmpdir(), "operations-http-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath, undefined, { admission: "strict", admissionTimeoutMs: 100 });
  cleanups.push(() => store.close());
  // The getter normally returns a fresh forwarding facade. Pin ONE real facade
  // before composition/mounting so later admission spies observe their actual
  // calls. It still forwards to the same owned core gate, with no fake admission.
  const admission = store.admission;
  vi.spyOn(store, "admission", "get").mockReturnValue(admission);
  const clock = { offset: 0 };
  const db = ownedFixtureDatabase(store), state = { maintenance: false, stopping: false, workerOpen: false, configChanged: false, providerState: "ready" as "ready" | "not_loaded" | "failed" };
  const installation = token("wsi"), agent = token("wts"), credentialId = agent.slice(4, 40);
  const storedLegacy = [
    { principal: "owner", principalKind: "owner", kind: "owner_session", secret: token("wts") },
    { principal: "worker", principalKind: "worker", kind: "worker_token", secret: token("wts") },
  ] as const;
  const unknownMachine = token("wts");
  await store.admission.run(() => {
    const policy = store.getAuthenticationPolicy();
    store.saveAuthenticationPolicy({ ...policy, mode: mode as "open", token: { id: installation.slice(4, 40), prefix: installation.slice(0, 40), verifierHash: hash(installation), createdAt: iso(NOW) } }, "fixture", "fixture");
    store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "fixture");
    store.saveCredential({ id: credentialId, principalId: "agent", kind: "agent_token", label: "fixture", tokenPrefix: agent.slice(0, 40), verifierHash: hash(agent), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
    for (const row of storedLegacy) {
      store.savePrincipal({ id: row.principal, kind: row.principalKind, status: "active" }, "fixture");
      store.saveCredential({ id: row.secret.slice(4, 40), principalId: row.principal, kind: row.kind, label: "legacy fixture",
        tokenPrefix: row.secret.slice(0, 40), verifierHash: hash(row.secret), status: "active", expiresAt: null,
        createdAt: iso(NOW), revokedAt: null, lastUsedAt: iso(NOW - 1000) }, "fixture");
    }
    for (const id of ["project-a", "project-b"]) store.saveKnowledgeProject({ id, name: id, status: "active", revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW) }, "fixture");
  });
  const socketPath = join(root, "admin.sock");
  let apiOpen = true, unixOpen = true;
  const eligibility = createControllerOperationEligibility({ maintenance: () => fault === "omit_guard" ? false : state.maintenance, stopping: () => state.stopping,
    configurationRestartRequired: () => state.configChanged, runtime: () => cookieMount && state.providerState === "ready" ? { isSessionAuthorityEligible: () => !state.configChanged } : undefined });
  const world = createProviderWorld({ now: Date.now() });
  const session = world.passwordLogin(world.account("human"));
  await store.admission.run(() => store.humanAccounts().createHumanPrincipal({ id: "human", kind: "human", status: "active" }, "fixture"));
  const provider = { isSessionAuthorityEligible: vi.fn(() => true), providerId: "better-auth" as const,
    reader: cookieMount ? world.store : store.authenticationProviderStorage(), resolveRequest: vi.fn(() => ({ result: Promise.resolve(cookieMount ? { session, principalId: "human" } : null), settled: Promise.resolve() })) };
  const built = buildOperationsRuntime({ store, activeMode: mode, now: () => Date.now() + clock.offset, logs: { controller() {} },
    eligibility, requestBudget: new AuthenticationRequestBudget(16, 4), provider: mode === "better-auth" ? provider : null, listeners: { worker: () => state.workerOpen, api: () => apiOpen, unix: () => unixOpen } });
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
  // Real unix HTTP/parser/capacity/close; execute and its maintenance gate are
  // stubbed. The CLI command dispatcher is not exported independently of startup.
  const legacy = vi.fn((body: unknown) => { if (state.maintenance) throw new Error("Controller is in maintenance."); return hooks.legacy ? hooks.legacy(body) : { echo: body }; });
  writeFileSync(join(root, "index.html"), "fixture");
  const controller = createControllerServer({ service: { addProject } as unknown as ControlService, directoryBrowser: new DirectoryBrowser(root),
    events: new EventStream(), webRoot: root, host: "127.0.0.1", port: 0, accessToken: "synthetic-pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "none", activeSessions: 0 }),
    operationsCookieBoundary: cookieMount ? { origin: "https://controller.test", cookieBytes: 8192 } : undefined, authentication: oldAuthentication, operations: fault === "unmounted" ? undefined : runtime, maintenance: () => state.maintenance, admission: store.admission });
  await new Promise<void>(r => controller.server.listen(0, "127.0.0.1", r));
  cleanups.push(() => { apiOpen = false; return controller.close(); });
  const admin = await listenAdminSocket(socketPath, legacy, fault === "unmounted" ? undefined : runtime);
  cleanups.push(() => { unixOpen = false; return admin.close(); });
  // Controlled-adapter cases retain real runtime/admission and HTTP I/O but
  // replace API dispatch: production mounts expose no limit override. Only the
  // early_release mutant replaces ownership; normal limit cases use the adapter owner.
  if (limits || fault === "early_release") {
    const adapter = createOperationsHttp({ runtime, listener: "api", limits, externallyOwned: fault === "early_release" });
    controller.server.removeAllListeners("request");
    let active = 0;
    controller.server.on("request", (req, res) => {
      if (fault === "early_release") {
        if (active >= OPERATIONS_HTTP_LIMITS.maxInFlight) { operationsFailure(res, { category: "busy", status: 503, reason: "listener_capacity", retry: "retry", effect: null }); return; }
        active++;
        // Deliberately broken owner: releases on disconnect while application work is pending.
        res.once("close", () => { active--; });
      }
      void adapter.handle(req, res);
    });
    cleanups.push(async () => { adapter.stop(); await adapter.drain(); });
  }
  const drivers = {
    api: createBoundaryDriver({ kind: "api", server: controller.server, close: () => controller.close(),
      legacyPath: "/api/projects", acceptedCredentials: mode === "open" ? ["none"] : mode === "token" ? ["installation"] : mode === "better-auth" ? ["agent"] : [] }),
    unix: createBoundaryDriver({ kind: "unix", server: admin.server, socketPath, close: () => admin.close(),
      legacyPath: "/auth", acceptedCredentials: mode === "legacy" ? [] : ["none"] }),
  };
  const send = (listener: keyof typeof drivers, options?: Parameters<BoundaryDriver["send"]>[0]) => drivers[listener].send(options);
  const grant = () => store.admission.run(() => db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent','reader','project','project-a',?)").run(iso(NOW)));
  return { root, storedLegacy, unknownMachine, drivers, store, state, db, built, runtime, send, hooks, oldAuthentication, legacy, controller, admin, installation, agent, credentialId, grant, clock, socketPath, provider, addProject, session, world };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const wire = (f: Fixture, listener: keyof Fixture["drivers"], ...args: Parameters<BoundaryDriver["wire"]>) => f.drivers[listener].wire(...args);
const protocolConnection = (f: Fixture, listener: keyof Fixture["drivers"]) => f.drivers[listener].connection();
const connectionCount = (server: Server) => new Promise<number>((resolve, reject) => {
  server.getConnections((error, count) => error ? reject(error) : resolve(count));
});
async function resetProtocol(f: Fixture, listener: "api" | "unix", method: "CONNECT" | "GET") {
  const server = f[listener === "api" ? "controller" : "admin"].server;
  const socket = protocolConnection(f, listener);
  cleanups.push(() => { socket.destroy(); });
  let reset = false;
  // Reset after the server receives the headers, while its refusal may still be writing.
  const received = (peer: Socket) => peer.once("data", () => {
    reset = true;
    // Unix sockets have no TCP RST; destroy abruptly without sending client EOF.
    if (listener === "api") socket.resetAndDestroy(); else socket.destroy();
  });
  server.once("connection", received);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Protocol reset timed out")); });
      socket.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
      socket.once("close", () => resolve());
      socket.once("connect", () => socket.write(`${method} ${route} HTTP/1.1\r\nHost: localhost\r\n${method === "GET" ? "Connection: Upgrade\r\nUpgrade: websocket\r\n" : ""}\r\n`));
    });
    expect(reset).toBe(true);
  } finally { server.off("connection", received); }
}
async function closeListener(server: Server) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Listener close timed out")), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function protocolWire(f: Fixture, listener: "api" | "unix", path: string, method: "CONNECT" | "GET") {
  return new Promise<string>((resolve, reject) => {
    const socket = protocolConnection(f, listener);
    cleanups.push(() => { socket.destroy(); });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Protocol response timed out")); });
    const chunks: Buffer[] = [];
    socket.on("data", c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    socket.on("error", reject);
    socket.on("end", () => {
      // Deliberately retain the client sending half. Server cleanup must not need EOF.
      expect(socket.writableEnded).toBe(false);
      socket.setTimeout(0);
      resolve(Buffer.concat(chunks).toString());
    });
    socket.on("connect", () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\n${method === "GET" ? "Connection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings:\r\n" : ""}\r\n`));
  });
}

const auth = (secret: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${secret}` });
const refusal = (reason: string, category = "unauthenticated", status = 401, retry = "reauthenticate") => ({ error: { category, status, reason, retry, effect: null } });

/** Shared outcome assertions, usable by later listener mounts and deliberate broken controls. */
function assertRefused(reply: Reply, prohibitedWork: number) { expect(reply.status).toBeGreaterThanOrEqual(400); expect(reply.body).not.toHaveProperty("actor"); expect(prohibitedWork).toBe(0); }
function assertOwned(owned: boolean) { expect(owned).toBe(true); }

type UpgradeOutcome = WireReply | { reset: "ECONNRESET" };
async function upgradeOutcome(driver: BoundaryDriver, path: string, method: string): Promise<UpgradeOutcome> {
  try { return await driver.wire(path, method, true); }
  catch (error) {
    // Only the old listener's exact hang-up is an outcome. Timeouts, refused
    // connections, response errors and malformed data must fail the test.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ECONNRESET" && error.message === "socket hang up") return { reset: "ECONNRESET" };
    throw error;
  }
}
function assertLegacyParity(outcome: UpgradeOutcome, baseline: WireReply) { conform("legacy Upgrade parity", outcome, baseline); }
function expectFailure(assertion: () => void, name: string, observed: unknown, expected: unknown) {
  let failure: unknown;
  try { assertion(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ConformanceFailure);
  expect(failure).toMatchObject({ assertion: name, observed, expected });
}
async function maintenanceObservation(f: Fixture, driver: BoundaryDriver) {
  const mint = vi.spyOn(f.runtime, "mint"), admission = vi.spyOn(f.store.admission, "run");
  let data = 0;
  const observe = (req: IncomingMessage) => req.on("newListener", event => { if (event === "data") data++; });
  driver.server.prependListener("request", observe);
  f.state.maintenance = true;
  try {
    const reply = await driver.send().reply;
    return { reply, calls: { mint: mint.mock.calls.length, admission: admission.mock.calls.length,
      data, provider: f.provider.isSessionAuthorityEligible.mock.calls.length } };
  } finally { driver.server.off("request", observe); }
}
function assertMaintenance({ reply, calls }: Awaited<ReturnType<typeof maintenanceObservation>>) {
  conform("maintenance prohibited mint calls", calls.mint, 0);
  conform("maintenance prohibited admission calls", calls.admission, 0);
  conform("maintenance prohibited body data listeners", calls.data, 0);
  conform("maintenance prohibited provider calls", calls.provider, 0);
  expect(reply.status).toBe(503); expect(reply.body).toEqual(refusal("release_not_eligible", "unavailable", 503, "none"));
  assertRefused(reply, calls.mint);
}
function assertCapacity(reply: Reply, owned: number) {
  // Setup evidence is outside the deliberately failed expectation.
  expect(owned).toBe(32);
  conform("capacity while 32 works remain unsettled", reply.status, 503);
  expect(reply.body).toEqual(refusal("listener_capacity", "busy", 503, "retry"));
}
async function disconnectedCapacity(f: Fixture, driver: BoundaryDriver, mutant: boolean) {
  const entered = pause(), release = pause(), disconnected = pause();
  let started = 0, settled = 0, aborted = 0;
  f.hooks.beforeMint = signal => signal?.addEventListener("abort", () => { if (++aborted === driver.capacity) disconnected.done(); }, { once: true });
  f.hooks.afterMint = async () => {
    if (++started <= driver.capacity) { if (started === driver.capacity) entered.done(); await release.promise; settled++; }
  };
  const held = Array.from({ length: driver.capacity }, () => driver.send());
  await entered.promise;
  try {
    for (const pending of held) pending.call.destroy();
    for (const pending of held) await expect(pending.reply).rejects.toMatchObject({ code: "ECONNRESET" });
    await disconnected.promise;
    if (driver.kind === "worker" && !mutant) {
      const cookie = await driver.send({ slow: true, headers: { "Content-Type": "application/json", Cookie: "wtc.session=x" } }).reply;
      expect(cookie.body).toEqual(refusal("provider_cookie_not_supported"));
    }
    const reply = await driver.capacityProbe();
    expect(started - settled).toBe(mutant ? 33 : 32);
    expect(settled).toBe(0);
    if (mutant) {
      expect(reply.body).toHaveProperty("actor.kind", "installation");
      expectFailure(() => assertCapacity(reply, driver.capacity), "capacity while 32 works remain unsettled", 200, 503);
    } else assertCapacity(reply, driver.capacity);
  } finally { release.done(); }
}
function assertMaintenanceRelease(reply: Reply) {
  conform("maintenance release status", reply.status, 401);
  // Context revalidation precedes readRelease's eligibility check.
  expect(reply.body).toEqual(refusal("listener_closed"));
  expect(reply.body).not.toHaveProperty("actor");
}
async function bufferedRelease(f: Fixture, driver: BoundaryDriver, mutant: boolean) {
  if (!f.built.supported) throw new Error("supported runtime required");
  const runner = f.built.runner, entered = pause(), release = pause();
  const realRelease = runner.readRelease.bind(runner);
  vi.spyOn(runner, "readRelease").mockImplementation(async (operation, context, raw, options) => {
    if (!mutant) { entered.done(); await release.promise; return realRelease(operation, context, raw, options); }
    // One mutation: buffer the ordinary runner result, then bypass readRelease's
    // final admitted revalidation by committing that old result directly.
    if (operation.kind === "stream") throw new Error("read required");
    const result = await runner.run(operation, context, raw, { signal: options.signal });
    expect(result.ok).toBe(true);
    entered.done(); await release.promise;
    if (!result.ok) throw new Error("successful control read required");
    options.commit(result.value); return { status: "committed" };
  });
  const pending = driver.send(); await entered.promise;
  f.state.maintenance = true; release.done();
  return pending.reply;
}

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
    const rows = ["none", "installation", "agent", "stored-owner", "stored-worker", "unknown-machine", "unknown", "cookie", "header"];
    for (const listener of ["api", "unix"] as const) for (const credential of rows) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (credential === "cookie") headers.Cookie = "__Secure-wtc.session=synthetic";
      else if (credential === "header") headers["X-Worktree-Control-Token"] = "synthetic-pairing";
      else if (credential !== "none") headers.Authorization = `Bearer ${credential === "installation" ? f.installation : credential === "agent" ? f.agent : credential === "stored-owner" ? f.storedLegacy[0].secret : credential === "stored-worker" ? f.storedLegacy[1].secret : credential === "unknown-machine" ? f.unknownMachine : "unrecognized"}`;
      const r = await f.send(listener, { headers }).reply;
      const accepted = f.drivers[listener].acceptedCredentials.includes(credential);
      if (accepted) {
        expect(r.status).toBe(200); expect(r.body).toMatchObject({ mode, listener, actor: { kind: listener === "unix" ? "operator" : mode === "better-auth" ? "agent" : "installation" } });
        expect(r.headers["cache-control"]).toBe("no-store");
      } else {
        const reason = credential === "cookie" ? listener === "unix" || mode === "legacy" ? "provider_cookie_not_supported" : mode === "open" ? "credential_in_open_mode" : mode === "token" ? "credential_not_accepted_here" : "invalid_credential" : mode === "legacy" ? "unknown_mode"
          : listener === "unix" ? "credential_on_local_listener" : credential === "header" ? "legacy_credential" : credential === "unknown" ? "unrecognized_credential"
          : mode === "open" ? "credential_in_open_mode" : credential === "none" ? "credential_required"
          : mode === "better-auth" && credential === "installation" ? "installation_token_in_account_mode"
          : mode === "better-auth" ? "invalid_credential" : "credential_not_accepted_here";
        expect(r.status).toBe(401); expect(r.body).toEqual(refusal(reason));
      }
    }
    expect(f.oldAuthentication.authenticateInstallation.mock.calls.length).toBe(0); expect(f.oldAuthentication.anonymousInstallation.mock.calls.length).toBe(0); expect(f.legacy).not.toHaveBeenCalled();
    await f.store.admission.run(() => {
      expect(f.store.getCredentialForAuthentication(f.credentialId)?.lastUsedAt).toBeNull();
      for (const row of f.storedLegacy) expect(f.store.getCredentialForAuthentication(row.secret.slice(4, 40))?.lastUsedAt).toBe(iso(NOW - 1000));
    });
  });

  it.each(["owner", "worker"] as const)("stored %s credential is refused by committed kind, without a context or usage update", async principal => {
    const f = await fixture("better-auth"), row = f.storedLegacy.find(row => row.principal === principal)!;
    const before = await f.store.admission.run(() => {
      expect(f.store.getPrincipal(principal)).toMatchObject({ kind: principal, status: "active" });
      const stored = f.store.getCredentialForAuthentication(row.secret.slice(4, 40));
      expect(stored).toMatchObject({ kind: row.kind, verifierHash: hash(row.secret), principalId: principal, status: "active" });
      return stored;
    });
    const mint = vi.spyOn(f.runtime, "mint");
    for (const driver of Object.values(f.drivers)) {
      const reply = await driver.send({ headers: auth(row.secret) }).reply;
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual(refusal(driver.kind === "api" ? "invalid_credential" : "credential_on_local_listener"));
      const result = await mint.mock.results.at(-1)!.value;
      expect(result).toEqual({ ok: false, error: reply.body.error }); expect(result).not.toHaveProperty("context");
    }
    await f.store.admission.run(() => expect(f.store.getCredentialForAuthentication(row.secret.slice(4, 40))).toEqual(before));
  });

  it("keeps real admin directory/socket permissions private", async () => {
    const f = await fixture();
    expect(lstatSync(f.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(f.socketPath).isSocket()).toBe(true);
    expect(lstatSync(f.socketPath).mode & 0o777).toBe(0o600);
  });

  it("uses security headers and terminal finite JSON replies", async () => {
    const f = await fixture();
    for (const driver of Object.values(f.drivers)) for (const method of ["POST", "GET"]) {
      const reply = await driver.send({ method }).reply;
      expect(reply.status).toBe(method === "POST" ? 200 : 400);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(reply.headers["retry-after"]).toBeUndefined();
      expect(reply.body).toHaveProperty(method === "POST" ? "actor" : "error");
    }
  });

  it("rejects malformed UTF-8 and duplicate singleton headers before mint", async () => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    for (const driver of Object.values(f.drivers)) {
      const invalid = await driver.send({ body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) }).reply;
      expect(invalid.status).toBe(400); expect(invalid.body).toEqual(refusal("invalid_request", "invalid_request", 400, "none"));
      for (const header of ["Host", "Content-Type", "Origin"]) {
        const headers = ["Content-Length", "2", "Content-Type", "application/json", header, header === "Content-Type" ? "application/json" : "localhost", header, header === "Content-Type" ? "application/json" : "localhost"];
        const reply = await driver.send({ headers }).reply;
        expect(reply.status).toBe(400);
      }
    }
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses project-command exception on operations (legacy unix executor stubbed)", async () => {
    const f = await fixture(), driver = f.drivers.unix;
    const body = JSON.stringify({ command: "project", padding: "x".repeat(17 * 1024) });
    const reply = await driver.send({ body }).reply;
    expect(reply.status).toBe(413); expect(reply.body).toEqual(refusal("request_too_large", "payload_too_large", 413, "none"));
    expect(f.legacy).not.toHaveBeenCalled();
    expect((await driver.send({ path: driver.legacyPath, body }).reply).status).toBe(200);
  });

  it("preserves legacy h2c status and bodies against listeners without the operations mount", async () => {
    const old = await fixture("open", undefined, "unmounted"), mounted = await fixture();
    for (const listener of ["api", "unix"] as const) {
      const targets = listener === "api" ? [["/", "GET"], ["/index.html", "GET"], ["/api/auth/status", "GET"], ["/api/status", "GET"]]
        : [["/auth", "POST"], ["/api/status", "GET"], ["/unknown", "GET"]];
      for (const [path, method] of targets) {
        const baseline = await wire(old, listener, path, method);
        assertLegacyParity(await upgradeOutcome(old.drivers[listener], path, method), baseline);
        expect(await wire(mounted, listener, path, method)).toEqual(baseline);
        assertLegacyParity(await upgradeOutcome(mounted.drivers[listener], path, method), baseline);
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

  it.each(["api", "unix"] as const)("negative control: the old %s Upgrade listener fails legacy parity exactly at ECONNRESET", async listener => {
    const f = await fixture(), driver = f.drivers[listener];
    const path = listener === "api" ? "/api/auth/status" : "/auth", method = listener === "api" ? "GET" : "POST";
    const baseline = await driver.wire(path, method);
    // One mutation: restore the old upgrade listener on unclaimed legacy targets.
    driver.server.on("upgrade", (_request, socket) => socket.destroy());
    const broken = await upgradeOutcome(driver, path, method);
    expectFailure(() => assertLegacyParity(broken, baseline), "legacy Upgrade parity", { reset: "ECONNRESET" }, baseline);
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
        namespace.replace("operations", "%6fperations"), `${namespace}/%2e`, `${namespace}/x/%2e%2e`,
        // Network-path and absolute-form targets: the legacy dispatcher's URL parser drops the authority.
        `//example.invalid${namespace}`, `//user@example.invalid:8443${namespace}`, `/\\example.invalid${namespace}`,
        `//example.invalid/./${namespace.slice(1)}`, `//example.invalid${namespace.replace("/operations", "/%2e/operations")}`,
        `http://example.invalid${namespace}`);
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
        expect(reply.status, `${listener} ${method} ${alias} cookie=${cookie}`).toBe(cookie && listener === "unix" ? 401 : 404);
        expect(reply.body).toEqual(cookie && (listener === "unix") ? refusal("provider_cookie_not_supported") : refusal("operation_not_found", "not_found", 404, "none"));
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
    expect((await f.send("api", { headers: { ...auth(f.installation), Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("mixed_credentials"));
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

  it("answers HEAD and Upgrade inside the namespace through normal HTTP dispatch", async () => {
    const f = await fixture();
    for (const listener of ["api", "unix"] as const) {
      expect((await f.send(listener, { method: "HEAD" }).reply).status).toBe(400);
      const raw = await protocolWire(f, listener, route, "GET");
      expect(raw).toContain("400 Bad Request"); expect(raw).toContain('"reason":"method_not_allowed"');
    }
    expect(f.oldAuthentication.authenticateInstallation).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
  });

  it("starts both listeners without CONNECT or Upgrade listeners and closes every CONNECT target", async () => {
    const f = await fixture();
    const mint = vi.spyOn(f.runtime, "mint");
    for (const listener of ["api", "unix"] as const) {
      const server = f[listener === "api" ? "controller" : "admin"].server;
      expect(server.listenerCount("connect")).toBe(0); expect(server.listenerCount("upgrade")).toBe(0);
      for (const target of [route, "example.invalid:443", "/auth", "/api/status"]) {
        expect(await protocolWire(f, listener, target, "CONNECT")).toBe("");
        await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0));
        expect(mint).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
        expect(f.oldAuthentication.anonymousInstallation).not.toHaveBeenCalled();
        expect((await f.send(listener, { headers: { "Content-Type": "application/json", Connection: "close" } }).reply).status).toBe(200);
        mint.mockClear();
      }
    }
  });

  it.each(["api", "unix"] as const)("%s cleans up half-open and reset protocol clients and completes server.close", async listener => {
    const f = await fixture();
    const server = f[listener === "api" ? "controller" : "admin"].server;
    const unhandled = vi.fn();
    // Observe without handling exceptions; Vitest also fails on unhandled errors.
    process.on("uncaughtExceptionMonitor", unhandled);
    try {
      for (const method of ["CONNECT", "GET"] as const) {
        const raw = await protocolWire(f, listener, route, method);
        if (method === "CONNECT") expect(raw).toBe("");
        else { expect(raw).toContain("400 Bad Request"); expect(raw).toContain('"reason":"method_not_allowed"'); }
        await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0));
        await resetProtocol(f, listener, method);
        await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0));
        expect((await f.send(listener, { headers: { "Content-Type": "application/json", Connection: "close" } }).reply).status).toBe(200);
        await vi.waitFor(async () => expect(await connectionCount(server)).toBe(0));
      }
      // Use Node's close directly: no force-close helper may hide leaked sockets.
      await closeListener(server);
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("uncaughtExceptionMonitor", unhandled); }
  });

  it("keeps legacy paths working in legacy mode, five per listener (unix executor stubbed)", async () => {
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
  it.each(["api", "unix"] as const)("%s keeps maintenance refusal and origin policy without application work (unix legacy gate stubbed)", async listener => {
    const f = await fixture(), driver = f.drivers[listener];
    const observation = await maintenanceObservation(f, driver);
    assertMaintenance(observation);
    const mint = vi.spyOn(f.runtime, "mint");
    // Unix neighbour maintenance is a stubbed executor gate; API gate is real.
    const effect = vi.fn(); f.hooks.legacy = effect;
    const old = await f.send(listener, { path: listener === "api" ? "/api/projects" : "/auth" }).reply;
    assertRefused(old, listener === "api" ? f.addProject.mock.calls.length : effect.mock.calls.length);
    f.state.maintenance = false;
    if (listener === "api") assertRefused(await f.send(listener, { headers: { "Content-Type": "application/json", Origin: "https://foreign.example" } }).reply, mint.mock.calls.length);
    // Configuration belongs to provider sessions. No provider call is permitted in 5a.
    f.state.configChanged = true;
    expect((await f.send(listener).reply).status).toBe(200);
  });

  it.each(["api", "unix"] as const)("%s enforces production byte ceilings before mint (unix legacy executor stubbed)", async listener => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    const body = JSON.stringify({ padding: "x".repeat(listener === "api" ? 65536 : 16384) });
    const driver = f.drivers[listener], reply = await driver.send({ body }).reply;
    expect(reply.status).toBe(413); expect(reply.body).toEqual(refusal("request_too_large", "payload_too_large", 413, "none"));
    assertRefused(reply, mint.mock.calls.length);
    const effect = vi.fn(); f.hooks.legacy = effect;
    assertRefused(await f.send(listener, { path: listener === "api" ? "/api/projects" : "/auth", body }).reply,
      listener === "api" ? f.addProject.mock.calls.length : effect.mock.calls.length);
  });

  it("controlled adapter: bounds a slow body and response on real HTTP (stubbed limits/dispatch)", async () => {
    const f = await fixture("open", { deadlineMs: 50, responseBytes: 32 });
    expect((await f.send("api", { slow: true }).reply).status).toBeGreaterThanOrEqual(400);
    expect((await f.send("api").reply).body).toEqual(refusal("response_too_large", "payload_too_large", 413, "none"));
  });

  it("controlled adapter: commits exactly one 413 envelope for an oversized response (stubbed limits/dispatch)", async () => {
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
      else if (change === "deadline") {
        expect(reply.status).toBe(503); expect(reply.body).toEqual(refusal("release_timed_out", "unavailable", 503, "retry"));
      } else expect(reply.status).toBeGreaterThanOrEqual(400);
    }
  });

  it("keeps the API's 32-request bound before body reads, with cookies excluded", async () => {
    const f = await fixture(); let reading = 0; const ready = pause();
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data" && ++reading === 32) ready.done(); }));
    const held = Array.from({ length: 32 }, () => f.send("api", { slow: true }));
    await ready.promise;
    try {
      expect((await f.send("api").reply).body).toEqual(refusal("listener_capacity", "busy", 503, "retry"));
      expect((await f.send("api", { slow: true, headers: { Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("listener_capacity", "busy", 503, "retry"));
      expect(reading).toBe(32);
    } finally { for (const pending of held) pending.call.destroy(); }
  });

  it("matches legacy Retry-After during real provider-storage contention on both operations listeners", async () => {
    const f = await fixture(), entered = pause(), release = pause();
    const borrow = f.store.authenticationProviderStorage().borrow(async () => { entered.done(); await release.promise; });
    await entered.promise;
    try {
      const legacy = await f.drivers.api.send({ path: f.drivers.api.legacyPath }).reply;
      expect(legacy.status).toBe(503); expect(legacy.body.code).toBe("database_busy");
      expect(legacy.headers["retry-after"]).toBe("1");
      for (const driver of Object.values(f.drivers)) {
        const reply = await driver.send().reply;
        expect(reply.body).toEqual(refusal("admission_refused", "busy", 503, "retry"));
        expect(reply.status).toBe(legacy.status); expect(reply.headers["retry-after"]).toBe(legacy.headers["retry-after"]);
      }
      expect(f.addProject).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
    } finally { release.done(); await borrow; }
  });

  it.each(["unix"] as const)("%s configuration change still refuses cookies before provider/admission/body work", async listener => {
    const f = await fixture("better-auth"), driver = f.drivers[listener];
    f.state.configChanged = true;
    const admission = vi.spyOn(f.store.admission, "run"), mint = vi.spyOn(f.runtime, "mint"); let data = 0;
    driver.server.prependListener("request", req => req.on("newListener", event => { if (event === "data") data++; }));
    const reply = await driver.send({ slow: true, headers: { "Content-Type": "application/json", Cookie: "wtc.session=x" } }).reply;
    expect(reply.status).toBe(401); expect(reply.body).toEqual(refusal("provider_cookie_not_supported"));
    expect(admission).not.toHaveBeenCalled(); expect(mint).not.toHaveBeenCalled(); expect(data).toBe(0);
    expect(f.provider.isSessionAuthorityEligible).not.toHaveBeenCalled();
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

  it("shares the real unix ceiling and drain with a stubbed /auth executor after disconnect", async () => {
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

  it("shutdown retains the real open SQLite handle and lock record until an admitted request settles", async () => {
    const f = await fixture(), entered = pause(), release = pause();
    const lockPath = join(f.root, "shutdown", "controller.lock"), lock = acquireControllerLock(lockPath);
    cleanups.push(() => lock.release());
    const record = readFileSync(lockPath, "utf8");
    f.hooks.afterMint = async () => { entered.done(); await release.promise; };
    const pending = f.send("api"); await entered.promise;
    // Only the service facade is stubbed. These callbacks perform the real close;
    // the real CLI shutdown function owns both real listeners and the real lock.
    const shutdown = createControllerShutdown({ service: { closeAdmission() {}, shutdown: async () => {
      expect(f.db.open).toBe(true); expect(readFileSync(lockPath, "utf8")).toBe(record);
      f.store.close(); expect(f.db.open).toBe(false);
    } }, stopping: () => { f.state.stopping = true; }, userSchedules: undefined,
      backups: { close() {} }, remoteVerification: null, mcp: null,
      controller: f.controller, adminSocket: f.admin,
      removeServiceAccess() { expect(f.db.open).toBe(false); expect(readFileSync(lockPath, "utf8")).toBe(record); }, controllerLock: lock });
    const stopping = shutdown();
    try {
      await new Promise<void>(done => setImmediate(done));
      expect(f.state.stopping).toBe(true); assertOwned(f.db.open);
      expect(readFileSync(lockPath, "utf8")).toBe(record);
    } finally { release.done(); }
    expect((await pending.reply).status).toBeGreaterThanOrEqual(400);
    await stopping; expect(f.db.open).toBe(false); expect(existsSync(lockPath)).toBe(false);
  });

  it("negative control: omitted maintenance guard starts exactly one measured mint", async () => {
    const f = await fixture("open", undefined, "omit_guard");
    const observation = await maintenanceObservation(f, f.drivers.api);
    expect(observation.reply.status).toBe(200); expect(observation.reply.body).toHaveProperty("actor.kind", "installation");
    expect(observation.calls.admission).toBeGreaterThan(0); expect(observation.calls.data).toBe(1);
    expectFailure(() => assertMaintenance(observation), "maintenance prohibited mint calls", 1, 0);
  });

  it("retains all 32 API slots until disconnected work settles through production dispatch", async () => {
    const f = await fixture(); await disconnectedCapacity(f, f.drivers.api, false);
  });
  it("negative control: early slot release admits request 33 while all 32 works remain unsettled", async () => {
    const f = await fixture("open", undefined, "early_release"); await disconnectedCapacity(f, f.drivers.api, true);
  });

  it("revalidates maintenance before releasing a buffered response through production dispatch", async () => {
    const f = await fixture(), reply = await bufferedRelease(f, f.drivers.api, false);
    assertMaintenanceRelease(reply);
  });
  it("negative control: buffered success without revalidation writes exactly 200 with a DTO after maintenance", async () => {
    const f = await fixture(), reply = await bufferedRelease(f, f.drivers.api, true);
    expect(reply.body).toHaveProperty("actor.kind", "installation");
    expectFailure(() => assertMaintenanceRelease(reply), "maintenance release status", 200, 401);
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

  it("controlled adapter/end hook: holds capacity through response completion after admitted work returns", async () => {
    const f = await fixture("open", { maxInFlight: 1 }), intercepted = pause();
    let finish: (() => void) | undefined;
    const hold = (_req: IncomingMessage, response: ServerResponse) => {
      f.controller.server.off("request", hold);
      const end = response.end.bind(response);
      response.end = ((...args: Parameters<ServerResponse["end"]>) => { finish = () => { end(...args); }; intercepted.done(); return response; }) as ServerResponse["end"];
    };
    // Controlled end hook, not a backpressure claim: Node's end is delayed.
    // A separate test below observes a real socket.write returning false.
    f.controller.server.prependListener("request", hold);
    const pending = f.send("api"); await intercepted.promise;
    try { expect((await f.send("api").reply).status).toBe(503); }
    finally { finish?.(); }
    expect((await pending.reply).status).toBe(200);
    expect((await f.send("api").reply).status).toBe(200);
  });

  it.each(["api", "unix"] as const)("%s completes a large real DTO under real socket backpressure", async listener => {
    const f = await fixture(), driver = f.drivers[listener];
    // session.describe can list 500 projects, so it is NOT always a tiny DTO.
    // Keep this below the real 256 KiB limit, above Node's socket high-water mark.
    await f.store.admission.run(() => {
      for (let i = 0; i < 300; i++) {
        const id = `large-${String(i).padStart(3, "0")}-${"x".repeat(145)}`;
        f.store.saveKnowledgeProject({ id, name: id, status: "active", revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW) }, "fixture");
      }
    });
    let backpressured = false, backpressureBeforeFinish = false, finished = false;
    driver.server.prependOnceListener("request", (_req, response) => {
      const socket = response.socket!, write = socket.write.bind(socket);
      // Observe the real write's return value. No bytes, end, drain or finish
      // are delayed or simulated. The separate end-hook test controls ownership.
      socket.write = ((...args: Parameters<Socket["write"]>) => {
        const accepted = write(...args);
        if (!accepted) { backpressured = true; backpressureBeforeFinish ||= !finished; }
        return accepted;
      }) as Socket["write"];
      response.once("finish", () => { finished = true; });
    });
    const reply = await driver.send().reply;
    expect(reply.status).toBe(200); expect(reply.body.projects).toHaveLength(302);
    expect(Buffer.byteLength(JSON.stringify(reply.body))).toBeGreaterThan(64 * 1024);
    expect(backpressured).toBe(true); expect(backpressureBeforeFinish).toBe(true); expect(finished).toBe(true);
    expect((await driver.capacityProbe()).status).toBe(200);
  });

  it("uses the socket's real ten second deadline for a slow operations body", async () => {
    const f = await fixture(), mint = vi.spyOn(f.runtime, "mint");
    const reply = await f.send("unix", { slow: true }).reply;
    assertRefused(reply, mint.mock.calls.length);
  }, 15_000);
});

const cookieHeaders = { Host: "controller.test", Origin: "https://controller.test", "Content-Type": "application/json", Cookie: "__Secure-wtc.session_token=synthetic" };
describe("operations cookie listener conformance", () => {
  it.each([
    ["Host", "other.test", "invalid_authority", 400],
    ["Origin", "https://other.test", "origin_forbidden", 403],
    ["Origin", "", "origin_forbidden", 403],
    ["Sec-Fetch-Site", "cross-site", "origin_forbidden", 403],
    ["Sec-Fetch-Mode", "navigate", "origin_forbidden", 403],
    ["Sec-Fetch-Dest", "document", "origin_forbidden", 403],
    ["Cookie", "wtc.session_token=alias", "invalid_request", 400],
    ["Cookie", "__Secure-wtc.session_token=x; __Secure-wtc.session_token=y", "invalid_request", 400],
    ["Cookie", `__Secure-wtc.session_token=${"x".repeat(8192)}`, "invalid_request", 400],
  ] as const)("cookie boundary rejects %s before body, budget and provider", async (name, value, reason, status) => {
    const f = await fixture("better-auth", undefined, undefined, true);
    const resolve = vi.spyOn(f.runtime, "resolveSession"), acquire = vi.spyOn(AuthenticationRequestBudget.prototype, "acquire"); let data = 0;
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data") data++; }));
    const reply = await f.send("api", { slow: true, headers: { ...cookieHeaders, [name]: value } }).reply;
    expect(reply.body).toEqual(refusal(reason, status === 403 ? "forbidden" : "invalid_request", status, "none"));
    expect(data).toBe(0); expect(resolve).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled();
  });

  it("requires Origin on cookie requests before body, budget and provider", async () => {
    const f = await fixture("better-auth", undefined, undefined, true);
    const resolve = vi.spyOn(f.runtime, "resolveSession"), acquire = vi.spyOn(AuthenticationRequestBudget.prototype, "acquire");
    let bodyReads = 0;
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data") bodyReads++; }));
    const headers = Object.fromEntries(Object.entries(cookieHeaders).filter(([name]) => name !== "Origin"));
    const reply = await f.send("api", { slow: true, headers }).reply;
    assertCookieRequiredOrigin(reply);
    expect(reply.body).toEqual(refusal("origin_forbidden", "forbidden", 403, "none"));
    expect(bodyReads).toBe(0); expect(acquire).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(f.provider.resolveRequest).not.toHaveBeenCalled();
  });

  it.each(["Host", "Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Content-Type"])("cookie boundary rejects duplicate %s", async name => {
    const f = await fixture("better-auth", undefined, undefined, true);
    const value = name === "Host" ? "controller.test" : name === "Origin" ? "https://controller.test" : name === "Content-Type" ? "application/json" : name === "Sec-Fetch-Site" ? "same-origin" : name === "Sec-Fetch-Mode" ? "cors" : "empty";
    const reply = await f.send("api", { headers: [...Object.entries(cookieHeaders).filter(([key]) => key !== name).flat(), name, value, name, value] }).reply;
    expect(reply.body.error.reason).toBe(name === "Host" ? "invalid_authority" : name === "Content-Type" ? "invalid_request" : "origin_forbidden");
    expect(f.provider.resolveRequest).not.toHaveBeenCalled();
  });

  it("resolves only allowlisted provider headers, stages in-request, and preserves mixed-cookie refusal even for null resolution", async () => {
    const f = await fixture("better-auth", undefined, undefined, true);
    const headers = { ...cookieHeaders, "X-Forwarded-For": "evil", "X-Worktree-Control-Client-IP": "evil", Cookie: cookieHeaders.Cookie + "; unrelated=secret; __Secure-wtc.two_factor=challenge" };
    expect((await f.send("api", { headers }).reply).body).toMatchObject({ actor: { kind: "human", accountId: "human" } });
    const forwarded = f.provider.resolveRequest.mock.calls[0] as unknown as [Headers];
    expect([...forwarded[0].keys()].sort()).toEqual(["content-type", "cookie", "origin", "x-worktree-control-client-ip"]);
    expect(forwarded[0].get("cookie")).toBe(cookieHeaders.Cookie);
    expect(forwarded[0].get("x-worktree-control-client-ip")).toBe("127.0.0.1");
    f.provider.resolveRequest.mockImplementation(() => ({ result: Promise.resolve(null), settled: Promise.resolve() }));
    expect((await f.send("api", { headers: { ...cookieHeaders, Authorization: `Bearer ${f.agent}` } }).reply).body).toEqual(refusal("mixed_credentials"));
    const unknown = await f.send("api", { headers: cookieHeaders }).reply;
    expect(unknown.status).toBe(401); expect(unknown.body).toEqual(refusal("invalid_credential"));
  });

  it.each(["maintenance", "configChanged"] as const)("cookie %s refusal preserves provider and body fences", async change => {
    const f = await fixture("better-auth", undefined, undefined, true); f.state[change] = true;
    let bodyReads = 0;
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data") bodyReads++; }));
    const reply = await f.send("api", { slow: true, headers: cookieHeaders }).reply;
    expect(bodyReads).toBe(0);
    expect(reply.body).toEqual(change === "maintenance" ? refusal("release_not_eligible", "unavailable", 503, "none") : refusal("provider_session_unavailable", "unavailable", 503, "retry"));
    expect(reply.status).toBe(503);
    expect(reply.headers["retry-after"]).toBe(change === "maintenance" ? undefined : "1");
    expect(f.provider.resolveRequest).not.toHaveBeenCalled();
  });

  it.each(["not_loaded", "failed", "configuration"] as const)("cookie provider %s is unavailable before body or resolution, with late readiness on the same boundary", async change => {
    const f = await fixture("better-auth", undefined, undefined, true);
    if (change === "configuration") f.state.configChanged = true;
    else f.state.providerState = change;
    const resolve = vi.spyOn(f.runtime, "resolveSession");
    let bodyReads = 0;
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data") bodyReads++; }));
    const reply = await f.send("api", { slow: true, headers: cookieHeaders }).reply;
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual(refusal("provider_session_unavailable", "unavailable", 503, "retry"));
    expect(reply.headers["retry-after"]).toBe("1");
    expect(bodyReads).toBe(0); expect(resolve).not.toHaveBeenCalled(); expect(f.provider.resolveRequest).not.toHaveBeenCalled();
    if (change === "not_loaded") {
      f.state.providerState = "ready";
      const ready = await f.send("api", { headers: cookieHeaders }).reply;
      expect(ready.status).toBe(200); expect(ready.body.actor).toMatchObject({ kind: "human", accountId: "human" });
      expect(f.provider.resolveRequest).toHaveBeenCalledTimes(1);
    }
  });

  it("cookie eligibility lost during pending resolution is unavailable at mint", async () => {
    const f = await fixture("better-auth", undefined, undefined, true), entered = pause(), release = pause();
    f.provider.resolveRequest.mockImplementation(() => {
      entered.done();
      return { result: release.promise.then(() => null), settled: release.promise };
    });
    const pending = f.send("api", { headers: cookieHeaders }); await entered.promise;
    try { f.state.configChanged = true; } finally { release.done(); }
    const reply = await pending.reply;
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual(refusal("provider_session_unavailable", "unavailable", 503, "retry"));
    expect(reply.headers["retry-after"]).toBe("1"); expect(f.provider.resolveRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["provider_failed", "provider_unavailable", "provider_disposed"] as const)("cookie resolution rejected by the provider with %s is unavailable, never an internal failure", async code => {
    const f = await fixture("better-auth", undefined, undefined, true);
    f.provider.resolveRequest.mockImplementation(() => ({ result: Promise.reject(new AuthenticationProviderError(code, "synthetic provider fault")), settled: Promise.resolve() }));
    const reply = await f.send("api", { headers: cookieHeaders }).reply;
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual(refusal("provider_session_unavailable", "unavailable", 503, "retry"));
    expect(reply.headers["retry-after"]).toBe("1"); expect(f.provider.resolveRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid_credential", "success"] as const)("pre-body ineligibility never becomes a credential verdict when mint returns %s", async outcome => {
    const f = await fixture("better-auth", undefined, undefined, true);
    vi.spyOn(f.runtime, "providerSessionEligibility").mockReturnValueOnce("ineligible");
    if (outcome === "success") {
      // Controlled mint result: this branch must refuse even a returned context.
      const minted = await f.built.mint("api", { bearers: [], providerSession: { secret: "" }, legacySecret: false, browserHeaders: true }, f.session, {});
      expect(minted.ok).toBe(true);
      vi.spyOn(f.runtime, "mint").mockResolvedValueOnce(minted);
    }
    const mint = vi.spyOn(f.runtime, "mint"), resolve = vi.spyOn(f.runtime, "resolveSession"); let bodyReads = 0;
    f.controller.server.prependListener("request", req => req.on("newListener", event => { if (event === "data") bodyReads++; }));
    const reply = await f.send("api", { slow: true, headers: cookieHeaders }).reply;
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual(refusal("provider_session_unavailable", "unavailable", 503, "retry"));
    expect(reply.headers["retry-after"]).toBe("1"); expect(bodyReads).toBe(0); expect(resolve).not.toHaveBeenCalled();
    expect(f.provider.resolveRequest).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(1);
    const minted = await mint.mock.results[0].value;
    expect(minted).toMatchObject(outcome === "success" ? { ok: true } : { ok: false, error: { reason: "invalid_credential" } });
  });

  it.each(["open", "token", "mixed"] as const)("ineligible cookie provider preserves the %s acceptance refusal", async mode => {
    const f = await fixture(mode === "mixed" ? "better-auth" : mode, undefined, undefined, true);
    f.state.providerState = "not_loaded";
    const headers = mode === "mixed" ? { ...cookieHeaders, Authorization: `Bearer ${f.agent}` } : cookieHeaders;
    const reply = await f.send("api", { slow: true, headers }).reply;
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual(refusal(mode === "open" ? "credential_in_open_mode" : mode === "token" ? "credential_not_accepted_here" : "mixed_credentials"));
    expect(f.provider.resolveRequest).not.toHaveBeenCalled();
  });

  it("retains initiating slots after disconnected public results until provider settled; drain joins that work", async () => {
    const f = await fixture("better-auth", undefined, undefined, true), release = pause(), entered = pause();
    let calls = 0;
    f.provider.resolveRequest.mockImplementation(() => { if (++calls === 12) entered.done(); return { result: Promise.resolve(null), settled: release.promise }; });
    const held = Array.from({ length: 12 }, () => f.send("api", { headers: cookieHeaders }));
    await entered.promise; await Promise.all(held.map(h => h.reply));
    try {
      expect((await f.send("api", { headers: cookieHeaders }).reply).body).toEqual(refusal("listener_capacity", "busy", 503, "retry"));
      expect(f.runtime.requestBudget.active).toBe(12); expect(calls).toBe(12);
      let drained = false; const close = f.controller.close().then(() => { drained = true; });
      await new Promise<void>(r => setImmediate(r)); expect(drained).toBe(false);
      release.done(); await close; expect(f.runtime.requestBudget.active).toBe(0);
    } finally { release.done(); }
  });

  it("cookie admission contention is retryable busy, never invalid credential", async () => {
    const f = await fixture("better-auth", undefined, undefined, true), entered = pause(), release = pause();
    const borrow = f.store.authenticationProviderStorage().borrow(async () => { entered.done(); await release.promise; }); await entered.promise;
    try {
      const reply = await f.send("api", { headers: cookieHeaders }).reply;
      expect(reply.body).toEqual(refusal("admission_refused", "busy", 503, "retry")); expect(reply.headers["retry-after"]).toBe("1");
      expect(f.provider.resolveRequest).not.toHaveBeenCalled();
    } finally { release.done(); await borrow; }
  });

  it.each(["maintenance", "configuration", "session", "grant", "deadline", "disconnect"])("cookie release recomputes after runner completion: %s", async change => {
    const f = await fixture("better-auth", undefined, undefined, true); if (!f.built.supported) throw new Error("supported fixture required");
    await f.store.admission.run(() => f.db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('human','reader','project','project-a',?)").run(iso(NOW)));
    const runner = f.built.runner, entered = pause(), release = pause(), real = runner.readRelease.bind(runner);
    vi.spyOn(runner, "readRelease").mockImplementation(async (operation, context, raw, options) => {
      if (operation.kind === "stream") throw new Error("read required");
      const prior = await runner.run(operation, context, raw); expect(prior.ok).toBe(true);
      entered.done(); await release.promise; return real(operation, context, raw, options);
    });
    const pending = f.send("api", { headers: cookieHeaders }); await entered.promise;
    if (change === "maintenance") f.state.maintenance = true;
    if (change === "configuration") f.state.configChanged = true;
    if (change === "session") f.world.store.sessions.delete(f.session.sessionId);
    if (change === "grant") await f.store.admission.run(() => f.db.prepare("DELETE FROM account_grants WHERE account_id='human'").run());
    if (change === "deadline") f.clock.offset = OPERATIONS_HTTP_LIMITS.deadlineMs + 1;
    if (change === "disconnect") { pending.call.destroy(); await new Promise<void>(r => setImmediate(r)); }
    release.done();
    if (change === "disconnect") await expect(pending.reply).rejects.toMatchObject({ code: "ECONNRESET" });
    else { const reply = await pending.reply; if (change === "grant") { expect(reply.status).toBe(200); expect(reply.body.projects).toEqual([]); } else { expect(reply.status).toBeGreaterThanOrEqual(400); expect(reply.body).not.toHaveProperty("actor"); } }
  });
});


describe("cookie conformance negative controls", () => {
  it("negative control: omitted origin guard fails cookie origin boundary with 200 versus 403", async () => {
    const f = await fixture("better-auth", undefined, undefined, true);
    // Deliberately erase the hostile origin before the mounted guard observes it.
    f.controller.server.prependOnceListener("request", req => { req.headers.origin = cookieHeaders.Origin; });
    const reply = await f.send("api", { headers: { ...cookieHeaders, Origin: "https://other.test" } }).reply;
    expect(reply.body.actor.kind).toBe("human");
    expectFailure(() => assertCookieOrigin(reply), "cookie origin boundary", 200, 403);
  });
  it("negative control: removing only required-Origin fails cookie required Origin boundary with 200 versus 403", async () => {
    const f = await fixture("better-auth", undefined, undefined, true);
    vi.spyOn(authenticationHttp, "authenticationRequestOrigin").mockImplementation(() => {});
    const headers = Object.fromEntries(Object.entries(cookieHeaders).filter(([name]) => name !== "Origin"));
    const reply = await f.send("api", { headers }).reply;
    expect(reply.body.actor.kind).toBe("human");
    expectFailure(() => assertCookieRequiredOrigin(reply), "cookie required Origin boundary", 200, 403);
  });
  it("negative control: early work settlement fails cookie capacity until settlement with 401 versus 503", async () => {
    const f = await fixture("better-auth", undefined, undefined, true), release = pause();
    const acquire = AuthenticationRequestBudget.prototype.acquire;
    vi.spyOn(AuthenticationRequestBudget.prototype, "acquire").mockImplementation(function (this: AuthenticationRequestBudget, kind) {
      const slot = acquire.call(this, kind);
      return slot && { responseFinished: slot.responseFinished, settle: (work: Promise<unknown>) => { void work.catch(() => undefined); return slot.settle(Promise.resolve()); } };
    });
    f.provider.resolveRequest.mockImplementation(() => ({ result: Promise.resolve(null), settled: release.promise }));
    try {
      for (let i = 0; i < 12; i++) expect((await f.send("api", { headers: cookieHeaders }).reply).status).toBe(401);
      const reply = await f.send("api", { headers: cookieHeaders }).reply;
      expectFailure(() => assertCookieCapacity(reply), "cookie capacity until settlement", 401, 503);
      expect(f.provider.resolveRequest).toHaveBeenCalledTimes(13);
    } finally { release.done(); }
  });
  it("negative control: premature buffered success fails cookie maintenance release with 200 versus 401", async () => {
    const f = await fixture("better-auth", undefined, undefined, true); if (!f.built.supported) throw new Error("supported fixture required");
    const runner = f.built.runner, entered = pause(), release = pause();
    vi.spyOn(runner, "readRelease").mockImplementation(async (operation, context, raw, options) => {
      if (operation.kind === "stream") throw new Error("read required");
      const prior = await runner.run(operation, context, raw); if (!prior.ok) throw new Error("successful control read required");
      entered.done(); await release.promise; options.commit(prior.value); return { status: "committed" };
    });
    const pending = f.send("api", { headers: cookieHeaders }); await entered.promise; f.state.maintenance = true; release.done();
    const reply = await pending.reply; expect(reply.body.actor.kind).toBe("human");
    expectFailure(() => assertCookieRelease(reply), "cookie maintenance release", 200, 401);
  });
});

describe("cookie cancellation ownership", () => {
  it("deadline aborts resolution and admission but retains real unsettled work and response drain", async () => {
    const f = await fixture("better-auth", undefined, undefined, true), release = pause();
    const cancelled = vi.fn();
    vi.spyOn(f.runtime, "resolveSession").mockImplementation((_headers, { signal } = {}) => ({
      result: new Promise((_resolve, reject) => signal!.addEventListener("abort", () => { cancelled(); reject(new Error("cancelled provider result")); }, { once: true })),
      settled: release.promise,
    }));
    try {
      const reply = await f.send("api", { headers: cookieHeaders }).reply;
      expect(reply.body).toEqual(refusal("request_timed_out", "unavailable", 503, "retry"));
      expect(reply.headers["retry-after"]).toBe("1"); expect(cancelled).toHaveBeenCalledOnce();
      expect(f.runtime.requestBudget.active).toBe(1);
    } finally { release.done(); }
  }, 15_000);
});

it("cookie disconnects abort twelve resolutions and retain all initiating slots until real work settles", async () => {
  const f = await fixture("better-auth", undefined, undefined, true), entered = pause(), aborted = pause(), release = pause();
  let calls = 0, cancellations = 0;
  vi.spyOn(f.runtime, "resolveSession").mockImplementation((_headers, { signal } = {}) => {
    if (++calls === 12) entered.done();
    const result = new Promise<null>((_resolve, reject) => signal!.addEventListener("abort", () => { if (++cancellations === 12) aborted.done(); reject(new Error("cancelled public result")); }, { once: true }));
    return { result, settled: release.promise };
  });
  const held = Array.from({ length: 12 }, () => f.send("api", { headers: cookieHeaders })); await entered.promise;
  try {
    for (const h of held) h.call.destroy(); await aborted.promise;
    for (const h of held) await expect(h.reply).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(f.runtime.requestBudget.active).toBe(12);
    const overflow = await f.send("api", { headers: cookieHeaders }).reply; assertCookieCapacity(overflow); expect(calls).toBe(12);
  } finally { release.done(); }
});

it.each([
  ['{"actor":{"kind":"installation"}}', "unexpected_input"],
  ['{"session":{"id":"spoof"}}', "unexpected_input"],
  ['{"x":1,"x":2}', "invalid_request"],
  ['[]', "invalid_request"],
  ['{"unterminated":', "invalid_request"],
])("cookie strict JSON and server-owned authority: %s", async (body, reason) => {
  const f = await fixture("better-auth", undefined, undefined, true);
  const reply = await f.send("api", { headers: cookieHeaders, body }).reply;
  expect(reply.body).toEqual(refusal(reason, "invalid_request", 400, "none")); expect(reply.body).not.toHaveProperty("actor");
  if (reason === "invalid_request") expect(f.provider.resolveRequest).not.toHaveBeenCalled();
});

it("cookie content type and byte ceiling refuse before provider work", async () => {
  const f = await fixture("better-auth", undefined, undefined, true);
  for (const type of ["text/plain", "application/json; charset=utf-8"]) expect((await f.send("api", { headers: { ...cookieHeaders, "Content-Type": type } }).reply).body.error.reason).toBe("invalid_request");
  const reply = await f.send("api", { headers: cookieHeaders, body: " ".repeat(65537) }).reply;
  expect(reply.body).toEqual(refusal("request_too_large", "payload_too_large", 413, "none")); expect(f.provider.resolveRequest).not.toHaveBeenCalled();
});


it("cookie response completion retains the initiating slot after all provider work settled", async () => {
  const f = await fixture("better-auth", undefined, undefined, true), intercepted = pause();
  let finish!: () => void;
  f.controller.server.prependOnceListener("request", (_req, response) => {
    const end = response.end.bind(response);
    response.end = ((...args: Parameters<ServerResponse["end"]>) => { finish = () => { end(...args); }; intercepted.done(); return response; }) as ServerResponse["end"];
  });
  const pending = f.send("api", { headers: cookieHeaders }); await intercepted.promise;
  try {
    expect(f.runtime.requestBudget.active).toBe(1);
    expect(f.provider.resolveRequest).toHaveBeenCalledOnce();
    await f.provider.resolveRequest.mock.results[0].value.settled;
    expect(f.runtime.requestBudget.active).toBe(1);
  } finally { finish(); }
  expect((await pending.reply).status).toBe(200);
  await vi.waitFor(() => expect(f.runtime.requestBudget.active).toBe(0));
});

// The older worker transport suite uses plaintext loopback fixtures. This mount
// additionally exercises real TLS with a short-lived, locally generated certificate.
async function workerFixture(mode = "open", plain = false, fault?: "early_release") {
  const f = await fixture(mode);
  const key = join(f.root, "worker.key"), cert = join(f.root, "worker.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore", timeout: 15_000 });
  const tls = { key: readFileSync(key), cert: readFileSync(cert) };
  const identity = new IdentityService(f.store), authenticate = vi.spyOn(identity, "authenticateBearer"), usage = vi.spyOn(f.store, "recordCredentialUsed");
  const poll = vi.fn(() => ({ version: 1, assignments: [], cancellations: [] })), report = vi.fn(() => ({ acceptedSequence: 1 }));
  const worker = createRemoteVerificationServer({ identity, controller: { poll, report } as unknown as RemoteVerificationController,
    admission: f.store.admission, ...(plain ? { allowLoopbackHttpFixture: true } : { tls }), operations: f.runtime });
  await new Promise<void>(r => worker.server.listen(0, "127.0.0.1", r));
  f.state.workerOpen = true;
  cleanups.push(() => { f.state.workerOpen = false; return worker.close(); });
  if (fault === "early_release") {
    // Mutate just operations ownership, keeping the HTTPS server and its policy.
    const adapter = createOperationsHttp({ runtime: f.runtime, listener: "worker", externallyOwned: true });
    worker.server.removeAllListeners("request"); let active = 0;
    worker.server.on("request", (req, res) => {
      if (active >= 32) { operationsFailure(res, { category: "busy", status: 503, reason: "listener_capacity", retry: "retry", effect: null }); return; }
      active++; res.once("close", () => { active--; }); void adapter.handle(req, res);
    });
    cleanups.push(async () => { adapter.stop(); await adapter.drain(); });
  }
  const driver = createBoundaryDriver({ kind: "worker", server: worker.server, close: worker.close, ...(plain ? {} : { tls: { ca: tls.cert } }),
    legacyPath: "/remote-verification/v1/poll", acceptedCredentials: mode === "open" ? ["none"] : mode === "token" ? ["installation"] : mode === "better-auth" ? ["agent"] : [] });
  return { ...f, worker, driver, authenticate, usage, poll, report };
}

const workerGuard = (reply: Reply, reason: string) => {
  conform(`worker ${reason} boundary`, reply.status, 403);
  expect(reply.body).toEqual(refusal(reason, "forbidden", 403, "none"));
};

describe("worker HTTPS boundary conformance", () => {
  it.each(["open", "token", "better-auth", "legacy"])("stored credential matrix in %s; protocol retains worker authentication", async mode => {
    const f = await workerFixture(mode);
    const rows = [
      [undefined, mode === "open" ? null : "credential_required"],
      [f.installation, mode === "token" ? null : mode === "open" ? "credential_in_open_mode" : "installation_token_in_account_mode"],
      [f.agent, mode === "better-auth" ? null : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here"],
      ...f.storedLegacy.map(row => [row.secret, mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here"]),
      [f.unknownMachine, mode === "better-auth" ? "invalid_credential" : mode === "open" ? "credential_in_open_mode" : "credential_not_accepted_here"],
      ["unknown", "unrecognized_credential"],
    ];
    for (const [secret, reason] of rows) {
      const reply = await f.driver.send({ headers: secret ? auth(secret) : undefined }).reply;
      if (mode !== "legacy" && reason === null) {
        expect(reply.status).toBe(200); expect(reply.body).toMatchObject({ mode, listener: "worker", actor: mode === "better-auth" ? { kind: "agent", accountId: "agent" } : { kind: "installation" } });
        expect(Object.keys(reply.body).sort()).toEqual(["actor", "freshLogin", "fullAuthority", "installationPermissions", "listener", "mode", "projects", "projectsTruncated"].sort());
        expect(reply.headers["cache-control"]).toBe("no-store");
      } else expect(reply.body).toEqual(refusal(mode === "legacy" ? "unknown_mode" : reason!));
    }
    expect((await f.driver.send({ slow: true, headers: { "Content-Type": "application/json", Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("provider_cookie_not_supported"));
    expect(f.authenticate).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
    expect(f.poll).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled(); expect(f.provider.resolveRequest).not.toHaveBeenCalled();
    await f.store.admission.run(() => {
      expect(f.store.getCredentialForAuthentication(f.credentialId)?.lastUsedAt).toBeNull();
      for (const row of f.storedLegacy) expect(f.store.getCredentialForAuthentication(row.secret.slice(4, 40))?.lastUsedAt).toBe(iso(NOW - 1000));
    });
    const headers = auth(f.storedLegacy[1].secret);
    expect((await f.driver.send({ path: f.driver.legacyPath, headers, body: '{"version":1,"workerId":"worker"}' }).reply).body).toEqual({ version: 1, assignments: [], cancellations: [] });
    expect((await f.driver.send({ path: "/remote-verification/v1/report", headers, body: JSON.stringify({ version: 1, workerId: "worker", report: { attemptId: "attempt", sequence: 1, phase: "running", localRunId: "run" } }) }).reply).body).toEqual({ version: 1, acceptedSequence: 1 });
    expect(f.authenticate).toHaveBeenCalledTimes(4); expect(f.poll).toHaveBeenCalledOnce(); expect(f.report).toHaveBeenCalledOnce(); expect(f.usage).toHaveBeenCalledTimes(4);
  });

  it("preserves mixed and duplicate credentials and refuses cookies before any work", async () => {
    const f = await workerFixture("token"), mint = vi.spyOn(f.runtime, "mint");
    for (const headers of [
      ["Host", "localhost", "Content-Type", "application/json", "Content-Length", "2", "Authorization", `Bearer ${f.installation}`, "Authorization", `Bearer ${f.installation}`],
      { ...auth(f.installation), "X-Worktree-Control-Token": f.installation },
      { ...auth(f.installation), "X-Worktree-Switcher-Token": f.installation },
    ]) expect((await f.driver.send({ headers }).reply).body).toEqual(refusal("mixed_credentials"));
    mint.mockClear(); const admission = vi.spyOn(f.store.admission, "run"); let reads = 0;
    f.worker.server.prependListener("request", req => req.on("newListener", name => { if (name === "data") reads++; }));
    for (const mode of ["POST", "GET"]) expect((await f.driver.send({ method: mode, slow: true, headers: { ...auth(f.installation), Cookie: "wtc.session=x" } }).reply).body).toEqual(refusal("provider_cookie_not_supported"));
    expect(reads).toBe(0); expect(mint).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled(); expect(f.runtime.requestBudget.active).toBe(0); expect(f.provider.resolveRequest).not.toHaveBeenCalled();
  });

  it("shares peer and Origin refusals with poll/report and keeps Fetch Metadata policy", async () => {
    const f = await workerFixture(), mint = vi.spyOn(f.runtime, "mint");
    for (const path of [route, f.driver.legacyPath, "/remote-verification/v1/report"]) {
      const reply = await f.driver.send({ path, headers: { "Content-Type": "application/json", Origin: "https://controller.test" } }).reply;
      if (path === route) workerGuard(reply, "origin_forbidden"); else expect(reply.body).toEqual({ error: "origin_forbidden" });
    }
    expect(mint).not.toHaveBeenCalled(); expect(f.authenticate).not.toHaveBeenCalled();
    expect((await f.driver.send({ headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" } }).reply).status).toBe(200);
    const plain = await workerFixture("open", true);
    plain.worker.server.prependListener("request", req => { Object.defineProperty(req.socket, "remoteAddress", { configurable: true, value: "192.0.2.1" }); });
    workerGuard(await plain.driver.send().reply, "loopback_fixture_only");
    expect((await plain.driver.send({ path: plain.driver.legacyPath }).reply).body).toEqual({ error: "loopback_fixture_only" }); expect(plain.authenticate).not.toHaveBeenCalled();
  });

  it.each(["origin_forbidden", "loopback_fixture_only"])("negative control: omitted %s guard has the exact conformance failure", async reason => {
    const f = await workerFixture("open", reason === "loopback_fixture_only");
    // Restore the allowed observation, as an omitted guard would do. Peer is
    // otherwise a controlled socket property; the request still crosses real TLS/HTTP.
    f.worker.server.prependOnceListener("request", req => {
      if (reason === "origin_forbidden") delete req.headers.origin;
      else Object.defineProperty(req.socket, "remoteAddress", { configurable: true, value: "127.0.0.1" });
    });
    const reply = await f.driver.send({ headers: { "Content-Type": "application/json", ...(reason === "origin_forbidden" ? { Origin: "https://hostile.test" } : {}) } }).reply;
    expectFailure(() => workerGuard(reply, reason), `worker ${reason} boundary`, 200, 403);
  });

  it("maintenance refusal shares the existing conformance assertion; provider configuration does not disable bearers", async () => {
    const f = await workerFixture(); assertMaintenance(await maintenanceObservation(f, f.driver));
    f.state.maintenance = false; f.state.configChanged = true;
    expect((await f.driver.send().reply).status).toBe(200); expect(f.provider.resolveRequest).not.toHaveBeenCalled();
  });

  it("raw aliases, methods, JSON and byte limits terminate before poll/report", async () => {
    const f = await workerFixture();
    for (const path of [route + "/", route + "?x=1", route.replace("session.", "session%2e"), "/api/operations/../session.describe", "/x/../api/operations/session.describe", "/api%2foperations/session.describe", "//api/operations/session.describe", "/mcp/operations"]) {
      for (const method of ["POST", "GET", "OPTIONS", "DELETE", "PATCH", "PUT", "HEAD", "TRACE"]) {
        const reply = await f.driver.send({ path, method }).reply; expect(reply.status).toBe(404);
        if (method !== "HEAD") expect(reply.body).toEqual(refusal("operation_not_found", "not_found", 404, "none"));
      }
    }
    for (const method of ["GET", "OPTIONS", "DELETE", "PATCH", "PUT", "HEAD", "TRACE"]) expect((await f.driver.send({ method }).reply).status).toBe(400);
    for (const body of ['{"x":1,"x":2}', '{} {}', '[]', 'null', '{"actor":"operator"}', '{"session":"spoof"}', '{"listener":"unix"}']) expect((await f.driver.send({ body }).reply).status).toBe(400);
    expect((await f.driver.send({ body: " ".repeat(65537) }).reply).body).toEqual(refusal("request_too_large", "payload_too_large", 413, "none"));
    expect((await f.driver.send({ headers: { "Content-Type": "text/plain" } }).reply).status).toBe(400);
    for (const header of ["Host", "Content-Type"]) {
      const reply = await f.driver.send({ headers: ["Content-Length", "2", "Content-Type", "application/json", header, "localhost", header, "localhost"] }).reply;
      expect(reply.status).toBe(400);
    }
    expect((await f.driver.send({ headers: { "Content-Type": "application/json", "X-Actor": "operator", "X-Session": "spoof" } }).reply).body.actor.kind).toBe("installation");
    expect(f.authenticate).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled();
  });

  it("real admission contention keeps its retryable public reason", async () => {
    const f = await workerFixture(), entered = pause(), release = pause();
    const borrowed = f.store.authenticationProviderStorage().borrow(async () => { entered.done(); await release.promise; }); await entered.promise;
    try { const reply = await f.driver.send().reply; expect(reply.body).toEqual(refusal("admission_refused", "busy", 503, "retry")); expect(reply.headers["retry-after"]).toBe("1"); expect(f.authenticate).not.toHaveBeenCalled(); }
    finally { release.done(); await borrowed; }
  });

  it("keeps production connection and request limits for both surfaces", async () => {
    const f = await workerFixture();
    expect(f.worker.server.maxConnections).toBe(32); expect(f.worker.server.requestTimeout).toBe(15000); expect(f.worker.server.headersTimeout).toBe(10000);
    const sockets = Array.from({ length: 32 }, () => f.driver.connection());
    try {
      await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); })));
      await expect(f.driver.send().reply).rejects.toMatchObject({ code: "ECONNRESET" });
      await expect(f.driver.send({ path: f.driver.legacyPath }).reply).rejects.toMatchObject({ code: "ECONNRESET" });
    } finally { for (const socket of sockets) socket.destroy(); }
  });

  it("disconnect retains capacity until started work settles", async () => { const f = await workerFixture(); await disconnectedCapacity(f, f.driver, false); });
  it("negative control: early capacity release fails with 200 versus 503", async () => { const f = await workerFixture("open", false, "early_release"); await disconnectedCapacity(f, f.driver, true); });
  it("negative control: premature success fails the shared maintenance release assertion", async () => {
    const f = await workerFixture(); const reply = await bufferedRelease(f, f.driver, true);
    expectFailure(() => assertMaintenanceRelease(reply), "maintenance release status", 200, 401);
  });

  it.each(["maintenance", "credential", "grant", "deadline", "disconnect", "listener"])("fresh release after runner completion rechecks %s", async change => {
    const f = await workerFixture("better-auth"); if (!f.built.supported) throw new Error("supported fixture"); await f.grant();
    const runner = f.built.runner, real = runner.readRelease.bind(runner), entered = pause(), release = pause();
    vi.spyOn(runner, "readRelease").mockImplementation(async (operation, context, raw, options) => {
      if (operation.kind === "stream") throw new Error("read required"); const prior = await runner.run(operation, context, raw); expect(prior.ok).toBe(true);
      entered.done(); await release.promise; return real(operation, context, raw, options);
    });
    const pending = f.driver.send({ headers: auth(f.agent) }); await entered.promise;
    try {
      if (change === "maintenance") f.state.maintenance = true;
      if (change === "credential") await f.store.admission.run(() => f.db.prepare("UPDATE principal_credentials SET status='revoked' WHERE id=?").run(f.credentialId));
      if (change === "grant") await f.store.admission.run(() => f.db.prepare("DELETE FROM account_grants WHERE account_id='agent'").run());
      if (change === "deadline") f.clock.offset = OPERATIONS_HTTP_LIMITS.deadlineMs + 1;
      if (change === "listener") f.state.workerOpen = false;
      if (change === "disconnect") { pending.call.destroy(); await new Promise<void>(r => setImmediate(r)); }
    } finally { release.done(); }
    if (change === "disconnect") await expect(pending.reply).rejects.toMatchObject({ code: "ECONNRESET" });
    else { const reply = await pending.reply; if (change === "grant") { expect(reply.status).toBe(200); expect(reply.body.projects).toEqual([]); } else { expect(reply.status).toBeGreaterThanOrEqual(400); expect(reply.body).not.toHaveProperty("actor"); } }
  });

  it("deadline aborts pending mint, retains ownership, and shutdown joins work before SQLite and lock release", async () => {
    const f = await workerFixture(), entered = pause(), release = pause(), cancelled = pause();
    const lockPath = join(f.root, "controller.lock"), lock = acquireControllerLock(lockPath);
    cleanups.push(() => lock.release());
    f.hooks.beforeMint = signal => signal?.addEventListener("abort", cancelled.done, { once: true });
    f.hooks.afterMint = async () => { entered.done(); await release.promise; };
    const pending = f.driver.send(); await entered.promise;
    await cancelled.promise;
    const closed = vi.fn(), released = vi.fn(); let done = false;
    const shutdown = createControllerShutdown({ service: { closeAdmission() { f.state.stopping = true; }, async shutdown() { f.store.close(); closed(); } },
      stopping: f.worker.stopOperations, userSchedules: undefined, backups: { close() {} }, remoteVerification: f.worker, mcp: null,
      controller: f.controller, adminSocket: f.admin, controllerLock: { ...lock, release() { lock.release(); released(); } }, removeServiceAccess() {} });
    const draining = shutdown().then(() => { done = true; });
    await new Promise<void>(r => setImmediate(r)); expect(done).toBe(false); expect(closed).not.toHaveBeenCalled(); expect(released).not.toHaveBeenCalled(); expect(existsSync(lockPath)).toBe(true);
    await f.store.admission.run(() => expect(f.db.prepare("SELECT 1 AS present").get()).toEqual({ present: 1 }));
    release.done(); const reply = await pending.reply; expect(reply.status).toBeGreaterThanOrEqual(400); expect(reply.body).not.toHaveProperty("actor"); await draining; expect(released).toHaveBeenCalledOnce();
  }, 15_000);

  it("response completion retains capacity and the response ceiling commits one refusal", async () => {
    const f = await workerFixture(), reached = pause(); let finish!: () => void;
    f.worker.server.prependOnceListener("request", (_req, response) => {
      const end = response.end.bind(response);
      response.end = ((...args: Parameters<ServerResponse["end"]>) => { finish = () => { end(...args); }; reached.done(); return response; }) as ServerResponse["end"];
    });
    const pending = f.driver.send(); await reached.promise; let drained = false;
    const closing = f.worker.close().then(() => { drained = true; });
    await new Promise<void>(r => setImmediate(r)); expect(drained).toBe(false); finish(); await pending.reply; await closing;
    const oversized = await workerFixture(); if (!oversized.built.supported) throw new Error("supported fixture");
    vi.spyOn(oversized.built.runner, "readRelease").mockImplementation(async (_operation, _context, _raw, options) => {
      options.commit({ fixture: "x".repeat(OPERATIONS_HTTP_LIMITS.responseBytes) }); return { status: "committed" };
    });
    expect((await oversized.driver.send().reply).body).toEqual(refusal("response_too_large", "payload_too_large", 413, "none"));
  });

  it("without listener configuration no server or namespace is mounted", async () => {
    const f = await fixture();
    expect(createRemoteVerificationRuntime(null, {} as never)).toBeNull();
    // No operations option means no mount even when the protocol listener exists.
    const protocolOnly = createRemoteVerificationServer({ controller: {} as never, identity: new IdentityService(f.store), allowLoopbackHttpFixture: true });
    await new Promise<void>(r => protocolOnly.server.listen(0, "127.0.0.1", r)); cleanups.push(protocolOnly.close);
    const driver = createBoundaryDriver({ kind: "worker", server: protocolOnly.server, close: protocolOnly.close, legacyPath: "/remote-verification/v1/poll", acceptedCredentials: [] });
    expect((await driver.send().reply).body).toEqual({ error: "protocol_not_found" });
    const minted = f.built.supported ? await f.built.mint("worker", { bearers: [], providerSession: null, browserHeaders: false, legacySecret: false }, null, {}) : undefined;
    expect(minted).toMatchObject({ ok: false, error: { reason: "listener_closed" } });
  });
});
