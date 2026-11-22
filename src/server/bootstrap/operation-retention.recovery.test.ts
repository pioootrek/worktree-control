import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "../paths";
import { createControllerBackup, restoreControllerBackup } from "../controller-backup";
import { SqliteStateStore } from "../infrastructure/sqlite";
import { operationKeyPath } from "../infrastructure/sqlite/operation-fingerprint-key";
import { unmanagedFixtureDatabase } from "../unmanaged-sqlite-fixture";
import { OperationRunner } from "../modules/operations";
import type { MutationOperation } from "../modules/operations/operation";
import { createWorld } from "../modules/operations/operations-fixture";
import { onProject } from "../modules/operations/requirements";
import { key, projectA } from "../modules/operations/runner-fixture";
import { initializeOperationRetention } from "./operation-retention";
import { maintainSecurityFence } from "./security-maintenance";
import { applyUpgrade, inspectUpgrade } from "./upgrade-maintenance";

/**
 * D1b decision 2 and amendment A1: after a recovery no retry of an old key
 * replays a pre-recovery result or runs fresh silently, for every record that
 * survived in the recovered database; a key first used after the restored
 * snapshot was taken has no record there and runs fresh (the operator
 * reconciles such effects before retrying). Full maintenance cycles, so each
 * test has a 30 s timeout.
 */
const CYCLE = 30_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const installation = (): AppPaths => { const root = mkdtempSync(join(tmpdir(), "retention-recovery-")); roots.push(root); return resolveAppPaths(join(root, "data"), join(root, "state")); };
const code = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as { code?: string }).code; } return "opened"; };
const states = (paths: AppPaths) => {
  const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries((database.prepare("SELECT idempotency_key,state,result_json FROM operation_idempotency ORDER BY idempotency_key").all() as
      Array<{ idempotency_key: string; state: string; result_json: string | null }>).map(row => [row.idempotency_key, row.result_json === null ? row.state : `${row.state} ${row.result_json}`]));
  } finally { database.close(); }
};

/** A controller start: the owner, its retention, and a runner over the store's admission. */
async function start(paths: AppPaths, world: ReturnType<typeof createWorld>) {
  const store = new SqliteStateStore(paths.databasePath);
  const retention = await initializeOperationRetention({ store, now: () => world.clock.now, logs: { controller: () => undefined } });
  if (!retention) { store.close(); throw new Error("retention unavailable"); }
  return { store, runner: new OperationRunner({ ...world.runtime({ idempotency: retention.idempotency, fingerprintKey: retention.fingerprintKey }), admission: store.admission }) };
}
function effect(counter: { runs: number }): MutationOperation<{ note: string }, { run: number }, { run: number }> {
  return {
    id: "fixture.external_effect", kind: "mutation",
    requirement: { require: onProject("runtime:control", "registration") },
    parse: raw => ({ note: String((raw as { note: string }).note) }),
    resources: () => ({ registration: { kind: "registration", id: "reg-1" } }),
    effect: { mode: "admitted", run: () => ({ run: ++counter.runs }) },
    retain: true, publicKeys: ["run"], project: result => result,
  };
}
/** `auth fence resume`, then the upgrade the quarantine makes necessary, as the operator runs them. */
async function recover(paths: AppPaths): Promise<void> {
  expect(code(() => new SqliteStateStore(paths.databasePath).close())).toBe("security_fence_recovery_required");
  const status = maintainSecurityFence(paths, { action: "inspect" });
  expect(maintainSecurityFence(paths, { action: "resume", expect: status.preflight, mode: "token" })).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 53 });
  expect(code(() => new SqliteStateStore(paths.databasePath).close())).toBe("upgrade_required");
  const inspection = inspectUpgrade(paths);
  expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 53, target: 53, marker: "pending" });
  expect(await applyUpgrade(paths, { expect: inspection.planHash! }, { directory: join(paths.dataDirectory, "..", "maintenance"), applicationVersion: "test" }))
    .toMatchObject({ state: "current", schemaVersion: 53 });
}

