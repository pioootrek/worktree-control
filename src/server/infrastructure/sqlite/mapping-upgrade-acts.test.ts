import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { IdentityService, type AuthenticatedPrincipal } from "../../modules/identity";
import { KnowledgeService } from "../../modules/knowledge";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { enableProvisionalSchema } from "./provisional-schema-gate";
import { SqliteStateStore } from "./sqlite-state-store";
import { SecurityFence, securityFenceRoot } from "./security-fence";
import { maintainSqliteSecurityFence } from "./security-maintenance";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { hashFile } from "./backup-validation";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { MAPPING_CLOCK_MAX, projectMappingChecksum, projectMappingMigration } from "./mapping-structure-migration";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup, type UpgradeBackupSource } from "./upgrade-maintenance";
import { canonicalJson, upgradePlanHash, upgradePlanPath, validateUpgradeProposal, type UpgradeAct, type UpgradePlan } from "./upgrade-plan";
import { MAPPING_ACT_DOMAIN, normaliseMappingDecisions, proposeProjectMapping, type MappingReview } from "./mapping-upgrade-acts";

// Every test here needs target 51; the switch is restored after each one.
const TARGET = 51;
const roots: string[] = [];
let restoreGate: () => void;
beforeEach(() => { restoreGate = enableProvisionalSchema(); });
afterEach(() => { vi.restoreAllMocks(); restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "mapping-acts-")); roots.push(root); return root; };

/** Historical time of every fixture write that takes a clock. */
const PAST = "2025-03-01T10:00:00.000Z";
/** Values that must never reach the plan file. */
const SECRET_PATH = "/srv/secret-repository-path-7f3a";
const SECRET_REMOTE = "https://git.example.invalid/secret-remote-url-7f3a.git";
const SECRET_VALUE = "SECRET-ENVIRONMENT-VALUE-7f3a";
const CIPHERTEXT = `FAKE-VAULT-CIPHERTEXT-7f3a-${"c".repeat(48)}`;

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");
const witnessFile = (paths: AppPaths) => join(securityFenceRoot(canonical(paths)), "witness.json");
const planFile = (paths: AppPaths) => upgradePlanPath(canonical(paths));
const read = <T,>(paths: AppPaths, operation: (database: Database.Database) => T) => {
  const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
  try { return operation(database); } finally { database.close(); }
};
/** The database and WAL bytes, the witness and the plan file: what a refusal must leave unchanged. */
const files = (paths: AppPaths) => {
  const wal = `${paths.databasePath}-wal`;
  return { database: sha(readFileSync(paths.databasePath)), wal: !existsSync(wal) || lstatSync(wal).size === 0 ? "empty" : sha(readFileSync(wal)),
    witness: existsSync(witnessFile(paths)) ? readFileSync(witnessFile(paths), "utf8") : "missing", plan: existsSync(planFile(paths)) ? readFileSync(planFile(paths), "utf8") : "missing" };
};
/**
 * A raw write outside any owner (for states the product's write paths cannot
 * produce), then a confirmed witness for the result, as the fixtures of the
 * step-50 tests publish one: the fence trusts the database again.
 */
const tamper = (paths: AppPaths, operation: (database: Database.Database) => void) => {
  const database = unmanagedFixtureDatabase(paths.databasePath);
  try { operation(database); SecurityFence.attach(canonical(paths), database, true); } finally { database.close(); }
};
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
/** `auth fence resume` at 51 of a fenced database: a restored one, or one whose witness is lost (removed first when it is still trusted). */
const resume = (paths: AppPaths) => {
  if (maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).trusted) rmSync(witnessFile(paths));
  return maintainSqliteSecurityFence(paths, { action: "resume", expect: maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).preflight, mode: "token" }, HANDOFF, TARGET);
};
const inspect = (paths: AppPaths, decisions?: unknown) => inspectSqliteUpgrade(paths, TARGET, decisions);

async function stepBackup(source: UpgradeBackupSource, destination: string, schemaVersion: number) {
  mkdirSync(destination, { mode: 0o700 }); mkdirSync(join(destination, "attachments"), { mode: 0o700 });
  const file = join(destination, "state.sqlite3");
  closeSync(openSync(file, "wx", 0o600)); await source.backup(file); chmodSync(file, 0o600);
  const snapshot = new Database(file, { fileMustExist: true });
  try { snapshot.pragma("journal_mode = DELETE"); } finally { snapshot.close(); }
  const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(), database: { file: "state.sqlite3", ...hashFile(file), schemaVersion }, attachments: [] };
  writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { root: destination, manifest };
}
const backups = (paths: AppPaths, calls: string[] = []): UpgradeBackup => async (source, context) => {
  const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
  calls.push(destination);
  if (context.schemaVersion <= SUPPORTED_SCHEMA_VERSION) {
    return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) };
  }
  return stepBackup(source, destination, context.schemaVersion);
};
const apply = (paths: AppPaths, expect: string, backup: UpgradeBackup = backups(paths)) => applySqliteUpgrade(paths, { expect }, backup, TARGET);
async function failure(operation: () => Promise<unknown> | unknown) {
  try { await operation(); } catch (error) {
    const { name, code, nextStep, committed, state, details } = error as { name: string; code: string; nextStep: string; committed: boolean; state?: string; details?: { findings: Array<{ table: string; id: string; problem: string }>; count: number; truncated: boolean } };
    return { name, code, nextStep, committed, state, details };
  }
  throw new Error("expected a refusal");
}

interface World {
  store: SqliteStateStore; owner: AuthenticatedPrincipal; knowledge: KnowledgeService;
  register(name: string): string;
  project(name: string): string;
  link(project: string, registration: string): void;
  remote(id: string, name?: string): string;
  worker(id: string, status?: "active" | "revoked"): string;
  bind(worker: string, identity: string, registration: string, revoked?: boolean): void;
  task(project: string): void;
}
let ports = 5200;
/** A schema-49 installation built through the product's own write paths (confirmed witness, historical clock). */
function installation(build?: (world: World) => void): AppPaths {
  const paths = resolveAppPaths(join(temporary(), "data"));
  const store = new SqliteStateStore(paths.databasePath);
  try {
    const identity = new IdentityService(store, () => PAST);
    const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
    const knowledge = new KnowledgeService(store, identity, () => PAST);
    const world: World = {
      store, owner, knowledge,
      register: name => store.addProject({ name, repositoryPath: `${SECRET_PATH}/${name}-${ports}`, port: ports++, executable: "node", args: [] }).id,
      project: name => {
        const project = identity.createKnowledgeProject({ name }, owner);
        identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] }, owner);
        return project.id;
      },
      link: (project, registration) => { knowledge.setRuntimeLink(project, registration, store.getKnowledgeProject(project)!.revision, { idempotencyKey: randomUUID() }, owner); },
      remote: (id, name = `Remote ${id}`) => { store.saveRemoteProjectIdentity({ id, name, sourceRemote: SECRET_REMOTE, status: "active" }, "local-cli"); return id; },
      worker: (id, status = "active") => {
        store.saveRemotePrincipal({ id: `${id}-principal`, kind: "worker", status }, "fixture");
        store.saveRemoteWorker({ id, principalId: `${id}-principal`, name: `Worker ${id}`, status, lastContactAt: null }, "fixture");
        return id;
      },
      bind: (worker, identity, registration, revoked = false) => {
        store.saveRemoteWorkerProjectGrant({ workerId: worker, projectId: identity, localProjectId: registration, presetIds: ["node:test"], revokedAt: revoked ? PAST : null }, "fixture");
      },
      task: project => { knowledge.createTask(project, { title: "Fixture task", description: "Fixture body" }, { idempotencyKey: randomUUID() }, owner); },
    };
    build?.(world);
  } finally { store.close(); }
  return paths;
}
/** Builds an installation and returns the IDs its builder named. */
function world<T extends Record<string, string>>(build: (world: World) => T): { paths: AppPaths; ids: T } {
  let ids!: T;
  const paths = installation(w => { ids = build(w); });
  return { paths, ids };
}
type Stamped = { id: string; parent: string | null; incarnation: number; version: number };
const stamps = (database: Database.Database, table: string) => database.prepare(`SELECT id,parent_project_id AS parent,incarnation,mapping_version AS version FROM ${table} ORDER BY id`).all() as Stamped[];
const parents = (paths: AppPaths) => read(paths, database => ({
  registrations: Object.fromEntries(stamps(database, "projects").map(row => [row.id, row.parent])),
  remoteIdentities: Object.fromEntries(stamps(database, "remote_project_identities").map(row => [row.id, row.parent])),
}));
const journal = (database: Database.Database) => database.prepare("SELECT * FROM project_mapping_journal ORDER BY sequence").all() as Array<Record<string, unknown>>;
const clock = (database: Database.Database) => database.prepare("SELECT value FROM project_mapping_clock").pluck().get() as number;
const review = (inspection: ReturnType<typeof inspect>) => inspection.review!.mapping as MappingReview;
const outcomeOf = (inspection: ReturnType<typeof inspect>, id: string) => [...review(inspection).registrations, ...review(inspection).remoteIdentities].find(row => row.id === id)!;
const kinds = (acts: readonly UpgradeAct[]) => acts.map(act => act.kind);

