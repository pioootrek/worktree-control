import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { resolveAppPaths } from "@/server/paths";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { ACCOUNT_GRANTS_READ_LIMIT, AccountGrantsQueries } from "@/server/infrastructure/sqlite/account-grants-queries";
import { permissionScope, roleDefinitions, type AccountId } from "@/shared/contracts/operations";
import { effectivePermissions, type GrantsSnapshot } from "../grants";
import { A, P } from "../operations-fixture";
import { MAX_ACCOUNT_GRANTS, MAX_SNAPSHOT_ACCOUNTS, sqliteGrants, type AccountGrantsReader } from "./sqlite-grants";

/**
 * C4 of slice 3: the `GrantsSnapshot` adapter over committed SQLite state. A
 * fresh install at the supported schema, opened by the store as the product
 * opens it; covered rows are written on the store's own guarded handle, so
 * every fence and table trigger runs.
 */
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const AT = "2026-11-16T00:00:00.000Z";

function freshInstall() {
  const root = mkdtempSync(join(tmpdir(), "sqlite-grants-")); roots.push(root);
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath);
  closers.push(() => store.close());
  const database = ownedFixtureDatabase(store);
  const project = (id: string) => { store.saveKnowledgeProject({ id, name: `Project ${id}`, status: "active", revision: 1, createdAt: AT, updatedAt: AT }, "fixture"); return P(id); };
  const grant = (account: string, role: string, projectId: string | null) => database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)")
    .run(account, role, projectId === null ? "installation" : "project", projectId, AT);
  const revokeGrant = (account: string, role: string) => database.prepare("DELETE FROM account_grants WHERE account_id=? AND role=?").run(account, role).changes;
  const reader = new AccountGrantsQueries(database);
  return { store, database, project, grant, revokeGrant, reader, grants: sqliteGrants(reader) };
}

/** Owner, human, agent, worker, the installation principal, and a revoked agent, with grants on project A. */
function accounts() {
  const install = freshInstall();
  const { store, project, grant } = install;
  const projectA = project("project-a"), projectB = project("project-b");
  store.saveRemotePrincipal({ id: "owner", kind: "owner", status: "active" }, "fixture");
  store.humanAccounts().createHumanPrincipal({ id: "human-a", kind: "human", status: "active" }, "fixture");
  store.saveRemotePrincipal({ id: "agent-a", kind: "agent", status: "active" }, "fixture");
  store.saveRemotePrincipal({ id: "agent-r", kind: "agent", status: "revoked" }, "fixture");
  store.saveRemotePrincipal({ id: "worker-a", kind: "worker", status: "active" }, "fixture");
  grant("owner", "admin", null);
  grant("human-a", "operator", projectA); grant("human-a", "reader", projectB);
  grant("agent-a", "executor", projectA);
  grant("agent-r", "reader", projectA);
  grant("worker-a", "reader", projectA);
  grant("installation", "reader", projectA);
  return { ...install, projectA, projectB };
}

const internal = (reason: string) => expect.objectContaining({ category: "internal", reason });
const plain = (snapshot: GrantsSnapshot, id: string) => snapshot.grantsFor(A(id)).map(grant => ({ ...grant, scope: { ...grant.scope } }));

describe("SQLite grants adapter: stored kinds", () => {
  it("reports owner and human as human and agent as agent; worker, installation, revoked and unknown as null without grants", () => {
    const { grants, projectA, projectB, database } = accounts();
    const snapshot = grants();
    expect(snapshot.accountKind(A("owner"))).toBe("human");
    expect(snapshot.accountKind(A("human-a"))).toBe("human");
    expect(snapshot.accountKind(A("agent-a"))).toBe("agent");
    for (const id of ["worker-a", "installation", "agent-r", "nobody"]) {
      expect(snapshot.accountKind(A(id)), id).toBeNull();
      expect(snapshot.grantsFor(A(id)), id).toEqual([]);
    }
    // The rows of the null accounts are still stored: the adapter, not the table, withholds them.
    expect(database.prepare("SELECT count(*) FROM account_grants WHERE account_id IN ('worker-a','installation','agent-r')").pluck().get()).toBe(3);
    expect(plain(snapshot, "owner")).toEqual([{ accountId: "owner", role: "admin", scope: { kind: "installation" } }]);
    expect(plain(snapshot, "human-a")).toEqual([
      { accountId: "human-a", role: "operator", scope: { kind: "project", projectId: projectA } },
      { accountId: "human-a", role: "reader", scope: { kind: "project", projectId: projectB } },
    ]);
    // Frozen values: a holder cannot add a grant to the snapshot.
    expect(Object.isFrozen(snapshot.grantsFor(A("human-a")))).toBe(true);
    expect(Object.isFrozen(snapshot.grantsFor(A("human-a"))[0].scope)).toBe(true);
  });

  it("gives the owner exactly the admin role's permissions, and none to a revoked owner whose grant row remains", () => {
    const { grants, store, database, projectA } = accounts();
    const owner = { kind: "human" as const, accountId: A("owner") };
    const permissions = effectivePermissions(owner, grants());
    const admin = roleDefinitions.admin.permissions;
    expect([...permissions.installation].sort()).toEqual(admin.filter(permission => permissionScope(permission) === "installation").sort());
    expect([...permissions.everyProject].sort()).toEqual(admin.filter(permission => permissionScope(permission) === "project" && !permission.startsWith("secrets:")).sort());
    expect(permissions.visible(projectA)).toBe(true);
    store.saveRemotePrincipal({ id: "owner", kind: "owner", status: "revoked" }, "fixture");
    const after = grants();
    expect(after.accountKind(A("owner"))).toBeNull();
    expect(after.grantsFor(A("owner"))).toEqual([]);
    const none = effectivePermissions(owner, after);
    expect([none.installation.size, none.everyProject.size, none.project(projectA).size, none.visible(projectA)]).toEqual([0, 0, 0, false]);
    expect(database.prepare("SELECT count(*) FROM account_grants WHERE account_id='owner'").pluck().get()).toBe(1);
  });
});

