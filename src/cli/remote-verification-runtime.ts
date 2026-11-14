import { readFileSync } from "node:fs";
import type { GitCommandAdmission, GitWorktreeReader } from "@/server/git-worktrees";
import type { IdentityService } from "@/server/modules/identity";
import type { ProjectLifecycle } from "@/server/modules/lifecycle";
import { RemoteVerificationController, type WorkerRecoveryService } from "@/server/modules/remote-verification";
import { createRemoteWorker } from "@/server/bootstrap/remote-worker";
import type { SqliteStateStore } from "@/server/sqlite-store";
import type { TestJobManager } from "@/server/test-job-manager";
import { createRemoteVerificationServer } from "@/server/transports/remote-verification-http";
import { readRemoteWorkerToken, type RemoteVerificationConfig } from "./remote-verification";

export function createRemoteVerificationRuntime(config: RemoteVerificationConfig | null, dependencies: {
  store: SqliteStateStore; identity: IdentityService; jobs: TestJobManager; lifecycle: ProjectLifecycle; git: GitWorktreeReader; admission: GitCommandAdmission; recovery: WorkerRecoveryService;
}) {
  if (!config) return null;
  const { store, identity, jobs, lifecycle, git, admission, recovery } = dependencies;
  jobs.configurePathAdmission(paths => recovery.assertPathsAvailable(paths));
  const controller = new RemoteVerificationController(store, store.remoteConnection, identity);
  controller.recover();
  const listener = config.listener ? createRemoteVerificationServer({
    controller, identity, allowLoopbackHttpFixture: config.listener.allowLoopbackHttpFixture, admission: store.admission,
    ...(config.listener.keyFile && config.listener.certFile ? { tls: { key: readFileSync(config.listener.keyFile), cert: readFileSync(config.listener.certFile) } } : {}),
  }) : null;
  const workerConfig = config.worker;
  if (workerConfig) readRemoteWorkerToken(workerConfig.tokenFile);
  const worker = workerConfig ? createRemoteWorker(workerConfig, () => readRemoteWorkerToken(workerConfig.tokenFile), { store, jobs, lifecycle, git, admission, recovery }) : null;
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
