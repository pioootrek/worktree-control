import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync, lstatSync, rmdirSync } from "node:fs";
import { privateDirectory, privateFile } from "./private-storage";
import { dirname } from "node:path";

interface LockRecord {
  pid: number;
  token: string;
  startedAt: string;
}

// Written records fit in 128 bytes (PID, UUID, ISO date); leave ample format margin.
const MAX_LOCK_RECORD_BYTES = 512;

export interface ControllerLock {
  /** Read-only, sticky ownership check; detects accidental loss, not a hostile same-UID process. */
  held(): boolean;
  release(): void;
}

export class ControllerAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Worktree Control is already running (PID ${pid}). Stop it before starting another controller.`);
    this.name = "ControllerAlreadyRunningError";
  }
}

export function acquireControllerLock(path: string): ControllerLock {
  privateDirectory(dirname(path));
  return withAcquisition(path, () => acquireLock(path));
}

/** Serializes publication and stale replacement; an abandoned guard requires operator inspection. */
function withAcquisition<T>(path: string, operation: () => T): T {
  const guard = `${path}.acquiring`;
  try { mkdirSync(guard, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Ownership acquisition is in progress or interrupted. Inspect the lock before retrying.");
    throw error;
  }
  try { return operation(); } finally { rmdirSync(guard); }
}

function acquireLock(path: string): ControllerLock {
  privateDirectory(dirname(path));
  const record: LockRecord = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      let acquired: ReturnType<typeof fstatSync>;
      try {
        writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
        acquired = fstatSync(descriptor);
      } catch (error) {
        unlinkSync(path);
        throw error;
      } finally {
        closeSync(descriptor);
      }
      let released = false;
      let lost = false;
      return {
        held() {
          if (released || lost) return false;
          let fd: number | undefined;
          try {
            // Use the acquisition reader's safety rules without its permission repair.
            privateFile(path, false, true);
            fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const opened = fstatSync(fd);
            const safe = (stat: typeof opened) => stat.isFile() && stat.nlink === 1
              && (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o7777) === 0o600
              && stat.dev === acquired.dev && stat.ino === acquired.ino
              && stat.size > 0 && stat.size <= MAX_LOCK_RECORD_BYTES;
            if (!safe(opened)) { lost = true; return false; }
            // One fixed-size read: a growing file cannot extend this synchronous check.
            const bytes = Buffer.alloc(MAX_LOCK_RECORD_BYTES);
            const size = readSync(fd, bytes, 0, bytes.length, 0);
            const after = fstatSync(fd), named = lstatSync(path);
            const current = parseLock(bytes.subarray(0, size).toString("utf8"));
            lost = size !== opened.size || ![after, named].every(stat => safe(stat)
              && stat.size === opened.size && stat.mtimeMs === opened.mtimeMs && stat.ctimeMs === opened.ctimeMs)
              || current?.pid !== record.pid || current?.token !== record.token;
          } catch { lost = true; }
          finally {
            if (fd !== undefined) { try { closeSync(fd); } catch { lost = true; } }
          }
          return !lost;
        },
        release() {
          if (released) return;
          released = true;
          try {
            const current = readLock(path);
            if (current?.token === record.token) unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readLock(path);
      if (!current) throw new Error("Ownership lock is incomplete or unrecognized. Inspect it before removal.");
      if (processExists(current.pid)) {
        throw new ControllerAlreadyRunningError(current.pid);
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire the Worktree Control controller lock.");
}

function readLock(path: string): LockRecord | null {
  try {
    privateFile(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Ownership lock must be a regular file without aliases.");
    return parseLock(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseLock(value: string): LockRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<LockRecord>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.token === "string" && parsed.token.length > 0 && typeof parsed.startedAt === "string"
      ? parsed as LockRecord
      : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