/** The standard world: a linked registration, an unlinked one, a project without registration, and a bound identity. */
const standard = () => world(w => {
  const linked = w.register("linked"), plain = w.register("plain");
  const knowledge = w.project("Linked knowledge"), lonely = w.project("Lonely knowledge");
  w.link(knowledge, linked);
  w.remote("remote-a"); w.worker("worker-a"); w.bind("worker-a", "remote-a", linked);
  return { linked, plain, knowledge, lonely, remote: "remote-a", worker: "worker-a" };
});

describe("project mapping: outcomes", () => {
  it("by default gives every registration and remote identity a new project of its own, reports links without applying them and leaves the rest untouched", async () => {
    const { paths, ids } = standard();
    const links = () => read(paths, database => database.prepare("SELECT knowledge_project_id,quote(runtime_project_id) AS r,linked_at,unlinked_at FROM knowledge_project_runtime_links ORDER BY rowid").all());
    const linksBefore = links(), lonelyBefore = read(paths, database => database.prepare("SELECT * FROM knowledge_projects WHERE id=?").get(ids.lonely));
    const inspection = inspect(paths);
    expect(inspection.decisions).toEqual({ mapping: { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } } });
    expect(kinds(inspection.plan!.acts)).toEqual(["create_project", "create_project", "create_project", "attach_registration", "attach_registration", "map_remote_identity"]);
    const linked = outcomeOf(inspection, ids.linked) as MappingReview["registrations"][number];
    expect(linked.outcome).toMatchObject({ basis: "created_project", created: true });
    expect(linked.outcome.projectId).not.toBe(ids.knowledge);
    expect(linked.link).toMatchObject({ projectId: ids.knowledge, linkedAt: PAST, accepted: false, lastChange: { operation: "linked", principalKind: "owner", authenticationMethod: "owner_session", at: PAST } });
    expect(outcomeOf(inspection, ids.remote).outcome).toMatchObject({ basis: "created_project", created: true });
    expect(review(inspection).projects).toEqual([]);
    expect(review(inspection).untouchedProjects).toBe(2);
    expect(inspection.acts!.join("\n")).toContain("not accepted (the registration does not join that project)");
    expect(inspection.acts!.join("\n")).toContain("Recorded history, not an approval");
    await apply(paths, inspection.planHash!);
    const after = parents(paths);
    const destinations = [after.registrations[ids.linked], after.registrations[ids.plain], after.remoteIdentities[ids.remote]];
    expect(new Set(destinations).size).toBe(3);
    expect(destinations).not.toContain(ids.knowledge);
    expect(links()).toEqual(linksBefore);
    read(paths, database => {
      expect(database.prepare("SELECT * FROM knowledge_projects WHERE id=?").get(ids.lonely)).toEqual(lonelyBefore);
      expect(database.prepare("SELECT count(*) FROM knowledge_projects").pluck().get()).toBe(5);
      for (const id of destinations) expect(database.prepare("SELECT name,status,revision,created_at=updated_at AS same FROM knowledge_projects WHERE id=?").get(id)).toMatchObject({ status: "active", revision: 1, same: 1 });
      expect(database.prepare("SELECT name FROM knowledge_projects WHERE id=?").pluck().get(after.registrations[ids.plain])).toBe("plain");
      expect(database.prepare("SELECT name FROM knowledge_projects WHERE id=?").pluck().get(after.remoteIdentities[ids.remote])).toBe("Remote remote-a");
      // No grant, role, membership or link for the created projects.
      for (const table of ["knowledge_project_grants", "knowledge_role_bindings", "knowledge_project_runtime_links", "knowledge_history"]) {
        const column = table === "knowledge_project_runtime_links" ? "knowledge_project_id" : "project_id";
        expect(database.prepare(`SELECT count(*) FROM ${table} WHERE ${column} IN (?,?,?)`).pluck().get(...destinations), table).toBe(0);
      }
    });
  });

  it("attaches an accepted link to the existing project and shows its inventory and principals; refuses a decision naming no such link", async () => {
    const { paths, ids } = world(w => {
      const linked = w.register("linked"), other = w.register("other"), unlinked = w.register("unlinked");
      const knowledge = w.project("Linked knowledge"), second = w.project("Second knowledge");
      w.link(knowledge, linked); w.link(second, other); w.task(knowledge);
      w.store.devVault.commit(linked, 0, CIPHERTEXT);
      return { linked, other, unlinked, knowledge, second };
    });
    const before = files(paths);
    for (const [name, decision] of [
      ["a missing registration", { registrationId: "no-such-registration", projectId: ids.knowledge }],
      ["an unlinked registration", { registrationId: ids.unlinked, projectId: ids.knowledge }],
      ["another pair", { registrationId: ids.linked, projectId: ids.second }],
      ["a missing project", { registrationId: ids.linked, projectId: "no-such-project" }],
    ] as const) {
      const refusal = await failure(() => inspect(paths, { links: [decision] }));
      expect(refusal, name).toMatchObject({ code: "upgrade_decisions_invalid", nextStep: "upgrade inspect", details: { count: 1, truncated: false } });
      expect(refusal.details!.findings[0]).toMatchObject({ table: "decisions.links", id: decision.registrationId });
      expect(files(paths), name).toEqual(before);
    }
    const inspection = inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }] });
    expect(outcomeOf(inspection, ids.linked).outcome).toEqual({ projectId: ids.knowledge, basis: "accepted_link", created: false });
    expect(outcomeOf(inspection, ids.other).outcome).toMatchObject({ basis: "created_project", created: true });
    const project = review(inspection).projects.find(entry => entry.id === ids.knowledge)!;
    const history = read(paths, database => database.prepare("SELECT count(*) FROM knowledge_history WHERE project_id=?").pluck().get(ids.knowledge));
    expect(project).toMatchObject({ name: "Linked knowledge", status: "active",
      inventory: { threads: 0, replies: 0, tasks: 1, memories: 0, attachments: 0, history, importBatches: 0 },
      registrations: [{ id: ids.linked, plan: true, journal: false, present: true }], remoteIdentities: [] });
    expect(project.principals.knowledgeGrants.owner).toEqual({ active: 1, revoked: 0 });
    expect(inspection.acts!.join("\n")).toContain("they are not a complete history");
    const result = await apply(paths, inspection.planHash!);
    expect(parents(paths).registrations[ids.linked]).toBe(ids.knowledge);
    read(paths, database => expect(journal(database).find(row => row.subject_id === ids.linked)).toMatchObject({ basis: "accepted_link", project_id: ids.knowledge, plan_hash: result.planHash, run_receipt: result.receipt }));
  });

  it("maps an identity through consistent accepted bindings, stops on disagreeing or divergent bindings, and never maps through an unaccepted binding", async () => {
    const { paths, ids } = world(w => {
      const first = w.register("first"), second = w.register("second");
      const knowledge = w.project("Shared knowledge");
      w.link(knowledge, first); w.link(w.project("Other knowledge"), second);
      w.worker("worker-a"); w.worker("worker-b", "revoked");
      w.remote("diverging"); w.bind("worker-a", "diverging", first); w.bind("worker-b", "diverging", second, true);
      w.remote("single"); w.bind("worker-a", "single", second);
      w.remote("lonely");
      return { first, second, knowledge };
    });
    // Undecided: the identity's bindings (one revoked) lead to two new projects.
    const before = files(paths);
    const divergent = await failure(() => inspect(paths));
    expect(divergent).toMatchObject({ code: "upgrade_mapping_divergent", nextStep: "upgrade inspect", details: { count: 1, findings: [{ table: "remote_project_identities", id: "diverging" }] } });
    expect(files(paths)).toEqual(before);
    // Accepted bindings that disagree stop too.
    const disagree = await failure(() => inspect(paths, { bindings: [{ remoteIdentityId: "diverging", registrationId: ids.first }, { remoteIdentityId: "diverging", registrationId: ids.second }] }));
    expect(disagree).toMatchObject({ code: "upgrade_mapping_divergent", details: { findings: [{ id: "diverging" }] } });
    expect(disagree.details!.findings[0].problem).toMatch(/^accepted bindings lead to projects/);
    // The binding to the registration whose link is accepted: one destination, consistent.
    const consistent = inspect(paths, {
      links: [{ registrationId: ids.first, projectId: ids.knowledge }],
      bindings: [{ remoteIdentityId: "diverging", registrationId: ids.first }],
      isolate: { registrations: [], remoteIdentities: [] },
    });
    expect(outcomeOf(consistent, "diverging").outcome).toEqual({ projectId: ids.knowledge, basis: "accepted_binding", created: false });
    const bindings = (outcomeOf(consistent, "diverging") as MappingReview["remoteIdentities"][number]).bindings;
    expect(bindings).toEqual([
      { workerId: "worker-a", workerName: "Worker worker-a", workerStatus: "active", workerPrincipalStatus: "active", registrationId: ids.first, revoked: false, accepted: true },
      { workerId: "worker-b", workerName: "Worker worker-b", workerStatus: "revoked", workerPrincipalStatus: "revoked", registrationId: ids.second, revoked: true, accepted: false },
    ]);
    expect(consistent.acts!.join("\n")).toContain("Accepting a binding accepts every worker row of that remote identity and registration");
    // An unaccepted single binding does not map the identity to the registration's project; no bindings: a new project.
    for (const id of ["single", "lonely"]) {
      expect(outcomeOf(consistent, id).outcome).toMatchObject({ basis: "created_project", created: true });
      expect(outcomeOf(consistent, id).outcome.projectId).not.toBe(outcomeOf(consistent, ids.second).outcome.projectId);
    }
    // Isolation resolves the divergence as well.
    const isolated = inspect(paths, { isolate: { remoteIdentities: ["diverging"] } });
    expect(outcomeOf(isolated, "diverging").outcome).toMatchObject({ basis: "created_project", created: true });
    // A subject both accepted and isolated, and duplicates, are refused before any lock.
    expect(await failure(() => inspect(paths, { bindings: [{ remoteIdentityId: "diverging", registrationId: ids.first }], isolate: { remoteIdentities: ["diverging"] } })))
      .toMatchObject({ code: "upgrade_decisions_invalid", details: { findings: [{ problem: "remote identity both accepted and isolated" }] } });
    expect(await failure(() => inspect(paths, { isolate: { registrations: [ids.first, ids.first] } }))).toMatchObject({ code: "upgrade_decisions_invalid", details: { findings: [{ problem: "duplicate decision" }] } });
    expect(await failure(() => inspect(paths, { bindings: [{ remoteIdentityId: "lonely", registrationId: ids.first }] }))).toMatchObject({ code: "upgrade_decisions_invalid", details: { findings: [{ table: "decisions.bindings", id: "lonely" }] } });
    await apply(paths, isolated.planHash!);
    read(paths, database => {
      // Accepting or not, no binding was changed or restored.
      expect(database.prepare("SELECT worker_id,revoked_at FROM remote_worker_project_grants ORDER BY worker_id,project_id").all())
        .toEqual([{ worker_id: "worker-a", revoked_at: null }, { worker_id: "worker-a", revoked_at: null }, { worker_id: "worker-b", revoked_at: PAST }]);
    });
  });

  it("refuses malformed decisions: unknown keys, bounds, a registration accepted into two projects and both accepted and isolated", async () => {
    const paths = installation(w => { w.register("only"); });
    const before = files(paths);
    for (const decisions of [
      { other: [] }, { links: [{ registrationId: "a", projectId: "b", extra: 1 }] }, { links: [{ registrationId: "", projectId: "b" }] },
      { isolate: { registrations: ["x".repeat(161)] } }, { links: "a" }, [], "decisions",
      { links: [{ registrationId: "a", projectId: "b" }, { registrationId: "a", projectId: "c" }] },
      { links: [{ registrationId: "a", projectId: "b" }], isolate: { registrations: ["a"] } },
    ]) {
      expect(await failure(() => inspect(paths, decisions)), JSON.stringify(decisions)).toMatchObject({ code: "upgrade_decisions_invalid", nextStep: "upgrade inspect" });
    }
    expect(files(paths)).toEqual(before);
    expect(existsSync(paths.controllerLockPath)).toBe(false);
    expect(normaliseMappingDecisions({ isolate: { registrations: ["b", "a"] }, links: [{ registrationId: "z", projectId: "p" }, { registrationId: "c", projectId: "p" }] }))
      .toEqual({ links: [{ registrationId: "c", projectId: "p" }, { registrationId: "z", projectId: "p" }], bindings: [], isolate: { registrations: ["a", "b"], remoteIdentities: [] } });
  });
});

