import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AuthenticationService } from "@/server/modules/authentication";
import { SqliteStateStore } from "./index";

const directories: string[] = [];
const NOW = "2026-09-26T12:00:00.000Z";

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-authentication-"));
  directories.push(directory);
  return join(directory, "state.sqlite3");
}

/** Restores the pre-migration-25 table definitions so the upgrade path runs against real rows. */
function downgradeToMigration24(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = OFF");
  const restore = (table: string, from: string, to: string) => {
    const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
    const indexes = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .all(table) as Array<{ sql: string }>;
    database.exec(sql.replace(from, to).replace(/^CREATE TABLE (?:IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE ${table}_old`));
    database.exec(`INSERT INTO ${table}_old SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_old RENAME TO ${table};`);
    for (const index of indexes) database.exec(index.sql);
  };
  database.exec("DELETE FROM remote_principals WHERE id = 'installation'");
  restore("remote_principals", "'worker', 'installation'", "'worker'");
  restore("knowledge_history", ", 'installation_token', 'none'", "");
  database.exec(`
    DELETE FROM controller_settings WHERE key = 'authentication';
    DELETE FROM schema_migrations WHERE version = 25;
    INSERT INTO remote_principals(id, kind, status) VALUES ('owner-1', 'owner', 'active');
    INSERT INTO knowledge_projects(id, name, status, revision, created_at, updated_at)
      VALUES ('project-1', 'Existing', 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO knowledge_history(project_id, record_kind, record_id, operation, previous_json, principal_id, authentication_method, revision, created_at)
      VALUES ('project-1', 'project', 'project-1', 'created', NULL, 'owner-1', 'owner_session', 1, '${NOW}');
  `);
  database.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("authentication policy SQLite persistence", () => {
  it("migrates an existing installation to the legacy policy without losing principals or history", () => {
    const path = databasePath();
    new SqliteStateStore(path).close();
    downgradeToMigration24(path);

    const store = new SqliteStateStore(path);
    expect(store.schemaVersion()).toBe(25);
    expect(store.getPrincipal("owner-1")).toEqual({ id: "owner-1", kind: "owner", status: "active" });
    expect(store.getPrincipal("installation")).toEqual({ id: "installation", kind: "installation", status: "active" });
    expect(store.getAuthenticationPolicy()).toEqual({ mode: "legacy", token: null, generation: 0 });
    store.close();

    const database = new Database(path);
    database.pragma("foreign_keys = ON");
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.prepare("SELECT principal_id, authentication_method FROM knowledge_history").all())
      .toEqual([{ principal_id: "owner-1", authentication_method: "owner_session" }]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'knowledge_history_record'").get())
      .toEqual({ name: "knowledge_history_record" });
    database.prepare(`
      INSERT INTO knowledge_history(project_id, record_kind, record_id, operation, previous_json, principal_id, authentication_method, revision, created_at)
      VALUES ('project-1', 'project', 'project-1', 'updated', NULL, 'installation', 'none', 2, ?)
    `).run(NOW);
    expect(() => database.prepare("INSERT INTO remote_principals(id, kind, status) VALUES ('x', 'robot', 'active')").run())
      .toThrow(/CHECK constraint/);
    expect(() => database.prepare("INSERT INTO knowledge_history(project_id, record_kind, record_id, operation, previous_json, principal_id, authentication_method, revision, created_at) VALUES ('project-1', 'project', 'project-1', 'updated', NULL, 'missing', 'none', 3, ?)").run(NOW))
      .toThrow(/FOREIGN KEY/);
    database.close();
  });

  it("starts a new installation in token mode without a token", () => {
    const store = new SqliteStateStore(databasePath());
    expect(store.getAuthenticationPolicy()).toEqual({ mode: "token", token: null, generation: 0 });
    expect(() => new AuthenticationService(store).assertStartupPolicy()).toThrow("auth token generate");
    store.close();
  });

  it("persists the token verifier across restarts and audits changes without the secret", () => {
    const path = databasePath();
    const first = new SqliteStateStore(path);
    const issued = new AuthenticationService(first).generateToken("local-cli");
    first.close();

    const reopened = new SqliteStateStore(path);
    const auth = new AuthenticationService(reopened);
    expect(auth.verifyInstallationToken(issued.token)).toBe(true);
    expect(auth.status().token?.prefix).toBe(issued.status.token?.prefix);
    reopened.close();

    const database = new Database(path);
    const secret = issued.token.split("_").at(-1)!;
    const stored = database.prepare("SELECT value_json FROM controller_settings WHERE key = 'authentication'").get() as { value_json: string };
    const audit = database.prepare("SELECT event_type, actor, details_json FROM controller_audit_events WHERE event_type LIKE 'authentication.%'").all();
    expect(stored.value_json).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(audit).toEqual([{
      event_type: "authentication.token_generated",
      actor: "local-cli",
      details_json: JSON.stringify({ mode: "token", tokenPrefix: issued.status.token?.prefix, generation: 1 }),
    }]);
    database.close();
  });

  it("fails closed on a corrupted or missing policy instead of choosing a weaker mode", () => {
    const path = databasePath();
    new SqliteStateStore(path).close();
    const database = new Database(path);
    database.prepare("UPDATE controller_settings SET value_json = ? WHERE key = 'authentication'").run(JSON.stringify({ mode: "anything" }));
    database.close();

    const corrupted = new SqliteStateStore(path);
    expect(() => new AuthenticationService(corrupted).assertStartupPolicy()).toThrow("Zapisana polityka uwierzytelniania jest nieprawidłowa.");
    corrupted.close();

    const raw = new Database(path);
    raw.exec("DELETE FROM controller_settings WHERE key = 'authentication'");
    raw.close();
    const missing = new SqliteStateStore(path);
    expect(() => missing.getAuthenticationPolicy()).toThrow("Brak zapisanej polityki uwierzytelniania.");
    missing.close();
  });
});
