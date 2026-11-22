import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { createControllerBackup } from "../../controller-backup";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { SqliteStateStore } from "./sqlite-state-store";
import { SecurityFence, securityFenceRoot } from "./security-fence";
import { maintainSqliteSecurityFence } from "./security-maintenance";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup } from "./upgrade-maintenance";
import { upgradePlanPath } from "./upgrade-plan";
import type { UpgradeError } from "./upgrade-contract";
import { createFencedAt49, createFencedDatabase } from "./fixtures/released-schema";

/**
 * D1b decision 1: the upgrade source matrix at target 53. The released 49 is
 * the supported source; a database completed at an intermediate schema (50 to
 * 52, built only by unreleased integration builds) is refused before any
 * proposal, plan file or backup; a pending marker keeps its proposal and an
 * untrusted fence its next step.
 */
const CYCLE = 30_000;
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const installation = (): AppPaths => { const root = mkdtempSync(join(tmpdir(), "idempotency-upgrade-")); roots.push(root); return resolveAppPaths(join(root, "data")); };
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");
const backups = (paths: AppPaths, calls: { count: number }): UpgradeBackup => async source => {
  calls.count++;
  const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
  return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory }) };
};
/** The database and its WAL; a missing and an empty WAL are the same state (a read-only open may create an empty one). */
const bytes = (paths: AppPaths) => [paths.databasePath, `${paths.databasePath}-wal`].map(file => existsSync(file) && statSync(file).size > 0 ? readFileSync(file).toString("base64") : "empty");
const failure = async (operation: () => unknown): Promise<UpgradeError> => {
  try { await operation(); } catch (error) { return error as UpgradeError; }
  throw new Error("expected a refusal");
};
const raw = <T,>(paths: AppPaths, read: (database: Database.Database) => T): T => {
  const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
  try { return read(database); } finally { database.close(); }
};
const version = (paths: AppPaths) => raw(paths, database => database.prepare("SELECT max(version) FROM schema_migrations").pluck().get());
/** `auth fence resume` at `target` of a trusted database, after removing its witness (it becomes untrusted). */
function resumeAt(paths: AppPaths, target: number) {
  rmSync(join(securityFenceRoot(canonical(paths)), "witness.json"));
  const status = maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, target);
  return maintainSqliteSecurityFence(paths, { action: "resume", expect: status.preflight, mode: "token" }, HANDOFF, target);
}

