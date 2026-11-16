import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROVISIONAL_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { enableProvisionalSchema } from "./provisional-schema-gate";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { validateDatabase } from "./database-validation";
import { hashFile, parseManifest, validateBackup, validateSnapshot } from "./backup-validation";
import { securityFenceChecksum, securityTriggers, SECURITY_TABLES } from "./security-fence-migration";
import { upgradeMarkerChecksum, upgradeMarkerTriggers } from "./upgrade-marker-migration";
import { projectMappingChecksum, projectMappingFenceTriggers, projectMappingTriggers } from "./mapping-structure-migration";
import {
  ACCOUNT_GRANTS_SECURITY_TABLES, ACCOUNT_GRANTS_VERSION, accountGrantsChecksum, accountGrantsFenceTriggers, accountGrantsMigration, accountGrantsTriggers,
  accountGrantsViolation, applyAccountGrantsMigration, GRANT_ROLE_SCOPES, GRANT_ROLES,
} from "./account-grants-migration";
import { SECURITY_COVERAGE, schemaTriggersAt, securityTriggersAt, STEP_TRIGGERS } from "./security-coverage";
import { rewindAccountGrants, rewindProjectMapping } from "./fixtures/schema-rewind";
import { SqliteStateStore } from "./sqlite-state-store";
import { quarantineAuthority } from "./security-maintenance";
import { structuralSteps } from "./upgrade-plan";

// Every test here needs target 52; the switch is restored after each one.
let restoreGate: () => void;
const roots: string[] = [];
beforeEach(() => { restoreGate = enableProvisionalSchema(); });
afterEach(() => { restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "account-grants-")); roots.push(root); return root; };

const TARGET = ACCOUNT_GRANTS_VERSION;
/** A connection without `worktree_security_pending`, as in ordinary startup before the fence attaches. */
const ordinary = (path = ":memory:") => new Database(path);
/** A connection with the no-op maintenance observer: covered writes pass. */
const observed = (path = ":memory:") => unmanagedFixtureDatabase(path);
const at = (target: number) => (database: Database.Database) => { inspectSchema(database, target); };
const freshAt = (target: number | undefined, database = ordinary()) => { initializeSchema(database, undefined, at(target ?? SUPPORTED_SCHEMA_VERSION), { target }); return database; };
const fresh52 = (database = ordinary()) => freshAt(TARGET, database);
const migrate = (database: Database.Database, target = TARGET) => { initializeSchema(database, false, at(target), { target }); return database; };
const catalogue = (database: Database.Database) => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
const stepObjects = (database: Database.Database) => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='account_grants' ORDER BY type,name").all();
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
const SCHEMA_REFUSAL = /^Unsupported or unrecognized database schema/;
const NO_OBSERVER = /no such function: worktree_security_pending/;
const AT = "2026-11-15T00:00:00.000Z", LATER = "2026-11-16T00:00:00.000Z";
const UNKNOWN_52 = `INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(52,'2026-11-15T00:00:00.000Z','unknown-newer','${"0".repeat(64)}')`;
const INSERT = "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)";
const grants = (database: Database.Database) => database.prepare("SELECT rowid,* FROM account_grants ORDER BY rowid").all();
/** Principals and projects that grants may name, written as raw fixture rows. */
function accounts(database: Database.Database): void {
  database.exec(`INSERT INTO remote_principals(id,kind,status) VALUES('owner','owner','active'),('human','human','active'),('agent','agent','active');
    INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES('project-a','A','active',1,'${AT}','${AT}'),('project-b','B','active',1,'${AT}','${AT}')`);
}
const withGrants = () => { const database = fresh52(observed()); accounts(database); return database; };
/** A private data directory with one database file, as the owned store expects. */
function privateDatabase(build: (database: Database.Database) => void, open = ordinary) {
  const directory = join(temporary(), "data"); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "state.sqlite3"), database = open(path);
  try { build(database); } finally { database.close(); }
  chmodSync(path, 0o600);
  return path;
}
function backupTree(build: (database: Database.Database) => void, schemaVersion: number) {
  const root = temporary(), path = join(root, "state.sqlite3");
  const database = ordinary(path);
  try { build(database); } finally { database.close(); }
  mkdirSync(join(root, "attachments"));
  const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(), database: { file: "state.sqlite3", ...hashFile(path), schemaVersion }, attachments: [] };
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return { root, path, manifest };
}

/**
 * The contract's role table, read from its source text: the guard of
 * `src/server/modules/operations/unmounted.test.ts` refuses an import of the
 * contract from every file of its inventory outside the module (test files
 * included), so the contract is parsed, not imported. `roles` is the frozen
 * array literal; each entry of `roleDefinitions` names its `scope`.
 */
