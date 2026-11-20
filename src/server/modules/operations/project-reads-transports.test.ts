import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { SystemGitWorktreeReader } from "@/server/git-worktrees";
import type { WorktreeGit } from "./adapters/worktree-discovery";
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

/** `repository` maps a registration name to its repository path; `git` replaces the fixture listing with a real reader. */
async function fixture(mode: "open" | "token" | "better-auth" | "legacy", setup: { repository?: (name: string) => string; git?: WorktreeGit } = {}) {
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
      const id = store.addProject({ name, repositoryPath: setup.repository?.(name) ?? `/repo/${name}`, port: 7300 + ports++, executable: "node", args: ["server.js"] }).id;
      db.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
      db.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, id);
      return id;
    };
    return { a: register("alpha", "project-a"), b: register("beta-repo", "project-b"), loose: register("loose", null) };
  });
  const gates = new Map<string, ReturnType<typeof deferred<unknown[]>>>();
  const git = {
    listTrees: vi.fn((path: string, options: { signal: AbortSignal }): Promise<readonly unknown[]> =>
      setup.git ? setup.git.listTrees(path, options) : gates.get(path)?.promise ?? Promise.resolve([tree(path)])),
    worktreeDirty: vi.fn(async (path: string, options: { signal: AbortSignal }) => setup.git ? setup.git.worktreeDirty(path, options) : false),
  };
  // Called inside every admitted read phase of project.list and project.status; a test may write the store there.
  const placement = { hook: undefined as (() => void) | undefined, statusSummary: vi.fn(() => { placement.hook?.(); return { phase: "stopped", worktreePath: null, startedAt: null }; }) };
  const eligibility = createControllerOperationEligibility({ maintenance: () => false, stopping: () => false, configurationRestartRequired: () => false, runtime: () => undefined });
  const built = buildOperationsRuntime({ store, activeMode: mode, now: Date.now, logs: { controller() {} }, provider: null, eligibility,
    projectReads: { placement, git },
    requestBudget: new AuthenticationRequestBudget(16, 4), listeners: { api: () => true, unix: () => true, worker: () => true, mcp: () => true } });
  if (!built.supported && mode !== "legacy") throw new Error("unsupported");
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
  const grantNow = (role: string, projectId: string) => db.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent',?,'project',?,?)").run(role, projectId, iso(NOW));
  const revokeNow = () => db.prepare("DELETE FROM account_grants WHERE account_id='agent'").run();
  const grant = (role: string, projectId: string) => admission.run(() => grantNow(role, projectId));
  const revoke = () => admission.run(revokeNow);
  const reparent = (id: string, parent: string) => admission.run(() => {
    db.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
    db.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, id);
  });
  return { built, ids, git, gates, placement, admission, post, client, grant, revoke, grantNow, revokeNow, reparent };
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
    expect(f.git.listTrees).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(f.git.listTrees).toHaveBeenCalledTimes(1));
    await f.revoke();
    gate.resolve([tree("/repo/beta-repo")]);
    expect(await http).toEqual({ status: 404, body: refusal("not_found", 404, "resource_not_found") });
    // The tool's refusal is released by the tool's own fresh decision, as on HTTP, never replaced by the describe witness.
    const mcpResult = await viaMcp;
    expect(mcpResult).toEqual({ result: expect.objectContaining({ isError: true, structuredContent: refusal("not_found", 404, "resource_not_found") }) });
    // Both callers shared one discovery of the repository.
    expect(f.git.listTrees).toHaveBeenCalledTimes(1);
  });

  it("open: a cancelled caller leaves a shared discovery to the other, and a registration moved during discovery is a conflict", async () => {
    const f = await fixture("open");
    const calls = (path: string) => f.git.listTrees.mock.calls.filter(([each]) => each === path).length;
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

  it("better-auth: a project refusal stays the tool's own answer when unrelated authority changes before it is written", async () => {
    const f = await fixture("better-auth"), c = await f.client();
    // The refusal envelope is built outside admission; a grant on another project lands then and changes session.describe.
    const idle = f.admission.idle.bind(f.admission);
    let granted = 0;
    vi.spyOn(f.admission, "idle").mockImplementation(async operation => {
      if (granted++ === 0) await f.grant("reader", "project-b");
      return idle(operation);
    });
    const hidden = await c.callTool({ name: "project_status", arguments: { projectId: "project-a" } });
    expect(granted).toBeGreaterThan(0);
    expect(hidden).toMatchObject({ isError: true, structuredContent: refusal("not_found", 404, "resource_not_found") });
    expect(await f.post("api", "project.status", { projectId: "project-a" })).toEqual({ status: 404, body: refusal("not_found", 404, "resource_not_found") });
    // The neighbour granted meanwhile is readable on both transports.
    expect((await c.callTool({ name: "project_status", arguments: { projectId: "project-b" } })).structuredContent).toEqual((await f.post("api", "project.status", { projectId: "project-b" })).body);
  });

  it("better-auth: a read revoked between its buffered value and the write is refused by the tool's fresh decision", async () => {
    const f = await fixture("better-auth"), c = await f.client();
    await f.grant("reader", "project-a");
    // Revoke inside the first admitted read phase, after its decision: the final read of the same tool decides again.
    let calls = 0;
    f.placement.hook = () => { if (calls++ === 0) f.revokeNow(); };
    const outcome = await c.callTool({ name: "project_status", arguments: { projectId: "project-a" } }).then(result => ({ result }), (error: Error & { data?: unknown }) => ({ error }));
    expect(calls).toBe(1);
    expect(outcome).not.toHaveProperty("result");
    const error = (outcome as { error: Error & { data?: unknown } }).error;
    expect(error.message).toMatch(/resource_not_found/);
    expect(error.data).toEqual(refusal("not_found", 404, "resource_not_found").error);
    f.placement.hook = undefined;
    expect(await f.post("api", "project.status", { projectId: "project-a" })).toEqual({ status: 404, body: refusal("not_found", 404, "resource_not_found") });
  });

  it("better-auth: HTTP and MCP decide alike for granted, hidden, missing, secrets-only and malformed requests", async () => {
    const f = await fixture("better-auth"), c = await f.client();
    await f.grant("reader", "project-a"); await f.grant("secrets", "project-b");
    const cases: [string, Record<string, unknown>][] = [
      ["project.list", {}], ["project.status", { projectId: "project-a" }], ["project.worktrees", { projectId: "project-a" }],
      ["project.status", { projectId: "project-b" }], ["project.worktrees", { projectId: "project-b" }],
      ["project.status", { projectId: "nope" }], ["project.status", { projectId: "a b" }], ["project.list", { limit: 0 }],
    ];
    for (const [operation, input] of cases) {
      const api = await f.post("api", operation, input);
      const viaMcp = await c.callTool({ name: tools[operation as keyof typeof tools], arguments: input });
      expect(viaMcp.structuredContent, `${operation} ${JSON.stringify(input)}`).toEqual(api.body);
      expect(Boolean(viaMcp.isError), operation).toBe(api.status !== 200);
    }
    const list = (await f.post("api", "project.list", {})).body as { items: { projectId: string }[] };
    expect(list.items.map(item => item.projectId)).toEqual(["project-a"]);
    expect((await f.post("api", "project.status", { projectId: "project-b" })).body).toEqual(refusal("forbidden", 403, "permission_denied"));
    // The secrets-only project's repository was never discovered.
    expect(f.git.listTrees.mock.calls.map(([path]) => path)).toEqual(["/repo/alpha", "/repo/alpha"]);
  });

  it("legacy: no registry exists, so every listener refuses the project reads without running them", async () => {
    const f = await fixture("legacy");
    for (const listener of ["api", "unix"] as const) {
      // Only the reserved describe path is claimed, and it answers the mode refusal.
      expect(await f.post(listener, "session.describe", {})).toEqual({ status: 401, body: refusal("unauthenticated", 401, "unknown_mode", "reauthenticate") });
      for (const operation of Object.keys(inputs) as (keyof typeof inputs)[]) {
        expect(await f.post(listener, operation, inputs[operation]), `${listener} ${operation}`).toEqual({ status: 404, body: refusal("not_found", 404, "operation_not_found") });
      }
    }
    expect(f.git.listTrees).not.toHaveBeenCalled(); expect(f.placement.statusSummary).not.toHaveBeenCalled();
  });

  it("better-auth: a reader sees its project's real Git worktrees, and a hidden neighbour is indistinguishable from a missing project, on API, unix and MCP", async () => {
    const base = mkdtempSync(join(tmpdir(), "project-reads-git-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const repository = (name: string) => {
      const directory = join(base, name);
      execFileSync("git", ["init", "-q", "-b", "main", directory]);
      for (const [key, value] of [["user.email", "test@example.invalid"], ["user.name", "Test"]]) execFileSync("git", ["-C", directory, "config", key, value]);
      writeFileSync(join(directory, "tracked.txt"), "one\n");
      execFileSync("git", ["-C", directory, "add", "tracked.txt"]); execFileSync("git", ["-C", directory, "commit", "-qm", "fixture"]);
      return realpathSync(directory);
    };
    const alpha = repository("alpha"), beta = repository("beta");
    execFileSync("git", ["-C", alpha, "worktree", "add", "-q", "-b", "feature", join(base, "alpha-feature")]);
    const feature = realpathSync(join(base, "alpha-feature"));
    writeFileSync(join(feature, "tracked.txt"), "changed\n");
    const head = execFileSync("git", ["-C", alpha, "rev-parse", "HEAD"]).toString().trim();
    const reader = new SystemGitWorktreeReader(); cleanups.push(() => reader.close());
    const f = await fixture("better-auth", { repository: name => name === "alpha" ? alpha : name === "beta-repo" ? beta : `/repo/${name}`, git: reader }), c = await f.client();
    await f.grant("reader", "project-a");

    const expected = { projectId: "project-a", registrationsTruncated: false, registrations: [{ registrationId: f.ids.a, discovery: "complete", worktreesTruncated: false, worktrees: [
      { path: alpha, branch: "main", head, shortHead: head.slice(0, 8), detached: false, locked: false, prunable: false, dirty: false },
      { path: feature, branch: "feature", head, shortHead: head.slice(0, 8), detached: false, locked: false, prunable: false, dirty: true },
    ] }] };
    const viaApi = await f.post("api", "project.worktrees", { projectId: "project-a" });
    expect(viaApi).toEqual({ status: 200, body: expected });
    // Unix is the local operator: full authority, the same real discovery.
    expect(await f.post("unix", "project.worktrees", { projectId: "project-a" })).toEqual(viaApi);
    const viaMcp = await c.callTool({ name: "project_worktrees", arguments: { projectId: "project-a" } });
    expect(viaMcp.isError).toBeFalsy(); expect(viaMcp.structuredContent).toEqual(expected);

    const listed = await f.post("api", "project.list", {});
    expect(listed).toEqual({ status: 200, body: { nextCursor: null, items: [{ projectId: "project-a", name: "project-a", status: "active", registrationsTruncated: false,
      registrations: [{ registrationId: f.ids.a, name: "alpha", port: expect.any(Number), phase: "stopped", worktreePath: null, claim: "none" }] }] } });
    expect((await c.callTool({ name: "project_list", arguments: {} })).structuredContent).toEqual(listed.body);
    const status = await f.post("api", "project.status", { projectId: "project-a" });
    expect(status).toMatchObject({ status: 200, body: { projectId: "project-a", writable: false, registrations: [{ registrationId: f.ids.a, launch: { executable: "node", args: ["server.js"] } }] } });
    expect((await c.callTool({ name: "project_status", arguments: { projectId: "project-a" } })).structuredContent).toEqual(status.body);

    // The neighbour has a real repository too; it is refused exactly like a missing project, and never discovered.
    for (const operation of ["project.status", "project.worktrees"] as const) {
      const hidden = await f.post("api", operation, { projectId: "project-b" }), missing = await f.post("api", operation, { projectId: "missing-project" });
      expect(hidden).toEqual({ status: 404, body: refusal("not_found", 404, "resource_not_found") }); expect(missing).toEqual(hidden);
      for (const projectId of ["project-b", "missing-project"]) {
        const viaTool = await c.callTool({ name: tools[operation], arguments: { projectId } });
        expect(viaTool, `${operation} ${projectId}`).toMatchObject({ isError: true, structuredContent: hidden.body });
      }
    }
    expect(f.git.listTrees.mock.calls.map(([path]) => path)).toEqual([alpha, alpha, alpha]);
  });
});
