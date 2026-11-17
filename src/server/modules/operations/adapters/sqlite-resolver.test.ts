import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ownedFixtureDatabase, unmanagedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { resolveAppPaths } from "@/server/paths";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { PROJECT_LIST_LIMIT, ProjectDirectoryQueries } from "@/server/infrastructure/sqlite/project-directory-queries";
import { initializeSchema } from "@/server/infrastructure/sqlite/migrations";
import { inspectSchema } from "@/server/infrastructure/sqlite/schema-inspection";
import { SUPPORTED_SCHEMA_VERSION } from "@/server/infrastructure/sqlite/migration-registry";
import { schemaAt49 } from "@/server/infrastructure/sqlite/fixtures/released-schema";
import { resourceKinds, type ResourceKind, type ResourceRef } from "../requirements";
import { resolveAll } from "../resolver";
import { MAX_LISTED_PROJECTS, PROJECT_VERSION, SqliteResourceResolver, type ProjectDirectoryReader } from "./sqlite-resolver";

/**
 * C4 of slice 3: the `ResourceResolver` adapter for `project` and
 * `registration` over the step-51 project directory. A fresh install at the
 * supported schema, opened by the store as the product opens it; covered rows
 * are written on the store's own guarded handle, so every fence and mapping
 * trigger runs (stamps come from the mapping clock, never from the test).
 */
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const AT = "2026-11-16T00:00:00.000Z";
let ports = 5400;

function freshInstall() {
  const root = mkdtempSync(join(tmpdir(), "sqlite-resolver-")); roots.push(root);
  const store = new SqliteStateStore(resolveAppPaths(join(root, "data")).databasePath);
  closers.push(() => store.close());
  const database = ownedFixtureDatabase(store);
  const directory = new ProjectDirectoryQueries(database);
  const project = (id: string, status: "active" | "archived" = "active") => {
    const existing = store.getKnowledgeProject(id);
    store.saveKnowledgeProject({ id, name: `Project ${id}`, status, revision: existing ? existing.revision + 1 : 1, createdAt: AT, updatedAt: AT }, "fixture");
    return id;
  };
  const register = (name: string) => store.addProject({ name, repositoryPath: `/code/${name}`, port: ports++, executable: "node", args: [] }).id;
  return { store, database, directory, project, register, resolver: new SqliteResourceResolver(directory) };
}
/** A parent change as the mapping acts make it: advance the clock, then stamp the new parent with the clock's value. */
function reparent(database: Database.Database, registration: string, parent: string | null): void {
  database.transaction(() => {
    database.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
    database.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, registration);
  })();
}
const registration = (id: string): ResourceRef => ({ kind: "registration", id });
const project = (id: string): ResourceRef => ({ kind: "project", id });
const internal = (reason: string) => expect.objectContaining({ category: "internal", reason });

describe("SQLite resolver: registrations", () => {
  it("resolves a registration to its parent project with its mapping version, a parentless one to null, and a missing one to null", () => {
    const { resolver, register, project: create, database } = freshInstall();
    const parentA = create("project-a");
    const loose = register("loose"), bound = register("bound");
    reparent(database, bound, parentA);
    const stamped = (id: string) => database.prepare("SELECT mapping_version FROM projects WHERE id=?").pluck().get(id) as number;
    expect(resolver.resolve(registration(loose))).toEqual({ ref: { kind: "registration", id: loose }, projectId: null, version: stamped(loose), relation: null });
    expect(resolver.resolve(registration(bound))).toEqual({ ref: { kind: "registration", id: bound }, projectId: parentA, version: stamped(bound), relation: null });
    expect(stamped(loose)).toBeGreaterThan(0);
    expect(resolver.resolve(registration("missing"))).toBeNull();
    expect(Object.isFrozen(resolver.resolve(registration(bound)))).toBe(true);
  });

  it("gives a version never seen before for that ID on every reparent, back to an earlier parent too, and after delete and recreate", () => {
    const { resolver, register, project: create, database, store } = freshInstall();
    const p1 = create("project-1"), p2 = create("project-2");
    const id = register("moving");
    const seen: number[] = [];
    const record = (expected: string | null) => {
      const resolved = resolver.resolve(registration(id))!;
      expect(resolved.projectId).toBe(expected);
      expect(seen).not.toContain(resolved.version);
      seen.push(resolved.version);
    };
    record(null);
    reparent(database, id, p1); record(p1);
    reparent(database, id, p2); record(p2);
    reparent(database, id, p1); record(p1);
    // Delete through the product's removal, then a new row under the same ID: the clock stamps it anew.
    const row = database.prepare("SELECT name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at FROM projects WHERE id=?").get(id) as Record<string, unknown>;
    store.removeProject(id, "fixture");
    expect(resolver.resolve(registration(id))).toBeNull();
    database.prepare(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at,parent_project_id)
      VALUES(@id,@name,@repository_path,@port,@executable,@args_json,@healthcheck_path,@startup_timeout_ms,@created_at,@updated_at,@parent)`).run({ ...row, id, parent: p1 });
    record(p1);
    expect([...seen].sort((left, right) => left - right)).toEqual(seen);
  });

  it("refuses an unstamped row (from before step 51) as internal, never as version 0 or not found", () => {
    // Schema 49 with a registration, then the structural steps to the supported schema: the row keeps 0 in both stamps.
    const database = schemaAt49(unmanagedFixtureDatabase());
    try {
      database.prepare(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
        VALUES('legacy','legacy','/code/legacy',5399,'node','[]','/',45000,?,?)`).run(AT, AT);
      initializeSchema(database, false, candidate => { inspectSchema(candidate, SUPPORTED_SCHEMA_VERSION); });
      expect(database.prepare("SELECT incarnation,mapping_version FROM projects WHERE id='legacy'").get()).toEqual({ incarnation: 0, mapping_version: 0 });
      const resolver = new SqliteResourceResolver(new ProjectDirectoryQueries(database));
      expect(() => resolver.resolve(registration("legacy"))).toThrowError(internal("registration_unstamped"));
      // Through `resolveAll` the failure wins over a missing slot.
      expect(() => resolveAll(resolver, { a: registration("legacy"), b: registration("missing") })).toThrowError(internal("registration_unstamped"));
    } finally { database.close(); }
  });
});

