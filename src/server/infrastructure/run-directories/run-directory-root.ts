import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { lstat, mkdtemp, opendir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { LogWriter } from "@/server/log-writer";
import { RUN_DIRECTORY_UNAVAILABLE, type RunDirectories } from "@/server/modules/verification";
import { durableJson, syncDirectory } from "@/server/private-storage";
import { assertOwnedDirectory, removeOwnedTree, UnsafeRemovalError, type RemovalDeadline } from "./owned-tree-removal";

/** File in the controller's state directory that names the roots this installation created. */
export const RUN_DIRECTORY_RECORD = "run-directory-root.json";
/**
 * Private copy (mode 0600) of the last record that was ignored, beside the
 * record, overwritten each time and never read for deletion.
 */
export const RUN_DIRECTORY_RECORD_IGNORED = "run-directory-root.ignored.json";
/**
 * File inside every root holding the random token its record entry stores.
 * Run directory names (`r1`, `r2`, ...) never collide with it.
 */
export const RUN_DIRECTORY_ROOT_MARKER = ".wtc-root";
/** Startup error when the record cannot take another root; bootstrap then fails local runs before spawn. */
export const RUN_DIRECTORY_RECORD_FULL = "run_directory_record_full";
/**
 * Roots that still exist stay recorded until they are removed or disappear.
 * At this many entries no further root is created.
 */
export const MAX_RECORDED_ROOTS = 64;
/** Time bound of one removal attempt: one run directory, a live root at shutdown, or one recorded root. */
export const RUN_DIRECTORY_REMOVAL_DEADLINE_MS = 120_000;
/** Time bound of the whole startup sweep across all recorded roots; roots not reached stay recorded. */
export const RUN_DIRECTORY_SWEEP_BUDGET_MS = 120_000;
const RECORD_MAX_BYTES = 64 * 1024;
const RECORD_VERSION = 3;
/** Entries of one recorded root examined per start; the rest wait for a later start. */
const ROOT_LISTING_LIMIT = 4096;
const ROOT_PREFIX = "wtc-";
const RUN_NAME_PATTERN = /^r[0-9a-z]{1,13}$/;
/** 256 random bits, hex encoded. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Test suites create Unix sockets under TMPDIR, and socket paths are limited to
 * about 104 bytes. A run directory at or below this length leaves them room.
 */
export const RUN_DIRECTORY_PATH_BUDGET = 40;

/** A run directory bound to the process group of the run spawned in it; `null` when there is no group id. */
interface RunEntry { name: string; processGroupId: number | null }
/** `bootId` is the boot of the controller that created the root, `null` where the platform has none. */
interface RootEntry { path: string; token: string; bootId: string | null; runs: RunEntry[] }
interface RootRecord { version: typeof RECORD_VERSION; roots: RootEntry[] }
type Logs = Pick<LogWriter, "controller">;

export interface RunDirectoryRootOptions {
  /** Private controller state directory that holds the ownership record. */
  stateDirectory: string;
  /** Parent of the root; defaults to the operating system's temporary directory. */
  temporaryDirectory?: string;
  logs: Logs;
  /** Monotonic clock in milliseconds for removal deadlines; defaults to `performance.now`. */
  clock?: () => number;
  /** Defaults to `RUN_DIRECTORY_REMOVAL_DEADLINE_MS`. */
  removalDeadlineMs?: number;
  /** Defaults to `RUN_DIRECTORY_SWEEP_BUDGET_MS`. */
  sweepBudgetMs?: number;
}

/**
 * Opens this controller's run-directory root. Roots recorded by an earlier
 * instance with the same state directory are swept first, each only after its
 * identity is established (see `verifyRoot`) and only as far as its runs are
 * proven quiescent (see `sweepPreviousRoot`); anything else is left in place
 * and stays recorded. A fresh root is then created with `mkdtemp` (mode 0700),
 * given a marker holding a new random token, and recorded before any run uses it.
 */
export async function openRunDirectoryRoot(options: RunDirectoryRootOptions): Promise<RunDirectoryRoot> {
  const clock = options.clock ?? (() => performance.now());
  const removalDeadlineMs = options.removalDeadlineMs ?? RUN_DIRECTORY_REMOVAL_DEADLINE_MS;
  const sweepBudgetMs = options.sweepBudgetMs ?? RUN_DIRECTORY_SWEEP_BUDGET_MS;
  const bootId = currentBootId();
  const recordPath = join(options.stateDirectory, RUN_DIRECTORY_RECORD);
  const retained: RootEntry[] = [];
  const sweepEnd = clock() + sweepBudgetMs;
  let notReached = 0;
  for (const previous of readRecord(recordPath, options.logs)) {
    if (clock() >= sweepEnd) {
      notReached += 1;
      options.logs.controller("run_directory.previous_root_skipped", { path: previous.path, reason: "sweep_budget_exhausted" });
      retained.push(previous);
      continue;
    }
    const deadline = { now: clock, expiresAt: Math.min(clock() + removalDeadlineMs, sweepEnd) };
    const kept = await sweepPreviousRoot(previous, bootId, deadline, options.logs);
    if (kept) retained.push(kept);
  }
  if (notReached) options.logs.controller("run_directory.sweep_budget_exhausted", { notReached, budgetMs: sweepBudgetMs });

  const parent = resolve(options.temporaryDirectory ?? tmpdir());
  const candidate: RootEntry = { path: join(parent, `${ROOT_PREFIX}XXXXXX`), token: "0".repeat(TOKEN_BYTES * 2), bootId, runs: [] };
  const bytes = recordBytes([...retained, candidate]);
  if (retained.length >= MAX_RECORDED_ROOTS || bytes > RECORD_MAX_BYTES) {
    // Entries for vanished roots are dropped; every root that still exists stays recorded.
    writeRecord(recordPath, retained);
    options.logs.controller("run_directory.record_full", {
      record: recordPath, entries: retained.length + 1, entryLimit: MAX_RECORDED_ROOTS, bytes, byteLimit: RECORD_MAX_BYTES,
    });
    throw new Error(RUN_DIRECTORY_RECORD_FULL);
  }
  const root = await mkdtemp(join(parent, ROOT_PREFIX));
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  let stats: Stats;
  try {
    stats = await lstat(root);
    assertOwnedDirectory(stats);
    writeMarker(root, token);
    // The marker's directory entry and the root's own entry are durable before the record names the root.
    syncDirectory(root);
    syncDirectory(parent);
    writeRecord(recordPath, [...retained, { path: root, token, bootId, runs: [] }]);
  } catch (error) {
    // Not recorded yet: this instance created it a moment ago and holds at most the marker.
    try { unlinkSync(join(root, RUN_DIRECTORY_ROOT_MARKER)); } catch { /* not written */ }
    try { rmdirSync(root); } catch { /* preserve the original failure */ }
    throw error;
  }
  if (root.length + 4 > RUN_DIRECTORY_PATH_BUDGET) {
    options.logs.controller("run_directory.path_budget_exceeded", { root, length: root.length + 4, budget: RUN_DIRECTORY_PATH_BUDGET });
  }
  options.logs.controller("run_directory.root_created", { root });
  return new RunDirectoryRoot(root, stats, token, bootId, recordPath, retained, options.logs, clock, removalDeadlineMs);
}

export class RunDirectoryRoot implements RunDirectories {
  private sequence = 0;
  private closing: Promise<void> | null = null;
  /** Bindings of this root's run directories that the record carries, by directory name. */
  private readonly runs = new Map<string, number | null>();

  constructor(
    readonly path: string,
    private readonly identity: Stats,
    private readonly token: string,
    private readonly bootId: string | null,
    private readonly recordPath: string,
    private readonly retained: readonly RootEntry[],
    private readonly logs: Logs,
    private readonly clock: () => number,
    private readonly removalDeadlineMs: number,
  ) {}

  create(): string {
    if (this.closing) throw new Error(RUN_DIRECTORY_UNAVAILABLE);
    this.assertRoot(lstatSync(this.path));
    // A short sequential name keeps the full path within the socket-path budget.
    this.sequence += 1;
    const path = join(this.path, `r${this.sequence.toString(36)}`);
    mkdirSync(path, { mode: 0o700 });
    return path;
  }

  bind(path: string, processGroupId: number | null): void {
    const name = basename(path);
    if (this.closing || dirname(path) !== this.path || !RUN_NAME_PATTERN.test(name)) {
      this.logs.controller("run_directory.binding_not_recorded", { root: this.path, name, reason: this.closing ? "root_closing" : "not_a_run_directory" });
      return;
    }
    const group = processGroupId !== null && Number.isSafeInteger(processGroupId) && processGroupId > 1 ? processGroupId : null;
    const bytes = recordBytes([...this.retained, this.entry([...this.runs, [name, group] as [string, number | null]])]);
    if (bytes > RECORD_MAX_BYTES) {
      this.logs.controller("run_directory.binding_not_recorded", { root: this.path, name, reason: "record_full", bytes, byteLimit: RECORD_MAX_BYTES });
      return;
    }
    this.runs.set(name, group);
    try { this.publish(); }
    catch (error) {
      // The run continues; until a later write succeeds a sweep sees this directory's liveness as unknown.
      this.logs.controller("run_directory.binding_not_recorded", { root: this.path, name, reason: "record_write_failed", error: errorCode(error) });
    }
  }

  async remove(path: string): Promise<void> {
    if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== this.path || !basename(path)) {
      throw new UnsafeRemovalError("outside_root");
    }
    if (basename(path) === RUN_DIRECTORY_ROOT_MARKER) throw new UnsafeRemovalError("root_marker");
    this.assertRoot(await lstat(this.path));
    const stats = await lstatMissing(path);
    if (stats) {
      assertOwnedDirectory(stats);
      await removeOwnedTree(path, stats, { deadline: this.deadline() });
    }
    if (!this.runs.delete(basename(path))) return;
    try { this.publish(); }
    catch (error) {
      // The directory is gone; a stale binding names nothing a sweep could remove.
      this.logs.controller("run_directory.binding_not_dropped", { root: this.path, name: basename(path), error: errorCode(error) });
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        const stats = await verifyRoot(this.entry());
        if (stats) {
          if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) throw new UnsafeRemovalError("root_replaced");
          await removeOwnedTree(this.path, stats, {
            last: RUN_DIRECTORY_ROOT_MARKER,
            restoreLast: () => restoreMarker(this.path, this.token, this.logs),
            deadline: this.deadline(),
          });
        }
      } catch (error) {
        // Still recorded: the next start removes it once its identity is established.
        this.logs.controller("run_directory.root_cleanup_failed", { root: this.path, error: errorCode(error) });
        throw error;
      }
      writeRecord(this.recordPath, [...this.retained]);
      this.logs.controller("run_directory.root_removed", { root: this.path });
    })();
    return this.closing;
  }

  private entry(runs: Iterable<[string, number | null]> = this.runs): RootEntry {
    return { path: this.path, token: this.token, bootId: this.bootId, runs: [...runs].map(([name, processGroupId]) => ({ name, processGroupId })) };
  }

  private publish(): void { writeRecord(this.recordPath, [...this.retained, this.entry()]); }

  private deadline(): RemovalDeadline {
    return { now: this.clock, expiresAt: this.clock() + this.removalDeadlineMs };
  }

  /** The live root: the same directory, owned by this user, still holding this instance's marker. */
  private assertRoot(stats: Stats): void {
    assertOwnedDirectory(stats);
    if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) throw new UnsafeRemovalError("root_replaced");
    assertMarker(this.path, this.token);
  }
}

