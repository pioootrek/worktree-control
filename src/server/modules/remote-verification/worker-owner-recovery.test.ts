import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { LinuxWorkerRecoveryHost } from "@/server/infrastructure/git";
import { IdentityService, type AuthenticatedPrincipal } from "@/server/modules/identity";
import { SqliteStateStore } from "@/server/sqlite-store";
import { TestJobManager } from "@/server/test-job-manager";
import { nullLogWriter } from "@/server/log-writer";
import type { EnqueueTestInput } from "@/server/modules/verification";
import { remoteReportSchema } from "@/shared/contracts/remote-verification";
import { WorkerRecoveryService, RemoteVerificationWorker, hasUnconfirmedRemoteExecution, type WorkerReceipt } from "./index";

const disposals: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0).reverse()) dispose(); });
// All boot transitions here are simulated. No machine restart is performed.
const originalBoot = "11111111-1111-4111-8111-111111111111", nextBoot = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-owner-recovery-"));
  disposals.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "worker.sqlite3"), workspaceRoot = join(root, "attempts"), cache = join(root, "cache"), human = join(root, "human");
  for (const path of [workspaceRoot, cache, human]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(human, "keep"), "human"); writeFileSync(join(cache, "keep"), "source-cache");
  let store = new SqliteStateStore(databasePath);
  disposals.push(() => store.close());
  let identity = new IdentityService(store);
  const session = identity.bootstrapOwnerSession();
  let owner = identity.authenticateBearer(session.token);
  const project = store.addProject({ name: "human", repositoryPath: human, port: 3199, executable: "", args: [], launchPreset: "none" });
  let boot = originalBoot, host = "a".repeat(64), readable = true;
  const adapter = () => new LinuxWorkerRecoveryHost(databasePath, () => { if (!readable) throw new Error("unreadable"); return { host, boot }; });
  let recovery = new WorkerRecoveryService(store.remoteConnection, adapter(), identity);
  const start = (attemptId = "attempt") => {
    const receipt: WorkerReceipt = { assignment: { attemptId, requestId: `request-${attemptId}`, workerId: "worker", projectId: "remote-project", presetId: "node:test", commitSha: "a".repeat(40) },
      localRunId: `run-${attemptId}`, cancellationRequested: false, reports: [], acknowledgedSequence: 0 };
    store.remoteConnection.accept(receipt);
    recovery.recordStart(receipt, workspaceRoot, cache);
    for (const path of [join(workspaceRoot, attemptId), join(workspaceRoot, `.home-${attemptId}`), join(workspaceRoot, `.tmp-${attemptId}`)]) {
      mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, "keep"), "attempt");
    }
    receipt.reports.push(remoteReportSchema.parse({ attemptId, localRunId: receipt.localRunId, sequence: 1, phase: "uncertain",
      execution: { queuedAt: "2026-10-25T00:00:00.000Z", startedAt: null, finishedAt: null, termination: "unknown", cleanup: "unknown" } }));
    receipt.acknowledgedSequence = 1;
    store.remoteConnection.saveReceipt(receipt);
    return receipt;
  };
  const reopen = () => {
    store.close(); store = new SqliteStateStore(databasePath); identity = new IdentityService(store); owner = identity.authenticateBearer(session.token);
    recovery = new WorkerRecoveryService(store.remoteConnection, adapter(), identity);
  };
  const blocked = () => hasUnconfirmedRemoteExecution(store.remoteConnection.receipts(), () => null, receipt => recovery.isReconciled(receipt));
  const input = (path = human): EnqueueTestInput => ({ projectId: project.id, actor: "local-user",
    worktree: { path, head: "b".repeat(40), shortHead: "bbbbbbbb", branch: null, detached: true, dirty: false, locked: false, prunable: false },
    command: { cwd: path, executable: process.execPath, args: ["-e", "process.exit(0)"], preset: { id: "node:test", name: "test", adapter: "node", timeoutMs: 1000 } },
    environment: { environment: {}, mode: "clean", profile: "unit", inheritedServerProfile: null, variableNames: [] } });
  return { root, databasePath, workspaceRoot, cache, human, start, reopen, blocked, input,
    get store() { return store; }, get identity() { return identity; }, get owner() { return owner; }, get recovery() { return recovery; },
    reboot() { boot = nextBoot; }, changeHost() { host = "b".repeat(64); }, unreadable() { readable = false; } };
}