describe("project mapping: stop conditions write no plan and change nothing", () => {
  /** A stop: no plan written over an existing one, database and witness unchanged, the rows named. */
  async function stops(paths: AppPaths, code: string, decisions?: unknown) {
    const before = files(paths);
    const refusal = await failure(() => inspect(paths, decisions));
    expect(refusal).toMatchObject({ name: "UpgradeError", code, nextStep: "upgrade inspect", committed: false });
    expect(files(paths)).toEqual(before);
    return refusal.details!;
  }

  it("stops on an ID shared by a registration, a project or a remote identity, linked or not, and keeps an existing plan as it was", async () => {
    const { paths, ids } = world(w => {
      const registration = w.register("registration");
      w.store.saveKnowledgeProject({ id: registration, name: "Same ID", status: "active", revision: 1, createdAt: PAST, updatedAt: PAST }, "fixture");
      w.remote("shared");
      w.store.saveKnowledgeProject({ id: "shared", name: "Shared", status: "active", revision: 1, createdAt: PAST, updatedAt: PAST }, "fixture");
      return { registration };
    });
    expect(existsSync(planFile(paths))).toBe(false);
    const details = await stops(paths, "upgrade_mapping_collision");
    expect(details.findings.map(entry => [entry.table, entry.id])).toEqual([[`projects,knowledge_projects`, ids.registration], ["knowledge_projects,remote_project_identities", "shared"]].sort((a, b) => (a[1] < b[1] ? -1 : 1)));
    expect(existsSync(planFile(paths))).toBe(false);
    // An existing plan (written before the collision existed) is left as it was.
    const clean = installation(w => { w.register("clean"); });
    const plan = inspect(clean);
    const registration = read(clean, database => database.prepare("SELECT id FROM projects").pluck().get());
    tamper(clean, database => { database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)").run(registration, "Collides", "active", PAST, PAST); });
    const kept = readFileSync(planFile(clean), "utf8");
    await stops(clean, "upgrade_mapping_collision");
    expect(readFileSync(planFile(clean), "utf8")).toBe(kept);
    expect(JSON.parse(kept).sha256).toBe(plan.planHash);
  });

  it("finds dangling links, bindings and parents in the proposal pass; ownership's foreign-key validation refuses such a database before it", async () => {
    const { paths, ids } = standard();
    tamper(paths, database => {
      database.pragma("foreign_keys = OFF");
      database.prepare("INSERT INTO knowledge_project_runtime_links(knowledge_project_id,runtime_project_id,linked_at,unlinked_at) VALUES('ghost-project',?,?,NULL)").run(ids.plain, PAST);
      database.prepare("UPDATE remote_worker_project_grants SET worker_id='ghost-worker'").run();
    });
    const before = files(paths);
    expect(() => inspect(paths)).toThrow(/foreign key check failed/);
    expect(files(paths)).toEqual(before);
    expect(existsSync(planFile(paths))).toBe(false);
    // The pass itself names them, on the same rows.
    const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
    try {
      const refusal = await failure(() => proposeProjectMapping(database, { schemaVersion: 49, source: 49, target: TARGET }, normaliseMappingDecisions({}), null, true));
      expect(refusal).toMatchObject({ code: "upgrade_mapping_dangling", details: { count: 2 } });
      expect(refusal.details!.findings.map(entry => entry.id).sort()).toEqual(["ghost-project", "remote-a"]);
      expect(refusal.details!.findings.map(entry => entry.problem).join(";")).toContain("missing project");
    } finally { database.close(); }
  });

  it("stops on a parent while the upgrade is needed", async () => {
    const { paths, ids } = standard();
    await apply(paths, inspect(paths).planHash!);
    resume(paths);
    tamper(paths, database => {
      database.prepare("UPDATE project_mapping_clock SET value=value+1").run();
      database.prepare("UPDATE projects SET parent_project_id=?,mapping_version=(SELECT value FROM project_mapping_clock) WHERE id=?").run(ids.knowledge, ids.plain);
    });
    const details = await stops(paths, "upgrade_mapping_unexpected");
    expect(details.findings).toEqual([{ table: "projects", id: ids.plain, problem: "has a parent project while the upgrade is needed" }]);
  });

  it("stops on a project journaled as created twice, or created after an earlier acceptance", async () => {
    for (const variant of ["twice", "after acceptance"] as const) {
      const { paths, ids } = standard();
      await apply(paths, inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }] }).planHash!);
      const created = parents(paths).registrations[ids.plain]!;
      resume(paths);
      tamper(paths, database => {
        const row = database.prepare("SELECT plan_hash,run_receipt,recorded_at FROM project_mapping_journal LIMIT 1").get() as Record<string, string>;
        database.prepare("INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES('registration',?,1,?,'created_project',?,?,?)")
          .run(ids.linked, variant === "twice" ? created : ids.knowledge, row.plan_hash, row.run_receipt, row.recorded_at);
      });
      const details = await stops(paths, "upgrade_mapping_journal");
      expect(details.findings, variant).toEqual([variant === "twice"
        ? { table: "project_mapping_journal", id: created, problem: expect.stringMatching(/^created by 2 entries/) }
        : { table: "project_mapping_journal", id: ids.knowledge, problem: expect.stringMatching(/^created by entry \d+ after its acceptance in entry \d+$/) }]);
    }
  });

  it("treats journal rows the table refuses, and malformed IDs, as corruption", async () => {
    // Journal rows with an unissued incarnation or an illegal kind and basis: the table and validation refuse them, so the pass is probed directly.
    const database = unmanagedFixtureDatabase(":memory:");
    try {
      initializeSchema(database, undefined, current => { inspectSchema(current, TARGET); }, { target: TARGET });
      database.exec("DROP TABLE project_mapping_journal");
      database.exec("CREATE TABLE project_mapping_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind, subject_id, subject_incarnation, project_id, basis, plan_hash, run_receipt, recorded_at)");
      database.exec("UPDATE project_mapping_clock SET value=3");
      const insert = database.prepare("INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,recorded_at) VALUES(?,?,?,?,?,?)");
      const propose = () => proposeProjectMapping(database, { schemaVersion: TARGET, source: TARGET, target: TARGET }, normaliseMappingDecisions({}), null, true);
      insert.run("registration", "zero", 0, "project-z", "created_project", PAST);
      expect(await failure(propose)).toMatchObject({ code: "upgrade_mapping_malformed", details: { findings: [{ table: "project_mapping_journal", id: "zero", problem: "malformed journal row" }] } });
      database.exec("DELETE FROM project_mapping_journal");
      insert.run("registration", "gone", 7, "project-x", "created_project", PAST);
      insert.run("remote_identity", "gone-too", 2, "project-y", "accepted_link", PAST);
      const refusal = await failure(propose);
      expect(refusal).toMatchObject({ code: "upgrade_mapping_journal", details: { count: 2 } });
      expect(refusal.details!.findings.map(entry => [entry.id, entry.problem])).toEqual([
        ["gone", expect.stringMatching(/records an incarnation the clock has not issued$/)], ["gone-too", expect.stringMatching(/illegal kind and basis$/)]]);
    } finally { database.close(); }
    // A registration whose ID is not text, through ownership: the pass refuses it as malformed.
    const paths = installation(w => { w.register("text"); });
    tamper(paths, database => {
      database.prepare("INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES(X'0102',?,?,?,?,?,?,?,?,?)")
        .run("blob", "/srv/blob", 5999, "node", "[]", "/", 1000, PAST, PAST);
    });
    const before = files(paths);
    expect(await failure(() => inspect(paths))).toMatchObject({ code: "upgrade_mapping_malformed", details: { findings: [{ table: "projects", id: "<object>", problem: "ID is not bounded text" }] } });
    expect(files(paths)).toEqual(before);
  });

  it("refuses more acts than the plan allows, and a plan larger than its byte limit, without truncating", async () => {
    const many = installation();
    tamper(many, database => {
      const insert = database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES(?,?,?,'active')");
      database.transaction(() => { for (let index = 0; index < 25_001; index++) insert.run(`remote-${index}`, "r", "origin"); })();
    });
    expect((await stops(many, "upgrade_plan_bounds")).findings).toEqual([{ table: "plan", id: "acts", problem: expect.stringContaining("25001 registrations and remote identities") }]);
    const large = installation();
    tamper(large, database => {
      const insert = database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES(?,?,?,'active')");
      database.transaction(() => { for (let index = 0; index < 6000; index++) insert.run(`remote-${index}`, "n".repeat(1024), "origin"); })();
    });
    expect((await stops(large, "upgrade_plan_bounds")).findings).toEqual([{ table: "plan", id: "bytes", problem: expect.stringContaining("exceeds") }]);
  });
});

