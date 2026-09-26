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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
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
  const agentToken = identity.issueAgentToken({ principalId: agent.id, label: "reader" }, owner).token;
  const installationToken = authentication.generateToken("test").token;
  authentication.setMode("token", "test");

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
  return { databasePath, authentication, identity, project, agentToken, installationToken, base, endpoint, knowledgeCall, mcpClient };
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
});
