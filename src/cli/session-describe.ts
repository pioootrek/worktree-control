import { writeSync } from "node:fs";
import { z } from "zod";
import { requestAdminSocket } from "../server/admin-socket";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import type { AppPaths } from "../server/paths";
import { SecurityFenceError, UpgradeError } from "../server/infrastructure/sqlite";
import { SqliteStateStore } from "../server/sqlite-store";
import { BackupHandoffPendingError, assertBackupHandoffCompleted } from "../server/modules/backups";
import { buildOfflineOperationsRuntime } from "../server/bootstrap/offline-operations-runtime";
import { closeOfflineStore } from "../server/bootstrap/offline-store-ownership";
import { retainAuthenticationOwnership } from "../server/bootstrap/authentication-administration";
import { AuthenticationRequestBudget } from "../server/bootstrap/authentication-request-budget";
import { ProviderAdminError } from "../server/modules/authentication";
import { OperationError, publicError, releaseError, sessionDescribe } from "../server/modules/operations";
import { authenticationModes, errorCategories, errorCategoryStatus, installationPermissions, projectPermissions, retryDispositions,
  type PublicOperationError } from "../shared/contracts/operations";

/** Only the already released operator DTO is accepted. Unknown fields are errors, never echoed. */
const description = z.object({
  actor: z.object({ kind: z.literal("operator"), accountId: z.null() }).strict(),
  mode: z.enum(authenticationModes), listener: z.literal("unix"), fullAuthority: z.literal(true),
  installationPermissions: z.array(z.enum(installationPermissions)),
  projects: z.array(z.object({ projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
    permissions: z.array(z.enum(projectPermissions)) }).strict()).max(500),
  projectsTruncated: z.boolean(), freshLogin: z.object({ state: z.literal("exempt"), validUntil: z.null() }).strict(),
}).strict();
const failure = z.object({ error: z.object({ category: z.enum(errorCategories), status: z.number().int(),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), retry: z.enum(retryDispositions), effect: z.null() }).strict() }).strict();

export class SessionDescribeError extends Error {
  constructor(readonly error: PublicOperationError) { super(`${error.category}: ${error.reason} (${error.retry})`); }
}
const localFailure = (reason: string) => new SessionDescribeError(publicError(new OperationError("unavailable", reason)));

/** Descriptor writes keep a failed output commit inside readRelease's admitted phase.
 * POSIX stdout pipes are asynchronous streams, unlike files/TTYs:
 * https://nodejs.org/docs/latest-v22.x/api/process.html#a-note-on-process-io
 * writeSync returns a byte count, not a promise of a complete buffer:
 * https://nodejs.org/docs/latest-v22.x/api/fs.html#fswritesyncfd-buffer-offset-length-position
 */
