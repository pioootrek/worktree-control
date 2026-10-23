// Isolated crash fixture: its own SQLite owner, worker, queue and source clone.
import { readFileSync } from "node:fs";
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
});
await runtime!.start();
process.send?.({ ready: true, admissionBlockReason: jobs.status().admissionBlockReason ?? null });
process.on("message", message => {
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
