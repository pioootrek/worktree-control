import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, Reservation } from "@/shared/contracts";
import type { ScopedProjectStatus } from "@/shared/contracts/runtime-access";
import { directAdmission } from "@/server/database-admission";
import { StatusService } from "./status-service";

const project = {
  id: "09ca1e75-1f7a-4bb5-a607-a0af3a785260", name: "Web", port: 3000,
  selectedWorktreePath: "/code/web", repositoryPath: "/private/repository",
  environment: { SECRET: "do-not-leak" },
} as unknown as Project;

function fixture(reservation: Reservation | null = null, onResume = () => {}) {
  let phase: "stopped" | "running" = "stopped";
  let globalUsed = 0;
  let globalRunning = 0;
  const store = {
    admission: { ...directAdmission, idle: async <T>(operation: () => Promise<T>) => {
      const result = await operation();
      onResume();
      return result;
    } },
    getProject: vi.fn(() => project),
    getEffectiveReservation: vi.fn(() => reservation),
    getTestRunStatus: vi.fn(() => ({
      id: "run", projectId: project.id, presetId: "node:test", worktreePath: "/code/web",
      worktreeHead: "queued-head", worktreeBranch: "main", worktreeDirty: false,
      phase: "passed" as const, queuePosition: null, queuedAt: "2026-09-08T00:00:00.000Z",
      startedAt: "2026-09-08T00:00:01.000Z", finishedAt: "2026-09-08T00:00:02.000Z",
      exitCode: 0, signal: null, error: null,
      source: {
        version: 1 as const, scope: "git-observations" as const,
        enqueue: { observedAt: "2026-09-08T00:00:00.000Z", head: "queued-head", branch: "main", dirty: false, statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null },
        preflight: { observedAt: "2026-09-08T00:00:01.000Z", head: "execution-head", branch: "main", dirty: false, statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null },
        finish: { observedAt: "2026-09-08T00:00:02.000Z", head: "execution-head", branch: "main", dirty: false, statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null },
        queueComparison: "match" as const, executionComparison: "match" as const,
        attribution: "observed_match" as const, reasonCodes: [], processOutcome: "passed" as const,
      },
    })),
    countTestRuns: vi.fn(() => 0),
    getTestQueueSettings: vi.fn(() => ({ limit: 1 })),
  };
  const processes = {
    statusSummary: vi.fn(() => ({ phase, worktreePath: phase === "running" ? "/code/web" : null, startedAt: null, failureCode: null, ownsProcess: phase === "running" })),
    logTail: vi.fn((_projectId: string, limit: number) => ({ lines: ["a", "b", "secret-ish detail"].slice(-limit), retainedLines: 3, truncated: limit < 3 })),
  };
  const service = new StatusService(store, processes,
    () => ({ enabled: true, limit: 2, used: globalUsed, available: 2 - globalUsed, holders: [] }),
    () => ({ limit: 1, running: globalRunning, queued: 0 }));
  return {
    service, store, processes,
    setPhase(value: "stopped" | "running") { phase = value; },
    setGlobalCounts(value: number) { globalUsed = value; globalRunning = value; },
  };
}

afterEach(() => vi.useRealTimers());

