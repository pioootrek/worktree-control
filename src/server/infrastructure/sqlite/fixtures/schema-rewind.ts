import type Database from "better-sqlite3";
import { rebuildTable } from "../verification-project-migration";

/**
 * Removes migration 38 from a current test database so it can be rewound to an
 * older schema. Its tables are refused before their migration, like any
 * partial provider schema.
 */
export const WITHOUT_AUTHENTICATION_PROVIDER_STORAGE = `DROP TABLE authentication_provider_subjects;
  DROP TABLE "authentication_ba_session"; DROP TABLE "authentication_ba_account";
  DROP TABLE "authentication_ba_verification"; DROP TABLE "authentication_ba_user";
  DELETE FROM schema_migrations WHERE version >= 38;`;

/** Only for synthetic old-schema fixtures; old rows cannot contain the new method. */
export function rewindProviderSessionHistory(database: Database.Database): void {
  rebuildTable(database, "knowledge_history",
    "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none', 'provider_session'))",
    "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none'))");
  database.exec("DELETE FROM schema_migrations WHERE version = 39");
}
