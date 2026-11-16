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
import {
  canonicalJson, FindingList, normaliseUpgradeDecisions, UPGRADE_DETAILS_LIMITS, upgradePlanHash, upgradePlanPath, validateUpgradeProposal, type UpgradeAct, type UpgradePlan,
} from "./upgrade-plan";
import {
  applicationProjectName, deriveProjectName, MAPPING_ACT_DOMAIN, MAPPING_READ_LIMIT, MAPPING_STORED_COLUMNS, MAPPING_TEXT_COLUMNS, normaliseMappingDecisions, PROJECT_NAME_LIMIT, proposeProjectMapping,
  type MappingReview,
} from "./mapping-upgrade-acts";
import { parseKnowledgeProjectSnapshot } from "../../modules/knowledge/project-transfer-schema";
import { exact, plain } from "./fixtures/exact-rows";

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
    const links = () => read(paths, database => exact(database).knowledge_project_runtime_links);
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
    expect(inspection.acts!.join("\n")).toContain("not accepted; the registration does not join that project in this plan");
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
    expect(outcomeOf(inspection, ids.linked).outcome).toEqual({ projectId: ids.knowledge, basis: "accepted_link", created: false, existing: true });
    expect(outcomeOf(inspection, ids.other).outcome).toMatchObject({ basis: "created_project", created: true });
    const project = review(inspection).projects.find(entry => entry.id === ids.knowledge)!;
    const history = read(paths, database => database.prepare("SELECT count(*) FROM knowledge_history WHERE project_id=?").pluck().get(ids.knowledge));
    expect(project).toMatchObject({ name: "Linked knowledge", status: "active",
      inventory: { threads: 0, replies: 0, tasks: 1, memories: 0, attachments: 0, history, importBatches: 0 },
      registrations: [{ id: ids.linked, plan: true, journal: false, present: true }], remoteIdentities: [] });
    expect(project.authorityRows.knowledgeGrants.owner).toEqual({ unrevoked: 1, revoked: 0 });
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
    expect(outcomeOf(consistent, "diverging").outcome).toEqual({ projectId: ids.knowledge, basis: "accepted_binding", created: false, existing: true });
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
      // Column types without the CHECKs: integers bound from JavaScript are stored as integers, as in the real table.
      database.exec("CREATE TABLE project_mapping_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT, subject_id TEXT, subject_incarnation INTEGER, project_id TEXT, basis TEXT, plan_hash TEXT, run_receipt TEXT, recorded_at TEXT)");
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
    expect(await failure(() => inspect(paths))).toMatchObject({ code: "upgrade_mapping_malformed", details: { findings: [{ table: "projects", id: "<blob>", problem: "id is blob, expected text" }] } });
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
      database.transaction(() => { for (let index = 0; index < 8000; index++) insert.run(`remote-${index}`, "n".repeat(1024), "origin"); })();
    });
    expect((await stops(large, "upgrade_plan_bounds")).findings).toEqual([{ table: "plan", id: "bytes", problem: expect.stringContaining("exceeds") }]);
  });
});

/** The exact row comparator ({@link exact}) is shared with the authority acts' tests (`fixtures/exact-rows.ts`). */
describe("project mapping: the exact row comparator", () => {
  it("tells apart values that differ only after an embedded NUL, in a blob, in a real or in storage class, where quote() does not", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE TABLE t(x)");
      const snapshot = (expression: string) => { database.exec(`DELETE FROM t; INSERT INTO t(rowid,x) VALUES(1,${expression})`); return exact(database); };
      for (const [left, right] of [
        ["'ab'||char(0)||'cd'", "'ab'||char(0)||'XY'"], ["X'000102'", "X'000103'"], ["0.30000000000000004", "0.3"], ["1", "1.0"], ["1", "'1'"], ["'1'", "X'31'"], ["NULL", "''"],
        ["9007199254740993", "9007199254740992"],
      ]) {
        expect(snapshot(left), `${left} / ${right}`).not.toEqual(snapshot(right));
        expect(snapshot(left), left).toEqual(snapshot(left));
      }
      // The comparator it replaces: quote() cuts text at the first NUL.
      expect(database.prepare("SELECT quote('ab'||char(0)||'cd')=quote('ab'||char(0)||'XY')").pluck().get()).toBe(1);
      expect(plain(snapshot("'a\u00e9'").t["1"].x)).toBe("a\u00e9");
      expect(plain(snapshot("42").t["1"].x)).toBe(42);
    } finally { database.close(); }
  });
});
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
    const before = read(paths, exact);
    const inspection = inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }], bindings: [{ remoteIdentityId: "remote-a", registrationId: ids.linked }] });
    const created = (inspection.plan!.acts.filter(act => act.kind === "create_project").map(act => (act.payload as { projectId: string }).projectId));
    expect(created).toHaveLength(2);
    await apply(paths, inspection.planHash!);
    const after = read(paths, exact);
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
      const old = new Map<string, number>(Object.values(before.sqlite_sequence).map(row => [plain(row.name) as string, plain(row.seq) as number]));
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
      expect(entry.outcome, id!).toEqual({ projectId: project, basis: "journal_reuse", created: false, existing: true });
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
    expect(outcomeOf(inspection, ids.plain).outcome).toEqual({ projectId: nominated, basis: "journal_reuse", created: false, existing: true });
    expect(outcomeOf(inspection, newcomer).outcome).toEqual({ projectId: nominated, basis: "accepted_link", created: false, existing: true });
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
    expect(outcomeOf(decided, fixture.ids.linked).outcome).toEqual({ projectId: fixture.ids.knowledge, basis: "accepted_link", created: false, existing: true });
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
    const before = read(paths, exact);
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
    const after = read(paths, exact);
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

  /** The standard world applied and resumed, its clock then set to `value` (three attach and map acts follow). */
  async function clockAt(value: number) {
    const { paths } = standard();
    await apply(paths, inspect(paths).planHash!);
    resume(paths);
    tamper(paths, database => { database.prepare("UPDATE project_mapping_clock SET value=?").run(value); });
    return paths;
  }

  it("refuses at inspect, with nothing written, a plan whose attach and map acts the clock cannot advance for; the last value that fits plans", async () => {
    const exhausted = await clockAt(MAPPING_CLOCK_MAX - 2);
    const before = files(exhausted);
    const refusal = await failure(() => inspect(exhausted));
    expect(refusal).toMatchObject({ code: "upgrade_mapping_clock", nextStep: "upgrade inspect", committed: false,
      details: { count: 1, findings: [{ table: "project_mapping_clock", id: "1", problem: `the clock at ${MAPPING_CLOCK_MAX - 2} cannot advance 3 times (its maximum is ${MAPPING_CLOCK_MAX})` }] } });
    expect(files(exhausted)).toEqual(before);
    const fits = await clockAt(MAPPING_CLOCK_MAX - 3);
    const inspection = inspect(fits);
    expect(kinds(inspection.plan!.acts)).toEqual(["attach_registration", "attach_registration", "map_remote_identity"]);
    await apply(fits, inspection.planHash!);
    read(fits, database => expect(clock(database)).toBe(MAPPING_CLOCK_MAX));
  });

  it("refuses the same plan again at the pre-backup validation when only the clock moved since it was proposed", async () => {
    const paths = await clockAt(MAPPING_CLOCK_MAX - 3);
    const genuine = inspect(paths).plan!;
    const fencePreflight = () => maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).preflight;
    expect(fencePreflight()).toBe(genuine.base);
    tamper(paths, database => { database.prepare("UPDATE project_mapping_clock SET value=?").run(MAPPING_CLOCK_MAX - 2); });
    // The same acts and review under the new base: everything but the clock is what the proposal gives.
    const payload: UpgradePlan = { ...genuine, base: fencePreflight() };
    const hash = sha(canonicalJson(payload));
    writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }), { mode: 0o600 });
    const before = files(paths), calls: string[] = [];
    expect(await failure(() => apply(paths, hash, backups(paths, calls)))).toMatchObject({ code: "upgrade_plan_unproposed", nextStep: "upgrade inspect", committed: false,
      details: { findings: [{ table: "project_mapping_clock", problem: expect.stringContaining("cannot advance 3 times") }] } });
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(before);
  });

  it("rolls everything back when the clock is exhausted during the acts after both validations passed (the clock's CHECK is the last defence)", async () => {
    const paths = await clockAt(MAPPING_CLOCK_MAX - 3);
    const inspection = inspect(paths);
    const before = read(paths, exact);
    // Fault injection: inside the transaction, just before the first act's clock advance, the clock jumps to its maximum.
    const prepare = Database.prototype.prepare;
    let advances = 0;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      if (source === "UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1" && ++advances === 1) prepare.call(this, "UPDATE project_mapping_clock SET value=? WHERE singleton=1").run(MAPPING_CLOCK_MAX);
      return prepare.call(this, source);
    } as typeof prepare);
    expect(await failure(() => apply(paths, inspection.planHash!))).toMatchObject({ code: "upgrade_outcome_uncertain", committed: false, state: "fenced" });
    expect(advances).toBe(1);
    vi.restoreAllMocks();
    expect({ ...read(paths, exact), security_checkpoint: undefined }).toEqual({ ...before, security_checkpoint: undefined });
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

