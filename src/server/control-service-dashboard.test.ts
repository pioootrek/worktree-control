import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Worktree } from "@/shared/contracts";
import { ControlService } from "./control-service";
import { EventStream } from "./events";
import type { GitWorktreeReader } from "./git-worktrees";
import { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";
import { ProjectTestCommandResolver } from "./test-command";
import type { WorktreeStorageManager } from "./worktree-storage";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ControlService dashboard projection", () => {
  it("keeps noisy dashboard reads cached but refreshes detailed agent snapshots", async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-dashboard-amplification-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const projects = Array.from({ length: 2 }, (_, index) => store.addProject({
      name: `P${index}`,
      repositoryPath: `/repo/${index}`,
      port: 3300 + index,
      executable: "pnpm",
      args: [],
    }));
    const list = vi.fn(async (repositoryPath: string) => Array.from({ length: 3 }, (_, index): Worktree => ({
      path: `${repositoryPath}/${index}`,
      head: "abcdef123456",
      shortHead: "abcdef12",
      branch: "main",
      detached: false,
      locked: false,
      prunable: false,
      dirty: false,
    })));
    const git = { list } as unknown as GitWorktreeReader;
    const ensureFresh = vi.fn();
    const storage = { ensureFresh, snapshots: vi.fn(() => []), assertLifecycle: vi.fn() } as unknown as WorktreeStorageManager;
    const testCommands = new ProjectTestCommandResolver();
    const discover = vi.spyOn(testCommands, "discover").mockReturnValue([]);
    const service = new ControlService(store, git, new ProcessManager(), undefined, undefined, storage, undefined, testCommands);
    const events = new EventStream();
    const requests: Array<Promise<unknown>> = [];
    for (let client = 0; client < 3; client += 1) {
      const response = new EventEmitter();
      Object.assign(response, {
        write: (message: string) => {
          if (message.startsWith("event: changed")) requests.push(service.dashboard());
          return true;
        },
        end: () => response.emit("close"),
      });
      events.add(response as unknown as ServerResponse);
    }

    events.publish({ kinds: ["runtime"] });
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all(requests);
    expect(list).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledTimes(6);
    expect(ensureFresh).toHaveBeenCalledTimes(2);

    requests.length = 0;
    await vi.advanceTimersByTimeAsync(31_000);
    for (let index = 0; index < 4; index += 1) {
      events.publish({ kinds: ["runtime"] });
      await vi.advanceTimersByTimeAsync(250);
    }
    await Promise.all(requests);
    expect(requests).toHaveLength(12);
    expect(list).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledTimes(6);
    expect(ensureFresh).toHaveBeenCalledTimes(2);

    const addedWorktree: Worktree = {
      path: "/repo/0/added",
      head: "fedcba654321",
      shortHead: "fedcba65",
      branch: "added",
      detached: false,
      locked: false,
      prunable: false,
      dirty: false,
    };
    list.mockResolvedValueOnce([addedWorktree]);
    const detailed = await service.projectSnapshot(projects[0].id);
    expect(detailed.worktrees).toEqual([addedWorktree]);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenLastCalledWith("/repo/0", { priority: "operational", includeInsights: true });

    events.close();
    store.close();
  });
});