describe("StatusService", () => {
  const safeStatus: ScopedProjectStatus = { id: project.id, name: "Web", port: 3000, actions: ["projects:read"],
    phase: "stopped", worktreePath: null, claim: "none", selectedWorktreePath: null, startedAt: null, managedServer: true, ownClaim: null };

  it.each(["change", "timeout"])("refuses a scoped %s result revoked while completion waits for re-admission", async outcome => {
    vi.useFakeTimers();
    let active = true;
    const { service } = fixture(null, () => { active = false; });
    const status = { ...safeStatus };
    const target = { kind: "scoped-project" as const, id: project.id, read: () => {
      if (!active) throw new Error("revoked");
      return service.scopedProject(status, "credential-session");
    } };
    const cursor = target.read().cursor;
    const waiting = service.wait(target, cursor, "session", outcome === "change" ? 10_000 : 50);
    const denied = expect(waiting).rejects.toThrow("revoked");
    if (outcome === "change") status.phase = "running";
    await vi.advanceTimersByTimeAsync(outcome === "change" ? 1_000 : 50);
    await denied;
    expect(service.diagnostics()).toEqual({ waiters: 0, targets: 0, waiterTimers: 0, samplerTimers: 0 });
    service.close();
  });

  it("shares budgets with installation waits but never shares a scoped reader's authority or raw observation", async () => {
    vi.useFakeTimers();
    const { service, store, processes } = fixture();
    let active = true;
    const one = { kind: "scoped-project" as const, id: project.id, read: () => {
      if (!active) throw new Error("revoked");
      return service.scopedProject(safeStatus, "one");
    } };
    const two = { kind: "scoped-project" as const, id: project.id, read: () => service.scopedProject(safeStatus, "two") };
    const waits = [service.wait(one, one.read().cursor, "session"),
      ...Array.from({ length: 3 }, () => service.wait(two, two.read().cursor, "session"))];
    const firstDenied = expect(waits[0]).rejects.toThrow("revoked");
    active = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await firstDenied;
    expect(service.diagnostics().waiters).toBe(3);
    expect(store.getProject).not.toHaveBeenCalled();
    expect(store.countTestRuns).not.toHaveBeenCalled();
    expect(processes.statusSummary).not.toHaveBeenCalled();
    const installation = service.project(project.id, "session");
    const final = service.wait({ kind: "project", id: project.id }, installation.cursor, "session");
    await expect(service.wait(two, two.read().cursor, "session")).resolves.toMatchObject({ errorCode: "status_wait_busy" });
    const settled = Promise.allSettled([...waits.slice(1), final]);
    service.cancelSession("session");
    await settled;
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });

  it("returns an allowlisted stable compact project projection", () => {
    const reservation = {
      id: "reservation", projectId: project.id, worktreePath: "/code/web", kind: "agent",
      owner: "agent:mcp:raw-session", reason: "private reason", createdAt: "2026-09-08T00:00:00.000Z",
      expiresAt: "2099-09-08T00:00:00.000Z", maximumExpiresAt: "2099-09-08T01:00:00.000Z",
    } as Reservation;
    const { service } = fixture(reservation);
    const first = service.project(project.id, "agent:mcp:raw-session");
    const second = service.project(project.id, "agent:mcp:raw-session");
    expect(first.cursor).toBe(second.cursor);
    expect(first.status.reservation).toMatchObject({ ownerRelation: "self", ownerLabel: expect.stringMatching(/^agent-/) });
    expect(JSON.stringify(first)).not.toContain("raw-session");
    expect(JSON.stringify(first)).not.toContain("private reason");
    expect(JSON.stringify(first)).not.toContain("do-not-leak");
    service.close();
  });

  it("waits for meaningful state and tears down on change", async () => {
    vi.useFakeTimers();
    const { service, setPhase } = fixture();
    const current = service.project(project.id, "session");
    const waiting = service.wait({ kind: "project", id: project.id }, current.cursor, "session", 10_000);
    setPhase("running");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toMatchObject({ changed: true, result: { status: { runtimePhase: "running" } } });
    service.close();
  });

  it("does not change a project cursor for unrelated global usage", () => {
    const { service, setGlobalCounts } = fixture();
    const first = service.project(project.id, "session");
    setGlobalCounts(1);
    const second = service.project(project.id, "session");
    expect(second.status.serverCapacity.used).toBe(1);
    expect(second.status.testQueue.running).toBe(1);
    expect(second.cursor).toBe(first.cursor);
    service.close();
  });

  it("times out quietly and releases its timer", async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    const current = service.project(project.id, "session");
    const waiting = service.wait({ kind: "project", id: project.id }, current.cursor, "session", 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(waiting).resolves.toMatchObject({ changed: false, cursor: current.cursor });
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });

  it("cleans up already-aborted and subsequently cancelled waits", async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    const current = service.project(project.id, "session");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(service.wait({ kind: "project", id: project.id }, current.cursor, "session", 10_000, alreadyAborted.signal))
      .rejects.toThrow("STATUS_WAIT_CANCELLED");
    expect(vi.getTimerCount()).toBe(0);

    const controller = new AbortController();
    const waiting = service.wait({ kind: "project", id: project.id }, current.cursor, "session", 10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("STATUS_WAIT_CANCELLED");
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });

  it("rejects outstanding waits on close and releases limits", async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    const current = service.project(project.id, "session");
    const waiting = service.wait({ kind: "project", id: project.id }, current.cursor, "session", 10_000);
    service.close();
    await expect(waiting).rejects.toThrow("STATUS_CLOSED");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up when the post-registration recheck fails", async () => {
    vi.useFakeTimers();
    const { service, store } = fixture();
    const current = service.project(project.id, "session");
    store.getProject
      .mockImplementationOnce(() => project)
      .mockImplementationOnce(() => { throw new Error("query failed"); });
    await expect(service.wait({ kind: "project", id: project.id }, current.cursor, "session", 10_000))
      .rejects.toThrow("query failed");
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });

  it("bounds waits per session without retaining the rejected waiter", async () => {
    vi.useFakeTimers();
    const { service } = fixture();
    const current = service.project(project.id, "session");
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const waits = controllers.map((controller) => service.wait(
      { kind: "project", id: project.id }, current.cursor, "session", 10_000, controller.signal,
    ));
    await expect(service.wait({ kind: "project", id: project.id }, current.cursor, "session", 10_000))
      .resolves.toMatchObject({ changed: false, errorCode: "status_wait_busy", retryAfterMs: 2_000 });
    controllers.forEach((controller) => controller.abort());
    await Promise.allSettled(waits);
    expect(vi.getTimerCount()).toBe(0);
    service.close();
  });

  it("shares one target projection per sampling tick", async () => {
    vi.useFakeTimers();
    const { service, store, processes } = fixture();
    const first = service.project(project.id, "session-a");
    const waits = ["session-a", "session-b"].map((session) => service.wait(
      { kind: "project", id: project.id }, first.cursor, session, 10_000,
    ));
    store.getProject.mockClear();
    processes.statusSummary.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getProject).toHaveBeenCalledOnce();
    expect(processes.statusSummary).toHaveBeenCalledOnce();
    service.close();
    await Promise.allSettled(waits);
  });

  it("projects bounded execution source evidence without logs", () => {
    const { service } = fixture();
    const result = service.test("run");
    expect(result.status.source).toEqual({
      queuedHead: "queued-head", preflightHead: "execution-head", finishHead: "execution-head",
      attribution: "observed_match", queueComparison: "match", executionComparison: "match",
      processOutcome: "passed", reasonCodes: [],
    });
    expect(Buffer.byteLength(JSON.stringify(result, null, 2), "utf8")).toBeLessThan(16 * 1024);
    service.close();
  });

  it("bounds explicit runtime log tails", () => {
    const { service, processes } = fixture();
    expect(service.logs(project.id, 2)).toMatchObject({ lines: ["b", "secret-ish detail"], retainedLines: 3, truncated: true });
    expect(processes.logTail).toHaveBeenCalledWith(project.id, 2);
    service.close();
  });

  it("bounds runtime logs after JSON escaping", () => {
    const { service, processes } = fixture();
    processes.logTail.mockReturnValue({ lines: ["\u0000".repeat(4_000)], retainedLines: 1, truncated: false });
    const result = service.logs(project.id, 1);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(result.truncated).toBe(true);
    service.close();
  });
});

it("reports owned waiter timers and the shared sampler until settlement", async () => {
  const { service } = fixture();
  const current = service.project(project.id, "session");
  const abort = new AbortController();
  const waiting = service.wait({ kind: "project", id: project.id }, current.cursor, "session", 20000, abort.signal);
  expect(service.diagnostics()).toEqual({ waiters: 1, targets: 1, samplerTimers: 1, waiterTimers: 1 });
  expect(service.diagnostics("session")).toEqual({ waiters: 1, waiterTimers: 1 });
  expect(service.diagnostics("another-session")).toEqual({ waiters: 0, waiterTimers: 0 });
  abort.abort();
  await expect(waiting).rejects.toThrow("STATUS_WAIT_CANCELLED");
  expect(service.diagnostics()).toEqual({ waiters: 0, targets: 0, samplerTimers: 0, waiterTimers: 0 });
  expect(service.diagnostics("session")).toEqual({ waiters: 0, waiterTimers: 0 });
  service.close();
});
