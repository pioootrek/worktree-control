import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSchema } from "@/server/infrastructure/sqlite/migrations";
import { OPERATION_IDEMPOTENCY_LIMITS, OperationIdempotencyQueries } from "@/server/infrastructure/sqlite/operation-idempotency-queries";
import { OperationError } from "../errors";
import type { EffectScope, MutationOperation, Receipt } from "../operation";
import { createWorld, FIXTURE_FINGERPRINT_KEY, P } from "../operations-fixture";
import { onProject } from "../requirements";
import { OperationRunner, type IdempotencyKey, type IdempotencyRecord } from "../runner";
import { fakeStart, input, key, projectA } from "../runner-fixture";
import { fingerprintKeyId, IDEMPOTENCY_RECORD_BYTES, SqliteIdempotencyStore, type IdempotencyStorePort } from "./sqlite-idempotency";

/**
 * D1b: the SQLite idempotency store (step 53) under its adapter, alone and
 * through the real runner. The connection is a raw in-memory database at the
 * supported schema; the fault matrix through the owned, fenced connection is in
 * `sqlite-idempotency.faults.test.ts`.
 */
const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const KEY_ID = fingerprintKeyId(FIXTURE_FINGERPRINT_KEY);
const FINGERPRINT = `hmac-sha256:v1:${"a".repeat(64)}`;
const OTHER_PRINT = `hmac-sha256:v1:${"b".repeat(64)}`;
const HORIZON = OPERATION_IDEMPOTENCY_LIMITS.horizonMs;
const RESOURCES = { registration: { ref: { kind: "registration", id: "reg-1" }, projectId: "project-a", version: 3, relation: null } };

function database(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  initializeSchema(db, true);
  return db;
}
function store(clock: { now: number }, port?: IdempotencyStorePort) {
  const db = database();
  const queries = new OperationIdempotencyQueries(db);
  return { db, queries, store: new SqliteIdempotencyStore({ port: port ?? queries, keyId: KEY_ID, now: () => clock.now }) };
}
const K = (idempotencyKey = "k-1", principal = "account:alice", operationId = "fixture.runtime_start"): IdempotencyKey => ({ operationId, principal, idempotencyKey });
const record = (state: IdempotencyRecord["state"], extra: Partial<IdempotencyRecord> = {}): IdempotencyRecord =>
  ({ attempt: "attempt-1", fingerprint: FINGERPRINT, resources: RESOURCES as never, state, ...extra });
const row = (db: Database.Database, idempotencyKey = "k-1") => db.prepare("SELECT * FROM operation_idempotency WHERE idempotency_key=?").get(idempotencyKey) as Record<string, unknown> | undefined;
const count = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM operation_idempotency").get() as { n: number }).n;
const reason = (call: () => unknown) => { try { call(); } catch (error) { return error instanceof OperationError ? `${error.category}/${error.reason}` : `untyped: ${(error as Error).message}`; } return "accepted"; };

/** Inserts `rows` synthetic records directly, valid for every CHECK, for capacity cases. */
function fill(db: Database.Database, rows: number, options: { principal?: (index: number) => string; state?: "completed" | "reserved" | "unknown"; charged?: number; expiresAt?: number | null; prefix?: string } = {}) {
  const insert = db.prepare(`INSERT INTO operation_idempotency(operation_id,principal,idempotency_key,attempt,key_id,fingerprint,state,resources_json,result_json,transitions_json,
    charged_bytes,created_at,updated_at,expires_at) VALUES('fixture.fill',?,?,'a',?,?,?,'{}',?,NULL,?,0,0,?)`);
  const state = options.state ?? "completed";
  db.transaction(() => {
    for (let index = 0; index < rows; index++) {
      insert.run(options.principal?.(index) ?? "account:filler", `${options.prefix ?? "f"}-${index}`, KEY_ID, FINGERPRINT, state, state === "completed" ? "1" : null,
        options.charged ?? 0, state === "reserved" ? null : options.expiresAt === undefined ? 10 * HORIZON : options.expiresAt);
    }
  })();
}

