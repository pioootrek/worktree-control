import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaimedRuntimeReceipt, Reservation } from "@/shared/contracts";
import type { ControlService } from "../../control-service";
import { createMcpControllerServer, type McpControllerServer } from "../../mcp-http-server";
import type { McpSessionLimits } from "../../modules/mcp-sessions";
import { ManualMcpClock } from "../../modules/mcp-sessions/manual-clock";

// Owned fixtures only: an in-process loopback listener on an ephemeral port,
// SDK clients created by this file and a mocked application service. No
// production controller, data directory, session or claim is touched.

const MINUTE = 60_000;
/** Real sockets settle asynchronously; allow for a CPU-limited verification runner. */
const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 10_000, interval: 20 });
const token = "session-policy-fixture-secret";
const projectId = "09ca1e75-1f7a-4bb5-a607-a0af3a785260";
const reservationId = "a3a76c68-c531-4dc8-838a-88416746a581";
const reservation = { id: reservationId, projectId, worktreePath: "/code/web" } as Reservation;
const claimArguments = { projectId, worktreePath: "/code/web", reason: "owned policy fixture", idempotencyKey: "claim-1", responseMode: "compact" };

type Snapshot = {
  logicalSessions: number; initializingSessions: number; drainingSessions: number; openResponses: number; sseResponses: number;
  operations: number; claims: number; renewalTimers: number; lifetimeTimers: number; drainTimers: number; runtimeRetryEntries: number;
  automaticRenewals: number; renewalsSkippedByPolicy: number; truncated: number; closeReasons: Record<string, number>;
  admission: { admittedSessions: number }; sessions: Array<Record<string, unknown>>;
};
const baseline = {
  logicalSessions: 0, initializingSessions: 0, drainingSessions: 0, openResponses: 0, sseResponses: 0, operations: 0,
  claims: 0, renewalTimers: 0, lifetimeTimers: 0, drainTimers: 0, runtimeRetryEntries: 0, sessions: [], admission: { admittedSessions: 0 },
};

const controllers: McpControllerServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.allSettled(controllers.splice(0).map(controller => controller.close()));
});

type FixtureService = Record<string, ReturnType<typeof vi.fn>>;

function fixtureService(overrides: FixtureService = {}): FixtureService {
  return {
    claimProject: vi.fn(async () => ({ reservation, leaseToken: "owned-policy-lease-secret", snapshot: null, operationError: null, operationErrorCode: null })),
    compactProjectStatus: vi.fn(() => ({ status: { projectId } })),
    renewAgentClaim: vi.fn(() => reservation),
    releaseAgentClaim: vi.fn(async () => undefined),
    serverCapacity: vi.fn(() => ({ enabled: false, limit: 0, used: 0, available: 0, holders: [] })),
    stopProject: vi.fn(),
    cancelTest: vi.fn(),
    ...overrides,
  };
}

async function listen(service: FixtureService, limits: Partial<McpSessionLimits> = {}, identity?: Parameters<typeof createMcpControllerServer>[0]["identity"]) {
  const clock = new ManualMcpClock();
  const controller = createMcpControllerServer({
    service: service as unknown as ControlService, port: 0, accessToken: token, sessionLimits: limits, sessionClock: clock, identity,
  });
  controllers.push(controller);
  await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
  const endpoint = new URL(`http://127.0.0.1:${(controller.server.address() as AddressInfo).port}/mcp`);
  const snapshot = async () => await controller.diagnosticsSnapshot() as Snapshot;
  return { controller, endpoint, clock, snapshot };
}

async function connect(endpoint: URL, options: { bearer?: string; sessionId?: string } = {}) {
  const transport = new StreamableHTTPClientTransport(endpoint, {
    sessionId: options.sessionId,
    requestInit: { headers: { Authorization: `Bearer ${options.bearer ?? token}` } },
    reconnectionOptions: { maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  });
  const client = new Client({ name: "owned-policy-fixture", version: "1" });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

/** A raw standalone SSE stream, so tests control exactly when the transport is open. */
async function openStream(endpoint: URL, sessionId: string) {
  const abort = new AbortController();
  const response = await fetch(endpoint, {
    method: "GET", signal: abort.signal,
    headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", "Mcp-Session-Id": sessionId },
  });
  return { status: response.status, close: () => abort.abort() };
}

function initialize(endpoint: URL, bearer = token) {
  return fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "owned-flood-fixture", version: "1" } } }),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const receipt = (action: string): ClaimedRuntimeReceipt => ({
  schemaVersion: 1, operationId: "owned-operation", action, projectId, reservationId, outcome: "completed", replayed: false,
  observedAt: "2026-10-07T12:00:00.000Z", port: 3000, claimedWorktreePath: "/code/web",
  runtime: { phase: "running", worktreePath: "/code/web", startedAt: "2026-10-07T12:00:00.000Z" },
  error: null, leaseHeld: true, occupiesCapacity: true, capacity: { enabled: true, limit: 2, used: 1, available: 1 },
} as ClaimedRuntimeReceipt);

