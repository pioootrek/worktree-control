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
import { createFencedAt49, openStoreAt, openStoreAt49, RELEASED_SCHEMA_VERSION, schemaAt49 } from "./fixtures/released-schema";

/**
 * The schema-49 fixtures build the released schema 49 by its own steps, while
 * this release creates 53 by default; the test-side store opens such a
 * database at 49 through an ordinary owner (the admission check runs there)
 * and refuses anything else loudly.
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
  it("keeps the released version and the fence base at 49, below the supported version", () => {
    expect(RELEASED_SCHEMA_VERSION).toBe(49);
    expect(SECURITY_FENCE_SCHEMA_VERSION).toBe(RELEASED_SCHEMA_VERSION);
    expect(SUPPORTED_SCHEMA_VERSION).toBe(53);
  });

  it("creates a fenced schema-49 database with a confirmed witness, which the store opened at 49 reopens unchanged", () => {
    const fixture = dataPath();
    createFencedAt49(fixture);
    expect(witness(fixture)).toMatchObject({ format: 1, state: "confirmed", receipt: null, recoveredAt: null, restore: null });
    expect(sidecars(fixture)).toEqual([false, false]);
    // Trusted by the fence, at 49.
    const owner = new OwnedSqliteDatabase(fixture, false, RELEASED_SCHEMA_VERSION, { inspectOnly: true });
    try {
      expect(owner.inspection).toEqual({ version: 49, fresh: false });
      expect(() => SecurityFence.inspect(owner.canonicalPath, owner.database, false)).not.toThrow();
    } finally { owner.close(); }
    // The store's own reopening at 49 changes no row; the ordinary store refuses it as needing the upgrade.
    const before = content(fixture);
    const store = openStoreAt49(fixture);
    try { expect(store.schemaVersion()).toBe(49); } finally { store.close(); }
    expect(content(fixture)).toEqual(before);
    expect(() => new SqliteStateStore(fixture)).toThrowError(expect.objectContaining({ code: "upgrade_required" }));
    expect(content(fixture)).toEqual(before);
    expect(() => createFencedAt49(fixture)).toThrow("creates a new database only");
  });

  it("opens a store at 49 on a new path, and refuses a database of this release as an unknown newer schema", () => {
    const fixture = dataPath(), current = dataPath();
    const store = openStoreAt49(fixture);
    try { expect(store.schemaVersion()).toBe(49); } finally { store.close(); }
    new SqliteStateStore(current).close();
    expect(() => openStoreAt49(current)).toThrow(/Unsupported or unrecognized database schema/);
    expect(() => openStoreAt(current, 51)).toThrow(/Unsupported or unrecognized database schema/);
  });

  it("initialises the schema-49 catalogue on a raw connection, which the default extends to 53", () => {
    const fixture = schemaAt49(new Database(":memory:")), current = new Database(":memory:");
    try {
      initializeSchema(current, undefined, inspectSchema);
      expect(inspectSchema(fixture)).toEqual({ version: 49, fresh: false });
      expect(inspectSchema(current)).toEqual({ version: 53, fresh: false });
      expect(fixture.prepare("SELECT version FROM schema_migrations ORDER BY version").pluck().all()).toEqual(Array.from({ length: 49 }, (_, index) => index + 1));
    } finally { fixture.close(); current.close(); }
  });
});
