import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { schemaTarget } from "./migration-registry";

/**
 * Provisional step 51 (integration branch): the structure of project mapping.
 * It is applied and recognised only with an explicit schema target of 51 and
 * the provisional switch on; the supported version stays 49, and this step may
 * still change until the release candidate.
 *
 * `knowledge_projects` is the project (a `ProjectId`); `projects` is the
 * registration of a repository on this machine (a `RegistrationId`), and
 * `remote_project_identities` is a project as remote workers know it. The step
 * gives both of the latter a nullable parent project and two stamps, adds the
 * installation-wide mapping clock that issues the stamps, and the decision
 * journal of the later upgrade acts. It carries structure only: it creates no
 * project, sets no parent, stamps no existing row and writes no journal row.
 * Rows that exist when it runs keep 0 in both stamps until an act (or the
 * quarantine) stamps them.
 *
 * Stamps, all issued by the clock (increment, then use):
 * - `incarnation`: the clock value of the row's creation, never changed after
 *   it is stamped; 0 means the row predates the step and is not stamped yet.
 *   Deleting a row and creating another with the same ID gives a new, larger
 *   incarnation, so a stamp is never repeated for one ID. Non-zero
 *   incarnations are unique within each table, enforced when one is written.
 * - `mapping_version`: the clock value of the row's creation or of its last
 *   mapping change (parent set or cleared); 0 means not stamped yet.
 *
 * Within one linear history of the database the clock only advances, so the
 * values it issues are increasing. A stamp is a value the clock has issued, not
 * necessarily a fresh one: the guards let a mapping version be set to the
 * clock's current value, which another row may already carry, and an unstamped
 * row's incarnation to any issued value no other row of its table holds. A restore of an
 * older database rewinds the clock with everything else and it may then issue
 * values it issued before; the quarantine (`auth fence resume`) is the recovery
 * boundary, and it re-stamps every row.
 */
export const PROJECT_MAPPING_VERSION = 51;
/** The clock's bound: every stamp is a safe integer. */
export const MAPPING_CLOCK_MAX = Number.MAX_SAFE_INTEGER;
/** The tables whose rows carry a parent project and the stamps. */
export const MAPPED_TABLES = ["projects", "remote_project_identities"] as const;
export type MappedTable = typeof MAPPED_TABLES[number];
/** Fence coverage added by step 51. The frozen schema-49 list is not extended. */
export const PROJECT_MAPPING_SECURITY_TABLES = ["project_mapping_clock", "project_mapping_journal"] as const;
export const projectMappingFenceTriggers = PROJECT_MAPPING_SECURITY_TABLES.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => ({
  name: `security_${table}_${event.toLowerCase()}`,
  sql: `CREATE TRIGGER security_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN SELECT worktree_security_pending(); UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32))) WHERE singleton=1; END`,
})));

const MAX = String(MAPPING_CLOCK_MAX);
const clockTable = `CREATE TABLE project_mapping_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value BETWEEN 0 AND ${MAX})
)`;
const clockRow = "INSERT INTO project_mapping_clock(singleton,value) VALUES(1,0)";

const HEX = "[0-9a-f]";
/** A lowercase UUID, as `randomUUID` writes the run receipt. */
const UUID_GLOB = `${HEX.repeat(8)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(12)}`;
/**
 * IDs as the contracts bound them (at most 160 characters), stored as text.
 * `length` and `GLOB` stop at the first NUL character, so the bytes are bounded
 * and searched for NUL as a BLOB, where neither stops.
 */
