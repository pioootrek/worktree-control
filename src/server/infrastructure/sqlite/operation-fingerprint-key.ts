import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, lstatSync, opendirSync, openSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readPrivateBoundedFile, syncDirectory, validateSensitivePath } from "../../private-storage";
import { restoreRoot } from "./restore-recovery";
import { securityFenceRoot } from "./security-fence";

/**
 * The fingerprint key of the operations idempotency store (D6): 32 random
 * bytes in `<database file>.operation-key`, bound to the canonical database
 * path, so two databases in one directory have independent keys. It is
 * created and read through the private-storage validators (no-follow
 * descriptor, private parent, owner, a single link, the same inode before and
 * after the read), with mode 0600 and exactly 32 bytes. It is never in a
 * backup (a backup holds the SQLite image, the attachments and the manifest
 * only), never in the composition returned to transports, and never logged.
 *
 * Replacing or losing the file does not delete records: at the next start the
 * repair turns unexpired records of another key generation into `unknown`, and
 * a retry answers `idempotency_conflict` or `outcome_unknown` until they
 * expire. Rotation is replacing the file while the controller is stopped.
 */
export const OPERATION_KEY_BYTES = 32;
export const operationKeyPath = (database: string): string => `${database}.operation-key`;
const temporaryPrefix = (database: string) => `${basename(operationKeyPath(database))}.tmp-`;
const TEMPORARY = /^[0-9a-f-]{36}$/;
/** The most directory entries scanned for an interrupted creation. */
const SCAN_LIMIT = 100_000;

/** Why the key is unavailable; carries no path, bytes or OS message. */
export class OperationKeyError extends Error {
  constructor(readonly reason: "key_unsafe" | "key_malformed" | "key_create_failed") {
    super(`Operation fingerprint key unavailable (${reason}).`);
    this.name = "OperationKeyError";
  }
}

const owned = (uid: number) => !process.getuid || uid === process.getuid();

/**
 * Removes what an interrupted creation left: a private temporary file of this
 * database's key. A temporary that is not a regular file of this user is
 * refused, never followed or removed. Removing one after a crash between the
 * publication link and its unlink gives the published key its single link back.
 */
function removeInterrupted(database: string): void {
  const directory = dirname(database), prefix = temporaryPrefix(database);
  const handle = opendirSync(directory);
  const leftovers: string[] = [];
  try {
    for (let count = 0; ; count++) {
      const entry = handle.readSync();
      if (!entry) break;
      if (count >= SCAN_LIMIT) throw new OperationKeyError("key_unsafe");
      if (entry.name.startsWith(prefix) && TEMPORARY.test(entry.name.slice(prefix.length))) leftovers.push(join(directory, entry.name));
    }
  } finally { handle.closeSync(); }
  if (!leftovers.length) return;
  for (const path of leftovers) {
    const stat = lstatSync(path);
    if (!stat.isFile() || !owned(stat.uid)) throw new OperationKeyError("key_unsafe");
    unlinkSync(path);
  }
  syncDirectory(directory);
}

/** Writes a new key to a private temporary, publishes it without replacing anything, then syncs the directory. */
function create(database: string): void {
  const path = operationKeyPath(database), temporary = join(dirname(database), `${temporaryPrefix(database)}${randomUUID()}`);
  const key = randomBytes(OPERATION_KEY_BYTES);
  let linked = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (writeSync(fd, key) !== OPERATION_KEY_BYTES) throw new OperationKeyError("key_create_failed");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // `link` never replaces an existing name: a file published meanwhile is kept and read as it is.
    try { linkSync(temporary, path); linked = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    key.fill(0);
    try { unlinkSync(temporary); } catch { /* A leftover is removed at the next load. */ }
  }
  if (linked) syncDirectory(dirname(database));
}

/**
 * The key of the canonical database path `database` and its generation,
 * creating it on first use. `excludedRoots` are trees the key must not be in
 * (the attachment directory); the restore and fence directories are always
 * excluded. Throws {@link OperationKeyError} for an unsafe or malformed file;
 * a published file of the wrong size is never overwritten.
 */
export function loadOperationKey(database: string, excludedRoots: readonly string[] = []): Buffer {
  const path = operationKeyPath(database);
  const excluded = [...excludedRoots, restoreRoot(database), securityFenceRoot(database)];
  try { validateSensitivePath(path, excluded, true); } catch { throw new OperationKeyError("key_unsafe"); }
  try {
    removeInterrupted(database);
    let exists = true;
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) create(database);
  } catch (error) {
    if (error instanceof OperationKeyError) throw error;
    throw new OperationKeyError("key_create_failed");
  }
  let bytes: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error();
    bytes = readPrivateBoundedFile(path, OPERATION_KEY_BYTES + 1, excluded);
  } catch { throw new OperationKeyError("key_unsafe"); }
  try {
    if (bytes.length !== OPERATION_KEY_BYTES) throw new OperationKeyError("key_malformed");
    return Buffer.from(bytes);
  } finally { bytes.fill(0); }
}
