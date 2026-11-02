import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { openControllerStore } from "@/server/controller-storage";
import { authenticationFactorChecksum, authenticationFactorMigration } from "./authentication-factor-migration";
import { AuthenticationSessionIssuanceQueries } from "./authentication-session-issuance-queries";
import { authenticationSessionIssuanceChecksum, authenticationSessionIssuanceMigration } from "./authentication-session-issuance-migration";
import { initializeSchema } from "./migrations";
import { OwnedSqliteDatabase } from "./owned-database";
import { inspectSchema } from "./schema-inspection";
import { SqliteStateStore } from "./sqlite-state-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const POLICY = { sessionRows: 16, sessionReconcileBatch: 2 };
const DEADLINE = "2099-01-01T00:00:00.000Z";
function directory() {
  const root = mkdtempSync(join(tmpdir(), "auth-issuance-migration-")); roots.push(root);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  return { root, path: join(root, "data", "state.sqlite3") };
}
function raw<T>(path: string, operation: (db: Database.Database) => T): T {
  const db = new Database(path); try { return operation(db); } finally { db.close(); }
}
const session = (id: string, expires = DEADLINE) => `INSERT INTO "authentication_ba_session"("id","expiresAt","token","createdAt","updatedAt","userId") VALUES('${id}','${expires}','token-${id}','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z','subject');`;
const evidence = (id: string, deadline = DEADLINE, subject = "subject") => `INSERT INTO authentication_session_evidence VALUES('${id}','better-auth','${subject}','password','2026-10-28T00:00:00.000Z','${deadline}',1,1,NULL,NULL,'attempt-${id}');`;
const issuance = (id: string, state: string, deadline = DEADLINE) => `INSERT INTO authentication_session_issuance VALUES('${id}','${state}','${deadline}');`;
/**
 * The frozen schema, with rows a real schema-40 installation holds: a released
 * session with evidence, a native row without evidence, an expired one with
 * evidence, an unrelated account's security state and a separately pruned receipt.
 */