describe("the upgrade to 53", () => {
  it("takes the released 49 through inspect and apply to 53 once, with the bound backup, marker and plan hash, and reports a repeated apply as applied", async () => {
    const paths = installation(), calls = { count: 0 };
    createFencedAt49(paths.databasePath);
    const inspection = inspectSqliteUpgrade(paths);
    expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 49, target: 53, marker: "absent" });
    expect(inspection.plan!.steps.map(step => step.version)).toEqual([50, 51, 52, 53]);
    const result = await applySqliteUpgrade(paths, { expect: inspection.planHash! }, backups(paths, calls));
    expect(result).toMatchObject({ state: "current", alreadyApplied: false, planHash: inspection.planHash, schemaVersion: 53, planRemoved: true });
    expect(calls.count).toBe(1);
    expect(raw(paths, database => database.prepare("SELECT state,plan_hash FROM upgrade_marker").get())).toEqual({ state: "complete", plan_hash: inspection.planHash });
    expect(raw(paths, database => database.prepare("SELECT count(*) FROM operation_idempotency").pluck().get())).toBe(0);
    const again = await applySqliteUpgrade(paths, { expect: inspection.planHash! }, backups(paths, calls));
    expect(again).toMatchObject({ state: "current", alreadyApplied: true, backup: null });
    expect(calls.count).toBe(1);
    expect(raw(paths, database => database.prepare("SELECT count(*) FROM controller_audit_events WHERE event_type='authentication.upgrade_applied'").pluck().get())).toBe(1);
    new SqliteStateStore(paths.databasePath).close();
  }, CYCLE);

  it.each([50, 51, 52])("refuses a trusted database completed at %i before any proposal, plan file or backup", async source => {
    const paths = installation(), calls = { count: 0 };
    createFencedDatabase(paths.databasePath, source);
    const before = bytes(paths);
    const inspected = await failure(() => inspectSqliteUpgrade(paths));
    expect(inspected).toMatchObject({ name: "UpgradeError", code: "upgrade_intermediate_schema", nextStep: "none", state: "upgrade_needed", committed: false });
    expect(inspected.message).toMatch(/unreleased intermediate schema/);
    expect(existsSync(upgradePlanPath(canonical(paths)))).toBe(false);
    const applied = await failure(() => applySqliteUpgrade(paths, { expect: "0".repeat(64) }, backups(paths, calls)));
    expect(applied).toMatchObject({ code: "upgrade_intermediate_schema", committed: false });
    expect(calls.count).toBe(0);
    expect(bytes(paths)).toEqual(before);
    expect(version(paths)).toBe(source);
    // The ordinary opening still names the upgrade; the refusal belongs to the upgrade alone.
    expect(() => new SqliteStateStore(paths.databasePath)).toThrowError(expect.objectContaining({ code: "upgrade_required" }));
    // An explicit target at the source's own level is not an intermediate upgrade.
    expect(inspectSqliteUpgrade(paths, source)).toMatchObject({ state: "current" });
  }, CYCLE);

  it("keeps the proposal of a pending 52 (no unexpected grants) and applies it to 53", async () => {
    const paths = installation(), calls = { count: 0 };
    createFencedDatabase(paths.databasePath, 52);
    expect(resumeAt(paths, 52)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 52 });
    const inspection = inspectSqliteUpgrade(paths);
    expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 52, target: 53, marker: "pending" });
    expect(inspection.plan!.steps.map(step => step.version)).toEqual([53]);
    expect(await applySqliteUpgrade(paths, { expect: inspection.planHash! }, backups(paths, calls))).toMatchObject({ state: "current", schemaVersion: 53 });
    expect(version(paths)).toBe(53);
  }, CYCLE);

  it("keeps the unexpected-grants refusal of a pending 52", async () => {
    const paths = installation();
    createFencedDatabase(paths.databasePath, 52);
    resumeAt(paths, 52);
    const database = unmanagedFixtureDatabase(paths.databasePath);
    try {
      database.prepare("INSERT INTO remote_principals(id,kind,status) VALUES('owner-1','owner','active')").run();
      database.prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('owner-1','admin','installation',NULL,'2026-11-20T00:00:00.000Z')").run();
      SecurityFence.attach(canonical(paths), database, true);
    } finally { database.close(); }
    const refused = await failure(() => inspectSqliteUpgrade(paths));
    expect(refused).toMatchObject({ code: "upgrade_authority_unexpected", nextStep: "upgrade inspect" });
    expect(existsSync(upgradePlanPath(canonical(paths)))).toBe(false);
  }, CYCLE);

  it("keeps the next step of an untrusted 52 whose marker still says complete", async () => {
    const paths = installation();
    createFencedDatabase(paths.databasePath, 52);
    const database = unmanagedFixtureDatabase(paths.databasePath);
    try { database.prepare("UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32)))").run(); } finally { database.close(); }
    expect(raw(paths, current => current.prepare("SELECT state FROM upgrade_marker").pluck().get())).toBe("complete");
    expect(inspectSqliteUpgrade(paths)).toMatchObject({ state: "fenced", nextStep: "auth fence resume", schemaVersion: 52, marker: "complete" });
    const applied = await failure(() => applySqliteUpgrade(paths, { expect: "0".repeat(64) }, backups(paths, { count: 0 })));
    expect(applied).toMatchObject({ code: "upgrade_wrong_state", nextStep: "auth fence resume", state: "fenced" });
  }, CYCLE);
});
