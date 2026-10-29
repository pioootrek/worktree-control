import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogWriter } from "@/server/log-writer";
import { RemoteVerificationController, RemoteVerificationWorker } from "@/server/modules/remote-verification";
import type { EnqueueTestInput } from "@/server/modules/verification";
import { TestJobManager } from "@/server/test-job-manager";
import { createRemoteVerificationServer } from "@/server/transports/remote-verification-http";
import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import { readCommitted } from "./fixture";
import { request } from "./server-request";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, gate, pauseProvisioning, sleep, strictProof, type StrictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
async function remote(f: StrictProof) {
  const data = await f.run(() => {
    const local = f.store.addProject({ name: "remote fixture", repositoryPath: f.root, port: 3897, executable: "", args: [], launchPreset: "none" });
    const principal = f.identity.createWorker(f.ownerActor), issued = f.identity.issueWorkerToken({ principalId: principal.id, label: "remote fixture" }, f.ownerActor);
    const actor = f.identity.authenticateBearer(issued.token);
    f.store.saveRemoteProjectIdentity({ id: "project", name: "remote", sourceRemote: "origin", status: "active" }, "test");
    f.store.saveRemoteWorker({ id: "worker", principalId: principal.id, name: "remote", status: "active", lastContactAt: null }, "test");
    f.store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "project", localProjectId: local.id, presetIds: ["node:test"], revokedAt: null }, "test");
    f.store.saveRemotePrincipalProjectGrant({ principalId: f.owner.principalId, projectId: "project", permissions: ["submit", "read"], revokedAt: null }, "test");
    const controller = new RemoteVerificationController(f.store, f.store.remoteConnection, f.identity);
    const submitted = controller.submit({ projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40), idempotencyKey: "remote-once" }, f.ownerActor);
    return { local, issued, actor, controller, submitted };
  });
  const http = createRemoteVerificationServer({ controller: data.controller, identity: f.identity, admission: f.store.admission, allowLoopbackHttpFixture: true });
  return { ...data, http };
}

