import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { lstat, mkdtemp, open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { LogWriter } from "@/server/log-writer";
import { RUN_DIRECTORY_UNAVAILABLE, type RunDirectories } from "@/server/modules/verification";
import { durableJson } from "@/server/private-storage";
import { assertOwnedDirectory, removeOwnedTree, UnsafeRemovalError } from "./owned-tree-removal";

/** File in the controller's state directory that names the roots this installation created. */
export const RUN_DIRECTORY_RECORD = "run-directory-root.json";
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
const RECORD_MAX_BYTES = 64 * 1024;
const ROOT_PREFIX = "wtc-";
/** 256 random bits, hex encoded. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
/**
 * Test suites create Unix sockets under TMPDIR, and socket paths are limited to
 * about 104 bytes. A run directory at or below this length leaves them room.
 */
export const RUN_DIRECTORY_PATH_BUDGET = 40;

interface RootEntry { path: string; token: string }
interface RootRecord { version: 2; roots: RootEntry[] }

export interface RunDirectoryRootOptions {
  /** Private controller state directory that holds the ownership record. */
  stateDirectory: string;
  /** Parent of the root; defaults to the operating system's temporary directory. */
  temporaryDirectory?: string;
  logs: Pick<LogWriter, "controller">;
}

/**
 * Opens this controller's run-directory root. Roots recorded by an earlier
 * instance with the same state directory are removed first, each only after
 * its identity is established (see `verifyRoot`); anything else is left in
 * place. A fresh root is then created with `mkdtemp` (mode 0700), given a
 * marker holding a new random token, and recorded before any run uses it.
 */
export async function openRunDirectoryRoot(options: RunDirectoryRootOptions): Promise<RunDirectoryRoot> {
  const recordPath = join(options.stateDirectory, RUN_DIRECTORY_RECORD);
  const retained: RootEntry[] = [];
  for (const previous of readRecord(recordPath, options.logs)) {
    if (await sweepPreviousRoot(previous, options.logs)) retained.push(previous);
  }
  const parent = resolve(options.temporaryDirectory ?? tmpdir());
  const candidate: RootEntry = { path: join(parent, `${ROOT_PREFIX}XXXXXX`), token: "0".repeat(TOKEN_BYTES * 2) };
  if (retained.length >= MAX_RECORDED_ROOTS || recordBytes([...retained, candidate]) > RECORD_MAX_BYTES) {
    // Entries for vanished roots are dropped; every root that still exists stays recorded.
    durableJson(recordPath, { version: 2, roots: retained } satisfies RootRecord);
    options.logs.controller("run_directory.record_full", { record: recordPath, count: retained.length, limit: MAX_RECORDED_ROOTS });
    throw new Error(RUN_DIRECTORY_RECORD_FULL);
  }
  const root = await mkdtemp(join(parent, ROOT_PREFIX));
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  let stats: Stats;
  try {
    stats = await lstat(root);
    assertOwnedDirectory(stats);
    writeMarker(root, token);
    durableJson(recordPath, { version: 2, roots: [...retained, { path: root, token }] } satisfies RootRecord);
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
  return new RunDirectoryRoot(root, stats, token, recordPath, retained, options.logs);
}

export class RunDirectoryRoot implements RunDirectories {
  private sequence = 0;
  private closing: Promise<void> | null = null;

  constructor(
    readonly path: string,
    private readonly identity: Stats,
    private readonly token: string,
    private readonly recordPath: string,
    private readonly retained: readonly RootEntry[],
    private readonly logs: Pick<LogWriter, "controller">,
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

  async remove(path: string): Promise<void> {
    if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== this.path || !basename(path)) {
      throw new UnsafeRemovalError("outside_root");
    }
    if (basename(path) === RUN_DIRECTORY_ROOT_MARKER) throw new UnsafeRemovalError("root_marker");
    this.assertRoot(await lstat(this.path));
    const stats = await lstatMissing(path);
    if (!stats) return;
    assertOwnedDirectory(stats);
    await removeOwnedTree(path, stats);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        const stats = await verifyRoot({ path: this.path, token: this.token });
        if (stats) {
          this.assertRoot(stats);
          await removeOwnedTree(this.path, stats, RUN_DIRECTORY_ROOT_MARKER);
        }
      } catch (error) {
        // Still recorded: the next start removes it once its identity is established.
        this.logs.controller("run_directory.root_cleanup_failed", { root: this.path, error: errorCode(error) });
        throw error;
      }
      durableJson(this.recordPath, { version: 2, roots: [...this.retained] } satisfies RootRecord);
      this.logs.controller("run_directory.root_removed", { root: this.path });
    })();
    return this.closing;
  }

  private assertRoot(stats: Stats): void {
    assertOwnedDirectory(stats);
    if (stats.dev !== this.identity.dev || stats.ino !== this.identity.ino) throw new UnsafeRemovalError("root_replaced");
  }
}

/** Fails every run before spawn when no root could be created at startup. */
export function unavailableRunDirectories(): RunDirectories {
  return {
    create: () => { throw new Error(RUN_DIRECTORY_UNAVAILABLE); },
    remove: async () => undefined,
    close: async () => undefined,
  };
}

