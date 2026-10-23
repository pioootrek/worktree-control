import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogWriter } from "@/server/log-writer";
import { SqliteStateStore } from "@/server/sqlite-store";
import { ProjectTestCommandResolver } from "@/server/test-command";
import { TestJobManager } from "@/server/test-job-manager";
import type { TestRun, Worktree } from "@/shared/contracts";
import { ProjectLifecycle } from "../lifecycle";
import { VerificationService, type EnqueueTestInput } from "./index";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(realJobs = false) {
  const root = mkdtempSync(join(tmpdir(), "wtc-timeout-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(root, "state.sqlite3"));
  cleanups.push(() => store.close());
  store.setTestQueueSettings({ limit: 2 });
  const paths = ["first", "branch", "second"].map((name) => join(root, name));
  for (const path of paths) {
    mkdirSync(join(path, "scripts"), { recursive: true });
    writeFileSync(join(path, "project.godot"), "");
    // A finite test of the controller's timeout, without invoking Godot or host runners.
    writeFileSync(join(path, "scripts/project.sh"), 'exec node -e "setInterval(() => {}, 1000)"\n');
  }
  const worktrees: Worktree[] = paths.map((path) => ({ path, branch: "main", head: "abc123", shortHead: "abc123", detached: false, locked: false, prunable: false, dirty: false }));
  const projects = [paths[0], paths[2]].map((repositoryPath, i) => store.addProject({ name: `Project ${i}`, repositoryPath, port: 3500 + i, launchPreset: "none", executable: "", args: [] }));
  const lifecycle = new ProjectLifecycle(store, { snapshot: vi.fn() });
  const commands = new ProjectTestCommandResolver();
  const enqueue = vi.fn((input: EnqueueTestInput) => ({ id: "queued", ...input } as unknown as TestRun));
  const jobs = realJobs ? new TestJobManager(store, nullLogWriter) : { enqueue, cancel: vi.fn(), status: () => ({ limit: 2, running: 0, queued: 0 }), setLimit: vi.fn() };
  if (realJobs) cleanups.push(() => (jobs as TestJobManager).shutdown());
  const service = new VerificationService(store, { list: async (path) => path === paths[0] ? worktrees.slice(0, 2) : worktrees.slice(2) }, nullLogWriter, commands, lifecycle, jobs);
  return { root, store, service, projects, paths, enqueue };
}

describe("project preset timeouts", () => {
  it("keeps 15-minute defaults, isolates projects/presets, covers all worktrees, and snapshots enqueue policy", async () => {
    const { store, service, projects: [project, other], paths, enqueue } = fixture();
    const presets = (id: string, path: string) => service.discoverPresets(store.getProject(id)!, path).presets;
    expect(presets(project.id, paths[0]).map(p => p.timeoutMs)).toEqual([900_000, 900_000]);
    const original = store.getProject(project.id)!;
    await service.setTestPresetTimeout(project.id, "godot:check", 1_800_000);
    for (const path of paths.slice(0, 2)) {
      expect(presets(project.id, path).map(p => p.timeoutMs)).toEqual([1_800_000, 900_000]);
      await service.enqueueTest(project.id, path, "godot:check");
      expect(enqueue.mock.lastCall![0].command.preset.timeoutMs).toBe(1_800_000);
    }
    expect(presets(other.id, paths[2]).map(p => p.timeoutMs)).toEqual([900_000, 900_000]);
    const queued = enqueue.mock.lastCall![0];
    await service.setTestPresetTimeout(project.id, "godot:check", null);
    expect(presets(project.id, paths[0]).map(p => p.timeoutMs)).toEqual([900_000, 900_000]);
    expect(queued.command.preset.timeoutMs).toBe(1_800_000);
    await service.enqueueTest(project.id, paths[0], "godot:check");
    expect(enqueue.mock.lastCall![0].command.preset.timeoutMs).toBe(900_000);
    expect(store.getProject(project.id)).toEqual({ ...original, updatedAt: expect.any(String) });
    expect(store.getTestQueueSettings()).toEqual({ limit: 2 });
  });

  it("persists overrides on reopen, resets one preset only, and redacts profile values", async () => {
    const { root, store, service, projects: [project] } = fixture();
    store.saveProjectTestEnvironmentProfile(project.id, { name: "private", environment: { SECRET: "hidden-value" }, nodeEnv: null, requiredVariables: [], policy: { mode: "clean", serverProfile: null } }, "local-user");
    await service.setTestPresetTimeout(project.id, "godot:export-macos", 600_000);
    const view = await service.setTestPresetTimeout(project.id, "godot:check", 1_800_000);
    expect(JSON.stringify(view)).not.toContain("hidden-value");
    await service.setTestPresetTimeout(project.id, "godot:export-macos", null);
    store.close();
    const reopened = new SqliteStateStore(join(root, "state.sqlite3"));
    try { expect(reopened.getProject(project.id)!.testPresetTimeouts).toEqual({ "godot:check": 1_800_000 }); }
    finally { reopened.close(); }
  });

  it("rejects invalid values and reservation conflicts without changing policy", async () => {
    const { store, service, projects: [project], paths } = fixture();
    for (const timeout of [0, -1, 0.1, NaN, Infinity, 86_400_001, undefined, "1800000"]) {
      await expect(service.setTestPresetTimeout(project.id, "godot:check", timeout as number)).rejects.toThrow();
    }
    await expect(service.setTestPresetTimeout(project.id, "__proto__", 1000)).rejects.toThrow();
    store.acquireReservation({ projectId: project.id, worktreePath: paths[0], kind: "human", owner: "someone-else" });
    await expect(service.setTestPresetTimeout(project.id, "godot:check", 1000, { owner: "agent:test" })).rejects.toThrow();
    expect(store.getProject(project.id)!.testPresetTimeouts).toEqual({});
  });

  it("enforces the configured timeout and confirms cleanup of a real queued process", async () => {
    const { store, service, projects: [project], paths } = fixture(true);
    await service.setTestPresetTimeout(project.id, "godot:check", 100);
    const run = await service.enqueueTest(project.id, paths[0], "godot:check");
    await vi.waitFor(() => expect(store.getTestRun(run.id)?.phase).toBe("timed_out"), { timeout: 5000 });
    expect(store.getTestRun(run.id)?.telemetry).toMatchObject({ termination: "timeout", cleanup: "confirmed" });
  });
});
