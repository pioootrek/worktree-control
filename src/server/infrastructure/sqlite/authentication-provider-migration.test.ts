import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openControllerStore } from "@/server/controller-storage";
import { authenticationProviderChecksum, authenticationProviderMigration } from "./authentication-provider-migration";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SqliteStateStore } from "./sqlite-state-store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const PROVIDER_TABLES = ["authentication_ba_account", "authentication_ba_session", "authentication_ba_user", "authentication_ba_verification", "authentication_provider_subjects"];

function directory() {
  const root = mkdtempSync(join(tmpdir(), "auth-provider-migration-")); roots.push(root);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  return { root, path: join(root, "data", "state.sqlite3") };
}
function raw<T>(path: string, operation: (db: Database.Database) => T): T {
  const db = new Database(path); try { return operation(db); } finally { db.close(); }
}
/** A database written by the A2 release (migrations.ts at 7dd311e), plus representative identity rows. */
function genuineV37() {
  const f = directory();
  raw(f.path, db => {
    db.exec(readFileSync(new URL("./fixtures/schema-v37.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
        VALUES('kept','Kept','/code/kept',3601,'node','["dev"]','/',45000,'now','now');
      INSERT INTO remote_principals(id,kind,status) VALUES('owner-1','owner','active'),('agent-1','agent','active');
      INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at)
        VALUES('owner-cred','owner-1','owner_session','owner','wso_x',printf('%064d',1),'active','now'),
              ('agent-cred','agent-1','agent_token','agent','wsa_x',printf('%064d',2),'active','now');
      INSERT INTO runtime_delegations(principal_id,project_id,sponsor_id,actions_json,revision,updated_at)
        VALUES('agent-1','kept','owner-1','["projects:read"]',1,'now');
      INSERT INTO runtime_credential_scopes(credential_id,project_id,actions_json,created_at) VALUES('agent-cred','kept','["projects:read"]','now');`);
  });
  return f;
}
const identityState = (db: Database.Database) => Object.fromEntries(["remote_principals", "principal_credentials", "runtime_delegations", "runtime_credential_scopes", "knowledge_project_grants", "knowledge_role_bindings", "projects", "reservations"]
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
/** Migration 43 (after this one) adds a NULL Godot Web configuration to every existing project. */
const upgradedIdentityState = (state: ReturnType<typeof identityState>) => ({
  ...state, projects: (state.projects as object[]).map(row => ({ ...row, godot_web_json: null })),
});
const providerTables = (db: Database.Database) => (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${PROVIDER_TABLES.map(() => "?").join(",")}) ORDER BY name`).all(...PROVIDER_TABLES) as Array<{ name: string }>).map(({ name }) => name);

describe("authentication provider storage migration 38", () => {
  it("creates empty, recognized provider storage in a fresh database", () => {
    const f = directory();
    const store = new SqliteStateStore(f.path);
    try {
      expect(store.schemaVersion()).toBe(45);
      expect(store.authenticationProviderStorage().storageRevision).toBe(3);
    } finally { store.close(); }
    raw(f.path, db => {
      expect(providerTables(db)).toEqual(PROVIDER_TABLES);
      for (const table of PROVIDER_TABLES) expect(db.prepare(`SELECT count(*) n FROM "${table}"`).get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=38").get())
        .toEqual({ name: authenticationProviderMigration.name, checksum: authenticationProviderChecksum });
      expect(inspectSchema(db)).toEqual({ version: 45, fresh: false });
    });
  });

  it("upgrades a genuine v37 database atomically after a verified pre-migration backup, with no identity or grant changes", async () => {
    const f = genuineV37();
    const before = raw(f.path, db => { expect(inspectSchema(db).version).toBe(37); return identityState(db); });
    raw(f.path, db => {
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(37);
      expect(providerTables(db)).toEqual([]);
      expect(identityState(db)).toEqual(before);
    });
    const backups = join(f.root, "backups");
    const store = await openControllerStore(f.path, { backupBeforeMigration: true, backupDirectory: backups, applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    try { expect(store.schemaVersion()).toBe(45); } finally { store.close(); }
    const [backup] = readdirSync(backups);
    expect(backup).toMatch(/^pre-migration-v37-/);
    expect(JSON.parse(readFileSync(join(backups, backup!, "manifest.json"), "utf8")).database.schemaVersion).toBe(37);
    raw(f.path, db => {
      expect(identityState(db)).toEqual(upgradedIdentityState(before));
      expect(providerTables(db)).toEqual(PROVIDER_TABLES);
      expect(db.prepare("SELECT count(*) n FROM authentication_provider_subjects").get()).toEqual({ n: 0 });
    });
  });

  const damaged: Array<[string, string, RegExp]> = [
    ["a missing provider column", 'ALTER TABLE "authentication_ba_user" DROP COLUMN "image"', /unrecognized database schema/],
    ["a missing provider index", 'DROP INDEX "authentication_ba_session_userId_idx"', /indexes of authentication_ba_session/],
    ["a non-partial principal index", "DROP INDEX authentication_provider_subjects_principal; CREATE UNIQUE INDEX authentication_provider_subjects_principal ON authentication_provider_subjects(provider_id, principal_id)", /indexes of authentication_provider_subjects/],
    ["a missing provider table", 'DROP TABLE "authentication_ba_verification"', /unrecognized database schema/],
    ["a changed migration checksum", "UPDATE schema_migrations SET checksum='wrong' WHERE version=38", /migration checksum/],
    ["a subject mapping without its foreign keys", `ALTER TABLE authentication_provider_subjects RENAME TO old_subjects;
      CREATE TABLE authentication_provider_subjects (provider_id TEXT NOT NULL CHECK(provider_id IN ('better-auth')), subject TEXT NOT NULL,
        principal_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'revoked')), linked_at TEXT NOT NULL, revoked_at TEXT,
        CHECK((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)), PRIMARY KEY(provider_id, subject));
      DROP TABLE old_subjects;
      CREATE UNIQUE INDEX authentication_provider_subjects_principal ON authentication_provider_subjects(provider_id, principal_id) WHERE status = 'active';`, /unrecognized database schema/],
    ["a subject mapped to an agent principal", `INSERT INTO remote_principals(id,kind,status) VALUES('agent-1','agent','active');
      INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES('subject-1','A','a@fixture.invalid',0,'now','now');
      INSERT INTO authentication_provider_subjects VALUES('better-auth','subject-1','agent-1','active','now',NULL);`, /provider subject principal/],
  ];
  it.each(damaged)("refuses %s without writing", (_, change, message) => {
    const f = directory();
    new SqliteStateStore(f.path).close();
    raw(f.path, db => { db.pragma("foreign_keys = OFF"); db.exec(change); });
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(message);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it("refuses provider tables that precede migration 38", () => {
    const f = genuineV37();
    raw(f.path, db => db.exec('CREATE TABLE "authentication_ba_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null)'));
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/authentication_ba_user precedes its migration/);
    expect(readFileSync(f.path)).toEqual(bytes);
  });
});
