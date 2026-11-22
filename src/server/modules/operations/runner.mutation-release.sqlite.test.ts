import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicOperationError } from "@/shared/contracts/operations";
import { initializeOperationRetention } from "@/server/bootstrap/operation-retention";
import { SqliteStateStore } from "@/server/infrastructure/sqlite/sqlite-state-store";
import { resolveAppPaths, type AppPaths } from "@/server/paths";
import { ownedFixtureDatabase } from "@/server/unmanaged-sqlite-fixture";
import { OperationError } from "./errors";
import type { AdmittedCommitScope, MutationOperation } from "./operation";
import { createWorld } from "./operations-fixture";
import { onProject } from "./requirements";
import { OperationRunner, type MutationReleaseOptions } from "./runner";
import { answer, projectA, projectB, REGISTRATION } from "./runner-fixture";

/**
 * D2b-1 decision 4 over the real SQLite store and the real connection gate,
 * for the rows `operation-retention.faults.test.ts` does not reach: existing
 * records, the release policy before and after the effect, a fresh denial, an
 * unconfirmed transition, a failed refusal delivery, a denied replay and a
 * release the store refuses inside an open transaction (amendment C2).
 *
 * The owner runs with strict admission, as the controller does once bootstrap
 * is done: every statement outside an admitted operation is refused. Each
 * delivery callback observes, at the moment it is called, the gate's count of
 * admitted participants, the records read through that gate (a read that only
 * an admitted callback can make) and whether a transaction is open. The
 * negative control at the end shows the same observation outside admission.
 * Every answer is compared with its five public fields; the durable record is
 * read before the reopen and after the next start's repair, and the retry's
 * answer after it.
 */

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type World = ReturnType<typeof createWorld>;
type Value = { value: number };
interface Observed { active: number; records: string[] | string; inTransaction: boolean }
const inside = (records: string[], inTransaction = false): Observed => ({ active: 1, records, inTransaction });

function installation(): AppPaths {
  const root = mkdtempSync(join(tmpdir(), "mutation-release-sqlite-"));
  roots.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}

async function owner(paths: AppPaths, world: World) {
  const store = new SqliteStateStore(paths.databasePath);
  closers.push(() => store.close());
  const retention = await initializeOperationRetention({ store, now: () => world.clock.now, logs: { controller: () => undefined } });
  if (!retention) throw new Error("retention unavailable");
  // From here every statement needs an admitted operation of the real gate.
  store.requireAdmission();
  const database = ownedFixtureDatabase(store);
  const runner = new OperationRunner({ ...world.runtime({ idempotency: retention.idempotency, fingerprintKey: retention.fingerprintKey }), admission: store.admission });
  const states = (): string[] => (database.prepare("SELECT state FROM operation_idempotency").all() as { state: string }[]).map(row => row.state);
  const observe = (): Observed => {
    let records: string[] | string;
    try { records = states(); } catch (error) { records = `refused:${String((error as { code?: unknown }).code)}`; }
    return { active: store.admissionSnapshot().coreActive, records, inTransaction: database.inTransaction };
  };
  /** Every column of every record, read in a fresh admission. */
  const rows = () => store.admission.run(() => database.prepare("SELECT * FROM operation_idempotency").all());
  const recorded = () => store.admission.run(states);
  return { store, runner, database, observe, rows, recorded };
}
type Owner = Awaited<ReturnType<typeof owner>>;

interface Hooks { before?: () => void; after?: () => void; finalize?: () => void; project?: () => void; transition?: boolean }
/** An admitted write with a declared commit point; with `transition`, it reports its registration removed while it still resolves. */
function write(counters: { effects: number }, hooks: Hooks): MutationOperation<{ n: number }, { n: number }, Value> {
  return {
    id: hooks.transition ? "fixture.sqlite_release_detach" : "fixture.sqlite_release_write", kind: "mutation",
    requirement: { require: onProject("runtime:control", "registration") },
    parse: raw => {
      const n = (raw as { n?: unknown } | null)?.n;
      if (typeof n !== "number") throw new Error("n must be a number");
      return { n };
    },
    resources: () => ({ registration: { ...REGISTRATION } }),
    ...(hooks.transition ? { transitions: ["registration"] } : {}),
    effect: { mode: "admitted", commitPoint: "declared", run: (value: { n: number }, scope: AdmittedCommitScope) => {
      counters.effects++;
      hooks.before?.();
      scope.commit();
      if (hooks.transition) scope.transition("registration", { kind: "removed" });
      hooks.after?.();
      return { n: value.n };
    } },
    finalize: () => { hooks.finalize?.(); },
    retain: true, publicKeys: ["value"],
    project: result => { hooks.project?.(); return { value: result.n }; },
  };
}

