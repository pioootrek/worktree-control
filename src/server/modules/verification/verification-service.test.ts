import { describe, expect, it, vi } from "vitest";

import type { Project, TestRun, Worktree } from "@/shared/contracts";
import { BUILT_IN_TEST_PROFILES } from "../environments";
import { ProjectLifecycle } from "../lifecycle";
import { VerificationService } from "./index";
import { legacySourceEvidence } from "@/server/test-source-attribution";

function fixture() {
  const worktree: Worktree = {
    path: "/fixture/web", branch: "main", head: "abcdef123456", shortHead: "abcdef1",
    detached: false, locked: false, prunable: false, dirty: false,
  };
  const project: Project = {
    id: "web", name: "Web", repositoryPath: worktree.path, port: 3000,
    launchPreset: "node", tlsMode: "off", tlsKeyPath: null, tlsCertPath: null, tlsCaPath: null,
    executable: "pnpm", args: ["run", "dev"], environment: { SERVER_ONLY: "server-value" },
    environmentProfiles: [{ name: "default", environment: { SERVER_ONLY: "server-value" } }],
    selectedEnvironmentProfile: "default", testEnvironmentProfiles: [...BUILT_IN_TEST_PROFILES],
    testPresetProfiles: {}, testPresetTimeouts: {}, healthcheckPath: "/", startupTimeoutMs: 30_000,
    selectedWorktreePath: worktree.path, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const run: TestRun = {
    id: "run-1", projectId: project.id, worktreePath: worktree.path, worktreeHead: worktree.head,
    worktreeBranch: worktree.branch, worktreeDirty: false, presetId: "node:test", presetName: "test",
    adapter: "node", actor: "agent:test", phase: "queued", queuePosition: 1,
    executable: "pnpm", args: ["run", "test"], cwd: worktree.path, queuedAt: project.createdAt,
    startedAt: null, finishedAt: null, exitCode: null, signal: null, error: null, logs: [],
    environmentMode: "clean", environmentProfile: "unit", inheritedServerProfile: null, environmentVariableNames: [], source: legacySourceEvidence(),
  };
  const authorize = vi.fn(() => null);
  const lifecycle = new ProjectLifecycle({
    getProject: () => project, listProjects: () => [project], authorizeReservation: authorize,
    getServerCapacitySettings: () => ({ enabled: false, limit: 2 }),
  }, { snapshot: vi.fn() });
  const resolve = vi.fn(() => ({
    preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 30_000 },
    executable: "pnpm", args: ["run", "test"], cwd: worktree.path,
  }));
  const enqueue = vi.fn(() => run);
  const log = vi.fn();
  const service = new VerificationService(
    { getTestQueueSettings: () => ({ limit: 1 }), countTestRuns: () => 0, getTestRun: () => null, setProjectTestPresetTimeout: vi.fn() },
    { list: async () => [worktree] },
    { controller: log },
    { resolve, discover: () => [resolve().preset] },
    lifecycle,
    { enqueue, cancel: vi.fn(), status: () => ({ limit: 1, running: 0, queued: 0 }), setLimit: vi.fn() },
  );
  return { service, project, worktree, enqueue, authorize, resolve, log };
}

describe("verification admission without a controller or database", () => {
  it("resolves an exact discovered target and submits a clean profile with actor and idempotency", async () => {
    const { service, project, worktree, enqueue, log } = fixture();
    await service.enqueueTest(project.id, worktree.path, "node:test", { owner: "agent:test" }, "request-1");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project.id, worktree, actor: "agent:test", idempotencyKey: "request-1",
      environment: expect.objectContaining({ mode: "clean", profile: "unit", inheritedServerProfile: null, environment: expect.objectContaining({ NODE_ENV: "test" }) }),
    }));
    expect(JSON.stringify(enqueue.mock.calls)).not.toContain("SERVER_ONLY");
    expect(JSON.stringify(log.mock.calls)).not.toContain("server-value");
  });

  it("rejects reservation conflicts before resolving a command or submitting a job", async () => {
    const { service, project, worktree, enqueue, authorize, resolve } = fixture();
    authorize.mockImplementationOnce(() => { throw new Error("reserved by another owner"); });
    await expect(service.enqueueTest(project.id, worktree.path, "node:test")).rejects.toThrow("reserved by another owner");
    expect(resolve).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
