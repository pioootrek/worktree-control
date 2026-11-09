import { LinuxWorkerRecoveryHost } from "@/server/infrastructure/git";
import { WorkerRecoveryService } from "@/server/modules/remote-verification";
// Isolated crash fixture: its own SQLite owner, worker, queue and source clone.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { acquireControllerLock } from "@/server/controller-lock";
import { SqliteStateStore } from "@/server/sqlite-store";
import { IdentityService } from "@/server/modules/identity";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { ProcessManager } from "@/server/process-manager";
import { TestJobManager } from "@/server/test-job-manager";
import { nullLogWriter } from "@/server/log-writer";
import { GitCommandAdmission, SystemGitWorktreeReader } from "@/server/git-worktrees";
import { createRemoteVerificationRuntime } from "@/cli/remote-verification-runtime";
import { remoteVerificationConfigSchema } from "@/cli/remote-verification";

const [databasePath, lockPath, configPath] = process.argv.slice(2);
const lock = acquireControllerLock(lockPath);
const store = new SqliteStateStore(databasePath);
const jobs = new TestJobManager(store, nullLogWriter);
const admission = new GitCommandAdmission();
const git = new SystemGitWorktreeReader(admission);
const processes = new ProcessManager(() => undefined, nullLogWriter);
const lifecycle = new ProjectLifecycle(store, processes);
const runtime = createRemoteVerificationRuntime(remoteVerificationConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8"))), {
  store, identity: new IdentityService(store), jobs, lifecycle, git, admission,
  recovery: new WorkerRecoveryService(store.remoteConnection, new LinuxWorkerRecoveryHost(databasePath)),
});
await runtime!.start();
process.send?.({ ready: true, admissionBlockReason: jobs.status().admissionBlockReason ?? null });
process.on("message", message => {
  if (message === "crash-confirmed" || message === "crash-pending") {
    const receipt = store.remoteConnection.receipts()[0];
    assert.equal(receipt?.lastPhase, "running");
    const run = store.getTestRun(receipt.localRunId);
    assert.equal(run?.phase, "running");
    const freeze = () => {
      const fence = JSON.parse(readFileSync(`${databasePath}.security/witness.json`, "utf8")).payload;
      process.send?.({ crash: message, fenceState: fence.state, attemptId: receipt.assignment.attemptId });
      // Freeze this process between synchronous SQLite operations until the
      // parent SIGKILLs it. The real command and its descendant keep running.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
      throw new Error("Parent did not kill the worker at the requested crash boundary");
    };
    if (message === "crash-pending") {
      // A normal authority write inside an unfinished transaction durably
      // publishes pending. Reopening this crash requires protected recovery.
      store.remoteConnection.atomic(() => { store.saveTestRun(run!); freeze(); });
    } else freeze();
    return;
  }
  if (message !== "close") return;
  void (async () => {
    await runtime!.close();
    await jobs.shutdown();
    git.close();
    store.close();
    lock.release();
    process.exit(0);
  })();
});