describe("claim renewal policy", () => {
  it("stops renewing after abrupt client loss without DELETE and returns every counter to baseline", async () => {
    const service = fixtureService();
    const { endpoint, clock, snapshot } = await listen(service);
    const { client } = await connect(endpoint);
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    await client.callTool({ name: "claim_project", arguments: claimArguments });
    expect(await snapshot()).toMatchObject({ claims: 1, renewalTimers: 1 });

    await client.close(); // the process vanishes: no DELETE
    await poll(async () => (await snapshot()).openResponses).toBe(0);
    clock.advance(10 * MINUTE);
    expect(service.renewAgentClaim).toHaveBeenCalledOnce(); // still within the 15-minute idle limit
    expect((await snapshot()).sessions[0]).toMatchObject({ transportPhase: "interrupted", renewalPolicyState: "renewing", closeDueReason: "abandoned-transport" });

    clock.advance(5 * MINUTE);
    await poll(async () => (await snapshot()).logicalSessions).toBe(0);
    expect(await snapshot()).toMatchObject({ ...baseline, closeReasons: { "abandoned-transport": 1 } });
    clock.advance(8 * 60 * MINUTE);
    // No later renewal, no early release: the lease keeps its remaining TTL.
    expect(service.renewAgentClaim).toHaveBeenCalledOnce();
    expect(service.releaseAgentClaim).not.toHaveBeenCalled();
    expect(clock.pendingTimers).toBe(0);
  });

  it("stops renewal of an idle open session without releasing the claim, resumes on activity, and expires the session", async () => {
    const service = fixtureService();
    const { endpoint, clock, snapshot } = await listen(service);
    const { client } = await connect(endpoint);
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    await client.callTool({ name: "claim_project", arguments: claimArguments });
    clock.advance(10 * MINUTE);
    clock.advance(10 * MINUTE);
    expect(service.renewAgentClaim).toHaveBeenCalledOnce();
    expect(await snapshot()).toMatchObject({ logicalSessions: 1, claims: 1, renewalTimers: 0, renewalsSkippedByPolicy: 1 });
    expect((await snapshot()).sessions[0]).toMatchObject({ renewalPolicyState: "stopped-idle", renewalsSkippedByPolicy: 1, transportPhase: "open" });
    expect(service.releaseAgentClaim).not.toHaveBeenCalled();

    await client.callTool({ name: "get_server_capacity", arguments: {} });
    clock.advance(0);
    expect(service.renewAgentClaim).toHaveBeenCalledTimes(2);
    expect((await snapshot()).sessions[0]).toMatchObject({ renewalPolicyState: "renewing", renewalTimers: 1 });

    // An open SSE stream alone does not keep the session: 60 idle minutes close it.
    clock.advance(60 * MINUTE);
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(0);
    expect(await snapshot()).toMatchObject({ ...baseline, renewalsSkippedByPolicy: 2, closeReasons: { "idle-expired": 1 } });
    expect(service.renewAgentClaim).toHaveBeenCalledTimes(3);
    expect(service.releaseAgentClaim).not.toHaveBeenCalled();
  });

  it("keeps everything during normal idle gaps below the limits", async () => {
    const service = fixtureService();
    const { endpoint, clock, snapshot } = await listen(service);
    const holder = await connect(endpoint);
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    await holder.client.callTool({ name: "claim_project", arguments: claimArguments });
    await connect(endpoint); // a second, never-used session with its own open stream
    await poll(async () => (await snapshot()).sseResponses).toBe(2);
    for (let gap = 0; gap < 4; gap += 1) {
      clock.advance(14 * MINUTE);
      await holder.client.callTool({ name: "get_server_capacity", arguments: {} });
    }
    clock.advance(3 * MINUTE);
    // 59 minutes: the never-used open session is still inside its 60-minute budget.
    expect(await snapshot()).toMatchObject({ logicalSessions: 2, claims: 1, renewalTimers: 1, renewalsSkippedByPolicy: 0, closeReasons: { "idle-expired": 0, "abandoned-transport": 0 } });
    expect(service.renewAgentClaim).toHaveBeenCalledTimes(5);
    expect((await snapshot()).sessions.map(entry => entry.renewalPolicyState)).toEqual(["renewing", "none"]);
  });
});