// ---------------------------------------------------------------------------
// Fix round: new destinations, names, wording, stored values, bounds, protections.

/** A schema-51 database in memory, outside any owner, for probing the pass on states ownership or the tables would refuse. */
function memory(): Database.Database {
  const database = unmanagedFixtureDatabase(":memory:");
  initializeSchema(database, undefined, current => { inspectSchema(current, TARGET); }, { target: TARGET });
  database.pragma("foreign_keys = OFF");
  return database;
}
const memoryRegistration = (database: Database.Database, id: string, name = id) => database.prepare(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, name, `/srv/${id}`, 6000 + (ports++ % 3000), "node", "[]", "/", 1000, PAST, PAST);
const memoryProject = (database: Database.Database, id: string) => database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,?,'active',1,?,?)").run(id, `Project ${id}`, PAST, PAST);
const journalRow = (database: Database.Database, kind: string, subject: string, incarnation: number, project: string, basis: string) => database.prepare(`INSERT INTO project_mapping_journal
  (subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at) VALUES(?,?,?,?,?,?,?,?)`).run(kind, subject, incarnation, project, basis, "a".repeat(64), "00000000-0000-4000-8000-000000000000", PAST);
const proposeAt51 = (database: Database.Database, decisions: Record<string, unknown> = {}) => proposeProjectMapping(database, { schemaVersion: TARGET, source: TARGET, target: TARGET }, normaliseMappingDecisions(decisions), null, true);
const incarnationOf = (database: Database.Database, table: string, id: string) => database.prepare(`SELECT incarnation FROM ${table} WHERE id=?`).pluck().get(id) as number;

