import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { EnqueueTestInput } from "@/server/modules/verification";
import type { RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import type { TestRun } from "@/shared/contracts";
import { emptyTelemetry } from "@/server/modules/verification";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { SqliteStateStore } from "@/server/sqlite-store";
import { IdentityService } from "@/server/modules/identity";
import { remoteReportSchema, type RemoteAssignment } from "@/shared/contracts/remote-verification";
import { RemoteVerificationController } from "./remote-verification-controller";
import { RemoteVerificationWorker } from "./remote-worker";
import type { WorkerReceipt } from "./connection-contracts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-remote-restart-")); roots.push(root);
  const path = join(root, "controller.sqlite3"), workerPath = join(root, "worker.sqlite3");
  const store = new SqliteStateStore(path);
  const local = store.addProject({ name: "Fixture", repositoryPath: root, port: 3199, executable: "", args: [], launchPreset: "none" });
  const identity = new IdentityService(store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const principal = identity.createWorker(owner);
  const issued = identity.issueWorkerToken({ principalId: principal.id, label: "fixture" }, owner);
  store.saveRemoteProjectIdentity({ id: "project", name: "Fixture", sourceRemote: "origin", status: "active" }, "fixture");
  store.saveRemoteWorker({ id: "worker", principalId: principal.id, name: "Fixture", status: "active", lastContactAt: null }, "fixture");
  store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "project", localProjectId: local.id, presetIds: ["node:test"], revokedAt: null }, "fixture");
  store.saveRemotePrincipalProjectGrant({ principalId: owner.principalId, projectId: "project", permissions: ["submit", "read"], revokedAt: null }, "fixture");
  const controller = new RemoteVerificationController(store, store.remoteConnection, identity);
  const request = controller.submit({ projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40), idempotencyKey: "once" }, owner);
  const actor = identity.authenticateBearer(issued.token);
  const assignment = controller.poll("worker", actor).assignments[0];
  const receipt: WorkerReceipt = { assignment, localRunId: "stable-run", cancellationRequested: false, reports: [], acknowledgedSequence: 0 };
  return { path, workerPath, store, identity, controller, request, owner, actor, receipt };
}
const report = (assignment: RemoteAssignment, sequence: number, phase: "preparing" | "running" | "succeeded") => remoteReportSchema.parse({ attemptId: assignment.attemptId, sequence, phase, localRunId: "stable-run", ...(phase !== "preparing" ? { executedCommitSha: assignment.commitSha, presetFingerprint: "b".repeat(64), environmentFingerprint: "c".repeat(64), ...(phase === "succeeded" ? { exitCode: 0, execution: { queuedAt: "2026-10-23T00:00:00.000Z", startedAt: "2026-10-23T00:00:01.000Z", finishedAt: "2026-10-23T00:00:02.000Z", termination: "exit", cleanup: "confirmed" }, source: { attribution: "observed_match", finishCommitSha: assignment.commitSha, queueComparison: "match", executionComparison: "match", reasonCodes: [] } } : {}) } : {}) });

it("persists acceptance before enqueue and never reexecutes unknown work after both databases reopen", async () => {
  const f = fixture();
  const workerStore = new SqliteStateStore(f.workerPath);
  workerStore.remoteConnection.accept(f.receipt);
  workerStore.close(); f.store.close();
  const controllerStore = new SqliteStateStore(f.path), reopened = new SqliteStateStore(f.workerPath);
  const identity = new IdentityService(controllerStore);
  const controller = new RemoteVerificationController(controllerStore, controllerStore.remoteConnection, identity);
  const enqueue = vi.fn(), resolve = vi.fn(), cancel = vi.fn(), blockAdmission = vi.fn();
  const worker = new RemoteVerificationWorker("worker", reopened.remoteConnection, { enqueue, cancel, blockAdmission }, () => null, { resolve }, {
    poll: async () => controller.poll("worker", f.actor),
    report: async input => { controller.report("worker", input, f.actor); },
  });
  try {
    expect(controller.recover()).toBe(1);
    expect(controller.poll("worker", f.actor).assignments).toEqual([]);
    await worker.tick();
    expect(controller.status(f.request.id, f.owner).attempt?.phase).toBe("uncertain");
    expect(reopened.remoteConnection.receipt(f.receipt.assignment.attemptId)).toMatchObject({ localRunId: "stable-run", reports: [{ phase: "uncertain" }] });
    expect(enqueue).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(blockAdmission).toHaveBeenCalledWith("remote_execution_cleanup_unconfirmed");
  } finally { await worker.close(); reopened.close(); controllerStore.close(); }
});