it("uses a simulated same-host reboot to release admission after reopen, retaining uncertain reports and excluding artifacts", async () => {
  const f = fixture(), receipt = f.start();
  const old = f.store.remoteConnection.receipt("attempt")!;
  expect(f.recovery.inspect("attempt", f.owner)).toMatchObject({ blocked: true, recoverable: false, code: "recovery_same_boot_unconfirmed" });
  expect(() => f.recovery.reconcile("attempt", "recover-one", f.owner)).toThrow("recovery_same_boot_unconfirmed");
  f.reboot(); f.reopen();
  expect(f.recovery.inspect("attempt", f.owner)).toMatchObject({ recoverable: true });
  const audit = f.recovery.reconcile("attempt", "recover-one", f.owner);
  expect(audit).toMatchObject({ processExit: "same-host-different-boot", artifacts: "retained-excluded", principalId: f.owner.principalId });
  expect(f.recovery.reconcile("attempt", "recover-one", f.owner)).toEqual(audit);
  f.reopen();
  expect(f.blocked()).toBe(false); // No retained local run details or remote config required.
  const saved = f.store.remoteConnection.receipt("attempt")!;
  expect(saved.reports).toEqual(old.reports); expect(saved.acknowledgedSequence).toBe(1);
  expect(saved.reports.at(-1)).toMatchObject({ phase: "uncertain", execution: { cleanup: "unknown" } });
  // An outbox callback with an old snapshot cannot erase the audit.
  f.store.remoteConnection.saveReceipt(receipt);
  expect(f.store.remoteConnection.receipt("attempt")!.recovery!.audit).toEqual(audit);
  for (const path of [f.cache, join(f.workspaceRoot, "attempt"), join(f.workspaceRoot, ".home-attempt"), join(f.workspaceRoot, ".tmp-attempt")]) {
    expect(existsSync(join(path, "keep"))).toBe(true);
    expect(() => f.recovery.assertPathsAvailable([path])).toThrow("recovery_artifacts_excluded");
  }
  expect(readFileSync(join(f.human, "keep"), "utf8")).toBe("human");
  // Startup uses the existing manager and only the validated recovery decision.
  const jobs = new TestJobManager(f.store, nullLogWriter);
  jobs.configurePathAdmission(paths => f.recovery.assertPathsAvailable(paths));
  if (f.blocked()) jobs.blockAdmission("remote_execution_cleanup_unconfirmed");
  const execution = { resolve: vi.fn() };
  const worker = new RemoteVerificationWorker("worker", f.store.remoteConnection, jobs, () => null, execution,
    { poll: async () => ({ version: 1, assignments: [receipt.assignment], cancellations: [] }), report: async () => undefined }, summary => f.recovery.isReconciled(summary));
  try {
    await worker.tick(); expect(execution.resolve).not.toHaveBeenCalled();
    expect(() => jobs.enqueue(f.input(f.cache))).toThrow("recovery_artifacts_excluded");
    const run = jobs.enqueue(f.input());
    await vi.waitFor(() => expect(f.store.getTestRun(run.id)?.phase).toBe("passed"));
    expect(f.store.getTestRun(receipt.localRunId)).toBeNull();
  } finally { await worker.close(); await jobs.shutdown(); }
});

it("reconciles each blocker independently and rejects conflicting operation reuse", () => {
  const f = fixture(); f.start("one"); f.start("two"); f.reboot();
  f.recovery.reconcile("one", "recover-one", f.owner);
  expect(f.blocked()).toBe(true);
  expect(() => f.recovery.reconcile("two", "recover-one", f.owner)).toThrow("recovery_operation_conflict");
  expect(() => f.recovery.reconcile("one", "different-operation", f.owner)).toThrow("recovery_operation_conflict");
  f.recovery.reconcile("two", "recover-two", f.owner); f.reopen();
  expect(f.blocked()).toBe(false);
});

