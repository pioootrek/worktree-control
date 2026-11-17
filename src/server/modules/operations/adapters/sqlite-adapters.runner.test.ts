import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { resolveAppPaths, type AppPaths } from "@/server/paths";
import { createControllerBackup } from "@/server/controller-backup";
import { IdentityService } from "@/server/modules/identity";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { AccountGrantsQueries } from "@/server/infrastructure/sqlite/account-grants-queries";
import { ProjectDirectoryQueries } from "@/server/infrastructure/sqlite/project-directory-queries";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup } from "@/server/infrastructure/sqlite/upgrade-maintenance";
import { openStoreAt49 } from "@/server/infrastructure/sqlite/fixtures/released-schema";
import { SUPPORTED_SCHEMA_VERSION } from "@/server/infrastructure/sqlite/migration-registry";
import type { AuthenticationContext } from "../authentication-context";
import { effectivePermissions, type GrantsSnapshot } from "../grants";
import type { ReadOperation } from "../operation";
import { A, createWorld, InMemoryGrants, MemoryIdempotency, P, presented } from "../operations-fixture";
import { allOf, onProject, sameProject, type OperationRequirement, type ResourceRef } from "../requirements";
import { OperationRunner } from "../runner";
import { fakeStart } from "../runner-fixture";
import { sqliteGrants } from "./sqlite-grants";
import { SqliteResourceResolver } from "./sqlite-resolver";

/**
 * C4 of slice 3, the gate: both SQLite adapters through the real runner, on a
 * fresh install at the supported schema and on a schema-49 installation taken
 * through the real upgrade (`inspect`, then `apply` with a validated backup).
 * Credentials are the fixture verifier's (slice 2 covers real ones); grants,
 * accounts and resources come only from SQLite. Covered rows are written on
 * the store's own guarded handle, so every fence and table trigger runs.
 */
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "sqlite-adapters-")); roots.push(root); return root; };
const PAST = "2025-03-01T10:00:00.000Z";
const AT = "2026-11-16T00:00:00.000Z";
const TARGET = SUPPORTED_SCHEMA_VERSION;
let ports = 5600;

const backups = (paths: AppPaths): UpgradeBackup => async source => {
  const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
  return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) };
};

/** The store, its guarded handle, both adapters over SQLite, and a runner with the fixture's admission and verifier. */
function open(paths: AppPaths) {
  const store = new SqliteStateStore(paths.databasePath);
  closers.push(() => store.close());
  const database = ownedFixtureDatabase(store);
  const grants = sqliteGrants(new AccountGrantsQueries(database));
  const resolver = new SqliteResourceResolver(new ProjectDirectoryQueries(database));
  const world = createWorld();
  const idempotency = new MemoryIdempotency();
  const runner = new OperationRunner({ ...world.runtime({ idempotency }), grants, resolver });
  let credentials = 0;
  /** A provider-session context for a stored account; only the credential is a fixture. */
  const human = (accountId: string): AuthenticationContext => {
    const secret = `cookie-${++credentials}`;
    world.verifier.register(secret, "provider_session", `provider-${credentials}`, { kind: "human", accountId: A(accountId) },
      { evidence: { authenticatedAt: world.clock.now - 1_000 }, session: { id: `session-${credentials}`, generation: 1, credentialId: `provider-${credentials}` } });
    return world.boundary("better-auth", "api").mint(presented({ providerSession: { secret }, browserHeaders: true }));
  };
  const agent = (accountId: string): AuthenticationContext => {
    const secret = `token-${++credentials}`;
    world.verifier.register(secret, "agent_token", `agent-${credentials}`, { kind: "agent", accountId: A(accountId) },
      { session: { id: `session-${credentials}`, generation: 1, credentialId: `agent-${credentials}` } });
    return world.boundary("better-auth", "mcp").mint(presented({ bearers: [{ class: "agent_token", secret }] }));
  };
  const grant = (account: string, role: string, projectId: string | null) => database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)")
    .run(account, role, projectId === null ? "installation" : "project", projectId, AT);
  const register = (name: string) => store.addProject({ name, repositoryPath: `/code/${name}`, port: ports++, executable: "node", args: [] }).id;
  return { store, database, grants, resolver, world, idempotency, runner, human, agent, grant, register };
}
/** A parent change as the mapping acts make it: advance the clock, then stamp the new parent with the clock's value. */
function reparent(database: Database.Database, registration: string, parent: string | null): void {
  database.transaction(() => {
    database.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
    database.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(parent, registration);
  })();
}

