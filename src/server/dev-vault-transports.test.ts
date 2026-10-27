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
import { DevVaultOperations } from "./modules/dev-vault";
import { ProjectLifecycle } from "./modules/lifecycle";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const f = vaultFixture(); cleanups.push(() => f.close());
  const authentication = new AuthenticationService(f.store);
  const installationToken = authentication.generateToken("fixture").token;
  const events = new EventStream(); cleanups.push(() => events.close());
  const diagnostics: unknown[] = [];
  const processes = new ProcessManager(), lifecycle = new ProjectLifecycle(f.store, processes);
  const service = new ControlService(f.store, { list: vi.fn(() => { throw new Error("Vault must not inspect or run source"); }) } as never,
    processes, undefined, undefined, undefined, undefined, undefined, undefined, lifecycle);
  const vault = new DevVaultOperations(f.vault, lifecycle);
  const web = createControllerServer({ service, identity: f.identity, authentication, devVault: vault, events,
    directoryBrowser: {} as DirectoryBrowser, webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "legacy-pairing",
    mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
  const mcp = createMcpControllerServer({ service, identity: f.identity, authentication, devVault: vault, port: 0, accessToken: "legacy-mcp",
    onDiagnostic: (message, details) => diagnostics.push({ message, details }) });
  for (const controller of [web, mcp]) { await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve)); cleanups.push(() => controller.close()); }
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`);
  const call = (body: unknown, token?: string) => fetch(`${base}/api/dev-vault`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { f, authentication, installationToken, base, endpoint, call, diagnostics };
}

describe("vault HTTP, MCP and CLI", () => {
  it("serializes first import behind removal, while another project's vault remains available", async () => {
    const f = vaultFixture(); cleanups.push(() => f.close());
    const processes = new ProcessManager(), lifecycle = new ProjectLifecycle(f.store, processes);
    const service = new ControlService(f.store, {} as never, processes, undefined, undefined, undefined, undefined, undefined, undefined, lifecycle);
    const vault = new DevVaultOperations(f.vault, lifecycle);
    let entered!: () => void, release!: () => void;
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(processes, "snapshot").mockReturnValue({ ...processes.snapshot(f.otherProject.id), phase: "running", worktreePath: f.otherProject.repositoryPath, pid: 12345 });
    vi.spyOn(processes, "stop").mockImplementation(async () => { entered(); await gate; });
    const removing = service.removeProject(f.otherProject.id);
    await stopping;
    const command = f.command({ operation: "import", projectId: f.otherProject.id, dotenv: "FAKE_KEY=fake" });
    const importing = vault.execute({ command, proof: f.proof(command) }, f.owner);
    const outcomes = Promise.allSettled([removing, importing]);
    try {
      const list = f.command({ operation: "list" });
      await expect(vault.execute({ command: list, proof: f.proof(list) }, f.owner)).resolves.toHaveProperty("result.profiles");
      expect(f.store.devVault.load(f.otherProject.id)).toBeNull();
    } finally { release(); await outcomes; }
    const [removed, imported] = await outcomes;
    expect(removed.status).toBe("fulfilled");
    expect(imported).toMatchObject({ status: "rejected", reason: { code: "vault_denied" } });
    expect(f.store.getProject(f.otherProject.id)).toBeNull();
    expect(f.store.devVault.load(f.otherProject.id)).toBeNull();
  });

  it("retains the running project when first import is admitted before removal", async () => {
    const f = vaultFixture(); cleanups.push(() => f.close());
    const processes = new ProcessManager(), lifecycle = new ProjectLifecycle(f.store, processes);
    const stop = vi.spyOn(processes, "stop");
    vi.spyOn(processes, "snapshot").mockReturnValue({ ...processes.snapshot(f.otherProject.id), phase: "running", worktreePath: f.otherProject.repositoryPath, pid: 12345 });
    const service = new ControlService(f.store, {} as never, processes, undefined, undefined, undefined, undefined, undefined, undefined, lifecycle);
    const vault = new DevVaultOperations(f.vault, lifecycle);
    const command = f.command({ operation: "import", projectId: f.otherProject.id, dotenv: "FAKE_KEY=fake" });
    const importing = vault.execute({ command, proof: f.proof(command) }, f.owner);
    const removing = service.removeProject(f.otherProject.id);
    const [imported, removed] = await Promise.allSettled([importing, removing]);
    expect(imported.status).toBe("fulfilled");
    expect(removed).toMatchObject({ status: "rejected", reason: { message: expect.stringContaining("encrypted DEV vault") } });
    expect(stop).not.toHaveBeenCalled();
    expect(f.store.getProject(f.otherProject.id)).not.toBeNull();
    expect(f.store.devVault.load(f.otherProject.id)).not.toBeNull();
  });

  it("rechecks proof freshness after lifecycle admission and keeps admission errors safe", async () => {
    const f = vaultFixture(); cleanups.push(() => f.close());
    const lifecycle = new ProjectLifecycle(f.store, new ProcessManager());
    const vault = new DevVaultOperations(f.vault, lifecycle);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = lifecycle.serialized(f.project.id, async () => gate);
    const command = f.command({ operation: "list" });
    const pending = vault.execute({ command, proof: f.proof(command) }, f.owner);
    const outcome = Promise.allSettled([pending]);
    f.advance(61_000);
    release(); await holding;
    expect(await outcome).toMatchObject([{ status: "rejected", reason: { code: "vault_proof_expired" } }]);
    await expect(vault.execute({ command, proof: f.proof(command) }, f.owner)).resolves.toHaveProperty("result.profiles");
    lifecycle.closeAdmission();
    await expect(vault.execute({ command, proof: f.proof(command) }, f.owner)).rejects.toThrow("vault_unavailable");
    await expect(vault.execute({ command: { ...command, FAKE_SECRET: "fake" } }, f.owner)).rejects.toThrow("vault_invalid_request");
  });

  it("rejects deleting an existing vault project before stopping its managed runtime", async () => {
    const f = vaultFixture(); cleanups.push(() => f.close());
    const processes = new ProcessManager();
    const stop = vi.spyOn(processes, "stop");
    vi.spyOn(processes, "snapshot").mockReturnValue({
      ...processes.snapshot(f.project.id), phase: "running", worktreePath: f.root, pid: 12345,
    });
    const service = new ControlService(f.store, {} as never, processes);
    const ciphertext = f.store.devVault.load(f.project.id);
    await expect(service.removeProject(f.project.id)).rejects.toThrow("encrypted DEV vault");
    expect(stop).not.toHaveBeenCalled();
    expect(f.store.getProject(f.project.id)).not.toBeNull();
    expect(f.store.devVault.load(f.project.id)).toEqual(ciphertext);
    expect(() => f.store.removeProject(f.project.id, "fixture")).toThrow("encrypted DEV vault");
  });

  it("never logs malformed JSON input fragments in MCP diagnostics", async () => {
    const { f, endpoint, diagnostics } = await setup();
    const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${f.first.token}`, "Content-Type": "application/json" }, body: "FAKE_MALFORMED_DEV_PAYLOAD" });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("FAKE_MALFORMED_DEV_PAYLOAD");
    expect(JSON.stringify(diagnostics)).not.toContain("FAKE_MALFORMED_DEV_PAYLOAD");
    expect(JSON.stringify(diagnostics)).toContain("MCP request JSON is invalid.");
  });
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
  it("returns a fixed retryable expiry code over HTTP without executing the import", async () => {
    const { f, call } = await setup();
    const command = f.command({ operation: "import", dotenv: "FAKE_EXPIRY_NAME=fake" });
    const proof = f.proof(command), before = f.store.devVault.load(f.project.id);
    f.advance(60_001);
    const response = await call({ command, proof }, f.ownerToken);
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ code: "vault_proof_expired" });
    expect(JSON.stringify(body)).not.toContain("FAKE_EXPIRY_NAME");
    expect(f.store.devVault.load(f.project.id)).toEqual(before);
    expect((await call({ command, proof: f.proof(command) }, f.ownerToken)).status).toBe(200);
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