function genuine40() {
  const f = directory();
  raw(f.path, db => {
    db.exec(readFileSync(new URL("./fixtures/schema-v40.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO remote_principals VALUES('owner','owner','active');
      INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES('subject','Owner','owner@fixture.invalid',0,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');
      INSERT INTO "authentication_ba_account"("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES('account','subject','credential','subject','hash','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');
      INSERT INTO authentication_provider_subjects VALUES('better-auth','subject','owner','active','2026-10-28T00:00:00.000Z',NULL);
      INSERT INTO authentication_account_policies VALUES('better-auth','subject',1,1,0,0,'2026-11-02T00:00:00.000Z');
      INSERT INTO authentication_totp_steps VALUES('better-auth','subject',59788416);
      ${session("released")} ${evidence("released")}
      ${session("no-evidence")}
      ${session("expired", "2026-10-28T08:00:00.000Z")} ${evidence("expired", "2026-10-28T08:00:00.000Z")}`);
  });
  return f;
}
const PRESERVED = ["remote_principals", "authentication_provider_subjects", "authentication_ba_session", "authentication_session_evidence", "authentication_account_policies", "authentication_totp_steps", "authentication_factor_receipts"];
const preserved = (db: Database.Database) => Object.fromEntries(PRESERVED.map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
const registry = (db: Database.Database) => db.prepare("SELECT version, applied_at, name, checksum FROM schema_migrations WHERE version <= 40 ORDER BY version").all();
const hasTable = (db: Database.Database) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='authentication_session_issuance'").get());

// Each case builds and migrates real database files, which is slow under the full parallel suite.
describe("authentication session issuance migration 41", { timeout: 30_000 }, () => {
  it("creates recognized empty storage on a fresh database and bumps the storage revision", () => {
    const f = directory(), store = new SqliteStateStore(f.path);
    try {
      expect(store.schemaVersion()).toBe(41);
      expect(store.authenticationProviderStorage().storageRevision).toBe(3);
    } finally { store.close(); }
    raw(f.path, db => {
      expect(inspectSchema(db)).toEqual({ version: 41, fresh: false });
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=41").get()).toEqual({ name: authenticationSessionIssuanceMigration.name, checksum: authenticationSessionIssuanceChecksum });
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=40").get()).toEqual({ name: authenticationFactorMigration.name, checksum: authenticationFactorChecksum });
      // No token, cookie, password, actor or process identity has a column here.
      expect((db.prepare("PRAGMA table_info(authentication_session_issuance)").all() as Array<{ name: string }>).map(column => column.name)).toEqual(["session_id", "state", "original_deadline"]);
    });
  });

  it("upgrades genuine schema 40 behind a verified backup, inventing and losing nothing", async () => {
    const f = genuine40(), attachmentDirectory = join(f.root, "attachments"), backups = join(f.root, "backups");
    const before = raw(f.path, db => ({ rows: preserved(db), registry: registry(db), bytes: readFileSync(f.path) }));
    expect(raw(f.path, db => inspectSchema(db).version)).toBe(40);
    const store = await openControllerStore(f.path, { backupBeforeMigration: true, backupDirectory: backups, applicationVersion: "test", attachmentDirectory });
    try { expect(store.schemaVersion()).toBe(41); } finally { store.close(); }
    raw(f.path, db => {
      expect(preserved(db)).toEqual(before.rows);
      expect(registry(db)).toEqual(before.registry);
      expect(db.prepare("SELECT count(*) n FROM authentication_session_issuance").get()).toEqual({ n: 0 });
      expect(new AuthenticationSessionIssuanceQueries(db).state("released")).toBe("unclassified");
    });
    const backup = readdirSync(backups).find(name => name.startsWith("pre-migration-v40-"))!;
    expect(JSON.parse(readFileSync(join(backups, backup, "manifest.json"), "utf8")).database.schemaVersion).toBe(40);
    const restoredPath = join(f.root, "restored", "state.sqlite3");
    restoreControllerBackup(join(backups, backup), restoredPath);
    const restored = new SqliteStateStore(restoredPath);
    try { expect(restored.schemaVersion()).toBe(41); } finally { restored.close(); }
    raw(restoredPath, db => { expect(preserved(db)).toEqual(before.rows); });
  });

  it("rolls every migration effect back when initialization fails after the new DDL", () => {
    const f = genuine40();
    const before = raw(f.path, db => ({ rows: preserved(db), registry: registry(db) }));
    raw(f.path, db => {
      expect(() => { initializeSchema(db, false, current => {
        expect(hasTable(current)).toBe(true);
        throw new Error("late validation failure");
      }); }).toThrow("late validation failure");
      expect(hasTable(db)).toBe(false);
      expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version=41").get()).toBeUndefined();
      expect(preserved(db)).toEqual(before.rows);
      expect(registry(db)).toEqual(before.registry);
      expect(inspectSchema(db).version).toBe(40);
    });
    const retry = new SqliteStateStore(f.path);
    try { expect(retry.schemaVersion()).toBe(41); } finally { retry.close(); }
  });

  it("carries markers through a backup as a structurally valid snapshot, while its owner reports the restore", async () => {
    const f = genuine40();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => db.exec(`${session("published")} ${evidence("published")} ${issuance("published", "may_publish")}
      ${session("pending")} ${evidence("pending")} ${issuance("pending", "pending")}`));
    const target = join(f.root, "manual"), store = new SqliteStateStore(f.path);
    try { await createControllerBackup(store, target, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") }); } finally { store.close(); }
    const ordinary = new OwnedSqliteDatabase(f.path);
    try { expect(ordinary.provenance).toBe("ordinary"); } finally { ordinary.close(); }
    const restoredPath = join(f.root, "restored", "state.sqlite3");
    restoreControllerBackup(target, restoredPath);
    const bytes = () => raw(restoredPath, db => ({ rows: preserved(db), markers: db.prepare("SELECT * FROM authentication_session_issuance ORDER BY session_id").all() }));
    const before = bytes();
    expect(before.markers).toHaveLength(2);
    const reopened = new SqliteStateStore(restoredPath);
    try {
      expect(reopened.databaseProvenance).toBe("restored");
      // Community and token paths see an ordinary store. Only the destructive sweep refuses.
      expect(reopened.getAuthenticationPolicy().mode).toBeDefined();
      await expect(reopened.recoverIssuedSessions(POLICY)).rejects.toThrow("provenance");
      expect(reopened.authenticationProviderStorage().sessionRecoveryComplete()).toBe(false);
    } finally { reopened.close(); }
    expect(bytes()).toEqual(before);
  });

  it("recovers an ordinary restart once, removing positively owned rows only", async () => {
    const f = genuine40();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => db.exec(`${session("published")} ${evidence("published")} ${issuance("published", "may_publish")}
      ${session("lapsed", "2026-10-29T00:00:00.000Z")} ${evidence("lapsed", "2026-10-29T00:00:00.000Z")} ${issuance("lapsed", "may_publish", "2026-10-29T00:00:00.000Z")}
      ${session("pending-a")} ${evidence("pending-a")} ${issuance("pending-a", "pending")}
      ${session("pending-b")} ${evidence("pending-b")} ${issuance("pending-b", "pending")}
      ${session("pending-c")} ${evidence("pending-c")} ${issuance("pending-c", "pending")}`));
    const store = new SqliteStateStore(f.path);
    try {
      expect(store.databaseProvenance).toBe("ordinary");
      expect(store.authenticationProviderStorage().sessionRecoveryComplete()).toBe(false);
      await store.recoverIssuedSessions(POLICY);
      expect(store.authenticationProviderStorage().sessionRecoveryComplete()).toBe(true);
    } finally { store.close(); }
    raw(f.path, db => {
      // Unmarked rows stay, even the expired ones. Marker and evidence went with their sessions.
      expect(db.prepare('SELECT "id" AS id FROM "authentication_ba_session" ORDER BY "id"').pluck().all()).toEqual(["expired", "no-evidence", "published", "released"]);
      expect(db.prepare("SELECT session_id FROM authentication_session_issuance").pluck().all()).toEqual(["published"]);
      expect(db.prepare("SELECT session_id FROM authentication_session_evidence ORDER BY session_id").pluck().all()).toEqual(["expired", "published", "released"]);
      expect(db.prepare("SELECT last_step FROM authentication_totp_steps").pluck().get()).toBe(59788416);
      expect(new AuthenticationSessionIssuanceQueries(db).nativeSessions(16)).toBe(4);
      expect(new AuthenticationSessionIssuanceQueries(db).nativeSessions(2)).toBe(2);
    });
  });

  it("refuses a pending row it cannot resolve, without skipping it into readiness", async () => {
    const opened = genuine40();
    new SqliteStateStore(opened.path).close();
    raw(opened.path, db => db.exec(`${session("pending")} ${evidence("pending")} ${issuance("pending", "pending")}`));
    const live = new SqliteStateStore(opened.path);
    try {
      // After the open-time validation: only a row changed under a running owner can look like this.
      const database = (live as unknown as { database: { prepare(sql: string): { run(): void } } }).database;
      database.prepare("UPDATE authentication_session_issuance SET original_deadline = '2098-01-01T00:00:00.000Z'").run();
      await expect(live.recoverIssuedSessions(POLICY)).rejects.toThrow("could not resolve");
      expect(live.authenticationProviderStorage().sessionRecoveryComplete()).toBe(false);
      await expect(live.recoverIssuedSessions(POLICY)).rejects.toThrow("could not resolve");
    } finally { live.close(); }
  });

  const damaged: Array<[string, string, RegExp]> = [
    ["a changed checksum", "UPDATE schema_migrations SET checksum='wrong' WHERE version=41", /migration checksum/],
    ["a changed name", "UPDATE schema_migrations SET name='wrong' WHERE version=41", /migration checksum/],
    ["a changed older checksum", "UPDATE schema_migrations SET checksum='wrong' WHERE version=40", /migration checksum/],
    ["an unknown table", "CREATE TABLE authentication_session_extra (id TEXT)", /unrecognized database schema/],
    ["a trigger", "CREATE TRIGGER issuance_guard BEFORE DELETE ON authentication_session_issuance BEGIN SELECT 1; END", /unrecognized database schema/],
    ["a missing table", "DROP TABLE authentication_session_issuance", /unrecognized database schema/],
    ["a missing index", "DROP INDEX authentication_session_issuance_deadline", /indexes of authentication_session_issuance/],
    ["an extra index", "CREATE INDEX authentication_session_issuance_extra ON authentication_session_issuance(original_deadline)", /indexes of authentication_session_issuance/],
    ["a missing column", "DROP INDEX authentication_session_issuance_deadline; ALTER TABLE authentication_session_issuance DROP COLUMN original_deadline", /unrecognized database schema/],
    ["a loosened state", `DROP TABLE authentication_session_issuance;
      CREATE TABLE authentication_session_issuance (session_id TEXT NOT NULL PRIMARY KEY REFERENCES authentication_session_evidence(session_id) ON DELETE CASCADE, state TEXT NOT NULL, original_deadline TEXT NOT NULL);
      CREATE INDEX authentication_session_issuance_state ON authentication_session_issuance(state, session_id);
      CREATE INDEX authentication_session_issuance_deadline ON authentication_session_issuance(state, original_deadline, session_id);`, /constraint in authentication_session_issuance/],
    ["a removed cascade", `DROP TABLE authentication_session_issuance;
      CREATE TABLE authentication_session_issuance (session_id TEXT NOT NULL PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending', 'may_publish')), original_deadline TEXT NOT NULL);
      CREATE INDEX authentication_session_issuance_state ON authentication_session_issuance(state, session_id);
      CREATE INDEX authentication_session_issuance_deadline ON authentication_session_issuance(state, original_deadline, session_id);`, /unrecognized database schema/],
    ["a dangling marker", issuance("missing", "pending"), /foreign key/],
    ["a marker with another deadline", issuance("released", "may_publish", "2098-01-01T00:00:00.000Z"), /session issuance/],
    ["a malformed deadline", `UPDATE authentication_session_evidence SET original_deadline='2099-13-01T00:00:00.000Z' WHERE session_id='released'; ${issuance("released", "pending", "2099-13-01T00:00:00.000Z")}`, /session issuance/],
    ["a marked session owned by another subject", `INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES('other','Other','other@fixture.invalid',0,'now','now');
      INSERT INTO authentication_provider_subjects VALUES('better-auth','other','owner-2','revoked','now','now');
      ${session("foreign")} ${evidence("foreign", DEADLINE, "other")} ${issuance("foreign", "pending")}`, /session evidence subject/],
  ];
  it.each(damaged)("refuses %s without writing", (_, change, message) => {
    const f = genuine40();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => { db.exec("INSERT INTO remote_principals VALUES('owner-2','owner','revoked')"); db.pragma("foreign_keys = OFF"); db.exec(change); });
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(message);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it("refuses a table that precedes its migration, and a registry ahead of this code", () => {
    const f = genuine40();
    raw(f.path, db => db.exec(authenticationSessionIssuanceMigration.sql));
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/authentication_session_issuance precedes its migration/);
    expect(readFileSync(f.path)).toEqual(bytes);
    const ahead = directory();
    new SqliteStateStore(ahead.path).close();
    raw(ahead.path, db => db.exec("INSERT INTO schema_migrations(version, applied_at, name, checksum) VALUES (42, '2026-11-02T00:00:00.000Z', 'future', 'future')"));
    const unchanged = readFileSync(ahead.path);
    expect(() => new SqliteStateStore(ahead.path)).toThrow(/unrecognized database schema/);
    expect(readFileSync(ahead.path)).toEqual(unchanged);
  });

  it("refuses a second migration of frozen schema 40 by recognizing its fixture as genuine", () => {
    const f = genuine40();
    raw(f.path, db => {
      expect(inspectSchema(db)).toEqual({ version: 40, fresh: false });
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=40").get()).toEqual({ name: authenticationFactorMigration.name, checksum: authenticationFactorChecksum });
      expect(hasTable(db)).toBe(false);
    });
  });

  it("deletes the marker with its session, through the existing cascades", () => {
    const f = genuine40();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => {
      db.pragma("foreign_keys = ON");
      db.exec(`${issuance("released", "may_publish")} DELETE FROM "authentication_ba_session" WHERE "id"='released';`);
      expect(db.prepare("SELECT count(*) n FROM authentication_session_issuance").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) n FROM authentication_session_evidence WHERE session_id='released'").get()).toEqual({ n: 0 });
    });
  });
});