/** Fails every run before spawn when no root could be created at startup. */
export function unavailableRunDirectories(): RunDirectories {
  return {
    create: () => { throw new Error(RUN_DIRECTORY_UNAVAILABLE); },
    bind: () => undefined,
    remove: async () => undefined,
    close: async () => undefined,
  };
}

/**
 * Sweeps one root recorded by an earlier instance and returns the entry that
 * stays recorded, or `null` when the root is gone.
 *
 * Its test processes were spawned detached and may outlive that instance, so
 * a run directory is removed only when it is proven quiescent: either the
 * root was created during another boot (both boot ids known and different),
 * or its binding names a process group id that is a safe integer above 1 and
 * a zero-signal probe of that group fails with `ESRCH`. A run directory
 * without a binding, with a `null` group id, or whose probe succeeds or fails
 * otherwise (including `EPERM`) is kept. The root is removed once nothing but
 * its marker is left.
 */
async function sweepPreviousRoot(entry: RootEntry, bootId: string | null, deadline: RemovalDeadline, logs: Logs): Promise<RootEntry | null> {
  let stats: Stats | null;
  try {
    stats = await verifyRoot(entry);
  } catch (error) {
    // Not provably ours: left untouched and kept recorded for an operator to inspect.
    logs.controller("run_directory.previous_root_skipped", { path: entry.path, reason: errorCode(error) });
    return entry;
  }
  if (!stats) {
    logs.controller("run_directory.previous_root_missing", { path: entry.path });
    return null;
  }
  const verified = stats;
  const removeRoot = async () => {
    await removeOwnedTree(entry.path, verified, {
      last: RUN_DIRECTORY_ROOT_MARKER, restoreLast: () => restoreMarker(entry.path, entry.token, logs), deadline,
    });
    logs.controller("run_directory.previous_root_removed", { path: entry.path });
    return null;
  };
  try {
    // Every process of an earlier boot is gone.
    if (entry.bootId !== null && bootId !== null && entry.bootId !== bootId) return await removeRoot();
    const { kept, removed, complete } = await removeQuiescentRuns(entry, verified, deadline);
    if (!kept.size && complete) return await removeRoot();
    logs.controller("run_directory.previous_root_retained", {
      path: entry.path, reason: kept.size ? "liveness_unknown" : "listing_limit", kept: kept.size, removed,
    });
    return { ...entry, runs: entry.runs.filter(run => kept.has(run.name)) };
  } catch (error) {
    logs.controller("run_directory.previous_root_cleanup_failed", { path: entry.path, error: errorCode(error) });
    return entry;
  }
}