it("rejects agent, worker, installation and revoked owner authority for both shared operations", () => {
  const f = fixture(); f.start(); f.reboot();
  const agent = f.identity.createAgent(f.owner), worker = f.identity.createWorker(f.owner);
  const agentToken = f.identity.issueAgentToken({ principalId: agent.id, label: "fixture" }, f.owner);
  const workerToken = f.identity.issueWorkerToken({ principalId: worker.id, label: "fixture" }, f.owner);
  const installation: AuthenticatedPrincipal = { principalId: "installation", principalKind: "installation", authenticationMethod: "installation_token", credentialId: "installation" };
  for (const actor of [f.identity.authenticateBearer(agentToken.token), f.identity.authenticateBearer(workerToken.token), installation]) {
    expect(() => f.recovery.inspect("attempt", actor)).toThrow("owner_session_required");
    expect(() => f.recovery.reconcile("attempt", "operation", actor)).toThrow("owner_session_required");
  }
  f.identity.revokeCredential(f.owner.credentialId, f.owner);
  expect(() => f.recovery.inspect("attempt", f.owner)).toThrow();
  expect(() => f.recovery.reconcile("attempt", "operation", f.owner)).toThrow();
  expect(f.blocked()).toBe(true);
});

it.each(["legacy", "legacy-reused-pids", "malformed", "tampered-pids", "tampered-boot", "tampered-path", "different-host", "unreadable", "changed-root", "changed-cache", "symlink-root", "symlink-artifact", "missing-anchor"])("fails closed without signals or deletion for %s evidence", kind => {
  const f = fixture(); f.start(); f.reboot();
  const signal = vi.spyOn(process, "kill");
  if (kind === "different-host") f.changeHost();
  else if (kind === "unreadable") f.unreadable();
  else if (kind === "changed-root" || kind === "changed-cache") {
    const path = kind === "changed-root" ? f.workspaceRoot : f.cache;
    renameSync(path, `${path}-original`); mkdirSync(path, { mode: 0o700 });
  } else if (kind === "symlink-root") {
    renameSync(f.workspaceRoot, `${f.workspaceRoot}-original`); symlinkSync(f.human, f.workspaceRoot);
  } else if (kind === "symlink-artifact") {
    renameSync(join(f.workspaceRoot, "attempt"), join(f.workspaceRoot, "original")); symlinkSync(f.human, join(f.workspaceRoot, "attempt"));
  } else if (kind === "missing-anchor") rmSync(`${f.databasePath}.worker-recovery-key`);
  else {
    const receipt = f.store.remoteConnection.receipt("attempt")!;
    if (kind === "legacy" || kind === "legacy-reused-pids") delete receipt.recovery;
    if (kind === "legacy-reused-pids") Object.assign(receipt, { pid: process.pid, pgid: process.pid });
    if (kind === "tampered-pids") Object.assign(receipt.recovery!.provenance, { pid: process.pid, pgid: process.pid });
    if (kind === "malformed") receipt.recovery = { invalid: true } as never;
    if (kind === "tampered-boot") receipt.recovery!.provenance.boot = originalBoot.replace(/^1/, "3");
    if (kind === "tampered-path") receipt.recovery!.provenance.cache.path = f.human;
    // Deliberate on-disk corruption; production persistence refuses journal rewriting.
    const database = new Database(f.databasePath);
    try { database.prepare("UPDATE remote_worker_receipts SET payload_json=? WHERE attempt_id='attempt'").run(JSON.stringify(receipt)); }
    finally { database.close(); }
  }
  signal.mockClear();
  expect(f.recovery.inspect("attempt", f.owner)).toMatchObject({ blocked: true, recoverable: false });
  expect(() => f.recovery.reconcile("attempt", "recover", f.owner)).toThrow();
  expect(f.blocked()).toBe(true); expect(signal).not.toHaveBeenCalled();
  expect(readFileSync(join(f.human, "keep"), "utf8")).toBe("human");
});

