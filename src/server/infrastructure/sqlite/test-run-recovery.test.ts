import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestRun } from "@/shared/contracts";
import { emptyRunResources, emptyTelemetry } from "@/server/modules/verification";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { SqliteStateStore } from "./sqlite-state-store";
import { TestRunQueries } from "./test-run-queries";
import { TEST_SUMMARY_POLICY } from "./test-summary-queries";
import { exact } from "./fixtures/exact-rows";
import { PENDING_RUNS_SQL, PINNED_RUNS_SQL, predictRecovery, recoveryRefusals, type RecoveryPrediction } from "./test-run-recovery-prediction";

/**
 * The read-only predictor of the test-run recovery against the recovery
 * itself. The recovery is the product's sequential code (`markInterruptedTestRuns`
 * in test-run-queries.ts, with the summary `save` and `prune`), unchanged; the
 * predictor carries its own copies of those rules. Each differential test runs
 * the real recovery on a copy of a fixture and compares, by storage class and
 * bytes and with a fixed clock, every table the recovery writes with the
 * prediction made on the original, so a change to either side that is not
 * mirrored on the other fails here.
 */

const roots: string[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The fixed clock of every recovery here; history is dated relative to it. */
const NOW = "2025-06-01T12:00:00.000Z";
const ago = (days: number, index = 0) => new Date(Date.parse(NOW) - days * 86_400_000 + index * 1000).toISOString();
const FINGERPRINT = "f".repeat(64);
const MIB = 1024 * 1024;
const temporary = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };

type Ids = Record<string, string>;
/**
 * Three registrations, written through the store (`saveTestRun` saves each
 * run with its summary and accounting, prunes and trims as the product does),
 * then history the product's own trimming would not leave, added raw:
 * - A: 50 kept runs, the older 25 (a-00 to a-24) all queued at the same time
 *   beyond the 30-day summary horizon, so the trims and the pruning break the
 *   tie by ID; 14 older runs beyond them (half with summaries); 70 summaries
 *   of runs long gone, older still, so the first pruning exhausts its batch of
 *   64; two queued runs (one with legacy NULL source and telemetry), a running
 *   run with sampled resources, a cancelled run whose summary is not final;
 *   receipts that pin two old runs and two that do not; and requester rows
 *   (agent and human) on runs that are trimmed and on runs that are kept;
 * - B: ten finished runs and a queued one, its accounting over the
 *   per-project record cap even after its old summaries are pruned by age;
 * - C: a running run, its accounting over the per-project byte cap and the
 *   installation over the global byte cap.
 *
 * The `global` variant drops B's and C's excess and the 70 summaries and adds
 * nine registrations whose accounting is just below the per-project byte cap:
 * every project is within its own caps and the installation is over the
 * global one, so only the global selection evicts beyond age.
 */
