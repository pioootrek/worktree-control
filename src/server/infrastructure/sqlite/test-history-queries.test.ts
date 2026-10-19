import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ControlService } from "@/server/control-service";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import type { IdentityService } from "@/server/modules/identity";
import { emptyRunResources, emptyTelemetry, VerificationHistoryService } from "@/server/modules/verification";
import type { ProcessManager } from "@/server/process-manager";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import type { TestRun } from "@/shared/contracts";
import { OwnedSqliteDatabase, SqliteStateStore } from "./index";
import { TestSummaryQueries } from "./test-summary-queries";
import { historyScanSql } from "./test-history-queries";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wtc-history-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3"), owned = new OwnedSqliteDatabase(path, true), store = new SqliteStateStore(path, owned);
  cleanup.push(() => store.close());
  const project = store.addProject({ name: "App", repositoryPath: root, port: 3210, executable: "node", args: [] });
  const other = store.addProject({ name: "Other", repositoryPath: join(root, "other"), port: 3211, executable: "node", args: [] });
  const now = Date.now(), at = (delta = 0) => new Date(now + delta).toISOString();
  const filter = { projectId: project.id, from: at(-60_000), to: at(60_000) };
  const history = new VerificationHistoryService(store);
  const run = (overrides: Partial<TestRun> = {}): TestRun => ({
    id: randomUUID(), projectId: project.id, worktreePath: root, worktreeHead: "abc", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "local-user", phase: "passed", queuePosition: null,
    executable: "node", args: ["SECRET_ARG"], cwd: root, queuedAt: at(), startedAt: at(), finishedAt: at(), exitCode: 0, signal: null,
    error: "SECRET_ERROR", logs: ["SECRET_LOG"], environmentMode: "clean", environmentProfile: "SECRET_PROFILE", inheritedServerProfile: null,
    environmentVariableNames: ["SECRET_ENV"], source: { ...legacySourceEvidence(), processOutcome: "passed", attribution: "observed_match",
      enqueue: { observedAt: at(), head: "abc", branch: "main", dirty: false, statusDigest: "clean", statusEntries: 0, complete: true, errorCode: null } },
    telemetry: { ...emptyTelemetry("observed"), termination: "exit", cleanup: "confirmed", spawnedAt: at(), exitedAt: at(), finalizedAt: at(),
      durations: { queueMs: 1, prepareMs: 2, processMs: 3, cleanupMs: 4, finalizationMs: 5, totalMs: 15, runnerWaitMs: null } },
    ...overrides,
  });
  return { root, owned, store, project, other, at, filter, history, run, summaries: new TestSummaryQueries(owned.database) };
}