describe("SQLite idempotency store: transitions and copies", () => {
  it("reserves, starts and completes one attempt, returning fresh copies of JSON-domain values", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    expect(s.get(K())).toBeNull();
    s.put(K(), record("reserved"));
    expect(row(db)).toMatchObject({ state: "reserved", attempt: "attempt-1", key_id: KEY_ID, result_json: null, expires_at: null, charged_bytes: IDEMPOTENCY_RECORD_BYTES });
    s.put(K(), record("started"));
    expect(row(db)).toMatchObject({ state: "started", expires_at: null, charged_bytes: IDEMPOTENCY_RECORD_BYTES });
    const result = { pid: 1, nested: { list: [1, "two", null, true] } };
    s.put(K(), record("completed", { result }));
    const stored = row(db)!;
    expect(stored).toMatchObject({ state: "completed", expires_at: 1_000 + HORIZON, result_json: JSON.stringify(result) });
    expect(stored.charged_bytes).toBe(Buffer.byteLength(stored.resources_json as string) + Buffer.byteLength(stored.result_json as string));
    const first = s.get(K())!, second = s.get(K())!;
    expect(first).toEqual({ ...record("completed"), result });
    expect(first).not.toBe(second);
    (first.result as { nested: { list: unknown[] } }).nested.list.push("mutated");
    expect(s.get(K())!.result).toEqual(result);
    expect(Object.getPrototypeOf(first.result)).toBe(Object.prototype);
  });

  it("keeps SQL NULL, a retained JSON null and a removed transition slot distinct", () => {
    const { db, store: s } = store({ now: 5 });
    s.put(K(), record("reserved")); s.put(K(), record("started"));
    s.put(K(), record("completed", { result: null, transitions: { registration: null } }));
    expect(row(db)).toMatchObject({ result_json: "null", transitions_json: '{"registration":null}' });
    expect(s.get(K())).toEqual({ ...record("completed"), result: null, transitions: { registration: null } });
    s.put(K("k-2"), record("reserved"));
    expect(row(db, "k-2")).toMatchObject({ result_json: null, transitions_json: null });
    expect(s.get(K("k-2"))).toEqual(record("reserved"));
    expect("result" in s.get(K("k-2"))!).toBe(false);
  });

  it("qualifies every later write by the owning attempt and the state it follows", () => {
    const { db, store: s } = store({ now: 5 });
    s.put(K(), record("reserved"));
    expect(reason(() => s.put(K(), record("started", { attempt: "attempt-2" })))).toBe("internal/idempotency_attempt_mismatch");
    expect(reason(() => s.put(K(), record("completed", { result: 1 })))).toBe("internal/idempotency_attempt_mismatch");
    expect(row(db)).toMatchObject({ state: "reserved", attempt: "attempt-1" });
    // The runner's reserved → unknown path (a declared handler that never crossed).
    s.put(K(), record("unknown"));
    expect(row(db)).toMatchObject({ state: "unknown", result_json: null, expires_at: 5 + HORIZON });
    // A missing record: no write lands.
    expect(reason(() => s.put(K("absent"), record("started")))).toBe("internal/idempotency_attempt_mismatch");
    expect(count(db)).toBe(1);
    // A second reservation of an unexpired key is refused without a change.
    expect(reason(() => s.put(K(), record("reserved", { attempt: "attempt-3" })))).toBe("internal/idempotency_record_exists");
    expect(row(db)).toMatchObject({ state: "unknown", attempt: "attempt-1" });
  });

  it("decision Z: an unknown write replaces a completed one of the same attempt", () => {
    const { db, store: s } = store({ now: 5 });
    s.put(K(), record("reserved")); s.put(K(), record("started")); s.put(K(), record("completed", { result: { a: 1 } }));
    s.put(K(), record("unknown"));
    expect(row(db)).toMatchObject({ state: "unknown", result_json: null, transitions_json: null });
  });

  it("releases only a live attempt of its owner; a missing or foreign attempt is a no-op", () => {
    const { db, store: s } = store({ now: 5 });
    s.release(K(), "attempt-1");
    s.put(K(), record("reserved"));
    s.release(K(), "attempt-2");
    expect(row(db)).toMatchObject({ state: "reserved" });
    s.release(K(), "attempt-1");
    expect(row(db)).toBeUndefined();
    s.put(K(), record("reserved")); s.put(K(), record("started")); s.put(K(), record("completed", { result: 1 }));
    s.release(K(), "attempt-1");
    expect(row(db)).toMatchObject({ state: "completed" });
  });
});