describe("abandoned session cleanup", () => {
  it("keeps a session and its claim across a reconnect within grace", async () => {
    const service = fixtureService();
    const { endpoint, clock, snapshot } = await listen(service);
    const { client, transport } = await connect(endpoint);
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    await client.callTool({ name: "claim_project", arguments: claimArguments });
    const sessionId = transport.sessionId!;
    await client.close();
    await poll(async () => (await snapshot()).openResponses).toBe(0);
    clock.advance(30_000);
    const stream = await openStream(endpoint, sessionId);
    expect(stream.status).toBe(200);
    const resumed = await connect(endpoint, { sessionId });
    await resumed.client.callTool({ name: "get_server_capacity", arguments: {} });
    clock.advance(14 * MINUTE);
    expect(await snapshot()).toMatchObject({ logicalSessions: 1, claims: 1, renewalTimers: 1, closeReasons: { "abandoned-transport": 0 } });
    expect(service.renewAgentClaim).toHaveBeenCalledOnce();
    expect(service.claimProject).toHaveBeenCalledOnce();
    stream.close();
  });

  it("closes a never-active session one non-repeating grace after its transport ends", async () => {
    const { endpoint, clock, snapshot } = await listen(fixtureService());
    const { client, transport } = await connect(endpoint);
    await client.listTools(); // discovery does not count as activity
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    const sessionId = transport.sessionId!;
    await client.close();
    await poll(async () => (await snapshot()).openResponses).toBe(0);
    clock.advance(30_000);
    const stream = await openStream(endpoint, sessionId);
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    clock.advance(10_000);
    stream.close();
    await poll(async () => (await snapshot()).openResponses).toBe(0);
    clock.advance(19_999);
    expect((await snapshot()).logicalSessions).toBe(1);
    clock.advance(1);
    await poll(async () => (await snapshot()).logicalSessions).toBe(0);
    expect(await snapshot()).toMatchObject({ ...baseline, closeReasons: { "abandoned-transport": 1 } });
  });

  it("cleans up DELETE, failed initialize, repeated policy close, absolute lifetime and shutdown idempotently", async () => {
    const service = fixtureService();
    const { controller, endpoint, clock, snapshot } = await listen(service, { openSessionIdleMs: 9 * 60 * MINUTE });

    const deleted = await connect(endpoint);
    await deleted.client.callTool({ name: "claim_project", arguments: claimArguments });
    await deleted.transport.terminateSession();
    await poll(async () => (await snapshot()).logicalSessions).toBe(0);
    expect(await snapshot()).toMatchObject({ ...baseline, closeReasons: { "client-delete": 1 } });

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "owned-rejected", version: "1" } } }),
    });
    expect(rejected.status).toBe(406);
    await rejected.text();
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(0);

    await connect(endpoint);
    await connect(endpoint);
    await controller.closeSessions();
    await controller.closeSessions();
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(0);

    const aged = await connect(endpoint);
    await poll(async () => (await snapshot()).sseResponses).toBe(1);
    for (let hour = 0; hour < 8; hour += 1) {
      clock.advance(59 * MINUTE);
      if (hour < 7) await aged.client.callTool({ name: "get_server_capacity", arguments: {} });
    }
    clock.advance(8 * MINUTE);
    await poll(async () => (await snapshot()).logicalSessions).toBe(0);

    const last = await connect(endpoint);
    await last.client.callTool({ name: "claim_project", arguments: claimArguments });
    await controller.close();
    await controller.close();
    expect(await snapshot()).toMatchObject({
      ...baseline,
      closeReasons: { "client-delete": 1, "initialization-failed": 1, "authentication-policy": 2, "absolute-lifetime": 1, "controller-shutdown": 1, "idle-expired": 0 },
    });
    expect(clock.pendingTimers).toBe(0);
    expect(service.releaseAgentClaim).not.toHaveBeenCalled();
  });
});

