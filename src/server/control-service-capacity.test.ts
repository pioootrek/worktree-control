import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, RuntimeSnapshot, Worktree } from "@/shared/contracts";
import { ControlService } from "./control-service";
import type { GitWorktreeReader } from "./git-worktrees";
import { nullLogWriter } from "./log-writer";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import type { ProjectTestCommandResolver } from "./test-command";
import { TestJobManager } from "./test-job-manager";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stoppedRuntime(): RuntimeSnapshot {
  return {
    phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [],
    resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
  };
}

function fixture(count = 3, onStart: (project: Project) => Promise<void> = async () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-capacity-"));
  directories.push(directory);
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  const projects = Array.from({ length: count }, (_, index) => store.addProject({
    name: `Project ${index + 1}`,
    repositoryPath: `/code/project-${index + 1}`,
    port: 3300 + index,
    executable: "pnpm",
    args: ["run", "dev"],
  }));
  const worktrees = new Map(projects.map((project) => [project.repositoryPath, [{
    path: project.repositoryPath,
    head: `head-${project.id}`,
    shortHead: "abc1234",
    branch: "main",
    detached: false,
    locked: false,
    prunable: false,
    dirty: false,
  } satisfies Worktree]]));
  const runtimes = new Map(projects.map((project) => [project.id, stoppedRuntime()]));
  const start = vi.fn(async (project: Project, path: string) => {
    const runtime = runtimes.get(project.id)!;
    runtime.phase = "starting";
    runtime.pid = 1000 + projects.indexOf(project);
    runtime.worktreePath = path;
    try {
      await onStart(project);
      runtime.phase = "running";
    } catch (error) {
      runtime.phase = "failed";
      runtime.pid = null;
      throw error;
    }
  });
  const stop = vi.fn(async (projectId: string) => {
    const runtime = runtimes.get(projectId)!;
    runtime.phase = "stopping";
    runtime.phase = "stopped";
    runtime.pid = null;
  });
  const processes = {
    snapshot: vi.fn((projectId: string) => ({ ...runtimes.get(projectId)! })),
    statusSummary: (projectId: string) => {
      const runtime = runtimes.get(projectId)!;
      return {
        phase: runtime.phase,
        worktreePath: runtime.worktreePath,
        startedAt: runtime.startedAt,
        failureCode: runtime.failure?.code ?? (runtime.error ? "runtime_error" : null),
        ownsProcess: runtime.pid !== null,
      };
    },
    start,
    stop,
    stopAll: vi.fn(async () => undefined),
  } as unknown as ProcessManager;
  const git = {
    list: vi.fn(async (repositoryPath: string) => worktrees.get(repositoryPath) ?? []),
  } as unknown as GitWorktreeReader;
  const commands = {
    resolve: vi.fn(() => ({
      preset: "node" as const,
      executable: "pnpm",
      args: ["run", "dev"],
      portMethod: "environment" as const,
      tls: { mode: "off" as const, keyPath: null, certPath: null, caPath: null },
    })),
  };
  return { service: new ControlService(store, git, processes, undefined, commands), store, projects, runtimes, start, stop, worktrees, directory, git, processes, commands };
}

