import { createServer, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createOperationsHttp, OPERATIONS_HTTP_LIMITS } from "@/server/transports/operations-http";
import { createOperationsMcp, OPERATIONS_MCP_REQUEST_ENVELOPE_BYTES } from "@/server/transports/operations-mcp";
import type { OperationRetention } from "@/server/bootstrap/operation-retention";
import { answer, knowledgeFixture, type KnowledgeFixture, type StoredMode } from "./knowledge-writes-fixture";
import type { IdempotencyStore } from "./runner";

/**
 * D2b-2 decision 10 on HTTP: `knowledge.create_thread` through the real
 * production composition (store, verifiers, grants, resolver, retention) on
 * the API, unix and worker adapters, and on the externally owned admin socket.
 * Covers header carriage, the singleton key header, a key on a read, both
 * sides of each body ceiling, the worker refusal, an unknown mode, concurrent
 * keys, and ownership around the commit point.
 */
const fixtures: KnowledgeFixture[] = [];
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  for (const f of fixtures.splice(0)) f.cleanup();
  vi.restoreAllMocks();
});
type Reply = { status: number; body: Record<string, unknown>; headers: IncomingMessage["headers"] };
type Listener = "api" | "unix" | "worker";

async function transports(mode: StoredMode, setup: { humans?: boolean } = {}) {
  const f = await knowledgeFixture(mode, setup); fixtures.push(f);
  const hooks: { reserved?: () => void; written?: () => void; staged?: () => void } = {};
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
  const built = buildOperationsRuntime({ ...f.runtimeOptions(), retention, knowledge: { changed: (projectId: string) => { published.push(projectId); } } });
  const adapters = {} as Record<Listener, ReturnType<typeof createOperationsHttp>>;
  const servers = {} as Record<Listener, HttpServer>;
  const responses: ServerResponse[] = [];
  for (const listener of ["api", "unix", "worker"] as const) {
    const adapter = createOperationsHttp({ runtime: built, listener });
    const server = createServer((request, response) => { responses.push(response); void adapter.handle(request, response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { adapter.stop(); await adapter.drain(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    adapters[listener] = adapter; servers[listener] = server;
  }
  // The MCP adapter over the same composition; `staged` observes the moment the SDK holds the buffered output.
  const runner = built.supported ? built.runner : undefined;
  const mcpRuntime = built.supported && runner ? { ...built, runner: {
    readRelease: runner.readRelease.bind(runner), queryRelease: runner.queryRelease.bind(runner),
    mutationRelease: ((operation, context, raw, options) => runner.mutationRelease(operation, context, raw, options.stage ? { ...options,
      async stage(value: object) { await options.stage!.call(options, value); hooks.staged?.(); } } : options)) as typeof runner.mutationRelease,
  } } : built;
  const mcp = createOperationsMcp({ runtime: mcpRuntime });
  const mcpServer = createServer((request, response) => { responses.push(response); void mcp.handle(request, response); });
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
  return { f, built, hooks, adapters, servers, responses, published, post, send, mcp, mcpServer, rpc, mcpHeaders, client };
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
    const mint = vi.spyOn(t.built, "mint");
    for (const listener of ["api", "unix"] as const) {
      const headers = ["Content-Type", "application/json", "Idempotency-Key", "k-1", "Idempotency-Key", "k-1",
        ...(listener === "api" ? ["Authorization", `Bearer ${t.f.installationSecret}`] : [])];
      const reply = await t.post(listener, "knowledge.create_thread", input(), { headers }).reply;
      expect(reply).toMatchObject({ status: 400, body: refusal("invalid_request", 400, "invalid_request", "none", null) });
    }
    expect(mint).not.toHaveBeenCalled();
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
    for (const [operation, body] of [["project.status", { projectId: "project-a" }], ["project.list", {}], ["session.describe", {}]] as const) {
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
    const borrowed: { release?: () => void; held?: Promise<void> } = {};
    let call: ReturnType<typeof t.post>["call"] | undefined;
    t.hooks.reserved = () => {
      // Hold the real gate so phase 3 waits; the client goes away meanwhile.
      borrowed.held = t.f.store.authenticationProviderStorage().borrow(() => new Promise<void>(resolve => { borrowed.release = resolve; })) as Promise<void>;
      call?.destroy();
    };
    const sent = t.post("api", "knowledge.create_thread", input(), { secret: t.f.installationSecret, key: "k" });
    call = sent.call;
    await expect(sent.reply).rejects.toThrow();
    const response = await vi.waitFor(() => { const last = t.responses.at(-1); if (!last?.destroyed) throw new Error("not closed yet"); return last; });
    expect(response.destroyed).toBe(true);
    await vi.waitFor(() => { if (!borrowed.release) throw new Error("not held yet"); });
    borrowed.release!();
    await borrowed.held;
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
    const mint = vi.spyOn(t.built, "mint");
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
    expect(mint).not.toHaveBeenCalled();
    expect(await t.f.threads()).toHaveLength(1);
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
