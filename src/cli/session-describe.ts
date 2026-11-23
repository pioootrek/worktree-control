import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { z } from "zod";
import { requestAdminSocket, type AdminSocketReply } from "../server/admin-socket";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../server/controller-lock";
import { resolveAppPaths, type AppPaths } from "../server/paths";
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
import { authenticationModes, effectStates, errorCategories, errorCategoryStatus, installationPermissions, projectPermissions, retryDispositions,
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

/**
 * A write of `knowledge threads create` that failed after its success was
 * known: the thread exists, so the effect is `committed`, never `null`.
 */
const committedOutputFailure = () => new SessionDescribeError(publicError(new OperationError("unavailable", "output_unavailable"), "committed"));

/**
 * The finite output of `knowledge threads create`. Like the read commands'
 * handler, it keeps its listeners until process termination and sets exitCode
 * without exiting, and it writes at most one diagnostic to standard error. It
 * differs in what a failed standard output reports: the command writes only
 * after the outcome is known, so a failed write, synchronous or a late stream
 * error, reports `output_unavailable` with effect `committed`. A synchronous
 * failure is thrown, so the offline runner classifies it as its failed
 * delivery and the socket path reports it; a stream error before any write
 * only sets the exit code, and the command's own answer is the diagnostic.
 */
export function createThreadsCreateOutput(stdout: OutputStream = process.stdout, stderr: OutputStream = process.stderr,
  fail: () => void = () => { process.exitCode = 1; }) {
  let outputFailed = false, stderrFailed = false, reported = false, written = false, thrown = false;
  const reportError = (line: string) => {
    if (reported) return;
    reported = true;
    fail();
    if (stderrFailed || stderr.destroyed) return;
    try { writeSync(2, `${line}\n`); } catch { stderrFailed = true; }
  };
  stdout.on("error", () => {
    outputFailed = true;
    // A failure already thrown is reported by the command's own answer (the runner's failed delivery offline).
    if (written && !thrown) reportError(JSON.stringify({ error: committedOutputFailure().error }));
    else fail();
  });
  stderr.on("error", () => { stderrFailed = true; fail(); });
  return {
    reportError,
    write(line: string) {
      written = true;
      try {
        if (outputFailed || stdout.destroyed || stdout.writableEnded || !stdout.writable) throw committedOutputFailure();
        // A false return is backpressure: the complete payload is committed to Node.
        stdout.write(`${line}\n`);
        if (outputFailed) throw committedOutputFailure();
      } catch {
        outputFailed = true; thrown = true;
        throw committedOutputFailure();
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
  claimHolder: z.object({ kind: z.enum(["human", "agent"]), accountId: projectIdText.nullable() }).strict().optional() }).strict();
/** The released DTOs of the project reads, as the operator receives them. Unknown fields are errors. */
const projectList = z.object({ items: z.array(z.object({ projectId: projectIdText.nullable(), name: z.string(), status: z.enum(["active", "archived"]).nullable(),
  registrations: z.array(registrationSummary).max(16), registrationsTruncated: z.boolean() }).strict()).max(100), nextCursor: z.string().nullable() }).strict();
const projectStatus = z.object({ projectId: projectIdText, name: z.string(), status: z.enum(["active", "archived"]), revision: z.number().int().positive(),
  writable: z.boolean(), compact: z.boolean(), registrations: z.array(z.union([registrationStatus, registrationSummary])).max(16), registrationsTruncated: z.boolean() }).strict();
const projectWorktrees = z.object({ projectId: projectIdText, registrations: z.array(z.object({ registrationId, discovery: z.enum(["complete", "partial", "unavailable"]),
  worktrees: z.array(z.object({ path: z.string(), branch: z.string().nullable(), head: z.string(), shortHead: z.string(), detached: z.boolean(), locked: z.boolean(),
    prunable: z.boolean(), dirty: z.boolean().nullable() }).strict()).max(64), worktreesTruncated: z.boolean() }).strict()).max(16), registrationsTruncated: z.boolean() }).strict();

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

// knowledge threads create (D2b-2) -----------------------------------------

const THREADS_CREATE_USAGE = "Usage: knowledge threads create --project PROJECT_ID --title TEXT (--body TEXT | --body-file PATH|-) [--idempotency-key KEY] [--data-dir PATH] [--state-dir PATH]";
/** A body file or standard input is read up to this many bytes before the lock is taken (the transports' request ceiling). */
export const THREAD_BODY_FILE_BYTES = 256 * 1024;
const THREAD_FLAGS: readonly string[] = Object.freeze(["--project", "--title", "--body", "--body-file", "--idempotency-key", "--data-dir", "--state-dir"]);
/** Refused before anything is submitted: nothing began. */
const notSubmitted = (category: ConstructorParameters<typeof OperationError>[0], reason: string) =>
  new SessionDescribeError(publicError(new OperationError(category, reason, { effect: "not_started" })));

export interface ThreadsCreateCommand {
  projectId: string; title: string;
  body: { text: string } | { file: string };
  idempotencyKey?: string; dataDir?: string; stateDir?: string;
}

/**
 * The arguments after `knowledge threads create`. Every flag takes exactly the
 * next argument as its value, verbatim, even one that starts with dashes; a
 * flag given twice, an unknown flag or a missing value is a usage error.
 */
export function parseThreadsCreateCommand(args: string[]): ThreadsCreateCommand {
  const usage = () => new Error(THREADS_CREATE_USAGE);
  if (args.length % 2 !== 0) throw usage();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1]!;
    if (!THREAD_FLAGS.includes(flag) || values.has(flag)) throw usage();
    values.set(flag, value);
  }
  const projectId = values.get("--project"), title = values.get("--title"), text = values.get("--body"), file = values.get("--body-file");
  if (projectId === undefined || title === undefined || (text === undefined) === (file === undefined)) throw usage();
  return {
    projectId, title, body: text !== undefined ? { text } : { file: file! },
    ...(values.has("--idempotency-key") ? { idempotencyKey: values.get("--idempotency-key")! } : {}),
    ...(values.has("--data-dir") ? { dataDir: values.get("--data-dir")! } : {}),
    ...(values.has("--state-dir") ? { stateDir: values.get("--state-dir")! } : {}),
  };
}

/** Bounded strict UTF-8 read of a body file, or of standard input for `-`. Never echoes the bytes. */
export async function readThreadBody(source: string, stdin: AsyncIterable<unknown> & { destroy?(): void } = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const tooLarge = () => notSubmitted("payload_too_large", "body_too_large");
  if (source === "-") {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      bytes += buffer.length;
      if (bytes > THREAD_BODY_FILE_BYTES) { stdin.destroy?.(); throw tooLarge(); }
      chunks.push(buffer);
    }
  } else {
    let descriptor: number;
    try { descriptor = openSync(source, "r"); } catch { throw notSubmitted("invalid_request", "body_file_unreadable"); }
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        let read: number;
        try { read = readSync(descriptor, buffer, 0, buffer.length, null); } catch { throw notSubmitted("invalid_request", "body_file_unreadable"); }
        if (read === 0) break;
        bytes += read;
        if (bytes > THREAD_BODY_FILE_BYTES) throw tooLarge();
        chunks.push(Buffer.from(buffer.subarray(0, read)));
      }
    } finally { closeSync(descriptor); }
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw notSubmitted("invalid_request", "invalid_body"); }
}

