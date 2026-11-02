import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HumanAccountService, IdentityService } from "@/server/modules/identity";
import { HumanAccountQueries } from "./human-account-queries";
import { IdentityQueries } from "./identity-queries";
import { initializeSchema } from "./migrations";

const NOW = "2026-11-02T12:00:00.000Z";
function fixture() {
  const db = new Database(":memory:"); initializeSchema(db); db.pragma("foreign_keys = ON");
  const queries = new IdentityQueries(db), identity = new IdentityService(queries);
  const owner = identity.bootstrapOwnerSession(), actor = identity.authenticateBearer(owner.token);
  const humans = new HumanAccountService(new HumanAccountQueries(db), "local-cli", () => NOW);
  const human = humans.create(), project = identity.createKnowledgeProject({ name: "Knowledge" }, actor);
  const input = { principalId: human.id, scope: { kind: "knowledge-project" as const, id: project.id }, role: "operator" as const,
    permissions: ["knowledge:read", "knowledge:write"], expectedRevision: 0 };
  return { db, queries, identity, owner, actor, humans, human, project, input };
}
describe("ordinary human account aggregate", () => {
  it("creates no implicit authority, bounds pages, preserves owner semantics, and disables exactly once", () => {
    const f = fixture();
    try {
      expect(f.queries.listPrincipalCredentials(f.human.id)).toEqual([]);
      expect(f.queries.listKnowledgeProjectGrants(f.human.id)).toEqual([]);
      expect(f.identity.ownerPrincipalStatus()).toMatchObject({ state: "single", principal: { id: f.owner.principalId, kind: "owner" } });
      for (let i = 0; i < 21; i++) f.humans.create();
      const first = f.humans.list({ limit: 20 }); expect(first.items).toHaveLength(20);
      const second = f.humans.list({ limit: 20, after: first.nextAfter }); expect(second.items).toHaveLength(2); expect(second.nextAfter).toBeNull();
      expect(new Set([...first.items, ...second.items].map(p => p.id)).size).toBe(22);
      expect(f.humans.disable(f.human.id)).toEqual({ changed: true, principal: { ...f.human, status: "revoked" } });
      expect(f.humans.disable(f.human.id).changed).toBe(false);
      expect(f.db.prepare("SELECT count(*) n FROM controller_audit_events WHERE event_type='identity.human_disabled'").get()).toEqual({ n: 1 });
      expect(() => f.humans.set(f.input)).toThrowError(expect.objectContaining({ code: "principal_unavailable" }));
      expect(() => f.queries.savePrincipal({ ...f.human, status: "active" }, "legacy")).toThrow();
      expect(() => f.humans.disable(f.owner.principalId)).toThrow();
      expect(() => f.humans.list({ limit: 21 })).toThrow();
    } finally { f.db.close(); }
  });
  it("uses one revision for permission and role changes, tombstones both rows, and restores only explicitly", () => {
    const f = fixture();
    try {
      expect(f.humans.set(f.input)).toMatchObject({ revision: 1, effectivePermissions: ["knowledge:read", "knowledge:write"] });
      expect(f.humans.set({ ...f.input, role: "reader", expectedRevision: 1 })).toMatchObject({ revision: 2, effectivePermissions: ["knowledge:read"] });
      expect(f.humans.set({ ...f.input, permissions: ["knowledge:read"], expectedRevision: 2 })).toMatchObject({ revision: 3, effectivePermissions: ["knowledge:read"] });
      expect(() => f.humans.set({ ...f.input, expectedRevision: 2 })).toThrowError(expect.objectContaining({ code: "membership_revision_conflict" }));
      const revoke = { principalId: f.human.id, scope: f.input.scope, expectedRevision: 3 };
      expect(f.humans.revoke(revoke)).toMatchObject({ revision: 4, revokedAt: NOW, grant: { revokedAt: NOW }, effectivePermissions: [] });
      expect(() => f.humans.revoke(revoke)).toThrow();
      expect(() => f.humans.set({ ...f.input, expectedRevision: 3 })).toThrow();
      expect(f.humans.set({ ...f.input, expectedRevision: 4 })).toMatchObject({ revision: 5, revokedAt: null, grant: { revokedAt: null } });
      expect(f.humans.memberships({ principalId: f.human.id })).toMatchObject({ items: [{ revision: 5 }], nextAfter: null });
      expect(f.db.prepare("SELECT count(*) n FROM controller_audit_events WHERE event_type='knowledge.human_membership_saved'").get()).toEqual({ n: 5 });
    } finally { f.db.close(); }
  });
  it("rolls back grant, binding and audit on a failure after the grant write", () => {
    const f = fixture();
    try {
      f.humans.set(f.input);
      const before = ["knowledge_project_grants", "knowledge_role_bindings", "controller_audit_events"].map(t => f.db.prepare(`SELECT * FROM ${t}`).all());
      f.db.exec("CREATE TRIGGER fail_membership BEFORE UPDATE ON knowledge_role_bindings BEGIN SELECT RAISE(ABORT,'injected after grant'); END;");
      expect(() => f.humans.set({ ...f.input, permissions: ["knowledge:read"], expectedRevision: 1 })).toThrow("injected after grant");
      expect(["knowledge_project_grants", "knowledge_role_bindings", "controller_audit_events"].map(t => f.db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    } finally { f.db.close(); }
  });
  it("closes every legacy grant/role mutator and rejects supplementary/forged/other-namespace inputs", () => {
    const f = fixture();
    try {
      f.humans.set(f.input);
      const target = { principalId: f.human.id, projectId: f.project.id, expectedRevision: 1 };
      for (const operation of [
        () => f.identity.setKnowledgeGrant({ ...target, permissions: ["knowledge:read"] }, f.actor),
        () => f.identity.revokeKnowledgeGrant(f.human.id, f.project.id, f.actor),
        () => f.identity.setKnowledgeRole({ ...target, role: "reader" }, f.actor),
        () => f.identity.revokeKnowledgeRole(target, f.actor),
        () => f.queries.saveKnowledgeProjectGrant({ ...target, permissions: [], revokedAt: null }, "legacy"),
        () => f.queries.saveKnowledgeRoleBinding({ ...target, role: "reader", revision: 2, updatedAt: NOW, revokedAt: null }, 1, "legacy"),
      ]) expect(operation).toThrow();
      for (const extra of [{ actor: "local-cli" }, { role: "manager" }, { permissions: ["knowledge:export"] },
        { permissions: ["attachments:read"] }, { permissions: ["knowledge:approve"] }, { scope: { kind: "runtime-project", id: f.project.id } }]) {
        expect(() => f.humans.set({ ...f.input, expectedRevision: 1, ...extra })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
      }
      expect(f.humans.memberships({ principalId: f.human.id }).items[0].revision).toBe(1);
    } finally { f.db.close(); }
  });
});
