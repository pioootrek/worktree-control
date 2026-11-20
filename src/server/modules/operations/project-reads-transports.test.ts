import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOperationsRuntime } from "@/server/bootstrap/operations-runtime";
import { createControllerOperationEligibility } from "@/server/bootstrap/authentication-provider-lifetime";
import { AuthenticationRequestBudget } from "@/server/bootstrap/authentication-request-budget";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { resolveAppPaths } from "@/server/paths";
import { createOperationsMcp } from "@/server/transports/operations-mcp";
import { createOperationsHttp } from "@/server/transports/operations-http";
import { hash, iso, NOW, token } from "./adapters/credential-verifier-fixture";

/**
 * D2a transport parity: the three project reads through the production
 * composition (real store, verifiers, grants, resolver, catalog and coalesced
 * discovery) on the API, unix and worker HTTP adapters and the MCP adapter.
 * Every transport releases the same DTO for the same authority, the worker
 * listener does not serve them, and authority is decided again after discovery.
 */
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
let ports = 0;
const tree = (path: string) => ({ path, branch: "main", head: "b".repeat(40), shortHead: "bbbbbbbb", detached: false, locked: false, prunable: false, dirty: false, statusError: "private" });

async function fixture(mode: "open" | "token" | "better-auth") {
  const root = mkdtempSync(join(tmpdir(), "project-reads-transports-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath, undefined, { admission: "strict" });
  cleanups.push(() => store.close());
  const admission = store.admission;
  vi.spyOn(store, "admission", "get").mockReturnValue(admission);
  const db = ownedFixtureDatabase(store), installation = token("wsi"), agent = token("wts");
  const ids = await admission.run(() => {
    const policy = store.getAuthenticationPolicy();
    store.saveAuthenticationPolicy({ ...policy, mode, token: { id: installation.slice(4, 40), prefix: installation.slice(0, 40), verifierHash: hash(installation), createdAt: iso(NOW) } }, "fixture", "fixture");
    store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "fixture");
    store.saveCredential({ id: agent.slice(4, 40), principalId: "agent", kind: "agent_token", label: "fixture", tokenPrefix: agent.slice(0, 40), verifierHash: hash(agent), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
    for (const id of ["project-a", "project-b"]) store.saveKnowledgeProject({ id, name: id, status: "active", revision: 1, createdAt: iso(NOW), updatedAt: iso(NOW) }, "fixture");
    const register = (name: string, parent: string | null) => {
      const id = store.addProject({ name, repositoryPath: `/repo/${name}`, port: 7300 + ports++, executable: "node", args: ["server.js"] }).id;
      db.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
      db.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, id);
      return id;
    };
    return { a: register("alpha", "project-a"), b: register("beta-repo", "project-b"), loose: register("loose", null) };
  });
  const gates = new Map<string, ReturnType<typeof deferred<unknown[]>>>();
  const git = { list: vi.fn((path: string) => gates.get(path)?.promise ?? Promise.resolve([tree(path)])) };
  const eligibility = createControllerOperationEligibility({ maintenance: () => false, stopping: () => false, configurationRestartRequired: () => false, runtime: () => undefined });
  const built = buildOperationsRuntime({ store, activeMode: mode, now: Date.now, logs: { controller() {} }, provider: null, eligibility,
    projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git },
    requestBudget: new AuthenticationRequestBudget(16, 4), listeners: { api: () => true, unix: () => true, worker: () => true, mcp: () => true } });
  if (!built.supported) throw new Error("unsupported");
  const serve = async (handler: Parameters<typeof createServer>[1], stop: () => Promise<void>) => {
    const server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => { await stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    return server;
  };
  const servers: Record<"api" | "unix" | "worker" | "mcp", HttpServer> = {} as never;
  for (const listener of ["api", "unix", "worker"] as const) {
    const adapter = createOperationsHttp({ runtime: built, listener });
    servers[listener] = await serve((request, response) => { void adapter.handle(request, response); }, async () => { adapter.stop(); await adapter.drain(); });
  }
  const mcp = createOperationsMcp({ runtime: built });
  servers.mcp = await serve((request, response) => { void mcp.handle(request, response); }, async () => { mcp.stop(); await mcp.drain(); });
  const secret = mode === "token" ? installation : mode === "better-auth" ? agent : undefined;
  const post = (listener: "api" | "unix" | "worker", operation: string, body: unknown, options: { secret?: string; signal?: AbortSignal } = {}) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const credential = listener === "unix" ? undefined : options.secret ?? secret;
      const call = httpRequest({ host: "127.0.0.1", port: (servers[listener].address() as AddressInfo).port, path: `/api/operations/${operation}`, method: "POST", signal: options.signal,
        headers: { "Content-Type": "application/json", ...(credential ? { Authorization: `Bearer ${credential}` } : {}) } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      call.on("error", reject); call.end(JSON.stringify(body));
    });
  const client = async () => {
    const c = new Client({ name: "project-reads", version: "1" }); cleanups.push(() => c.close());
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(servers.mcp.address() as AddressInfo).port}/mcp/operations`),
      { requestInit: { headers: secret ? { Authorization: `Bearer ${secret}` } : {} } }));
    return c;
  };
  const grant = (role: string, projectId: string) => admission.run(() => db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent',?,'project',?,?)").run(role, projectId, iso(NOW)));
  const revoke = () => admission.run(() => db.prepare("DELETE FROM account_grants WHERE account_id='agent'").run());
  const reparent = (id: string, parent: string) => admission.run(() => {
    db.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
    db.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, id);
  });
  return { built, ids, git, gates, post, client, grant, revoke, reparent };
}
const refusal = (category: string, status: number, reason: string, retry = "none") => ({ error: { category, status, reason, retry, effect: null } });
const inputs = { "project.list": {}, "project.status": { projectId: "project-a" }, "project.worktrees": { projectId: "project-b" } } as const;
const tools = { "project.list": "project_list", "project.status": "project_status", "project.worktrees": "project_worktrees" } as const;

describe("project reads over every transport (D2a)", () => {
  it.each(["open", "token"] as const)("%s: API, unix and MCP release the same DTO; the worker listener does not serve project reads", async mode => {
    const f = await fixture(mode), c = await f.client();
    for (const [operation, input] of Object.entries(inputs) as [keyof typeof inputs, Record<string, unknown>][]) {
      const api = await f.post("api", operation, input), unix = await f.post("unix", operation, input);
      expect(api.status, operation).toBe(200);
      expect(unix).toEqual(api);
      const viaMcp = await c.callTool({ name: tools[operation], arguments: input });
      expect(viaMcp.isError, operation).toBeFalsy();
      expect(viaMcp.structuredContent).toEqual(api.body);
      expect(await f.post("worker", operation, input)).toEqual({ status: 404, body: refusal("not_found", 404, "operation_not_found") });
    }
    // Full authority sees the parentless registration as its own item.
    const listed = (await f.post("api", "project.list", {})).body as { items: { projectId: string | null; registrations: { registrationId: string }[] }[] };
    expect(listed.items.map(item => [item.projectId, item.registrations.map(r => r.registrationId)])).toEqual([["project-a", [f.ids.a]], ["project-b", [f.ids.b]], [null, [f.ids.loose]]]);
    expect(JSON.stringify(listed)).not.toContain("private");
  });

  it("better-auth: a zero-role agent gets an empty list and cannot tell a hidden project from a missing one, on API and MCP alike", async () => {
    const f = await fixture("better-auth"), c = await f.client();
    expect(await f.post("api", "project.list", {})).toEqual({ status: 200, body: { items: [], nextCursor: null } });
    const hidden = await f.post("api", "project.status", { projectId: "project-a" }), missing = await f.post("api", "project.status", { projectId: "nope" });
    expect(hidden).toEqual(missing); expect(hidden).toEqual({ status: 404, body: refusal("not_found", 404, "resource_not_found") });
    expect((await c.callTool({ name: "project_list", arguments: {} })).structuredContent).toEqual({ items: [], nextCursor: null });
    const viaMcp = await c.callTool({ name: "project_worktrees", arguments: { projectId: "project-b" } });
    expect(viaMcp.isError).toBe(true); expect(viaMcp.structuredContent).toEqual(refusal("not_found", 404, "resource_not_found"));
    expect(f.git.list).not.toHaveBeenCalled();
    await f.grant("reader", "project-a");
    const reader = (await f.post("api", "project.status", { projectId: "project-a" })).body as Record<string, unknown>;
    expect(reader).toMatchObject({ projectId: "project-a", writable: false, revision: 1 });
    expect((await c.callTool({ name: "project_status", arguments: { projectId: "project-a" } })).structuredContent).toEqual(reader);
    expect((await c.callTool({ name: "project_status", arguments: { projectId: "project-a", extra: 1 } })).structuredContent).toEqual(refusal("invalid_request", 400, "unexpected_input"));
  });

  it("better-auth: revocation while discovery waits releases nothing over HTTP or MCP", async () => {
    const f = await fixture("better-auth"), c = await f.client();
    await f.grant("reader", "project-b");
    const gate = deferred<unknown[]>(); f.gates.set("/repo/beta-repo", gate);
    const http = f.post("api", "project.worktrees", { projectId: "project-b" });
    const viaMcp = c.callTool({ name: "project_worktrees", arguments: { projectId: "project-b" } }).then(result => ({ result }), (error: Error) => ({ error }));
    await vi.waitFor(() => expect(f.git.list).toHaveBeenCalledTimes(1));
    await f.revoke();
    gate.resolve([tree("/repo/beta-repo")]);
    expect(await http).toEqual({ status: 404, body: refusal("not_found", 404, "resource_not_found") });
    // The tool's refusal is written under the session.describe witness of D1a. Revocation also changed
    // that witness, so the final gate refuses the whole response; either way no worktree is released.
    const mcpResult = await viaMcp;
    expect(mcpResult).not.toHaveProperty("result");
    expect("error" in mcpResult && mcpResult.error.message).toMatch(/release_payload_changed/);
    // Both callers shared one discovery of the repository.
    expect(f.git.list).toHaveBeenCalledTimes(1);
  });

  it("open: a cancelled caller leaves a shared discovery to the other, and a registration moved during discovery is a conflict", async () => {
    const f = await fixture("open");
    const calls = (path: string) => f.git.list.mock.calls.filter(([each]) => each === path).length;
    const shared = deferred<unknown[]>(); f.gates.set("/repo/alpha", shared);
    const abort = new AbortController();
    const cancelled = f.post("api", "project.worktrees", { projectId: "project-a" }, { signal: abort.signal }).catch(error => error as Error);
    const kept = f.post("unix", "project.worktrees", { projectId: "project-a" });
    await vi.waitFor(() => expect(calls("/repo/alpha")).toBe(1));
    // Let the second caller reach the same in-flight discovery before the first leaves.
    await new Promise(resolve => setTimeout(resolve, 200));
    abort.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    shared.resolve([tree("/repo/alpha")]);
    expect(await kept).toMatchObject({ status: 200, body: { projectId: "project-a", registrations: [expect.objectContaining({ discovery: "complete" })] } });
    expect(calls("/repo/alpha")).toBe(1);
    const moved = deferred<unknown[]>(); f.gates.set("/repo/beta-repo", moved);
    const pending = f.post("api", "project.worktrees", { projectId: "project-b" });
    await vi.waitFor(() => expect(calls("/repo/beta-repo")).toBe(1));
    await f.reparent(f.ids.b, "project-a");
    moved.resolve([tree("/repo/beta-repo")]);
    expect(await pending).toEqual({ status: 409, body: refusal("conflict", 409, "resource_changed") });
  });
});