/** A new installation at the supported schema, as the store creates it. */
function freshInstall() {
  return open(resolveAppPaths(join(temporary(), "data")));
}

/**
 * A schema-49 installation built through the product's own write paths (an
 * owner from the bootstrap, an agent, a worker, a human, two registrations and
 * a Knowledge project), then the real upgrade with its default decisions:
 * each registration joins a project created for it, the old grants are
 * revoked and the single active owner gets `admin`.
 */
async function upgradedInstall() {
  const paths = resolveAppPaths(join(temporary(), "data"));
  const legacy = openStoreAt49(paths.databasePath);
  let ids: { owner: string; agent: string; worker: string; human: string; registrationA: string; registrationB: string; knowledge: string };
  try {
    const identity = new IdentityService(legacy, () => PAST, undefined, undefined, { isCurrentInstallationActor: () => true }, legacy);
    const bootstrapped = identity.bootstrapOwnerSession();
    const owner = identity.authenticateBearer(bootstrapped.token);
    const agent = identity.createAgent(owner).id, worker = identity.createWorker(owner).id;
    legacy.humanAccounts().createHumanPrincipal({ id: "human-a", kind: "human", status: "active" }, "fixture");
    const registrationA = legacy.addProject({ name: "alpha", repositoryPath: "/code/alpha", port: ports++, executable: "node", args: [] }).id;
    const registrationB = legacy.addProject({ name: "beta", repositoryPath: "/code/beta", port: ports++, executable: "node", args: [] }).id;
    const knowledge = identity.createKnowledgeProject({ name: "Knowledge" }, owner).id;
    ids = { owner: bootstrapped.principalId, agent, worker, human: "human-a", registrationA, registrationB, knowledge };
  } finally { legacy.close(); }
  const inspection = inspectSqliteUpgrade(paths, TARGET);
  await applySqliteUpgrade(paths, { expect: inspection.planHash! }, backups(paths), TARGET);
  return { ...open(paths), ids };
}

const notFound = (effect: string | null) => ({ ok: false, error: { category: "not_found", status: 404, reason: "resource_not_found", retry: "none", effect } });
const runtimeControl: OperationRequirement = { require: onProject("runtime:control", "registration") };
const parentOf = (database: Database.Database, registration: string) => database.prepare("SELECT parent_project_id FROM projects WHERE id=?").pluck().get(registration) as string | null;
/** Plain values of a snapshot's answer for one account, for comparing two installations. */
const answer = (snapshot: GrantsSnapshot, id: string) => ({
  kind: snapshot.accountKind(A(id)),
  grants: snapshot.grantsFor(A(id)).map(grant => ({ role: grant.role, scope: grant.scope.kind === "project" ? grant.scope.projectId : "installation" })),
});