const idCheck = (column: string) => `typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 640 AND instr(CAST(${column} AS BLOB),X'00')=0 AND length(${column})<=160`;
/**
 * The decision journal, written only by the later upgrade acts (none exists
 * yet). One row records that a subject (a registration or a remote identity,
 * by ID and the incarnation it had then) was mapped to a project, on which
 * basis, by which plan and run. It has no foreign keys: the history outlives a
 * removed registration.
 *
 * Append-only by trigger: UPDATE and DELETE are refused, and so is an INSERT
 * with an explicit sequence that is not above every existing one. That covers
 * every replacing form (`INSERT OR REPLACE`, `REPLACE INTO`, an upsert),
 * whatever `recursive_triggers` says (the primary key is the only unique key),
 * and an insert into an earlier hole, so sequence order is append order: the
 * later acts read a subject's latest record by the largest sequence. In a
 * BEFORE INSERT trigger an omitted or NULL sequence reads as -1, which the
 * guard lets through to AUTOINCREMENT; an explicit -1 then fails the CHECK.
 * What remains possible: an explicit sequence above the last one (a gap, which
 * moves `sqlite_sequence` on); AUTOINCREMENT then continues above it. An
 * INSERT must also name an incarnation the clock has issued (at most its
 * current value; a non-integer is left to the CHECK).
 *
 * `recorded_at` is canonical UTC with milliseconds, as `toISOString` writes
 * it, and a real instant: formatting the value's own Julian day must give the
 * value back. The plain `strftime(..., recorded_at)` comparison is not enough,
 * because SQLite's parser accepts hour 24 and `%H` prints it back; the Julian
 * day normalises it to the next day, so it differs.
 *
 * These guards hold against application defects, not against a raw rewrite of
 * the file, `DROP TRIGGER`, a write to `sqlite_sequence` (raising it leaves a
 * gap; AUTOINCREMENT never issues a value at or below the largest existing
 * sequence) or a restore of an older database. `sequence` is an order of
 * records, not a version: it can be rewound by a restore like everything else.
 */
const journalTable = `CREATE TABLE project_mapping_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence>0),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('registration','remote_identity')),
  subject_id TEXT NOT NULL CHECK(${idCheck("subject_id")}),
  subject_incarnation INTEGER NOT NULL CHECK(typeof(subject_incarnation)='integer' AND subject_incarnation BETWEEN 1 AND ${MAX}),
  project_id TEXT NOT NULL CHECK(${idCheck("project_id")}),
  basis TEXT NOT NULL CHECK(basis IN ('created_project','accepted_link','accepted_binding','journal_reuse')),
  plan_hash TEXT NOT NULL CHECK(typeof(plan_hash)='text' AND length(plan_hash)=64 AND length(CAST(plan_hash AS BLOB))=64 AND NOT plan_hash GLOB '*[^0-9a-f]*'),
  run_receipt TEXT NOT NULL CHECK(typeof(run_receipt)='text' AND length(CAST(run_receipt AS BLOB))=36 AND run_receipt GLOB '${UUID_GLOB}'),
  recorded_at TEXT NOT NULL CHECK(typeof(recorded_at)='text' AND recorded_at IS strftime('%Y-%m-%dT%H:%M:%fZ',julianday(recorded_at))),
  CHECK(basis IN ('created_project','journal_reuse') OR (basis='accepted_link' AND subject_kind='registration') OR (basis='accepted_binding' AND subject_kind='remote_identity'))
)`;
/** The lookups of the later acts: a subject's records in order, and a project's records by basis. */
const journalIndexes = [
  "CREATE INDEX project_mapping_journal_subject ON project_mapping_journal(subject_kind,subject_id,sequence)",
  "CREATE INDEX project_mapping_journal_project ON project_mapping_journal(project_id,basis,sequence)",
];

/** The column definitions step 51 adds to each mapped table, in order. */
export const PROJECT_MAPPING_COLUMN_DEFINITIONS = [
  "parent_project_id TEXT REFERENCES knowledge_projects(id)",
  `incarnation INTEGER NOT NULL DEFAULT 0 CHECK(incarnation BETWEEN 0 AND ${MAX} AND typeof(incarnation)='integer')`,
  `mapping_version INTEGER NOT NULL DEFAULT 0 CHECK(mapping_version BETWEEN 0 AND ${MAX} AND typeof(mapping_version)='integer')`,
] as const;
/**
 * The exact end of a mapped table's CREATE text once step 51 has run: SQLite
 * inserts each added definition, after a comma, before the closing parenthesis.
 * The tables were created and rebuilt by earlier steps, so only this end is
 * the step's own text.
 */