/**
 * Every value of every row, as SQLite quotes it (text, numbers and blobs
 * exactly), keyed by table and rowid.
 */
function quoted(database: Database.Database): Record<string, Record<string, Record<string, string>>> {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[];
  return Object.fromEntries(tables.map(table => {
    const columns = (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name);
    const rows = database.prepare(`SELECT rowid AS r,${columns.map(column => `quote("${column}")`).join(",")} FROM "${table}" ORDER BY rowid`).raw().all() as unknown[][];
    return [table, Object.fromEntries(rows.map(row => [String(row[0]), Object.fromEntries(columns.map((column, index) => [column, String(row[index + 1])]))]))];
  }));
}
/**
 * The preservation allow-list: what an apply from schema 49 may change. Every
 * other table, row and value that existed before is byte-identical after.
 */
const PRESERVATION = {
  /** Only these three columns are added and set; every older column is unchanged. */
  mappedColumns: { projects: ["parent_project_id", "incarnation", "mapping_version"], remote_project_identities: ["parent_project_id", "incarnation", "mapping_version"] },
  /** Existing rows unchanged; only new rows: the created projects, the upgrade's audit event, steps 50 and 51. */
  appendOnly: ["knowledge_projects", "controller_audit_events", "schema_migrations"],
  /** The fence's epoch changes with every covered write; the installation does not. */
  checkpoint: { security_checkpoint: ["epoch"] },
  /** New tables of steps 50 and 51. */
  created: ["project_mapping_clock", "project_mapping_journal", "upgrade_marker"],
  /** sqlite_sequence: the audit table moves by the one event; the journal's row is new. */
  sequences: { controller_audit_events: 1 },
} as const;

