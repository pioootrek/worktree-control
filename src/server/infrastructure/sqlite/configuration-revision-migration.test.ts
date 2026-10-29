import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { SqliteStateStore } from "./sqlite-state-store";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { configurationRevisionChecksum, configurationRevisionMigration } from "./configuration-revision-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "configuration-revision-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const project = store.addProject({ name: "Kept", repositoryPath: "/code/kept", port: 3502, executable: "pnpm", args: ["run", "dev"] });
  store.saveProjectEnvironmentProfile(project.id, { name: "staging", environment: { KEPT: "1" } }, "test");
  store.setProjectTestPresetTimeout(project.id, "node:test", 1000, "test");
  return { root, path, store, project };
}

describe("configuration revision migration 37", () => {
  it("upgrades 36 atomically with revision 0 for every project and keeps configuration", () => {
    const f = fixture(); f.store.close();
    const db = new Database(f.path);
    try {
      db.exec("ALTER TABLE projects DROP COLUMN configuration_revision; DELETE FROM schema_migrations WHERE version=37");
      expect(inspectSchema(db).version).toBe(36);
      const before = db.prepare("SELECT * FROM projects").all();
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(36);
      expect(db.prepare("SELECT * FROM projects").all()).toEqual(before);
      initializeSchema(db, false);
      expect(inspectSchema(db).version).toBe(37);
      expect(db.prepare("SELECT * FROM projects").all()).toEqual((before as object[]).map(row => ({ ...row, configuration_revision: 0 })));
      expect(db.prepare("SELECT name, checksum FROM schema_migrations WHERE version=37").get())
        .toEqual({ name: configurationRevisionMigration.name, checksum: configurationRevisionChecksum });
    } finally { db.close(); }
    const reopened = new SqliteStateStore(f.path);
    try {
      expect(reopened.getProjectConfigurationRevision(f.project.id)).toBe(0);
      expect(reopened.getProject(f.project.id)).toMatchObject({ testPresetTimeouts: { "node:test": 1000 }, environmentProfiles: [{ name: "default" }, { name: "staging" }] });
      reopened.selectProjectEnvironmentProfile(f.project.id, "staging", "test");
      expect(reopened.getProjectConfigurationRevision(f.project.id)).toBe(1);
      expect(reopened.getProjectConfigurationRevision("missing")).toBeNull();
    } finally { reopened.close(); }
  });

  it("rejects tampered provenance and an invalid revision before writes", () => {
    const f = fixture(); f.store.close();
    const db = new Database(f.path);
    db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=37"); db.close();
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/migration checksum/);
    expect(readFileSync(f.path)).toEqual(before);
    for (const invalid of ["-1", "'text'", "1.5"]) {
      const repaired = new Database(f.path);
      repaired.prepare("UPDATE schema_migrations SET checksum=? WHERE version=37").run(configurationRevisionChecksum);
      repaired.exec(`UPDATE projects SET configuration_revision=${invalid}`);
      repaired.close();
      expect(() => new SqliteStateStore(f.path)).toThrow(/configuration revision/);
    }
  });

  it("round-trips the revision through backup and restore", async () => {
    const f = fixture();
    const backup = join(f.root, "backup");
    try {
      expect(f.store.getProjectConfigurationRevision(f.project.id)).toBe(2);
      await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    } finally { f.store.close(); }
    const path = join(f.root, "restored.sqlite3");
    restoreControllerBackup(backup, path);
    const restored = new SqliteStateStore(path);
    try {
      expect(restored.schemaVersion()).toBe(37);
      expect(restored.getProjectConfigurationRevision(f.project.id)).toBe(2);
    } finally { restored.close(); }
  });
});
