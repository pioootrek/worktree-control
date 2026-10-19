import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { TestJobManager } from "./test-job-manager";
import { SqliteStateStore } from "./sqlite-store";
import type { OwnedResourceSampler, ProcessGroupSnapshot } from "./resource-monitor";
import { OwnedProcessGroup } from "./owned-process-group";
import { nullLogWriter } from "./log-writer";
import type { TestSourceObservation, Worktree } from "@/shared/contracts";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn() }));
const fixtures: Array<{ manager: TestJobManager; store: SqliteStateStore; root: string }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.manager.shutdown().catch(() => undefined);
    f.store.close(); rmSync(f.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});
const clean = (): TestSourceObservation => ({ observedAt: "2026-10-19T00:00:00.000Z", head: "aaa", branch: "main", dirty: false, statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null });
const drain = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function fixture(options: { failStartupPrune?: boolean; sampler?: OwnedResourceSampler; timeoutMs?: number } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const root = mkdtempSync(join(tmpdir(), "wtc-phase-"));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  const project = store.addProject({ name: "App", repositoryPath: root, port: 3210, executable: "node", args: [] });
  let wall = "2026-10-19T00:00:00.000Z", tick = 0, missing = false;
  const clock = { wallNow: () => wall, monotonicNow: () => { if (missing) throw Error("unavailable"); return tick; } };
  const finishLog = vi.fn(async () => {});
  const controllerLog = vi.fn();
  if (options.failStartupPrune) vi.spyOn(store, "pruneTestSummaryHistory").mockImplementationOnce(() => { throw Error("retention busy"); });
  const manager = new TestJobManager(store, { ...nullLogWriter, finishTest: finishLog, controller: controllerLog }, () => {}, clock, { sampler: options.sampler });
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: null, stderr: null, pid: options.sampler ? 42 : undefined, exitCode: null, signalCode: null });
  vi.mocked(spawn).mockReset().mockReturnValue(child);
  const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockResolvedValue();
  const worktree: Worktree = { path: root, head: "aaa", shortHead: "aaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
  const enqueue = (source = clean()) => manager.enqueue({ projectId: project.id, worktree,
    command: { executable: "node", args: [], cwd: root, preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: options.timeoutMs ?? 1000 } },
    environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] }, actor: "local-user", sourceObservation: source });
  const advance = (value: number, date?: string) => { tick = value; if (date) wall = date; };
  const exit = (code: number | null = 0, signal: string | null = null) => { child.emit("exit", code, signal); child.emit("close"); };
  const f = { root, store, manager, child, stop, enqueue, advance, exit, finishLog, controllerLog, missing: () => { missing = true; } };
  fixtures.push(f); return f;
}

const resourceSnapshot = (ticks = 5, observedAtMs = 0): ProcessGroupSnapshot => ({
  members: [{ pid: 42, startTicks: 100, processGroupId: 42, cpuTicks: ticks, rssBytes: 1234, state: "S" }],
  hostCpuTicks: 100 + observedAtMs, cpuCount: 2, observedAtMs, incomplete: false,
});
const resourceSampler = (): OwnedResourceSampler => ({ supported: true, capture: vi.fn(async () => ({ pid: 42, startTicks: 100 })), snapshot: vi.fn(async () => resourceSnapshot()) });

