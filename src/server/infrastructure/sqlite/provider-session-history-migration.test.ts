import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openControllerStore } from "@/server/controller-storage";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService, exportKnowledgeProject, importKnowledgeProject } from "@/server/modules/knowledge";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SqliteStateStore } from "./sqlite-state-store";
import { providerSessionHistoryChecksum, providerSessionHistoryMigration } from "./provider-session-history-migration";
import { rebuildTable } from "./verification-project-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() {
  const root = mkdtempSync(join(tmpdir(), "provider-history-")); roots.push(root);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  return { root, path: join(root, "data", "state.sqlite3") };
}
function raw<T>(path: string, operation: (db: Database.Database) => T): T {
  const db = new Database(path); try { return operation(db); } finally { db.close(); }
}
function genuine38() {
  const f = directory();
  raw(f.path, db => {
    db.exec(readFileSync(new URL("./fixtures/schema-v38.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO remote_principals VALUES('owner','owner','active'),('agent','agent','active');
      INSERT INTO knowledge_projects VALUES('kept','Kept','active',1,'2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');
      INSERT INTO knowledge_project_grants VALUES('owner','kept','["knowledge:read","knowledge:write"]',NULL);
      INSERT INTO knowledge_tasks(id,project_id,title,description,status,priority,revision,created_by,created_at,updated_at)
        VALUES('kept-task','kept','Kept','Content','open','now',1,'owner','2026-10-28T00:00:00.000Z','2026-10-28T00:00:00.000Z');`);
    for (const [id, principal, method] of [[7, "owner", "owner_session"], [19, "agent", "agent_token"], [31, "owner", "none"]]) {
      db.prepare(`INSERT INTO knowledge_history(id,project_id,record_kind,record_id,operation,previous_json,principal_id,authentication_method,revision,created_at)
        VALUES(?,'kept','task','kept-task','created',NULL,?,?,1,'2026-10-28T00:00:00.000Z')`).run(id, principal, method);
    }
    // Preserve an advanced AUTOINCREMENT watermark, including deleted history IDs.
    db.exec("UPDATE sqlite_sequence SET seq=99 WHERE name='knowledge_history'");
  });
  return f;
}
const preserved = (db: Database.Database) => Object.fromEntries(["knowledge_history", "knowledge_tasks", "remote_principals",
  "principal_credentials", "knowledge_project_grants", "knowledge_role_bindings", "authentication_provider_subjects"]
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

describe("provider session history migration 39", () => {
  it("creates recognized fresh storage with provider storage revision 1 and honest history method", () => {
    const f = directory(), store = new SqliteStateStore(f.path);
    try {
      expect(store.schemaVersion()).toBe(42);
      expect(store.authenticationProviderStorage().storageRevision).toBe(3);
    } finally { store.close(); }
    raw(f.path, db => {
      expect(inspectSchema(db)).toEqual({ version: 42, fresh: false });
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=39").get())
        .toEqual({ name: providerSessionHistoryMigration.name, checksum: providerSessionHistoryChecksum });
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='knowledge_history'").get()).toMatchObject({ sql: expect.stringContaining("'provider_session'") });
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='knowledge_import_batches'").get()).toMatchObject({ sql: expect.not.stringContaining("'provider_session'") });
    });
  });

  it("atomically upgrades genuine 38, preserving all rows, old registry entries, indexes and the deleted-ID watermark", async () => {
    const f = genuine38();
    const before = raw(f.path, db => {
      expect(inspectSchema(db).version).toBe(38);
      return { rows: preserved(db), registry: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
        indexes: db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_history' ORDER BY name").all() };
    });
    raw(f.path, db => {
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(38);
      expect(preserved(db)).toEqual(before.rows);
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before.registry);
      expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='knowledge_history'").get()).toEqual({ seq: 99 });
    });
    const backups = join(f.root, "backups");
    const store = await openControllerStore(f.path, { backupBeforeMigration: true, backupDirectory: backups,
      applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    store.close();
    const [backup] = readdirSync(backups);
    expect(backup).toMatch(/^pre-migration-v38-/);
    expect(JSON.parse(readFileSync(join(backups, backup!, "manifest.json"), "utf8")).database.schemaVersion).toBe(38);
    raw(f.path, db => {
      expect(inspectSchema(db).version).toBe(42);
      expect(preserved(db)).toEqual(before.rows);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=38 ORDER BY version").all()).toEqual(before.registry);
      expect(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_history' ORDER BY name").all()).toEqual(before.indexes);
      const inserted = db.prepare(`INSERT INTO knowledge_history(project_id,record_kind,record_id,operation,principal_id,authentication_method,revision,created_at)
        VALUES('kept','task','kept-task','updated','owner','provider_session',2,'2026-10-29T00:00:00.000Z')`).run();
      expect(inserted.lastInsertRowid).toBe(100);
    });
    // Restore the genuine old snapshot through the supported restore path, then migrate on open.
    const restoredPath = join(f.root, "restored38", "state.sqlite3");
    restoreControllerBackup(join(backups, backup!), restoredPath);
    const restored = new SqliteStateStore(restoredPath);
    try { expect(restored.schemaVersion()).toBe(42); } finally { restored.close(); }
    raw(restoredPath, db => expect(preserved(db)).toEqual(before.rows));
  });

  it.each(["checksum", "constraint", "import-constraint"])("refuses malformed %s storage before writes", kind => {
    const f = directory(); new SqliteStateStore(f.path).close();
    raw(f.path, db => {
      if (kind === "checksum") db.exec("UPDATE schema_migrations SET checksum='bad' WHERE version=39");
      else {
        const table = kind === "constraint" ? "knowledge_history" : "knowledge_import_batches";
        db.pragma("foreign_keys = OFF");
        if (kind === "constraint") rebuildTable(db, table,
          "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none', 'provider_session'))",
          "CHECK(authentication_method IN ('owner_session', 'agent_token', 'worker_token', 'installation_token', 'none'))");
        else rebuildTable(db, table, "'legacy_unknown'))", "'legacy_unknown', 'provider_session'))");
      }
    });
    const bytes = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/unrecognized database schema/);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  it("retains the deleted-ID watermark even when every old history row was deleted", () => {
    const f = genuine38();
    raw(f.path, db => {
      db.exec("DELETE FROM knowledge_history");
      initializeSchema(db, false);
      const result = db.prepare(`INSERT INTO knowledge_history(project_id,record_kind,record_id,operation,principal_id,authentication_method,revision,created_at)
        VALUES('kept','task','kept-task','updated','owner','provider_session',2,'2026-10-29T00:00:00.000Z')`).run();
      expect(result.lastInsertRowid).toBe(100);
    });
  });

  it("round-trips provider history through full backup/restore and authorized logical export/import", async () => {
    const f = genuine38();
    const store = new SqliteStateStore(f.path), identity = new IdentityService(store);
    const owner = identity.recoverOwnerSession(), actor = identity.authenticateBearer(owner.token);
    const knowledge = new KnowledgeService(store, identity);
    const task = knowledge.createTask("kept", { title: "New", description: "Kept" }, { idempotencyKey: "new" }, actor);
    // The real-provider suite writes this method through the public application; here verify persistence formats.
    store.close();
    raw(f.path, db => db.prepare("UPDATE knowledge_history SET authentication_method='provider_session' WHERE record_id=?").run(task.value.id));
    const reopened = new SqliteStateStore(f.path), backup = join(f.root, "new-backup");
    const exported = join(f.root, "logical-export");
    try {
      const current = identityFor(reopened);
      current.setKnowledgeGrant({ principalId: actor.principalId, projectId: "kept", permissions: ["knowledge:read", "knowledge:write", "knowledge:export", "attachments:read"] }, actor);
      exportKnowledgeProject(reopened, current, "kept", exported, join(f.root, "attachments"), actor, { applicationVersion: "test" });
      await createControllerBackup(reopened, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    } finally { reopened.close(); }
    const restoredPath = join(f.root, "restored39", "state.sqlite3");
    restoreControllerBackup(backup, restoredPath);
    const restored = new SqliteStateStore(restoredPath);
    try {
      expect(restored.schemaVersion()).toBe(42);
      expect(restored.listHistory("kept", "task", task.value.id, 25, 0).items[0]?.authenticationMethod).toBe("provider_session");
    } finally { restored.close(); }
    const target = new SqliteStateStore(join(f.root, "logical.sqlite3"));
    try {
      const targetIdentity = identityFor(target), token = targetIdentity.bootstrapOwnerSession();
      // Logical import requires explicit existing historical IDs and creates no identities or grants.
      target.savePrincipal({ id: "owner", kind: "owner", status: "revoked" }, "fixture");
      target.savePrincipal({ id: "agent", kind: "agent", status: "revoked" }, "fixture");
      importKnowledgeProject(target, targetIdentity, exported, join(f.root, "target-attachments"), targetIdentity.authenticateBearer(token.token));
      expect(target.listHistory("kept", "task", task.value.id, 25, 0).items[0]?.authenticationMethod).toBe("provider_session");
    } finally { target.close(); }
  });
});
const identityFor = (store: SqliteStateStore) => new IdentityService(store);
