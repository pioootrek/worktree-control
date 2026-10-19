import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { TestJobManager } from "./test-job-manager";
import { SqliteStateStore } from "./sqlite-store";
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
function fixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const root = mkdtempSync(join(tmpdir(), "wtc-phase-"));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  const project = store.addProject({ name: "App", repositoryPath: root, port: 3210, executable: "node", args: [] });
  let wall = "2026-10-19T00:00:00.000Z", tick = 0, missing = false;
  const clock = { wallNow: () => wall, monotonicNow: () => { if (missing) throw Error("unavailable"); return tick; } };
  const finishLog = vi.fn(async () => {});
  const manager = new TestJobManager(store, { ...nullLogWriter, finishTest: finishLog }, () => {}, clock);
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: null, stderr: null });
  vi.mocked(spawn).mockReset().mockReturnValue(child);
  const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockResolvedValue();
  const worktree: Worktree = { path: root, head: "aaa", shortHead: "aaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
  const enqueue = (source = clean()) => manager.enqueue({ projectId: project.id, worktree,
    command: { executable: "node", args: [], cwd: root, preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 1000 } },
    environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] }, actor: "local-user", sourceObservation: source });
  const advance = (value: number, date?: string) => { tick = value; if (date) wall = date; };
  const exit = (code: number | null = 0, signal: string | null = null) => { child.emit("exit", code, signal); child.emit("close"); };
  const f = { root, store, manager, child, stop, enqueue, advance, exit, finishLog, missing: () => { missing = true; } };
  fixtures.push(f); return f;
}

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

  it("retains the occupied slot and nonterminal summary on failed cleanup, then retries", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    f.stop.mockRejectedValue(Error("cannot inspect owned tree")); f.advance(50); f.exit();
    await vi.advanceTimersByTimeAsync(250); await drain();
    expect(f.manager.status().running).toBe(1);
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "running", finishedAt: null, telemetry: { cleanup: "failed", cleanupFinishedAt: null, finalizedAt: null, durations: { cleanupMs: null } } });
    f.stop.mockResolvedValue(); f.advance(100); await f.manager.cancel(run.id, "local-user"); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "passed", telemetry: { termination: "exit", durations: { cleanupMs: 50 } } });
  });

  it("holds preparation exclusion until a cancelled observer settles", async () => {
    const f = fixture(); let release!: (value: TestSourceObservation) => void;
    f.manager.configureSourceObserver(async () => new Promise(resolve => { release = resolve; }));
    const run = f.enqueue(); await drain(); f.advance(20);
    const cancelled = f.manager.cancel(run.id, "local-user"); await drain();
    expect(f.manager.status().running).toBe(1);
    expect(f.store.getTestRun(run.id)?.telemetry?.finalizedAt).toBeNull();
    f.advance(50); release(clean()); await cancelled; await drain();
    expect(f.manager.status().running).toBe(0);
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "cancelled", telemetry: { termination: "cancel", durations: { prepareMs: 50, processMs: null, totalMs: 50 } } });
  });

  it("keeps a correct process outcome when the measurement clock is unavailable", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.missing(); f.child.emit("spawn"); f.exit(); await drain();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "passed", source: { processOutcome: "passed" }, telemetry: { availability: "partial", durations: { processMs: null, cleanupMs: null, totalMs: null } } });
  });

  it("surfaces final durable-write failure and does not release the slot as a successful finalization", async () => {
    const f = fixture(); const run = f.enqueue(); await drain(); f.child.emit("spawn");
    const save = f.store.saveTestRun.bind(f.store);
    vi.spyOn(f.store, "saveTestRun").mockImplementation((value, key) => { if (value.telemetry?.finalizedAt) throw Error("disk full"); save(value, key); });
    f.exit(); await drain();
    expect(f.store.getTestRun(run.id)?.phase).toBe("running");
    expect(f.manager.status().running).toBe(1);
    await expect(f.manager.shutdown()).rejects.toThrow("disk full");
  });
});
