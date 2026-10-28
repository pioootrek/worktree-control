import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { devVaultChecksum, devVaultMigration } from "./dev-vault-migration";
import { taskCurrentStateChecksum, taskCurrentStateMigration } from "./task-current-state-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vault-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const project = store.addProject({ name: "Kept", repositoryPath: root, port: 3987, executable: "node", args: ["dev"] });
  const policy = store.getAuthenticationPolicy();
  store.close();
  return { path, project, policy };
}

describe("Knowledge 33 and DEV vault 34 integration", () => {
  it.each([32, 33])("upgrades schema %s atomically, preserves records and reopens", version => {
    const f = fixture();
    const db = new Database(f.path);
    try {
      db.exec(`DROP TABLE dev_environment_vaults;
        DROP TABLE knowledge_role_bindings;
        DELETE FROM schema_migrations WHERE version >= 34;
        INSERT INTO knowledge_projects VALUES('knowledge','Kept','active',1,'now','now');
        INSERT INTO knowledge_tasks(id,project_id,title,description,status,priority,revision,created_by,created_at,updated_at,current_state_json)
        VALUES('task','knowledge','Kept task','History stays','open','now',1,'installation','now','now','{"preserved":"state"}');`);
      if (version === 32) db.exec("ALTER TABLE knowledge_tasks DROP COLUMN current_state_json; DELETE FROM schema_migrations WHERE version=33");
      expect(inspectSchema(db).version).toBe(version);
      const before = db.prepare("SELECT * FROM knowledge_tasks").get() as Record<string, unknown>;
      const provenance = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      // A late failure must undo both new DDL and provenance on the same connection.
      expect(() => initializeSchema(db, false, () => { throw new Error("late migration failure"); })).toThrow("late migration failure");
      expect(inspectSchema(db).version).toBe(version);
      expect(db.prepare("SELECT * FROM knowledge_tasks").get()).toEqual(before);
      expect(db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(provenance);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='dev_environment_vaults'").get()).toBeUndefined();
    } finally { db.close(); }

    const upgraded = new SqliteStateStore(f.path);
    try {
      expect(upgraded.schemaVersion()).toBe(36);
      expect(upgraded.getProject(f.project.id)).toEqual(f.project);
      expect(upgraded.getAuthenticationPolicy()).toEqual(f.policy);
      expect(upgraded.devVault.load(f.project.id)).toBeNull();
    } finally { upgraded.close(); }
    const check = new Database(f.path, { readonly: true });
    try {
      expect(inspectSchema(check).version).toBe(36);
      expect(check.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version BETWEEN 33 AND 34 ORDER BY version").all()).toEqual([
        { version: 33, name: taskCurrentStateMigration.name, checksum: taskCurrentStateChecksum },
        { version: 34, name: devVaultMigration.name, checksum: devVaultChecksum },
      ]);
      expect(check.prepare("SELECT description,current_state_json FROM knowledge_tasks WHERE id='task'").get()).toEqual({
        description: "History stays", current_state_json: version === 33 ? '{"preserved":"state"}' : null,
      });
      expect(check.pragma("foreign_key_check")).toEqual([]);
    } finally { check.close(); }
    new SqliteStateStore(f.path).close();
  });

  it("refuses the old experimental vault-33 lineage without changing ciphertext or provenance", () => {
    const f = fixture();
    const db = new Database(f.path);
    const oldChecksum = createHash("sha256").update(`33\0${devVaultMigration.name}\0${devVaultMigration.sql}`).digest("hex");
    try {
      db.exec("ALTER TABLE knowledge_tasks DROP COLUMN current_state_json; DELETE FROM schema_migrations WHERE version>=33");
      db.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(33,'now',?,?)").run(devVaultMigration.name, oldChecksum);
      db.prepare("INSERT INTO dev_environment_vaults VALUES(?,1,?)").run(f.project.id, "FAKE_CIPHERTEXT_".repeat(4));
    } finally { db.close(); }
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/migration checksum or name/);
    expect(readFileSync(f.path)).toEqual(before);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
  });

  it.each([33, 34])("rejects tampered migration %s before any writes", version => {
    const f = fixture();
    const db = new Database(f.path);
    try { db.prepare("UPDATE schema_migrations SET checksum='wrong' WHERE version=?").run(version); }
    finally { db.close(); }
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/migration checksum or name/);
    expect(readFileSync(f.path)).toEqual(before);
    expect(existsSync(`${f.path}.owner.lock`)).toBe(false);
  });
});