describe("ControlService server capacity", () => {
  it("closes persistent state after managed-process cleanup fails", async () => {
    const { service, store, processes } = fixture(1);
    const close = vi.spyOn(store, "close");
    vi.mocked(processes.stopAll).mockRejectedValueOnce(new Error("cleanup unconfirmed"));

    await expect(service.shutdown()).rejects.toThrow("Nie zakończono poprawnie");

    expect(close).toHaveBeenCalledOnce();
  });

  it("stops an owned process before removing its project", async () => {
    const { service, store, projects, stop } = fixture(1);
    const removed = await service.removeProject(projects[0].id);
    expect(removed.id).toBe(projects[0].id);
    expect(stop).toHaveBeenCalledWith(projects[0].id);
    expect(store.getProject(projects[0].id)).toBeNull();
    store.close();
  });

  it("does not remove a project reserved by another owner", async () => {
    const { service, store, projects, stop } = fixture(1);
    store.acquireReservation({
      projectId: projects[0].id,
      worktreePath: projects[0].repositoryPath,
      kind: "human",
      owner: "another-user",
    });
    await expect(service.removeProject(projects[0].id)).rejects.toThrow("another-user");
    expect(stop).not.toHaveBeenCalled();
    expect(store.getProject(projects[0].id)).not.toBeNull();
    store.close();
  });

  it("serializes a concurrent test enqueue before project removal", async () => {
    const { store, projects, directory, git, processes, commands } = fixture(1);
    let releaseWorktrees!: () => void;
    const worktreesReady = new Promise<void>((resolve) => { releaseWorktrees = resolve; });
    vi.mocked(git.list).mockImplementationOnce(async () => {
      await worktreesReady;
      return [{
        path: projects[0].repositoryPath,
        head: "abc123456789",
        shortHead: "abc1234",
        branch: "main",
        detached: false,
        locked: false,
        prunable: false,
        dirty: false,
      }];
    });
    const tests = new TestJobManager(store, nullLogWriter);
    const testCommands = {
      resolve: vi.fn(() => ({
        preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 5_000 },
        executable: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 2000)"],
        cwd: directory,
      })),
    } as unknown as ProjectTestCommandResolver;
    const service = new ControlService(store, git, processes, undefined, commands, undefined, undefined, testCommands, tests);

    const enqueue = service.enqueueTest(projects[0].id, projects[0].repositoryPath, "node:test");
    await vi.waitFor(() => expect(git.list).toHaveBeenCalledTimes(1));
    const removal = service.removeProject(projects[0].id);
    releaseWorktrees();
    const run = await enqueue;

    await expect(removal).rejects.toThrow("Anuluj testy");
    expect(store.getProject(projects[0].id)).not.toBeNull();
    await tests.cancel(run.id, "local-user");
    await vi.waitFor(() => expect(tests.status().running).toBe(0));
    await tests.shutdown();
    store.close();
  });

  it("rejects a third server at capacity two and keeps existing servers when the limit is lowered", async () => {
    const { service, store, projects, start } = fixture();
    service.setServerCapacity({ enabled: true, limit: 2 });
    await service.operate(projects[0].id, "start");
    await service.operate(projects[1].id, "start");

    await expect(service.operate(projects[2].id, "start")).rejects.toThrow("limit 2");
    expect(start).toHaveBeenCalledTimes(2);
    expect(service.serverCapacity()).toMatchObject({ used: 2, available: 0 });

    service.setServerCapacity({ enabled: true, limit: 1 });
    expect(service.serverCapacity()).toMatchObject({ limit: 1, used: 2, available: 0 });
    expect(projects.slice(0, 2).map(({ id }) => service.serverCapacity().holders.some((holder) => holder.projectId === id)))
      .toEqual([true, true]);
    store.close();
  });

  it("atomically grants the last slot to only one concurrent start", async () => {
    let releaseStart!: () => void;
    const heldStart = new Promise<void>((resolve) => { releaseStart = resolve; });
    const { service, store, projects, runtimes, start } = fixture(2, async (project) => {
      if (project.id === projects[0].id) await heldStart;
    });
    service.setServerCapacity({ enabled: true, limit: 1 });

    const first = service.operate(projects[0].id, "start");
    await vi.waitFor(() => expect(runtimes.get(projects[0].id)?.phase).toBe("starting"));
    expect(service.serverCapacity().holders).toContainEqual(expect.objectContaining({
      projectId: projects[0].id,
      phase: "starting",
    }));
    await expect(service.operate(projects[1].id, "start")).rejects.toThrow("limit 1");
    expect(start).toHaveBeenCalledTimes(1);
    releaseStart();
    await first;
    store.close();
  });

  it("retains one slot while switching a running project", async () => {
    const { service, store, projects, worktrees, start, stop } = fixture(1);
    const alternate = { ...worktrees.get(projects[0].repositoryPath)![0], path: `${projects[0].repositoryPath}-feature`, branch: "feature" };
    worktrees.get(projects[0].repositoryPath)!.push(alternate);
    service.setServerCapacity({ enabled: true, limit: 1 });
    await service.operate(projects[0].id, "start");

    await service.operate(projects[0].id, "switch", alternate.path);

    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    expect(service.serverCapacity()).toMatchObject({ used: 1, available: 0 });
    store.close();
  });

  it.each(["restart", "switch"] as const)("keeps capacity and blocks %s when cleanup fails", async (operation) => {
    const { service, store, projects, runtimes, start, stop } = fixture(2);
    service.setServerCapacity({ enabled: true, limit: 1 });
    await service.operate(projects[0].id, "start");
    stop.mockImplementationOnce(async (id) => {
      runtimes.get(id)!.phase = "failed";
      throw new Error("cleanup unconfirmed");
    });
    await expect(service.operate(projects[0].id, operation)).rejects.toThrow("cleanup unconfirmed");
    expect(service.serverCapacity()).toMatchObject({ used: 1, available: 0, holders: [{ phase: "stopping" }] });
    expect(service.compactProjectStatus(projects[0].id, "human:web").status.serverCapacity)
      .toMatchObject({ used: 1, available: 0 });
    await expect(service.operate(projects[1].id, "start")).rejects.toThrow("limit 1");
    expect(start).toHaveBeenCalledTimes(1);
    await service.operate(projects[0].id, "stop");
    expect(service.serverCapacity().used).toBe(0);
    expect(service.compactProjectStatus(projects[0].id, "human:web").status.serverCapacity)
      .toMatchObject({ used: 0, available: 1 });
    await expect(service.operate(projects[1].id, "start")).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    expect(service.serverCapacity()).toMatchObject({ used: 1, available: 0 });
    expect(service.compactProjectStatus(projects[1].id, "human:web").status.serverCapacity)
      .toMatchObject({ used: 1, available: 0 });
    await service.operate(projects[0].id, "stop");
    expect(service.serverCapacity().holders.map(({ projectId }) => projectId)).toEqual([projects[1].id]);
    store.close();
  });

  it("keeps compact status on the bounded summary path", () => {
    const { service, store, projects, git, processes } = fixture(1);
    service.setServerCapacity({ enabled: true, limit: 1 });
    vi.mocked(processes.snapshot).mockClear();
    vi.mocked(git.list).mockClear();
    vi.mocked(processes.snapshot).mockImplementation(() => { throw new Error("rich runtime hydration is forbidden"); });
    vi.mocked(git.list).mockImplementation(() => Promise.reject(new Error("Git discovery is forbidden")));

    expect(service.compactProjectStatus(projects[0].id, "human:web").status)
      .toMatchObject({ runtimePhase: "stopped", serverCapacity: { used: 0, available: 1 } });
    expect(processes.snapshot).not.toHaveBeenCalled();
    expect(git.list).not.toHaveBeenCalled();
    store.close();
  });

  it("releases a slot after a failed start", async () => {
    const { service, store, projects, start } = fixture(2, async (project) => {
      if (project.id === projects[0].id) throw new Error("broken start");
    });
    service.setServerCapacity({ enabled: true, limit: 1 });

    await expect(service.operate(projects[0].id, "start")).rejects.toThrow("broken start");
    await expect(service.operate(projects[1].id, "start")).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    expect(service.serverCapacity().holders.map(({ projectId }) => projectId)).toEqual([projects[1].id]);
    store.close();
  });
});
