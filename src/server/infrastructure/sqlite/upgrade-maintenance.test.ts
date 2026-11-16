import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { maintainSecurityFence } from "../../bootstrap/security-maintenance";
import { AuthenticationService } from "../../modules/authentication";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { openStoreAt49 } from "./fixtures/released-schema";
import { OwnedSqliteDatabase, ReopenedDatabaseChangedError } from "./owned-database";
import { getOwnedRestoreStatus, restoreRoot } from "./restore-recovery";
import { SecurityFence, SecurityFenceError, securityFenceBinding, securityFenceRoot, securityRecoveryBoundary } from "./security-fence";
import { establishSqliteSecurityFence, maintainSqliteSecurityFence } from "./security-maintenance";
import { configureDurability, validateDatabase } from "./database-validation";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { hashFile, parseManifest, readBoundedJson, validateBackup, BACKUP_LIMITS } from "./backup-validation";
import { UPGRADE_MARKER_VERSION, upgradeMarkerChecksum, upgradeMarkerMigration } from "./upgrade-marker-migration";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup, type UpgradeBackupSource } from "./upgrade-maintenance";
import { takeBoundBackup } from "./backup-binding";
import {
  canonicalJson, describeUpgradeActs, executeUpgradeActs, normaliseUpgradeDecisions, parseUpgradePlan, proposeUpgrade, readUpgradePlan, structuralSteps,
  UPGRADE_ACT_DOMAINS, UPGRADE_PLAN_LIMITS, upgradePlanHash, upgradePlanPath, upgradePlanRoot, validateUpgradeProposal, writeUpgradePlan,
  type UpgradeActDomain, type UpgradePlan,
} from "./upgrade-plan";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));

// Step 50 exactly: plans, steps and marker states asserted here are the marker step's.
// The upgrade to step 51 is covered in mapping-structure-migration.test.ts.
const TARGET = UPGRADE_MARKER_VERSION;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const temporary = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
/** The canonical database path the owner and the fence use. */
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");
const witnessPath = (paths: AppPaths) => join(securityFenceRoot(canonical(paths)), "witness.json");
const witness = (paths: AppPaths) => JSON.parse(readFileSync(witnessPath(paths), "utf8")).payload as Record<string, unknown> & { format: number; state: string; upgrade?: { receipt: string; plan: string; at: string } };
const planFile = (paths: AppPaths) => upgradePlanPath(canonical(paths));
const read = <T,>(paths: AppPaths, operation: (db: Database.Database) => T) => { const db = unmanagedFixtureDatabase(paths.databasePath, { readonly: true }); try { return operation(db); } finally { db.close(); } };
const marker = (db: Database.Database) => db.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_marker'").get()
  ? db.prepare("SELECT state,plan_hash FROM upgrade_marker").all() : "absent";
const all = (db: Database.Database) => ({ catalogue: db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
  rows: Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").pluck().all() as string[]).map(name => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])) });
/**
 * Names each generated value by its kind and order of first appearance, across
 * the database and the witness of one installation: the same value in two
 * places gets the same name, so relationships between identifiers compare.
 */
const aliases = () => {
  const names = new Map<string, string>(), counts = new Map<string, number>();
  return (kind: string, value: unknown) => {
    if (value === null || typeof value !== "string") return value;
    let name = names.get(value);
    if (!name) { const count = (counts.get(kind) ?? 0) + 1; counts.set(kind, count); name = `${kind}#${count}`; names.set(value, name); }
    return name;
  };
};
type Alias = ReturnType<typeof aliases>;
/** A timestamp column: only a canonical ISO time is replaced, anything else stays visible. */
const time = (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) ? "<time>" : value;
/** Audit details: this run's receipt and plan hash are named; every other field is exact. */
const details = (value: unknown, alias: Alias) => {
  if (typeof value !== "string") return value;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return { ...parsed, ...("receipt" in parsed ? { receipt: alias("receipt", parsed.receipt) } : {}), ...("plan" in parsed ? { plan: alias("plan", parsed.plan) } : {}) };
};
/**
 * The only columns that legitimately differ between two installations taken
 * through the same operator steps: timestamps, this run's receipts and plan
 * hashes, and the checkpoint's random installation and epoch. Every other
 * column of every table, and the catalogue, compare exactly.
 */
const NORMALISED: Readonly<Record<string, Readonly<Record<string, (value: unknown, alias: Alias) => unknown>>>> = {
  schema_migrations: { applied_at: time },
  controller_settings: { updated_at: time },
  controller_audit_events: { created_at: time, details_json: details },
  security_checkpoint: { installation: (value, alias) => alias("installation", value), epoch: (value, alias) => alias("epoch", value) },
  upgrade_marker: { changed_at: time, plan_hash: (value, alias) => alias("plan", value) },
};
const normal = (db: Database.Database, alias: Alias) => {
  const { catalogue, rows } = all(db);
  return { catalogue, rows: Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, (list as Array<Record<string, unknown>>)
    .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, NORMALISED[name]?.[key] ? NORMALISED[name][key](value, alias) : value])))])) };
};
/**
 * The database and WAL bytes, the witness and the plan file: what a refusal must leave unchanged.
 * SQLite's read-only open of a WAL database creates an empty WAL when none exists; an empty WAL
 * holds no frames, so a missing and an empty WAL are the same database state.
 */
const files = (paths: AppPaths) => {
  const optional = (path: string) => existsSync(path) ? sha(readFileSync(path)) : "missing";
  const wal = `${paths.databasePath}-wal`;
  return { database: optional(paths.databasePath), wal: !existsSync(wal) || lstatSync(wal).size === 0 ? "empty" : optional(wal), witness: existsSync(witnessPath(paths)) ? readFileSync(witnessPath(paths), "utf8") : "missing",
    plan: existsSync(planFile(paths)) ? readFileSync(planFile(paths), "utf8") : "missing" };
};
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
const fenceInspect = (paths: AppPaths) => maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET);
const resume = (paths: AppPaths) => maintainSqliteSecurityFence(paths, { action: "resume", expect: fenceInspect(paths).preflight, mode: "token" }, HANDOFF, TARGET);
const inspect = (paths: AppPaths) => inspectSqliteUpgrade(paths, TARGET);

/** A schema-49 snapshot through the Backup API, as createControllerBackup writes it but at a schema ceiling of 50. */
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
/**
 * The composition's backup: createControllerBackup for a schema-49 source (it
 * recognises nothing above the supported version), the same layout otherwise.
 */
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
    const { name, code, nextStep, committed, state } = error as { name: string; code: string; nextStep: string; committed: boolean; state?: string };
    return { name, code, nextStep, committed, state };
  }
  throw new Error("expected a refusal");
}

/** A schema-49 installation with a confirmed witness and no authority changes beyond the store's own: upgrade needed. */
function installation(token = false) {
  const root = temporary("upgrade-49-");
  const paths = resolveAppPaths(join(root, "data"));
  const store = openStoreAt49(paths.databasePath);
  try { if (token) new AuthenticationService(store).generateToken("local-cli"); } finally { store.close(); }
  return paths;
}
/** Step 50 with a pending marker and a trusted fence, reached as an operator reaches it: resume at the target. */
function pending50() {
  const paths = installation();
  rmSync(witnessPath(paths));
  expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
  return paths;
}
/** A fresh installation initialised at step 50: marker complete without a plan hash, witness confirmed. */
function fresh50() {
  const root = temporary("upgrade-fresh-");
  const paths = resolveAppPaths(join(root, "data")); mkdirSync(paths.dataDirectory, { mode: 0o700 });
  const db = new Database(paths.databasePath);
  try {
    chmodSync(paths.databasePath, 0o600); configureDurability(db);
    initializeSchema(db, true, current => { inspectSchema(current, TARGET); }, { target: TARGET });
    SecurityFence.attach(canonical(paths), db, true);
  } finally { db.close(); }
  return paths;
}
/** A schema-40 installation that never had a fence. */
function preFence() {
  const root = temporary("upgrade-40-");
  const paths = resolveAppPaths(join(root, "data")); mkdirSync(paths.dataDirectory, { mode: 0o700 });
  const db = unmanagedFixtureDatabase(paths.databasePath);
  try { db.exec(readFileSync(new URL("./fixtures/schema-v40.sql", import.meta.url), "utf8")); } finally { db.close(); }
  chmodSync(paths.databasePath, 0o600);
  return paths;
}
/** Replaces the witness with a mutated, self-consistent record. */
function rewriteWitness(paths: AppPaths, mutate: (payload: Record<string, unknown>) => void) {
  const payload = witness(paths); mutate(payload);
  writeFileSync(witnessPath(paths), JSON.stringify({ payload, sha256: sha(JSON.stringify(payload)) }));
}
/** A supported restore, acknowledged by resume: a confirmed witness with a recovery receipt. */
async function restored() {
  const root = temporary("upgrade-restore-");
  const paths = resolveAppPaths(join(root, "data")), backup = join(root, "restore-source");
  const store = openStoreAt49(paths.databasePath);
  try {
    await createControllerBackup(store, backup, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory });
    new AuthenticationService(store).generateToken("local-cli");
  } finally { store.close(); }
  restoreControllerBackup(backup, paths.databasePath);
  return { paths, acknowledge: () => maintainSecurityFence(paths, { action: "resume", expect: maintainSecurityFence(paths, { action: "inspect" }).preflight, mode: "token" }) };
}

