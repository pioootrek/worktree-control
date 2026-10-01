import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { acquireControllerLock, type ControllerLock } from "@/server/controller-lock";
import { inspectSchema, type SchemaInspection } from "./schema-inspection";

/** Canonical parent aliases are supported; file symlinks and hardlinks are refused. */
export function acquireDatabaseOwnership(input: string): { path: string; lock: ControllerLock } {
  const absolute = resolve(input);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(dirname(absolute)), basename(absolute));
  const validate = () => {
    if (!existsSync(path)) {
      // lstat also recognizes dangling symlinks.
      try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Database must be a regular file without symlink or hardlink aliases.");
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
      if (create && !existsSync(this.ownership.path)) closeSync(openSync(this.ownership.path, "wx", 0o600));
      connection = new Database(this.ownership.path, { readonly: true, fileMustExist: true });
      this.inspection = inspectSchema(connection);
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
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { if (this.connection.open) this.connection.close(); } finally { this.ownership.lock.release(); }
  }
}