interface Written { kind: "commit" | "refuse"; value: unknown; observed: Observed }

async function start() {
  const paths = installation();
  const world = createWorld();
  world.resolver.addProject(projectA).addProject(projectB).put(REGISTRATION, projectA);
  const alice = world.human("alice");
  const grant = () => world.grants.grant({ accountId: alice.id, role: "operator", scope: { kind: "project", projectId: projectA } });
  grant();
  const counters = { effects: 0 };
  const state = { paths, world, alice, grant, counters, current: await owner(paths, world) as Owner };
  /** One `mutationRelease` call; `failing` makes that callback record its observation and then throw. */
  const release = async (hooks: Hooks = {}, raw: unknown = { n: 1 }, extra: Partial<MutationReleaseOptions<Value>> = {}, failing?: "commit" | "refuse") => {
    const target = state.current;
    const writes: Written[] = [];
    const record = (kind: Written["kind"], value: unknown) => {
      writes.push({ kind, value: structuredClone(value), observed: target.observe() });
      if (failing === kind) throw new Error("socket gone /secret");
    };
    const options: MutationReleaseOptions<Value> = {
      eligible: () => true, connected: () => true, deadline: Number.MAX_SAFE_INTEGER, idempotencyKey: "k-1",
      commit(value) { record("commit", value); }, refuse(error) { record("refuse", error); },
      ...extra,
    };
    const result = await target.runner.mutationRelease(write(counters, hooks), alice.context, raw, options);
    return { result, writes, options };
  };
  const reopen = async () => { state.current.store.close(); state.current = await owner(paths, world); };
  return Object.assign(state, { release, reopen });
}

const committed = { status: "committed" };
const refused = (error: PublicOperationError, observed: Observed): Written => ({ kind: "refuse", value: error, observed });
const replayed = (observed: Observed): Written => ({ kind: "commit", value: { value: 1 }, observed });
const previousUnknown = answer("outcome_unknown", 409, "previous_attempt_outcome_unknown", "inspect_first", "unknown");