it("reopens and replays a durable terminal outbox after an ACK is lost, preserving cancellation intent", async () => {
  const f = fixture();
  const preparing = report(f.receipt.assignment, 1, "preparing"), running = report(f.receipt.assignment, 2, "running"), succeeded = report(f.receipt.assignment, 3, "succeeded");
  f.controller.report("worker", preparing, f.actor); f.controller.report("worker", running, f.actor); f.controller.report("worker", succeeded, f.actor);
  const workerStore = new SqliteStateStore(f.workerPath);
  workerStore.remoteConnection.accept({ ...f.receipt, reports: [preparing, running, succeeded], acknowledgedSequence: 2, cancellationRequested: true });
  workerStore.close(); f.store.close();
  const controllerStore = new SqliteStateStore(f.path), reopened = new SqliteStateStore(f.workerPath);
  const controller = new RemoteVerificationController(controllerStore, controllerStore.remoteConnection, new IdentityService(controllerStore));
  const enqueue = vi.fn(), resolve = vi.fn(), uploaded = vi.fn();
  const worker = new RemoteVerificationWorker("worker", reopened.remoteConnection, { enqueue, cancel: vi.fn(), blockAdmission: vi.fn() }, () => null, { resolve }, {
    poll: async () => controller.poll("worker", f.actor),
    report: async input => { uploaded(input); controller.report("worker", input, f.actor); },
  });
  try {
    controller.recover(); await worker.tick();
    expect(uploaded).toHaveBeenCalledExactlyOnceWith(succeeded);
    expect(controller.status(f.request.id, f.owner).attempt?.phase).toBe("succeeded");
    expect(reopened.remoteConnection.receipt(f.receipt.assignment.attemptId)).toMatchObject({ acknowledgedSequence: 3, cancellationRequested: true });
    expect(enqueue).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(() => controller.report("worker", { ...running, sequence: 4 }, f.actor)).toThrow("stale_report");
  } finally { await worker.close(); reopened.close(); controllerStore.close(); }
});

function localRun(projectId: string, path: string, overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: "stable-run", projectId, worktreePath: path, worktreeHead: "a".repeat(40), worktreeBranch: null, worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "remote-worker:worker", phase: "cancelled", queuePosition: null,
    executable: process.execPath, args: ["check.cjs"], cwd: path, queuedAt: "2026-10-23T00:00:00.000Z",
    startedAt: "2026-10-23T00:00:01.000Z", finishedAt: "2026-10-23T00:00:02.000Z", exitCode: null, signal: "SIGTERM", error: null,
    logs: [], environmentMode: "clean", environmentProfile: "remote-secret-free-v1", inheritedServerProfile: null, environmentVariableNames: [],
    source: legacySourceEvidence(), telemetry: { ...emptyTelemetry("observed"), termination: "cancel", cleanup: "confirmed", finalizedAt: "2026-10-23T00:00:03.000Z" },
    ...overrides,
  };
}

it.each(["confirmed", "not_required", "unknown"] as const)("retains %s cleanup in an uncertain receipt after local history pruning and restart", async cleanup => {
  const f = fixture();
  let workerStore = new SqliteStateStore(f.workerPath);
  const project = workerStore.addProject({ name: "Worker", repositoryPath: roots.at(-1)!, port: 3197, executable: "", args: [], launchPreset: "none" });
  const run = localRun(project.id, project.repositoryPath);
  run.telemetry!.cleanup = cleanup;
  workerStore.saveTestRun(run);
  workerStore.remoteConnection.accept({ ...f.receipt, reports: [report(f.receipt.assignment, 1, "preparing"), report(f.receipt.assignment, 2, "running")] });
  const jobs = { enqueue: vi.fn(), cancel: vi.fn(), blockAdmission: vi.fn() };
  const execution = { resolve: vi.fn() };
  const transport = { poll: async () => f.controller.poll("worker", f.actor), report: async (input: Parameters<typeof f.controller.report>[1]) => { f.controller.report("worker", input, f.actor); } };
  const first = new RemoteVerificationWorker("worker", workerStore.remoteConnection, jobs, id => workerStore.getTestRun(id), execution, transport);
  expect(workerStore.remoteConnection.receipt(f.receipt.assignment.attemptId)?.reports.at(-1)).toMatchObject({ phase: "uncertain", execution: { cleanup } });
  await first.close();
  // Real detail retention, rather than a mock returning null, removes the cancelled run.
  for (let index = 0; index < 51; index++) workerStore.saveTestRun(localRun(project.id, project.repositoryPath, {
    id: `newer-${index}`, phase: "passed", queuedAt: new Date(Date.parse(run.queuedAt) + index + 1).toISOString(),
  }));
  expect(workerStore.getTestRun(run.id)).toBeNull();
  workerStore.close();
  workerStore = new SqliteStateStore(f.workerPath);
  jobs.blockAdmission.mockClear();
  const restarted = new RemoteVerificationWorker("worker", workerStore.remoteConnection, jobs, id => workerStore.getTestRun(id), execution, transport);
  try {
    await restarted.tick();
    expect(f.controller.status(f.request.id, f.owner).attempt?.phase).toBe("uncertain");
    if (cleanup === "unknown") expect(jobs.blockAdmission).toHaveBeenCalledWith("remote_execution_cleanup_unconfirmed");
    else expect(jobs.blockAdmission).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(execution.resolve).not.toHaveBeenCalled();
  } finally { await restarted.close(); workerStore.close(); f.store.close(); }
});

