import type { AppPaths } from "../server/paths";
import { acquireControllerLock, ControllerAlreadyRunningError, type ControllerLock } from "../server/controller-lock";
import { AuthenticationService } from "../server/modules/authentication";
import { SqliteStateStore } from "../server/sqlite-store";

export interface AuthCommandDependencies {
  write?: (line: string) => void;
}

const USAGE = "Available auth commands: status, token generate, token rotate, mode set <open|token|better-auth>";
const ACTOR = "local-cli";

function lockForAdministration(paths: AppPaths): ControllerLock {
  try {
    return acquireControllerLock(paths.controllerLockPath);
  } catch (error) {
    if (error instanceof ControllerAlreadyRunningError) {
      throw new Error(`The controller is running (PID ${error.pid}). Stop it before changing authentication; this command opens the database only while the controller is stopped.`);
    }
    throw error;
  }
}

export async function runAuthCommand(
  args: string[],
  paths: AppPaths,
  dependencies: AuthCommandDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? console.log;
  const [group, action, value, ...rest] = args;
  const command = [group, action].filter(Boolean).join(" ");
  const valid = (group === "status" && action === undefined)
    || (group === "token" && (action === "generate" || action === "rotate") && value === undefined)
    || (group === "mode" && action === "set" && value !== undefined && rest.length === 0);
  if (!valid) throw new Error(USAGE);

  const lock = lockForAdministration(paths);
  let store: SqliteStateStore | null = null;
  try {
    store = new SqliteStateStore(paths.databasePath);
    const service = new AuthenticationService(store);
    switch (command) {
      case "status":
        write(JSON.stringify(service.status(), null, 2));
        return;
      case "token generate":
        write(JSON.stringify(service.generateToken(ACTOR), null, 2));
        return;
      case "token rotate":
        write(JSON.stringify(service.rotateToken(ACTOR), null, 2));
        return;
      case "mode set":
        write(JSON.stringify(service.setMode(value!, ACTOR), null, 2));
        return;
    }
  } finally {
    store?.close();
    lock.release();
  }
}
