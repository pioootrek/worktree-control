import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { validateDatabase } from "./database-validation";
import { hashFile, parseManifest, validateBackup, validateSnapshot } from "./backup-validation";
import { SECURITY_TABLES, securityFenceChecksum, securityFenceMigration, securityTriggers } from "./security-fence-migration";
import { UPGRADE_MARKER_SECURITY_TABLES, UPGRADE_MARKER_VERSION, upgradeMarkerChecksum, upgradeMarkerMigration, upgradeMarkerTriggers } from "./upgrade-marker-migration";
import { PROJECT_MAPPING_SECURITY_TABLES } from "./mapping-structure-migration";
import { SECURITY_COVERAGE, securityTriggersAt } from "./security-coverage";
import { rewindUpgradeMarker } from "./fixtures/schema-rewind";
import { openStoreAt, schemaAt49 } from "./fixtures/released-schema";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "upgrade-marker-")); roots.push(root); return root; };

// Step 50 exactly; step 51 has its own tests.
const TARGET = UPGRADE_MARKER_VERSION;
const atTarget = (database: Database.Database) => { inspectSchema(database, TARGET); };
/** A connection without `worktree_security_pending`, as in ordinary startup before the fence attaches. */
const ordinary = (path = ":memory:") => new Database(path);
const fresh50 = (database = ordinary()) => { initializeSchema(database, undefined, atTarget, { target: TARGET }); return database; };
const fresh49 = (database = ordinary()) => schemaAt49(database);
const marker = (database: Database.Database) => database.prepare("SELECT singleton,state,changed_at FROM upgrade_marker").all() as Array<{ singleton: number; state: string; changed_at: string }>;
const catalogue = (database: Database.Database) => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
const shapes = (database: Database.Database) => Object.fromEntries((database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[])
  .map(name => [name, { columns: database.prepare(`PRAGMA table_info("${name}")`).all(), keys: database.prepare(`PRAGMA foreign_key_list("${name}")`).all() }]));
const markerObjects = (database: Database.Database) => database.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='upgrade_marker' OR type='trigger' ORDER BY type,name").all();
const triggers = (database: Database.Database) => database.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
/** Binary order, as SQLite sorts by name. */
const byName = (list: Array<{ name: string; sql: string }>) => [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
const UNKNOWN_NEWER = "INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(50,'2026-11-15T00:00:00.000Z','unknown-newer','" + "0".repeat(64) + "')";
const SCHEMA_REFUSAL = /^Unsupported or unrecognized database schema/;
/** The tables of released step 49, in their frozen order. */
const STEP_49_TABLES = ["reservations", "test_runs", "human_runtime_leases", "human_runtime_intents", "human_test_run_requesters", "human_test_run_intents",
  "test_run_requesters", "remote_verification_requests", "remote_verification_attempts", "remote_verification_cancellations", "remote_verification_reports",
  "remote_worker_receipts", "projects", "knowledge_projects", "controller_settings", "remote_principals", "principal_credentials", "remote_workers",
  "remote_project_identities", "remote_principal_project_grants", "remote_worker_project_grants", "knowledge_project_grants", "knowledge_role_bindings",
  "knowledge_project_runtime_links", "runtime_delegations", "runtime_credential_scopes", "runtime_human_memberships", "authentication_provider_subjects",
  "authentication_ba_user", "authentication_ba_account", "authentication_ba_session", "authentication_ba_verification", "authentication_ba_two_factor",
  "authentication_ba_passkey", "authentication_account_policies", "authentication_totp_steps", "authentication_passkey_trust", "authentication_passkey_staged",
  "authentication_factor_contexts", "authentication_factor_budgets", "authentication_factor_receipts", "authentication_session_evidence",
  "authentication_session_issuance", "dev_environment_vaults"];
/** The marker table exactly as step 50 creates it; SQLite stores this text unchanged. */
const MARKER_TABLE = `CREATE TABLE upgrade_marker (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  changed_at TEXT NOT NULL,
  plan_hash TEXT CHECK(plan_hash IS NULL OR (typeof(plan_hash)='text' AND length(plan_hash)=64 AND length(CAST(plan_hash AS BLOB))=64 AND NOT plan_hash GLOB '*[^0-9a-f]*')),
  CHECK(state='complete' OR plan_hash IS NULL)
)`;
const COMPLETE_ROW = "INSERT INTO upgrade_marker VALUES(1,'complete','2026-11-15T00:00:00.000Z',NULL)";
/** A marker table without constraints, for rows the genuine table would refuse. */
const LOOSE_MARKER = "CREATE TABLE upgrade_marker (singleton INTEGER, state TEXT, changed_at TEXT, plan_hash)";
const PLAN = "a".repeat(64);
/** Replace the marker table (and drop its triggers) for structural or invalid-row fixtures. */
function rebuildMarker(database: Database.Database, ddl: string, rows = "", restoreTriggers = false) {
  for (const trigger of upgradeMarkerTriggers) database.exec(`DROP TRIGGER ${trigger.name}`);
  database.exec(`DROP TABLE upgrade_marker; ${ddl}; ${rows}`);
  if (restoreTriggers) for (const trigger of upgradeMarkerTriggers) database.exec(trigger.sql);
}
/** A private data directory with one database file, as the owned store expects. */
function privateDatabase(build: (database: Database.Database) => void) {
  const directory = join(temporary(), "data"); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "state.sqlite3"), database = ordinary(path);
  try { build(database); } finally { database.close(); }
  chmodSync(path, 0o600);
  return path;
}
/** A backup tree with no attachments around one database. */
function backupTree(build: (database: Database.Database) => void, schemaVersion: number) {
  const root = temporary(), path = join(root, "state.sqlite3");
  const database = ordinary(path);
  try { build(database); } finally { database.close(); }
  mkdirSync(join(root, "attachments"));
  const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(),
    database: { file: "state.sqlite3", ...hashFile(path), schemaVersion }, attachments: [] };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, path, manifest };
}