describe("SQLite grants adapter: active grants only", () => {
  it("never returns a deleted grant, and an agent's maintainer row (inconsistent) grants nothing", () => {
    const { grants, grant, revokeGrant, projectA, projectB } = accounts();
    expect(revokeGrant("human-a", "operator")).toBe(1);
    expect(plain(grants(), "human-a")).toEqual([{ accountId: "human-a", role: "reader", scope: { kind: "project", projectId: projectB } }]);
    const agent = { kind: "agent" as const, accountId: A("agent-a") };
    const before = effectivePermissions(agent, grants());
    grant("agent-a", "maintainer", projectA);
    // The snapshot carries the stored row; effective permissions refuse it against the stored kind.
    expect(grants().grantsFor(A("agent-a")).map(row => row.role)).toEqual(["executor", "maintainer"]);
    const after = effectivePermissions(agent, grants());
    expect([...after.project(projectA)].sort()).toEqual([...before.project(projectA)].sort());
    expect([...after.project(projectA)].sort()).toEqual([...roleDefinitions.executor.permissions].sort());
  });
});

describe("SQLite grants adapter: snapshot semantics", () => {
  it("answers one account from one read per snapshot; a new snapshot reads the current committed state", () => {
    const { reader, revokeGrant, store } = accounts();
    const reads: string[] = [];
    const counting: AccountGrantsReader = { accountGrants: id => { reads.push(id); return reader.accountGrants(id); } };
    const source = sqliteGrants(counting);
    const first = source();
    const kept = first.grantsFor(A("human-a"));
    expect(kept.map(row => row.role)).toEqual(["operator", "reader"]);
    expect(first.accountKind(A("agent-a"))).toBe("agent");
    revokeGrant("human-a", "operator");
    store.saveRemotePrincipal({ id: "agent-a", kind: "agent", status: "revoked" }, "fixture");
    // The same snapshot answers from its reads, kind and grants alike, and reads nothing again.
    expect(first.grantsFor(A("human-a"))).toBe(kept);
    expect(first.accountKind(A("human-a"))).toBe("human");
    expect(first.accountKind(A("agent-a"))).toBe("agent");
    expect(first.grantsFor(A("agent-a")).map(row => row.role)).toEqual(["executor"]);
    expect(reads).toEqual(["human-a", "agent-a"]);
    const second = source();
    expect(second.grantsFor(A("human-a")).map(row => row.role)).toEqual(["reader"]);
    expect(second.accountKind(A("agent-a"))).toBeNull();
    expect(second.grantsFor(A("agent-a"))).toEqual([]);
    expect(reads).toEqual(["human-a", "agent-a", "human-a", "agent-a"]);
  });

  it("refuses a snapshot asked about more accounts than its bound, without dropping an earlier answer", () => {
    const answers = new Map<string, number>();
    const reader: AccountGrantsReader = { accountGrants: id => { answers.set(id, (answers.get(id) ?? 0) + 1); return { kind: "agent", status: "active", grants: [] }; } };
    const snapshot = sqliteGrants(reader)();
    for (let index = 0; index < MAX_SNAPSHOT_ACCOUNTS; index++) expect(snapshot.accountKind(A(`agent-${index}`))).toBe("agent");
    expect(() => snapshot.accountKind(A("agent-extra"))).toThrowError(internal("grants_snapshot_exhausted"));
    expect(snapshot.accountKind(A("agent-0"))).toBe("agent");
    expect(answers.get("agent-0")).toBe(1);
  });
});

