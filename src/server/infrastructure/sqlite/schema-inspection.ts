import Database from "better-sqlite3";
import { initializeSchema } from "./migrations";

export const SUPPORTED_SCHEMA_VERSION = 27;
export interface SchemaInspection { version: number; fresh: boolean }
type Column = { name: string; type: string; notnull: number; pk: number };
type ForeignKey = { table: string; from: string; to: string; on_delete: string; on_update: string };

// Historical installations may already have tables from the bootstrap DDL. Require
// them only after their introducing migration, but validate any that are present.
const tableVersions: Record<string, number> = {
  schema_migrations: 1, projects: 1, reservations: 1, audit_events: 1,
  controller_settings: 5, controller_audit_events: 5, worktree_storage_samples: 6,
  test_runs: 10, remote_principals: 14, remote_project_identities: 14,
  remote_workers: 14, remote_principal_project_grants: 14, remote_worker_project_grants: 14,
  remote_verification_requests: 14, remote_verification_attempts: 15,
  principal_credentials: 17, knowledge_projects: 17, knowledge_project_grants: 17,
  knowledge_project_runtime_links: 17, knowledge_threads: 19, knowledge_replies: 19,
  knowledge_tasks: 19, knowledge_relations: 19, knowledge_history: 19,
  knowledge_idempotency: 19, knowledge_memories: 20, knowledge_attachments: 21,
  knowledge_import_batches: 22, knowledge_import_staging: 22, knowledge_import_sources: 22,
};
const columnVersions: Record<string, number> = {
  "projects.tls_mode": 3, "projects.tls_key_path": 3, "projects.tls_cert_path": 3, "projects.tls_ca_path": 3,
  "reservations.maximum_expires_at": 4, "reservations.token_hash": 4, "reservations.idempotency_key": 4,
  // Migration 13 explicitly supports the legacy lineage without launch_preset.
  "projects.launch_preset": 15, "projects.environment_json": 8,
  "projects.environment_profiles_json": 9, "projects.selected_environment_profile": 9,
  "projects.test_environment_profiles_json": 11, "projects.test_preset_profiles_json": 11,
  "test_runs.environment_mode": 11, "test_runs.environment_profile": 11,
  "test_runs.inherited_server_profile": 11, "test_runs.environment_variable_names_json": 11,
  "test_runs.source_json": 12, "knowledge_import_sources.target_revision": 23,
  "knowledge_import_batches.authentication_method": 26,
};
interface TableShape { columns: Column[]; foreignKeys: ForeignKey[]; checks: string[]; uniqueKeys: string[] }
function checks(sql: string): string[] {
  const result: string[] = [];
  const start = /CHECK\s*\(/gi;
  while (start.exec(sql)) {
    let depth = 1;
    let end = start.lastIndex;
    let quoted = false;
    for (; end < sql.length && depth; end++) {
      const character = sql[end];
      if (character === "'") { if (quoted && sql[end + 1] === "'") { end++; continue; } quoted = !quoted; }
      if (!quoted) { if (character === "(") depth++; if (character === ")") depth--; }
    }
    if (depth) refuse();
    result.push(sql.slice(start.lastIndex, end - 1).replace(/\s+/g, "").toLowerCase());
    start.lastIndex = end;
  }
  return result;
}
function uniqueKeys(database: Database.Database, table: string): string[] {
  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string; unique: number; partial: number }>;
  return indexes.filter(x => x.unique && !x.partial).map(x => {
    const name = x.name.replaceAll('"', '""');
    return (database.prepare(`PRAGMA index_info("${name}")`).all() as Array<{ name: string }>).map(c => c.name).join(",");
  });
}
let reference: Map<string, TableShape> | undefined;
function knownStructure(): Map<string, TableShape> {
  if (reference) return reference;
  const database = new Database(":memory:");
  try {
    initializeSchema(database);
    reference = new Map(Object.keys(tableVersions).map(table => [table, {
      columns: database.prepare(`PRAGMA table_info("${table}")`).all() as Column[],
      foreignKeys: database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as ForeignKey[],
      checks: checks((database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as {sql:string}).sql),
      uniqueKeys: uniqueKeys(database, table),
    }]));
    return reference;
  } finally { database.close(); }
}
function refuse(): never { throw new Error("Unsupported or unrecognized database schema. Use a compatible release or inspect an isolated copy; the source was not migrated."); }