it("refuses copied installation state even on the same simulated host and different boot", () => {
  const f = fixture(); f.start(); f.reboot(); f.store.close();
  const copiedPath = join(f.root, "copy.sqlite3");
  copyFileSync(f.databasePath, copiedPath); copyFileSync(`${f.databasePath}.worker-recovery-key`, `${copiedPath}.worker-recovery-key`);
  const copied = new SqliteStateStore(copiedPath);
  try {
    const identity = new IdentityService(copied);
    const recovery = new WorkerRecoveryService(copied.remoteConnection, new LinuxWorkerRecoveryHost(copiedPath, () => ({ host: "a".repeat(64), boot: nextBoot })), identity);
    expect(recovery.inspect("attempt", f.owner)).toMatchObject({ blocked: true, recoverable: false, code: "recovery_provenance_invalid" });
    expect(() => recovery.reconcile("attempt", "recover-copy", f.owner)).toThrow();
  } finally { copied.close(); }
});

it("retains the block on ambiguous journal/save failures and retries without filesystem mutation", () => {
  const f = fixture(); f.start(); f.reboot();
  const before = f.store.remoteConnection.receipt("attempt");
  const save = f.store.remoteConnection.saveRecovery.bind(f.store.remoteConnection);
  const failure = vi.spyOn(f.store.remoteConnection, "saveRecovery").mockImplementation((attempt, journal) => { save(attempt, journal); throw new Error("save_failed"); });
  expect(() => f.recovery.reconcile("attempt", "operation", f.owner)).toThrow("save_failed");
  expect(f.store.remoteConnection.receipt("attempt")).toEqual(before); // Outer owner transaction rolled back.
  expect(f.blocked()).toBe(true);
  failure.mockRestore(); f.reopen();
  f.recovery.reconcile("attempt", "operation", f.owner);
  expect(f.blocked()).toBe(false);
  expect(readFileSync(join(f.cache, "keep"), "utf8")).toBe("source-cache");
});

it("never executes without a committed pre-work journal and refuses reusing a started attempt", () => {
  const f = fixture(); const receipt = f.start();
  expect(() => f.recovery.recordStart(receipt, f.workspaceRoot, f.cache)).toThrow();
  const next: WorkerReceipt = { ...receipt, assignment: { ...receipt.assignment, attemptId: "not-started" }, localRunId: "next-run", reports: [], acknowledgedSequence: 0 };
  f.store.remoteConnection.accept(next);
  const save = vi.spyOn(f.store.remoteConnection, "saveRecovery").mockImplementation(() => { throw new Error("journal_failed"); });
  expect(() => f.recovery.recordStart(next, f.workspaceRoot, f.cache)).toThrow("journal_failed");
  expect(existsSync(join(f.workspaceRoot, "not-started"))).toBe(false);
  expect(f.store.remoteConnection.receipt("not-started")!.recovery).toBeUndefined();
  save.mockRestore(); expect(f.blocked()).toBe(true);
});

it("permits a new attempt slot with a new independent cache while retaining the original exclusions", () => {
  const f = fixture(), receipt = f.start(); f.reboot();
  f.recovery.reconcile("attempt", "recover", f.owner);
  const cache = join(f.root, "fresh-source-cache"); mkdirSync(cache, { mode: 0o700 });
  const next: WorkerReceipt = { ...receipt, assignment: { ...receipt.assignment, attemptId: "new-attempt", requestId: "new-request" }, localRunId: "new-run", reports: [], acknowledgedSequence: 0 };
  f.store.remoteConnection.accept(next);
  expect(() => f.recovery.recordStart(next, f.workspaceRoot, f.cache)).toThrow("recovery_artifacts_excluded");
  expect(f.store.remoteConnection.receipt("new-attempt")!.recovery).toBeUndefined();
  f.recovery.recordStart(next, f.workspaceRoot, cache);
  expect(f.store.remoteConnection.receipt("new-attempt")!.recovery?.provenance).toMatchObject({ boot: nextBoot, cache: { path: cache } });
  expect(() => f.recovery.assertPathsAvailable([join(f.workspaceRoot, "attempt")])).toThrow("recovery_artifacts_excluded");
});
