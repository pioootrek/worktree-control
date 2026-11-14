import { acquireControllerLock, type ControllerLock } from "@/server/controller-lock";
import { openControllerStore, type MigrationBackupOptions } from "@/server/controller-storage";
import { GitCommandAdmission, SystemGitWorktreeReader } from "@/server/git-worktrees";
import { LinuxWorkerRecoveryHost } from "@/server/infrastructure/git";
import { openRunDirectoryRoot, unavailableRunDirectories } from "@/server/infrastructure/run-directories";
import { FileLogWriter } from "@/server/log-writer";
import { finishBackupHandoff, recoverBackupHandoff, type BackupPolicy } from "@/server/modules/backups";
import { ProjectLifecycle } from "@/server/modules/lifecycle";
import { hasUnconfirmedRemoteExecution, WorkerRecoveryService } from "@/server/modules/remote-verification";
import type { AppPaths } from "@/server/paths";
import { ProcessManager } from "@/server/process-manager";
import { TestJobManager } from "@/server/test-job-manager";
import { createControllerShutdown } from "./controller-shutdown";
import { createRemoteWorker, type RemoteWorkerSettings } from "./remote-worker";

export interface WorkerProcessOptions {
  paths: AppPaths;
  settings: RemoteWorkerSettings;
  credential: () => string;
  migrationBackup: MigrationBackupOptions;
  /** Only its directory is used, to complete a restore handoff exactly as controller startup does. */
  backupPolicy: BackupPolicy;
  applicationVersion: string;
}

export interface WorkerProcess {
  admissionBlockReason: string | null;
  /** Stops polling, then runs the controller's shutdown sequence. A rejection retains ownership. */
  shutdown(stopping?: () => void): Promise<void>;
}

/** A pending rejection and exit code alone cannot keep Node, and so the owner lock, alive. */
const retainedOwners = new Set<{ resource: unknown; lifetime: ReturnType<typeof setInterval> }>();
function retainOwnership(resource: unknown): void {
  const retained = { resource, lifetime: setInterval(() => { void retained.resource; }, 60_000) };
  retainedOwners.add(retained);
  process.exitCode = 1;
}

/**
 * Runs every cleanup step of a failed startup, newest first, even after one rejects. As in
 * controller startup, the lock is released only when all of them succeeded; otherwise ownership
 * is retained for operator recovery and the failures join the original error.
 */
async function abandonStartup(error: unknown, opened: Array<() => void | Promise<void>>, lock: ControllerLock): Promise<unknown> {
  const failures: unknown[] = [];
  for (const close of opened.reverse()) {
    try { await close(); } catch (failure) { failures.push(failure); }
  }
  if (!failures.length) {
    try { lock.release(); return error; } catch (failure) { failures.push(failure); }
  }
  retainOwnership(lock);
  return new AggregateError([error, ...failures], "Worker startup failed and its cleanup is unconfirmed; ownership retained. Operator recovery is required.");
}

/**
 * Worker-only composition: the controller's lock, store, logs, run directories, test queue, Git
 * and lifecycle, plus the outbound worker. No HTTP, MCP, admin socket, remote-verification
 * listener, Knowledge, backups, schedules, Godot preview, vault or authentication bootstrap.
 */
export async function startWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcess> {
  const { paths } = options;
  const lock = acquireControllerLock(paths.controllerLockPath);
  // Everything that can fail runs here, before the lifetime timer and the first poll.
  const opened: Array<() => void | Promise<void>> = [];
  const compose = async () => {
    const handoff = recoverBackupHandoff(paths.databasePath, paths.knowledgeAttachmentDirectory, options.backupPolicy);
    const owned = await openControllerStore(paths.databasePath, { ...options.migrationBackup, applicationVersion: options.applicationVersion, attachmentDirectory: paths.knowledgeAttachmentDirectory });
    opened.push(() => owned.close());
    if (handoff) finishBackupHandoff(paths.databasePath, handoff, owned);
    const logs = new FileLogWriter(paths.logDirectory);
    opened.push(() => logs.close());
    const processes = new ProcessManager(() => undefined, logs, { admission: owned.admission });
    const lifecycle = new ProjectLifecycle(owned, processes);
    const runDirectories = await openRunDirectoryRoot({ stateDirectory: paths.stateDirectory, logs }).catch((error: unknown) => {
      logs.controller("run_directory.root_unavailable", { error: String(error) });
      return unavailableRunDirectories();
    });
    const tests = new TestJobManager(owned, logs);
    opened.push(() => tests.shutdown());
    tests.configureRunDirectories(runDirectories);
    const recovery = new WorkerRecoveryService(owned.remoteConnection, new LinuxWorkerRecoveryHost(paths.databasePath));
    tests.configurePathAdmission(checked => recovery.assertPathsAvailable(checked));
    // Same startup rule as the controller: unconfirmed remote cleanup blocks all test admission.
    if (hasUnconfirmedRemoteExecution(owned.remoteConnection.receipts(), id => owned.getTestRun(id), receipt => recovery.isReconciled(receipt))) {
      tests.blockAdmission("remote_execution_cleanup_unconfirmed");
    }
    const gitAdmission = new GitCommandAdmission();
    const git = new SystemGitWorktreeReader(gitAdmission);
    opened.push(() => git.close());
    const worker = createRemoteWorker(options.settings, options.credential, { store: owned, jobs: tests, lifecycle, git, admission: gitAdmission, recovery });
    opened.push(() => worker.close());
    const admissionBlockReason = tests.status().admissionBlockReason ?? null;
    logs.controller("worker.started", { workerId: options.settings.workerId, origin: new URL(options.settings.origin).origin });
    return { owned, logs, processes, lifecycle, tests, git, worker, admissionBlockReason };
  };
  const { owned, logs, processes, lifecycle, tests, git, worker, admissionBlockReason } = await compose()
    .catch(async (error: unknown) => { throw await abandonStartup(error, opened, lock); });
  // The worker's poll timer is unreferenced; this keeps the process, and on failed cleanup its
  // ownership, alive. It is cleared only after the whole shutdown, lock release included, succeeds.
  const lifetime = setInterval(() => undefined, 60_000);
  worker.start();

  let polling: Promise<void> | undefined;
  let stoppingCallback: (() => void) | undefined;
  // The parts of ControlService.shutdown that a worker owns, in the same order.
  const closeAdmission = () => { lifecycle.closeAdmission(); processes.closeAdmission(); };
  const shutdownResources = async () => {
    closeAdmission();
    const failures: unknown[] = [];
    const cleanup = await Promise.allSettled([lifecycle.closeAndDrain(), tests.shutdown(), processes.stopAll()]);
    failures.push(...cleanup.filter(result => result.status === "rejected").map(result => result.reason));
    git.close();
    // Unconfirmed process/job cleanup may still need the owned database.
    if (!failures.length) try { await owned.closeAfterDrain(); } catch (error) { failures.push(error); }
    try { await logs.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Worker resources did not close cleanly.");
  };
  const absent = { close() {} };
  const sequence = createControllerShutdown({
    service: { closeAdmission, shutdown: shutdownResources },
    stopping: () => stoppingCallback?.(),
    userSchedules: undefined, backups: absent, mcp: null, controller: absent, adminSocket: absent,
    remoteVerification: { close: () => polling ?? worker.close() },
    removeServiceAccess() {},
    controllerLock: lock,
  });
  return {
    admissionBlockReason,
    shutdown(stopping) {
      stoppingCallback ??= stopping;
      // Stop polling first: the timer is cleared synchronously and no new tick starts.
      polling ??= worker.close();
      return sequence().then(() => clearInterval(lifetime));
    },
  };
}
