import { writeSync } from "node:fs";
import { z } from "zod";
import { requestAdminSocket, type AdminSocketReply } from "../server/admin-socket";
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
import { SystemGitWorktreeReader } from "../server/git-worktrees";
import { OperationError, publicError, releaseError, sessionDescribe, type AuthenticationContext, type ReadReleaseResult } from "../server/modules/operations";
import { authenticationModes, errorCategories, errorCategoryStatus, installationPermissions, projectPermissions, retryDispositions,
  type PublicOperationError, type SessionDescription } from "../shared/contracts/operations";

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

type OutputStream = {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly writable: boolean;
  write(chunk: string): boolean;
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
    if (reported) return;
    reported = true;
    fail();
    if (stderrFailed || stderr.destroyed) return;
    // One small diagnostic, well below a pipe buffer. Never retry a full/closed stderr.
    try { writeSync(2, `${line}\n`); } catch { stderrFailed = true; }
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
        if (outputFailed || stdout.destroyed || stdout.writableEnded || !stdout.writable) throw localFailure("output_unavailable");
        // A false return is backpressure: the complete payload is committed to Node.
        // A later error means failed delivery after that commit, handled by the listener.
        // Pending pipe writes keep the process alive without delaying offline cleanup:
        // https://nodejs.org/download/release/v24.19.0/docs/api/process.html#processexitcode
        stdout.write(`${line}\n`);
        if (outputFailed) throw localFailure("output_unavailable");
      } catch {
        outputFailed = true;
        throw localFailure("output_unavailable");
      }
    },
  };
}

function replyDecoder(success: z.ZodType) {
  return (status: number | undefined, value: unknown): unknown => {
    if (status === 200) {
      if (!success.safeParse(value).success) throw localFailure("admin_invalid_response");
      return value; // Validate without transforming or adding fields to the released projection.
    }
    const parsed = failure.safeParse(value);
    if (!parsed.success || status !== parsed.data.error.status || status !== errorCategoryStatus[parsed.data.error.category]
      || JSON.stringify(releaseError(parsed.data.error)) !== JSON.stringify(parsed.data.error)) {
      throw localFailure("admin_invalid_response");
    }
    throw new SessionDescribeError(parsed.data.error);
  };
}

const registrationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const projectIdText = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const registrationSummary = z.object({ registrationId, name: z.string(), port: z.number().int(),
  phase: z.enum(["stopped", "starting", "running", "stopping", "failed"]), worktreePath: z.string().nullable(), claim: z.enum(["none", "own", "other"]) }).strict();
const registrationStatus = registrationSummary.extend({ selectedWorktreePath: z.string().nullable(), startedAt: z.string().nullable(), managedServer: z.boolean(),
  launch: z.object({ executable: z.string(), args: z.array(z.string()) }).strict().optional(),
  claimHolder: z.object({ kind: z.enum(["human", "agent"]), accountId: projectIdText.nullable(), reason: z.string().nullable(), createdAt: z.string(),
    expiresAt: z.string().nullable() }).strict().optional() }).strict();
/** The released DTOs of the project reads, as the operator receives them. Unknown fields are errors. */
const projectList = z.object({ items: z.array(z.object({ projectId: projectIdText.nullable(), name: z.string(), status: z.enum(["active", "archived"]).nullable(),
  registrations: z.array(registrationSummary).max(16), registrationsTruncated: z.boolean() }).strict()).max(100), nextCursor: z.string().nullable() }).strict();
const projectStatus = z.object({ projectId: projectIdText, name: z.string(), status: z.enum(["active", "archived"]), revision: z.number().int().positive(),
  writable: z.boolean(), compact: z.boolean(), registrations: z.array(z.union([registrationStatus, registrationSummary])).max(16), registrationsTruncated: z.boolean() }).strict();
const projectWorktrees = z.object({ projectId: projectIdText, registrations: z.array(z.object({ registrationId, discovery: z.enum(["complete", "unavailable"]),
  worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable(), head: z.string(), shortHead: z.string(), detached: z.boolean(), locked: z.boolean(),
    prunable: z.boolean(), dirty: z.boolean() }).strict()).max(64), worktreesTruncated: z.boolean() }).strict()).max(16), registrationsTruncated: z.boolean() }).strict();

type OfflineRuntime = Extract<ReturnType<typeof buildOfflineOperationsRuntime>, { supported: true }>;
interface LockFirstRead {
  /** The operation's exact path on the private socket. */
  path: AdminSocketReply["path"];
  input: Record<string, unknown>;
  success: z.ZodType;
  /** Release through the offline runner; `commit` emits inside admission. */
  release(runtime: OfflineRuntime, context: AuthenticationContext, options: { eligible(): boolean; connected(): boolean; deadline: number; commit(value: unknown): void }): Promise<ReadReleaseResult>;
}

