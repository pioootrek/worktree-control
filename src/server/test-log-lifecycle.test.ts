import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileLogWriter } from "./log-writer";
import { SqliteStateStore } from "./sqlite-store";
import { TestJobManager } from "./test-job-manager";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "switcher-log-lifecycle-"));
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  const project = store.addProject({ name: "Logs", repositoryPath: directory, port: 3210, executable: "node", args: [] });
  const logs = new FileLogWriter(directory);
  const manager = new TestJobManager(store, logs);
  let expectedDurabilityFailure = false;
  cleanups.push(async () => {
    if (expectedDurabilityFailure) await expect(manager.shutdown()).rejects.toThrow("database write failed");
    else await manager.shutdown();
    await logs.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const enqueue = (script = "console.log('final output')", options: { executable?: string; cwd?: string; timeoutMs?: number } = {}) => manager.enqueue({
    projectId: project.id,
    worktree: { path: directory, head: "abc123", shortHead: "abc123", branch: "main", detached: false, locked: false, prunable: false, dirty: false },
    command: {
      preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: options.timeoutMs ?? 5_000 },
      executable: options.executable ?? process.execPath,
      args: ["-e", script],
      cwd: options.cwd ?? directory,
    },
    environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] },
    actor: "local-user",
  });
  const testDescriptors = () => process.platform === "linux" ? readdirSync("/proc/self/fd").filter((fd) => {
    try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(join(directory, "tests") + "/"); }
    catch { return false; }
  }) : [];
  return { directory, store, project, logs, manager, enqueue, testDescriptors, expectDurabilityFailure: () => { expectedDurabilityFailure = true; } };
}

