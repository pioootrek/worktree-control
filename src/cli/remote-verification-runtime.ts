import { readFileSync } from "node:fs";
import type { GitCommandAdmission, GitWorktreeReader } from "@/server/git-worktrees";
import type { IdentityService } from "@/server/modules/identity";
import type { ProjectLifecycle } from "@/server/modules/lifecycle";
import { RemoteVerificationController, RemoteVerificationWorker } from "@/server/modules/remote-verification";
import { SystemRemoteVerificationWorkspacePreparer, SystemRemoteWorkerExecution } from "@/server/infrastructure/git";
import type { SqliteStateStore } from "@/server/sqlite-store";
import { ProjectTestCommandResolver } from "@/server/test-command";
import type { TestJobManager } from "@/server/test-job-manager";
import { createRemoteVerificationServer, HttpRemoteWorkerTransport } from "@/server/transports/remote-verification-http";
import { readRemoteWorkerToken, type RemoteVerificationConfig } from "./remote-verification";

export function createRemoteVerificationRuntime(config: RemoteVerificationConfig | null, dependencies: {
  store: SqliteStateStore; identity: IdentityService; jobs: TestJobManager; lifecycle: ProjectLifecycle; git: GitWorktreeReader; admission: GitCommandAdmission;
}) {
  if (!config) return null;
  const { store, identity, jobs, lifecycle, git, admission } = dependencies;
  const controller = new RemoteVerificationController(store, store.remoteConnection, identity);
  controller.recover();
  const listener = config.listener ? createRemoteVerificationServer({
    controller, identity, allowLoopbackHttpFixture: config.listener.allowLoopbackHttpFixture,
    ...(config.listener.keyFile && config.listener.certFile ? { tls: { key: readFileSync(config.listener.keyFile), cert: readFileSync(config.listener.certFile) } } : {}),
  }) : null;
  const workerConfig = config.worker;
  if (workerConfig) readRemoteWorkerToken(workerConfig.tokenFile);
  const worker = workerConfig ? new RemoteVerificationWorker(workerConfig.workerId, store.remoteConnection, jobs, id => store.getTestRun(id),
    new SystemRemoteWorkerExecution(workerConfig.workerId, workerConfig.mappings, store, lifecycle, git, new ProjectTestCommandResolver(),
      new SystemRemoteVerificationWorkspacePreparer(workerConfig.workspaceRoot, admission), workerConfig.workspaceRoot),
    new HttpRemoteWorkerTransport(workerConfig.origin, workerConfig.workerId, () => readRemoteWorkerToken(workerConfig.tokenFile), workerConfig.allowLoopbackHttpFixture)) : null;
  return {
    controller,
    async start() {
      if (listener && config.listener) await new Promise<void>((resolve, reject) => {
        listener.server.once("error", reject);
        listener.server.listen(config.listener!.port, config.listener!.host, () => { listener.server.off("error", reject); resolve(); });
      });
      worker?.start();
    },
    async close() { await worker?.close(); await listener?.close(); },
  };
}
