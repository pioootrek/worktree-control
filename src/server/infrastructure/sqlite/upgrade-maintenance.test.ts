import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { maintainSecurityFence } from "../../bootstrap/security-maintenance";
import { AuthenticationService } from "../../modules/authentication";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { SqliteStateStore } from "./sqlite-state-store";
import { SecurityFence, SecurityFenceError, securityFenceBinding, securityFenceRoot, securityRecoveryBoundary } from "./security-fence";
import { maintainSqliteSecurityFence } from "./security-maintenance";
import { configureDurability, validateDatabase } from "./database-validation";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { PROVISIONAL_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { enableProvisionalSchema } from "./provisional-schema-gate";
import { hashFile, parseManifest, readBoundedJson, validateBackup, BACKUP_LIMITS } from "./backup-validation";
import { upgradeMarkerChecksum, upgradeMarkerMigration } from "./upgrade-marker-migration";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup, type UpgradeBackupSource } from "./upgrade-maintenance";
import {
  canonicalJson, describeUpgradeActs, executeUpgradeActs, parseUpgradePlan, proposeUpgradeActs, readUpgradePlan, structuralSteps,
  UPGRADE_ACT_KINDS, UPGRADE_PLAN_LIMITS, upgradePlanHash, upgradePlanPath, upgradePlanRoot, writeUpgradePlan,
  type UpgradeActKind, type UpgradePlan,
} from "./upgrade-plan";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));

const TARGET = PROVISIONAL_SCHEMA_VERSION;
const roots: string[] = [];
let restoreGate: () => void;
beforeEach(() => { restoreGate = enableProvisionalSchema(); });
afterEach(() => { vi.restoreAllMocks(); restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
const TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, HEX = /[0-9a-f]{64}/g, RANDOM = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
const scrub = (value: unknown) => typeof value === "string" ? value.replace(TIME, "<time>").replace(UUID, "<uuid>").replace(HEX, "<hex>").replace(RANDOM, "<random>") : value;
/** Everything that is not a timestamp, receipt, hash or random epoch. */
const normal = (db: Database.Database) => {
  const { catalogue, rows } = all(db);
  delete rows.security_checkpoint;
  return { catalogue, rows: Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, (list as Array<Record<string, unknown>>).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, scrub(value)])))])) };
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
  const store = new SqliteStateStore(paths.databasePath);
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
  const store = new SqliteStateStore(paths.databasePath);
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
      kind: "worktree-control/upgrade-plan", format: 1, binding: securityFenceBinding(path),
      installation: read(paths, db => db.prepare("SELECT installation FROM security_checkpoint").pluck().get()), base: first.preflight,
      source: 49, target: 50, steps: [{ version: 50, name: upgradeMarkerMigration.name, checksum: upgradeMarkerChecksum }], acts: [],
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
    const store = new SqliteStateStore(paths.databasePath);
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

  it("refuses a plan that contains an act, with no act kind registered", async () => {
    expect(UPGRADE_ACT_KINDS).toEqual([]);
    const paths = installation(), status = inspect(paths);
    const payload = { ...status.plan!, acts: [{ kind: "fixture.note", payload: {} }] };
    expect(() => parseUpgradePlan(payload)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    expect(() => writeUpgradePlan(canonical(paths), payload)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
    const hash = upgradePlanHash(payload);
    writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: hash }));
    const before = files(paths);
    expect(await failure(() => apply(paths, hash))).toMatchObject({ code: "upgrade_plan_invalid", nextStep: "upgrade inspect", committed: false });
    expect(files(paths)).toEqual(before);
  });
});

