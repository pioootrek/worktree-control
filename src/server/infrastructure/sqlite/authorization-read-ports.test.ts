import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialAuthenticationRecord } from "@/server/modules/identity";
import { resolveAppPaths } from "@/server/paths";
import { ownedFixtureDatabase, unmanagedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { ExclusiveConnectionError } from "./exclusive-connection";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { ACCOUNT_GRANTS_READ_LIMIT } from "./account-grants-queries";
import { PROJECT_LIST_LIMIT } from "./project-directory-queries";
import { SqliteStateStore } from "./sqlite-state-store";
import { storeReaderAdapters } from "../../../../tests/types/sqlite-store-readers.test";

const AT = "2026-11-18T00:00:00.000Z";
const roots: string[] = [];
const stores: SqliteStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "authorization-read-ports-")); roots.push(root);
  const path = resolveAppPaths(join(root, "data")).databasePath;
  const store = new SqliteStateStore(path, undefined, { admission: "strict" }); stores.push(store);
  const database = ownedFixtureDatabase(store);
  const machine = store.machineCredentialReader(), grants = store.accountGrantsReader(), directory = store.projectDirectoryReader();
  const project = (id: string, status: "active" | "archived" = "active") =>
    store.saveKnowledgeProject({ id, name: id, status, revision: (store.getKnowledgeProject(id)?.revision ?? 0) + 1, createdAt: AT, updatedAt: AT }, "fixture");
  // No product grant writer exists yet. Like C4, write fixture rows through
  // the store's sole guarded handle, retaining all fence and table triggers.
  const grant = (account: string, role: string, projectId: string | null) => database.prepare(
    "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)",
  ).run(account, role, projectId === null ? "installation" : "project", projectId, AT);
  const credential = (kind: CredentialAuthenticationRecord["kind"] = "agent_token", expiresAt: string | null = null) => {
    const id = randomUUID(), principalId = randomUUID();
    store.savePrincipal({ id: principalId, kind: kind === "owner_session" ? "owner" : kind === "worker_token" ? "worker" : "agent", status: "active" }, "fixture");
    const row: CredentialAuthenticationRecord = { id, principalId, kind, label: "fixture", tokenPrefix: "fixture",
      verifierHash: createHash("sha256").update(randomUUID()).digest("hex"), status: "active", expiresAt, createdAt: AT, revokedAt: null, lastUsedAt: AT };
    store.saveCredential(row, "fixture");
    return row;
  };
  return { store, path, database, machine, grants, directory, project, grant, credential };
}

