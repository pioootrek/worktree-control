import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteStateStore } from "./sqlite-store";
import { AuthenticationService } from "./modules/authentication";
import { IdentityService } from "./modules/identity";
import { KnowledgeService } from "./modules/knowledge";
import { ControlService } from "./control-service";
import { ProcessManager } from "./process-manager";
import { createControllerServer } from "./http-server";
import { createMcpControllerServer } from "./mcp-http-server";
import { EventStream } from "./events";
import type { DirectoryBrowser } from "./directory-browser";
import { authenticationAdminHandler } from "./authentication-admin";
import type { AppPaths } from "./paths";
import { runKnowledgeCommand } from "../cli/knowledge-management";
import { runIdentityCommand } from "../cli/identity-management";
import { writeServiceAccess } from "../cli/service-access";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(mode: "token" | "open" = "token") {
  const directory = mkdtempSync(join(tmpdir(), "installation-token-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "index.html"), "<title>Dashboard</title>");
  const databasePath = join(directory, "state.sqlite3");
  const store = new SqliteStateStore(databasePath);
  cleanups.push(() => store.close());
  const authentication = new AuthenticationService(store);
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication);
  // A scoped agent created while the installation still ran in legacy mode keeps working in token mode.
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = identity.createKnowledgeProject({ name: "Shared" }, owner);
  const agent = identity.createAgent(owner);
  identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: ["knowledge:read"] }, owner);
  const { token: agentToken, credential: agentCredential } = identity.issueAgentToken({ principalId: agent.id, label: "reader" }, owner);
  const installationToken = authentication.generateToken("test").token;
  authentication.setMode(mode, "test");

  const events = new EventStream();
  cleanups.push(() => events.close());
  const knowledge = new KnowledgeService(store, identity, undefined, undefined, events.publishKnowledge);
  const git = { list: vi.fn(async () => []) };
  const service = new ControlService(store, git as never, new ProcessManager(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, knowledge);
  const web = createControllerServer({
    service, identity, authentication, events, directoryBrowser: {} as DirectoryBrowser, webRoot: directory,
    host: "127.0.0.1", port: 0, accessToken: "pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
  });
  const mcp = createMcpControllerServer({ service, identity, authentication, port: 0, accessToken: "legacy-mcp" });
  for (const controller of [web, mcp]) {
    await new Promise<void>((resolve) => controller.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => controller.close());
  }
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`);
  const knowledgeCall = (token: string, operation: string, input: unknown) => fetch(`${base}/api/knowledge`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, input }),
  });
  const mcpClient = async (token: string) => {
    const client = new Client({ name: "installation-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    cleanups.push(() => client.close());
    return client;
  };
  // CLI commands discover this controller; the database path must never be opened offline.
  const cliPaths = { serviceAccessPath: join(directory, "access.json"), databasePath: join(directory, "never-open.sqlite3"), controllerLockPath: join(directory, "never-lock") } as AppPaths;
  writeServiceAccess(cliPaths.serviceAccessPath, { pid: process.pid, startedAt: new Date().toISOString(), version: "test", dashboardEndpoint: base, mcpEndpoint: endpoint.href, accessUrl: base, logDirectory: directory });
  const cli = async (command: "knowledge" | "identity", args: string[], environment: Record<string, string> = {}) => {
    const output: string[] = [];
    const run = command === "knowledge" ? runKnowledgeCommand : runIdentityCommand;
    await run(args, cliPaths, { environment, write: (line) => output.push(line) });
    return JSON.parse(output[0]!) as Record<string, unknown>;
  };
  return { databasePath, authentication, identity, project, agent, agentToken, agentCredential, installationToken, base, endpoint, knowledgeCall, mcpClient, mcp, events, cli };
}

describe("installation token mode across transports", () => {
  it("accepts only the installation token for the runtime API and rejects legacy secrets", async () => {
    const f = await setup();
    const dashboard = (headers: Record<string, string>) => fetch(`${f.base}/api/metrics`, { headers });

    expect((await dashboard({ "X-Worktree-Switcher-Token": f.installationToken })).status).toBe(200);
    expect((await dashboard({ Authorization: `Bearer ${f.installationToken}` })).status).toBe(200);
    expect((await dashboard({ "X-Worktree-Switcher-Token": "pairing" })).status).toBe(401);
    expect((await dashboard({ Authorization: `Bearer ${f.agentToken}` })).status).toBe(401);
    expect((await dashboard({ "X-Worktree-Switcher-Token": `${f.installationToken.slice(0, -1)}${f.installationToken.endsWith("0") ? "1" : "0"}` })).status).toBe(401);
    const bootstrap = await fetch(`${f.base}/api/identity/bootstrap`, {
      method: "POST", headers: { "X-Worktree-Switcher-Token": "pairing", "Content-Type": "application/json" }, body: "{}",
    });
    expect(bootstrap.status).toBe(401);
  });

  it("gives the installation authority full knowledge access and records it in history", async () => {
    const f = await setup();
    const created = await f.knowledgeCall(f.installationToken, "create_task", {
      projectId: f.project.id, title: "Installation task", description: "Created without a grant", idempotencyKey: "installation-task",
    });
    expect(created.status).toBe(200);
    const denied = await f.knowledgeCall(f.agentToken, "create_task", {
      projectId: f.project.id, title: "Reader task", description: "Reader has no write grant", idempotencyKey: "reader-task",
    });
    expect(denied.status).toBe(403);

    const projects = await (await f.knowledgeCall(f.installationToken, "projects", {})).json() as { items: Array<{ id: string; writable: boolean }> };
    expect(projects.items).toEqual([expect.objectContaining({ id: f.project.id, writable: true })]);
    const readerProjects = await (await f.knowledgeCall(f.agentToken, "projects", {})).json() as { items: Array<{ writable: boolean }> };
    expect(readerProjects.items).toEqual([expect.objectContaining({ writable: false })]);
    const project = await (await f.knowledgeCall(f.installationToken, "project", { projectId: f.project.id })).json() as { writable: boolean };
    expect(project.writable).toBe(true);

    const identity = await fetch(`${f.base}/api/identity`, { headers: { Authorization: `Bearer ${f.installationToken}` } });
    expect(await identity.json()).toEqual({
      principal: { id: "installation", kind: "installation", status: "active" },
      credential: null,
      knowledgeGrants: [],
      installationAuthority: true,
    });
    const admin = await fetch(`${f.base}/api/identity/admin`, {
      method: "POST", headers: { Authorization: `Bearer ${f.installationToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create-agent" }),
    });
    expect(admin.status).toBe(200);

    const database = new Database(f.databasePath, { readonly: true });
    const history = database.prepare("SELECT principal_id, authentication_method FROM knowledge_history WHERE record_kind = 'task'").all();
    database.close();
    expect(history).toEqual([{ principal_id: "installation", authentication_method: "installation_token" }]);
  });

  it("opens runtime and knowledge MCP tools for the installation token and rejects the legacy MCP token", async () => {
    const f = await setup();
    const client = await f.mcpClient(f.installationToken);
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    expect(tools).toEqual(expect.arrayContaining(["list_projects", "knowledge_create_task", "get_identity"]));

    const legacy = await fetch(f.endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer legacy-mcp", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } }),
    });
    expect(legacy.status).toBe(401);
    const scoped = await f.mcpClient(f.agentToken);
    expect((await scoped.listTools()).tools.map(({ name }) => name)).not.toContain("list_projects");
  });

  it("invalidates the previous installation token immediately after rotation", async () => {
    const f = await setup();
    const actor = f.authentication.authenticateInstallation(f.installationToken)!;
    const rotated = f.authentication.rotateToken("test").token;

    expect((await fetch(`${f.base}/api/metrics`, { headers: { "X-Worktree-Switcher-Token": f.installationToken } })).status).toBe(401);
    expect((await fetch(`${f.base}/api/metrics`, { headers: { "X-Worktree-Switcher-Token": rotated } })).status).toBe(200);
    // Long-lived consumers such as SSE filters recheck the actor and lose knowledge access at once.
    expect(() => f.identity.authorizeKnowledge(actor, f.project.id, "knowledge:read")).toThrow("Nieprawidłowe lub nieaktywne poświadczenie.");
  });

  it("requires no credentials in open mode and records anonymous installation authority", async () => {
    const f = await setup("open");
    expect((await fetch(`${f.base}/api/metrics`)).status).toBe(200);
    const dashboard = await (await fetch(`${f.base}/api/dashboard`)).json() as { authentication: { mode: string; listen: string } };
    expect(dashboard.authentication).toEqual({ mode: "open", listen: "127.0.0.1:0" });
    // Grants are no boundary for anonymous callers: even a read-only agent credential is ignored.
    const created = await f.knowledgeCall(f.agentToken, "create_task", {
      projectId: f.project.id, title: "Anonymous task", description: "Open mode", idempotencyKey: "open-task",
    });
    expect(created.status).toBe(200);
    const bootstrap = await fetch(`${f.base}/api/identity/bootstrap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(bootstrap.status).toBe(401);

    const client = new Client({ name: "anonymous", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(f.endpoint));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining(["list_projects", "knowledge_create_task"]));

    const database = new Database(f.databasePath, { readonly: true });
    const history = database.prepare("SELECT principal_id, authentication_method FROM knowledge_history WHERE record_kind = 'task'").all();
    database.close();
    expect(history).toEqual([{ principal_id: "installation", authentication_method: "none" }]);

    const anonymous = f.authentication.anonymousInstallation()!;
    f.authentication.setMode("token", "test");
    expect((await fetch(`${f.base}/api/metrics`)).status).toBe(401);
    expect(() => f.identity.authorizeKnowledge(anonymous, f.project.id, "knowledge:read")).toThrow("Nieprawidłowe lub nieaktywne poświadczenie.");
  });

  it("runs knowledge and identity CLI commands against an open-mode controller without token variables", async () => {
    const f = await setup("open");
    const task = (await f.cli("knowledge", ["create_task", "--json", JSON.stringify({
      projectId: f.project.id, title: "CLI task", description: "Open mode CLI", idempotencyKey: "open-cli-task",
    })])).value as { id: string };
    expect(task.id).toEqual(expect.any(String));
    expect((await f.cli("knowledge", ["projects"])).items).toEqual([expect.objectContaining({ id: f.project.id, writable: true })]);
    const agent = (await f.cli("identity", ["create-agent"])).principal as { id: string };
    await f.cli("identity", ["grant-knowledge", "--principal-id", agent.id, "--project-id", f.project.id, "--permissions", "knowledge:read"]);
    expect((await f.cli("identity", ["list-knowledge-grants", "--principal-id", agent.id])).grants)
      .toEqual([expect.objectContaining({ projectId: f.project.id, permissions: ["knowledge:read"] })]);

    const database = new Database(f.databasePath, { readonly: true });
    const history = database.prepare("SELECT principal_id, authentication_method FROM knowledge_history WHERE record_kind = 'task'").all();
    database.close();
    expect(history).toEqual([{ principal_id: "installation", authentication_method: "none" }]);
  });

  it("keeps CLI credentials mandatory in token mode and scoped agent tokens within their grants", async () => {
    const f = await setup();
    const create = (environment: Record<string, string>, key: string) => f.cli("knowledge", ["create_task", "--json", JSON.stringify({
      projectId: f.project.id, title: "Protected", description: "Token mode", idempotencyKey: key,
    })], environment);
    await expect(create({}, "missing")).rejects.toThrow("WORKTREE_SWITCHER_KNOWLEDGE_TOKEN");
    await expect(f.cli("identity", ["list-agents"])).rejects.toThrow("WORKTREE_SWITCHER_OWNER_TOKEN");
    const forged = `${f.installationToken.slice(0, -1)}${f.installationToken.endsWith("0") ? "1" : "0"}`;
    await expect(create({ WORKTREE_SWITCHER_TOKEN: forged }, "forged")).rejects.toThrow("invalid_credential");
    await expect(f.cli("identity", ["list-agents"], { WORKTREE_SWITCHER_TOKEN: forged })).rejects.toThrow("A valid access token is required.");

    // A read-only agent reads through the CLI but cannot write or administer identity.
    const reader = { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: f.agentToken };
    expect((await f.cli("knowledge", ["projects"], reader)).items).toEqual([expect.objectContaining({ id: f.project.id, writable: false })]);
    await expect(create(reader, "reader")).rejects.toThrow("knowledge_forbidden");
    await expect(f.cli("identity", ["list-agents"], { WORKTREE_SWITCHER_OWNER_TOKEN: f.agentToken })).rejects.toThrow("sesji właściciela");

    const installation = { WORKTREE_SWITCHER_TOKEN: f.installationToken };
    expect((await f.cli("identity", ["list-agents"], installation)).principals).toEqual([expect.objectContaining({ id: f.agent.id })]);
    await f.cli("identity", ["revoke-token", "--credential-id", f.agentCredential.id], installation);
    await expect(f.cli("knowledge", ["projects"], reader)).rejects.toThrow("invalid_credential");
    await create(installation, "installation");
  });

  it("ends live MCP sessions and event streams when the admin channel changes the policy", async () => {
    const f = await setup();
    const client = await f.mcpClient(f.installationToken);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const stream = await fetch(`${f.base}/api/events`, { headers: { "X-Worktree-Switcher-Token": f.installationToken } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read();

    const admin = authenticationAdminHandler({
      authentication: f.authentication,
      closeMcpSessions: () => f.mcp.closeSessions(),
      disconnectEvents: () => f.events.disconnectAll(),
    });
    expect(await admin({ command: "status" })).toMatchObject({ mode: "token" });
    await expect(client.listTools()).resolves.toBeDefined();

    const rotated = await admin({ command: "token rotate" }) as { token: string };
    let ended = false;
    while (!ended) ended = (await reader.read()).done;
    await expect(client.listTools()).rejects.toThrow();
    const fresh = await f.mcpClient(rotated.token);
    expect((await fresh.listTools()).tools.length).toBeGreaterThan(0);
    await expect(admin({ command: "mode set", value: "legacy" })).rejects.toThrow("Dostępne tryby");
    await expect(admin({ command: "drop tables" })).rejects.toThrow("Available auth commands");
  });
});
