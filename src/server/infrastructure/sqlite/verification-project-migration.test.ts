import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { OwnedSqliteDatabase, SqliteStateStore, inspectSchema } from "./index";
import { initializeSchema } from "./migrations";
import { verificationProjectChecksum, verificationProjectMigration } from "./verification-project-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-godot-migration-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const db = new Database(path);
  db.exec(readFileSync(new URL("./fixtures/schema-v26.sql", import.meta.url), "utf8"));
  for (const preset of ["node", "django"]) {
    db.prepare(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at,launch_preset,environment_profiles_json,test_environment_profiles_json)
      VALUES(?,?,?,?,?,'[]','/',45000,'then','then',?,?,?)`).run(preset, preset, `/code/${preset}`, preset === "node" ? 3210 : 3211, preset === "node" ? "npm" : "python3", preset,
      '[{"name":"qa","environment":{"KEPT":"yes"}}]', '[{"name":"tooling","policy":{"mode":"clean","serverProfile":null},"environment":{"GODOT_BIN":"/fixture/godot"},"nodeEnv":null,"requiredVariables":[]}]');
    db.prepare(`INSERT INTO test_runs(id,project_id,worktree_path,worktree_head,worktree_dirty,preset_id,preset_name,adapter,actor,phase,executable,args_json,cwd,queued_at,logs_json)
      VALUES(?,?,?,'abc',0,?,'test',?,'fixture','passed',?,'[]',?,'2026-10-19T00:00:00Z','["kept output"]')`).run(preset, preset, `/code/${preset}`, `${preset}:test`, preset, preset === "node" ? "npm" : "python3", `/code/${preset}`);
    db.prepare(`INSERT INTO audit_events(project_id,event_type,actor,details_json,created_at) VALUES(?,'kept','fixture','{}','then')`).run(preset);
    db.prepare(`INSERT INTO reservations(id,project_id,worktree_path,kind,owner,created_at) VALUES(?,?,?,'human','fixture','then')`).run(preset, preset, `/code/${preset}`);
  }
  // Produce the immediately preceding schema through the frozen upgrade path, then
  // revert only the new constraints/record. The two populated table shapes remain real v29.
  initializeSchema(db);
  db.pragma("foreign_keys=OFF");
  for (const [table, extra] of [["projects", ", 'none'"], ["test_runs", ", 'godot'"]]) {
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql;
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table) as Array<{ sql: string }>;
    db.exec(sql.replace(extra, "").replace(/^CREATE TABLE "?\w+"?/, `CREATE TABLE ${table}_old`));
    db.exec(`INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table};`);
    for (const index of indexes) db.exec(index.sql);
  }
  db.exec("DELETE FROM schema_migrations WHERE version=30"); db.close();
  return { path };
}
function contents(db: Database.Database) {
  return Object.fromEntries(["projects", "test_runs", "reservations", "audit_events", "test_run_summaries", "test_summary_coverage"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("verification projects migration 30", () => {
  it("preserves populated Node/Django rows, profiles, summaries, FK references and indexes across upgrade/reopen", () => {
    const f = fixture(); const beforeDb = new Database(f.path);
    expect(inspectSchema(beforeDb).version).toBe(29);
    const before = contents(beforeDb);
    const indexes = beforeDb.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all(); beforeDb.close();
    const owned = new OwnedSqliteDatabase(f.path); const store = new SqliteStateStore(f.path, owned);
    try {
      expect(contents(owned.database)).toEqual(before);
      expect(owned.database.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()).toEqual(indexes);
      expect(owned.database.pragma("foreign_key_check")).toEqual([]);
      expect(owned.database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(owned.database.prepare("SELECT name,checksum FROM schema_migrations WHERE version=30").get()).toEqual({ name: verificationProjectMigration.name, checksum: verificationProjectChecksum });
      expect(store.getProject("node")?.testEnvironmentProfiles[0].environment).toEqual({ GODOT_BIN: "/fixture/godot" });
      const project = store.addProject({ name: "Godot", repositoryPath: "/code/godot", port: 3212, launchPreset: "none", executable: "", args: [] });
      const run = store.getTestRun("node")!;
      store.saveTestRun({ ...run, id: "godot", projectId: project.id, adapter: "godot", presetId: "godot:check" });
      expect(store.getTestRun("godot")?.adapter).toBe("godot");
    } finally { store.close(); }
    const reopened = new SqliteStateStore(f.path);
    expect(reopened.getTestRun("django")?.logs).toEqual(["kept output"]);
    expect(reopened.getTestRun("godot")?.adapter).toBe("godot"); reopened.close();
  });

  it("rolls both rebuilds and provenance back on validation failure, then upgrades cleanly", () => {
    const f = fixture(); const db = new Database(f.path); db.pragma("foreign_keys=ON");
    const before = contents(db);
    expect(() => initializeSchema(db, false, () => { throw new Error("injected validation failure"); })).toThrow("injected");
    expect(inspectSchema(db).version).toBe(29);
    expect(contents(db)).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
    new SqliteStateStore(f.path).close();
  });
});
