import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultFixture } from "./modules/dev-vault/test-fixture";
import { AuthenticationService } from "./modules/authentication";
import { ControlService } from "./control-service";
import { ProcessManager } from "./process-manager";
import { createControllerServer } from "./http-server";
import { createMcpControllerServer } from "./mcp-http-server";
import { EventStream } from "./events";
import type { DirectoryBrowser } from "./directory-browser";
import { runDevVaultCommand } from "../cli/dev-vault";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = vaultFixture(); cleanups.push(() => f.close());
  const authentication = new AuthenticationService(f.store);
  const installationToken = authentication.generateToken("fixture").token;
  const events = new EventStream(); cleanups.push(() => events.close());
  const service = new ControlService(f.store, { list: vi.fn(() => { throw new Error("Vault must not inspect or run source"); }) } as never, new ProcessManager());
  const web = createControllerServer({ service, identity: f.identity, authentication, devVault: f.vault, events,
    directoryBrowser: {} as DirectoryBrowser, webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "legacy-pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
  const mcp = createMcpControllerServer({ service, identity: f.identity, authentication, devVault: f.vault, port: 0, accessToken: "legacy-mcp" });
  for (const controller of [web, mcp]) { await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve)); cleanups.push(() => controller.close()); }
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`);
  const call = (body: unknown, token?: string) => fetch(`${base}/api/dev-vault`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { f, authentication, installationToken, base, endpoint, call };
}

describe("vault HTTP, MCP and CLI", () => {
  it("denies owner-token-only, installation/open authority and requester role claims", async () => {
    const { f, call, authentication, installationToken } = await setup();
    const cmd = f.command({ operation: "list" });
    for (const token of [f.ownerToken, installationToken, undefined]) {
      const response = await call({ command: cmd }, token); expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const spoof = await call({ command: { ...cmd, role: "owner" } }, f.first.token);
    expect(spoof.status).toBe(400);
    authentication.setMode("open", "fixture");
    expect((await call({ command: cmd, proof: f.proof(cmd) }, f.ownerToken)).status).toBe(403);
  });
  it("returns plaintext only for signed owner reads or the exact authorized agent read, with no cache", async () => {
    const { f, call } = await setup();
    const grant = f.approve(f.request("read"));
    const cmd = f.command({ operation: "read", ...f.imported, grantId: grant.id });
    const denied = await call({ command: cmd }, f.second.token);
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("FAKE_DEV_KEY_NAME");
    const allowed = await call({ command: cmd }, f.first.token);
    expect(allowed.status).toBe(200); expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(await allowed.json()).toMatchObject({ result: { environment: { FAKE_DEV_KEY_NAME: "FAKE_DEV_ONLY_VALUE_987654321" } } });
    const malformed = await call({ command: { ...cmd, operation: "FAKE_SECRET_IN_OPERATION" } }, f.first.token);
    expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain("FAKE_SECRET_IN_OPERATION");
  });
  it("shares request/write/owner denial through MCP without exposing stored values", async () => {
    const { f, endpoint } = await setup();
    const client = new Client({ name: "vault-fixture", version: "1" });
    const cacheHeaders: Array<string | null> = [];
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${f.first.token}` } },
      fetch: async (input, init) => { const response = await fetch(input, init); if (response.headers.get("content-type")?.includes("application/json")) cacheHeaders.push(response.headers.get("cache-control")); return response; } }));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools.some(t => t.name === "dev_vault")).toBe(true);
    const request = f.command({ operation: "request", ...f.imported, permission: "write", source: "inline-dotenv", dotenv: "NEW_FAKE_NAME=NEW_FAKE_VALUE" });
    const response = await client.callTool({ name: "dev_vault", arguments: { command: request } });
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response)).not.toContain("NEW_FAKE_NAME");
    const content = response.content as Array<{ text: string }>;
    const r = JSON.parse(content[0].text).result as { id: string; revision: number };
    const selfApproval = await client.callTool({ name: "dev_vault", arguments: { command: f.command({ operation: "approve", requestId: r.id, revision: 1, lifetime: "once" }) } });
    expect(selfApproval.isError).toBe(true);
    const grant = f.approve(r);
    const written = await client.callTool({ name: "dev_vault", arguments: { command: f.command({ operation: "write", grantId: grant.id }) } });
    expect(written.isError).not.toBe(true); expect(JSON.stringify(written)).not.toContain("FAKE_DEV_ONLY_VALUE");
    expect(JSON.stringify(written)).not.toContain("NEW_FAKE");
    const malformed = await client.callTool({ name: "dev_vault", arguments: { command: { ...request, FAKE_SECRET_FIELD: "fake" } } });
    expect(malformed.isError).toBe(true); expect(JSON.stringify(malformed)).not.toContain("FAKE_SECRET_FIELD");
    expect(cacheHeaders.length).toBeGreaterThan(0);
    expect(cacheHeaders.every(value => value === "no-store")).toBe(true);
  });
  it("allows signed CLI administration over the same application boundary and rejects token-only access", async () => {
    const { f, base } = await setup();
    const output: string[] = [], warnings: string[] = [];
    const cmd = f.command({ operation: "list" });
    const dependencies = (input: unknown) => ({ environment: { WORKTREE_CONTROL_DEV_VAULT_TOKEN: f.ownerToken },
      input: (async function* () { yield JSON.stringify(input); })(), write: (line: string) => output.push(line), warn: (line: string) => warnings.push(line) });
    await runDevVaultCommand(["--endpoint", base], dependencies({ command: cmd, proof: f.proof(cmd) }));
    expect(JSON.parse(output[0]).result).toMatchObject({ profiles: [{ profileId: f.imported.profileId }], useAvailable: false });
    expect(warnings[0]).toContain("DEV credentials only");
    await expect(runDevVaultCommand(["--endpoint", base], dependencies({ command: cmd }))).rejects.toThrow("DEV vault request failed");
    expect(output).toHaveLength(1);
  });
});
