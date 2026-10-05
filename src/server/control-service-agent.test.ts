import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSnapshot, Worktree } from "@/shared/contracts";
import { ControlService } from "./control-service";
import type { GitWorktreeReader } from "./git-worktrees";
import type { ProcessManager } from "./process-manager";
import { SqliteStateStore } from "./sqlite-store";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ControlService agent claims", () => {
  it("claims and starts a worktree while blocking human runtime operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-agent-service-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({
      name: "Web",
      repositoryPath: "/code/web",
      port: 3216,
      executable: "pnpm",
      args: ["run", "dev"],
    });
    const worktree: Worktree = {
      path: "/code/web-feature",
      head: "abc",
      shortHead: "abc",
      branch: "feature",
      detached: false,
      locked: false,
      prunable: false,
      dirty: false,
    };
    const runtime: RuntimeSnapshot = {
      phase: "stopped",
      pid: null,
      worktreePath: null,
      startedAt: null,
      error: null,
      failure: null,
      logs: [],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    const start = vi.fn(async (_project, path: string) => {
      runtime.phase = "running";
      runtime.worktreePath = path;
    });
    const stop = vi.fn(async () => {
      runtime.phase = "stopped";
      runtime.worktreePath = null;
    });
    const processes = { snapshot: () => ({ ...runtime }), start, stop } as unknown as ProcessManager;
    const git = { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader;
    const service = new ControlService(store, git, processes, undefined,
      { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });

    const claim = await service.claimProject({
      projectId: project.id,
      worktreePath: worktree.path,
      owner: "agent:mcp:session-1",
      reason: "Run tests",
      idempotencyKey: "test-1",
    });
    expect(claim.operationError).toBeNull();
    expect(claim.reservation.worktreePath).toBe(worktree.path);
    expect(start).toHaveBeenCalledOnce();
    await expect(service.operate(project.id, "stop")).rejects.toThrow("agent:mcp:session-1");
    await expect(service.setProjectEnvironment(project.id, { FEATURE_MODE: "local" })).rejects.toThrow("agent:mcp:session-1");
    expect(stop).not.toHaveBeenCalled();

    await service.releaseAgentClaim(project.id, claim.reservation.id, "agent:mcp:session-1", claim.leaseToken);
    await service.operate(project.id, "stop");
    expect(stop).toHaveBeenCalledOnce();
    const recordEvent = store.recordProjectEvent.bind(store);
    vi.spyOn(store, "recordProjectEvent").mockImplementation((projectId, event, owner, details) => {
      if (event === "worktree.launched") throw new Error("fixture database full");
      recordEvent(projectId, event, owner, details);
    });
    for (const operation of ["start", "restart", "switch"] as const) {
      await expect(service.operate(project.id, operation, worktree.path)).resolves.toBeUndefined();
      expect(runtime.phase).toBe("running");
      expect(runtime.worktreePath).toBe(worktree.path);
    }
    expect(store.getProject(project.id)?.selectedWorktreePath).toBe(worktree.path);
    store.close();
  });

  it("starts, restarts, and stops only the exact active agent claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-claimed-runtime-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({ name: "Web", repositoryPath: "/code/web", port: 3220, executable: "pnpm", args: ["run", "dev"] });
    const worktree: Worktree = { path: "/code/web", head: "abc", shortHead: "abc", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
    const runtime: RuntimeSnapshot = {
      phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    let nextPid = 100;
    let spawned = 0;
    let revokeBeforeSpawn = false;
    const start = vi.fn(async (_project, path: string, beforeSpawn?: () => void) => {
      if (revokeBeforeSpawn) store.releaseReservation(project.id, "local-user", true);
      beforeSpawn?.(); spawned += 1; runtime.phase = "running"; runtime.pid = nextPid++; runtime.worktreePath = path; runtime.startedAt = new Date().toISOString();
    });
    const stop = vi.fn(async () => { runtime.phase = "stopped"; runtime.pid = null; runtime.worktreePath = null; runtime.startedAt = null; });
    const service = new ControlService(store, { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader,
      { snapshot: () => ({ ...runtime }), start, stop } as unknown as ProcessManager, undefined,
      { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) });
    store.setServerCapacitySettings({ enabled: true, limit: 1 });
    const claim = await service.claimProject({ projectId: project.id, worktreePath: worktree.path, owner: "agent:mcp:runtime", reason: "Runtime test", idempotencyKey: "claim" });
    const actor = { owner: "agent:mcp:runtime", leaseToken: claim.leaseToken };
    const recordEvent = store.recordProjectEvent.bind(store);
    const audit = vi.spyOn(store, "recordProjectEvent").mockImplementation((projectId, event, owner, details) => {
      if (event === "worktree.launched") throw new Error("fixture database full");
      recordEvent(projectId, event, owner, details);
    });

    const noop = await service.operateClaimedRuntime(project.id, claim.reservation.id, "start", actor);
    expect(noop.outcome).toBe("noop");
    expect(start).toHaveBeenCalledOnce();
    const restarted = await service.operateClaimedRuntime(project.id, claim.reservation.id, "restart", actor);
    expect(restarted).toMatchObject({ outcome: "completed", leaseHeld: true, occupiesCapacity: true, capacity: { limit: 1, used: 1, available: 0 } });
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(project.id, "worktree.launched", `mcp:${createHash("sha256").update(actor.owner).digest("hex").slice(0, 12)}`, { worktreePath: worktree.path });
    expect(audit.mock.calls.some(([, event]) => event === "agent.runtime_failed")).toBe(false);
    const stopped = await service.operateClaimedRuntime(project.id, claim.reservation.id, "stop", actor);
    expect(stopped).toMatchObject({ outcome: "completed", leaseHeld: true, occupiesCapacity: false });
    expect((await service.operateClaimedRuntime(project.id, claim.reservation.id, "stop", actor)).outcome).toBe("noop");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(service.operateClaimedRuntime(project.id, claim.reservation.id, "start", actor, cancelled.signal)).rejects.toThrow("cancelled");
    expect(start).toHaveBeenCalledTimes(2);

    expect((await service.operateClaimedRuntime(project.id, claim.reservation.id, "start", actor)).outcome).toBe("completed");
    expect(spawned).toBe(3);
    revokeBeforeSpawn = true;
    const revoked = await service.operateClaimedRuntime(project.id, claim.reservation.id, "restart", actor);
    expect(revoked).toMatchObject({ outcome: "failed", error: { code: "claim_stale" }, leaseHeld: false, occupiesCapacity: false });
    expect(spawned).toBe(3);
    await expect(service.operateClaimedRuntime(project.id, claim.reservation.id, "start", actor)).rejects.toThrow("stale");
    store.close();
  });

  it("keeps the claim and returns an explicit error when server startup fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-agent-failure-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({
      name: "Broken",
      repositoryPath: "/code/broken",
      port: 3217,
      executable: "pnpm",
      args: ["run", "dev"],
    });
    const worktree: Worktree = {
      path: "/code/broken",
      head: "def",
      shortHead: "def",
      branch: "main",
      detached: false,
      locked: false,
      prunable: false,
      dirty: false,
    };
    const runtime: RuntimeSnapshot = {
      phase: "failed",
      pid: null,
      worktreePath: worktree.path,
      startedAt: null,
      error: "Dependency missing",
      failure: null,
      logs: [],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    const processes = {
      snapshot: () => ({ ...runtime }),
      stop: vi.fn(async () => { runtime.phase = "stopped"; }),
      start: vi.fn(async () => { throw new Error("Dependency missing"); }),
    } as unknown as ProcessManager;
    const service = new ControlService(
      store,
      { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader,
      processes,
    );

    const claim = await service.claimProject({
      projectId: project.id,
      worktreePath: worktree.path,
      owner: "agent:mcp:session-2",
      reason: "Diagnose startup",
      idempotencyKey: "failure-1",
    });
    expect(claim.operationError).toBe("Dependency missing");
    expect(claim.operationErrorCode).toBe("runtime_operation_failed");
    expect(store.getActiveReservation(project.id)?.id).toBe(claim.reservation.id);
    await expect(service.setProjectEnvironment(project.id, { FEATURE_MODE: "local" })).rejects.toThrow("agent:mcp:session-2");
    await expect(service.setProjectEnvironment(project.id, { FEATURE_MODE: "agent" }, {
      owner: "agent:mcp:session-2",
      leaseToken: claim.leaseToken,
    })).resolves.toMatchObject({ environment: { FEATURE_MODE: "agent" } });
    store.close();
  });

  it("serializes an active-profile restart with concurrent operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-profile-restart-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({
      name: "Web",
      repositoryPath: "/code/web",
      port: 3218,
      executable: "pnpm",
      args: ["run", "dev"],
    });
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
    store.setSelectedWorktree(project.id, worktree.path);
    const runtime: RuntimeSnapshot = {
      phase: "running", pid: 123, worktreePath: worktree.path, startedAt: new Date().toISOString(), error: null, failure: null, logs: [],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    const events: string[] = [];
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stop = vi.fn(async () => {
      events.push("stop");
      await stopGate;
      runtime.phase = "stopped";
      runtime.pid = null;
      runtime.worktreePath = null;
    });
    const start = vi.fn(async (startedProject) => {
      events.push(`start:${startedProject.environment.FEATURE_MODE}`);
      runtime.phase = "running";
      runtime.pid = 456;
      runtime.worktreePath = worktree.path;
    });
    const service = new ControlService(
      store,
      { list: vi.fn(async () => [worktree]) } as unknown as GitWorktreeReader,
      { snapshot: () => ({ ...runtime }), start, stop } as unknown as ProcessManager,
      undefined,
      { resolve: () => ({ preset: "node", executable: "pnpm", args: ["run", "dev"], portMethod: "environment", tls: { mode: "off", keyPath: null, certPath: null, caPath: null } }) },
    );

    const profileRestart = service.saveEnvironmentProfile(project.id, "default", { FEATURE_MODE: "new" }, { owner: "local-user" }, true);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const concurrentStart = service.operate(project.id, "start");
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(service.serverCapacity()).toMatchObject({ used: 1, holders: [{ projectId: project.id }] });
    releaseStop();
    await profileRestart;
    await concurrentStart;

    expect(events).toEqual(["stop", "start:new", "start:new"]);
    store.close();
  });

  it("resolves the launch command for the selected worktree before every start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-launch-resolution-"));
    directories.push(directory);
    const store = new SqliteStateStore(join(directory, "state.sqlite3"));
    const project = store.addProject({
      name: "Django",
      repositoryPath: "/code/api",
      port: 8000,
      launchPreset: "django",
      executable: "python3",
      args: ["manage.py", "runserver", "127.0.0.1:8000"],
    });
    const worktrees = ["/code/api-main", "/code/api-feature"].map((path): Worktree => ({
      path,
      head: path,
      shortHead: path,
      branch: path.endsWith("main") ? "main" : "feature",
      detached: false,
      locked: false,
      prunable: false,
      dirty: false,
    }));
    const runtime: RuntimeSnapshot = {
      phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: [],
      resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
    };
    const start = vi.fn(async (_project, path: string) => { runtime.phase = "running"; runtime.worktreePath = path; });
    const stop = vi.fn(async () => { runtime.phase = "stopped"; runtime.worktreePath = null; });
    const resolve = vi.fn((path: string) => ({
      preset: "django" as const,
      executable: path.endsWith("feature") ? "./.venv/bin/python" : "python3",
      args: ["manage.py", "runserver", "127.0.0.1:8000"],
      portMethod: "argument" as const,
      tls: { mode: "off" as const, keyPath: null, certPath: null, caPath: null },
    }));
    const service = new ControlService(
      store,
      { list: vi.fn(async () => worktrees) } as unknown as GitWorktreeReader,
      { snapshot: () => ({ ...runtime }), start, stop } as unknown as ProcessManager,
      undefined,
      { resolve },
    );

    await service.saveEnvironmentProfile(project.id, "staging", {
      DJANGO_SETTINGS_MODULE: "config.settings.staging",
      SWITCHER_TEST_VALUE: "staging",
    });
    await expect(service.setProjectEnvironment(project.id, { PORT: "9000" })).rejects.toThrow("PORT");
    await expect(service.setProjectEnvironment(project.id, { NODE_ENV: "production" })).rejects.toThrow("NODE_ENV");
    await expect(service.setProjectEnvironment(project.id, { NODE_OPTIONS: "--require=/tmp/payload.js" })).rejects.toThrow("NODE_OPTIONS");
    await expect(service.setProjectEnvironment(project.id, { DYLD_INSERT_LIBRARIES: "/tmp/payload.dylib" })).rejects.toThrow("DYLD_INSERT_LIBRARIES");
    await expect(service.setProjectEnvironment(project.id, { "INVALID-NAME": "value" })).rejects.toThrow("INVALID-NAME");
    await expect(service.setProjectEnvironment(project.id, { [`A${"B".repeat(128)}`]: "value" })).rejects.toThrow("Nieprawidłowa nazwa");
    await expect(service.setProjectEnvironment(project.id, Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`VAR_${index}`, "value"])))).rejects.toThrow("maksymalnie 100");
    await expect(service.setProjectEnvironment(project.id, { VALUE: `x${"y".repeat(8192)}` })).rejects.toThrow("Nieprawidłowa wartość");
    await expect(service.setProjectEnvironment(project.id, { VALUE: "bad\0value" })).rejects.toThrow("Nieprawidłowa wartość");
    await expect(service.setProjectEnvironment(project.id, { VALUE: "line1\nline2" })).rejects.toThrow("Nieprawidłowa wartość");
    await expect(service.setProjectEnvironment(project.id, { VALUE: " padded " })).rejects.toThrow("Nieprawidłowa wartość");
    await expect(service.saveEnvironmentProfile(project.id, "bad profile", {})).rejects.toThrow("Nieprawidłowa nazwa profilu");
    await expect(service.deleteEnvironmentProfile(project.id, "default")).rejects.toThrow("default");
    await service.selectEnvironmentProfile(project.id, "staging");
    await expect(service.deleteEnvironmentProfile(project.id, "staging")).rejects.toThrow("aktywnego profilu");
    await service.operate(project.id, "start", worktrees[0].path);
    await expect(service.setProjectEnvironment(project.id, { SWITCHER_TEST_VALUE: "changed" })).rejects.toThrow("Zatrzymaj serwer");
    await expect(service.saveEnvironmentProfile(project.id, "staging", { SWITCHER_TEST_VALUE: "changed" })).rejects.toThrow("restartem");
    await expect(service.selectEnvironmentProfile(project.id, "default")).rejects.toThrow("restartem");
    await service.operate(project.id, "switch", worktrees[1].path);

    expect(resolve.mock.calls.map(([path]) => path)).toEqual(worktrees.map(({ path }) => path));
    expect(start.mock.calls[1][0].executable).toBe("./.venv/bin/python");
    expect(start.mock.calls.map(([startedProject]) => startedProject.environment)).toEqual([
      { DJANGO_SETTINGS_MODULE: "config.settings.staging", SWITCHER_TEST_VALUE: "staging" },
      { DJANGO_SETTINGS_MODULE: "config.settings.staging", SWITCHER_TEST_VALUE: "staging" },
    ]);
    expect(store.getProject(project.id)?.selectedEnvironmentProfile).toBe("staging");
    store.close();
  });
});
