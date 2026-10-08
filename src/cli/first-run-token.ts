import type { Locale } from "../i18n/messages";
import { translate } from "../i18n/messages";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import { openCurrentControllerStore } from "../server/controller-storage";
import type { AppPaths } from "../server/paths";
import { AuthenticationService, executeAuthenticationCommand, type IssuedInstallationToken } from "../server/modules/authentication";
import { assertBackupHandoffCompleted } from "../server/modules/backups";
import { AUTH_CLI_ACTOR } from "./auth-management";

/** The terminal that receives a first-run token. Only an interactive one is ever written to. */
export interface FirstRunTerminal {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface FirstRunTokenOptions {
  terminal: FirstRunTerminal;
  locale: Locale;
  /** A supervised controller writes to a service log, never to an operator's terminal. */
  serviceMode?: boolean;
}

export class FirstRunTokenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirstRunTokenRefusedError";
  }
}

/**
 * Issues the installation token of a new token-mode installation through the same command as
 * `auth token generate` and shows it once. Refuses instead of issuing when the token could land
 * in a log: service mode or a terminal that is not interactive.
 */
export function bootstrapInstallationToken(authentication: AuthenticationService, options: FirstRunTokenOptions): boolean {
  const status = authentication.status();
  if (status.mode !== "token" || status.token) return false;
  if (options.serviceMode || options.terminal.isTTY !== true) {
    throw new FirstRunTokenRefusedError(translate(options.locale, "cli.firstRunToken.terminalRequired"));
  }
  const { result } = executeAuthenticationCommand(authentication, { command: "token generate" }, AUTH_CLI_ACTOR);
  const { token } = result as IssuedInstallationToken;
  options.terminal.write([
    "",
    translate(options.locale, "cli.firstRunToken.issued"),
    "",
    `  ${token}`,
    "",
    translate(options.locale, "cli.firstRunToken.warning"),
    "",
    "",
  ].join("\n"));
  return true;
}

/**
 * `service install` variant: runs offline under the controller lock before the unit starts, like
 * `auth token generate`. A running controller (or another database owner) already satisfies its
 * startup policy; a database that still needs a migration or a pending restore handoff is left to
 * the controller. None of them is opened here.
 */
export function bootstrapServiceInstallationToken(paths: AppPaths, options: FirstRunTokenOptions): boolean {
  let lock;
  try {
    lock = acquireControllerLock(paths.controllerLockPath);
  } catch (error) {
    if (error instanceof ControllerAlreadyRunningError) return false;
    throw error;
  }
  let store = null;
  try {
    try {
      assertBackupHandoffCompleted(paths.databasePath);
    } catch {
      return false;
    }
    try {
      store = openCurrentControllerStore(paths.databasePath);
    } catch (error) {
      if (error instanceof ControllerAlreadyRunningError) return false;
      throw error;
    }
    if (!store) return false;
    return bootstrapInstallationToken(new AuthenticationService(store), options);
  } finally {
    store?.close();
    lock.release();
  }
}
