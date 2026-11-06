import { describe, expect, it } from "vitest";

import type { TestRun } from "@/shared/contracts";
import { MAX_CONSECUTIVE_SUPERSEDED, WebExportSession } from "./web-export-session";

function run(overrides: Partial<TestRun> & { processOutcome?: TestRun["source"]["processOutcome"]; termination?: string; queueComparison?: TestRun["source"]["queueComparison"] } = {}): TestRun {
  const { processOutcome = "passed", termination = "exit", queueComparison = "match", ...rest } = overrides;
  return {
    id: "run-1", phase: "failed", startedAt: new Date(1_000).toISOString(), exitCode: 0,
    source: { processOutcome, queueComparison }, telemetry: { termination },
    ...rest,
  } as unknown as TestRun;
}

describe("Godot Web export session", () => {
  it("keeps one export in flight and coalesces later requests into one follow-up", () => {
    let now = 0;
    const session = new WebExportSession("p", "/w", () => now);
    expect(session.request("start")).toBe(true);
    session.activeRunId = "run-1";
    for (let index = 0; index < 5; index += 1) { now = 500 + index; expect(session.request("change")).toBe(false); }
    expect(session.pending).toBe(true);
    // Changes before process start are included in that export.
    expect(session.decide(run())).toEqual({ kind: "publish" });
    expect(session.finish({ kind: "publish" })).toBe(true);
    expect(session.pending).toBe(false);
    expect(session.activeRunId).toBeNull();
  });

  it("treats process success with edits during the export as superseded, not published", () => {
    let now = 0;
    const session = new WebExportSession("p", "/w", () => now);
    session.activeRunId = "run-1";
    now = 2_000; session.request("change");
    // Dirty source: the queue reports phase failed, but the process passed.
    expect(session.decide(run({ phase: "failed" }))).toEqual({ kind: "superseded" });
    expect(session.finish({ kind: "superseded" })).toBe(true);
  });

  it("classifies failures without ever publishing them", () => {
    const session = new WebExportSession("p", "/w", () => 0);
    session.activeRunId = "run-1";
    expect(session.decide(run({ processOutcome: "failed", exitCode: 2 }))).toMatchObject({ kind: "failed", code: "export_failed", message: expect.stringContaining("code 2") });
    expect(session.decide(run({ processOutcome: "timed_out" }))).toMatchObject({ code: "export_timed_out" });
    expect(session.decide(run({ processOutcome: "cancelled" }))).toMatchObject({ code: "export_cancelled" });
    expect(session.decide(run({ processOutcome: null, termination: "rejected", queueComparison: "changed", startedAt: null }))).toEqual({ kind: "superseded" });
    expect(session.decide(run({ processOutcome: null, termination: "rejected", queueComparison: "unknown", startedAt: null }))).toMatchObject({ code: "queue_rejected" });
    expect(session.decide(run({ id: "other" }))).toEqual({ kind: "ignored" });
  });

  it("pauses automatic rebuilds after repeated supersession until a manual rebuild", () => {
    let now = 0;
    const session = new WebExportSession("p", "/w", () => now);
    for (let index = 0; index < MAX_CONSECUTIVE_SUPERSEDED; index += 1) {
      session.activeRunId = "run-1";
      now += 5_000; session.request("change");
      const rerun = session.finish({ kind: "superseded" });
      expect(rerun).toBe(index < MAX_CONSECUTIVE_SUPERSEDED - 1);
    }
    expect(session.autoPaused).toBe(true);
    expect(session.status(null)).toMatchObject({ state: "failed", lastFailure: { code: "superseded" } });
    expect(session.request("change")).toBe(false);
    expect(session.request("manual")).toBe(true);
    expect(session.autoPaused).toBe(false);
  });

  it("never schedules work after disposal and releases drain waiters", async () => {
    const session = new WebExportSession("p", "/w", () => 0);
    session.activeRunId = "run-1";
    const settled = session.settled(10_000);
    session.dispose();
    expect(session.request("manual")).toBe(false);
    expect(session.decide(run())).toEqual({ kind: "ignored" });
    expect(session.finish({ kind: "ignored" })).toBe(false);
    await settled;
  });

  it("reports stale served builds and queued/building states", () => {
    let now = 10_000;
    const session = new WebExportSession("p", "/w", () => now);
    session.current = { id: "g", publishedAt: new Date(5_000).toISOString(), runId: "r", head: null, dirty: false, files: 1, bytes: 1 };
    expect(session.status(null)).toMatchObject({ state: "ready", currentStale: false });
    session.request("change");
    expect(session.status(null)).toMatchObject({ state: "ready", currentStale: true });
    session.activeRunId = "run-1";
    expect(session.status("queued").state).toBe("queued");
    expect(session.status("running").state).toBe("building");
    now += 1;
  });
});
