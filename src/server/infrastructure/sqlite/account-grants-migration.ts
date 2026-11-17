import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";

/**
 * Step 52: the storage of the new grants, applied by the default target (the
 * supported version) and by an explicit target of 52. It may still change
 * until the release candidate; a database migrated by an unreleased build is
 * disposable.
 *
 * One row is one stored role assignment (`StoredGrant` of the operations
 * contract): an account (`remote_principals.id`), one of the six roles, a scope
 * (`project` with a Knowledge project, or `installation` without one) and the
 * time it was granted. There is no expiry: a grant holds until it is deleted,
 * and revocation is deletion. The step carries structure only: it writes no
 * grant. The upgrade's authority acts write the first `admin` grant
 * (`authority-upgrade-acts.ts`). The unmounted SQLite grants snapshot reads the
 * table (`modules/operations/adapters/sqlite-grants.ts`); no mounted code does.
 *
 * What the table enforces, and `validateDatabase` checks again at 52: a known
 * role; a scope kind consistent with the role (from {@link GRANT_ROLE_SCOPES},
 * the contract's role table, kept here as a literal so production code does
 * not import the contract; a test compares the two); a project exactly when
 * the scope is a project; typed, bounded IDs; a canonical real instant; at
 * most one row per account, role and scope; existing account and project (the
 * foreign keys, checked by `PRAGMA foreign_key_check`).
 *
 * What it deliberately does not enforce: who may hold a role (`maintainer` and
 * `admin` only humans, `executor` only agents). The contract re-validates
 * every stored grant against the account's stored kind on every evaluation
 * (`grantAllowed` in the operations module), so an inconsistent row refuses
 * only itself; were it a table or startup rule, one such row would make the
 * whole installation unstartable.
 */
export const ACCOUNT_GRANTS_VERSION = 52;
/**
 * The contract's six roles and the scope kind of each (`roleDefinitions` in
 * `src/shared/contracts/operations.ts`): `admin` is the installation role,
 * every other role is a project role. A literal, compared with the contract
 * by `account-grants-migration.test.ts`.
 */
export const GRANT_ROLE_SCOPES = Object.freeze([
  ["reader", "project"], ["operator", "project"], ["maintainer", "project"], ["secrets", "project"], ["executor", "project"], ["admin", "installation"],
] as const);
export const GRANT_ROLES = Object.freeze(GRANT_ROLE_SCOPES.map(([role]) => role));
export type GrantRole = typeof GRANT_ROLES[number];
/** Fence coverage added by step 52. The frozen schema-49 list is not extended. */
export const ACCOUNT_GRANTS_SECURITY_TABLES = ["account_grants"] as const;
export const accountGrantsFenceTriggers = ACCOUNT_GRANTS_SECURITY_TABLES.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => ({
  name: `security_${table}_${event.toLowerCase()}`,
  sql: `CREATE TRIGGER security_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN SELECT worktree_security_pending(); UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32))) WHERE singleton=1; END`,
})));

/**
 * IDs as the contracts bound them (at most 160 characters), stored as text.
 * `length` and `GLOB` stop at the first NUL character, so the bytes are bounded
 * and searched for NUL as a BLOB, where neither stops (as in step 51).
 */
const idCheck = (column: string) => `typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 640 AND instr(CAST(${column} AS BLOB),X'00')=0 AND length(${column})<=160`;
const quoted = (values: readonly string[]) => values.map(value => `'${value}'`).join(",");
const scopeOf = `CASE role ${GRANT_ROLE_SCOPES.map(([role, scope]) => `WHEN '${role}' THEN '${scope}'`).join(" ")} END`;
/**
 * A rowid table without a declared key: the row's identity is the grant
 * (account, role, scope), which the unique index and the insert guard keep
 * single. `CHECK(rowid>0)` keeps an explicit rowid out of the -1 that a BEFORE
 * INSERT trigger reads for an omitted one, so the guard's rowid lookup never
 * refuses an ordinary insert.
 *
 * `granted_at` is canonical UTC with milliseconds, as `toISOString` writes it,
 * and a real instant: formatting its own Julian day must give it back (hour 24,
 * which `%H` prints back, normalises to the next day and differs), as the
 * step-51 journal requires of `recorded_at`.
 */
const table = `CREATE TABLE account_grants (
  account_id TEXT NOT NULL REFERENCES remote_principals(id) CHECK(${idCheck("account_id")}),
  role TEXT NOT NULL CHECK(role IN (${quoted(GRANT_ROLES)})),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','installation')),
  project_id TEXT REFERENCES knowledge_projects(id) CHECK(project_id IS NULL OR (${idCheck("project_id")})),
  granted_at TEXT NOT NULL CHECK(typeof(granted_at)='text' AND granted_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(granted_at))),
  CHECK(rowid>0),
  CHECK(scope_kind IS ${scopeOf}),
  CHECK((project_id IS NOT NULL)=(scope_kind='project'))
)`;
/**
 * One grant per account, role and scope. A UNIQUE constraint over the four
 * columns would not do: SQLite treats NULLs as distinct in a unique key, so
 * two installation grants (project NULL) of one account and role would both
 * be accepted (probed). The expression `ifnull(project_id,'')` makes the
 * installation scope one value; '' is never a project ID (the CHECK requires
 * at least one byte). The index also serves the lookup by account; the second
 * serves the foreign-key check when a project is deleted.
 */
