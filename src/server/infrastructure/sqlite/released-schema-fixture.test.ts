import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths } from "../../paths";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { SqliteStateStore } from "./sqlite-state-store";
import { OwnedSqliteDatabase } from "./owned-database";
import { SecurityFence, securityFenceRoot } from "./security-fence";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SECURITY_FENCE_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { createFencedAt49, openStoreAt49, RELEASED_SCHEMA_VERSION, schemaAt49 } from "./fixtures/released-schema";

/**
 * The schema-49 fixtures build what the default built before C3c-1, while the
 * supported version is 49. The comparisons with the default below are what the
 * activation deletes: after it the default builds schema 52, and the fixtures
 * keep building 49 (`schema-version-separation.test.ts` shows that).
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dataPath = () => { const root = mkdtempSync(join(tmpdir(), "released-schema-")); roots.push(root); return resolveAppPaths(join(root, "data")).databasePath; };
const canonical = (path: string) => join(realpathSync(join(path, "..")), "state.sqlite3");
/** Catalogue and rows, without the columns that differ between any two installations: times and the checkpoint's random values. */
const content = (path: string) => {
  const database = unmanagedFixtureDatabase(path, { readonly: true });
  try {
    const catalogue = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
    const rows = Object.fromEntries(tables.map(name => [name, (database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as Array<Record<string, unknown>>)
      .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
        /(_at|At)$/.test(key) || (name === "security_checkpoint" && (key === "installation" || key === "epoch")) ? typeof value : value])))]));
    return { catalogue, rows, journal: database.pragma("journal_mode", { simple: true }) };
  } finally { database.close(); }
};
/** The witness without the fields bound to one database file and installation. */
const witness = (path: string) => {
  const { payload } = JSON.parse(readFileSync(join(securityFenceRoot(canonical(path)), "witness.json"), "utf8")) as { payload: Record<string, unknown> };
  const { binding: _binding, installation: _installation, epoch: _epoch, file: _file, ...rest } = payload;
  void _binding; void _installation; void _epoch; void _file;
  return rest;
};
const sidecars = (path: string) => [`${path}.initializing`, `${path}-journal`].map(existsSync);

describe("released schema-49 fixtures", () => {
  it("keeps the released version, the fence base and (until the activation) the supported version at 49", () => {
    expect(RELEASED_SCHEMA_VERSION).toBe(49);
    expect(SECURITY_FENCE_SCHEMA_VERSION).toBe(RELEASED_SCHEMA_VERSION);
    expect(SUPPORTED_SCHEMA_VERSION).toBe(RELEASED_SCHEMA_VERSION);
  });

  it("creates the fenced database and witness the default store creates, and the store reopens it unchanged", () => {
    const fixture = dataPath(), reference = dataPath();
    createFencedAt49(fixture);
    new SqliteStateStore(reference).close();
    expect(content(fixture)).toEqual(content(reference));
    expect(witness(fixture)).toEqual(witness(reference));
    expect(witness(fixture)).toMatchObject({ format: 1, state: "confirmed", receipt: null, recoveredAt: null, restore: null });
    expect(sidecars(fixture)).toEqual(sidecars(reference));
    // Trusted by the fence, at 49.
    const owner = new OwnedSqliteDatabase(fixture, false, RELEASED_SCHEMA_VERSION, { inspectOnly: true });
    try {
      expect(owner.inspection).toEqual({ version: 49, fresh: false });
      expect(() => SecurityFence.inspect(owner.canonicalPath, owner.database, false)).not.toThrow();
    } finally { owner.close(); }
    // The store's own reopening changes no row.
    const before = content(fixture);
    const store = openStoreAt49(fixture);
    try { expect(store.schemaVersion()).toBe(49); } finally { store.close(); }
    expect(content(fixture)).toEqual(before);
    expect(() => createFencedAt49(fixture)).toThrow("creates a new database only");
  });

  it("opens a store at 49 on a new path as the default store does", () => {
    const fixture = dataPath(), reference = dataPath();
    const store = openStoreAt49(fixture);
    try { expect(store.schemaVersion()).toBe(49); } finally { store.close(); }
    new SqliteStateStore(reference).close();
    expect(content(fixture)).toEqual(content(reference));
    expect(witness(fixture)).toEqual(witness(reference));
  });

  it("initialises the schema-49 catalogue the default initialises, on a raw connection", () => {
    const fixture = schemaAt49(new Database(":memory:")), reference = new Database(":memory:");
    try {
      initializeSchema(reference, undefined, inspectSchema);
      expect(inspectSchema(fixture)).toEqual({ version: 49, fresh: false });
      const catalogue = (database: Database.Database) => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      expect(catalogue(fixture)).toEqual(catalogue(reference));
      expect(fixture.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all()).toEqual(reference.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all());
    } finally { fixture.close(); reference.close(); }
  });
});