describe("project mapping: preservation after apply", () => {
  it("keeps every pre-existing row byte-identical apart from the allow-list, Vault ciphertext and history ordinals included", async () => {
    const { paths, ids } = world(w => {
      const linked = w.register("linked"), plain = w.register("plain");
      const knowledge = w.project("Linked knowledge");
      w.link(knowledge, linked); w.task(knowledge);
      w.store.devVault.commit(linked, 0, CIPHERTEXT); w.store.devVault.commit(plain, 0, `${CIPHERTEXT}-2`);
      w.store.saveProjectEnvironmentProfile(plain, { name: "secrets", environment: { API_KEY: SECRET_VALUE } }, "fixture");
      w.remote("remote-a"); w.worker("worker-a"); w.bind("worker-a", "remote-a", linked); w.remote("remote-b"); w.bind("worker-a", "remote-b", plain, true);
      return { linked, plain, knowledge };
    });
    const before = read(paths, quoted);
    const inspection = inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }], bindings: [{ remoteIdentityId: "remote-a", registrationId: ids.linked }] });
    const created = (inspection.plan!.acts.filter(act => act.kind === "create_project").map(act => (act.payload as { projectId: string }).projectId));
    expect(created).toHaveLength(2);
    await apply(paths, inspection.planHash!);
    const after = read(paths, quoted);
    expect(Object.keys(after).filter(table => !(table in before)).sort()).toEqual([...PRESERVATION.created].sort());
    for (const [table, rows] of Object.entries(before)) {
      const later = after[table];
      if (table === "sqlite_sequence") continue;
      for (const [rowid, row] of Object.entries(rows)) {
        const exempt = (PRESERVATION.checkpoint as Record<string, readonly string[]>)[table] ?? [];
        expect(Object.fromEntries(Object.entries(later[rowid]).filter(([column]) => column in row && !exempt.includes(column))), `${table} ${rowid}`)
          .toEqual(Object.fromEntries(Object.entries(row).filter(([column]) => !exempt.includes(column))));
        const added = Object.keys(later[rowid]).filter(column => !(column in row));
        expect(added, table).toEqual([...((PRESERVATION.mappedColumns as Record<string, readonly string[]>)[table] ?? [])]);
      }
      const extra = Object.keys(later).filter(rowid => !(rowid in rows));
      if (!(PRESERVATION.appendOnly as readonly string[]).includes(table)) expect(extra, table).toEqual([]);
    }
    read(paths, database => {
      expect(database.prepare("SELECT id FROM knowledge_projects WHERE rowid>? ORDER BY id").pluck().all(Math.max(...Object.keys(before.knowledge_projects).map(Number)))).toEqual([...created].sort());
      expect(database.prepare("SELECT event_type FROM controller_audit_events WHERE rowid>?").pluck().all(Math.max(...Object.keys(before.controller_audit_events).map(Number)))).toEqual(["authentication.upgrade_applied"]);
      expect(database.prepare("SELECT version FROM schema_migrations WHERE version>49 ORDER BY version").pluck().all()).toEqual([50, 51]);
      const sequences = Object.fromEntries((database.prepare("SELECT name,seq FROM sqlite_sequence").all() as Array<{ name: string; seq: number }>).map(row => [row.name, row.seq]));
      const old = new Map<string, number>(Object.values(before.sqlite_sequence).map(row => [row.name.slice(1, -1), Number(row.seq)]));
      for (const [name, seq] of old) expect(sequences[name], name).toBe(seq + ((PRESERVATION.sequences as Record<string, number>)[name] ?? 0));
      expect(sequences.project_mapping_journal).toBe(4);
      // Every registration and identity has a parent and non-zero stamps; one journal row per attach and map act.
      for (const table of ["projects", "remote_project_identities"]) for (const row of stamps(database, table)) {
        expect(row.parent).not.toBeNull(); expect(row.incarnation).toBeGreaterThan(0); expect(row.version).toBeGreaterThan(0);
      }
      expect(journal(database).map(row => [row.subject_kind, row.subject_id, row.basis])).toEqual(inspection.plan!.acts.filter(act => act.kind !== "create_project")
        .map(act => { const payload = act.payload as Record<string, string>; return [act.kind === "attach_registration" ? "registration" : "remote_identity", payload.registrationId ?? payload.remoteIdentityId, payload.basis]; }));
      expect(database.prepare("SELECT ciphertext FROM dev_environment_vaults ORDER BY ciphertext").pluck().all()).toEqual([CIPHERTEXT, `${CIPHERTEXT}-2`]);
    });
  });
});