/** Removes the entries of a verified root whose runs are proven quiescent and returns the names it kept. */
async function removeQuiescentRuns(entry: RootEntry, root: Stats, deadline: RemovalDeadline) {
  const groups = new Map(entry.runs.map(run => [run.name, run.processGroupId] as const));
  const { names, complete } = await listRoot(entry.path);
  const kept = new Set<string>();
  let removed = 0;
  for (const name of names) {
    if (!processGroupGone(groups.get(name))) { kept.add(name); continue; }
    const path = join(entry.path, name);
    const stats = await lstatMissing(path);
    if (stats?.isDirectory()) {
      if (stats.dev !== root.dev) throw new UnsafeRemovalError("mount_point");
      assertOwnedDirectory(stats);
      await removeOwnedTree(path, stats, { deadline });
    } else if (stats) {
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    removed += 1;
  }
  return { kept, removed, complete };
}

/** Names directly inside a root other than its marker, at most `ROOT_LISTING_LIMIT` of them. */
async function listRoot(root: string): Promise<{ names: string[]; complete: boolean }> {
  const names: string[] = [];
  for await (const entry of await opendir(root)) {
    if (entry.name === RUN_DIRECTORY_ROOT_MARKER) continue;
    // `for await` closes the listing on `return`.
    if (names.length >= ROOT_LISTING_LIMIT) return { names, complete: false };
    names.push(entry.name);
  }
  return { names, complete: true };
}

/**
 * Whether no process of the recorded group exists. Only signal 0 is ever sent
 * (nothing is stopped or adopted), and only for a safe integer above 1, so a
 * damaged record can never address process group 0 (the caller's own), 1 or a
 * pid instead of a group. A reused group id can only make this `false`, which
 * delays a sweep.
 */
function processGroupGone(groupId: number | null | undefined): boolean {
  if (process.platform === "win32" || typeof groupId !== "number" || !Number.isSafeInteger(groupId) || groupId <= 1) return false;
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Linux's per-boot random id; `null` where it is unavailable. */
function currentBootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return BOOT_ID_PATTERN.test(value) ? value : null;
  } catch { return null; }
}

