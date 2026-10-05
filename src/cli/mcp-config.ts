import type { AppPaths } from "../server/paths";
import { requestAdminSocket } from "../server/admin-socket";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import { AuthenticationService } from "../server/modules/authentication";
import { loadOrCreateSecret } from "../server/secret-file";
import { SqliteStateStore } from "../server/sqlite-store";
import { readServiceAccess } from "./service-access";
import { readProductEnvironment } from "../server/product-environment";

export const INSTALLATION_TOKEN_PLACEHOLDER = "<installation token: worktree-control auth token rotate>";

export interface McpConfigDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  processExists?: (pid: number) => boolean;
  /** Authentication status of a running controller; defaults to its admin socket. */
  requestStatus?: () => Promise<unknown>;
}

/**
 * Mode of a running service from its access record, of a foreground controller from its admin
 * socket, or of a stopped controller from its database. Never guesses: a wrong guess would print a
 * credential the controller rejects.
 */
async function currentMode(paths: AppPaths, dependencies: McpConfigDependencies): Promise<string> {
  const processExists = dependencies.processExists ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const access = readServiceAccess(paths.serviceAccessPath);
  if (access && processExists(access.pid)) return access.authenticationMode ?? "legacy";
  let lock;
  try {
    lock = acquireControllerLock(paths.controllerLockPath);
  } catch (error) {
    if (!(error instanceof ControllerAlreadyRunningError)) throw error;
    const requestStatus = dependencies.requestStatus ?? (() => requestAdminSocket(paths.adminSocketPath, { command: "status" }));
    const status = await requestStatus().catch(() => null) as { mode?: unknown } | null;
    if (typeof status?.mode === "string") return status.mode;
    throw new Error(`The controller is running (PID ${error.pid}) without an access record or admin socket, so its MCP credential is unknown. Restart it with this version, or stop it and run config mcp again.`);
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
 * stored, so token mode uses WORKTREE_CONTROL_TOKEN or prints a placeholder, never the mcp-token.
 */
export async function mcpConfigToken(paths: AppPaths, dependencies: McpConfigDependencies = {}): Promise<string | null> {
  const environment = dependencies.environment ?? process.env;
  const supplied = readProductEnvironment(environment, "WORKTREE_CONTROL_TOKEN");
  if (supplied?.startsWith("wsi_")) return supplied;
  const mode = await currentMode(paths, dependencies);
  if (mode === "open") return null;
  if (mode !== "legacy") return INSTALLATION_TOKEN_PLACEHOLDER;
  return loadOrCreateSecret(paths.mcpTokenPath);
}