export const PROJECT_MAPPING_COLUMN_SUFFIX = `${PROJECT_MAPPING_COLUMN_DEFINITIONS.map(column => `, ${column}`).join("")})`;
const columns = MAPPED_TABLES.flatMap(table => PROJECT_MAPPING_COLUMN_DEFINITIONS.map(column => `ALTER TABLE ${table} ADD COLUMN ${column}`));

const CLOCK = "(SELECT value FROM project_mapping_clock WHERE singleton=1)";
/**
 * The non-fence triggers of step 51. Each refusal is RAISE(ABORT), which no
 * conflict clause of the statement that fired it can turn into IGNORE or
 * REPLACE: inside a trigger SQLite applies the outer statement's conflict
 * algorithm to the trigger's own statements, so an `INSERT OR IGNORE` would
 * otherwise skip a failing clock update and reuse a stamp.
 *
 * Per mapped table:
 * - `unstamped_insert`: an INSERT supplies no stamp of its own (both stay 0),
 *   so every stamp comes from the clock.
 * - `stamp`: after an INSERT, advances the clock and stamps both columns of
 *   the new row with the new value. It refuses at an exhausted clock, never
 *   wraps, and checks that the stamp landed. `changes` and `lastInsertRowid`
 *   of the INSERT are its own: a trigger's statements count in neither. Each
 *   row of a multi-row INSERT gets its own advance. The postcondition cannot
 *   fail through the genuine schema (no constraint the stamp could break is
 *   skippable by a conflict clause, and recognition refuses any other trigger
 *   in the file); a connection's TEMP trigger, which the file does not hold,
 *   can skip or undo the stamp, and then it refuses.
 * - `incarnation`: an incarnation changes only from 0 to a value issued by the
 *   clock (at most its current value), together with a mapping version no
 *   smaller than it, and only to a value no other row of the table holds. Each
 *   row's BEFORE trigger sees the rows its statement has already changed, so
 *   one statement that gives several rows the same value fails as a whole. A
 *   unique index would not do: under `UPDATE OR REPLACE` it deletes the row
 *   that holds the value. The lookup scans the table (there is no index on
 *   `incarnation`); it runs once per stamped row, which is bounded by the
 *   registrations and identities of one machine.
 * - `version`: a changed mapping version must be larger than before and equal
 *   to the clock's current value (a fresh stamp); a changed parent requires a
 *   larger mapping version; an unstamped row keeps mapping version 0 unless the
 *   same statement stamps its incarnation. An UPDATE that changes neither the
 *   parent nor the mapping version (an unrelated column) passes.
 *
 * The clock: its one row is written before these triggers exist; afterwards it
 * only advances, and no row is inserted or deleted. The journal: append-only
 * in sequence order, and bounded by the clock (see its table).
 */