describe("draining", () => {
  it("keeps the real outcome of a call racing expiry and refuses new work", async () => {
    const finish = deferred();
    const service = fixtureService({ operateClaimedRuntime: vi.fn(async (_p: string, _r: string, action: string) => { await finish.promise; return receipt(action); }) });
    const { endpoint, clock, snapshot } = await listen(service);
    const { client, transport } = await connect(endpoint);
    await client.callTool({ name: "claim_project", arguments: claimArguments });
    const call = client.callTool({ name: "restart_project", arguments: { projectId, reservationId, idempotencyKey: "restart-1" } });
    await poll(async () => (await snapshot()).operations).toBe(1);

    clock.advance(60 * MINUTE);
    expect(await snapshot()).toMatchObject({ logicalSessions: 0, drainingSessions: 1, operations: 1, drainTimers: 1, claims: 0, renewalTimers: 0, closeReasons: { "idle-expired": 1 } });
    const refused = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": transport.sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "get_server_capacity", arguments: {} } }),
    });
    expect(refused.status).toBe(404);
    expect(service.serverCapacity).not.toHaveBeenCalled();

    finish.resolve();
    const result = await call as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ outcome: "completed", replayed: false, action: "restart" });
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(0);
    expect(await snapshot()).toMatchObject(baseline);
    expect(service.operateClaimedRuntime).toHaveBeenCalledOnce();
  });

  it("reports an unknown outcome after the drain bound and never replays the write", async () => {
    const finish = deferred();
    const service = fixtureService({ operateClaimedRuntime: vi.fn(async (_p: string, _r: string, action: string) => { await finish.promise; return receipt(action); }) });
    const { endpoint, clock, snapshot } = await listen(service);
    const { client } = await connect(endpoint);
    await client.callTool({ name: "claim_project", arguments: claimArguments });
    const call = client.callTool({ name: "start_project", arguments: { projectId, reservationId, idempotencyKey: "start-1" } }).then(
      value => ({ value }), (error: unknown) => ({ error: String(error) }),
    );
    await poll(async () => (await snapshot()).operations).toBe(1);
    clock.advance(60 * MINUTE);
    clock.advance(120_000);
    expect(await call).toMatchObject({ error: expect.stringContaining("outcome is unknown") });
    // The accepted operation is still running and still counted.
    expect(await snapshot()).toMatchObject({ logicalSessions: 0, drainingSessions: 1, operations: 1, runtimeRetryEntries: 1, admission: { admittedSessions: 1 } });

    finish.resolve();
    await poll(async () => (await snapshot()).operations).toBe(0);
    expect(await snapshot()).toMatchObject(baseline);
    const retry = await connect(endpoint);
    const replay = await retry.client.callTool({ name: "start_project", arguments: { projectId, reservationId, idempotencyKey: "start-1" } });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay)).toContain("does not own the requested claim");
    expect(service.operateClaimedRuntime).toHaveBeenCalledOnce();
  });

  it("never stops a managed server or cancels an accepted test job when sessions close", async () => {
    const service = fixtureService({
      enqueueTest: vi.fn(async () => ({ id: "f70af07d-d065-41a7-8918-c61ca5a2b833", phase: "queued" })),
    });
    const { controller, endpoint, clock, snapshot } = await listen(service);
    const tester = await connect(endpoint);
    await tester.client.callTool({ name: "claim_project", arguments: claimArguments });
    await tester.client.callTool({ name: "run_test", arguments: { projectId, worktreePath: "/code/web", presetId: "node:test", idempotencyKey: "job-1" } });
    await tester.client.close();
    clock.advance(16 * MINUTE);
    await connect(endpoint);
    clock.advance(61 * MINUTE);
    await connect(endpoint);
    await controller.closeSessions();
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(0);
    expect(await snapshot()).toMatchObject({ closeReasons: { "abandoned-transport": 1, "idle-expired": 1, "authentication-policy": 1 } });
    for (const method of ["stopProject", "cancelTest", "releaseAgentClaim"] as const) expect(service[method]).not.toHaveBeenCalled();
    expect(service.enqueueTest).toHaveBeenCalledOnce();
  });
});

