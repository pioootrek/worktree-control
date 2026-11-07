import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { applyHumanPrincipalMigration } from "./human-principal-migration";
import { applyGodotWebMigration } from "./godot-web-migration";
import { applyTestRunRequesterMigration } from "./test-run-requester-migration";
import { runtimeMembershipMigration, runtimeMembershipChecksum } from "./runtime-membership-migration";
import { SqliteStateStore } from "./sqlite-state-store";

/** Frozen pre-42 DDL plus the actual unchanged 42..44 transformations, independent of initializeSchema/45. */
function genuine44(db: Database.Database) {
  db.exec(readFileSync(new URL("./fixtures/schema-v41.sql", import.meta.url), "utf8"));
  db.pragma("foreign_keys=OFF");
  db.transaction(() => { applyHumanPrincipalMigration(db); applyGodotWebMigration(db); applyTestRunRequesterMigration(db); }).immediate();
  db.exec(`INSERT INTO remote_principals VALUES('69849424-2aba-4fdd-b4fa-a394a77a193c','owner','active'),('human','human','active');
    INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
    VALUES('runtime','Runtime','/code/runtime',3601,'node','[]','/',45000,'now','now');
    INSERT INTO knowledge_projects VALUES('runtime','Knowledge','active',1,'now','now');
    INSERT INTO knowledge_project_grants VALUES('69849424-2aba-4fdd-b4fa-a394a77a193c','runtime','["knowledge:read"]',NULL);
    INSERT INTO knowledge_history VALUES(1,'runtime','project','runtime','created',NULL,'69849424-2aba-4fdd-b4fa-a394a77a193c','owner_session',1,'now');`);
}
const kept = (db: Database.Database) => Object.fromEntries(["remote_principals", "principal_credentials", "knowledge_project_grants", "knowledge_role_bindings", "knowledge_history", "runtime_credential_scopes", "runtime_delegations", "test_run_requesters", "projects"].map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
describe("runtime membership migration 45", () => {
  it("recognizes genuine 44, preserves every old migration/identity/history and rolls back the additive change", () => {
    const db = new Database(":memory:");
    try {
      genuine44(db); expect(inspectSchema(db).version).toBe(44);
      const before = kept(db), registry = db.prepare("SELECT * FROM schema_migrations").all();
      expect(() => initializeSchema(db, false, () => { throw new Error("rollback45"); })).toThrow("rollback45");
      expect(inspectSchema(db).version).toBe(44); expect(kept(db)).toEqual(before);
      initializeSchema(db, false, inspectSchema);
      expect(inspectSchema(db).version).toBe(45); expect(kept(db)).toEqual(before);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=44").all()).toEqual(registry);
      expect(db.prepare("SELECT * FROM runtime_human_memberships").all()).toEqual([]);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=45").get())
        .toEqual({ name: runtimeMembershipMigration.name, checksum: runtimeMembershipChecksum });
    } finally { db.close(); }
  });
  it("preserves an explicit aggregate across backup/restore without minting roles or provider sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-membership-backup-")), path = join(root, "state.sqlite3");
    const db = new Database(path); genuine44(db); db.close();
    const store = new SqliteStateStore(path);
    try {
      const row = store.runtimeMemberships().saveRuntimeMembership({ principalId: "human", scope: { kind: "runtime-project", id: "runtime" }, role: "reader", permissions: ["projects:read"], expectedRevision: 0 }, "local-cli", new Date().toISOString());
      await createControllerBackup(store, join(root, "backup"), { applicationVersion: "test", attachmentDirectory: join(root, "attachments") });
      const target = join(root, "restored.sqlite3"); restoreControllerBackup(join(root, "backup"), target);
      const restored = new SqliteStateStore(target);
      try {
        expect(restored.schemaVersion()).toBe(45);
        expect(restored.runtimeMemberships().getRuntimeMembership("human", "runtime")).toEqual(row);
        expect(restored.listPrincipalCredentials("human")).toEqual([]);
        expect(restored.hasAuthenticationProviderData()).toBe(false);
      } finally { restored.close(); }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["checksum", "premature", "kind"])("refuses malformed %s before writing the source", mode => {
    const root = mkdtempSync(join(tmpdir(), "runtime-membership-malformed-")), path = join(root, "state.sqlite3");
    try {
      const db = new Database(path); genuine44(db); initializeSchema(db, false, inspectSchema);
      if (mode === "checksum") db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=45");
      if (mode === "premature") db.exec("DELETE FROM schema_migrations WHERE version=45");
      if (mode === "kind") db.exec(`INSERT INTO remote_principals VALUES('agent','agent','active');
        INSERT INTO runtime_human_memberships VALUES('agent','runtime','runtime-project','reader','["projects:read"]',1,'now',NULL)`);
      db.close(); const before = readFileSync(path);
      expect(() => new SqliteStateStore(path)).toThrow(/schema|runtime membership principal/);
      expect(readFileSync(path)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
