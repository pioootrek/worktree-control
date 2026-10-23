import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
  const enqueue = vi.fn(), resolve = vi.fn(), cancel = vi.fn();
  const worker = new RemoteVerificationWorker("worker", reopened.remoteConnection, { enqueue, cancel }, () => null, { resolve }, {
    poll: async () => controller.poll("worker", f.actor),
    report: async input => { controller.report("worker", input, f.actor); },
  });
  try {
    expect(controller.recover()).toBe(1);
    expect(controller.poll("worker", f.actor).assignments).toEqual([]);
    await worker.tick();
    expect(controller.status(f.request.id, f.owner).attempt?.phase).toBe("uncertain");
    expect(reopened.remoteConnection.receipts()[0]).toMatchObject({ localRunId: "stable-run", reports: [{ phase: "uncertain" }] });
    expect(enqueue).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
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
  const worker = new RemoteVerificationWorker("worker", reopened.remoteConnection, { enqueue, cancel: vi.fn() }, () => null, { resolve }, {
    poll: async () => controller.poll("worker", f.actor),
    report: async input => { uploaded(input); controller.report("worker", input, f.actor); },
  });
  try {
    controller.recover(); await worker.tick();
    expect(uploaded).toHaveBeenCalledExactlyOnceWith(succeeded);
    expect(controller.status(f.request.id, f.owner).attempt?.phase).toBe("succeeded");
    expect(reopened.remoteConnection.receipts()[0]).toMatchObject({ acknowledgedSequence: 3, cancellationRequested: true });
    expect(enqueue).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    expect(() => controller.report("worker", { ...running, sequence: 4 }, f.actor)).toThrow("stale_report");
  } finally { await worker.close(); reopened.close(); controllerStore.close(); }
});
