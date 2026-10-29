import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, Worktree } from "@/shared/contracts";
import { ControlService } from "../../control-service";
import type { GitWorktreeReader } from "../../git-worktrees";
import { createMcpControllerServer, type McpControllerServer } from "../../mcp-http-server";
import { ManualMcpClock } from "../../modules/mcp-sessions/manual-clock";
import { IdentityService } from "../../modules/identity";
import type { ProcessManager } from "../../process-manager";
import { SqliteStateStore } from "../../sqlite-store";

// Real application service and SQLite reservations in a temporary directory,
// a fake process manager standing in for the managed fixture server, owned SDK
// clients and a manual clock that also drives Date for lease expiry.

const MINUTE = 60_000;
/** Real sockets settle asynchronously; allow for a CPU-limited verification runner. */
const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 10_000, interval: 20 });
const token = "session-lease-fixture-secret";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

describe("session cleanup and persisted leases", () => {
  it("makes an abandoned claim available within its TTL, never to another session earlier, and keeps the server running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.parse("2026-10-07T12:00:00.000Z"), now => vi.setSystemTime(now));
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-mcp-lease-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    cleanups.push(() => store.close());
    const project = store.addProject({ name: "Fixture", repositoryPath: "/code/fixture", port: 3291, executable: "pnpm", args: ["run", "dev"] });
    const worktree: Worktree = { path: "/code/fixture", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const runtime: RuntimeSnapshot = {
      phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    const start = vi.fn(async (_project: unknown, path: string) => { runtime.phase = "running"; runtime.pid = 4242; runtime.worktreePath = path; });
    const stop = vi.fn(async () => { runtime.phase = "stopped"; runtime.pid = null; runtime.worktreePath = null; });
    const stopAll = vi.fn(async () => undefined);
    const statusSummary = () => ({ phase: runtime.phase, worktreePath: runtime.worktreePath, startedAt: runtime.startedAt, failureCode: null, ownsProcess: runtime.pid !== null });
    const processes = { snapshot: () => ({ ...runtime }), statusSummary, start, stop, stopAll } as unknown as ProcessManager;
    const service = new ControlService(store, { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader, processes, undefined,
      { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });
    const cancelTest = vi.spyOn(service, "cancelTest");

    const controller: McpControllerServer = createMcpControllerServer({ service, port: 0, accessToken: token, sessionClock: clock });
    cleanups.push(() => controller.close());
    await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(controller.server.address() as AddressInfo).port}/mcp`);
    const snapshot = async () => await controller.diagnosticsSnapshot() as { logicalSessions: number; openResponses: number; claims: number; admission: { admittedSessions: number }; closeReasons: Record<string, number> };
    const connect = async () => {
      const client = new Client({ name: "owned-lease-fixture", version: "1" });
      cleanups.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      return client;
    };
    const claim = (client: Client, key: string) => client.callTool({ name: "claim_project", arguments: {
      projectId: project.id, worktreePath: worktree.path, reason: "owned lease fixture", idempotencyKey: key, responseMode: "compact",
    } });

    const first = await connect();
    const held = await claim(first, "first");
    expect(held.isError, JSON.stringify(held)).toBeFalsy();
    const firstReservation = store.getActiveReservation(project.id)!;
    expect(start).toHaveBeenCalledOnce();
    await first.close(); // abrupt client loss without DELETE

    const second = await connect();
    await poll(async () => (await snapshot()).openResponses).toBe(1); // the second client's stream
    expect((await claim(second, "early")).isError).toBe(true);

    clock.advance(10 * MINUTE); // one server renewal while the first session was recently active
    clock.advance(5 * MINUTE);
    await poll(async () => (await snapshot()).closeReasons["abandoned-transport"]).toBe(1);
    expect(store.getActiveReservation(project.id)).toMatchObject({ id: firstReservation.id, expiresAt: "2026-10-07T12:40:00.000Z" });

    clock.advance(24 * MINUTE + 59_000);
    expect((await claim(second, "still-early")).isError).toBe(true);
    clock.advance(2_000);
    const taken = await claim(second, "after-expiry");
    expect(taken.isError).toBeFalsy();
    const successor = store.getActiveReservation(project.id)!;
    expect(successor.id).not.toBe(firstReservation.id);
    expect(successor.owner).not.toBe(firstReservation.owner);

    // Session cleanup never stopped the managed server or touched tests.
    expect(runtime).toMatchObject({ phase: "running", pid: 4242, worktreePath: worktree.path });
    expect(stop).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(cancelTest).not.toHaveBeenCalled();
    expect(await snapshot()).toMatchObject({ logicalSessions: 1, claims: 1, admission: { admittedSessions: 1 } });
  });
});

describe("scoped agent claims", () => {
  it("re-authorizes every automatic renewal and stops renewing on revocation without releasing or stopping", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new ManualMcpClock(Date.parse("2026-10-07T12:00:00.000Z"), now => vi.setSystemTime(now));
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-mcp-scoped-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    cleanups.push(() => store.close());
    const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
    const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
    const project = store.addProject({ name: "Scoped", repositoryPath: "/code/scoped", port: 3292, executable: "pnpm", args: ["run", "dev"] });
    store.updateProjectEnvironment(project.id, { SECRET_VALUE: "env-sentinel" }, "test");
    const worktree: Worktree = { path: "/code/scoped", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const runtime: RuntimeSnapshot = {
      phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: ["log-sentinel"],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    const start = vi.fn(async (_project: unknown, path: string, beforeSpawn?: () => void) => { beforeSpawn?.(); runtime.phase = "running"; runtime.pid = 4343; runtime.worktreePath = path; });
    const stop = vi.fn(async () => { runtime.phase = "stopped"; runtime.pid = null; runtime.worktreePath = null; });
    const processes = { snapshot: () => ({ ...runtime }), start, stop, stopAll: vi.fn(async () => undefined) } as unknown as ProcessManager;
    const service = new ControlService(store, { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader, processes, undefined,
      { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, identity);
    const agent = identity.createAgent(owner);
    identity.setRuntimeDelegation({ principalId: agent.id, projectId: project.id, actions: ["projects:read", "claims:manage", "runtime:control"], expectedRevision: 0 }, owner);
    const issued = identity.issueRuntimeCredential({ principalId: agent.id, label: "scoped", projects: [{ projectId: project.id, actions: ["projects:read", "claims:manage", "runtime:control"] }] }, owner);
    const diagnostics: Array<[string, Record<string, unknown> | undefined]> = [];
    const controller = createMcpControllerServer({ service, port: 0, accessToken: token, identity, sessionClock: clock, onDiagnostic: (message, details) => diagnostics.push([message, details]) });
    cleanups.push(() => controller.close());
    await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
    const endpoint = new URL(`http://127.0.0.1:${(controller.server.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: "scoped-lease-fixture", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } } }));
    const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]!.text;

    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const absent of ["get_runtime_logs", "set_project_environment", "get_server_capacity", "run_test", "save_environment_profile",
      "delete_environment_profile", "save_test_environment_profile", "assign_test_preset_profile", "list_test_environment_profiles", "get_project_storage"]) {
      expect(tools).not.toContain(absent);
    }
    // Configuration tools are registered but each call requires its own separately granted action.
    for (const present of ["list_environment_profiles", "select_environment_profile", "get_project_configuration", "set_test_preset_timeout"]) {
      expect(tools).toContain(present);
    }
    expect(tools.some(name => /issue|grant|delegat|token|rotate/.test(name))).toBe(false);
    const identityView = JSON.parse(text(await client.callTool({ name: "get_identity", arguments: {} })));
    expect(identityView.runtimeAccess).toEqual([{ projectId: project.id, actions: ["projects:read", "claims:manage", "runtime:control"], expiresAt: null }]);
    const listed = await client.callTool({ name: "list_projects", arguments: {} });
    expect(text(listed)).not.toMatch(/env-sentinel|SECRET_VALUE|log-sentinel/);
    const claimed = await client.callTool({ name: "claim_project", arguments: { projectId: project.id, worktreePath: worktree.path, reason: "scoped", idempotencyKey: "scoped", start: true } });
    expect(claimed.isError, text(claimed)).toBeFalsy();
    const reservationId = JSON.parse(text(claimed)).reservationId as string;
    expect(start).toHaveBeenCalledOnce();
    const initial = store.getActiveReservation(project.id)!;
    expect(initial.expiresAt).toBe("2026-10-07T12:30:00.000Z");

    clock.advance(10 * MINUTE); // authorized renewal
    await poll(() => store.getActiveReservation(project.id)?.expiresAt).toBe("2026-10-07T12:40:00.000Z");
    identity.revokeRuntimeDelegation({ principalId: agent.id, projectId: project.id, expectedRevision: 1 }, owner);
    await client.callTool({ name: "get_identity", arguments: {} }); // keep the session active: only authority stops renewal
    clock.advance(10 * MINUTE);
    await poll(() => diagnostics.some(([message]) => message === "mcp.claim_auto_renew_failed")).toBe(true);
    expect(diagnostics.find(([message]) => message === "mcp.claim_auto_renew_failed")?.[1]?.error).toMatch(/not authorized/);
    expect(store.getActiveReservation(project.id)).toMatchObject({ id: reservationId, expiresAt: "2026-10-07T12:40:00.000Z" });
    clock.advance(10 * MINUTE);
    expect(diagnostics.filter(([message]) => message.startsWith("mcp.claim_auto_renew")).length).toBe(1);
    expect((await client.callTool({ name: "stop_project", arguments: { projectId: project.id, reservationId, idempotencyKey: "after-revoke" } })).isError).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(runtime).toMatchObject({ phase: "running", pid: 4343 });
  });
});