describe("project mapping: subjects that join a project created in this plan", () => {
  /** One unlinked registration A and identity I bound to it (and, when asked, a second identity J bound to it). */
  const bound = (second = false) => world(w => {
    const a = w.register("A");
    w.worker("worker-a"); w.remote("I"); w.bind("worker-a", "I", a);
    if (second) { w.remote("J"); w.bind("worker-a", "J", a); }
    return { a };
  });
  const newProject = (inspection: ReturnType<typeof inspect>, id: string) => review(inspection).newProjects.find(entry => entry.id === id)!;

  for (const [name, isolate] of [["an unlinked registration", false], ["an isolated registration", true]] as const) {
    it(`maps an identity whose binding to ${name} is accepted to that registration's new project, and shows the project as new with both joiners`, async () => {
      const { paths, ids } = bound();
      const inspection = inspect(paths, { bindings: [{ remoteIdentityId: "I", registrationId: ids.a }], ...(isolate ? { isolate: { registrations: [ids.a] } } : {}) });
      const registration = outcomeOf(inspection, ids.a).outcome, identity = outcomeOf(inspection, "I").outcome;
      expect(registration).toMatchObject({ basis: "created_project", created: true, existing: false });
      expect(identity).toEqual({ projectId: registration.projectId, basis: "accepted_binding", created: false, existing: false });
      expect(review(inspection).projects).toEqual([]);
      expect(review(inspection).newProjects).toEqual([{ id: registration.projectId, name: "A", naming: "copied", sourceLength: 1, createdFor: { kind: "registration", id: ids.a },
        registrations: [ids.a], remoteIdentities: ["I"] }]);
      expect(kinds(inspection.plan!.acts)).toEqual(["create_project", "attach_registration", "map_remote_identity"]);
      const text = inspection.acts!.join("\n");
      expect(text).toContain(`Map remote identity I "Remote I" (active) to new project ${registration.projectId} (created in this plan for registration ${ids.a}): its accepted worker bindings.`);
      expect(text).toContain(`Joined in this plan by registration ${ids.a}, remote identity I.`);
      expect(text).toContain("New project: no Knowledge content and no stored grants or role bindings.");
      expect(text).not.toContain("Existing project");
      const result = await apply(paths, inspection.planHash!);
      expect(parents(paths)).toEqual({ registrations: { [ids.a]: registration.projectId }, remoteIdentities: { I: registration.projectId } });
      read(paths, database => {
        expect(journal(database).map(row => [row.subject_id, row.project_id, row.basis, row.plan_hash])).toEqual([
          [ids.a, registration.projectId, "created_project", result.planHash], ["I", registration.projectId, "accepted_binding", result.planHash]]);
        expect(database.prepare("SELECT name FROM knowledge_projects WHERE id=?").pluck().get(registration.projectId)).toBe("A");
      });
    });
  }

  it("maps two identities that accept bindings to one registration to its one new project, listing every joiner", async () => {
    const { paths, ids } = bound(true);
    const inspection = inspect(paths, { bindings: [{ remoteIdentityId: "I", registrationId: ids.a }, { remoteIdentityId: "J", registrationId: ids.a }] });
    const destination = outcomeOf(inspection, ids.a).outcome.projectId;
    for (const id of ["I", "J"]) expect(outcomeOf(inspection, id).outcome).toEqual({ projectId: destination, basis: "accepted_binding", created: false, existing: false });
    expect(newProject(inspection, destination)).toMatchObject({ createdFor: { kind: "registration", id: ids.a }, registrations: [ids.a], remoteIdentities: ["I", "J"] });
    expect(review(inspection).newProjects).toHaveLength(1);
    expect(inspection.acts!.join("\n")).toContain(`Joined in this plan by registration ${ids.a}, remote identity I, remote identity J.`);
    await apply(paths, inspection.planHash!);
    expect(new Set([...Object.values(parents(paths).registrations), ...Object.values(parents(paths).remoteIdentities)])).toEqual(new Set([destination]));
  });

  it("maps an identity that accepts bindings to two registrations reaching one existing project (an accepted link and a journal nomination), with several joiners", async () => {
    // The standard world and a second worker (one binding row per worker and identity).
    const { paths, ids } = world(w => {
      const linked = w.register("linked"), plain = w.register("plain");
      const knowledge = w.project("Linked knowledge"), lonely = w.project("Lonely knowledge");
      w.link(knowledge, linked);
      w.remote("remote-a"); w.worker("worker-a"); w.bind("worker-a", "remote-a", linked); w.worker("worker-b");
      return { linked, plain, knowledge, lonely };
    });
    await apply(paths, inspect(paths).planHash!);
    const nominated = parents(paths).registrations[ids.plain]!;
    resume(paths);
    const newcomer = randomUUID();
    tamper(paths, database => {
      database.prepare("INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(newcomer, "newcomer", `${SECRET_PATH}/newcomer`, 5997, "node", "[]", "/", 1000, PAST, PAST);
      database.prepare("INSERT INTO knowledge_project_runtime_links(knowledge_project_id,runtime_project_id,linked_at,unlinked_at) VALUES(?,?,?,NULL)").run(nominated, newcomer, PAST);
      database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES('remote-b','Remote remote-b','origin','active')").run();
      for (const [worker, registration] of [["worker-a", ids.plain], ["worker-b", newcomer]]) {
        database.prepare("INSERT INTO remote_worker_project_grants(worker_id,project_id,local_project_id,preset_ids_json,revoked_at) VALUES(?,'remote-b',?,'[]',NULL)").run(worker, registration);
      }
    });
    const inspection = inspect(paths, { links: [{ registrationId: newcomer, projectId: nominated }],
      bindings: [{ remoteIdentityId: "remote-b", registrationId: ids.plain }, { remoteIdentityId: "remote-b", registrationId: newcomer }] });
    expect(outcomeOf(inspection, ids.plain).outcome).toEqual({ projectId: nominated, basis: "journal_reuse", created: false, existing: true });
    expect(outcomeOf(inspection, newcomer).outcome).toEqual({ projectId: nominated, basis: "accepted_link", created: false, existing: true });
    expect(outcomeOf(inspection, "remote-b").outcome).toEqual({ projectId: nominated, basis: "accepted_binding", created: false, existing: true });
    const project = review(inspection).projects.find(entry => entry.id === nominated)!;
    expect(project.registrations).toEqual([{ id: ids.plain, plan: true, journal: true, present: true }, { id: newcomer, plan: true, journal: false, present: true }].sort((a, b) => (a.id < b.id ? -1 : 1)));
    expect(project.remoteIdentities).toEqual([{ id: "remote-b", plan: true, journal: false, present: true }]);
    expect(review(inspection).newProjects.map(entry => entry.id)).not.toContain(nominated);
    expect(inspection.acts!.join("\n")).toContain(`Map remote identity remote-b "Remote remote-b" (active) to existing project ${nominated}: its accepted worker bindings.`);
    await apply(paths, inspection.planHash!);
    expect(parents(paths).remoteIdentities["remote-b"]).toBe(nominated);
  });

  it("maps an identity whose only binding is revoked when that binding is accepted", async () => {
    const { paths, ids } = world(w => {
      const a = w.register("A"), knowledge = w.project("Knowledge");
      w.link(knowledge, a);
      w.worker("worker-r", "revoked"); w.remote("R"); w.bind("worker-r", "R", a, true);
      return { a, knowledge };
    });
    const inspection = inspect(paths, { links: [{ registrationId: ids.a, projectId: ids.knowledge }], bindings: [{ remoteIdentityId: "R", registrationId: ids.a }] });
    expect(outcomeOf(inspection, "R").outcome).toEqual({ projectId: ids.knowledge, basis: "accepted_binding", created: false, existing: true });
    expect((outcomeOf(inspection, "R") as MappingReview["remoteIdentities"][number]).bindings).toMatchObject([{ revoked: true, accepted: true }]);
    await apply(paths, inspection.planHash!);
    expect(parents(paths).remoteIdentities.R).toBe(ids.knowledge);
    read(paths, database => expect(database.prepare("SELECT revoked_at FROM remote_worker_project_grants").pluck().get()).toBe(PAST));
  });
});

describe("project mapping: names of created projects", () => {
  const surrogate = "\u{1F600}";
  const CASES: Array<[string, string, string, string]> = [
    ["120 characters, copied", "a".repeat(120), "a".repeat(120), "copied"],
    ["121 characters, shortened", "b".repeat(121), "b".repeat(120), "shortened"],
    ["1024 characters, shortened", "c".repeat(1024), "c".repeat(120), "shortened"],
    ["a surrogate pair across the cut, which is not split", `${"d".repeat(119)}${surrogate}tail`, "d".repeat(119), "shortened"],
    ["a surrogate pair ending at the cut, which is kept", `${"e".repeat(118)}${surrogate}tail`, `${"e".repeat(118)}${surrogate}`, "shortened"],
    ["surrounding whitespace, trimmed", "  padded\t\n", "padded", "trimmed"],
    ["whitespace that the cut exposes, trimmed again", `f${" ".repeat(130)}g`, "f", "shortened"],
  ];

  it("derives names the application could create, deterministically, from the subject's name alone", () => {
    for (const [label, source, expected, naming] of CASES) {
      expect(deriveProjectName("registration", "r-1", source), label).toEqual({ name: expected, naming });
      expect(applicationProjectName(expected), label).toBe(true);
    }
    expect(deriveProjectName("registration", "r-1", "")).toEqual({ name: "Registration r-1", naming: "replaced" });
    expect(deriveProjectName("remote_identity", "i-1", " 　\t")).toEqual({ name: "Remote identity i-1", naming: "replaced" });
    const longId = "x".repeat(160);
    expect(deriveProjectName("remote_identity", longId, "")).toEqual({ name: `Remote identity ${"x".repeat(PROJECT_NAME_LIMIT - 16)}`, naming: "replaced" });
    for (const value of ["", " a", "a ", "x".repeat(121), 7, null]) expect(applicationProjectName(value), String(value)).toBe(false);
  });

  it("creates projects whose names satisfy the application's rule and round-trip through the snapshot schema; the review says how each was derived", async () => {
    const subjects: Array<[string, string, string]> = [...CASES.map(([, source, expected, naming]) => [source, expected, naming] as [string, string, string]), ["", "", "replaced"], ["   ", "", "replaced"]];
    const { paths, ids } = world(w => Object.fromEntries(subjects.map((_entry, index) => [`s${index}`, w.register(`placeholder-${index}`)])));
    tamper(paths, database => { subjects.forEach(([source], index) => { database.prepare("UPDATE projects SET name=? WHERE id=?").run(source, ids[`s${index}`]); }); });
    tamper(paths, database => { database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES('nameless','','origin','active')").run(); });
    const inspection = inspect(paths);
    const expectedOf = (index: number) => subjects[index][1] || `Registration ${ids[`s${index}`]}`;
    subjects.forEach(([source, , naming], index) => {
      const outcome = outcomeOf(inspection, ids[`s${index}`]).outcome;
      const entry = review(inspection).newProjects.find(project => project.id === outcome.projectId)!;
      expect(entry, String(index)).toMatchObject({ naming, sourceLength: source.length, createdFor: { kind: "registration", id: ids[`s${index}`] } });
      expect((inspection.plan!.acts.find(act => act.kind === "create_project" && (act.payload as { projectId: string }).projectId === outcome.projectId)!.payload as { name: string }).name, String(index)).toBe(expectedOf(index));
    });
    const text = inspection.acts!.join("\n");
    expect(text).toContain("its name trimmed and shortened from 1024 to 120 characters");
    expect(text).toContain("its name replaced, since the registration's name is empty after trimming");
    expect(text).toContain("its name replaced, since the remote identity's name is empty after trimming");
    expect(text).toContain("its name without the surrounding whitespace");
    await apply(paths, inspection.planHash!);
    read(paths, database => {
      const after = parents(paths);
      subjects.forEach((_entry, index) => {
        const row = database.prepare("SELECT id,name,status,revision,created_at,updated_at FROM knowledge_projects WHERE id=?").get(after.registrations[ids[`s${index}`]]) as Record<string, unknown>;
        expect(row.name, String(index)).toBe(expectedOf(index));
        expect(applicationProjectName(row.name)).toBe(true);
        const snapshot = parseKnowledgeProjectSnapshot({ project: row, threads: [], replies: [], tasks: [], memories: [], relations: [], history: [], attachments: [], importSources: [], requiredPrincipals: [] });
        expect(snapshot.project).toEqual(row);
      });
      expect(database.prepare("SELECT name FROM knowledge_projects WHERE id=?").pluck().get(after.remoteIdentities.nameless)).toBe("Remote identity nameless");
    });
  });

  it("validates the name again in the act's payload and at execution", () => {
    const create = MAPPING_ACT_DOMAIN.kinds.find(entry => entry.kind === "create_project")!;
    for (const name of ["", " padded", "x".repeat(121)]) expect(create.payload.safeParse({ projectId: randomUUID(), name }).success, name).toBe(false);
    expect(create.payload.safeParse({ projectId: randomUUID(), name: "x".repeat(120) }).success).toBe(true);
    const database = memory();
    try {
      const context = { source: TARGET, target: TARGET, planHash: "a".repeat(64), receipt: randomUUID(), at: PAST };
      database.exec("BEGIN");
      expect(() => create.execute(database, { projectId: randomUUID(), name: "x".repeat(121) }, context)).toThrow(/create_project/);
      expect(() => create.execute(database, { projectId: randomUUID(), name: " padded" }, context)).toThrow(/create_project/);
      expect(database.prepare("SELECT count(*) FROM knowledge_projects").pluck().get()).toBe(0);
      database.exec("ROLLBACK");
    } finally { database.close(); }
  });
});

describe("project mapping: the operator's lines state only what is true", () => {
  it("does not say a registration avoids the project its link names when a journal nomination selects that project", async () => {
    const { paths, ids } = standard();
    await apply(paths, inspect(paths).planHash!);
    const created = parents(paths).registrations[ids.plain]!;
    resume(paths);
    tamper(paths, database => { database.prepare("INSERT INTO knowledge_project_runtime_links(knowledge_project_id,runtime_project_id,linked_at,unlinked_at) VALUES(?,?,?,NULL)").run(created, ids.plain, PAST); });
    const inspection = inspect(paths);
    const entry = outcomeOf(inspection, ids.plain) as MappingReview["registrations"][number];
    expect(entry.outcome).toEqual({ projectId: created, basis: "journal_reuse", created: false, existing: true });
    expect(entry.link).toMatchObject({ projectId: created, accepted: false });
    const lines = inspection.acts!.filter(line => line.includes(`Existing link to project ${created}`));
    expect(lines).toEqual([`  Existing link to project ${created} since ${PAST}: not accepted as the basis; the registration joins that project anyway, by another basis: the project the journal nominates.`]);
    expect(inspection.acts!.filter(line => line.includes(created)).join("\n")).not.toContain("does not join");
    // The linked registration's own link still is not followed and says so.
    expect(inspection.acts!.join("\n")).toContain("not accepted; the registration does not join that project in this plan");
  });

  it("says when a nomination not used as the basis still names the project the subject joins", async () => {
    const fixture = standard();
    await apply(fixture.paths, inspect(fixture.paths, { links: [{ registrationId: fixture.ids.linked, projectId: fixture.ids.knowledge }] }).planHash!);
    resume(fixture.paths);
    const decided = inspect(fixture.paths, { links: [{ registrationId: fixture.ids.linked, projectId: fixture.ids.knowledge }] });
    const line = decided.acts!.find(text => text.startsWith("  Journal nomination") && text.includes(`project ${fixture.ids.knowledge}`))!;
    expect(line).toContain("not used: an acceptance of a pre-existing project needs the decision again.");
    expect(line).toContain("The subject joins that project anyway, by another basis: its existing link, accepted by the operator.");
    expect(decided.acts!.join("\n")).toContain(`Existing link to project ${fixture.ids.knowledge} since ${PAST}: accepted as the basis; the registration joins that project.`);
  });

  it("words the authority counts as stored rows by their own revocation fields", () => {
    const { paths, ids } = standard();
    const inspection = inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }] });
    expect(inspection.acts!.join("\n")).toContain("row counts, not distinct principals and not effective access; a revoked principal or an expired credential is not taken into account.");
    expect(inspection.acts!.join("\n")).toContain("Knowledge grants: owner 1 unrevoked/0 revoked");
  });
});