describe("strict remote protocol and worker persistence", () => {
  it.each(["commit", "rollback"] as const)("admits remote poll after provider %s and preserves exact report replay", async outcome => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), r = await remote(f);
    const hold = pauseProvisioning(f, faults, outcome);
    try {
      await hold.paused;
      const poll = request(r.http.server, "/remote-verification/v1/poll", r.issued.token, JSON.stringify({ version: 1, workerId: "worker" }));
      await sleep(20); expect(poll.ended).toBe(false);
      hold.resume(); await hold.pending;
      const result = await poll.completed; expect(result.status).toBe(200);
      const assignment = (result.body.assignments as RemoteAssignment[])[0]; expect(assignment).toBeTruthy();
      const report = { version: 1, workerId: "worker", report: { attemptId: assignment.attemptId, localRunId: "local-run", sequence: 1, phase: "preparing" } };
      const first = await request(r.http.server, "/remote-verification/v1/report", r.issued.token, JSON.stringify(report)).completed;
      expect(first).toMatchObject({ status: 200, body: { acceptedSequence: 1 } });
      expect(await request(r.http.server, "/remote-verification/v1/report", r.issued.token, JSON.stringify(report)).completed).toMatchObject({ status: 200, body: { acceptedSequence: 1 } });
      expect(await f.run(() => r.controller.status(r.submitted.id, f.ownerActor).result?.sequence)).toBe(1);
    } finally { hold.resume(); await hold.pending; await r.http.close(); await closeStrictProof(f); }
  });

  it.each(["commit", "rollback"] as const)("admits a remote report after provider %s without repeated transitions", async outcome => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), r = await remote(f);
    const assignment = await f.run(() => r.controller.poll("worker", r.actor).assignments[0]);
    const input = JSON.stringify({ version: 1, workerId: "worker", report: { attemptId: assignment.attemptId, localRunId: "local-run", sequence: 1, phase: "preparing" } });
    const hold = pauseProvisioning(f, faults, outcome);
    try {
      await hold.paused;
      const report = request(r.http.server, "/remote-verification/v1/report", r.issued.token, input);
      await sleep(20); expect(report.ended).toBe(false);
      hold.resume(); await hold.pending;
      expect(await report.completed).toMatchObject({ status: 200, body: { acceptedSequence: 1 } });
      const version = await f.run(() => r.controller.status(r.submitted.id, f.ownerActor).attempt?.version);
      expect(await request(r.http.server, "/remote-verification/v1/report", r.issued.token, input).completed).toMatchObject({ status: 200, body: { acceptedSequence: 1 } });
      expect(await f.run(() => r.controller.status(r.submitted.id, f.ownerActor).attempt?.version)).toBe(version);
    } finally { hold.resume(); await hold.pending; await r.http.close(); await closeStrictProof(f); }
  });

  it("rechecks worker grants at delivery after admission wait", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), r = await remote(f);
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoked = f.run(() => f.store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "project", localProjectId: r.local.id, presetIds: ["node:test"], revokedAt: new Date().toISOString() }, "test"));
      const poll = request(r.http.server, "/remote-verification/v1/poll", r.issued.token, JSON.stringify({ version: 1, workerId: "worker" }));
      hold.resume(); await hold.pending; await revoked;
      expect(await poll.completed).toMatchObject({ status: 200, body: { assignments: [] } });
      expect(await f.run(() => r.controller.status(r.submitted.id, f.ownerActor).attempt)).toBeNull();
    } finally { hold.resume(); await hold.pending; await r.http.close(); await closeStrictProof(f); }
  });

  it("merges a delayed ACK into current receipt state after provider wait, retaining cancellation and immutable reports", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const assignment: RemoteAssignment = { requestId: "request", attemptId: "attempt", projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40) };
    const report: RemoteWorkerReport = { attemptId: "attempt", localRunId: "local-run", sequence: 1, phase: "failed", failureKind: "setup", errorCode: "preparation_failed" };
    await f.run(() => f.store.remoteConnection.accept({ assignment, localRunId: "local-run", cancellationRequested: false, reports: [report], acknowledgedSequence: 0 }));
    const uploaded = gate(), acknowledge = gate();
    const jobs = { enqueue: vi.fn(), cancel: vi.fn(), blockAdmission: vi.fn() };
    const worker = await f.run(() => new RemoteVerificationWorker("worker", f.store.remoteConnection, jobs, () => null, { resolve: vi.fn() }, {
      poll: async () => { expect(f.store.admissionSnapshot().coreActive).toBe(0); return { version: 1, assignments: [], cancellations: [] }; },
      report: async input => { expect(input).toEqual(report); expect(f.store.admissionSnapshot().coreActive).toBe(0); uploaded.open(); await acknowledge.opened; },
    }, undefined, f.store.admission));
    const ticking = worker.tick(); await uploaded.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const cancellation = f.run(() => { const current = f.store.remoteConnection.receipt("attempt")!; current.cancellationRequested = true; f.store.remoteConnection.saveReceipt(current); });
      acknowledge.open(); await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(2));
      hold.resume(); await hold.pending; await cancellation; await ticking;
      const receipt = await f.run(() => f.store.remoteConnection.receipt("attempt"));
      expect(receipt).toMatchObject({ cancellationRequested: true, acknowledgedSequence: 1, reports: [report] });
      await worker.tick(); expect(jobs.enqueue).not.toHaveBeenCalled();
    } finally { acknowledge.open(); hold.resume(); await hold.pending; await ticking; await worker.close(); await closeStrictProof(f); }
  });

  it("commits receipt before SQL-free preparation and delays spawn until provider release", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "worker", repositoryPath: f.root, port: 3898, executable: "", args: [], launchPreset: "none" }));
    const jobs = await f.run(() => new TestJobManager(f.store, nullLogWriter));
    const prepared = gate(), finish = gate();
    const assignment: RemoteAssignment = { requestId: "request", attemptId: "attempt", projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40) };
    const observation = () => ({ observedAt: new Date().toISOString(), head: assignment.commitSha, branch: "main", dirty: false, statusDigest: "e".repeat(64), statusEntries: 0, complete: true, errorCode: null });
    let delivered = false;
    const resolve = vi.fn(async (_assignment: RemoteAssignment, _receipt: unknown, running: (evidence: Partial<RemoteWorkerReport>) => void): Promise<EnqueueTestInput> => {
      expect(readCommitted(f.path, db => (db.prepare("SELECT count(*) n FROM remote_worker_receipts").get() as { n: number }).n)).toBe(1);
      const worktree = { path: f.root, head: assignment.commitSha, shortHead: "aaaaaaa", branch: "main", detached: false, locked: false, prunable: false, dirty: false };
      const command = { preset: { id: "node:test", name: "test", adapter: "node" as const, timeoutMs: 5000 }, executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: f.root };
      const environment = { environment: {}, mode: "clean" as const, profile: "unit", inheritedServerProfile: null, variableNames: [] };
      return { projectId: project.id, worktree, command, environment, actor: "remote-worker:worker", preparation: {
        prepare: async () => { expect(f.store.admissionSnapshot().coreActive).toBe(0); prepared.open(); await finish.opened; return { worktree, command, environment, sourceObservation: observation() }; },
        observe: async () => observation(), dispose: async () => undefined,
        starting: () => { expect(f.store.getTestRun(f.store.remoteConnection.receipt("attempt")!.localRunId)?.startedAt).toBeNull(); },
        started: () => running({ executedCommitSha: assignment.commitSha, presetFingerprint: "b".repeat(64), environmentFingerprint: "c".repeat(64) }),
      } };
    });
    const worker = await f.run(() => new RemoteVerificationWorker("worker", f.store.remoteConnection, jobs, id => f.store.getTestRun(id), { resolve }, {
      poll: async () => { const assignments = delivered ? [] : [assignment]; delivered = true; return { version: 1, assignments, cancellations: [] }; }, report: async () => undefined,
    }, undefined, f.store.admission));
    await worker.tick(); await prepared.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused; finish.open(); await sleep(50);
      expect(readCommitted(f.path, db => (db.prepare("SELECT phase FROM test_runs").get() as { phase: string }).phase)).toBe("queued");
      hold.resume(); await hold.pending;
      const localRun = await f.run(() => f.store.remoteConnection.receipt("attempt")!.localRunId);
      await vi.waitFor(async () => expect((await f.run(() => f.store.getTestRun(localRun)))?.phase).toBe("passed"));
      await worker.tick();
      const receipt = await f.run(() => f.store.remoteConnection.receipt("attempt"));
      expect(receipt?.reports.map(value => value.phase)).toEqual(["preparing", "running", "succeeded"]);
      expect(receipt?.acknowledgedSequence).toBe(3); expect(resolve).toHaveBeenCalledOnce();
    } finally { finish.open(); hold.resume(); await hold.pending; await worker.close(); await jobs.shutdown(); await closeStrictProof(f); }
  });
});