describe("test job passive resource integration", () => {
  it.each(["exit", "cancel", "timeout", "shutdown", "cleanup_retry"])("retains samples and stops on confirmed cleanup: %s", async cause => {
    const sampler = resourceSampler(), f = fixture({ sampler, timeoutMs: 10_000 });
    vi.mocked(sampler.snapshot).mockResolvedValueOnce(resourceSnapshot()).mockResolvedValue(resourceSnapshot(15, 1000));
    const run = f.enqueue(); await drain(); f.child.emit("spawn"); await drain();
    await vi.advanceTimersByTimeAsync(1000); await drain();
    let shutdown: Promise<void> | undefined;
    if (cause === "cancel") await f.manager.cancel(run.id, "local-user");
    if (cause === "timeout") await vi.advanceTimersByTimeAsync(9000);
    if (cause === "shutdown") shutdown = f.manager.shutdown();
    if (cause === "cleanup_retry") f.stop.mockRejectedValue(Error("inspection failed"));
    f.exit(cause === "exit" || cause === "cleanup_retry" ? 0 : null, cause === "exit" || cause === "cleanup_retry" ? null : "SIGTERM");
    if (cause === "cleanup_retry") {
      await vi.advanceTimersByTimeAsync(250); await drain();
      expect(f.manager.status().running).toBe(1);
      const calls = vi.mocked(sampler.snapshot).mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.mocked(sampler.snapshot).mock.calls.length).toBeGreaterThan(calls);
      f.stop.mockResolvedValue(); await f.manager.cancel(run.id, "local-user");
    }
    await drain(); if (shutdown) await shutdown;
    const result = f.store.getTestRun(run.id)!;
    const phase = cause === "timeout" ? "timed_out" : cause === "cancel" || cause === "shutdown" ? "cancelled" : "passed";
    expect(result.phase).toBe(phase);
    expect(result.source.processOutcome).toBe(phase);
    expect(result.telemetry!.resources).toMatchObject({ sampleCount: expect.any(Number), peakSampledRssBytes: 1234, peakSampledCpuPercent: 2 });
    const calls = vi.mocked(sampler.snapshot).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sampler.snapshot).toHaveBeenCalledTimes(calls);
    expect(f.manager.status().running).toBe(0);
  });

  it("bounds resource-only durable checkpoints to one per ten seconds", async () => {
    const sampler = resourceSampler(), f = fixture({ sampler, timeoutMs: 100_000 });
    const tick = vi.spyOn(performance, "now").mockReturnValue(0);
    const run = f.enqueue(); await drain(); f.child.emit("spawn"); await drain();
    const save = vi.spyOn(f.store, "saveTestRun");
    await vi.advanceTimersByTimeAsync(9500);
    expect(save).not.toHaveBeenCalled();
    tick.mockReturnValue(10_000); await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    f.exit(); await drain();
    expect(f.store.getTestRun(run.id)?.telemetry?.resources?.sampleCount).toBeGreaterThan(10);
  });

  it("releases the slot without waiting for sampling and rejects late mutation of durable results", async () => {
    const sampler = resourceSampler(), f = fixture({ sampler });
    let release!: (value: ProcessGroupSnapshot) => void;
    vi.mocked(sampler.snapshot).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const run = f.enqueue(); await drain(); f.child.emit("spawn"); await drain();
    f.exit(); await drain();
    const final = f.store.getTestRun(run.id)!;
    expect(final.phase).toBe("passed");
    expect(final.telemetry!.resources).toMatchObject({ status: "unavailable", sampleCount: 0, peakSampledRssBytes: null, missingSampleCount: 1 });
    expect(f.manager.status().running).toBe(0);
    release(resourceSnapshot()); await drain();
    expect(f.store.getTestRun(run.id)).toEqual(final);
  });

  it("never changes successful process/source attribution when the sampler fails", async () => {
    const sampler = resourceSampler(), f = fixture({ sampler });
    vi.mocked(sampler.snapshot).mockRejectedValue(Error("EACCES"));
    f.manager.configureSourceObserver(async () => clean());
    const run = f.enqueue(); await drain(); f.child.emit("spawn"); await drain(); f.exit(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "passed", source: { processOutcome: "passed", attribution: "observed_match" },
      telemetry: { resources: { status: "unavailable", peakSampledRssBytes: null, missingSampleCount: 1 } } });
  });
});

