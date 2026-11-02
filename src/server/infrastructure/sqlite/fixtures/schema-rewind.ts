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

/** Only for synthetic old-schema fixtures: an empty current schema, rewound to 39. */
export function rewindAuthenticationFactors(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=42").get()) {
    rebuildTable(database, "remote_principals", "CHECK(kind IN ('owner', 'agent', 'worker', 'installation', 'human'))", "CHECK(kind IN ('owner', 'agent', 'worker', 'installation'))");
    database.exec("DELETE FROM schema_migrations WHERE version=42");
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