const mappedTriggers = (table: MappedTable) => [
  { name: `project_mapping_${table}_unstamped_insert`, sql: `CREATE TRIGGER project_mapping_${table}_unstamped_insert BEFORE INSERT ON ${table} WHEN NEW.incarnation IS NOT 0 OR NEW.mapping_version IS NOT 0 BEGIN SELECT RAISE(ABORT,'project mapping stamps are issued only by the mapping clock'); END` },
  { name: `project_mapping_${table}_stamp`, sql: `CREATE TRIGGER project_mapping_${table}_stamp AFTER INSERT ON ${table} WHEN NEW.incarnation=0 BEGIN SELECT RAISE(ABORT,'project mapping clock exhausted') WHERE NOT ifnull(${CLOCK}<${MAX},0); UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1; UPDATE ${table} SET incarnation=${CLOCK},mapping_version=${CLOCK} WHERE rowid=NEW.rowid; SELECT RAISE(ABORT,'project mapping stamp failed') WHERE (SELECT incarnation FROM ${table} WHERE rowid=NEW.rowid) IS NOT ${CLOCK}; END` },
  // The row being changed still holds 0 when the second check runs, so it never finds itself.
  { name: `project_mapping_${table}_incarnation`, sql: `CREATE TRIGGER project_mapping_${table}_incarnation BEFORE UPDATE ON ${table} WHEN NEW.incarnation IS NOT OLD.incarnation BEGIN SELECT RAISE(ABORT,'project mapping incarnation is immutable') WHERE NOT ifnull(OLD.incarnation=0 AND NEW.incarnation>0 AND NEW.incarnation<=${CLOCK} AND NEW.mapping_version>=NEW.incarnation,0); SELECT RAISE(ABORT,'project mapping incarnation is already issued') WHERE EXISTS(SELECT 1 FROM ${table} WHERE incarnation=NEW.incarnation); END` },
  { name: `project_mapping_${table}_version`, sql: `CREATE TRIGGER project_mapping_${table}_version BEFORE UPDATE ON ${table} WHEN (NEW.mapping_version IS NOT OLD.mapping_version AND NOT ifnull(NEW.mapping_version>OLD.mapping_version AND NEW.mapping_version=${CLOCK},0)) OR (NEW.parent_project_id IS NOT OLD.parent_project_id AND NOT ifnull(NEW.mapping_version>OLD.mapping_version,0)) OR (NEW.incarnation IS OLD.incarnation AND OLD.incarnation=0 AND NEW.mapping_version IS NOT 0) BEGIN SELECT RAISE(ABORT,'project mapping version must advance with the clock'); END` },
];
export const projectMappingTriggers: ReadonlyArray<{ name: string; sql: string }> = [
  ...MAPPED_TABLES.flatMap(mappedTriggers),
  { name: "project_mapping_clock_advance", sql: "CREATE TRIGGER project_mapping_clock_advance BEFORE UPDATE ON project_mapping_clock WHEN NOT ifnull(NEW.singleton=OLD.singleton AND NEW.value>OLD.value,0) BEGIN SELECT RAISE(ABORT,'project mapping clock only advances'); END" },
  { name: "project_mapping_clock_insert", sql: "CREATE TRIGGER project_mapping_clock_insert BEFORE INSERT ON project_mapping_clock BEGIN SELECT RAISE(ABORT,'project mapping clock has one row'); END" },
  { name: "project_mapping_clock_delete", sql: "CREATE TRIGGER project_mapping_clock_delete BEFORE DELETE ON project_mapping_clock BEGIN SELECT RAISE(ABORT,'project mapping clock has one row'); END" },
  { name: "project_mapping_journal_insert", sql: `CREATE TRIGGER project_mapping_journal_insert BEFORE INSERT ON project_mapping_journal BEGIN SELECT RAISE(ABORT,'project mapping journal is append-only') WHERE NEW.sequence IS NOT -1 AND NEW.sequence<=ifnull((SELECT max(sequence) FROM project_mapping_journal),0); SELECT RAISE(ABORT,'project mapping journal records only issued incarnations') WHERE typeof(NEW.subject_incarnation)='integer' AND NOT ifnull(NEW.subject_incarnation<=${CLOCK},0); END` },
  { name: "project_mapping_journal_update", sql: "CREATE TRIGGER project_mapping_journal_update BEFORE UPDATE ON project_mapping_journal BEGIN SELECT RAISE(ABORT,'project mapping journal is append-only'); END" },
  { name: "project_mapping_journal_delete", sql: "CREATE TRIGGER project_mapping_journal_delete BEFORE DELETE ON project_mapping_journal BEGIN SELECT RAISE(ABORT,'project mapping journal is append-only'); END" },
];

/** Every statement of the step, in the order it runs. */
const statements = [clockTable, clockRow, journalTable, ...journalIndexes, ...columns,
  ...projectMappingFenceTriggers.map(trigger => trigger.sql), ...projectMappingTriggers.map(trigger => trigger.sql)];