describe("SQLite idempotency store: refusals before any change", () => {
  it("refuses put and release inside an open transaction of the shared connection", () => {
    const { db, store: s } = store({ now: 5 });
    s.put(K(), record("reserved"));
    db.transaction(() => {
      expect(reason(() => s.put(K("k-2"), record("reserved")))).toBe("internal/idempotency_in_transaction");
      expect(reason(() => s.put(K(), record("started")))).toBe("internal/idempotency_in_transaction");
      expect(reason(() => s.release(K(), "attempt-1"))).toBe("internal/idempotency_in_transaction");
    })();
    expect(row(db)).toMatchObject({ state: "reserved" });
    expect(count(db)).toBe(1);
  });

  it("refuses values outside the JSON domain and records above 256 KiB", () => {
    const { db, store: s } = store({ now: 5 });
    s.put(K(), record("reserved")); s.put(K(), record("started"));
    for (const result of [undefined, new Date(0), Number.NaN, () => 1, { toJSON: () => 1 }, 1n, Object.assign(Object.create({ inherited: 1 }), { a: 1 })]) {
      expect(reason(() => s.put(K(), record("completed", { result }))), String(result)).toBe("internal/idempotency_value_unsupported");
    }
    expect(reason(() => s.put(K(), record("completed", { result: "x".repeat(IDEMPOTENCY_RECORD_BYTES) })))).toBe("internal/idempotency_record_too_large");
    expect(reason(() => s.put(K("k-2"), record("reserved", { resources: { a: "x".repeat(IDEMPOTENCY_RECORD_BYTES) } as never })))).toBe("internal/idempotency_record_too_large");
    expect(row(db)).toMatchObject({ state: "started" });
    expect(count(db)).toBe(1);
    // -0 is normalized to 0 by the domain, as on release.
    s.put(K(), record("completed", { result: { value: -0 } }));
    expect(Object.is((s.get(K())!.result as { value: number }).value, 0)).toBe(true);
  });

  it("equals the SQLite side's record bound", () => {
    expect(IDEMPOTENCY_RECORD_BYTES).toBe(OPERATION_IDEMPOTENCY_LIMITS.recordBytes);
  });
});

describe("SQLite idempotency store: expiry", () => {
  it("reads a record as absent from its expiry instant on, and replaces it atomically on the next reservation", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    s.put(K(), record("reserved")); s.put(K(), record("started")); s.put(K(), record("completed", { result: 1 }));
    clock.now = 1_000 + HORIZON - 1;
    expect(s.get(K())).toMatchObject({ state: "completed" });
    clock.now = 1_000 + HORIZON;
    expect(s.get(K())).toBeNull();
    expect(count(db)).toBe(1);
    s.put(K(), record("reserved", { attempt: "attempt-2", fingerprint: OTHER_PRINT }));
    expect(row(db)).toMatchObject({ state: "reserved", attempt: "attempt-2", fingerprint: OTHER_PRINT, result_json: null });
    expect(count(db)).toBe(1);
  });

  it("never expires a live attempt, and sweeps at most 100 expired records per reservation", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    s.put(K(), record("reserved"));
    fill(db, 250, { expiresAt: 500 });
    clock.now = 100 * HORIZON;
    expect(s.get(K())).toMatchObject({ state: "reserved" });
    s.put(K("k-2"), record("reserved"));
    expect(count(db)).toBe(2 + 150);
    s.put(K("k-3"), record("reserved"));
    expect(count(db)).toBe(3 + 50);
  });
});