describe("verification history on the existing SQLite owner", () => {
  it("survives 50-detail pruning and separates retained summary reads from existing detail semantics", () => {
    const f = fixture(); const runs = Array.from({ length: 60 }, (_, i) => f.run({ queuedAt: f.at(i) }));
    for (const run of runs) f.store.saveTestRun(run);
    expect(f.store.getTestRun(runs[0].id)).toBeNull();
    expect(f.history.summary({ projectId: f.project.id, runId: runs[0].id })).toMatchObject({ detailAvailable: false, summary: { runId: runs[0].id } });
    const page = f.history.list(f.filter);
    expect(page.items).toHaveLength(50);
    expect(page.items.every(e => e.detailAvailable)).toBe(true);
    expect(f.history.list({ ...f.filter, cursor: page.nextCursor }).items).toHaveLength(10);
    expect(page.coverage).toMatchObject({ records: 60, evicted: 0, historicalCompleteness: "not_guaranteed" });
    for (const secret of ["SECRET_ARG", "SECRET_ERROR", "SECRET_LOG", "SECRET_PROFILE", "SECRET_ENV"]) expect(JSON.stringify(page)).not.toContain(secret);
  });

  it("persists versioned resources across detail pruning and maps old JSON to unknown", () => {
    const f = fixture(), run = f.run();
    run.telemetry!.resources = { ...emptyRunResources("sampled", 1000), sampleCount: 2, attemptCount: 2, cpuIntervalCount: 1,
      peakSampledRssBytes: 1000, peakSampledCpuPercent: 25, peakSampledProcessCount: 2 };
    f.store.saveTestRun(run);
    expect(f.store.getTestRun(run.id)?.telemetry?.resources).toEqual(run.telemetry!.resources);
    for (let i = 0; i < 50; i++) f.store.saveTestRun(f.run({ queuedAt: f.at(i + 1) }));
    expect(f.store.getTestRun(run.id)).toBeNull();
    expect(f.history.summary({ projectId: f.project.id, runId: run.id })).toMatchObject({ detailAvailable: false,
      summary: { telemetry: { resources: run.telemetry!.resources } } });
    const legacy = f.run({ queuedAt: f.at(100) }); delete legacy.telemetry!.resources;
    f.store.saveTestRun(legacy);
    f.owned.database.prepare("UPDATE test_runs SET telemetry_json=? WHERE id=?").run(JSON.stringify(legacy.telemetry), legacy.id);
    expect(f.store.getTestRun(legacy.id)?.telemetry?.resources?.status).toBe("legacy_unknown");
    // Exercise already-stored JSON from the previous release, not only new writes.
    const json = JSON.parse(f.owned.database.prepare("SELECT summary_json FROM test_run_summaries WHERE run_id=?").pluck().get(legacy.id) as string);
    delete json.telemetry.resources;
    f.owned.database.prepare("UPDATE test_run_summaries SET summary_json=? WHERE run_id=?").run(JSON.stringify(json), legacy.id);
    expect(f.history.summary({ projectId: f.project.id, runId: legacy.id }).summary.telemetry.resources).toMatchObject({ status: "legacy_unknown", peakSampledRssBytes: null });
    expect(f.history.list(f.filter).items.find(e => e.summary.runId === legacy.id)?.summary.telemetry.resources?.status).toBe("legacy_unknown");
  });

  it("retains only saved observations on interruption and marks resource quality partial", () => {
    const f = fixture(), run = f.run({ phase: "running", finishedAt: null });
    run.telemetry!.finalizedAt = null;
    run.telemetry!.resources = { ...emptyRunResources("sampled", 1000), sampleCount: 3, attemptCount: 3, peakSampledRssBytes: 5000 };
    f.store.saveTestRun(run); f.store.markInterruptedTestRuns();
    expect(f.store.getTestRun(run.id)).toMatchObject({ phase: "interrupted", telemetry: { resources: {
      status: "partial", sampleCount: 3, peakSampledRssBytes: 5000, peakSampledCpuPercent: null, reasons: ["controller_interrupted"] } } });
  });

  it("exposes per-population resource denominators, gaps and qualified comparison deltas", () => {
    const f = fixture(), a = f.run(), b = f.run(), gap = f.run();
    a.telemetry!.resources = { ...emptyRunResources("sampled", 1000), sampleCount: 2, attemptCount: 2,
      cpuIntervalCount: 1, peakSampledRssBytes: 1000, peakSampledCpuPercent: 20 };
    b.telemetry!.resources = { ...a.telemetry!.resources, peakSampledRssBytes: 3000, peakSampledCpuPercent: 40 };
    for (const r of [a, b, gap]) f.store.saveTestRun(r);
    const metrics = f.history.metrics(f.filter);
    expect(metrics.resources.rss.populations.completed_execution).toMatchObject({ median: 2000, p95: 3000, valid: 2, missing: 1, denominator: 3,
      statuses: { sampled: 2, legacy_unknown: 1 }, sampleCount: 4 });
    expect(metrics.resources.cpu.populations.completed_execution).toMatchObject({ median: 30, valid: 2, missing: 1, cpuIntervalCount: 2 });
    const input = { projectId: f.project.id, leftRunId: a.id, rightRunId: b.id };
    expect(f.history.compare(input).resources.rss).toMatchObject({ left: 1000, right: 3000, delta: 2000 });
    b.telemetry!.resources.status = "partial"; f.store.saveTestRun(b);
    expect(f.history.compare(input).resources.rss.delta).toBeNull();
    b.telemetry!.resources.status = "sampled"; b.telemetry!.resources.intervalMs = 2000; f.store.saveTestRun(b);
    expect(f.history.compare(input).resources.cpu.delta).toBeNull();
    expect(f.history.compare({ ...input, rightRunId: gap.id }).resources.cpu).toMatchObject({ left: 20, right: null, delta: null });
  });

  it("uses stable equal-time keysets across insertions/deletions and authenticates filter/project/order scope", () => {
    const f = fixture();
    const runs = Array.from({ length: 9 }, () => f.run()).sort((a, b) => b.id.localeCompare(a.id));
    for (const run of runs) f.store.saveTestRun(run);
    const first = f.history.list({ ...f.filter, limit: 3 });
    expect(first.items.map(e => e.summary.runId)).toEqual(runs.slice(0, 3).map(r => r.id));
    f.store.saveTestRun(f.run({ queuedAt: f.at(1) })); // inserted above first page ceiling
    f.owned.database.prepare("DELETE FROM test_run_summaries WHERE run_id=?").run(runs[3].id);
    const second = f.history.list({ ...f.filter, limit: 2, cursor: first.nextCursor });
    expect(second.items.map(e => e.summary.runId)).toEqual(runs.slice(4, 6).map(r => r.id));
    const third = f.history.list({ ...f.filter, cursor: second.nextCursor });
    expect(third.items.map(e => e.summary.runId)).toEqual(runs.slice(6).map(r => r.id));
    expect(third.nextCursor).toBeNull();
    for (const changed of [{ projectId: f.other.id }, { presetId: "node:build" }, { from: f.at(-1) }, { attribution: "changed" }]) {
      expect(() => f.history.list({ ...f.filter, ...changed, cursor: first.nextCursor })).toThrow("cursor");
    }
    expect(() => f.history.list({ ...f.filter, cursor: `${first.nextCursor!.slice(0, -5)}wrong` })).toThrow("cursor");
    expect(() => new VerificationHistoryService(f.store).list({ ...f.filter, cursor: first.nextCursor })).toThrow("cursor");
  });

  it("validates bounded strict inputs and limits filtered candidate scans with resumable empty pages", () => {
    const f = fixture();
    for (const invalid of [{ limit: 51 }, { limit: 0 }, { cursor: "x".repeat(2049) }, { unknown: 1 }, { dirty: "false" }, { processOutcome: "secret" }, { from: "2026-02-30T00:00:00.000Z" }, { from: f.at(1), to: f.at() }, { from: f.at(-32 * 86400_000) }]) {
      expect(() => f.history.list({ ...f.filter, ...invalid })).toThrow("Invalid verification");
    }
    const save = f.owned.database.transaction(() => { for (let i = 0; i < 1002; i++) f.summaries.save(f.run({ queuedAt: f.at(i) })); }); save();
    const first = f.history.list({ ...f.filter, presetId: "node:missing" });
    expect(first.items).toEqual([]);
    expect(first.selection).toMatchObject({ scanned: 1000, scanLimit: 1000, scanLimitReached: true });
    expect(first.nextCursor).not.toBeNull();
    const second = f.history.list({ ...f.filter, presetId: "node:missing", cursor: first.nextCursor });
    expect(second.selection.scanned).toBe(2); expect(second.nextCursor).toBeNull();
    expect(f.history.list(f.filter).selection.scanned).toBe(50); // no full-payload page scan
  });

  it("filters every supported identity/outcome and never exposes a cross-project guessed summary", () => {
    const f = fixture(); const run = f.run(); f.store.saveTestRun(run);
    f.store.saveTestRun(f.run({ projectId: f.other.id }));
    const selected = { ...f.filter, presetId: run.presetId, worktreePath: run.worktreePath, head: "abc", statusDigest: "clean", dirty: false, processOutcome: "passed", attribution: "observed_match" };
    expect(f.history.list(selected).items.map(e => e.summary.runId)).toEqual([run.id]);
    for (const changed of [{ presetId: "x" }, { worktreePath: "x" }, { head: "x" }, { statusDigest: "x" }, { dirty: true }, { processOutcome: "failed" }, { attribution: "changed" }]) expect(f.history.list({ ...selected, ...changed }).items).toEqual([]);
    const error = (runId: string) => { try { f.history.summary({ projectId: f.other.id, runId }); } catch (e) { return (e as Error).message; } };
    expect(error(run.id)).toBe(error(randomUUID()));
    expect(() => f.history.compare({ projectId: f.other.id, leftRunId: run.id, rightRunId: run.id })).toThrow("Nie znaleziono uruchomienia testu.");
  });

  it("computes exact per-population median/nearest-rank p95 and separate process/source counts without zero-filled gaps", () => {
    const f = fixture();
    for (let i = 1; i <= 20; i++) {
      const run = f.run(); run.telemetry!.durations.processMs = i;
      if (i === 1) { run.phase = "failed"; run.source.attribution = "changed"; } // process still passed
      if (i === 2) { run.phase = "failed"; run.source.processOutcome = "failed"; }
      f.store.saveTestRun(run);
    }
    const missing = f.run(); missing.telemetry!.durations.processMs = null; f.store.saveTestRun(missing);
    for (const phase of ["cancelled", "timed_out", "interrupted", "running"] as const) {
      const run = f.run({ phase }); run.telemetry!.durations.processMs = 999_999;
      if (phase === "cancelled" || phase === "timed_out") run.source.processOutcome = phase;
      if (phase === "running") { run.source.processOutcome = null; run.source.attribution = "pending"; }
      f.store.saveTestRun(run);
    }
    const rejected = f.run({ phase: "failed" }); rejected.telemetry!.termination = "rejected"; rejected.source.processOutcome = null; f.store.saveTestRun(rejected);
    f.store.saveTestRun(f.run({ telemetry: emptyTelemetry(), source: legacySourceEvidence() }));
    const metrics = f.history.metrics(f.filter);
    expect(metrics.selection.matched).toBe(27);
    expect(metrics.populations.completed_execution).toMatchObject({ count: 21, durations: { processMs: { medianMs: 10.5, p95Ms: 19, valid: 20, missing: 1, denominator: 21 } } });
    for (const p of ["cancelled", "timed_out", "interrupted", "in_progress", "rejected", "other_incomplete"] as const) expect(metrics.populations[p].count).toBe(1);
    expect(metrics.populations.other_incomplete.durations.processMs).toEqual({ medianMs: null, p95Ms: null, valid: 0, missing: 1, denominator: 1 });
    expect(metrics.processOutcomes).toEqual({ passed: 21, failed: 1, cancelled: 1, timed_out: 1, interrupted: 0, unknown: 3 });
    expect(f.history.metrics({ ...f.filter, processOutcome: "unknown" }).selection.matched).toBe(3);
    expect(metrics.sourceAttributions).toMatchObject({ observed_match: 24, pending: 1, changed: 1, legacy_unknown: 1 });
    expect(metrics.method.p95).toBe("nearest_rank_ceil_0.95_n");
    expect(f.history.metrics({ ...f.filter, presetId: "none" }).populations.completed_execution.durations.totalMs).toMatchObject({ valid: 0, denominator: 0, medianMs: null });
    expect(metrics.resources.rss.populations.completed_execution).toMatchObject({ valid: 0, missing: 21, median: null });
    expect(metrics.resources.cpu.populations.completed_execution.median).toBeNull();
  });

  it.each([
    ["queued", "observed", "unfinished", "exit", "in_progress", false],
    ["running", "observed", "unfinished", "exit", "in_progress", false],
    ["passed", "observed", "unfinished", "exit", "in_progress", false],
    ["failed", "observed", "unfinished", "exit", "in_progress", false],
    ["cancelled", "observed", "unfinished", "cancel", "in_progress", false],
    ["timed_out", "observed", "unfinished", "timeout", "in_progress", false],
    ["interrupted", "partial", "unfinished", "interruption", "in_progress", false],
    ["passed", "partial", "unfinished", "exit", "in_progress", false],
    ["failed", "partial", "unfinished", "rejected", "in_progress", false],
    ["failed", "observed", "unfinished", "spawn_error", "in_progress", false],
    ["passed", "observed", "finalized", "exit", "completed_execution", true],
    ["failed", "observed", "finalized", "exit", "completed_execution", true],
    ["cancelled", "observed", "finalized", "cancel", "cancelled", true],
    ["timed_out", "observed", "finalized", "timeout", "timed_out", true],
    ["interrupted", "partial", "recovered", "interruption", "interrupted", true],
    ["cancelled", "partial", "recovered", "cancel", "cancelled", true],
    ["timed_out", "partial", "recovered", "timeout", "timed_out", true],
    ["failed", "partial", "recovered", "unknown", "other_incomplete", true],
    ["failed", "observed", "finalized", "rejected", "rejected", true],
    ["failed", "observed", "finalized", "spawn_error", "rejected", true],
    ["passed", "legacy_unknown", "unfinished", "unknown", "other_incomplete", true],
    ["failed", "legacy_unknown", "unfinished", "unknown", "other_incomplete", true],
    ["cancelled", "legacy_unknown", "unfinished", "unknown", "cancelled", true],
    ["timed_out", "legacy_unknown", "unfinished", "unknown", "timed_out", true],
    ["interrupted", "legacy_unknown", "unfinished", "unknown", "interrupted", true],
    ["queued", "legacy_unknown", "unfinished", "unknown", "in_progress", false],
    ["running", "legacy_unknown", "unfinished", "unknown", "in_progress", false],
  ] as const)("keeps SQLite terminal, metrics and comparison consistent for %s/%s/%s/%s", (phase, availability, milestone, termination, population, terminal) => {
    const f = fixture(), baseline = f.run(), run = f.run({ phase });
    if (availability === "legacy_unknown") {
      run.telemetry = emptyTelemetry();
      run.source = legacySourceEvidence();
    } else {
      run.telemetry = { ...run.telemetry!, availability, termination,
        finalizedAt: milestone === "finalized" ? f.at() : null,
        recoveredAt: milestone === "recovered" ? f.at() : null };
    }
    f.store.saveTestRun(baseline); f.store.saveTestRun(run);
    const persisted = f.owned.database.prepare("SELECT terminal FROM test_run_summaries WHERE run_id=?").get(run.id) as { terminal: number };
    expect(persisted.terminal).toBe(terminal ? 1 : 0);
    const metrics = f.history.metrics(f.filter);
    const completed = population === "completed_execution";
    expect(metrics.selection.matched).toBe(2);
    expect(metrics.populations.completed_execution.count).toBe(completed ? 2 : 1);
    expect(metrics.populations[population].count).toBe(completed ? 2 : 1);
    expect(Object.values(metrics.populations).reduce((sum, p) => sum + p.count, 0)).toBe(2);
    expect(metrics.populations.completed_execution.durations.processMs).toMatchObject({ valid: completed ? 2 : 1, denominator: completed ? 2 : 1, medianMs: 3 });
    const comparison = f.history.compare({ projectId: f.project.id, leftRunId: baseline.id, rightRunId: run.id });
    expect(comparison.populations).toEqual({ left: "completed_execution", right: population });
    expect(comparison.caveats.some(c => c.includes("do not compare as completed execution"))).toBe(!completed);
  });

  it("preserves historical terminal populations when telemetry is absent", () => {
    const f = fixture();
    for (const phase of ["passed", "failed", "cancelled", "timed_out", "interrupted"] as const) {
      f.store.saveTestRun(f.run({ phase, telemetry: undefined, source: legacySourceEvidence() }));
    }
    const metrics = f.history.metrics(f.filter);
    expect(metrics.populations.in_progress.count).toBe(0);
    expect(metrics.populations.other_incomplete.count).toBe(2);
    for (const population of ["cancelled", "timed_out", "interrupted"] as const) expect(metrics.populations[population].count).toBe(1);
    expect(metrics.populations.completed_execution.count).toBe(0);
  });

  it("reports retention independently from selection and handles pruned summaries safely", () => {
    const f = fixture(), run = f.run({ queuedAt: "2000-01-01T00:00:00.000Z" });
    f.store.saveTestRun(run); f.store.pruneTestSummaryHistory();
    expect(f.history.list(f.filter).coverage).toMatchObject({ evicted: 1, records: 0, historicalCompleteness: "not_guaranteed" });
    expect(() => f.history.summary({ projectId: f.project.id, runId: run.id })).toThrow("Nie znaleziono uruchomienia testu.");
    expect(() => f.history.compare({ projectId: f.project.id, leftRunId: run.id, rightRunId: randomUUID() })).toThrow("Nie znaleziono uruchomienia testu.");
  });

  it("compares identities and right-minus-left durations with missing/censored observation caveats", () => {
    const f = fixture(), a = f.run(), b = f.run({ phase: "cancelled", presetId: "node:build", worktreePath: "/other", args: ["OTHER_SECRET"], environmentProfile: "other" });
    b.source = { ...b.source, attribution: "uncertain", enqueue: null }; b.telemetry!.durations.processMs = 30; b.telemetry!.durations.totalMs = null;
    f.store.saveTestRun(a); f.store.saveTestRun(b);
    const result = f.history.compare({ projectId: f.project.id, leftRunId: a.id, rightRunId: b.id });
    expect(result.differences).toEqual({ source: true, command: true, profile: true, preset: true, worktree: true });
    expect(result.timings.processMs).toEqual({ leftMs: 3, rightMs: 30, deltaMs: 27 });
    expect(result.timings.totalMs.deltaMs).toBeNull();
    expect(result.caveats.join(" ")).toMatch(/censored/);
    expect(result.caveats.join(" ")).toMatch(/observed_match/);
    expect(result.caveats.join(" ")).toMatch(/not prove identical/);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    const same = f.history.compare({ projectId: f.project.id, leftRunId: a.id, rightRunId: a.id });
    expect(Object.values(same.differences)).toEqual([false, false, false, false, false]);
    expect(same.caveats.join(" ")).toContain("flakiness");
  });

  it("bounds read work at representative 5000/project, 50000/global volume using the existing index", () => {
    const f = fixture();
    const projects = [f.project, f.other, ...Array.from({ length: 8 }, (_, i) => f.store.addProject({ name: `P${i}`, repositoryPath: join(f.root, `p${i}`), port: 3300 + i, executable: "node", args: [] }))];
    f.owned.database.transaction(() => {
      for (const p of projects) for (let i = 0; i < 5000; i++) f.summaries.save(f.run({ projectId: p.id, queuedAt: f.at(i) }));
    })();
    const plan = f.owned.database.prepare(`EXPLAIN QUERY PLAN ${historyScanSql(f.filter)}`).all(f.project.id, f.filter.from, f.filter.to, "\uffff", 1001) as Array<{ detail: string }>;
    expect(plan.some(p => p.detail.includes("test_summaries_project_history") && p.detail.includes("SEARCH"))).toBe(true);
    expect(plan.some(p => /SCAN s|TEMP B-TREE/.test(p.detail))).toBe(false);
    const start = performance.now(), page = f.history.list(f.filter), pageMs = performance.now() - start;
    const metricStart = performance.now(), metrics = f.history.metrics(f.filter), metricsMs = performance.now() - metricStart;
    expect(page.selection.scanned).toBe(50); expect(metrics.selection).toMatchObject({ scanned: 5000, truncated: false, matched: 5000 });
    const overflow = f.run({ queuedAt: f.at(6000) }); f.owned.database.transaction(() => f.summaries.save(overflow))();
    expect(f.history.metrics({ ...f.filter, presetId: "missing" }).selection).toMatchObject({ scanned: 5000, truncated: true, matched: 0 });
    const cursorPlan = f.owned.database.prepare(`EXPLAIN QUERY PLAN ${historyScanSql({ ...f.filter, before: { queuedAt: f.at(1000), runId: overflow.id } })}`).all(f.project.id, f.filter.from, f.at(1000), overflow.id, 1001) as Array<{ detail: string }>;
    expect(cursorPlan.some(p => /SCAN s|TEMP B-TREE/.test(p.detail))).toBe(false);
    console.info("verification-history-cost", JSON.stringify({ globalRows: 50000, projectRows: 5000, pageMs, metricsMs, pageResponseBytes: Buffer.byteLength(JSON.stringify(page)), metricsResponseBytes: Buffer.byteLength(JSON.stringify(metrics)), plan, cursorPlan }));
  }, 120_000);
});

