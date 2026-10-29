import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Empty, controller-owned storage for the optional Better Auth provider. The
 * four provider tables are the DDL Better Auth 1.7.14's `getMigrations`
 * compiles for its SQLite Kysely adapter with these model names and email and
 * password sign-in, frozen here: the provider never runs its own migrations.
 * The subject table maps a provider account to an existing owner principal.
 * Nothing is backfilled; no account, principal, role or grant is created.
 * Standard Better Auth sessions store their bearer token in `token`.
 */
export const authenticationProviderMigration = {
  version: 38,
  name: "authentication-provider-storage",
  sql: `CREATE TABLE "authentication_ba_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "authentication_ba_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "authentication_ba_user" ("id") on delete cascade);
CREATE TABLE "authentication_ba_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "authentication_ba_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "authentication_ba_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
CREATE INDEX "authentication_ba_session_userId_idx" on "authentication_ba_session" ("userId");
CREATE INDEX "authentication_ba_account_userId_idx" on "authentication_ba_account" ("userId");
CREATE INDEX "authentication_ba_verification_identifier_idx" on "authentication_ba_verification" ("identifier");
CREATE TABLE authentication_provider_subjects (
  provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')),
  subject TEXT NOT NULL REFERENCES "authentication_ba_user"("id") ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES remote_principals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  linked_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  PRIMARY KEY(provider_id, subject)
);
CREATE UNIQUE INDEX authentication_provider_subjects_principal
  ON authentication_provider_subjects(provider_id, principal_id) WHERE status = 'active';`,
};
export const authenticationProviderChecksum = createHash("sha256")
  .update(`${authenticationProviderMigration.version}\0${authenticationProviderMigration.name}\0${authenticationProviderMigration.sql}`).digest("hex");

/** Provider storage contract revision that migration 38 implements. */
export const AUTHENTICATION_PROVIDER_STORAGE_REVISION = 1;

/** Runs inside the schema owner's transaction after migration 37. Any pre-existing table fails it. */
export function applyAuthenticationProviderMigration(database: Database.Database): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(authenticationProviderMigration.version)) return;
  database.exec(authenticationProviderMigration.sql);
  database.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(?,?,?,?)")
    .run(authenticationProviderMigration.version, new Date().toISOString(), authenticationProviderMigration.name, authenticationProviderChecksum);
}