describe("project mapping: the journal after a resume", () => {
  /** Applied with the standard world's defaults, then resumed at 51: parents cleared, projects and journal kept. */
  async function resumed(decisions?: unknown) {
    const { paths, ids } = standard();
    await apply(paths, inspect(paths, decisions).planHash!);
    const first = parents(paths), journalBefore = read(paths, journal);
    resume(paths);
    const cleared = parents(paths);
    expect(Object.values(cleared.registrations).every(parent => parent === null) && Object.values(cleared.remoteIdentities).every(parent => parent === null)).toBe(true);
    expect(read(paths, journal)).toEqual(journalBefore);
    return { paths, ids, first };
  }

  it("nominates each created project for its own subject, shows the nomination, and ends with the same parenthood", async () => {
    const { paths, ids, first } = await resumed();
    const inspection = inspect(paths);
    expect(kinds(inspection.plan!.acts)).toEqual(["attach_registration", "attach_registration", "map_remote_identity"]);
    for (const [id, project] of [[ids.linked, first.registrations[ids.linked]], [ids.plain, first.registrations[ids.plain]], [ids.remote, first.remoteIdentities[ids.remote]]]) {
      const entry = outcomeOf(inspection, id!);
      expect(entry.outcome, id!).toEqual({ projectId: project, basis: "journal_reuse", created: false });
      expect(entry.nomination).toMatchObject({ projectId: project, basis: "created_project", used: true, reason: "used", recordedAt: expect.any(String), sequence: expect.any(Number) });
    }
    expect(review(inspection).projects.map(project => project.id).sort()).toEqual([first.registrations[ids.linked], first.registrations[ids.plain], first.remoteIdentities[ids.remote]].sort());
    expect(review(inspection).projects[0].registrations.concat(review(inspection).projects[0].remoteIdentities)).toEqual([expect.objectContaining({ plan: true, journal: true, present: true })]);
    expect(inspection.acts!.join("\n")).toContain("It is a nomination from history: approve it through the plan hash, or decline it with isolate.");
    await apply(paths, inspection.planHash!);
    expect(parents(paths)).toEqual(first);
    read(paths, database => expect(journal(database).slice(-3).map(row => row.basis)).toEqual(["journal_reuse", "journal_reuse", "journal_reuse"]));
  });

  it("declines a nomination with isolate", async () => {
    const { paths, ids, first } = await resumed();
    const inspection = inspect(paths, { isolate: { registrations: [ids.plain] } });
    const entry = outcomeOf(inspection, ids.plain);
    expect(entry.outcome).toMatchObject({ basis: "created_project", created: true });
    expect(entry.outcome.projectId).not.toBe(first.registrations[ids.plain]);
    expect(entry.nomination).toMatchObject({ projectId: first.registrations[ids.plain], used: false, reason: "isolated" });
  });

  it("does not reuse a nomination for a registration removed and created again with the same ID", async () => {
    const { paths, ids, first } = await resumed();
    tamper(paths, database => {
      const row = database.prepare("SELECT * FROM projects WHERE id=?").get(ids.plain) as Record<string, unknown>;
      database.prepare("DELETE FROM projects WHERE id=?").run(ids.plain);
      database.prepare("INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(ids.plain, row.name, row.repository_path, row.port, row.executable, row.args_json, row.healthcheck_path, row.startup_timeout_ms, row.created_at, row.updated_at);
    });
    const inspection = inspect(paths);
    const entry = outcomeOf(inspection, ids.plain);
    expect(entry.outcome).toMatchObject({ basis: "created_project", created: true });
    expect(entry.outcome.projectId).not.toBe(first.registrations[ids.plain]);
    expect(entry.nomination).toMatchObject({ projectId: first.registrations[ids.plain], used: false, reason: "incarnation_changed" });
    expect(inspection.acts!.join("\n")).toContain("removed and created again since");
  });

  it("still nominates a project that meanwhile gained Knowledge content and another registration, and shows both", async () => {
    const { paths, ids, first } = await resumed();
    const nominated = first.registrations[ids.plain]!;
    const newcomer = randomUUID();
    tamper(paths, database => {
      database.prepare("INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(newcomer, "newcomer", `${SECRET_PATH}/newcomer`, 5998, "node", "[]", "/", 1000, PAST, PAST);
      database.prepare("INSERT INTO knowledge_project_runtime_links(knowledge_project_id,runtime_project_id,linked_at,unlinked_at) VALUES(?,?,?,NULL)").run(nominated, newcomer, PAST);
      const principal = database.prepare("SELECT id FROM remote_principals WHERE kind='owner'").pluck().get();
      database.prepare("INSERT INTO knowledge_tasks(id,project_id,title,description,status,priority,revision,created_by,created_at,updated_at) VALUES(?,?,'t','d','open','later',1,?,?,?)").run(randomUUID(), nominated, principal, PAST, PAST);
    });
    const inspection = inspect(paths, { links: [{ registrationId: newcomer, projectId: nominated }] });
    expect(outcomeOf(inspection, ids.plain).outcome).toEqual({ projectId: nominated, basis: "journal_reuse", created: false });
    expect(outcomeOf(inspection, newcomer).outcome).toEqual({ projectId: nominated, basis: "accepted_link", created: false });
    const project = review(inspection).projects.find(entry => entry.id === nominated)!;
    expect(project.inventory.tasks).toBe(1);
    expect(project.registrations).toEqual([
      { id: ids.plain, plan: true, journal: true, present: true }, { id: newcomer, plan: true, journal: false, present: true },
    ].sort((a, b) => (a.id < b.id ? -1 : 1)));
  });

  it("does not reuse an accepted link without the decision", async () => {
    const fixture = standard();
    await apply(fixture.paths, inspect(fixture.paths, { links: [{ registrationId: fixture.ids.linked, projectId: fixture.ids.knowledge }] }).planHash!);
    resume(fixture.paths);
    const undecided = inspect(fixture.paths);
    const entry = outcomeOf(undecided, fixture.ids.linked);
    expect(entry.outcome).toMatchObject({ basis: "created_project", created: true });
    expect(entry.nomination).toMatchObject({ projectId: fixture.ids.knowledge, basis: "accepted_link", used: false, reason: "accepted_basis" });
    const decided = inspect(fixture.paths, { links: [{ registrationId: fixture.ids.linked, projectId: fixture.ids.knowledge }] });
    expect(outcomeOf(decided, fixture.ids.linked).outcome).toEqual({ projectId: fixture.ids.knowledge, basis: "accepted_link", created: false });
    expect(outcomeOf(decided, fixture.ids.linked).nomination).toMatchObject({ reason: "accepted_basis" });
  });
});

describe("project mapping: backup, restore, resume, inspect, apply", () => {
  it("restores a schema-49 backup over an upgraded database and then maps exactly the approved plan", async () => {
    const { paths, ids } = standard();
    const backup = join(paths.dataDirectory, "..", "schema-49-backup");
    const store = new SqliteStateStore(paths.databasePath);
    try { await createControllerBackup(store, backup, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }); } finally { store.close(); }
    const decisions = { links: [{ registrationId: ids.linked, projectId: ids.knowledge }], bindings: [{ remoteIdentityId: ids.remote, registrationId: ids.linked }] };
    const approved = inspect(paths, decisions);
    await apply(paths, approved.planHash!);
    restoreControllerBackup(backup, paths.databasePath);
    resume(paths);
    read(paths, database => {
      expect(inspectSchema(database, TARGET).version).toBe(51);
      expect(database.prepare("SELECT count(*) FROM knowledge_projects").pluck().get()).toBe(2);
      expect(journal(database)).toEqual([]);
      for (const table of ["projects", "remote_project_identities"]) for (const row of stamps(database, table)) expect(row.parent).toBeNull();
    });
    const again = inspect(paths, decisions);
    const shape = (inspection: ReturnType<typeof inspect>) => [...review(inspection).registrations, ...review(inspection).remoteIdentities]
      .map(row => [row.id, row.outcome.basis, row.outcome.created, row.outcome.created ? "<new>" : row.outcome.projectId]);
    expect(shape(again)).toEqual(shape(approved));
    expect(again.decisions).toEqual(approved.decisions);
    await apply(paths, again.planHash!);
    const mapped = parents(paths);
    expect(mapped.registrations[ids.linked]).toBe(ids.knowledge);
    expect(mapped.remoteIdentities[ids.remote]).toBe(ids.knowledge);
    expect(mapped.registrations[ids.plain]).toBe((again.plan!.acts.find(act => act.kind === "attach_registration" && (act.payload as { registrationId: string }).registrationId === ids.plain)!.payload as { projectId: string }).projectId);
  });
});

describe("project mapping: interrupted apply", () => {
  /** The mapping state with generated values named by first appearance, in subject order. */
  const mappingState = (paths: AppPaths) => read(paths, database => {
    const names = new Map<string, string>();
    const name = (value: unknown) => {
      if (typeof value !== "string") return value;
      if (!names.has(value)) names.set(value, `generated#${names.size + 1}`);
      return names.get(value);
    };
    const known = new Set(database.prepare("SELECT id FROM knowledge_projects WHERE revision>1 OR created_at=?").pluck().all(PAST) as string[]);
    const project = (value: unknown) => known.has(value as string) ? value : name(value);
    return {
      clock: clock(database),
      registrations: stamps(database, "projects").map(row => ({ ...row, parent: project(row.parent) })),
      remoteIdentities: stamps(database, "remote_project_identities").map(row => ({ ...row, parent: project(row.parent) })),
      journal: journal(database).map(row => ({ subject: row.subject_id, kind: row.subject_kind, incarnation: row.subject_incarnation, project: project(row.project_id), basis: row.basis })),
      projects: (database.prepare("SELECT id,name,status,revision FROM knowledge_projects ORDER BY name,id").all() as Array<Record<string, unknown>>).map(row => ({ ...row, id: project(row.id) })),
    };
  });

  it("rolls back every act, created project and journal row with the steps; after resume, inspect and apply end as an uninterrupted run", async () => {
    const decisions = (ids: Record<string, string>) => ({ links: [{ registrationId: ids.linked, projectId: ids.knowledge }] });
    const { paths, ids } = standard();
    const noted = inspect(paths, decisions(ids)).planHash!;
    const before = read(paths, quoted);
    let journalInserts = 0;
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      // The second journal row: one attach act and the creations already ran.
      if (source.startsWith("INSERT INTO project_mapping_journal") && ++journalInserts === 2) throw new Error("fixture act fault");
      return prepare.call(this, source);
    } as typeof prepare);
    expect(await failure(() => apply(paths, noted))).toMatchObject({ code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed: false, state: "fenced" });
    expect(journalInserts).toBe(2);
    vi.restoreAllMocks();
    const after = read(paths, quoted);
    expect({ ...after, security_checkpoint: undefined }).toEqual({ ...before, security_checkpoint: undefined });
    resume(paths);
    await apply(paths, inspect(paths, decisions(ids)).planHash!);
    // The uninterrupted twin, through the same operator steps (resume first, then inspect and apply).
    const twin = standard();
    resume(twin.paths);
    await apply(twin.paths, inspect(twin.paths, decisions(twin.ids)).planHash!);
    // Registration and project IDs differ between the two installations: compare by name and order.
    const byName = (state: ReturnType<typeof mappingState>, idsOf: Record<string, string>) => JSON.parse(JSON.stringify(state)
      .replaceAll(idsOf.linked, "<linked>").replaceAll(idsOf.plain, "<plain>").replaceAll(idsOf.knowledge, "<knowledge>").replaceAll(idsOf.lonely, "<lonely>"));
    const left = byName(mappingState(paths), ids), right = byName(mappingState(twin.paths), twin.ids);
    expect(left.clock).toBe(right.clock);
    const bases = (state: { journal: Array<Record<string, unknown>> }) => state.journal.map(row => `${String(row.subject)}:${String(row.kind)}:${String(row.basis)}`).sort();
    expect(bases(left)).toEqual(bases(right));
    expect(left.projects.map((row: Record<string, unknown>) => [row.name, row.status, row.revision])).toEqual(right.projects.map((row: Record<string, unknown>) => [row.name, row.status, row.revision]));
    const parentOf = (state: { registrations: Array<{ id: string; parent: unknown }> }, id: string) => state.registrations.find(row => row.id === id)!.parent;
    expect(parentOf(left, "<linked>")).toBe("<knowledge>");
    expect(parentOf(right, "<linked>")).toBe("<knowledge>");
    expect(String(parentOf(left, "<plain>"))).toMatch(/^generated#/);
  });
});