describe("queue phase telemetry with independent wall and monotonic clocks", () => {
  it("separates queue, preparation, process, cleanup and source/log finalization despite wall jumps", async () => {
    const f = fixture();
    let release!: (value: TestSourceObservation) => void;
    f.manager.configureSourceObserver(async (_run, stage) => {
      if (stage === "preflight") return new Promise(resolve => { release = resolve; });
      f.advance(170); return clean();
    });
    f.finishLog.mockImplementation(async () => { f.advance(180, "2026-10-20T00:00:00.000Z"); });
    const run = f.enqueue();
    f.advance(10); await drain();
    expect(f.store.getTestRun(run.id)?.telemetry?.durations.queueMs).toBe(10);
    f.advance(30, "2026-10-18T23:00:00.000Z"); release(clean()); await drain();
    f.advance(35); f.child.emit("spawn");
    let cleaned!: () => void;
    f.stop.mockImplementation(() => new Promise<void>(resolve => { cleaned = resolve; }));
    f.advance(135); f.exit(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "running", finishedAt: null, source: { processOutcome: "passed" }, telemetry: { durations: { queueMs: 10, prepareMs: 20, processMs: 100, cleanupMs: null }, cleanup: "pending" } });
    f.advance(150); cleaned(); await drain();
    const result = f.store.getTestRun(run.id)!;
    expect(result).toMatchObject({ phase: "passed", source: { attribution: "observed_match", processOutcome: "passed" }, telemetry: { termination: "exit", cleanup: "confirmed", finalizedAt: "2026-10-20T00:00:00.000Z", durations: { queueMs: 10, prepareMs: 20, processMs: 100, cleanupMs: 15, finalizationMs: 30, totalMs: 180, runnerWaitMs: null } } });
    expect(result.finishedAt).toBe("2026-10-18T23:00:00.000Z");
    expect(result.telemetry!.admittedAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it.each(["changed", "throws"])("rejects preparation without inventing a process interval: %s", async mode => {
    const f = fixture();
    f.manager.configureSourceObserver(async () => { f.advance(25); if (mode === "throws") throw Error("Git failed"); return { ...clean(), head: "bbb" }; });
    const run = f.enqueue(); await drain();
    expect(spawn).not.toHaveBeenCalled();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "failed", source: { processOutcome: null }, telemetry: { termination: "rejected", cleanup: "not_required", spawnedAt: null, exitedAt: null, durations: { prepareMs: 25, processMs: null } } });
  });

  it.each([0, 7, 137])("keeps exit %s independent from dirty-source qualification without inferring OOM", async code => {
    const f = fixture(); const source = { ...clean(), dirty: true };
    f.manager.configureSourceObserver(async () => source);
    const run = f.enqueue(source); await drain(); f.child.emit("spawn"); f.advance(40); f.exit(code); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "failed", exitCode: code, source: { processOutcome: code === 0 ? "passed" : "failed", attribution: "uncertain" }, telemetry: { termination: "exit", durations: { processMs: 40 } } });
  });

  it("records synchronous spawn failure and cancellation before admission", async () => {
    const f = fixture();
    const cancelled = f.enqueue(); f.advance(8);
    await f.manager.cancel(cancelled.id, "local-user"); await drain();
    expect(f.store.getTestRun(cancelled.id)).toMatchObject({ phase: "cancelled", telemetry: { admittedAt: null, prepareFinishedAt: null, termination: "cancel", durations: { queueMs: 8, prepareMs: null, processMs: null } } });
    vi.mocked(spawn).mockImplementationOnce(() => { throw Error("invalid spawn"); });
    const failed = f.enqueue(); await drain();
    expect(f.store.getTestRun(failed.id)).toMatchObject({ phase: "failed", source: { processOutcome: null }, telemetry: { termination: "spawn_error", cleanup: "not_required", spawnedAt: null, exitedAt: null } });
  });

  it("records spawn error without a fake exit or zero process duration", async () => {
    const f = fixture(); const run = f.enqueue(); await drain();
    f.child.emit("error", Error("ENOENT")); f.child.emit("close"); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "failed", source: { processOutcome: "failed" }, telemetry: { termination: "spawn_error", spawnedAt: null, exitedAt: null, durations: { processMs: null } } });
  });

  it.each(["cancel", "timeout", "exit-first"])("records requested stop and exit races honestly: %s", async mode => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    let cleaned!: () => void; f.stop.mockImplementation(() => new Promise<void>(resolve => { cleaned = resolve; }));
    f.advance(60);
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(1000);
    else if (mode === "cancel") await f.manager.cancel(run.id, "local-user");
    else f.exit();
    await drain();
    if (mode === "exit-first") await f.manager.cancel(run.id, "local-user");
    else f.exit(null, "SIGTERM");
    f.advance(80); cleaned(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: mode === "exit-first" ? "passed" : mode === "cancel" ? "cancelled" : "timed_out", telemetry: { termination: mode === "exit-first" ? "exit" : mode, cleanup: "confirmed", stopRequestedAt: mode === "exit-first" ? null : expect.any(String) } });
  });

  it.each(["cancel", "shutdown"])("preserves timeout attribution when %s arrives during teardown", async action => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    let cleaned!: () => void;
    f.stop.mockImplementation(() => new Promise<void>(resolve => { cleaned = resolve; }));
    const timeoutAt = "2026-10-19T00:00:01.000Z";
    f.advance(1000, timeoutAt); await vi.advanceTimersByTimeAsync(1000); await drain();
    f.advance(1100, "2026-10-19T00:00:01.100Z");
    const requested = action === "cancel" ? f.manager.cancel(run.id, "local-user") : f.manager.shutdown();
    await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "running", telemetry: { termination: "timeout", stopRequestedAt: timeoutAt } });
    expect(f.manager.status().running).toBe(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.exit(null, "SIGTERM"); cleaned(); await requested; await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "timed_out", source: { processOutcome: "timed_out" }, telemetry: { termination: "timeout", stopRequestedAt: timeoutAt, cleanup: "confirmed" } });
    expect(f.manager.status().running).toBe(0);
  });

  it("preserves cancellation attribution when the timeout fires during teardown", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    let cleaned!: () => void;
    f.stop.mockImplementation(() => new Promise<void>(resolve => { cleaned = resolve; }));
    const cancelledAt = "2026-10-19T00:00:00.100Z";
    f.advance(100, cancelledAt); await f.manager.cancel(run.id, "local-user"); await drain();
    f.advance(1000, "2026-10-19T00:00:01.000Z"); await vi.advanceTimersByTimeAsync(1000); await drain();
    expect(f.stop).toHaveBeenCalledTimes(1);
    f.exit(null, "SIGTERM"); cleaned(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "cancelled", source: { processOutcome: "cancelled" }, telemetry: { termination: "cancel", stopRequestedAt: cancelledAt, cleanup: "confirmed" } });
  });

  it("retains the occupied slot and nonterminal summary on failed cleanup, then retries", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    f.stop.mockRejectedValue(Error("cannot inspect owned tree")); f.advance(50); f.exit();
    await vi.advanceTimersByTimeAsync(250); await drain();
    expect(f.manager.status().running).toBe(1);
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "running", finishedAt: null, telemetry: { cleanup: "failed", cleanupFinishedAt: null, finalizedAt: null, durations: { cleanupMs: null } } });
    f.stop.mockResolvedValue(); f.advance(100); await f.manager.cancel(run.id, "local-user"); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "passed", telemetry: { termination: "exit", durations: { cleanupMs: 50 } } });
  });

  it.each([1, 2])("returns cancellation promptly and holds preparation exclusion through finalization at limit %s", async limit => {
    const f = fixture(); let release!: (value: TestSourceObservation) => void;
    f.manager.setLimit(limit);
    const observer = vi.fn(async () => clean());
    observer.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    f.manager.configureSourceObserver(observer);
    const run = f.enqueue(); await drain(); f.advance(20);
    const waiting = f.enqueue(); await drain();
    expect(f.manager.status()).toMatchObject({ running: 1, queued: 1 });
    let cancellationResolved = false;
    const cancelled = f.manager.cancel(run.id, "local-user").then(result => { cancellationResolved = true; return result; });
    await drain();
    expect(cancellationResolved).toBe(true);
    expect(await cancelled).toMatchObject({ phase: "cancelled" });
    expect(f.manager.status()).toMatchObject({ running: 1, queued: 1 });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(f.store.getTestRun(run.id)?.telemetry?.finalizedAt).toBeNull();
    let finishLog!: () => void;
    f.finishLog.mockImplementationOnce(() => new Promise<void>(resolve => { finishLog = resolve; }));
    f.advance(50); release(clean()); await drain();
    expect(f.manager.status()).toMatchObject({ running: 1, queued: 1 });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    finishLog(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "cancelled", telemetry: { termination: "cancel", durations: { prepareMs: 50, processMs: null, totalMs: 50 } } });
    expect(f.store.getTestRun(waiting.id)?.phase).toBe("running");
    expect(f.manager.status()).toMatchObject({ running: 1, queued: 0 });
    f.child.emit("spawn"); f.exit(); await drain();
    expect(f.manager.status()).toMatchObject({ running: 0, queued: 0 });
  });

  it("waits for a cancelled preparation and log finalization during shutdown", async () => {
    const f = fixture(); let release!: (value: TestSourceObservation) => void;
    f.manager.configureSourceObserver(async () => new Promise(resolve => { release = resolve; }));
    const run = f.enqueue(); await drain();
    let cancelled = false;
    void f.manager.cancel(run.id, "local-user").then(() => { cancelled = true; }); await drain();
    expect(cancelled).toBe(true);
    let finalized!: () => void;
    f.finishLog.mockImplementationOnce(() => new Promise<void>(resolve => { finalized = resolve; }));
    let stopped = false;
    const shutdown = f.manager.shutdown().then(() => { stopped = true; }); await drain();
    expect(stopped).toBe(false);
    release(clean()); await drain();
    expect(stopped).toBe(false);
    expect(f.manager.status().running).toBe(1);
    finalized(); await shutdown;
    expect(stopped).toBe(true);
    expect(f.manager.status().running).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([false, true])("retries retention without closing admission or stranding pending jobs (startup failure: %s)", async failStartupPrune => {
    const f = fixture({ failStartupPrune });
    const prune = vi.spyOn(f.store, "pruneTestSummaryHistory");
    let release!: (value: TestSourceObservation) => void;
    f.manager.configureSourceObserver(vi.fn(async () => clean())
      .mockImplementationOnce(async () => new Promise(resolve => { release = resolve; })));
    const first = f.enqueue(); await drain();
    f.advance(1, "2026-10-19T00:00:00.001Z");
    const pending = f.enqueue(); await drain();
    const calls = prune.mock.calls.length;
    prune.mockImplementationOnce(() => { throw Error("retention busy"); });
    await vi.advanceTimersByTimeAsync(60_000); await drain();
    expect(prune).toHaveBeenCalledTimes(calls + 1);
    expect(f.controllerLog).toHaveBeenCalledWith("test_summary.retention_failed", { error: "Error: retention busy" });
    expect(f.manager.status()).toMatchObject({ running: 1, queued: 1 });
    f.advance(2, "2026-10-19T00:00:00.002Z");
    const added = f.enqueue(); await drain();
    expect(f.manager.status()).toMatchObject({ running: 1, queued: 2 });
    await vi.advanceTimersByTimeAsync(60_000); await drain();
    expect(prune).toHaveBeenCalledTimes(calls + 2);
    expect(f.controllerLog.mock.calls.filter(([event]) => event === "test_summary.retention_failed")).toHaveLength(failStartupPrune ? 2 : 1);
    release(clean()); await drain();
    for (const run of [first, pending, added]) {
      expect(f.store.getTestRun(run.id)?.phase).toBe("running");
      f.child.emit("spawn"); f.exit(); await drain();
      expect(f.store.getTestRun(run.id)?.phase).toBe("passed");
    }
    await expect(f.manager.shutdown()).resolves.toBeUndefined();
  });

  it("keeps a correct process outcome when the measurement clock is unavailable", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.missing(); f.child.emit("spawn"); f.exit(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "passed", source: { processOutcome: "passed" }, telemetry: { availability: "partial", durations: { processMs: null, cleanupMs: null, totalMs: null } } });
  });

  it("retries the final snapshot without losing a log failure or re-running finalization", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    f.finishLog.mockRejectedValueOnce(Error("log disk failure"));
    const save = f.store.saveTestRun.bind(f.store);
    const persistence = vi.spyOn(f.store, "saveTestRun").mockImplementation((value, key) => {
      if (value.telemetry?.finalizedAt) throw Error("summary disk full");
      save(value, key);
    });
    f.exit(); await drain();
    expect(f.store.getTestRun(run.id)?.phase).toBe("running");
    persistence.mockRestore();
    await expect(f.manager.shutdown()).rejects.toThrow("summary disk full");
    expect(f.finishLog).toHaveBeenCalledTimes(1);
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "failed", error: expect.stringContaining("log disk failure"), source: { processOutcome: "passed" } });
    expect(f.manager.status().running).toBe(0);
  });

  it("surfaces final durable-write failure and does not release the slot as a successful finalization", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    const save = f.store.saveTestRun.bind(f.store);
    vi.spyOn(f.store, "saveTestRun").mockImplementation((value, key) => { if (value.telemetry?.finalizedAt) throw Error("disk full"); save(value, key); });
    f.exit(); await drain();
    expect(f.store.getTestRun(run.id)?.phase).toBe("running");
    expect(f.manager.status().running).toBe(1);
    expect(() => f.enqueue()).toThrow("Kolejka testów jest zamknięta.");
    await expect(f.manager.shutdown()).rejects.toThrow("disk full");
  });
});
