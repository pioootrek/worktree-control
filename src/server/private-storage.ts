import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

function owned(uid: number): boolean { return !process.getuid || uid === process.getuid(); }
function unsafe(): never {
  throw new Error("Unsafe data path or permissions. Use a private directory owned by the current user; inspect aliases and ownership before retrying.");
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
