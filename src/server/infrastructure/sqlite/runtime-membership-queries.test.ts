import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { RuntimeMembershipService } from "@/server/modules/identity";
import { initializeSchema } from "./migrations";
import { RuntimeMembershipQueries } from "./runtime-membership-queries";

const now = "2026-11-07T12:00:00.000Z";
function fixture() {
  const db = new Database(":memory:"); initializeSchema(db); db.pragma("foreign_keys=ON");
  db.exec(`INSERT INTO remote_principals VALUES('owner','owner','active'),('human','human','active'),('agent','agent','active'),('worker','worker','active'),('installation','installation','active');
    INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
    VALUES('runtime','Runtime','/code/runtime',3601,'node','[]','/',45000,'now','now');
    INSERT INTO knowledge_projects VALUES('runtime','Same ID, separate namespace','active',1,'now','now'),('knowledge-only','Knowledge','active',1,'now','now');`);
  const queries = new RuntimeMembershipQueries(db), service = new RuntimeMembershipService(queries, "local-cli", () => now);
  const input = { principalId: "human", scope: { kind: "runtime-project" as const, id: "runtime" }, role: "reader" as const,
    permissions: ["projects:read"] as ["projects:read"], expectedRevision: 0 };
  return { db, queries, service, input };
}
describe("human runtime membership aggregate", () => {
  it("has no default grants, supports owner and ordinary human, and isolates Knowledge rows", () => {
    const f = fixture();
    try {
      expect(f.service.list({ principalId: "owner" }).items).toEqual([]);
      expect(f.service.list({ principalId: "human" }).items).toEqual([]);
      expect(f.service.set(f.input)).toMatchObject({ revision: 1, role: "reader", permissions: ["projects:read"], revokedAt: null });
      f.service.set({ ...f.input, principalId: "owner" });
      expect(f.db.prepare("SELECT * FROM knowledge_project_grants").all()).toEqual([]);
      expect(f.db.prepare("SELECT * FROM knowledge_role_bindings").all()).toEqual([]);
      expect(f.db.prepare("SELECT * FROM principal_credentials").all()).toEqual([]);
      expect(f.db.prepare("SELECT kind FROM remote_principals WHERE id='owner'").get()).toEqual({ kind: "owner" });
    } finally { f.db.close(); }
  });
  it("CAS updates and revokes atomically, and restoration needs the latest tombstone plus a complete set", () => {
    const f = fixture();
    try {
      f.service.set(f.input);
      expect(() => f.service.set(f.input)).toThrowError(expect.objectContaining({ code: "membership_revision_conflict" }));
      const revoke = { principalId: "human", scope: f.input.scope, expectedRevision: 1 };
      expect(f.service.revoke(revoke)).toMatchObject({ revision: 2, revokedAt: now });
      expect(() => f.service.revoke({ ...revoke, expectedRevision: 2 })).toThrow();
      expect(() => f.service.set({ ...f.input, expectedRevision: 1 })).toThrow();
      expect(() => f.service.set({ ...revoke, expectedRevision: 2, role: "reader" })).toThrow();
      expect(f.service.set({ ...f.input, expectedRevision: 2 })).toMatchObject({ revision: 3, revokedAt: null });
      const before = ["runtime_human_memberships", "controller_audit_events"].map(t => f.db.prepare(`SELECT * FROM ${t}`).all());
      f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON controller_audit_events BEGIN SELECT RAISE(ABORT,'audit rollback'); END");
      expect(() => f.service.revoke({ ...revoke, expectedRevision: 3 })).toThrow("audit rollback");
      expect(["runtime_human_memberships", "controller_audit_events"].map(t => f.db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    } finally { f.db.close(); }
  });
  it("enforces kinds, active status, typed targets and exact permissions even on direct store calls", () => {
    const f = fixture();
    try {
      for (const extra of [{ principalId: "agent" }, { principalId: "worker" }, { principalId: "installation" }, { principalId: "missing" },
        { scope: { kind: "knowledge-project", id: "runtime" } }, { scope: { kind: "runtime-project", id: "knowledge-only" } },
        { role: "operator" }, { role: "manager" }, { permissions: [] }, { permissions: ["runtime:control"] },
        { permissions: ["projects:read", "projects:read"] }, { permissions: ["projects:read", "tests:run"] }, { actor: "owner" }]) {
        expect(() => f.queries.saveRuntimeMembership({ ...f.input, ...extra } as never, "local-cli", now)).toThrow();
      }
      f.service.set(f.input);
      f.db.exec("UPDATE remote_principals SET status='revoked' WHERE id='human'");
      expect(() => f.queries.saveRuntimeMembership({ ...f.input, expectedRevision: 1 }, "local-cli", now)).toThrow();
      expect(f.service.list({ principalId: "human" }).items[0].revision).toBe(1);
      expect(() => f.queries.listRuntimeMemberships({ principalId: "owner", limit: 21 })).toThrow();
      expect(() => f.queries.listRuntimeMemberships({ principalId: "agent", limit: 1 })).toThrow();
    } finally { f.db.close(); }
  });
  it("pages by stable project ID and includes tombstones without leaking another principal", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 23; i++) {
        const id = `r${String(i).padStart(2, "0")}`;
        f.db.prepare(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
          VALUES(?,?,?,?, 'node','[]','/',45000,'now','now')`).run(id, id, `/code/${id}`, 3700 + i);
        f.service.set({ ...f.input, scope: { kind: "runtime-project", id } });
      }
      f.service.revoke({ principalId: "human", scope: { kind: "runtime-project", id: "r01" }, expectedRevision: 1 });
      f.service.set({ ...f.input, principalId: "owner" });
      const first = f.service.list({ principalId: "human", limit: 20 });
      const next = f.service.list({ principalId: "human", after: first.nextAfter, limit: 20 });
      expect(first.items).toHaveLength(20); expect(next.items).toHaveLength(3); expect(next.nextAfter).toBeNull();
      expect(first.items[1].revokedAt).toBe(now);
      expect(new Set([...first.items, ...next.items].map(x => x.scope.id)).size).toBe(23);
    } finally { f.db.close(); }
  });
});