describe("project mapping: whole-plan validation", () => {
  /** A plan file with a consistent envelope hash, as an operator could hand-write it. */
  const writePlan = (paths: AppPaths, payload: unknown) => {
    const hash = sha(canonicalJson(payload));
    writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }), { mode: 0o600 });
    return hash;
  };
  type Mutation = (plan: UpgradePlan, ids: Record<string, string>) => unknown;
  const attachOf = (plan: UpgradePlan, id: string) => plan.acts.findIndex(act => act.kind === "attach_registration" && (act.payload as { registrationId: string }).registrationId === id);
  const MUTATIONS: Array<[string, Mutation]> = [
    ["an attach to a project the proposal would not choose", (plan, ids) => { const index = attachOf(plan, ids.plain); plan.acts[index] = { kind: "attach_registration", payload: { registrationId: ids.plain, projectId: ids.lonely, basis: "journal_reuse" } }; return plan; }],
    ["an attachment labelled created_project for a pre-existing project", (plan, ids) => {
      const index = attachOf(plan, ids.plain), created = (plan.acts[index].payload as { projectId: string }).projectId;
      plan.acts = plan.acts.map(act => act.kind === "create_project" && (act.payload as { projectId: string }).projectId === created ? { kind: "create_project", payload: { projectId: ids.lonely, name: "plain" } } : act);
      plan.acts[index] = { kind: "attach_registration", payload: { registrationId: ids.plain, projectId: ids.lonely, basis: "created_project" } };
      return plan;
    }],
    ["a created project nobody is attached to", plan => { plan.acts.unshift({ kind: "create_project", payload: { projectId: randomUUID(), name: "orphan" } }); return plan; }],
    ["a missing registration", (plan, ids) => { plan.acts.splice(attachOf(plan, ids.plain), 1); return plan; }],
    ["a duplicate attach", (plan, ids) => { plan.acts.splice(attachOf(plan, ids.plain), 0, plan.acts[attachOf(plan, ids.plain)]); return plan; }],
    ["acts out of dependency order", plan => { const creates = plan.acts.filter(act => act.kind === "create_project"); plan.acts = [...plan.acts.filter(act => act.kind !== "create_project"), ...creates]; return plan; }],
    ["decisions that do not match the acts", (plan, ids) => { plan.decisions = { mapping: { links: [{ registrationId: ids.linked, projectId: ids.knowledge }], bindings: [], isolate: { registrations: [], remoteIdentities: [] } } }; return plan; }],
    ["an altered review", plan => { (plan.review.mapping as MappingReview).registrations[0].inventory.testRuns = 5; return plan; }],
  ];

  it.each(MUTATIONS)("refuses %s before the backup with nothing changed, and again inside the transaction", async (_name, mutate) => {
    const { paths, ids } = standard();
    const genuine = inspect(paths).plan!;
    const payload = mutate(JSON.parse(JSON.stringify(genuine)) as UpgradePlan, ids) as UpgradePlan;
    const hash = writePlan(paths, payload);
    const before = files(paths), calls: string[] = [];
    expect(await failure(() => apply(paths, hash, backups(paths, calls)))).toMatchObject({ code: "upgrade_plan_unproposed", nextStep: "upgrade inspect", committed: false });
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(before);
    // The in-transaction check alone (the pre-check bypassed): a copy of the database taken to 51, the plan validated after the steps.
    const copy = join(temporary(), "copy.sqlite3");
    copyFileSync(paths.databasePath, copy);
    if (existsSync(`${paths.databasePath}-wal`)) copyFileSync(`${paths.databasePath}-wal`, `${copy}-wal`);
    const database = unmanagedFixtureDatabase(copy);
    try {
      const at = (current: Database.Database) => { inspectSchema(current, TARGET); };
      expect(() => initializeSchema(database, false, at, { target: TARGET, acts: current => validateUpgradeProposal(current, payload, TARGET) }))
        .toThrowError(expect.objectContaining({ code: "upgrade_plan_unproposed" }));
      expect(inspectSchema(database).version).toBe(49);
      // The genuine plan passes the same check.
      expect(() => initializeSchema(database, false, at, { target: TARGET, acts: current => { validateUpgradeProposal(current, genuine, TARGET); throw new Error("rollback"); } })).toThrow("rollback");
    } finally { database.close(); }
  });

  it("refuses a plan of the old format as malformed", async () => {
    const { paths } = standard();
    const genuine = inspect(paths).plan!;
    const { decisions: _decisions, review: _review, ...rest } = genuine;
    void _decisions; void _review;
    const hash = writePlan(paths, { ...rest, format: 1, acts: [] });
    const before = files(paths);
    expect(await failure(() => apply(paths, hash))).toMatchObject({ code: "upgrade_plan_invalid", nextStep: "upgrade inspect" });
    expect(files(paths)).toEqual(before);
  });
});

