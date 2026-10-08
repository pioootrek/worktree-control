import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "./sqlite-store";
import { AuthenticationService } from "./modules/authentication";
import { IdentityService } from "./modules/identity";
import { EventStream } from "./events";
import { createControllerServer } from "./http-server";
import { createMcpControllerServer } from "./mcp-http-server";
import { mcpDiagnosticsAdminHandler } from "./mcp-diagnostics-admin";
import type { ControlService } from "./control-service";
import type { DirectoryBrowser } from "./directory-browser";
import type { McpDiagnosticsResponse } from "@/shared/contracts/mcp-diagnostics";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(mode: "token" | "legacy" | "open" = "token", publicOrigin?: string) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-diagnostics-http-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  cleanups.push(() => store.close());
  const authentication = new AuthenticationService(store);
  let identityNow = Date.now();
  const identity = new IdentityService(store, () => new Date(identityNow).toISOString(), undefined, undefined, authentication);
  const ownerToken = identity.bootstrapOwnerSession().token;
  const owner = identity.authenticateBearer(ownerToken);
  const agent = identity.createAgent(owner);
  const issuedAgent = identity.issueAgentToken({ principalId: agent.id, label: "test reader" }, owner);
  // The worker issuance API belongs to a later workflow; populate a valid persisted worker credential.
  const worker = { id: "test-worker", kind: "worker" as const, status: "active" as const };
  store.savePrincipal(worker, owner.principalId);
  const agentRecord = store.getCredentialForAuthentication(issuedAgent.credential.id)!;
  const workerCredentialId = randomUUID();
  const workerToken = `wts_${workerCredentialId}_${randomBytes(32).toString("hex")}`;
  store.saveCredential({ ...agentRecord, id: workerCredentialId, principalId: worker.id, kind: "worker_token", tokenPrefix: `wts_${workerCredentialId}`,
    verifierHash: createHash("sha256").update(workerToken).digest("hex"),
  }, owner.principalId);
  const agentToken = issuedAgent.token;
  const installationToken = authentication.generateToken("test").token;
  if (mode === "legacy") store.saveAuthenticationPolicy({ ...store.getAuthenticationPolicy(), mode: "legacy" }, "test", "test");
  else authentication.setMode(mode, "test");
  const waits = { waiters: 2, waiterTimers: 2, targets: 1, samplerTimers: 1 };
  const service = { statusWaitDiagnostics: (sessionKey?: string) => sessionKey ? { waiters: 1, waiterTimers: 1 } : waits } as unknown as ControlService;
  const mcp = createMcpControllerServer({ service, identity, authentication, accessToken: "mcp-pairing", port: 0 });
  cleanups.push(() => mcp.close());
  let reads = 0;
  const read = async (): Promise<McpDiagnosticsResponse> => { reads++; return { mcp: await mcp.diagnosticsSnapshot(), status: "enabled", statusWaits: waits }; };
  const web = createControllerServer({ service, identity, authentication, events: new EventStream(), directoryBrowser: {} as DirectoryBrowser,
    mcpDiagnostics: read, mcpStatus: () => ({ phase: "running", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
    accessToken: "pairing", host: "127.0.0.1", port: 0, webRoot: directory, publicOrigin,
  });
  await new Promise<void>(resolve => web.server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => web.close());
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const get = (headers: Record<string, string> = {}, method = "GET") => fetch(`${base}/api/mcp/diagnostics`, { headers, method });
  const connect = async () => {
    await new Promise<void>(resolve => mcp.server.listen(0, "127.0.0.1", resolve));
    const client = new Client({ name: "private-test-client", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${installationToken}` } },
    }));
  };
  return { get, read, readCount: () => reads, advanceTime: (ms: number) => { identityNow += ms; }, connect, authentication, identity, store, owner, ownerToken, agentToken, workerToken, installationToken, base };
}

describe("owner MCP diagnostics HTTP read", () => {
  it("returns the same bounded read as the owner CLI for installation and owner-session authority", async () => {
    const f = await fixture();
    await f.connect();
    await expect.poll(async () => {
      const snapshot = (await f.read()).mcp!;
      return { logicalSessions: snapshot.logicalSessions, sseResponses: snapshot.sseResponses };
    }).toEqual({ logicalSessions: 1, sseResponses: 1 });
    const cli = await mcpDiagnosticsAdminHandler(f.read)({ command: "mcp-diagnostics" }) as McpDiagnosticsResponse;
    for (const headers of <Record<string, string>[]>[{ Authorization: `Bearer ${f.ownerToken}` }, { Authorization: `Bearer ${f.installationToken}` }, { "X-Worktree-Control-Token": f.installationToken }]) {
      const response = await f.get(headers);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.json();
      // The observation time advances; every other snapshot field is the same bounded collector read.
      expect(body).toEqual({ ...cli, mcp: { ...cli.mcp, observedAt: body.mcp.observedAt, processSampleAgeMs: body.mcp.processSampleAgeMs } });
      expect(body.mcp.sessions).toHaveLength(1);
      expect(body.mcp.sessions.length).toBeLessThanOrEqual(32);
      expect(body.mcp.sessions[0]).toMatchObject({ label: 1, agentState: "unknown", lastQualifyingActivityAt: null, renewalPolicyState: "none" });
      expect(JSON.stringify(body)).not.toMatch(/wts_|wsi_|"verifier(?:Hash)?"|"leaseToken"|"sessionId"|private-test-client/);
    }
  });
  it.each(["token", "legacy"] as const)("rejects valid agents and workers with 403 in %s mode", async mode => {
    const f = await fixture(mode);
    for (const token of [f.agentToken, f.workerToken]) expect((await f.get({ Authorization: `Bearer ${token}` })).status).toBe(403);
    expect(f.readCount()).toBe(0);
  });
  it("rejects missing, invalid, expired, revoked and rotated credentials with 401", async () => {
    const f = await fixture();
    for (const headers of <Record<string, string>[]>[{}, { Authorization: "Bearer invalid" }, { "X-Worktree-Control-Token": "pairing" }]) expect((await f.get(headers)).status).toBe(401);
    const expiring = f.identity.renewOwnerSession({ sessionLifetimeSeconds: 300 }, f.owner);
    f.advanceTime(300_000);
    expect((await f.get({ Authorization: `Bearer ${expiring.token}` })).status).toBe(401);
    const revoked = f.identity.renewOwnerSession({}, f.owner);
    f.identity.revokeCredential(revoked.credential.id, f.owner);
    expect((await f.get({ Authorization: `Bearer ${revoked.token}` })).status).toBe(401);
    f.authentication.rotateToken("test");
    expect((await f.get({ Authorization: `Bearer ${f.installationToken}` })).status).toBe(401);
    expect(f.readCount()).toBe(0);
  });
  it("preserves legacy dashboard pairing and owner sessions", async () => {
    const f = await fixture("legacy");
    expect((await f.get({ "X-Worktree-Control-Token": "pairing" })).status).toBe(200);
    expect((await f.get({ "X-Worktree-Switcher-Token": "pairing" })).status).toBe(200);
    expect((await f.get({ Authorization: `Bearer ${f.ownerToken}` })).status).toBe(200);
    expect((await f.get({ Authorization: `Bearer ${f.installationToken}` })).status).toBe(401);
  });
  it("preserves open mode anonymous installation authority, ignoring every bearer", async () => {
    const f = await fixture("open");
    for (const headers of <Record<string, string>[]>[{}, { Authorization: "Bearer invalid" }, { Authorization: `Bearer ${f.agentToken}` }, { Authorization: `Bearer ${f.workerToken}` }]) {
      expect((await f.get(headers)).status).toBe(200);
    }
  });
  it("checks same origin and GET-only method without reading request bodies", async () => {
    const f = await fixture("token", "https://controller.example.test");
    const headers = { Authorization: `Bearer ${f.ownerToken}` };
    expect((await f.get({ ...headers, Origin: "https://foreign.example.test" })).status).toBe(403);
    expect(f.readCount()).toBe(0);
    expect((await f.get({ ...headers, Origin: "https://controller.example.test" })).status).toBe(200);
    const response = await fetch(`${f.base}/api/mcp/diagnostics`, { method: "POST", headers, body: "{invalid-json" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await f.get(headers, "HEAD")).status).toBe(405);
    expect(f.readCount()).toBe(1);
  });
});
