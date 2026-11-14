import type { GitCommandAdmission, GitWorktreeReader } from "@/server/git-worktrees";
import { SystemRemoteVerificationWorkspacePreparer, SystemRemoteWorkerExecution, type RemoteWorkerProjectMapping } from "@/server/infrastructure/git";
import type { ProjectLifecycle } from "@/server/modules/lifecycle";
import { RemoteVerificationWorker, type WorkerRecoveryService } from "@/server/modules/remote-verification";
import type { SqliteStateStore } from "@/server/sqlite-store";
import { ProjectTestCommandResolver } from "@/server/test-command";
import type { TestJobManager } from "@/server/test-job-manager";
import { HttpRemoteWorkerTransport } from "@/server/transports/remote-verification-http";

export interface RemoteWorkerSettings {
  workerId: string;
  origin: string;
  workspaceRoot: string;
  allowLoopbackHttpFixture: boolean;
  mappings: RemoteWorkerProjectMapping[];
}

export interface RemoteWorkerDependencies {
  store: SqliteStateStore;
  jobs: TestJobManager;
  lifecycle: ProjectLifecycle;
  git: GitWorktreeReader;
  admission: GitCommandAdmission;
  recovery: WorkerRecoveryService;
}

/**
 * The one construction of the outbound worker, its execution adapter and its transport, used by
 * the embedded controller mode and the worker-only process. The credential is read again for
 * every request, so a replaced file takes effect without a restart.
 */
export function createRemoteWorker(settings: RemoteWorkerSettings, credential: () => string, dependencies: RemoteWorkerDependencies): RemoteVerificationWorker {
  const { store, jobs, lifecycle, git, admission, recovery } = dependencies;
  const execution = new SystemRemoteWorkerExecution(settings.workerId, settings.mappings, store, lifecycle, git, new ProjectTestCommandResolver(),
    new SystemRemoteVerificationWorkspacePreparer(settings.workspaceRoot, admission), settings.workspaceRoot, recovery);
  const transport = new HttpRemoteWorkerTransport(settings.origin, settings.workerId, credential, settings.allowLoopbackHttpFixture);
  return new RemoteVerificationWorker(settings.workerId, store.remoteConnection, jobs, id => store.getTestRun(id), execution, transport,
    receipt => recovery.isReconciled(receipt), store.admission);
}
