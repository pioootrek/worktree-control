import { lstatSync, mkdirSync, readFileSync, type Stats } from "node:fs";
import { lstat, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { LogWriter } from "@/server/log-writer";
import { RUN_DIRECTORY_UNAVAILABLE, type RunDirectories } from "@/server/modules/verification";
import { durableJson } from "@/server/private-storage";
import { assertOwnedDirectory, removeOwnedTree, UnsafeRemovalError } from "./owned-tree-removal";

/** File in the controller's state directory that proves which roots this installation created. */
export const RUN_DIRECTORY_RECORD = "run-directory-root.json";
const RECORD_MAX_BYTES = 16 * 1024;
/** Earlier roots whose removal failed stay recorded for the next start, within this bound. */
const MAX_RETAINED_ROOTS = 8;
/**
 * Test suites create Unix sockets under TMPDIR, and socket paths are limited to
 * about 104 bytes. A run directory at or below this length leaves them room.
 */
export const RUN_DIRECTORY_PATH_BUDGET = 40;

interface RootRecord { version: 1; roots: string[] }

export interface RunDirectoryRootOptions {
  /** Private controller state directory that holds the ownership record. */
  stateDirectory: string;
  /** Parent of the root; defaults to the operating system's temporary directory. */
  temporaryDirectory?: string;
  logs: Pick<LogWriter, "controller">;
}

/**
 * Opens this controller's run-directory root. Roots recorded by an earlier
 * instance with the same state directory are removed first; directories
 * without a record are never touched, whatever their name. A fresh root is
 * then created with `mkdtemp` (mode 0700) and recorded before any run uses it.
 */
export async function openRunDirectoryRoot(options: RunDirectoryRootOptions): Promise<RunDirectoryRoot> {
  const recordPath = join(options.stateDirectory, RUN_DIRECTORY_RECORD);
  const retained: string[] = [];
  for (const previous of readRecord(recordPath, options.logs)) {
    try {
      await removeRoot(previous);
      options.logs.controller("run_directory.previous_root_removed", { path: previous });
    } catch (error) {
      retained.push(previous);
      options.logs.controller("run_directory.previous_root_cleanup_failed", { path: previous, error: errorCode(error) });
    }
  }
  if (retained.length >= MAX_RETAINED_ROOTS) {
    const dropped = retained.splice(0, retained.length - MAX_RETAINED_ROOTS + 1);
    options.logs.controller("run_directory.record_dropped", { paths: dropped });
  }
  const parent = resolve(options.temporaryDirectory ?? tmpdir());
  const root = await mkdtemp(join(parent, "wtc-"));
  let stats: Stats;
  try {
    stats = await lstat(root);
    assertOwnedDirectory(stats);
    durableJson(recordPath, { version: 1, roots: [...retained, root] } satisfies RootRecord);
  } catch (error) {
    // Not recorded yet: this instance created it a moment ago and it is still empty.
    await rmdir(root).catch(() => undefined);
    throw error;
  }
  if (root.length + 4 > RUN_DIRECTORY_PATH_BUDGET) {
    options.logs.controller("run_directory.path_budget_exceeded", { root, length: root.length + 4, budget: RUN_DIRECTORY_PATH_BUDGET });
  }
  options.logs.controller("run_directory.root_created", { root });
  return new RunDirectoryRoot(root, stats, recordPath, retained, options.logs);
}

export class RunDirectoryRoot implements RunDirectories {
  private sequence = 0;
  private closing: Promise<void> | null = null;

  constructor(
    readonly path: string,
    private readonly identity: Stats,
    private readonly recordPath: string,
    private readonly retained: readonly string[],
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
    this.assertRoot(await lstat(this.path));
    const stats = await lstatMissing(path);
    if (!stats) return;
    assertOwnedDirectory(stats);
    await removeOwnedTree(path, stats);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        const stats = await lstatMissing(this.path);
        if (stats) {
          this.assertRoot(stats);
          await removeOwnedTree(this.path, stats);
        }
      } catch (error) {
        // Still recorded: the next start removes it.
        this.logs.controller("run_directory.root_cleanup_failed", { root: this.path, error: errorCode(error) });
        throw error;
      }
      durableJson(this.recordPath, { version: 1, roots: [...this.retained] } satisfies RootRecord);
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

async function removeRoot(path: string): Promise<void> {
  const stats = await lstatMissing(path);
  if (!stats) return;
  assertOwnedDirectory(stats);
  await removeOwnedTree(path, stats);
}

/**
 * Only an absolute, normalized path that this installation recorded is ever a
 * removal candidate. An unreadable or malformed record proves nothing, so
 * nothing is removed for it.
 */
function readRecord(path: string, logs: Pick<LogWriter, "controller">): string[] {
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
    const record = JSON.parse(content.toString("utf8")) as Partial<RootRecord>;
    if (record.version !== 1 || !Array.isArray(record.roots)) throw new Error("record_invalid");
    return [...new Set(record.roots)].filter((root): root is string => typeof root === "string"
      && isAbsolute(root) && resolve(root) === root && dirname(root) !== root);
  } catch (error) {
    logs.controller("run_directory.record_ignored", { error: errorCode(error) });
    return [];
  }
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
