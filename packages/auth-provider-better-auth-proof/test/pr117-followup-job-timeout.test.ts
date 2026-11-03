import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestJobManager } from "@/server/test-job-manager";
import { OwnedProcessGroup } from "@/server/owned-process-group";
import { nullLogWriter } from "@/server/log-writer";
import type { RemoteAssignment } from "@/shared/contracts/remote-verification";
import { readCommitted } from "./fixture";
import { cleanupStrictRoots, closeStrictProof, gate, strictProof } from "./strict-fixture";

// Use the actual queue, timeout callback, provider gate and durable receipt.
// Only process creation and termination are replaced.
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => Object.assign(new EventEmitter(), { stdout: null, stderr: null, pid: undefined, exitCode: null, signalCode: null })) }));
afterEach(() => { vi.restoreAllMocks(); cleanupStrictRoots(); });

describe("remote job timeout while spawn evidence waits for admission", () => {
  it("stops before admission, retaining the slot and finalization barrier until started evidence is durable", async () => {
    const f = await strictProof();
    const jobs = await f.run(() => new TestJobManager(f.store, nullLogWriter));
    const borrowed = gate(), release = gate();
    let hold: Promise<unknown> | undefined;
    const order: string[] = [];
    const timers = vi.spyOn(globalThis, "setTimeout");
    const timeoutMs = 123_456;
    vi.mocked(spawn).mockClear();
    const stop = vi.spyOn(OwnedProcessGroup.prototype, "stop").mockImplementation(async () => {
      order.push("stop");
      // OS exit events are asynchronous relative to initiating a stop.
      await Promise.resolve();
      const child = vi.mocked(spawn).mock.results[0]!.value;
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM");
    });
    const assignment: RemoteAssignment = { requestId: "request", attemptId: "attempt", projectId: "remote-project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40) };
    const started = vi.fn(() => {
      const receipt = f.store.remoteConnection.receipt(assignment.attemptId)!;
      receipt.reports.push({ attemptId: assignment.attemptId, localRunId: "local-run", sequence: 2, phase: "running" });
      f.store.remoteConnection.saveReceipt(receipt);
      order.push("started");
    });
    const dispose = vi.fn(async () => { order.push("dispose"); });
    try {
      const project = await f.run(() => {
        jobs.setLimit(1);
        f.store.remoteConnection.accept({ assignment, localRunId: "local-run", cancellationRequested: false,
          reports: [{ attemptId: assignment.attemptId, localRunId: "local-run", sequence: 1, phase: "preparing" }], acknowledgedSequence: 0 });
        return f.store.addProject({ name: "remote timeout", repositoryPath: f.root, port: 3899, executable: "", args: [], launchPreset: "none" });
      });
      const worktree = { path: f.root, head: assignment.commitSha, shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
      const command = { preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs }, executable: process.execPath, args: [], cwd: f.root };
      const environment = { environment: {}, mode: "clean" as const, profile: "unit", inheritedServerProfile: null, variableNames: [] };
      await f.run(() => jobs.enqueue({ runId: "local-run", projectId: project.id, worktree, command, environment, actor: "remote-worker:worker",
        preparation: { prepare: async () => ({ worktree, command, environment }), started, dispose } }));
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      hold = f.store.authenticationProviderStorage().borrow(async () => { borrowed.open(); await release.opened; });
      await borrowed.opened;
      const child = vi.mocked(spawn).mock.results[0]!.value;
      child.emit("spawn");
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThan(0));
      const timeout = timers.mock.calls.find(([, delay]) => delay === timeoutMs)?.[0];
      expect(timeout).toBeTypeOf("function");
      (timeout as () => void)();
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      expect(started).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect((jobs as unknown as { active: Map<string, unknown> }).active.has("local-run")).toBe(true);
      expect(readCommitted(f.path, db => db.prepare("SELECT phase FROM test_runs WHERE id = ?").get("local-run"))).toEqual({ phase: "running" });
      release.open(); await hold;
      await vi.waitFor(async () => expect((await f.run(() => f.store.getTestRun("local-run")))?.phase).toBe("timed_out"));
      expect(order).toEqual(["stop", "started", "dispose"]);
      expect(started).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
      expect(await f.run(() => f.store.remoteConnection.receipt("attempt")!.reports.map(report => report.phase))).toEqual(["preparing", "running"]);
      expect(await f.run(() => jobs.status().running)).toBe(0);
      expect(await f.run(() => f.store.getTestRun("local-run"))).toMatchObject({ phase: "timed_out", telemetry: { cleanup: "confirmed", termination: "timeout" } });
    } finally {
      release.open(); await hold;
      await jobs.shutdown(); await closeStrictProof(f);
    }
  });
});
