import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { IdentityService } from "@/server/modules/identity";
import { SqliteStateStore } from "./sqlite-state-store";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { knowledgeRoleChecksum, knowledgeRoleMigration } from "./knowledge-role-migration";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-roles-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const identity = new IdentityService(store);
  const token = identity.bootstrapOwnerSession().token;
  const owner = identity.authenticateBearer(token);
  const project = identity.createKnowledgeProject({ name: "Kept" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:approve"] }, owner);
  return { root, path, store, identity, owner, token, project };
}
describe("Knowledge role migration and persistence", () => {
  it("upgrades 34 atomically without widening grants or replacing owner IDs", () => {
    const f = fixture(); f.store.close();
    const db = new Database(f.path);
    try {
      db.exec("DROP TABLE knowledge_role_bindings; DELETE FROM schema_migrations WHERE version>=35");
      const before = db.prepare("SELECT * FROM knowledge_project_grants").all();
      expect(inspectSchema(db).version).toBe(34);
      expect(() => initializeSchema(db, false, () => { throw new Error("late failure"); })).toThrow("late failure");
      expect(inspectSchema(db).version).toBe(34);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_role_bindings'").get()).toBeUndefined();
      initializeSchema(db, false);
      expect(inspectSchema(db).version).toBe(36);
      expect(db.prepare("SELECT * FROM knowledge_project_grants").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM knowledge_role_bindings").all()).toEqual([]);
      expect(db.prepare("SELECT id,kind FROM remote_principals WHERE id=?").get(f.owner.principalId)).toEqual({ id: f.owner.principalId, kind: "owner" });
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=35").get()).toEqual({ name: knowledgeRoleMigration.name, checksum: knowledgeRoleChecksum });
    } finally { db.close(); }
    const reopened = new SqliteStateStore(f.path);
    try { new IdentityService(reopened).authorizeKnowledge(f.owner, f.project.id, "knowledge:write"); }
    finally { reopened.close(); }
  });
  it("rejects tampered migration provenance before writes", () => {
    const f = fixture(); f.store.close();
    const db = new Database(f.path);
    db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=35"); db.close();
    const before = readFileSync(f.path);
    expect(() => new SqliteStateStore(f.path)).toThrow(/migration checksum/);
    expect(readFileSync(f.path)).toEqual(before);
  });
  it("persists CAS tombstones and audit through backup/restore without reviving legacy access", async () => {
    const f = fixture();
    const target = { principalId: f.owner.principalId, projectId: f.project.id };
    const backup = join(f.root, "backup");
    try {
      const reader = f.identity.setKnowledgeRole({ ...target, role: "reader", expectedRevision: 0 }, f.owner);
      expect(f.store.saveKnowledgeRoleBinding({ ...reader, role: "manager", revision: 1 }, 0, f.owner.principalId)).toBe(false);
      f.identity.revokeKnowledgeRole({ ...target, expectedRevision: 1 }, f.owner);
      await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
    } finally { f.store.close(); }
    const path = join(f.root, "restored.sqlite3");
    restoreControllerBackup(backup, path);
    const restored = new SqliteStateStore(path);
    try {
      expect(restored.getKnowledgeRoleBinding(target.principalId, target.projectId)).toMatchObject({ role: "reader", revision: 2, revokedAt: expect.any(String) });
      const identity = new IdentityService(restored);
      const actor = identity.authenticateBearer(f.token);
      expect(identity.describeIdentity(actor).knowledgeGrants).toEqual([]);
      expect(() => identity.authorizeKnowledge(actor, f.project.id, "knowledge:read")).toThrow();
      // Owner authority can recover an accidentally revoked Knowledge role with a new revision.
      identity.setKnowledgeRole({ ...target, role: "manager", expectedRevision: 2 }, actor);
      identity.authorizeKnowledge(actor, f.project.id, "knowledge:approve");
    } finally { restored.close(); }
    const db = new Database(path, { readonly: true });
    try {
      const audit = db.prepare("SELECT actor,details_json FROM controller_audit_events WHERE event_type='knowledge.role_saved'").all();
      expect(audit).toHaveLength(3);
      expect(JSON.stringify(audit)).not.toContain(f.token);
    } finally { db.close(); }
  });
});
