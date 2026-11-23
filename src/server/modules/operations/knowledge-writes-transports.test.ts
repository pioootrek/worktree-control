// test-tier: heavy (network listeners, durable SQLite stores)
import { writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { acquireControllerLock } from "@/server/controller-lock";
import type { ControlService } from "@/server/control-service";
import { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { createHttpServerCloser } from "@/server/http-server-lifecycle";
import { ExclusiveSqliteConnection } from "@/server/infrastructure/sqlite/exclusive-connection";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createOperationsHttp, OPERATIONS_HTTP_LIMITS, type OperationsHttpRuntime } from "@/server/transports/operations-http";
import { createOperationsMcp, OPERATIONS_MCP_REQUEST_ENVELOPE_BYTES, withoutIdempotencyArgument } from "@/server/transports/operations-mcp";
import type { OperationRetention } from "@/server/bootstrap/operation-retention";
import { answer, knowledgeFixture, type GrantRows, type KnowledgeFixture, type StoredMode } from "./knowledge-writes-fixture";
import { NOW, presentedBearer } from "./adapters/credential-verifier-fixture";
import type { IdempotencyStore, MutationReleaseResult } from "./runner";

/**
 * D2b-2 decision 10 on HTTP: `knowledge.create_thread` through the real
 * production composition (store, verifiers, grants, resolver, retention) on
 * the API, unix and worker adapters, and on the externally owned admin socket.
 * Covers header carriage, the singleton key header, a key on a read, both
 * sides of each body ceiling, the worker refusal, an unknown mode, a principal
 * ID outside the grammar, concurrent keys, and ownership around the commit
 * point; on MCP, the strict request classification, a pending SDK staging and
 * its late settlement, the server's closes, the real owner shutdown (with a
 * held response and with a finished one under an unsettled handler), and where
 * each adapter writes relative to the real gate.
 */
/** Project grants rows, written directly: no release command grants a project role yet. */
const grants: GrantRows = {
  insert: (database, account, role, projectId) => database.prepare(
    "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,'project',?,?)").run(account, role, projectId, new Date(NOW).toISOString()),
  remove: (database, account, role) => {
    if (role) database.prepare("DELETE FROM account_grants WHERE account_id=? AND role=?").run(account, role);
    else database.prepare("DELETE FROM account_grants WHERE account_id=?").run(account);
  },
};
const fixtures: KnowledgeFixture[] = [];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  for (const f of fixtures.splice(0)) f.cleanup();
  vi.restoreAllMocks();
});
type Reply = { status: number; body: Record<string, unknown>; headers: IncomingMessage["headers"] };
type Listener = "api" | "unix" | "worker";

const pause = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve; }); return { promise, done }; };

