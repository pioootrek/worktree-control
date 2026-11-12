import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TestSourceObservation, Worktree } from "@/shared/contracts";
import type { ResolvedTestEnvironment } from "@/server/modules/environments";
import { TestRunAdministration } from "@/server/modules/verification";
import { admissionOf } from "./database-admission";
import { nullLogWriter } from "./log-writer";
import { OwnedProcessGroup } from "./owned-process-group";
import { SqliteStateStore } from "./sqlite-store";
import type { TestCommand } from "./test-command";
import { TestJobManager } from "./test-job-manager";

const SECRET = "wtc-secret-value-never-audited";
const directories: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const environment = (): ResolvedTestEnvironment => ({
  environment: { WTC_TEST_SECRET: SECRET }, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: ["WTC_TEST_SECRET"],
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wtc-run-admin-"));
  directories.push(directory);
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  const project = store.addProject({ name: "App", repositoryPath: directory, port: 3290, executable: "node", args: [] });
  const other = store.addProject({ name: "Other", repositoryPath: join(directory, "other"), port: 3291, executable: "node", args: [] });
  const manager = new TestJobManager(store, { ...nullLogWriter });
  manager.setLimit(4);
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await manager.shutdown().catch(() => undefined);
    store.close();
  });
  const administration = new TestRunAdministration({
    jobs: manager, audit: store, admission: admissionOf(store),
    operator: () => ({ kind: "local-admin-socket", uid: 1000, user: "operator" }),
  });
  const worktree = (path: string): Worktree => ({ path, head: "abcdef1", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false });
  const command = (script: string): TestCommand => ({
    preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 60_000 },
    executable: process.execPath, args: ["-e", script], cwd: directory,
  });
  const enqueue = (script: string, options: { path?: string; actor?: string; projectId?: string } = {}) => manager.enqueue({
    projectId: options.projectId ?? project.id, worktree: worktree(options.path ?? `/tmp/wtc-admin-${Math.random()}`), command: command(script),
    environment: environment(), actor: options.actor ?? "agent:mcp:original-session",
  });
  const ready = async (runId: string) => {
    let pid = 0;
    await vi.waitFor(() => {
      const line = store.getTestRun(runId)?.logs.find(value => value.startsWith("pid:"));
      expect(line).toBeTruthy();
      pid = Number(line!.slice(4));
    }, { timeout: 5_000 });
    return pid;
  };
  const audit = (runId: string) => store.listTestRunAdministration(runId, 50);
  const stop = (runId: string, extra: Partial<Parameters<TestRunAdministration["stop"]>[0]> = {}) =>
    administration.stop({ runId, reason: "agent credential rotated", waitMs: 15_000, requestId: `request-${runId}`, ...extra });
  return { directory, store, project, other, manager, administration, enqueue, ready, audit, stop, markClosed: () => { closed = true; } };
}

const LIVE = "console.log('pid:' + process.pid); setInterval(() => {}, 1000)";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Fails only the terminal write (the one carrying `finalizedAt`) of the chosen
 * runs. Reads, audit rows and every other run's writes keep working.
 */
function failFinalizationWrites(store: SqliteStateStore) {
  const original = store.saveTestRun.bind(store);
  const targets = new Set<string>();
  const state = { failures: 0 };
  vi.spyOn(store, "saveTestRun").mockImplementation((...args: Parameters<SqliteStateStore["saveTestRun"]>) => {
    const [run] = args;
    if (targets.has(run.id) && run.telemetry?.finalizedAt) {
      state.failures += 1;
      throw new Error("injected terminal write failure");
    }
    return original(...args);
  });
  return { targets, state };
}

