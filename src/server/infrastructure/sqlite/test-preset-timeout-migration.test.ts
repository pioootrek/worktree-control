import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { testPresetTimeoutMigration, testPresetTimeoutChecksum } from "./test-preset-timeout-migration";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("upgrades schema 30 with empty overrides, preserves policies, rolls back failures and reopens", () => {
  const dir = mkdtempSync(join(tmpdir(), "wtc-timeout-migration-")); dirs.push(dir);
  const path = join(dir, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const project = store.addProject({ name: "Godot", repositoryPath: "/code/game", port: 3500, launchPreset: "none", executable: "", args: [] });
  store.assignProjectTestPresetProfile(project.id, "godot:check", "tooling", "local-user");
  store.setTestQueueSettings({ limit: 2 });
  store.close();
  const db = new Database(path);
  try {
    db.exec("ALTER TABLE projects DROP COLUMN test_preset_timeouts_json; DELETE FROM schema_migrations WHERE version>=31; DROP TABLE remote_verification_reports; DROP TABLE remote_verification_cancellations; DROP TABLE remote_worker_receipts; ALTER TABLE knowledge_tasks DROP COLUMN current_state_json;");
    expect(inspectSchema(db).version).toBe(30);
    const before = db.prepare("SELECT * FROM projects").get();
    expect(() => initializeSchema(db, false, () => { throw new Error("injected failure"); })).toThrow("injected failure");
    expect(inspectSchema(db).version).toBe(30);
    expect(db.prepare("SELECT * FROM projects").get()).toEqual(before);
    initializeSchema(db);
    expect(inspectSchema(db).version).toBe(33);
    expect(db.prepare("SELECT * FROM projects").get()).toEqual({ ...before as object, test_preset_timeouts_json: "{}" });
    expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=31").get()).toEqual({ name: testPresetTimeoutMigration.name, checksum: testPresetTimeoutChecksum });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
  const reopened = new SqliteStateStore(path);
  try {
    expect(reopened.getProject(project.id)!.testPresetTimeouts).toEqual({});
    expect(reopened.getProject(project.id)!.testPresetProfiles).toEqual({ "godot:check": "tooling" });
    expect(reopened.getTestQueueSettings()).toEqual({ limit: 2 });
  } finally { reopened.close(); }
});
