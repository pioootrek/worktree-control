import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppPaths, type AppPaths } from "@/server/paths";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { initializeOperationRetention } from "./operation-retention";
import { maintainSecurityFence } from "./security-maintenance";
import { applyUpgrade, inspectUpgrade } from "./upgrade-maintenance";
import { ownedFixtureDatabase, unmanagedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import type { EffectScope, MutationOperation } from "@/server/modules/operations/operation";
import { createWorld } from "@/server/modules/operations/operations-fixture";
import { onProject } from "@/server/modules/operations/requirements";
import { OperationRunner, type RunResult } from "@/server/modules/operations/runner";
import { key, projectA } from "@/server/modules/operations/runner-fixture";

/**
 * D1b decision 7 and amendment A4: fault injection through the real,
 * file-backed and fenced store facade. Each case writes through the real
 * adapter on a disposable owner and injects at one transition:
 *
 * - `before`: the write's statement is refused by SQLite before it changes
 *   anything (a BEFORE trigger); the fence stays healthy;
 * - `inner`: the security fence's image stamp fails after an inner statement,
 *   while the write's transaction can still roll back; the fence latches;
 * - `after`: the stamp fails after the write's own transaction committed (a
 *   landed write whose acknowledgement throws); the fence latches.
 *
 * Then the owner is closed and the database reopened as the next controller
 * start does (with its repair), and the first caller's answer, the durable
 * record and the retry's answer are compared with decision Z.
 */
const injection = vi.hoisted(() => ({ path: "", armed: null as null | "inner" | "after", inTransaction: (): boolean => false, fired: 0 }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((path: unknown, ...rest: unknown[]) => {
    if (injection.armed && path === injection.path && (injection.armed === "inner") === injection.inTransaction()) {
      injection.armed = null; injection.fired++;
      throw Object.assign(new Error("EIO: injected image stamp failure"), { code: "EIO" });
    }
    return (actual.lstatSync as (...values: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync, default: { ...actual, lstatSync } };
});

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  injection.armed = null; injection.path = ""; injection.fired = 0; injection.inTransaction = () => false;
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* a latched owner may refuse */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function installation(): AppPaths {
  const root = mkdtempSync(join(tmpdir(), "idempotency-faults-"));
  roots.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}
type Point = "reserved" | "started" | "completed" | "unknown" | "release";
type Mode = "before" | "inner" | "after";

/** Opens the owner as the controller does and installs the one-shot injection for `point`. */
async function owner(paths: AppPaths, world: ReturnType<typeof createWorld>, inject?: { point: Point; mode: Mode }) {
  const store = new SqliteStateStore(paths.databasePath);
  closers.push(() => store.close());
  const retention = await initializeOperationRetention({ store, now: () => world.clock.now, logs: { controller: () => undefined } });
  if (!retention) throw new Error("retention unavailable");
  const database = ownedFixtureDatabase(store);
  if (inject) {
    let pending = true;
    const target = (transition: string) => pending && transition === inject.point;
    database.function("test_fail", (transition: unknown) => { if (inject.mode !== "before" || !target(String(transition))) return 0; pending = false; return 1; });
    database.function("test_arm", (transition: unknown) => {
      if (inject.mode === "before" || !target(String(transition))) return 0;
      pending = false; injection.armed = inject.mode; return 0;
    });
    injection.path = store.canonicalDatabasePath;
    injection.inTransaction = () => database.inTransaction;
    database.exec(`
      CREATE TEMP TRIGGER fault_insert_before BEFORE INSERT ON main.operation_idempotency WHEN test_fail(NEW.state) BEGIN SELECT RAISE(ABORT,'injected'); END;
      CREATE TEMP TRIGGER fault_update_before BEFORE UPDATE ON main.operation_idempotency WHEN test_fail(NEW.state) BEGIN SELECT RAISE(ABORT,'injected'); END;
      CREATE TEMP TRIGGER fault_delete_before BEFORE DELETE ON main.operation_idempotency WHEN test_fail('release') BEGIN SELECT RAISE(ABORT,'injected'); END;
      CREATE TEMP TRIGGER fault_insert_after AFTER INSERT ON main.operation_idempotency BEGIN SELECT test_arm(NEW.state); END;
      CREATE TEMP TRIGGER fault_update_after AFTER UPDATE ON main.operation_idempotency BEGIN SELECT test_arm(NEW.state); END;
      CREATE TEMP TRIGGER fault_delete_after AFTER DELETE ON main.operation_idempotency BEGIN SELECT test_arm('release'); END;`);
  }
  const runner = new OperationRunner({ ...world.runtime({ idempotency: retention.idempotency, fingerprintKey: retention.fingerprintKey }), admission: store.admission });
  const record = () => {
    // Read on the raw file after the owner closed, so a latched fence cannot hide the durable row.
    return () => (database.prepare("SELECT state FROM operation_idempotency").get() as { state: string } | undefined)?.state ?? "none";
  };
  return { store, runner, database, record: record() };
}

interface Counters { effects: number }
/** `entry` admitted effect; `throws` past the commit point (unknown outcome); `declared` refuses before its commit point. */
function operation(kind: "entry" | "throws" | "declared", counters: Counters): MutationOperation<Record<string, never>, { value: number }, { value: number }> {
  return {
    id: "fixture.fault_write", kind: "mutation",
    requirement: { require: onProject("runtime:control", "registration") },
    parse: () => ({}), resources: () => ({ registration: { kind: "registration", id: "reg-1" } }),
    effect: kind === "declared"
      ? { mode: "admitted", commitPoint: "declared", run: (_input, _scope: EffectScope) => { counters.effects++; throw new Error("refused before commit /secret"); } }
      : { mode: "admitted", run: () => { counters.effects++; if (kind === "throws") throw new Error("effect failed /secret"); return { value: 1 }; } },
    retain: true, publicKeys: ["value"], project: result => ({ value: result.value }),
  };
}

const summary = (result: RunResult<unknown>) => result.ok ? (result.replayed ? "replay" : "fresh") : `${result.error.category}/${result.error.effect}`;

/**
 * Decision Z, row by row: [point, mode] → the first caller's effect state, the
 * durable record before the reopen, after the reopen's repair, and the retry's
 * answer after the reopen.
 */
const MATRIX: ReadonlyArray<{ point: Point; mode: Mode; first: string; before: string; after: string; retry: string; latched: boolean }> = [
  { point: "reserved", mode: "before", first: "internal/not_started", before: "none", after: "none", retry: "fresh", latched: false },
  { point: "reserved", mode: "inner", first: "internal/not_started", before: "none", after: "none", retry: "fresh", latched: true },
  { point: "reserved", mode: "after", first: "internal/not_started", before: "reserved", after: "none", retry: "fresh", latched: true },
  { point: "started", mode: "before", first: "internal/not_started", before: "none", after: "none", retry: "fresh", latched: false },
  { point: "started", mode: "inner", first: "internal/not_started", before: "reserved", after: "none", retry: "fresh", latched: true },
  { point: "started", mode: "after", first: "internal/not_started", before: "started", after: "unknown", retry: "outcome_unknown/unknown", latched: true },
  { point: "completed", mode: "before", first: "unavailable/cleanup_unconfirmed", before: "unknown", after: "unknown", retry: "outcome_unknown/unknown", latched: false },
  { point: "completed", mode: "inner", first: "unavailable/cleanup_unconfirmed", before: "started", after: "unknown", retry: "outcome_unknown/unknown", latched: true },
  { point: "completed", mode: "after", first: "unavailable/cleanup_unconfirmed", before: "completed", after: "completed", retry: "replay", latched: true },
  { point: "unknown", mode: "before", first: "outcome_unknown/unknown", before: "unknown", after: "unknown", retry: "outcome_unknown/unknown", latched: false },
  { point: "unknown", mode: "inner", first: "outcome_unknown/unknown", before: "started", after: "unknown", retry: "outcome_unknown/unknown", latched: true },
  { point: "unknown", mode: "after", first: "outcome_unknown/unknown", before: "unknown", after: "unknown", retry: "outcome_unknown/unknown", latched: true },
  { point: "release", mode: "before", first: "internal/not_started", before: "reserved", after: "none", retry: "internal/not_started", latched: false },
  { point: "release", mode: "inner", first: "internal/not_started", before: "reserved", after: "none", retry: "internal/not_started", latched: true },
  { point: "release", mode: "after", first: "internal/not_started", before: "none", after: "none", retry: "internal/not_started", latched: true },
];

describe("idempotency writes through the real facade: decision Z", () => {
  it.each(MATRIX)("$point $mode: first $first, durable $before → $after, retry $retry", async row => {
    const paths = installation();
    const world = createWorld();
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const operator = world.operator();
    const counters: Counters = { effects: 0 };
    const kind = row.point === "unknown" ? "throws" : row.point === "release" ? "declared" : "entry";
    const first = await owner(paths, world, { point: row.point, mode: row.mode });
    const answer = await first.runner.run(operation(kind, counters), operator, {}, key("k-1"));
    expect(summary(answer)).toBe(row.first);
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect(injection.fired).toBe(row.mode === "before" ? 0 : 1);
    // A latched fence refuses every later call on this owner; a healthy one still answers.
    if (row.latched) expect(() => first.store.getAuthenticationPolicy()).toThrow(/security_fence/);
    else expect(first.record()).toBe(row.before);
    const effectsBefore = counters.effects;
    expect(effectsBefore).toBe(row.point === "reserved" || row.point === "started" ? 0 : 1);
    first.store.close();
    // The durable record, read without an owner's fence (read-only, after the close).
    const raw = new Database(paths.databasePath, { readonly: true });
    try { expect((raw.prepare("SELECT state FROM operation_idempotency").get() as { state: string } | undefined)?.state ?? "none").toBe(row.before); } finally { raw.close(); }
    // The next controller start: an ordinary reopen (the fence was never told about this unfenced write), then the repair.
    const second = await owner(paths, world);
    expect(second.record()).toBe(row.after);
    const retry = await second.runner.run(operation(kind, counters), operator, {}, key("k-1"));
    expect(summary(retry)).toBe(row.retry);
    expect(counters.effects - effectsBefore).toBe(row.retry === "fresh" || (row.point === "release") ? 1 : 0);
  });
});

describe("a landed write whose acknowledgement threw, then a recovery", () => {
  it("is invalidated by the quarantine when the reopen requires one: the retry answers outcome_unknown", async () => {
    const paths = installation();
    // The quarantine and the upgrade use the wall clock; the runtime clock follows it here.
    const world = createWorld({ now: Date.now() });
    world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
    const operator = world.operator(), counters: Counters = { effects: 0 };
    const first = await owner(paths, world, { point: "completed", mode: "after" });
    expect(summary(await first.runner.run(operation("entry", counters), operator, {}, key("k-1")))).toBe("unavailable/cleanup_unconfirmed");
    first.store.close();
    // An outside change the fence detects at the next opening, so ordinary access needs the recovery.
    const outside = unmanagedFixtureDatabase(paths.databasePath);
    try {
      expect(outside.prepare("SELECT state FROM operation_idempotency").pluck().get()).toBe("completed");
      outside.prepare("UPDATE security_checkpoint SET epoch=lower(hex(randomblob(32)))").run();
    } finally { outside.close(); }
    expect(() => new SqliteStateStore(paths.databasePath)).toThrow(/security_fence_recovery_required/);
    const status = maintainSecurityFence(paths, { action: "inspect" });
    maintainSecurityFence(paths, { action: "resume", expect: status.preflight, mode: "token" });
    const inspection = inspectUpgrade(paths);
    await applyUpgrade(paths, { expect: inspection.planHash! }, { directory: join(paths.dataDirectory, "..", "maintenance"), applicationVersion: "test" });
    const second = await owner(paths, world);
    expect(second.record()).toBe("unknown");
    expect(summary(await second.runner.run(operation("entry", counters), operator, {}, key("k-1")))).toBe("outcome_unknown/unknown");
    expect(counters.effects).toBe(1);
  }, 30_000);
});