const threadId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
/** The released DTO of `knowledge.create_thread`: exactly eight named fields. */
const threadResult = z.object({ thread: z.object({ id: threadId, projectId: projectIdText, title: z.string(), body: z.string(), revision: z.literal(1),
  createdBy: threadId, createdAt: z.string(), updatedAt: z.string() }).strict() }).strict();
const mutationFailure = z.object({ error: z.object({ category: z.enum(errorCategories), status: z.number().int(),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), retry: z.enum(retryDispositions), effect: z.enum(effectStates).nullable() }).strict() }).strict();

/**
 * The socket decoder of a mutation: the strict DTO on 200; otherwise a boundary
 * error (`effect: null`) or a mutation error with a valid effect state, whose
 * status matches its category and which satisfies the outcome invariants. The
 * read decoder, which requires `effect: null`, stays for the reads.
 */
function mutationReplyDecoder(success: z.ZodType) {
  return (status: number | undefined, value: unknown): unknown => {
    if (status === 200) {
      if (!success.safeParse(value).success) throw Object.assign(new Error("Invalid admin response."), { code: "admin_invalid_response" });
      return value;
    }
    const parsed = mutationFailure.safeParse(value);
    if (!parsed.success || status !== parsed.data.error.status || status !== errorCategoryStatus[parsed.data.error.category]
      || JSON.stringify(releaseError(parsed.data.error)) !== JSON.stringify(parsed.data.error)) {
      throw Object.assign(new Error("Invalid admin response."), { code: "admin_invalid_response" });
    }
    throw new SessionDescribeError(parsed.data.error);
  };
}

/**
 * What the finite command writes: the DTO to stdout, a refusal to stderr.
 * `write` is called only after the outcome is known; a write that throws is a
 * delivery failure of a committed thread.
 */
