import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Unlinks issued concurrently inside one directory. Subdirectories are removed one at a time. */
const UNLINK_BATCH = 32;
/** Directory entries read per system call; the listing is streamed, never held in memory. */
const LISTING_BUFFER = 128;

export class UnsafeRemovalError extends Error {
  constructor(readonly code: string) { super(code); }
}

const currentUid = () => (process.getuid ? process.getuid() : null);

/** A real directory owned by this user: never a symbolic link, never someone else's tree. */
export function assertOwnedDirectory(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new UnsafeRemovalError("not_a_directory");
  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) throw new UnsafeRemovalError("not_owned");
}

/**
 * Removes `path` and everything below it with asynchronous calls, so a tree of
 * hundreds of thousands of files never blocks the event loop and never holds
 * its listing in memory. The caller has already verified `path` itself with
 * `lstat` (`expected`). Entries are never followed: symbolic links and other
 * non-directories are unlinked, and a directory is entered only after `lstat`
 * shows a real directory on the same device that this user owns.
 *
 * Path-based calls cannot exclude a concurrent swap by a process that escaped
 * its owned process group; callers remove a run's tree only after that group
 * is confirmed stopped.
 */
export async function removeOwnedTree(path: string, expected: Stats): Promise<void> {
  await removeContents(path, expected);
  const current = await lstat(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new UnsafeRemovalError("directory_replaced");
  assertOwnedDirectory(current);
  await rmdir(path);
}

async function removeContents(directory: string, expected: Stats): Promise<void> {
  await ensureOwnerAccess(directory, expected);
  const pending: Promise<void>[] = [];
  const flush = async () => {
    const results = await Promise.allSettled(pending.splice(0));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  const listing = await opendir(directory, { bufferSize: LISTING_BUFFER });
  // `for await` closes the listing on completion and on every thrown error.
  for await (const entry of listing) {
    const child = join(directory, entry.name);
    const known = entry.isFile() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()
      || entry.isCharacterDevice() || entry.isBlockDevice();
    if (entry.isDirectory() || !known) {
      // A directory, or a file system that does not report entry types: decide with lstat.
      const stats = await lstatOrMissing(child);
      if (!stats) continue;
      if (stats.isDirectory()) {
        await flush();
        if (stats.dev !== expected.dev) throw new UnsafeRemovalError("mount_point");
        assertOwnedDirectory(stats);
        await removeContents(child, stats);
        await ignoreMissing(rmdir(child));
        continue;
      }
    }
    pending.push(ignoreMissing(unlink(child)));
    if (pending.length >= UNLINK_BATCH) await flush();
  }
  await flush();
}

/**
 * A test may leave a directory without owner write or search permission. Its
 * mode is repaired through a descriptor opened without following links, after
 * confirming it is the same directory that `lstat` reported.
 */
async function ensureOwnerAccess(directory: string, expected: Stats): Promise<void> {
  if ((expected.mode & 0o700) === 0o700) return;
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) throw new UnsafeRemovalError("directory_replaced");
    await handle.chmod((opened.mode & 0o7777) | 0o700);
  } finally { await handle.close(); }
}

async function lstatOrMissing(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function ignoreMissing(operation: Promise<void>): Promise<void> {
  try { await operation; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