describe("SQLite grants adapter: refusals", () => {
  it("is structurally the SQLite reader, with the same grant bound; over it the read fails as internal", () => {
    const { reader, database, grants } = accounts();
    const port: AccountGrantsReader = reader;
    expect(port).toBe(reader);
    expect(MAX_ACCOUNT_GRANTS).toBe(ACCOUNT_GRANTS_READ_LIMIT);
    database.transaction(() => {
      let rows = 0;
      for (let index = 0; rows <= ACCOUNT_GRANTS_READ_LIMIT; index++) {
        const id = `bulk-${String(index).padStart(5, "0")}`;
        database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,'active',1,?,?)").run(id, id, AT, AT);
        for (const role of ["reader", "operator", "maintainer", "secrets", "executor"]) {
          if (rows > ACCOUNT_GRANTS_READ_LIMIT) break;
          database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('agent-a',?,'project',?,?)").run(role, id, AT);
          rows++;
        }
      }
    })();
    expect(() => grants().accountKind(A("agent-a"))).toThrowError(internal("grants_read_failed"));
    expect(() => effectivePermissions({ kind: "agent", accountId: A("agent-a") }, grants())).toThrowError(internal("grants_read_failed"));
  });

  it("fails as internal on a reader fault and on any stored value outside the schema's domain, never granting anything", () => {
    const snapshotOf = (answer: () => unknown) => sqliteGrants({ accountGrants: answer as AccountGrantsReader["accountGrants"] })();
    const ask = (answer: () => unknown) => () => snapshotOf(answer).accountKind(A("someone"));
    const ok = { kind: "human", status: "active", grants: [] as unknown[] };
    expect(ask(() => { throw new Error("disk /secret"); })).toThrowError(internal("grants_read_failed"));
    expect(ask(() => Promise.resolve(ok))).toThrowError(internal("grants_not_synchronous"));
    expect(ask(() => "human")).toThrowError(internal("invalid_stored_account"));
    for (const kind of ["superuser", "Owner", null, 1]) expect(ask(() => ({ ...ok, kind })), String(kind)).toThrowError(internal("invalid_stored_account"));
    for (const status of ["disabled", null]) expect(ask(() => ({ ...ok, status })), String(status)).toThrowError(internal("invalid_stored_account"));
    expect(ask(() => ({ ...ok, grants: null }))).toThrowError(internal("invalid_stored_account"));
    expect(ask(() => ({ ...ok, grants: Array.from({ length: MAX_ACCOUNT_GRANTS + 1 }, () => ({ role: "reader", scopeKind: "project", projectId: "p" })) })))
      .toThrowError(internal("grants_limit_exceeded"));
    const badRows: unknown[] = [
      null, { role: "owner", scopeKind: "project", projectId: "p" }, { role: "admin", scopeKind: "project", projectId: "p" },
      { role: "reader", scopeKind: "installation", projectId: null }, { role: "admin", scopeKind: "installation", projectId: "p" },
      { role: "reader", scopeKind: "project", projectId: null }, { role: "reader", scopeKind: "project", projectId: "../p" }, { role: "reader", scopeKind: "team", projectId: "p" },
    ];
    for (const row of badRows) {
      expect(ask(() => ({ ...ok, grants: [row] })), JSON.stringify(row)).toThrowError(internal("invalid_stored_grant"));
      // Also for an account that would hold none of them: a corrupt row is never silently ignored.
      expect(ask(() => ({ kind: "worker", status: "active", grants: [row] })), JSON.stringify(row)).toThrowError(internal("invalid_stored_grant"));
    }
    // An inherited or accessor property is not a stored value.
    const inherited = Object.create({ kind: "human", status: "active", grants: [] }) as object;
    expect(ask(() => inherited)).toThrowError(internal("invalid_stored_account"));
    // Unknown and non-text IDs are no account; the reader is not asked for a non-text ID.
    const calls: unknown[] = [];
    const snapshot = sqliteGrants({ accountGrants: id => { calls.push(id); return null; } })();
    expect(snapshot.accountKind(A("nobody"))).toBeNull();
    expect(snapshot.accountKind("" as AccountId)).toBeNull();
    expect(snapshot.grantsFor(42 as unknown as AccountId)).toEqual([]);
    expect(calls).toEqual(["nobody"]);
    expect(() => sqliteGrants({} as AccountGrantsReader)).toThrow(TypeError);
  });
});
