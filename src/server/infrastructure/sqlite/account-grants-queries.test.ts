import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { ACCOUNT_GRANTS_READ_LIMIT, AccountGrantsQueries } from "./account-grants-queries";
import { GRANT_ROLE_SCOPES } from "./account-grants-migration";
import { PROJECT_LIST_LIMIT, ProjectDirectoryQueries } from "./project-directory-queries";

/**
 * The read side of C4 (slice 3): one account and its step-52 grants, and the
 * listing of every project. Fresh databases at the supported schema on a
 * connection with the no-op fence observer, so covered writes pass through
 * every trigger.
 */
const AT = "2026-11-15T00:00:00.000Z";
const fresh = () => {
  const database = unmanagedFixtureDatabase();
  initializeSchema(database, undefined, candidate => { inspectSchema(candidate, SUPPORTED_SCHEMA_VERSION); });
  return database;
};
const project = (database: Database.Database, id: string, status = "active") =>
  database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)").run(id, `Project ${id}`, status, AT, AT);
const principal = (database: Database.Database, id: string, kind: string, status = "active") =>
  database.prepare("INSERT INTO remote_principals(id,kind,status) VALUES(?,?,?)").run(id, kind, status);
const grant = (database: Database.Database, account: string, role: string, projectId: string | null) =>
  database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)").run(account, role, projectId === null ? "installation" : "project", projectId, AT);

describe("account grants reader", () => {
  it("reads the account and its grants in insertion order, null for an unknown ID, and never a deleted grant", () => {
    const database = fresh();
    try {
      project(database, "project-a"); project(database, "project-b");
      principal(database, "owner", "owner"); principal(database, "bare", "agent", "revoked");
      grant(database, "owner", "admin", null); grant(database, "owner", "reader", "project-b"); grant(database, "owner", "operator", "project-a");
      const reader = new AccountGrantsQueries(database);
      expect(reader.accountGrants("owner")).toEqual({ kind: "owner", status: "active", grants: [
        { role: "admin", scopeKind: "installation", projectId: null },
        { role: "reader", scopeKind: "project", projectId: "project-b" },
        { role: "operator", scopeKind: "project", projectId: "project-a" },
      ] });
      expect(reader.accountGrants("bare")).toEqual({ kind: "agent", status: "revoked", grants: [] });
      expect(reader.accountGrants("nobody")).toBeNull();
      // Each namespace is its own: a project ID is not an account.
      expect(reader.accountGrants("project-a")).toBeNull();
      database.prepare("DELETE FROM account_grants WHERE account_id='owner' AND role='reader'").run();
      expect(reader.accountGrants("owner")?.grants.map(row => row.role)).toEqual(["admin", "operator"]);
      expect(() => reader.accountGrants(1 as unknown as string)).toThrow("Malformed account ID.");
    } finally { database.close(); }
  });

  it("refuses an account with more grants than its limit, and reads one at the limit; the limit covers every project role on every listable project", () => {
    const projectRoles = GRANT_ROLE_SCOPES.filter(([, scope]) => scope === "project").map(([role]) => role);
    expect(ACCOUNT_GRANTS_READ_LIMIT).toBe(projectRoles.length * PROJECT_LIST_LIMIT + 1);
    const database = fresh();
    try {
      principal(database, "busy", "human");
      const projects = Math.ceil(ACCOUNT_GRANTS_READ_LIMIT / projectRoles.length) + 1;
      const fill = database.transaction(() => {
        let rows = 0;
        for (let index = 0; index < projects && rows < ACCOUNT_GRANTS_READ_LIMIT; index++) {
          const id = `project-${String(index).padStart(5, "0")}`;
          project(database, id);
          for (const role of projectRoles) if (rows < ACCOUNT_GRANTS_READ_LIMIT) { grant(database, "busy", role, id); rows++; }
        }
      });
      fill();
      const reader = new AccountGrantsQueries(database);
      expect(reader.accountGrants("busy")?.grants).toHaveLength(ACCOUNT_GRANTS_READ_LIMIT);
      project(database, "project-last"); grant(database, "busy", "reader", "project-last");
      expect(() => reader.accountGrants("busy")).toThrow("Account grants exceed their read limit.");
    } finally { database.close(); }
  });
});

describe("project directory listing", () => {
  it("lists every project by ID, archived ones included, and refuses above its limit without truncating", () => {
    const database = fresh();
    try {
      const directory = new ProjectDirectoryQueries(database);
      expect(directory.projects()).toEqual([]);
      project(database, "project-b", "archived"); project(database, "project-a");
      expect(directory.projects()).toEqual([{ id: "project-a", status: "active" }, { id: "project-b", status: "archived" }]);
      database.transaction(() => { for (let index = 2; index < PROJECT_LIST_LIMIT; index++) project(database, `project-${String(index).padStart(4, "0")}`); })();
      expect(directory.projects()).toHaveLength(PROJECT_LIST_LIMIT);
      project(database, "project-z");
      expect(() => directory.projects()).toThrow("Project listing exceeds its limit.");
    } finally { database.close(); }
  });
});