function writeDescriptor(fd: number, line: string): void {
  const bytes = Buffer.from(`${line}\n`), deadline = performance.now() + 1_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  // Bound both partial writes and EAGAIN retries; never spin on a full pipe.
  for (let attempts = 0; offset < bytes.length; attempts++) {
    if (attempts >= 4096 || performance.now() >= deadline) throw localFailure("output_unavailable");
    try {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw localFailure("output_unavailable");
      offset += written;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK" && code !== "EINTR") throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
}

type OutputStream = {
  readonly destroyed: boolean;
  on(event: "error", listener: () => void): unknown;
};

/** Install only for this finite command, before its first write. Keep listeners until
 * process termination: a delayed stream error can arrive even after main resolves.
 * They set exitCode, never exit, so offline drain/close/release always gets to finish.
 */
export function createSessionDescribeOutput(stdout: OutputStream = process.stdout, stderr: OutputStream = process.stderr,
  fail: () => void = () => { process.exitCode = 1; }) {
  let outputFailed = false, stderrFailed = false, reported = false;
  const reportError = (line: string) => {
    fail();
    if (reported) return;
    reported = true;
    if (stderrFailed || stderr.destroyed) return;
    try { writeDescriptor(2, line); } catch { stderrFailed = true; }
  };
  stdout.on("error", () => {
    outputFailed = true;
    reportError(JSON.stringify({ error: localFailure("output_unavailable").error }));
  });
  stderr.on("error", () => { stderrFailed = true; fail(); });
  return {
    reportError,
    write(line: string) {
      try {
        if (outputFailed || stdout.destroyed) throw localFailure("output_unavailable");
        writeDescriptor(1, line);
      } catch {
        outputFailed = true;
        throw localFailure("output_unavailable");
      }
    },
  };
}

function decodeReply(status: number | undefined, value: unknown): unknown {
  if (status === 200) {
    if (!description.safeParse(value).success) throw localFailure("admin_invalid_response");
    return value; // Validate without transforming or adding fields to the released projection.
  }
  const parsed = failure.safeParse(value);
  if (!parsed.success || status !== parsed.data.error.status || status !== errorCategoryStatus[parsed.data.error.category]
    || JSON.stringify(releaseError(parsed.data.error)) !== JSON.stringify(parsed.data.error)) {
    throw localFailure("admin_invalid_response");
  }
  throw new SessionDescribeError(parsed.data.error);
}

/** Lock alone selects the path. A failed owner request can never become an offline invocation. */
export async function runSessionDescribe(args: string[], paths: AppPaths, write: (line: string) => void = console.log): Promise<void> {
  if (args.length !== 1 || args[0] !== "describe") throw new Error("Usage: session describe [--data-dir PATH] [--state-dir PATH]");
  let outputFailed = false;
  const emit = (value: unknown) => {
    try { write(JSON.stringify(value, null, 2)); }
    catch { outputFailed = true; throw localFailure("output_unavailable"); }
  };
  let lock;
  try { lock = acquireControllerLock(paths.controllerLockPath); }
  catch (error) {
    if (!(error instanceof ControllerAlreadyRunningError)) throw localFailure("offline_lock_unavailable");
    let result: unknown;
    try {
      result = await requestAdminSocket(paths.adminSocketPath, {}, 15_000, 256 * 1024,
        { path: "/api/operations/session.describe", decode: decodeReply });
    } catch (cause) {
      if (cause instanceof SessionDescribeError) throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      throw localFailure(code === "ENOENT" ? "admin_socket_missing" : code === "ECONNREFUSED" ? "admin_socket_refused"
        : code === "admin_timeout" ? "admin_timeout" : code === "admin_response_limit" ? "admin_response_limit"
        : code === "admin_invalid_response" ? "admin_invalid_response"
        : cause instanceof SyntaxError || cause instanceof TypeError || cause instanceof ProviderAdminError ? "admin_invalid_response" : "admin_socket_failed");
    }
    emit(result); return;
  }
  let store: SqliteStateStore | null = null;
  try {
    try { assertBackupHandoffCompleted(paths.databasePath); }
    catch (error) {
      if (error instanceof BackupHandoffPendingError) throw error;
      // Record parsing errors may contain the record's bytes. Never print them.
      throw localFailure("restore_handoff_unreadable");
    }
    store = new SqliteStateStore(paths.databasePath);
    const activeMode = await store.admission.run(() => store!.getAuthenticationPolicy().mode);
    const runtime = buildOfflineOperationsRuntime({ store, controllerLock: lock, activeMode, now: Date.now,
      logs: { controller() {} }, requestBudget: new AuthenticationRequestBudget(16, 4),
      eligibility: { controllerEligible: () => true, providerSessionEligible: () => false } });
    const minted = await runtime.mintOffline({});
    if (!minted.ok) throw new SessionDescribeError(minted.error);
    if (!runtime.supported) throw localFailure("unknown_mode");
    const released = await runtime.runner.readRelease(sessionDescribe, minted.context, {}, {
      eligible: runtime.eligible, connected: () => !process.stdout.destroyed, deadline: Date.now() + 15_000,
      commit(value) { emit(value); },
    });
    if (released.status !== "committed") {
      if (outputFailed) throw localFailure("output_unavailable");
      throw new SessionDescribeError(released.error);
    }
  } catch (error) {
    if (error instanceof SessionDescribeError || error instanceof BackupHandoffPendingError
      || error instanceof SecurityFenceError || error instanceof UpgradeError) throw error;
    throw localFailure("offline_unavailable");
  } finally {
    try { await closeOfflineStore(store, lock); }
    catch {
      retainAuthenticationOwnership({ store, lock });
      throw new ProviderAdminError("disposal_unconfirmed", undefined, false);
    }
  }
}
