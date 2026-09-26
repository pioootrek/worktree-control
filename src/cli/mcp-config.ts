import type { AppPaths } from "../server/paths";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import { AuthenticationService } from "../server/modules/authentication";
import { loadOrCreateSecret } from "../server/secret-file";
import { SqliteStateStore } from "../server/sqlite-store";
import { readServiceAccess } from "./service-access";

export const INSTALLATION_TOKEN_PLACEHOLDER = "<installation token: worktree-switcher auth token rotate>";

export interface McpConfigDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  processExists?: (pid: number) => boolean;
}

/** Mode of a running service from its access record, or of a stopped controller from its database. */
function currentMode(paths: AppPaths, processExists: (pid: number) => boolean): string | null {
  const access = readServiceAccess(paths.serviceAccessPath);
  if (access && processExists(access.pid)) return access.authenticationMode ?? "legacy";
  let lock;
  try {
    lock = acquireControllerLock(paths.controllerLockPath);
  } catch (error) {
    if (error instanceof ControllerAlreadyRunningError) return null;
    throw error;
  }
  try {
    const store = new SqliteStateStore(paths.databasePath);
    try { return new AuthenticationService(store).mode(); } finally { store.close(); }
  } finally {
    lock.release();
  }
}

/**
 * Bearer for `config mcp`, or null when open mode needs none. The raw installation token is never
 * stored, so token mode uses WORKTREE_SWITCHER_TOKEN or prints a placeholder, never the mcp-token.
 */
export function mcpConfigToken(paths: AppPaths, dependencies: McpConfigDependencies = {}): string | null {
  const environment = dependencies.environment ?? process.env;
  const supplied = environment.WORKTREE_SWITCHER_TOKEN;
  if (supplied?.startsWith("wsi_")) return supplied;
  const mode = currentMode(paths, dependencies.processExists ?? ((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }));
  if (mode === "open") return null;
  if (mode !== null && mode !== "legacy") return INSTALLATION_TOKEN_PLACEHOLDER;
  return loadOrCreateSecret(paths.mcpTokenPath);
}