/**
 * Establishes that `entry.path` is a root this installation created: an
 * absolute, normalized path named `wtc-*` that `lstat` shows as a real
 * directory owned by this user, holding a marker that is a regular file owned
 * by this user, not a link, with exactly the recorded token. Returns `null`
 * when nothing exists at the path, whatever its name, and throws a stable
 * reason otherwise.
 *
 * This protects against a damaged or stale record, not against a process of
 * the same user, which can delete or copy the marker. A deleted marker makes
 * removal skip the root (a logged leak).
 */
async function verifyRoot(entry: RootEntry): Promise<Stats | null> {
  const { path, token } = entry;
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) throw new UnsafeRemovalError("path_invalid");
  const stats = await lstatMissing(path);
  if (!stats) return null;
  if (!basename(path).startsWith(ROOT_PREFIX)) throw new UnsafeRemovalError("name_mismatch");
  assertOwnedDirectory(stats);
  assertMarker(path, token);
  const after = await lstat(path);
  if (after.dev !== stats.dev || after.ino !== stats.ino) throw new UnsafeRemovalError("root_replaced");
  return stats;
}

/** Synchronous, so that `create` can check the live root in the admitted phase before spawn. */
function assertMarker(root: string, token: string): void {
  const expected = Buffer.from(token, "utf8");
  let descriptor: number;
  try {
    // O_NOFOLLOW rejects a symbolic link; O_NONBLOCK keeps a planted FIFO from blocking the open.
    descriptor = openSync(join(root, RUN_DIRECTORY_ROOT_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new UnsafeRemovalError("marker_missing");
    if (code === "ELOOP") throw new UnsafeRemovalError("marker_not_regular");
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1) throw new UnsafeRemovalError("marker_not_regular");
    if (process.getuid && stats.uid !== process.getuid()) throw new UnsafeRemovalError("marker_not_owned");
    if (stats.size !== expected.length) throw new UnsafeRemovalError("marker_mismatch");
    const content = Buffer.alloc(expected.length + 1);
    const bytesRead = readSync(descriptor, content, 0, content.length, 0);
    // Both sides have the fixed token length before the constant-time comparison.
    if (bytesRead !== expected.length || !timingSafeEqual(content.subarray(0, bytesRead), expected)) {
      throw new UnsafeRemovalError("marker_mismatch");
    }
  } finally { closeSync(descriptor); }
}

function writeMarker(root: string, token: string): void {
  const descriptor = openSync(join(root, RUN_DIRECTORY_ROOT_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(descriptor, token);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

/**
 * Called by removal when an emptied root that is still the same directory
 * could not be removed after its marker was unlinked: the record still names
 * it, so the marker is written back with the same token for a later start.
 */
function restoreMarker(root: string, token: string, logs: Logs): void {
  try {
    writeMarker(root, token);
    syncDirectory(root);
    logs.controller("run_directory.marker_restored", { root });
  } catch (error) {
    logs.controller("run_directory.marker_restore_failed", { root, error: errorCode(error) });
  }
}

/**
 * Only a version 3 record whose every entry is well formed is used. Any other
 * content, including earlier formats, proves nothing, so nothing is removed for
 * it; a private copy is kept beside the record for an operator.
 */
function readRecord(path: string, logs: Logs): RootEntry[] {
  let content: Buffer;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > RECORD_MAX_BYTES || (process.getuid && stats.uid !== process.getuid())) throw new UnsafeRemovalError("record_invalid");
    content = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    ignoreRecord(path, error, logs);
    return [];
  }
  try {
    const record = JSON.parse(content.toString("utf8")) as { version?: unknown; roots?: unknown };
    if (record?.version !== RECORD_VERSION) throw new UnsafeRemovalError("record_version_unsupported");
    if (!Array.isArray(record.roots) || !record.roots.every(isRootEntry)) throw new UnsafeRemovalError("record_invalid");
    const entries = new Map<string, RootEntry>();
    for (const { path: root, token, bootId, runs } of record.roots) {
      if (entries.has(root)) continue;
      const unique = new Map(runs.map(run => [run.name, run.processGroupId] as const));
      entries.set(root, { path: root, token, bootId, runs: [...unique].map(([name, processGroupId]) => ({ name, processGroupId })) });
    }
    return [...entries.values()];
  } catch (error) {
    ignoreRecord(path, error, logs);
    return [];
  }
}

/** Keeps at most `RECORD_MAX_BYTES` of an ignored record in one private file and logs where. */
function ignoreRecord(path: string, reason: unknown, logs: Logs): void {
  const copy = join(dirname(path), RUN_DIRECTORY_RECORD_IGNORED);
  try {
    writePrivateFile(copy, readBounded(path, RECORD_MAX_BYTES));
    logs.controller("run_directory.record_ignored", { error: errorCode(reason), copy });
  } catch (error) {
    logs.controller("run_directory.record_ignored", { error: errorCode(reason), copy: null, copyError: errorCode(error) });
  }
}

function readBounded(path: string, maxBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(descriptor).isFile()) throw new UnsafeRemovalError("record_not_regular");
    const content = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const bytesRead = readSync(descriptor, content, length, maxBytes - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return content.subarray(0, length);
  } finally { closeSync(descriptor); }
}

/** Atomically replaces `path` with `content` (mode 0600); a link at `path` is replaced, never followed. */
function writePrivateFile(path: string, content: Buffer): void {
  const temporary = join(dirname(path), `.journal-${randomUUID()}`);
  let published = false;
  try {
    const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
    published = true;
    syncDirectory(dirname(path));
  } finally {
    if (!published) { try { rmSync(temporary, { force: true }); } catch { /* preserve the original failure */ } }
  }
}

function isRootEntry(value: unknown): value is RootEntry {
  if (!isPlainObject(value)) return false;
  const { path, token, bootId, runs, ...rest } = value;
  return Object.keys(rest).length === 0
    && typeof path === "string" && isAbsolute(path) && resolve(path) === path && dirname(path) !== path
    && typeof token === "string" && TOKEN_PATTERN.test(token)
    && (bootId === null || (typeof bootId === "string" && BOOT_ID_PATTERN.test(bootId)))
    && Array.isArray(runs) && runs.every(isRunEntry);
}

/** Any number is accepted as a group id here; `processGroupGone` decides whether it may be probed. */
function isRunEntry(value: unknown): value is RunEntry {
  if (!isPlainObject(value)) return false;
  const { name, processGroupId, ...rest } = value;
  return Object.keys(rest).length === 0
    && typeof name === "string" && RUN_NAME_PATTERN.test(name)
    && (processGroupId === null || typeof processGroupId === "number");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function writeRecord(path: string, roots: RootEntry[]): void {
  durableJson(path, { version: RECORD_VERSION, roots } satisfies RootRecord);
}

function recordBytes(roots: RootEntry[]): number {
  return Buffer.byteLength(JSON.stringify({ version: RECORD_VERSION, roots } satisfies RootRecord));
}

async function lstatMissing(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function errorCode(error: unknown): string {
  if (error instanceof UnsafeRemovalError) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}
