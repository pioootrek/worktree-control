import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { resolveAppPaths } from "@/server/paths";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { sqliteGrants, type AccountGrantsReader } from "./sqlite-grants";
import { SqliteResourceResolver, type ProjectDirectoryReader } from "./sqlite-resolver";

const AT = "2026-11-18T00:00:00.000Z";
const roots: string[] = [];
const stores: SqliteStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sqlite-store-ports-")); roots.push(root);
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath, undefined, { admission: "strict" }); stores.push(store);
  const database = ownedFixtureDatabase(store);
  const directory = store.projectDirectoryReader();
  const project = (id: string, status: "active" | "archived" = "active") =>
    store.saveKnowledgeProject({ id, name: id, status, revision: 1, createdAt: AT, updatedAt: AT }, "fixture");
  // No product grant writer exists yet. Keep the real fence and table triggers.
  const grant = (account: string, role: string, projectId: string | null) => database.prepare(
    "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)",
  ).run(account, role, projectId === null ? "installation" : "project", projectId, AT);
  return { store, database, directory, project, grant };
}

function storeReaderAdapters(store: SqliteStateStore) {
  const grants: AccountGrantsReader = store.accountGrantsReader();
  const directory: ProjectDirectoryReader = store.projectDirectoryReader();
  return { grants: sqliteGrants(grants), resolver: new SqliteResourceResolver(directory) };
}

describe("operations adapters over the store's structural ports", () => {
  it("assigns the store's ports to the operations readers", () => {
    expectTypeOf<ReturnType<SqliteStateStore["accountGrantsReader"]>>().toMatchTypeOf<AccountGrantsReader>();
    expectTypeOf<ReturnType<SqliteStateStore["projectDirectoryReader"]>>().toMatchTypeOf<ProjectDirectoryReader>();
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
});
