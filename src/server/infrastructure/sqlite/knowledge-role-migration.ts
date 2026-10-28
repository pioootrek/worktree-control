import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const knowledgeRoleMigration = {
  version: 35,
  name: "knowledge-scoped-role-bindings",
  sql: `CREATE TABLE IF NOT EXISTS knowledge_role_bindings (
    principal_id TEXT NOT NULL REFERENCES remote_principals(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE RESTRICT,
    role TEXT NOT NULL CHECK(role IN ('reader','operator','manager')),
    revision INTEGER NOT NULL CHECK(revision > 0),
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    PRIMARY KEY(principal_id, project_id)
  )`,
};
export const knowledgeRoleChecksum = createHash("sha256")
  .update(`${knowledgeRoleMigration.version}\0${knowledgeRoleMigration.name}\0${knowledgeRoleMigration.sql}`).digest("hex");

/** Runs inside the schema owner's transaction; no grants or identities are rewritten. */
export function applyKnowledgeRoleMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(knowledgeRoleMigration.version)) return;
  database.exec(knowledgeRoleMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(knowledgeRoleMigration.version, new Date().toISOString(), knowledgeRoleMigration.name, knowledgeRoleChecksum);
}
