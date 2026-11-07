import type Database from "better-sqlite3";
import { rebuildTable } from "../verification-project-migration";

const WITHOUT_AUTHENTICATION_FACTOR_TABLES = `DROP TABLE authentication_session_evidence;
  DROP TABLE authentication_factor_receipts; DROP TABLE authentication_factor_budgets; DROP TABLE authentication_factor_contexts;
  DROP TABLE authentication_passkey_staged; DROP TABLE authentication_passkey_trust; DROP TABLE authentication_totp_steps;
  DROP TABLE authentication_account_policies; DROP TABLE "authentication_ba_passkey"; DROP TABLE "authentication_ba_two_factor";`;

/**
 * Removes migration 38 from a current test database so it can be rewound to an
 * older schema. Its tables are refused before their migration, like any
 * partial provider schema.
 */
export const WITHOUT_AUTHENTICATION_PROVIDER_STORAGE = `DROP TABLE authentication_provider_subjects;
  DROP TABLE "authentication_ba_session"; DROP TABLE "authentication_ba_account";
  DROP TABLE "authentication_ba_verification"; DROP TABLE "authentication_ba_user";
  DELETE FROM schema_migrations WHERE version >= 38;`;

/** Only synthetic fixture databases; production migrations and checksums stay immutable. */
export function rewindHumanConfiguration(database: Database.Database): void {
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version=48").get()) return;
  database.exec("ALTER TABLE human_runtime_intents DROP COLUMN configuration_context_json; ALTER TABLE human_runtime_intents DROP COLUMN configuration_bound; DELETE FROM schema_migrations WHERE version=48");
  rebuildTable(database, "runtime_human_memberships", "BETWEEN 1 AND 6", "BETWEEN 1 AND 4");
}
/** Remove schema47 job attribution before earlier synthetic fixture rewinds. */
export function rewindHumanTestRuns(database: Database.Database): void {
  rewindHumanConfiguration(database);
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version=47").get()) return;
  database.exec("DROP TABLE human_test_run_intents; DROP TABLE human_test_run_requesters; ALTER TABLE test_runs DROP COLUMN provider_bound; DELETE FROM schema_migrations WHERE version=47");
  rebuildTable(database, "runtime_human_memberships", "BETWEEN 1 AND 4", "BETWEEN 1 AND 3");
}
export function rewindHumanRuntime(database: Database.Database): void {
  rewindHumanTestRuns(database);
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version=46").get()) return;
  database.exec("DROP TABLE human_runtime_intents; DROP TABLE human_runtime_leases; ALTER TABLE reservations DROP COLUMN provider_bound; DELETE FROM schema_migrations WHERE version=46");
  rebuildTable(database, "runtime_human_memberships", "CHECK(role IN ('reader','operator'))", "CHECK(role='reader')");
  // Synthetic fixtures use empty memberships. Restore the exact original CHECK.
  const sql = (database.prepare("SELECT sql FROM sqlite_master WHERE name='runtime_human_memberships'").get() as {sql:string}).sql;
  const start = sql.indexOf("CHECK(json_valid(permissions_json)"), end = sql.indexOf(",\n  revision", start);
  if (start < 0 || end < 0) throw new Error("Unknown membership fixture shape");
  rebuildTable(database, "runtime_human_memberships", sql.slice(start, end), `CHECK(permissions_json='["projects:read"]')`);
}
export function rewindGodotWeb(database: Database.Database): void {
  rewindHumanRuntime(database);
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=45").get()) {
    database.exec("DROP TABLE runtime_human_memberships; DELETE FROM schema_migrations WHERE version=45");
  }
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=44").get()) {
    database.exec("DROP TABLE test_run_requesters; DELETE FROM schema_migrations WHERE version=44");
  }
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version=43").get()) return;
  database.transaction(() => {
    database.exec("ALTER TABLE projects DROP COLUMN godot_web_json; DELETE FROM schema_migrations WHERE version=43");
  }).immediate();
}

/** Only for synthetic old-schema fixtures: an empty current schema, rewound to 39. */
export function rewindAuthenticationFactors(database: Database.Database): void {
  rewindGodotWeb(database);
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=42").get()) {
    const foreignKeys = database.pragma("foreign_keys", { simple: true });
    database.pragma("foreign_keys=OFF");
    try {
      database.transaction(() => {
        rebuildTable(database, "remote_principals", "CHECK(kind IN ('owner', 'agent', 'worker', 'installation', 'human'))", "CHECK(kind IN ('owner', 'agent', 'worker', 'installation'))");
        database.exec("DELETE FROM schema_migrations WHERE version=42");
      }).immediate();
    } finally { database.pragma(`foreign_keys=${foreignKeys ? "ON" : "OFF"}`); }
  }
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version = 41").get()) database.exec("DROP TABLE authentication_session_issuance; DELETE FROM schema_migrations WHERE version = 41;");
  if (!database.prepare("SELECT 1 FROM schema_migrations WHERE version = 40").get()) return;
  database.exec(`${WITHOUT_AUTHENTICATION_FACTOR_TABLES}
    ALTER TABLE "authentication_ba_user" DROP COLUMN "twoFactorEnabled";
    DELETE FROM schema_migrations WHERE version = 40;`);
}

/** Only for synthetic old-schema fixtures; old rows cannot contain the new method. */
export function rewindProviderSessionHistory(database: Database.Database): void {
  rewindAuthenticationFactors(database);
  rebuildTable(database, "knowledge_history",
    "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none', 'provider_session'))",
    "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none'))");
  database.exec("DELETE FROM schema_migrations WHERE version = 39");
}
