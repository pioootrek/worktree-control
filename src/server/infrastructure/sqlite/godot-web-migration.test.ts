import { createHash } from "node:crypto";
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

const fixture42 = readFileSync(new URL("./fixtures/schema-v42.sql", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const at = "2026-11-06T00:00:00.000Z";
/** Children of `projects` added by main's migrations 36–42 must keep their foreign keys through the rebuild. */
const projectChildren = ["reservations", "runtime_delegations", "runtime_credential_scopes", "audit_events", "test_run_summaries", "remote_worker_project_grants"];

/** The genuine schema-42 file of the released main line, populated with a registered project and its runtime-access rows. */
function v42() {
  const root = mkdtempSync(join(tmpdir(), "wtc-godot-web-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const db = new Database(path);
  try {
    db.exec(fixture42);
    db.exec(`
      INSERT INTO projects(id,name,repository_path,port,launch_preset,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at,configuration_revision)
        VALUES('kept','Kept','/code/kept',3301,'none','','[]','/',30000,'${at}','${at}',7);
      INSERT INTO audit_events(project_id,event_type,actor,details_json,created_at) VALUES('kept','kept','fixture','{}','${at}');
      INSERT INTO remote_principals VALUES('owner','owner','active'),('agent','agent','active');
      INSERT INTO principal_credentials VALUES('credential','agent','agent_token','Agent','prefix','${"a".repeat(64)}','active',NULL,'${at}','${at}',NULL);
      INSERT INTO runtime_delegations VALUES('agent','kept','owner','["runtime:read"]',1,NULL,'${at}',NULL);
      INSERT INTO runtime_credential_scopes VALUES('credential','kept','["runtime:read"]','${at}');
    `);
  } finally { db.close(); }
  return path;
}

const foreignKeys = (db: Database.Database) => Object.fromEntries(projectChildren.map((table) => [table, db.prepare(`PRAGMA foreign_key_list(${table})`).all()]));
const rows = (db: Database.Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();

describe("Godot Web migration 43", () => {
  it("upgrades genuine schema 42 atomically, keeps rows, revision and child foreign keys, and records provenance", () => {
    const path = v42();
    const db = new Database(path);
    try {
      expect(inspectSchema(db)).toEqual({ version: 42, fresh: false });
      const before = rows(db, "projects");
      const audit = rows(db, "audit_events");
      const delegations = rows(db, "runtime_delegations");
      const scopes = rows(db, "runtime_credential_scopes");
      const registry = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const keys = foreignKeys(db);
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(42);
      expect(rows(db, "projects")).toEqual(before);
      initializeSchema(db, false, inspectSchema);
      expect(inspectSchema(db)).toEqual({ version: 47, fresh: false });
      expect(rows(db, "projects")).toEqual((before as object[]).map((row) => ({ ...row, godot_web_json: null })));
      expect(rows(db, "audit_events")).toEqual(audit);
      expect(rows(db, "runtime_delegations")).toEqual(delegations);
      expect(rows(db, "runtime_credential_scopes")).toEqual(scopes);
      // Released migrations keep their records and checksums; Godot Web is appended after them.
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=42 ORDER BY version").all()).toEqual(registry);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=43").get()).toEqual({ name: godotWebMigration.name, checksum: godotWebChecksum });
      expect(foreignKeys(db)).toEqual(keys);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      // The rebuilt parent still cascades to main's runtime-access children.
      db.pragma("foreign_keys=ON");
      db.prepare("DELETE FROM projects WHERE id='kept'").run();
      expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_delegations").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_credential_scopes").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("opens schema 42 through the store and counts Godot Web configuration as a configuration revision", () => {
    const path = v42();
    const store = new SqliteStateStore(path);
    try {
      expect(store.schemaVersion()).toBe(47);
      expect(store.getProject("kept")).toMatchObject({ launchPreset: "none", godotWeb: null });
      expect(store.getProjectConfigurationRevision("kept")).toBe(7);
      store.setProjectGodotWeb("kept", { launchPreset: "godot-web", godotWeb: DEFAULT_GODOT_WEB_CONFIG, executable: "node", args: ["server.js"] }, "local-user");
      expect(store.getProject("kept")).toMatchObject({ launchPreset: "godot-web", godotWeb: DEFAULT_GODOT_WEB_CONFIG, executable: "node", tlsMode: "off" });
      // Scoped configuration commits compare this revision; an installation change must invalidate stale expectations.
      expect(store.getProjectConfigurationRevision("kept")).toBe(8);
      expect(() => store.setProjectGodotWeb("kept", { launchPreset: "none", godotWeb: DEFAULT_GODOT_WEB_CONFIG, executable: "", args: [] }, "local-user")).toThrow("requires the godot-web preset");
      expect(store.getProjectConfigurationRevision("kept")).toBe(8);
    } finally { store.close(); }
    const check = new Database(path, { readonly: true });
    try {
      const events = check.prepare("SELECT event_type, actor FROM audit_events WHERE event_type='project.godot_web_configured'").all();
      expect(events).toEqual([{ event_type: "project.godot_web_configured", actor: "local-user" }]);
    } finally { check.close(); }
  });

  it("refuses an unknown preset and a tampered migration record", () => {
    const path = v42();
    new SqliteStateStore(path).close();
    const db = new Database(path);
    try {
      expect(() => db.prepare("UPDATE projects SET launch_preset='unity'").run()).toThrow(/CHECK constraint/);
      db.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=43").run();
    } finally { db.close(); }
    const before = readFileSync(path);
    expect(() => new SqliteStateStore(path)).toThrow(/migration checksum or name/);
    expect(readFileSync(path)).toEqual(before);
  });

  it("refuses an unreleased pre-integration database that recorded Godot Web as version 35", () => {
    const path = v42();
    // The feature branch once used version 35; main released 35 as Knowledge role bindings.
    const sql = godotWebMigration.sql;
    const name = "godot-web-runtime-preset";
    const legacyChecksum = createHash("sha256").update(`35\0${name}\0${sql}`).digest("hex");
    const db = new Database(path);
    try { db.prepare("UPDATE schema_migrations SET name=?, checksum=? WHERE version=35").run(name, legacyChecksum); }
    finally { db.close(); }
    const before = readFileSync(path);
    expect(() => new SqliteStateStore(path)).toThrow(/migration checksum or name/);
    expect(readFileSync(path)).toEqual(before);
  });
});