async function transports() {
  const f = fixture();
  const service = new ControlService(f.store, { list: vi.fn(async () => []) } as never, {} as ProcessManager);
  const actor = { principalId: "scoped-agent", principalKind: "agent" as const, credentialId: "credential", authenticationMethod: "agent_token" as const };
  const identity = { authenticateBearer: (token: string) => { if (token !== "scoped") throw Error("invalid credential"); return actor; } } as IdentityService;
  const http = createControllerServer({
    service, directoryBrowser: {} as DirectoryBrowser, events: new EventStream(), webRoot: f.root,
    host: "127.0.0.1", port: 0, accessToken: "runtime-token", identity,
    mcpStatus: () => ({ phase: "running", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }),
  });
  const mcp = createMcpControllerServer({ service, port: 0, accessToken: "runtime-token", identity });
  for (const controller of [http, mcp]) {
    cleanup.push(() => controller.close());
    await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
  }
  const base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: "history-parity", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: "Bearer runtime-token" } } }));
  cleanup.push(() => client.close());
  const get = (operation: string, params: Record<string, unknown> = {}, headers: Record<string, string> = { "X-Worktree-Control-Token": "runtime-token" }, projectId = f.project.id) => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return fetch(`${base}/api/projects/${projectId}/${operation}?${query}`, { headers });
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse((result.content as Array<{ text: string }>)[0].text) };
  };
  return { ...f, service, base, endpoint, client, get, call };
}

