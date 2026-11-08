import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpControllerServer } from "../../mcp-http-server";
import { diagnosticsFixture, cleanup } from "../../modules/status/scoped-diagnostics-fixture";

afterEach(async () => { for (const close of [...network.splice(0).reverse(), ...cleanup.splice(0).reverse()]) await close(); });
const network: Array<() => void | Promise<void>> = [];
async function fixture(actions?: Parameters<typeof diagnosticsFixture>[0]) {
  const f = diagnosticsFixture(actions);
  const server = createMcpControllerServer({ service: f.service, port: 0, accessToken: "old-shared-secret", identity: f.identity,
    authentication: { mode: () => "better-auth", authenticateInstallation: () => null, anonymousInstallation: () => null } });
  network.push(() => server.close());
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${(server.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "diagnostic-agent", version: "1" }); network.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${f.issued.token}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { ...f, client, call, url };
}
describe("RBAC diagnostic MCP surface", () => {
  it("advertises and executes independent explicit rights with safe resources and rejects downgrade on the existing session", async () => {
    const f = await fixture();
    const names = (await f.client.listTools()).tools.map(tool => tool.name);
    for (const name of ["get_runtime_logs", "get_test_run_logs", "get_project_storage", "get_server_capacity", "get_test_queue"]) expect(names).toContain(name);
    const logs = await f.call("get_runtime_logs", { projectId: f.project.id });
    expect(logs.isError).toBeFalsy(); expect(JSON.stringify(logs)).not.toContain(f.issued.token);
    const resource = await f.client.readResource({ uri: "worktree-switcher://capacity" });
    expect(JSON.stringify(resource)).not.toMatch(/holders|Secret foreign|agent:mcp:/);
    expect((await f.call("get_runtime_logs", { projectId: f.foreign.id })).isError).toBe(true);
    expect((await f.call("get_test_run_logs", { runId: "00000000-0000-4000-8000-000000000000" })).isError).toBe(true);
    f.grant(["projects:read"]);
    expect((await f.call("get_runtime_logs", { projectId: f.project.id })).isError).toBe(true);
    await expect(f.client.readResource({ uri: "worktree-switcher://capacity" })).rejects.toThrow();
  });
  it("does not advertise diagnostic tools for an old project-read credential, even after a broader delegation", async () => {
    const f = await fixture(["projects:read"]); f.grant(["projects:read", "logs:read", "capacity:read", "storage:read"]);
    const names = (await f.client.listTools()).tools.map(tool => tool.name);
    for (const name of ["get_runtime_logs", "get_project_storage", "get_server_capacity", "get_test_queue"]) expect(names).not.toContain(name);
    const denied = await fetch(f.url, { method: "POST", headers: { Authorization: `Bearer ${f.issued.token}`, "x-worktree-switcher-token": "old-shared-secret", "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
  });
});
