import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireControllerLock } from "@/server/controller-lock";
import { acquireDatabaseOwnership, getOwnedRestoreStatus } from "@/server/infrastructure/sqlite";
import { assertNoUnfinishedControllerRestoreRequests } from "@/server/restore-requests";
import { assertNoUnfinishedBackupHandoff } from "./restore-operations";
import { rebindRemoteLedger } from "./remote-records";

export async function rebindRemoteBackup(input: { controllerLockPath: string; databasePath: string; from: string; destinationId: string; generation: number }, authenticate: (directory: string) => Promise<void>): Promise<{ destinationId: string; generation: number; archivedRepositories: number; newTargetInitiallyProtected: false }> {
  const inspect = (path: string) => {
    const restore = getOwnedRestoreStatus(path);
    if (restore && restore.state !== "verified") throw new Error("Unfinished restore prevents remote rebind.");
    assertNoUnfinishedBackupHandoff(path); assertNoUnfinishedControllerRestoreRequests(path);
  };
  // Early refusal, then repeat authoritatively under the canonical DB lock.
  const absolute = resolve(input.databasePath);
  inspect(join(realpathSync(dirname(absolute)), basename(absolute)));
  const controller = acquireControllerLock(input.controllerLockPath);
  try {
    const ownership = acquireDatabaseOwnership(input.databasePath, { inspectOnly: true, inspect });
    try {
      const directory = `${ownership.path}.backup-operations`;
      await authenticate(directory);
      const ledger = rebindRemoteLedger(join(directory, "remote.json"), input.from, input.destinationId, input.generation);
      return { destinationId: ledger.destinationId, generation: ledger.rebindGeneration, archivedRepositories: ledger.archives.length, newTargetInitiallyProtected: false };
    } finally { ownership.lock.release(); }
  } finally { controller.release(); }
}