export interface ThreadsCreateOutput { write(line: string): void; reportError(line: string): void }

/**
 * `knowledge threads create`: lock-first like `projects`. While a controller
 * owns the lock the request goes to its private socket, with the key as the
 * `Idempotency-Key` header; once it was submitted, a broken socket or a timeout
 * is an unknown outcome, and nothing ever falls back to offline execution.
 * Otherwise one offline store runs it under the lock without retention: a
 * write without a key runs, a write with a key answers
 * `unavailable`/`idempotency_unavailable` before any effect. An unkeyed write
 * repeated after an uncertain answer can create a second thread.
 */
export async function runThreadsCreateCommand(args: string[], output: ThreadsCreateOutput, stdin?: AsyncIterable<unknown> & { destroy?(): void },
  socketTimeoutMs = 15_000): Promise<void> {
  const command = parseThreadsCreateCommand(args);
  const paths = resolveAppPaths(command.dataDir, command.stateDir);
  // Bounded before the lock is taken.
  const body = "text" in command.body ? command.body.text : await readThreadBody(command.body.file, stdin);
  const input = { projectId: command.projectId, title: command.title, body };
  const key = command.idempotencyKey;
  // Header framing only: the runner validates the key itself.
  if (key !== undefined && !/^[\x21-\x7e]*$/.test(key)) throw notSubmitted("invalid_request", "invalid_idempotency_key");
  const emit = (value: unknown) => { output.write(JSON.stringify(value, null, 2)); };
  let lock;
  try { lock = acquireControllerLock(paths.controllerLockPath); }
  catch (error) {
    if (!(error instanceof ControllerAlreadyRunningError)) throw notSubmitted("unavailable", "offline_lock_unavailable");
    let result: unknown;
    try {
      result = await requestAdminSocket(paths.adminSocketPath, input, socketTimeoutMs, 256 * 1024,
        { path: "/api/operations/knowledge.create_thread", decode: mutationReplyDecoder(threadResult), ...(key !== undefined ? { idempotencyKey: key } : {}) });
    } catch (cause) {
      if (cause instanceof SessionDescribeError) throw cause;
      const code = (cause as NodeJS.ErrnoException).code;
      // The connection never opened: nothing was submitted.
      if (code === "ENOENT") throw notSubmitted("unavailable", "admin_socket_missing");
      if (code === "ECONNREFUSED") throw notSubmitted("unavailable", "admin_socket_refused");
      // Submitted: the controller may have written the thread. Inspect before repeating; never run it offline.
      throw new SessionDescribeError(publicError(new OperationError("outcome_unknown", "admin_outcome_unknown", { effect: "unknown" })));
    }
    // The decoded success is the controller's committed thread: a failed write cannot hide that.
    try { emit(result); } catch { throw committedOutputFailure(); }
    return;
  }
  let store: SqliteStateStore | null = null;
  try {
    try { assertBackupHandoffCompleted(paths.databasePath); }
    catch (error) {
      if (error instanceof BackupHandoffPendingError) throw error;
      throw localFailure("restore_handoff_unreadable");
    }
    store = new SqliteStateStore(paths.databasePath);
    const activeMode = await store.admission.run(() => store!.getAuthenticationPolicy().mode);
    // No retention offline: the composition gets no idempotency store and no fingerprint key.
    const runtime = buildOfflineOperationsRuntime({ store, controllerLock: lock, activeMode, now: Date.now,
      logs: { controller() {} }, requestBudget: new AuthenticationRequestBudget(16, 4),
      projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git: { listTrees: async () => [], worktreeDirty: async () => false } },
      eligibility: { controllerEligible: () => true, providerSessionEligible: () => false } });
    const minted = await runtime.mintOffline({});
    if (!minted.ok) throw new SessionDescribeError(minted.error);
    if (!runtime.supported) throw localFailure("unknown_mode");
    const operation = runtime.registry.get("knowledge.create_thread");
    if (!operation) throw new SessionDescribeError(publicError(new OperationError("not_found", "operation_not_found")));
    const released = await runtime.runner.mutationRelease(operation, minted.context, input, {
      eligible: runtime.eligible, connected: () => true, deadline: Date.now() + 15_000,
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      // Both writes happen inside the admitted phase that established them. A failed write of the
      // DTO is the runner's failed delivery, reported below with the runner's error and effect.
      commit(value) { emit(value); },
      refuse(error) { output.reportError(JSON.stringify({ error })); },
    });
    // A returned refusal was not written; a failed delivery is reported with its effect, and stdout gets nothing more.
    if (released.status !== "committed") throw new SessionDescribeError(released.error);
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
