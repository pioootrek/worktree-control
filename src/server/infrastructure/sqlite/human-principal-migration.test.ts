import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { openControllerStore } from "@/server/controller-storage";
import { HumanAccountService } from "@/server/modules/identity";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { validateDatabase } from "./database-validation";
import { SqliteStateStore } from "./sqlite-state-store";
import { humanPrincipalChecksum, humanPrincipalMigration } from "./human-principal-migration";
import { rewindGodotWeb } from "./fixtures/schema-rewind";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture41 = readFileSync(new URL("./fixtures/schema-v41.sql", import.meta.url), "utf8");
const kept = (db: Database.Database) => Object.fromEntries(["remote_principals", "principal_credentials", "knowledge_project_grants", "knowledge_role_bindings", "knowledge_history", "authentication_provider_subjects",
  "authentication_totp_steps", "authentication_session_evidence", "authentication_session_issuance", "sqlite_sequence"].map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
function baseline() {
  const db = new Database(":memory:"); db.exec(fixture41);
  db.exec(`INSERT INTO remote_principals VALUES('owner','owner','active'),('old-agent','agent','revoked');
    CREATE INDEX historical_principal_status ON remote_principals(status);
    INSERT INTO principal_credentials VALUES('credential','owner','owner_session','Historical','prefix','${"a".repeat(64)}','revoked',NULL,'2026-11-01T00:00:00.000Z','2026-11-01T01:00:00.000Z',NULL);
    INSERT INTO knowledge_projects VALUES('k','Knowledge','active',1,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
    INSERT INTO knowledge_history VALUES(7,'k','project','k','created',NULL,'owner','owner_session',1,'2026-11-01T00:00:00.000Z');
    INSERT INTO knowledge_history VALUES(91,'k','project','k','updated',NULL,'owner','provider_session',2,'2026-11-01T00:00:00.000Z');
    DELETE FROM knowledge_history WHERE id=91;
    INSERT INTO knowledge_project_grants VALUES('owner','k','["knowledge:read"]',NULL),('old-agent','k','["knowledge:write"]','2026-11-01T00:00:00.000Z');
    INSERT INTO knowledge_role_bindings VALUES('old-agent','k','operator',9,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
    INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('s','Fixture','fixture@invalid.test',0,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');
    INSERT INTO authentication_provider_subjects VALUES('better-auth','s','owner','active','2026-11-01T00:00:00.000Z',NULL);
    INSERT INTO authentication_totp_steps VALUES('better-auth','s',59788416);
    INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session','2099-01-01T00:00:00.000Z','fixture-token','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z','s');
    INSERT INTO authentication_session_evidence VALUES('session','better-auth','s','password','2026-11-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',1,1,NULL,NULL,'attempt');
    INSERT INTO authentication_session_issuance VALUES('session','pending','2099-01-01T00:00:00.000Z');`);
  return db;
}
describe("ordinary human principal migration 42", () => {
  it("upgrades the genuine baseline 41 shape atomically and preserves old rows, registry, indexes and FKs", () => {
    const db = baseline();
    try {
      expect(inspectSchema(db)).toEqual({ version: 41, fresh: false });
      expect(() => db.exec("INSERT INTO remote_principals VALUES('forbidden-human','human','active')")).toThrow(/CHECK/);
      const before = kept(db), registry = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const keys = db.prepare("PRAGMA foreign_key_list(knowledge_project_grants)").all();
      expect(() => initializeSchema(db, false, () => { throw Error("after rebuild"); })).toThrow("after rebuild");
      expect(inspectSchema(db).version).toBe(41); expect(kept(db)).toEqual(before);
      initializeSchema(db, false, inspectSchema);
      expect(inspectSchema(db).version).toBe(43); expect(kept(db)).toEqual(before);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=41 ORDER BY version").all()).toEqual(registry);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=42").get()).toEqual({ name: humanPrincipalMigration.name, checksum: humanPrincipalChecksum });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='historical_principal_status'").get()).toBeTruthy();
      expect(db.prepare("PRAGMA foreign_key_list(knowledge_project_grants)").all()).toEqual(keys);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.exec("INSERT INTO remote_principals VALUES('human','human','active')");
      validateDatabase(db, 42);
    } finally { db.close(); }
  });
  it("opens a populated genuine schema-41 file only after making a verified schema-41 backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "human-upgrade41-")); roots.push(root);
    const data = join(root, "data"); mkdirSync(data, { mode: 0o700 });
    const path = join(data, "state.sqlite3"), old = baseline();
    const before = kept(old), registry = old.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    try { await old.backup(path); } finally { old.close(); }
    chmodSync(path, 0o600);
    const backups = join(root, "backups");
    const store = await openControllerStore(path, { backupBeforeMigration: true, backupDirectory: backups,
      applicationVersion: "human-upgrade-test", attachmentDirectory: join(root, "attachments") });
    try { expect(store.schemaVersion()).toBe(43); expect(store.getPrincipal("owner")).toEqual({ id: "owner", kind: "owner", status: "active" }); }
    finally { await store.closeAfterDrain(); }
    const names = readdirSync(backups); expect(names).toHaveLength(1); expect(names[0]).toMatch(/^pre-migration-v41-/);
    const backup = join(backups, names[0]);
    expect(JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")).database.schemaVersion).toBe(41);
    for (const [file, version] of [[path, 43], [join(backup, "state.sqlite3"), 41]] as const) {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(inspectSchema(db).version).toBe(version); expect(kept(db)).toEqual(before);
        expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=41 ORDER BY version").all()).toEqual(registry);
      } finally { db.close(); }
    }
  });

  it("rolls back on final FK validation and restores enforcement", () => {
    const db = baseline();
    try {
      db.pragma("foreign_keys=OFF");
      db.exec("INSERT INTO knowledge_project_grants VALUES('missing','k','[]',NULL)");
      db.pragma("foreign_keys=ON");
      expect(() => initializeSchema(db, false)).toThrow(/foreign key/);
      expect(inspectSchema(db).version).toBe(41);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally { db.close(); }
  });
  it.each(["checksum", "name", "old-wide", "old-row", "human-credential", "agent-mapping"])("rejects incompatible %s", variant => {
    const db = baseline();
    try {
      initializeSchema(db);
      if (variant === "checksum" || variant === "name") db.exec(`UPDATE schema_migrations SET ${variant}='tampered' WHERE version=42`);
      if (variant === "old-wide" || variant === "old-row") {
        if (variant === "old-row") db.exec("INSERT INTO remote_principals VALUES('h','human','active')");
        // Remove the later Godot Web migration first so the registry ends at 41.
        rewindGodotWeb(db);
        db.exec("DELETE FROM schema_migrations WHERE version=42");
        expect(() => inspectSchema(db)).toThrow(/human principal precedes/); return;
      }
      if (variant === "human-credential") db.exec("INSERT INTO remote_principals VALUES('h','human','active'); UPDATE principal_credentials SET principal_id='h'");
      if (variant === "agent-mapping") db.exec("UPDATE authentication_provider_subjects SET principal_id='old-agent'");
      expect(() => { const shape = inspectSchema(db); validateDatabase(db, shape.version); }).toThrow();
    } finally { db.close(); }
  });
  it("creates fresh schema 42 and reopens/full-backs-up human mappings without changing provider revision or restore provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "human-migration-")); roots.push(root);
    const path = join(root, "data", "state.sqlite3"), store = new SqliteStateStore(path);
    const human = new HumanAccountService(store.humanAccounts(), "local-cli").create();
    expect(store.schemaVersion()).toBe(43); expect(store.authenticationProviderStorage().storageRevision).toBe(3);
    const storage = store.authenticationProviderStorage(), connection = storage.createProviderConnection();
    await storage.borrow(async () => {
      connection.prepare("INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('s','Fixture','fixture@invalid.test',0,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')").run([]);
      storage.runControllerOperation(() => storage.subjects("better-auth").link({ subject: "s", principalId: human.id, actor: "fixture" }));
    }); connection.close();
    const target = join(root, "backup");
    await createControllerBackup(store, target, { applicationVersion: "test", attachmentDirectory: join(root, "attachments") });
    await store.closeAfterDrain();
    const reopened = new SqliteStateStore(path);
    expect(reopened.getPrincipal(human.id)).toEqual(human); await reopened.closeAfterDrain();
    const restoredPath = join(root, "restored", "state.sqlite3"); restoreControllerBackup(target, restoredPath);
    const restored = new SqliteStateStore(restoredPath);
    try {
      expect(restored.getPrincipal(human.id)).toEqual(human);
      expect(restored.authenticationProviderStorage().subjects("better-auth").resolveActivePrincipal("s")).toBe(human.id);
      await expect(restored.recoverIssuedSessions({ sessionRows: 8, sessionReconcileBatch: 2 })).rejects.toThrow();
    } finally { await restored.closeAfterDrain(); }
  });
});