describe("explicit offline upgrade: state recognition", () => {
  it.each([
    ["schema 49, trusted", () => installation(), { state: "upgrade_needed", nextStep: "upgrade apply", schemaVersion: 49, marker: "absent", appliedPlan: null }],
    ["step 50 pending, trusted", () => pending50(), { state: "upgrade_needed", nextStep: "upgrade apply", schemaVersion: 50, marker: "pending", appliedPlan: null }],
    ["step 50 complete (fresh)", () => fresh50(), { state: "current", nextStep: "none", schemaVersion: 50, marker: "complete", appliedPlan: null }],
    ["pre-fence schema 40", () => preFence(), { state: "pre_fence", nextStep: "auth fence establish", schemaVersion: 40, marker: "absent" }],
    ["a pending witness", () => { const paths = installation(); rewriteWitness(paths, payload => { payload.state = "pending"; }); return paths; }, { state: "fenced", nextStep: "auth fence resume", schemaVersion: 49 }],
    ["a witness missing on fenced data", () => { const paths = installation(); rmSync(witnessPath(paths)); return paths; }, { state: "fenced", nextStep: "auth fence resume", schemaVersion: 49 }],
  ] as const)("recognises %s and writes a plan only when an upgrade is needed", (_name, build, expected) => {
    const paths = build(), before = files(paths);
    const status = inspect(paths);
    expect(status).toMatchObject({ ...expected, target: TARGET, preflight: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Read-only on the database and the witness.
    expect({ ...files(paths), plan: "ignored", wal: "ignored" }).toEqual({ ...before, plan: "ignored", wal: "ignored" });
    if (expected.state === "upgrade_needed") {
      expect(status.planHash).toMatch(/^[0-9a-f]{64}$/);
      expect(readUpgradePlan(canonical(paths))).toEqual({ plan: status.plan, hash: status.planHash });
      expect(status.plan).toMatchObject({ source: expected.schemaVersion, target: TARGET, acts: [] });
      expect(status.acts).toEqual([]);
    } else {
      expect(status.plan).toBeUndefined();
      expect(existsSync(planFile(paths))).toBe(false);
    }
  });

  it("trusts a confirmed witness that carries a recovery receipt, and fences an unacknowledged restore", async () => {
    const { paths, acknowledge } = await restored();
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
    expect(existsSync(planFile(paths))).toBe(false);
    expect(acknowledge()).toMatchObject({ trusted: true, quarantined: true });
    expect(witness(paths)).toMatchObject({ format: 1, state: "confirmed", receipt: expect.any(String), recoveredAt: expect.any(String), restore: expect.any(String) });
    expect(inspect(paths)).toMatchObject({ state: "upgrade_needed", schemaVersion: 49, marker: "absent" });
    expect(existsSync(planFile(paths))).toBe(true);
  });
});

describe("explicit offline upgrade: inspect", () => {
  it("writes the plan with exactly its fields, a stable hash over the canonical payload, and private permissions", () => {
    const paths = installation(), path = canonical(paths);
    const first = inspect(paths), second = inspect(paths);
    expect(second.planHash).toBe(first.planHash);
    expect(first.plan).toEqual({
      kind: "worktree-control/upgrade-plan", format: 2, binding: securityFenceBinding(path),
      installation: read(paths, db => db.prepare("SELECT installation FROM security_checkpoint").pluck().get()), base: first.preflight,
      source: 49, target: 50, steps: [{ version: 50, name: upgradeMarkerMigration.name, checksum: upgradeMarkerChecksum }], decisions: {}, acts: [], review: {},
    });
    expect(first.planHash).toBe(sha(canonicalJson(first.plan)));
    expect(first.planHash).toBe(upgradePlanHash(first.plan!));
    const stored = JSON.parse(readFileSync(planFile(paths), "utf8"));
    expect(stored).toEqual({ payload: first.plan, sha256: first.planHash });
    expect(upgradePlanRoot(path)).toBe(`${path}.upgrade`);
    expect(lstatSync(upgradePlanRoot(path)).mode & 0o777).toBe(0o700);
    expect(lstatSync(planFile(paths)).mode & 0o777).toBe(0o600);
    expect(lstatSync(planFile(paths)).uid).toBe(process.getuid!());
    // The fence's own directory holds nothing new.
    expect(fs.readdirSync(securityFenceRoot(path))).toEqual(["witness.json"]);
  });

  it("replaces the plan on a new inspect and changes the hash only when the content changed", () => {
    const paths = installation(true);
    const first = inspect(paths);
    expect(inspect(paths).planHash).toBe(first.planHash);
    const store = openStoreAt49(paths.databasePath);
    try { new AuthenticationService(store).rotateToken("local-cli"); } finally { store.close(); }
    const second = inspect(paths);
    expect(second.planHash).not.toBe(first.planHash);
    expect(second.plan).toEqual({ ...first.plan, base: second.preflight });
    expect(readUpgradePlan(canonical(paths)).hash).toBe(second.planHash);
  });

  it("reaps leftover temporaries of an interrupted write and refuses links and unknown entries", () => {
    const paths = installation(), root = upgradePlanRoot(canonical(paths));
    const first = inspect(paths);
    const leftovers = Array.from({ length: 3 }, () => join(root, `.journal-${randomUUID()}`));
    for (const leftover of leftovers) writeFileSync(leftover, "{\"partial\":", { mode: 0o600 });
    expect(inspect(paths).planHash).toBe(first.planHash);
    expect(leftovers.some(leftover => existsSync(leftover))).toBe(false);
    // A link is never followed or removed, and neither is its target.
    const target = join(paths.dataDirectory, "..", "preserve"); writeFileSync(target, "preserve", { mode: 0o600 });
    const alias = join(root, `.journal-${randomUUID()}`); symlinkSync(target, alias);
    expect(() => inspect(paths)).toThrowError(expect.objectContaining({ code: "upgrade_plan_storage" }));
    expect(readFileSync(target, "utf8")).toBe("preserve"); expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    rmSync(alias);
    writeFileSync(join(root, "other.json"), "{}", { mode: 0o600 });
    expect(() => inspect(paths)).toThrowError(expect.objectContaining({ code: "upgrade_plan_storage" }));
    rmSync(join(root, "other.json"));
    // A linked plan is not followed: inspect refuses to replace it and apply refuses to read it.
    rmSync(planFile(paths)); symlinkSync(target, planFile(paths));
    expect(() => inspect(paths)).toThrowError(expect.objectContaining({ code: "upgrade_plan_storage" }));
    expect(() => readUpgradePlan(canonical(paths))).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    expect(readFileSync(target, "utf8")).toBe("preserve");
  });

  it("refuses a plan at target 50 that contains an act or decisions: the first act domain (mapping) starts at 51", async () => {
    // Since C3a the authority domain follows the mapping domain, from 52.
    expect(UPGRADE_ACT_DOMAINS.map(domain => [domain.name, domain.minimumTarget])).toEqual([["mapping", 51], ["authority", 52]]);
    const paths = installation(), status = inspect(paths);
    const mapping = { kind: "attach_registration", payload: { registrationId: "r", projectId: "p", basis: "created_project" } };
    for (const payload of [{ ...status.plan!, acts: [{ kind: "fixture.note", payload: {} }] }, { ...status.plan!, acts: [mapping] },
      { ...status.plan!, decisions: { mapping: { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } } } }]) {
      expect(() => parseUpgradePlan(payload)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      expect(() => writeUpgradePlan(canonical(paths), payload)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      const hash = upgradePlanHash(payload);
      writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }));
      const before = files(paths);
      expect(await failure(() => apply(paths, hash))).toMatchObject({ code: "upgrade_plan_invalid", nextStep: "upgrade inspect", committed: false });
      expect(files(paths)).toEqual(before);
    }
  });
});

describe("explicit offline upgrade: plan and act mechanism", () => {
  const plan = (acts: UpgradePlan["acts"] = []): UpgradePlan => ({ kind: "worktree-control/upgrade-plan", format: 2, binding: "a".repeat(64), installation: "b".repeat(64), base: "c".repeat(64),
    source: 49, target: 50, steps: structuralSteps(49, 50), decisions: {}, acts, review: {} });
  it("serialises canonically and refuses values without one spelling", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], "é": { z: 0, y: -1 } })).toBe('{"a":[true,null,"x"],"b":1,"é":{"y":-1,"z":0}}');
    for (const value of [1.5, -0, Number.MAX_SAFE_INTEGER + 1, Number.NaN, undefined, { a: undefined }, new Map(), new Date(0)]) {
      expect(() => canonicalJson(value), String(value)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    }
    // Key order does not change the hash; every field does.
    const reordered = Object.fromEntries(Object.entries(plan()).reverse()) as unknown as UpgradePlan;
    expect(upgradePlanHash(reordered)).toBe(upgradePlanHash(plan()));
    for (const change of [{ base: "d".repeat(64) }, { binding: "d".repeat(64) }, { installation: "d".repeat(64) }, { source: 50, steps: [] }, { steps: [{ version: 50, name: "x", checksum: "0".repeat(64) }] }]) {
      expect(upgradePlanHash({ ...plan(), ...change })).not.toBe(upgradePlanHash(plan()));
    }
    // Every index is visited: a hole is refused, not skipped as Array.prototype.map would.
    const late: unknown[] = ["a"]; late[2] = "c";
    for (const value of [late, new Array(2), { a: new Array(1) }, [[1], late], [undefined]]) {
      expect(() => canonicalJson(value)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    }
    expect(canonicalJson(["a", null, "c"])).toBe('["a",null,"c"]');
    expect(() => upgradePlanHash({ ...plan(), acts: new Array(1) as UpgradePlan["acts"] })).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    expect(structuralSteps(50, 50)).toEqual([]);
    expect(() => structuralSteps(48, 50)).toThrowError(expect.objectContaining({ code: "upgrade_step_mismatch" }));
    // Step 51 is a known structural step since C2a and step 52 since C3a; a step above the highest known one is not.
    expect(structuralSteps(49, 51).map(step => step.version)).toEqual([50, 51]);
    expect(structuralSteps(49, 52).map(step => step.version)).toEqual([50, 51, 52]);
    expect(() => structuralSteps(49, 53)).toThrowError(expect.objectContaining({ code: "upgrade_step_mismatch" }));
  });
  it("lets a registered domain propose, validate, execute and describe acts in order, every act, decision and review covered by the hash", () => {
    const executed: string[] = [];
    const note: UpgradeActDomain<{ names: string[] }, { count: number }> = {
      name: "fixture", minimumTarget: 50, decisionKeys: ["names"],
      decisions: z.object({ names: z.array(z.string().max(16)) }).strict(),
      review: z.object({ count: z.number().int() }).strict(),
      kinds: [{ kind: "fixture.note", payload: z.object({ name: z.string().max(16) }).strict(), execute: (_database, payload) => { executed.push((payload as { name: string }).name); } }],
      normalise: input => ({ names: [...((input.names as string[] | undefined) ?? ["b", "a"])] }),
      propose: (_database, _context, decisions) => ({ acts: decisions.names.map(name => ({ kind: "fixture.note", payload: { name } })), review: { count: decisions.names.length } }),
      describe: (acts, review) => [...acts.map(act => `note ${(act.payload as { name: string }).name}`), `${review.count} notes`],
    };
    const domains = [note] as unknown as ReadonlyArray<UpgradeActDomain>;
    const database = new Database(":memory:");
    try {
      const decisions = normaliseUpgradeDecisions({}, 50, domains);
      expect(decisions).toEqual({ fixture: { names: ["b", "a"] } });
      expect(() => normaliseUpgradeDecisions({ other: 1 }, 50, domains)).toThrowError(expect.objectContaining({ code: "upgrade_decisions_invalid" }));
      const proposal = proposeUpgrade(database, { schemaVersion: 49, source: 49, target: 50 }, decisions, null, true, domains);
      expect(proposal.acts).toEqual([{ kind: "fixture.note", payload: { name: "b" } }, { kind: "fixture.note", payload: { name: "a" } }]);
      const parsed = parseUpgradePlan({ ...plan(proposal.acts), decisions, review: proposal.review }, domains);
      expect(describeUpgradeActs(parsed, domains)).toEqual(["note b", "note a", "2 notes"]);
      expect(() => validateUpgradeProposal(database, parsed, 49, domains)).not.toThrow();
      // A plan the proposal does not give, with valid shape, is refused by the validation.
      for (const altered of [{ ...parsed, acts: [...parsed.acts].reverse() }, { ...parsed, review: { fixture: { count: 3 } } }]) {
        expect(() => validateUpgradeProposal(database, altered, 49, domains)).toThrowError(expect.objectContaining({ code: "upgrade_plan_unproposed" }));
      }
      const context = { source: 49, target: 50, planHash: "0".repeat(64), receipt: "00000000-0000-4000-8000-000000000000", at: new Date(0).toISOString() };
      expect(() => executeUpgradeActs(database, parsed, context, domains)).toThrow(/inside the schema transaction/);
      database.transaction(() => executeUpgradeActs(database, parsed, context, domains))();
      expect(executed).toEqual(["b", "a"]);
      // Order, payload, kind, decisions and review are all part of the hash.
      expect(upgradePlanHash({ ...parsed, acts: [...parsed.acts].reverse() })).not.toBe(upgradePlanHash(parsed));
      expect(upgradePlanHash({ ...parsed, acts: [parsed.acts[0], { kind: "fixture.note", payload: { name: "c" } }] })).not.toBe(upgradePlanHash(parsed));
      expect(upgradePlanHash({ ...parsed, decisions: { fixture: { names: ["a"] } } })).not.toBe(upgradePlanHash(parsed));
      expect(upgradePlanHash({ ...parsed, review: { fixture: { count: 1 } } })).not.toBe(upgradePlanHash(parsed));
      // Strict payloads; unknown kinds; a domain's sections required exactly at its targets; the default registry refuses the fixture's act.
      for (const invalid of [[{ kind: "fixture.note", payload: { name: "a", extra: 1 } }], [{ kind: "fixture.other", payload: {} }], [{ kind: "fixture.note", payload: { name: "a" }, extra: 1 }]]) {
        expect(() => parseUpgradePlan({ ...parsed, acts: invalid as UpgradePlan["acts"] }, domains)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      }
      for (const invalid of [{ ...parsed, decisions: {} }, { ...parsed, review: {} }, { ...parsed, target: 49 }]) {
        expect(() => parseUpgradePlan(invalid, domains)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      }
      expect(() => parseUpgradePlan(plan(proposal.acts))).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      expect(UPGRADE_PLAN_LIMITS).toMatchObject({ bytes: 8 * 1024 * 1024, acts: 50_000 });
      expect(UPGRADE_PLAN_LIMITS.bytes).toBe(BACKUP_LIMITS.manifestBytes);
    } finally { database.close(); }
  });
  it("refuses a plan file that is oversized, not private, of another format, with an unknown field, duplicate keys or a wrong envelope hash", () => {
    const paths = installation(), path = canonical(paths), status = inspect(paths), good = readFileSync(planFile(paths), "utf8");
    const variants: Array<[string, () => void]> = [
      ["oversized", () => writeFileSync(planFile(paths), " ".repeat(UPGRADE_PLAN_LIMITS.bytes + 1))],
      ["readable by others", () => chmodSync(planFile(paths), 0o644)],
      ["the old format", () => { const payload = { ...status.plan!, format: 1 }; writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: sha(canonicalJson(payload)) })); }],
      ["another format", () => { const payload = { ...status.plan!, format: 3 }; writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: sha(canonicalJson(payload)) })); }],
      ["an unknown field", () => { const payload = { ...status.plan!, extra: 1 }; writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: sha(canonicalJson(payload)) })); }],
      ["duplicate keys", () => writeFileSync(planFile(paths), good.replace('{"payload":', `{"sha256":"${status.planHash}","payload":`))],
      ["a wrong envelope hash", () => writeFileSync(planFile(paths), good.replace(status.planHash!, "0".repeat(64)))],
      ["an altered byte", () => writeFileSync(planFile(paths), good.replace(status.plan!.base, status.plan!.base.replace(/^./, c => c === "0" ? "1" : "0")))],
      ["not JSON", () => writeFileSync(planFile(paths), "{")],
    ];
    for (const [name, mutate] of variants) {
      writeFileSync(planFile(paths), good); chmodSync(planFile(paths), 0o600);
      mutate();
      expect(() => readUpgradePlan(path), name).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    }
    rmSync(planFile(paths));
    expect(() => readUpgradePlan(path)).toThrowError(expect.objectContaining({ code: "upgrade_plan_missing" }));
  });
});