describe("SQLite idempotency store: sweep budget", () => {
  it("counts the replaced expired record of the requested key against the 100-record sweep", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    fill(db, 100, { expiresAt: 500 });
    s.put(K(), record("reserved")); s.put(K(), record("started")); s.put(K(), record("completed", { result: 1 }));
    clock.now = 1_000 + HORIZON;
    expect(count(db)).toBe(101);
    s.put(K(), record("reserved", { attempt: "attempt-2", fingerprint: OTHER_PRINT }));
    // 1 (the requested key) + 99 swept: one earlier expired filler and the new reservation remain.
    expect(count(db)).toBe(2);
    expect(row(db)).toMatchObject({ state: "reserved", attempt: "attempt-2" });
  });
});

describe("SQLite idempotency store: bounds without early eviction", () => {
  const capacity = (call: () => unknown) => reason(call);

  it("refuses a new reservation when its principal holds 1000 unexpired records; other principals and updates proceed", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    s.put(K("live", "account:alice"), record("reserved"));
    fill(db, 999, { principal: () => "account:alice" });
    expect(capacity(() => s.put(K("k-new", "account:alice"), record("reserved", { attempt: "attempt-9" })))).toBe("busy/idempotency_capacity");
    expect(count(db)).toBe(1000);
    s.put(K("k-new", "account:bob"), record("reserved"));
    // Updates and owner releases at capacity.
    s.put(K("live", "account:alice"), record("started"));
    s.put(K("live", "account:alice"), record("completed", { result: { ok: true } }));
    expect(row(db, "live")).toMatchObject({ state: "completed" });
    // Expired records do not count.
    db.prepare("UPDATE operation_idempotency SET expires_at=? WHERE idempotency_key='f-0'").run(clock.now);
    s.put(K("k-new", "account:alice"), record("reserved", { attempt: "attempt-9" }));
    expect(row(db, "k-new")).toBeDefined();
  });

  it("refuses a new reservation when the store holds 10,000 unexpired records", () => {
    const { db, store: s } = store({ now: 1_000 });
    fill(db, 10_000, { principal: index => `account:p${index % 20}` });
    expect(capacity(() => s.put(K("k", "operator"), record("reserved")))).toBe("busy/idempotency_capacity");
    expect(count(db)).toBe(10_000);
  });

  it("charges 256 KiB per live attempt against 64 MiB, so a completion is never refused for bytes", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    // A nearly full store: 64 MiB minus 16 KiB charged by terminal records.
    const terminal = OPERATION_IDEMPOTENCY_LIMITS.bytes - 16 * 1024;
    fill(db, 256, { charged: Math.floor(terminal / 256) });
    fill(db, 1, { charged: terminal - 256 * Math.floor(terminal / 256), prefix: "rest" });
    expect(capacity(() => s.put(K("small"), record("reserved")))).toBe("busy/idempotency_capacity");
    db.prepare("DELETE FROM operation_idempotency").run();
    // Overlapping live attempts: 256 reservations fill 64 MiB exactly.
    const keys = Array.from({ length: 256 }, (_, index) => K(`live-${index}`, `account:p${index % 8}`));
    for (const each of keys) s.put(each, record("reserved"));
    expect(capacity(() => s.put(K("one-more", "operator"), record("reserved")))).toBe("busy/idempotency_capacity");
    // Each live attempt completes at capacity with a result close to the per-record bound.
    s.put(keys[0], record("started"));
    s.put(keys[0], record("completed", { result: "x".repeat(IDEMPOTENCY_RECORD_BYTES - 1_000) }));
    // Its actual size replaces the charge: still too little headroom for another attempt.
    expect(capacity(() => s.put(K("one-more", "operator"), record("reserved")))).toBe("busy/idempotency_capacity");
    s.put(keys[1], record("started")); s.put(keys[1], record("completed", { result: 1 }));
    s.put(K("one-more", "operator"), record("reserved"));
    // Release and expiry give the charge back.
    s.release(keys[2], "attempt-1");
    s.put(K("two-more", "operator"), record("reserved"));
    expect(capacity(() => s.put(K("three-more", "operator"), record("reserved")))).toBe("busy/idempotency_capacity");
  });
});