describe("test log lifecycle", () => {
  it("closes twelve completed job logs before publishing results and never reopens late output", async () => {
    const { directory, store, logs, manager, enqueue, testDescriptors } = fixture();
    const finish = vi.spyOn(logs, "finishTest");
    for (let index = 0; index < 12; index += 1) {
      const run = enqueue();
      await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"));
      expect(readFileSync(join(directory, "tests", `${run.id}.log`), "utf8")).toContain("final output");
      expect(testDescriptors()).toHaveLength(0);
      logs.test(run.id, "late output");
      await logs.finishTest(run.id);
      expect(readFileSync(join(directory, "tests", `${run.id}.log`), "utf8")).not.toContain("late output");
    }
    expect(manager.status()).toMatchObject({ running: 0, queued: 0 });
    // One manager finalization and one explicit idempotency check per run.
    expect(finish).toHaveBeenCalledTimes(24);
    await manager.shutdown();
    expect(testDescriptors()).toHaveLength(0);
  }, 10_000);

  it.each(["failed", "timed_out", "spawn_error", "sync_spawn_error", "cancelled", "queued_cancelled"])("finalizes exactly once after %s", async (outcome) => {
    const { store, logs, manager, enqueue, testDescriptors } = fixture();
    const finish = vi.spyOn(logs, "finishTest");
    const run = enqueue(outcome === "failed" ? "process.exit(1)" : "console.log('ready'); setInterval(() => {}, 1000)", {
      executable: outcome === "spawn_error" ? "/missing-switcher-test-executable" : undefined,
      cwd: outcome === "sync_spawn_error" ? "invalid\0cwd" : undefined,
      timeoutMs: outcome === "timed_out" ? 50 : undefined,
    });
    if (outcome === "queued_cancelled") await manager.cancel(run.id, "local-user");
    if (outcome === "cancelled") {
      await vi.waitFor(() => expect(store.getTestRun(run.id)?.logs).toContain("ready"));
      await manager.cancel(run.id, "local-user");
    }
    const phase = outcome.includes("spawn_error") ? "failed" : outcome === "queued_cancelled" ? "cancelled" : outcome;
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe(phase));
    expect(finish).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(testDescriptors()).toHaveLength(0);
  });

  it("retains fifty completed logs and rotated copies while preserving running and queued output", async () => {
    const { directory, store, logs, manager, enqueue } = fixture();
    const running = enqueue("setInterval(() => {}, 1000)");
    await vi.waitFor(() => expect(store.getTestRun(running.id)?.phase).toBe("running"));
    const queued = enqueue();
    const completed: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      // Exercise the real history policy without launching 55 processes.
      const persisted = store.getTestRun(queued.id)!;
      const id = randomUUID();
      store.saveTestRun({ ...persisted, id, queuedAt: new Date(index * 1000).toISOString(), phase: "passed", telemetry: { ...persisted.telemetry!, finalizedAt: new Date().toISOString() } });
      logs.openTest(id);
      logs.test(id, "retained output");
      await logs.finishTest(id);
      writeFileSync(join(directory, "tests", `${id}.log.1`), "rotated output");
      completed.push(id);
    }
    await manager.pruneLogs();
    const retained = store.listTestRuns(undefined, 500);
    expect(retained.filter((run) => !["running", "queued"].includes(run.phase))).toHaveLength(50);
    for (const id of completed) {
      expect(existsSync(join(directory, "tests", `${id}.log`))).toBe(store.hasTestRun(id));
      expect(existsSync(join(directory, "tests", `${id}.log.1`))).toBe(store.hasTestRun(id));
    }
    expect(readdirSync(join(directory, "tests")).length).toBeLessThanOrEqual(102);
    expect(readFileSync(join(directory, "tests", `${running.id}.log`), "utf8")).toContain("setInterval");
    expect(readFileSync(join(directory, "tests", `${queued.id}.log`), "utf8")).toContain("final output");
  }, 10_000);

  it("recovers interrupted history and deletes orphan logs after project removal", async () => {
    const { directory, store, project, logs, manager, enqueue } = fixture();
    const seed = enqueue();
    await manager.cancel(seed.id, "local-user");
    await manager.shutdown();
    const template = store.getTestRun(seed.id)!;
    for (let index = 0; index < 60; index += 1) {
      const id = randomUUID();
      store.saveTestRun({ ...template, id, phase: "queued", queuedAt: new Date(index * 1000).toISOString(), finishedAt: null });
      writeFileSync(join(directory, "tests", `${id}.log`), "before restart");
    }
    const recovered = new TestJobManager(store, logs);
    await recovered.pruneLogs();
    expect(store.countTestRuns(["queued", "running"])).toBe(0);
    expect(store.listTestRuns(undefined, 500)).toHaveLength(50);
    expect(readdirSync(join(directory, "tests"))).toHaveLength(50);
    store.removeProject(project.id, "local-user");
    await recovered.pruneLogs();
    expect(readdirSync(join(directory, "tests"))).toHaveLength(0);
    await recovered.shutdown();
  });

  it("waits for log finalization before publishing success and releasing queue capacity", async () => {
    const { store, logs, manager, enqueue } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finish = vi.spyOn(logs, "finishTest").mockImplementationOnce(async (id) => {
      await gate;
      await FileLogWriter.prototype.finishTest.call(logs, id);
    });
    try {
      const run = enqueue();
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(run.id));
      expect(store.getTestRun(run.id)?.phase).toBe("running");
      const next = enqueue();
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.getTestRun(next.id)?.phase).toBe("queued");
      expect(manager.status()).toMatchObject({ running: 1, queued: 1 });
      release();
      await vi.waitFor(() => expect(store.getTestRun(next.id)?.phase).toBe("passed"));
    } finally {
      release();
    }
  });

  it("acknowledges queued cancellation only after logs and stored state are finalized", async () => {
    const { directory, store, project, logs, manager, enqueue } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(logs, "finishTest").mockImplementationOnce(async (id) => {
      await gate;
      await FileLogWriter.prototype.finishTest.call(logs, id);
    });
    const run = enqueue();
    let acknowledged = false;
    const cancelled = manager.cancel(run.id, "local-user").then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(acknowledged).toBe(false);
      expect(store.getTestRun(run.id)?.phase).toBe("queued");
      release();
      expect((await cancelled).phase).toBe("cancelled");
      expect(store.getTestRun(run.id)?.phase).toBe("cancelled");
      expect(store.countTestRuns(["queued", "running"], project.id)).toBe(0);
      store.removeProject(project.id, "local-user");
      await manager.pruneLogs();
      expect(existsSync(join(directory, "tests", `${run.id}.log`))).toBe(false);
    } finally {
      release();
      await cancelled;
    }
  });

  it("keeps the queue moving during slow log pruning and awaits pruning on shutdown", async () => {
    const { store, logs, manager, enqueue } = fixture();
    await manager.pruneLogs();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(logs, "pruneTests").mockReturnValue(gate);
    try {
      const first = enqueue();
      const second = enqueue();
      await vi.waitFor(() => {
        expect(store.getTestRun(first.id)?.phase).toBe("passed");
        expect(store.getTestRun(second.id)?.phase).toBe("passed");
      });
      expect(manager.status()).toMatchObject({ running: 0, queued: 0 });
      let stopped = false;
      const shutdown = manager.shutdown().then(() => { stopped = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release();
      await shutdown;
    } finally {
      release();
    }
  });

  it("observes background finalization failures after a synchronous spawn error", async () => {
    const { store, logs, manager, enqueue, testDescriptors, expectDurabilityFailure } = fixture();
    expectDurabilityFailure();
    const audit = vi.spyOn(logs, "controller");
    const save = store.saveTestRun.bind(store);
    vi.spyOn(store, "saveTestRun").mockImplementation((run, key) => {
      if (run.phase === "failed") throw new Error("database write failed");
      save(run, key);
    });
    const run = enqueue("", { cwd: "invalid\0cwd" });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledWith("test_run.finalization_failed", {
      runId: run.id, error: "Error: database write failed",
    }));
    expect(testDescriptors()).toHaveLength(0);
    // Durability failure stops admission, remains visible at shutdown, and leaves
    // the persisted active record available for interrupted recovery.
    expect(store.getTestRun(run.id)?.phase).toBe("running");
    expect(() => enqueue()).toThrow("zamknięta");
    await expect(manager.shutdown()).rejects.toThrow("database write failed");
  });

  it("still stops active processes when another cancellation fails during shutdown", async () => {
    const { store, manager, enqueue, testDescriptors, expectDurabilityFailure } = fixture();
    expectDurabilityFailure();
    const running = enqueue("console.log('ready'); setInterval(() => {}, 1000)");
    await vi.waitFor(() => expect(store.getTestRun(running.id)?.logs).toContain("ready"));
    const queued = enqueue();
    const save = store.saveTestRun.bind(store);
    const persistence = vi.spyOn(store, "saveTestRun").mockImplementation((run, key) => {
      if (run.id === queued.id && run.phase === "cancelled") throw new Error("database write failed");
      save(run, key);
    });
    try {
      await expect(manager.shutdown()).rejects.toThrow("anulowania zadań");
      expect(store.getTestRun(running.id)?.phase).toBe("cancelled");
      expect(manager.status().running).toBe(0);
      expect(testDescriptors()).toHaveLength(0);
    } finally {
      persistence.mockRestore();
    }
  });

  it("reports a log close failure as a failed verification even when the process exits zero", async () => {
    const { store, logs, enqueue } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = enqueue();
    vi.spyOn(logs, "finishTest").mockImplementationOnce(async (id) => {
      await FileLogWriter.prototype.finishTest.call(logs, id);
      throw new Error("disk failure");
    });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("failed"));
    expect(store.getTestRun(run.id)).toMatchObject({ exitCode: 0, error: expect.stringContaining("disk failure") });
  });
});