/**
 * Removes one root recorded by an earlier instance. Returns whether its entry
 * stays recorded: only a path that no longer exists, or a root that was
 * removed, leaves the record.
 */
async function sweepPreviousRoot(entry: RootEntry, logs: Pick<LogWriter, "controller">): Promise<boolean> {
  let stats: Stats | null;
  try {
    stats = await verifyRoot(entry);
  } catch (error) {
    // Not provably ours: left untouched and kept recorded for an operator to inspect.
    logs.controller("run_directory.previous_root_skipped", { path: entry.path, reason: errorCode(error) });
    return true;
  }
  if (!stats) {
    logs.controller("run_directory.previous_root_missing", { path: entry.path });
    return false;
  }
  try {
    await removeOwnedTree(entry.path, stats, RUN_DIRECTORY_ROOT_MARKER);
    logs.controller("run_directory.previous_root_removed", { path: entry.path });
    return false;
  } catch (error) {
    logs.controller("run_directory.previous_root_cleanup_failed", { path: entry.path, error: errorCode(error) });
    return true;
  }
}

/**
 * Establishes that `entry.path` is a root this installation created: an
 * absolute, normalized path named `wtc-*` that `lstat` shows as a real
 * directory owned by this user, holding a marker that is a regular file owned
 * by this user, not a link, with exactly the recorded token. Returns `null`
 * when nothing exists at the path, and throws a stable reason otherwise.
 *
 * This protects against a damaged or stale record, not against a process of
 * the same user, which can delete or copy the marker. A deleted marker makes
 * removal skip the root (a logged leak).
 */
async function verifyRoot(entry: RootEntry): Promise<Stats | null> {
  const { path, token } = entry;
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) throw new UnsafeRemovalError("path_invalid");
  if (!basename(path).startsWith(ROOT_PREFIX)) throw new UnsafeRemovalError("name_mismatch");
  const stats = await lstatMissing(path);
  if (!stats) return null;
  assertOwnedDirectory(stats);
  await assertMarker(path, token);
  const after = await lstat(path);
  if (after.dev !== stats.dev || after.ino !== stats.ino) throw new UnsafeRemovalError("root_replaced");
  return stats;
}

async function assertMarker(root: string, token: string): Promise<void> {
  const expected = Buffer.from(token, "utf8");
  let handle: FileHandle;
  try {
    // O_NOFOLLOW rejects a symbolic link; O_NONBLOCK keeps a planted FIFO from blocking the open.
    handle = await open(join(root, RUN_DIRECTORY_ROOT_MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new UnsafeRemovalError("marker_missing");
    if (code === "ELOOP") throw new UnsafeRemovalError("marker_not_regular");
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) throw new UnsafeRemovalError("marker_not_regular");
    if (process.getuid && stats.uid !== process.getuid()) throw new UnsafeRemovalError("marker_not_owned");
    if (stats.size !== expected.length) throw new UnsafeRemovalError("marker_mismatch");
    const content = Buffer.alloc(expected.length + 1);
    const { bytesRead } = await handle.read(content, 0, content.length, 0);
    // Both sides have the fixed token length before the constant-time comparison.
    if (bytesRead !== expected.length || !timingSafeEqual(content.subarray(0, bytesRead), expected)) {
      throw new UnsafeRemovalError("marker_mismatch");
    }
  } finally { await handle.close(); }
}

function writeMarker(root: string, token: string): void {
  const fd = openSync(join(root, RUN_DIRECTORY_ROOT_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, token);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * Only a version 2 record whose every entry is an absolute, normalized path
 * with a well-formed token is used. Any other content, including the earlier
 * path-only format, proves nothing, so nothing is removed for it.
 */
function readRecord(path: string, logs: Pick<LogWriter, "controller">): RootEntry[] {
  let content: Buffer;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > RECORD_MAX_BYTES || (process.getuid && stats.uid !== process.getuid())) throw new UnsafeRemovalError("record_invalid");
    content = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    logs.controller("run_directory.record_ignored", { error: errorCode(error) });
    return [];
  }
  try {
    const record = JSON.parse(content.toString("utf8")) as { version?: unknown; roots?: unknown };
    if (record?.version !== 2) throw new UnsafeRemovalError("record_version_unsupported");
    if (!Array.isArray(record.roots) || !record.roots.every(isRootEntry)) throw new UnsafeRemovalError("record_invalid");
    const entries = new Map<string, RootEntry>();
    for (const { path: root, token } of record.roots) if (!entries.has(root)) entries.set(root, { path: root, token });
    return [...entries.values()];
  } catch (error) {
    logs.controller("run_directory.record_ignored", { error: errorCode(error) });
    return [];
  }
}

function isRootEntry(value: unknown): value is RootEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { path, token, ...rest } = value as Record<string, unknown>;
  return Object.keys(rest).length === 0
    && typeof path === "string" && isAbsolute(path) && resolve(path) === path && dirname(path) !== path
    && typeof token === "string" && TOKEN_PATTERN.test(token);
}

function recordBytes(roots: RootEntry[]): number {
  return Buffer.byteLength(JSON.stringify({ version: 2, roots } satisfies RootRecord));
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