it("retries a rejected attempt independently after its preset grant is revoked", async () => {
  const f = fixture();
  const workerStore = new SqliteStateStore(f.workerPath);
  const old = f.receipt.assignment;
  const grant = f.store.getRemoteWorkerProjectGrant("worker", "project")!;
  f.store.saveRemoteWorkerProjectGrant({ ...grant, presetIds: ["node:build"] }, "fixture");
  const next = f.controller.submit({ projectId: "project", workerId: "worker", presetId: "node:build", commitSha: "d".repeat(40), idempotencyKey: "next" }, f.owner);
  const assignment = f.controller.poll("worker", f.actor).assignments[0];
  for (const item of [old, assignment]) workerStore.remoteConnection.accept({ ...f.receipt, assignment: item,
    reports: [report(item, 1, "preparing"), report(item, 2, "running"), report(item, 3, "succeeded")],
  });
  const rejectedEvidence = JSON.stringify(workerStore.remoteConnection.receipt(old.attemptId));
  const jobs = { enqueue: vi.fn(), cancel: vi.fn(), blockAdmission: vi.fn() }, execution = { resolve: vi.fn() };
  const uploaded = vi.fn(async (input: Parameters<typeof f.controller.report>[1]) => { f.controller.report("worker", input, f.actor); });
  const worker = new RemoteVerificationWorker("worker", workerStore.remoteConnection, jobs, () => null, execution, { poll: async () => f.controller.poll("worker", f.actor), report: uploaded });
  try {
    await expect(worker.tick()).rejects.toThrow("project_forbidden");
    expect(f.controller.status(next.id, f.owner).attempt?.phase).toBe("succeeded");
    expect(workerStore.remoteConnection.receipt(assignment.attemptId)?.acknowledgedSequence).toBe(3);
    expect(JSON.stringify(workerStore.remoteConnection.receipt(old.attemptId))).toBe(rejectedEvidence);
    uploaded.mockClear();
    await expect(worker.tick()).rejects.toThrow("project_forbidden");
    expect(uploaded).toHaveBeenCalledExactlyOnceWith(report(old, 1, "preparing"));
    expect(JSON.stringify(workerStore.remoteConnection.receipt(old.attemptId))).toBe(rejectedEvidence);
    expect(jobs.enqueue).not.toHaveBeenCalled(); expect(execution.resolve).not.toHaveBeenCalled();
  } finally { await worker.close(); workerStore.close(); f.store.close(); }
});