/** `sql` is the complete text the step executes, in order, and the checksum covers it. */
export const projectMappingMigration = {
  version: PROJECT_MAPPING_VERSION, name: "project-mapping-structure",
  sql: statements.map(statement => `${statement};`).join("\n"),
};
export const projectMappingChecksum = createHash("sha256")
  .update(`${projectMappingMigration.version}\0${projectMappingMigration.name}\0${projectMappingMigration.sql}`).digest("hex");

/**
 * Safe in ordinary startup, where the schema runs before the fence registers
 * `worktree_security_pending`: the clock row is written before the clock's
 * triggers exist, and everything else is DDL. `ALTER TABLE ADD COLUMN` on the
 * fenced `projects` and `remote_project_identities` fires no trigger, and the
 * step stamps no existing row (only `schema_migrations`, which is not fenced,
 * gets a row).
 */
export function applyProjectMappingMigration(database: Database.Database): void {
  // A direct call passes the provisional gate too, not only initializeSchema's target.
  schemaTarget(PROJECT_MAPPING_VERSION);
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=51").get()) return;
  for (const statement of statements) database.exec(statement);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(51,?,?,?)")
    .run(new Date().toISOString(), projectMappingMigration.name, projectMappingChecksum);
}

/**
 * Validation at 51 (see `validateDatabase`): the name of the first rule a
 * database breaks, or null.
 */
export function projectMappingViolation(database: Database.Database): string | null {
  // Reads step-51 tables: passes the provisional gate first, like every operation of the step.
  schemaTarget(PROJECT_MAPPING_VERSION);
  const clock = database.prepare("SELECT singleton,value,typeof(value) AS type FROM project_mapping_clock LIMIT 2").all() as Array<{ singleton: unknown; value: unknown; type: string }>;
  if (clock.length !== 1 || clock[0].singleton !== 1 || clock[0].type !== "integer" || !Number.isSafeInteger(clock[0].value) || (clock[0].value as number) < 0) return "project mapping clock";
  const value = clock[0].value as number;
  for (const table of MAPPED_TABLES) {
    // Stamps: safe integers from 0 to the clock, both 0 or both issued, the
    // version no smaller than the incarnation, and a parent only on a stamped row.
    if (database.prepare(`SELECT 1 FROM ${table} WHERE typeof(incarnation)<>'integer' OR typeof(mapping_version)<>'integer'
      OR incarnation<0 OR mapping_version<0 OR incarnation>? OR mapping_version>? OR mapping_version<incarnation
      OR (incarnation=0)<>(mapping_version=0) OR (parent_project_id IS NOT NULL AND incarnation=0) LIMIT 1`).get(value, value)) return "project mapping stamps";
    if (database.prepare(`SELECT 1 FROM ${table} WHERE incarnation<>0 GROUP BY incarnation HAVING count(*)>1 LIMIT 1`).get()) return "project mapping incarnation";
    // The foreign-key check covers this too; it is stated here as the mapping's own rule.
    if (database.prepare(`SELECT 1 FROM ${table} t WHERE t.parent_project_id IS NOT NULL AND (typeof(t.parent_project_id)<>'text'
      OR NOT EXISTS(SELECT 1 FROM knowledge_projects k WHERE k.id=t.parent_project_id)) LIMIT 1`).get()) return "project mapping parent";
  }
  const id = (column: string) => `typeof(${column})<>'text' OR length(CAST(${column} AS BLOB)) NOT BETWEEN 1 AND 640 OR instr(CAST(${column} AS BLOB),X'00')<>0 OR length(${column})>160`;
  if (database.prepare(`SELECT 1 FROM project_mapping_journal WHERE typeof(sequence)<>'integer' OR sequence<=0
      OR sequence>ifnull((SELECT seq FROM sqlite_sequence WHERE name='project_mapping_journal'),0)
      OR typeof(subject_kind)<>'text' OR subject_kind NOT IN ('registration','remote_identity')
      OR typeof(basis)<>'text' OR basis NOT IN ('created_project','accepted_link','accepted_binding','journal_reuse')
      OR (basis='accepted_link' AND subject_kind<>'registration') OR (basis='accepted_binding' AND subject_kind<>'remote_identity')
      OR ${id("subject_id")} OR ${id("project_id")}
      OR typeof(subject_incarnation)<>'integer' OR subject_incarnation<1 OR subject_incarnation>?
      OR typeof(plan_hash)<>'text' OR length(plan_hash)<>64 OR length(CAST(plan_hash AS BLOB))<>64 OR plan_hash GLOB '*[^0-9a-f]*'
      OR typeof(run_receipt)<>'text' OR length(CAST(run_receipt AS BLOB))<>36 OR NOT run_receipt GLOB '${UUID_GLOB}'
      OR typeof(recorded_at)<>'text' OR recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',julianday(recorded_at)) LIMIT 1`).get(value)) return "project mapping journal";
  return null;
}

