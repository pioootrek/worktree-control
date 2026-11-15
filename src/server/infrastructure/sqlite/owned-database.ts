import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { acquireControllerLock, type ControllerLock } from "@/server/controller-lock";
import { privateDirectory, privateFile, syncDirectory } from "../../private-storage";
import { inspectSchema, snapshotAttachments, type SchemaInspection } from "./schema-inspection";
import { getOwnedRestoreStatus, recoverOwnedRestore, restoreRoot } from "./restore-recovery";
import { validateDatabase } from "./database-validation";
import { schemaTarget } from "./migration-registry";

/** The database and its sidecars, as ownership validates and normalises them. */
const ownedFiles = (path: string) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`, `${path}.initializing`];
/**
 * The inspection-only refusal of an unfinished restore (a restore journal that is
 * not `verified`). Its message is the one this refusal always had; only the class
 * lets a caller recognise it.
 */
export class UnfinishedRestoreError extends Error {
  constructor() { super("Unfinished restore prevents offline inspection."); }
}

/** {@link OwnedSqliteDatabase.enableVerifiedWrites} found another file, or `verify` another database, after the reopen. */
export class ReopenedDatabaseChangedError extends Error {
  constructor() { super("The database reopened for writing is not the one inspected."); this.name = "ReopenedDatabaseChangedError"; }
}

/** Canonical parent aliases are supported; file symlinks and hardlinks are refused. */
export function acquireDatabaseOwnership(input: string, options?: { inspectOnly: true; inspect?: (canonicalPath: string) => void }): { path: string; lock: ControllerLock } {
  const absolute = resolve(input);
  const path = join(privateDirectory(dirname(absolute)), basename(absolute));
  const validate = (validateOnly = false) => {
    for (const file of ownedFiles(path)) privateFile(file, true, validateOnly);
  };
  validate(true);
  const lock = acquireControllerLock(`${path}.owner.lock`);
  try {
    if (options?.inspectOnly) {
      // Authoritative refusal under the canonical lock: never resume a restore.
      const restore = getOwnedRestoreStatus(path);
      if (restore && restore.state !== "verified") throw new UnfinishedRestoreError();
      options.inspect?.(path);
      validate(true);
    } else { recoverOwnedRestore(path); validate(); }
    return { path, lock };
  } catch (error) { lock.release(); throw error; }
}

/**
 * What this owner can say about how its database file came to be. `restored`
 * and `unconfirmed` both mean a snapshot may stand behind the current rows, so
 * nothing there may be read as left over from an ordinary crash. Raw replacement detection is supplied separately by the external security fence.
 */
export type DatabaseProvenance = "ordinary" | "restored" | "unconfirmed";
function databaseProvenance(path: string): DatabaseProvenance {
  try { return getOwnedRestoreStatus(path) ? "restored" : "ordinary"; } catch { return "unconfirmed"; }
}

/** One connection and database lock, transferable from inspection to migration. */
export class OwnedSqliteDatabase {
  private connection: Database.Database;
  readonly inspection: SchemaInspection;
  private readonly ownership: ReturnType<typeof acquireDatabaseOwnership>;
  private closed = false;
  readonly provenance: DatabaseProvenance;
  private readonly inspectOnly: boolean;

  /**
   * `ceiling` (default `SUPPORTED_SCHEMA_VERSION`) is the highest schema version {@link inspectSchema} recognises.
   *
   * `inspectOnly` takes ownership as offline inspection does: an unfinished
   * restore is refused ({@link UnfinishedRestoreError}) instead of recovered, and
   * no file mode is normalised. Such an owner never creates a database and
   * enables writes only through {@link enableVerifiedWrites}.
   */
  constructor(path: string, create = false, ceiling?: number, options?: { inspectOnly?: boolean }) {
    // Refuse an unsupported ceiling before any lock or file is touched.
    schemaTarget(ceiling);
    this.inspectOnly = options?.inspectOnly === true;
    if (this.inspectOnly && create) throw new Error("An inspection-only owner never creates a database.");
    this.ownership = this.inspectOnly ? acquireDatabaseOwnership(path, { inspectOnly: true }) : acquireDatabaseOwnership(path);
    this.provenance = databaseProvenance(this.ownership.path);
    let connection: Database.Database | undefined;
    try {
      const marker = `${this.ownership.path}.initializing`;
      if (create && !existsSync(this.ownership.path)) {
        if (existsSync(marker)) throw new Error("Interrupted database creation has no matching file; inspect it before retrying.");
        const fd = openSync(this.ownership.path, "wx", 0o600);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        const stat = lstatSync(this.ownership.path);
        const markerFd = openSync(marker, "wx", 0o600);
        try {
          writeFileSync(markerFd, JSON.stringify({ format: 1, device: stat.dev, inode: stat.ino }));
          fsyncSync(markerFd);
        } finally { closeSync(markerFd); }
        syncDirectory(dirname(this.ownership.path));
      }
      let initializing = false;
      if (existsSync(marker)) {
        const record = JSON.parse(readFileSync(marker, "utf8"));
        const stat = lstatSync(this.ownership.path);
        if (record.format !== 1 || record.device !== stat.dev || record.inode !== stat.ino) throw new Error("Unrecognized database initialization marker; inspect it before retrying.");
        initializing = true;
      }
      connection = new Database(this.ownership.path, { readonly: true, fileMustExist: true });
      this.inspection = inspectSchema(connection, ceiling);
      if (this.inspection.fresh && !(create && initializing)) throw new Error("Unrecognized empty database without a verified initialization marker; startup stopped.");
      validateDatabase(connection, this.inspection.version);
      this.connection = connection;
    } catch (error) {
      try { connection?.close(); } finally { this.ownership.lock.release(); }
      throw error;
    }
  }
  get database(): Database.Database { return this.connection; }
  get canonicalPath(): string { return this.ownership.path; }
  backupEstimateBytes(): number {
    return Number(this.connection.pragma("page_count", { simple: true })) * Number(this.connection.pragma("page_size", { simple: true }))
      + snapshotAttachments(this.connection).reduce((sum, entry) => sum + entry.size, 0);
  }
  backup(destination: string, options?: { progress: () => number }): Promise<void> { return this.connection.backup(destination, options).then(() => undefined); }
  schemaVersion(): number { return this.inspection.version; }
  enableWrites(): Database.Database {
    if (this.inspectOnly) throw new Error("An inspection-only owner enables writes only after verifying the reopened database.");
    this.connection.close();
    this.connection = new Database(this.ownership.path, { fileMustExist: true });
    return this.connection;
  }
  /**
   * The inspection-only owner's switch to writing, under the locks it holds.
   * Ordinary ownership recovered a restore and normalised modes before SQLite
   * opened; writing depends on both, so this first requires them without
   * recovering anything: no restore other than a verified one (whose journal
   * directories are synchronised again, which is all recovery does for a
   * verified journal) and private modes on the database and its sidecars,
   * normalised exactly as ordinary ownership does.
   *
   * Then it closes the inspected connection, opens the pathname again and runs
   * `verify` on the new connection before anything else uses it. The pathname
   * must name the same file before and after the open. While `verify` runs, a
   * guard connection that has read holds SQLite's shared lock: when `verify`
   * refuses, the writable connection closes first and cannot checkpoint a WAL
   * into whatever file now sits at the pathname. The refused file may keep an
   * empty WAL and a shared-memory file that the opens created.
   */
  enableVerifiedWrites(verify: (database: Database.Database) => void): Database.Database {
    if (!this.inspectOnly) throw new Error("Only an inspection-only owner verifies its reopened database.");
    const path = this.ownership.path;
    const restore = getOwnedRestoreStatus(path);
    if (restore && restore.state !== "verified") throw new UnfinishedRestoreError();
    if (restore) { syncDirectory(restoreRoot(path)); syncDirectory(dirname(restoreRoot(path))); }
    for (const file of ownedFiles(path)) privateFile(file, true);
    this.connection.close();
    const before = lstatSync(path);
    const guard = new Database(path, { readonly: true, fileMustExist: true });
    let writable: Database.Database | undefined;
    try {
      guard.prepare("SELECT count(*) FROM sqlite_master").get();
      writable = new Database(path, { fileMustExist: true });
      const after = lstatSync(path);
      if (after.dev !== before.dev || after.ino !== before.ino) throw new ReopenedDatabaseChangedError();
      verify(writable);
    } catch (error) {
      try { writable?.close(); } finally { guard.close(); }
      throw error;
    }
    guard.close();
    this.connection = writable;
    return writable;
  }
  completeInitialization(): void {
    const marker = `${this.ownership.path}.initializing`;
    if (existsSync(marker)) {
      unlinkSync(marker);
      syncDirectory(dirname(this.ownership.path));
    }
  }
  /**
   * Releases ownership only after SQLite actually closed. A failed close leaves
   * the connection and owner lock in place so a later call can retry; no other
   * process (including a restore) may take over a database still open here.
   */
  close(): void {
    if (this.closed) return;
    if (this.connection.open) this.connection.close();
    if (this.connection.open) throw new Error("The database connection is still open; ownership is retained.");
    this.closed = true;
    this.ownership.lock.release();
  }
}
