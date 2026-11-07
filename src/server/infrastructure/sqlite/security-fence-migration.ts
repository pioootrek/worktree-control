import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/** Frozen schema49 coverage. New authority tables must extend this in a later migration. */
export const SECURITY_TABLES = [
  "reservations", "test_runs", "human_runtime_leases", "human_runtime_intents", "human_test_run_requesters", "human_test_run_intents", "test_run_requesters",
  "remote_verification_requests", "remote_verification_attempts", "remote_verification_cancellations", "remote_verification_reports", "remote_worker_receipts",
  "projects", "knowledge_projects", "controller_settings", "remote_principals", "principal_credentials", "remote_workers",
  "remote_project_identities", "remote_principal_project_grants", "remote_worker_project_grants",
  "knowledge_project_grants", "knowledge_role_bindings", "knowledge_project_runtime_links",
  "runtime_delegations", "runtime_credential_scopes", "runtime_human_memberships",
  "authentication_provider_subjects", "authentication_ba_user", "authentication_ba_account",
  "authentication_ba_session", "authentication_ba_verification", "authentication_ba_two_factor",
  "authentication_ba_passkey", "authentication_account_policies", "authentication_totp_steps",
  "authentication_passkey_trust", "authentication_passkey_staged", "authentication_factor_contexts",
  "authentication_factor_budgets", "authentication_factor_receipts", "authentication_session_evidence",
  "authentication_session_issuance", "dev_environment_vaults",
] as const;
export const securityTriggers = SECURITY_TABLES.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => ({
  name: `security_${table}_${event.toLowerCase()}`,
  sql: `CREATE TRIGGER security_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN SELECT worktree_security_pending(); UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32))) WHERE singleton=1; END`,
})));
export const securityFenceMigration = {
  version: 49, name: "external-security-checkpoint",
  sql: `CREATE TABLE security_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation TEXT NOT NULL CHECK(length(installation)=64 AND installation NOT GLOB '*[^0-9a-f]*'),
  epoch TEXT NOT NULL CHECK(length(epoch)=64 AND epoch NOT GLOB '*[^0-9a-f]*')
);
INSERT INTO security_checkpoint VALUES(1,lower(hex(randomblob(32))),lower(hex(randomblob(32))));
${securityTriggers.map(trigger => `${trigger.sql};`).join("\n")}`,
};
export const securityFenceChecksum = createHash("sha256")
  .update(`${securityFenceMigration.version}\0${securityFenceMigration.name}\0${securityFenceMigration.sql}`).digest("hex");
export function applySecurityFenceMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=49").get()) return;
  database.exec(securityFenceMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(49,?,?,?)")
    .run(new Date().toISOString(), securityFenceMigration.name, securityFenceChecksum);
}
