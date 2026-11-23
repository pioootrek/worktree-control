import { createServer, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenAdminSocket } from "@/server/admin-socket";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { createOperationsHttp } from "@/server/transports/operations-http";
import type { OperationRetention } from "@/server/bootstrap/operation-retention";
import { answer, knowledgeFixture, type KnowledgeFixture, type StoredMode } from "./knowledge-writes-fixture";
import type { KnowledgeThreadWriter } from "./knowledge-writes";
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
  const hooks: { reserved?: () => void; written?: () => void } = {};
  // Observation points inside the admitted phases, on the real writer and the real idempotency store.
  const store = f.store, writerOf = store.knowledgeThreadWriter.bind(store);
  store.knowledgeThreadWriter = () => {
    const writer = writerOf();
    return { ...writer, createThread: (thread, author) => { writer.createThread(thread, author); hooks.written?.(); } } satisfies KnowledgeThreadWriter;
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
  return { f, built, hooks, adapters, servers, responses, published, post, send };
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