describe("project mapping: storage classes of every value the pass reads", () => {
  it("lists every column it reads", () => {
    const listed = MAPPING_STORED_COLUMNS.flatMap(entry => entry.columns.map(([column, rule]) => `${entry.table}.${column}:${rule}`));
    expect(new Set(listed).size).toBe(listed.length);
    for (const required of ["knowledge_project_runtime_links.linked_at:text", "remote_worker_project_grants.revoked_at:text_or_null", "projects.incarnation:integer",
      "project_mapping_journal.recorded_at:text", "project_mapping_clock.value:integer", "remote_principals.kind:text", "principal_credentials.status:text"]) expect(listed).toContain(required);
  });

  /** Every listed column, one corrupted value at a time, in a table recreated without constraints (the pass itself, at 51). */
  const BAD: Readonly<Record<string, readonly string[]>> = { text: ["X'00ff'", "7", "1.5"], text_or_null: ["X'00ff'", "7"], integer: ["X'00ff'", "'1'", "1.0"] };
  const CORRUPTIONS = MAPPING_STORED_COLUMNS.flatMap(entry => entry.columns.flatMap(([column, rule]) => BAD[rule].map(value => [entry.table, column, rule, value] as const)));
  it.each(CORRUPTIONS)("refuses %s.%s (%s) holding %s", (table, column, rule, value) => {
    const database = memory();
    try {
      const columns = (database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(entry => entry.name);
      const rules = new Map(MAPPING_STORED_COLUMNS.filter(entry => entry.table === table).flatMap(entry => entry.columns.map(([name, kind]) => [name, kind] as const)));
      database.exec(`DROP TABLE "${table}"`);
      database.exec(`CREATE TABLE "${table}"(${columns.map(name => `"${name}"`).join(",")})`);
      const good = (name: string) => rules.get(name) === "integer" ? (name === "singleton" ? "1" : "0") : rules.get(name) === "text" ? "'x'" : "NULL";
      database.exec(`INSERT INTO "${table}"(${columns.map(name => `"${name}"`).join(",")}) VALUES(${columns.map(name => name === column ? value : good(name)).join(",")})`);
      const type = database.prepare(`SELECT typeof("${column}") FROM "${table}"`).pluck().get() as string;
      expect(rule === "text_or_null" ? ["text", "null"] : [rule]).not.toContain(type);
      let refusal: { code?: string; details?: { findings: Array<{ table: string; problem: string }> } } | undefined;
      try { proposeAt51(database); } catch (error) { refusal = error as typeof refusal; }
      expect(refusal?.code).toBe("upgrade_mapping_malformed");
      expect(refusal!.details!.findings).toEqual([expect.objectContaining({ table, problem: `${column} is ${type}, expected ${rule === "text_or_null" ? "text or null" : rule}` })]);
    } finally { database.close(); }
  });

  /** Through inspect, on the tables a product-built world fills: a BLOB written by raw SQL. */
  const filled = () => world(w => {
    const linked = w.register("linked"), knowledge = w.project("Knowledge");
    w.link(knowledge, linked); w.task(knowledge); w.store.devVault.commit(linked, 0, CIPHERTEXT);
    w.remote("remote-a"); w.worker("worker-a"); w.bind("worker-a", "remote-a", linked);
    return { linked, knowledge };
  });
  const INSPECTED = MAPPING_STORED_COLUMNS.filter(entry => !entry.mapped && ["projects", "remote_project_identities", "knowledge_projects", "knowledge_project_runtime_links",
    "remote_worker_project_grants", "remote_workers", "remote_principals", "dev_environment_vaults", "knowledge_history", "knowledge_project_grants", "principal_credentials", "knowledge_tasks"].includes(entry.table))
    .flatMap(entry => entry.columns.filter(([, , onlyMapped]) => !onlyMapped).map(([column]) => [entry.table, column] as const));
  it.each(INSPECTED)("refuses a BLOB in %s.%s through inspect, with no plan written and nothing changed", async (table, column) => {
    const { paths } = filled();
    try {
      tamper(paths, database => { database.pragma("foreign_keys = OFF"); database.prepare(`UPDATE "${table}" SET "${column}"=X'00ff' WHERE rowid=(SELECT min(rowid) FROM "${table}")`).run(); });
    } catch (error) {
      // A CHECK of the table refuses the value: it cannot be stored, so there is nothing to read.
      expect((error as { code?: string }).code, `${table}.${column}`).toMatch(/^SQLITE_CONSTRAINT/);
      return;
    }
    const before = files(paths);
    const refusal = await failure(() => inspect(paths));
    expect(files(paths)).toEqual(before);
    expect(existsSync(planFile(paths))).toBe(false);
    if (refusal.code === "upgrade_mapping_malformed") {
      expect(refusal.details!.findings.map(entry => entry.problem), `${table}.${column}`).toContain(`${column} is blob, expected ${MAPPING_STORED_COLUMNS.find(entry => entry.table === table)!.columns.find(([name]) => name === column)![1] === "text_or_null" ? "text or null" : "text"}`);
      return;
    }
    // Ownership's validation (foreign keys) refused the database first, generically; the pass refuses the same value itself.
    expect(refusal.name, `${table}.${column}`).not.toBe("UpgradeError");
    const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
    try {
      const direct = await failure(() => proposeProjectMapping(database, { schemaVersion: 49, source: 49, target: TARGET }, normaliseMappingDecisions({}), null, true));
      expect(direct.code).toBe("upgrade_mapping_malformed");
      expect(direct.details!.findings.map(entry => entry.problem).join(";")).toContain(`${column} is blob`);
    } finally { database.close(); }
  });

  it("refuses the reported cases: an accepted link with a BLOB linked_at, and a binding with a BLOB revoked_at", async () => {
    for (const [table, column, problem] of [["knowledge_project_runtime_links", "linked_at", "linked_at is blob, expected text"], ["remote_worker_project_grants", "revoked_at", "revoked_at is blob, expected text or null"]] as const) {
      const { paths, ids } = filled();
      tamper(paths, database => { database.prepare(`UPDATE "${table}" SET "${column}"=X'00ff'`).run(); });
      const before = files(paths);
      expect(await failure(() => inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }], bindings: [{ remoteIdentityId: "remote-a", registrationId: ids.linked }] })))
        .toMatchObject({ code: "upgrade_mapping_malformed", details: { count: 1, findings: [{ table, problem }] } });
      expect(files(paths)).toEqual(before);
    }
  });
});

