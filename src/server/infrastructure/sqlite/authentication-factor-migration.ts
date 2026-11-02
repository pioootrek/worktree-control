import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Frozen plugin storage plus controller-recognized account protection for the
 * optional provider. The first eight statements are exactly what Better Auth
 * 1.7.14 `getMigrations` compiles for its two-factor and passkey plugins with
 * these model names; a provider test recompiles them from a genuine schema 39.
 * The provider never runs its own migrations.
 *
 * Nothing is backfilled. An existing password account has no policy row and no
 * session evidence until it signs in again; its old sessions authorize nothing.
 * Subject-keyed rows restrict deletion, so neither a step nor a generation can
 * be reset by recreating an opaque subject.
 */
export const authenticationFactorMigration = {
  version: 40,
  name: "authentication-factor-storage",
  sql: `alter table "authentication_ba_user" add column "twoFactorEnabled" integer default 0;
create table "authentication_ba_two_factor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "authentication_ba_user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);
create table "authentication_ba_passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "authentication_ba_user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);
create index "authentication_ba_two_factor_secret_idx" on "authentication_ba_two_factor" ("secret");
create index "authentication_ba_two_factor_userId_idx" on "authentication_ba_two_factor" ("userId");
create index "authentication_ba_passkey_userId_idx" on "authentication_ba_passkey" ("userId");
create index "authentication_ba_passkey_credentialID_idx" on "authentication_ba_passkey" ("credentialID");
CREATE TABLE authentication_account_policies (
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  subject TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
  totp_selected INTEGER NOT NULL CHECK(totp_selected IN (0, 1)),
  passkey_selected INTEGER NOT NULL CHECK(passkey_selected IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider_id, subject),
  FOREIGN KEY(provider_id, subject) REFERENCES authentication_provider_subjects(provider_id, subject) ON DELETE RESTRICT
);
CREATE TABLE authentication_totp_steps (
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  subject TEXT NOT NULL,
  last_step INTEGER NOT NULL CHECK(last_step >= 0),
  PRIMARY KEY(provider_id, subject),
  FOREIGN KEY(provider_id, subject) REFERENCES authentication_provider_subjects(provider_id, subject) ON DELETE RESTRICT
);
CREATE TABLE authentication_passkey_trust (
  credential_id TEXT NOT NULL PRIMARY KEY,
  native_id TEXT NOT NULL UNIQUE REFERENCES "authentication_ba_passkey" ("id") ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  subject TEXT NOT NULL,
  handle TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  verified_uv INTEGER NOT NULL CHECK(verified_uv = 1),
  trusted_at TEXT NOT NULL,
  FOREIGN KEY(provider_id, subject) REFERENCES authentication_provider_subjects(provider_id, subject) ON DELETE RESTRICT
);
CREATE TABLE authentication_passkey_staged (
  credential_id TEXT NOT NULL PRIMARY KEY,
  native_id TEXT NOT NULL UNIQUE REFERENCES "authentication_ba_passkey" ("id") ON DELETE CASCADE,
  capability TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  subject TEXT NOT NULL,
  handle TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  generation INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  original_deadline TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  FOREIGN KEY(provider_id, subject) REFERENCES authentication_provider_subjects(provider_id, subject) ON DELETE RESTRICT
);
CREATE TABLE authentication_factor_contexts (
  capability TEXT NOT NULL PRIMARY KEY,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  purpose TEXT NOT NULL CHECK(purpose IN ('totp_enrollment', 'totp_login', 'passkey_registration', 'passkey_confirmation', 'passkey_authentication')),
  subject TEXT,
  principal_id TEXT,
  session_id TEXT,
  native_id TEXT,
  handle TEXT,
  credential TEXT,
  binding TEXT,
  generation INTEGER,
  policy_revision INTEGER,
  authenticated_at TEXT,
  original_deadline TEXT,
  deadline INTEGER NOT NULL,
  used INTEGER NOT NULL CHECK(used IN (0, 1))
);
CREATE INDEX authentication_factor_contexts_deadline ON authentication_factor_contexts(deadline);
CREATE TABLE authentication_factor_budgets (
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  scope TEXT NOT NULL CHECK(scope IN ('totp', 'passkey')),
  subject TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  charged INTEGER NOT NULL CHECK(charged >= 1),
  PRIMARY KEY(provider_id, scope, subject, epoch)
);
CREATE TABLE authentication_factor_receipts (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  capability TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('totp_enrollment', 'totp_login', 'passkey_registration', 'passkey_confirmation', 'passkey_authentication')),
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  credential TEXT,
  binding TEXT,
  generation INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('charged', 'succeeded', 'failed')),
  session_id TEXT
);
CREATE INDEX authentication_factor_receipts_capability ON authentication_factor_receipts(capability, state);
CREATE TABLE authentication_session_evidence (
  session_id TEXT NOT NULL PRIMARY KEY REFERENCES "authentication_ba_session" ("id") ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  subject TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('password', 'password_totp', 'passkey_uv')),
  authenticated_at TEXT NOT NULL,
  original_deadline TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
  credential TEXT,
  credential_binding TEXT,
  attempt_id TEXT NOT NULL UNIQUE,
  CHECK(authenticated_at < original_deadline),
  CHECK((method = 'password' AND credential IS NULL AND credential_binding IS NULL)
    OR (method <> 'password' AND credential IS NOT NULL AND credential_binding IS NOT NULL)),
  FOREIGN KEY(provider_id, subject) REFERENCES authentication_provider_subjects(provider_id, subject) ON DELETE RESTRICT
);
CREATE INDEX authentication_session_evidence_subject ON authentication_session_evidence(provider_id, subject);`,
};
export const authenticationFactorChecksum = createHash("sha256")
  .update(`${authenticationFactorMigration.version}\0${authenticationFactorMigration.name}\0${authenticationFactorMigration.sql}`).digest("hex");

/** Joins the sole owner's ordered schema transaction after migration 39. Any pre-existing table fails it. */
export function applyAuthenticationFactorMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(authenticationFactorMigration.version)) return;
  database.exec(authenticationFactorMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(authenticationFactorMigration.version, new Date().toISOString(), authenticationFactorMigration.name, authenticationFactorChecksum);
}
