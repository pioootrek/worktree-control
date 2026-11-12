import { constants, type Dirent, type Stats } from "node:fs";
import { chmod, lstat, open, opendir, rmdir, unlink } from "node:fs/promises";
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
 * `last` names one entry directly inside `path` that is unlinked only after
 * everything else is gone, so an interrupted removal leaves it in place.
 *
 * Path-based calls cannot exclude a concurrent swap by a process that escaped
 * its owned process group; callers remove a run's tree only after that group
 * is confirmed stopped.
 */
export async function removeOwnedTree(path: string, expected: Stats, last?: string): Promise<void> {
  await removeContents(path, expected, last);
  if (last) await ignoreMissing(unlink(join(path, last)));
  const current = await lstat(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new UnsafeRemovalError("directory_replaced");
  assertOwnedDirectory(current);
  await rmdir(path);
}

/**
 * Empties one verified directory. The listing is closed before a subdirectory
 * is entered and reopened after it is removed, so removal holds one open
 * directory at any depth; entries already removed do not reappear.
 */
async function removeContents(directory: string, expected: Stats, skip?: string): Promise<void> {
  await ensureOwnerAccess(directory, expected);
  for (;;) {
    const subdirectory = await unlinkUntilDirectory(directory, skip);
    if (!subdirectory) return;
    if (subdirectory.stats.dev !== expected.dev) throw new UnsafeRemovalError("mount_point");
    assertOwnedDirectory(subdirectory.stats);
    await removeContents(subdirectory.path, subdirectory.stats);
    await ignoreMissing(rmdir(subdirectory.path));
  }
}

/**
 * Unlinks the non-directories of `directory` until the listing ends or shows a
 * real subdirectory, which is returned unentered. Every unlink is observed at
 * once, and all of them have settled before this returns or throws; the first
 * failure, of an unlink or of the traversal, is the one reported.
 */
async function unlinkUntilDirectory(directory: string, skip?: string): Promise<{ path: string; stats: Stats } | null> {
  const unlinks = new SettledUnlinks();
  let found: { path: string; stats: Stats } | null = null;
  try {
    const listing = await opendir(directory, { bufferSize: LISTING_BUFFER });
    // `for await` closes the listing on completion, on `break` and on every thrown error.
    for await (const entry of listing) {
      if (entry.name === skip) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory() || !knownNonDirectory(entry)) {
        // A directory, or a file system that does not report entry types: decide with lstat.
        const stats = await lstatOrMissing(child);
        if (!stats) continue;
        if (stats.isDirectory()) { found = { path: child, stats }; break; }
      }
      unlinks.add(unlink(child));
      if (unlinks.size >= UNLINK_BATCH) {
        await unlinks.settle();
        unlinks.throwIfFailed();
      }
    }
  } catch (error) {
    unlinks.record(error);
  }
  await unlinks.settle();
  unlinks.throwIfFailed();
  return found;
}

/** Unlink operations converted on creation into promises that cannot reject. */
class SettledUnlinks {
  private readonly pending: Promise<void>[] = [];
  private failure: { error: unknown } | null = null;

  get size(): number { return this.pending.length; }

  add(operation: Promise<void>): void {
    this.pending.push(operation.then(() => undefined, (error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") this.record(error);
    }));
  }

  record(error: unknown): void { this.failure ??= { error }; }

  async settle(): Promise<void> { await Promise.all(this.pending.splice(0)); }

  throwIfFailed(): void { if (this.failure) throw this.failure.error; }
}

function knownNonDirectory(entry: Dirent): boolean {
  return entry.isFile() || entry.isSymbolicLink() || entry.isFIFO() || entry.isSocket()
    || entry.isCharacterDevice() || entry.isBlockDevice();
}

/**
 * A test may leave a directory without owner read, write or search
 * permission. When the owner can still read it, the mode is repaired through a
 * descriptor opened without following links, after confirming it is the same
 * directory that `lstat` reported.
 */
async function ensureOwnerAccess(directory: string, expected: Stats): Promise<void> {
  if ((expected.mode & 0o700) === 0o700) return;
  const mode = (expected.mode & 0o7777) | 0o700;
  if (expected.mode & 0o400) {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) throw new UnsafeRemovalError("directory_replaced");
      await handle.chmod(mode);
    } finally { await handle.close(); }
    return;
  }
  // Without owner read permission the directory cannot be opened, and Linux has
  // neither lchmod nor fchmod on an O_PATH descriptor, so the mode is set by
  // path right after `lstat`. chmod follows a symbolic link: if the entry were
  // swapped in between, the swap's target (which this user must own) would
  // gain owner rwx. That stays inside the documented limit: removal runs only
  // after the run's owned process group is confirmed stopped. Device and inode
  // are verified again afterwards, so a swap stops removal instead of entering
  // another tree.
  await chmod(directory, mode);
  const current = await lstat(directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new UnsafeRemovalError("directory_replaced");
  assertOwnedDirectory(current);
}

async function lstatOrMissing(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function ignoreMissing(operation: Promise<void>): Promise<void> {
  try { await operation; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