function contractRoleScopes(): Array<[string, string]> {
  const path = resolve("src/shared/contracts/operations.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializer = (name: string) => {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!found) throw new Error(`contract has no ${name}`);
    return found;
  };
  /** `Object.freeze(x)` and `x as const` both read as `x`. */
  const unwrap = (node: ts.Expression): ts.Expression => ts.isCallExpression(node) && node.arguments.length === 1 ? unwrap(node.arguments[0])
    : ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const roles = unwrap(initializer("roles"));
  if (!ts.isArrayLiteralExpression(roles)) throw new Error("roles is not an array literal");
  const names = roles.elements.map(element => { if (!ts.isStringLiteral(element)) throw new Error("role is not a literal"); return element.text; });
  const definitions = unwrap(initializer("roleDefinitions"));
  if (!ts.isObjectLiteralExpression(definitions)) throw new Error("roleDefinitions is not an object literal");
  const scopes = new Map(definitions.properties.map(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) throw new Error("unexpected role definition");
    const definition = unwrap(property.initializer);
    if (!ts.isObjectLiteralExpression(definition)) throw new Error("role definition is not an object literal");
    const scope = definition.properties.find(entry => ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === "scope") as ts.PropertyAssignment | undefined;
    if (!scope || !ts.isStringLiteral(scope.initializer)) throw new Error("role definition has no literal scope");
    return [property.name.text, scope.initializer.text] as const;
  }));
  expect([...scopes.keys()].sort()).toEqual([...names].sort());
  return names.map(name => [name, scopes.get(name)!]);
}