/** What the quarantine stamps: the clock before it, and the value it advances to. */
export interface MappingQuarantine { readonly base: number; readonly final: number; readonly unstamped: Readonly<Record<MappedTable, number>> }

/**
 * Reads what the quarantine of `auth fence resume` will stamp, or null when
 * the clock cannot advance: it is missing, malformed, behind a stamp, or would
 * pass {@link MAPPING_CLOCK_MAX}. Writes nothing. Passes the provisional gate
 * before it reads anything.
 *
 * Every row ends with mapping version `final`, the clock's new value. A row not
 * stamped yet also gets an incarnation of its own, from `base + 1` up, so no
 * two rows share one; the clock therefore advances by the number of unstamped
 * rows, and by one when there are none.
 */
export function planMappingQuarantine(database: Database.Database): MappingQuarantine | null {
  schemaTarget(PROJECT_MAPPING_VERSION);
  const clock = database.prepare("SELECT value,typeof(value) AS type FROM project_mapping_clock WHERE singleton=1").all() as Array<{ value: unknown; type: string }>;
  if (clock.length !== 1 || clock[0].type !== "integer" || !Number.isSafeInteger(clock[0].value) || (clock[0].value as number) < 0) return null;
  const base = clock[0].value as number;
  const unstamped = {} as Record<MappedTable, number>;
  for (const table of MAPPED_TABLES) {
    if (database.prepare(`SELECT 1 FROM ${table} WHERE typeof(incarnation)<>'integer' OR typeof(mapping_version)<>'integer'
      OR incarnation<0 OR mapping_version<incarnation OR mapping_version>? LIMIT 1`).get(base)) return null;
    unstamped[table] = database.prepare(`SELECT count(*) FROM ${table} WHERE incarnation=0`).pluck().get() as number;
  }
  const final = base + Math.max(1, unstamped.projects + unstamped.remote_project_identities);
  if (!Number.isSafeInteger(final) || final > MAPPING_CLOCK_MAX) return null;
  return { base, final, unstamped };
}

/**
 * The quarantine's mapping statements, inside its transaction: advance the
 * clock to `final`; stamp every unstamped row (its own incarnation, version
 * `final`); clear every parent and set every other row's version to `final`.
 * Incarnations already issued, `knowledge_projects` and the journal stay as
 * they are. The guard triggers permit exactly this: the new incarnations are
 * distinct and above every issued one. Passes the provisional gate before it
 * prepares any statement.
 */
export function applyMappingQuarantine(database: Database.Database, plan: MappingQuarantine): void {
  schemaTarget(PROJECT_MAPPING_VERSION);
  database.prepare("UPDATE project_mapping_clock SET value=? WHERE singleton=1").run(plan.final);
  let offset = plan.base;
  for (const table of MAPPED_TABLES) {
    database.prepare(`UPDATE ${table} SET incarnation=?+u.n,mapping_version=?,parent_project_id=NULL
      FROM (SELECT rowid AS r,row_number() OVER (ORDER BY rowid) AS n FROM ${table} WHERE incarnation=0) AS u WHERE ${table}.rowid=u.r`).run(offset, plan.final);
    offset += plan.unstamped[table];
    database.prepare(`UPDATE ${table} SET parent_project_id=NULL,mapping_version=? WHERE mapping_version<>?`).run(plan.final, plan.final);
  }
}