describe("protected test run administration", () => {
  it("cancels a queued run without a spawn and confirms its durable finalization", async () => {
    const { manager, enqueue, stop, store, audit } = fixture();
    manager.setLimit(1);
    const blocker = enqueue(LIVE);
    const queued = enqueue(LIVE);
    await vi.waitFor(() => expect(store.getTestRun(blocker.id)?.phase).toBe("running"));
    expect(store.getTestRun(queued.id)?.phase).toBe("queued");

    const result = await stop(queued.id);

    expect(result).toMatchObject({ action: "cancel", outcome: "confirmed", reason: "finalized", before: { phase: "queued" },
      run: { phase: "cancelled", startedAt: null, telemetry: { cleanup: "not_required", spawnedAt: null } } });
    expect(store.getTestRun(queued.id)?.telemetry?.finalizedAt).toBeTruthy();
    // Exactly one run: the other one keeps running.
    expect(store.getTestRun(blocker.id)?.phase).toBe("running");
    expect(audit(queued.id).map(record => record.event)).toEqual(["test_run.admin_stop_result", "test_run.admin_stop_requested"]);
  });

  it("stops only the owned process group of one running run and confirms cleanup before reporting success", async () => {
    const { enqueue, ready, stop, store, audit } = fixture();
    const target = enqueue(LIVE);
    const neighbour = enqueue(LIVE);
    const [pid, neighbourPid] = [await ready(target.id), await ready(neighbour.id)];

    const result = await stop(target.id);

    expect(result).toMatchObject({ action: "cancel", outcome: "confirmed", reason: "finalized",
      run: { phase: "cancelled", telemetry: { cleanup: "confirmed", termination: "cancel" } } });
    expect(alive(pid)).toBe(false);
    expect(alive(neighbourPid)).toBe(true);
    expect(store.getTestRun(neighbour.id)?.phase).toBe("running");
    const records = audit(target.id);
    expect(records[0]).toMatchObject({ event: "test_run.admin_stop_result", action: "cancel", outcome: "confirmed", outcomeReason: "finalized",
      phaseBefore: "running", phaseAfter: "cancelled", cleanupAfter: "confirmed", reason: "agent credential rotated",
      operator: { kind: "local-admin-socket", uid: 1000, user: "operator" }, requestId: `request-${target.id}` });
    const serialized = JSON.stringify(records) + JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("original-session");
  });

  it("acts without the original session and leaves ordinary author-only cancellation unchanged", async () => {
    const { enqueue, ready, manager, stop, administration } = fixture();
    const run = enqueue(LIVE, { actor: "agent:mcp:original-session" });
    await ready(run.id);
    // The original MCP session (and its credential) is gone; a new session is not its author.
    await expect(manager.cancel(run.id, "agent:mcp:replacement-session")).rejects.toThrow("Tylko autor");
    const inspection = await administration.inspect({ runId: run.id });
    expect(inspection).toMatchObject({ found: true, run: { requesterKind: "agent" }, resolution: { state: "pending", reason: "running", stopEffect: "cancel" },
      ownership: { processGroup: "owned_live" } });
    expect(JSON.stringify(inspection)).not.toContain("original-session");
    expect(await stop(run.id)).toMatchObject({ outcome: "confirmed", run: { phase: "cancelled" } });
  });

  it.each([0, 5_000])("keeps a cancelled source preflight pending until it finishes (wait %i ms)", async waitMs => {
    const { manager, project, directory, administration, store, stop } = fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    cleanups.push(release);
    const observation = (): TestSourceObservation => ({ observedAt: new Date().toISOString(), head: "abcdef1", branch: "main",
      dirty: false, statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null });
    const observer = vi.fn(async () => { await barrier; return observation(); });
    const run = manager.enqueue({ projectId: project.id,
      worktree: { path: directory, head: "abcdef1", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false },
      command: { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 60_000 }, executable: process.execPath,
        args: ["-e", LIVE], cwd: directory }, environment: environment(), actor: "agent:mcp:original-session",
      sourceObservation: observation(), observe: observer });
    await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce());
    const stopping = stop(run.id, { waitMs });
    try {
      await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("cancelled"));
      const inspection = await administration.inspect({ runId: run.id });
      expect(inspection).toMatchObject({ ownership: { preparationActive: true },
        resolution: { state: "pending", reason: "stop_in_progress", stopEffect: "join" } });
      expect(await stop(run.id, { waitMs: 0, requestId: "request-join-preflight" }))
        .toMatchObject({ action: "join", outcome: "pending", reason: "stop_in_progress" });
      if (waitMs === 0) expect(await stopping).toMatchObject({ action: "cancel", outcome: "pending" });
      release();
      if (waitMs > 0) expect(await stopping).toMatchObject({ action: "cancel", outcome: "confirmed" });
      await vi.waitFor(async () => expect((await administration.inspect({ runId: run.id })).resolution.state).toBe("confirmed"));
      expect(store.getTestRun(run.id)).toMatchObject({ phase: "cancelled", startedAt: null,
        telemetry: { spawnedAt: null, cleanup: "not_required", finalizedAt: expect.any(String) } });
    } finally {
      release();
      await stopping;
    }
  });

  it("does not report no effect when the cancellation checkpoint fails after stop has started", async () => {
    const { enqueue, ready, store, stop, audit } = fixture();
    const run = enqueue(LIVE);
    const pid = await ready(run.id);
    const original = store.saveTestRun.bind(store);
    let rejected = false;
    vi.spyOn(store, "saveTestRun").mockImplementation((...args: Parameters<SqliteStateStore["saveTestRun"]>) => {
      if (!rejected && args[0].id === run.id && args[0].telemetry?.stopRequestedAt) {
        rejected = true;
        throw new Error("injected cancellation checkpoint failure");
      }
      return original(...args);
    });
    const result = await stop(run.id);
    expect(rejected).toBe(true);
    expect(result).toMatchObject({ action: "undetermined", outcome: "unresolved", reason: "stop_request_failed" });
    expect(audit(run.id)[0]).toMatchObject({ action: "undetermined", outcome: "unresolved", outcomeReason: "stop_request_failed" });
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 });
    expect(store.getTestRun(run.id)?.telemetry?.stopRequestedAt).toBeTruthy();
  });

  it("is idempotent on retries and lets concurrent requests share one effect", async () => {
    const { enqueue, ready, stop } = fixture();
    const run = enqueue(LIVE);
    await ready(run.id);
    const [first, second] = await Promise.all([stop(run.id), stop(run.id, { requestId: "request-concurrent" })]);
    expect([first.action, second.action].sort()).toEqual(["cancel", "join"]);
    expect(first.outcome).toBe("confirmed");
    expect(second.outcome).toBe("confirmed");
    const kill = vi.spyOn(process, "kill");
    expect(await stop(run.id)).toMatchObject({ action: "none", outcome: "confirmed", run: { phase: "cancelled" } });
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps a natural exit's result when it only retries the owned cleanup", async () => {
    const { enqueue, store, stop } = fixture();
    const groupStop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockRejectedValue(new Error("inspection unavailable"));
    const passed = enqueue("setTimeout(() => process.exit(0), 20)");
    const failed = enqueue("setTimeout(() => process.exit(3), 20)");
    await vi.waitFor(() => {
      expect(store.getTestRun(passed.id)?.telemetry?.cleanup).toBe("failed");
      expect(store.getTestRun(failed.id)?.telemetry?.cleanup).toBe("failed");
    }, { timeout: 5_000 });
    expect(store.getTestRun(passed.id)).toMatchObject({ phase: "running", exitCode: 0, finishedAt: null });
    groupStop.mockRestore();

    expect(await stop(passed.id)).toMatchObject({ action: "cleanup_retry", outcome: "confirmed",
      run: { phase: "passed", exitCode: 0, telemetry: { cleanup: "confirmed", termination: "exit" } } });
    expect(await stop(failed.id)).toMatchObject({ action: "cleanup_retry", outcome: "confirmed",
      run: { phase: "failed", exitCode: 3, telemetry: { termination: "exit" } } });
  });

  it("reports failed cleanup as unresolved, keeps the slot, and retries on request", async () => {
    const { enqueue, ready, store, manager, stop, audit } = fixture();
    const run = enqueue(LIVE);
    const pid = await ready(run.id);
    const groupStop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockRejectedValue(new Error("inspection unavailable"));

    const failed = await stop(run.id);

    expect(failed).toMatchObject({ action: "cancel", outcome: "unresolved", reason: "process_cleanup_unconfirmed",
      run: { phase: "running", finishedAt: null, telemetry: { cleanup: "failed" } } });
    expect(failed.nextStep).toContain("Repeat 'test-run stop'");
    expect(manager.status().running).toBe(1);
    expect(alive(pid)).toBe(true);
    expect(audit(run.id)[0]).toMatchObject({ outcome: "unresolved", outcomeReason: "process_cleanup_unconfirmed" });

    groupStop.mockRestore();
    expect(await stop(run.id, { requestId: "request-retry-cleanup" })).toMatchObject({ action: "cleanup_retry", outcome: "confirmed",
      run: { phase: "cancelled", telemetry: { cleanup: "confirmed" } } });
    expect(alive(pid)).toBe(false);
    expect(store.getTestRun(run.id)?.telemetry?.finalizedAt).toBeTruthy();
  });

  it("returns pending after the bounded wait and never waits forever", async () => {
    const { enqueue, ready, stop, administration } = fixture();
    const run = enqueue("process.on('SIGTERM', () => {}); console.log('pid:' + process.pid); setInterval(() => {}, 1000)");
    const pid = await ready(run.id);
    const started = Date.now();

    const result = await stop(run.id, { waitMs: 200 });

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toMatchObject({ action: "cancel", outcome: "pending", reason: "stop_in_progress" });
    await vi.waitFor(async () => expect((await administration.inspect({ runId: run.id })).resolution.state).toBe("confirmed"), { timeout: 10_000 });
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("refuses ownership after a controller restart and never signals the previous controller's process", async () => {
    const { store, enqueue, ready, audit } = fixture();
    const run = enqueue(LIVE);
    const pid = await ready(run.id);
    // A new manager on the same database models a restarted controller: it never spawned this group.
    const restarted = new TestJobManager(store, { ...nullLogWriter });
    cleanups.push(() => restarted.shutdown().catch(() => undefined));
    const administration = new TestRunAdministration({ jobs: restarted, audit: store, admission: admissionOf(store),
      operator: () => ({ kind: "local-admin-socket", uid: 1000, user: "operator" }) });
    const kill = vi.spyOn(process, "kill");

    const result = await administration.stop({ runId: run.id, reason: "orphan after restart", waitMs: 2_000, requestId: "request-restarted" });

    expect(result).toMatchObject({ action: "none", outcome: "unresolved", reason: "ownership_lost_after_restart",
      run: { phase: "interrupted", telemetry: { recoveredAt: expect.any(String) } } });
    expect(result.nextStep).toContain("will not signal a saved PID");
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    // The process (or a later process reusing its PID) is left to the operator.
    expect(alive(pid)).toBe(true);
    expect(audit(run.id)[0]).toMatchObject({ action: "none", outcome: "unresolved", outcomeReason: "ownership_lost_after_restart" });
  });

  it("keeps unconfirmed workspace disposal unresolved and the queue block in place", async () => {
    const { store, project, manager, markClosed, administration } = fixture();
    const source = (): TestSourceObservation => ({ observedAt: new Date().toISOString(), head: "abcdef1", branch: "main", dirty: false, statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null });
    const worktree: Worktree = { path: "/tmp/wtc-admin-remote", head: "abcdef1", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const command: TestCommand = { preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 5_000 }, executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: project.repositoryPath };
    const run = manager.enqueue({ projectId: project.id, worktree, command, environment: environment(), actor: "remote-worker:w1", sourceObservation: source(),
      preparation: { prepare: async () => ({ worktree, command, environment: environment(), sourceObservation: source() }), observe: async () => source(),
        dispose: async () => { throw new Error("disposal failed"); } } });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.error).toBe("workspace_cleanup_failed"), { timeout: 5_000 });
    markClosed();

    const result = await administration.stop({ runId: run.id, reason: "remote workspace stuck", waitMs: 1_000, requestId: "request-remote-1" });

    expect(result).toMatchObject({ action: "none", outcome: "unresolved", reason: "workspace_cleanup_failed", run: { phase: "interrupted" } });
    expect(manager.status().admissionBlockReason).toBe("remote_execution_cleanup_unconfirmed");
  });

  it("does not treat a missing record as quiescence and refuses a mismatched project without effect", async () => {
    const { enqueue, ready, stop, other, audit, store, administration } = fixture();
    expect(await stop("00000000-0000-4000-8000-000000000000")).toMatchObject({ action: "none", outcome: "unresolved", reason: "run_not_found", run: null });
    expect((await administration.inspect({ runId: "00000000-0000-4000-8000-000000000000" })).found).toBe(false);
    const run = enqueue(LIVE);
    const pid = await ready(run.id);
    await expect(stop(run.id, { projectId: other.id })).rejects.toMatchObject({ code: "project_mismatch" });
    await expect(administration.inspect({ runId: run.id, projectId: other.id })).rejects.toMatchObject({ code: "project_mismatch" });
    expect(alive(pid)).toBe(true);
    expect(store.getTestRun(run.id)?.phase).toBe("running");
    expect(audit(run.id)).toEqual([]);
  });

  describe("when the terminal write fails", () => {
    /** Waits until every completion, cleanup and finalization promise of the run has settled. */
    const settled = async (administration: TestRunAdministration, runId: string, state: { failures: number }) => {
      await vi.waitFor(async () => {
        expect(state.failures).toBeGreaterThan(0);
        const { ownership } = await administration.inspect({ runId });
        expect(ownership).toMatchObject({ finalizing: false, stopping: false });
      }, { timeout: 5_000 });
    };

    it("does not confirm a natural exit whose finalization was not saved, and keeps already durable runs confirmed", async () => {
      const { enqueue, store, manager, administration, stop, audit } = fixture();
      const historical = enqueue("process.exit(0)");
      await vi.waitFor(async () => expect((await administration.inspect({ runId: historical.id })).resolution.state).toBe("confirmed"), { timeout: 5_000 });
      const failing = failFinalizationWrites(store);
      const run = enqueue("setTimeout(() => process.exit(0), 50)");
      failing.targets.add(run.id);

      await settled(administration, run.id, failing.state);

      const persisted = store.getTestRun(run.id)!;
      expect(persisted.phase).toBe("running");
      expect(persisted.telemetry?.finalizedAt).toBeNull();
      const inspection = await administration.inspect({ runId: run.id });
      expect(inspection.resolution).toMatchObject({ state: "unresolved", reason: "finalization_not_durable", stopEffect: "none" });
      expect(inspection.resolution.nextStep).toContain("not durable");
      expect(inspection.durableRecord).toEqual({ write: "failed", phase: persisted.phase, cleanup: persisted.telemetry?.cleanup ?? null, finalizedAt: null });
      // The process result held in memory is reported, never rewritten.
      expect(inspection.run).toMatchObject({ phase: "passed", exitCode: 0 });
      // The slot stays held and the queue stays closed by the persistence failure.
      expect(manager.status().running).toBe(1);

      const result = await stop(run.id, { waitMs: 1_000 });
      expect(result).toMatchObject({ action: "none", outcome: "unresolved", reason: "finalization_not_durable",
        durableRecord: { write: "failed", phase: "running", finalizedAt: null } });
      expect(store.getTestRun(run.id)).toMatchObject({ phase: "running", telemetry: { finalizedAt: null } });
      expect(manager.status().running).toBe(1);
      expect(audit(run.id)[0]).toMatchObject({ event: "test_run.admin_stop_result", outcome: "unresolved", outcomeReason: "finalization_not_durable",
        persistenceAfter: "failed", durablePhaseAfter: "running" });

      // Another run's failure closes the queue, but a durably finalized run stays confirmed.
      expect((await administration.inspect({ runId: historical.id })).resolution).toMatchObject({ state: "confirmed", reason: "finalized" });
      expect(await stop(historical.id, { requestId: "request-historical" })).toMatchObject({ action: "none", outcome: "confirmed" });
    });

    it("does not confirm an administrator cancellation whose finalization was not saved", async () => {
      const { enqueue, ready, store, manager, administration, stop } = fixture();
      const failing = failFinalizationWrites(store);
      const run = enqueue(LIVE);
      failing.targets.add(run.id);
      const pid = await ready(run.id);

      const result = await stop(run.id);

      expect(failing.state.failures).toBeGreaterThan(0);
      await settled(administration, run.id, failing.state);
      expect(alive(pid)).toBe(false);
      const persisted = store.getTestRun(run.id)!;
      expect(persisted.phase).toBe("running");
      expect(persisted.telemetry?.finalizedAt).toBeNull();
      expect(result).toMatchObject({ action: "cancel", outcome: "unresolved", reason: "finalization_not_durable" });
      expect(manager.status().running).toBe(1);
      const retry = await stop(run.id, { requestId: "request-retry-durable", waitMs: 1_000 });
      expect(retry).toMatchObject({ action: "none", outcome: "unresolved", reason: "finalization_not_durable" });
      expect((await administration.inspect({ runId: run.id })).resolution.state).toBe("unresolved");
      expect(store.getTestRun(run.id)?.phase).toBe("running");
    });

    it("does not confirm a queued cancellation that exists only as a failed staged write", async () => {
      const { enqueue, store, manager, administration, stop, ready, audit } = fixture();
      manager.setLimit(1);
      const blocker = enqueue(LIVE);
      const blockerPid = await ready(blocker.id);
      const queued = enqueue(LIVE);
      const failing = failFinalizationWrites(store);
      failing.targets.add(queued.id);

      const first = await stop(queued.id, { waitMs: 1_000 });

      expect(first.outcome).not.toBe("confirmed");
      expect(first.action).toBe("undetermined");
      expect(audit(queued.id)[0]).toMatchObject({ action: "undetermined", outcome: "unresolved" });
      expect(failing.state.failures).toBeGreaterThan(0);
      expect(store.getTestRun(queued.id)).toMatchObject({ phase: "queued", startedAt: null, telemetry: { finalizedAt: null } });
      const inspection = await administration.inspect({ runId: queued.id });
      expect(inspection.resolution).toMatchObject({ state: "unresolved", reason: "finalization_not_durable" });
      expect(inspection.durableRecord).toMatchObject({ write: "failed", phase: "queued", finalizedAt: null });
      expect(await stop(queued.id, { requestId: "request-queued-retry", waitMs: 1_000 })).toMatchObject({ action: "none", outcome: "unresolved",
        reason: "finalization_not_durable" });
      expect(store.getTestRun(queued.id)?.phase).toBe("queued");
      // Exactly one run: the running neighbour is not touched.
      expect(alive(blockerPid)).toBe(true);
      expect(store.getTestRun(blocker.id)?.phase).toBe("running");
    });
  });
});