describe("retained outcomes across a recovery", () => {
  it("restore, resume and upgrade: a key used before the backup answers outcome_unknown; one first used after it runs fresh", async () => {
    const paths = installation(), world = createWorld({ now: Date.now() });
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const operator = world.operator(), counter = { runs: 0 }, operation = effect(counter);
    const backup = join(paths.dataDirectory, "..", "backup");
    const first = await start(paths, world);
    try {
      expect(await first.runner.run(operation, operator, { note: "before" }, key("before-backup"))).toEqual({ ok: true, value: { run: 1 }, replayed: false });
      await createControllerBackup(first.store, backup, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory });
      expect(await first.runner.run(operation, operator, { note: "after" }, key("after-backup"))).toEqual({ ok: true, value: { run: 2 }, replayed: false });
      expect(await first.runner.run(operation, operator, { note: "before" }, key("before-backup"))).toMatchObject({ ok: true, replayed: true });
    } finally { first.store.close(); }
    // The key file is never part of a backup.
    const key32 = readFileSync(operationKeyPath(paths.databasePath));
    const files = (root: string): string[] => readdirSync(root).flatMap(name => { const path = join(root, name); return statSync(path).isDirectory() ? files(path) : [path]; });
    for (const file of files(backup)) {
      expect(file).not.toContain("operation-key");
      expect(readFileSync(file).includes(key32)).toBe(false);
    }

    restoreControllerBackup(backup, paths.databasePath, paths.knowledgeAttachmentDirectory);
    expect(states(paths)).toEqual({ "before-backup": 'completed {"run":1}' });
    await recover(paths);
    expect(states(paths)).toEqual({ "before-backup": "unknown" });
    const second = await start(paths, world);
    try {
      expect(await second.runner.run(operation, operator, { note: "before" }, key("before-backup")))
        .toMatchObject({ ok: false, error: { category: "outcome_unknown", reason: "previous_attempt_outcome_unknown" } });
      expect(await second.runner.run(operation, operator, { note: "changed" }, key("before-backup")))
        .toMatchObject({ ok: false, error: { category: "conflict", reason: "idempotency_conflict" } });
      // Absent from the snapshot: a fresh run. The operator reconciles post-snapshot effects first.
      expect(await second.runner.run(operation, operator, { note: "after" }, key("after-backup"))).toEqual({ ok: true, value: { run: 3 }, replayed: false });
    } finally { second.store.close(); }
    expect(counter.runs).toBe(3);
  }, CYCLE);

  it("a fence resume without a restore converts what the database holds", async () => {
    const paths = installation(), world = createWorld({ now: Date.now() });
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const operator = world.operator(), counter = { runs: 0 }, operation = effect(counter);
    const first = await start(paths, world);
    try { expect(await first.runner.run(operation, operator, { note: "x" }, key("k-1"))).toMatchObject({ ok: true }); } finally { first.store.close(); }
    // A change outside the owner that the fence detects: the checkpoint no longer matches the witness.
    const outside = unmanagedFixtureDatabase(paths.databasePath);
    try { outside.prepare("UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32)))").run(); } finally { outside.close(); }
    await recover(paths);
    expect(states(paths)).toEqual({ "k-1": "unknown" });
    const second = await start(paths, world);
    try { expect(await second.runner.run(operation, operator, { note: "x" }, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown" } }); }
    finally { second.store.close(); }
    expect(counter.runs).toBe(1);
  }, CYCLE);

  it("upgrade apply invalidates a record it meets, keeping an unknown record's expiry", async () => {
    const paths = installation(), world = createWorld({ now: Date.now() });
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const operator = world.operator(), counter = { runs: 0 }, operation = effect(counter);
    const first = await start(paths, world);
    try { await first.runner.run(operation, operator, { note: "x" }, key("k-1")); } finally { first.store.close(); }
    const outside = unmanagedFixtureDatabase(paths.databasePath);
    try { outside.prepare("UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32)))").run(); } finally { outside.close(); }
    expect(code(() => new SqliteStateStore(paths.databasePath).close())).toBe("security_fence_recovery_required");
    const status = maintainSecurityFence(paths, { action: "inspect" });
    maintainSecurityFence(paths, { action: "resume", expect: status.preflight, mode: "token" });
    // A record written after the quarantine, outside the owner (the table is not fenced): the upgrade meets it.
    const write = new Database(paths.databasePath);
    let expiry: number;
    try {
      expiry = (write.prepare("SELECT expires_at FROM operation_idempotency WHERE idempotency_key='k-1'").pluck().get() as number);
      write.prepare(`INSERT INTO operation_idempotency(operation_id,principal,idempotency_key,attempt,key_id,fingerprint,state,resources_json,result_json,charged_bytes,created_at,updated_at,expires_at)
        SELECT operation_id,principal,'k-2',attempt,key_id,fingerprint,'completed',resources_json,'{"run":9}',10,created_at,updated_at,? FROM operation_idempotency WHERE idempotency_key='k-1'`)
        .run(world.clock.now + 60_000);
    } finally { write.close(); }
    const inspection = inspectUpgrade(paths);
    await applyUpgrade(paths, { expect: inspection.planHash! }, { directory: join(paths.dataDirectory, "..", "maintenance"), applicationVersion: "test" });
    expect(states(paths)).toEqual({ "k-1": "unknown", "k-2": "unknown" });
    const database = new Database(paths.databasePath, { readonly: true });
    try { expect(database.prepare("SELECT expires_at FROM operation_idempotency WHERE idempotency_key='k-1'").pluck().get()).toBe(expiry); } finally { database.close(); }
  }, CYCLE);
});