describe("SQLite idempotency store: stored values that cannot be decoded", () => {
  it("answers internal/invalid_idempotency_record for an oversized, too deep, prototype-carrying or foreign-shaped value, never a miss", () => {
    const clock = { now: 1_000 };
    const { db, store: s } = store(clock);
    s.put(K(), record("reserved")); s.put(K(), record("started")); s.put(K(), record("completed", { result: 1 }));
    const deep = `${"[".repeat(40)}1${"]".repeat(40)}`;
    for (const value of [JSON.stringify("x".repeat(IDEMPOTENCY_RECORD_BYTES)), deep, '{"__proto__":{"polluted":true}}']) {
      db.prepare("UPDATE operation_idempotency SET result_json=?").run(value);
      expect(reason(() => s.get(K())), value.slice(0, 20)).toBe("internal/invalid_idempotency_record");
    }
  });
});

/** A small installation over the real adapter. */
function runnerWorld(options: { port?: (queries: OperationIdempotencyQueries) => IdempotencyStorePort } = {}) {
  const world = createWorld();
  world.resolver.addProject(projectA).put({ kind: "registration", id: "reg-1" }, projectA);
  const alice = world.human("alice");
  world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
  const db = database();
  const queries = new OperationIdempotencyQueries(db);
  const idempotency = new SqliteIdempotencyStore({ port: options.port?.(queries) ?? queries, keyId: KEY_ID, now: () => world.clock.now });
  const runner = new OperationRunner(world.runtime({ idempotency }));
  return { world, alice, db, queries, idempotency, runner };
}