describe("project mapping: bounded refusal details", () => {
  it("bounds a finding's text, samples embedded lists with the complete count, and bounds the serialised details", () => {
    const list = new FindingList();
    list.add("t".repeat(500), "id", "p".repeat(10_000));
    const [finding] = list.details().findings;
    expect([...finding.table]).toHaveLength(UPGRADE_DETAILS_LIMITS.table + 1);
    expect([...finding.problem]).toHaveLength(UPGRADE_DETAILS_LIMITS.problem + 1);
    expect(finding.problem.endsWith("…")).toBe(true);
    const database = memory();
    try {
      memoryRegistration(database, "A"); memoryProject(database, "P");
      database.transaction(() => { for (let index = 0; index < 20_000; index++) journalRow(database, "registration", "A", 1, "P", "created_project"); })();
      const refusal = (() => { try { proposeAt51(database); } catch (error) { return error as { code: string; details: { findings: Array<{ problem: string }> } }; } throw new Error("expected a refusal"); })();
      expect(refusal.code).toBe("upgrade_mapping_journal");
      expect(refusal.details.findings[0].problem).toBe("created by 20000 entries (1, 2, 3, 4, 5 and 19995 more (20000 in all))");
      expect(Buffer.byteLength(JSON.stringify(refusal.details))).toBeLessThan(1024);
    } finally { database.close(); }
  }, 30_000);

  it("cuts the findings of one refusal to its byte bound, keeping the complete count", async () => {
    const paths = installation();
    const id = (index: number) => `${"\u0001".repeat(150)}${index}`;
    tamper(paths, database => {
      for (let index = 0; index < 150; index++) {
        database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES(?,'r','origin','active')").run(id(index));
        database.prepare("INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES(?,'k','active',1,?,?)").run(id(index), PAST, PAST);
      }
    });
    const before = files(paths);
    const refusal = await failure(() => inspect(paths));
    expect(refusal).toMatchObject({ code: "upgrade_mapping_collision", details: { count: 150, truncated: true } });
    expect(refusal.details!.findings.length).toBeGreaterThan(0);
    expect(refusal.details!.findings.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(refusal.details), "utf8")).toBeLessThanOrEqual(UPGRADE_DETAILS_LIMITS.bytes);
    expect(files(paths)).toEqual(before);
  });
});

describe("project mapping: explicit null decisions", () => {
  it("refuses null before any lock, and takes undefined as no decisions", async () => {
    const paths = installation(w => { w.register("only"); });
    const before = files(paths);
    expect(await failure(() => inspect(paths, null))).toMatchObject({ code: "upgrade_decisions_invalid", nextStep: "upgrade inspect" });
    expect(() => normaliseUpgradeDecisions(null, TARGET)).toThrowError(expect.objectContaining({ code: "upgrade_decisions_invalid" }));
    expect(existsSync(paths.controllerLockPath)).toBe(false);
    expect(files(paths)).toEqual(before);
    expect(normaliseUpgradeDecisions(undefined, TARGET)).toEqual({ mapping: { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } } });
    expect(inspect(paths, undefined).decisions).toEqual(inspect(paths, {}).decisions);
  });
});

