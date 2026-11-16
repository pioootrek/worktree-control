import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { initializeSchema } from "../migrations";
import { inspectSchema } from "../schema-inspection";
import { OwnedSqliteDatabase } from "../owned-database";
import { SecurityFence } from "../security-fence";
import { assertDurability, configureDurability } from "../database-validation";
import { SqliteStateStore } from "../sqlite-state-store";

/**
 * Test fixtures of the released schema 49: the schema the security fence was
 * introduced at, from which the explicit upgrade starts. Each fixture names its
 * target, so it keeps building schema 49 when the activation raises the version
 * this release creates by default. A test whose meaning is "whatever this
 * release creates" keeps the default (`new SqliteStateStore(path)`,
 * `initializeSchema(database)`) instead.
 *
 * The store has no schema target of its own, so a store on a schema-49
 * database is the ordinary store reopened on it ({@link openStoreAt49}); that
 * is the one place the activation must change.
 */
export const RELEASED_SCHEMA_VERSION = 49;

const atReleased = (database: Database.Database) => { inspectSchema(database, RELEASED_SCHEMA_VERSION); };

/**
 * Schema 49 on a raw connection, without ownership or fence: `initializeSchema`
 * at the explicit target 49, its structure recognised at ceiling 49. `fresh` is
 * passed on as `initializeSchema` takes it.
 */
export function schemaAt49<T extends Database.Database>(database: T, fresh?: boolean): T {
  initializeSchema(database, fresh, atReleased, { target: RELEASED_SCHEMA_VERSION });
  return database;
}

/**
 * A new fenced database at `databasePath` and an explicit `target`, created by
 * the store's own steps in the store's order: ordinary ownership with the
 * initialization marker, the fence's inspection, WAL durability, the schema at
 * the target (a fresh database: from step 50 on its upgrade marker is
 * `complete` without a plan), the initialization marker removed and the
 * confirmed witness published. A target above the supported version needs the
 * provisional switch, as every target does. Refuses an existing file.
 */
export function createFencedDatabase(databasePath: string, target: number): void {
  if (existsSync(databasePath)) throw new Error("The fenced-database fixture creates a new database only.");
  const owner = new OwnedSqliteDatabase(databasePath, true, target);
  try {
    SecurityFence.inspect(owner.canonicalPath, owner.database, owner.inspection.fresh);
    const writable = owner.enableWrites();
    configureDurability(writable);
    initializeSchema(writable, owner.inspection.fresh, database => { inspectSchema(database, target); }, { target });
    assertDurability(writable);
    owner.completeInitialization();
    SecurityFence.attach(owner.canonicalPath, writable, owner.inspection.fresh);
  } finally { owner.close(); }
}

/**
 * A new fenced schema-49 database: {@link createFencedDatabase} at 49. The
 * store's construction writes nothing beyond these steps, so while the
 * supported version is 49 the database and the witness are those of `new
 * SqliteStateStore(path).close()` (`released-schema-fixture.test.ts` compares
 * them).
 */
export function createFencedAt49(databasePath: string): void {
  createFencedDatabase(databasePath, RELEASED_SCHEMA_VERSION);
}

/**
 * The store on a fenced schema-49 database, for writing the released schema's
 * rows through the product's own paths: creates the database with
 * {@link createFencedAt49} when none exists, then opens the ordinary store,
 * which at 49 migrates nothing. Refuses (closing the store) unless the database
 * is at 49, so a store that migrated it fails here instead of silently testing
 * another schema.
 */
export function openStoreAt49(databasePath: string): SqliteStateStore {
  if (!existsSync(databasePath)) createFencedAt49(databasePath);
  const store = new SqliteStateStore(databasePath);
  const version = store.schemaVersion();
  if (version !== RELEASED_SCHEMA_VERSION) { store.close(); throw new Error(`The schema-49 store fixture opened schema ${version}.`); }
  return store;
}