describe("explicit offline upgrade: apply refusals change nothing", () => {
  /** Runs the refusal and requires the files and the backup directory unchanged. */
  async function refused(paths: AppPaths, operation: (calls: string[]) => Promise<unknown> | unknown) {
    const before = files(paths), calls: string[] = [];
    const result = await failure(() => operation(calls));
    expect(files(paths)).toEqual(before);
    return { result, calls };
  }
  it("refuses a missing, altered, replaced or foreign plan and a wrong --expect", async () => {
    const paths = installation(true), twin = installation();
    const noted = inspect(paths).planHash!;
    expect((await refused(paths, () => apply(paths, "0".repeat(64)))).result).toMatchObject({ code: "upgrade_plan_mismatch", nextStep: "upgrade inspect", committed: false });
    expect(await failure(() => applySqliteUpgrade(paths, { expect: "NOT-A-HASH" }, backups(paths), TARGET))).toMatchObject({ code: "upgrade_invalid_input" });
    // Altered consistently (another hash), and altered without a matching envelope.
    const altered = { ...readUpgradePlan(canonical(paths)).plan, base: "0".repeat(64) };
    writeFileSync(planFile(paths), JSON.stringify({ payload: altered, sha256: upgradePlanHash(altered) }));
    expect((await refused(paths, () => apply(paths, noted))).result).toMatchObject({ code: "upgrade_plan_mismatch" });
    writeFileSync(planFile(paths), JSON.stringify({ payload: altered, sha256: noted }));
    expect((await refused(paths, () => apply(paths, noted))).result).toMatchObject({ code: "upgrade_plan_invalid" });
    rmSync(planFile(paths));
    expect((await refused(paths, () => apply(paths, noted))).result).toMatchObject({ code: "upgrade_plan_missing", nextStep: "upgrade inspect" });
    // Replaced by a second inspect after the hash was noted (the database changed in between).
    expect(inspect(paths).planHash).toBe(noted);
    const store = openStoreAt49(paths.databasePath);
    try { new AuthenticationService(store).rotateToken("local-cli"); } finally { store.close(); }
    const replaced = inspect(paths).planHash!;
    expect(replaced).not.toBe(noted);
    expect((await refused(paths, () => apply(paths, noted))).result).toMatchObject({ code: "upgrade_plan_mismatch" });
    // Another database's plan, named by its own hash.
    const foreign = inspect(twin).planHash!;
    writeFileSync(planFile(paths), readFileSync(planFile(twin)));
    const { result, calls } = await refused(paths, calls => apply(paths, foreign, backups(paths, calls)));
    expect(result).toMatchObject({ code: "upgrade_plan_foreign", nextStep: "upgrade inspect" });
    expect(calls).toEqual([]);
  });

  it("refuses a base changed by an ordinary owned write after inspect", async () => {
    const paths = installation(true);
    const noted = inspect(paths).planHash!, plan = files(paths).plan;
    const store = openStoreAt49(paths.databasePath);
    try { new AuthenticationService(store).rotateToken("local-cli"); } finally { store.close(); }
    // Still trusted and still needing the upgrade; only the base moved.
    expect(files(paths).plan).toBe(plan);
    const { result, calls } = await refused(paths, calls => apply(paths, noted, backups(paths, calls)));
    expect(result).toMatchObject({ code: "upgrade_base_changed", nextStep: "upgrade inspect", committed: false });
    expect(calls).toEqual([]);
    expect(inspect(paths)).toMatchObject({ state: "upgrade_needed" });
    expect(readUpgradePlan(canonical(paths)).hash).not.toBe(noted);
  });

  it("refuses the base changed by a raw file change between inspect and apply", async () => {
    const paths = installation();
    const noted = inspect(paths).planHash!;
    const bytes = readFileSync(paths.databasePath); bytes.writeUInt32BE((bytes.readUInt32BE(24) + 7) >>> 0, 24); writeFileSync(paths.databasePath, bytes);
    const { result, calls } = await refused(paths, calls => apply(paths, noted, backups(paths, calls)));
    expect(result).toMatchObject({ code: "upgrade_base_changed", committed: false });
    expect(calls).toEqual([]);
  });

  it("refuses a plan whose step checksum differs from the code's", async () => {
    const paths = installation(), status = inspect(paths);
    const changed = { ...status.plan!, steps: [{ ...status.plan!.steps[0], checksum: "0".repeat(64) }] };
    const hash = writeUpgradePlan(canonical(paths), changed);
    expect((await refused(paths, () => apply(paths, hash))).result).toMatchObject({ code: "upgrade_step_mismatch", nextStep: "upgrade inspect" });
    const renamed = writeUpgradePlan(canonical(paths), { ...status.plan!, steps: [{ ...status.plan!.steps[0], name: "other-step" }] });
    expect((await refused(paths, () => apply(paths, renamed))).result).toMatchObject({ code: "upgrade_step_mismatch" });
    const skipped = writeUpgradePlan(canonical(paths), { ...status.plan!, source: 50, steps: [] });
    expect((await refused(paths, () => apply(paths, skipped))).result).toMatchObject({ code: "upgrade_step_mismatch" });
  });

  it.each([
    ["pre-fence", () => preFence(), { state: "pre_fence", nextStep: "auth fence establish" }],
    ["a pending witness", () => { const paths = installation(); rewriteWitness(paths, payload => { payload.state = "pending"; }); return paths; }, { state: "fenced", nextStep: "auth fence resume" }],
    ["a missing witness", () => { const paths = installation(); rmSync(witnessPath(paths)); return paths; }, { state: "fenced", nextStep: "auth fence resume" }],
    ["current without a recorded plan", () => fresh50(), { state: "current", nextStep: "none" }],
  ] as const)("refuses %s with the operator's next step", async (_name, build, expected) => {
    const paths = build();
    const { result, calls } = await refused(paths, calls => apply(paths, "a".repeat(64), backups(paths, calls)));
    expect(result).toEqual({ name: "UpgradeError", code: "upgrade_wrong_state", committed: false, ...expected });
    expect(calls).toEqual([]);
  });

  it("refuses an owner continuity mismatch before reading the plan", async () => {
    const paths = installation(), noted = inspect(paths).planHash!;
    vi.spyOn(SecurityFence, "assertOwnerContinuity").mockImplementation(() => { throw new SecurityFenceError("security_fence_recovery_required"); });
    const { result, calls } = await refused(paths, calls => apply(paths, noted, backups(paths, calls)));
    expect(result).toMatchObject({ code: "upgrade_owner_changed", nextStep: "auth fence resume", committed: false });
    expect(calls).toEqual([]);
  });

  it("aborts with nothing changed when the backup fails or does not validate", async () => {
    const paths = installation(), noted = inspect(paths).planHash!;
    const throwing: UpgradeBackup = async () => { throw new Error("fixture backup fault"); };
    expect((await refused(paths, () => apply(paths, noted, throwing))).result).toMatchObject({ code: "upgrade_backup_failed", nextStep: "upgrade apply", committed: false });
    const corrupt: UpgradeBackup = async (source, context) => {
      const created = await backups(paths)(source, context);
      writeFileSync(join(created.root, "state.sqlite3"), Buffer.concat([readFileSync(join(created.root, "state.sqlite3")), Buffer.alloc(1)]));
      return created;
    };
    expect((await refused(paths, () => apply(paths, noted, corrupt))).result).toMatchObject({ code: "upgrade_backup_failed" });
    const other: UpgradeBackup = async (source, context) => {
      const created = await backups(paths)(source, context);
      return { ...created, manifest: { ...(created.manifest as Record<string, unknown>), applicationVersion: "other" } };
    };
    expect((await refused(paths, () => apply(paths, noted, other))).result).toMatchObject({ code: "upgrade_backup_failed" });
    // The same plan still applies afterwards.
    expect(await apply(paths, noted)).toMatchObject({ alreadyApplied: false, planHash: noted });
  });

  /** A valid backup tree of an installation, written through ordinary ownership before the upgrade runs. */
  async function priorBackup(paths: AppPaths) {
    const owner = new OwnedSqliteDatabase(paths.databasePath), destination = join(paths.dataDirectory, "..", `prior-${randomUUID()}`);
    try { return { root: destination, manifest: await createControllerBackup(owner, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) }; }
    finally { owner.close(); }
  }
  /** Takes this run's snapshot into a scratch file, then returns another tree. */
  const substitute = (tree: { root: string; manifest: unknown }): UpgradeBackup => async source => {
    await source.backup(join(temporary("upgrade-scratch-"), "snapshot.sqlite3"));
    return tree;
  };
  it("accepts only a backup of this source made by this run's single snapshot", async () => {
    const paths = installation(true), twin = installation(true);
    // (a) A valid backup of another database.
    const foreign = await priorBackup(twin);
    // (b) A valid older backup of this database, then a further authority write.
    const older = await priorBackup(paths);
    const store = openStoreAt49(paths.databasePath);
    try { new AuthenticationService(store).rotateToken("local-cli"); } finally { store.close(); }
    const noted = inspect(paths).planHash!;
    // (c) A valid current backup of this database that the run did not take.
    const current = await priorBackup(paths);
    expect(() => validateBackup(current.root, parseManifest(current.manifest), true)).not.toThrow();
    const variants: Array<[string, UpgradeBackup]> = [
      ["another database", substitute(foreign)],
      ["an older backup of this database", substitute(older)],
      ["a tree without calling backup", async () => current],
      ["a tree after calling backup twice", async (source, context) => {
        const first = await backups(paths)(source, context);
        await expect(backups(paths)(source, context)).rejects.toThrow();
        return first;
      }],
      // This run's snapshot file, overwritten in place (same device and inode) with the
      // older backup's bytes and a manifest that matches them: only the checkpoint tells.
      ["this run's snapshot file holding an older state", async (source, context) => {
        const created = await backups(paths)(source, context);
        const file = join(created.root, "state.sqlite3");
        writeFileSync(file, readFileSync(join(older.root, "state.sqlite3")));
        const manifest = { ...(created.manifest as { database: Record<string, unknown> }), database: { ...(created.manifest as { database: Record<string, unknown> }).database, ...hashFile(file) } };
        writeFileSync(join(created.root, "manifest.json"), JSON.stringify(manifest));
        expect(() => validateBackup(created.root, parseManifest(manifest), true)).not.toThrow();
        return { root: created.root, manifest };
      }],
      ["a snapshot left running when the callback returned", async source => {
        void source.backup(join(temporary("upgrade-scratch-"), "snapshot.sqlite3"));
        return current;
      }],
    ];
    for (const [name, backup] of variants) {
      const { result } = await refused(paths, () => apply(paths, noted, backup));
      expect(result, name).toMatchObject({ code: "upgrade_backup_failed", nextStep: "upgrade apply", committed: false });
    }
    // The run's own backup, through createControllerBackup, is accepted.
    const result = await apply(paths, noted);
    expect(result).toMatchObject({ alreadyApplied: false, planHash: noted });
    expect(parseManifest(readBoundedJson(join(result.backup!, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET).database.schemaVersion).toBe(49);
  });

  /**
   * This run's own tree, with its snapshot written straight into the tree's
   * database file and a manifest made before the snapshot finished: the bytes it
   * will have are those of a reference copy taken first, through another
   * read-only connection to the same unchanged source, into a new empty file as
   * the snapshot is (two Backup API copies of an unchanged database are
   * byte-identical). The file keeps the bytes the Backup API writes (no
   * journal-mode switch, which needs the finished file). With `wait` false the
   * callback returns while its snapshot is still running; `observed` records the
   * root and whether the snapshot had completed when the callback returned.
   */
  const ownTree = (wait: boolean, observed: { root?: string; completedAtReturn?: boolean } = {}): UpgradeBackup => async (source, context) => {
    const root = join(temporary("upgrade-own-"), "backup"), file = join(root, "state.sqlite3");
    const reference = join(temporary("upgrade-reference-"), "reference.sqlite3"); closeSync(openSync(reference, "wx", 0o600));
    const live = unmanagedFixtureDatabase(context.database, { readonly: true, fileMustExist: true });
    try { await live.backup(reference); } finally { live.close(); }
    mkdirSync(join(root, "attachments"), { recursive: true, mode: 0o700 });
    const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(), database: { file: "state.sqlite3", ...hashFile(reference), schemaVersion: context.schemaVersion }, attachments: [] };
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    closeSync(openSync(file, "wx", 0o600));
    let completed = false;
    const snapshot = source.backup(file).then(() => { completed = true; });
    if (wait) await snapshot; else snapshot.catch(() => undefined);
    observed.root = root; observed.completedAtReturn = completed;
    return { root, manifest };
  };
  it("refuses this run's own tree whose snapshot was still running when the callback returned, by the completion guard alone", async () => {
    // The variant above returns a tree unrelated to its snapshot, which the file
    // identity check refuses too. Here the tree is the one the snapshot is
    // written into, so only the completion guard tells.
    const paths = installation(true), noted = inspect(paths).planHash!, content = read(paths, all);
    const unfinished: { root?: string; completedAtReturn?: boolean } = {};
    const { result } = await refused(paths, () => apply(paths, noted, ownTree(false, unfinished)));
    expect(result).toMatchObject({ code: "upgrade_backup_failed", nextStep: "upgrade apply", committed: false });
    expect(unfinished.completedAtReturn).toBe(false);
    // The refusal drained the copy before refusing: the refused tree is now
    // complete and passes every later check. Its file is the one the snapshot
    // was written into; its stored manifest is the returned one and validates
    // at the target ceiling; the copy holds the source's schema version, its
    // content and its checkpoint.
    const root = unfinished.root!, manifest = parseManifest(readBoundedJson(join(root, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET);
    expect(manifest.database).toMatchObject({ schemaVersion: 49, ...hashFile(join(root, "state.sqlite3")) });
    expect(() => validateBackup(root, manifest, true, TARGET)).not.toThrow();
    const copy = new Database(join(root, "state.sqlite3"), { readonly: true, fileMustExist: true });
    try { expect(inspectSchema(copy, TARGET).version).toBe(49); expect(all(copy)).toEqual(content); } finally { copy.close(); }
    // The helper itself refuses with the completion guard's message. The
    // callback took exactly one snapshot and it completed, so of the guard's
    // three conditions only "still running when the callback returned" holds.
    const owner = new OwnedSqliteDatabase(paths.databasePath, false, TARGET);
    try {
      const direct: { root?: string; completedAtReturn?: boolean } = {}, waited: { root?: string; completedAtReturn?: boolean } = {};
      await expect(takeBoundBackup(owner, owner.canonicalPath, owner.inspection.version, TARGET, ownTree(false, direct))).rejects.toThrow("The backup is not this run's single completed snapshot.");
      expect(direct.completedAtReturn).toBe(false);
      expect(() => validateBackup(direct.root!, parseManifest(readBoundedJson(join(direct.root!, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET), true, TARGET)).not.toThrow();
      // The same callback, waiting for its snapshot, is accepted.
      expect(await takeBoundBackup(owner, owner.canonicalPath, owner.inspection.version, TARGET, ownTree(true, waited))).toBe(waited.root);
      expect(waited.completedAtReturn).toBe(true);
    } finally { owner.close(); }
    // And applies the same plan.
    const waited: { root?: string; completedAtReturn?: boolean } = {};
    expect(await apply(paths, noted, ownTree(true, waited))).toMatchObject({ alreadyApplied: false, planHash: noted, backup: waited.root });
    expect(waited.completedAtReturn).toBe(true);
  });

  it("refuses as base changed a raw change to the database made while the backup callback runs, with nothing written", async () => {
    // The callback runs under both singleton locks, so no cooperating owner can
    // write; what remains is a write outside them, here a raw change of the file.
    const paths = installation(), noted = inspect(paths).planHash!;
    let changed: ReturnType<typeof files> | undefined;
    const result = await failure(() => apply(paths, noted, async (source, context) => {
      const created = await backups(paths)(source, context);
      const bytes = readFileSync(paths.databasePath); bytes.writeUInt32BE((bytes.readUInt32BE(24) + 7) >>> 0, 24); writeFileSync(paths.databasePath, bytes);
      changed = files(paths);
      return created;
    }));
    expect(result).toMatchObject({ code: "upgrade_base_changed", nextStep: "upgrade inspect", committed: false });
    expect(files(paths)).toEqual(changed);
    expect(witness(paths)).toMatchObject({ format: 1, state: "confirmed" });
    expect(read(paths, db => inspectSchema(db, TARGET).version)).toBe(49);
  });

  it("refuses inspect and apply over an interrupted restore without recovering or normalising anything; auth fence inspect completes it", async () => {
    const root = temporary("upgrade-restore-interrupted-");
    const paths = resolveAppPaths(join(root, "data")), backup = join(root, "restore-source");
    const store = openStoreAt49(paths.databasePath);
    try {
      await createControllerBackup(store, backup, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory });
      new AuthenticationService(store).generateToken("local-cli");
    } finally { store.close(); }
    const noted = inspect(paths).planHash!, path = canonical(paths), attachments = join(realpathSync(paths.dataDirectory), "knowledge-attachments");
    mkdirSync(attachments, { recursive: true, mode: 0o700 }); writeFileSync(join(attachments, "retained"), "old bytes", { mode: 0o600 });
    // Interrupt the restore at its first move: the journal is written, nothing is moved yet.
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === join(restoreRoot(path), "previous", "0")) throw Object.assign(new Error("fixture restore interruption"), { code: "EIO" });
      rename(from, to);
    });
    expect(() => restoreControllerBackup(backup, paths.databasePath)).toThrow("fixture restore interruption");
    vi.restoreAllMocks();
    expect(getOwnedRestoreStatus(path)?.state).toBe("prepared");
    // A mode ordinary ownership would normalise.
    chmodSync(path, 0o640);
    /** Kind, bytes and mode of a file, or of every entry of a tree. */
    const image = (target: string): unknown => {
      const entry = (file: string) => { const stat = lstatSync(file); return stat.isFile() ? `${sha(readFileSync(file))}:${(stat.mode & 0o777).toString(8)}` : stat.isDirectory() ? `directory:${(stat.mode & 0o777).toString(8)}` : "other"; };
      if (!existsSync(target)) return "missing";
      if (!lstatSync(target).isDirectory()) return entry(target);
      return Object.fromEntries((fs.readdirSync(target, { recursive: true, encoding: "utf8" }) as string[]).sort().map(name => [name, entry(join(target, name))]));
    };
    const state = () => ({ database: image(path), wal: image(`${path}-wal`), shm: image(`${path}-shm`), attachments: image(attachments), restore: image(restoreRoot(path)),
      witness: image(witnessPath(paths)), plan: image(planFile(paths)) });
    const before = state();
    expect(before.plan).not.toBe("missing");
    expect(before.restore).toHaveProperty(["journal.json"]);
    const refusal = { name: "UpgradeError", code: "upgrade_restore_unfinished", nextStep: "auth fence inspect", committed: false, state: "fenced" };
    expect(await failure(() => inspect(paths))).toEqual(refusal);
    expect(state()).toEqual(before);
    const calls: string[] = [];
    expect(await failure(() => apply(paths, noted, backups(paths, calls)))).toEqual(refusal);
    expect(calls).toEqual([]);
    expect(state()).toEqual(before);
    expect(getOwnedRestoreStatus(path)?.state).toBe("prepared");
    // The step the refusal names completes the restore (its ownership recovers it)
    // and reports the restored database as fenced, for the resume that follows.
    expect(fenceInspect(paths)).toMatchObject({ trusted: false });
    expect(getOwnedRestoreStatus(path)?.state).toBe("verified");
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
  });
});

/** Everything a completed upgrade must show. */
function assertUpgraded(paths: AppPaths, result: Awaited<ReturnType<typeof apply>>, previous: { receipt: unknown; recoveredAt: unknown; restore: unknown }) {
  expect(result).toMatchObject({ state: "current", alreadyApplied: false, planHash: expect.stringMatching(/^[0-9a-f]{64}$/), receipt: expect.any(String), planRemoved: true, schemaVersion: 50 });
  read(paths, db => {
    expect(inspectSchema(db, TARGET)).toEqual({ version: 50, fresh: false });
    expect(() => validateDatabase(db, TARGET)).not.toThrow();
    expect(marker(db)).toEqual([{ state: "complete", plan_hash: result.planHash }]);
    const events = db.prepare("SELECT details_json FROM controller_audit_events WHERE event_type='authentication.upgrade_applied' ORDER BY id").pluck().all() as string[];
    expect(JSON.parse(events.at(-1)!)).toEqual({ receipt: result.receipt, plan: result.planHash, source: expect.any(Number), target: 50 });
  });
  expect(witness(paths)).toMatchObject({ format: 2, state: "confirmed", ...previous, upgrade: { receipt: result.receipt, plan: result.planHash, at: expect.any(String) } });
  expect(existsSync(planFile(paths))).toBe(false);
  const manifest = parseManifest(readBoundedJson(join(result.backup!, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET);
  expect(() => validateBackup(result.backup!, manifest, true, TARGET)).not.toThrow();
  expect(inspect(paths)).toMatchObject({ state: "current", nextStep: "none", marker: "complete", appliedPlan: result.planHash });
  expect(fenceInspect(paths)).toMatchObject({ trusted: true });
}
const recovery = (paths: AppPaths) => { const { receipt, recoveredAt, restore } = witness(paths); return { receipt, recoveredAt, restore }; };

describe("explicit offline upgrade: apply", () => {
  it("upgrades schema 49 to step 50 with the plan, a validated backup and a confirmed witness carrying the upgrade receipt", async () => {
    const paths = installation(true), previous = recovery(paths);
    const status = inspect(paths);
    const result = await apply(paths, status.planHash!);
    assertUpgraded(paths, result, previous);
    expect(read(paths, db => (JSON.parse(db.prepare("SELECT details_json FROM controller_audit_events WHERE event_type='authentication.upgrade_applied'").pluck().get() as string)).source)).toBe(49);
    expect(parseManifest(readBoundedJson(join(result.backup!, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET).database.schemaVersion).toBe(49);
    // The upgrade quarantines nothing: the token stays valid in the data.
    expect(read(paths, db => JSON.parse(db.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").pluck().get() as string).token)).not.toBeNull();
  });

  it("upgrades a step-50 pending database and leaves the earlier recovery receipt untouched", async () => {
    const paths = pending50(), previous = recovery(paths);
    expect(previous).toMatchObject({ receipt: expect.any(String), recoveredAt: expect.any(String) });
    const status = inspect(paths);
    expect(status.plan).toMatchObject({ source: 50, steps: [] });
    const result = await apply(paths, status.planHash!);
    assertUpgraded(paths, result, previous);
  });

  it("keeps an acknowledged restore's receipt and the recovery boundary exactly", async () => {
    const { paths, acknowledge } = await restored();
    acknowledge();
    const previous = recovery(paths), boundary = securityRecoveryBoundary(paths.databasePath);
    expect(boundary).toMatchObject({ receipt: previous.receipt, createdAt: previous.recoveredAt, restore: previous.restore });
    const result = await apply(paths, inspect(paths).planHash!);
    assertUpgraded(paths, result, previous);
    expect(securityRecoveryBoundary(paths.databasePath)).toEqual(boundary);
  });

  it("answers a repeated apply as already applied and refuses another --expect", async () => {
    const paths = installation(), noted = inspect(paths).planHash!;
    const first = await apply(paths, noted);
    const before = files(paths), calls: string[] = [];
    expect(await apply(paths, noted, backups(paths, calls))).toEqual({ state: "current", alreadyApplied: true, planHash: noted, receipt: null, backup: null, planRemoved: true, schemaVersion: 50 });
    expect(calls).toEqual([]);
    expect(files(paths)).toEqual(before);
    expect(await failure(() => apply(paths, "a".repeat(64)))).toEqual({ name: "UpgradeError", code: "upgrade_wrong_state", nextStep: "none", committed: false, state: "current" });
    expect(files(paths)).toEqual(before);
    expect(first.receipt).not.toBeNull();
  });

  it("needs the upgrade again after a resume: the marker becomes pending without a plan hash, and a new apply has a new receipt", async () => {
    const paths = installation(true);
    const first = await apply(paths, inspect(paths).planHash!);
    rmSync(witnessPath(paths));
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
    expect(read(paths, marker)).toEqual([{ state: "pending", plan_hash: null }]);
    expect(witness(paths)).toMatchObject({ format: 1, state: "confirmed" });
    expect(witness(paths).upgrade).toBeUndefined();
    const status = inspect(paths), previous = recovery(paths);
    expect(status).toMatchObject({ state: "upgrade_needed", marker: "pending", plan: { source: 50, steps: [] } });
    const second = await apply(paths, status.planHash!);
    assertUpgraded(paths, second, previous);
    expect(second.receipt).not.toBe(first.receipt);
    expect(second.planHash).not.toBe(first.planHash);
  });
});

describe("explicit offline upgrade: interrupted apply", () => {
  /**
   * The final state the operator's recovery must reach, for comparison with an
   * uninterrupted twin: the database (see NORMALISED) and the witness, whose
   * generated values share names with the database's, so its installation,
   * epoch, receipts and plan must be the ones the rows carry.
   */
  const final = (paths: AppPaths) => {
    const alias = aliases(), database = read(paths, db => normal(db, alias)), path = canonical(paths), stat = lstatSync(path);
    const { format, binding, installation, epoch, state, file, policy, owner, restore, receipt, recoveredAt, upgrade } = witness(paths);
    return { database, witness: { format, state, policy, owner,
      binding: binding === securityFenceBinding(path) ? "<this database>" : binding,
      file: JSON.stringify(file) === JSON.stringify({ device: stat.dev, inode: stat.ino }) ? "<this file>" : file,
      installation: alias("installation", installation), epoch: alias("epoch", epoch), restore: alias("restore", restore), receipt: alias("receipt", receipt), recoveredAt: time(recoveredAt),
      upgrade: upgrade ? { receipt: alias("receipt", upgrade.receipt), plan: alias("plan", upgrade.plan), at: time(upgrade.at) } : upgrade } };
  };
  const auditFault = () => {
    let injected = false;
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      if (source.startsWith("INSERT INTO controller_audit_events") && source.includes("'authentication.upgrade_applied'")) { injected = true; throw new Error("fixture audit fault"); }
      return prepare.call(this, source);
    } as typeof prepare);
    return () => injected;
  };
  const postCommitFault = () => {
    let injected = false;
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      const result = pragma.call(this, source, options);
      // initializeSchema's finally fails AFTER the one transaction committed the upgrade.
      if (!injected && source === "foreign_keys = ON" && !this.inTransaction && this.prepare("SELECT 1 FROM controller_audit_events WHERE event_type='authentication.upgrade_applied'").get()) {
        injected = true; throw new Error("fixture post-commit fault");
      }
      return result;
    });
    return () => injected;
  };
  /**
   * A fault inside the witness publication of the given record state: at its
   * rename (nothing replaced) or at the directory sync after it (replaced, not
   * durable). The pending record of an upgrade is format 2.
   */
  const witnessFault = (paths: AppPaths, state: "pending" | "confirmed", stage: "rename" | "sync") => {
    let injected = false, published: string | undefined;
    const sync = fs.fsyncSync, rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const payload = String(to) === witnessPath(paths) ? JSON.parse(readFileSync(String(from), "utf8")).payload as { state: string; format: number } : undefined;
      const target = payload?.state === state && (state === "confirmed" || payload.format === 2);
      if (target && stage === "rename" && !injected) { injected = true; throw Object.assign(new Error("fixture rename fault"), { code: "EIO" }); }
      rename(from, to); if (payload) published = target ? state : undefined;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      // The directory sync that would make the rename durable.
      if (stage === "sync" && !injected && published === state && fs.realpathSync(`/proc/self/fd/${fd}`) === securityFenceRoot(canonical(paths))) {
        injected = true; throw Object.assign(new Error("fixture fsync fault"), { code: "EIO" });
      }
      sync(fd);
    });
    return () => injected;
  };
  const confirmedFsyncFault = (paths: AppPaths) => witnessFault(paths, "confirmed", "sync");
  /** The uninterrupted run with the same operator steps as the recovery: `resume` first when the fault needs it. */
  async function twin(resumed: "none" | "before" | "after") {
    const paths = installation();
    if (resumed === "before") { rmSync(witnessPath(paths)); resume(paths); }
    await apply(paths, inspect(paths).planHash!);
    if (resumed === "after") { rmSync(witnessPath(paths)); resume(paths); await apply(paths, inspect(paths).planHash!); }
    return final(paths);
  }

  it("before the pending witness: database and witness unchanged, and the same plan applies on retry", async () => {
    const paths = installation(), noted = inspect(paths).planHash!, before = files(paths);
    vi.spyOn(SecurityFence, "beginUpgrade");
    expect(await failure(() => apply(paths, noted, async () => { throw new Error("fixture backup fault"); }))).toMatchObject({ code: "upgrade_backup_failed", committed: false, nextStep: "upgrade apply" });
    expect(SecurityFence.beginUpgrade).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(files(paths)).toEqual(before);
    const result = await apply(paths, noted);
    assertUpgraded(paths, result, recovery(paths));
    expect(final(paths)).toEqual(await twin("none"));
  });

  it("after the pending witness, before the SQL commit: database unchanged, witness pending; resume, then inspect and apply succeed", async () => {
    const paths = installation(), noted = inspect(paths).planHash!, before = read(paths, all), plan = files(paths).plan;
    const injected = auditFault();
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed: false, state: "fenced" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    expect(read(paths, all)).toEqual(before);
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    expect(files(paths).plan).toBe(plan);
    const fenced = files(paths);
    expect(await failure(() => apply(paths, noted))).toMatchObject({ code: "upgrade_wrong_state", nextStep: "auth fence resume", state: "fenced" });
    expect(files(paths)).toEqual(fenced);
    expect(inspect(paths)).toMatchObject({ state: "fenced" });
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
    expect(read(paths, marker)).toEqual([{ state: "pending", plan_hash: null }]);
    assertUpgraded(paths, await apply(paths, inspect(paths).planHash!), recovery(paths));
    expect(final(paths)).toEqual(await twin("before"));
  });

  it.each([["after the SQL commit, before the confirmed witness", "post-commit"], ["confirmed witness written but not durable", "fsync"]] as const)
  ("%s: upgraded, witness pending, reported committed; resume makes the marker pending, and inspect and apply succeed", async (_name, stage) => {
    const paths = installation(), noted = inspect(paths).planHash!, plan = files(paths).plan;
    expect(plan).not.toBe("missing");
    const injected = stage === "post-commit" ? postCommitFault() : confirmedFsyncFault(paths);
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed: true, state: "fenced" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    read(paths, db => { expect(inspectSchema(db, TARGET).version).toBe(50); expect(marker(db)).toEqual([{ state: "complete", plan_hash: noted }]); });
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    // The plan is removed only after the confirmed witness is durable.
    expect(files(paths).plan).toBe(plan);
    const fenced = files(paths);
    expect(await failure(() => apply(paths, noted))).toMatchObject({ code: "upgrade_wrong_state", nextStep: "auth fence resume", state: "fenced" });
    expect(files(paths)).toEqual(fenced);
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
    expect(read(paths, marker)).toEqual([{ state: "pending", plan_hash: null }]);
    const status = inspect(paths);
    expect(status).toMatchObject({ state: "upgrade_needed", plan: { source: 50, steps: [] } });
    assertUpgraded(paths, await apply(paths, status.planHash!), recovery(paths));
    expect(final(paths)).toEqual(await twin("after"));
  });

  it.each([["in the transaction, rolled back", "audit", false], ["after the SQL commit", "post-commit", true]] as const)
  ("from a step-50 pending source, a fault %s is reported with committed=%s from the audit event alone", async (_name, stage, committed) => {
    const paths = pending50(), noted = inspect(paths).planHash!, before = read(paths, all), plan = files(paths).plan;
    expect(read(paths, db => inspectSchema(db, TARGET).version)).toBe(50);
    const injected = stage === "audit" ? auditFault() : postCommitFault();
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed, state: "fenced" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    // No schema version changes from step 50: only the marker and the audit event tell.
    read(paths, db => {
      expect(inspectSchema(db, TARGET).version).toBe(50);
      expect(marker(db)).toEqual([committed ? { state: "complete", plan_hash: noted } : { state: "pending", plan_hash: null }]);
    });
    if (!committed) expect(read(paths, all)).toEqual(before);
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    expect(files(paths).plan).toBe(plan);
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
    assertUpgraded(paths, await apply(paths, inspect(paths).planHash!), recovery(paths));
  });

  it("a failed publication of the pending witness before its rename leaves the trusted witness: retryable, and the same plan applies", async () => {
    const paths = installation(), noted = inspect(paths).planHash!, before = files(paths);
    const injected = witnessFault(paths, "pending", "rename");
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_witness_unchanged", nextStep: "upgrade apply", committed: false, state: "upgrade_needed" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    expect(files(paths)).toEqual(before);
    expect(witness(paths)).toMatchObject({ format: 1, state: "confirmed" });
    expect(fs.readdirSync(securityFenceRoot(canonical(paths)))).toEqual(["witness.json"]);
    expect(inspect(paths)).toMatchObject({ state: "upgrade_needed", planHash: noted });
    const result = await apply(paths, noted);
    assertUpgraded(paths, result, recovery(paths));
    expect(final(paths)).toEqual(await twin("none"));
  });

  it("a failed directory sync after the pending witness was renamed into place is uncertain: the witness is pending and resume is required", async () => {
    const paths = installation(), noted = inspect(paths).planHash!, before = read(paths, all), plan = files(paths).plan;
    const injected = witnessFault(paths, "pending", "sync");
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed: false, state: "fenced" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    expect(read(paths, all)).toEqual(before);
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    expect(files(paths).plan).toBe(plan);
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
    assertUpgraded(paths, await apply(paths, inspect(paths).planHash!), recovery(paths));
    expect(final(paths)).toEqual(await twin("before"));
  });

  /**
   * Runs `replace` once, right after the inspected read-only connection closed
   * for the reopen (armed only once the pending witness was published).
   */
  const reopenFault = (paths: AppPaths, replace: () => void) => {
    let armed = false, injected = false;
    const begin = SecurityFence.beginUpgrade, close = Database.prototype.close;
    vi.spyOn(SecurityFence, "beginUpgrade").mockImplementation((...args) => { begin.apply(SecurityFence, args); armed = true; });
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      const inspected = this.readonly && this.name === canonical(paths);
      const result = close.call(this);
      if (armed && !injected && inspected) { injected = true; replace(); }
      return result;
    } as typeof close);
    return () => injected;
  };
  it.each([
    ["another valid database with its own installation, renamed into place", "other"],
    ["a byte-different copy with the same installation, written in place", "in-place"],
  ] as const)("refuses %s at the reopen: nothing is written to it and the pending witness stays", async (_name, kind) => {
    const paths = installation(), path = canonical(paths), noted = inspect(paths).planHash!, plan = files(paths).plan;
    let replacement: Buffer | undefined;
    const replace = kind === "other"
      ? (() => {
        const other = installation(), staged = join(paths.dataDirectory, "replacement.sqlite3");
        copyFileSync(other.databasePath, staged); chmodSync(staged, 0o600);
        expect(read(other, db => db.prepare("SELECT installation FROM security_checkpoint").pluck().get())).not.toBe(read(paths, db => db.prepare("SELECT installation FROM security_checkpoint").pluck().get()));
        return () => { replacement = readFileSync(staged); renameSync(staged, path); };
      })()
      : () => { const bytes = readFileSync(path); bytes.writeUInt32BE((bytes.readUInt32BE(24) + 7) >>> 0, 24); writeFileSync(path, bytes); replacement = bytes; };
    const inode = lstatSync(path).ino;
    const injected = reopenFault(paths, replace);
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_source_changed", nextStep: "auth fence resume", committed: false, state: "fenced" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    // The replacement is untouched: its bytes (no checkpoint into it, no upgrade), its schema and no marker.
    expect(sha(readFileSync(path))).toBe(sha(replacement!));
    expect(lstatSync(path).ino === inode).toBe(kind === "in-place");
    expect(!existsSync(`${path}-wal`) || lstatSync(`${path}-wal`).size === 0).toBe(true);
    read(paths, db => { expect(inspectSchema(db, TARGET).version).toBe(49); expect(marker(db)).toBe("absent"); });
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    expect(files(paths).plan).toBe(plan);
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
  });

  /**
   * A WAL database whose WAL holds committed frames its main file lacks, as a
   * writer that never closed leaves it: a copy of `source` and its WAL gets one
   * more audit row through a writer with automatic checkpoints off, and the
   * copy's files are copied again while that writer still holds them. Asserted
   * here, so no test built on it passes vacuously: the WAL is not empty, the
   * main file alone lacks the row, and with the WAL it holds it.
   */
  const uncheckpointed = (source: string, mutate?: (bytes: Buffer) => void) => {
    const root = temporary("upgrade-wal-"), staged = join(root, "writer.sqlite3"), file = join(root, "uncheckpointed.sqlite3"), marker = randomUUID();
    copyFileSync(source, staged);
    if (existsSync(`${source}-wal`) && lstatSync(`${source}-wal`).size > 0) copyFileSync(`${source}-wal`, `${staged}-wal`);
    const writer = new Database(staged, { fileMustExist: true });
    try {
      expect(writer.pragma("journal_mode", { simple: true })).toBe("wal");
      writer.pragma("wal_autocheckpoint = 0");
      writer.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('fixture.uncheckpointed','fixture',?,?)")
        .run(JSON.stringify({ marker, padding: "x".repeat(6000) }), new Date().toISOString());
      copyFileSync(staged, file); copyFileSync(`${staged}-wal`, `${file}-wal`);
    } finally { writer.close(); }
    if (mutate) { const bytes = readFileSync(file); mutate(bytes); writeFileSync(file, bytes); }
    chmodSync(file, 0o600); chmodSync(`${file}-wal`, 0o600);
    const database = readFileSync(file), wal = readFileSync(`${file}-wal`);
    const holds = (main: Buffer, log?: Buffer) => {
      const probe = join(temporary("upgrade-wal-probe-"), "probe.sqlite3");
      writeFileSync(probe, main); if (log) writeFileSync(`${probe}-wal`, log);
      const db = new Database(probe, { readonly: true, fileMustExist: true });
      try { return Boolean(db.prepare("SELECT 1 FROM controller_audit_events WHERE event_type='fixture.uncheckpointed' AND json_extract(details_json,'$.marker')=?").get(marker)); } finally { db.close(); }
    };
    expect(wal.length).toBeGreaterThan(0);
    expect(holds(database)).toBe(false);
    expect(holds(database, wal)).toBe(true);
    return { file, database, wal };
  };
  /**
   * A schema-49 installation whose WAL holds such frames (written beside its
   * unchanged main file, so the fence still trusts it), with its plan inspected.
   */
  const walInstallation = () => {
    const paths = installation(), path = canonical(paths), frames = uncheckpointed(path);
    expect(sha(frames.database)).toBe(sha(readFileSync(path)));
    writeFileSync(`${path}-wal`, frames.wal, { mode: 0o600 });
    const status = inspect(paths);
    expect(status).toMatchObject({ state: "upgrade_needed" });
    return { paths, path, noted: status.planHash!, original: frames };
  };
  /** The database file and its WAL at `file`, hashed. */
  const bytes = (file: string) => ({ database: sha(readFileSync(file)), wal: existsSync(`${file}-wal`) ? sha(readFileSync(`${file}-wal`)) : "missing" });
  /** Renames a database with its WAL and shared-memory files. */
  const move = (from: string, to: string) => { for (const suffix of ["", "-wal", "-shm"]) if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix); };
  type ReopenWindow = "closed" | "identity-before" | "guard-read" | "identity-after" | "verify" | "observed";
  /**
   * Runs each step once, at its window of the reopen (armed once the pending
   * witness was published): `closed` right after the inspected connection
   * closed; `identity-before` right after the first identity read of the
   * pathname, before the guard opens; `guard-read` right after the guard's
   * read, before the writable open; `identity-after` right before the second
   * identity read, after the writable open; `verify` at the start of `verify`;
   * `observed` after its observer read the reopened database. A step that
   * throws makes `verify` refuse.
   */
  const reopenWindows = (paths: AppPaths, steps: Partial<Record<ReopenWindow, () => void>>) => {
    const path = canonical(paths), fired: ReopenWindow[] = [];
    let armed = false, closed = false, guardRead = false, identities = 0;
    const fire = (window: ReopenWindow) => { const step = steps[window]; if (step && !fired.includes(window)) { fired.push(window); step(); } };
    const begin = SecurityFence.beginUpgrade, observe = SecurityFence.registerUpgradeObserver;
    const close = Database.prototype.close, prepare = Database.prototype.prepare, lstat = fs.lstatSync;
    vi.spyOn(SecurityFence, "beginUpgrade").mockImplementation((...args) => { begin.apply(SecurityFence, args); armed = true; });
    vi.spyOn(SecurityFence, "registerUpgradeObserver").mockImplementation((...args) => { fire("verify"); observe.apply(SecurityFence, args); fire("observed"); });
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      const inspected = armed && !closed && this.readonly && this.name === path;
      const result = close.call(this);
      if (inspected) { closed = true; fire("closed"); }
      return result;
    } as typeof close);
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, source: string) {
      const statement = prepare.call(this, source);
      if (closed && !guardRead && this.readonly && this.name === path) {
        guardRead = true;
        const get = statement.get;
        statement.get = function (this: typeof statement, ...args: unknown[]) { const row = Reflect.apply(get, this, args) as unknown; fire("guard-read"); return row; } as typeof statement.get;
      }
      return statement;
    } as typeof prepare);
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      const identity = closed && identities < 2 && String(target) === path ? ++identities : 0;
      if (identity === 2) fire("identity-after");
      const result = lstat(target, options as never);
      if (identity === 1) fire("identity-before");
      return result;
    }) as never);
    return () => fired;
  };
  const SOURCE_CHANGED = { name: "UpgradeError", code: "upgrade_source_changed", nextStep: "auth fence resume", committed: false, state: "fenced" };
  /**
   * Each window in which the pathname can be swapped, with a replacement (another
   * installation) and an original that both hold a non-empty WAL of frames not in
   * their main files: the refusal writes neither, wherever each one ends up.
   * `guard` and `writable` name the file each connection opened, `closing` the
   * file at the pathname when the refused writable connection closes.
   */
  it.each([
    ["before the first identity read", { closed: "swap" }, { guard: "replacement", writable: "replacement", closing: "replacement" }],
    ["between the identity read and the guard open", { "identity-before": "swap" }, { guard: "replacement", writable: "replacement", closing: "replacement" }],
    ["between the guard's read and the writable open", { "guard-read": "swap" }, { guard: "original", writable: "replacement", closing: "replacement" }],
    ["between the writable open and the identity check", { "identity-after": "swap" }, { guard: "original", writable: "original", closing: "replacement" }],
    ["during verify, after its reads", { observed: "swap" }, { guard: "original", writable: "original", closing: "replacement" }],
    ["swapped in before the writable open, back for the check and in again during verify", { "guard-read": "swap", "identity-after": "back", verify: "swap" },
      { guard: "original", writable: "replacement", closing: "replacement" }],
    ["swapped in before the guard, back before the writable open, and verify refusing after its reads", { "identity-before": "swap", "guard-read": "back", observed: "refuse" },
      { guard: "replacement", writable: "original", closing: "original" }],
  ] as const)("a replacement %s: the refusal writes neither file", async (_name, plan, connections) => {
    const { paths, path, noted, original } = walInstallation(), plan0 = files(paths).plan;
    const replacement = uncheckpointed(installation().databasePath);
    const asideOriginal = join(paths.dataDirectory, "original.sqlite3"), asideReplacement = join(paths.dataDirectory, "replacement.sqlite3");
    move(replacement.file, asideReplacement);
    const actions = {
      swap: () => { move(path, asideOriginal); move(asideReplacement, path); },
      back: () => { move(path, asideReplacement); move(asideOriginal, path); },
      refuse: () => { throw new Error("fixture verify refusal"); },
    };
    const fired = reopenWindows(paths, Object.fromEntries(Object.entries(plan).map(([window, action]) => [window, actions[action as keyof typeof actions]])));
    expect(await failure(() => apply(paths, noted))).toEqual(SOURCE_CHANGED);
    expect([...fired()].sort()).toEqual(Object.keys(plan).sort()); vi.restoreAllMocks();
    const at = (which: "original" | "replacement") => existsSync(which === "original" ? asideOriginal : asideReplacement) ? (which === "original" ? asideOriginal : asideReplacement) : path;
    expect(bytes(at("replacement"))).toEqual({ database: sha(replacement.database), wal: sha(replacement.wal) });
    expect(bytes(at("original"))).toEqual({ database: sha(original.database), wal: sha(original.wal) });
    expect(at(connections.closing)).toBe(path);
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    expect(files(paths).plan).toBe(plan0);
  });
  it("a byte-different copy of the same installation with a non-empty WAL, written in place: detected only by verify, and neither file is written", async () => {
    const { paths, path, noted } = walInstallation(), plan = files(paths).plan, inode = lstatSync(path).ino;
    // The main file with a changed change counter, and a WAL with one more uncheckpointed row.
    const replacement = uncheckpointed(path, main => main.writeUInt32BE((main.readUInt32BE(24) + 7) >>> 0, 24));
    const fired = reopenWindows(paths, { closed: () => { writeFileSync(path, replacement.database); writeFileSync(`${path}-wal`, replacement.wal); } });
    expect(await failure(() => apply(paths, noted))).toEqual(SOURCE_CHANGED);
    expect(fired()).toEqual(["closed"]); vi.restoreAllMocks();
    expect(lstatSync(path).ino).toBe(inode);
    expect(bytes(path)).toEqual({ database: sha(replacement.database), wal: sha(replacement.wal) });
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
    expect(files(paths).plan).toBe(plan);
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
  });

  it("an interrupted establishment with its backup: resume, inspect and apply end where an uninterrupted establish, inspect and apply do, apart from the resume's quarantine", async () => {
    const establish = (paths: AppPaths, calls?: string[]) => establishSqliteSecurityFence(paths, { action: "establish", expect: fenceInspect(paths).preflight }, HANDOFF, backups(paths, calls), TARGET);
    const without = (value: object, keys: string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    /**
     * `final` without what a resume adds by design: the authentication policy it
     * rotates (the setting and the witness's copy of its mode and generation),
     * its audit event (and the sequence value that event takes), the witness's
     * recovery time, and the receipts, whose names depend on the number of runs.
     * Those are returned apart, for the explicit comparison.
     */
    const settle = (paths: AppPaths) => {
      const { database, witness: fence } = final(paths);
      const { controller_audit_events: events, controller_settings: settings, sqlite_sequence: sequence, ...rows } = database.rows as Record<string, Array<Record<string, unknown>>>;
      return {
        same: { catalogue: database.catalogue, rows, settings: settings.filter(row => row.key !== "authentication"), witness: { ...without(fence, ["receipt", "recoveredAt", "upgrade", "policy"]), upgrade: without(fence.upgrade!, ["receipt"]) },
          events: events.filter(event => event.event_type !== "authentication.security_quarantined").map(event => ({ ...without(event, ["id"]), details_json: without(event.details_json as object, ["receipt"]) })) },
        authentication: JSON.parse(settings.find(row => row.key === "authentication")!.value_json as string), policy: fence.policy,
        quarantined: events.filter(event => event.event_type === "authentication.security_quarantined").map(event => ({ ...without(event, ["id"]), details_json: without(event.details_json as object, ["receipt"]) })),
        sequence: (sequence ?? []).map(row => ({ name: row.name, seq: row.seq })), recoveredAt: fence.recoveredAt,
      };
    };
    /** The raw receipts: the witness's, its upgrade's, and those of the quarantine and upgrade events. */
    const receipts = (paths: AppPaths) => {
      const { receipt, upgrade } = witness(paths);
      const events = read(paths, db => db.prepare("SELECT event_type,details_json FROM controller_audit_events WHERE event_type IN ('authentication.security_quarantined','authentication.upgrade_applied') ORDER BY id").all() as Array<{ event_type: string; details_json: string }>);
      return { witness: receipt, upgrade: upgrade?.receipt, events: events.map(event => [event.event_type, (JSON.parse(event.details_json) as { receipt: string }).receipt]) };
    };

    // Uninterrupted: establish with its backup at the target, then inspect and apply.
    const reference = preFence();
    expect(await establish(reference)).toMatchObject({ trusted: true, changed: true, quarantined: false, schemaVersion: 50, backup: expect.any(String) });
    expect(inspect(reference)).toMatchObject({ state: "upgrade_needed", marker: "pending", schemaVersion: 50 });
    const unchanged = recovery(reference);
    assertUpgraded(reference, await apply(reference, inspect(reference).planHash!), unchanged);

    // Interrupted after the pending witness, before the schema transaction.
    const paths = preFence(), before = read(paths, all), calls: string[] = [];
    let injected = false;
    vi.spyOn(SecurityFence, "registerMaintenanceObserver").mockImplementation(() => { injected = true; throw new Error("fixture fault after the pending witness"); });
    expect(await failure(() => establish(paths, calls))).toMatchObject({ name: "SecurityFenceError", code: "security_fence_pending", committed: false });
    expect(injected).toBe(true); vi.restoreAllMocks();
    expect(read(paths, all)).toEqual(before);
    expect(witness(paths)).toMatchObject({ format: 1, state: "pending" });
    expect(calls).toHaveLength(1);
    expect(() => validateBackup(calls[0]!, parseManifest(readBoundedJson(join(calls[0]!, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET), true, TARGET)).not.toThrow();
    expect(inspect(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume" });
    expect(resume(paths)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 50 });
    expect(inspect(paths)).toMatchObject({ state: "upgrade_needed", marker: "pending", schemaVersion: 50 });
    const previous = recovery(paths);
    assertUpgraded(paths, await apply(paths, inspect(paths).planHash!), previous);

    const recovered = settle(paths), expected = settle(reference);
    expect(recovered.same).toEqual(expected.same);
    // What the resume adds: the rotated policy, its audit event and the sequence value it took, and the recovery time.
    expect(expected.authentication).toEqual({ mode: "token", token: null, generation: 0 });
    expect(recovered.authentication).toEqual({ mode: "token", generation: 1, token: null });
    // The witness records the policy it was confirmed with: the setting's mode and generation.
    expect(expected.policy).toEqual({ mode: "token", generation: 0 });
    expect(recovered.policy).toEqual({ mode: "token", generation: 1 });
    expect(expected.quarantined).toEqual([]);
    expect(recovered.quarantined).toEqual([{ event_type: "authentication.security_quarantined", actor: "local-cli", details_json: { mode: "token" }, created_at: "<time>" }]);
    expect(recovered.sequence).toEqual(expected.sequence.map(row => row.name === "controller_audit_events" ? { ...row, seq: (row.seq as number) + 1 } : row));
    expect(expected.recoveredAt).toBeNull();
    expect(recovered.recoveredAt).toBe("<time>");
    // The receipts relate as they should: the witness keeps the last establish or resume, its upgrade the apply's.
    const mine = receipts(paths), theirs = receipts(reference);
    expect(mine.events).toEqual([["authentication.security_quarantined", mine.witness], ["authentication.upgrade_applied", mine.upgrade]]);
    expect(theirs.events).toEqual([["authentication.upgrade_applied", theirs.upgrade]]);
    expect(theirs.witness).toEqual(expect.any(String));
  });

  it("success not seen by the operator: the same --expect answers already applied with the plan hash", async () => {
    const paths = installation(), noted = inspect(paths).planHash!;
    await apply(paths, noted);
    const before = files(paths);
    expect(await apply(paths, noted)).toMatchObject({ alreadyApplied: true, planHash: noted, receipt: null });
    expect(files(paths)).toEqual(before);
    expect(final(paths)).toEqual(await twin("none"));
  });
});

describe("explicit offline upgrade: witness compatibility", () => {
  const hex = z.string().regex(/^[0-9a-f]{64}$/);
  /** The witness schema before the upgrade receipt, as a binary without it decodes. */
  const legacy = z.object({ payload: z.object({ format: z.literal(1), binding: hex, installation: hex, epoch: hex,
    state: z.enum(["pending", "confirmed"]), file: z.object({ device: z.number().int().nonnegative(), inode: z.number().int().nonnegative() }).strict(),
    policy: z.object({ mode: z.enum(["legacy", "token", "open", "better-auth"]), generation: z.number().int().nonnegative() }).strict(), owner: z.string().min(1).max(160).nullable(),
    restore: z.uuid().nullable(), receipt: z.uuid().nullable(), recoveredAt: z.iso.datetime().nullable() }).strict(), sha256: hex }).strict();
  const legacyDecode = (bytes: string) => { const parsed = legacy.parse(JSON.parse(bytes)); if (sha(JSON.stringify(parsed.payload)) !== parsed.sha256) throw new Error("hash"); return parsed.payload; };
  /** Exactly how the code before this change wrote a record: its literal field order. */
  const legacyBytes = (p: z.infer<typeof legacy>["payload"]) => {
    const payload = { format: 1, binding: p.binding, installation: p.installation, epoch: p.epoch, state: p.state, file: { device: p.file.device, inode: p.file.inode },
      policy: { mode: p.policy.mode, generation: p.policy.generation }, owner: p.owner, restore: p.restore, receipt: p.receipt, recoveredAt: p.recoveredAt };
    return JSON.stringify({ payload, sha256: sha(JSON.stringify(payload)) });
  };

  it("accepts a byte-for-byte pre-change witness and re-publishes format 1 consistently in ordinary operation", () => {
    const paths = installation(true);
    const written = readFileSync(witnessPath(paths), "utf8");
    // What this code writes for a record without an upgrade is the pre-change bytes.
    expect(written).toBe(legacyBytes(legacyDecode(written)));
    writeFileSync(witnessPath(paths), legacyBytes(legacyDecode(written)));
    const store = openStoreAt49(paths.databasePath);
    try {
      new AuthenticationService(store).rotateToken("local-cli");
      expect(store.getAuthenticationPolicy().mode).toBe("token");
    } finally { store.close(); }
    const republished = readFileSync(witnessPath(paths), "utf8");
    expect(republished).not.toBe(written);
    expect(republished).toBe(legacyBytes(legacyDecode(republished)));
    expect(JSON.parse(republished).payload).not.toHaveProperty("upgrade");
    openStoreAt49(paths.databasePath).close();
    expect(inspect(paths)).toMatchObject({ state: "upgrade_needed" });
  });

  it("writes format 2 on apply, which a format-1 binary refuses and ordinary fenced writes carry forward", async () => {
    const paths = installation(true), previous = recovery(paths);
    const result = await apply(paths, inspect(paths).planHash!);
    const bytes = readFileSync(witnessPath(paths), "utf8");
    expect(() => legacyDecode(bytes)).toThrow();
    const upgraded = witness(paths);
    expect(Object.keys(upgraded)).toEqual(["format", "binding", "installation", "epoch", "state", "file", "policy", "owner", "restore", "receipt", "recoveredAt", "upgrade"]);
    // An ordinary authority write through the fence keeps the upgrade receipt and the recovery fields.
    const db = new Database(canonical(paths));
    try {
      configureDurability(db);
      const fence = SecurityFence.attach(canonical(paths), db, false);
      fence.execute(() => db.prepare("UPDATE controller_settings SET updated_at=updated_at WHERE key='authentication'").run(), false);
      fence.execute(() => db.prepare("SELECT 1").get(), true);
    } finally { db.close(); }
    const after = witness(paths);
    expect(after).toMatchObject({ format: 2, state: "confirmed", ...previous, upgrade: upgraded.upgrade });
    expect(after.epoch).not.toBe(upgraded.epoch);
    expect(inspect(paths)).toMatchObject({ state: "current", appliedPlan: result.planHash });
  });

  it("reads and verifies a confirmed format-2 witness; the upgrade's receipt helper refuses a witness that is not this run's pending one", async () => {
    const paths = installation(), result = await apply(paths, inspect(paths).planHash!), path = canonical(paths);
    const bytes = readFileSync(witnessPath(paths), "utf8"), boundary = securityRecoveryBoundary(paths.databasePath);
    expect(securityRecoveryBoundary(paths.databasePath)).toEqual(boundary);
    read(paths, db => {
      expect(() => SecurityFence.inspect(path, db, false)).not.toThrow();
      expect(SecurityFence.preflight(path, db, 50)).toMatchObject({ trusted: true, code: "security_fence_current" });
      expect(() => SecurityFence.upgradeReceipt(path, db, result.receipt!, "confirmed")).toThrowError(expect.objectContaining({ code: "security_fence_recovery_required" }));
    });
    expect(readFileSync(witnessPath(paths), "utf8")).toBe(bytes);
    expect(witness(paths)).toMatchObject({ format: 2, state: "confirmed", upgrade: { receipt: result.receipt, plan: result.planHash } });
  });

  it("confirms an upgrade only for the database its pending witness was published for", () => {
    const paths = installation(), other = installation(), path = canonical(paths), receipt = randomUUID();
    SecurityFence.beginUpgrade(path, { receipt, plan: "a".repeat(64), at: new Date().toISOString() });
    const pending = readFileSync(witnessPath(paths), "utf8");
    const refuses = (database: Database.Database) => {
      for (const phase of ["pending", "confirmed"] as const) {
        expect(() => SecurityFence.upgradeReceipt(path, database, receipt, phase), phase).toThrowError(expect.objectContaining({ code: "security_fence_recovery_required" }));
        expect(() => SecurityFence.registerUpgradeObserver(path, database, receipt), phase).toThrowError(expect.objectContaining({ code: "security_fence_recovery_required" }));
      }
      expect(readFileSync(witnessPath(paths), "utf8")).toBe(pending);
    };
    // Another installation's database, read through the canonical path's witness.
    const foreign = unmanagedFixtureDatabase(other.databasePath, { readonly: true });
    try { refuses(foreign); } finally { foreign.close(); }
    // The same installation in another file at the pathname (a copy renamed into place).
    const copy = join(paths.dataDirectory, "copy.sqlite3");
    copyFileSync(path, copy); chmodSync(copy, 0o600); renameSync(copy, path);
    const moved = unmanagedFixtureDatabase(paths.databasePath, { readonly: true });
    try { refuses(moved); } finally { moved.close(); }
  });
});

describe("inspection-only owner: a refused reopen of a rollback-journal database", () => {
  it("the guard's read transaction keeps a hot journal planted during verify from being rolled back into the file", () => {
    const paths = installation(), path = canonical(paths);
    const convert = new Database(path, { fileMustExist: true });
    try { convert.pragma("journal_mode = DELETE"); } finally { convert.close(); }
    // A hot journal from a copy whose committed pages differ from this file's:
    // its spilled transaction is copied while the writer still holds it.
    const copy = join(temporary("upgrade-journal-"), "copy.sqlite3");
    copyFileSync(path, copy);
    const writer = new Database(copy, { fileMustExist: true });
    let journal = Buffer.alloc(0);
    try {
      const insert = writer.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('fixture.journal','fixture',?,?)");
      for (let row = 0; row < 200; row++) insert.run(JSON.stringify({ row, padding: "x".repeat(500) }), new Date().toISOString());
      writer.pragma("cache_size = 1");
      writer.exec("BEGIN");
      writer.prepare("UPDATE controller_audit_events SET details_json=json_set(details_json,'$.padding','y') WHERE event_type='fixture.journal'").run();
      journal = readFileSync(`${copy}-journal`);
    } finally { writer.close(); }
    expect(journal.length).toBeGreaterThan(0);
    const database = sha(readFileSync(path));
    // Without the guard's lock, the writable connection's first read would roll it back here.
    const plain = join(temporary("upgrade-journal-plain-"), "plain.sqlite3");
    copyFileSync(path, plain); writeFileSync(`${plain}-journal`, journal);
    const unguarded = new Database(plain, { fileMustExist: true });
    try { unguarded.prepare("SELECT count(*) FROM sqlite_master").get(); } finally { unguarded.close(); }
    expect(sha(readFileSync(plain))).not.toBe(database);
    const owner = new OwnedSqliteDatabase(paths.databasePath, false, undefined, { inspectOnly: true });
    try {
      expect(() => owner.enableVerifiedWrites(reopened => {
        writeFileSync(`${path}-journal`, journal, { mode: 0o600 });
        reopened.prepare("SELECT count(*) FROM sqlite_master").get();
        throw new ReopenedDatabaseChangedError();
      })).toThrow();
    } finally { owner.close(); }
    expect(sha(readFileSync(path))).toBe(database);
    expect(sha(readFileSync(`${path}-journal`))).toBe(sha(journal));
  }, 30_000);
});
