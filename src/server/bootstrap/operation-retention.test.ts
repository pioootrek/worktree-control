import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSessionDescribe } from "@/cli/session-describe";
import { resolveAppPaths, type AppPaths } from "@/server/paths";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { SecurityFenceError } from "@/server/infrastructure/sqlite/security-fence";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { loadOperationKey, operationKeyPath } from "@/server/infrastructure/sqlite/operation-fingerprint-key";
import { OPERATION_IDEMPOTENCY_LIMITS } from "@/server/infrastructure/sqlite/operation-idempotency-queries";
import { fingerprintKeyId, OperationRunner, SqliteIdempotencyStore, type IdempotencyStorePort } from "@/server/modules/operations";
import type { EffectScope, MutationOperation } from "@/server/modules/operations/operation";
import { createWorld } from "@/server/modules/operations/operations-fixture";
import { onProject } from "@/server/modules/operations/requirements";
import { fakeStart, input, key, projectA } from "@/server/modules/operations/runner-fixture";
import { initializeOperationRetention, type OperationRetention } from "./operation-retention";
import { AuthenticationRequestBudget } from "./authentication-request-budget";
import { buildOperationsRuntime } from "./operations-runtime";

/**
 * D1b decision 6: the controller's retention initialization, once per
 * database-owner lifetime, on the real owned and fenced store: the key file,
 * the restart repair and its failure classes.
 */
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const HORIZON = OPERATION_IDEMPOTENCY_LIMITS.horizonMs;
const T0 = Date.parse("2026-11-22T12:00:00.000Z");
function installation(): AppPaths {
  const root = mkdtempSync(join(tmpdir(), "operation-retention-"));
  roots.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}
function open(paths: AppPaths): SqliteStateStore {
  const store = new SqliteStateStore(paths.databasePath);
  closers.push(() => store.close());
  return store;
}
const logs = () => ({ controller: vi.fn() });
async function start(paths: AppPaths, now: number, log = logs()) {
  const store = open(paths);
  const retention = await initializeOperationRetention({ store, now: () => now, logs: log });
  return { store, retention, log, database: ownedFixtureDatabase(store) };
}
const FINGERPRINT = `hmac-sha256:v1:${"c".repeat(64)}`;
const FOREIGN = "f".repeat(32);
/** A record written directly on the store's guarded handle. */
function insert(database: Database.Database, idempotencyKey: string, keyId: string, state: string, expiresAt: number | null) {
  database.prepare(`INSERT INTO operation_idempotency(operation_id,principal,idempotency_key,attempt,key_id,fingerprint,state,resources_json,result_json,transitions_json,
    charged_bytes,created_at,updated_at,expires_at) VALUES('fixture.runtime_start','operator',?,'attempt-1',?,?,?,'{}',?,NULL,2,?,?,?)`)
    .run(idempotencyKey, keyId, FINGERPRINT, state, state === "completed" ? '{"retained":true}' : null, T0, T0, expiresAt);
}
const rows = (database: Database.Database) => Object.fromEntries((database.prepare("SELECT idempotency_key,state,expires_at,result_json FROM operation_idempotency ORDER BY idempotency_key").all() as
  Array<{ idempotency_key: string; state: string; expires_at: number | null; result_json: string | null }>).map(row => [row.idempotency_key, { state: row.state, expiresAt: row.expires_at, result: row.result_json }]));

/** A runner over the real store's admission and the controller's retention; credentials and resources from the fixture. */
function runner(store: SqliteStateStore, retention: OperationRetention | null, shared?: ReturnType<typeof createWorld>) {
  const world = shared ?? createWorld({ now: T0 });
  if (!shared) world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
  const operator = world.operator();
  const run = new OperationRunner({ ...world.runtime({ idempotency: retention?.idempotency, fingerprintKey: retention?.fingerprintKey }), admission: store.admission,
    ...(retention ? {} : { fingerprintKey: undefined }) });
  return { world, operator, run };
}

