import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVISIONAL_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { enableProvisionalSchema } from "./provisional-schema-gate";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { configureDurability, validateDatabase } from "./database-validation";
import { hashFile, parseManifest, validateBackup, validateSnapshot } from "./backup-validation";
import { SECURITY_TABLES, securityFenceChecksum, securityTriggers } from "./security-fence-migration";
import { UPGRADE_MARKER_SECURITY_TABLES, upgradeMarkerChecksum, upgradeMarkerTriggers } from "./upgrade-marker-migration";
import {
  applyMappingQuarantine, applyProjectMappingMigration, MAPPED_TABLES, MAPPING_CLOCK_MAX, planMappingQuarantine, PROJECT_MAPPING_COLUMN_DEFINITIONS,
  PROJECT_MAPPING_COLUMN_SUFFIX, PROJECT_MAPPING_SECURITY_TABLES, PROJECT_MAPPING_VERSION, projectMappingChecksum, projectMappingFenceTriggers,
  projectMappingMigration, projectMappingTriggers, projectMappingViolation,
} from "./mapping-structure-migration";
import { SECURITY_COVERAGE, schemaTriggersAt, securityTriggersAt, STEP_TRIGGERS } from "./security-coverage";
import { rewindProjectMapping, rewindUpgradeMarker } from "./fixtures/schema-rewind";
import { SqliteStateStore } from "./sqlite-state-store";
import { RemoteVerificationQueries } from "./remote-verification-queries";
import { maintainSqliteSecurityFence, quarantineAuthority } from "./security-maintenance";
import { rebuildTable } from "./verification-project-migration";
import { ProjectDirectoryQueries, type ProjectId, type RegistrationId, type RemoteIdentityId } from "./project-directory-queries";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup, type UpgradeBackupSource } from "./upgrade-maintenance";
import { SecurityFence } from "./security-fence";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { createControllerBackup } from "../../controller-backup";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";