describe("store authorization read ports under strict admission", () => {
  it("reuses the installation policy read and sees the next committed token and generation", async () => {
    const { store } = fixture();
    await store.admission.run(() => {
      expect(store.schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      const first = store.getAuthenticationPolicy();
      expect(first.token).toBeNull();
      const token = { id: randomUUID(), prefix: "fixture", verifierHash: createHash("sha256").update(randomUUID()).digest("hex"), createdAt: AT };
      store.saveAuthenticationPolicy({ mode: "token", token, generation: first.generation + 1 }, "fixture.policy", "fixture");
      const second = store.getAuthenticationPolicy();
      expect(second.token?.id).toBe(token.id);
      expect(second.token?.verifierHash === token.verifierHash).toBe(true);
      expect(second.generation).toBe(first.generation + 1);
      store.saveAuthenticationPolicy({ mode: "open", token: null, generation: second.generation + 1 }, "fixture.policy", "fixture");
      expect(store.getAuthenticationPolicy()).toEqual({ mode: "open", token: null, generation: second.generation + 1 });
    });
  });

  it.each(["agent_token", "worker_token", "owner_session"] as const)("returns only the stored facts of a committed %s and its principal", async kind => {
    const f = fixture();
    let id!: string;
    await f.store.admission.run(() => {
      const row = f.credential(kind); id = row.id;
      const read = f.machine.credential(id)!;
      expect(Object.keys(read).sort()).toEqual(["id", "principalId", "kind", "verifierHash", "status", "expiresAt", "createdAt", "revokedAt", "principal"].sort());
      expect(read.verifierHash === row.verifierHash).toBe(true);
      const { verifierHash: _hash, ...facts } = read; void _hash;
      expect(facts).toEqual({ id, principalId: row.principalId, kind, status: "active", expiresAt: null, createdAt: AT, revokedAt: null,
        principal: { id: row.principalId, kind: kind === "owner_session" ? "owner" : kind === "worker_token" ? "worker" : "agent", status: "active" } });
    });
    // An independent read-only fixture connection observes the committed row.
    const committed = unmanagedFixtureDatabase(f.path, { readonly: true });
    try { expect(committed.prepare("SELECT id FROM principal_credentials WHERE id=?").get(id)).toEqual({ id }); }
    finally { committed.close(); }
  });

  it("reports revocation, expiry and principal revocation without filtering or retaining a stale answer", async () => {
    const f = fixture();
    await f.store.admission.run(() => {
      const active = f.credential(), expired = f.credential("agent_token", "2020-01-01T00:00:00.000Z");
      expect(f.machine.credential(active.id)?.status).toBe("active");
      f.store.revokeCredential(active.id, AT, "fixture");
      expect(f.machine.credential(active.id)?.status).toBe("revoked");
      expect(f.machine.credential(active.id)?.revokedAt).toBe(AT);
      expect(f.machine.credential(expired.id)?.expiresAt).toBe(expired.expiresAt);
      f.store.savePrincipal({ id: expired.principalId, kind: "agent", status: "revoked" }, "fixture");
      expect(f.machine.credential(expired.id)?.principal.status).toBe("revoked");
      expect(f.machine.credential(randomUUID())).toBeNull();
      for (const id of ["", "malformed", "' OR 1=1 --", null, undefined, 42, {}, [], Symbol("id")]) {
        expect(f.machine.credential(id as string)).toBeNull();
      }
    });
  });

  it("returns account kinds, revoked facts, empty and ordered grants, then observes deletion and principal changes", async () => {
    const f = fixture();
    await f.store.admission.run(() => {
      f.project("project-a"); f.project("project-b", "archived");
      for (const kind of ["owner", "agent", "worker"] as const) f.store.savePrincipal({ id: kind, kind, status: "active" }, "fixture");
      f.store.humanAccounts().createHumanPrincipal({ id: "human", kind: "human", status: "active" }, "fixture");
      f.grant("owner", "admin", null); f.grant("human", "reader", "project-b"); f.grant("human", "operator", "project-a");
      expect(f.grants.accountGrants("owner")).toEqual({ kind: "owner", status: "active", grants: [{ role: "admin", scopeKind: "installation", projectId: null }] });
      expect(f.grants.accountGrants("human")).toEqual({ kind: "human", status: "active", grants: [
        { role: "reader", scopeKind: "project", projectId: "project-b" }, { role: "operator", scopeKind: "project", projectId: "project-a" },
      ] });
      for (const kind of ["agent", "worker", "installation"]) expect(f.grants.accountGrants(kind)).toEqual({ kind, status: "active", grants: [] });
      expect(f.grants.accountGrants("missing")).toBeNull(); expect(f.grants.accountGrants("project-a")).toBeNull();
      f.database.prepare("DELETE FROM account_grants WHERE account_id='human' AND role='reader'").run();
      expect(f.grants.accountGrants("human")?.grants.map(row => row.role)).toEqual(["operator"]);
      f.store.savePrincipal({ id: "owner", kind: "owner", status: "revoked" }, "fixture");
      expect(f.grants.accountGrants("owner")?.status).toBe("revoked");
      expect(f.grants.accountGrants("owner")?.grants).toHaveLength(1);
    });
  });

  it("keeps directory namespaces separate, includes archived projects and observes store writes on the next call", async () => {
    const f = fixture();
    await f.store.admission.run(() => {
      f.project("project-b", "archived"); f.project("project-a");
      const registration = f.store.addProject({ name: "Registration", repositoryPath: "/fixture/repo", port: 5432, executable: "node", args: [] });
      const row = f.directory.registration(registration.id)!;
      expect(row.id).toBe(registration.id); expect(row.projectId).toBeNull();
      expect(row.incarnation).toBeGreaterThan(0); expect(row.mappingVersion).toBeGreaterThanOrEqual(row.incarnation);
      // Parent changes use the guarded handle as in C4's mapping-act fixtures.
      f.database.transaction(() => {
        f.database.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
        f.database.prepare("UPDATE projects SET parent_project_id='project-a',mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(registration.id);
      })();
      const changed = f.directory.registration(registration.id)!;
      expect(changed.projectId).toBe("project-a"); expect(changed.incarnation).toBe(row.incarnation);
      expect(changed.mappingVersion).toBeGreaterThan(row.mappingVersion);
      expect(f.directory.project(registration.id)).toBeNull(); expect(f.directory.registration("project-a")).toBeNull();
      expect(f.directory.project("missing")).toBeNull(); expect(f.directory.registration("missing")).toBeNull();
      expect(f.directory.projects()).toEqual([{ id: "project-a", status: "active" }, { id: "project-b", status: "archived" }]);
      f.project("project-a", "archived");
      expect(f.directory.project("project-a")).toEqual({ id: "project-a", status: "archived" });
      f.store.removeProject(registration.id, "fixture");
      expect(f.directory.registration(registration.id)).toBeNull();
    });
  });

  it("preserves the C4 readers' fail-closed listing and grant bounds", async () => {
    const f = fixture();
    await f.store.admission.run(() => {
      f.store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "fixture");
      f.database.transaction(() => {
        f.database.prepare(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<?)
          INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at)
          SELECT 'bulk-'||n,'bulk','active',1,?,? FROM ids`).run(PROJECT_LIST_LIMIT, AT, AT);
        f.database.prepare(`INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at)
          SELECT 'agent',role,'project',id,? FROM knowledge_projects CROSS JOIN
          (SELECT 'reader' AS role UNION ALL SELECT 'operator' UNION ALL SELECT 'maintainer' UNION ALL SELECT 'secrets' UNION ALL SELECT 'executor')`).run(AT);
        f.grant("agent", "admin", null);
      })();
      expect(f.directory.projects()).toHaveLength(PROJECT_LIST_LIMIT);
      expect(f.grants.accountGrants("agent")?.grants).toHaveLength(ACCOUNT_GRANTS_READ_LIMIT);
      f.project("overflow"); f.grant("agent", "reader", "overflow");
      expect(() => f.directory.projects()).toThrow("Project listing exceeds its limit.");
      expect(() => f.grants.accountGrants("agent")).toThrow("Account grants exceed their read limit.");
    });
  });

  it("feeds the unchanged C4 adapters with fresh grants and directory facts", async () => {
    const f = fixture();
    const adapters = storeReaderAdapters(f.store);
    await f.store.admission.run(() => {
      f.project("project-a"); f.project("project-b", "archived");
      f.store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "fixture");
      f.grant("agent", "reader", "project-a"); f.grant("agent", "executor", "project-b");
      const id = "agent" as Parameters<ReturnType<typeof adapters.grants>["accountKind"]>[0];
      const first = adapters.grants();
      expect(first.accountKind(id)).toBe("agent");
      expect(first.grantsFor(id).map(row => row.role)).toEqual(["reader", "executor"]);
      f.database.prepare("DELETE FROM account_grants WHERE account_id='agent' AND role='reader'").run();
      expect(first.grantsFor(id).map(row => row.role)).toEqual(["reader", "executor"]);
      expect(adapters.grants().grantsFor(id).map(row => row.role)).toEqual(["executor"]);
      f.store.savePrincipal({ id: "agent", kind: "agent", status: "revoked" }, "fixture");
      expect(adapters.grants().accountKind(id)).toBeNull();
      expect(adapters.grants().grantsFor(id)).toEqual([]);
      expect(adapters.resolver.listProjects()).toEqual(["project-a", "project-b"]);
      expect(adapters.resolver.resolve({ kind: "project", id: "project-b" })).toEqual({
        ref: { kind: "project", id: "project-b" }, projectId: "project-b", version: 1, relation: null,
      });
      const registration = f.store.addProject({ name: "Adapter", repositoryPath: "/fixture/adapter", port: 5433, executable: "node", args: [] });
      expect(adapters.resolver.resolve({ kind: "registration", id: registration.id })).toEqual({
        ref: { kind: "registration", id: registration.id }, projectId: null, version: f.directory.registration(registration.id)!.mappingVersion, relation: null,
      });
      f.store.removeProject(registration.id, "fixture");
      expect(adapters.resolver.resolve({ kind: "registration", id: registration.id })).toBeNull();
    });
  });

  it("requires the same core admission as existing reads, including retained readers after a phase ends", async () => {
    const f = fixture();
    const reads = [() => f.store.getAuthenticationPolicy(), () => f.machine.credential("0".repeat(36)), () => f.machine.credential("malformed"),
      () => f.grants.accountGrants("installation"), () => f.directory.project("p"), () => f.directory.registration("r"), () => f.directory.projects()];
    const refused = () => { for (const read of reads) expect(read).toThrowError(expect.objectContaining({ code: "unadmitted" })); };
    refused();
    await f.store.admission.run(() => { for (const read of reads) expect(read).not.toThrow(); });
    refused();
    // Pin the refusal class as well as its code, as the existing store tests do.
    expect(reads[0]).toThrow(ExclusiveConnectionError);
  });

  it("changes neither the fence epoch, SQLite total changes, nor credential usage across any port calls", async () => {
    const f = fixture();
    await f.store.admission.run(() => {
      const row = f.credential(); f.project("project-a"); f.grant(row.principalId, "reader", "project-a");
      const epoch = () => f.database.prepare("SELECT epoch FROM security_checkpoint WHERE singleton=1").pluck().get();
      const changes = () => f.database.prepare("SELECT total_changes()").pluck().get();
      const beforeEpoch = epoch(), beforeChanges = changes();
      for (let index = 0; index < 3; index++) {
        f.store.getAuthenticationPolicy(); f.machine.credential(row.id); f.machine.credential(randomUUID()); f.machine.credential("malformed");
        f.grants.accountGrants(row.principalId); f.grants.accountGrants("missing");
        f.directory.registration("missing"); f.directory.project("project-a"); f.directory.projects();
      }
      expect(epoch() === beforeEpoch).toBe(true); expect(changes() === beforeChanges).toBe(true);
      expect(f.database.prepare("SELECT last_used_at FROM principal_credentials WHERE id=?").pluck().get(row.id)).toBe(AT);
    });
  });
});