describe("project mapping: determinism", () => {
  it("gives the same hash and generated IDs for an unchanged database and decisions, and a new hash or base otherwise", () => {
    const { paths, ids } = standard();
    const first = inspect(paths), second = inspect(paths);
    expect(second.planHash).toBe(first.planHash);
    expect(second.plan).toEqual(first.plan);
    const decided = inspect(paths, { isolate: { remoteIdentities: [ids.remote] } });
    expect(decided.planHash).not.toBe(first.planHash);
    // Back to no decisions: the plan file now holds the decided plan, whose decisions differ, so new IDs are generated; repeating gives the same hash again.
    const third = inspect(paths);
    expect(third.plan!.decisions).toEqual(first.plan!.decisions);
    expect(inspect(paths).planHash).toBe(third.planHash);
    const store = new SqliteStateStore(paths.databasePath);
    try { store.addProject({ name: "late", repositoryPath: `${SECRET_PATH}/late`, port: ports++, executable: "node", args: [] }); } finally { store.close(); }
    const changed = inspect(paths);
    expect(changed.plan!.base).not.toBe(third.plan!.base);
    expect(changed.planHash).not.toBe(third.planHash);
    expect(upgradePlanHash(changed.plan!)).toBe(changed.planHash);
  });
});

describe("project mapping: acts against step 51's triggers", () => {
  it("stamps unstamped rows from schema 49 and advances stamped rows after a resume, one clock value per act", async () => {
    const { paths } = standard();
    const inspection = inspect(paths);
    await apply(paths, inspection.planHash!);
    read(paths, database => {
      const mapped = [...stamps(database, "projects"), ...stamps(database, "remote_project_identities")];
      expect(clock(database)).toBe(3);
      expect(mapped.map(row => row.incarnation).sort()).toEqual([1, 2, 3]);
      for (const row of mapped) expect(row.version).toBe(row.incarnation);
    });
    resume(paths);
    const base = read(paths, clock), stamped = read(paths, database => [...stamps(database, "projects"), ...stamps(database, "remote_project_identities")]);
    const again = inspect(paths);
    await apply(paths, again.planHash!);
    read(paths, database => {
      expect(clock(database)).toBe(base + 3);
      const order = again.plan!.acts.map(act => (act.payload as Record<string, string>).registrationId ?? (act.payload as Record<string, string>).remoteIdentityId);
      const now = [...stamps(database, "projects"), ...stamps(database, "remote_project_identities")];
      for (const row of now) {
        expect(row.incarnation).toBe(stamped.find(entry => entry.id === row.id)!.incarnation);
        expect(row.version).toBe(base + 1 + order.indexOf(row.id));
      }
    });
  });

  it("rolls everything back when the clock is exhausted during apply", async () => {
    const { paths } = standard();
    await apply(paths, inspect(paths).planHash!);
    resume(paths);
    tamper(paths, database => { database.prepare("UPDATE project_mapping_clock SET value=?").run(MAPPING_CLOCK_MAX - 1); });
    const inspection = inspect(paths);
    expect(inspection.plan!.acts.length).toBeGreaterThan(1);
    const before = read(paths, quoted);
    expect(await failure(() => apply(paths, inspection.planHash!))).toMatchObject({ code: "upgrade_outcome_uncertain", committed: false, state: "fenced" });
    expect({ ...read(paths, quoted), security_checkpoint: undefined }).toEqual({ ...before, security_checkpoint: undefined });
  });
});

describe("project mapping: the review", () => {
  it("carries no repository path, remote URL, environment value or ciphertext, escapes control characters, counts the fixture and orders stably", () => {
    const { paths, ids } = world(w => {
      const evil = w.register("evil\u001b[2J‮name\\");
      w.store.devVault.commit(evil, 0, CIPHERTEXT);
      w.store.saveProjectEnvironmentProfile(evil, { name: "secrets", environment: { API_KEY: SECRET_VALUE } }, "fixture");
      const knowledge = w.project("Knowledge\u0007bell");
      w.link(knowledge, evil); w.task(knowledge);
      w.remote("remote\u0001id", "Remote\u009bname"); w.worker("worker-a"); w.bind("worker-a", "remote\u0001id", evil);
      return { evil, knowledge };
    });
    const inspection = inspect(paths, { links: [{ registrationId: ids.evil, projectId: ids.knowledge }] });
    const text = readFileSync(planFile(paths), "utf8");
    for (const secret of [SECRET_PATH, SECRET_REMOTE, SECRET_VALUE, CIPHERTEXT, "API_KEY", "node:test"]) expect(text, secret).not.toContain(secret);
    const entry = outcomeOf(inspection, ids.evil) as MappingReview["registrations"][number];
    expect(entry.name).toBe("evil\\u{1b}[2J\\u{202e}name\\\\");
    expect(entry.inventory).toEqual({ vaultRecords: 1, reservations: 0, activeReservations: 0, testRuns: 0, environmentProfiles: 2 });
    expect(review(inspection).projects[0].name).toBe("Knowledge\\u{7}bell");
    expect(review(inspection).remoteIdentities[0]).toMatchObject({ id: "remote\u0001id", name: "Remote\\u{9b}name", inventory: { requests: 0, attempts: 0 } });
    // The operator's lines carry no control character at all (IDs are escaped there too).
    for (const line of inspection.acts!) expect(line, line).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
    expect(inspection.acts!.join("\n")).toContain("remote\\u{1}id");
    // Stable ordering: a second inspect gives the same review, byte for byte.
    expect(canonicalJson(inspect(paths, { links: [{ registrationId: ids.evil, projectId: ids.knowledge }] }).review)).toBe(canonicalJson(inspection.review));
    const sorted = (values: string[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(review(inspection).registrations.map(row => row.id)).toEqual(sorted(review(inspection).registrations.map(row => row.id)));
    expect(MAPPING_ACT_DOMAIN.review.safeParse(inspection.review!.mapping).success).toBe(true);
  });
});

describe("project mapping: targets", () => {
  it("refuses decisions at target 50 before any lock, and plans step 51 with the mapping acts from a completed step-50 database", async () => {
    const paths = installation(w => { w.register("only"); });
    const before = files(paths);
    expect(await failure(() => inspectSqliteUpgrade(paths, 50, { isolate: { registrations: ["x"] } }))).toMatchObject({ code: "upgrade_decisions_invalid", details: { findings: [{ table: "decisions", id: "isolate" }] } });
    expect(existsSync(paths.controllerLockPath)).toBe(false);
    expect(files(paths)).toEqual(before);
    const at50 = inspectSqliteUpgrade(paths, 50, {});
    expect(at50.plan).toMatchObject({ target: 50, decisions: {}, acts: [], review: {} });
    await applySqliteUpgrade(paths, { expect: at50.planHash! }, backups(paths), 50);
    const at51 = inspect(paths);
    expect(at51.plan!.steps).toEqual([{ version: 51, name: projectMappingMigration.name, checksum: projectMappingChecksum }]);
    expect(kinds(at51.plan!.acts)).toEqual(["create_project", "attach_registration"]);
    await apply(paths, at51.planHash!);
    expect(Object.values(parents(paths).registrations).every(parent => typeof parent === "string")).toBe(true);
  });

  it("has no acts and completes for an installation without registrations or remote identities", async () => {
    const paths = installation();
    const inspection = inspect(paths);
    expect(inspection.plan).toMatchObject({ acts: [], review: { mapping: { registrations: [], remoteIdentities: [], projects: [], untouchedProjects: 0 } } });
    expect(await apply(paths, inspection.planHash!)).toMatchObject({ state: "current", schemaVersion: 51 });
    read(paths, database => { expect(journal(database)).toEqual([]); expect(clock(database)).toBe(0); });
  });
});