describe("C4 gate 1: the owner after the upgrade", () => {
  it("is a human with exactly admin's permissions through its upgrade grant, and holds nothing once revoked although the row remains", async () => {
    const { ids, grants, database, runner, world, human, store } = await upgradedInstall();
    expect(database.prepare("SELECT account_id,role,scope_kind,project_id FROM account_grants").all()).toEqual([{ account_id: ids.owner, role: "admin", scope_kind: "installation", project_id: null }]);
    expect(grants().accountKind(A(ids.owner))).toBe("human");
    const actor = { kind: "human" as const, accountId: A(ids.owner) };
    const expected = effectivePermissions(actor, new InMemoryGrants().account(A(ids.owner), "human").grant({ accountId: A(ids.owner), role: "admin", scope: { kind: "installation" } }));
    const actual = effectivePermissions(actor, grants());
    const parentA = P(parentOf(database, ids.registrationA)!);
    expect([...actual.installation].sort()).toEqual([...expected.installation].sort());
    expect([...actual.everyProject].sort()).toEqual([...expected.everyProject].sort());
    expect([...actual.project(parentA)].sort()).toEqual([...expected.project(parentA)].sort());
    const context = human(ids.owner);
    const { operation, log } = fakeStart(world, { requirement: runtimeControl });
    expect(await runner.run(operation, context, { registrationId: ids.registrationA })).toEqual({ ok: true, value: { projectId: parentA, started: true }, replayed: false });
    expect(log.effects).toEqual([`start ${parentA}`]);

    store.saveRemotePrincipal({ id: ids.owner, kind: "owner", status: "revoked" }, "fixture");
    expect(grants().accountKind(A(ids.owner))).toBeNull();
    const none = effectivePermissions(actor, grants());
    expect([none.installation.size, none.everyProject.size, none.project(parentA).size, none.visible(parentA)]).toEqual([0, 0, 0, false]);
    expect(database.prepare("SELECT count(*) FROM account_grants WHERE account_id=?").pluck().get(ids.owner)).toBe(1);
    expect(await runner.run(fakeStart(world, { requirement: runtimeControl }).operation, context, { registrationId: ids.registrationA })).toEqual(notFound("not_started"));
  });

  it("gives worker and installation principals, and the upgraded agent and human without grants, nothing", async () => {
    const { ids, grants } = await upgradedInstall();
    const snapshot = grants();
    expect(answer(snapshot, ids.worker)).toEqual({ kind: null, grants: [] });
    expect(answer(snapshot, "installation")).toEqual({ kind: null, grants: [] });
    expect(answer(snapshot, ids.agent)).toEqual({ kind: "agent", grants: [] });
    expect(answer(snapshot, ids.human)).toEqual({ kind: "human", grants: [] });
  });
});

describe("C4 gate 4: replay and recheck compare the SQLite version", () => {
  it("refuses a replay after every reparent, back to the original parent too, and withholds a result when the registration moves during the effect", async () => {
    const { ids, database, runner, world, human, grant } = await upgradedInstall();
    const p1 = parentOf(database, ids.registrationA)!, p2 = parentOf(database, ids.registrationB)!;
    grant(ids.human, "operator", p1); grant(ids.human, "operator", p2);
    const context = human(ids.human);
    const input = { registrationId: ids.registrationA };
    const { operation, log } = fakeStart(world, { requirement: runtimeControl });
    expect(await runner.run(operation, context, input, { idempotencyKey: "k-1" })).toMatchObject({ ok: true, replayed: false });
    // Unchanged: the retained result replays.
    expect(await runner.run(operation, context, input, { idempotencyKey: "k-1" })).toMatchObject({ ok: true, replayed: true });
    const changed = { ok: false, error: { category: "conflict", status: 409, reason: "resource_changed", retry: "none", effect: "not_started" } };
    reparent(database, ids.registrationA, p2);
    expect(await runner.run(operation, context, input, { idempotencyKey: "k-1" })).toEqual(changed);
    reparent(database, ids.registrationA, p1);
    // Back in the original project, with a new version: still not the stored resolution.
    expect(await runner.run(operation, context, input, { idempotencyKey: "k-1" })).toEqual(changed);
    expect(log.effects).toEqual([`start ${p1}`]);

    const moving = fakeStart(world, { requirement: runtimeControl, duringEffect: () => reparent(database, ids.registrationA, p2) });
    expect(await runner.run(moving.operation, context, input)).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed", effect: "committed" } });
    expect(moving.log.effects).toEqual([`start ${p1}`]);
  });
});