describe("project mapping: the protections, isolated", () => {
  /** A plan file with a consistent envelope hash, as an operator could hand-write it. */
  const writePlan = (paths: AppPaths, payload: unknown) => {
    const hash = sha(canonicalJson(payload));
    writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }), { mode: 0o600 });
    return hash;
  };

  it("validates the whole plan inside the transaction after the structural steps and before the first act", async () => {
    const { paths, ids } = standard();
    const inspection = inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }] });
    const events: Array<[string, boolean]> = [];
    const prepare = Database.prototype.prepare, exec = Database.prototype.exec;
    const tag = (source: string) => source.includes("CREATE TABLE project_mapping_clock") ? "step 51"
      : source.startsWith("SELECT id,name,NULL AS status,NULL AS parent") ? "proposal at 49"
        : source.startsWith("SELECT id,name,NULL AS status,parent_project_id AS parent") ? "proposal at 51"
          : source.startsWith("SELECT 1 FROM knowledge_projects WHERE id=? UNION ALL") ? "first act" : undefined;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      const name = tag(source); if (name) events.push([name, this.inTransaction]);
      return prepare.call(this, source);
    } as typeof prepare);
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, source: string) {
      const name = tag(source); if (name) events.push([name, this.inTransaction]);
      return exec.call(this, source);
    } as typeof exec);
    await apply(paths, inspection.planHash!);
    vi.restoreAllMocks();
    const order = events.filter(([name], index) => events.findIndex(([other]) => other === name) === index);
    expect(order).toEqual([["proposal at 49", false], ["step 51", true], ["proposal at 51", true], ["first act", true]]);
  });

  it("aborts the transaction with nothing applied when the database differs between the two validations", async () => {
    const { paths, ids } = standard();
    const inspection = inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }] });
    const before = read(paths, exact);
    const prepare = Database.prototype.prepare;
    let acted = false, changed = false;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      // After the structural steps, just before the in-transaction proposal reads: the accepted link's time moves.
      if (!changed && this.inTransaction && source.startsWith("SELECT id,name,NULL AS status,parent_project_id AS parent")) {
        changed = true;
        prepare.call(this, "UPDATE knowledge_project_runtime_links SET linked_at=?").run("2025-04-01T10:00:00.000Z");
      }
      if (source.startsWith("SELECT 1 FROM knowledge_projects WHERE id=? UNION ALL")) acted = true;
      return prepare.call(this, source);
    } as typeof prepare);
    expect(await failure(() => apply(paths, inspection.planHash!))).toMatchObject({ code: "upgrade_outcome_uncertain", committed: false, state: "fenced" });
    vi.restoreAllMocks();
    expect(changed).toBe(true);
    expect(acted).toBe(false);
    expect({ ...read(paths, exact), security_checkpoint: undefined }).toEqual({ ...before, security_checkpoint: undefined });
  });

  /** The review rewritten to agree with the plan's acts: what a careful forger would hand-write so that the plan reads as one coherent whole. */
  function coherent(plan: UpgradePlan): UpgradePlan {
    const review = plan.review.mapping as MappingReview;
    const payloads = (kind: string) => plan.acts.filter(act => act.kind === kind).map(act => act.payload as Record<string, string>);
    const creates = new Map(payloads("create_project").map(payload => [payload.projectId, payload.name]));
    const attaches = new Map(payloads("attach_registration").map(payload => [payload.registrationId, payload]));
    const maps = new Map(payloads("map_remote_identity").map(payload => [payload.remoteIdentityId, payload]));
    const outcome = (payload: Record<string, string>) => ({ projectId: payload.projectId, basis: payload.basis, created: payload.basis === "created_project" && creates.has(payload.projectId), existing: !creates.has(payload.projectId) });
    const sorted = (values: string[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const joined = (id: string) => ({ registrations: sorted([...attaches.values()].filter(payload => payload.projectId === id).map(payload => payload.registrationId)),
      remoteIdentities: sorted([...maps.values()].filter(payload => payload.projectId === id).map(payload => payload.remoteIdentityId)) });
    const newProjects = sorted([...creates.keys()]).map(id => {
      const own = [...attaches.values()].find(payload => payload.projectId === id && payload.basis === "created_project");
      const ownIdentity = [...maps.values()].find(payload => payload.projectId === id && payload.basis === "created_project");
      const createdFor = own ? { kind: "registration" as const, id: own.registrationId } : ownIdentity ? { kind: "remote_identity" as const, id: ownIdentity.remoteIdentityId } : { kind: "registration" as const, id: review.registrations[0].id };
      return { id, name: creates.get(id)!, naming: "copied" as const, sourceLength: creates.get(id)!.length, createdFor, ...joined(id) };
    });
    const zero = { owner: { unrevoked: 0, revoked: 0 }, human: { unrevoked: 0, revoked: 0 }, agent: { unrevoked: 0, revoked: 0 }, worker: { unrevoked: 0, revoked: 0 }, installation: { unrevoked: 0, revoked: 0 } };
    const known = new Map(review.projects.map(project => [project.id, project]));
    const members = (values: string[]) => values.map(id => ({ id, plan: true, journal: false, present: true }));
    const projects = sorted([...new Set([...attaches.values(), ...maps.values()].map(payload => payload.projectId).filter(id => !creates.has(id)))]).map(id => {
      const kept = known.get(id), { registrations, remoteIdentities } = joined(id);
      return kept ? { ...kept, registrations: members(registrations), remoteIdentities: members(remoteIdentities) } : {
        id, name: "Forged", status: "active", inventory: { threads: 0, replies: 0, tasks: 0, memories: 0, attachments: 0, history: 0, importBatches: 0 },
        registrations: members(registrations), remoteIdentities: members(remoteIdentities),
        authorityRows: { knowledgeGrants: zero, roleBindings: zero, runtimeDelegations: zero, runtimeMemberships: zero, credentialScopes: zero, workerBindings: zero, remotePrincipalGrants: zero },
      };
    });
    const mapping = {
      registrations: review.registrations.filter(row => attaches.has(row.id)).map(row => ({ ...row, outcome: outcome(attaches.get(row.id)!) })),
      remoteIdentities: review.remoteIdentities.filter(row => maps.has(row.id)).map(row => ({ ...row, outcome: outcome(maps.get(row.id)!) })),
      projects, newProjects, untouchedProjects: Math.max(0, review.untouchedProjects + review.projects.length - projects.length),
    };
    expect(MAPPING_ACT_DOMAIN.review.safeParse(mapping).success).toBe(true);
    return { ...plan, review: { mapping } };
  }
  const attachOf = (plan: UpgradePlan, id: string) => plan.acts.findIndex(act => act.kind === "attach_registration" && (act.payload as { registrationId: string }).registrationId === id);
  /** Replaces the new project ID of `subject` (a registration) in its create and attach acts. */
  const reassign = (plan: UpgradePlan, subject: string, id: string): UpgradePlan => {
    const index = attachOf(plan, subject), old = (plan.acts[index].payload as { projectId: string }).projectId;
    plan.acts = plan.acts.map(act => (act.payload as { projectId: string }).projectId === old ? { kind: act.kind, payload: { ...(act.payload as object), projectId: id } } : act);
    return plan;
  };
  type Forgery = (plan: UpgradePlan, ids: Record<string, string>) => UpgradePlan;
  /** Forged act lists with a review forged to match; `source` names where the refusal must come from: the recomputed acts, or the replay of new IDs. */
  const COHERENT: Array<[string, "acts" | "ids", Forgery]> = [
    ["an attach to a project the proposal would not choose", "ids", (plan, ids) => { plan.acts[attachOf(plan, ids.plain)] = { kind: "attach_registration", payload: { registrationId: ids.plain, projectId: ids.lonely, basis: "journal_reuse" } }; return plan; }],
    ["an attachment labelled created_project for a pre-existing project", "ids", (plan, ids) => reassign(plan, ids.plain, ids.lonely)],
    ["a created project nobody is attached to", "acts", plan => { plan.acts.unshift({ kind: "create_project", payload: { projectId: randomUUID(), name: "orphan" } }); return plan; }],
    ["a missing registration", "ids", (plan, ids) => { plan.acts.splice(attachOf(plan, ids.plain), 1); return plan; }],
    ["a duplicate attach", "acts", (plan, ids) => { plan.acts.splice(attachOf(plan, ids.plain), 0, plan.acts[attachOf(plan, ids.plain)]); return plan; }],
    ["acts out of dependency order", "acts", plan => { const creates = plan.acts.filter(act => act.kind === "create_project"); plan.acts = [...plan.acts.filter(act => act.kind !== "create_project"), ...creates]; return plan; }],
    ["duplicate generated IDs for two subjects", "ids", (plan, ids) => {
      const shared = (plan.acts[attachOf(plan, ids.linked)].payload as { projectId: string }).projectId;
      reassign(plan, ids.plain, shared);
      const first = plan.acts.findIndex(act => act.kind === "create_project" && (act.payload as { projectId: string }).projectId === shared);
      plan.acts = plan.acts.filter((act, index) => act.kind !== "create_project" || (act.payload as { projectId: string }).projectId !== shared || index === first);
      return plan;
    }],
    ["a generated ID equal to a registration's ID", "ids", (plan, ids) => reassign(plan, ids.plain, ids.linked)],
    ["a generated ID equal to a Knowledge project's ID", "ids", (plan, ids) => reassign(plan, ids.plain, ids.knowledge)],
    ["a generated ID equal to a remote identity's ID", "ids", (plan, ids) => reassign(plan, ids.plain, ids.uuidRemote)],
  ];
  it.each(COHERENT)("refuses %s, its review forged to match, for its acts and not for a stale review", async (name, source, forge) => {
    const fixture = world(w => {
      const linked = w.register("linked"), plain = w.register("plain");
      const knowledge = w.project("Linked knowledge"), lonely = w.project("Lonely knowledge");
      w.link(knowledge, linked);
      w.remote("remote-a"); w.worker("worker-a"); w.bind("worker-a", "remote-a", linked);
      const uuidRemote = w.remote(randomUUID());
      return { linked, plain, knowledge, lonely, uuidRemote };
    });
    const genuine = inspect(fixture.paths).plan!;
    const payload = coherent(forge(JSON.parse(JSON.stringify(genuine)) as UpgradePlan, fixture.ids));
    const hash = writePlan(fixture.paths, payload);
    const before = files(fixture.paths), calls: string[] = [];
    const refusal = await failure(() => apply(fixture.paths, hash, backups(fixture.paths, calls)));
    expect(refusal).toMatchObject({ code: "upgrade_plan_unproposed", nextStep: "upgrade inspect", committed: false });
    const findings = refusal.details!.findings;
    if (source === "acts") expect(findings).toContainEqual({ table: "plan", id: "acts", problem: expect.stringContaining("the acts differ") });
    else {
      // The second of two subjects sharing an ID is the one refused, whichever sorts first.
      expect(findings).toEqual([{ table: "projects", id: expect.any(String), problem: "the plan gives this subject no new project ID that is a UUID and still free" }]);
      expect(name === "duplicate generated IDs for two subjects" ? [fixture.ids.plain, fixture.ids.linked] : [fixture.ids.plain]).toContain(findings[0].id);
    }
    expect(calls).toEqual([]);
    expect(files(fixture.paths)).toEqual(before);
    // The in-transaction check alone refuses it too.
    const copy = join(temporary(), "copy.sqlite3");
    copyFileSync(fixture.paths.databasePath, copy);
    if (existsSync(`${fixture.paths.databasePath}-wal`)) copyFileSync(`${fixture.paths.databasePath}-wal`, `${copy}-wal`);
    const database = unmanagedFixtureDatabase(copy);
    try {
      expect(() => initializeSchema(database, false, current => { inspectSchema(current, TARGET); }, { target: TARGET, acts: current => validateUpgradeProposal(current, payload, TARGET) }))
        .toThrowError(expect.objectContaining({ code: "upgrade_plan_unproposed" }));
    } finally { database.close(); }
  });

  it("refuses an altered review on its own, naming the review", async () => {
    const { paths } = standard();
    const genuine = inspect(paths).plan!;
    const payload = JSON.parse(JSON.stringify(genuine)) as UpgradePlan;
    (payload.review.mapping as MappingReview).untouchedProjects += 1;
    const hash = writePlan(paths, payload);
    expect(await failure(() => apply(paths, hash))).toMatchObject({ code: "upgrade_plan_unproposed", details: { findings: [{ table: "plan", id: "review" }] } });
  });

  it("refuses a generated ID that a journal row still names although its project is gone", async () => {
    const { paths, ids } = standard();
    await apply(paths, inspect(paths).planHash!);
    const gone = parents(paths).registrations[ids.plain]!;
    resume(paths);
    tamper(paths, database => { database.prepare("DELETE FROM knowledge_projects WHERE id=?").run(gone); });
    const genuine = inspect(paths).plan!;
    expect(outcomeOf(inspect(paths), ids.plain).nomination).toMatchObject({ projectId: gone, reason: "project_missing" });
    const payload = coherent(reassign(JSON.parse(JSON.stringify(genuine)) as UpgradePlan, ids.plain, gone));
    const hash = writePlan(paths, payload);
    expect(await failure(() => apply(paths, hash))).toMatchObject({ code: "upgrade_plan_unproposed",
      details: { findings: [{ table: "projects", id: ids.plain, problem: "the plan gives this subject no new project ID that is a UUID and still free" }] } });
  });

  it("refuses decisions that name an unlinked link or a link whose registration is gone", async () => {
    for (const change of ["UPDATE knowledge_project_runtime_links SET unlinked_at=linked_at", "UPDATE knowledge_project_runtime_links SET runtime_project_id=NULL"]) {
      const { paths, ids } = standard();
      tamper(paths, database => { database.prepare(change).run(); });
      const before = files(paths);
      expect(await failure(() => inspect(paths, { links: [{ registrationId: ids.linked, projectId: ids.knowledge }] })), change).toMatchObject({ code: "upgrade_decisions_invalid",
        details: { count: 1, findings: [{ table: "decisions.links", id: ids.linked, problem: "names no current link of this registration to this project" }] } });
      expect(files(paths)).toEqual(before);
      // Without the decision the link is simply not current.
      expect((outcomeOf(inspect(paths), ids.linked) as MappingReview["registrations"][number]).link).toBeNull();
    }
  });

  it.each([
    ["the creation entry belongs to another subject", (database: Database.Database) => {
      memoryRegistration(database, "A"); memoryRegistration(database, "B"); memoryProject(database, "X");
      journalRow(database, "registration", "A", incarnationOf(database, "projects", "A"), "X", "created_project");
      journalRow(database, "registration", "B", incarnationOf(database, "projects", "B"), "X", "journal_reuse");
      return { subject: "B", reason: "provenance" };
    }],
    ["the creation entry belongs to another incarnation of the same ID", (database: Database.Database) => {
      memoryRegistration(database, "A"); memoryProject(database, "X");
      journalRow(database, "registration", "A", incarnationOf(database, "projects", "A"), "X", "created_project");
      database.prepare("DELETE FROM projects WHERE id='A'").run();
      memoryRegistration(database, "A");
      journalRow(database, "registration", "A", incarnationOf(database, "projects", "A"), "X", "journal_reuse");
      return { subject: "A", reason: "provenance" };
    }],
    ["a later accepted_link entry superseded the creation", (database: Database.Database) => {
      memoryRegistration(database, "A"); memoryProject(database, "X");
      journalRow(database, "registration", "A", incarnationOf(database, "projects", "A"), "X", "created_project");
      journalRow(database, "registration", "A", incarnationOf(database, "projects", "A"), "X", "accepted_link");
      return { subject: "A", reason: "accepted_basis" };
    }],
    ["a later accepted_binding entry superseded the creation", (database: Database.Database) => {
      database.prepare("INSERT INTO remote_project_identities(id,name,source_remote,status) VALUES('I','I','origin','active')").run();
      memoryProject(database, "X");
      journalRow(database, "remote_identity", "I", incarnationOf(database, "remote_project_identities", "I"), "X", "created_project");
      journalRow(database, "remote_identity", "I", incarnationOf(database, "remote_project_identities", "I"), "X", "accepted_binding");
      return { subject: "I", reason: "accepted_basis" };
    }],
  ] as const)("refuses a nomination when %s", (_name, build) => {
    const database = memory();
    try {
      const { subject, reason } = build(database);
      const { review: proposed } = proposeAt51(database);
      const entry = [...proposed.registrations, ...proposed.remoteIdentities].find(row => row.id === subject)!;
      expect(entry.nomination).toMatchObject({ projectId: "X", used: false, reason });
      expect(entry.outcome).toMatchObject({ basis: "created_project", created: true, existing: false });
      expect(entry.outcome.projectId).not.toBe("X");
    } finally { database.close(); }
  });

  it("reads exactly the row limit and refuses one row more, never truncating", () => {
    const database = memory();
    try {
      // The fence triggers would update the checkpoint once per row; this probe needs only the rows.
      for (const name of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='remote_workers'").pluck().all() as string[]) database.exec(`DROP TRIGGER "${name}"`);
      const insert = database.prepare("INSERT INTO remote_workers(id,principal_id,name,status) VALUES(?,?,'w','active')");
      database.transaction(() => { for (let index = 0; index < MAPPING_READ_LIMIT; index++) insert.run(`w${index}`, `p${index}`); })();
      expect(proposeAt51(database).acts).toEqual([]);
      insert.run("one-more", "p-one-more");
      expect((() => { try { proposeAt51(database); } catch (error) { return error; } throw new Error("expected a refusal"); })())
        .toMatchObject({ code: "upgrade_plan_bounds", details: { count: 1, findings: [{ table: "remote_workers", id: "remote_workers", problem: `more than ${MAPPING_READ_LIMIT} rows` }] } });
    } finally { database.close(); }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Fix round: identifiers whose stored bytes do not read back exactly.

/**
 * Gives a row an ID that is text but not UTF-8 (`CAST(x'<hex>' AS TEXT)`),
 * and every row that references it the same bytes, so that ownership's
 * foreign-key validation still passes: SQLite compares the bytes.
 */
function storeBytes(database: Database.Database, table: string, id: string, hex: string): void {
  database.pragma("foreign_keys = OFF");
  const bytes = `CAST(x'${hex}' AS TEXT)`;
  for (const name of database.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all() as string[]) {
    for (const key of database.prepare(`PRAGMA foreign_key_list("${name}")`).all() as Array<{ table: string; from: string }>) {
      if (key.table === table) database.prepare(`UPDATE "${name}" SET "${key.from}"=${bytes} WHERE "${key.from}"=?`).run(id);
    }
  }
  database.prepare(`UPDATE "${table}" SET id=${bytes} WHERE id=?`).run(id);
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  database.pragma("foreign_keys = ON");
}
/** The stored bytes and the string read back of one row's ID: different bytes, and the string, bound again, matches no row. */
function readBack(database: Database.Database, table: string, where: string): string {
  const row = database.prepare(`SELECT id,hex(id) AS bytes FROM "${table}" WHERE ${where}`).get() as { id: string; bytes: string };
  expect(Buffer.from(row.id, "utf8").toString("hex").toUpperCase()).not.toBe(row.bytes);
  expect(database.prepare(`SELECT count(*) FROM "${table}" WHERE id=?`).pluck().get(row.id)).toBe(0);
  return row.id;
}
const NOT_UTF8 = (column: string) => `${column} is not valid UTF-8 text`;
const BY_ROWID = expect.stringMatching(/^rowid \d+$/);

describe("project mapping: identifiers that do not read back exactly", () => {
  type Ids = { linked: string; plain: string; knowledge: string; lonely: string; remote: string; worker: string };
  /**
   * Each stored ID planned before this fix and then failed inside the
   * transaction, after the pending witness (a registration, a remote identity, a
   * linked Knowledge project whose link was accepted), or was matched in
   * JavaScript to rows other than its own bytes (a worker): each now refused,
   * with every reference to it, at inspect and at the validation before the backup.
   */
  /** Each case: the change, the decisions (before the change, then after it: the accepted link names the project as it reads back), the findings. */
  const CASES: ReadonlyArray<[string, (database: Database.Database, ids: Ids) => void, (ids: Ids, changed: boolean) => unknown, (ids: Ids) => Array<{ table: string; id: unknown; problem: string }>]> = [
    ["a registration's ID", (database, ids) => storeBytes(database, "projects", ids.plain, "7280"), () => undefined,
      () => [{ table: "projects", id: BY_ROWID, problem: NOT_UTF8("id") }]],
    ["a remote identity's ID", (database, ids) => storeBytes(database, "remote_project_identities", ids.remote, "6980"), () => undefined,
      () => [{ table: "remote_project_identities", id: BY_ROWID, problem: NOT_UTF8("id") }, { table: "remote_worker_project_grants", id: BY_ROWID, problem: NOT_UTF8("project_id") }]],
    ["a linked Knowledge project's ID, its link accepted", (database, ids) => storeBytes(database, "knowledge_projects", ids.knowledge, "6b80"),
      (ids, changed) => ({ links: [{ registrationId: ids.linked, projectId: changed ? "k\uFFFD" : ids.knowledge }] }),
      () => [{ table: "knowledge_projects", id: BY_ROWID, problem: NOT_UTF8("id") }, { table: "knowledge_project_runtime_links", id: BY_ROWID, problem: NOT_UTF8("knowledge_project_id") }]],
    ["an unlinked Knowledge project's ID", (database, ids) => storeBytes(database, "knowledge_projects", ids.lonely, "6c80"), () => undefined,
      () => [{ table: "knowledge_projects", id: BY_ROWID, problem: NOT_UTF8("id") }]],
    ["a worker's ID", (database, ids) => storeBytes(database, "remote_workers", ids.worker, "7780"), ids => ({ bindings: [{ remoteIdentityId: ids.remote, registrationId: ids.linked }] }),
      ids => [{ table: "remote_worker_project_grants", id: ids.remote, problem: NOT_UTF8("worker_id") }, { table: "remote_workers", id: BY_ROWID, problem: NOT_UTF8("id") }]],
  ];
  const writePlan = (paths: AppPaths, payload: unknown) => {
    const hash = sha(canonicalJson(payload));
    writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }), { mode: 0o600 });
    return hash;
  };

  it.each(CASES)("refuses %s at inspect, naming the rows and no value, with nothing written", async (_name, mutate, decisions, expected) => {
    const { paths, ids } = standard();
    tamper(paths, database => mutate(database, ids));
    const before = files(paths);
    const refusal = await failure(() => inspect(paths, decisions(ids, true)));
    expect(refusal).toMatchObject({ name: "UpgradeError", code: "upgrade_mapping_malformed", nextStep: "upgrade inspect", committed: false });
    expect(refusal.details!.findings).toEqual(expected(ids));
    expect(files(paths)).toEqual(before);
    expect(before.plan).toBe("missing");
  });

  it.each(CASES)("refuses a plan written before %s stops reading back, at the validation before the backup, with nothing changed", async (_name, mutate, decisions, expected) => {
    const { paths, ids } = standard();
    const genuine = inspect(paths, decisions(ids, false)).plan!;
    tamper(paths, database => mutate(database, ids));
    // The plan as inspect wrote it, rebased on the changed database so that only the validation can refuse it.
    const hash = writePlan(paths, { ...genuine, base: maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).preflight });
    const before = files(paths), calls: string[] = [];
    const refusal = await failure(() => apply(paths, hash, backups(paths, calls)));
    expect(refusal).toMatchObject({ code: "upgrade_plan_unproposed", nextStep: "upgrade inspect", committed: false });
    expect(refusal.details!.findings).toEqual(expected(ids));
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(before);
  });

  it("shows why: the string read back is other bytes, and matches no row when bound again", () => {
    const { paths, ids } = standard();
    tamper(paths, database => { storeBytes(database, "projects", ids.plain, "7280"); storeBytes(database, "knowledge_projects", ids.knowledge, "6b80"); });
    read(paths, database => {
      expect(readBack(database, "projects", "hex(id)='7280'")).toBe("r\uFFFD");
      expect(readBack(database, "knowledge_projects", "hex(id)='6B80'")).toBe("k\uFFFD");
    });
  });

  it("plans a registration and a project whose IDs hold U+FFFD as their own UTF-8, which read back exactly", () => {
    const { paths, ids } = standard();
    tamper(paths, database => { storeBytes(database, "projects", ids.plain, "72efbfbd"); storeBytes(database, "knowledge_projects", ids.knowledge, "6befbfbd"); });
    const plan = inspect(paths, { links: [{ registrationId: ids.linked, projectId: "k\uFFFD" }] }).plan!;
    expect(plan.acts).toEqual(expect.arrayContaining([
      { kind: "attach_registration", payload: { registrationId: "r\uFFFD", projectId: expect.any(String), basis: "created_project" } },
      { kind: "attach_registration", payload: { registrationId: ids.linked, projectId: "k\uFFFD", basis: "accepted_link" } },
    ]));
  });

  /** A journal row naming its subject or project by bytes that do not read back, written after a completed upgrade and a resume. */
  async function journaled(column: "subject_id" | "project_id") {
    const { paths, ids } = standard();
    await apply(paths, inspect(paths).planHash!);
    const created = parents(paths).registrations[ids.plain]!;
    resume(paths);
    const journalWith = (database: Database.Database) => {
      const row = database.prepare("SELECT subject_incarnation AS incarnation,plan_hash,run_receipt,recorded_at FROM project_mapping_journal WHERE subject_id=?").get(ids.plain) as Record<string, string | number>;
      // Bytes that read back as the subject's or the project's own ID followed by U+FFFD: before this fix the row was
      // compared as that string, while its stored bytes name neither the subject nor the project.
      const invalid = (id: string) => `CAST(x'${Buffer.from(id, "utf8").toString("hex")}80' AS TEXT)`;
      const subject = column === "subject_id" ? invalid(ids.plain) : `'${ids.plain}'`, project = column === "project_id" ? invalid(created) : `'${created}'`;
      database.prepare(`INSERT INTO project_mapping_journal(subject_kind,subject_id,subject_incarnation,project_id,basis,plan_hash,run_receipt,recorded_at)
        VALUES('registration',${subject},?,${project},'journal_reuse',?,?,?)`).run(row.incarnation, row.plan_hash, row.run_receipt, row.recorded_at);
    };
    return { paths, ids, journalWith };
  }
  it.each(["subject_id", "project_id"] as const)("refuses a journal row whose %s does not read back, at inspect and at the validation before the backup", async column => {
    const { paths, ids, journalWith } = await journaled(column);
    const genuine = inspect(paths).plan!;
    tamper(paths, journalWith);
    const expected = [{ table: "project_mapping_journal", id: column === "subject_id" ? BY_ROWID : ids.plain, problem: NOT_UTF8(column) }];
    const before = files(paths);
    const refusal = await failure(() => inspect(paths));
    expect(refusal).toMatchObject({ code: "upgrade_mapping_malformed", nextStep: "upgrade inspect", committed: false });
    expect(refusal.details!.findings).toEqual(expected);
    expect(files(paths)).toEqual(before);
    const hash = writePlan(paths, { ...genuine, base: maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).preflight });
    const written = files(paths), calls: string[] = [];
    const late = await failure(() => apply(paths, hash, backups(paths, calls)));
    expect(late).toMatchObject({ code: "upgrade_plan_unproposed", nextStep: "upgrade inspect", committed: false });
    expect(late.details!.findings).toEqual(expected);
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(written);
  });

  // References whose bytes match no row: ownership's foreign-key validation refuses the database first, so the pass is called directly.
  it.each([
    ["a link's registration", "knowledge_project_runtime_links", "runtime_project_id", (ids: Ids) => ids.knowledge, "knowledge_project_runtime_links", (ids: Ids) => ids.knowledge],
    ["a binding's registration", "remote_worker_project_grants", "local_project_id", (ids: Ids) => ids.remote, "remote_worker_project_grants", (ids: Ids) => ids.remote],
    ["a binding's remote identity", "remote_worker_project_grants", "project_id", (ids: Ids) => ids.remote, "remote_worker_project_grants", () => BY_ROWID],
    ["a binding's worker", "remote_worker_project_grants", "worker_id", (ids: Ids) => ids.remote, "remote_worker_project_grants", (ids: Ids) => ids.remote],
  ] as const)("refuses %s that does not read back in its own pass, when called directly", async (_name, table, column, key, findingTable, findingId) => {
    const { paths, ids } = standard();
    const keyColumn = table === "knowledge_project_runtime_links" ? "knowledge_project_id" : "project_id";
    tamper(paths, database => {
      database.pragma("foreign_keys = OFF");
      database.prepare(`UPDATE ${table} SET ${column}=CAST(CAST(${column} AS BLOB) || x'80' AS TEXT) WHERE ${keyColumn}=?`).run(key(ids));
    });
    const before = files(paths);
    expect(() => inspect(paths)).toThrow(/foreign key check failed/);
    expect(files(paths)).toEqual(before);
    const database = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
    try {
      const refusal = await failure(() => proposeProjectMapping(database, { schemaVersion: 49, source: 49, target: TARGET }, normaliseMappingDecisions({}), null, true));
      expect(refusal).toMatchObject({ code: "upgrade_mapping_malformed", details: { count: 1, findings: [{ table: findingTable, id: findingId(ids), problem: NOT_UTF8(column) }] } });
    } finally { database.close(); }
  });

  it("refuses a parent that does not read back in its own pass, before the parent itself is refused (ownership refuses a parent naming no project first)", async () => {
    const database = memory();
    try {
      memoryRegistration(database, "A"); memoryProject(database, "X");
      database.exec("UPDATE project_mapping_clock SET value=value+1");
      database.exec("UPDATE projects SET parent_project_id=CAST(x'5880' AS TEXT),mapping_version=(SELECT value FROM project_mapping_clock) WHERE id='A'");
      expect(await failure(() => proposeAt51(database))).toMatchObject({ code: "upgrade_mapping_malformed",
        details: { count: 1, findings: [{ table: "projects", id: "A", problem: NOT_UTF8("parent_project_id") }] } });
    } finally { database.close(); }
  });

  it("lists the identifiers it requires to read back exactly", () => {
    expect(MAPPING_TEXT_COLUMNS.map(entry => [entry.table, [...entry.columns]])).toEqual([
      ["projects", ["id", "parent_project_id"]], ["remote_project_identities", ["id", "parent_project_id"]], ["knowledge_projects", ["id"]],
      ["knowledge_project_runtime_links", ["knowledge_project_id", "runtime_project_id"]], ["remote_worker_project_grants", ["worker_id", "project_id", "local_project_id"]],
      ["remote_workers", ["id"]], ["project_mapping_journal", ["subject_id", "project_id"]],
    ]);
  });
});