/** Read-only recognition, before persistent PRAGMA, DDL or authentication setup. */
export function inspectSchema(database: Database.Database): SchemaInspection {
  if (database.pragma("application_id", {simple:true}) !== 0 || database.pragma("user_version", {simple:true}) !== 0) refuse();
  const objects = database.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; type: string }>;
  if (!objects.length) return { version: 0, fresh: true };
  if (!objects.some(x => x.type === "table" && x.name === "schema_migrations")) refuse();
  const registry = database.prepare("PRAGMA table_info(schema_migrations)").all() as Column[];
  if (registry.length !== 2 || registry[0].name !== "version" || registry[0].type !== "INTEGER" || registry[0].pk !== 1 || registry[1].name !== "applied_at" || registry[1].type !== "TEXT" || registry[1].notnull !== 1) refuse();
  const migrations = database.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all() as Array<{ version: number; applied_at: string }>;
  if (!migrations.length || migrations.length > SUPPORTED_SCHEMA_VERSION || migrations.some((x, i) => x.version !== i + 1 || typeof x.applied_at !== "string" || !x.applied_at)) refuse();
  const version = migrations.length;
  const tables = new Set(objects.filter(x => x.type === "table").map(x => x.name));
  if (objects.some(x => x.type === "view" || x.type === "trigger") || [...tables].some(x => !(x in tableVersions))) refuse();
  for (const [table, introduced] of Object.entries(tableVersions)) {
    if (!tables.has(table)) { if (version >= introduced) refuse(); continue; }
    const expected = knownStructure().get(table)!;
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Column[];
    for (const column of columns) {
      const known = expected.columns.find(x => x.name === column.name);
      if (!known || known.type !== column.type || known.pk !== column.pk || known.notnull !== column.notnull) refuse();
    }
    for (const column of expected.columns) {
      if (version >= (columnVersions[`${table}.${column.name}`] ?? introduced) && !columns.some(x => x.name === column.name)) refuse();
    }
    const actualChecks = checks((database.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as {sql:string}).sql);
    for (let check of expected.checks) {
      if (table === "remote_principals" && version < 25) check = check.replace(",'installation'", "");
      if (table === "knowledge_history" && version < 25) check = check.replace(",'installation_token','none'", "");
      if (table === "knowledge_history" && version < 20) check = check.replace(",'memory'", "").replace(",'approved','superseded'", "");
      const field = check.match(/^[a-z_]+/)?.[0];
      if (field && version < (columnVersions[`${table}.${field}`] ?? introduced)) continue;
      if (table === "reservations" && check.startsWith("(") && version < 4) continue;
      // Bootstrap may have supplied the latest constraint before this migration.
      if (!actualChecks.includes(check) && !actualChecks.includes(expected.checks.find(x => x.startsWith(field ?? check)) ?? check)) refuse();
    }
    const keys = uniqueKeys(database, table);
    if (expected.uniqueKeys.some(key => !keys.includes(key))) refuse();
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list("${table}")`).all() as ForeignKey[];
    for (const key of expected.foreignKeys) {
      if (!columns.some(x => x.name === key.from)) continue;
      if (!foreignKeys.some(x => x.table === key.table && x.from === key.from && x.to === key.to && x.on_delete === key.on_delete && x.on_update === key.on_update)) refuse();
    }
    // Migration 24 removed the old legacy_id foreign key.
    if (foreignKeys.some(key => !expected.foreignKeys.some(x => x.from === key.from && x.table === key.table) && !(table === "knowledge_import_sources" && key.from === "legacy_id" && version < 24))) refuse();
  }
  const ownershipIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_active_reservation_per_project'").get() as {sql:string}|undefined;
  if (!ownershipIndex || !/createuniqueindex(?:ifnotexists)?one_active_reservation_per_projectonreservations\(project_id\)wherereleased_atisnull/i.test(ownershipIndex.sql.replace(/\s+/g,""))) refuse();
  return { version, fresh: false };
}

export function snapshotAttachments(database: Database.Database): Array<{ sha256: string; size: number }> {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_attachments'").get()) return [];
  return database.prepare("SELECT DISTINCT sha256, size FROM knowledge_attachments ORDER BY sha256").all() as Array<{ sha256: string; size: number }>;
}