async function transports(mode: StoredMode, setup: { humans?: boolean; mcpDeadlineMs?: number } = {}) {
  const f = await knowledgeFixture(mode, { humans: setup.humans, grants }); fixtures.push(f);
  // `respond` sees every server-side response before its adapter handles the request.
  // `returning` runs after a mutation release has returned, before the adapter sees its result: outside admission.
  const hooks: { reserved?: () => void; written?: () => void; staged?: () => void; returning?: () => Promise<void>; respond?: (response: ServerResponse) => void } = {};
  // Observation points inside the admitted phases, on the real writer and the real idempotency store.
  const store = f.store, writerOf = store.knowledgeThreadWriter.bind(store);
  store.knowledgeThreadWriter = () => {
    const writer = writerOf();
    return { ...writer, createThread: (thread, author) => { writer.createThread(thread, author); hooks.written?.(); } };
  };
  const real = f.retention;
  const idempotency: IdempotencyStore | undefined = real ? {
    get: key => real.idempotency.get(key),
    put: (key, record) => { real.idempotency.put(key, record); if (record.state === "reserved") hooks.reserved?.(); },
    release: (key, attempt) => real.idempotency.release(key, attempt),
  } : undefined;
  const retention: OperationRetention | null = real && idempotency ? { idempotency, fingerprintKey: real.fingerprintKey } : null;
  const published: string[] = [];
  const composed = buildOperationsRuntime({ ...f.runtimeOptions(), retention, knowledge: { changed: (projectId: string) => { published.push(projectId); } } });
  // The composition is frozen; the adapters get a copy whose mint counts its calls.
  const minted = { count: 0 };
  const built = composed.supported ? { ...composed, mint: (...args: Parameters<typeof composed.mint>) => { minted.count++; return composed.mint(...args); } } : composed;
  const adapters = {} as Record<Listener, ReturnType<typeof createOperationsHttp>>;
  const servers = {} as Record<Listener, HttpServer>;
  const responses: ServerResponse[] = [];
  for (const listener of ["api", "unix", "worker"] as const) {
    const adapter = createOperationsHttp({ runtime: built, listener });
    const server = createServer((request, response) => { responses.push(response); hooks.respond?.(response); void adapter.handle(request, response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { adapter.stop(); await adapter.drain(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    adapters[listener] = adapter; servers[listener] = server;
  }
  // The MCP adapter over the same composition; `staged` observes the moment the SDK holds the buffered output,
  // and `releases` keeps what each of its mutation releases returned.
  const runner = built.supported ? built.runner : undefined;
  const releases: Promise<MutationReleaseResult>[] = [];
  const mcpRuntime = built.supported && runner ? { ...built, runner: {
    readRelease: runner.readRelease.bind(runner), queryRelease: runner.queryRelease.bind(runner),
    mutationRelease: ((operation, context, raw, options) => {
      const released = runner.mutationRelease(operation, context, raw, options.stage ? { ...options,
        async stage(value: Parameters<NonNullable<typeof options.stage>>[0]) { await options.stage!.call(options, value); hooks.staged?.(); } } : options);
      releases.push(released);
      const returning = hooks.returning;
      return returning ? released.then(async result => { await returning(); return result; }) : released;
    }) as typeof runner.mutationRelease,
  } } : built;
  const mcp = createOperationsMcp({ runtime: mcpRuntime, limits: setup.mcpDeadlineMs === undefined ? undefined : { deadlineMs: setup.mcpDeadlineMs } });
  const mcpServer = createServer((request, response) => { responses.push(response); hooks.respond?.(response); void mcp.handle(request, response); });
  await new Promise<void>(resolve => mcpServer.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { mcp.stop(); await mcp.drain(); mcpServer.closeAllConnections(); await new Promise<void>(resolve => mcpServer.close(() => resolve())); });
  const send = (target: { port?: number; socketPath?: string }, path: string, body: string, headers: Record<string, string> | string[]) => {
    let call!: ReturnType<typeof httpRequest>;
    const reply = new Promise<Reply>((resolve, reject) => {
      call = httpRequest({ ...(target.socketPath ? { socketPath: target.socketPath } : { host: "127.0.0.1", port: target.port }), path, method: "POST", headers }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); }
        });
      });
      call.on("error", reject); call.end(body);
    });
    void reply.catch(() => undefined);
    return { call, reply };
  };
  /** One POST to an adapter; `secret` is a bearer (never on unix), `key` the Idempotency-Key header. */
  const post = (listener: Listener, operation: string, input: unknown, options: { secret?: string; key?: string; headers?: Record<string, string> | string[]; raw?: string } = {}) => {
    const headers = options.headers ?? {
      "Content-Type": "application/json",
      ...(options.secret ? { Authorization: `Bearer ${options.secret}` } : {}),
      ...(options.key !== undefined ? { "Idempotency-Key": options.key } : {}),
    };
    return send({ port: (servers[listener].address() as AddressInfo).port }, `/api/operations/${operation}`, options.raw ?? JSON.stringify(input), headers);
  };
  const mcpHeaders = (secret?: string): Record<string, string> => ({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) });
  /** One raw JSON-RPC POST to the MCP adapter; `raw` replaces the serialized message. */
  const rpc = (message: unknown, options: { secret?: string; raw?: string; headers?: Record<string, string> } = {}) =>
    send({ port: (mcpServer.address() as AddressInfo).port }, "/mcp/operations", options.raw ?? JSON.stringify(message), options.headers ?? mcpHeaders(options.secret));
  const client = async (secret?: string) => {
    const c = new Client({ name: "knowledge-writes", version: "1" }); cleanups.push(() => c.close());
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp/operations`), { requestInit: { headers: secret ? { Authorization: `Bearer ${secret}` } : {} } }));
    return c;
  };
  return { f, built, minted, hooks, adapters, servers, responses, published, post, send, mcp, mcpServer, rpc, mcpHeaders, client, mcpRuntime, releases };
}
type Transports = Awaited<ReturnType<typeof transports>>;

/** The number of writeHead calls of each server-side response, in arrival order. */
function countWrites(t: Transports): number[] {
  const writes: number[] = [];
  t.hooks.respond = response => {
    const index = writes.push(0) - 1, head = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
    response.writeHead = ((...args: unknown[]) => { writes[index]++; return head(...args); }) as ServerResponse["writeHead"];
  };
  return writes;
}

/**
 * The controller's real owners over this composition: the controller server
 * (API), the externally owned admin socket (unix), the MCP server, a real
 * controller lock and the real shutdown sequence. `disposed` and `unlocked`
 * count the store's close and the lock's release.
 *
 * `drainAccepted: false` builds the negative control: the same shutdown whose
 * three listener closers only close their Node servers through the generic
 * HTTP closer, without the owners' explicit join of accepted handlers.
 */
async function owners(t: Transports, setup: { drainAccepted?: boolean } = {}) {
  const runtime = t.mcpRuntime as OperationsHttpRuntime;
  writeFileSync(join(t.f.root, "index.html"), "fixture");
  const controller = createControllerServer({ service: {} as unknown as ControlService, directoryBrowser: new DirectoryBrowser(t.f.root),
    events: new EventStream(), webRoot: t.f.root, host: "127.0.0.1", port: 0, accessToken: "synthetic-pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "none", activeSessions: 0 }),
    operations: runtime, maintenance: () => false, admission: t.f.store.admission });
  await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => controller.close());
  const socketPath = join(t.f.root, "owner-admin.sock");
  const admin = await listenAdminSocket(socketPath, vi.fn(), runtime);
  cleanups.push(() => admin.close());
  const mcpOptions = { service: { admission: t.f.store.admission, remoteVerificationEnabled: () => false } as unknown as ControlService,
    port: 0, accessToken: "synthetic-mcp-secret", operations: runtime };
  const mcp = createMcpControllerServer(mcpOptions);
  await new Promise<void>(resolve => mcp.server.listen(0, "127.0.0.1", resolve));
  mcpOptions.port = (mcp.server.address() as AddressInfo).port;
  cleanups.push(() => mcp.close());
  const lock = acquireControllerLock(join(t.f.root, "controller.lock"));
  cleanups.push(() => { try { lock.release(); } catch { /* released by the shutdown */ } });
  const counts = { disposed: 0, unlocked: 0 };
  const untracked = setup.drainAccepted === false;
  const closers = untracked
    ? { mcp: { close: createHttpServerCloser(mcp.server) }, controller: { close: createHttpServerCloser(controller.server) }, adminSocket: { close: createHttpServerCloser(admin.server) } }
    : { mcp, controller, adminSocket: admin };
  const shutdown = createControllerShutdown({
    service: { closeAdmission() {}, async shutdown() { await t.f.store.closeAfterDrain(); counts.disposed++; } },
    stopping: mcp.stopOperations, userSchedules: undefined, backups: { close() {} }, remoteVerification: null,
    ...closers, controllerLock: { ...lock, release() { counts.unlocked++; lock.release(); } }, removeServiceAccess() {},
  });
  const port = (server: HttpServer) => (server.address() as AddressInfo).port;
  /** One thread write on a listener of these owners. */
  const create = (listener: "api" | "unix" | "mcp", key: string, secret?: string) => listener === "unix"
    ? t.send({ socketPath }, "/api/operations/knowledge.create_thread", JSON.stringify(input()), { "Content-Type": "application/json", "Idempotency-Key": key })
    : listener === "api"
      ? t.send({ port: port(controller.server) }, "/api/operations/knowledge.create_thread", JSON.stringify(input()),
        { "Content-Type": "application/json", "Idempotency-Key": key, ...(secret ? { Authorization: `Bearer ${secret}` } : {}) })
      : t.send({ port: port(mcp.server) }, "/mcp/operations", JSON.stringify(tool({ ...input(), idempotencyKey: key }, 31)), t.mcpHeaders(secret));
  const servers = { api: controller.server, unix: admin.server, mcp: mcp.server };
  return { controller, admin, mcp, lock, counts, shutdown, create, servers };
}

/** The rows a closed owner left behind, read through a fresh store on the same files. */
function durable(f: KnowledgeFixture) {
  const store = new SqliteStateStore(f.paths.databasePath);
  try {
    const db = ownedFixtureDatabase(store);
    return {
      threads: (db.prepare("SELECT count(*) AS n FROM knowledge_threads").get() as { n: number }).n,
      history: (db.prepare("SELECT count(*) AS n FROM knowledge_history WHERE record_kind='thread'").get() as { n: number }).n,
      records: (db.prepare("SELECT idempotency_key,principal,state FROM operation_idempotency ORDER BY idempotency_key").all() as Array<Record<string, unknown>>)
        .map(row => `${String(row.idempotency_key)} ${String(row.principal)} ${String(row.state)}`),
    };
  } finally { store.close(); }
}
const input = (extra: Record<string, unknown> = {}) => ({ projectId: "project-a", title: "Release plan", body: "First draft.", ...extra });
const refusal = (category: string, status: number, reason: string, retry = "none", effect: string | null = "not_started") => ({ error: answer(category, status, reason, retry, effect) });
/** A JSON text of exactly `bytes` bytes: the value followed by spaces, which the strict parser accepts. */
const padded = (value: unknown, bytes: number) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > bytes) throw new Error("value larger than the padding target");
  return text + " ".repeat(bytes - Buffer.byteLength(text));
};

describe("knowledge.create_thread on HTTP: carriage and refusals", () => {
  it("carries the Idempotency-Key header on API and unix; the first release and the replay are the same 200", async () => {
    const t = await transports("better-auth");
    await t.f.agent("agent", [["operator", "project-a"]]);
    const secret = t.f.agents.get("agent")!;
    const first = await t.post("api", "knowledge.create_thread", input(), { secret, key: "k-1" }).reply;
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const thread = (first.body as { thread: Record<string, unknown> }).thread;
    expect(thread).toMatchObject({ projectId: "project-a", title: "Release plan", body: "First draft.", revision: 1, createdBy: "agent" });
    expect(Object.keys(first.body)).toEqual(["thread"]);
    expect(Object.keys(thread).sort()).toEqual(["body", "createdAt", "createdBy", "id", "projectId", "revision", "title", "updatedAt"]);
    const replay = await t.post("api", "knowledge.create_thread", input(), { secret, key: "k-1" }).reply;
    expect(replay).toMatchObject({ status: 200, body: first.body });
    expect("replayed" in replay.body).toBe(false);
    // The unix operator is its own principal: the same key runs fresh there, and replays there.
    const unix = await t.post("unix", "knowledge.create_thread", input(), { key: "k-1" }).reply;
    expect(unix.status).toBe(200);
    expect((unix.body as { thread: Record<string, unknown> }).thread).toMatchObject({ createdBy: "installation" });
    expect((await t.post("unix", "knowledge.create_thread", input(), { key: "k-1" }).reply).body).toEqual(unix.body);
    expect(await t.f.records()).toEqual(["k-1 account:agent completed", "k-1 operator completed"]);
    expect(await t.f.threads()).toHaveLength(2);
    expect((await t.f.history()).map(row => [row.principal_id, row.authentication_method])).toEqual([["agent", "agent_token"], ["installation", "none"]]);
    expect(t.published).toEqual(["project-a", "project-a"]);
    expect(await t.f.legacyIdempotency()).toBe(0);
  });

  it("refuses a duplicate Idempotency-Key header before mint, body or reservation", async () => {
    const t = await transports("token");
    for (const listener of ["api", "unix"] as const) {
      // Raw headers: Node adds no Host to an array, and its server refuses a request without one.
      const headers = ["Host", "127.0.0.1", "Content-Type", "application/json", "Idempotency-Key", "k-1", "Idempotency-Key", "k-1",
        ...(listener === "api" ? ["Authorization", `Bearer ${t.f.installationSecret}`] : [])];
      const reply = await t.post(listener, "knowledge.create_thread", input(), { headers }).reply;
      expect(reply).toMatchObject({ status: 400, body: refusal("invalid_request", 400, "invalid_request", "none", null) });
    }
    expect(t.minted.count).toBe(0);
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
  });

  it("refuses a malformed key and a key on a read with the runner's answers, inside admission", async () => {
    const t = await transports("token");
    const secret = t.f.installationSecret;
    expect((await t.post("api", "knowledge.create_thread", input(), { secret, key: "has space" }).reply).body)
      .toEqual(refusal("invalid_request", 400, "invalid_idempotency_key"));
    expect((await t.post("api", "knowledge.create_thread", input(), { secret, key: "" }).reply).body)
      .toEqual(refusal("invalid_request", 400, "invalid_idempotency_key"));
    // A read, the query and the describe: none of them retains, so a key is refused before any work.
    for (const [operation, body] of [["project.status", { projectId: "project-a" }], ["project.list", {}], ["project.worktrees", { projectId: "project-a" }], ["session.describe", {}]] as const) {
      expect((await t.post("api", operation, body, { secret, key: "k" }).reply).body, operation)
        .toEqual(refusal("invalid_request", 400, "idempotency_not_supported", "none", null));
    }
    expect(await t.f.records()).toEqual([]);
  });

  it("keeps the key out of the input: an idempotencyKey body field is unexpected input", async () => {
    const t = await transports("token");
    expect((await t.post("api", "knowledge.create_thread", input({ idempotencyKey: "k" }), { secret: t.f.installationSecret }).reply).body)
      .toEqual(refusal("invalid_request", 400, "unexpected_input"));
    expect(await t.f.threads()).toEqual([]);
  });

  it.each(["api", "unix"] as const)("%s: 256 KiB for knowledge.create_thread, the existing ceiling for a read", async listener => {
    const t = await transports("token");
    const secret = listener === "api" ? t.f.installationSecret : undefined;
    const create = (bytes: number) => t.post(listener, "knowledge.create_thread", undefined, { secret, raw: padded(input(), bytes) }).reply;
    expect((await create(256 * 1024)).status).toBe(200);
    expect(await create(256 * 1024 + 1)).toMatchObject({ status: 413, body: refusal("payload_too_large", 413, "request_too_large", "none", null) });
    const readCeiling = listener === "api" ? 64 * 1024 : 16 * 1024;
    const read = (bytes: number) => t.post(listener, "project.status", undefined, { secret, raw: padded({ projectId: "project-a" }, bytes) }).reply;
    expect((await read(readCeiling)).status).toBe(200);
    expect(await read(readCeiling + 1)).toMatchObject({ status: 413, body: refusal("payload_too_large", 413, "request_too_large", "none", null) });
    expect(await t.f.threads()).toHaveLength(1);
  });

  it("the worker listener does not serve it, in any mode", async () => {
    for (const mode of ["open", "token", "better-auth"] as const) {
      const t = await transports(mode);
      const reply = await t.post("worker", "knowledge.create_thread", input(), { secret: mode === "token" ? t.f.installationSecret : undefined, key: "k" }).reply;
      expect(reply).toMatchObject({ status: 404, body: refusal("not_found", 404, "operation_not_found", "none", null) });
      expect(await t.f.threads()).toEqual([]);
    }
  });

  it("an unknown mode builds no registry: the path is not found on API and unix", async () => {
    const t = await transports("legacy");
    for (const listener of ["api", "unix"] as const) {
      const reply = await t.post(listener, "knowledge.create_thread", input(), { key: "k" }).reply;
      expect(reply).toMatchObject({ status: 404, body: refusal("not_found", 404, "operation_not_found", "none", null) });
    }
    expect((await t.post("api", "session.describe", {}).reply).body).toEqual(refusal("unauthenticated", 401, "unknown_mode", "reauthenticate", null));
    expect(await t.f.threads()).toEqual([]);
  });

  it("denies without both grants and hides another project, inside admission", async () => {
    const t = await transports("better-auth");
    await t.f.agent("reader", [["reader", "project-a"]]);
    await t.f.agent("other", [["operator", "project-b"]]);
    expect((await t.post("api", "knowledge.create_thread", input(), { secret: t.f.agents.get("reader"), key: "k" }).reply))
      .toMatchObject({ status: 403, body: refusal("forbidden", 403, "permission_denied") });
    expect((await t.post("api", "knowledge.create_thread", input(), { secret: t.f.agents.get("other"), key: "k" }).reply))
      .toMatchObject({ status: 404, body: refusal("not_found", 404, "resource_not_found") });
    expect(await t.f.records()).toEqual([]);
  });

  it("refuses at the mint an agent whose stored principal ID is outside the ID grammar, on API and MCP, with and without a key", async () => {
    const t = await transports("better-auth");
    await t.f.agent("legacy user", [["operator", "project-a"]]);
    await t.f.agent("legacy-user", [["operator", "project-a"]]);
    const secret = t.f.agents.get("legacy user")!;
    const counted = { reserved: 0, written: 0 };
    t.hooks.reserved = () => { counted.reserved++; }; t.hooks.written = () => { counted.written++; };
    const refused = refusal("unauthenticated", 401, "invalid_credential", "reauthenticate", null);
    for (const key of [undefined, "legacy"]) {
      expect(await t.post("api", "knowledge.create_thread", input(), { secret, key }).reply, `api ${String(key)}`).toMatchObject({ status: 401, body: refused });
      const args = key === undefined ? input() : { ...input(), idempotencyKey: key };
      expect(await t.rpc(tool(args, 51), { secret }).reply, `mcp ${String(key)}`).toMatchObject({ status: 401, body: refused });
    }
    expect(t.minted.count).toBe(4);
    expect(counted).toEqual({ reserved: 0, written: 0 });
    expect(t.releases).toHaveLength(0);
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
    expect(await t.f.history()).toEqual([]);
    // The positive control: the same grants under an ID inside the grammar.
    expect((await t.post("api", "knowledge.create_thread", input(), { secret: t.f.agents.get("legacy-user"), key: "legacy" }).reply).status).toBe(200);
    expect(counted).toEqual({ reserved: 1, written: 1 });
    expect(await t.f.records()).toEqual(["legacy account:legacy-user completed"]);
  });

  it("answers an archived project as a conflict before the commit point, with no record", async () => {
    const t = await transports("token");
    await t.f.setProjectStatus("project-a", "archived");
    expect(await t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "k" }).reply)
      .toMatchObject({ status: 409, body: refusal("conflict", 409, "project_archived") });
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
  });
});

describe("knowledge.create_thread on HTTP: concurrent keys", () => {
  it("one principal, one key, concurrently on API: one effect; two principals stay isolated", async () => {
    const t = await transports("better-auth");
    await t.f.agent("one", [["operator", "project-a"]]);
    await t.f.agent("two", [["operator", "project-a"]]);
    const one = t.f.agents.get("one")!, two = t.f.agents.get("two")!;
    const replies = await Promise.all([
      t.post("api", "knowledge.create_thread", input(), { secret: one, key: "same" }).reply,
      t.post("api", "knowledge.create_thread", input(), { secret: one, key: "same" }).reply,
      t.post("api", "knowledge.create_thread", input(), { secret: two, key: "same" }).reply,
    ]);
    expect(replies[2].status).toBe(200);
    // The second call of `one` met the reservation or the completed record: in progress, or a replay.
    const ofOne = replies.slice(0, 2);
    expect(ofOne.filter(reply => reply.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const reply of ofOne) {
      if (reply.status !== 200) expect(reply.body).toEqual(refusal("conflict", 409, "request_in_progress"));
      else expect(reply.body).toEqual(ofOne.find(each => each.status === 200)!.body);
    }
    expect((await t.f.threads()).map(row => row.created_by).sort()).toEqual(["one", "two"]);
    expect(await t.f.records()).toEqual(["same account:one completed", "same account:two completed"]);
  });
});

describe("knowledge.create_thread on HTTP: ownership around the commit point", () => {
  it("API stop after the reservation and before the effect: no rows, reservation released, the cancellation returned", async () => {
    const t = await transports("token");
    // Stop aborts the request's signal: the runner answers before phase 3 is admitted, without a write.
    t.hooks.reserved = () => { t.adapters.api.stop(); };
    const reply = await t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "k" }).reply;
    expect(reply).toMatchObject({ status: 503, body: refusal("unavailable", 503, "request_cancelled", "retry") });
    expect(reply.headers["retry-after"]).toBe("1");
    await t.adapters.api.drain();
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
    expect(t.published).toEqual([]);
  });

  it("API disconnect after the reservation and before the effect: no rows, reservation released", async () => {
    const t = await transports("token");
    let reserved!: () => void;
    const reservation = new Promise<void>(resolve => { reserved = resolve; });
    t.hooks.reserved = () => { reserved(); };
    const sent = t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "k" });
    await reservation;
    // Outside the admitted phase, before phase 3 asks for admission: hold the real gate (FIFO), then leave.
    let release!: () => void;
    const held = t.f.store.authenticationProviderStorage().borrow(() => new Promise<void>(resolve => { release = resolve; }));
    sent.call.destroy();
    await expect(sent.reply).rejects.toThrow();
    await vi.waitFor(() => { if (!t.responses.at(-1)?.destroyed) throw new Error("not closed yet"); });
    await vi.waitFor(() => { if (!release) throw new Error("not held yet"); });
    release();
    await held;
    await t.adapters.api.drain();
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
  });

  it("API stop after the thread transaction and before completion: one pair, the completed record after drain, no stale success", async () => {
    const t = await transports("token");
    let drained = false;
    t.hooks.written = () => { t.adapters.api.stop(); };
    const sent = t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "k" });
    const reply = await sent.reply;
    expect(reply).toMatchObject({ status: 503, body: refusal("unavailable", 503, "release_not_eligible", "none", "committed") });
    await t.adapters.api.drain().then(() => { drained = true; });
    expect(drained).toBe(true);
    expect(await t.f.records()).toEqual(["k installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.history()).toHaveLength(1);
    expect(t.published).toEqual(["project-a"]);
  });

  it("the externally owned unix path: close during the effect joins the handler before the socket is gone", async () => {
    const t = await transports("token");
    const socketPath = join(t.f.root, "admin.sock");
    const admin = await listenAdminSocket(socketPath, vi.fn(), t.built);
    let closing: Promise<void> | undefined;
    t.hooks.written = () => { closing = admin.close(); };
    const reply = await t.send({ socketPath }, "/api/operations/knowledge.create_thread", JSON.stringify(input()), { "Content-Type": "application/json", "Idempotency-Key": "k" }).reply;
    expect(reply).toMatchObject({ status: 503, body: refusal("unavailable", 503, "release_not_eligible", "none", "committed") });
    await closing;
    // Close resolved only after the completion phase wrote the promised record.
    expect(await t.f.records()).toEqual(["k operator completed"]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.history()).toHaveLength(1);
  });

  it("API disconnect after the thread transaction and before completion: one pair, the completed record after drain, no write", async () => {
    const t = await transports("token");
    const writes = countWrites(t);
    // Inside the admitted phase, right after the content transaction: the caller is gone before completion.
    t.hooks.written = () => { t.responses.at(-1)!.destroy(); };
    const sent = t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "k" });
    await expect(sent.reply).rejects.toThrow();
    await t.adapters.api.drain();
    expect(writes).toEqual([0]);
    expect(await t.f.records()).toEqual(["k installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.history()).toHaveLength(1);
    expect(t.published).toEqual(["project-a"]);
  });

  it("the externally owned unix path: close before the effect cancels it; close resolves after the handler, with no rows", async () => {
    const t = await transports("token");
    const socketPath = join(t.f.root, "admin.sock");
    const admin = await listenAdminSocket(socketPath, vi.fn(), t.built);
    let closing: Promise<void> | undefined, closed = false;
    t.hooks.reserved = () => { closing = admin.close().then(() => { closed = true; }); };
    const sent = t.send({ socketPath }, "/api/operations/knowledge.create_thread", JSON.stringify(input()), { "Content-Type": "application/json", "Idempotency-Key": "k" });
    const reply = await sent.reply;
    expect(reply).toMatchObject({ status: 503, body: refusal("unavailable", 503, "request_cancelled", "retry") });
    await closing;
    expect(closed).toBe(true);
    // The reservation was given back before the handler settled; nothing was written.
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
    expect(await t.f.history()).toEqual([]);
    expect(t.published).toEqual([]);
  });

  it("the externally owned unix path serves the operation with the key header, and refuses a cookie", async () => {
    const t = await transports("better-auth");
    const socketPath = join(t.f.root, "admin.sock");
    const admin = await listenAdminSocket(socketPath, vi.fn(), t.built);
    cleanups.push(() => admin.close());
    const path = "/api/operations/knowledge.create_thread";
    const first = await t.send({ socketPath }, path, JSON.stringify(input()), { "Content-Type": "application/json", "Idempotency-Key": "k" }).reply;
    expect(first.status).toBe(200);
    expect((await t.send({ socketPath }, path, JSON.stringify(input()), { "Content-Type": "application/json", "Idempotency-Key": "k" }).reply).body).toEqual(first.body);
    const cookie = await t.send({ socketPath }, path, JSON.stringify(input()), { "Content-Type": "application/json", Cookie: "__Secure-wtc.session_token=x" }).reply;
    expect(cookie).toMatchObject({ status: 401, body: refusal("unauthenticated", 401, "provider_cookie_not_supported", "reauthenticate", null) });
    expect(await t.f.threads()).toHaveLength(1);
  });
});

const tool = (args: unknown, id: string | number = 7) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "knowledge_create_thread", arguments: args } });
/** The JSON-RPC error the adapter writes for a refusal after SDK dispatch. */
const rpcError = (id: string | number, error: ReturnType<typeof answer>) => ({ jsonrpc: "2.0", id, error: { code: -32000, message: error.reason, data: error } });

describe("knowledge.create_thread on MCP", () => {
  it("carries the reserved idempotencyKey argument; the buffered success and the replay are the same tool result", async () => {
    const t = await transports("token");
    const c = await t.client(t.f.installationSecret);
    expect((await c.listTools()).tools.map(each => each.name)).toEqual(["knowledge_create_thread", "project_list", "project_status", "project_worktrees", "session_describe"]);
    const described = (await c.listTools()).tools[0];
    expect(described.inputSchema).toMatchObject({ required: ["projectId", "title", "body"], additionalProperties: false, properties: { idempotencyKey: { type: "string" } } });
    const first = await c.callTool({ name: "knowledge_create_thread", arguments: { ...input(), idempotencyKey: "m-1" } });
    expect(first.isError).toBeFalsy();
    const thread = (first.structuredContent as { thread: Record<string, unknown> }).thread;
    expect(thread).toMatchObject({ projectId: "project-a", title: "Release plan", createdBy: "installation" });
    expect(JSON.parse((first.content as Array<{ text: string }>)[0].text)).toEqual(first.structuredContent);
    const replay = await c.callTool({ name: "knowledge_create_thread", arguments: { ...input(), idempotencyKey: "m-1" } });
    expect(replay.structuredContent).toEqual(first.structuredContent);
    expect(await t.f.records()).toEqual(["m-1 installation completed"]);
    expect((await t.f.history()).map(row => [row.principal_id, row.authentication_method])).toEqual([["installation", "installation_token"]]);
    expect(t.published).toEqual(["project-a"]);
    // The same key from the same principal over HTTP replays the MCP attempt: one effect across transports.
    expect((await t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "m-1" }).reply).body).toEqual(first.structuredContent);
    expect(await t.f.threads()).toHaveLength(1);
  });

  it("answers every refusal after dispatch as a JSON-RPC error with the request ID, written by the adapter", async () => {
    const t = await transports("better-auth");
    await t.f.agent("agent", [["operator", "project-a"]]);
    await t.f.agent("stranger");
    const secret = t.f.agents.get("agent")!;
    const nonString = await t.rpc(tool({ ...input(), idempotencyKey: 7 }, "a-1"), { secret }).reply;
    expect(nonString).toMatchObject({ status: 200, body: rpcError("a-1", answer("invalid_request", 400, "invalid_idempotency_key", "none", "not_started")) });
    const nullKey = await t.rpc(tool({ ...input(), idempotencyKey: null }, 2), { secret }).reply;
    expect(nullKey.body).toEqual(rpcError(2, answer("invalid_request", 400, "invalid_idempotency_key", "none", "not_started")));
    expect((await t.rpc(tool({ ...input(), title: " " }, 3), { secret }).reply).body).toEqual(rpcError(3, answer("invalid_request", 400, "invalid_title", "none", "not_started")));
    expect((await t.rpc(tool(input(), 4), { secret: t.f.agents.get("stranger") }).reply).body).toEqual(rpcError(4, answer("not_found", 404, "resource_not_found", "none", "not_started")));
    await t.f.setProjectStatus("project-a", "archived");
    const archived = await t.rpc(tool({ ...input(), idempotencyKey: "k" }, 5), { secret }).reply;
    expect(archived.body).toEqual(rpcError(5, answer("conflict", 409, "project_archived", "none", "not_started")));
    expect(archived.headers["retry-after"]).toBeUndefined();
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
  });

  it("removes the reserved argument by descriptor only: no getter runs, the prototype is kept, and the runner refuses what is not plain data", async () => {
    const t = await transports("token");
    const built = t.built;
    if (!built.supported) throw new Error("supported fixture");
    const minted = await built.mint("api", presentedBearer(t.f.installationSecret), null, {});
    if (!minted.ok) throw new Error("mint refused");
    const operation = built.registry.get("knowledge.create_thread")!, runner = built.runner, context = minted.context;
    let getters = 0;
    const accessor = (value: unknown): PropertyDescriptor => ({ enumerable: true, configurable: true, get() { getters++; return value; } });
    const release = async (raw: unknown, key: unknown) =>
      (await t.f.release(runner, operation, context, raw, { idempotencyKey: key as string | undefined })).writes;
    const refused = (reason: string) => [{ kind: "refuse", value: answer("invalid_request", 400, reason, "none", "not_started"), admitted: 1 }];
    const fields = ["projectId", "title", "body"];

    // A null prototype: the key is taken, the prototype kept, and the remaining plain data runs.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, input({ title: "Bare" }), { idempotencyKey: "bare" });
    const fromBare = withoutIdempotencyArgument(bare);
    expect(fromBare.key).toBe("bare");
    expect(Object.getPrototypeOf(fromBare.input)).toBeNull();
    expect(Reflect.ownKeys(fromBare.input as object)).toEqual(fields);
    expect(Reflect.ownKeys(bare)).toEqual([...fields, "idempotencyKey"]);
    expect(await release(fromBare.input, fromBare.key)).toEqual([{ kind: "commit", value: { thread: expect.objectContaining({ title: "Bare" }) }, admitted: 1 }]);

    // A custom prototype is kept, so the retained-input serializer refuses it.
    const prototype = { inherited: "value" };
    const custom = Object.assign(Object.create(prototype) as Record<string, unknown>, input({ title: "Custom" }), { idempotencyKey: "custom" });
    const fromCustom = withoutIdempotencyArgument(custom);
    expect(fromCustom.key).toBe("custom");
    expect(Object.getPrototypeOf(fromCustom.input)).toBe(prototype);
    expect(await release(fromCustom.input, fromCustom.key)).toEqual(refused("invalid_input"));

    // An inherited key is not the reserved argument: nothing is taken, and the prototype is refused.
    const inherited = Object.assign(Object.create({ idempotencyKey: "inherited" }) as Record<string, unknown>, input({ title: "Inherited" }));
    const fromInherited = withoutIdempotencyArgument(inherited);
    expect(fromInherited.input).toBe(inherited); expect(fromInherited.key).toBeUndefined();
    expect(await release(fromInherited.input, fromInherited.key)).toEqual(refused("invalid_input"));

    // An accessor key is never read: a malformed key.
    const accessorKey = Object.defineProperty(input({ title: "Accessor key" }), "idempotencyKey", accessor("hidden"));
    const fromAccessorKey = withoutIdempotencyArgument(accessorKey);
    expect(fromAccessorKey.key).toBeNull();
    expect(Reflect.ownKeys(fromAccessorKey.input as object)).toEqual(fields);
    expect(await release(fromAccessorKey.input, fromAccessorKey.key)).toEqual(refused("invalid_idempotency_key"));

    // An accessor in another field is copied as an accessor, never invoked, and refused by the serializer.
    const accessorField = Object.defineProperty({ projectId: "project-a", body: "b", idempotencyKey: "field" } as Record<string, unknown>, "title", accessor("Accessor field"));
    const fromField = withoutIdempotencyArgument(accessorField);
    expect(fromField.key).toBe("field");
    expect(Object.getOwnPropertyDescriptor(fromField.input as object, "title")).toMatchObject({ get: expect.any(Function) });
    expect(await release(fromField.input, fromField.key)).toEqual(refused("invalid_input"));

    expect(getters).toBe(0);
    expect(await t.f.records()).toEqual(["bare installation completed"]);
    expect((await t.f.threads()).map(row => row.title)).toEqual(["Bare"]);
  });

  it("no mounted mutation's parse accepts the reserved argument name", async () => {
    const t = await transports("open");
    if (!t.built.supported) throw new Error("unsupported");
    // A valid input of every mounted mutation; the table must cover them all.
    const valid: Record<string, unknown> = { "knowledge.create_thread": input() };
    const mutations = t.built.registry.idsOn("mcp").filter(id => t.built.supported && t.built.registry.get(id)?.kind === "mutation");
    expect(Object.keys(valid).sort()).toEqual(mutations);
    for (const id of mutations) {
      const operation = t.built.registry.get(id)!;
      expect(() => operation.parse(valid[id])).not.toThrow();
      expect(() => operation.parse({ ...(valid[id] as object), idempotencyKey: "k" }), id).toThrow();
    }
  });

  it("bounds the request: 256 KiB plus the envelope for the thread write, the existing 64 KiB for every other message", async () => {
    const t = await transports("token");
    const secret = t.f.installationSecret;
    const outer = OPERATIONS_HTTP_LIMITS.operationBodyBytes["knowledge.create_thread"] + OPERATIONS_MCP_REQUEST_ENVELOPE_BYTES;
    expect(outer).toBe(256 * 1024 + 4 * 1024);
    const accepted = await t.rpc(undefined, { secret, raw: padded(tool(input(), 1), outer) }).reply;
    expect(accepted.status).toBe(200); expect((accepted.body as { result?: unknown }).result).toBeDefined();
    const over = await t.rpc(undefined, { secret, raw: padded(tool(input({ title: "Over" }), 2), outer + 1) }).reply;
    expect(over).toMatchObject({ status: 413, body: refusal("payload_too_large", 413, "request_too_large", "none", null) });
    const list = { jsonrpc: "2.0", id: 3, method: "tools/list" };
    expect((await t.rpc(undefined, { secret, raw: padded(list, OPERATIONS_HTTP_LIMITS.bodyBytes) }).reply).status).toBe(200);
    const before = t.minted.count;
    // Not a strictly classified call of the thread write: the existing ceiling, refused before mint.
    const unclassified = [
      list,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "project_status", arguments: { projectId: "project-a" } } },
      { ...tool(input(), 6), jsonrpc: "1.0" },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "knowledge_create_thread", arguments: input() } },
      { jsonrpc: "2.0", id: null, method: "tools/call", params: { name: "knowledge_create_thread", arguments: input() } },
      { jsonrpc: "2.0", id: 8, method: "tools/list", params: { name: "knowledge_create_thread" } },
    ];
    for (const message of unclassified) {
      expect(await t.rpc(undefined, { secret, raw: padded(message, OPERATIONS_HTTP_LIMITS.bodyBytes + 1) }).reply, JSON.stringify(message).slice(0, 80))
        .toMatchObject({ status: 413, body: refusal("payload_too_large", 413, "request_too_large", "none", null) });
    }
    expect(t.minted.count).toBe(before);
    expect(await t.f.threads()).toHaveLength(1);
  });

  it("refuses above 64 KiB, before mint and dispatch, every message the SDK would not dispatch as a call of the thread write, task requests included", async () => {
    const t = await transports("token");
    const secret = t.f.installationSecret;
    const handled = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
    const size = OPERATIONS_HTTP_LIMITS.bodyBytes + 1;
    const call = (id: number) => tool(input(), id);
    // Each is a near miss of the shapes the pinned SDK accepts: its JSON-RPC request schema and its call-tool request schema.
    const nearMisses: ReadonlyArray<[name: string, message: unknown]> = [
      ["a fractional numeric ID", call(1.5)],
      ["arguments as an array", { ...call(2), params: { name: "knowledge_create_thread", arguments: [input()] } }],
      ["arguments as a string", { ...call(3), params: { name: "knowledge_create_thread", arguments: JSON.stringify(input()) } }],
      ["an extra envelope field", { ...call(4), extra: true }],
      ["a wrong jsonrpc value", { ...call(5), jsonrpc: "2" }],
      ["a method other than tools/call", { ...call(6), method: "tools/list" }],
      ["a tool name without a declared ceiling", { ...call(7), params: { name: "project_status", arguments: { projectId: "project-a" } } }],
      // Both schemas accept task metadata, but this server advertises no task capability: the SDK refuses it before the handler.
      ["empty task metadata", { ...call(9), params: { name: "knowledge_create_thread", arguments: input(), task: {} } }],
      ["populated task metadata", { ...call(10), params: { name: "knowledge_create_thread", arguments: { ...input(), idempotencyKey: "task" }, task: { ttl: 1 } } }],
    ];
    for (const [name, message] of nearMisses) {
      expect(await t.rpc(undefined, { secret, raw: padded(message, size) }).reply, name)
        .toMatchObject({ status: 413, body: refusal("payload_too_large", 413, "request_too_large", "none", null) });
    }
    expect(t.minted.count).toBe(0);
    expect(handled).not.toHaveBeenCalled();
    expect(t.releases).toHaveLength(0);
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
    expect(await t.f.history()).toEqual([]);
    // A call the SDK dispatches, at the same size: the larger class, one effect.
    const accepted = await t.rpc(undefined, { secret, raw: padded(tool({ ...input(), idempotencyKey: "same-size" }, 8), size) }).reply;
    expect(accepted.status).toBe(200); expect((accepted.body as { result?: unknown }).result).toBeDefined();
    expect(t.minted.count).toBe(1); expect(handled).toHaveBeenCalledTimes(1); expect(t.releases).toHaveLength(1);
    expect(await t.f.records()).toEqual(["same-size installation completed"]);
  });

  it("counts streamed bytes of a chunked body", async () => {
    const t = await transports("token");
    const outer = OPERATIONS_HTTP_LIMITS.operationBodyBytes["knowledge.create_thread"] + OPERATIONS_MCP_REQUEST_ENVELOPE_BYTES;
    const chunked = (text: string) => new Promise<Reply>((resolve, reject) => {
      const call = httpRequest({ host: "127.0.0.1", port: (t.mcpServer.address() as AddressInfo).port, path: "/mcp/operations", method: "POST", headers: t.mcpHeaders(t.f.installationSecret) }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      call.on("error", reject);
      // No Content-Length: Node sends chunked transfer encoding.
      for (let index = 0; index < text.length; index += 4096) call.write(text.slice(index, index + 4096));
      call.end();
    });
    expect((await chunked(padded(tool({ ...input(), idempotencyKey: "c" }, 1), outer))).status).toBe(200);
    expect(await chunked(padded(tool(input({ title: "Over" }), 2), outer + 1))).toMatchObject({ status: 413, body: refusal("payload_too_large", 413, "request_too_large", "none", null) });
    expect(await t.f.records()).toEqual(["c installation completed"]);
  });

  it("budgets a large escaped JSON-RPC ID of the thread write against its envelope, at send and collection", async () => {
    const t = await transports("token");
    const id = `"\\${"\u0001".repeat(20_000)}${"\"".repeat(60_000)}`;
    const message = tool({ ...input(), idempotencyKey: "id" }, id);
    expect(Buffer.byteLength(JSON.stringify(message))).toBeGreaterThan(OPERATIONS_HTTP_LIMITS.bodyBytes);
    const reply = await t.rpc(message, { secret: t.f.installationSecret }).reply;
    expect(reply.status).toBe(200);
    expect((reply.body as { id: string }).id).toBe(id);
    expect((reply.body as { result: { structuredContent: { thread: { title: string } } } }).result.structuredContent.thread.title).toBe("Release plan");
    // A large ID on a message that is not the thread write still has the existing ceiling.
    expect((await t.rpc({ jsonrpc: "2.0", id, method: "tools/list" }, { secret: t.f.installationSecret }).reply).status).toBe(413);
  });

  it.each(["send", "collection"] as const)("refuses an escaped request ID over its budget at SDK %s, after the effect, as a failed stage", async point => {
    const t = await transports("token");
    const id = `"\\${"\u0001".repeat(20_000)}${"\"".repeat(60_000)}`;
    const budget = 3 * OPERATIONS_HTTP_LIMITS.responseBytes + 128 + Buffer.byteLength(JSON.stringify(id));
    // Each guard alone: the other sees the real message. One byte over the budget at that point.
    const over = (message: unknown) => JSON.stringify(message) + " ".repeat(budget + 1 - Buffer.byteLength(JSON.stringify(message)));
    if (point === "send") {
      // The message the SDK sends, enlarged on its way into the adapter's own bound on send.
      const connect = Server.prototype.connect;
      vi.spyOn(Server.prototype, "connect").mockImplementation(async function (this: Server, transport) {
        const bounded = transport.send.bind(transport);
        transport.send = async (message, options) => {
          const enlarged = { ...message, padding: "" };
          enlarged.padding = "x".repeat(budget + 1 - Buffer.byteLength(JSON.stringify(enlarged)));
          return bounded(enlarged, options);
        };
        return connect.call(this, transport);
      });
    } else {
      // The Response the SDK hands back, enlarged after send passed: only the bound on collection sees it.
      const real = WebStandardStreamableHTTPServerTransport.prototype.handleRequest;
      vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest").mockImplementation(async function (this: WebStandardStreamableHTTPServerTransport, ...args) {
        const response = await real.apply(this, args);
        return new Response(over(await response.json()), { status: response.status, headers: response.headers });
      });
    }
    const reply = await t.rpc(tool({ ...input(), idempotencyKey: "budget" }, id), { secret: t.f.installationSecret }).reply;
    // The thread was written before staging; the failed stage is the runner's refusal, with the effect committed.
    expect(reply.body).toEqual(rpcError(id, answer("internal", 500, "release_stage_failed", "none", "committed")));
    expect(await t.releases[0]).toEqual({ status: "refused", error: answer("internal", 500, "release_stage_failed", "none", "committed") });
    expect(await t.f.records()).toEqual(["budget installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
  });

  it("an undispatched protocol message runs no effect", async () => {
    const t = await transports("token");
    const secret = t.f.installationSecret;
    for (const message of [{ ...tool(input(), 1), jsonrpc: "1.0" }, { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { arguments: input() } }]) {
      const reply = await t.rpc(message, { secret }).reply.catch(() => undefined);
      expect(reply === undefined || reply.status < 500).toBe(true);
    }
    // A protocol version the SDK refuses: answered without dispatch.
    await t.rpc(tool(input(), 3), { headers: { ...t.mcpHeaders(secret), "mcp-protocol-version": "1999-01-01" } }).reply.catch(() => undefined);
    // Task metadata within the existing ceiling: the SDK refuses it before the handler, as a JSON-RPC error.
    for (const [id, task] of [[4, {}], [5, { ttl: 1 }]] as const) {
      const reply = await t.rpc({ ...tool(input(), id), params: { name: "knowledge_create_thread", arguments: input(), task } }, { secret }).reply;
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ jsonrpc: "2.0", id, error: expect.any(Object) });
      expect("result" in reply.body).toBe(false);
    }
    expect(t.releases).toHaveLength(0);
    expect(await t.f.threads()).toEqual([]);
    expect(await t.f.records()).toEqual([]);
  });

  it("keeps refusing a cookie before any work", async () => {
    const t = await transports("token");
    const reply = await t.rpc(tool(input()), { headers: { ...t.mcpHeaders(t.f.installationSecret), Cookie: "__Secure-wtc.session_token=x" } }).reply;
    expect(reply).toMatchObject({ status: 401, body: refusal("unauthenticated", 401, "provider_cookie_not_supported", "reauthenticate", null) });
    expect(await t.f.threads()).toEqual([]);
  });

  it("one principal, one key, concurrently on API and MCP: one effect", async () => {
    const t = await transports("token");
    const secret = t.f.installationSecret;
    const [api, mcp] = await Promise.all([
      t.post("api", "knowledge.create_thread", input(), { secret, key: "both" }).reply,
      t.rpc(tool({ ...input(), idempotencyKey: "both" }, 9), { secret }).reply,
    ]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.records()).toEqual(["both installation completed"]);
    const answers = [api.status === 200 ? "ok" : (api.body as { error: { reason: string } }).error.reason,
      (mcp.body as { result?: unknown }).result ? "ok" : (mcp.body as { error: { data: { reason: string } } }).error.data.reason];
    expect(answers.filter(each => each === "ok").length).toBeGreaterThanOrEqual(1);
    for (const each of answers) expect(["ok", "request_in_progress"]).toContain(each);
  });

  it("MCP stop while the SDK holds the staged output: one pair, the completed record after drain, no stale success", async () => {
    const t = await transports("token");
    t.hooks.staged = () => { t.mcp.stop(); };
    const reply = await t.rpc(tool({ ...input(), idempotencyKey: "s" }, 11), { secret: t.f.installationSecret }).reply;
    expect(reply.body).toEqual(rpcError(11, answer("unavailable", 503, "request_cancelled", "none", "committed")));
    await t.mcp.drain();
    expect(await t.f.records()).toEqual(["s installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.history()).toHaveLength(1);
  });

  it("MCP stop after the reservation and before the effect: no rows, the reservation released", async () => {
    const t = await transports("token");
    t.hooks.reserved = () => { t.mcp.stop(); };
    const reply = await t.rpc(tool({ ...input(), idempotencyKey: "r" }, 12), { secret: t.f.installationSecret }).reply;
    expect(reply.body).toEqual(rpcError(12, answer("unavailable", 503, "request_cancelled", "retry", "not_started")));
    await t.mcp.drain();
    expect(await t.f.records()).toEqual([]);
    expect(await t.f.threads()).toEqual([]);
  });
});

describe("knowledge.create_thread on MCP: a pending SDK staging and the owner's closes", () => {
  /**
   * Holds the SDK's send of the tool result: `stage` stays pending after the effect and its completion until
   * the test settles the held send through `held`, or forever.
   */
  const holdSend = () => {
    const entered = pause();
    const held: { fulfil?: () => void; reject?: (error: unknown) => void } = {};
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "send").mockImplementation(() => {
      entered.done();
      return new Promise<void>((resolve, reject) => { held.fulfil = () => { resolve(); }; held.reject = reject; });
    });
    return { ...entered, held };
  };

  it.each([["deadline", "fulfils"], ["deadline", "rejects"], ["departure", "fulfils"], ["departure", "rejects"]] as const)(
    "the %s aborts a pending staging: the cancellation, one pair, the record, no write after the abort; when the held send %s late, nothing follows", async (kind, late) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => { process.off("unhandledRejection", onUnhandled); });
    const t = await transports("token", kind === "deadline" ? { mcpDeadlineMs: 2_000 } : {});
    const writes = countWrites(t);
    const entered = holdSend();
    const sent = t.rpc(tool({ ...input(), idempotencyKey: "held" }, 21), { secret: t.f.installationSecret });
    await entered.promise;
    // The SDK holds the result: the effect and its completion are durable, the release is not written.
    expect(await t.f.records()).toEqual(["held installation completed"]);
    expect(writes).toEqual([0]);
    if (kind === "departure") sent.call.destroy();
    expect(await t.releases[0]).toEqual({ status: "refused", error: answer("unavailable", 503, "request_cancelled", "none", "committed") });
    if (kind === "deadline") {
      // The adapter writes the returned cancellation once; no tool result ever follows.
      expect((await sent.reply).body).toEqual(rpcError(21, answer("unavailable", 503, "request_cancelled", "none", "committed")));
      expect(writes).toEqual([1]);
    } else {
      await expect(sent.reply).rejects.toThrow();
    }
    await t.mcp.drain();
    if (kind === "departure") expect(writes).toEqual([0]);
    expect(await t.f.records()).toEqual(["held installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.history()).toHaveLength(1);
    expect(t.published).toEqual(["project-a"]);
    // The SDK's held send settles after the release returned and the handler drained: no admission, no write follows.
    const admissions = [vi.spyOn(ExclusiveSqliteConnection.prototype, "runCore"), vi.spyOn(ExclusiveSqliteConnection.prototype, "runDetached"),
      vi.spyOn(ExclusiveSqliteConnection.prototype, "tryCore")];
    const before = [...writes];
    if (late === "fulfils") entered.held.fulfil!(); else entered.held.reject!(new Error("late send /secret"));
    for (let tick = 0; tick < 5; tick++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(writes).toEqual(before);
    for (const spy of admissions) expect(spy).not.toHaveBeenCalled();
    expect(t.releases).toHaveLength(1);
    expect(t.published).toEqual(["project-a"]);
    expect(unhandled).toEqual([]);
    for (const spy of admissions) spy.mockRestore();
    expect(await t.f.records()).toEqual(["held installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
  });

  it.each(["policy replacement", "server close"] as const)("a mutation in flight through the MCP server's %s settles before the close resolves", async kind => {
    const t = await transports("token");
    const o = await owners(t);
    const entered = holdSend();
    const events: string[] = [];
    const sent = o.create("mcp", "inflight", t.f.installationSecret);
    await entered.promise;
    void t.releases[0].then(() => { events.push("released"); });
    const closing = (kind === "policy replacement" ? o.mcp.closeSessions() : o.mcp.close()).then(() => { events.push("closed"); });
    expect((await sent.reply).body).toEqual(rpcError(31, answer("unavailable", 503, "request_cancelled", "none", "committed")));
    await closing;
    expect(events).toEqual(["released", "closed"]);
    expect(await t.f.records()).toEqual(["inflight installation completed"]);
    expect(await t.f.threads()).toHaveLength(1);
    expect(await t.f.history()).toHaveLength(1);
    if (kind === "policy replacement") {
      // The replaced owner serves the next request.
      vi.restoreAllMocks();
      const next = await o.create("mcp", "after", t.f.installationSecret).reply;
      expect((next.body as { result?: { structuredContent?: unknown } }).result?.structuredContent).toMatchObject({ thread: { title: "Release plan" } });
      expect(await t.f.records()).toEqual(["after installation completed", "inflight installation completed"]);
    }
  });
});

describe("knowledge.create_thread: the real owner shutdown and an unsettled accepted mutation", () => {
  it.each(["api", "unix", "mcp"] as const)("%s: the store stays open and the lock held until the handler settled; then one disposal", async listener => {
    const t = await transports("token");
    const o = await owners(t);
    // Hold the accepted request's Node response completion: its handler stays unsettled after the answer was written.
    const held = pause();
    let finish: (() => void) | undefined;
    o.servers[listener].prependListener("request", (_request: IncomingMessage, response: ServerResponse) => {
      const end = response.end.bind(response);
      response.end = ((...args: Parameters<ServerResponse["end"]>) => { finish = () => { end(...args); }; held.done(); return response; }) as ServerResponse["end"];
    });
    const sent = o.create(listener, "owned", listener === "unix" ? undefined : t.f.installationSecret);
    await held.promise;
    let done = false;
    const stopping = o.shutdown().then(() => { done = true; });
    for (let tick = 0; tick < 5; tick++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(done).toBe(false);
    expect(o.counts).toEqual({ disposed: 0, unlocked: 0 });
    expect(o.lock.held()).toBe(true);
    // The store is still open and usable through the real gate.
    expect(await t.f.records()).toEqual([`owned ${listener === "unix" ? "operator" : "installation"} completed`]);
    finish!();
    const reply = await sent.reply;
    expect(reply.status).toBe(200);
    await stopping;
    expect(o.counts).toEqual({ disposed: 1, unlocked: 1 });
    expect(durable(t.f)).toEqual({ threads: 1, history: 1, records: [`owned ${listener === "unix" ? "operator" : "installation"} completed`] });
    // Repeated shutdown reports the same completion and disposes nothing again.
    await o.shutdown();
    expect(o.counts).toEqual({ disposed: 1, unlocked: 1 });
  });

  /**
   * No socket holds the listener here: the response has finished and the client has read it, and the Node
   * listener has closed. The accepted handler is still unsettled, outside admission: the release waits on a
   * latch after its real effect, record and response delivery, before it returns to the adapter. Only the
   * owners' explicit join of accepted handlers keeps the store open and the lock held. The untracked owner is
   * the negative control: the same shutdown without that join disposes both while the latch is closed.
   */
  it.each([["api", "tracked"], ["unix", "tracked"], ["mcp", "tracked"], ["api", "untracked"], ["unix", "untracked"], ["mcp", "untracked"]] as const)(
    "%s, %s owner: a handler unsettled after its response finished holds the store and the lock until it settles", async (listener, variant) => {
      const t = await transports("token");
      const o = await owners(t, { drainAccepted: variant === "tracked" });
      const latch = pause(), waiting = pause();
      const outside: number[] = [];
      t.hooks.returning = async () => { outside.push(t.f.store.admissionSnapshot().coreActive); waiting.done(); await latch.promise; };
      const record = `finished ${listener === "unix" ? "operator" : "installation"} completed`;
      const sent = o.create(listener, "finished", listener === "unix" ? undefined : t.f.installationSecret);
      await waiting.promise;
      // The release returned committed after its effect and record; the client has the whole answer.
      expect(await t.releases[0]).toEqual({ status: "committed" });
      const reply = await sent.reply;
      expect(reply.status).toBe(200);
      expect(listener === "mcp" ? (reply.body as { result?: { structuredContent?: unknown } }).result?.structuredContent : reply.body).toMatchObject({ thread: { title: "Release plan" } });
      expect(outside).toEqual([0]);
      expect(await t.f.records()).toEqual([record]);
      let done = false;
      const closed = new Promise<void>(resolve => { o.servers[listener].once("close", () => { resolve(); }); });
      const stopping = o.shutdown().then(() => { done = true; });
      // The Node listener closes: nothing on the network keeps the shutdown pending.
      await closed;
      expect(o.servers[listener].listening).toBe(false);
      // The same bounded wait in both variants: long enough for an unheld shutdown to finish.
      await vi.waitFor(() => { if (!done) throw new Error("shutdown pending"); }, { timeout: 500, interval: 10 }).catch(() => undefined);
      const observed = { done, counts: { ...o.counts }, held: o.lock.held() };
      const holding = { done: false, counts: { disposed: 0, unlocked: 0 }, held: true };
      if (variant === "tracked") {
        expect(observed).toEqual(holding);
        // The store is still open and usable through the real gate.
        expect(await t.f.records()).toEqual([record]);
      } else {
        // Negative control: without the join the store is closed and the lock released under the unsettled handler.
        expect(observed).not.toEqual(holding);
        expect(observed).toEqual({ done: true, counts: { disposed: 1, unlocked: 1 }, held: false });
      }
      latch.done();
      await stopping;
      expect(o.counts).toEqual({ disposed: 1, unlocked: 1 });
      expect(o.lock.held()).toBe(false);
      expect(durable(t.f)).toEqual({ threads: 1, history: 1, records: [record] });
    });
});

describe("knowledge.create_thread: the adapters write inside admission", () => {
  /** Each server-side writeHead with the real gate's count of admitted participants at that moment. */
  const observeWrites = (t: Transports) => {
    const observed: Array<{ status: number; admitted: number }> = [];
    t.hooks.respond = response => {
      const head = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
      response.writeHead = ((...args: unknown[]) => {
        observed.push({ status: args[0] as number, admitted: t.f.store.admissionSnapshot().coreActive });
        return head(...args);
      }) as ServerResponse["writeHead"];
    };
    return observed;
  };
  /**
   * The negative control: the same runtime whose release captures `commit`
   * and `refuse` and calls them after the runner returned, as an adapter that
   * moved its write outside admission would.
   */
  const deferredWrites = (t: Transports): OperationsHttpRuntime => {
    const runtime = t.mcpRuntime as OperationsHttpRuntime;
    if (!runtime.supported) throw new Error("supported fixture");
    const real = runtime.runner;
    return { ...runtime, runner: { ...real, async mutationRelease(operation, context, raw, options) {
      let later: (() => void) | undefined;
      const released = await real.mutationRelease(operation, context, raw, { ...options,
        commit(value) { later = () => { options.commit(value); }; }, refuse(error) { later = () => { options.refuse(error); }; } });
      later?.();
      return released;
    } } };
  };
  const listen = async (handler: { handle(request: IncomingMessage, response: ServerResponse): Promise<void>; stop(): void; drain(): Promise<void> }, t: Transports) => {
    const server = createServer((request, response) => { t.hooks.respond?.(response); void handler.handle(request, response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { handler.stop(); await handler.drain(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    return (server.address() as AddressInfo).port;
  };

  it("HTTP: commit and refuse write inside the admitted phase; a moved write is seen outside it", async () => {
    const t = await transports("token");
    const observed = observeWrites(t);
    const secret = t.f.installationSecret;
    expect((await t.post("api", "knowledge.create_thread", input(), { secret, key: "in" }).reply).status).toBe(200);
    await t.f.setProjectStatus("project-b", "archived");
    expect((await t.post("api", "knowledge.create_thread", input({ projectId: "project-b" }), { secret, key: "refused" }).reply).status).toBe(409);
    expect(observed).toEqual([{ status: 200, admitted: 1 }, { status: 409, admitted: 1 }]);
    // Negative control: the same requests through an adapter whose writes run after the runner returned.
    observed.length = 0;
    const port = await listen(createOperationsHttp({ runtime: deferredWrites(t), listener: "api" }), t);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${secret}` };
    expect((await t.send({ port }, "/api/operations/knowledge.create_thread", JSON.stringify(input({ title: "Moved" })), { ...headers, "Idempotency-Key": "moved" }).reply).status).toBe(200);
    expect((await t.send({ port }, "/api/operations/knowledge.create_thread", JSON.stringify(input({ projectId: "project-b" })), headers).reply).status).toBe(409);
    expect(observed).toEqual([{ status: 200, admitted: 0 }, { status: 409, admitted: 0 }]);
  });

  it("MCP: the buffered commit and the JSON-RPC refusal write inside the admitted phase; a moved write is seen outside it", async () => {
    const t = await transports("token");
    const observed = observeWrites(t);
    const secret = t.f.installationSecret;
    const created = await t.rpc(tool({ ...input(), idempotencyKey: "in" }, 41), { secret }).reply;
    expect((created.body as { result?: unknown }).result).toBeDefined();
    await t.f.setProjectStatus("project-b", "archived");
    expect((await t.rpc(tool(input({ projectId: "project-b" }), 42), { secret }).reply).body).toEqual(rpcError(42, answer("conflict", 409, "project_archived", "none", "not_started")));
    expect(observed).toEqual([{ status: 200, admitted: 1 }, { status: 200, admitted: 1 }]);
    observed.length = 0;
    const port = await listen(createOperationsMcp({ runtime: deferredWrites(t) }), t);
    const moved = await t.send({ port }, "/mcp/operations", JSON.stringify(tool({ ...input({ title: "Moved" }), idempotencyKey: "moved" }, 43)), t.mcpHeaders(secret)).reply;
    expect((moved.body as { result?: unknown }).result).toBeDefined();
    expect((await t.send({ port }, "/mcp/operations", JSON.stringify(tool(input({ projectId: "project-b" }), 44)), t.mcpHeaders(secret)).reply).body)
      .toEqual(rpcError(44, answer("conflict", 409, "project_archived", "none", "not_started")));
    expect(observed).toEqual([{ status: 200, admitted: 0 }, { status: 200, admitted: 0 }]);
  });
});