describe("SQLite resolver: projects", () => {
  it("resolves a project to itself with the constant project version, archived ones included, and lists every project", () => {
    const { resolver, project: create } = freshInstall();
    const active = create("project-a"), archived = create("project-b");
    create(archived, "archived");
    expect(resolver.resolve(project(active))).toEqual({ ref: { kind: "project", id: active }, projectId: active, version: PROJECT_VERSION, relation: null });
    expect(resolver.resolve(project(archived))).toEqual({ ref: { kind: "project", id: archived }, projectId: archived, version: PROJECT_VERSION, relation: null });
    // Archiving and restoring change neither the mapping nor the version.
    create(archived, "active");
    expect(resolver.resolve(project(archived))?.version).toBe(PROJECT_VERSION);
    expect(resolver.resolve(project("missing"))).toBeNull();
    expect(resolver.listProjects()).toEqual([active, archived]);
    expect(Object.isFrozen(resolver.listProjects())).toBe(true);
  });

  it("refuses a listing above its bound as internal, never truncated; the bound equals the SQLite reader's", () => {
    expect(MAX_LISTED_PROJECTS).toBe(PROJECT_LIST_LIMIT);
    const { resolver, database } = freshInstall();
    database.transaction(() => {
      for (let index = 0; index < PROJECT_LIST_LIMIT; index++) {
        database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,'active',1,?,?)").run(`p-${String(index).padStart(4, "0")}`, "p", AT, AT);
      }
    })();
    expect(resolver.listProjects()).toHaveLength(PROJECT_LIST_LIMIT);
    database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES('p-last','p','active',1,?,?)").run(AT, AT);
    expect(() => resolver.listProjects()).toThrowError(internal("project_list_read_failed"));
  });

  /**
   * The constant project version relies on this: no production path deletes,
   * replaces or renames a `knowledge_projects` row, so a project ID is never
   * recreated within one linear history. Test fixtures under `fixtures/`
   * directories are not production paths.
   */
  it("finds no production path that deletes, replaces or renames a knowledge project", () => {
    const patterns = [
      /DELETE\s+FROM\s+["`]?knowledge_projects\b/i, /REPLACE\s+INTO\s+["`]?knowledge_projects\b/i, /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?knowledge_projects\b/i,
      /ALTER\s+TABLE\s+["`]?knowledge_projects["`]?\s+RENAME/i, /UPDATE\s+(?:OR\s+\w+\s+)?["`]?knowledge_projects["`]?\s+SET\s+(?:(?!WHERE)[^;])*\bid\s*=/i,
    ];
    const files: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if ([".ts", ".tsx", ".mts", ".js", ".mjs", ".sql"].includes(extname(entry.name)) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(join(process.cwd(), "src"));
    const hits = files.filter(file => patterns.some(pattern => pattern.test(readFileSync(file, "utf8")))).map(file => relative(process.cwd(), file).split(sep).join("/"));
    expect(hits.filter(file => !file.split("/").includes("fixtures"))).toEqual([]);
    // The scan sees the fixture that does delete projects (a crash-test worker), so it reads what it should.
    expect(hits).toContain("src/server/infrastructure/sqlite/fixtures/attachment-crash-worker.ts");
    // The patterns would catch each form.
    for (const text of ["DELETE FROM knowledge_projects WHERE id=?", "INSERT OR REPLACE INTO knowledge_projects VALUES(1)", "UPDATE knowledge_projects SET id=? WHERE id=?",
      "ALTER TABLE knowledge_projects RENAME TO old", "DROP TABLE IF EXISTS knowledge_projects"]) expect(patterns.some(pattern => pattern.test(text)), text).toBe(true);
    expect(patterns.some(pattern => pattern.test("UPDATE knowledge_projects SET name = ?, status = ? WHERE id = ?"))).toBe(false);
  });
});