it("keeps a compact 1000-receipt replay index and reads only an unacknowledged report body on demand", async () => {
  const f = fixture();
  const workerStore = new SqliteStateStore(f.workerPath);
  const logs = Array.from({ length: 8 }, () => "history-must-stay-on-disk:" + "x".repeat(1900));
  workerStore.remoteConnection.atomic(() => {
    for (let index = 0; index < 1000; index++) {
      const assignment = { ...f.receipt.assignment, attemptId: `history-${index}`, requestId: `request-${index}` };
      workerStore.remoteConnection.accept({ ...f.receipt, assignment, acknowledgedSequence: index === 999 ? 2 : 3,
        reports: [report(assignment, 1, "preparing"), report(assignment, 2, "running"), { ...report(assignment, 3, "succeeded"), logs }],
      });
    }
  });
  workerStore.close();
  const reopened = new SqliteStateStore(f.workerPath);
  const summaries = reopened.remoteConnection.receipts();
  expect(summaries).toHaveLength(1000);
  expect(Buffer.byteLength(JSON.stringify(summaries))).toBeLessThan(1024 * 1024);
  expect(JSON.stringify(summaries)).not.toContain("history-must-stay-on-disk");
  const read = vi.spyOn(reopened.remoteConnection, "receipt");
  const enqueue = vi.fn(), resolve = vi.fn();
  const duplicate = summaries[0].assignment;
  let rejectReport = true;
  const upload = vi.fn<(input: RemoteWorkerReport) => Promise<void>>(async () => { if (rejectReport) throw new Error("retry later"); });
  const transport = { poll: async () => ({ version: 1 as const, assignments: [duplicate], cancellations: [] }), report: upload };
  const worker = new RemoteVerificationWorker("worker", reopened.remoteConnection, { enqueue, cancel: vi.fn(), blockAdmission: vi.fn() }, () => null, { resolve }, transport);
  try {
    expect(read).not.toHaveBeenCalled();
    // The worker retains exactly the compact index, including duplicate tombstones.
    const retained = Reflect.get(worker, "receipts") as Map<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify([...retained.values()]))).toBeLessThan(1024 * 1024);
    await expect(worker.tick()).rejects.toThrow("retry later");
    await expect(worker.tick()).rejects.toThrow("retry later");
    expect(read.mock.calls).toEqual([["history-999"], ["history-999"]]);
    expect(upload.mock.calls[0]).toEqual(upload.mock.calls[1]);
    rejectReport = false;
    await worker.tick();
    expect(upload.mock.calls[2]).toEqual(upload.mock.calls[0]);
    read.mockClear();
    await worker.tick();
    expect(read).not.toHaveBeenCalled();
    expect(Buffer.byteLength(JSON.stringify([...retained.values()]))).toBeLessThan(1024 * 1024);
    expect(JSON.stringify([...retained.values()])).not.toContain("history-must-stay-on-disk");
    expect(enqueue).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(() => reopened.remoteConnection.accept({ ...f.receipt, assignment: { ...duplicate, attemptId: "over-capacity" } })).toThrow("worker_receipt_capacity_exhausted");
    // Full immutable evidence is still available for owner diagnostics/replay.
    expect(reopened.remoteConnection.receipt("history-999")?.reports.at(-1)?.logs).toEqual(logs);
  } finally { await worker.close(); reopened.close(); f.store.close(); }
}, 15_000);

it("merges an ACK with execution evidence appended while the upload was in flight", async () => {
  const f = fixture(), workerStore = new SqliteStateStore(f.workerPath);
  let running!: (evidence: Partial<RemoteWorkerReport>) => void;
  const enqueue = vi.fn();
  const worker = new RemoteVerificationWorker("worker", workerStore.remoteConnection, { enqueue, cancel: vi.fn(), blockAdmission: vi.fn() }, () => null, {
    resolve: async (_assignment, _receipt, started) => { running = started; return {} as EnqueueTestInput; },
  }, {
    poll: async () => f.controller.poll("worker", f.actor),
    report: async input => {
      if (input.sequence === 1) running({ executedCommitSha: f.receipt.assignment.commitSha, presetFingerprint: "b".repeat(64), environmentFingerprint: "c".repeat(64) });
      f.controller.report("worker", input, f.actor);
    },
  });
  try {
    await worker.tick();
    expect(workerStore.remoteConnection.receipt(f.receipt.assignment.attemptId)).toMatchObject({
      acknowledgedSequence: 1, reports: [{ phase: "preparing" }, { phase: "running" }],
    });
    await worker.tick();
    expect(workerStore.remoteConnection.receipt(f.receipt.assignment.attemptId)?.acknowledgedSequence).toBe(2);
    expect(f.controller.status(f.request.id, f.owner).attempt?.phase).toBe("running");
    expect(enqueue).toHaveBeenCalledOnce();
  } finally { await worker.close(); workerStore.close(); f.store.close(); }
});

it.each(["uncertain", "succeeded", "failed", "cancelled"] as const)("never treats explicit unknown cleanup in a %s receipt as confirmed", async phase => {
  const f = fixture(), workerStore = new SqliteStateStore(f.workerPath);
  const terminal = report(f.receipt.assignment, 3, "succeeded");
  workerStore.remoteConnection.accept({ ...f.receipt, reports: [report(f.receipt.assignment, 1, "preparing"), report(f.receipt.assignment, 2, "running"),
    { ...terminal, phase, execution: { ...terminal.execution!, cleanup: "unknown" } }],
  });
  const blockAdmission = vi.fn();
  const worker = new RemoteVerificationWorker("worker", workerStore.remoteConnection, { enqueue: vi.fn(), cancel: vi.fn(), blockAdmission }, () => null, { resolve: vi.fn() }, {
    poll: async () => ({ version: 1, assignments: [], cancellations: [] }), report: async () => undefined,
  });
  try { expect(blockAdmission).toHaveBeenCalledWith("remote_execution_cleanup_unconfirmed"); }
  finally { await worker.close(); workerStore.close(); f.store.close(); }
});
