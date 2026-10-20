import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createControllerServer } from "./http-server";
import { createMcpControllerServer } from "./mcp-http-server";
import { EventStream } from "./events";
import { DirectoryBrowser } from "./directory-browser";
import { leaseTokenHash } from "./modules/lifecycle";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlService } from "./control-service";
import { SystemGitWorktreeReader } from "./git-worktrees";
import { nullLogWriter } from "./log-writer";
import { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import { TestJobManager } from "./test-job-manager";
import { ProjectTestCommandResolver } from "./test-command";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(godot = true) {
  const root = mkdtempSync(join(tmpdir(), "wtc-verification-only-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repo"); mkdirSync(repository);
  execFileSync("git", ["init", "--quiet", repository]);
  if (godot) {
    writeFileSync(join(repository, "project.godot"), "config_version=5\n");
    mkdirSync(join(repository, "scripts"));
    writeFileSync(join(repository, "scripts/project.sh"), 'test "$1" = check || test "$1" = export-macos || exit 2\ntest -z "$WORKTREE_CONTROL_SERVER_URL" || exit 3\necho "verified $1"\n');
  } else writeFileSync(join(repository, "README"), "verification-only repository\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"]);
  const store = new SqliteStateStore(join(root, "state.sqlite3")); cleanup.push(() => store.close());
  const git = new SystemGitWorktreeReader();
  const processes = new ProcessManager(); cleanup.push(() => processes.stopAll());
  const start = vi.spyOn(processes, "start"), stop = vi.spyOn(processes, "stop");
  const manager = new TestJobManager(store, nullLogWriter); cleanup.push(() => manager.shutdown());
  const service = new ControlService(store, git, processes, undefined, undefined, undefined, undefined, new ProjectTestCommandResolver(), manager);
  store.setServerCapacitySettings({ enabled: true, limit: 1 });
  return { root, repository, store, service, start, stop, processes };
}

describe("verification-only application workflow", () => {
  it.each([true, false])("registers %s and refuses runtime and TLS before ownership/capacity effects", async godot => {
    const f = fixture(godot);
    const project = await f.service.addProject({ name: "Verification", repositoryPath: f.repository, port: 3210, launchPreset: godot ? "auto" : "none" });
    expect(project).toMatchObject({ launchPreset: "none", executable: "", args: [], tlsMode: "off" });
    for (const action of ["start", "restart", "switch", "stop"] as const) await expect(f.service.operate(project.id, action, f.repository)).rejects.toThrow("no managed server");
    await expect(f.service.claimProject({ projectId: project.id, worktreePath: f.repository, owner: "agent:mcp:test", reason: "verify", idempotencyKey: "claim" })).rejects.toThrow("Queue tests without a runtime claim");
    await expect(f.service.setProjectTls(project.id, { mode: "generated", keyPath: null, certPath: null, caPath: null })).rejects.toThrow("no managed server");
    expect(f.store.getActiveReservation(project.id)).toBeNull();
    expect(f.service.serverCapacity()).toMatchObject({ used: 0, available: 1, holders: [] });
    expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
    await expect(f.processes.start(f.store.getProject(project.id)!, f.repository)).rejects.toThrow("no managed server");
    // Defensive handling of a pre-existing valid claim must also fail before capacity.
    const token = "fixture-lease", owner = "agent:mcp:existing";
    const reservation = f.store.acquireReservation({ projectId: project.id, worktreePath: f.repository, kind: "agent", owner, ttlSeconds: 60, maximumLifetimeSeconds: 120, leaseTokenHash: leaseTokenHash(token), idempotencyKey: "existing" });
    for (const action of ["start", "restart"] as const) {
      expect(await f.service.operateClaimedRuntime(project.id, reservation.id, action, { owner, leaseToken: token })).toMatchObject({ outcome: "failed", error: { code: "no_managed_server" }, occupiesCapacity: false, leaseHeld: true });
    }
    expect(f.start).toHaveBeenCalledTimes(1); // The direct defensive start above refused before spawn.
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("runs both Godot presets without a runtime claim and retains terminal source, history and metrics", async () => {
    const f = fixture();
    const project = await f.service.addProject({ name: "Godot", repositoryPath: f.repository, port: 3210 });
    const snapshot = await f.service.projectSnapshot(project.id);
    expect(snapshot.testPresets[0].presets.map(p => [p.id, p.profile])).toEqual([["godot:check", "tooling"], ["godot:export-macos", "tooling"]]);
    const actor = { owner: "agent:mcp:verify" };
    for (const preset of ["godot:check", "godot:export-macos"]) {
      const run = await f.service.enqueueTest(project.id, f.repository, preset, actor, preset);
      expect((await f.service.enqueueTest(project.id, f.repository, preset, actor, preset)).id).toBe(run.id);
      await vi.waitFor(() => expect(f.service.testRun(run.id).phase).toBe("passed"));
      expect(f.service.testRun(run.id)).toMatchObject({ adapter: "godot", executable: "bash", source: { attribution: "observed_match", processOutcome: "passed" }, environmentProfile: "tooling", telemetry: { cleanup: "confirmed" } });
    }
    const filter = { projectId: project.id, from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const history = f.service.listTestHistory(filter);
    expect(history.items).toHaveLength(2);
    expect(history.items.every(item => item.summary.presetId.startsWith("godot:"))).toBe(true);
    expect(f.service.testMetrics(filter).selection.matched).toBe(2);
    expect(f.store.getActiveReservation(project.id)).toBeNull();
    expect(f.service.serverCapacity().used).toBe(0);
    expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
    // A human pin still protects worktree isolation even when there is no runtime.
    await f.service.reserve({ projectId: project.id, worktreePath: f.repository, owner: "local-user", kind: "human" });
    await expect(f.service.enqueueTest(project.id, f.repository, "godot:check", actor)).rejects.toThrow();
  });
});


describe("verification-only HTTP/MCP handlers", () => {
  it("rejects runtime operations and claims while queueing Godot through the real MCP handlers", async () => {
    const f = fixture();
    const http = createControllerServer({ service: f.service, directoryBrowser: new DirectoryBrowser(f.root), events: new EventStream(), webRoot: f.root, host: "127.0.0.1", port: 0, accessToken: "fixture-token",
      mcpStatus: () => ({ phase: "running", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
    const mcp = createMcpControllerServer({ service: f.service, port: 0, accessToken: "fixture-token" });
    for (const controller of [http, mcp]) {
      cleanup.push(() => controller.close());
      await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
    }
    const base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Worktree-Control-Token": "fixture-token" }, body: JSON.stringify(body) });
    const added = await post("/api/projects", { name: "Godot", repositoryPath: f.repository, port: 3210, launchPreset: "none" });
    expect(added.status).toBe(201);
    const project = f.store.listProjects()[0];
    for (const operation of ["start", "restart"]) {
      const refused = await post(`/api/projects/${project.id}/operation`, { operation, worktreePath: f.repository });
      expect(refused.status).toBe(400); expect(await refused.json()).toMatchObject({ error: expect.stringContaining("no managed server") });
    }
    const tls = await post(`/api/projects/${project.id}/tls`, { mode: "generated", keyPath: null, certPath: null, caPath: null });
    expect(tls.status).toBe(400); expect(await tls.json()).toMatchObject({ error: expect.stringContaining("no managed server") });
    const client = new Client({ name: "godot-fixture", version: "1" }); cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: "Bearer fixture-token" } } }));
    const claim = await client.callTool({ name: "claim_project", arguments: { projectId: project.id, worktreePath: f.repository, reason: "fixture", idempotencyKey: "no-server-claim" } });
    expect(claim.isError).toBe(true); expect(JSON.stringify(claim.content)).toContain("no managed server");
    expect(f.store.getActiveReservation(project.id)).toBeNull();
    const presets = await client.callTool({ name: "list_test_presets", arguments: { projectId: project.id } });
    expect(JSON.stringify(presets.content)).toContain("godot:export-macos");
    const result = await client.callTool({ name: "run_test", arguments: { projectId: project.id, worktreePath: f.repository, presetId: "godot:check", idempotencyKey: "godot-run" } });
    expect(result.isError).not.toBe(true);
    const run = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    await vi.waitFor(() => expect(f.service.testRun(run.id).phase).toBe("passed"));
    const terminal = await client.callTool({ name: "get_test_run", arguments: { runId: run.id } });
    expect(JSON.parse((terminal.content as Array<{ text: string }>)[0].text)).toMatchObject({ adapter: "godot", phase: "passed", source: { attribution: "observed_match", processOutcome: "passed" } });
    expect(f.service.serverCapacity().used).toBe(0);
    expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled();
  });
});