const roots: string[] = [];
// Every test here needs target 51; the switch is restored after each one.
let restoreGate: () => void;
beforeEach(() => { restoreGate = enableProvisionalSchema(); });
afterEach(() => { restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = (prefix = "project-mapping-") => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };

const TARGET = PROJECT_MAPPING_VERSION;
type MappedTableName = typeof MAPPED_TABLES[number];
const MAX = MAPPING_CLOCK_MAX;
/** A connection without `worktree_security_pending`, as in ordinary startup before the fence attaches. */
const ordinary = (path = ":memory:") => new Database(path);
/**
 * A connection with the no-op observer `worktree_security_pending`, which is what the
 * maintenance observer registers (`SecurityFence.registerMaintenanceObserver`): covered
 * writes pass and change the checkpoint, and nothing publishes a witness.
 */
const observed = (path = ":memory:") => unmanagedFixtureDatabase(path);
const at = (target: number) => (database: Database.Database) => { inspectSchema(database, target); };
const fresh51 = (database = ordinary()) => { initializeSchema(database, undefined, at(TARGET), { target: TARGET }); return database; };
const fresh50 = (database = ordinary()) => { initializeSchema(database, undefined, at(50), { target: 50 }); return database; };
const fresh49 = (database = ordinary()) => { initializeSchema(database, undefined, inspectSchema); return database; };
const to51 = (database: Database.Database) => { initializeSchema(database, false, at(TARGET), { target: TARGET }); return database; };
const clock = (database: Database.Database) => database.prepare("SELECT value FROM project_mapping_clock").pluck().get() as number;
type Stamps = { id: string; parent: string | null; incarnation: number; version: number };
const stamps = (database: Database.Database, table: string) => database.prepare(`SELECT id,parent_project_id AS parent,incarnation,mapping_version AS version FROM ${table} ORDER BY rowid`).all() as Stamps[];
const stampOf = (database: Database.Database, table: string, id: string) => stamps(database, table).find(row => row.id === id)!;
const catalogue = (database: Database.Database) => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
const shapes = (database: Database.Database) => Object.fromEntries((database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[])
  .map(name => [name, { columns: database.prepare(`PRAGMA table_info("${name}")`).all(), keys: database.prepare(`PRAGMA foreign_key_list("${name}")`).all() }]));
/** Every object from step 50 on, and every trigger, by its stored text. */
const stepObjects = (database: Database.Database) => database.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE tbl_name IN ('upgrade_marker','project_mapping_clock','project_mapping_journal') OR type='trigger' ORDER BY type,name`).all();
const triggerNames = (database: Database.Database) => database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").pluck().all() as string[];
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
const sorted = (names: string[]) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const SCHEMA_REFUSAL = /^Unsupported or unrecognized database schema/;
const NO_OBSERVER = /no such function: worktree_security_pending/;
const UNKNOWN_51 = `INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(51,'2026-11-15T00:00:00.000Z','unknown-newer','${"0".repeat(64)}')`;
const PLAN = "a".repeat(64);
const RECEIPT = "00000000-0000-4000-8000-000000000000";
const AT = "2026-11-15T00:00:00.000Z";
const JOURNAL = "INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES(?,?,?,?,?,?,?,?)";
const journal = (database: Database.Database, row: Partial<Record<"kind" | "id" | "project" | "basis" | "plan" | "receipt" | "at", unknown>> & { incarnation?: unknown } = {}) =>
  database.prepare(JOURNAL).run(row.kind ?? "registration", row.id ?? "registration-a", row.incarnation ?? 1, row.project ?? "project-a", row.basis ?? "created_project", row.plan ?? PLAN, row.receipt ?? RECEIPT, row.at ?? AT);

/** The product's own write path for registrations: SqliteStateStore methods on this connection. */
function registrations(database: Database.Database): SqliteStateStore {
  const view = Object.create(SqliteStateStore.prototype) as { database: Database.Database };
  view.database = database;
  return view as unknown as SqliteStateStore;
}
let ports = 4100;
const registration = (store: SqliteStateStore, name = `app-${ports}`) => store.addProject({ name, repositoryPath: `/code/${name}-${ports}`, port: ports++, executable: "node", args: [] });
/** The product's own provisioning path for remote identities. */
const identities = (database: Database.Database) => new RemoteVerificationQueries(database);
const identity = (database: Database.Database, id: string, name = id) => identities(database).saveRemoteProjectIdentity({ id, name, sourceRemote: "origin", status: "active" }, "local-cli");
const knowledgeProject = (database: Database.Database, id: string, status = "active") =>
  database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)").run(id, id, status, AT, AT);
/** A mapping change as a later act makes it: advance the clock, then set the parent with the new value. */
function setParent(database: Database.Database, table: string, id: string, parent: string | null) {
  database.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
  database.prepare(`UPDATE ${table} SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?`).run(parent, id);
}
/** A private data directory with one database file, as the owned store expects. */
function privateDatabase(build: (database: Database.Database) => void, open = ordinary) {
  const directory = join(temporary(), "data"); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "state.sqlite3"), database = open(path);
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
/** A schema-49 installation built by the store itself (confirmed witness), with registrations and an identity. */
function installation() {
  const paths = resolveAppPaths(join(temporary(), "data"));
  const store = new SqliteStateStore(paths.databasePath);
  try {
    registration(store, "first"); registration(store, "second");
    store.saveRemoteProjectIdentity({ id: "remote-a", name: "Remote A", sourceRemote: "origin", status: "active" }, "local-cli");
  } finally { store.close(); }
  return paths;
}
const read = <T,>(paths: AppPaths, operation: (database: Database.Database) => T) => { const database = observed(paths.databasePath); try { return operation(database); } finally { database.close(); } };
/** Authority written outside its owner, so the fence needs `auth fence resume`. */
const touch = (paths: AppPaths) => read(paths, database => database.exec("UPDATE controller_settings SET updated_at=updated_at WHERE key='authentication'"));
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
const resume = (paths: AppPaths, target = TARGET) => maintainSqliteSecurityFence(paths,
  { action: "resume", expect: maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, target).preflight, mode: "token" }, HANDOFF, target);
/** The quarantine as `auth fence resume` runs it: as the acts of the one schema transaction. */
const quarantine = (database: Database.Database, receipt = RECEIPT, acts?: (database: Database.Database) => void) =>
  initializeSchema(database, false, at(TARGET), { target: TARGET, acts: current => { quarantineAuthority(current, receipt, "token", TARGET); acts?.(current); } });
const mapped = (database: Database.Database) => Object.fromEntries(MAPPED_TABLES.map(table => [table, stamps(database, table)]));
const rows = (database: Database.Database, table: string) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

/** Step 51's triggers on one mapped table: the guards first dropped and then restored by fixtures. */
const tableTriggers = (table: string) => projectMappingTriggers.filter(trigger => trigger.name.startsWith(`project_mapping_${table}_`));
/** Replaces step 51's columns of a mapped table with other definitions, keeping its triggers. */
function replaceColumns(database: Database.Database, table: string, definitions: readonly string[]) {
  // A REFERENCES column with a default other than NULL can be added only without enforcement.
  database.pragma("foreign_keys=OFF");
  for (const trigger of tableTriggers(table)) database.exec(`DROP TRIGGER ${trigger.name}`);
  for (const column of ["mapping_version", "incarnation", "parent_project_id"]) database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  for (const definition of definitions) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  for (const trigger of tableTriggers(table)) database.exec(trigger.sql);
}
const alteredColumns = (index: number, from: string, to: string) => {
  const definitions = [...PROJECT_MAPPING_COLUMN_DEFINITIONS] as string[];
  expect(definitions[index]).toContain(from);
  definitions[index] = definitions[index].replace(from, to);
  return definitions;
};
/** Rebuilds a mapped table without the step's column types and constraints, for rows the genuine table refuses. */
function loosen(database: Database.Database, table: string) {
  database.pragma("foreign_keys=OFF");
  rebuildTable(database, table, PROJECT_MAPPING_COLUMN_SUFFIX, ", parent_project_id, incarnation, mapping_version)");
}
const LOOSE_JOURNAL = "CREATE TABLE project_mapping_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind, subject_id, subject_incarnation, project_id, basis, plan_hash, run_receipt, recorded_at)";

describe("provisional schema step 51: project mapping structure", () => {
  it("pins step 51 and its coverage, and leaves steps 49 and 50 as they were", () => {
    expect(PROVISIONAL_SCHEMA_VERSION).toBe(51);
    expect(SUPPORTED_SCHEMA_VERSION).toBe(49);
    expect(projectMappingMigration).toMatchObject({ version: 51, name: "project-mapping-structure" });
    // Pinned while provisional: a change to the step's text is a visible edit here.
    expect(projectMappingChecksum).toBe("1c0afefd54f82635da94be7361bbe412ec76bbe49ff50a335ed8a248ea50bc85");
    // Steps 49 and 50 keep their pinned checksums (also pinned in upgrade-marker-migration.test.ts).
    expect(securityFenceChecksum).toBe("320f46981c17c44f4d14ee48298bd91f43d01ab78bf4162c607d2118f29486ae");
    expect(upgradeMarkerChecksum).toBe("d720c5eef040ff328401426cc18fefb560a6be7460cc355a789f169d5d07315c");
    expect(SECURITY_TABLES).not.toContain("project_mapping_clock");
    expect(SECURITY_COVERAGE.map(step => [step.version, step.tables])).toEqual([[49, SECURITY_TABLES], [50, UPGRADE_MARKER_SECURITY_TABLES], [51, PROJECT_MAPPING_SECURITY_TABLES]]);
    expect(PROJECT_MAPPING_SECURITY_TABLES).toEqual(["project_mapping_clock", "project_mapping_journal"]);
    expect(STEP_TRIGGERS.map(step => [step.version, step.triggers])).toEqual([[51, projectMappingTriggers]]);
    expect(securityTriggersAt(50)).toEqual([...securityTriggers, ...upgradeMarkerTriggers]);
    expect(securityTriggersAt(51)).toEqual([...securityTriggers, ...upgradeMarkerTriggers, ...projectMappingFenceTriggers]);
    expect(schemaTriggersAt(50).map(trigger => trigger.name)).toEqual([...securityTriggers, ...upgradeMarkerTriggers].map(trigger => trigger.name));
    expect(schemaTriggersAt(51).map(({ name, sql }) => ({ name, sql }))).toEqual([...securityTriggers, ...upgradeMarkerTriggers, ...projectMappingFenceTriggers, ...projectMappingTriggers]);
    // The fence triggers have the schema-49 body, with only the table name changed.
    for (const [index, trigger] of projectMappingFenceTriggers.entries()) {
      const table = PROJECT_MAPPING_SECURITY_TABLES[Math.floor(index / 3)];
      expect(trigger.sql).toBe(securityTriggers[index % 3].sql.replaceAll(SECURITY_TABLES[0], table));
    }
    expect(projectMappingTriggers.map(trigger => trigger.name)).toEqual([
      ...MAPPED_TABLES.flatMap(table => ["unstamped_insert", "stamp", "incarnation", "version"].map(kind => `project_mapping_${table}_${kind}`)),
      "project_mapping_clock_advance", "project_mapping_clock_insert", "project_mapping_clock_delete",
      "project_mapping_journal_insert", "project_mapping_journal_update", "project_mapping_journal_delete",
    ]);
    // The exact text of the clock and of the added columns.
    expect(projectMappingMigration.sql.startsWith(`CREATE TABLE project_mapping_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value BETWEEN 0 AND 9007199254740991)
);
INSERT INTO project_mapping_clock(singleton,value) VALUES(1,0);
CREATE TABLE project_mapping_journal (`)).toBe(true);
    expect(PROJECT_MAPPING_COLUMN_SUFFIX).toBe(", parent_project_id TEXT REFERENCES knowledge_projects(id)"
      + ", incarnation INTEGER NOT NULL DEFAULT 0 CHECK(incarnation BETWEEN 0 AND 9007199254740991 AND typeof(incarnation)='integer')"
      + ", mapping_version INTEGER NOT NULL DEFAULT 0 CHECK(mapping_version BETWEEN 0 AND 9007199254740991 AND typeof(mapping_version)='integer'))");
    for (const trigger of [...projectMappingFenceTriggers, ...projectMappingTriggers]) expect(projectMappingMigration.sql).toContain(`${trigger.sql};`);
    // The clock row precedes every trigger of the step.
    expect(projectMappingMigration.sql.indexOf("INSERT INTO project_mapping_clock")).toBeLessThan(projectMappingMigration.sql.indexOf("CREATE TRIGGER"));
    expect(MAX).toBe(9007199254740991);
  });

  it("neither applies nor recognises step 51 at the default target or at 50, and refuses a step-51 database like an unknown newer schema", async () => {
    const current = fresh49(), marker = fresh50();
    try {
      for (const database of [current, marker]) {
        expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'project_mapping%'").get()).toBeUndefined();
        expect((database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(column => column.name)).not.toContain("incarnation");
      }
      expect(triggerNames(marker)).toEqual(sorted([...securityTriggers, ...upgradeMarkerTriggers].map(trigger => trigger.name)));
    } finally { current.close(); marker.close(); }
    const provisional = fresh51(), unknown = fresh50();
    try {
      unknown.exec(UNKNOWN_51);
      const refusal = message(() => inspectSchema(unknown));
      expect(refusal).toMatch(SCHEMA_REFUSAL);
      for (const ceiling of [undefined, 49, 50]) {
        expect(message(() => inspectSchema(unknown, ceiling))).toBe(refusal);
        expect(message(() => inspectSchema(provisional, ceiling))).toBe(refusal);
      }
      // Initialisation at the default target or at 50 does not recognise it either.
      expect(message(() => initializeSchema(provisional, false, inspectSchema))).toBe(refusal);
      expect(message(() => initializeSchema(provisional, false, at(50), { target: 50 }))).toBe(refusal);
    } finally { provisional.close(); unknown.close(); }
    // Ordinary store opening.
    const provisionalPath = privateDatabase(database => fresh51(database));
    const unknownPath = privateDatabase(database => { fresh50(database); database.exec(UNKNOWN_51); });
    const opening = message(() => new SqliteStateStore(unknownPath));
    expect(opening).toMatch(SCHEMA_REFUSAL);
    expect(message(() => new SqliteStateStore(provisionalPath))).toBe(opening);
    // Offline maintenance and the upgrade, at the default target and at 50.
    const failure = (operation: () => unknown) => { try { operation(); } catch (error) { const { name, code, message: text } = error as { name: string; code?: string; message: string }; return { name, code, text }; } throw new Error("expected a refusal"); };
    const pathsOf = (database: string) => resolveAppPaths(join(database, "..")) as AppPaths;
    for (const target of [undefined, 50]) {
      const inspect = (path: string) => failure(() => maintainSqliteSecurityFence(pathsOf(path), { action: "inspect" }, HANDOFF, target));
      expect(inspect(provisionalPath)).toEqual(inspect(unknownPath));
    }
    const upgrade = (path: string) => failure(() => inspectSqliteUpgrade(pathsOf(path), 50));
    expect(upgrade(provisionalPath)).toEqual(upgrade(unknownPath));
    // Backup validation.
    const backup = backupTree(database => fresh51(database), 51);
    const unknownBackup = backupTree(database => { fresh50(database); database.exec(UNKNOWN_51); }, 50);
    const manifestRefusal = "Unsupported or invalid backup manifest (types, paths, versions or limits).";
    expect(() => parseManifest(backup.manifest)).toThrow(manifestRefusal);
    expect(() => parseManifest(backup.manifest, 50)).toThrow(manifestRefusal);
    const parsed = parseManifest(backup.manifest, TARGET);
    expect(() => validateBackup(backup.root, parsed, false, TARGET)).not.toThrow();
    const snapshotRefusal = message(() => validateSnapshot(unknownBackup.path, parseManifest(unknownBackup.manifest, 50), 50));
    expect(snapshotRefusal).toMatch(SCHEMA_REFUSAL);
    expect(message(() => validateSnapshot(backup.path, parsed))).toBe(snapshotRefusal);
    expect(message(() => validateSnapshot(backup.path, parsed, 50))).toBe(snapshotRefusal);
    expect(message(() => validateBackup(backup.root, parsed, false, 50))).toBe(snapshotRefusal);
  });

  it("applies step 51 fresh and from 49, 50 and an older fixture with one structure, on connections without the fence function", () => {
    const reference = fresh51(), reference50 = fresh50(), reference49 = fresh49();
    // Rows that exist before the step, written as the product writes them (with the observer).
    const seeded = (build: (database: Database.Database) => void) => privateDatabase(database => {
      build(database);
      const store = registrations(database);
      registration(store, "existing-a"); registration(store, "existing-b");
      identity(database, "remote-existing");
    }, observed);
    const from49 = ordinary(seeded(database => fresh49(database))), from50 = ordinary(seeded(database => fresh50(database)));
    const from40 = ordinary();
    try {
      from40.exec(readFileSync(new URL("./fixtures/schema-v40.sql", import.meta.url), "utf8"));
      expect(inspectSchema(from40).version).toBe(40);
      for (const database of [reference, from49, from50, from40]) {
        if (database !== reference) to51(database);
        expect(inspectSchema(database, TARGET)).toEqual({ version: 51, fresh: false });
        expect(() => validateDatabase(database, 51)).not.toThrow();
        expect(clock(database)).toBe(0);
        expect(database.prepare("SELECT count(*) FROM project_mapping_journal").pluck().get()).toBe(0);
        // Rows from before the step: parentless and unstamped; the step wrote none of them.
        for (const table of MAPPED_TABLES) for (const row of stamps(database, table)) expect(row).toMatchObject({ parent: null, incarnation: 0, version: 0 });
        expect(stepObjects(database)).toEqual(stepObjects(reference));
        for (const table of MAPPED_TABLES) {
          expect((database.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(table) as string).endsWith(PROJECT_MAPPING_COLUMN_SUFFIX)).toBe(true);
        }
        // The fence triggers of steps 49 and 50 are unchanged, byte for byte.
        for (const trigger of [...securityTriggers, ...upgradeMarkerTriggers]) expect(database.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(trigger.name)).toBe(trigger.sql);
        // The fence covers the clock, the journal and the new columns: every write reaches the missing observer.
        // (The fence trigger is compiled into each statement, so the missing function fails it when it is
        // prepared, before any of step 51's own guards runs.)
        for (const statement of ["UPDATE project_mapping_clock SET value=value+1",
          "INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES('remote-new','n','origin','active')",
          `INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES('registration','r',1,'p','created_project','${PLAN}','${RECEIPT}','${AT}')`]) {
          expect(() => database.exec(statement), statement).toThrow(NO_OBSERVER);
        }
        // Row triggers fire only for a row: the seeded databases have rows in both mapped tables.
        for (const table of MAPPED_TABLES) {
          if (!stamps(database, table).length) continue;
          for (const assignment of ["mapping_version=mapping_version", "incarnation=incarnation", "parent_project_id=NULL"]) {
            expect(() => database.exec(`UPDATE ${table} SET ${assignment}`), `${table} ${assignment}`).toThrow(NO_OBSERVER);
          }
        }
        expect(clock(database)).toBe(0);
      }
      for (const database of [from49, from50]) { expect(stamps(database, "projects")).toHaveLength(2); expect(stamps(database, "remote_project_identities")).toHaveLength(1); }
      // From 49 and 50 the whole structure matches the fresh one; only rows differ.
      for (const database of [from49, from50]) { expect(catalogue(database)).toEqual(catalogue(reference)); expect(shapes(database)).toEqual(shapes(reference)); }
      // The rewind fixture returns to the step-50 and step-49 structures.
      rewindProjectMapping(from50);
      expect(inspectSchema(from50, 50)).toEqual({ version: 50, fresh: false });
      expect(catalogue(from50)).toEqual(catalogue(reference50));
      rewindUpgradeMarker(from49);
      expect(inspectSchema(from49)).toEqual({ version: 49, fresh: false });
      expect(catalogue(from49)).toEqual(catalogue(reference49));
      rewindProjectMapping(from49);
      expect(inspectSchema(from49).version).toBe(49);
      // Initialising again changes nothing.
      const before = catalogue(reference);
      to51(reference);
      expect(catalogue(reference)).toEqual(before);
    } finally { for (const database of [reference, reference50, reference49, from49, from50, from40]) database.close(); }
  });

  it("rolls back step 51 with the rest of the schema transaction", () => {
    for (const database of [fresh49(), fresh50()]) {
      try {
        const before = catalogue(database), version = inspectSchema(database, TARGET).version;
        expect(() => initializeSchema(database, false, () => { throw new Error("fixture rollback51"); }, { target: TARGET })).toThrow("fixture rollback51");
        expect(catalogue(database)).toEqual(before);
        expect(inspectSchema(database, TARGET).version).toBe(version);
      } finally { database.close(); }
    }
  });
});

describe("step 51 stamping through the product's write paths (maintenance observer)", () => {
  it("stamps every new registration with a fresh clock value, and a recreated ID with a larger one", () => {
    const database = fresh51(observed());
    try {
      const store = registrations(database);
      const first = registration(store), second = registration(store);
      expect(stampOf(database, "projects", first.id)).toEqual({ id: first.id, parent: null, incarnation: 1, version: 1 });
      expect(stampOf(database, "projects", second.id)).toEqual({ id: second.id, parent: null, incarnation: 2, version: 2 });
      expect(clock(database)).toBe(2);
      // The application's own INSERT: one change, its own row id; the trigger's statements count in neither.
      const insert = database.prepare(`INSERT INTO projects (id, name, repository_path, port, launch_preset, executable, args_json,
          healthcheck_path, startup_timeout_ms, created_at, updated_at, godot_web_json) VALUES (?, ?, ?, ?, 'auto', 'node', '[]', '/', 45000, ?, ?, NULL)`);
      const result = insert.run("raw-one", "raw", "/code/raw", ports++, AT, AT);
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBe(database.prepare("SELECT rowid FROM projects WHERE id='raw-one'").pluck().get());
      expect(stampOf(database, "projects", "raw-one")).toMatchObject({ incarnation: 3, version: 3 });
      // Removal through the product, then a registration with the same ID: a new, larger incarnation.
      store.removeProject(first.id, "local-user");
      expect(stamps(database, "projects").some(row => row.id === first.id)).toBe(false);
      insert.run(first.id, "again", "/code/again", ports++, AT, AT);
      expect(stampOf(database, "projects", first.id)).toEqual({ id: first.id, parent: null, incarnation: 4, version: 4 });
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it("stamps a remote identity through its provisioning upsert and leaves the stamps on a repeated save", () => {
    const database = fresh51(observed());
    try {
      registration(registrations(database));
      identity(database, "remote-a");
      expect(stampOf(database, "remote_project_identities", "remote-a")).toEqual({ id: "remote-a", parent: null, incarnation: 2, version: 2 });
      // The upsert's update path (name and status) never touches the stamps.
      identities(database).saveRemoteProjectIdentity({ id: "remote-a", name: "Renamed", sourceRemote: "origin", status: "revoked" }, "local-cli");
      expect(database.prepare("SELECT name,status FROM remote_project_identities WHERE id='remote-a'").get()).toEqual({ name: "Renamed", status: "revoked" });
      expect(stampOf(database, "remote_project_identities", "remote-a")).toMatchObject({ incarnation: 2, version: 2 });
      expect(clock(database)).toBe(2);
      identity(database, "remote-b");
      expect(stampOf(database, "remote_project_identities", "remote-b")).toMatchObject({ incarnation: 3, version: 3 });
      // No product path deletes an identity; a deleted and re-provisioned one gets a larger incarnation.
      database.exec("DELETE FROM remote_project_identities WHERE id='remote-a'");
      identity(database, "remote-a");
      expect(stampOf(database, "remote_project_identities", "remote-a")).toMatchObject({ incarnation: 4, version: 4 });
      const upsert = database.prepare("INSERT INTO remote_project_identities(id, name, source_remote, status) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status");
      expect(upsert.run("remote-c", "C", "origin", "active").changes).toBe(1);
      expect(upsert.run("remote-c", "C2", "origin", "active").changes).toBe(1);
      expect(stampOf(database, "remote_project_identities", "remote-c")).toMatchObject({ incarnation: 5, version: 5 });
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it("keeps every existing registration update path working without touching the stamps or the parent", () => {
    const database = fresh51(observed());
    try {
      knowledgeProject(database, "project-a");
      const store = registrations(database);
      const project = registration(store);
      setParent(database, "projects", project.id, "project-a");
      const before = stampOf(database, "projects", project.id), clockBefore = clock(database);
      expect(before).toEqual({ id: project.id, parent: "project-a", incarnation: 1, version: 2 });
      const testProfile = { name: "fixture", policy: { mode: "clean", serverProfile: null }, environment: {}, nodeEnv: "test", requiredVariables: [] } as Parameters<SqliteStateStore["saveProjectTestEnvironmentProfile"]>[1];
      const attribution = { principalId: "installation", credentialId: "fixture-credential", operationId: "fixture-operation" };
      const scoped = (change: Parameters<SqliteStateStore["commitScopedConfiguration"]>[0]["change"]) =>
        store.commitScopedConfiguration({ projectId: project.id, expectedRevision: store.getProjectConfigurationRevision(project.id)!, claim: null, change, attribution });
      // Each product path that writes `projects` after creation (see the report of C2a), in an order whose preconditions hold.
      const paths: Array<[string, () => unknown]> = [
        ["setSelectedWorktree", () => store.setSelectedWorktree(project.id, "/code/worktree")],
        ["updateProjectLaunch", () => store.updateProjectLaunch(project.id, { tlsMode: "off", tlsKeyPath: null, tlsCertPath: null, tlsCaPath: null, executable: "node", args: ["dev"] })],
        ["setProjectGodotWeb", () => store.setProjectGodotWeb(project.id, { launchPreset: "node", godotWeb: null, executable: "node", args: [] }, "local-user")],
        ["updateProjectEnvironment", () => store.updateProjectEnvironment(project.id, { FIXTURE: "1" }, "local-user")],
        ["saveProjectEnvironmentProfile", () => store.saveProjectEnvironmentProfile(project.id, { name: "other", environment: {} }, "local-user")],
        ["commitScopedConfiguration (profile)", () => expect(scoped({ kind: "select_environment_profile", profileName: "other" })).toMatchObject({ status: "completed" })],
        ["selectProjectEnvironmentProfile", () => store.selectProjectEnvironmentProfile(project.id, "default", "local-user")],
        ["deleteProjectEnvironmentProfile", () => store.deleteProjectEnvironmentProfile(project.id, "other", "local-user")],
        ["saveProjectTestEnvironmentProfile", () => store.saveProjectTestEnvironmentProfile(project.id, testProfile, "local-user")],
        ["assignProjectTestPresetProfile", () => store.assignProjectTestPresetProfile(project.id, "node:test", "fixture", "local-user")],
        ["deleteProjectTestEnvironmentProfile", () => store.deleteProjectTestEnvironmentProfile(project.id, "fixture", "local-user")],
        ["setProjectTestPresetTimeout", () => store.setProjectTestPresetTimeout(project.id, "node:test", 60_000, "local-user")],
        ["commitScopedConfiguration (timeout)", () => expect(scoped({ kind: "set_test_preset_timeout", presetId: "node:check", timeoutMs: 1000, overrideLimit: 8 })).toMatchObject({ status: "completed" })],
      ];
      for (const [name, operation] of paths) {
        expect(operation, name).not.toThrow();
        expect(stampOf(database, "projects", project.id), name).toEqual(before);
      }
      expect(clock(database)).toBe(clockBefore);
      expect(store.getProject(project.id)).toMatchObject({ selectedWorktreePath: "/code/worktree", selectedEnvironmentProfile: "default", testPresetTimeouts: { "node:test": 60_000, "node:check": 1000 } });
      // Removal works with a parent set; the project row stays.
      store.removeProject(project.id, "local-user");
      expect(store.getProject(project.id)).toBeNull();
      expect(database.prepare("SELECT count(*) FROM knowledge_projects WHERE id='project-a'").pluck().get()).toBe(1);
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });
});

describe("step 51 guard triggers", () => {
  const IMMUTABLE = "project mapping incarnation is immutable", ADVANCE = "project mapping version must advance with the clock";
  const UNSTAMPED = "project mapping stamps are issued only by the mapping clock", EXHAUSTED = "project mapping clock exhausted";
  const APPEND_ONLY = "project mapping journal is append-only";
  const fixture = () => {
    const database = fresh51(observed());
    knowledgeProject(database, "project-a"); knowledgeProject(database, "project-b");
    const store = registrations(database), project = registration(store);
    identity(database, "remote-a");
    return { database, id: project.id };
  };

  it.each(MAPPED_TABLES)("refuses a change of an issued incarnation and any stamp an INSERT brings on %s", table => {
    const { database, id: registrationId } = fixture();
    const id = table === "projects" ? registrationId : "remote-a";
    try {
      const before = stampOf(database, table, id);
      for (const statement of [`UPDATE ${table} SET incarnation=incarnation+1 WHERE id='${id}'`, `UPDATE ${table} SET incarnation=0 WHERE id='${id}'`,
        `UPDATE OR REPLACE ${table} SET incarnation=NULL WHERE id='${id}'`, `UPDATE OR IGNORE ${table} SET incarnation=incarnation-1 WHERE id='${id}'`]) {
        expect(message(() => database.exec(statement)), statement).toBe(IMMUTABLE);
      }
      // Also through an upsert's update path.
      if (table === "remote_project_identities") {
        expect(message(() => database.exec("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES('remote-a','x','origin','active') ON CONFLICT(id) DO UPDATE SET incarnation=99"))).toBe(IMMUTABLE);
      }
      expect(stampOf(database, table, id)).toEqual(before);
      const columns = table === "projects"
        ? "(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at,{stamp}) VALUES('preset','p','/code/preset',4999,'node','[]','/',45000,'x','x',{value})"
        : "(id,name,source_remote,status,{stamp}) VALUES('preset','p','origin','active',{value})";
      for (const [stamp, value] of [["incarnation", "5"], ["mapping_version", "5"], ["incarnation", "'1'"], ["mapping_version", "NULL"]]) {
        const statement = `INSERT INTO ${table}${columns.replace("{stamp}", stamp).replace("{value}", value)}`;
        expect(message(() => database.exec(statement)), statement).toBe(UNSTAMPED);
      }
    } finally { database.close(); }
  });

  it("refuses a mapping version that does not advance with the clock, and permits exactly the advancing changes", () => {
    const { database, id } = fixture();
    try {
      const tick = () => database.exec("UPDATE project_mapping_clock SET value=value+1");
      const now = () => clock(database);
      const set = (assignments: string) => message(() => database.exec(`UPDATE projects SET ${assignments} WHERE id='${id}'`));
      // Refused: a parent change without an advance (kept equal), a lowered version, a larger
      // version that is not the clock's current value, and a version change of an unstamped row.
      expect(set("parent_project_id='project-a'")).toBe(ADVANCE);
      tick();
      expect(set(`parent_project_id='project-a',mapping_version=${now() + 5}`)).toBe(ADVANCE);
      expect(set("parent_project_id='project-a',mapping_version=0")).toBe(ADVANCE);
      expect(set("mapping_version=mapping_version-1")).toBe(ADVANCE);
      expect(set("mapping_version=NULL")).toBe(ADVANCE);
      expect(stampOf(database, "projects", id)).toMatchObject({ parent: null, incarnation: 1, version: 1 });
      // Permitted: a parent set with the clock's new value.
      setParent(database, "projects", id, "project-a");
      expect(stampOf(database, "projects", id)).toMatchObject({ parent: "project-a", incarnation: 1, version: now() });
      // Refused: the same version again with another parent, or with the parent cleared.
      expect(set("parent_project_id='project-b'")).toBe(ADVANCE);
      expect(set(`parent_project_id=NULL,mapping_version=${now()}`)).toBe(ADVANCE);
      // Permitted: an unrelated column with the version kept equal, and a re-stamp to the clock without a parent change.
      expect(() => database.exec(`UPDATE projects SET name='renamed' WHERE id='${id}'`)).not.toThrow();
      tick();
      expect(() => database.exec(`UPDATE projects SET mapping_version=(SELECT value FROM project_mapping_clock) WHERE id='${id}'`)).not.toThrow();
      // Refused: a parent change to the clock's value when the version already holds it.
      expect(set("parent_project_id=NULL")).toBe(ADVANCE);
      // An unstamped row (from before step 51) keeps version 0 unless its incarnation is stamped in the same statement.
      database.exec("DROP TRIGGER project_mapping_projects_unstamped_insert; DROP TRIGGER project_mapping_projects_stamp");
      database.exec(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES('legacy','l','/code/legacy',4998,'node','[]','/',45000,'x','x')`);
      for (const trigger of tableTriggers("projects").filter(trigger => /_(unstamped_insert|stamp)$/.test(trigger.name))) database.exec(trigger.sql);
      expect(stampOf(database, "projects", "legacy")).toMatchObject({ incarnation: 0, version: 0 });
      tick();
      expect(message(() => database.exec("UPDATE projects SET mapping_version=(SELECT value FROM project_mapping_clock) WHERE id='legacy'"))).toBe(ADVANCE);
      expect(message(() => database.exec("UPDATE projects SET parent_project_id='project-a',mapping_version=(SELECT value FROM project_mapping_clock) WHERE id='legacy'"))).toBe(ADVANCE);
      // Stamping the incarnation: only a value the clock issued, with a version no smaller than it.
      expect(message(() => database.exec(`UPDATE projects SET incarnation=${now() + 1},mapping_version=${now()} WHERE id='legacy'`))).toBe(IMMUTABLE);
      expect(message(() => database.exec("UPDATE projects SET incarnation=(SELECT value FROM project_mapping_clock) WHERE id='legacy'"))).toBe(IMMUTABLE);
      expect(() => database.exec("UPDATE projects SET incarnation=(SELECT value FROM project_mapping_clock),mapping_version=(SELECT value FROM project_mapping_clock),parent_project_id='project-b' WHERE id='legacy'")).not.toThrow();
      expect(stampOf(database, "projects", "legacy")).toMatchObject({ parent: "project-b", incarnation: now(), version: now() });
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it("keeps the clock advancing only and its one row in place", () => {
    const { database } = fixture();
    try {
      for (const statement of ["UPDATE project_mapping_clock SET value=value", "UPDATE project_mapping_clock SET value=value-1", "UPDATE project_mapping_clock SET value=NULL",
        "UPDATE project_mapping_clock SET singleton=2", "INSERT OR REPLACE INTO project_mapping_clock VALUES(1,0)", "REPLACE INTO project_mapping_clock VALUES(1,0)",
        "INSERT INTO project_mapping_clock VALUES(2,0)", "DELETE FROM project_mapping_clock"]) {
        expect(message(() => database.exec(statement)), statement).toMatch(/^project mapping clock (only advances|has one row)$/);
      }
      expect(database.prepare("SELECT singleton,value FROM project_mapping_clock").all()).toEqual([{ singleton: 1, value: 2 }]);
    } finally { database.close(); }
  });

  it.each(["OFF", "ON"])("keeps the journal append-only against every replacing form, recursive_triggers %s", recursive => {
    const { database } = fixture();
    try {
      database.pragma(`recursive_triggers=${recursive}`);
      journal(database); journal(database, { id: "registration-b" });
      const before = rows(database, "project_mapping_journal");
      const values = `(1,'registration','registration-a',1,'project-b','created_project','${PLAN}','${RECEIPT}','${AT}')`;
      for (const statement of ["UPDATE project_mapping_journal SET project_id='project-b'", "DELETE FROM project_mapping_journal",
        `INSERT OR REPLACE INTO project_mapping_journal VALUES${values}`, `REPLACE INTO project_mapping_journal VALUES${values}`,
        `INSERT OR IGNORE INTO project_mapping_journal VALUES${values}`, `INSERT INTO project_mapping_journal VALUES${values} ON CONFLICT DO NOTHING`,
        `INSERT INTO project_mapping_journal VALUES${values} ON CONFLICT(sequence) DO UPDATE SET project_id='project-b'`,
        "UPDATE OR REPLACE project_mapping_journal SET sequence=2 WHERE sequence=1"]) {
        expect(message(() => database.exec(statement)), statement).toBe(APPEND_ONLY);
      }
      expect(rows(database, "project_mapping_journal")).toEqual(before);
      // What remains possible, as documented: an explicit sequence above the last (a gap).
      expect(() => database.exec(`INSERT INTO project_mapping_journal VALUES(10,'registration','registration-c',1,'project-a','created_project','${PLAN}','${RECEIPT}','${AT}')`)).not.toThrow();
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it("refuses journal rows outside their typed, bounded and legal shapes", () => {
    const { database } = fixture();
    try {
      for (const [name, row] of [
        ["an unknown kind", { kind: "project" }], ["an unknown basis", { basis: "guess" }],
        ["a link for a remote identity", { kind: "remote_identity", basis: "accepted_link" }], ["a binding for a registration", { basis: "accepted_binding" }],
        ["incarnation 0", { incarnation: 0 }], ["a text incarnation", { incarnation: "one" }], ["a fractional incarnation", { incarnation: 1.5 }],
        ["an empty ID", { id: "" }], ["an ID with NUL", { id: "registration\0a" }], ["an ID of 161 characters", { id: "r".repeat(161) }], ["a BLOB project", { project: Buffer.from("project-a") }],
        ["an uppercase plan hash", { plan: PLAN.toUpperCase() }], ["a plan hash with NUL", { plan: `${PLAN}\0` }], ["an uppercase receipt", { receipt: "0000000A-0000-4000-8000-00000000000B" }],
        ["a receipt without dashes", { receipt: RECEIPT.replaceAll("-", "0").slice(0, 36) }], ["a time without milliseconds", { at: "2026-11-15T00:00:00Z" }],
        ["an impossible date", { at: "2026-02-30T00:00:00.000Z" }], ["a numeric time", { at: 2461000 }],
        ["hour 24", { at: "2026-11-15T24:30:00.000Z" }], ["hour 24 at midnight", { at: "2026-11-15T24:00:00.000Z" }],
        ["minute 60", { at: "2026-11-15T23:60:00.000Z" }], ["second 60", { at: "2026-11-15T23:59:60.000Z" }],
        ["29 February of a common year", { at: "2026-02-29T00:00:00.000Z" }], ["an offset", { at: "2026-11-15T00:00:00.000+00:00" }],
      ] as const) expect(() => journal(database, row as Parameters<typeof journal>[1]), name).toThrow(/CHECK constraint failed/);
      // Every legal combination is accepted.
      for (const [kind, basis] of [["registration", "created_project"], ["registration", "accepted_link"], ["registration", "journal_reuse"],
        ["remote_identity", "created_project"], ["remote_identity", "accepted_binding"], ["remote_identity", "journal_reuse"]]) {
        expect(() => journal(database, { kind, basis }), `${kind} ${basis}`).not.toThrow();
      }
      expect(() => journal(database, { id: "r".repeat(160) })).not.toThrow();
      // Every time the application writes (`toISOString`) is accepted, at the ends of the range too.
      for (const at of [new Date().toISOString(), "1970-01-01T00:00:00.000Z", "2024-02-29T23:59:59.999Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z",
        new Date(Date.UTC(2026, 10, 15, 23, 59, 59, 999)).toISOString()]) expect(() => journal(database, { at }), at).not.toThrow();
    } finally { database.close(); }
  });

  it.each(["", "OR IGNORE ", "OR REPLACE ", "OR FAIL ", "OR ABORT ", "OR ROLLBACK "])("refuses an insert at an exhausted clock with %sand never reuses a stamp", conflict => {
    const database = fresh51(observed());
    try {
      database.prepare("UPDATE project_mapping_clock SET value=? WHERE singleton=1").run(MAX - 1);
      const store = registrations(database);
      const last = registration(store);
      expect(stampOf(database, "projects", last.id)).toMatchObject({ incarnation: MAX, version: MAX });
      const before = { projects: stamps(database, "projects"), identities: stamps(database, "remote_project_identities") };
      const insert = `INSERT ${conflict}INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES('over','o','/code/over',4997,'node','[]','/',45000,'x','x')`;
      expect(message(() => database.exec(insert))).toBe(EXHAUSTED);
      expect(message(() => registration(store))).toBe(EXHAUSTED);
      expect(message(() => identity(database, "remote-over"))).toBe(EXHAUSTED);
      expect(message(() => database.exec(`INSERT ${conflict}INTO remote_project_identities(id,name,source_remote,status) VALUES('remote-over','o','origin','active')`))).toBe(EXHAUSTED);
      expect({ projects: stamps(database, "projects"), identities: stamps(database, "remote_project_identities") }).toEqual(before);
      expect(clock(database)).toBe(MAX);
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });
});

describe("step 51 guards on multi-row, replacing and stamping statements", () => {
  const ISSUED = "project mapping incarnation is already issued", UNISSUED = "project mapping journal records only issued incarnations";
  const ADVANCE = "project mapping version must advance with the clock", EXHAUSTED = "project mapping clock exhausted";
  const STAMP_FAILED = "project mapping stamp failed", APPEND_ONLY = "project mapping journal is append-only";
  const CLOCK = "(SELECT value FROM project_mapping_clock WHERE singleton=1)";
  const tick = (database: Database.Database) => { database.prepare(`UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1`).run(); };
  /** One INSERT ... SELECT of several rows, in the order of `ids`; registrations get ports from `port` up. */
  const many = (database: Database.Database, table: string, ids: string[], conflict = "", port = 7000) => table === "projects"
    ? database.prepare(`INSERT ${conflict}INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) SELECT value,'m','/code/'||value,?+key,'node','[]','/',45000,'x','x' FROM json_each(?) ORDER BY key`).run(port, JSON.stringify(ids))
    : database.prepare(`INSERT ${conflict}INTO remote_project_identities(id,name,source_remote,status) SELECT value,'m','origin','active' FROM json_each(?) ORDER BY key`).run(JSON.stringify(ids));
  const pairs = (database: Database.Database, table: string) => stamps(database, table).map(row => [row.id, row.incarnation, row.version]);
  /** Two unstamped rows in each mapped table, written before the step on the genuine schema, then migrated to 51. */
  const legacyRows = () => {
    const database = observed();
    fresh50(database);
    const store = registrations(database);
    const ids: Record<MappedTableName, string[]> = { projects: [registration(store, "legacy-a").id, registration(store, "legacy-b").id], remote_project_identities: ["remote-legacy-a", "remote-legacy-b"] };
    for (const id of ids.remote_project_identities) identity(database, id);
    to51(database);
    return { database, ids };
  };

  it.each(MAPPED_TABLES)("refuses giving one incarnation to two unstamped rows of %s, in one statement or one at a time, under every conflict clause", table => {
    const { database, ids } = legacyRows();
    const other = MAPPED_TABLES.find(name => name !== table)!;
    try {
      expect(pairs(database, table)).toEqual(ids[table].map(id => [id, 0, 0]));
      // The review's two statements: one advance, then one UPDATE that gives every unstamped row the clock's value.
      // Each row's BEFORE trigger sees the rows the statement already changed, so the second row fails it, and the statement fails whole.
      tick(database);
      for (const conflict of ["", "OR REPLACE ", "OR IGNORE ", "OR FAIL "]) {
        expect(message(() => database.exec(`UPDATE ${conflict}${table} SET incarnation=${CLOCK},mapping_version=${CLOCK} WHERE incarnation=0`)), conflict).toBe(ISSUED);
        expect(pairs(database, table), conflict).toEqual(ids[table].map(id => [id, 0, 0]));
      }
      expect(clock(database)).toBe(1);
      // Legitimate stamping, one row at a time with its own advance; the second row cannot take the first one's value,
      // and UPDATE OR REPLACE does not delete the row that holds it.
      const stampRow = (id: string, value = CLOCK, conflict = "") => database.prepare(`UPDATE ${conflict}${table} SET incarnation=${value},mapping_version=${CLOCK} WHERE id=?`).run(id);
      expect(stampRow(ids[table][0]).changes).toBe(1);
      for (const conflict of ["", "OR REPLACE "]) expect(message(() => stampRow(ids[table][1], "1", conflict)), conflict).toBe(ISSUED);
      tick(database);
      expect(message(() => stampRow(ids[table][1], "1", "OR REPLACE "))).toBe(ISSUED);
      expect(stampRow(ids[table][1]).changes).toBe(1);
      expect(pairs(database, table)).toEqual([[ids[table][0], 1, 1], [ids[table][1], 2, 2]]);
      // Uniqueness is per table: a row of the other table may hold an issued value a row of this one holds.
      database.prepare(`UPDATE ${other} SET incarnation=1,mapping_version=${CLOCK} WHERE id=?`).run(ids[other][0]);
      expect(stampOf(database, other, ids[other][0])).toMatchObject({ incarnation: 1, version: 2 });
      // A row created now still gets its own stamp through the same guard.
      many(database, table, ["new-row"]);
      expect(stampOf(database, table, "new-row")).toMatchObject({ incarnation: 3, version: 3 });
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it("still lets the quarantine give each remaining unstamped row an incarnation of its own", () => {
    const { database, ids } = legacyRows();
    try {
      tick(database);
      database.prepare(`UPDATE projects SET incarnation=${CLOCK},mapping_version=${CLOCK} WHERE id=?`).run(ids.projects[0]);
      quarantine(database);
      expect(clock(database)).toBe(4);
      expect(pairs(database, "projects")).toEqual([[ids.projects[0], 1, 4], [ids.projects[1], 2, 4]]);
      expect(pairs(database, "remote_project_identities")).toEqual([[ids.remote_project_identities[0], 3, 4], [ids.remote_project_identities[1], 4, 4]]);
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it("refuses a journal row whose incarnation the clock has not issued", () => {
    const database = fresh51(observed());
    try {
      expect(clock(database)).toBe(0);
      for (const conflict of ["", "OR IGNORE ", "OR REPLACE "]) {
        expect(message(() => database.prepare(JOURNAL.replace("INSERT ", `INSERT ${conflict}`)).run("registration", "registration-a", 1, "project-a", "created_project", PLAN, RECEIPT, AT)), conflict).toBe(UNISSUED);
      }
      registration(registrations(database));
      expect(clock(database)).toBe(1);
      expect(() => journal(database, { incarnation: 1 })).not.toThrow();
      for (const incarnation of [2, MAX]) expect(message(() => journal(database, { incarnation })), String(incarnation)).toBe(UNISSUED);
      // A non-integer is left to the CHECK.
      expect(() => journal(database, { incarnation: "one" })).toThrow(/CHECK constraint failed/);
      // Without the clock row (removed past its own guard) no incarnation is issued.
      database.exec("DROP TRIGGER project_mapping_clock_delete; DELETE FROM project_mapping_clock");
      expect(message(() => journal(database, { incarnation: 1 }))).toBe(UNISSUED);
      expect(rows(database, "project_mapping_journal")).toHaveLength(1);
    } finally { database.close(); }
  });

  it.each(["OFF", "ON"])("keeps journal sequence order equal to append order, recursive_triggers %s", recursive => {
    const database = fresh51(observed());
    try {
      database.pragma(`recursive_triggers=${recursive}`);
      registration(registrations(database));
      const insert = (sequence: number | null | undefined) => sequence === undefined
        ? journal(database)
        : database.prepare(`INSERT INTO project_mapping_journal(sequence,subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES(?,'registration','registration-a',1,'project-a','created_project','${PLAN}','${RECEIPT}','${AT}')`).run(sequence);
      expect(insert(undefined).lastInsertRowid).toBe(1);
      // An explicit sequence above the last leaves a gap; one at or below it (an earlier gap, an existing one, 0) is refused.
      expect(insert(10).lastInsertRowid).toBe(10);
      for (const sequence of [5, 2, 10, 1, 0]) expect(message(() => insert(sequence)), String(sequence)).toBe(APPEND_ONLY);
      expect(message(() => insert(-1))).toMatch(/CHECK constraint failed: sequence>0/);
      // An omitted or NULL sequence is AUTOINCREMENT's, above the gap.
      expect(insert(null).lastInsertRowid).toBe(11);
      expect(insert(undefined).lastInsertRowid).toBe(12);
      // sqlite_sequence is not protected: lowering it changes nothing, raising it leaves a gap, and order still holds.
      database.exec("UPDATE sqlite_sequence SET seq=1 WHERE name='project_mapping_journal'");
      expect(insert(undefined).lastInsertRowid).toBe(13);
      database.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='project_mapping_journal'");
      expect(insert(undefined).lastInsertRowid).toBe(101);
      expect(message(() => insert(50))).toBe(APPEND_ONLY);
      expect(database.prepare("SELECT sequence FROM project_mapping_journal ORDER BY rowid").pluck().all()).toEqual([1, 10, 11, 12, 13, 101]);
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it.each(MAPPED_TABLES)("stamps each row of a multi-row INSERT ... SELECT on %s with its own successive clock value", table => {
    const database = fresh51(observed());
    try {
      registration(registrations(database));
      const result = many(database, table, ["m-1", "m-2", "m-3"]);
      expect(result.changes).toBe(3);
      expect(clock(database)).toBe(4);
      expect(pairs(database, table).filter(([id]) => String(id).startsWith("m-"))).toEqual([["m-1", 2, 2], ["m-2", 3, 3], ["m-3", 4, 4]]);
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it.each(["OFF", "ON"])("gives a replaced row a fresh, larger incarnation on the primary key and each unique column, recursive_triggers %s", recursive => {
    const database = fresh51(observed());
    try {
      database.pragma(`recursive_triggers=${recursive}`);
      many(database, "projects", ["p-1", "p-2", "p-3"]);
      many(database, "remote_project_identities", ["r-1"]);
      const replace = (form: string, id: string, path: string, port: number) => database.prepare(`${form} INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
        VALUES(?,'r',?,?,'node','[]','/',45000,'x','x')`).run(id, path, port);
      const issued: number[] = [1, 2, 3, 4];
      const step = (run: () => { changes: number }, projects: Array<[string, number, number]>) => {
        expect(run().changes).toBe(1);
        expect(pairs(database, "projects")).toEqual(projects);
        const fresh = clock(database);
        expect(fresh).toBe(issued.length + 1);
        issued.push(fresh);
      };
      // The primary key: p-1 again.
      step(() => replace("INSERT OR REPLACE", "p-1", "/code/new-1", 7101), [["p-2", 2, 2], ["p-3", 3, 3], ["p-1", 5, 5]]);
      // repository_path: q-2 takes p-2's path.
      step(() => replace("REPLACE", "q-2", "/code/p-2", 7102), [["p-3", 3, 3], ["p-1", 5, 5], ["q-2", 6, 6]]);
      // port: q-3 takes p-3's port.
      step(() => replace("INSERT OR REPLACE", "q-3", "/code/q-3", 7002), [["p-1", 5, 5], ["q-2", 6, 6], ["q-3", 7, 7]]);
      // Two rows at once: q-2's path and p-1's port.
      step(() => replace("INSERT OR REPLACE", "q-4", "/code/q-2", 7101), [["q-3", 7, 7], ["q-4", 8, 8]]);
      // The remote identity's primary key.
      expect(database.prepare("INSERT OR REPLACE INTO remote_project_identities(id,name,source_remote,status) VALUES('r-1','again','origin','active')").run().changes).toBe(1);
      expect(pairs(database, "remote_project_identities")).toEqual([["r-1", 9, 9]]);
      expect(clock(database)).toBe(9);
      // No stamp was reused or lost: every advance was used once.
      expect(new Set(issued).size).toBe(issued.length);
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });

  it.each(MAPPED_TABLES.flatMap(table => ["", "OR IGNORE ", "OR REPLACE "].map(conflict => [table, conflict] as const)))("rolls back a whole multi-row INSERT on %s %swhen the clock is exhausted on a later row", (table, conflict) => {
    const database = fresh51(observed());
    try {
      database.prepare("UPDATE project_mapping_clock SET value=? WHERE singleton=1").run(MAX - 2);
      expect(message(() => many(database, table, ["x-1", "x-2", "x-3"], conflict))).toBe(EXHAUSTED);
      // The first two rows and their two advances are gone with the statement.
      expect(rows(database, table)).toEqual([]);
      expect(clock(database)).toBe(MAX - 2);
      expect(many(database, table, ["x-1", "x-2"], conflict).changes).toBe(2);
      expect(pairs(database, table)).toEqual([["x-1", MAX - 1, MAX - 1], ["x-2", MAX, MAX]]);
    } finally { database.close(); }
  });

  it.each(MAPPED_TABLES)("rolls back the earlier rows of a multi-row mapping UPDATE on %s when a later row fails a guard", table => {
    const database = fresh51(observed());
    try {
      knowledgeProject(database, "project-a");
      many(database, table, ["u-1", "u-2", "u-3"]);
      tick(database);
      const before = stamps(database, table);
      // SQLite visits a full-table UPDATE in rowid order: u-1 and u-2 pass, then u-3 brings a version that is not the clock's.
      expect(message(() => database.exec(`UPDATE ${table} SET parent_project_id='project-a',mapping_version=CASE id WHEN 'u-3' THEN 99 ELSE ${CLOCK} END`))).toBe(ADVANCE);
      expect(stamps(database, table)).toEqual(before);
      // Likewise an incarnation guard on the last row, and the clock's own value given twice.
      database.exec("DROP TRIGGER project_mapping_" + table + "_unstamped_insert; DROP TRIGGER project_mapping_" + table + "_stamp");
      many(database, table, ["v-1", "v-2"], "", 7100);
      for (const trigger of tableTriggers(table).filter(trigger => /_(unstamped_insert|stamp)$/.test(trigger.name))) database.exec(trigger.sql);
      tick(database);
      const unstamped = stamps(database, table);
      expect(message(() => database.exec(`UPDATE ${table} SET incarnation=CASE id WHEN 'v-2' THEN 999 ELSE ${CLOCK} END,mapping_version=${CLOCK} WHERE incarnation=0`))).toBe("project mapping incarnation is immutable");
      expect(stamps(database, table)).toEqual(unstamped);
      // The same statement passes when every row passes.
      database.exec(`UPDATE ${table} SET parent_project_id='project-a',mapping_version=${CLOCK} WHERE incarnation<>0`);
      expect(stamps(database, table).filter(row => row.incarnation !== 0).map(row => [row.parent, row.version])).toEqual([["project-a", 5], ["project-a", 5], ["project-a", 5]]);
    } finally { database.close(); }
  });

  // The stamp trigger's postcondition cannot fail through the file's own schema: the stamp's UPDATE can break no
  // constraint a conflict clause could skip (the clock is below its maximum, the CHECK bounds hold, no unique key
  // covers the stamps), and recognition refuses any other trigger in the file. A connection's TEMP trigger is not
  // in the file and recognition does not see it; it can skip the stamp or remove the row, and then the INSERT fails.
  it.each(MAPPED_TABLES)("refuses with 'stamp failed' on %s when a connection's TEMP trigger skips or undoes the stamp", table => {
    for (const temporaryTrigger of [`CREATE TEMP TRIGGER skip_stamp BEFORE UPDATE ON main.${table} BEGIN SELECT RAISE(IGNORE); END`,
      `CREATE TEMP TRIGGER undo_insert AFTER INSERT ON main.${table} BEGIN DELETE FROM main.${table} WHERE rowid=NEW.rowid; END`]) {
      const database = fresh51(observed());
      try {
        database.exec(temporaryTrigger);
        expect(inspectSchema(database, TARGET)).toEqual({ version: 51, fresh: false });
        for (const conflict of ["", "OR IGNORE ", "OR REPLACE "]) expect(message(() => many(database, table, ["t-1"], conflict)), `${temporaryTrigger} ${conflict}`).toBe(STAMP_FAILED);
        expect(rows(database, table)).toEqual([]);
        expect(clock(database)).toBe(0);
      } finally { database.close(); }
    }
  });
});

describe("step 51 recognition at ceiling 51", () => {
  const recognised = (mutate: (database: Database.Database) => void, build = () => fresh51(observed())) => {
    const database = build();
    try {
      expect(() => inspectSchema(database, TARGET)).not.toThrow();
      mutate(database);
      return message(() => inspectSchema(database, TARGET));
    } finally { database.close(); }
  };
  const triggerOf = (name: string) => [...projectMappingFenceTriggers, ...projectMappingTriggers].find(trigger => trigger.name === name)!;
  const replaceTrigger = (database: Database.Database, name: string, sql: string) => database.exec(`DROP TRIGGER ${name}; ${sql}`);
  const rebuildOwnTable = (table: "project_mapping_clock" | "project_mapping_journal", from: string, to: string) => (database: Database.Database) => {
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(table) as string;
    expect(sql).toContain(from);
    const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").pluck().all(table) as string[];
    const rows = database.prepare(`SELECT * FROM ${table}`).raw().all() as unknown[][];
    database.exec(`DROP TABLE ${table}; ${sql.replace(from, to)}`);
    for (const row of rows) database.prepare(`INSERT INTO ${table} VALUES(${row.map(() => "?").join(",")})`).run(...row);
    for (const index of indexes) database.exec(index);
    for (const trigger of [...projectMappingFenceTriggers, ...projectMappingTriggers].filter(trigger => trigger.sql.includes(` ON ${table} `))) database.exec(trigger.sql);
  };

  it.each(MAPPED_TABLES)("refuses one altered property of each added column of %s", table => {
    const cases: Array<[string, readonly string[]]> = [
      ["parent without its foreign key", alteredColumns(0, " REFERENCES knowledge_projects(id)", "")],
      ["parent referencing another table", alteredColumns(0, "knowledge_projects(id)", "projects(id)")],
      ["parent with another type", alteredColumns(0, "parent_project_id TEXT", "parent_project_id BLOB")],
      ["parent not nullable", alteredColumns(0, "TEXT REFERENCES", "TEXT NOT NULL DEFAULT '' REFERENCES")],
      ["parent with a default", alteredColumns(0, "TEXT REFERENCES", "TEXT DEFAULT NULL REFERENCES")],
      ["incarnation with another type", alteredColumns(1, "incarnation INTEGER", "incarnation NUMERIC")],
      ["incarnation nullable", alteredColumns(1, "INTEGER NOT NULL DEFAULT 0", "INTEGER DEFAULT 0")],
      ["incarnation with another default", alteredColumns(1, "DEFAULT 0", "DEFAULT 1")],
      ["incarnation with another CHECK literal", alteredColumns(1, "9007199254740991", "9007199254740990")],
      ["incarnation without its CHECK", alteredColumns(1, ` CHECK(incarnation BETWEEN 0 AND ${MAX} AND typeof(incarnation)='integer')`, "")],
      ["mapping version with another type", alteredColumns(2, "mapping_version INTEGER", "mapping_version TEXT")],
      ["mapping version with another default", alteredColumns(2, "DEFAULT 0", "DEFAULT '0'")],
      ["the columns in another order", [PROJECT_MAPPING_COLUMN_DEFINITIONS[0], PROJECT_MAPPING_COLUMN_DEFINITIONS[2], PROJECT_MAPPING_COLUMN_DEFINITIONS[1]]],
      ["a missing column", PROJECT_MAPPING_COLUMN_DEFINITIONS.slice(0, 2)],
      ["an extra column", [...PROJECT_MAPPING_COLUMN_DEFINITIONS, "mapping_note TEXT"]],
    ];
    for (const [name, definitions] of cases) expect(recognised(database => replaceColumns(database, table, definitions)), name).toMatch(SCHEMA_REFUSAL);
    // Replacing them with the identical definitions is the genuine table.
    const database = fresh51(observed());
    try { replaceColumns(database, table, PROJECT_MAPPING_COLUMN_DEFINITIONS); expect(inspectSchema(database, TARGET)).toEqual({ version: 51, fresh: false }); } finally { database.close(); }
  });

  it("recognises the added columns by their exact text, beyond what table_info reports", () => {
    // SQLite reports `DEFAULT (0)` as the default '0', like `DEFAULT 0`: type, nullability, key,
    // default and CHECK all compare equal by PRAGMA, and only the exact column text tells them apart.
    const database = fresh51(observed());
    try {
      const reference = database.prepare("PRAGMA table_info(projects)").all();
      replaceColumns(database, "projects", alteredColumns(1, "DEFAULT 0", "DEFAULT (0)"));
      expect(database.prepare("PRAGMA table_info(projects)").all()).toEqual(reference);
      expect(message(() => inspectSchema(database, TARGET))).toBe("Unsupported or unrecognized database schema (columns of projects). Use a compatible release or inspect an isolated copy; the source was not migrated.");
    } finally { database.close(); }
  });

  it.each([
    ["a missing stamping trigger", (db: Database.Database) => db.exec("DROP TRIGGER project_mapping_projects_stamp")],
    ["a missing fence trigger of the clock", (db: Database.Database) => db.exec("DROP TRIGGER security_project_mapping_clock_update")],
    ["a missing append-only trigger", (db: Database.Database) => db.exec("DROP TRIGGER project_mapping_journal_delete")],
    ["an altered stamping trigger", (db: Database.Database) => replaceTrigger(db, "project_mapping_remote_project_identities_stamp",
      triggerOf("project_mapping_remote_project_identities_stamp").sql.replace(`<${MAX}`, `<${MAX - 1}`))],
    ["an altered immutability trigger", (db: Database.Database) => replaceTrigger(db, "project_mapping_projects_incarnation",
      triggerOf("project_mapping_projects_incarnation").sql.replace("NEW.incarnation>0", "NEW.incarnation>=0"))],
    ["an altered version trigger", (db: Database.Database) => replaceTrigger(db, "project_mapping_projects_version",
      triggerOf("project_mapping_projects_version").sql.replace("'project mapping version must advance with the clock'", "'project mapping version must advance'"))],
    ["an altered append-only trigger", (db: Database.Database) => replaceTrigger(db, "project_mapping_journal_update",
      "CREATE TRIGGER project_mapping_journal_update BEFORE UPDATE ON project_mapping_journal BEGIN SELECT 1; END")],
    ["an altered fence trigger of the journal", (db: Database.Database) => replaceTrigger(db, "security_project_mapping_journal_insert",
      triggerOf("security_project_mapping_journal_insert").sql.replace("SELECT worktree_security_pending()", "select worktree_security_pending()"))],
    ["a recased clock trigger", (db: Database.Database) => replaceTrigger(db, "project_mapping_clock_advance",
      triggerOf("project_mapping_clock_advance").sql.replace("BEFORE UPDATE", "before update"))],
    ["an extra trigger on a mapped table", (db: Database.Database) => db.exec("CREATE TRIGGER project_mapping_projects_extra AFTER UPDATE ON projects BEGIN SELECT 1; END")],
    ["an extra trigger on the journal", (db: Database.Database) => db.exec("CREATE TRIGGER extra_journal AFTER INSERT ON project_mapping_journal BEGIN SELECT 1; END")],
    ["the clock with a changed CHECK literal", rebuildOwnTable("project_mapping_clock", "BETWEEN 0 AND 9007199254740991", "BETWEEN 0 AND 9007199254740990")],
    ["the clock reformatted", rebuildOwnTable("project_mapping_clock", "\n  value", " value")],
    ["the journal with a changed CHECK literal", rebuildOwnTable("project_mapping_journal", "'created_project','accepted_link'", "'created_project','accepted_links'")],
    ["the journal with a widened basis combination", rebuildOwnTable("project_mapping_journal", "(basis='accepted_link' AND subject_kind='registration')", "basis='accepted_link'")],
    ["the journal without its sequence CHECK", rebuildOwnTable("project_mapping_journal", " CHECK(sequence>0)", "")],
    ["a missing journal index", (db: Database.Database) => db.exec("DROP INDEX project_mapping_journal_project")],
    ["an altered journal index", (db: Database.Database) => db.exec("DROP INDEX project_mapping_journal_subject; CREATE INDEX project_mapping_journal_subject ON project_mapping_journal(subject_kind,subject_id)")],
    ["a recased journal index", (db: Database.Database) => db.exec("DROP INDEX project_mapping_journal_subject; CREATE INDEX project_mapping_journal_subject ON project_mapping_journal(SUBJECT_KIND,subject_id,sequence)")],
    ["an extra journal index", (db: Database.Database) => db.exec("CREATE INDEX project_mapping_journal_extra ON project_mapping_journal(recorded_at)")],
    ["a wrong checksum", (db: Database.Database) => db.exec(`UPDATE schema_migrations SET checksum='${"0".repeat(64)}' WHERE version=51`)],
    ["a wrong name", (db: Database.Database) => db.exec("UPDATE schema_migrations SET name='other-step' WHERE version=51")],
    ["a missing clock table", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock")],
    ["a missing journal table", (db: Database.Database) => db.exec("DROP TABLE project_mapping_journal")],
    ["step-51 objects before their migration", (db: Database.Database) => db.exec("DELETE FROM schema_migrations WHERE version=51")],
  ])("refuses a step-51 database with %s", (_name, mutate) => {
    expect(recognised(mutate)).toMatch(SCHEMA_REFUSAL);
  });

  it("refuses the added columns before step 51, at every ceiling", () => {
    const withColumns = (database: Database.Database) => { for (const table of MAPPED_TABLES) for (const column of PROJECT_MAPPING_COLUMN_DEFINITIONS) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); };
    for (const build of [() => fresh50(observed()), () => fresh49(observed())]) {
      const database = build();
      try {
        const version = inspectSchema(database, TARGET).version;
        withColumns(database);
        for (const ceiling of version === 50 ? [50, 51] : [49, 50, 51]) expect(message(() => inspectSchema(database, ceiling)), `${version} at ${ceiling}`).toMatch(SCHEMA_REFUSAL);
        expect(message(() => inspectSchema(database, TARGET))).toMatch(/precedes its migration/);
      } finally { database.close(); }
    }
    // One column alone is refused as well.
    const single = fresh50(observed());
    try { single.exec(`ALTER TABLE remote_project_identities ADD COLUMN ${PROJECT_MAPPING_COLUMN_DEFINITIONS[0]}`); expect(message(() => inspectSchema(single, TARGET))).toMatch(SCHEMA_REFUSAL); } finally { single.close(); }
  });

  it("recognises a schema-49 and a step-50 database at ceiling 51 unchanged", () => {
    for (const [database, version] of [[fresh49(), 49], [fresh50(), 50]] as const) {
      try {
        expect(inspectSchema(database, TARGET)).toEqual({ version, fresh: false });
        expect(() => validateDatabase(database, version)).not.toThrow();
      } finally { database.close(); }
    }
  });
});

describe("step 51 validation", () => {
  /** A step-51 database with stamped registrations and identities, one of them parented, and a journal row. */
  const populated = () => {
    const database = fresh51(observed());
    knowledgeProject(database, "project-a");
    const store = registrations(database);
    const first = registration(store), second = registration(store);
    identity(database, "remote-a"); identity(database, "remote-b");
    setParent(database, "projects", first.id, "project-a");
    journal(database, { id: first.id, incarnation: 1 });
    expect(() => validateDatabase(database, 51)).not.toThrow();
    return { database, first: first.id, second: second.id };
  };
  const failing = (rule: string) => `SQLite application invariant failed (${rule}); startup stopped.`;

  it.each([
    ["no clock row", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value)")],
    ["two clock rows", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(1,9),(1,9)")],
    ["another singleton", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(2,9)")],
    ["a text clock", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(1,'9')")],
    ["a fractional clock", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(1,9.5)")],
    ["a negative clock", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(1,-1)")],
    ["an unsafe clock", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(1,9007199254740992)")],
  ])("refuses %s", (_name, mutate) => {
    const { database } = populated();
    try { mutate(database); expect(() => validateDatabase(database, 51)).toThrow(failing("project mapping clock")); expect(() => validateDatabase(database, 50)).not.toThrow(); } finally { database.close(); }
  });

  it.each(MAPPED_TABLES)("refuses malformed stamps, shared incarnations and a parent without a project on %s", table => {
    const cases: Array<[string, string, string]> = [
      ["a text incarnation", "project mapping stamps", "UPDATE {t} SET incarnation='1' WHERE rowid=1"],
      ["a fractional version", "project mapping stamps", "UPDATE {t} SET mapping_version=3.5 WHERE rowid=1"],
      ["a negative incarnation", "project mapping stamps", "UPDATE {t} SET incarnation=-1,mapping_version=-1 WHERE rowid=1"],
      ["an incarnation above the clock", "project mapping stamps", "UPDATE {t} SET incarnation=1000,mapping_version=1000 WHERE rowid=1"],
      ["a version above the clock", "project mapping stamps", "UPDATE {t} SET mapping_version=1000 WHERE rowid=1"],
      ["a version below the incarnation", "project mapping stamps", "UPDATE {t} SET mapping_version=incarnation-1 WHERE rowid=2"],
      ["a stamped incarnation with version 0", "project mapping stamps", "UPDATE {t} SET mapping_version=0 WHERE rowid=1"],
      ["an unstamped incarnation with a version", "project mapping stamps", "UPDATE {t} SET incarnation=0 WHERE rowid=2"],
      ["a parent on an unstamped row", "project mapping stamps", "UPDATE {t} SET parent_project_id='project-a',incarnation=0,mapping_version=0 WHERE rowid=2"],
      ["a shared incarnation", "project mapping incarnation", "UPDATE {t} SET incarnation=(SELECT incarnation FROM {t} WHERE rowid=1),mapping_version=(SELECT value FROM project_mapping_clock) WHERE rowid=2"],
    ];
    for (const [name, rule, statement] of cases) {
      const { database } = populated();
      try {
        loosen(database, table);
        database.exec(statement.replaceAll("{t}", table));
        expect(() => validateDatabase(database, 51), name).toThrow(failing(rule));
        expect(() => validateDatabase(database, 50), name).not.toThrow();
      } finally { database.close(); }
    }
    // A parent without its project. On the genuine table the foreign-key check refuses it first,
    // and the mapping's own rule names it too.
    {
      const { database, second } = populated();
      try {
        database.pragma("foreign_keys=OFF");
        setParent(database, table, table === "projects" ? second : "remote-b", "project-missing");
        expect(() => validateDatabase(database, 51)).toThrow("SQLite foreign key check failed; startup stopped.");
        expect(projectMappingViolation(database)).toBe("project mapping parent");
      } finally { database.close(); }
    }
    // Without the foreign key (a loosened table), the mapping's own rule refuses it, and a parent that is not text.
    for (const parent of ["'project-missing'", "CAST('project-a' AS BLOB)"]) {
      const { database } = populated();
      try {
        loosen(database, table);
        database.exec(`UPDATE ${table} SET parent_project_id=${parent} WHERE rowid=2`);
        expect(() => validateDatabase(database, 51), parent).toThrow(failing("project mapping parent"));
      } finally { database.close(); }
    }
  });

  it("refuses malformed journal rows", () => {
    const valid = `'registration','registration-a',1,'project-a','created_project','${PLAN}','${RECEIPT}','${AT}'`;
    const cases: Array<[string, string]> = [
      ["an unknown kind", valid.replace("'registration'", "'project'")], ["an unknown basis", valid.replace("'created_project'", "'guess'")],
      ["a link for a remote identity", valid.replace("'registration'", "'remote_identity'").replace("'created_project'", "'accepted_link'")],
      ["a binding for a registration", valid.replace("'created_project'", "'accepted_binding'")],
      ["incarnation 0", valid.replace(",1,", ",0,")], ["an incarnation above the clock", valid.replace(",1,", ",1000,")], ["a text incarnation", valid.replace(",1,", ",'1',")],
      ["an empty subject", valid.replace("'registration-a'", "''")], ["a subject with NUL", valid.replace("'registration-a'", "'registration'||char(0)||'a'")],
      ["a long project ID", valid.replace("'project-a'", `'${"p".repeat(161)}'`)], ["a BLOB project ID", valid.replace("'project-a'", "CAST('project-a' AS BLOB)")],
      ["an uppercase plan hash", valid.replace(PLAN, PLAN.toUpperCase())], ["a short plan hash", valid.replace(PLAN, PLAN.slice(1))],
      ["a plan hash stored as a BLOB", valid.replace(`'${PLAN}'`, `CAST('${PLAN}' AS BLOB)`)], ["a malformed receipt", valid.replace(RECEIPT, "not-a-uuid")],
      ["an uppercase receipt", valid.replace(RECEIPT, RECEIPT.replace("4000", "4ABC"))], ["a time without milliseconds", valid.replace(AT, "2026-11-15T00:00:00Z")],
      ["an impossible date", valid.replace(AT, "2026-02-30T00:00:00.000Z")], ["a numeric time", valid.replace(`'${AT}'`, "2461000")],
      ["hour 24", valid.replace(AT, "2026-11-15T24:30:00.000Z")], ["minute 60", valid.replace(AT, "2026-11-15T23:60:00.000Z")],
      ["second 60", valid.replace(AT, "2026-11-15T23:59:60.000Z")],
    ];
    for (const [name, values] of cases) {
      const { database } = populated();
      try {
        database.exec(`DROP TABLE project_mapping_journal; ${LOOSE_JOURNAL}; INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES(${values})`);
        expect(() => validateDatabase(database, 51), name).toThrow(failing("project mapping journal"));
        expect(() => validateDatabase(database, 50), name).not.toThrow();
      } finally { database.close(); }
    }
    // A sequence beyond sqlite_sequence.
    const { database } = populated();
    try {
      database.exec(`DROP TABLE project_mapping_journal; ${LOOSE_JOURNAL}; INSERT INTO project_mapping_journal VALUES(5,${valid}); UPDATE sqlite_sequence SET seq=2 WHERE name='project_mapping_journal'`);
      expect(() => validateDatabase(database, 51)).toThrow(failing("project mapping journal"));
      database.exec("UPDATE sqlite_sequence SET seq=5 WHERE name='project_mapping_journal'");
      expect(() => validateDatabase(database, 51)).not.toThrow();
    } finally { database.close(); }
  });
});

describe("step 51 in the quarantine of auth fence resume", () => {
  /** Unstamped rows from before the step, stamped rows after it, parents on some, journal rows. */
  const quarantineFixture = () => {
    const database = observed();
    fresh50(database);
    const store = registrations(database);
    const legacy = [registration(store, "legacy-a").id, registration(store, "legacy-b").id];
    identity(database, "remote-legacy");
    to51(database);
    knowledgeProject(database, "project-a"); knowledgeProject(database, "project-b", "archived");
    const current = [registration(store, "current-a").id, registration(store, "current-b").id];
    identity(database, "remote-current");
    setParent(database, "projects", current[0], "project-a");
    setParent(database, "remote_project_identities", "remote-current", "project-b");
    journal(database, { id: current[0], incarnation: 1 }); journal(database, { kind: "remote_identity", id: "remote-current", incarnation: 3, basis: "accepted_binding", project: "project-b" });
    expect(() => validateDatabase(database, 51)).not.toThrow();
    return { database, legacy, current };
  };

  it("clears every parent, stamps every row from the clock, and keeps projects, the journal and issued incarnations", () => {
    const { database, legacy } = quarantineFixture();
    try {
      const before = mapped(database), projects = rows(database, "knowledge_projects"), entries = rows(database, "project_mapping_journal"), base = clock(database);
      expect(base).toBe(5);
      quarantine(database);
      const after = mapped(database), final = clock(database);
      // The clock advances once per unstamped row (here three), so each gets its own incarnation.
      expect(final).toBe(base + 3);
      for (const table of MAPPED_TABLES) {
        for (const [index, row] of after[table].entries()) {
          const old = before[table][index];
          expect(row).toMatchObject({ id: old.id, parent: null, version: final });
          if (old.incarnation !== 0) expect(row.incarnation).toBe(old.incarnation);
          else expect(row.incarnation).toBeGreaterThan(base);
        }
      }
      expect(after.projects.filter(row => legacy.includes(row.id)).map(row => row.incarnation)).toEqual([base + 1, base + 2]);
      expect(stampOf(database, "remote_project_identities", "remote-legacy").incarnation).toBe(base + 3);
      expect(rows(database, "knowledge_projects")).toEqual(projects);
      expect(rows(database, "project_mapping_journal")).toEqual(entries);
      expect(() => validateDatabase(database, 51)).not.toThrow();
      // A second resume ticks once more (nothing is unstamped any more) and is otherwise the same.
      quarantine(database, "00000000-0000-4000-8000-000000000001");
      expect(clock(database)).toBe(final + 1);
      const again = mapped(database);
      for (const table of MAPPED_TABLES) expect(again[table]).toEqual(after[table].map(row => ({ ...row, version: final + 1 })));
      expect(rows(database, "knowledge_projects")).toEqual(projects);
      expect(rows(database, "project_mapping_journal")).toEqual(entries);
    } finally { database.close(); }
  });

  it("ticks exactly once when every row is stamped", () => {
    const database = fresh51(observed());
    try {
      knowledgeProject(database, "project-a");
      const store = registrations(database), first = registration(store);
      registration(store); identity(database, "remote-a");
      setParent(database, "projects", first.id, "project-a");
      const before = mapped(database), base = clock(database);
      quarantine(database);
      expect(clock(database)).toBe(base + 1);
      for (const table of MAPPED_TABLES) expect(mapped(database)[table]).toEqual(before[table].map(row => ({ ...row, parent: null, version: base + 1 })));
    } finally { database.close(); }
  });

  it("rolls the mapping statements back with the rest of the quarantine and the schema steps", () => {
    const database = observed();
    try {
      fresh50(database);
      const store = registrations(database);
      registration(store); identity(database, "remote-a");
      const before = { catalogue: catalogue(database), mapped: rows(database, "projects"), identities: rows(database, "remote_project_identities") };
      // From step 50, the step and the quarantine roll back together.
      expect(() => quarantine(database, RECEIPT, () => { throw new Error("fixture quarantine fault"); })).toThrow("fixture quarantine fault");
      expect({ catalogue: catalogue(database), mapped: rows(database, "projects"), identities: rows(database, "remote_project_identities") }).toEqual(before);
      expect(inspectSchema(database, TARGET).version).toBe(50);
      // At step 51 the clock and every stamp roll back too.
      to51(database);
      quarantine(database);
      const stamped = { mapped: mapped(database), clock: clock(database) };
      expect(() => quarantine(database, RECEIPT, current => { expect(clock(current)).toBe(stamped.clock + 1); throw new Error("fixture quarantine fault"); })).toThrow("fixture quarantine fault");
      expect({ mapped: mapped(database), clock: clock(database) }).toEqual(stamped);
    } finally { database.close(); }
  });

  it.each([
    ["an exhausted clock", (db: Database.Database) => db.prepare("UPDATE project_mapping_clock SET value=?").run(MAX)],
    ["too many unstamped rows for the clock", (db: Database.Database) => {
      db.exec("DROP TRIGGER project_mapping_projects_unstamped_insert; DROP TRIGGER project_mapping_projects_stamp");
      db.exec("INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES('legacy-1','l','/code/l1',4991,'node','[]','/',45000,'x','x'),('legacy-2','l','/code/l2',4992,'node','[]','/',45000,'x','x')");
      for (const trigger of tableTriggers("projects").filter(trigger => /_(unstamped_insert|stamp)$/.test(trigger.name))) db.exec(trigger.sql);
      db.prepare("UPDATE project_mapping_clock SET value=?").run(MAX - 1);
    }],
    ["a stamp beyond the clock", (db: Database.Database) => { db.exec("DROP TRIGGER project_mapping_projects_version"); db.exec("UPDATE projects SET mapping_version=1000 WHERE rowid=1"); }],
    ["a malformed clock", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value); INSERT INTO project_mapping_clock VALUES(1,'x')")],
    ["a missing clock row", (db: Database.Database) => db.exec("DROP TABLE project_mapping_clock; CREATE TABLE project_mapping_clock(singleton, value)")],
  ])("refuses with security_fence_recovery_required and changes nothing at %s", (_name, mutate) => {
    const database = fresh51(observed());
    try {
      knowledgeProject(database, "project-a");
      const first = registration(registrations(database));
      setParent(database, "projects", first.id, "project-a");
      mutate(database);
      const before = { catalogue: catalogue(database), projects: rows(database, "projects"), clock: rows(database, "project_mapping_clock"), settings: rows(database, "controller_settings") };
      expect(() => quarantine(database)).toThrowError(expect.objectContaining({ name: "SecurityFenceError", code: "security_fence_recovery_required" }));
      expect({ catalogue: catalogue(database), projects: rows(database, "projects"), clock: rows(database, "project_mapping_clock"), settings: rows(database, "controller_settings") }).toEqual(before);
    } finally { database.close(); }
  });

  it("keeps the quarantine's statements at the default target and at 50 free of step 51", () => {
    for (const [build, target] of [[() => fresh49(observed()), undefined], [() => fresh50(observed()), 50]] as const) {
      const database = build(), statements: string[] = [];
      try {
        const prepare = database.prepare.bind(database), exec = database.exec.bind(database);
        Object.assign(database, {
          prepare: (source: string) => { statements.push(source); return prepare(source); },
          exec: (source: string) => { statements.push(source); return exec(source); },
        });
        initializeSchema(database, false, undefined, { target, acts: current => quarantineAuthority(current, RECEIPT, "token", target) });
        expect(statements.some(statement => statement.includes("UPDATE controller_settings"))).toBe(true);
        expect(statements.filter(statement => /project_mapping|parent_project_id|incarnation|mapping_version/.test(statement))).toEqual([]);
      } finally { database.close(); }
    }
  });

  it("migrates schema 49 to 51 and quarantines in one auth fence resume, and resumes again", () => {
    const paths = installation();
    touch(paths);
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 51 });
    const first = read(paths, database => {
      expect(inspectSchema(database, TARGET).version).toBe(51);
      expect(() => validateDatabase(database, 51)).not.toThrow();
      expect(database.prepare("SELECT state FROM upgrade_marker").pluck().get()).toBe("pending");
      // Two registrations and one identity predate the step: three ticks, one incarnation each, one version for all.
      expect(clock(database)).toBe(3);
      expect(stamps(database, "projects").map(row => [row.parent, row.incarnation, row.version])).toEqual([[null, 1, 3], [null, 2, 3]]);
      expect(stamps(database, "remote_project_identities").map(row => [row.id, row.parent, row.incarnation, row.version])).toEqual([["remote-a", null, 3, 3]]);
      expect(database.prepare("SELECT count(*) FROM project_mapping_journal").pluck().get()).toBe(0);
      return mapped(database);
    });
    touch(paths);
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 51 });
    read(paths, database => {
      expect(clock(database)).toBe(4);
      for (const table of MAPPED_TABLES) expect(stamps(database, table)).toEqual(first[table].map(row => ({ ...row, version: 4 })));
    });
  });
});

describe("step 51 in the explicit offline upgrade", () => {
  it("lists steps 50 and 51 in the plan and applies them from schema 49 without stamping a row", async () => {
    const paths = installation();
    const inspection = inspectSqliteUpgrade(paths, TARGET);
    expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 49, target: 51 });
    expect(inspection.plan?.steps).toEqual([
      { version: 50, name: "explicit-upgrade-marker", checksum: upgradeMarkerChecksum },
      { version: 51, name: projectMappingMigration.name, checksum: projectMappingChecksum },
    ]);
    const backup: UpgradeBackup = async (source, context) => {
      expect(context.schemaVersion).toBe(49);
      const destination = join(paths.dataDirectory, "..", "backup-51");
      return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) };
    };
    expect(await applySqliteUpgrade(paths, { expect: inspection.planHash! }, backup, TARGET)).toMatchObject({ state: "current", schemaVersion: 51, planHash: inspection.planHash });
    read(paths, database => {
      expect(inspectSchema(database, TARGET).version).toBe(51);
      expect(database.prepare("SELECT state,plan_hash FROM upgrade_marker").get()).toEqual({ state: "complete", plan_hash: inspection.planHash });
      expect(clock(database)).toBe(0);
      for (const table of MAPPED_TABLES) for (const row of stamps(database, table)) expect(row).toMatchObject({ parent: null, incarnation: 0, version: 0 });
    });
  });

  /** A step-50 snapshot through the Backup API, in the layout `createControllerBackup` writes (which recognises nothing above 49). */
  async function stepBackup(source: UpgradeBackupSource, destination: string, schemaVersion: number) {
    mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, "attachments"), { mode: 0o700 });
    const file = join(destination, "state.sqlite3");
    closeSync(openSync(file, "wx", 0o600)); await source.backup(file); chmodSync(file, 0o600);
    const snapshot = new Database(file, { fileMustExist: true });
    try { snapshot.pragma("journal_mode = DELETE"); } finally { snapshot.close(); }
    const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(), database: { file: "state.sqlite3", ...hashFile(file), schemaVersion }, attachments: [] };
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    return { root: destination, manifest };
  }
  const anyBackup = (paths: AppPaths): UpgradeBackup => async (source, context) => {
    const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
    if (context.schemaVersion <= SUPPORTED_SCHEMA_VERSION) {
      return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) };
    }
    return stepBackup(source, destination, context.schemaVersion);
  };
  /** A fresh installation initialised at step 50: marker complete without a plan hash, witness confirmed. */
  function freshComplete50() {
    const paths = resolveAppPaths(join(temporary(), "data")); mkdirSync(paths.dataDirectory, { mode: 0o700 });
    const database = new Database(paths.databasePath);
    try {
      chmodSync(paths.databasePath, 0o600); configureDurability(database);
      initializeSchema(database, true, at(50), { target: 50 });
      SecurityFence.attach(join(realpathSync(paths.dataDirectory), "state.sqlite3"), database, true);
    } finally { database.close(); }
    return paths;
  }
  const readOnly = <T,>(paths: AppPaths, operation: (database: Database.Database) => T) => { const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true }); try { return operation(database); } finally { database.close(); } };
  const upgradeFailure = async (operation: () => Promise<unknown> | unknown) => {
    try { await operation(); } catch (error) { const { name, code, state } = error as { name: string; code: string; state?: string }; return { name, code, state }; }
    throw new Error("expected a refusal");
  };

  it.each([["fresh-complete", false], ["upgraded-complete", true]] as const)("upgrades a %s step-50 database to 51, and answers 'already applied' only at the target the plan was applied for", async (_name, upgraded) => {
    let paths: AppPaths, applied50: string | null = null;
    if (upgraded) {
      paths = installation();
      applied50 = inspectSqliteUpgrade(paths, 50).planHash!;
      expect(await applySqliteUpgrade(paths, { expect: applied50 }, anyBackup(paths), 50)).toMatchObject({ state: "current", alreadyApplied: false, schemaVersion: 50 });
    } else paths = freshComplete50();
    // At 50 it is current, and a repeated apply of its own plan is already applied.
    expect(inspectSqliteUpgrade(paths, 50)).toMatchObject({ state: "current", schemaVersion: 50, target: 50, marker: "complete", appliedPlan: applied50 });
    if (applied50) expect(await applySqliteUpgrade(paths, { expect: applied50 }, anyBackup(paths), 50)).toMatchObject({ state: "current", alreadyApplied: true, planHash: applied50, schemaVersion: 50 });
    // At 51 the complete marker does not make it current: its schema is below the target. The plan lists step 51 only.
    const inspection = inspectSqliteUpgrade(paths, TARGET);
    expect(inspection).toMatchObject({ state: "upgrade_needed", nextStep: "upgrade apply", schemaVersion: 50, target: 51, marker: "complete", appliedPlan: applied50 });
    expect(inspection.plan).toMatchObject({ source: 50, target: 51, acts: [] });
    expect(inspection.plan?.steps).toEqual([{ version: 51, name: projectMappingMigration.name, checksum: projectMappingChecksum }]);
    expect(inspection.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inspection.planHash).not.toBe(applied50);
    // The earlier target-50 plan's hash (or, for a fresh installation, any other) is a plan mismatch, never "already applied".
    const stale = applied50 ?? "a".repeat(64);
    expect(await upgradeFailure(() => applySqliteUpgrade(paths, { expect: stale }, anyBackup(paths), TARGET))).toEqual({ name: "UpgradeError", code: "upgrade_plan_mismatch", state: undefined });
    const result = await applySqliteUpgrade(paths, { expect: inspection.planHash! }, anyBackup(paths), TARGET);
    expect(result).toMatchObject({ state: "current", alreadyApplied: false, planHash: inspection.planHash, receipt: expect.any(String), planRemoved: true, schemaVersion: 51 });
    readOnly(paths, database => {
      expect(inspectSchema(database, TARGET)).toEqual({ version: 51, fresh: false });
      expect(() => validateDatabase(database, 51)).not.toThrow();
      expect(database.prepare("SELECT state,plan_hash FROM upgrade_marker").get()).toEqual({ state: "complete", plan_hash: inspection.planHash });
      expect(clock(database)).toBe(0);
      for (const table of MAPPED_TABLES) for (const row of stamps(database, table)) expect(row).toMatchObject({ parent: null, incarnation: 0, version: 0 });
    });
    // Now current at 51: its own plan is already applied, the stale one is the wrong state.
    expect(inspectSqliteUpgrade(paths, TARGET)).toMatchObject({ state: "current", schemaVersion: 51, target: 51, marker: "complete", appliedPlan: inspection.planHash });
    expect(await applySqliteUpgrade(paths, { expect: inspection.planHash! }, anyBackup(paths), TARGET)).toEqual({
      state: "current", alreadyApplied: true, planHash: inspection.planHash, receipt: null, backup: null, planRemoved: true, schemaVersion: 51 });
    expect(await upgradeFailure(() => applySqliteUpgrade(paths, { expect: stale }, anyBackup(paths), TARGET))).toEqual({ name: "UpgradeError", code: "upgrade_wrong_state", state: "current" });
    // Above the target (51 at 50) the ceiling refuses it before any state is read.
    expect(() => inspectSqliteUpgrade(paths, 50)).toThrow(SCHEMA_REFUSAL);
    await expect(applySqliteUpgrade(paths, { expect: inspection.planHash! }, anyBackup(paths), 50)).rejects.toThrow(SCHEMA_REFUSAL);
  });
});

describe("the project directory (step 51, unmounted)", () => {
  const directoryFixture = () => {
    const database = observed();
    fresh50(database);
    const legacy = registration(registrations(database), "legacy").id;
    identity(database, "remote-legacy");
    to51(database);
    knowledgeProject(database, "project-a"); knowledgeProject(database, "project-b", "archived");
    const store = registrations(database);
    const parented = registration(store, "parented").id, parentless = registration(store, "parentless").id;
    identity(database, "remote-parented"); identity(database, "remote-parentless");
    setParent(database, "projects", parented, "project-a");
    setParent(database, "remote_project_identities", "remote-parented", "project-a");
    return { database, legacy, parented, parentless, directory: new ProjectDirectoryQueries(database) };
  };
  const registrationId = (value: string) => value as RegistrationId, projectId = (value: string) => value as ProjectId, remoteId = (value: string) => value as RemoteIdentityId;

  it("returns registrations and remote identities as stored: parented, parentless, unstamped and missing", () => {
    const { database, legacy, parented, parentless, directory } = directoryFixture();
    try {
      expect(directory.registration(registrationId(parented))).toEqual({ id: parented, projectId: "project-a", incarnation: 1, mappingVersion: 5 });
      expect(directory.registration(registrationId(parentless))).toEqual({ id: parentless, projectId: null, incarnation: 2, mappingVersion: 2 });
      // Unstamped rows are returned as such, not hidden.
      expect(directory.registration(registrationId(legacy))).toEqual({ id: legacy, projectId: null, incarnation: 0, mappingVersion: 0 });
      expect(directory.registration(registrationId("missing"))).toBeNull();
      expect(directory.remoteIdentity(remoteId("remote-parented"))).toEqual({ id: "remote-parented", projectId: "project-a", incarnation: 3, mappingVersion: 6 });
      expect(directory.remoteIdentity(remoteId("remote-parentless"))).toEqual({ id: "remote-parentless", projectId: null, incarnation: 4, mappingVersion: 4 });
      expect(directory.remoteIdentity(remoteId("remote-legacy"))).toEqual({ id: "remote-legacy", projectId: null, incarnation: 0, mappingVersion: 0 });
      expect(directory.remoteIdentity(remoteId("missing"))).toBeNull();
      expect(directory.project(projectId("project-a"))).toEqual({ id: "project-a", status: "active" });
      expect(directory.project(projectId("project-b"))).toEqual({ id: "project-b", status: "archived" });
      expect(directory.project(projectId("missing"))).toBeNull();
      expect(directory.projectRegistrations(projectId("project-a"))).toEqual([{ id: parented, projectId: "project-a", incarnation: 1, mappingVersion: 5 }]);
      expect(directory.projectRemoteIdentities(projectId("project-a"))).toEqual([{ id: "remote-parented", projectId: "project-a", incarnation: 3, mappingVersion: 6 }]);
      expect(directory.projectRegistrations(projectId("project-b"))).toEqual([]);
      expect(directory.projectRemoteIdentities(projectId("missing"))).toEqual([]);
    } finally { database.close(); }
  });

  it("never falls back from one namespace to another", () => {
    const { database, parented, directory } = directoryFixture();
    try {
      // The same text in another table is another namespace.
      database.exec(`INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES('project-a','x','origin','active')`);
      knowledgeProject(database, parented);
      expect(directory.project(projectId("remote-parented"))).toBeNull();
      expect(directory.registration(registrationId("project-a"))).toBeNull();
      expect(directory.registration(registrationId("remote-parented"))).toBeNull();
      expect(directory.remoteIdentity(remoteId(parented))).toBeNull();
      expect(directory.project(projectId(parented))).toEqual({ id: parented, status: "active" });
      expect(directory.remoteIdentity(remoteId("project-a"))).toMatchObject({ id: "project-a", projectId: null });
      expect(directory.projectRegistrations(projectId(parented))).toEqual([]);
      // The brands are distinct types: no lookup accepts another namespace's ID.
      // @ts-expect-error A RegistrationId is not a ProjectId.
      expect(directory.project(registrationId(parented))).toEqual({ id: parented, status: "active" });
      // @ts-expect-error A ProjectId is not a RegistrationId.
      expect(directory.registration(projectId("project-a"))).toBeNull();
      // @ts-expect-error A RemoteIdentityId is not a RegistrationId.
      expect(directory.registration(remoteId("remote-parented"))).toBeNull();
      // @ts-expect-error A plain string is no ID.
      expect(directory.projectRegistrations("project-a")).toHaveLength(1);
    } finally { database.close(); }
  });

  it("refuses a listing above its limit instead of truncating it", () => {
    const database = fresh51(observed());
    try {
      knowledgeProject(database, "project-a");
      const insert = database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES(?,'r','origin','active')");
      for (let index = 0; index <= 1000; index++) insert.run(`remote-${index}`);
      database.prepare("UPDATE project_mapping_clock SET value=value+1").run();
      database.exec("UPDATE remote_project_identities SET parent_project_id='project-a',mapping_version=(SELECT value FROM project_mapping_clock)");
      expect(() => new ProjectDirectoryQueries(database).projectRemoteIdentities(projectId("project-a"))).toThrow("Project directory listing exceeds its limit.");
      database.exec("DELETE FROM remote_project_identities WHERE id='remote-0'");
      expect(new ProjectDirectoryQueries(database).projectRemoteIdentities(projectId("project-a"))).toHaveLength(1000);
    } finally { database.close(); }
  });

  it("cannot be built, nor step 51 reached, while the provisional switch is off", () => {
    const { database } = directoryFixture();
    const empty = ordinary();
    // A plan the quarantine would apply here: the fixture has unstamped rows, so applying it would change them.
    const plan = planMappingQuarantine(database)!;
    expect(plan.unstamped).toEqual({ projects: 1, remote_project_identities: 1 });
    const state = () => ({ catalogue: catalogue(database), mapped: mapped(database), clock: rows(database, "project_mapping_clock"), journal: rows(database, "project_mapping_journal") });
    const before = state();
    restoreGate();
    try {
      for (const [entry, refusal] of Object.entries({
        ProjectDirectoryQueries: () => new ProjectDirectoryQueries(database),
        applyProjectMappingMigration: () => applyProjectMappingMigration(empty),
        initializeSchema: () => initializeSchema(empty, undefined, undefined, { target: TARGET }),
        quarantineAuthority: () => quarantineAuthority(database, RECEIPT, "token", TARGET),
        inspectSchema: () => inspectSchema(database, TARGET),
        planMappingQuarantine: () => planMappingQuarantine(database),
        applyMappingQuarantine: () => applyMappingQuarantine(database, plan),
        projectMappingViolation: () => projectMappingViolation(database),
      })) expect(message(refusal), entry).toBe("Unsupported schema target.");
      // The step-51 database itself is refused as an unknown newer schema.
      expect(message(() => inspectSchema(database))).toMatch(SCHEMA_REFUSAL);
      expect(empty.prepare("SELECT count(*) FROM sqlite_master").pluck().get()).toBe(0);
      // Nothing changed: no stamp, no clock advance, no journal row.
      expect(state()).toEqual(before);
    } finally {
      restoreGate = enableProvisionalSchema();
      database.close(); empty.close();
    }
  });
});