function populated(variant: "main" | "global" = "main"): { path: string; ids: Ids } {
  const root = temporary("recovery-");
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const ids: Ids = {};
  try {
    const add = (name: string, port: number) => store.addProject({ name, repositoryPath: join(root, name), port, executable: "node", args: [] }).id;
    Object.assign(ids, { a: add("alpha", 4901), b: add("beta", 4902), c: add("gamma", 4903) });
    if (variant === "global") for (let index = 1; index <= 9; index++) ids[`g${index}`] = add(`global-${index}`, 4910 + index);
    const run = (id: string, projectId: string, queuedAt: string, overrides: Partial<TestRun> = {}): TestRun => ({
      id, projectId, worktreePath: root, worktreeHead: "a".repeat(40), worktreeBranch: "main", worktreeDirty: false,
      presetId: "node:test", presetName: "test", adapter: "node", actor: "local-cli", phase: "passed", queuePosition: null,
      executable: "pnpm", args: ["test"], cwd: root, queuedAt, startedAt: queuedAt, finishedAt: queuedAt, exitCode: 0, signal: null,
      error: null, logs: ["ok"], environmentMode: "clean", environmentProfile: "default", inheritedServerProfile: null, environmentVariableNames: [],
      source: legacySourceEvidence(), ...overrides,
    });
    // Saved at a time before all of the history, so the store's own pruning keeps every summary.
    const save = (value: TestRun) => { vi.setSystemTime(new Date(ago(70))); store.saveTestRun(value); };
    for (let index = 0; index < 50; index++) save(run(`a-${String(index).padStart(2, "0")}`, ids.a, index < 25 ? ago(40) : ago(5, index)));
    for (let index = 0; index < 10; index++) save(run(`b-${index}`, ids.b, ago(index < 5 ? 45 : 2, index)));
    // Pending work.
    save(run("a-queued", ids.a, ago(0, 1), { phase: "queued", queuePosition: 1, startedAt: null, finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
    save(run("a-legacy", ids.a, ago(0, 2), { phase: "queued", queuePosition: 2, startedAt: null, finishedAt: null, exitCode: null }));
    save(run("a-running", ids.a, ago(0, 3), { phase: "running", finishedAt: null, exitCode: null, source: { ...legacySourceEvidence(), attribution: "pending", processOutcome: "passed" },
      telemetry: { ...emptyTelemetry("observed"), admittedAt: ago(0, 3), spawnedAt: ago(0, 4), resources: { ...emptyRunResources("sampled", 1000), sampleCount: 3 } } as TestRun["telemetry"] }));
    save(run("a-finalizing", ids.a, ago(0, 5), { phase: "cancelled", telemetry: emptyTelemetry("observed") }));
    save(run("b-queued", ids.b, ago(0, 6), { phase: "queued", queuePosition: 1, startedAt: null, finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
    save(run("c-running", ids.c, ago(0, 7), { phase: "running", finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
  } finally { store.close(); }
  vi.setSystemTime(new Date(NOW));
  const database = unmanagedFixtureDatabase(path);
  try {
    database.pragma("foreign_keys = OFF");
    const copyRun = database.prepare(`INSERT INTO test_runs(id,project_id,worktree_path,worktree_head,worktree_branch,worktree_dirty,preset_id,preset_name,adapter,actor,phase,queue_position,executable,args_json,cwd,queued_at,started_at,finished_at,exit_code,signal,error,logs_json,idempotency_key,environment_mode,environment_profile,inherited_server_profile,environment_variable_names_json,source_json,telemetry_json,provider_bound)
      SELECT ?,project_id,worktree_path,worktree_head,worktree_branch,worktree_dirty,preset_id,preset_name,adapter,actor,phase,queue_position,executable,args_json,cwd,?,started_at,finished_at,exit_code,signal,error,logs_json,idempotency_key,environment_mode,environment_profile,inherited_server_profile,environment_variable_names_json,source_json,telemetry_json,provider_bound FROM test_runs WHERE id='a-00'`);
    const copySummary = database.prepare(`INSERT INTO test_run_summaries(run_id,project_id,queued_at,terminal,bytes,summary_json) SELECT ?,project_id,?,terminal,bytes,summary_json FROM test_run_summaries WHERE run_id='a-00'`);
    const account = database.prepare("UPDATE test_summary_coverage SET records=records+1,bytes=bytes+(SELECT bytes FROM test_run_summaries WHERE run_id='a-00') WHERE project_id=?");
    for (let index = 0; index < 14; index++) {
      const id = `a-old-${String(index).padStart(2, "0")}`, queuedAt = ago(60, index);
      copyRun.run(id, queuedAt);
      if (index % 2 === 0) { copySummary.run(id, queuedAt); account.run(ids.a); }
    }
    // Seven groups of ten summaries, each group at one queue time.
    if (variant === "main") for (let index = 0; index < 70; index++) { copySummary.run(`a-gone-${String(index).padStart(2, "0")}`, ago(90, index % 7)); account.run(ids.a); }
    // Telemetry and source of a run written before either existed.
    database.exec("UPDATE test_runs SET source_json=NULL,telemetry_json=NULL WHERE id='a-legacy'");
    const receipt = database.prepare("INSERT INTO remote_worker_receipts(attempt_id,payload_json) VALUES(?,?)");
    receipt.run("receipt-pin-1", JSON.stringify({ localRunId: "a-old-00", reports: [{ phase: "running" }] }));
    receipt.run("receipt-pin-2", JSON.stringify({ localRunId: "a-old-03", reports: [] }));
    receipt.run("receipt-done", JSON.stringify({ localRunId: "a-old-01", reports: [{ phase: "running" }, { phase: "succeeded" }] }));
    receipt.run("receipt-none", JSON.stringify({ reports: [] }));
    const agent = database.prepare("INSERT INTO test_run_requesters(run_id,principal_id,credential_id,project_id,session_owner,reservation_id,lease_token_hash) VALUES(?,'agent-1','credential-1',?,'agent:mcp:fixture',NULL,NULL)");
    const human = database.prepare(`INSERT INTO human_test_run_requesters(run_id,project_id,principal_id,session_owner,authority_json,reference_json,reservation_id,fingerprint) VALUES(?,?,'human-1','human:test:human-1','{}','{}',NULL,'${FINGERPRINT}')`);
    for (const id of ["a-old-02", "a-01", "a-40", "a-queued"]) agent.run(id, ids.a);
    for (const id of ["a-old-04", "a-02", "a-45"]) human.run(id, ids.a);
    if (variant === "main") {
      database.exec(`UPDATE test_summary_coverage SET records=5010 WHERE project_id='${ids.b}'`);
      database.exec(`UPDATE test_summary_coverage SET bytes=${TEST_SUMMARY_POLICY.globalBytes}+200000-(SELECT sum(bytes) FROM test_summary_coverage WHERE project_id<>'${ids.c}') WHERE project_id='${ids.c}'`);
    } else {
      const insert = database.prepare("INSERT INTO test_summary_coverage(project_id,records,bytes,evicted) VALUES(?,0,?,0)");
      for (let index = 1; index <= 9; index++) insert.run(ids[`g${index}`], 15 * MIB);
    }
  } finally { database.close(); }
  return { path, ids };
}

// ---------------------------------------------------------------------------
// The comparison

type Exact = ReturnType<typeof exact>;
type Rows = Record<string, Record<string, string>>;
/** Every table the recovery writes, with its key. */
const WRITTEN: Readonly<Record<string, string>> = { test_runs: "id", test_run_summaries: "run_id", test_summary_coverage: "project_id", test_run_requesters: "run_id", human_test_run_requesters: "run_id" };
/** A predicted value as `exact` writes a stored one: the storage class SQLite gives a bound text, integer or NULL, and its bytes. */
const encode = (value: unknown) => {
  if (value === null) return "null";
  if (typeof value === "number" && Number.isInteger(value)) return `integer:${value}`;
  if (typeof value === "string") return `text:${Buffer.from(value, "utf8").toString("hex")}`;
  throw new Error(`no stored form for ${typeof value}`);
};
const keyed = (state: Exact, table: string): Rows => Object.fromEntries(Object.values(state[table]).map(row => [row[WRITTEN[table]], row]));
const keyText = (key: string) => Buffer.from(key.slice(key.indexOf(":") + 1), "hex").toString("utf8");
/** The written tables as the prediction says the recovery leaves them: the stored rows, changed and deleted as predicted. */
function predicted(state: Exact, prediction: RecoveryPrediction): Record<string, Rows> {
  const tables = Object.fromEntries(Object.keys(WRITTEN).map(table => [table, structuredClone(keyed(state, table))])) as Record<string, Rows>;
  const trimmed = new Set(prediction.trimmed);
  for (const run of prediction.interrupted) {
    if (!trimmed.has(run.id)) Object.assign(tables.test_runs[encode(run.id)], Object.fromEntries(Object.entries(run.columns).map(([column, value]) => [column, encode(value)])));
  }
  for (const id of trimmed) delete tables.test_runs[encode(id)];
  for (const [runId, row] of prediction.summaries) {
    if (row === null) delete tables.test_run_summaries[encode(runId)];
    else tables.test_run_summaries[encode(runId)] = Object.fromEntries(Object.entries(row).map(([column, value]) => [column, encode(value)]));
  }
  for (const [projectId, row] of prediction.coverage) {
    const stored = tables.test_summary_coverage[encode(projectId)];
    expect(Boolean(stored), projectId).toBe(!row.inserted);
    tables.test_summary_coverage[encode(projectId)] = { project_id: encode(projectId), records: encode(row.records), bytes: encode(row.bytes), evicted: encode(row.evicted),
      last_pruned_at: row.last_pruned_at === undefined ? stored.last_pruned_at : encode(row.last_pruned_at) };
  }
  for (const id of prediction.requesters.agent) delete tables.test_run_requesters[encode(id)];
  for (const id of prediction.requesters.human) delete tables.human_test_run_requesters[encode(id)];
  return tables;
}
/** A copy of the fixture file. */
function twin(path: string): string {
  const target = join(temporary("recovery-twin-"), "state.sqlite3");
  copyFileSync(path, target);
  return target;
}
const runIds = (state: Exact) => new Set(Object.values(state.test_runs).map(row => keyText(row.id)));
/**
 * The prediction on the original (read-only) and the real recovery on a copy:
 * every written table compared by key, storage class and bytes, and every
 * other table unchanged (but the security checkpoint, whose epoch the fence
 * triggers on test_runs and the requester tables rewrite with randomness).
 * Rowids are not compared: the predictor predicts rows by their keys.
 */
function differential(path: string, foreignKeys: boolean) {
  const original = unmanagedFixtureDatabase(path, { readonly: true });
  let before: Exact, prediction: RecoveryPrediction, refusals: ReturnType<typeof recoveryRefusals>;
  try {
    before = exact(original);
    refusals = recoveryRefusals(original, 100);
    prediction = predictRecovery(original, new Date().toISOString());
  } finally { original.close(); }
  const copy = unmanagedFixtureDatabase(twin(path));
  let after: Exact;
  try {
    copy.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    new TestRunQueries(copy).markInterruptedTestRuns();
    after = exact(copy);
  } finally { copy.close(); }
  const expected = predicted(before, prediction);
  for (const table of Object.keys(WRITTEN)) {
    const actual = keyed(after, table);
    expect(Object.keys(actual).map(keyText).sort(), table).toEqual(Object.keys(expected[table]).map(keyText).sort());
    for (const [key, row] of Object.entries(actual)) expect(row, `${table} ${keyText(key)}`).toEqual(expected[table][key]);
  }
  for (const table of Object.keys(before).filter(name => !(name in WRITTEN) && name !== "security_checkpoint")) expect(after[table], table).toEqual(before[table]);
  // The predicted deletions are the runs that are gone, by identity.
  const gone = [...runIds(before)].filter(id => !runIds(after).has(id)).sort();
  expect([...prediction.trimmed].sort()).toEqual(gone);
  return { before, after, prediction, refusals };
}

// ---------------------------------------------------------------------------

describe("test-run recovery: the prediction against the recovery", () => {
  it.each([[true], [false]])("predicts every table the recovery writes, by storage class and bytes (foreign keys on: %s)", foreignKeys => {
    const { path } = populated();
    const { before, prediction, refusals } = differential(path, foreignKeys);
    expect(refusals).toEqual({ refusals: [], count: 0 });
    // The fixture reaches every part of the recovery.
    expect(prediction.interrupted.map(run => run.id).sort()).toEqual(["a-finalizing", "a-legacy", "a-queued", "a-running", "b-queued", "c-running"]);
    const rules = new Set(prediction.evictions.map(eviction => eviction.rule));
    expect([...rules].sort()).toEqual(["age", "global", "project"]);
    // The first pruning exhausts its batch of 64 by age while older summaries remain: the next pruning evicts by age again.
    expect(prediction.evictions.slice(0, TEST_SUMMARY_POLICY.pruneBatch).every(eviction => eviction.rule === "age")).toBe(true);
    expect(prediction.evictions[TEST_SUMMARY_POLICY.pruneBatch].rule).toBe("age");
    // Equal queue times: the pruning takes the lower IDs first, the trims keep the higher ones.
    const tied = prediction.evictions.filter(eviction => /^a-gone-/.test(eviction.runId)).slice(0, 10).map(eviction => eviction.runId);
    expect(tied).toEqual(Array.from({ length: 10 }, (_, index) => `a-gone-${String(index * 7).padStart(2, "0")}`).sort());
    expect(prediction.trimmed.filter(id => /^a-\d\d$/.test(id)).sort()).toEqual(["a-00", "a-01", "a-02", "a-03"]);
    expect(Object.values(before.test_runs).filter(row => /^a-(0\d|1\d|2[0-4])$/.test(keyText(row.id))).map(row => row.queued_at)).toEqual(Array(25).fill(encode(ago(40))));
    // Per-project evictions on B and C, the global one after them.
    const projects = (rule: string) => new Set(prediction.evictions.filter(eviction => eviction.rule === rule).map(eviction => eviction.projectId));
    expect(projects("project").size).toBe(2);
    // Receipts pin two old runs through the per-project trims; the final trim deletes them all the same.
    expect(prediction.trims.filter(trim => trim.selection === "project").flatMap(trim => trim.runs)).not.toEqual(expect.arrayContaining(["a-old-00"]));
    expect(prediction.trims.filter(trim => trim.selection === "project").flatMap(trim => trim.runs)).not.toEqual(expect.arrayContaining(["a-old-03"]));
    expect(prediction.trims.at(-1)).toMatchObject({ selection: "recovery", runs: expect.arrayContaining(["a-old-00", "a-old-03"]) });
    expect(prediction.trimmed).toHaveLength(new Set(prediction.trimmed).size);
    // Requester rows go with trimmed runs and stay with kept ones.
    expect(prediction.requesters).toEqual({ agent: ["a-01", "a-old-02"], human: ["a-02", "a-old-04"] });
  });

  it("predicts an eviction by the global cap alone: every project within its own caps, the installation over the global one", () => {
    const { path } = populated("global");
    const database = unmanagedFixtureDatabase(path, { readonly: true });
    try {
      const totals = database.prepare("SELECT sum(records) AS records, sum(bytes) AS bytes, max(records) AS projectRecords, max(bytes) AS projectBytes FROM test_summary_coverage").get() as Record<string, number>;
      expect(totals.bytes).toBeGreaterThan(TEST_SUMMARY_POLICY.globalBytes);
      expect(totals.projectBytes).toBeLessThanOrEqual(TEST_SUMMARY_POLICY.perProjectBytes - 64 * 8192);
      expect(totals.projectRecords).toBeLessThanOrEqual(TEST_SUMMARY_POLICY.perProjectRecords);
    } finally { database.close(); }
    const { prediction } = differential(path, true);
    const rules = prediction.evictions.map(eviction => eviction.rule);
    expect(rules).toContain("global");
    expect(rules).not.toContain("project");
  });

  it("predicts a second recovery: nothing pending, the final trim still runs", () => {
    const { path } = populated();
    const recovered = twin(path);
    const once = unmanagedFixtureDatabase(recovered);
    try { new TestRunQueries(once).markInterruptedTestRuns(); } finally { once.close(); }
    const { prediction } = differential(recovered, true);
    expect(prediction.interrupted).toEqual([]);
    expect(prediction.trims).toEqual([{ selection: "recovery", projectId: null, runs: [] }]);
  });

  it("predicts and refuses on a read-only connection and writes nothing", () => {
    const { path } = populated();
    const sha = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = sha();
    const database = unmanagedFixtureDatabase(path, { readonly: true });
    try {
      const state = exact(database);
      expect(recoveryRefusals(database, 100).count).toBe(0);
      expect(predictRecovery(database, NOW).now).toBe(NOW);
      expect(exact(database)).toEqual(state);
    } finally { database.close(); }
    expect(sha()).toBe(before);
  });

  it("carries the recovery's own selection and pinning SQL, verbatim", () => {
    const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const source = squash(readFileSync(join(process.cwd(), "src/server/infrastructure/sqlite/test-run-queries.ts"), "utf8"));
    expect(source).toContain(squash(PENDING_RUNS_SQL));
    expect(source).toContain(squash(PINNED_RUNS_SQL));
  });
});

describe("test-run recovery: the product's recovery is the base's", () => {
  it("evicts a summary whose run ID is a BLOB once, and counts it once", () => {
    const root = temporary("recovery-blob-");
    const path = join(root, "state.sqlite3");
    const store = new SqliteStateStore(path);
    let project: string;
    try {
      project = store.addProject({ name: "alpha", repositoryPath: join(root, "a"), port: 4901, executable: "node", args: [] }).id;
      const run = (id: string, queuedAt: string, overrides: Partial<TestRun>): TestRun => ({
        id, projectId: project, worktreePath: root, worktreeHead: "a".repeat(40), worktreeBranch: "main", worktreeDirty: false, presetId: "node:test", presetName: "test",
        adapter: "node", actor: "local-cli", phase: "passed", queuePosition: null, executable: "pnpm", args: ["test"], cwd: root, queuedAt, startedAt: queuedAt, finishedAt: queuedAt,
        exitCode: 0, signal: null, error: null, logs: [], environmentMode: "clean", environmentProfile: "default", inheritedServerProfile: null, environmentVariableNames: [],
        source: legacySourceEvidence(), ...overrides,
      });
      vi.setSystemTime(new Date(ago(70)));
      store.saveTestRun(run("old-run", ago(60), {}));
      store.saveTestRun(run("queued-run", ago(0, 1), { phase: "queued", queuePosition: 1, startedAt: null, finishedAt: null, exitCode: null, telemetry: emptyTelemetry("observed") }));
    } finally { store.close(); }
    vi.setSystemTime(new Date(NOW));
    const database = unmanagedFixtureDatabase(path);
    try {
      database.exec("UPDATE test_run_summaries SET run_id=CAST(run_id AS BLOB) WHERE run_id='old-run'");
      expect(database.prepare("SELECT records FROM test_summary_coverage").pluck().get()).toBe(2);
      new TestRunQueries(database).markInterruptedTestRuns();
      // The BLOB summary is gone by age; the accounting lost it once and holds exactly the summary left.
      expect(database.prepare("SELECT run_id FROM test_run_summaries").pluck().all()).toEqual(["queued-run"]);
      expect(database.prepare("SELECT c.records,c.evicted,c.bytes=(SELECT sum(bytes) FROM test_run_summaries) AS exact FROM test_summary_coverage c").get())
        .toEqual({ records: 1, evicted: 1, exact: 1 });
    } finally { database.close(); }
  });
});