const indexes = [
  "CREATE UNIQUE INDEX account_grants_key ON account_grants(account_id,role,scope_kind,ifnull(project_id,''))",
  "CREATE INDEX account_grants_project ON account_grants(project_id)",
];
/**
 * The non-fence triggers. Each refusal is RAISE(ABORT), which no conflict
 * clause of the statement that fired it can turn into IGNORE or REPLACE.
 *
 * - `insert`: an INSERT of a grant that exists (same account, role, scope
 *   kind and project, NULL included) is refused before any conflict
 *   resolution, so `INSERT OR REPLACE`, `REPLACE INTO` and an upsert cannot
 *   delete the stored row and write a new `granted_at` in its place, and
 *   `INSERT OR IGNORE` reports the duplicate instead of hiding it (probed,
 *   whatever `recursive_triggers` says). An INSERT that names the rowid of an
 *   existing row is refused too, so a replacing insert of another grant
 *   cannot delete that row by its rowid.
 * - `update`: rows are immutable; a change of a grant is a deletion and a new
 *   grant. DELETE is allowed (revocation).
 *
 * These guards hold against application defects, not against a raw rewrite of
 * the file, `DROP TRIGGER` or a restore of an older database.
 */
export const accountGrantsTriggers: ReadonlyArray<{ name: string; sql: string }> = [
  { name: "account_grants_insert", sql: "CREATE TRIGGER account_grants_insert BEFORE INSERT ON account_grants BEGIN SELECT RAISE(ABORT,'account grant already exists') WHERE EXISTS(SELECT 1 FROM account_grants WHERE account_id=NEW.account_id AND role=NEW.role AND scope_kind=NEW.scope_kind AND project_id IS NEW.project_id); SELECT RAISE(ABORT,'account grants are never replaced') WHERE EXISTS(SELECT 1 FROM account_grants WHERE rowid=NEW.rowid); END" },
  { name: "account_grants_update", sql: "CREATE TRIGGER account_grants_update BEFORE UPDATE ON account_grants BEGIN SELECT RAISE(ABORT,'account grants are immutable; revocation is deletion'); END" },
];

/** Every statement of the step, in the order it runs. */
const statements = [table, ...indexes, ...accountGrantsFenceTriggers.map(trigger => trigger.sql), ...accountGrantsTriggers.map(trigger => trigger.sql)];
/** `sql` is the complete text the step executes, in order, and the checksum covers it. */
export const accountGrantsMigration = {
  version: ACCOUNT_GRANTS_VERSION, name: "account-grants-structure",
  sql: statements.map(statement => `${statement};`).join("\n"),
};
export const accountGrantsChecksum = createHash("sha256")
  .update(`${accountGrantsMigration.version}\0${accountGrantsMigration.name}\0${accountGrantsMigration.sql}`).digest("hex");

/**
 * Safe in ordinary startup, where the schema runs before the fence registers
 * `worktree_security_pending`: the step is DDL only and writes no row (only
 * `schema_migrations`, which is not fenced, gets one).
 */
export function applyAccountGrantsMigration(database: Database.Database): void {
  // A direct call checks the step against the supported version, as initializeSchema's target does.
  schemaTarget(ACCOUNT_GRANTS_VERSION);
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=52").get()) return;
  for (const statement of statements) database.exec(statement);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(52,?,?,?)")
    .run(new Date().toISOString(), accountGrantsMigration.name, accountGrantsChecksum);
}

/**
 * Validation at 52 (see `validateDatabase`): the name of the first rule a
 * database breaks, or null. The rules are the table's own shape rules; an
 * existing account and project are the foreign-key check's. Recipient kinds
 * are not checked (see the module comment).
 */
export function accountGrantsViolation(database: Database.Database): string | null {
  // Reads the step-52 table: checks the step against the supported version first, like every operation of the step.
  schemaTarget(ACCOUNT_GRANTS_VERSION);
  const not = (column: string) => `NOT ifnull(${idCheck(column)},0)`;
  if (database.prepare(`SELECT 1 FROM account_grants WHERE rowid<=0 OR ${not("account_id")}
      OR typeof(role)<>'text' OR role NOT IN (${quoted(GRANT_ROLES)})
      OR typeof(scope_kind)<>'text' OR scope_kind NOT IN ('project','installation') OR scope_kind IS NOT ${scopeOf}
      OR (project_id IS NOT NULL)<>(scope_kind='project') OR (project_id IS NOT NULL AND ${not("project_id")})
      OR typeof(granted_at)<>'text' OR granted_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',julianday(granted_at)) LIMIT 1`).get()) return "account grant shape";
  if (database.prepare("SELECT 1 FROM account_grants GROUP BY account_id,role,scope_kind,ifnull(project_id,'') HAVING count(*)>1 LIMIT 1").get()) return "account grant duplicate";
  return null;
}

/**
 * The quarantine's step-52 statement, inside its transaction: every grant is
 * deleted, so no grant written after the upgrade survives `auth fence resume`;
 * the next upgrade grants `admin` again when its rule holds. Checks the step
 * against the supported version before it prepares any statement.
 */
export function clearAccountGrants(database: Database.Database): void {
  schemaTarget(ACCOUNT_GRANTS_VERSION);
  database.prepare("DELETE FROM account_grants").run();
}