describe("mutationRelease over SQLite: refusals before the effect", () => {
  it("a typed refusal before the commit point: the reservation is released, then the refusal is written, inside phase 3", async () => {
    const s = await start();
    const seen: Observed[] = [];
    const first = await s.release({ before: () => { seen.push(s.current.observe()); throw new OperationError("conflict", "project_archived"); } });
    expect(first.result).toEqual(committed);
    // The handler saw its reservation; the refusal callback, in the same phase, no longer does.
    expect(seen).toEqual([inside(["reserved"])]);
    expect(first.writes).toEqual([refused(answer("conflict", 409, "project_archived", "none", "not_started"), inside([]))]);
    expect(await s.current.recorded()).toEqual([]);
    await s.reopen();
    expect(await s.current.recorded()).toEqual([]);
    const retry = await s.release();
    expect(retry.writes).toEqual([replayed(inside(["completed"]))]);
    expect(s.counters.effects).toBe(2);
  });

  it("an input error: written in one admitted phase, no record before or after the reopen", async () => {
    const s = await start();
    const expected = refused(answer("invalid_request", 400, "invalid_input", "none", "not_started"), inside([]));
    expect((await s.release({}, { n: "one" })).writes).toEqual([expected]);
    expect(await s.current.recorded()).toEqual([]);
    await s.reopen();
    expect(await s.current.recorded()).toEqual([]);
    expect((await s.release({}, { n: "one" })).writes).toEqual([expected]);
    expect(s.counters.effects).toBe(0);
  });

  it.each<[string, (s: Awaited<ReturnType<typeof start>>) => Partial<MutationReleaseOptions<Value>>, PublicOperationError]>([
    ["phase 1 ineligible", () => ({ eligible: () => false }), answer("unavailable", 503, "release_not_eligible", "none", "not_started")],
    ["phase 3 disconnected", () => { let calls = 0; return { connected: () => ++calls === 1 }; }, answer("unavailable", 503, "request_cancelled", "retry", "not_started")],
    ["phase 3 past the deadline", s => {
      const deadline = s.world.clock.now + 10;
      let calls = 0;
      // The clock reaches the deadline after phase 1's check, so phase 3's check refuses.
      return { deadline, connected: () => { if (++calls === 1) s.world.clock.now = deadline; return true; } };
    }, answer("unavailable", 503, "release_timed_out", "retry", "not_started")],
  ])("a policy refusal before the effect (%s): returned, never written; an owned reservation is given back", async (_name, policy, expected) => {
    const s = await start();
    const first = await s.release({}, { n: 1 }, policy(s));
    expect(first.result).toEqual({ status: "refused", error: expected });
    expect(first.writes).toEqual([]);
    expect(await s.current.recorded()).toEqual([]);
    await s.reopen();
    expect(await s.current.recorded()).toEqual([]);
    expect((await s.release()).writes).toEqual([replayed(inside(["completed"]))]);
    expect(s.counters.effects).toBe(1);
  });
});

describe("mutationRelease over SQLite: an existing record is answered and left alone", () => {
  it("a different input under the same key: idempotency_conflict in phase 1; every column unchanged", async () => {
    const s = await start();
    expect((await s.release()).writes).toEqual([replayed(inside(["completed"]))]);
    const stored = await s.current.rows();
    const expected = refused(answer("conflict", 409, "idempotency_conflict", "none", "not_started"), inside(["completed"]));
    expect((await s.release({}, { n: 2 })).writes).toEqual([expected]);
    expect(await s.current.rows()).toEqual(stored);
    await s.reopen();
    expect(await s.current.rows()).toEqual(stored);
    expect((await s.release({}, { n: 2 })).writes).toEqual([expected]);
    expect(s.counters.effects).toBe(1);
  });

  it.each<["reserved" | "started", string[], () => Written, number]>([
    ["reserved", [], () => replayed(inside(["completed"])), 2],
    ["started", ["unknown"], () => refused(previousUnknown, inside(["unknown"])), 1],
  ])("another attempt's %s record: request_in_progress, untouched; the reopen's repair decides the retry", async (state, repaired, retried, effects) => {
    const s = await start();
    await s.release();
    // The row of a live attempt (live rows carry no expiry): this test's arrangement, written through the owned connection inside admission.
    await s.current.store.admission.run(() => s.current.database
      .prepare("UPDATE operation_idempotency SET state=?, result_json=NULL, transitions_json=NULL, expires_at=NULL").run(state));
    const stored = await s.current.rows();
    const first = await s.release();
    expect(first.writes).toEqual([refused(answer("conflict", 409, "request_in_progress", "none", "not_started"), inside([state]))]);
    expect(await s.current.rows()).toEqual(stored);
    await s.reopen();
    expect(await s.current.recorded()).toEqual(repaired);
    expect((await s.release()).writes).toEqual([retried()]);
    expect(s.counters.effects).toBe(effects);
  });

  it("a previous attempt whose outcome is unknown: previous_attempt_outcome_unknown in phase 1, untouched across the reopen", async () => {
    const s = await start();
    const first = await s.release({ after: () => { throw new Error("effect failed /secret"); } });
    expect(first.writes).toEqual([refused(answer("outcome_unknown", 409, "effect_interrupted", "inspect_first", "unknown"), inside(["unknown"]))]);
    expect(JSON.stringify(first.writes)).not.toContain("secret");
    const stored = await s.current.rows();
    expect((await s.release()).writes).toEqual([refused(previousUnknown, inside(["unknown"]))]);
    expect(await s.current.rows()).toEqual(stored);
    await s.reopen();
    expect(await s.current.rows()).toEqual(stored);
    expect((await s.release()).writes).toEqual([refused(previousUnknown, inside(["unknown"]))]);
    expect(s.counters.effects).toBe(1);
  });

  it("an ordinary denial of a replay: this invocation's not_started, in phase 1; every column unchanged", async () => {
    const s = await start();
    await s.release();
    const stored = await s.current.rows();
    s.world.grants.revokeAll(s.alice.id);
    const expected = refused(answer("not_found", 404, "resource_not_found", "none", "not_started"), inside(["completed"]));
    expect((await s.release()).writes).toEqual([expected]);
    expect(await s.current.rows()).toEqual(stored);
    await s.reopen();
    expect(await s.current.rows()).toEqual(stored);
    expect((await s.release()).writes).toEqual([expected]);
    s.grant();
    expect((await s.release()).writes).toEqual([replayed(inside(["completed"]))]);
    expect(s.counters.effects).toBe(1);
  });
});