describe("the runner over the SQLite store: the answer table", () => {
  it("runs fresh without a record, replays completed, and answers conflict, in-progress and unknown from the stored state", async () => {
    const { world, alice, db, runner } = runnerWorld();
    const { operation, log } = fakeStart(world);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: false });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: true });
    expect(await runner.run(operation, alice.context, { ...input, note: "different" }, key("k-1")))
      .toMatchObject({ ok: false, error: { category: "conflict", reason: "idempotency_conflict", effect: "not_started" } });
    const fingerprint = (row(db, "k-1") as { fingerprint: string }).fingerprint;
    for (const [state, expected] of [
      ["reserved", { category: "conflict", reason: "request_in_progress" }],
      ["started", { category: "conflict", reason: "request_in_progress" }],
      ["unknown", { category: "outcome_unknown", reason: "previous_attempt_outcome_unknown", effect: "unknown" }],
    ] as const) {
      db.prepare(`INSERT INTO operation_idempotency(operation_id,principal,idempotency_key,attempt,key_id,fingerprint,state,resources_json,charged_bytes,created_at,updated_at,expires_at)
        SELECT operation_id,principal,?,attempt,key_id,fingerprint,?,resources_json,0,created_at,updated_at,? FROM operation_idempotency WHERE idempotency_key='k-1'`)
        .run(`k-${state}`, state, state === "unknown" ? world.clock.now + HORIZON : null);
      expect((row(db, `k-${state}`) as { fingerprint: string }).fingerprint).toBe(fingerprint);
      expect(await runner.run(operation, alice.context, input, key(`k-${state}`)), state).toMatchObject({ ok: false, error: expected });
    }
    expect(log.effects).toEqual(["start project-a"]);
  });

  it("re-decides a replay: not_found without access, resource_changed after a move", async () => {
    const { world, alice, runner } = runnerWorld();
    const { operation, log } = fakeStart(world);
    await runner.run(operation, alice.context, input, key("k-1"));
    world.resolver.addProject(P("project-b"));
    world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: P("project-b") } });
    world.resolver.move({ kind: "registration", id: "reg-1" }, P("project-b"));
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "conflict", reason: "resource_changed" } });
    world.resolver.move({ kind: "registration", id: "reg-1" }, projectA);
    world.grants.revokeAll(alice.id);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "not_found" } });
    expect(log.effects).toHaveLength(1);
  });

  it("answers internal/invalid_idempotency_record for an actual malformed stored value", async () => {
    const { world, alice, db, runner } = runnerWorld();
    const { operation, log } = fakeStart(world);
    await runner.run(operation, alice.context, input, key("k-1"));
    db.prepare("UPDATE operation_idempotency SET result_json=?").run(`${"[".repeat(40)}1${"]".repeat(40)}`);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "internal", status: 500, reason: "invalid_idempotency_record", retry: "none", effect: "not_started" } });
    db.prepare("UPDATE operation_idempotency SET result_json='{}',resources_json='\"not resources\"'").run();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "internal", reason: "invalid_idempotency_record" } });
    expect(log.effects).toHaveLength(1);
  });

  it("refuses a reservation of a full store as busy/idempotency_capacity, retry, not_started, with no handler call and other rows intact", async () => {
    const { world, alice, db, runner } = runnerWorld();
    const { operation, log } = fakeStart(world);
    fill(db, 1000, { principal: () => `account:${alice.id}`, expiresAt: world.clock.now + HORIZON });
    const before = db.prepare("SELECT * FROM operation_idempotency ORDER BY idempotency_key").all();
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: false, error: {
      category: "busy", status: 503, reason: "idempotency_capacity", retry: "retry", effect: "not_started" } });
    expect(log.attempts).toBe(0);
    expect(log.lockReleases).toBe(0);
    expect(db.prepare("SELECT * FROM operation_idempotency ORDER BY idempotency_key").all()).toEqual(before);
    // Without a key the operation still runs.
    expect(await runner.run(operation, alice.context, input)).toMatchObject({ ok: true });
  });

  it("keeps accounts apart and shares one space per installation and per operator actor", async () => {
    const { world, alice, db, runner } = runnerWorld();
    const { operation, log } = fakeStart(world);
    const bob = world.human("bob");
    world.grants.grant({ accountId: bob.id, role: "operator", scope: { kind: "project", projectId: projectA } });
    expect(await runner.run(operation, alice.context, input, key("shared"))).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, bob.context, input, key("shared"))).toMatchObject({ ok: true, replayed: false });
    const first = world.installation(), second = world.installation("api");
    expect(await runner.run(operation, first.context, input, key("shared"))).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, second.context, input, key("shared"))).toMatchObject({ ok: true, replayed: true });
    expect(await runner.run(operation, world.operator(), input, key("shared"))).toMatchObject({ ok: true, replayed: false });
    expect(await runner.run(operation, world.operator(), input, key("shared"))).toMatchObject({ ok: true, replayed: true });
    expect(log.effects).toHaveLength(4);
    expect((db.prepare("SELECT principal FROM operation_idempotency ORDER BY principal").all() as Array<{ principal: string }>).map(entry => entry.principal))
      .toEqual([`account:${alice.id}`, `account:${bob.id}`, "installation", "operator"]);
  });
});

interface Negative { value: number }
const negativeZero = (counter: { runs: number }): MutationOperation<Record<string, never>, Negative, { negative: boolean }> => ({
  id: "fixture.negative_zero", kind: "mutation",
  requirement: { require: onProject("runtime:control", "registration") },
  parse: () => ({}), resources: () => ({ registration: { kind: "registration", id: "reg-1" } }),
  effect: { mode: "admitted", run: () => { counter.runs++; return { value: -0 }; } },
  retain: true, publicKeys: ["negative"],
  project: result => ({ negative: Object.is(result.value, -0) }),
});