/** Lock alone selects the path. A failed owner request can never become an offline invocation. */
export async function runSessionDescribe(args: string[], paths: AppPaths, write: (line: string) => void = console.log): Promise<void> {
  if (args.length !== 1 || args[0] !== "describe") throw new Error("Usage: session describe [--data-dir PATH] [--state-dir PATH]");
  await runLockFirstRead({ path: "/api/operations/session.describe", input: {}, success: description,
    release: (runtime, context, options) => runtime.runner.readRelease<Record<string, never>, SessionDescription, SessionDescription>(sessionDescribe, context, {}, options) }, paths, write);
}

const PROJECTS_USAGE = "Usage: projects list [--limit N] [--cursor CURSOR] | projects status PROJECT_ID [--compact] | projects worktrees PROJECT_ID [--data-dir PATH] [--state-dir PATH]";

/** The project reads (D2a) through the same lock-first selection as session describe. */
export function parseProjectsCommand(args: string[]): { operation: "project.list" | "project.status" | "project.worktrees"; input: Record<string, unknown> } {
  const [verb, ...rest] = args;
  const usage = () => new Error(PROJECTS_USAGE);
  if (verb === "list") {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const [flag, value] = [rest[i], rest[i + 1]];
      if (value === undefined || value.startsWith("--")) throw usage();
      if (flag === "--limit" && input.limit === undefined && /^[0-9]{1,3}$/.test(value)) input.limit = Number(value);
      else if (flag === "--cursor" && input.cursor === undefined) input.cursor = value;
      else throw usage();
    }
    return { operation: "project.list", input };
  }
  if ((verb === "status" || verb === "worktrees") && rest[0] !== undefined && !rest[0].startsWith("--")) {
    const [projectId, ...flags] = rest;
    if (verb === "status" && (flags.length === 0 || (flags.length === 1 && flags[0] === "--compact"))) {
      return { operation: "project.status", input: flags.length ? { projectId, compact: true } : { projectId } };
    }
    if (verb === "worktrees" && flags.length === 0) return { operation: "project.worktrees", input: { projectId } };
  }
  throw usage();
}

export async function runProjectsCommand(args: string[], paths: AppPaths, write: (line: string) => void = console.log): Promise<void> {
  const { operation, input } = parseProjectsCommand(args);
  const success = operation === "project.list" ? projectList : operation === "project.status" ? projectStatus : projectWorktrees;
  await runLockFirstRead({ path: `/api/operations/${operation}`, input, success, release(runtime, context, options) {
    const registered = runtime.registry.get(operation);
    if (!registered) return Promise.resolve({ status: "refused" as const, error: publicError(new OperationError("not_found", "operation_not_found")) });
    return registered.kind === "query" ? runtime.runner.queryRelease(registered, context, input, options) : runtime.runner.readRelease(registered, context, input, options);
  } }, paths, write);
}

async function runLockFirstRead(read: LockFirstRead, paths: AppPaths, write: (line: string) => void): Promise<void> {
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
      result = await requestAdminSocket(paths.adminSocketPath, read.input, 15_000, 256 * 1024,
        { path: read.path, decode: replyDecoder(read.success) });
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
  // Offline, no controller runs managed servers; discovery uses this command's own Git reader.
  let git: SystemGitWorktreeReader | null = null;
  try {
    try { assertBackupHandoffCompleted(paths.databasePath); }
    catch (error) {
      if (error instanceof BackupHandoffPendingError) throw error;
      // Record parsing errors may contain the record's bytes. Never print them.
      throw localFailure("restore_handoff_unreadable");
    }
    store = new SqliteStateStore(paths.databasePath);
    const activeMode = await store.admission.run(() => store!.getAuthenticationPolicy().mode);
    git = new SystemGitWorktreeReader();
    const runtime = buildOfflineOperationsRuntime({ store, controllerLock: lock, activeMode, now: Date.now,
      logs: { controller() {} }, requestBudget: new AuthenticationRequestBudget(16, 4),
      projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git },
      eligibility: { controllerEligible: () => true, providerSessionEligible: () => false } });
    const minted = await runtime.mintOffline({});
    if (!minted.ok) throw new SessionDescribeError(minted.error);
    if (!runtime.supported) throw localFailure("unknown_mode");
    const released = await read.release(runtime, minted.context, {
      // Output availability is checked by the synchronous commit, within admission.
      eligible: runtime.eligible, connected: () => true, deadline: Date.now() + 15_000,
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
    git?.close?.();
    try { await closeOfflineStore(store, lock); }
    catch {
      retainAuthenticationOwnership({ store, lock });
      throw new ProviderAdminError("disposal_unconfirmed", undefined, false);
    }
  }
}
