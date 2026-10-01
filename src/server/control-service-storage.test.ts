import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Worktree } from "@/shared/contracts";
import { ControlService } from "./control-service";
import type { GitWorktreeReader } from "./git-worktrees";
import type { ProcessManager } from "./process-manager";
import { ProjectLifecycle } from "./modules/lifecycle";
import { SqliteStateStore } from "./sqlite-store";
import type { ProjectTestCommandResolver } from "./test-command";
import type { TestJobManager } from "./test-job-manager";
import { WorktreeStorageManager, type WorktreeCacheCleaner } from "./worktree-storage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ControlService worktree storage", () => {
  it("queues only paths discovered for the registered repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-storage-service-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3301, executable: "pnpm", args: ["run", "dev"] });
    const worktree: Worktree = {
      path: "/code/web",
      head: "abc",
      shortHead: "abc",
      branch: "main",
      detached: false,
      locked: false,
      prunable: false,
      dirty: false,
    };
    const git = { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader;
    const snapshot = vi.fn(() => ({ phase: "stopped", worktreePath: worktree.path }));
    const processes = { snapshot } as unknown as ProcessManager;
    const queue = vi.fn();
    const storage = { queue, isBusy: vi.fn(() => false), assertLifecycle: vi.fn() } as unknown as WorktreeStorageManager;
    const remove = vi.fn(async () => ({ cache: "next" as const, worktreePath: worktree.path, removed: true }));
    const cleaner = { remove } as unknown as WorktreeCacheCleaner;
    const service = new ControlService(store, git, processes, undefined, undefined, storage, cleaner);
    const recordProjectEvent = vi.spyOn(store, "recordProjectEvent");

    await service.refreshWorktreeStorage(project.id, worktree.path);
    expect(queue).toHaveBeenCalledWith(project.id, worktree.path, true);
    await expect(service.refreshWorktreeStorage(project.id, "/etc")).rejects.toThrow("nie należy");
    expect(queue).toHaveBeenCalledOnce();

    await expect(service.deleteWorktreeCache(project.id, worktree.path, "next")).resolves.toMatchObject({ removed: true });
    expect(remove).toHaveBeenCalledWith(worktree.path, "next");
    expect(queue).toHaveBeenLastCalledWith(project.id, worktree.path, true);
    expect(recordProjectEvent).toHaveBeenCalledWith(
      project.id,
      "worktree_cache.delete_succeeded",
      "local-user",
      expect.objectContaining({ cache: "next", removed: true }),
    );

    snapshot.mockReturnValue({ phase: "running", worktreePath: worktree.path });
    await expect(service.deleteWorktreeCache(project.id, worktree.path, "next")).rejects.toThrow("Zatrzymaj serwer");
    snapshot.mockReturnValue({ phase: "stopped", worktreePath: worktree.path });
    vi.mocked(storage.isBusy).mockReturnValueOnce(true);
    await expect(service.deleteWorktreeCache(project.id, worktree.path, "next")).rejects.toThrow("pomiaru dysku");
    store.acquireReservation({ projectId: project.id, worktreePath: worktree.path, kind: "human", owner: "local-user" });
    await expect(service.deleteWorktreeCache(project.id, worktree.path, "next")).rejects.toThrow("Zwolnij blokadę");
    expect(remove).toHaveBeenCalledOnce();
    expect(recordProjectEvent).toHaveBeenCalledWith(
      project.id,
      "worktree_cache.delete_failed",
      "local-user",
      expect.objectContaining({ error: expect.stringContaining("Zwolnij blokadę") }),
    );
    store.close();
  });

  it("blocks runtime, reservation, test admission, and explicit storage refresh until deferred deletion finishes", async () => {
    for (const conflict of ["start", "reserve", "enqueue", "refresh"] as const) {
      const directory = mkdtempSync(join(tmpdir(), `worktree-switcher-cache-${conflict}-`));
      directories.push(directory);
      const store = new SqliteStateStore(join(directory, "state.sqlite3"));
      const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3301, executable: "pnpm", args: ["run", "dev"] });
      const worktree: Worktree = {
        path: "/code/web", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false,
      };
      const git = { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader;
      const start = vi.fn(async () => undefined);
      const processes = {
        snapshot: vi.fn(() => ({
          phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [],
          resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
        })),
        start,
        stop: vi.fn(async () => undefined),
      } as unknown as ProcessManager;
      let cleanerEntered!: () => void;
      let releaseCleaner!: () => void;
      const entered = new Promise<void>((resolve) => { cleanerEntered = resolve; });
      const gate = new Promise<void>((resolve) => { releaseCleaner = resolve; });
      const cleaner = { remove: vi.fn(async () => {
        cleanerEntered();
        await gate;
        return { cache: "next" as const, worktreePath: worktree.path, removed: true };
      }) };
      const storage = { queue: vi.fn(), isBusy: vi.fn(() => false), assertLifecycle: vi.fn() } as unknown as WorktreeStorageManager;
      const commands = { resolve: vi.fn(() => ({
        preset: "node" as const, executable: "pnpm", args: ["run", "dev"], portMethod: "environment" as const,
        tls: { mode: "off" as const, keyPath: null, certPath: null, caPath: null },
      })) };
      const enqueue = vi.fn(() => ({ id: "run-1" }));
      const testCommands = {
        resolve: vi.fn(() => ({
          preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 30_000 },
          executable: "pnpm", args: ["run", "test"], cwd: worktree.path,
        })),
        discover: vi.fn(() => []),
      } as unknown as ProjectTestCommandResolver;
      const tests = {
        enqueue,
        status: vi.fn(() => ({ limit: 1, running: 0, queued: 0 })),
      } as unknown as TestJobManager;
      const service = new ControlService(store, git, processes, undefined, commands, storage, cleaner, testCommands, tests);

      const deletion = service.deleteWorktreeCache(project.id, worktree.path, "next");
      await entered;
      const pending = conflict === "start"
        ? service.operate(project.id, "start", worktree.path)
        : conflict === "reserve"
          ? service.reserve({ projectId: project.id, worktreePath: worktree.path, kind: "human", owner: "local-user" })
          : conflict === "enqueue"
            ? service.enqueueTest(project.id, worktree.path, "node:test")
            : service.refreshWorktreeStorage(project.id, worktree.path);
      await Promise.resolve();
      expect(start).not.toHaveBeenCalled();
      expect(store.getActiveReservation(project.id)).toBeNull();
      expect(storage.queue).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();

      releaseCleaner();
      await deletion;
      await pending;
      if (conflict === "start") expect(start).toHaveBeenCalledOnce();
      else if (conflict === "reserve") expect(store.getActiveReservation(project.id)?.worktreePath).toBe(worktree.path);
      else if (conflict === "enqueue") expect(enqueue).toHaveBeenCalledOnce();
      else expect(storage.queue).toHaveBeenCalledTimes(2);
      store.close();
    }
  });

  it("releases serialization after cleaner failure so a waiting operation can proceed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-cache-failure-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3301, executable: "pnpm", args: [] });
    const worktree = { path: "/code/web", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false } satisfies Worktree;
    const git = { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader;
    const processes = { snapshot: vi.fn(() => ({ phase: "stopped", worktreePath: null })) } as unknown as ProcessManager;
    let rejectCleaner!: (error: Error) => void;
    const cleaner = { remove: vi.fn(() => new Promise<never>((_resolve, reject) => { rejectCleaner = reject; })) };
    const service = new ControlService(store, git, processes, undefined, undefined, undefined, cleaner);
    const deletion = service.deleteWorktreeCache(project.id, worktree.path, "next");
    await vi.waitFor(() => expect(cleaner.remove).toHaveBeenCalledOnce());
    const reservation = service.reserve({ projectId: project.id, worktreePath: worktree.path, kind: "human", owner: "local-user" });
    rejectCleaner(new Error("cleaner failed"));
    await expect(deletion).rejects.toThrow("cleaner failed");
    await reservation;
    expect(store.getActiveReservation(project.id)).not.toBeNull();
    store.close();
  });

  it("drains accepted work before stopping processes and closing persistence during shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-cache-shutdown-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3301, executable: "pnpm", args: [] });
    const worktree = { path: "/code/web", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false } satisfies Worktree;
    const git = { list: vi.fn(async () => [worktree]), close: vi.fn() } as unknown as GitWorktreeReader;
    const order: string[] = [];
    const processes = {
      snapshot: vi.fn(() => ({ phase: "stopped", worktreePath: null })),
      stopAll: vi.fn(async () => { order.push("processes-stopped"); }),
    } as unknown as ProcessManager;
    let releaseCleaner!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCleaner = resolve; });
    const cleaner = { remove: vi.fn(async () => {
      await gate;
      order.push("deletion-drained");
      return { cache: "next" as const, worktreePath: worktree.path, removed: true };
    }) };
    const closeStore = store.close.bind(store);
    const close = vi.spyOn(store, "close").mockImplementation(() => { order.push("store-closed"); closeStore(); });
    const service = new ControlService(store, git, processes, undefined, undefined, undefined, cleaner);
    const deletion = service.deleteWorktreeCache(project.id, worktree.path, "next");
    await vi.waitFor(() => expect(cleaner.remove).toHaveBeenCalledOnce());
    const shutdown = service.shutdown();

    await Promise.resolve();
    expect(processes.stopAll).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    releaseCleaner();
    await deletion;
    await shutdown;
    expect(close).toHaveBeenCalledOnce();
    expect(order).toEqual(["deletion-drained", "processes-stopped", "store-closed"]);
  });

  it("blocks real automatic storage admission for the worktree during deletion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-cache-scan-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3301, executable: "pnpm", args: [] });
    const worktree = { path: "/code/web", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false } satisfies Worktree;
    const git = { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader;
    const processes = { snapshot: vi.fn(() => ({ phase: "stopped", worktreePath: null })) } as unknown as ProcessManager;
    const lifecycle = new ProjectLifecycle(store, processes);
    const scan = vi.fn(async (worktreePath: string) => ({ worktreePath, totalBytes: 1, nextBytes: 0, nextCacheBytes: 0, nodeModulesBytes: 0, topDirectories: [] }));
    const storage = new WorktreeStorageManager(store, lifecycle, { scan });
    let releaseCleaner!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCleaner = resolve; });
    const cleaner = { remove: vi.fn(async () => {
      await gate;
      return { cache: "next" as const, worktreePath: worktree.path, removed: true };
    }) };
    const service = new ControlService(store, git, processes, undefined, undefined, storage, cleaner, undefined, undefined, lifecycle);
    const deletion = service.deleteWorktreeCache(project.id, worktree.path, "next");
    await vi.waitFor(() => expect(cleaner.remove).toHaveBeenCalledOnce());

    storage.ensureFresh(project.id, [worktree.path]);
    expect(scan).not.toHaveBeenCalled();
    expect(storage.isBusy(project.id, worktree.path)).toBe(false);

    releaseCleaner();
    await deletion;
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
    await storage.close();
    store.close();
  });
});
