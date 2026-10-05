import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TestCommand } from "./test-command";
import type { TestSourceObservation, Worktree } from "@/shared/contracts";
import { OwnedProcessGroup } from "./owned-process-group";
import { nullLogWriter } from "./log-writer";
import { SqliteStateStore } from "./sqlite-store";
import { TestJobManager } from "./test-job-manager";
import type { ResolvedTestEnvironment } from "@/server/modules/environments";

function resolved(environment: Record<string, string> = {}): ResolvedTestEnvironment {
  return {
    environment,
    mode: "clean",
    profile: "unit",
    inheritedServerProfile: null,
    variableNames: Object.keys(environment).sort(),
  };
}

const directories: string[] = [];
const managers: TestJobManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-test-queue-"));
  directories.push(directory);
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  const project = store.addProject({ name: "App", repositoryPath: directory, port: 3210, executable: "node", args: [] });
  const manager = new TestJobManager(store, nullLogWriter);
  managers.push(manager);
  const worktree = (path: string): Worktree => ({
    path, head: "abcdef123456", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false,
  });
  const command = (delay: number): TestCommand => ({
    preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 5_000 },
    executable: process.execPath,
    args: ["-e", `setTimeout(() => process.exit(0), ${delay})`],
    cwd: directory,
  });
  return { store, project, manager, worktree, command };
}