describe("SQLite resolver: namespaces and refusals", () => {
  it("looks each kind up only in its own table", () => {
    const { resolver, register, project: create } = freshInstall();
    const knowledge = create("project-a"), local = register("local");
    expect(resolver.resolve(registration(knowledge))).toBeNull();
    expect(resolver.resolve(project(local))).toBeNull();
  });

  it("fails closed with internal for every other kind, never not found, whatever exists", () => {
    const { resolver, project: create } = freshInstall();
    const id = create("project-a");
    const unsupported = resourceKinds.filter(kind => kind !== "project" && kind !== "registration");
    expect(unsupported).toHaveLength(10);
    for (const kind of unsupported) {
      expect(() => resolver.resolve({ kind, id }), kind).toThrowError(internal("resource_kind_unsupported"));
      expect(() => resolver.resolve({ kind, id: "missing" }), kind).toThrowError(internal("resource_kind_unsupported"));
      expect(() => resolveAll(resolver, { a: { kind, id }, b: registration("missing") }), kind).toThrowError(internal("resource_kind_unsupported"));
    }
    expect(() => resolver.resolve({ kind: "other" as ResourceKind, id })).toThrowError(internal("resource_kind_unsupported"));
    expect(() => resolver.resolve(null as unknown as ResourceRef)).toThrowError(internal("invalid_resource_reference"));
    expect(() => resolver.resolve({ kind: "project", id: "" })).toThrowError(internal("invalid_resource_reference"));
  });

  it("is structurally the SQLite directory, and refuses every reader fault and malformed row as internal", () => {
    const { directory } = freshInstall();
    const port: ProjectDirectoryReader = directory;
    expect(port).toBe(directory);
    const base: ProjectDirectoryReader = { registration: () => null, project: () => null, projects: () => [] };
    const with_ = (change: Partial<Record<keyof ProjectDirectoryReader, () => unknown>>) => new SqliteResourceResolver({ ...base, ...change } as ProjectDirectoryReader);
    const row = { id: "reg", projectId: "project-a", incarnation: 3, mappingVersion: 5 };
    expect(with_({ registration: () => row }).resolve(registration("reg"))).toMatchObject({ projectId: "project-a", version: 5 });
    expect(() => with_({ registration: () => { throw new Error("disk /secret"); } }).resolve(registration("reg"))).toThrowError(internal("registration_read_failed"));
    expect(() => with_({ project: () => { throw new Error("disk"); } }).resolve(project("p"))).toThrowError(internal("project_read_failed"));
    expect(() => with_({ projects: () => { throw new Error("disk"); } }).listProjects()).toThrowError(internal("project_list_read_failed"));
    expect(() => with_({ registration: () => Promise.resolve(row) }).resolve(registration("reg"))).toThrowError(internal("resolver_not_synchronous"));
    for (const bad of [{ ...row, id: "other" }, { ...row, incarnation: -1 }, { ...row, mappingVersion: 1.5 }, { ...row, mappingVersion: 2 }, { ...row, projectId: "" },
      { ...row, projectId: "../x" }, { ...row, projectId: undefined }, "row"]) {
      expect(() => with_({ registration: () => bad }).resolve(registration("reg")), JSON.stringify(bad)).toThrowError(internal("invalid_stored_registration"));
    }
    for (const stamps of [{ incarnation: 0, mappingVersion: 0 }, { incarnation: 0, mappingVersion: 4 }, { incarnation: 3, mappingVersion: 0 }]) {
      expect(() => with_({ registration: () => ({ ...row, ...stamps }) }).resolve(registration("reg")), JSON.stringify(stamps)).toThrowError(internal("registration_unstamped"));
    }
    for (const bad of [{ id: "p", status: "deleted" }, { id: "other", status: "active" }, { id: "../p", status: "active" }, "p"]) {
      expect(() => with_({ project: () => bad }).resolve(project("p")), JSON.stringify(bad)).toThrowError(internal("invalid_stored_project"));
    }
    for (const bad of [null, [{ id: "p", status: "gone" }], [{ id: "p", status: "active" }, { id: "p", status: "active" }]]) {
      expect(() => with_({ projects: () => bad }).listProjects(), JSON.stringify(bad)).toThrowError(internal("invalid_stored_project"));
    }
    expect(() => with_({ projects: () => Array.from({ length: MAX_LISTED_PROJECTS + 1 }, (_, index) => ({ id: `p${index}`, status: "active" })) }).listProjects())
      .toThrowError(internal("project_list_limit_exceeded"));
    expect(() => new SqliteResourceResolver({} as ProjectDirectoryReader)).toThrow(TypeError);
  });
});
