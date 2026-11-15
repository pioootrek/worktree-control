import { lstatSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { OwnedSqliteDatabase } from "./owned-database";
import { inspectSchema } from "./schema-inspection";
import { BACKUP_LIMITS, parseManifest, readBoundedJson, validateBackup } from "./backup-validation";

/**
 * The maintenance backup bound to one run: the explicit offline upgrade's
 * pre-upgrade backup and fence establishment's pre-establishment backup.
 * Both run under both singleton locks, on the owner's read-only connection,
 * before anything is written.
 */

/**
 * What the injected backup may use: a read-only Backup API copy of the owned
 * connection. `backup` takes exactly one snapshot; a second call is refused.
 */
export interface MaintenanceBackupSource { backup(destination: string, options?: { progress: () => number }): Promise<void>; schemaVersion(): number }
/**
 * Writes the backup (the composition passes `createControllerBackup` with its
 * destination) and returns its root and manifest. The caller accepts the tree
 * only as a copy of this source made in this run (see {@link takeBoundBackup}).
 */
export type MaintenanceBackup = (source: MaintenanceBackupSource, context: { database: string; schemaVersion: number }) => Promise<{ root: string; manifest: unknown }>;

/** The checkpoint row, or "absent" when the database has no `security_checkpoint` table (a pre-fence database). */
function checkpoint(database: Database.Database): { installation: string; epoch: string } | undefined | "absent" {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='security_checkpoint'").get()) return "absent";
  return database.prepare("SELECT installation,epoch FROM security_checkpoint WHERE singleton=1").get() as { installation: string; epoch: string } | undefined;
}
function sameCheckpoint(copy: ReturnType<typeof checkpoint>, live: ReturnType<typeof checkpoint>): boolean {
  if (live === "absent") return copy === "absent";
  return typeof copy === "object" && typeof live === "object" && copy.installation === live.installation && copy.epoch === live.epoch;
}

/**
 * Runs the injected backup and returns the root of the tree it accepted. The
 * callback gets a Backup API source that takes exactly one snapshot and records
 * the device and inode of the file the snapshot was written to once the copy
 * completed. `createControllerBackup` switches that file's journal mode in
 * place and renames its staging directory to the destination, so the file
 * keeps its identity but not its path or bytes. The returned tree is accepted
 * only if the snapshot completed before the callback returned; its database
 * file is that file (same device and inode); its manifest is its own and valid
 * at `ceiling`; the tree validates; and the copy holds the live source's schema
 * version.
 *
 * When the source has a `security_checkpoint` (a fenced database, as the
 * upgrade's always is), the copy must also hold its installation and epoch, so
 * no authority write separates the two and an older state of the same
 * installation written into this run's file is refused.
 *
 * A pre-fence source has no checkpoint, and the copy must have none either.
 * What binds its snapshot is its provenance alone: it was written through this
 * owner's connection in this run, under both locks, into the file the tree
 * holds, and the caller proves with a second preflight that the source did not
 * move meanwhile. What cannot be checked is the content of that file after the
 * snapshot: the callback could overwrite it in place (same device and inode)
 * with an older state of the same database at the same schema version and a
 * manifest that matches, and nothing in a pre-fence database tells the two
 * states apart.
 */
export async function takeBoundBackup(owner: OwnedSqliteDatabase, path: string, source: number, ceiling: number, backup: MaintenanceBackup): Promise<string> {
  const taken: { calls: number; settled: boolean; snapshot?: { device: number; inode: number }; running?: Promise<void> } = { calls: 0, settled: false };
  const api: MaintenanceBackupSource = {
    backup: (destination, options) => {
      if (++taken.calls > 1) return Promise.reject(new Error("The maintenance backup takes exactly one snapshot."));
      const running = (async () => {
        if (typeof destination !== "string") throw new Error("Invalid backup destination.");
        await owner.backup(destination, options);
        const stat = lstatSync(destination);
        if (!stat.isFile()) throw new Error("The snapshot is not a regular file.");
        taken.snapshot = { device: stat.dev, inode: stat.ino };
      })().finally(() => { taken.settled = true; });
      // Also handled here, so a rejection the callback ignores is never unhandled.
      running.catch(() => undefined);
      taken.running = running;
      return running;
    },
    schemaVersion: () => source,
  };
  let created: Awaited<ReturnType<MaintenanceBackup>>, unfinished: boolean;
  try {
    created = await backup(api, { database: path, schemaVersion: source });
    unfinished = !taken.settled;
  } finally {
    // Never leave a Backup API copy running on the connection the caller closes.
    await taken.running?.catch(() => undefined);
  }
  const snapshot = taken.snapshot;
  if (taken.calls !== 1 || unfinished || !snapshot) throw new Error("The backup is not this run's single completed snapshot.");
  if (!created || typeof created.root !== "string") throw new Error("Backup returned no tree.");
  const manifest = parseManifest(created.manifest, ceiling);
  if (manifest.database.schemaVersion !== source) throw new Error("Backup schema version differs from the database.");
  // The tree's own manifest is the one returned, and the tree matches it.
  const stored = parseManifest(readBoundedJson(join(created.root, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), ceiling);
  if (JSON.stringify(stored) !== JSON.stringify(manifest)) throw new Error("Backup manifest differs from the returned one.");
  const file = join(created.root, "state.sqlite3"), stat = lstatSync(file);
  if (!stat.isFile() || stat.dev !== snapshot.device || stat.ino !== snapshot.inode) throw new Error("The backup's database is not this run's snapshot.");
  validateBackup(created.root, manifest, true, ceiling);
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (inspectSchema(copy, ceiling).version !== source || !sameCheckpoint(checkpoint(copy), checkpoint(owner.database))) throw new Error("The snapshot is not of this source's current state.");
  } finally { copy.close(); }
  return created.root;
}
