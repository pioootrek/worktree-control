import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { syncDirectory } from "./private-storage";

export class InvalidAttachmentObject extends Error {}
export interface AttachmentObject { sha256: string; size: number }

function invalid(): never { throw new InvalidAttachmentObject("Unsafe attachment object path or conflicting content."); }
function owned(uid: number): boolean { return !process.getuid || uid === process.getuid(); }

function directory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || ((info.mode & 0o022) && !(info.mode & 0o1000))) invalid();
}

function objectDirectory(path: string, create: boolean): void {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    info = lstatSync(path);
  }
  if (!info.isDirectory() || !owned(info.uid)) invalid();
  if (info.mode & 0o022) {
    // Older releases used the umask (commonly 002). Narrow only our root/shard,
    // after checking the opened inode; never chmod an alias or foreign directory.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const opened = fstatSync(fd);
      if (!opened.isDirectory() || !owned(opened.uid) || opened.dev !== info.dev || opened.ino !== info.ino) invalid();
      fchmodSync(fd, 0o700);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
}

function objectPath(root: string, object: AttachmentObject, create: boolean): string {
  if (!/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.size) || object.size < 0) invalid();
  const input = resolve(root), parent = dirname(input);
  // Support canonical parent aliases, as database ownership does. Root/shard
  // aliases themselves remain forbidden; never follow them when creating files.
  const absolute = join(realpathSync(parent), basename(input)), shard = join(absolute, object.sha256.slice(0, 2));
  // Validate existing ancestors too, including when no directory needs creation.
  for (let current = dirname(absolute); ; current = dirname(current)) {
    directory(current);
    if (dirname(current) === current) break;
  }
  objectDirectory(absolute, create);
  objectDirectory(shard, create);
  return join(shard, object.sha256);
}

function regular(path: string, destination = true): number {
  const info = lstatSync(path);
  if (!info.isFile() || (destination && (!owned(info.uid) || (info.mode & 0o022)))) invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) invalid();
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

function verify(fd: number, object: AttachmentObject, copyTo?: number): void {
  if (fstatSync(fd).size !== object.size) invalid();
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  for (;;) {
    const bytes = readSync(fd, buffer, 0, buffer.length, position);
    if (!bytes) break;
    position += bytes;
    if (position > object.size) invalid();
    hash.update(buffer.subarray(0, bytes));
    if (copyTo !== undefined) {
      let written = 0;
      while (written < bytes) {
        const count = writeSync(copyTo, buffer, written, bytes - written);
        if (!count) throw new Error("Attachment write made no progress.");
        written += count;
      }
    }
  }
  if (position !== object.size || hash.digest("hex") !== object.sha256) invalid();
}

/** Sync shard, object root and its existing parent, also on interrupted retries. */
function syncParents(path: string): void {
  const boundary = dirname(dirname(path));
  for (let current = path; ; current = dirname(current)) {
    syncDirectory(current);
    if (current === boundary) break;
  }
}

/**
 * Objects are immutable and retained after publication, even on SQL rollback.
 * This is also the backup retention invariant: no live operation unlinks objects
 * while SQLite Backup API selects a snapshot or its attachments are copied.
 * Only this call's private staging is cleaned. There is deliberately no GC.
 * The caller supplies an existing durable parent (owned database data directory
 * or backup staging). This operation creates only the object root and shard;
 * their parent's entry and outer ancestors are never changed by publication.
 */
export function publishAttachmentObject(root: string, object: AttachmentObject, source: Uint8Array | { path: string }): string {
  const destination = objectPath(root, object, true), shard = dirname(destination);
  if (source instanceof Uint8Array && (source.byteLength !== object.size || createHash("sha256").update(source).digest("hex") !== object.sha256)) invalid();
  let existing: number | undefined;
  try { existing = regular(destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    try {
      if (!(source instanceof Uint8Array)) {
        const input = regular(source.path, false);
        try { verify(input, object); } finally { closeSync(input); }
      }
      verify(existing, object); fsyncSync(existing);
    } finally { closeSync(existing); }
    syncParents(shard);
    return destination;
  }
  const staging = mkdtempSync(join(shard, ".object-"));
  try {
    const temporary = join(staging, "content");
    const fd = openSync(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (source instanceof Uint8Array) {
        if (source.byteLength !== object.size) invalid();
        let written = 0;
        while (written < source.byteLength) {
          const count = writeSync(fd, source, written, source.byteLength - written);
          if (!count) throw new Error("Attachment write made no progress.");
          written += count;
        }
        verify(fd, object);
      } else {
        const input = regular(source.path, false);
        try { verify(input, object, fd); } finally { closeSync(input); }
        verify(fd, object);
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // Atomic create-if-absent. rename would overwrite another publisher on POSIX.
    try { linkSync(temporary, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const published = regular(destination);
    try { verify(published, object); fsyncSync(published); } finally { closeSync(published); }
    syncParents(shard);
    return destination;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Resolve a verified immutable source without following object/shard symlinks. */
export function attachmentObjectPath(root: string, object: AttachmentObject): string {
  return objectPath(root, object, false);
}