describe("session admission", () => {
  it("refuses excess initialize predictably for one shared credential and restores capacity after cleanup", async () => {
    const service = fixtureService();
    const { endpoint, snapshot } = await listen(service, { maxSessions: 4, maxSessionsPerCredential: 2 });
    const first = await connect(endpoint);
    await connect(endpoint);
    const refused = await initialize(endpoint);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("mcp-session-id")).toBeNull();
    expect(await refused.json()).toMatchObject({ id: 1, error: { message: expect.stringContaining("per-credential limit 2"), data: { reason: "admission-refused", scope: "credential", limit: 2 } } });
    // Established sessions keep working.
    expect((await first.client.callTool({ name: "get_server_capacity", arguments: {} })).isError).toBeFalsy();
    expect(await snapshot()).toMatchObject({ logicalSessions: 2, initializingSessions: 0, admission: { admittedSessions: 2 }, closeReasons: { "admission-refused": 1 } });

    await first.transport.terminateSession();
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(1);
    await connect(endpoint);
    expect(await snapshot()).toMatchObject({ logicalSessions: 2, closeReasons: { "admission-refused": 1 } });
  });

  it("applies the global bound across several credentials", async () => {
    const credentials: Record<string, string> = { "scoped-a": "credential-a", "scoped-b": "credential-b", "scoped-c": "credential-c" };
    const identity = {
      authenticateBearer: vi.fn((bearer: string) => {
        if (!credentials[bearer]) throw new Error("invalid credential");
        return { principalId: bearer, principalKind: "agent" as const, credentialId: credentials[bearer]!, authenticationMethod: "agent_token" as const };
      }),
      describeIdentity: vi.fn(() => { throw new Error("not used"); }),
    };
    const { endpoint, snapshot } = await listen(fixtureService(), { maxSessions: 3, maxSessionsPerCredential: 2 }, identity);
    const a = await connect(endpoint, { bearer: "scoped-a" });
    await connect(endpoint, { bearer: "scoped-a" });
    expect((await initialize(endpoint, "scoped-a")).status).toBe(503);
    await connect(endpoint, { bearer: "scoped-b" });
    const global = await initialize(endpoint, "scoped-c");
    expect(global.status).toBe(503);
    expect(await global.json()).toMatchObject({ error: { data: { scope: "global", limit: 3 } } });
    await a.transport.terminateSession();
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(2);
    await connect(endpoint, { bearer: "scoped-c" });
    expect(await snapshot()).toMatchObject({ logicalSessions: 3, admission: { credentials: 3 }, closeReasons: { "admission-refused": 2 } });
  });

  it("counts initializing and draining sessions until their accepted work settles", async () => {
    const finish = deferred();
    const service = fixtureService({ serverCapacity: vi.fn(async () => { await finish.promise; return {}; }) });
    const { endpoint, clock, snapshot } = await listen(service, { maxSessions: 2, maxSessionsPerCredential: 2 });
    const busy = await connect(endpoint);
    await connect(endpoint);
    const held = busy.client.callTool({ name: "get_server_capacity", arguments: {} });
    await poll(async () => (await snapshot()).operations).toBe(1);
    clock.advance(60 * MINUTE);
    // The idle session closes completely; the busy one drains its accepted call
    // and still holds an admission slot.
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(1);
    expect(await snapshot()).toMatchObject({ logicalSessions: 0, drainingSessions: 1, operations: 1 });
    await connect(endpoint);
    expect((await initialize(endpoint)).status).toBe(503);
    finish.resolve();
    expect((await held).isError).toBeFalsy();
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(1);
    await connect(endpoint);
    expect(await snapshot()).toMatchObject({ logicalSessions: 2, closeReasons: { "admission-refused": 1, "idle-expired": 2 } });
  });

  it("returns to baseline after bounded repeated connect, disconnect and crash cycles", async () => {
    const service = fixtureService();
    const { endpoint, clock, snapshot } = await listen(service, { maxSessions: 8, maxSessionsPerCredential: 8 });
    for (let cycle = 0; cycle < 24; cycle += 1) {
      const { client, transport } = await connect(endpoint);
      await poll(async () => (await snapshot()).sseResponses).toBe(1);
      if (cycle % 3 !== 2) await client.callTool({ name: "claim_project", arguments: { ...claimArguments, idempotencyKey: `claim-${cycle}` } });
      if (cycle % 3 === 0) await transport.terminateSession();
      await client.close(); // otherwise an abrupt exit without DELETE
      await poll(async () => (await snapshot()).openResponses).toBe(0);
      clock.advance(5 * MINUTE);
      expect((await snapshot()).admission.admittedSessions).toBeLessThanOrEqual(4);
    }
    clock.advance(16 * MINUTE);
    await poll(async () => (await snapshot()).admission.admittedSessions).toBe(0);
    const final = await snapshot();
    expect(final).toMatchObject(baseline);
    expect(final.closeReasons).toMatchObject({ "client-delete": 8, "abandoned-transport": 16, "admission-refused": 0 });
    expect(clock.pendingTimers).toBe(0);
  });
});