describe("restart repair", () => {
  it("deletes expired and same-generation reserved records, turns started into unknown, and converts every unexpired foreign-generation record across two restarts", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    expect(first.retention).not.toBeNull();
    const own = fingerprintKeyId(loadOperationKey(first.store.canonicalDatabasePath));
    insert(first.database, "own-reserved", own, "reserved", null);
    insert(first.database, "own-started", own, "started", null);
    insert(first.database, "own-completed", own, "completed", T0 + HORIZON);
    insert(first.database, "own-unknown", own, "unknown", T0 + 2 * HORIZON);
    insert(first.database, "own-expired", own, "completed", T0 + 10);
    insert(first.database, "foreign-reserved", FOREIGN, "reserved", null);
    insert(first.database, "foreign-started", FOREIGN, "started", null);
    insert(first.database, "foreign-completed", FOREIGN, "completed", T0 + HORIZON);
    insert(first.database, "foreign-unknown", FOREIGN, "unknown", T0 + 3 * HORIZON);
    insert(first.database, "foreign-expired", FOREIGN, "completed", T0 + 10);
    first.store.close();

    const second = await start(paths, T0 + 100);
    expect(rows(second.database)).toEqual({
      "own-completed": { state: "completed", expiresAt: T0 + HORIZON, result: '{"retained":true}' },
      "own-started": { state: "unknown", expiresAt: T0 + 100 + HORIZON, result: null },
      "own-unknown": { state: "unknown", expiresAt: T0 + 2 * HORIZON, result: null },
      "foreign-reserved": { state: "unknown", expiresAt: T0 + 100 + HORIZON, result: null },
      "foreign-started": { state: "unknown", expiresAt: T0 + 100 + HORIZON, result: null },
      "foreign-completed": { state: "unknown", expiresAt: T0 + HORIZON, result: null },
      "foreign-unknown": { state: "unknown", expiresAt: T0 + 3 * HORIZON, result: null },
    });
    expect(second.log.controller).toHaveBeenCalledWith("operations.retention_repaired", { deletedExpired: 2, convertedForeign: 3, deletedReserved: 1, convertedStarted: 1 });
    second.store.close();

    // A later start never extends an expiry and never resurrects an expired record.
    const third = await start(paths, T0 + 200);
    const after = rows(third.database);
    expect(after["foreign-reserved"]).toEqual({ state: "unknown", expiresAt: T0 + 100 + HORIZON, result: null });
    expect(after["own-started"]).toEqual({ state: "unknown", expiresAt: T0 + 100 + HORIZON, result: null });
    expect(Object.keys(after)).toHaveLength(7);
    third.store.close();
    const fourth = await start(paths, T0 + HORIZON + 1);
    expect(Object.keys(rows(fourth.database)).sort()).toEqual(["foreign-reserved", "foreign-started", "foreign-unknown", "own-started", "own-unknown"]);
  });

  it("writes nothing on an empty table", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    first.store.close();
    const second = await start(paths, T0);
    expect(second.log.controller).not.toHaveBeenCalled();
  });

  it("replays a completed outcome after a reopen with an unchanged key, and answers a foreign key's record as a key change", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    const one = runner(first.store, first.retention);
    const { operation, log } = fakeStart(one.world);
    expect(await one.run.run(operation, one.operator, input, key("k-1"))).toMatchObject({ ok: true, replayed: false });
    first.store.close();
    const second = await start(paths, T0);
    const two = runner(second.store, second.retention, one.world);
    expect(await two.run.run(operation, one.operator, input, key("k-1"))).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: true });
    second.store.close();
    // A replaced key: the record becomes unknown, and its digest no longer matches the same input.
    rmSync(operationKeyPath(second.store.canonicalDatabasePath));
    const third = await start(paths, T0);
    expect(rows(third.database)["k-1"]).toMatchObject({ state: "unknown", result: null });
    const three = runner(third.store, third.retention, one.world);
    expect(await three.run.run(operation, one.operator, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "idempotency_conflict" } });
    expect(log.effects).toHaveLength(1);
  });

  it("clears a reservation left by a failed release at the next start; until then the key is in progress", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    const port = first.store.operationIdempotency();
    const failing: IdempotencyStorePort = { inTransaction: () => port.inTransaction(), read: (k, now) => port.read(k, now), reserve: value => port.reserve(value),
      advance: value => port.advance(value), release: () => { throw new Error("release failed /secret"); } };
    const keyId = fingerprintKeyId(first.retention!.fingerprintKey);
    const one = runner(first.store, { idempotency: new SqliteIdempotencyStore({ port: failing, keyId, now: () => T0 }), fingerprintKey: first.retention!.fingerprintKey });
    let calls = 0;
    const declared: MutationOperation<Record<string, never>, { ok: boolean }, { ok: boolean }> = {
      id: "fixture.declared_refusal", kind: "mutation", requirement: { require: onProject("runtime:control", "registration") },
      parse: () => ({}), resources: () => ({ registration: { kind: "registration", id: "reg-1" } }),
      effect: { mode: "admitted", commitPoint: "declared", run: (_value, _scope: EffectScope) => { calls++; throw new Error("refused before commit"); } },
      retain: true, publicKeys: ["ok"], project: result => result,
    };
    expect(await one.run.run(declared, one.operator, {}, key("k-1"))).toMatchObject({ ok: false, error: { effect: "not_started" } });
    expect(rows(first.database)["k-1"]).toMatchObject({ state: "reserved" });
    expect(await one.run.run(declared, one.operator, {}, key("k-1"))).toMatchObject({ ok: false, error: { reason: "request_in_progress" } });
    expect(calls).toBe(1);
    first.store.close();
    const second = await start(paths, T0);
    expect(rows(second.database)).toEqual({});
    const two = runner(second.store, second.retention, one.world);
    expect(await two.run.run(declared, one.operator, {}, key("k-1"))).toMatchObject({ ok: false, error: { category: "internal", effect: "not_started" } });
    expect(calls).toBe(2);
  });
});

