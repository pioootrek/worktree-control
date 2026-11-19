import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { createControllerOperationEligibility } from "@/server/bootstrap/authentication-provider-lifetime";
import { AuthenticationRequestBudget } from "@/server/bootstrap/authentication-request-budget";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { resolveAppPaths } from "@/server/paths";
import { IdentityService } from "@/server/modules/identity";
import { createOperationsMcp, isOperationsMcpOrigin, OPERATIONS_MCP_TOOLS } from "@/server/transports/operations-mcp";
import { operationsFailure, type OperationsHttpRuntime } from "@/server/transports/operations-http";
import { SESSION_COOKIE } from "@/server/transports/authentication-http-boundary";
import { createBoundaryDriver, conform, ConformanceFailure } from "./http-boundary-driver";
import { acceptanceTable, resolveAcceptance } from "./acceptance";
import { hash, iso, NOW, token } from "./adapters/credential-verifier-fixture";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });
const pause = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; };
const list = { jsonrpc: "2.0", id: 7, method: "tools/list" };
const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "session_describe", arguments: {} } };
const initialize = { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const notification = { jsonrpc: "2.0", method: "notifications/initialized" };

type Fault = "premature_write" | "early_release" | "omit_list_authentication";
async function fixture(mode = "open", limits?: Parameters<typeof createOperationsMcp>[0]["limits"], fault?: Fault) {
  const root = mkdtempSync(join(tmpdir(), "operations-mcp-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath, undefined, { admission: "strict", admissionTimeoutMs: 75 });
  cleanups.push(() => store.close());
  const admission = store.admission;
  vi.spyOn(store, "admission", "get").mockReturnValue(admission);
  const db = ownedFixtureDatabase(store), installation = token("wsi"), agent = token("wts"), other = token("wts"), owner = token("wts"), worker = token("wts");
  await admission.run(() => {
    const policy = store.getAuthenticationPolicy();
    store.saveAuthenticationPolicy({ ...policy, mode: mode as "open", token: { id: installation.slice(4, 40), prefix: installation.slice(0, 40), verifierHash: hash(installation), createdAt: iso(NOW) } }, "fixture", "fixture");
    for (const [id, kind, secret, credentialKind] of [["agent", "agent", agent, "agent_token"], ["other", "agent", other, "agent_token"], ["owner", "owner", owner, "owner_session"], ["worker", "worker", worker, "worker_token"]] as const) {
      store.savePrincipal({ id, kind, status: "active" }, "fixture");
      store.saveCredential({ id: secret.slice(4, 40), principalId: id, kind: credentialKind, label: "fixture", tokenPrefix: secret.slice(0, 40), verifierHash: hash(secret), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
    }
    store.saveKnowledgeProject({ id: "project-a", name: "fixture", status: "active", revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW) }, "fixture");
  });
  const used = vi.spyOn(store, "recordCredentialUsed");
  const legacy = vi.spyOn(IdentityService.prototype, "authenticateBearer");
  const state = { maintenance: false, stopping: false, configChanged: false, offset: 0 };
  const eligibility = createControllerOperationEligibility({ maintenance: () => state.maintenance, stopping: () => state.stopping, configurationRestartRequired: () => state.configChanged, runtime: () => undefined });
  const built = buildOperationsRuntime({ store, activeMode: mode, now: () => Date.now() + state.offset, logs: { controller() {} }, provider: null,
    eligibility, requestBudget: new AuthenticationRequestBudget(16, 4), listeners: { mcp: () => true } });
  if (!built.supported) throw new Error("fixture mode unsupported");
  const handles: Promise<void>[] = [];
  const hooks: { beforeHandle?: (request: IncomingMessage, response: ServerResponse) => void; beforeFinal?: (response: ServerResponse) => void | Promise<void>; beforeMint?: (signal?: AbortSignal) => void | Promise<void> } = {};
  let currentResponse!: ServerResponse;
  const minted = vi.fn(async (...args: Parameters<typeof built.mint>) => {
    await hooks.beforeMint?.(args[3].signal);
    return built.mint(...args);
  });
  const readRelease: typeof built.runner.readRelease = async (operation, context, input, options) => {
    if (options.expectedCanonical !== undefined) {
      const response = currentResponse;
      if (fault === "premature_write") response.end(JSON.stringify({ stale: true }));
      await hooks.beforeFinal?.(response);
    }
    return built.runner.readRelease(operation, context, input, options);
  };
  const runtime = { ...built, mint: minted, runner: { readRelease } } satisfies OperationsHttpRuntime;
  const adapter = createOperationsMcp({ runtime, limits });
  // Fault owners are deliberate negative controls; the actual adapter is unchanged.
  let brokenActive = 0;
  const server = createServer((request, response) => {
    currentResponse = response;
    if (fault === "omit_list_authentication" && request.headers["x-omit-authentication"]) {
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: OPERATIONS_MCP_TOOLS } })); return;
    }
    if (fault === "early_release") {
      if (brokenActive) { operationsFailure(response, { category: "busy", reason: "listener_capacity", retry: "retry", effect: null, status: 503 }); return; }
      brokenActive++; response.once("close", () => { brokenActive--; });
    }
    hooks.beforeHandle?.(request, response);
    const handle = adapter.handle(request, response); handles.push(handle);
    void handle;
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { adapter.stop(); server.closeAllConnections(); await adapter.drain(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const driver = createBoundaryDriver({ kind: "api", server, legacyPath: "/unused", close: async () => {}, acceptedCredentials: [] });
  const auth = (secret?: string): Record<string, string> => secret ? { Authorization: `Bearer ${secret}` } : {};
  const send = (body: unknown = call, secret?: string, headers: Record<string, string> = {}, extra: Parameters<typeof driver.send>[0] = {}) => driver.send({ path: "/mcp/operations", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...auth(secret), ...headers }, ...extra });
  const client = async (secret?: string) => {
    const c = new Client({ name: "conformance", version: "1" }); cleanups.push(() => c.close());
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/operations`), { requestInit: { headers: auth(secret) } }));
    return c;
  };
  const credential = mode === "token" ? installation : mode === "better-auth" ? agent : undefined;
  const grant = () => admission.run(() => db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent','reader','project','project-a',?)").run(iso(NOW)));
  return { root, store, db, admission, state, built, runtime, minted, hooks, handles, adapter, server, driver, send, client, installation, agent, other, owner, worker, credential, used, legacy, grant };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const operationError = (reply: Awaited<ReturnType<Fixture["send"]>["reply"]>) => reply.body.error?.data ?? reply.body.error;
async function exactNegative(assertion: string, observed: unknown, expected: unknown) {
  let failure: unknown;
  try { conform(assertion, observed, expected); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ConformanceFailure);
  expect(failure).toMatchObject({ assertion, observed, expected });
}

describe("unmounted request-scoped MCP adapter", () => {
  it.each(["open", "token", "better-auth"])("%s: real SDK sequential initialize, notification, list and call, with no usage writer", async mode => {
    const f = await fixture(mode), client = await f.client(f.credential);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(["session_describe"]);
    const result = await client.callTool({ name: "session_describe", arguments: {} });
    expect(result.structuredContent).toMatchObject({ mode, listener: "mcp", actor: { kind: mode === "better-auth" ? "agent" : "installation", accountId: mode === "better-auth" ? "agent" : null } });
    expect(f.minted).toHaveBeenCalledTimes(4);
    expect(f.minted.mock.calls.every(args => args[0] === "mcp")).toBe(true);
    expect(f.legacy).not.toHaveBeenCalled(); expect(f.used).not.toHaveBeenCalled();
    expect(await f.admission.run(() => f.db.prepare("SELECT last_used_at FROM principal_credentials").all())).toEqual(Array(4).fill({ last_used_at: null }));
    expect(OPERATIONS_MCP_TOOLS.map(t => t.operation)).toEqual(f.built.registry.idsOn("mcp"));
    expect(new Set(OPERATIONS_MCP_TOOLS.map(t => t.name)).size).toBe(OPERATIONS_MCP_TOOLS.length);
  });

  it.each(["open", "token", "better-auth"])("%s: exact acceptance table on every JSON-RPC method", async mode => {
    const f = await fixture(mode);
    for (const message of [initialize, notification, list, call]) {
      for (const secret of [undefined, f.installation, f.agent, f.owner, f.worker, "unrecognized", token("wts")]) {
        const wire = secret ? { bearers: [{ class: secret.startsWith("wsi_") ? "installation_token" as const : secret.startsWith("wts_") ? "agent_token" as const : "unrecognized" as const, secret }], providerSession: null, browserHeaders: false, legacySecret: false } : { bearers: [], providerSession: null, browserHeaders: false, legacySecret: false };
        const accepted = resolveAcceptance(mode, "mcp", wire);
        const reply = await f.send(message, secret).reply;
        const invalid = secret === f.owner || secret === f.worker || (secret?.startsWith("wts_") && secret !== f.agent);
        const reason = !accepted.accepted ? accepted.reason : invalid ? "invalid_credential" : null;
        if (reason) expect(operationError(reply)).toMatchObject({ category: "unauthenticated", reason });
        else expect(reply.status).toBe(message === notification ? 202 : 200);
      }
    }
    expect(acceptanceTable.filter(row => row.mode === mode && row.listener === "mcp")).toHaveLength(1);
  });

  it("separates concurrent principals with identical RPC IDs and ignores session/resumption headers", async () => {
    const f = await fixture("better-auth");
    const replies = await Promise.all([f.agent, f.other].map(secret => f.send(call, secret, { "Mcp-Session-Id": "forged", "Last-Event-ID": "forged", "X-Mcp-Session-Id": "forged" }).reply));
    expect(replies.map(r => r.body.result.structuredContent.actor.accountId)).toEqual(["agent", "other"]);
    expect(replies.map(r => r.body.id)).toEqual([7, 7]);
    expect(replies.every(r => r.headers["mcp-session-id"] === undefined)).toBe(true);
  });

  it("cookie preflight precedes body, capacity, admission, method and alias checks", async () => {
    const f = await fixture("better-auth", { maxInFlight: 0 });
    const run = vi.spyOn(f.admission, "run");
    const reply = await f.send(call, f.agent, { Cookie: `${SESSION_COOKIE}=opaque`, "Content-Type": "text/plain" }, { path: "/mcp/operations?alias", method: "GET", slow: true }).reply;
    expect(reply.status).toBe(401); expect(operationError(reply).reason).toBe("provider_cookie_not_supported");
    expect(f.minted).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it("rejects batches, methods, aliases, bad Origin and strict-body/header violations", async () => {
    const f = await fixture();
    expect(operationError(await f.send([call]).reply).reason).toBe("invalid_request");
    for (const method of ["GET", "DELETE", "PUT"]) {
      const reply = await f.send(call, undefined, {}, { method }).reply;
      expect(reply.status).toBe(405); expect(reply.headers.allow).toBe("POST");
    }
    for (const path of ["/mcp/operations/", "/mcp/operations?x=1", "/mcp%2foperations", "/x/../mcp/operations", "//mcp/operations", "/mcp/operations.json"]) {
      const reply = await f.send(call, undefined, {}, { path }).reply;
      expect(reply.status).toBe(404); expect(operationError(reply).reason).toBe("operation_not_found");
    }
    const badOrigin = await f.send(call, undefined, { Origin: "https://evil.invalid" }).reply;
    expect(operationError(badOrigin)).toMatchObject({ category: "forbidden", reason: "origin_forbidden" });
    expect(operationError(await f.send(call, undefined, {}, { body: '{"method":"tools/list","method":"tools/call"}' }).reply).reason).toBe("invalid_request");
    expect(operationError(await f.send(call, undefined, {}, { body: Buffer.from([0xff]) }).reply).reason).toBe("invalid_request");
    const duplicate = await f.send(call, undefined, {}, { headers: ["Host", "localhost", "Content-Length", String(Buffer.byteLength(JSON.stringify(call))), "Content-Type", "application/json", "Content-Type", "application/json"] }).reply;
    expect(operationError(duplicate).reason).toBe("invalid_request");
    expect(f.minted).not.toHaveBeenCalled();
  });

  it("bounds request bytes and SDK response bytes, including before Response construction", async () => {
    const f = await fixture("open", { bodyBytes: 200, responseBytes: 100 });
    expect(operationError(await f.send(call, undefined, {}, { body: JSON.stringify({ data: "x".repeat(201) }) }).reply)).toMatchObject({ reason: "request_too_large", category: "payload_too_large" });
    const originalSend = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send");
    expect(operationError(await f.send(call).reply)).toMatchObject({ reason: "response_too_large", category: "payload_too_large", status: 413 });
    expect(originalSend).not.toHaveBeenCalled();
  });

  it("compares canonical loopback Origins using effective HTTP ports", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(isOperationsMcpOrigin(`http://${host}`, 80)).toBe(true);
      expect(isOperationsMcpOrigin(`http://${host}:1234`, 1234)).toBe(true);
      for (const origin of [`http://${host}`, `http://${host}:80`, `http://${host}:1234/`, `https://${host}:1234`, `http://user@${host}:1234`]) {
        expect(isOperationsMcpOrigin(origin, 1234), origin).toBe(false);
      }
      expect(isOperationsMcpOrigin(`http://${host}:80`, 80)).toBe(false); // non-canonical spelling
    }
    for (const origin of ["null", "broken", "http://evil.invalid", "http://127.0.0.2", "http://LOCALHOST"]) {
      expect(isOperationsMcpOrigin(origin, 80), origin).toBe(false);
    }
    expect(isOperationsMcpOrigin("http://localhost", undefined)).toBe(false);
  });

  it("contains SDK close rejection and holds capacity until real Node finish, cleaning up exactly once", async () => {
    const f = await fixture("open", { maxInFlight: 1, deadlineMs: 12_345 });
    const closeCalled = pause(), written = pause();
    const close = vi.spyOn(Server.prototype, "close").mockImplementationOnce(async () => { closeCalled.done(); throw new Error("faulted SDK disposal"); });
    const timers = vi.spyOn(globalThis, "setTimeout"), clear = vi.spyOn(globalThis, "clearTimeout");
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    cleanups.push(() => { process.off("unhandledRejection", unhandled); });
    let request!: IncomingMessage, response!: ServerResponse, completeWrite!: () => void, restoreWrites!: () => void;
    let before!: ReturnType<IncomingMessage["rawListeners"]>[];
    f.hooks.beforeHandle = (req, res) => {
      request = req; response = res;
      before = [req.rawListeners("aborted"), req.rawListeners("error"), res.rawListeners("finish"), res.rawListeners("close")];
      const socket = res.socket!;
      const hold = (callback: (error?: Error | null) => void) => (error?: Error | null) => {
        completeWrite = () => callback(error); written.done();
      };
      const write = socket._write.bind(socket), writev = socket._writev!.bind(socket);
      const single = vi.spyOn(socket, "_write").mockImplementation((chunk, encoding, callback) => write(chunk, encoding, hold(callback)));
      const batch = vi.spyOn(socket, "_writev").mockImplementation((chunks, callback) => writev(chunks, hold(callback)));
      restoreWrites = () => { single.mockRestore(); batch.mockRestore(); };
    };
    const pending = f.send(call);
    await closeCalled.promise; await written.promise;
    f.hooks.beforeHandle = undefined;
    const requestTimer = timers.mock.results[timers.mock.calls.findIndex(args => args[1] === 12_345)].value;
    let settled = 0, rejected: unknown;
    void f.handles[0].then(() => { settled++; }, error => { rejected = error; });
    try {
      expect(response.writableEnded).toBe(true); expect(response.writableFinished).toBe(false);
      expect(operationError(await f.send(list).reply).reason).toBe("listener_capacity");
      expect(settled).toBe(0); expect(rejected).toBeUndefined();
      expect(clear.mock.calls.filter(args => args[0] === requestTimer)).toHaveLength(0);
    } finally { restoreWrites(); completeWrite(); }
    expect((await pending.reply).status).toBe(200);
    await expect(f.handles[0]).resolves.toBeUndefined(); await f.adapter.drain();
    expect(settled).toBe(1); expect(rejected).toBeUndefined(); expect(unhandled).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls.filter(args => args[0] === requestTimer)).toHaveLength(1);
    const remaining = [request.rawListeners("aborted"), request.rawListeners("error"), response.rawListeners("finish"), response.rawListeners("close")];
    expect(remaining.map((listeners, index) => listeners.filter(listener => !before[index].includes(listener)))).toEqual([[], [], [], []]);
    expect((await f.send(list).reply).status).toBe(200); await f.adapter.drain();
    const aborts = vi.spyOn(AbortController.prototype, "abort");
    f.adapter.stop(); f.adapter.stop(); expect(aborts).not.toHaveBeenCalled();
  });

  it.each(["deadline", "stop", "disconnect"])("interrupts a never-settling SDK connect on %s", async kind => {
    const f = await fixture("open", { maxInFlight: 1, deadlineMs: kind === "deadline" ? 100 : 12_345 });
    const reached = pause();
    vi.spyOn(Server.prototype, "connect").mockImplementationOnce(() => { reached.done(); return new Promise<void>(() => {}); });
    const close = vi.spyOn(Server.prototype, "close");
    const pending = f.send(call); await reached.promise;
    if (kind === "stop") f.adapter.stop();
    if (kind === "disconnect") pending.call.destroy();
    if (kind === "disconnect") await expect(pending.reply).rejects.toThrow();
    else expect(operationError(await pending.reply)).toMatchObject({ category: "unavailable", reason: kind === "deadline" ? "request_timed_out" : "request_cancelled", retry: "retry", effect: null, status: 503 });
    await expect(f.handles[0]).resolves.toBeUndefined(); await f.adapter.drain();
    expect(close).toHaveBeenCalledTimes(1);
    if (kind !== "stop") expect((await f.send(list).reply).status).toBe(200);
  });

  it("retains capacity after Node finish until pending SDK disposal settles", async () => {
    const f = await fixture("open", { maxInFlight: 1 });
    const disposing = pause(), disposed = pause();
    vi.spyOn(Server.prototype, "close").mockImplementationOnce(() => { disposing.done(); return disposed.promise; });
    const pending = f.send(call); await disposing.promise;
    try {
      expect((await pending.reply).status).toBe(200);
      expect(operationError(await f.send(list).reply).reason).toBe("listener_capacity");
    } finally { disposed.done(); }
    await f.adapter.drain(); expect((await f.send(list).reply).status).toBe(200);
  });

  it.each(["maintenance", "revoke", "grants", "deadline", "disconnect", "stop", "configuration"])("rechecks %s after SDK buffering and before Node write", async change => {
    const f = await fixture("better-auth"); await f.grant();
    const reached = pause(), resume = pause();
    let response!: ServerResponse;
    f.hooks.beforeFinal = res => { response = res; reached.done(); return resume.promise; };
    const pending = f.send(call, f.agent); await reached.promise;
    expect(response.headersSent).toBe(false);
    if (change === "maintenance") f.state.maintenance = true;
    if (change === "revoke") await f.admission.run(() => f.db.prepare("UPDATE principal_credentials SET status='revoked' WHERE id=?").run(f.agent.slice(4, 40)));
    if (change === "grants") await f.admission.run(() => f.db.prepare("DELETE FROM account_grants").run());
    if (change === "deadline") f.state.offset = 20_000;
    if (change === "stop") f.adapter.stop();
    if (change === "disconnect") { pending.call.destroy(); await new Promise<void>(resolve => response.once("close", resolve)); }
    if (change === "configuration") f.state.configChanged = true;
    resume.done();
    if (change === "disconnect") { await expect(pending.reply).rejects.toThrow(); await f.adapter.drain(); expect(response.headersSent).toBe(false); }
    else {
      const reply = await pending.reply;
      const reasons: Record<string, string | undefined> = { maintenance: "listener_closed", revoke: "credential_no_longer_valid", grants: "release_payload_changed", deadline: "release_timed_out", stop: "request_cancelled" };
      const reason = reasons[change];
      if (reason) { expect(operationError(reply).reason).toBe(reason); expect(reply.body.result).toBeUndefined(); }
      else expect(reply.body.result.structuredContent.actor.accountId).toBe("agent"); // provider-only configuration does not invalidate agents
    }
  });

  it.each(["disconnect", "deadline"])("%s retains capacity until started admission work settles, cleanup is repeatable", async kind => {
    const f = await fixture("open", { maxInFlight: 1, deadlineMs: kind === "deadline" ? 100 : 10_000 });
    const reached = pause(), resume = pause();
    f.hooks.beforeFinal = () => { reached.done(); return resume.promise; };
    const pending = f.send(call); await reached.promise;
    if (kind === "disconnect") pending.call.destroy();
    else await new Promise<void>(resolve => setTimeout(resolve, 150));
    expect(operationError(await f.send(list).reply).reason).toBe("listener_capacity");
    let drained = false; const draining = f.adapter.drain().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    resume.done();
    if (kind === "disconnect") await expect(pending.reply).rejects.toThrow();
    else expect(operationError(await pending.reply)).toMatchObject({ reason: "request_cancelled", retry: "retry" });
    await draining;
    f.hooks.beforeFinal = undefined;
    expect((await f.send(list).reply).status).toBe(200);
    f.adapter.stop(); f.adapter.stop(); await f.adapter.drain(); await f.adapter.drain();
  });

  it("preserves exact retryable admission contention and aborted-admission errors", async () => {
    const f = await fixture(); const held = pause(), release = pause();
    const borrow = f.store.authenticationProviderStorage().borrow(async () => { held.done(); await release.promise; }); await held.promise;
    try {
      const busy = await f.send(list).reply;
      expect(operationError(busy)).toMatchObject({ category: "busy", reason: "admission_refused", retry: "retry" });
      expect(busy.headers["retry-after"]).toBe("1");
    } finally { release.done(); await borrow; }
    const reached = pause(), heldAgain = pause(), releaseAgain = pause();
    const borrowed = f.store.authenticationProviderStorage().borrow(async () => { heldAgain.done(); await releaseAgain.promise; }); await heldAgain.promise;
    f.hooks.beforeMint = () => { reached.done(); };
    try {
      const pending = f.send(list); await reached.promise; f.adapter.stop();
      expect(operationError(await pending.reply)).toMatchObject({ category: "unavailable", reason: "request_cancelled", retry: "retry" });
    } finally { releaseAgain.done(); await borrowed; }
  });

  it.each(["open", "token", "better-auth"])("%s preserves duplicate/mixed credentials and fixed cookie refusals", async mode => {
    const f = await fixture(mode), body = JSON.stringify(call);
    for (const headers of [
      ["Authorization", `Bearer ${f.agent}`, "Authorization", `Bearer ${f.agent}`],
      ["Authorization", `Bearer ${f.agent}`, "X-Worktree-Control-Token", f.installation],
    ]) {
      const reply = await f.send(call, undefined, {}, { headers: ["Host", "localhost", "Content-Length", String(Buffer.byteLength(body)), "Content-Type", "application/json", ...headers] }).reply;
      expect(operationError(reply)).toMatchObject({ category: "unauthenticated", reason: "mixed_credentials" });
    }
    for (const message of [initialize, notification, list, call]) {
      expect(operationError(await f.send(message, f.credential, { Cookie: `${SESSION_COOKIE}=opaque` }).reply).reason).toBe("provider_cookie_not_supported");
    }
  });

  it("retains capacity after SDK disposal until the real Node response completes", async () => {
    const f = await fixture("open", { maxInFlight: 1 }), intercepted = pause();
    let finish!: () => void;
    f.server.prependOnceListener("request", (_request, response) => {
      const end = response.end.bind(response);
      response.end = ((...args: Parameters<ServerResponse["end"]>) => { finish = () => { end(...args); }; intercepted.done(); return response; }) as ServerResponse["end"];
    });
    const pending = f.send(call); await intercepted.promise;
    try { expect(operationError(await f.send(list).reply).reason).toBe("listener_capacity"); }
    finally { finish(); }
    expect((await pending.reply).body.result.structuredContent.listener).toBe("mcp");
    await f.adapter.drain(); expect((await f.send(list).reply).status).toBe(200);
  });

  it("returns safe tool refusals without losing operations reasons", async () => {
    const f = await fixture();
    for (const [params, reason] of [[{ name: "other" }, "operation_not_found"], [{ name: "session_describe", arguments: { extra: true } }, "unexpected_input"]] as const) {
      const reply = await f.send({ ...call, params }).reply;
      expect(reply.body.result.isError).toBe(true);
      expect(reply.body.result.structuredContent.error.reason).toBe(reason);
    }
  });

  it("negative control identifies the exact premature-write failure", async () => {
    const f = await fixture("open", undefined, "premature_write");
    let observed = false;
    f.hooks.beforeFinal = response => { observed = response.headersSent; };
    expect((await f.send(call).reply).body).toEqual({ stale: true });
    await exactNegative("Node write before release", observed, false);
  });

  it("negative control identifies the exact early-slot-release failure", async () => {
    const f = await fixture("open", { maxInFlight: 2 }, "early_release");
    const reached = pause(), resume = pause();
    f.hooks.beforeFinal = () => { reached.done(); return resume.promise; };
    const pending = f.send(call); await reached.promise; pending.call.destroy();
    await expect(pending.reply).rejects.toThrow(); await new Promise<void>(resolve => setTimeout(resolve, 20));
    f.hooks.beforeFinal = undefined;
    await exactNegative("capacity until settlement", (await f.send(list).reply).status, 503);
    resume.done(); await f.adapter.drain();
  });

  it("negative control identifies the exact omitted tools/list authentication", async () => {
    const f = await fixture("token", undefined, "omit_list_authentication");
    await exactNegative("tools/list authentication", (await f.send(list, undefined, { "X-Omit-Authentication": "1" }).reply).status, 401);
    expect(f.minted).not.toHaveBeenCalled();
  });
});
