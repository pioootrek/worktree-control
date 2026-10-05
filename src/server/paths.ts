import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readProductEnvironment, warnOnce, warnOnStderr } from "./product-environment";

export interface AppPaths {
  adminSocketPath: string;
  controllerLockPath: string;
  dataDirectory: string;
  databasePath: string;
  knowledgeAttachmentDirectory: string;
  mcpTokenPath: string;
  serviceAccessPath: string;
  stateDirectory: string;
  logDirectory: string;
}

/** Directory name under the XDG data and state bases for new installations. */
export const APP_DIRECTORY_NAME = "worktree-control";
/** Pre-rename directory name, used only when it exists and the new one does not. */
export const LEGACY_APP_DIRECTORY_NAME = "worktree-switcher";

export interface AppPathsOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  exists?: (path: string) => boolean;
  warn?: (message: string) => void;
}

/**
 * Explicit directories and `WORKTREE_CONTROL_*_DIR` (or legacy `WORKTREE_SWITCHER_*_DIR`) are used
 * as given. Default directories prefer `worktree-control`, but keep using an existing
 * `worktree-switcher` directory while the new one does not exist. Data is never moved or copied.
 */
export function resolveAppPaths(dataDirectory?: string, stateDirectory?: string, options: AppPathsOptions = {}): AppPaths {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const exists = options.exists ?? existsSync;
  const warn = options.warn ?? warnOnStderr;
  const defaultDirectory = (base: string, flag: string, variable: string): string => {
    const current = join(base, APP_DIRECTORY_NAME);
    const legacy = join(base, LEGACY_APP_DIRECTORY_NAME);
    if (exists(current) || !exists(legacy)) return current;
    warnOnce(warn, legacy, `Notice: using the existing ${legacy} directory; pass ${flag} or set ${variable} to choose explicitly.`);
    return legacy;
  };

  const dataVariable = dataDirectory ? undefined : readProductEnvironment(environment, "WORKTREE_CONTROL_DATA_DIR", warn);
  const appDirectory = dataDirectory || dataVariable
    ? resolve(dataDirectory ?? dataVariable!)
    : defaultDirectory(resolve(environment.XDG_DATA_HOME ?? join(home, ".local", "share")), "--data-dir", "WORKTREE_CONTROL_DATA_DIR");
  const stateVariable = stateDirectory ? undefined : readProductEnvironment(environment, "WORKTREE_CONTROL_STATE_DIR", warn);
  const appStateDirectory = stateDirectory || stateVariable
    ? resolve(stateDirectory ?? stateVariable!)
    : dataDirectory
      ? resolve(dataDirectory, "state")
      : defaultDirectory(resolve(environment.XDG_STATE_HOME ?? join(home, ".local", "state")), "--state-dir", "WORKTREE_CONTROL_STATE_DIR");

  return {
    adminSocketPath: join(appStateDirectory, "admin.sock"),
    controllerLockPath: join(appStateDirectory, "controller.lock"),
    dataDirectory: appDirectory,
    databasePath: join(appDirectory, "state.sqlite3"),
    knowledgeAttachmentDirectory: join(appDirectory, "knowledge-attachments"),
    mcpTokenPath: join(appDirectory, "mcp-token"),
    serviceAccessPath: join(appStateDirectory, "service-access.json"),
    stateDirectory: appStateDirectory,
    logDirectory: join(appStateDirectory, "logs"),
  };
}