describe("failure classes", () => {
  it("a key failure disables only keyed requests, with one bounded diagnostic and nothing on stdout", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    first.store.close();
    chmodSync(operationKeyPath(first.store.canonicalDatabasePath), 0o644);
    const stdout = vi.spyOn(process.stdout, "write");
    const second = await start(paths, T0);
    expect(second.retention).toBeNull();
    expect(second.log.controller.mock.calls).toEqual([["operations.retention_unavailable", { reason: "key_unavailable" }]]);
    expect(stdout).not.toHaveBeenCalled();
    const { run, operator, world } = runner(second.store, null);
    const { operation, log } = fakeStart(world);
    expect(await run.run(operation, operator, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "unavailable", reason: "idempotency_unavailable", effect: "not_started" } });
    expect(await run.run(operation, operator, input)).toMatchObject({ ok: true });
    expect(log.attempts).toBe(1);
    // Ordinary access is unaffected.
    expect(await second.store.admission.run(() => second.store.getAuthenticationPolicy().mode)).toBeTruthy();
  });

  it("a failure local to the records disables keyed requests; the store stays usable", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    insert(first.database, "own-reserved", fingerprintKeyId(first.retention!.fingerprintKey), "reserved", null);
    first.store.close();
    const store = open(paths);
    ownedFixtureDatabase(store).exec("CREATE TEMP TRIGGER refuse_repair BEFORE DELETE ON main.operation_idempotency BEGIN SELECT RAISE(ABORT,'local refusal'); END");
    const log = logs();
    expect(await initializeOperationRetention({ store, now: () => T0, logs: log })).toBeNull();
    expect(log.controller.mock.calls).toEqual([["operations.retention_unavailable", { reason: "repair_failed" }]]);
    expect(rows(ownedFixtureDatabase(store))).toMatchObject({ "own-reserved": { state: "reserved" } });
    expect(await store.admission.run(() => store.getAuthenticationPolicy().mode)).toBeTruthy();
  });

  it("a failed fence beside it keeps the store-wide refusal: initialization throws", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    first.store.close();
    const store = open(paths);
    // A change outside the owned connection, which the fence detects at its next execution.
    const outside = new Database(paths.databasePath);
    outside.exec("CREATE TABLE outside_change(x); DROP TABLE outside_change;");
    outside.close();
    const log = logs();
    await expect(initializeOperationRetention({ store, now: () => T0, logs: log })).rejects.toBeInstanceOf(SecurityFenceError);
    expect(log.controller).not.toHaveBeenCalled();
  });

  it("runs once per database owner", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    await expect(initializeOperationRetention({ store: first.store, now: () => T0, logs: logs() })).rejects.toThrow("once per database owner");
  });
});

describe("composition", () => {
  const options = (store: SqliteStateStore) => ({ store, activeMode: "token", now: () => T0, logs: logs(),
    projectReads: { placement: { statusSummary: () => ({ phase: "stopped" as const, worktreePath: null, startedAt: null }) }, git: { listTrees: async () => [], worktreeDirty: async () => false } },
    requestBudget: new AuthenticationRequestBudget(16, 4), provider: null,
    eligibility: { controllerEligible: () => true, providerSessionEligible: () => false }, listeners: { unix: () => true } });

  it("gives the store and key to the runner only, and keeps the registry at the four production operations", async () => {
    const paths = installation();
    const { store, retention } = await start(paths, T0);
    const built = buildOperationsRuntime({ ...options(store), retention });
    if (!built.supported) throw new Error("expected supported mode");
    expect([...built.registry.ids()].sort()).toEqual(["project.list", "project.status", "project.worktrees", "session.describe"]);
    expect("fingerprintKey" in built.runtime).toBe(false);
    expect("idempotency" in built.runtime).toBe(false);
    const key = Buffer.from(retention!.fingerprintKey).toString("hex");
    const seen = new Set<unknown>();
    const scan = (value: unknown, depth = 0): boolean => {
      if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);
      if (value instanceof Uint8Array) return Buffer.from(value).toString("hex") === key;
      return Object.values(value).some(item => scan(item, depth + 1));
    };
    expect(scan(built)).toBe(false);
  });

  it("an offline session describe creates no key and leaves the records as they are", async () => {
    const paths = installation();
    const first = await start(paths, T0);
    first.store.saveAuthenticationPolicy({ ...first.store.getAuthenticationPolicy(), mode: "token" }, "fixture", "fixture");
    insert(first.database, "own-reserved", fingerprintKeyId(first.retention!.fingerprintKey), "reserved", null);
    first.store.close();
    rmSync(operationKeyPath(first.store.canonicalDatabasePath));
    const lines: string[] = [];
    await runSessionDescribe(["describe"], paths, line => { lines.push(line); });
    expect(JSON.parse(lines[0])).toMatchObject({ listener: "offline" });
    expect(existsSync(operationKeyPath(first.store.canonicalDatabasePath))).toBe(false);
    const store = open(paths);
    expect(rows(ownedFixtureDatabase(store))).toMatchObject({ "own-reserved": { state: "reserved" } });
  });
});
