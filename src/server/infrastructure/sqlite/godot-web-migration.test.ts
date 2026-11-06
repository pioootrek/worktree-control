import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_GODOT_WEB_CONFIG } from "@/shared/contracts/godot-web";
import { SqliteStateStore } from "./index";
import { godotWebChecksum, godotWebMigration } from "./godot-web-migration";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A real v34 shape: the previous CHECK and no configuration column. */
function v34() {
  const root = mkdtempSync(join(tmpdir(), "wtc-godot-web-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const kept = store.addProject({ name: "Kept", repositoryPath: "/code/kept", port: 3301, launchPreset: "none", executable: "", args: [] });
  store.recordProjectEvent(kept.id, "kept", "fixture", {});
  store.close();
  const db = new Database(path);
  db.pragma("foreign_keys=OFF");
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='projects'").get() as { sql: string }).sql.replace(", 'godot-web'", "");
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='projects' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  db.exec("ALTER TABLE projects DROP COLUMN godot_web_json");
  db.exec(sql.replace(", godot_web_json TEXT", "").replace(/^CREATE TABLE "?\w+"?/, "CREATE TABLE projects_old"));
  db.exec("INSERT INTO projects_old SELECT * FROM projects; DROP TABLE projects; ALTER TABLE projects_old RENAME TO projects;");
  for (const index of indexes) db.exec(index.sql);
  db.exec("DELETE FROM schema_migrations WHERE version = 35");
  db.close();
  return { path, kept };
}

describe("Godot Web migration 35", () => {
  it("upgrades v34 atomically, keeps rows unconfigured and records provenance", () => {
    const f = v34();
    const db = new Database(f.path);
    try {
      expect(inspectSchema(db).version).toBe(34);
      const before = db.prepare("SELECT * FROM projects").all();
      const audit = db.prepare("SELECT * FROM audit_events").all();
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(34);
      expect(db.prepare("SELECT * FROM projects").all()).toEqual(before);
      initializeSchema(db);
      expect(inspectSchema(db).version).toBe(35);
      expect(db.prepare("SELECT * FROM projects").all()).toEqual((before as object[]).map((row) => ({ ...row, godot_web_json: null })));
      expect(db.prepare("SELECT * FROM audit_events").all()).toEqual(audit);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=35").get()).toEqual({ name: godotWebMigration.name, checksum: godotWebChecksum });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
    const store = new SqliteStateStore(f.path);
    try {
      expect(store.getProject(f.kept.id)).toMatchObject({ launchPreset: "none", godotWeb: null });
      store.setProjectGodotWeb(f.kept.id, { launchPreset: "godot-web", godotWeb: DEFAULT_GODOT_WEB_CONFIG, executable: "node", args: ["server.js"] }, "local-user");
      expect(store.getProject(f.kept.id)).toMatchObject({ launchPreset: "godot-web", godotWeb: DEFAULT_GODOT_WEB_CONFIG, executable: "node", tlsMode: "off" });
      expect(() => store.setProjectGodotWeb(f.kept.id, { launchPreset: "none", godotWeb: DEFAULT_GODOT_WEB_CONFIG, executable: "", args: [] }, "local-user")).toThrow("requires the godot-web preset");
    } finally { store.close(); }
    const check = new Database(f.path, { readonly: true });
    try {
      const events = check.prepare("SELECT event_type, actor FROM audit_events WHERE event_type='project.godot_web_configured'").all();
      expect(events).toEqual([{ event_type: "project.godot_web_configured", actor: "local-user" }]);
    } finally { check.close(); }
  });

  it("refuses an unknown preset and a tampered migration record", () => {
    const f = v34();
    new SqliteStateStore(f.path).close();
    const db = new Database(f.path);
    try {
      expect(() => db.prepare("UPDATE projects SET launch_preset='unity'").run()).toThrow(/CHECK constraint/);
      db.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=35").run();
    } finally { db.close(); }
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/migration checksum or name/);
    expect(readFileSync(f.path)).toEqual(before);
  });
});
