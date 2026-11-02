import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Durable ownership of every session minted from this version on. A row is
 * written in the transaction that creates its native session and evidence.
 * `pending` means no publication was permitted, so an ordinary restart may
 * delete the session. `may_publish` means a cookie may have left: it says nothing
 * about receipt, and the row stays until its deadline or an authorized revocation.
 *
 * Nothing is backfilled. A session without a row predates this table: it is
 * unclassified, never an orphan, and never deleted by inference. The deadline
 * copy serves bounded expiry only. It equals the evidence's immutable deadline
 * and grants nothing.
 */
export const authenticationSessionIssuanceMigration = {
  version: 41,
  name: "authentication-session-issuance",
  sql: `CREATE TABLE authentication_session_issuance (
  session_id TEXT NOT NULL PRIMARY KEY REFERENCES authentication_session_evidence(session_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending', 'may_publish')),
  original_deadline TEXT NOT NULL
);
CREATE INDEX authentication_session_issuance_state ON authentication_session_issuance(state, session_id);
CREATE INDEX authentication_session_issuance_deadline ON authentication_session_issuance(state, original_deadline, session_id);`,
};
export const authenticationSessionIssuanceChecksum = createHash("sha256")
  .update(`${authenticationSessionIssuanceMigration.version}\0${authenticationSessionIssuanceMigration.name}\0${authenticationSessionIssuanceMigration.sql}`).digest("hex");

/** Joins the sole owner's ordered schema transaction after migration 40. Any pre-existing table fails it. */
export function applyAuthenticationSessionIssuanceMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(authenticationSessionIssuanceMigration.version)) return;
  database.exec(authenticationSessionIssuanceMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(authenticationSessionIssuanceMigration.version, new Date().toISOString(), authenticationSessionIssuanceMigration.name, authenticationSessionIssuanceChecksum);
}
