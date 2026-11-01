import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

function owned(uid: number): boolean { return !process.getuid || uid === process.getuid(); }
function unsafe(): never {
  throw new Error("Unsafe data path or permissions. Use a private directory owned by the current user; inspect aliases and ownership before retrying.");
}

/** Validate a CLI destination before opening SQLite or changing a service definition. No writes. */
export function validatePrivateDirectory(input: string): void {
  const absolute = resolve(input);
  let ancestor = absolute;
  for (;;) {
    try { lstatSync(ancestor); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  const canonical = realpathSync(ancestor);
  assertAncestors(canonical);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || (ancestor === absolute && (!owned(stat.uid) || (stat.mode & 0o077)))) unsafe();
  accessSync(canonical, constants.W_OK | constants.X_OK);
}

/** Canonical directory aliases are allowed, but writable untrusted ancestors are not. */
export function privateDirectory(input: string): string {
  const absolute = resolve(input);
  const missing: string[] = [];
  let ancestor = absolute;
  for (;;) {
    try { lstatSync(ancestor); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(ancestor);
      ancestor = dirname(ancestor);
    }
  }
  assertAncestors(realpathSync(ancestor));
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode: 0o700 });
    try { syncDirectory(dirname(path)); }
    catch (error) {
      // Remove only our still-empty unpublished directory so retry recreates
      // and synchronizes its entry. Never remove another caller's contents.
      try { rmdirSync(path); } catch { /* Preserve the synchronization failure. */ }
      throw error;
    }
  }
  const canonical = realpathSync(absolute);
  assertAncestors(canonical);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || !owned(stat.uid) || (stat.mode & 0o077)) unsafe();
  return canonical;
}

function assertAncestors(path: string): void {
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory()) unsafe();
    // System temporary directories are sticky; their individual data directories must be private.
    if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) unsafe();
    if (current === parse(current).root) break;
  }
}

/** Narrow only the explicitly selected owned data file; never follow links. */
export function privateFile(path: string, optional = false, validateOnly = false): void {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1 || !owned(stat.uid)) {
    throw new Error("Data file must be owned by the current user and be a regular file without symlink or hardlink aliases.");
  }
  if (validateOnly) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened.uid) || opened.dev !== stat.dev || opened.ino !== stat.ino) unsafe();
    if ((opened.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Atomic journal replacement. Never infer success from a rename without fsync. */
export function durableJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.journal-${randomUUID()}`);
  let published = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); published = true; syncDirectory(dirname(path));
  } finally {
    if (!published) { try { rmSync(temporary, { force: true }); } catch { /* Preserve the original failure. */ } }
  }
}

/** New sensitive inputs reject aliases rather than repairing permissions or following parents. */
export function validateSensitivePath(path: string, excludedRoots: readonly string[] = [], allowMissing = false): void {
  if (!isAbsolute(path)) unsafe();
  const absolute = resolve(path);
  for (const root of excludedRoots) {
    const inside = relative(resolve(root), absolute);
    if (!inside || (inside !== ".." && !inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(inside))) unsafe();
  }
  let current = absolute, first = true;
  for (let depth = 0; ; depth++) {
    if (depth > 128) unsafe();
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) unsafe();
      if (!first) {
        if (!stat.isDirectory() || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) unsafe();
        if (stat.uid !== 0 && !owned(stat.uid)) unsafe();
        if (current === dirname(absolute) && (!owned(stat.uid) || (stat.mode & 0o077))) unsafe();
        if (existsSync(join(current, ".git"))) unsafe();
      }
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === dirname(current)) break;
    current = dirname(current); first = false;
  }
}

/** Fixed allocation, no-follow/nonblocking descriptor read, checked before AND after reading. */
export function readPrivateBoundedFile(path: string, maxBytes: number, excludedRoots: readonly string[] = []): Buffer {
  let fd: number | undefined;
  try {
    validateSensitivePath(path, excludedRoots);
    const before = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    const safe = (stat: typeof opened) => stat.isFile() && stat.nlink === 1 && owned(stat.uid)
      && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= maxBytes;
    if (!safe(before) || !safe(opened) || before.dev !== opened.dev || before.ino !== opened.ino) unsafe();
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    const after = fstatSync(fd), named = lstatSync(path);
    for (const stat of [after, named]) {
      if (!safe(stat) || stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size
        || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs) unsafe();
    }
    if (size !== opened.size || size > maxBytes) unsafe();
    return bytes.subarray(0, size);
  } catch { return unsafe(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