describe("C4 gate 5: a parentless registration through the runner", () => {
  /** A read over the given slots; `reads` counts reads that ran. */
  const guarded = (requirement: OperationRequirement, refs: Record<string, ResourceRef>, counter: { reads: number }): ReadOperation<object, { ok: boolean }, { ok: boolean }> => ({
    id: "fixture.sqlite_parentless_read", kind: "read", requirement, parse: () => ({}), resources: () => refs,
    read: () => { counter.reads++; return { ok: true }; }, publicKeys: ["ok"], project: value => value,
  });

  it("lets the installation and the operator act, and answers every account exactly as for a missing registration, admin included", async () => {
    const { store, runner, world, human, agent, grant, register } = freshInstall();
    store.saveKnowledgeProject({ id: "project-a", name: "A", status: "active", revision: 1, createdAt: AT, updatedAt: AT }, "fixture");
    store.saveRemotePrincipal({ id: "owner", kind: "owner", status: "active" }, "fixture");
    store.humanAccounts().createHumanPrincipal({ id: "maintainer", kind: "human", status: "active" }, "fixture");
    store.saveRemotePrincipal({ id: "robot", kind: "agent", status: "active" }, "fixture");
    grant("owner", "admin", null); grant("maintainer", "maintainer", "project-a"); grant("robot", "operator", "project-a");
    const loose = register("loose");
    expect(new ProjectDirectoryQueries(ownedFixtureDatabase(store)).registration(loose as never)?.projectId).toBeNull();

    for (const [name, context] of Object.entries({ installation: world.installation().context, operator: world.operator() })) {
      const { operation, log } = fakeStart(world, { requirement: runtimeControl });
      expect(await runner.run(operation, context, { registrationId: loose }), name).toEqual({ ok: true, value: { projectId: null, started: true }, replayed: false });
      expect(log.effects, name).toEqual(["start (no project)"]);
    }
    const accounts = { admin: human("owner"), maintainer: human("maintainer"), robot: agent("robot") };
    const counter = { reads: 0 };
    for (const [name, context] of Object.entries(accounts)) {
      const { operation, log } = fakeStart(world, { requirement: runtimeControl });
      const missing = await runner.run(operation, context, { registrationId: "missing-registration" });
      expect(missing, name).toEqual(notFound("not_started"));
      expect(await runner.run(operation, context, { registrationId: loose }), name).toEqual(missing);
      expect(await runner.run({ ...operation }, context, { registrationId: loose }, { idempotencyKey: `k-${name}` }), name).toEqual(missing);
      expect(log.effects, name).toEqual([]);
      // No child-resource path: pairing the registration with a project the account holds opens nothing.
      const paired = { require: allOf(onProject("project:read", "project"), sameProject("project", "registration")) };
      expect(await runner.run(guarded(paired, { project: { kind: "project", id: "project-a" }, registration: { kind: "registration", id: loose } }, counter), context, {}), name)
        .toEqual(await runner.run(guarded(paired, { project: { kind: "project", id: "project-a" }, registration: { kind: "registration", id: "missing-registration" } }, counter), context, {}));
    }
    expect(counter.reads).toBe(0);
  });
});