describe("schema step 50: upgrade marker", () => {
  it("keeps schema-49 coverage frozen and covers the marker with the same trigger body", () => {
    expect(SECURITY_TABLES).not.toContain("upgrade_marker");
    // Steps 49 to 51; step 52's entry is pinned in account-grants-migration.test.ts.
    expect(SECURITY_COVERAGE.slice(0, 3).map(step => [step.version, step.tables])).toEqual([[49, SECURITY_TABLES], [50, UPGRADE_MARKER_SECURITY_TABLES], [51, PROJECT_MAPPING_SECURITY_TABLES]]);
    expect(securityTriggersAt(48)).toEqual([]);
    expect(securityTriggersAt(49)).toEqual(securityTriggers);
    expect(securityTriggersAt(50)).toEqual([...securityTriggers, ...upgradeMarkerTriggers]);
    expect(upgradeMarkerTriggers.map(trigger => trigger.name)).toEqual(["security_upgrade_marker_insert", "security_upgrade_marker_update", "security_upgrade_marker_delete"]);
    // Same body as a schema-49 table's trigger, with only the table name changed.
    for (const [index, trigger] of upgradeMarkerTriggers.entries()) {
      expect(trigger.sql).toBe(securityTriggers[index].sql.replaceAll(SECURITY_TABLES[0], "upgrade_marker"));
    }
    // The checksum covers the whole executed text; step 49 is unchanged.
    expect(upgradeMarkerMigration).toMatchObject({ version: 50, name: "explicit-upgrade-marker" });
    expect(upgradeMarkerMigration.sql).toContain("INSERT INTO upgrade_marker(singleton,state,changed_at) VALUES(1,?,");
    for (const trigger of upgradeMarkerTriggers) expect(upgradeMarkerMigration.sql).toContain(trigger.sql);
    expect(upgradeMarkerChecksum).toMatch(/^[0-9a-f]{64}$/);
    // Pinned: a change to the step's text is a visible edit here.
    expect(upgradeMarkerChecksum).toBe("d720c5eef040ff328401426cc18fefb560a6be7460cc355a789f169d5d07315c");
    expect(upgradeMarkerMigration.sql.startsWith(`${MARKER_TABLE};\n`)).toBe(true);
    expect(securityFenceMigration).toMatchObject({ version: 49, name: "external-security-checkpoint" });
  });

  it("pins released step 49: checksum, covered tables and every trigger name and body", () => {
    // Values of the released step as it is; any change to SECURITY_TABLES or the trigger body fails here.
    expect(securityFenceChecksum).toBe("320f46981c17c44f4d14ee48298bd91f43d01ab78bf4162c607d2118f29486ae");
    expect(SECURITY_TABLES).toEqual(STEP_49_TABLES);
    expect(securityTriggers).toHaveLength(132);
    expect(securityTriggers.map(trigger => trigger.name)).toEqual(STEP_49_TABLES.flatMap(table => ["insert", "update", "delete"].map(event => `security_${table}_${event}`)));
    expect(createHash("sha256").update(securityTriggers.map(trigger => `${trigger.name}\0${trigger.sql}`).join("\n")).digest("hex"))
      .toBe("368a47d2ee6e8f2bcf5aeb9d59edecd62fc357b3e577971d90c4e1b1490cd8c6");
    expect(securityTriggers[0].sql).toBe("CREATE TRIGGER security_reservations_insert BEFORE INSERT ON reservations BEGIN SELECT worktree_security_pending(); UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32))) WHERE singleton=1; END");
  });

  it("does not apply or recognise step 50 at target 49, and refuses a step-50 database there like an unknown newer schema", () => {
    const current = fresh49();
    try {
      expect(SUPPORTED_SCHEMA_VERSION).toBe(52);
      expect(inspectSchema(current, 49)).toEqual({ version: 49, fresh: false });
      expect(current.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_marker'").get()).toBeUndefined();
      expect(triggers(current)).toEqual(byName(securityTriggers));
    } finally { current.close(); }
    const provisional = fresh50(), unknown = fresh49();
    try {
      unknown.exec(UNKNOWN_NEWER);
      const refusal = message(() => inspectSchema(unknown, 49));
      expect(refusal).toMatch(SCHEMA_REFUSAL);
      expect(message(() => inspectSchema(provisional, 49))).toBe(refusal);
      // An initialisation at 49 does not recognise it either.
      expect(message(() => initializeSchema(provisional, false, database => { inspectSchema(database, 49); }, { target: 49 }))).toBe(refusal);
    } finally { provisional.close(); unknown.close(); }
    // A store opened at 49 (the test-side opener: an ordinary owner at that target).
    const provisionalPath = privateDatabase(database => fresh50(database));
    const unknownPath = privateDatabase(database => { fresh49(database); database.exec(UNKNOWN_NEWER); });
    const opening = message(() => openStoreAt(unknownPath, 49));
    expect(opening).toMatch(SCHEMA_REFUSAL);
    expect(message(() => openStoreAt(provisionalPath, 49))).toBe(opening);
  });

  it("initialises a fresh database at target 50 with a complete marker, on a connection without the fence function", () => {
    const database = fresh50();
    try {
      expect(inspectSchema(database, TARGET)).toEqual({ version: 50, fresh: false });
      expect(() => validateDatabase(database, 50)).not.toThrow();
      expect(marker(database)).toEqual([{ singleton: 1, state: "complete", changed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) }]);
      expect(triggers(database)).toEqual(byName([...securityTriggers, ...upgradeMarkerTriggers]));
      expect(database.prepare("SELECT name,checksum FROM schema_migrations WHERE version>=49 ORDER BY version").all())
        .toEqual([{ name: securityFenceMigration.name, checksum: securityFenceChecksum }, { name: upgradeMarkerMigration.name, checksum: upgradeMarkerChecksum }]);
      // The fence covers the marker: every write reaches the missing observer.
      for (const statement of ["UPDATE upgrade_marker SET state='complete'", "DELETE FROM upgrade_marker",
        "INSERT INTO upgrade_marker VALUES(2,'complete','2026-11-15T00:00:00.000Z',NULL)"]) {
        expect(() => database.exec(statement)).toThrow(/no such function: worktree_security_pending/);
      }
      expect(marker(database)).toHaveLength(1);
      // Initialising again changes nothing.
      initializeSchema(database, false, atTarget, { target: TARGET });
      expect(marker(database)[0].state).toBe("complete");
    } finally { database.close(); }
    // Only an empty database counts as fresh, whatever the caller passes.
    const explicit = ordinary();
    try { initializeSchema(explicit, false, atTarget, { target: TARGET }); expect(marker(explicit)[0].state).toBe("complete"); } finally { explicit.close(); }
    const claimed = fresh49();
    try { initializeSchema(claimed, true, atTarget, { target: TARGET }); expect(marker(claimed)[0].state).toBe("pending"); } finally { claimed.close(); }
  });

  it("migrates schema 49 and an older fixture to a pending marker with the fresh structure, without the fence function", () => {
    const reference = fresh50(), reference49 = fresh49();
    const from49 = fresh49(), from40 = ordinary();
    try {
      from40.exec(readFileSync(new URL("./fixtures/schema-v40.sql", import.meta.url), "utf8"));
      expect(inspectSchema(from40).version).toBe(40);
      for (const database of [from49, from40]) {
        initializeSchema(database, false, atTarget, { target: TARGET });
        expect(inspectSchema(database, TARGET)).toEqual({ version: 50, fresh: false });
        expect(() => validateDatabase(database, 50)).not.toThrow();
        expect(marker(database)).toEqual([{ singleton: 1, state: "pending", changed_at: expect.any(String) }]);
        expect(markerObjects(database)).toEqual(markerObjects(reference));
        expect(() => database.exec("UPDATE upgrade_marker SET state='complete'")).toThrow(/no such function: worktree_security_pending/);
      }
      // From schema 49 the whole structure matches the fresh one; only rows differ.
      expect(catalogue(from49)).toEqual(catalogue(reference));
      expect(shapes(from49)).toEqual(shapes(reference));
      // The rewind fixture returns it to the schema-49 structure.
      rewindUpgradeMarker(from49);
      expect(inspectSchema(from49)).toEqual({ version: 49, fresh: false });
      expect(catalogue(from49)).toEqual(catalogue(reference49));
      rewindUpgradeMarker(from49);
      expect(inspectSchema(from49).version).toBe(49);
    } finally { for (const database of [reference, reference49, from49, from40]) database.close(); }
  });

  it("rolls back step 50 with the rest of the schema transaction", () => {
    const database = fresh49();
    try {
      const before = catalogue(database);
      expect(() => initializeSchema(database, false, () => { throw new Error("fixture rollback50"); }, { target: TARGET })).toThrow("fixture rollback50");
      expect(catalogue(database)).toEqual(before);
      expect(inspectSchema(database).version).toBe(49);
    } finally { database.close(); }
  });

  it.each([
    ["an extra column", (db: Database.Database) => db.exec("ALTER TABLE upgrade_marker ADD COLUMN extra TEXT")],
    ["a missing column", (db: Database.Database) => db.exec("ALTER TABLE upgrade_marker DROP COLUMN changed_at")],
    ["a widened constraint", (db: Database.Database) => rebuildMarker(db, MARKER_TABLE.replace("('pending','complete')", "('pending','complete','skipped')"),
      "INSERT INTO upgrade_marker VALUES(1,'pending','2026-11-15T00:00:00.000Z',NULL)", true)],
    ["an added constraint", (db: Database.Database) => rebuildMarker(db, MARKER_TABLE.replace("changed_at TEXT NOT NULL,", "changed_at TEXT NOT NULL CHECK(changed_at<>''),"),
      "INSERT INTO upgrade_marker VALUES(1,'pending','2026-11-15T00:00:00.000Z',NULL)", true)],
    ["a plan hash without its constraint", (db: Database.Database) => rebuildMarker(db, MARKER_TABLE.replace(/ CHECK\(plan_hash IS NULL[^\n]*\),\n/, ",\n"),
      "INSERT INTO upgrade_marker VALUES(1,'pending','2026-11-15T00:00:00.000Z',NULL)", true)],
    ["a missing plan-hash column", (db: Database.Database) => rebuildMarker(db, `CREATE TABLE upgrade_marker (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state IN ('pending','complete')),
  changed_at TEXT NOT NULL
)`, "INSERT INTO upgrade_marker VALUES(1,'pending','2026-11-15T00:00:00.000Z')", true)],
    ["a missing trigger", (db: Database.Database) => db.exec("DROP TRIGGER security_upgrade_marker_update")],
    ["an altered trigger body", (db: Database.Database) => db.exec("DROP TRIGGER security_upgrade_marker_delete; CREATE TRIGGER security_upgrade_marker_delete BEFORE DELETE ON upgrade_marker BEGIN SELECT 1; END")],
    ["an extra unknown trigger", (db: Database.Database) => db.exec("CREATE TRIGGER extra_upgrade_marker AFTER UPDATE ON upgrade_marker BEGIN SELECT 1; END")],
    ["a wrong checksum", (db: Database.Database) => db.exec(`UPDATE schema_migrations SET checksum='${"0".repeat(64)}' WHERE version=50`)],
    ["a wrong name", (db: Database.Database) => db.exec("UPDATE schema_migrations SET name='other-step' WHERE version=50")],
    ["a missing marker table", (db: Database.Database) => { for (const trigger of upgradeMarkerTriggers) db.exec(`DROP TRIGGER ${trigger.name}`); db.exec("DROP TABLE upgrade_marker"); }],
    ["a marker table before its migration", (db: Database.Database) => db.exec("DELETE FROM schema_migrations WHERE version=50")],
  ])("refuses a step-50 database with %s at ceiling 50", (_name, mutate) => {
    // The no-op observer lets fixture DDL rewrite the covered table.
    const database = fresh50(unmanagedFixtureDatabase(":memory:"));
    try {
      expect(() => inspectSchema(database, TARGET)).not.toThrow();
      mutate(database);
      expect(() => inspectSchema(database, TARGET)).toThrow(SCHEMA_REFUSAL);
    } finally { database.close(); }
  });

  it.each([
    ["state literals differing only in case", "('PENDING','complete')"],
    ["a state literal differing only in inner whitespace", "('pend ing','complete')"],
    ["an extra accepted state", "('pending','complete','skipped')"],
  ])("refuses a marker table with %s at ceiling 50, also with a complete row and the triggers restored", (_name, states) => {
    const ddl = MARKER_TABLE.replace("('pending','complete')", states);
    expect(ddl).not.toBe(MARKER_TABLE);
    const database = fresh50(unmanagedFixtureDatabase(":memory:"));
    try {
      rebuildMarker(database, ddl, COMPLETE_ROW, true);
      // The row itself is valid; only recognition can refuse the table.
      expect(() => validateDatabase(database, 50)).not.toThrow();
      expect(message(() => inspectSchema(database, TARGET))).toMatch(/^Unsupported or unrecognized database schema \(shape of upgrade_marker\)/);
    } finally { database.close(); }
    // A backup of it is refused at the ceiling 50 as well.
    // The rebuild drops the triggers before it writes, so an ordinary connection suffices.
    const backup = backupTree(database => { fresh50(database); rebuildMarker(database, ddl, COMPLETE_ROW, true); }, 50);
    expect(() => validateBackup(backup.root, parseManifest(backup.manifest, TARGET), false, TARGET)).toThrow(SCHEMA_REFUSAL);
  });

  it("recognises the marker table and its triggers by their exact text, on a fresh and on a migrated database", () => {
    const fresh = fresh50(), migrated = fresh49(), rebuilt = fresh50(unmanagedFixtureDatabase(":memory:")), reformatted = fresh50(unmanagedFixtureDatabase(":memory:"));
    try {
      initializeSchema(migrated, false, atTarget, { target: TARGET });
      for (const database of [fresh, migrated]) {
        // SQLite stores the CREATE text as the step executed it, byte for byte.
        expect(database.prepare("SELECT sql FROM sqlite_master WHERE name='upgrade_marker'").pluck().get()).toBe(MARKER_TABLE);
        for (const trigger of upgradeMarkerTriggers) expect(database.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(trigger.name)).toBe(trigger.sql);
        expect(inspectSchema(database, TARGET)).toEqual({ version: 50, fresh: false });
      }
      expect(upgradeMarkerMigration.sql.startsWith(`${MARKER_TABLE};\n`)).toBe(true);
      // A rebuild with the identical text is the genuine table.
      rebuildMarker(rebuilt, MARKER_TABLE, COMPLETE_ROW, true);
      expect(inspectSchema(rebuilt, TARGET)).toEqual({ version: 50, fresh: false });
      // Exact means exact: a reformatted table is not the step's, nor a recased step-50 trigger.
      rebuildMarker(reformatted, MARKER_TABLE.replace(/\n\s*/g, " "), COMPLETE_ROW, true);
      expect(() => inspectSchema(reformatted, TARGET)).toThrow(SCHEMA_REFUSAL);
      const recased = upgradeMarkerTriggers[2];
      rebuilt.exec(`DROP TRIGGER ${recased.name}; ${recased.sql.replace("SELECT worktree_security_pending()", "select worktree_security_pending()")}`);
      expect(() => inspectSchema(rebuilt, TARGET)).toThrow(SCHEMA_REFUSAL);
      // Released recognition of the schema-49 triggers is unchanged (normalised): a recased body is still accepted.
      const released = securityTriggers[0];
      migrated.close();
      const current = fresh49(unmanagedFixtureDatabase(":memory:"));
      try {
        current.exec(`DROP TRIGGER ${released.name}; ${released.sql.replace("SELECT worktree_security_pending()", "select worktree_security_pending()")}`);
        expect(inspectSchema(current)).toEqual({ version: 49, fresh: false });
      } finally { current.close(); }
    } finally { for (const database of [fresh, migrated, rebuilt, reformatted]) if (database.open) database.close(); }
  });

  it("recognises a schema-49 database at ceiling 50 unchanged", () => {
    const database = fresh49();
    try {
      expect(inspectSchema(database, TARGET)).toEqual({ version: 49, fresh: false });
      expect(() => validateDatabase(database, 49)).not.toThrow();
    } finally { database.close(); }
  });

  it.each([
    ["no row", (db: Database.Database) => db.exec("DELETE FROM upgrade_marker")],
    ["two rows", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER,
      "INSERT INTO upgrade_marker VALUES(1,'pending','2026-11-15T00:00:00.000Z',NULL),(1,'complete','2026-11-15T00:00:00.000Z',NULL)")],
    ["another singleton", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER,
      "INSERT INTO upgrade_marker VALUES(2,'complete','2026-11-15T00:00:00.000Z',NULL)")],
    ["an invalid state", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER,
      "INSERT INTO upgrade_marker VALUES(1,'skipped','2026-11-15T00:00:00.000Z',NULL)")],
    ["a pending marker with a plan hash", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER, `INSERT INTO upgrade_marker VALUES(1,'pending','2026-11-15T00:00:00.000Z','${PLAN}')`)],
    ["an uppercase plan hash", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER, `INSERT INTO upgrade_marker VALUES(1,'complete','2026-11-15T00:00:00.000Z','${PLAN.toUpperCase()}')`)],
    ["a short plan hash", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER, `INSERT INTO upgrade_marker VALUES(1,'complete','2026-11-15T00:00:00.000Z','${PLAN.slice(1)}')`)],
    ["a plan hash stored as a BLOB", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER, `INSERT INTO upgrade_marker VALUES(1,'complete','2026-11-15T00:00:00.000Z',CAST('${PLAN}' AS BLOB))`)],
    ["an empty plan hash", (db: Database.Database) => rebuildMarker(db, LOOSE_MARKER, "INSERT INTO upgrade_marker VALUES(1,'complete','2026-11-15T00:00:00.000Z','')")],
    ["a timestamp without milliseconds", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-11-15T00:00:00Z'")],
    ["a timestamp with a space", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-11-15 00:00:00.000'")],
    ["an impossible date", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-02-30T00:00:00.000Z'")],
    ["a non-date", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='yesterday'")],
    ["a numeric timestamp", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at=2461000")],
    // SQLite's parser accepts hour 24 and prints it back; the Julian-day rule refuses it.
    ["hour 24", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-11-15T24:30:00.000Z'")],
    ["hour 24 at midnight", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-11-15T24:00:00.000Z'")],
    ["minute 60", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-11-15T23:60:00.000Z'")],
    ["second 60", (db: Database.Database) => db.exec("UPDATE upgrade_marker SET changed_at='2026-11-15T23:59:60.000Z'")],
  ])("refuses a marker with %s in validation at 50 only", (_name, mutate) => {
    // The no-op observer lets the fixture write through the marker's triggers.
    const database = unmanagedFixtureDatabase(":memory:");
    try {
      fresh50(database);
      mutate(database);
      expect(() => validateDatabase(database, 50)).toThrow("SQLite application invariant failed (upgrade marker); startup stopped.");
      expect(() => validateDatabase(database, 49)).not.toThrow();
    } finally { database.close(); }
  });

  it("records a plan hash only on a complete marker: the table refuses the others, validation accepts both complete forms", () => {
    const database = unmanagedFixtureDatabase(":memory:");
    try {
      fresh50(database);
      // A fresh complete marker has no plan hash; an applied one has a lowercase SHA-256.
      expect(marker(database)[0].state).toBe("complete");
      expect(database.prepare("SELECT plan_hash FROM upgrade_marker").pluck().get()).toBeNull();
      database.exec(`UPDATE upgrade_marker SET plan_hash='${PLAN}'`);
      expect(() => validateDatabase(database, 50)).not.toThrow();
      expect(() => inspectSchema(database, TARGET)).not.toThrow();
      for (const statement of [`UPDATE upgrade_marker SET state='pending'`, `UPDATE upgrade_marker SET plan_hash='${PLAN.toUpperCase()}'`,
        `UPDATE upgrade_marker SET plan_hash='${PLAN.slice(1)}'`, `UPDATE upgrade_marker SET plan_hash=CAST('${PLAN}' AS BLOB)`, "UPDATE upgrade_marker SET plan_hash=''",
        `UPDATE upgrade_marker SET plan_hash='${"g".repeat(64)}'`]) {
        expect(() => database.exec(statement), statement).toThrow(/CHECK constraint failed/);
      }
      // SQLite's text length and GLOB stop at NUL: the byte length makes the table
      // refuse what validateDatabase refuses, also through a bound parameter.
      for (const value of [`${PLAN}\0`, `${PLAN}\0suffix`, `${PLAN.slice(4)}\0abc`, "\u00e9".repeat(64)]) {
        expect(() => database.prepare("UPDATE upgrade_marker SET plan_hash=?").run(value), JSON.stringify(value)).toThrow(/CHECK constraint failed/);
        expect(() => database.prepare("INSERT OR REPLACE INTO upgrade_marker(singleton,state,changed_at,plan_hash) VALUES(1,'complete',strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)").run(value)).toThrow(/CHECK constraint failed/);
      }
      expect(database.prepare("SELECT plan_hash FROM upgrade_marker").pluck().get()).toBe(PLAN);
      database.exec("UPDATE upgrade_marker SET state='pending',plan_hash=NULL");
      expect(() => validateDatabase(database, 50)).not.toThrow();
      expect(() => database.exec(`UPDATE upgrade_marker SET plan_hash='${PLAN}'`)).toThrow(/CHECK constraint failed/);
    } finally { database.close(); }
  });

  it("accepts a schema-50 backup only with a ceiling of 50 or more", () => {
    const provisional = backupTree(database => fresh50(database), 50);
    const unknown = backupTree(database => { fresh49(database); database.exec(UNKNOWN_NEWER); }, 49);
    const current = backupTree(database => fresh49(database), 49);
    const manifestRefusal = "Unsupported or invalid backup manifest (types, paths, versions or limits).";
    expect(() => parseManifest(provisional.manifest, 49)).toThrow(manifestRefusal);
    expect(parseManifest(provisional.manifest).database.schemaVersion).toBe(50);
    expect(() => parseManifest({ ...provisional.manifest, database: { ...provisional.manifest.database, schemaVersion: 51 } }, TARGET)).toThrow(manifestRefusal);
    const parsed = parseManifest(provisional.manifest, TARGET);
    expect(parsed.database.schemaVersion).toBe(50);
    expect(() => validateBackup(provisional.root, parsed, false, TARGET)).not.toThrow();
    // At ceiling 49 the snapshot itself is refused as the unknown newer one is; the default (52) accepts it.
    const refusal = message(() => validateSnapshot(unknown.path, parseManifest(unknown.manifest, 49), 49));
    expect(refusal).toMatch(SCHEMA_REFUSAL);
    expect(message(() => validateSnapshot(provisional.path, parsed, 49))).toBe(refusal);
    expect(message(() => validateBackup(provisional.root, parsed, false, 49))).toBe(refusal);
    expect(() => validateBackup(provisional.root, parsed)).not.toThrow();
    // A schema-49 backup is accepted at every ceiling.
    expect(() => validateBackup(current.root, parseManifest(current.manifest))).not.toThrow();
    expect(() => validateBackup(current.root, parseManifest(current.manifest, 49), false, 49)).not.toThrow();
    expect(() => validateBackup(current.root, parseManifest(current.manifest, TARGET), false, TARGET)).not.toThrow();
    // The first target above the supported version.
    expect(() => parseManifest(current.manifest, 53)).toThrow("Unsupported schema target.");
  });
});