describe("provisional schema step 52: grants storage", () => {
  it("pins step 52 and its coverage, and leaves steps 49, 50 and 51 as they were", () => {
    expect(PROVISIONAL_SCHEMA_VERSION).toBe(52);
    expect(SUPPORTED_SCHEMA_VERSION).toBe(49);
    expect(accountGrantsMigration).toMatchObject({ version: 52, name: "account-grants-structure" });
    // Pinned while provisional: a change to the step's text is a visible edit here.
    expect(accountGrantsChecksum).toBe("8a65a27c2243118bd3f14dba323df6f00e3e6b608351c5c23463997a36115cff");
    // Steps 49 to 51 keep their pinned checksums (also pinned in their own tests).
    expect(securityFenceChecksum).toBe("320f46981c17c44f4d14ee48298bd91f43d01ab78bf4162c607d2118f29486ae");
    expect(upgradeMarkerChecksum).toBe("d720c5eef040ff328401426cc18fefb560a6be7460cc355a789f169d5d07315c");
    expect(projectMappingChecksum).toBe("1c0afefd54f82635da94be7361bbe412ec76bbe49ff50a335ed8a248ea50bc85");
    expect(structuralSteps(49, 52).map(step => [step.version, step.name, step.checksum])).toEqual([
      [50, "explicit-upgrade-marker", upgradeMarkerChecksum], [51, "project-mapping-structure", projectMappingChecksum], [52, "account-grants-structure", accountGrantsChecksum]]);
    expect(SECURITY_TABLES).not.toContain("account_grants");
    expect(SECURITY_COVERAGE.map(step => step.version)).toEqual([49, 50, 51, 52]);
    expect(SECURITY_COVERAGE[3]).toEqual({ version: 52, tables: ACCOUNT_GRANTS_SECURITY_TABLES, triggers: accountGrantsFenceTriggers });
    expect(ACCOUNT_GRANTS_SECURITY_TABLES).toEqual(["account_grants"]);
    expect(STEP_TRIGGERS.map(step => [step.version, step.triggers])).toEqual([[51, projectMappingTriggers], [52, accountGrantsTriggers]]);
    // The expected triggers stay a function of the version: 51 is unchanged, 52 adds the step's own.
    expect(securityTriggersAt(51)).toEqual([...securityTriggers, ...upgradeMarkerTriggers, ...projectMappingFenceTriggers]);
    expect(securityTriggersAt(52)).toEqual([...securityTriggers, ...upgradeMarkerTriggers, ...projectMappingFenceTriggers, ...accountGrantsFenceTriggers]);
    expect(schemaTriggersAt(51).map(({ name }) => name)).not.toContain("account_grants_insert");
    expect(schemaTriggersAt(52).map(({ name, sql }) => ({ name, sql }))).toEqual([...securityTriggers, ...upgradeMarkerTriggers, ...projectMappingFenceTriggers, ...accountGrantsFenceTriggers,
      ...projectMappingTriggers, ...accountGrantsTriggers]);
    for (const [index, trigger] of accountGrantsFenceTriggers.entries()) expect(trigger.sql).toBe(securityTriggers[index].sql.replaceAll(SECURITY_TABLES[0], "account_grants"));
    expect(accountGrantsTriggers.map(trigger => trigger.name)).toEqual(["account_grants_insert", "account_grants_update"]);
    for (const trigger of [...accountGrantsFenceTriggers, ...accountGrantsTriggers]) expect(accountGrantsMigration.sql).toContain(`${trigger.sql};`);
    // Structure only: the step writes no row.
    expect(accountGrantsMigration.sql).not.toMatch(/\bINSERT\b(?! ON)/);
  });

  it("states the contract's role table exactly, in the literal and in the table's CHECK", () => {
    const contract = contractRoleScopes();
    expect(contract).toEqual(GRANT_ROLE_SCOPES.map(([role, scope]) => [role, scope]));
    expect([...GRANT_ROLES]).toEqual(contract.map(([role]) => role));
    // The genuine table accepts exactly the contract's role and scope pairs.
    const database = withGrants();
    try {
      for (const [role] of contract) for (const scope of ["project", "installation"]) {
        const project = scope === "project" ? "project-a" : null;
        const accepted = contract.some(entry => entry[0] === role && entry[1] === scope);
        const insert = () => database.prepare(INSERT).run("owner", role, scope, project, AT);
        if (accepted) expect(insert, `${role} ${scope}`).not.toThrow();
        else expect(insert, `${role} ${scope}`).toThrow(/CHECK constraint failed/);
      }
      expect(database.prepare("SELECT role,scope_kind FROM account_grants ORDER BY rowid").raw().all()).toEqual(contract);
      expect(() => validateDatabase(database, TARGET)).not.toThrow();
      // An unknown role and an unknown scope kind are refused too.
      expect(() => database.prepare(INSERT).run("owner", "owner", "project", "project-a", AT)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(INSERT).run("owner", "reader", "global", "project-a", AT)).toThrow(/CHECK constraint failed/);
    } finally { database.close(); }
  });

  it("neither applies nor recognises step 52 at the default target, at 50 or at 51, and refuses a step-52 database like an unknown newer schema", () => {
    for (const target of [undefined, 50, 51]) {
      const database = freshAt(target);
      try {
        expect(database.prepare("SELECT 1 FROM sqlite_master WHERE tbl_name='account_grants'").get(), String(target)).toBeUndefined();
        expect(database.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(target ?? 49);
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").pluck().all()).toEqual(schemaTriggersAt(target ?? 49).map(trigger => trigger.name).sort());
      } finally { database.close(); }
    }
    const provisional = fresh52(), unknown = freshAt(51);
    try {
      unknown.exec(UNKNOWN_52);
      const refusal = message(() => inspectSchema(unknown, 51));
      expect(refusal).toMatch(SCHEMA_REFUSAL);
      for (const ceiling of [undefined, 49, 50, 51]) {
        expect(message(() => inspectSchema(unknown, ceiling))).toMatch(SCHEMA_REFUSAL);
        expect(message(() => inspectSchema(provisional, ceiling))).toBe(message(() => inspectSchema(unknown, ceiling)));
      }
      for (const target of [undefined, 50, 51]) expect(message(() => initializeSchema(provisional, false, at(target ?? 49), { target }))).toMatch(SCHEMA_REFUSAL);
    } finally { provisional.close(); unknown.close(); }
    // Ordinary store opening refuses it as the unknown newer schema.
    const provisionalPath = privateDatabase(database => fresh52(database));
    const unknownPath = privateDatabase(database => { freshAt(51, database); database.exec(UNKNOWN_52); });
    const opening = message(() => new SqliteStateStore(unknownPath));
    expect(opening).toMatch(SCHEMA_REFUSAL);
    expect(message(() => new SqliteStateStore(provisionalPath))).toBe(opening);
    // Backup validation: the manifest ceiling and the snapshot recognition follow the target.
    const backup = backupTree(database => fresh52(database), 52);
    const manifestRefusal = "Unsupported or invalid backup manifest (types, paths, versions or limits).";
    for (const ceiling of [undefined, 50, 51]) expect(() => parseManifest(backup.manifest, ceiling)).toThrow(manifestRefusal);
    const parsed = parseManifest(backup.manifest, TARGET);
    expect(() => validateBackup(backup.root, parsed, false, TARGET)).not.toThrow();
    for (const ceiling of [undefined, 51]) expect(message(() => validateSnapshot(backup.path, parsed, ceiling))).toMatch(SCHEMA_REFUSAL);
    expect(() => parseManifest(backup.manifest, 53)).toThrow("Unsupported schema target.");
  });

  it("applies step 52 fresh and from 49, 50 and 51 with one structure, on connections without the fence function, and writes no row", () => {
    const reference = fresh52();
    const sources = [freshAt(undefined), freshAt(50), freshAt(51)];
    try {
      for (const database of [reference, ...sources]) {
        if (database !== reference) migrate(database);
        expect(inspectSchema(database, TARGET)).toEqual({ version: 52, fresh: false });
        expect(() => validateDatabase(database, TARGET)).not.toThrow();
        expect(database.prepare("SELECT count(*) FROM account_grants").pluck().get()).toBe(0);
        expect(stepObjects(database)).toEqual(stepObjects(reference));
        expect(catalogue(database)).toEqual(catalogue(reference));
        // Earlier steps' triggers stay byte-identical.
        for (const trigger of [...securityTriggers, ...upgradeMarkerTriggers, ...projectMappingFenceTriggers, ...projectMappingTriggers]) {
          expect(database.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(trigger.name)).toBe(trigger.sql);
        }
        // Every write to the grants reaches the missing observer: insert, update and delete are fenced.
        for (const statement of [`INSERT INTO account_grants VALUES('installation','admin','installation',NULL,'${AT}')`,
          `UPDATE account_grants SET granted_at='${AT}'`, "DELETE FROM account_grants"]) expect(() => database.exec(statement), statement).toThrow(NO_OBSERVER);
        expect(database.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version=52").get()).toEqual({ version: 52, name: "account-grants-structure", checksum: accountGrantsChecksum });
      }
      // The exact stored text of the table, its indexes and triggers.
      expect(reference.prepare("SELECT sql FROM sqlite_master WHERE name='account_grants'").pluck().get()).toBe(accountGrantsMigration.sql.split(";\n")[0]);
      // Initialising again changes nothing; the rewind fixture returns to the step-51 structure.
      const before = catalogue(reference);
      migrate(reference);
      expect(catalogue(reference)).toEqual(before);
      const step51 = freshAt(51);
      try {
        rewindAccountGrants(reference);
        expect(inspectSchema(reference, 51)).toEqual({ version: 51, fresh: false });
        expect(catalogue(reference)).toEqual(catalogue(step51));
        rewindAccountGrants(reference);
        rewindProjectMapping(sources[2]);
        expect(inspectSchema(sources[2], 50)).toEqual({ version: 50, fresh: false });
      } finally { step51.close(); }
    } finally { for (const database of [reference, ...sources]) database.close(); }
  });

  it("is safe in ordinary startup over a populated schema-49 store, and its writes are fenced afterwards", () => {
    const path = privateDatabase(database => {
      freshAt(undefined, database);
      accounts(database);
    }, observed);
    const database = ordinary(path);
    try {
      migrate(database);
      expect(inspectSchema(database, TARGET).version).toBe(52);
      expect(database.prepare("SELECT count(*) FROM account_grants").pluck().get()).toBe(0);
      expect(() => database.prepare(INSERT).run("owner", "admin", "installation", null, AT)).toThrow(NO_OBSERVER);
    } finally { database.close(); }
    // With the observer the same insert is accepted.
    const fenced = observed(path);
    try { fenced.prepare(INSERT).run("owner", "admin", "installation", null, AT); expect(grants(fenced)).toHaveLength(1); } finally { fenced.close(); }
  });

  it("rolls back step 52 with the rest of the schema transaction", () => {
    for (const database of [freshAt(undefined), freshAt(51)]) {
      try {
        const before = catalogue(database), version = inspectSchema(database, TARGET).version;
        expect(() => initializeSchema(database, false, () => { throw new Error("fixture rollback52"); }, { target: TARGET })).toThrow("fixture rollback52");
        expect(catalogue(database)).toEqual(before);
        expect(inspectSchema(database, TARGET).version).toBe(version);
      } finally { database.close(); }
    }
  });

  it("refuses a direct call of the step while the provisional switch is off", () => {
    restoreGate();
    try {
      const database = ordinary();
      try {
        expect(() => applyAccountGrantsMigration(database)).toThrow("Unsupported schema target.");
        expect(() => accountGrantsViolation(database)).toThrow("Unsupported schema target.");
        expect(database.prepare("SELECT count(*) FROM sqlite_master").pluck().get()).toBe(0);
      } finally { database.close(); }
    } finally { restoreGate = enableProvisionalSchema(); }
  });
});

describe("step 52 grant table guards", () => {
  it.each(["OFF", "ON"])("refuses a duplicate grant under a plain insert and every conflict clause, with recursive_triggers %s", recursive => {
    const database = withGrants();
    try {
      database.pragma(`recursive_triggers = ${recursive}`);
      database.prepare(INSERT).run("owner", "admin", "installation", null, AT);
      database.prepare(INSERT).run("human", "reader", "project", "project-a", AT);
      const before = grants(database);
      const values = (account: string, role: string, scope: string, project: string | null) => `('${account}','${role}','${scope}',${project === null ? "NULL" : `'${project}'`},'${LATER}')`;
      for (const row of [values("owner", "admin", "installation", null), values("human", "reader", "project", "project-a")]) {
        for (const statement of [
          `INSERT INTO account_grants VALUES${row}`, `INSERT OR ABORT INTO account_grants VALUES${row}`, `INSERT OR FAIL INTO account_grants VALUES${row}`,
          `INSERT OR IGNORE INTO account_grants VALUES${row}`, `INSERT OR REPLACE INTO account_grants VALUES${row}`, `REPLACE INTO account_grants VALUES${row}`,
          `INSERT OR ROLLBACK INTO account_grants VALUES${row}`,
          `INSERT INTO account_grants VALUES${row} ON CONFLICT DO NOTHING`, `INSERT INTO account_grants VALUES${row} ON CONFLICT DO UPDATE SET granted_at=excluded.granted_at`,
        ]) {
          // OR ROLLBACK ends the implicit transaction of the statement only; nothing else is open.
          expect(() => database.exec(statement), statement).toThrow("account grant already exists");
          expect(grants(database), statement).toEqual(before);
        }
      }
      // Without the insert guard, the unique index alone still refuses a second installation grant (NULL project) under a plain insert.
      database.exec("DROP TRIGGER account_grants_insert");
      expect(() => database.exec(`INSERT INTO account_grants VALUES${values("owner", "admin", "installation", null)}`)).toThrow("UNIQUE constraint failed: index 'account_grants_key'");
      // A UNIQUE constraint over the columns would not: NULLs are distinct in a unique key.
      database.exec("CREATE TABLE probe(account TEXT, role TEXT, scope TEXT, project TEXT, UNIQUE(account,role,scope,project)); INSERT INTO probe VALUES('o','admin','installation',NULL),('o','admin','installation',NULL)");
      expect(database.prepare("SELECT count(*) FROM probe").pluck().get()).toBe(2);
    } finally { database.close(); }
  });

  it("refuses every UPDATE, allows DELETE, and refuses a replacing insert by rowid", () => {
    const database = withGrants();
    try {
      database.prepare(INSERT).run("owner", "admin", "installation", null, AT);
      database.prepare(INSERT).run("human", "operator", "project", "project-a", AT);
      const before = grants(database);
      for (const statement of [`UPDATE account_grants SET granted_at='${LATER}'`, `UPDATE OR REPLACE account_grants SET granted_at='${LATER}'`,
        `UPDATE OR IGNORE account_grants SET role='reader' WHERE role='operator'`, "UPDATE account_grants SET project_id='project-b' WHERE project_id='project-a'",
        "UPDATE account_grants SET account_id=account_id"]) {
        expect(() => database.exec(statement), statement).toThrow("account grants are immutable; revocation is deletion");
      }
      // A replacing insert of another grant with an existing row's rowid would delete that row: refused.
      for (const conflict of ["", "OR REPLACE ", "OR IGNORE "]) {
        expect(() => database.exec(`INSERT ${conflict}INTO account_grants(rowid,account_id,role,scope_kind,project_id,granted_at) VALUES(1,'agent','reader','project','project-b','${LATER}')`))
          .toThrow("account grants are never replaced");
      }
      // A non-positive explicit rowid is refused by the CHECK.
      expect(() => database.exec(`INSERT INTO account_grants(rowid,account_id,role,scope_kind,project_id,granted_at) VALUES(-1,'agent','reader','project','project-b','${LATER}')`)).toThrow("CHECK constraint failed: rowid>0");
      expect(grants(database)).toEqual(before);
      // Revocation is deletion; the deleted grant can be granted again (with a new time).
      expect(database.prepare("DELETE FROM account_grants WHERE account_id='human'").run().changes).toBe(1);
      database.prepare(INSERT).run("human", "operator", "project", "project-a", LATER);
      expect(database.prepare("SELECT granted_at FROM account_grants WHERE account_id='human'").pluck().get()).toBe(LATER);
      expect(() => validateDatabase(database, TARGET)).not.toThrow();
    } finally { database.close(); }
  });

  it("refuses malformed values: a time that is not a canonical real instant, untyped or unbounded IDs, a project on the wrong scope", () => {
    const database = withGrants();
    try {
      for (const time of ["2026-11-15T24:00:00.000Z", "2026-11-15T00:00:00Z", "2026-11-15 00:00:00.000", "2026-02-30T00:00:00.000Z", "2026-11-15T00:00:00.000+00:00", "", "now"]) {
        expect(() => database.prepare(INSERT).run("owner", "admin", "installation", null, time), time).toThrow(/CHECK constraint failed/);
      }
      expect(() => database.exec("INSERT INTO account_grants VALUES('owner','admin','installation',NULL,1)")).toThrow(/CHECK constraint failed/);
      expect(() => database.exec(`INSERT INTO account_grants VALUES(CAST('owner' AS BLOB),'admin','installation',NULL,'${AT}')`)).toThrow(/CHECK constraint failed/);
      expect(() => database.exec(`INSERT INTO account_grants VALUES('owner',CAST('admin' AS BLOB),'installation',NULL,'${AT}')`)).toThrow(/CHECK constraint failed/);
      expect(() => database.exec(`INSERT INTO account_grants VALUES('owner'||char(0),'admin','installation',NULL,'${AT}')`)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(INSERT).run("x".repeat(161), "admin", "installation", null, AT)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(INSERT).run("", "admin", "installation", null, AT)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(INSERT).run("owner", "reader", "project", null, AT)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(INSERT).run("owner", "admin", "installation", "project-a", AT)).toThrow(/CHECK constraint failed/);
      expect(() => database.prepare(INSERT).run("owner", "reader", "project", "", AT)).toThrow(/CHECK constraint failed/);
      expect(grants(database)).toEqual([]);
    } finally { database.close(); }
  });

  it("leaves a missing account or project to the final foreign-key check, which refuses the database", () => {
    for (const [account, project] of [["nobody", null], ["owner", "missing-project"]] as const) {
      const database = withGrants();
      try {
        database.pragma("foreign_keys = OFF");
        database.prepare(INSERT).run(account, project ? "reader" : "admin", project ? "project" : "installation", project, AT);
        expect(() => validateDatabase(database, TARGET)).toThrow("SQLite foreign key check failed; startup stopped.");
        // With enforcement on, the insert itself is refused.
        database.exec("DELETE FROM account_grants");
        database.pragma("foreign_keys = ON");
        expect(() => database.prepare(INSERT).run(account, project ? "reader" : "admin", project ? "project" : "installation", project, AT)).toThrow("FOREIGN KEY constraint failed");
      } finally { database.close(); }
    }
  });

  it("does not enforce who may hold a role: a human executor or an agent admin is stored and passes validation (the contract refuses it at evaluation)", () => {
    const database = withGrants();
    try {
      database.prepare(INSERT).run("human", "executor", "project", "project-a", AT);
      database.prepare(INSERT).run("agent", "admin", "installation", null, AT);
      database.prepare(INSERT).run("agent", "maintainer", "project", "project-b", AT);
      expect(() => validateDatabase(database, TARGET)).not.toThrow();
    } finally { database.close(); }
  });
});

describe("step 52 recognition at ceiling 52", () => {
  const recognised = (mutate: (database: Database.Database) => void) => {
    const database = fresh52(observed());
    try {
      expect(() => inspectSchema(database, TARGET)).not.toThrow();
      mutate(database);
      return message(() => inspectSchema(database, TARGET));
    } finally { database.close(); }
  };
  const triggerOf = (name: string) => [...accountGrantsFenceTriggers, ...accountGrantsTriggers].find(trigger => trigger.name === name)!;
  const replaceTrigger = (database: Database.Database, name: string, sql: string) => database.exec(`DROP TRIGGER ${name}; ${sql}`);
  /** Rebuilds the grants table with one change to its CREATE text, keeping its indexes and triggers. */
  const rebuild = (from: string, to: string) => (database: Database.Database) => {
    const sql = database.prepare("SELECT sql FROM sqlite_master WHERE name='account_grants'").pluck().get() as string;
    expect(sql).toContain(from);
    database.exec(`DROP TABLE account_grants; ${sql.replace(from, to)}`);
    for (const statement of accountGrantsMigration.sql.split(";\n").slice(1)) database.exec(statement.replace(/;$/, ""));
  };

  it.each([
    ["a changed role literal", rebuild("'secrets'", "'secret'")],
    ["a widened role list", rebuild("'admin')", "'admin','owner')")],
    ["a changed scope literal", rebuild("WHEN 'admin' THEN 'installation'", "WHEN 'admin' THEN 'project'")],
    ["no scope consistency", rebuild(`,\n  CHECK((project_id IS NOT NULL)=(scope_kind='project'))`, "")],
    ["no rowid CHECK", rebuild(",\n  CHECK(rowid>0)", "")],
    ["a widened ID bound", rebuild("length(account_id)<=160", "length(account_id)<=161")],
    ["a time without the Julian-day comparison", rebuild("julianday(granted_at)", "granted_at")],
    ["an account without its foreign key", rebuild(" REFERENCES remote_principals(id)", "")],
    ["a project referencing registrations", rebuild("REFERENCES knowledge_projects(id)", "REFERENCES projects(id)")],
    ["an expiry column", rebuild("  granted_at TEXT NOT NULL", "  expires_at TEXT,\n  granted_at TEXT NOT NULL")],
    ["a reformatted table", rebuild("\n  role TEXT", " role TEXT")],
    ["a missing insert guard", (db: Database.Database) => db.exec("DROP TRIGGER account_grants_insert")],
    ["a missing immutability guard", (db: Database.Database) => db.exec("DROP TRIGGER account_grants_update")],
    ["a missing fence trigger", (db: Database.Database) => db.exec("DROP TRIGGER security_account_grants_delete")],
    ["an altered insert guard", (db: Database.Database) => replaceTrigger(db, "account_grants_insert", triggerOf("account_grants_insert").sql.replace(" AND project_id IS NEW.project_id", ""))],
    ["an altered immutability guard", (db: Database.Database) => replaceTrigger(db, "account_grants_update",
      "CREATE TRIGGER account_grants_update BEFORE UPDATE ON account_grants BEGIN SELECT 1; END")],
    ["a recased fence trigger", (db: Database.Database) => replaceTrigger(db, "security_account_grants_insert", triggerOf("security_account_grants_insert").sql.replace("BEFORE INSERT", "before insert"))],
    ["an extra trigger", (db: Database.Database) => db.exec("CREATE TRIGGER account_grants_extra AFTER INSERT ON account_grants BEGIN SELECT 1; END")],
    ["a missing unique index", (db: Database.Database) => db.exec("DROP INDEX account_grants_key")],
    ["a unique index without the installation key", (db: Database.Database) => db.exec("DROP INDEX account_grants_key; CREATE UNIQUE INDEX account_grants_key ON account_grants(account_id,role,scope_kind,project_id)")],
    ["a non-unique key index", (db: Database.Database) => db.exec("DROP INDEX account_grants_key; CREATE INDEX account_grants_key ON account_grants(account_id,role,scope_kind,ifnull(project_id,''))")],
    ["a missing project index", (db: Database.Database) => db.exec("DROP INDEX account_grants_project")],
    ["an extra index", (db: Database.Database) => db.exec("CREATE INDEX account_grants_extra ON account_grants(granted_at)")],
    ["a wrong checksum", (db: Database.Database) => db.exec(`UPDATE schema_migrations SET checksum='${"0".repeat(64)}' WHERE version=52`)],
    ["a wrong name", (db: Database.Database) => db.exec("UPDATE schema_migrations SET name='other-step' WHERE version=52")],
    ["a missing table", (db: Database.Database) => db.exec("DROP TABLE account_grants")],
    ["step-52 objects before their migration", (db: Database.Database) => db.exec("DELETE FROM schema_migrations WHERE version=52")],
  ])("refuses a step-52 database with %s", (_name, mutate) => {
    expect(recognised(mutate)).toMatch(SCHEMA_REFUSAL);
  });

  it("refuses the grants table before step 52, at every ceiling, and recognises a step-51 database at ceiling 52 unchanged", () => {
    for (const target of [undefined, 50, 51]) {
      const database = freshAt(target, observed());
      try {
        expect(inspectSchema(database, TARGET)).toEqual({ version: target ?? 49, fresh: false });
        for (const statement of accountGrantsMigration.sql.split(";\n")) database.exec(statement.replace(/;$/, ""));
        for (const ceiling of [target ?? 49, 51, 52]) expect(message(() => inspectSchema(database, ceiling)), `${target} at ${ceiling}`).toMatch(SCHEMA_REFUSAL);
      } finally { database.close(); }
    }
  });
});

describe("step 52 validation", () => {
  /** Rows the genuine table refuses, written with CHECK enforcement off (triggers and the unique index stay). */
  const raw = (database: Database.Database, sql: string) => { database.pragma("ignore_check_constraints = ON"); try { database.exec(sql); } finally { database.pragma("ignore_check_constraints = OFF"); } };
  it.each([
    ["an unknown role", `INSERT INTO account_grants VALUES('owner','owner','installation',NULL,'${AT}')`],
    ["a role on the wrong scope", `INSERT INTO account_grants VALUES('owner','admin','project','project-a','${AT}')`],
    ["a project role on the installation", `INSERT INTO account_grants VALUES('owner','reader','installation',NULL,'${AT}')`],
    ["a project scope without a project", `INSERT INTO account_grants VALUES('owner','reader','project',NULL,'${AT}')`],
    ["an installation scope with a project", `INSERT INTO account_grants VALUES('owner','admin','installation','project-a','${AT}')`],
    ["hour 24", `INSERT INTO account_grants VALUES('owner','admin','installation',NULL,'2026-11-15T24:00:00.000Z')`],
    ["a time without milliseconds", `INSERT INTO account_grants VALUES('owner','admin','installation',NULL,'2026-11-15T00:00:00Z')`],
    ["a BLOB time", `INSERT INTO account_grants VALUES('owner','admin','installation',NULL,CAST('${AT}' AS BLOB))`],
    // An integer account would be stored as text by the column's affinity; a BLOB keeps its class.
    ["a BLOB account", `INSERT INTO account_grants VALUES(CAST('owner' AS BLOB),'admin','installation',NULL,'${AT}')`],
    ["an account with a NUL", `INSERT INTO account_grants VALUES('owner'||char(0)||'x','admin','installation',NULL,'${AT}')`],
    ["a BLOB role", `INSERT INTO account_grants VALUES('owner',CAST('admin' AS BLOB),'installation',NULL,'${AT}')`],
    ["a BLOB scope kind", `INSERT INTO account_grants VALUES('owner','admin',CAST('installation' AS BLOB),NULL,'${AT}')`],
    ["a non-positive rowid", `INSERT INTO account_grants(rowid,account_id,role,scope_kind,project_id,granted_at) VALUES(-5,'owner','admin','installation',NULL,'${AT}')`],
  ])("refuses %s", (_name, sql) => {
    const database = withGrants();
    try {
      // The owner principal 'owner\0x' does not exist; foreign keys stay off so that the shape rule decides.
      database.pragma("foreign_keys = OFF");
      raw(database, sql);
      expect(accountGrantsViolation(database)).toBe("account grant shape");
      expect(() => validateDatabase(database, TARGET)).toThrow(/application invariant failed \(account grant shape\)|foreign key check failed/);
    } finally { database.close(); }
  });

  it("refuses a duplicate grant written past the guards", () => {
    for (const project of [null, "project-a"]) {
      const database = withGrants();
      try {
        database.exec("DROP TRIGGER account_grants_insert; DROP INDEX account_grants_key");
        for (let index = 0; index < 2; index++) database.prepare(INSERT).run("owner", project ? "reader" : "admin", project ? "project" : "installation", project, AT);
        expect(accountGrantsViolation(database)).toBe("account grant duplicate");
        expect(() => validateDatabase(database, TARGET)).toThrow("SQLite application invariant failed (account grant duplicate); startup stopped.");
      } finally { database.close(); }
    }
  });

  it("accepts every well-formed grant, recipient kinds aside", () => {
    const database = withGrants();
    try {
      for (const [role, scope] of GRANT_ROLE_SCOPES) database.prepare(INSERT).run("human", role, scope, scope === "project" ? "project-a" : null, AT);
      expect(accountGrantsViolation(database)).toBeNull();
      expect(() => validateDatabase(database, TARGET)).not.toThrow();
    } finally { database.close(); }
  });
});

describe("step 52 in the quarantine of auth fence resume", () => {
  const RECEIPT = "00000000-0000-4000-8000-000000000000";
  const quarantine = (database: Database.Database, target = TARGET, acts?: (database: Database.Database) => void) =>
    initializeSchema(database, false, at(target), { target, acts: current => { quarantineAuthority(current, RECEIPT, "token", target); acts?.(current); } });

  it("deletes every grant at target 52, in the quarantine's one transaction, and rolls back with it", () => {
    const database = withGrants();
    try {
      for (const [role, scope] of GRANT_ROLE_SCOPES) database.prepare(INSERT).run("human", role, scope, scope === "project" ? "project-a" : null, AT);
      database.prepare(INSERT).run("owner", "admin", "installation", null, AT);
      const before = { grants: grants(database), settings: database.prepare("SELECT * FROM controller_settings ORDER BY key").all(), catalogue: catalogue(database) };
      expect(() => quarantine(database, TARGET, current => { expect(grants(current)).toEqual([]); throw new Error("fixture quarantine fault"); })).toThrow("fixture quarantine fault");
      expect({ grants: grants(database), settings: database.prepare("SELECT * FROM controller_settings ORDER BY key").all(), catalogue: catalogue(database) }).toEqual(before);
      quarantine(database);
      expect(grants(database)).toEqual([]);
      expect(database.prepare("SELECT state,plan_hash FROM upgrade_marker").get()).toEqual({ state: "pending", plan_hash: null });
      expect(() => validateDatabase(database, TARGET)).not.toThrow();
    } finally { database.close(); }
  });

  it("migrates to 52 and quarantines in one transaction from 49 and 51", () => {
    for (const source of [undefined, 51]) {
      const database = freshAt(source, observed());
      try {
        quarantine(database);
        expect(inspectSchema(database, TARGET).version).toBe(52);
        expect(grants(database)).toEqual([]);
      } finally { database.close(); }
    }
  });

  it("keeps the quarantine's statements at the default target, 50 and 51 free of step 52", () => {
    for (const target of [undefined, 50, 51]) {
      const database = freshAt(target, observed()), statements: string[] = [];
      try {
        const prepare = database.prepare.bind(database), exec = database.exec.bind(database);
        Object.assign(database, {
          prepare: (source: string) => { statements.push(source); return prepare(source); },
          exec: (source: string) => { statements.push(source); return exec(source); },
        });
        initializeSchema(database, false, undefined, { target, acts: current => quarantineAuthority(current, RECEIPT, "token", target) });
        expect(statements.some(statement => statement.includes("UPDATE controller_settings"))).toBe(true);
        expect(statements.filter(statement => statement.includes("account_grants")), String(target)).toEqual([]);
      } finally { database.close(); }
    }
  });
});