describe("C4 gate 6: fresh and upgraded installs answer alike", () => {
  it("gives the same kinds, grants, resolutions and project list for the same accounts, projects, registrations and grants", async () => {
    const upgraded = await upgradedInstall();
    const { ids } = upgraded;
    const p1 = parentOf(upgraded.database, ids.registrationA)!;
    // After the upgrade: a grant of each kind, a new parentless registration, an archived project.
    upgraded.grant(ids.human, "operator", p1); upgraded.grant(ids.agent, "executor", ids.knowledge); upgraded.grant(ids.worker, "reader", p1);
    const loose = upgraded.register("loose");
    const archived = upgraded.store.getKnowledgeProject(ids.knowledge)!;
    upgraded.store.saveKnowledgeProject({ ...archived, status: "archived", revision: archived.revision + 1, updatedAt: AT }, "fixture");

    // The same data written into a fresh install, through the same paths where the product has one.
    const fresh = freshInstall();
    const principals = upgraded.database.prepare("SELECT id,kind,status FROM remote_principals ORDER BY id").all() as Array<{ id: string; kind: "owner" | "human" | "agent" | "worker" | "installation"; status: "active" | "revoked" }>;
    for (const principal of principals) {
      if (principal.kind === "human") fresh.store.humanAccounts().createHumanPrincipal({ id: principal.id, kind: "human", status: principal.status }, "fixture");
      else if (principal.kind !== "installation") fresh.store.saveRemotePrincipal(principal, "fixture");
    }
    const projects = upgraded.database.prepare("SELECT id,name,status,revision,created_at,updated_at FROM knowledge_projects ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of projects) {
      fresh.database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(@id,@name,@status,@revision,@created_at,@updated_at)").run(row);
    }
    const registrations = upgraded.database.prepare("SELECT id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at,parent_project_id FROM projects ORDER BY id").all() as Array<Record<string, unknown>>;
    for (const row of registrations) {
      fresh.database.prepare(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at,parent_project_id)
        VALUES(@id,@name,@repository_path,@port,@executable,@args_json,@healthcheck_path,@startup_timeout_ms,@created_at,@updated_at,@parent_project_id)`).run(row);
    }
    for (const row of upgraded.database.prepare("SELECT account_id,role,project_id FROM account_grants ORDER BY rowid").all() as Array<{ account_id: string; role: string; project_id: string | null }>) {
      fresh.grant(row.account_id, row.role, row.project_id);
    }

    const accounts = [...principals.map(principal => principal.id), "nobody"];
    const answers = (install: typeof fresh) => {
      const snapshot = install.grants();
      return Object.fromEntries(accounts.map(id => [id, answer(snapshot, id)]));
    };
    expect(answers(fresh)).toEqual(answers(upgraded));
    expect(answers(upgraded)[ids.owner]).toEqual({ kind: "human", grants: [{ role: "admin", scope: "installation" }] });
    const refs: ResourceRef[] = [...registrations.map(row => ({ kind: "registration" as const, id: row.id as string })), ...projects.map(row => ({ kind: "project" as const, id: row.id as string })),
      { kind: "registration", id: "missing" }, { kind: "project", id: "missing" }];
    // Versions are clock values of each database; everything else is equal, and every version is a positive stamp.
    const resolutions = (install: typeof fresh) => refs.map(ref => {
      const resolved = install.resolver.resolve(ref);
      if (resolved) expect(resolved.version, `${ref.kind} ${ref.id}`).toBeGreaterThan(0);
      return resolved && { ref: resolved.ref, projectId: resolved.projectId, relation: resolved.relation };
    });
    expect(resolutions(fresh)).toEqual(resolutions(upgraded));
    expect(resolutions(upgraded).find(entry => entry?.ref.id === loose)?.projectId).toBeNull();
    expect(fresh.resolver.listProjects()).toEqual(upgraded.resolver.listProjects());
    expect(upgraded.resolver.listProjects()).toContain(ids.knowledge);
  });
});

describe("C4 gate 7: unsupported kinds fail as internal through the runner", () => {
  it("answers internal, not not_found, for a kind this adapter does not resolve, whether or not something with that ID exists", async () => {
    const { runner, world, store } = freshInstall();
    store.saveKnowledgeProject({ id: "project-a", name: "A", status: "active", revision: 1, createdAt: AT, updatedAt: AT }, "fixture");
    const context = world.installation().context;
    for (const id of ["project-a", "missing"]) {
      const read: ReadOperation<object, { ok: boolean }, { ok: boolean }> = {
        id: "fixture.sqlite_claim_read", kind: "read", requirement: { require: onProject("project:read", "claim") }, parse: () => ({}),
        resources: () => ({ claim: { kind: "claim", id } }), read: () => ({ ok: true }), publicKeys: ["ok"], project: value => value,
      };
      const result = await runner.run(read, context, {});
      expect(result, id).toMatchObject({ ok: false, error: { category: "internal" } });
      expect(JSON.stringify(result)).not.toContain("not_found");
    }
  });
});
