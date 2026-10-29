import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, Worktree } from "@/shared/contracts";
import type { RuntimeAction } from "@/shared/contracts/runtime-access";
import { ControlService } from "../../control-service";
import type { GitWorktreeReader } from "../../git-worktrees";
import { createMcpControllerServer } from "../../mcp-http-server";
import { IdentityService } from "../../modules/identity";
import type { ProcessManager } from "../../process-manager";
import { SqliteStateStore } from "../../sqlite-store";
import type { ProjectTestCommandResolver } from "../../test-command";

// Real SDK client, MCP session ledger, ControlService, IdentityService and SQLite.

const SENTINEL = "SENTINEL-mcp-config";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(actions: RuntimeAction[]) {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-mcp-config-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  cleanups.push(() => store.close());
  const identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = store.addProject({ name: "Config", repositoryPath: "/code/config", port: 3295, executable: "pnpm", args: ["run", "dev"] });
  store.updateProjectEnvironment(project.id, { SECRET_VALUE: SENTINEL }, "test");
  store.saveProjectEnvironmentProfile(project.id, { name: "staging", environment: { STAGING_TOKEN: SENTINEL } }, "test");
  const worktree: Worktree = { path: "/code/config", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
  const runtime: RuntimeSnapshot = {
    phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [SENTINEL],
    resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
  };
  const processes = { snapshot: () => ({ ...runtime }), start: vi.fn(), stop: vi.fn(), stopAll: vi.fn(async () => undefined) } as unknown as ProcessManager;
  const testCommands = { discover: () => [{ id: "node:test", name: "test", adapter: "node", timeoutMs: 900_000 }], resolve: vi.fn() } as unknown as ProjectTestCommandResolver;
  const service = new ControlService(store, { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader, processes, undefined,
    { resolve: vi.fn() }, undefined, undefined, testCommands, undefined, undefined, undefined, undefined, identity);
  const agent = identity.createAgent(owner);
  let revision = identity.setRuntimeDelegation({ principalId: agent.id, projectId: project.id, actions, expectedRevision: 0 }, owner).revision;
  const delegate = (next: RuntimeAction[]) => {
    revision = identity.setRuntimeDelegation({ principalId: agent.id, projectId: project.id, actions: next, expectedRevision: revision }, owner).revision;
  };
  const issued = identity.issueRuntimeCredential({ principalId: agent.id, label: "config", projects: [{ projectId: project.id, actions }] }, owner);
  const controller = createMcpControllerServer({ service, port: 0, accessToken: "installation-fixture-secret", identity });
  cleanups.push(() => controller.close());
  await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
  const endpoint = new URL(`http://127.0.0.1:${(controller.server.address() as AddressInfo).port}/mcp`);
  const connect = async () => {
    const client = new Client({ name: "scoped-config-fixture", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toMatch(/SECRET_VALUE|STAGING_TOKEN|agent:mcp:|pnpm/);
    expect(text).not.toContain(issued.token);
    return { error: Boolean(result.isError), text, value: result.isError ? null : JSON.parse(text) };
  };
  return { store, project, delegate, connect, call };
}

describe("scoped configuration MCP tools", () => {
  it("rejects unknown fields strictly and returns only allowlisted fields", async () => {
    const f = await fixture(["profiles:select", "config:write"]);
    const client = await f.connect();
    const listed = await f.call(client, "list_environment_profiles", { projectId: f.project.id });
    expect(listed.value).toEqual({ schemaVersion: 1, projectId: f.project.id, configurationRevision: 2, selectedProfile: "default", profiles: [{ name: "default" }, { name: "staging" }] });
    const configured = await f.call(client, "get_project_configuration", { projectId: f.project.id, worktreePath: "/code/config" });
    expect(configured.value).toEqual({ schemaVersion: 1, projectId: f.project.id, configurationRevision: 2, presets: [{ id: "node:test", timeoutMs: 900_000, overrideTimeoutMs: null }] });
    for (const [name, args] of [
      ["select_environment_profile", { projectId: f.project.id, name: "staging", expectedRevision: 2, idempotencyKey: "a", restart: true }],
      ["select_environment_profile", { projectId: f.project.id, name: "staging", expectedRevision: 2, idempotencyKey: "a", environment: { X: "1" } }],
      ["set_test_preset_timeout", { projectId: f.project.id, worktreePath: "/code/config", presetId: "node:test", timeoutMs: 5, expectedRevision: 2, idempotencyKey: "b", testProfile: "unit" }],
      ["list_environment_profiles", { projectId: f.project.id, includeValues: true }],
      ["get_project_configuration", { projectId: f.project.id, worktreePath: "/code/config", tls: true }],
    ] as const) {
      const refused = await f.call(client, name, args);
      expect(refused.error, refused.text).toBe(true);
    }
    expect(f.store.getProjectConfigurationRevision(f.project.id)).toBe(2);
  });

  it("replays identical requests once, conflicts on changed input or claim context, and re-authorizes replays", async () => {
    const f = await fixture(["profiles:select", "config:write"]);
    const client = await f.connect();
    const request = { projectId: f.project.id, worktreePath: "/code/config", presetId: "node:test", timeoutMs: 60_000, expectedRevision: 2, idempotencyKey: "same" };
    const first = await f.call(client, "set_test_preset_timeout", request);
    expect(first.value).toMatchObject({ outcome: "completed", configurationRevision: 3, replayed: false });
    const again = await f.call(client, "set_test_preset_timeout", request);
    expect(again.value).toEqual({ ...first.value, replayed: true });
    expect(f.store.getProjectConfigurationRevision(f.project.id)).toBe(3);
    for (const changed of [{ timeoutMs: 1 }, { expectedRevision: 3 }, { reservationId: "00000000-0000-4000-8000-000000000001" }]) {
      const conflict = await f.call(client, "set_test_preset_timeout", { ...request, ...changed });
      expect(conflict).toMatchObject({ error: true });
      expect(conflict.text).toMatch(/^idempotency_conflict:/);
    }
    // The same key cannot be reused for another operation either.
    expect((await f.call(client, "select_environment_profile", { projectId: f.project.id, name: "staging", expectedRevision: 3, idempotencyKey: "same" })).text)
      .toMatch(/^idempotency_conflict:/);
    // A retained failure is replayed as the same failure, not re-executed against the new revision.
    const stale = { projectId: f.project.id, name: "staging", expectedRevision: 2, idempotencyKey: "stale" };
    expect((await f.call(client, "select_environment_profile", stale)).text).toMatch(/^revision_conflict:/);
    expect((await f.call(client, "select_environment_profile", stale)).text).toMatch(/^revision_conflict:/);

    f.delegate(["profiles:select"]);
    const denied = await f.call(client, "set_test_preset_timeout", request);
    expect(denied.text).toMatch(/^project_access_denied:/);
    f.delegate(["config:write"]);
    expect((await f.call(client, "select_environment_profile", stale)).text).toMatch(/^project_access_denied:/);
    // Another session has its own ledger; it executes again under the changed revision.
    const second = await f.connect();
    expect((await f.call(second, "set_test_preset_timeout", request)).text).toMatch(/^revision_conflict:/);
    expect(f.store.getProject(f.project.id)!.testPresetTimeouts).toEqual({ "node:test": 60_000 });
  });

  it("refuses a claimed operation from a session that does not hold the claim", async () => {
    const f = await fixture(["claims:manage", "config:write"]);
    const holder = await f.connect();
    const claim = await f.call(holder, "claim_project", { projectId: f.project.id, worktreePath: "/code/config", reason: "config", idempotencyKey: "claim" });
    const reservationId = claim.value.reservationId as string;
    const request = { projectId: f.project.id, worktreePath: "/code/config", presetId: "node:test", timeoutMs: 5, expectedRevision: 2, idempotencyKey: "k" };
    const other = await f.connect();
    expect((await f.call(other, "set_test_preset_timeout", { ...request, reservationId })).text).toMatch(/^claim_not_owned:/);
    // Same key with a different claim context conflicts instead of silently running unclaimed.
    expect((await f.call(other, "set_test_preset_timeout", request)).text).toMatch(/^idempotency_conflict:/);
    expect((await f.call(other, "set_test_preset_timeout", { ...request, idempotencyKey: "unclaimed" })).text).toMatch(/^claim_required:/);
    expect((await f.call(holder, "set_test_preset_timeout", request)).text).toMatch(/^claim_required:/);
    expect((await f.call(holder, "set_test_preset_timeout", { ...request, idempotencyKey: "own", reservationId })).value).toMatchObject({ outcome: "completed" });
    await f.call(holder, "release_project_claim", { projectId: f.project.id, reservationId });
    // The receipt of a claimed operation is not released once that claim is gone.
    expect((await f.call(holder, "set_test_preset_timeout", { ...request, idempotencyKey: "own", reservationId })).text).toMatch(/^claim_not_owned:/);
  });
});
