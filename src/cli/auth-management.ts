import { runSecurityFenceCommand } from "./security-fence";
import type { AppPaths } from "../server/paths";
import { requestAdminSocket } from "../server/admin-socket";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import {
  AuthenticationService,
  authenticationCommandFromArgs,
  executeAuthenticationCommand,
} from "../server/modules/authentication";
import { SqliteStateStore } from "../server/sqlite-store";
import type { Readable } from "node:stream";
import { createAuthenticationAdministration, retainAuthenticationOwnership, type AuthenticationAdministrationOptions } from "../server/bootstrap/authentication-administration";
import { ProviderAdminError, providerAdminFailure } from "../server/modules/authentication";
import { AdminRequestError } from "../server/admin-socket";
import { isProviderCommandArgs, providerCommandFromArgs } from "./auth-provider-input";

export interface AuthCommandDependencies {
  write?: (line: string) => void;
  input?: Readable;
  /** Trusted composition seam for finite lifecycle tests; never parsed from user input. */
  provider?: Pick<AuthenticationAdministrationOptions, "loadProvider" | "onInvalidation" | "drainTimeoutMs">;
}

/** Audit actor of offline auth administration, including the first-run token of `start`. */
export const AUTH_CLI_ACTOR = "local-cli";

/**
 * A stopped controller is administered offline under the singleton lock; a running one through
 * its owner-only admin socket, so the database never gets a second owner.
 */
export async function runAuthCommand(
  args: string[],
  paths: AppPaths,
  dependencies: AuthCommandDependencies = {},
): Promise<void> {
  if (args[0] === "fence") return runSecurityFenceCommand(args, paths, dependencies.write ?? console.log);
  if (isProviderCommandArgs(args)) return runProviderCommand(args, paths, dependencies);
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
  let administration: ReturnType<typeof createAuthenticationAdministration> | undefined;
  try {
    store = new SqliteStateStore(paths.databasePath);
    const authentication = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
    if (request.command === "mode set" && request.value === "better-auth") {
      administration = createAuthenticationAdministration({ store, authentication, dataDirectory: paths.dataDirectory, actor: AUTH_CLI_ACTOR });
      await authentication.prepareAccountMode();
    }
    const { result } = executeAuthenticationCommand(authentication, request, AUTH_CLI_ACTOR);
    write(JSON.stringify(result, null, 2));
  } finally {
    try { await administration?.dispose(); await store?.closeAfterDrain(); lock.release(); }
    catch { retainAuthenticationOwnership({ store, administration, lock }); throw new ProviderAdminError("disposal_unconfirmed", undefined, false); }
  }
}

async function runProviderCommand(args: string[], paths: AppPaths, dependencies: AuthCommandDependencies): Promise<void> {
  // All bytes are read BEFORE ownership; no read wait holds the single connection.
  const request = await providerCommandFromArgs(args, dependencies.input);
  const write = dependencies.write ?? console.log;
  let lock;
  try { lock = acquireControllerLock(paths.controllerLockPath); }
  catch (error) {
    if (!(error instanceof ControllerAlreadyRunningError)) throw providerAdminFailure(error);
    try {
      const result = await requestAdminSocket(paths.adminSocketPath, request, 15_000, 16 * 1024);
      write(JSON.stringify(result, null, 2)); return;
    } catch (cause) {
      if (cause instanceof AdminRequestError) throw cause;
      throw new ProviderAdminError("admin_outcome_unknown");
    }
  }
  let store: SqliteStateStore;
  try { store = new SqliteStateStore(paths.databasePath); }
  catch (error) { lock.release(); throw providerAdminFailure(error); }
  let administration: ReturnType<typeof createAuthenticationAdministration> | undefined;
  let result: unknown, effectFailure: unknown;
  try {
    administration = createAuthenticationAdministration({ store, dataDirectory: paths.dataDirectory,
      authentication: new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline"),
      actor: AUTH_CLI_ACTOR,
      configurationEvent: () => { process.stderr.write('{"event":"authentication.provider_configuration_written"}\n'); },
      ...dependencies.provider });
    result = await administration.execute(request);
  } catch (error) { effectFailure = providerAdminFailure(error); }
  try {
    await administration?.dispose();
    await store.closeAfterDrain();
    lock.release();
  } catch {
    retainAuthenticationOwnership({ store, administration, lock });
    const mutation = !["status", "human-list", "knowledge-access-list", "runtime-access-list"].includes(request.action)
      && !(request.action === "human-disable" && (result as { changed?: boolean } | undefined)?.changed === false);
    const committed = (result !== undefined && mutation) || providerAdminFailure(effectFailure).committed;
    throw new ProviderAdminError("disposal_unconfirmed", committed ? true : undefined, false);
  }
  if (effectFailure) throw effectFailure;
  write(JSON.stringify(result, null, 2));
}
