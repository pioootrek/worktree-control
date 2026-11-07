import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { humanConfigurationFingerprint, type HumanConfigurationIntent } from "@/server/modules/environments";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { applyHumanPrincipalMigration } from "./human-principal-migration";
import { applyGodotWebMigration } from "./godot-web-migration";
import { applyTestRunRequesterMigration } from "./test-run-requester-migration";
import { applyRuntimeMembershipMigration } from "./runtime-membership-migration";
import { applyHumanRuntimeMigration } from "./human-runtime-migration";
import { applyHumanTestRunMigration } from "./human-test-run-migration";
import { humanConfigurationChecksum, humanConfigurationMigration } from "./human-configuration-migration";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SqliteStateStore } from "./sqlite-state-store";

function genuine47(db: Database.Database) {
  db.exec(readFileSync(new URL("./fixtures/schema-v41.sql", import.meta.url), "utf8"));
  db.pragma("foreign_keys=OFF");
  db.transaction(() => {
    applyHumanPrincipalMigration(db); applyGodotWebMigration(db); applyTestRunRequesterMigration(db);
    applyRuntimeMembershipMigration(db); applyHumanRuntimeMigration(db); applyHumanTestRunMigration(db);
  }).immediate();
  db.exec(`INSERT INTO remote_principals VALUES('human','human','active');
    INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
    VALUES('p','Runtime','/code/runtime',3601,'node','[]','/',45000,'now','now');
    INSERT INTO runtime_human_memberships VALUES('human','p','runtime-project','operator','["claims:manage"]',1,'now',NULL);`);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "human-configuration-")), path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  store.humanAccounts().createHumanPrincipal({ id: "human", kind: "human", status: "active" }, "local-cli");
  const project = store.addProject({ name: "P", repositoryPath: root, port: 3700, executable: "node", args: [] });
  store.runtimeMemberships().saveRuntimeMembership({ principalId: "human", scope: { kind: "runtime-project", id: project.id }, role: "operator", permissions: ["config:write"], expectedRevision: 0 }, "local-cli", new Date().toISOString());
  const authority = { principalId: "human", sessionKey: "a".repeat(64), evidenceKey: "b".repeat(64), generation: 1,
    deadline: new Date(Date.now() + 3600000).toISOString(), membershipRevision: 1, permissions: ["config:write" as const] };
  const request = { projectId: project.id, worktreePath: root, presetId: "node:test", timeoutMs: 1234, expectedRevision: 0,
    idempotencyKey: "timeout", operation: "set_test_preset_timeout" as const };
  const intent: HumanConfigurationIntent = { authority, request, projectId: project.id, key: request.idempotencyKey,
    fingerprint: "", reservationId: null, worktreePath: root };
  intent.fingerprint = humanConfigurationFingerprint(intent);
  const db = (store as unknown as { database: Database.Database }).database;
  return { root, path, store, project, intent, db, remove: () => rmSync(root, { recursive: true, force: true }) };
}
describe("human configuration schema48 and atomic ledger", () => {
  it("upgrades genuine47 without changing history, identities, grants or memberships and rolls back a failed upgrade", () => {
    const db = new Database(":memory:");
    try {
      genuine47(db); expect(inspectSchema(db).version).toBe(47);
      const tables = ["schema_migrations", "remote_principals", "principal_credentials", "runtime_human_memberships", "reservations", "knowledge_history", "runtime_credential_scopes", "test_runs"];
      const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all());
      expect(() => initializeSchema(db, false, () => { throw new Error("rollback48"); })).toThrow("rollback48");
      expect(inspectSchema(db).version).toBe(47); expect(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
      initializeSchema(db, false, inspectSchema); expect(inspectSchema(db).version).toBe(48);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=47").all()).toEqual(before[0]);
      expect(tables.slice(1).map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before.slice(1));
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=48").get()).toEqual({ name: humanConfigurationMigration.name, checksum: humanConfigurationChecksum });
      db.prepare("UPDATE runtime_human_memberships SET permissions_json=?").run('["projects:read","claims:manage","runtime:control","tests:run","profiles:select","config:write"]');
    } finally { db.close(); }
  });
  it("rolls back mutation, revision, audit and completed receipt when receipt persistence fails", () => {
    const f = fixture();
    try {
      f.store.beginHumanConfiguration(f.intent);
      f.db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE OF state ON human_runtime_intents WHEN NEW.configuration_bound=1 BEGIN SELECT RAISE(ABORT,'receipt failure'); END");
      expect(() => f.store.commitHumanConfiguration({ intent: f.intent, operationId: randomUUID() })).toThrow("receipt failure");
      expect(f.store.getProjectConfigurationRevision(f.project.id)).toBe(0);
      expect(f.store.getProject(f.project.id)?.testPresetTimeouts).toEqual({});
      expect(f.db.prepare("SELECT * FROM audit_events WHERE event_type LIKE 'configuration.%'").all()).toEqual([]);
      expect(f.db.prepare("SELECT state,result_json,configuration_bound FROM human_runtime_intents").get()).toEqual({ state: "pending", result_json: null, configuration_bound: 1 });
      expect(() => f.store.beginHumanConfiguration(f.intent)).toThrow(/unknown/);
    } finally { f.store.close(); f.remove(); }
  });
  it("retains original receipt and human attribution through reopen and backup, without duplicate effects", async () => {
    const f = fixture(); let reopened: SqliteStateStore | undefined;
    try {
      f.store.beginHumanConfiguration(f.intent);
      const receipt = f.store.commitHumanConfiguration({ intent: f.intent, operationId: randomUUID() });
      const events = f.db.prepare("SELECT details_json FROM audit_events WHERE event_type LIKE 'configuration.%'").all();
      expect(JSON.stringify(events)).toContain('provider_session'); expect(JSON.stringify(events)).not.toContain('credentialId');
      const backup = join(f.root, "backup");
      await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
      f.store.close(); reopened = new SqliteStateStore(f.path);
      expect(reopened.beginHumanConfiguration(f.intent)).toEqual(receipt);
      expect(reopened.getProjectConfigurationRevision(f.project.id)).toBe(1);
      reopened.close();
      const restored = join(f.root, "restored.sqlite3"); restoreControllerBackup(backup, restored);
      reopened = new SqliteStateStore(restored); expect(reopened.beginHumanConfiguration(f.intent)).toEqual(receipt);
      // Storage retains evidence only. Actual provider authority is still required by the application.
    } finally { reopened?.close(); f.store.close(); f.remove(); }
  });
  it("shares CAS with the historical agent mutation and rejects changed intent fields", () => {
    const f = fixture();
    try {
      f.store.beginHumanConfiguration(f.intent);
      expect(f.store.commitScopedConfiguration({ projectId: f.project.id, expectedRevision: 0, claim: null,
        change: { kind: "set_test_preset_timeout", presetId: "node:test", timeoutMs: 2000, overrideLimit: 256 },
        attribution: { principalId: "agent", credentialId: "agent-credential", operationId: randomUUID() } })).toMatchObject({ status: "completed", revision: 1 });
      expect(() => f.store.commitHumanConfiguration({ intent: f.intent, operationId: randomUUID() })).toThrow(/refused/);
      expect(f.store.getProject(f.project.id)?.testPresetTimeouts).toEqual({ "node:test": 2000 });
      const changed = { ...f.intent, request: { ...f.intent.request, timeoutMs: 9999 } };
      expect(() => f.store.beginHumanConfiguration(changed)).toThrow();
      expect(f.db.prepare("SELECT count(*) n FROM audit_events WHERE event_type LIKE 'configuration.%'").get()).toEqual({ n: 1 });
    } finally { f.store.close(); f.remove(); }
  });
  it.each(["context", "marker", "checksum", "premature"])("refuses corrupted %s on reopen without repairing the database", mode => {
    const f = fixture();
    try {
      f.store.beginHumanConfiguration(f.intent); f.store.commitHumanConfiguration({ intent: f.intent, operationId: randomUUID() }); f.store.close();
      const db = new Database(f.path);
      if (mode === "context") db.exec("UPDATE human_runtime_intents SET configuration_context_json=NULL");
      if (mode === "marker") db.exec("UPDATE human_runtime_intents SET configuration_bound=0");
      if (mode === "checksum") db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=48");
      if (mode === "premature") db.exec("DELETE FROM schema_migrations WHERE version=48");
      db.close(); const before = readFileSync(f.path);
      expect(() => new SqliteStateStore(f.path)).toThrow(/schema|human configuration/); expect(readFileSync(f.path)).toEqual(before);
    } finally { f.store.close(); f.remove(); }
  });
  it.each(["session", "global"])("fails closed at the shared %s budget without evicting any live key", kind => {
    const f = fixture();
    try {
      const count = kind === "session" ? 128 : 4096;
      const insert = f.db.prepare(`INSERT INTO human_runtime_intents(session_key,idempotency_key,principal_id,project_id,membership_revision,fingerprint,state,retain_until) VALUES(?,?,?,?,1,?,'pending',?)`);
      f.db.transaction(() => { for (let n = 0; n < count; n++) insert.run(kind === "session" ? f.intent.authority.sessionKey : n.toString(16).padStart(64, "0"), `key-${n}`, "human", f.project.id, "c".repeat(64), f.intent.authority.deadline); })();
      expect(() => f.store.beginHumanConfiguration(f.intent)).toThrow(/capacity/);
      expect(f.db.prepare("SELECT count(*) n FROM human_runtime_intents").get()).toEqual({ n: count });
    } finally { f.store.close(); f.remove(); }
  });
});
