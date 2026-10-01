import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { acquireControllerLock, type ControllerLock } from "@/server/controller-lock";
import { privateDirectory, privateFile, syncDirectory } from "../../private-storage";
import { inspectSchema, type SchemaInspection } from "./schema-inspection";
import { validateDatabase } from "./database-validation";

/** Canonical parent aliases are supported; file symlinks and hardlinks are refused. */
export function acquireDatabaseOwnership(input: string): { path: string; lock: ControllerLock } {
  const absolute = resolve(input);
  const path = join(privateDirectory(dirname(absolute)), basename(absolute));
  const validate = () => {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`, `${path}.initializing`]) privateFile(file, true);
  };
  validate();
  const lock = acquireControllerLock(`${path}.owner.lock`);
  try { validate(); return { path, lock }; } catch (error) { lock.release(); throw error; }
}

/** One connection and database lock, transferable from inspection to migration. */
export class OwnedSqliteDatabase {
  private connection: Database.Database;
  readonly inspection: SchemaInspection;
  private readonly ownership: ReturnType<typeof acquireDatabaseOwnership>;
  private closed = false;

  constructor(path: string, create = false) {
    this.ownership = acquireDatabaseOwnership(path);
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
      this.inspection = inspectSchema(connection);
      if (this.inspection.fresh && !(create && initializing)) throw new Error("Unrecognized empty database without a verified initialization marker; startup stopped.");
      validateDatabase(connection, this.inspection.version);
      this.connection = connection;
    } catch (error) {
      try { connection?.close(); } finally { this.ownership.lock.release(); }
      throw error;
    }
  }
  get database(): Database.Database { return this.connection; }
  backup(destination: string): Promise<void> { return this.connection.backup(destination).then(() => undefined); }
  schemaVersion(): number { return this.inspection.version; }
  enableWrites(): Database.Database {
    this.connection.close();
    this.connection = new Database(this.ownership.path, { fileMustExist: true });
    return this.connection;
  }
  completeInitialization(): void {
    const marker = `${this.ownership.path}.initializing`;
    if (existsSync(marker)) {
      unlinkSync(marker);
      syncDirectory(dirname(this.ownership.path));
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { if (this.connection.open) this.connection.close(); } finally { this.ownership.lock.release(); }
  }
}
