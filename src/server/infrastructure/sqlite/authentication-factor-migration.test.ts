import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { openControllerStore } from "@/server/controller-storage";
import { authenticationFactorChecksum, authenticationFactorMigration } from "./authentication-factor-migration";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SqliteStateStore } from "./sqlite-state-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const FACTOR_TABLES = ["authentication_account_policies", "authentication_ba_passkey", "authentication_ba_two_factor", "authentication_factor_budgets", "authentication_factor_contexts",
  "authentication_factor_receipts", "authentication_passkey_staged", "authentication_passkey_trust", "authentication_session_evidence", "authentication_totp_steps"];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "auth-factor-migration-")); roots.push(root);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  return { root, path: join(root, "data", "state.sqlite3") };
}
function raw<T>(path: string, operation: (db: Database.Database) => T): T {
  const db = new Database(path); try { return operation(db); } finally { db.close(); }
}
/** A genuine schema 39 holding a password account, a live session and a grant. */
function genuine39() {
  const f = directory();
  raw(f.path, db => {
    db.exec(readFileSync(new URL("./fixtures/schema-v39.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO remote_principals VALUES('owner','owner','active');
      INSERT INTO knowledge_projects VALUES('kept','Kept','active',1,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');
      INSERT INTO knowledge_project_grants VALUES('owner','kept','["knowledge:read"]',NULL);
      INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES('subject','Owner','owner@fixture.invalid',0,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');
      INSERT INTO "authentication_ba_account"("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES('account','subject','credential','subject','hash','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');
      INSERT INTO "authentication_ba_session"("id","expiresAt","token","createdAt","updatedAt","userId") VALUES('session','2099-01-01T00:00:00.000Z','token','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z','subject');
      INSERT INTO authentication_provider_subjects VALUES('better-auth','subject','owner','active','2026-10-28T00:00:00.000Z',NULL);`);
  });
  return f;
}
const preserved = (db: Database.Database) => Object.fromEntries(["remote_principals", "knowledge_project_grants", "authentication_provider_subjects", "authentication_ba_session", "authentication_ba_account"]
  .map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
const factorTables = (db: Database.Database) => (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${FACTOR_TABLES.map(() => "?").join(",")}) ORDER BY name`).all(...FACTOR_TABLES) as Array<{ name: string }>).map(({ name }) => name);

/** Valid rows for one selected account, written through the same SQL shapes as the adapter. */
const authority = `INSERT INTO "authentication_ba_two_factor"("id","secret","backupCodes","userId","verified") VALUES('factor','ciphertext','codes','subject',1);
  UPDATE "authentication_ba_user" SET "twoFactorEnabled"=1;
  INSERT INTO authentication_account_policies VALUES('better-auth','subject',2,2,1,0,'2026-11-02T00:00:00.000Z');
  INSERT INTO authentication_totp_steps VALUES('better-auth','subject',59788416);
  INSERT INTO authentication_session_evidence VALUES('session','better-auth','subject','password_totp','2026-11-02T00:00:00.000Z','2026-11-02T08:00:00.000Z',2,2,'factor','digest','attempt');`;

describe("authentication factor migration 40", () => {
  it("creates recognized empty storage on a fresh database", () => {
    const f = directory(), store = new SqliteStateStore(f.path);
    try {
      expect(store.schemaVersion()).toBe(47);
      expect(store.authenticationProviderStorage().storageRevision).toBe(3);
    } finally { store.close(); }
    raw(f.path, db => {
      expect(inspectSchema(db)).toEqual({ version: 47, fresh: false });
      expect(factorTables(db)).toEqual(FACTOR_TABLES);
      for (const table of FACTOR_TABLES) expect(db.prepare(`SELECT count(*) n FROM "${table}"`).get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=40").get()).toEqual({ name: authenticationFactorMigration.name, checksum: authenticationFactorChecksum });
    });
  });

  it("upgrades genuine 39 atomically after a verified backup, preserving rows and inferring nothing", async () => {
    const f = genuine39();
    const before = raw(f.path, db => {
      expect(inspectSchema(db).version).toBe(39);
      return { rows: preserved(db), registry: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all() };
    });
    raw(f.path, db => {
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(39);
      expect(factorTables(db)).toEqual([]);
      expect(preserved(db)).toEqual(before.rows);
      expect(db.prepare("PRAGMA table_info(\"authentication_ba_user\")").all()).not.toContainEqual(expect.objectContaining({ name: "twoFactorEnabled" }));
    });
    const backups = join(f.root, "backups");
    const store = await openControllerStore(f.path, { backupBeforeMigration: true, backupDirectory: backups, applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    try { expect(store.schemaVersion()).toBe(47); } finally { store.close(); }
    const [backup] = readdirSync(backups);
    expect(backup).toMatch(/^pre-migration-v39-/);
    raw(f.path, db => {
      expect(preserved(db)).toEqual(before.rows);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=39 ORDER BY version").all()).toEqual(before.registry);
      for (const table of FACTOR_TABLES) expect(db.prepare(`SELECT count(*) n FROM "${table}"`).get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT "twoFactorEnabled" flag FROM "authentication_ba_user"').all()).toEqual([{ flag: 0 }]);
    });
    // The old snapshot restores through the supported path, then migrates on open.
    const restoredPath = join(f.root, "restored39", "state.sqlite3");
    restoreControllerBackup(join(backups, backup!), restoredPath);
    const restored = new SqliteStateStore(restoredPath);
    try { expect(restored.schemaVersion()).toBe(47); } finally { restored.close(); }
    raw(restoredPath, db => expect(preserved(db)).toEqual(before.rows));
  });

  it("backs up and restores recognized authority rows without inventing or losing any", async () => {
    const f = genuine39();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => db.exec(authority));
    const store = new SqliteStateStore(f.path), target = join(f.root, "manual");
    try { await createControllerBackup(store, target, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") }); } finally { store.close(); }
    const restoredPath = join(f.root, "restored", "state.sqlite3");
    restoreControllerBackup(target, restoredPath);
    const reopened = new SqliteStateStore(restoredPath);
    try { expect(reopened.schemaVersion()).toBe(47); } finally { reopened.close(); }
    raw(restoredPath, db => {
      expect(db.prepare("SELECT last_step FROM authentication_totp_steps").all()).toEqual([{ last_step: 59788416 }]);
      expect(db.prepare("SELECT method, generation FROM authentication_session_evidence").all()).toEqual([{ method: "password_totp", generation: 2 }]);
      expect(db.prepare("SELECT generation, totp_selected FROM authentication_account_policies").all()).toEqual([{ generation: 2, totp_selected: 1 }]);
    });
  });

  it("cascades evidence with its session, but neither a step nor a policy with its account", () => {
    const f = genuine39();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => {
      db.pragma("foreign_keys = ON");
      db.exec(authority);
      db.exec('DELETE FROM "authentication_ba_session"');
      expect(db.prepare("SELECT count(*) n FROM authentication_session_evidence").get()).toEqual({ n: 0 });
      expect(() => db.exec("DELETE FROM authentication_provider_subjects")).toThrow(/FOREIGN KEY/);
      expect(() => db.exec('DELETE FROM "authentication_ba_user"')).toThrow(/FOREIGN KEY/);
    });
  });

  const damaged: Array<[string, string, RegExp]> = [
    ["a changed checksum", "UPDATE schema_migrations SET checksum='wrong' WHERE version=40", /migration checksum/],
    ["an unknown table", "CREATE TABLE authentication_factor_extra (id TEXT)", /unrecognized database schema/],
    ["a missing plugin column", 'ALTER TABLE "authentication_ba_two_factor" DROP COLUMN "lockedUntil"', /unrecognized database schema/],
    ["a missing plugin index", 'DROP INDEX "authentication_ba_passkey_credentialID_idx"', /indexes of authentication_ba_passkey/],
    ["a missing evidence table", "DROP TABLE authentication_session_evidence", /unrecognized database schema/],
    ["a missing step table", "DROP TABLE authentication_totp_steps", /unrecognized database schema/],
    ["a loosened evidence method", `ALTER TABLE authentication_session_evidence RENAME TO old_evidence;
      CREATE TABLE authentication_session_evidence (session_id TEXT NOT NULL PRIMARY KEY REFERENCES "authentication_ba_session" ("id") ON DELETE CASCADE, provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')), subject TEXT NOT NULL,
        method TEXT NOT NULL, authenticated_at TEXT NOT NULL, original_deadline TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 1), policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1),
        credential TEXT, credential_binding TEXT, attempt_id TEXT NOT NULL UNIQUE, FOREIGN KEY(provider_id, subject) REFERENCES authentication_provider_subjects(provider_id, subject) ON DELETE RESTRICT);
      DROP TABLE old_evidence;
      CREATE INDEX authentication_session_evidence_subject ON authentication_session_evidence(provider_id, subject);`, /constraint in authentication_session_evidence/],
    ["a removed step foreign key", `ALTER TABLE authentication_totp_steps RENAME TO old_steps;
      CREATE TABLE authentication_totp_steps (provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')), subject TEXT NOT NULL, last_step INTEGER NOT NULL CHECK(last_step >= 0), PRIMARY KEY(provider_id, subject));
      DROP TABLE old_steps;`, /unrecognized database schema/],
    ["evidence for another subject", `INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES('other','Other','other@fixture.invalid',0,'now','now');
      INSERT INTO authentication_provider_subjects VALUES('better-auth','other','owner-2','revoked','now','now');
      INSERT INTO authentication_session_evidence VALUES('session','better-auth','other','password','2026-11-02T00:00:00.000Z','2026-11-02T08:00:00.000Z',1,1,NULL,NULL,'attempt');`, /session evidence subject/],
  ];
  it.each(damaged)("refuses %s without writing", (_, change, message) => {
    const f = genuine39();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => { db.exec("INSERT INTO remote_principals VALUES('owner-2','owner','revoked')"); db.pragma("foreign_keys = OFF"); db.exec(change); });
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(message);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it("refuses plugin storage that precedes migration 40", () => {
    const f = genuine39();
    raw(f.path, db => db.exec('ALTER TABLE "authentication_ba_user" ADD COLUMN "twoFactorEnabled" integer default 0'));
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/twoFactorEnabled precedes its migration/);
    expect(readFileSync(f.path)).toEqual(bytes);
    raw(f.path, db => db.exec('ALTER TABLE "authentication_ba_user" DROP COLUMN "twoFactorEnabled"; CREATE TABLE "authentication_ba_two_factor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "authentication_ba_user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date)'));
    expect(() => new SqliteStateStore(f.path)).toThrow(/authentication_ba_two_factor precedes its migration/);
  });

  it("keeps evidence rows constrained to the recognized shapes", () => {
    const f = genuine39();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => {
      const insert = (method: string, authenticated: string, deadline: string, credential: string | null, binding: string | null) => db.prepare("INSERT INTO authentication_session_evidence VALUES('session','better-auth','subject',?,?,?,1,1,?,?,'attempt')").run(method, authenticated, deadline, credential, binding);
      const start = "2026-11-02T00:00:00.000Z", end = "2026-11-02T08:00:00.000Z";
      expect(() => insert("recovery_code", start, end, "c", "b")).toThrow(/CHECK/);
      expect(() => insert("password", start, end, "c", "b")).toThrow(/CHECK/);
      expect(() => insert("password_totp", start, end, null, null)).toThrow(/CHECK/);
      expect(() => insert("password", end, start, null, null)).toThrow(/CHECK/);
    });
  });
});
