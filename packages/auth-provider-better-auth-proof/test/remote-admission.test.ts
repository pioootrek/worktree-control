import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ControlService } from "@/server/control-service";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { IdentityService } from "@/server/modules/identity";
import { McpSessionGovernor, type GovernedMcpSession } from "@/server/modules/mcp-sessions";
import { McpRuntime } from "@/server/transports/mcp/mcp-runtime";
import { join } from "node:path";
import { SystemRemoteWorkerExecution, LinuxWorkerRecoveryHost } from "@/server/infrastructure/git";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { ProcessManager } from "@/server/process-manager";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nullLogWriter } from "@/server/log-writer";
import { RemoteVerificationController, RemoteVerificationWorker, WorkerRecoveryService } from "@/server/modules/remote-verification";
import type { EnqueueTestInput } from "@/server/modules/verification";
import { TestJobManager } from "@/server/test-job-manager";
import { createRemoteVerificationServer } from "@/server/transports/remote-verification-http";
import type { RemoteAssignment, RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import { loadProof, readCommitted } from "./fixture";
import { request } from "./server-request";
import type { ProofFaultInjection } from "../src/index";
import { cleanupStrictRoots, closeStrictProof, gate, pauseProvisioning, sleep, strictProof, type StrictProof } from "./strict-fixture";

afterEach(cleanupStrictRoots);
async function remote(f: StrictProof, expiresAt?: string) {
  const data = await f.run(() => {
    const local = f.store.addProject({ name: "remote fixture", repositoryPath: f.root, port: 3897, executable: "", args: [], launchPreset: "none" });
    const principal = f.identity.createWorker(f.ownerActor), issued = f.identity.issueWorkerToken({ principalId: principal.id, label: "remote fixture", expiresAt }, f.ownerActor);
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

async function remoteProtocol(f: StrictProof, controller: RemoteVerificationController) {
  const service = new ControlService(f.store, { list: async () => [] } as never, new ProcessManager(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, controller);
  const governor = new McpSessionGovernor(), runtime = new McpRuntime(service, undefined, f.identity, undefined, governor);
  const admitted = governor.admit(`principal:${f.ownerActor.credentialId}`);
  if (!admitted.admitted) throw new Error("fixture session refused");
  const session = (runtime as unknown as { createSession(auth: unknown, governed: GovernedMcpSession): { server: McpServer; transport: { close(): Promise<void> } } })
    .createSession({ kind: "principal", actor: f.ownerActor }, admitted.session);
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair(), client = new Client({ name: "strict-remote", version: "1" });
  await session.server.connect(serverWire); await client.connect(clientWire);
  return { client, close: async () => { await session.transport.close(); await client.close(); await session.server.close(); admitted.session.markClosed(); } };
}

describe("strict remote protocol and worker persistence", () => {
  it("admits actual MCP submit/cancel handlers once and cancels pending work before delivery without an attempt", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), r = await remote(f), mcp = await remoteProtocol(f, r.controller);
    const input = { name: "submit_remote_verification", arguments: { projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "b".repeat(40), idempotencyKey: "mcp-submit-once" } };
    const submit = vi.spyOn(r.controller, "submit"), cancel = vi.spyOn(r.controller, "cancel");
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const submitted = mcp.client.callTool(input);
      const cancelled = mcp.client.callTool({ name: "cancel_remote_verification", arguments: { requestId: r.submitted.id } });
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(2));
      expect(submit).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
      hold.resume(); await hold.pending;
      const result = await submitted; expect(result.isError).not.toBe(true);
      expect((await cancelled).isError).not.toBe(true);
      expect(submit).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
      expect(await mcp.client.callTool(input)).toEqual(result);
      const poll = await request(r.http.server, "/remote-verification/v1/poll", r.issued.token, JSON.stringify({ version: 1, workerId: "worker" })).completed;
      const assignments = poll.body.assignments as RemoteAssignment[];
      expect(assignments).toHaveLength(1);
      const assignment = assignments[0];
      expect(assignment).toMatchObject({ commitSha: input.arguments.commitSha });
      expect(assignment.requestId).not.toBe(r.submitted.id);
      expect(poll.body.cancellations).toEqual([]);
      expect(await f.run(() => r.controller.status(r.submitted.id, f.ownerActor))).toMatchObject({ request: { phase: "cancelled" }, cancellationRequested: true, attempt: null, result: null });
      const report = { attemptId: assignment.attemptId, localRunId: "new-run", sequence: 1, phase: "preparing" };
      expect(await request(r.http.server, "/remote-verification/v1/report", r.issued.token, JSON.stringify({ version: 1, workerId: "worker", report })).completed).toMatchObject({ status: 200, body: { acceptedSequence: 1 } });
      const terminal = { ...report, sequence: 2, phase: "failed", failureKind: "setup", errorCode: "preparation_failed" };
      expect(await request(r.http.server, "/remote-verification/v1/report", r.issued.token, JSON.stringify({ version: 1, workerId: "worker", report: terminal })).completed).toMatchObject({ status: 200, body: { acceptedSequence: 2 } });
      expect(await f.run(() => r.controller.status(assignment.requestId, f.ownerActor))).toMatchObject({ request: { phase: "completed" }, result: { phase: "failed", sequence: 2 } });
      expect(readCommitted(f.path, db => (db.prepare("SELECT count(*) n FROM remote_verification_requests").get() as { n: number }).n)).toBe(2);
    } finally { hold.resume(); await hold.pending; await mcp.close(); await r.http.close(); await closeStrictProof(f); }
  });

  it("rechecks submit/cancel authority in actual queued MCP handlers", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), r = await remote(f), mcp = await remoteProtocol(f, r.controller);
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoke = f.run(() => f.store.saveRemotePrincipalProjectGrant({ principalId: f.owner.principalId, projectId: "project", permissions: ["submit", "read"], revokedAt: new Date().toISOString() }, "test"));
      const submit = mcp.client.callTool({ name: "submit_remote_verification", arguments: { projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "c".repeat(40), idempotencyKey: "must-not-submit" } });
      const cancel = mcp.client.callTool({ name: "cancel_remote_verification", arguments: { requestId: r.submitted.id } });
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(3));
      hold.resume(); await hold.pending; await revoke;
      expect((await submit).isError).toBe(true); expect((await cancel).isError).toBe(true);
      expect(await f.run(() => f.store.remoteConnection.cancellationRequested(r.submitted.id))).toBe(false);
      expect(readCommitted(f.path, db => (db.prepare("SELECT count(*) n FROM remote_verification_requests").get() as { n: number }).n)).toBe(1);
    } finally { hold.resume(); await hold.pending; await mcp.close(); await r.http.close(); await closeStrictProof(f); }
  });

  it("refuses an expired worker at the HTTP operation phase after its body-read admission wait", async () => {
    let now = Date.now();
    const faults: ProofFaultInjection = {}, f = await strictProof(faults, {}, () => new Date(now).toISOString()), r = await remote(f, new Date(now + 1000).toISOString());
    const authenticated = vi.spyOn(f.identity, "authenticateBearer");
    const poll = request(r.http.server, "/remote-verification/v1/poll", r.issued.token);
    await vi.waitFor(() => expect(authenticated).toHaveBeenCalledOnce());
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused; poll.send(JSON.stringify({ version: 1, workerId: "worker" }));
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
      now += 1001; hold.resume(); await hold.pending;
      expect(await poll.completed).toMatchObject({ status: 400, body: { error: "remote_protocol_rejected" } });
      expect(authenticated).toHaveBeenCalledTimes(2);
      expect(await f.run(() => r.controller.status(r.submitted.id, f.ownerActor).attempt)).toBeNull();
    } finally { hold.resume(); await hold.pending; await r.http.close(); await closeStrictProof(f); }
  });

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
    const report: RemoteWorkerReport = { attemptId: "attempt", localRunId: "local-run", sequence: 1, phase: "failed", failureKind: "setup", errorCode: "preparation_failed", logs: [] };
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

  it("commits receipt before preparation, delays spawn, and merges a queued ACK with a real running report appended during upload", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const project = await f.run(() => f.store.addProject({ name: "worker", repositoryPath: f.root, port: 3898, executable: "", args: [], launchPreset: "none" }));
    const jobs = await f.run(() => new TestJobManager(f.store, nullLogWriter));
    const prepared = gate(), finish = gate(), uploaded = gate(), acknowledge = gate();
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
      poll: async () => { const assignments = delivered ? [] : [assignment]; delivered = true; return { version: 1, assignments, cancellations: [] }; },
      report: async report => { if (report.sequence === 1) { uploaded.open(); await acknowledge.opened; } },
    }, undefined, f.store.admission));
    const ticking = worker.tick(); await prepared.opened; await uploaded.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    let ackHold: ReturnType<typeof pauseProvisioning> | undefined;
    try {
      await hold.paused; finish.open(); await sleep(50);
      expect(readCommitted(f.path, db => (db.prepare("SELECT phase FROM test_runs").get() as { phase: string }).phase)).toBe("queued");
      hold.resume(); await hold.pending;
      const localRun = await f.run(() => f.store.remoteConnection.receipt("attempt")!.localRunId);
      await vi.waitFor(async () => expect((await f.run(() => f.store.getTestRun(localRun)))?.phase).toBe("passed"));
      // A real queue `started` callback appended sequence 2 while sequence 1 was in flight.
      expect(await f.run(() => f.store.remoteConnection.receipt("attempt"))).toMatchObject({ acknowledgedSequence: 0, reports: [{ phase: "preparing" }, { phase: "running" }] });
      ackHold = pauseProvisioning(f, faults, "rollback"); await ackHold.paused;
      acknowledge.open();
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBeGreaterThan(0));
      ackHold.resume(); await ackHold.pending; await ticking;
      expect(await f.run(() => f.store.remoteConnection.receipt("attempt"))).toMatchObject({ acknowledgedSequence: 1, reports: [{ phase: "preparing" }, { phase: "running" }] });
      await worker.tick();
      const receipt = await f.run(() => f.store.remoteConnection.receipt("attempt"));
      expect(receipt?.reports.map(value => value.phase)).toEqual(["preparing", "running", "succeeded"]);
      expect(receipt?.acknowledgedSequence).toBe(3); expect(resolve).toHaveBeenCalledOnce();
    } finally { finish.open(); acknowledge.open(); hold.resume(); ackHold?.resume(); await hold.pending; await ackHold?.pending; await ticking; await worker.close(); await jobs.shutdown(); await closeStrictProof(f); }
  });

  it("recovers an interrupted receipt on a reopened strict owner without re-enqueue, and retains cleanup refusal while its outbox waits for the provider", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults), r = await remote(f);
    const assignment = await f.run(() => r.controller.poll("worker", r.actor).assignments[0]);
    await f.run(() => f.store.remoteConnection.accept({ assignment, localRunId: "interrupted-run", cancellationRequested: true, reports: [], acknowledgedSequence: 0 }));
    await r.http.close(); await closeStrictProof(f);
    const store = new SqliteStateStore(f.path, undefined, { admission: "strict" }), identity = new IdentityService(store);
    const controller = new RemoteVerificationController(store, store.remoteConnection, identity);
    const jobs = { enqueue: vi.fn(), cancel: vi.fn(), blockAdmission: vi.fn() }, resolve = vi.fn();
    const { runtime } = await loadProof(store, faults);
    const reopened = { ...f, store, identity, runtime, run: <T>(operation: () => T | Promise<T>) => store.admission.run(operation) };
    const reports: RemoteWorkerReport[] = [];
    const worker = await reopened.run(() => {
      expect(controller.recover()).toBe(1);
      return new RemoteVerificationWorker("worker", store.remoteConnection, jobs, () => null, { resolve }, {
        poll: async () => reopened.run(() => controller.poll("worker", r.actor)),
        report: async report => { reports.push(report); await reopened.run(() => controller.report("worker", report, r.actor)); },
      }, undefined, store.admission);
    });
    const hold = pauseProvisioning(reopened, faults, "rollback");
    try {
      expect(jobs.blockAdmission).toHaveBeenCalledExactlyOnceWith("remote_execution_cleanup_unconfirmed");
      await hold.paused;
      const ticking = worker.tick();
      await vi.waitFor(() => expect(store.admissionSnapshot().queuedCore).toBe(1));
      expect(reports).toEqual([]); expect(jobs.enqueue).not.toHaveBeenCalled();
      hold.resume(); await hold.pending; await ticking;
      expect(await reopened.run(() => store.remoteConnection.receipt(assignment.attemptId))).toMatchObject({ cancellationRequested: true, acknowledgedSequence: 1, reports: [{ phase: "uncertain", sequence: 1 }] });
      expect(await reopened.run(() => controller.status(r.submitted.id, f.ownerActor))).toMatchObject({ attempt: { phase: "uncertain" }, result: { phase: "uncertain" } });
      await worker.tick(); expect(reports).toHaveLength(1);
      expect(resolve).not.toHaveBeenCalled(); expect(jobs.enqueue).not.toHaveBeenCalled(); expect(jobs.cancel).not.toHaveBeenCalled();
    } finally { hold.resume(); await hold.pending; await worker.close(); await closeStrictProof(reopened); }
  });

  it("the real workspace preparation releases admission and rechecks its mapping after provider wait", async () => {
    const faults: ProofFaultInjection = {}, f = await strictProof(faults);
    const human = join(f.root, "human"), cache = join(f.root, "cache"), workspaces = join(f.root, "attempts");
    mkdirSync(join(human, ".git"), { recursive: true }); mkdirSync(join(cache, ".git"), { recursive: true });
    const local = await f.run(() => {
      const local = f.store.addProject({ name: "real preparation", repositoryPath: human, port: 3900, executable: "", args: [], launchPreset: "none" });
      f.store.saveRemotePrincipal({ id: "worker-principal", kind: "worker", status: "active" }, "test");
      f.store.saveRemoteProjectIdentity({ id: "project", name: "remote", sourceRemote: "origin", status: "active" }, "test");
      f.store.saveRemoteWorker({ id: "worker", principalId: "worker-principal", name: "worker", status: "active", lastContactAt: null }, "test");
      f.store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "project", localProjectId: local.id, presetIds: ["node:test"], revokedAt: null }, "test");
      return local;
    });
    const assignment: RemoteAssignment = { requestId: "request", attemptId: "attempt", projectId: "project", workerId: "worker", presetId: "node:test", commitSha: "a".repeat(40) };
    const receipt = { assignment, localRunId: "local-run", cancellationRequested: false, reports: [], acknowledgedSequence: 0 };
    await f.run(() => f.store.remoteConnection.accept(receipt));
    const entered = gate(), resume = gate(), resolveCommand = vi.fn();
    const preparer = { prepare: vi.fn(async () => {
      expect(f.store.admissionSnapshot().coreActive).toBe(0);
      const committed = readCommitted(f.path, db => JSON.parse((db.prepare("SELECT payload_json FROM remote_worker_receipts WHERE attempt_id='attempt'").get() as { payload_json: string }).payload_json));
      expect(committed.recovery).toBeTruthy(); // Real provenance commits before the mocked Git effect.
      entered.open(); await resume.opened;
      return { requestId: assignment.attemptId, path: join(workspaces, "attempt"), repositoryPath: cache, sourceRemote: "origin", requestedCommitSha: assignment.commitSha, executedCommitSha: assignment.commitSha };
    }), cleanup: vi.fn(async () => undefined) };
    const execution = new SystemRemoteWorkerExecution("worker", [{ projectId: "project", localProjectId: local.id, sourceCachePath: cache, sourceRemote: "origin", presetIds: ["node:test"] }], f.store,
      new ProjectLifecycle(f.store, new ProcessManager()), { observe: vi.fn() } as never, { resolve: resolveCommand } as never, preparer, workspaces,
      new WorkerRecoveryService(f.store.remoteConnection, new LinuxWorkerRecoveryHost(f.path)));
    const input = await f.run(() => execution.resolve(assignment, receipt, vi.fn()));
    const preparing = input.preparation!.prepare();
    const denied = expect(preparing).rejects.toThrow("local_mapping_forbidden");
    await entered.opened;
    const hold = pauseProvisioning(f, faults, "rollback");
    try {
      await hold.paused;
      const revoke = f.run(() => f.store.saveRemoteWorkerProjectGrant({ workerId: "worker", projectId: "project", localProjectId: local.id, presetIds: ["node:test"], revokedAt: new Date().toISOString() }, "test"));
      resume.open(); await sleep(20); expect(resolveCommand).not.toHaveBeenCalled();
      hold.resume(); await hold.pending; await revoke; await denied;
      expect(resolveCommand).not.toHaveBeenCalled(); expect(preparer.prepare).toHaveBeenCalledOnce();
    } finally { resume.open(); hold.resume(); await hold.pending; await denied; await input.preparation!.dispose(); await closeStrictProof(f); }
  });

});