describe("mutationRelease over SQLite: answers after the effect", () => {
  const ineligibleAtRelease = (): Partial<MutationReleaseOptions<Value>> => { let calls = 0; return { eligible: () => ++calls <= 2 }; };

  it.each<[string, Hooks, PublicOperationError, string, Written]>([
    ["a confirmed success", {}, answer("unavailable", 503, "release_not_eligible", "none", "committed"), "completed", replayed(inside(["completed"]))],
    ["an unknown effect", { after: () => { throw new Error("effect failed /secret"); } },
      answer("outcome_unknown", 409, "release_not_eligible", "inspect_first", "unknown"), "unknown", refused(previousUnknown, inside(["unknown"]))],
    ["an unconfirmed cleanup", { finalize: () => { throw new Error("audit down /secret"); } },
      answer("unavailable", 503, "release_not_eligible", "inspect_first", "cleanup_unconfirmed"), "unknown", refused(previousUnknown, inside(["unknown"]))],
  ])("a policy refusal in step 5 after %s: returned with that effect, never written", async (_name, hooks, expected, record, retried) => {
    const s = await start();
    const first = await s.release(hooks, { n: 1 }, ineligibleAtRelease());
    expect(first.result).toEqual({ status: "refused", error: expected });
    expect(first.writes).toEqual([]);
    expect(await s.current.recorded()).toEqual([record]);
    await s.reopen();
    expect(await s.current.recorded()).toEqual([record]);
    expect((await s.release()).writes).toEqual([retried]);
    expect(s.counters.effects).toBe(1);
  });

  it.each<[string, (revoke: () => void) => Hooks, PublicOperationError, string, Written]>([
    ["a confirmed success", revoke => ({ finalize: revoke }), answer("not_found", 404, "resource_not_found", "none", "committed"), "completed",
      replayed(inside(["completed"]))],
    ["an unknown effect", revoke => ({ after: () => { throw new Error("effect failed /secret"); }, finalize: revoke }),
      answer("outcome_unknown", 409, "resource_not_found", "inspect_first", "unknown"), "unknown", refused(previousUnknown, inside(["unknown"]))],
    ["an unconfirmed cleanup", revoke => ({ finalize: () => { revoke(); throw new Error("audit down /secret"); } }),
      answer("not_found", 404, "resource_not_found", "inspect_first", "cleanup_unconfirmed"), "unknown", refused(previousUnknown, inside(["unknown"]))],
  ])("a fresh denial in step 5 after %s: the fresh reason classified with that effect, written once; the record unchanged by it", async (_name, hooks, expected, record, retried) => {
    const s = await start();
    const first = await s.release(hooks(() => s.world.grants.revokeAll(s.alice.id)));
    expect(first.result).toEqual(committed);
    expect(first.writes).toEqual([refused(expected, inside([record]))]);
    expect(JSON.stringify(first.writes)).not.toContain("secret");
    expect(await s.current.recorded()).toEqual([record]);
    await s.reopen();
    expect(await s.current.recorded()).toEqual([record]);
    s.grant();
    expect((await s.release()).writes).toEqual([retried]);
    expect(s.counters.effects).toBe(1);
  });

  it("an unconfirmed transition: conflict/transition_unconfirmed with effect committed; the record is unknown", async () => {
    const s = await start();
    const first = await s.release({ transition: true });
    expect(first.writes).toEqual([refused(answer("conflict", 409, "transition_unconfirmed", "none", "committed"), inside(["unknown"]))]);
    expect(await s.current.recorded()).toEqual(["unknown"]);
    await s.reopen();
    expect(await s.current.recorded()).toEqual(["unknown"]);
    expect((await s.release({ transition: true })).writes).toEqual([refused(previousUnknown, inside(["unknown"]))]);
    expect(s.counters.effects).toBe(1);
  });
});

