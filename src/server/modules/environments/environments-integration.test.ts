import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlService } from "@/server/control-service";
import type { GitWorktreeReader } from "@/server/git-worktrees";
import { nullLogWriter } from "@/server/log-writer";
import { systemEnvironment } from "@/server/modules/environments";
import type { ProcessManager } from "@/server/process-manager";
import { SqliteStateStore } from "@/server/sqlite-store";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import { TestJobManager } from "@/server/test-job-manager";
import type { RuntimeSnapshot, Worktree } from "@/shared/contracts";

const directories: string[] = [];
const managers: TestJobManager[] = [];
const stores: SqliteStateStore[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function stoppedRuntime(): RuntimeSnapshot {
  return {
    phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [],
    resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
  };
}

function worktreeOf(path: string): Worktree {
  return { path, head: "abcdef123456", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
}

/** Reproduces the WinPath report: a QA server profile selected while unit tests run. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-test-env-"));
  directories.push(directory);
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  stores.push(store);
  const project = store.addProject({ name: "WinPath", repositoryPath: directory, port: 3400, executable: "pnpm", args: ["run", "dev"] });
  store.saveProjectEnvironmentProfile(project.id, {
    name: "qa-shots",
    environment: {
      PLAYWRIGHT_E2E: "1",
      GOOGLE_CALENDAR_E2E_FIXTURES: "1",
      QA_SHOTS_FROZEN_CLOCK_ISO: "2026-01-01T00:00:00.000Z",
    },
  }, "local-user");
  store.selectProjectEnvironmentProfile(project.id, "qa-shots", "local-user");
  const git = { list: vi.fn(async () => [worktreeOf(directory)]), canonicalRepositoryPath: vi.fn(async (path: string) => path) } as unknown as GitWorktreeReader;
  const processes = { snapshot: () => stoppedRuntime(), stop: vi.fn(async () => {}) } as unknown as ProcessManager;
  const testCommands = {
    resolve: vi.fn(() => ({
      preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 10_000 },
      executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify({ names: Object.keys(process.env).sort(), nodeEnv: process.env.NODE_ENV ?? null }))"],
      cwd: directory,
    })),
    discover: vi.fn(() => [{ id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 10_000 }]),
  } as unknown as ProjectTestCommandResolver;
  const tests = new TestJobManager(store, nullLogWriter);
  managers.push(tests);
  const service = new ControlService(store, git, processes, undefined, undefined, undefined, undefined, testCommands, tests);
  return { directory, git, project: store.getProject(project.id)!, store, service, tests };
}

async function childEnvironment(store: SqliteStateStore, runId: string): Promise<{ names: string[]; nodeEnv: string | null }> {
  await vi.waitFor(() => expect(store.getTestRun(runId)?.phase).toBe("passed"), { timeout: 5_000 });
  const line = store.getTestRun(runId)!.logs.find((entry) => entry.startsWith("{"));
  if (!line) throw new Error(`Test child produced no environment dump: ${store.getTestRun(runId)!.logs.join(" | ")}`);
  return JSON.parse(line) as { names: string[]; nodeEnv: string | null };
}

describe("test runs against a selected server profile", () => {
  it("keeps test profile values out of dashboard and project snapshots", async () => {
    const { project, service } = fixture();
    const saved = await service.saveTestEnvironmentProfile(project.id, {
      name: "e2e",
      environment: { DATABASE_PASSWORD: "top-secret" },
    });
    const assigned = await service.assignTestPresetProfile(project.id, "node:test", "e2e");

    const dashboard = await service.dashboard();
    const status = await service.projectSnapshot(project.id);

    expect(dashboard.projects[0].project.testEnvironmentProfiles).toContainEqual(expect.objectContaining({
      name: "e2e",
      variableNames: ["DATABASE_PASSWORD"],
    }));
    expect(JSON.stringify(saved)).not.toContain("top-secret");
    expect(JSON.stringify(assigned)).not.toContain("top-secret");
    expect(JSON.stringify(dashboard)).not.toContain("top-secret");
    expect(JSON.stringify(status)).not.toContain("top-secret");
  });

  it("keeps test profile values out of every project mutation result", async () => {
    const { git, project, service } = fixture();
    await service.saveTestEnvironmentProfile(project.id, {
      name: "e2e",
      environment: { DATABASE_PASSWORD: "top-secret" },
    });

    const otherDirectory = mkdtempSync(join(tmpdir(), "worktree-control-test-env-other-"));
    directories.push(otherDirectory);
    writeFileSync(join(otherDirectory, "package.json"), JSON.stringify({ name: "other", scripts: { dev: "node server.js" } }));
    (git.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([worktreeOf(otherDirectory)]);
    const added = await service.addProject({
      name: "Other", repositoryPath: otherDirectory, port: 3401, launchPreset: "auto",
    });
    const environmentSet = await service.setProjectEnvironment(project.id, { APP_FLAG: "1" });
    const profileSaved = await service.saveEnvironmentProfile(project.id, "staging", { APP_FLAG: "1" });
    const profileSelected = await service.selectEnvironmentProfile(project.id, "staging");
    await service.selectEnvironmentProfile(project.id, "qa-shots");
    const profileDeleted = await service.deleteEnvironmentProfile(project.id, "staging");
    const removed = await service.removeProject(project.id);

    for (const result of [added, environmentSet, profileSaved, profileSelected, profileDeleted, removed]) {
      expect(JSON.stringify(result)).not.toContain("top-secret");
    }
    expect(removed.id).toBe(project.id);
  });

  it("protects built-in and assigned test profiles from mutation or deletion", async () => {
    const { project, service } = fixture();
    await expect(service.saveTestEnvironmentProfile(project.id, {
      name: "unit", environment: {}, nodeEnv: null,
    })).rejects.toThrow("nie można zastąpić");
    await expect(service.deleteTestEnvironmentProfile(project.id, "unit")).rejects.toThrow("nie można usunąć");

    await service.saveTestEnvironmentProfile(project.id, { name: "custom", environment: {} });
    await service.assignTestPresetProfile(project.id, "node:test", "custom");
    await expect(service.deleteTestEnvironmentProfile(project.id, "custom")).rejects.toThrow("node:test");
  });

  it("protects server profiles referenced by inheriting test profiles", async () => {
    const { project, service, store } = fixture();
    await service.saveTestEnvironmentProfile(project.id, {
      name: "e2e", environment: {}, mode: "inherit-server-profile", serverProfile: "qa-shots",
    });
    store.selectProjectEnvironmentProfile(project.id, "default", "local-user");

    await expect(service.deleteEnvironmentProfile(project.id, "qa-shots")).rejects.toThrow("e2e");
  });

  it("reports the locale wildcard alongside fixed system variable names", () => {
    const { project, service } = fixture();
    expect(service.testEnvironmentProfiles(project.id).systemVariableNames).toContain("LC_*");
  });

  it("runs the default unit preset without the selected server profile or controller variables", async () => {
    vi.stubEnv("WINPATH_CONTROLLER_SECRET", "leaked");
    const { store, project, service } = fixture();

    const run = await service.enqueueTest(project.id, project.repositoryPath, "node:test");
    const child = await childEnvironment(store, run.id);

    expect(child.names).not.toContain("PLAYWRIGHT_E2E");
    expect(child.names).not.toContain("GOOGLE_CALENDAR_E2E_FIXTURES");
    expect(child.names).not.toContain("QA_SHOTS_FROZEN_CLOCK_ISO");
    expect(child.names).not.toContain("WINPATH_CONTROLLER_SECRET");
    expect(child.nodeEnv).toBe("test");
    // The whole environment is accounted for; nothing undeclared survives.
    expect(child.names).toEqual([...new Set([
      ...Object.keys(systemEnvironment()),
      "NODE_ENV",
      ...["", "_PROJECT_ID", "_SERVER_PORT", "_SERVER_URL", "_TEST_PROFILE", "_WORKTREE_PATH"]
        .flatMap((suffix) => [`WORKTREE_CONTROL${suffix}`, `WORKTREE_SWITCHER${suffix}`]),
    ])].sort());
    const stored = store.getTestRun(run.id)!;
    expect(stored.environmentMode).toBe("clean");
    expect(stored.environmentProfile).toBe("unit");
    expect(stored.inheritedServerProfile).toBeNull();
    expect(stored.environmentVariableNames).toEqual(child.names);
  });

  it("passes the server profile to a preset that explicitly opts in", async () => {
    const { store, project, service } = fixture();
    await service.saveTestEnvironmentProfile(project.id, {
      name: "e2e",
      environment: { E2E_RESET_DB_CONFIRM: "winpath_test" },
      mode: "inherit-server-profile",
      serverProfile: "qa-shots",
      nodeEnv: null,
      requiredVariables: ["PLAYWRIGHT_E2E"],
    });
    await service.assignTestPresetProfile(project.id, "node:test", "e2e");

    const run = await service.enqueueTest(project.id, project.repositoryPath, "node:test");
    const child = await childEnvironment(store, run.id);

    expect(child.names).toContain("PLAYWRIGHT_E2E");
    expect(child.names).toContain("E2E_RESET_DB_CONFIRM");
    expect(child.nodeEnv).toBeNull();
    const stored = store.getTestRun(run.id)!;
    expect(stored.environmentMode).toBe("inherit-server-profile");
    expect(stored.inheritedServerProfile).toBe("qa-shots");
  });

  it("keeps the queued result independent of which server profile is selected", async () => {
    const { store, project, service } = fixture();
    const before = await service.enqueueTest(project.id, project.repositoryPath, "node:test");
    const withQaProfile = await childEnvironment(store, before.id);

    store.saveProjectEnvironmentProfile(project.id, { name: "default", environment: {} }, "local-user");
    store.selectProjectEnvironmentProfile(project.id, "default", "local-user");
    const after = await service.enqueueTest(project.id, project.repositoryPath, "node:test");

    expect((await childEnvironment(store, after.id)).names).toEqual(withQaProfile.names);
  });

  it("rejects a test profile that inherits without naming a server profile", async () => {
    const { project, service } = fixture();
    await expect(service.saveTestEnvironmentProfile(project.id, {
      name: "broken", environment: {}, mode: "inherit-server-profile", serverProfile: null,
    })).rejects.toThrow("jawnej nazwy profilu serwera");
  });
});