describe("the runner over the SQLite store: equivalent first release and replay", () => {
  it("projects the normalized result on the first release, so -0 releases as on replay", async () => {
    const { alice, runner } = runnerWorld();
    const counter = { runs: 0 };
    const operation = negativeZero(counter);
    const first = await runner.run(operation, alice.context, {}, key("k-1"));
    const replay = await runner.run(operation, alice.context, {}, key("k-1"));
    expect(first).toEqual({ ok: true, value: { negative: false }, replayed: false });
    expect(replay).toEqual({ ok: true, value: { negative: false }, replayed: true });
    expect(counter.runs).toBe(1);
  });

  it("a result outside the JSON domain retains nothing: unknown, cleanup_unconfirmed, then outcome_unknown", async () => {
    const { alice, db, runner } = runnerWorld();
    const counter = { runs: 0 };
    const operation = { ...negativeZero(counter), effect: { mode: "admitted" as const, run: () => { counter.runs++; return { value: 1, at: new Date(0) } as unknown as Negative; } } };
    expect(await runner.run(operation, alice.context, {}, key("k-1"))).toMatchObject({ ok: false, error: { reason: "finalization_unconfirmed", effect: "cleanup_unconfirmed" } });
    expect(row(db)).toMatchObject({ state: "unknown", result_json: null });
    expect(await runner.run(operation, alice.context, {}, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown" } });
    expect(counter.runs).toBe(1);
  });
});

describe("the runner over the SQLite store: transitions, failures and projections", () => {
  const detach = (world: ReturnType<typeof createWorld>): MutationOperation<{ registrationId: string }, { registrationId: string }, { registrationId: string }> => ({
    id: "fixture.registration_detach", kind: "mutation",
    requirement: { require: onProject("runtime:control", "registration") },
    parse: raw => ({ registrationId: String((raw as { registrationId: string }).registrationId) }),
    resources: value => ({ registration: { kind: "registration", id: value.registrationId } }),
    transitions: ["registration"],
    effect: { mode: "admitted", run: (value, scope: EffectScope) => {
      world.resolver.delete({ kind: "registration", id: "reg-1" });
      scope.transition("registration", { kind: "removed" });
      return { registrationId: value.registrationId };
    } },
    retain: true, publicKeys: ["registrationId"], project: result => result,
  });

  it("retains a removed transition slot as a JSON null and replays it", async () => {
    const { world, alice, db, runner } = runnerWorld();
    const operation = detach(world);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: true, value: input, replayed: false });
    expect(row(db)).toMatchObject({ state: "completed", transitions_json: '{"registration":null}' });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toEqual({ ok: true, value: input, replayed: true });
    world.resolver.put({ kind: "registration", id: "reg-1" }, projectA);
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { reason: "resource_changed" } });
  });

  it("decision Z double failure leaves started; the next start turns it into unknown", async () => {
    const failing = new Set<string>();
    const { world, alice, db, queries, runner } = runnerWorld({ port: queries => ({
      inTransaction: () => queries.inTransaction(), read: (k, now) => queries.read(k, now), reserve: value => queries.reserve(value),
      release: (k, attempt) => queries.release(k, attempt),
      advance: value => { if (failing.has(value.state)) throw new Error("store write failed /secret"); return queries.advance(value); },
    }) });
    const { operation, log } = fakeStart(world);
    failing.add("completed"); failing.add("unknown");
    const first = await runner.run(operation, alice.context, input, key("k-1"));
    expect(first).toMatchObject({ ok: false, error: { reason: "finalization_unconfirmed", effect: "cleanup_unconfirmed", retry: "inspect_first" } });
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(row(db)).toMatchObject({ state: "started" });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { reason: "request_in_progress" } });
    queries.repair({ now: world.clock.now, keyId: KEY_ID });
    expect(row(db)).toMatchObject({ state: "unknown", expires_at: world.clock.now + HORIZON });
    expect(await runner.run(operation, alice.context, input, key("k-1"))).toMatchObject({ ok: false, error: { category: "outcome_unknown" } });
    expect(log.effects).toHaveLength(1);
  });

  it("a projection failure after completion keeps the completed record, and the retry replays it", async () => {
    const { world, alice, db, runner } = runnerWorld();
    const { operation, log } = fakeStart(world);
    let fail = true;
    const projecting = { ...operation, project: (result: { projectId: string | null }) => { if (fail) { fail = false; throw new Error("projection failed /secret"); } return { projectId: result.projectId, started: true }; } };
    const first = await runner.run(projecting as typeof operation, alice.context, input, key("k-1"));
    expect(first).toMatchObject({ ok: false, error: { category: "internal", effect: "committed" } });
    expect(row(db)).toMatchObject({ state: "completed" });
    expect(await runner.run(projecting as typeof operation, alice.context, input, key("k-1"))).toEqual({ ok: true, value: { projectId: projectA, started: true }, replayed: true });
    expect(log.effects).toHaveLength(1);
  });
});