describe("HTTP/MCP verification history parity through real handlers", () => {
  it("shares validated history, metrics, comparison and pruned-summary semantics", async () => {
    const f = await transports(), a = f.run(), b = f.run();
    a.telemetry!.resources = { ...emptyRunResources("partial", 1000), sampleCount: 2, peakSampledRssBytes: 1234, missingSampleCount: 1,
      cpuIntervalCount: 1, peakSampledCpuPercent: 20, reasons: ["membership_changed", "process_churn", "group_exited"] };
    b.telemetry!.resources = { ...a.telemetry!.resources, peakSampledRssBytes: 2234, peakSampledCpuPercent: 40, reasons: ["inflight_discarded"] };
    a.queuedAt = f.at(-1); f.store.saveTestRun(a); f.store.saveTestRun(b);
    for (let i = 0; i < 50; i++) f.store.saveTestRun(f.run({ queuedAt: f.at(120_000 + i) }));
    expect(f.service.testRunSummary({ projectId: f.project.id, runId: a.id }).detailAvailable).toBe(false);
    expect(() => f.service.testRun(a.id)).toThrow("Nie znaleziono uruchomienia testu.");
    expect((await f.client.callTool({ name: "get_test_run", arguments: { runId: a.id } })).isError).toBe(true);
    expect(f.history.compare({ projectId: f.project.id, leftRunId: a.id, rightRunId: b.id }).resources).toMatchObject({ rss: { delta: 1000 }, cpu: { delta: 20 } });
    expect(f.history.summary({ projectId: f.project.id, runId: a.id }).summary.telemetry.resources).toEqual(a.telemetry!.resources);
    const { projectId: _projectId, ...query } = f.filter; void _projectId;
    const pairs = [
      ["test-runs", "list_test_runs", query], ["test-metrics", "get_test_metrics", query],
      [`test-runs/${a.id}`, "get_test_run_summary", { runId: a.id }],
      ["test-run-comparison", "compare_test_runs", { leftRunId: a.id, rightRunId: b.id }],
    ] as const;
    for (const [operation, tool, params] of pairs) {
      const httpParams = { ...params }; if ("runId" in httpParams) delete (httpParams as { runId?: string }).runId;
      const response = await f.get(operation, httpParams); expect(response.status).toBe(200);
      expect((await f.call(tool, { projectId: f.project.id, ...params })).data).toEqual(await response.json());
    }
    const exact = { ...query, presetId: "node:test", head: "abc", statusDigest: "clean", dirty: false, processOutcome: "passed", attribution: "observed_match" };
    expect(await (await f.get("test-runs", exact)).json()).toEqual((await f.call("list_test_runs", { projectId: f.project.id, ...exact })).data);
    const first = await f.call("list_test_runs", { ...f.filter, limit: 1 });
    const next = await f.get("test-runs", { ...query, cursor: first.data.nextCursor });
    expect((await next.json()).items).toHaveLength(1); // cursor crosses transports
    for (const invalid of [{ ...query, limit: 51 }, { ...query, dirty: "no" }, { ...query, unknown: "x" }, { ...query, cursor: "invalid" }]) {
      expect((await f.get("test-runs", invalid)).status).toBe(400);
      expect((await f.client.callTool({ name: "list_test_runs", arguments: { projectId: f.project.id, ...invalid } })).isError).toBe(true);
    }
    expect((await fetch(`${f.base}/api/projects/${f.project.id}/test-runs?${new URLSearchParams(query)}&limit=1&limit=2`, { headers: { "X-Worktree-Control-Token": "runtime-token" } })).status).toBe(400);
    const cross = await f.get(`test-runs/${a.id}`, {}, undefined, f.other.id);
    const missing = await f.get(`test-runs/${randomUUID()}`, {}, undefined, f.other.id);
    expect(cross.status).toBe(400); expect(await cross.json()).toEqual(await missing.json());
    const crossTool = await f.client.callTool({ name: "get_test_run_summary", arguments: { projectId: f.other.id, runId: a.id } });
    const missingTool = await f.client.callTool({ name: "get_test_run_summary", arguments: { projectId: f.other.id, runId: randomUUID() } });
    expect(crossTool).toEqual(missingTool);
    expect((await f.get("test-runs", { ...query, cursor: first.data.nextCursor }, undefined, f.other.id)).status).toBe(400);
    expect((await f.client.callTool({ name: "list_test_runs", arguments: { ...f.filter, projectId: f.other.id, cursor: first.data.nextCursor } })).isError).toBe(true);
  });

  it("keeps scoped Knowledge credentials outside verification, with no guessed project/run/cursor leakage", async () => {
    const f = await transports(), run = f.run(); f.store.saveTestRun(run);
    const { projectId: _projectId, ...query } = f.filter; void _projectId;
    for (const operation of ["test-runs", "test-metrics", `test-runs/${run.id}`, `test-runs/${randomUUID()}`, "test-run-comparison"]) {
      expect((await f.get(operation, query, {})).status).toBe(401);
      expect((await f.get(operation, query, { Authorization: "Bearer scoped" })).status).toBe(401);
      expect((await f.get(operation, query, { "X-Worktree-Control-Token": "runtime-token", Origin: "https://foreign.invalid" })).status).toBe(403);
    }
    const scoped = new Client({ name: "scoped-history", version: "1" });
    await scoped.connect(new StreamableHTTPClientTransport(f.endpoint, { requestInit: { headers: { Authorization: "Bearer scoped" } } })); cleanup.push(() => scoped.close());
    const names = (await scoped.listTools()).tools.map(t => t.name);
    for (const name of ["list_test_runs", "get_test_metrics", "get_test_run_summary", "compare_test_runs"]) {
      expect(names).not.toContain(name);
      expect((await scoped.callTool({ name, arguments: { ...f.filter, runId: run.id, leftRunId: run.id, rightRunId: run.id } })).isError).toBe(true);
    }
  });
});
