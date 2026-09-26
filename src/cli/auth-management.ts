import type { AppPaths } from "../server/paths";
import { requestAdminSocket } from "../server/admin-socket";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import {
  AuthenticationService,
  authenticationCommandFromArgs,
  executeAuthenticationCommand,
} from "../server/modules/authentication";
import { SqliteStateStore } from "../server/sqlite-store";

export interface AuthCommandDependencies {
  write?: (line: string) => void;
}

const ACTOR = "local-cli";

/**
 * A stopped controller is administered offline under the singleton lock; a running one through
 * its owner-only admin socket, so the database never gets a second owner.
 */
export async function runAuthCommand(
  args: string[],
  paths: AppPaths,
  dependencies: AuthCommandDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? console.log;
  const request = authenticationCommandFromArgs(args);

  let lock;
  try {
    lock = acquireControllerLock(paths.controllerLockPath);
  } catch (error) {
    if (!(error instanceof ControllerAlreadyRunningError)) throw error;
    let result: unknown;
    try {
      result = await requestAdminSocket(paths.adminSocketPath, request);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT" || (cause as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        throw new Error(`The controller is running (PID ${error.pid}) without an admin socket at ${paths.adminSocketPath}. Restart it with this version, or stop it to change authentication offline.`);
      }
      throw cause;
    }
    write(JSON.stringify(result, null, 2));
    return;
  }
  let store: SqliteStateStore | null = null;
  try {
    store = new SqliteStateStore(paths.databasePath);
    const { result } = executeAuthenticationCommand(new AuthenticationService(store), request, ACTOR);
    write(JSON.stringify(result, null, 2));
  } finally {
    store?.close();
    lock.release();
  }
}