describe("the runner over the SQLite store: secret-bearing receipts", () => {
  const TOKEN = "wct_live_6f1d9c8e2b7a4c3d";
  const PASSWORD = "correct horse battery staple";
  type Issued = { accountId: string; tokenId: string; revision: number; token: string };
  const issue = (counter: { issued: number }): MutationOperation<{ accountId: string; password: string }, Issued, { accountId: string; tokenId: string; revision: number; token?: string }> => ({
    id: "fixture.token_issue", kind: "mutation",
    requirement: { require: onProject("runtime:control", "registration") },
    parse: raw => ({ accountId: String((raw as { accountId: string }).accountId), password: String((raw as { password: string }).password) }),
    resources: () => ({ registration: { kind: "registration", id: "reg-1" } }),
    effect: { mode: "admitted", run: value => { counter.issued++; return { accountId: value.accountId, tokenId: `token-${counter.issued}`, revision: counter.issued, token: TOKEN }; } },
    retain: true,
    secret: {
      receipt: (result: Issued) => ({ accountId: result.accountId, tokenId: result.tokenId, revision: result.revision }),
      projectReceipt: (value: Receipt) => ({ accountId: String(value.accountId), tokenId: String(value.tokenId), revision: Number(value.revision) }),
    } as never,
    publicKeys: ["accountId", "tokenId", "revision", "token"],
    project: result => ({ accountId: result.accountId, tokenId: result.tokenId, revision: result.revision, token: result.token }),
  });

  it("stores only the receipt, never the input or the secret output, in the row and in a copy of the database, and replays the receipt", async () => {
    const { alice, db, runner } = runnerWorld();
    const counter = { issued: 0 };
    const operation = issue(counter);
    const raw = { accountId: "agent-1", password: PASSWORD };
    expect(await runner.run(operation, alice.context, raw, key("k-1"))).toEqual({ ok: true, value: { accountId: "agent-1", tokenId: "token-1", revision: 1, token: TOKEN }, replayed: false });
    const stored = row(db)!;
    expect(JSON.parse(stored.result_json as string)).toEqual({ accountId: "agent-1", tokenId: "token-1", revision: 1 });
    const image = db.serialize().toString("latin1");
    for (const secret of [TOKEN, PASSWORD]) {
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(image).not.toContain(secret);
    }
    expect(await runner.run(operation, alice.context, raw, key("k-1"))).toEqual({ ok: true, value: { accountId: "agent-1", tokenId: "token-1", revision: 1 }, replayed: true });
    expect(counter.issued).toBe(1);
  });
});
