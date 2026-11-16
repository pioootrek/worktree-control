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
 * target, so it builds schema 49 although this release creates 52 by default.
 * A test whose meaning is "whatever this release creates" keeps the default
 * (`new SqliteStateStore(path)`, `initializeSchema(database)`) instead.
 *
 * The ordinary store admits only a current database at the supported version,
 * so a store on a schema-49 database is opened by the test-side opener
 * {@link openStoreAt}: an ordinary owner (the admission check runs) at an
 * explicit lower target. Production never opens an owner at a lower target
 * for the store; `schema-entry-points.test.ts` guards that.
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
 * the store's own steps in the store's order: an ordinary owner with the
 * initialization marker (the admission check admits a fresh database), WAL
 * durability, the schema at the target (a fresh database: from step 50 on its
 * upgrade marker is `complete` without a plan), the confirmed witness
 * published and then the initialization marker removed. Refuses an existing
 * file.
 */
export function createFencedDatabase(databasePath: string, target: number): void {
  if (existsSync(databasePath)) throw new Error("The fenced-database fixture creates a new database only.");
  const owner = new OwnedSqliteDatabase(databasePath, true, target, { ordinary: true });
  try {
    const writable = owner.enableWrites();
    configureDurability(writable);
    initializeSchema(writable, owner.inspection.fresh, database => { inspectSchema(database, target); }, { target });
    assertDurability(writable);
    SecurityFence.attach(owner.canonicalPath, writable, owner.inspection.fresh);
    owner.completeInitialization();
  } finally { owner.close(); }
}

/** A new fenced schema-49 database: {@link createFencedDatabase} at 49. */
export function createFencedAt49(databasePath: string): void {
  createFencedDatabase(databasePath, RELEASED_SCHEMA_VERSION);
}

/**
 * The test-side store at an explicit `target` below the supported version,
 * for operating on a versioned database through the product's own query
 * layer: an ordinary owner opened at `target` (so the admission check runs at
 * that target: trusted fence, schema exactly `target`, and from step 50 on a
 * complete marker) handed to the store. Refuses (closing the store) unless
 * the database is at `target`, so a fixture never silently tests another
 * schema. Confined to tests.
 */
export function openStoreAt(databasePath: string, target: number): SqliteStateStore {
  const store = new SqliteStateStore(databasePath, new OwnedSqliteDatabase(databasePath, false, target, { ordinary: true }));
  const version = store.schemaVersion();
  if (version !== target) { store.close(); throw new Error(`The schema-${target} store fixture opened schema ${version}.`); }
  return store;
}

/**
 * The store on a fenced schema-49 database, for writing the released schema's
 * rows through the product's own paths: creates the database with
 * {@link createFencedAt49} when none exists, then opens it with
 * {@link openStoreAt} at 49, which migrates nothing and refuses any other
 * version.
 */
export function openStoreAt49(databasePath: string): SqliteStateStore {
  if (!existsSync(databasePath)) createFencedAt49(databasePath);
  return openStoreAt(databasePath, RELEASED_SCHEMA_VERSION);
}