describe("TestJobManager", () => {
  const cleanSource = (): TestSourceObservation => ({ observedAt: new Date().toISOString(), head: "aaa", branch: "main", dirty: false, statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null });

  it("rejects a queued source change before spawning the command", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const enqueueSource = { observedAt: new Date().toISOString(), head: "aaa", branch: "main", dirty: false, statusDigest: "empty", statusEntries: 0, complete: true, errorCode: null };
    manager.configureSourceObserver(async () => ({ ...enqueueSource, observedAt: new Date().toISOString(), head: "bbb" }));
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(10), environment: resolved(), actor: "local-user", sourceObservation: enqueueSource });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("failed"));
    expect(store.getTestRun(run.id)).toMatchObject({ startedAt: null, source: { attribution: "changed", queueComparison: "changed", processOutcome: null } });
  });

  it("preserves command success but does not green-light equal dirty observations", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const dirtySource = { observedAt: new Date().toISOString(), head: "aaa", branch: "main", dirty: true, statusDigest: "dirty", statusEntries: 1, complete: true, errorCode: null };
    manager.configureSourceObserver(async () => ({ ...dirtySource, observedAt: new Date().toISOString() }));
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(10), environment: resolved(), actor: "local-user", sourceObservation: dirtySource });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("failed"), { timeout: 2_000 });
    expect(store.getTestRun(run.id)).toMatchObject({ exitCode: 0, source: { attribution: "uncertain", processOutcome: "passed" } });
  });

  it("finalizes with uncertain attribution when the finish observation throws", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const source = cleanSource();
    manager.configureSourceObserver(async (_run, stage) => {
      if (stage === "finish") throw new Error("Git unavailable");
      return cleanSource();
    });
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(10), environment: resolved(), actor: "local-user", sourceObservation: source });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("failed"), { timeout: 2_000 });
    expect(store.getTestRun(run.id)).toMatchObject({ exitCode: 0, source: { attribution: "uncertain", processOutcome: "passed", finish: { errorCode: "source_finish_failed" } } });
    expect(manager.status().running).toBe(0);
  });

  it("makes a throwing preflight terminal and source-uncertain", async () => {
    const { store, project, manager, worktree, command } = fixture();
    manager.configureSourceObserver(async () => { throw new Error("command drift"); });
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(10), environment: resolved(), actor: "local-user", sourceObservation: cleanSource() });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("failed"));
    expect(store.getTestRun(run.id)).toMatchObject({ startedAt: null, source: { attribution: "uncertain", processOutcome: null, reasonCodes: expect.arrayContaining(["source_preflight_failed"]) } });
  });

  it("reports preparing capacity without double-counting it as queued", async () => {
    const { project, manager, worktree, command } = fixture();
    let release!: () => void;
    manager.configureSourceObserver(async (_run, stage) => stage === "finish" ? cleanSource() : new Promise<TestSourceObservation>((resolve) => { release = () => resolve(cleanSource()); }));
    manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(10), environment: resolved(), actor: "local-user", sourceObservation: cleanSource() });
    await vi.waitFor(() => expect(manager.status()).toMatchObject({ running: 1, queued: 0 }));
    release();
  });

  it("drains a configured observer when shutdown cancels an active run", async () => {
    const { store, project, manager, worktree, command } = fixture();
    manager.configureSourceObserver(async (_run, stage) => {
      if (stage === "finish") throw new Error("lifecycle closed");
      return cleanSource();
    });
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(1_000), environment: resolved(), actor: "local-user", sourceObservation: cleanSource() });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("running"));

    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(store.getTestRun(run.id)).toMatchObject({ phase: "cancelled", source: { attribution: "uncertain", processOutcome: "cancelled" } });
    managers.splice(managers.indexOf(manager), 1);
    store.close();
  });

  it("does not inherit production NODE_ENV from the controller", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { store, project, manager, worktree, command } = fixture();
    const inspectEnvironment = command(20);
    inspectEnvironment.args = ["-e", "console.log(`NODE_ENV=${process.env.NODE_ENV ?? '<unset>'}`)"];
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: inspectEnvironment, environment: resolved({ PATH: process.env.PATH ?? "" }), actor: "local-user" });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"), { timeout: 2_000 });
    expect(store.getTestRun(run.id)?.logs).toContain("NODE_ENV=<unset>");
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("applies NODE_ENV from the resolved test environment policy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { store, project, manager, worktree, command } = fixture();
    const inspectEnvironment = command(20);
    inspectEnvironment.args = ["-e", "console.log(`NODE_ENV=${process.env.NODE_ENV ?? '<unset>'}`)"];
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: inspectEnvironment, environment: resolved({ NODE_ENV: "test" }), actor: "local-user" });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"), { timeout: 2_000 });
    expect(store.getTestRun(run.id)?.logs).toContain("NODE_ENV=test");
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("honors the global limit and runs at most one test per worktree", async () => {
    const { store, project, manager, worktree, command } = fixture();
    manager.setLimit(2);
    const first = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(1_000), environment: resolved(), actor: "local-user" });
    await vi.waitFor(() => expect(store.getTestRun(first.id)?.phase).toBe("running"));
    const second = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(10), environment: resolved(), actor: "local-user" });
    const third = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/b"), command: command(1_000), environment: resolved(), actor: "local-user" });

    await vi.waitFor(() => expect(manager.status()).toMatchObject({ running: 2, queued: 1 }));
    expect(store.getTestRun(first.id)?.phase).toBe("running");
    expect(store.getTestRun(second.id)?.phase).toBe("queued");
    expect(store.getTestRun(third.id)?.phase).toBe("running");
    await vi.waitFor(() => expect(store.getTestRun(second.id)?.phase).toBe("passed"), { timeout: 3_000 });
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("does not stop active runs when the global limit is lowered", async () => {
    const { store, project, manager, worktree, command } = fixture();
    manager.setLimit(2);
    const first = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: command(250), environment: resolved(), actor: "local-user" });
    const second = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/b"), command: command(250), environment: resolved(), actor: "local-user" });

    await vi.waitFor(() => expect(manager.status()).toMatchObject({ running: 2, queued: 0 }));
    manager.setLimit(1);
    const third = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/c"), command: command(10), environment: resolved(), actor: "local-user" });

    expect(store.getTestRun(first.id)?.phase).toBe("running");
    expect(store.getTestRun(second.id)?.phase).toBe("running");
    expect(store.getTestRun(third.id)?.phase).toBe("queued");
    await vi.waitFor(() => expect(store.getTestRun(third.id)?.phase).toBe("passed"), { timeout: 3_000 });
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("cancels queued and running jobs and restricts agent cancellation to the author", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const longRunning = command(2_000);
    longRunning.preset.timeoutMs = 30_000;
    longRunning.args = ["-e", "console.log('ready'); setInterval(() => {}, 1000)"];
    const running = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: longRunning, environment: resolved(), actor: "agent:mcp:one" });
    await vi.waitFor(() => expect(store.getTestRun(running.id)?.logs).toContain("ready"));
    const queued = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/b"), command: command(20), environment: resolved(), actor: "agent:mcp:one" });
    await expect(manager.cancel(running.id, "agent:mcp:other")).rejects.toThrow("autor");
    expect((await manager.cancel(queued.id, "agent:mcp:one")).phase).toBe("cancelled");
    expect(await manager.cancel(running.id, "agent:mcp:one")).toMatchObject({ phase: "running", finishedAt: null });
    await vi.waitFor(() => expect(manager.status().running).toBe(0));
    expect(store.getTestRun(running.id)?.phase).toBe("cancelled");
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("keeps cancellation non-terminal until a signal-handling child exits", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const delayedExit = command(2_000);
    delayedExit.args = ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); console.log('ready'); setInterval(() => {}, 1000)"];
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: delayedExit, environment: resolved(), actor: "local-user" });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.logs).toContain("ready"));

    expect(await manager.cancel(run.id, "local-user")).toMatchObject({ phase: "running", finishedAt: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.getTestRun(run.id)).toMatchObject({ phase: "running", finishedAt: null });
    expect(manager.status().running).toBe(1);

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("cancelled"), { timeout: 2_000 });
    expect(store.getTestRun(run.id)?.finishedAt).not.toBeNull();
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("keeps the worktree occupied on cleanup failure and retries cancellation", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const job = command(20);
    job.args = ["-e", "console.log('ready'); setInterval(() => {}, 1000)"];
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: job, environment: resolved(), actor: "local-user" });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.logs).toContain("ready"));
    const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockRejectedValue(new Error("inspection unavailable"));
    await manager.cancel(run.id, "local-user");
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.error).toContain("inspection unavailable"));
    expect(manager.status().running).toBe(1);
    expect(store.getTestRun(run.id)).toMatchObject({ phase: "running", finishedAt: null });
    await expect(manager.shutdown()).rejects.toThrow("Nie potwierdzono");
    stop.mockRestore();
    await manager.cancel(run.id, "local-user");
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("cancelled"));
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("automatically retries transient cleanup failure without changing a passed result", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop")
      .mockRejectedValueOnce(new Error("inspection unavailable"));
    const run = manager.enqueue({
      projectId: project.id,
      worktree: worktree("/tmp/a"),
      command: command(20),
      environment: resolved(),
      actor: "local-user",
    });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"), { timeout: 2_000 });
    expect(store.getTestRun(run.id)).toMatchObject({ error: null, exitCode: 0 });
    expect(stop).toHaveBeenCalledTimes(2);
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("preserves an observed passed result when cleanup is retried explicitly", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop")
      .mockRejectedValue(new Error("inspection unavailable"));
    const run = manager.enqueue({
      projectId: project.id,
      worktree: worktree("/tmp/a"),
      command: command(20),
      environment: resolved(),
      actor: "local-user",
    });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.error).toContain("inspection unavailable"));
    expect(store.getTestRun(run.id)).toMatchObject({ phase: "running", exitCode: 0, finishedAt: null });

    stop.mockRestore();
    await manager.cancel(run.id, "local-user");

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"));
    expect(store.getTestRun(run.id)?.error).toBeNull();
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("bounds output-pipe close after the owned process group has exited", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const daemonized = command(20);
    daemonized.args = ["-e", `
      const child = require('node:child_process').spawn(
        process.execPath,
        ['-e', "setTimeout(() => console.log('late-daemon-output'), 1500); setTimeout(() => process.exit(0), 2000)"],
        { detached: true, stdio: ['ignore', 1, 2] },
      );
      child.unref();
    `];
    const run = manager.enqueue({
      projectId: project.id,
      worktree: worktree("/tmp/a"),
      command: daemonized,
      environment: resolved(),
      actor: "local-user",
    });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"), { timeout: 1_700 });
    expect(manager.status().running).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(store.getTestRun(run.id)?.logs).not.toContain("late-daemon-output");
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it.each(["cancel", "timeout", "launcher-exit", "shutdown"])(
    "retains the queue slot until a silent stubborn descendant exits: %s",
    async (mode) => {
      const { store, project, manager, worktree, command } = fixture();
      const job = command(20);
      const heartbeat = join(project.repositoryPath, "heartbeat");
      const descendant = `
        process.on('SIGTERM', () => {});
        const fs = require('node:fs');
        const beat = () => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()));
        beat(); setInterval(beat, 25); process.send('ready');
      `;
      job.args = ["-e", `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.on('message', () => {
          console.log('descendant-ready');
          ${mode === "launcher-exit" ? "process.exit(0);" : ""}
        });
        process.on('SIGTERM', () => process.exit(0));
      `];
      job.preset.timeoutMs = mode === "timeout" ? 800 : 15_000;
      const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: job, environment: resolved(), actor: "local-user" });
      await vi.waitFor(() => expect(store.getTestRun(run.id)?.logs).toContain("descendant-ready"), { timeout: 2_000 });
      const shutdown = mode === "shutdown" ? manager.shutdown() : null;
      if (mode === "cancel") await manager.cancel(run.id, "local-user");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(manager.status().running).toBe(1);
      expect(store.getTestRun(run.id)).toMatchObject({ phase: "running", finishedAt: null });
      await vi.waitFor(() => expect(manager.status().running).toBe(0), { timeout: 6_000 });
      await shutdown;
      expect(store.getTestRun(run.id)?.phase).toBe(
        mode === "timeout" ? "timed_out" : mode === "launcher-exit" ? "passed" : "cancelled",
      );
      const lastBeat = readFileSync(heartbeat, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFileSync(heartbeat, "utf8")).toBe(lastBeat);
      await manager.shutdown();
      store.close();
      managers.splice(managers.indexOf(manager), 1);
    }, 12_000,
  );

  it("debounces persisted output while retaining the bounded final tail", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const save = vi.spyOn(store, "saveTestRun");
    const chatty = command(20);
    chatty.args = ["-e", "for (let index = 0; index < 300; index += 1) console.log(`line-${index}`)"];
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: chatty, environment: resolved(), actor: "local-user" });

    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("passed"), { timeout: 2_000 });
    expect(save.mock.calls.length).toBeLessThan(20);
    expect(store.getTestRun(run.id)?.logs).toHaveLength(200);
    expect(store.getTestRun(run.id)?.logs.at(-1)).toBe("line-299");
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("deduplicates agent retries by actor and idempotency key", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const input = { projectId: project.id, worktree: worktree("/tmp/a"), command: command(20), environment: resolved(), actor: "agent:mcp:one", idempotencyKey: "attempt-1" };
    const first = manager.enqueue(input);
    expect(manager.enqueue(input).id).toBe(first.id);
    expect(() => manager.enqueue({ ...input, command: { ...input.command, preset: { ...input.command.preset, id: "node:build" } } })).toThrow("idempotencji");
    await manager.cancel(first.id, "local-user");
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });

  it("terminates a run after its preset timeout", async () => {
    const { store, project, manager, worktree, command } = fixture();
    const slow = command(2_000);
    slow.preset.timeoutMs = 30;
    const run = manager.enqueue({ projectId: project.id, worktree: worktree("/tmp/a"), command: slow, environment: resolved(), actor: "local-user" });
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("timed_out"), { timeout: 2_000 });
    await manager.shutdown();
    store.close();
    managers.splice(managers.indexOf(manager), 1);
  });
});