describe("mutationRelease over SQLite: a failed refusal delivery", () => {
  it.each<[string, Hooks, PublicOperationError, string[], Written, number]>([
    ["a refusal before the commit point", { before: () => { throw new OperationError("conflict", "project_archived"); } },
      answer("internal", 500, "release_commit_failed", "none", "not_started"), [], replayed(inside(["completed"])), 2],
    ["an unknown effect", { after: () => { throw new Error("effect failed /secret"); } },
      answer("outcome_unknown", 409, "release_commit_failed", "inspect_first", "unknown"), ["unknown"], refused(previousUnknown, inside(["unknown"])), 1],
    ["an unconfirmed cleanup", { finalize: () => { throw new Error("audit down /secret"); } },
      answer("internal", 500, "release_commit_failed", "inspect_first", "cleanup_unconfirmed"), ["unknown"], refused(previousUnknown, inside(["unknown"])), 1],
  ])("%s, then a refuse that throws: commit_failed with that effect, one attempt, the record not changed by it", async (_name, hooks, expected, record, retried, effects) => {
    const s = await start();
    const first = await s.release(hooks, { n: 1 }, {}, "refuse");
    expect(first.result).toEqual({ status: "commit_failed", error: expected });
    expect(first.writes.map(each => [each.kind, each.observed])).toEqual([["refuse", inside(record)]]);
    expect(JSON.stringify(first.result)).not.toContain("secret");
    expect(await s.current.recorded()).toEqual(record);
    await s.reopen();
    expect(await s.current.recorded()).toEqual(record);
    expect((await s.release()).writes).toEqual([retried]);
    expect(s.counters.effects).toBe(effects);
  });
});

describe("mutationRelease over SQLite: a release the store refuses (amendment C2)", () => {
  it("a handler that leaves its transaction open: the store refuses the release, the refusal is still written once, `finally` does not repeat it", async () => {
    const s = await start();
    const first = await s.release({ before: () => { s.current.database.exec("BEGIN"); throw new OperationError("conflict", "project_archived"); } });
    expect(first.result).toEqual(committed);
    // Refused by the adapter (`idempotency_in_transaction`): the reservation is still there when the refusal is written.
    expect(first.writes).toEqual([refused(answer("conflict", 409, "project_archived", "none", "not_started"), inside(["reserved"], true))]);
    // The broken handler's transaction is this test's to end; nothing of the runner ran after the refusal.
    await s.current.store.admission.run(() => { s.current.database.exec("ROLLBACK"); });
    expect(await s.current.recorded()).toEqual(["reserved"]);
    await s.reopen();
    // The next start's repair deletes the reservation; a retry runs fresh.
    expect(await s.current.recorded()).toEqual([]);
    expect((await s.release()).writes).toEqual([replayed(inside(["completed"]))]);
    expect(s.counters.effects).toBe(2);
  });
});

describe("mutationRelease over SQLite: the observation", () => {
  it("negative control: a callback called after the runner returned is outside the real gate", async () => {
    const s = await start();
    const first = await s.release({ before: () => { throw new OperationError("conflict", "project_archived"); } });
    expect(first.writes.map(each => each.observed)).toEqual([inside([])]);
    first.options.refuse(answer("conflict", 409, "project_archived", "none", "not_started"));
    expect(first.writes.map(each => each.observed)).toEqual([inside([]), { active: 0, records: "refused:unadmitted", inTransaction: false }]);
  });
});