describe("explicit offline upgrade: plan and act mechanism", () => {
  const plan = (acts: UpgradePlan["acts"] = []): UpgradePlan => ({ kind: "worktree-control/upgrade-plan", format: 1, binding: "a".repeat(64), installation: "b".repeat(64), base: "c".repeat(64),
    source: 49, target: 50, steps: structuralSteps(49, 50), acts });
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
    expect(structuralSteps(50, 50)).toEqual([]);
    expect(() => structuralSteps(48, 50)).toThrowError(expect.objectContaining({ code: "upgrade_step_mismatch" }));
    expect(() => structuralSteps(49, 51)).toThrowError(expect.objectContaining({ code: "upgrade_step_mismatch" }));
  });
  it("lets a registered kind propose, execute and describe acts in order, every act covered by the hash", () => {
    const executed: string[] = [];
    const note: UpgradeActKind<{ name: string }> = {
      kind: "fixture.note", payload: z.object({ name: z.string().max(16) }).strict(),
      propose: () => [{ name: "b" }, { name: "a" }],
      execute: (_database, payload) => { executed.push(payload.name); },
      describe: payload => `note ${payload.name}`,
    };
    const kinds = [note] as ReadonlyArray<UpgradeActKind>;
    const database = new Database(":memory:");
    try {
      const acts = proposeUpgradeActs(database, { source: 49, target: 50 }, kinds);
      expect(acts).toEqual([{ kind: "fixture.note", payload: { name: "b" } }, { kind: "fixture.note", payload: { name: "a" } }]);
      const parsed = parseUpgradePlan(plan(acts), kinds);
      expect(describeUpgradeActs(parsed, kinds)).toEqual(["note b", "note a"]);
      expect(() => executeUpgradeActs(database, parsed, kinds)).toThrow(/inside the schema transaction/);
      database.transaction(() => executeUpgradeActs(database, parsed, kinds))();
      expect(executed).toEqual(["b", "a"]);
      // Order, payload and kind are all part of the hash.
      expect(upgradePlanHash(plan([...acts].reverse()))).not.toBe(upgradePlanHash(parsed));
      expect(upgradePlanHash(plan([acts[0], { kind: "fixture.note", payload: { name: "c" } }]))).not.toBe(upgradePlanHash(parsed));
      // Strict payloads; unknown kinds; the default registry refuses every act.
      for (const invalid of [[{ kind: "fixture.note", payload: { name: "a", extra: 1 } }], [{ kind: "fixture.other", payload: {} }], [{ kind: "fixture.note", payload: { name: "a" }, extra: 1 }]]) {
        expect(() => parseUpgradePlan(plan(invalid as UpgradePlan["acts"]), kinds)).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      }
      expect(() => parseUpgradePlan(plan(acts))).toThrowError(expect.objectContaining({ code: "upgrade_plan_invalid" }));
      expect(UPGRADE_PLAN_LIMITS).toMatchObject({ bytes: 8 * 1024 * 1024, acts: 50_000 });
      expect(UPGRADE_PLAN_LIMITS.bytes).toBe(BACKUP_LIMITS.manifestBytes);
    } finally { database.close(); }
  });
  it("refuses a plan file that is oversized, not private, of another format, with an unknown field, duplicate keys or a wrong envelope hash", () => {
    const paths = installation(), path = canonical(paths), status = inspect(paths), good = readFileSync(planFile(paths), "utf8");
    const variants: Array<[string, () => void]> = [
      ["oversized", () => writeFileSync(planFile(paths), " ".repeat(UPGRADE_PLAN_LIMITS.bytes + 1))],
      ["readable by others", () => chmodSync(planFile(paths), 0o644)],
      ["another format", () => { const payload = { ...status.plan!, format: 2 }; writeFileSync(planFile(paths), JSON.stringify({ payload, sha256: sha(canonicalJson(payload)) })); }],
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
    const store = new SqliteStateStore(paths.databasePath);
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
    const store = new SqliteStateStore(paths.databasePath);
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
  /** The final state the operator's recovery must reach, for comparison with an uninterrupted twin. */
  const final = (paths: AppPaths) => ({ database: read(paths, normal), marker: read(paths, db => (db.prepare("SELECT state FROM upgrade_marker").pluck().get())),
    witness: (({ format, state, policy, owner, restore, receipt, recoveredAt, upgrade }) => ({ format, state, policy, owner, restore: restore !== null, receipt: receipt !== null, recoveredAt: recoveredAt !== null, upgrade: Boolean(upgrade) }))(witness(paths)) });
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
  const confirmedFsyncFault = (paths: AppPaths) => {
    let injected = false, published: string | undefined;
    const sync = fs.fsyncSync, rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const state = String(to) === witnessPath(paths) ? JSON.parse(readFileSync(String(from), "utf8")).payload.state : undefined;
      rename(from, to); if (state) published = state;
    });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      // The directory sync that would make the confirmed rename durable.
      if (!injected && published === "confirmed" && fs.realpathSync(`/proc/self/fd/${fd}`) === securityFenceRoot(canonical(paths))) {
        injected = true; throw Object.assign(new Error("fixture fsync fault"), { code: "EIO" });
      }
      sync(fd);
    });
    return () => injected;
  };
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
    const paths = installation(), noted = inspect(paths).planHash!;
    const injected = stage === "post-commit" ? postCommitFault() : confirmedFsyncFault(paths);
    expect(await failure(() => apply(paths, noted))).toEqual({ name: "UpgradeError", code: "upgrade_outcome_uncertain", nextStep: "auth fence resume", committed: true, state: "fenced" });
    expect(injected()).toBe(true); vi.restoreAllMocks();
    read(paths, db => { expect(inspectSchema(db, TARGET).version).toBe(50); expect(marker(db)).toEqual([{ state: "complete", plan_hash: noted }]); });
    expect(witness(paths)).toMatchObject({ format: 2, state: "pending", upgrade: { plan: noted } });
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
    const store = new SqliteStateStore(paths.databasePath);
    try {
      new AuthenticationService(store).rotateToken("local-cli");
      expect(store.getAuthenticationPolicy().mode).toBe("token");
    } finally { store.close(); }
    const republished = readFileSync(witnessPath(paths), "utf8");
    expect(republished).not.toBe(written);
    expect(republished).toBe(legacyBytes(legacyDecode(republished)));
    expect(JSON.parse(republished).payload).not.toHaveProperty("upgrade");
    new SqliteStateStore(paths.databasePath).close();
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
});
