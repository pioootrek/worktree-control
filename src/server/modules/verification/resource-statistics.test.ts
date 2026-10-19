import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestRunResources, TestRunSummary } from "@/shared/contracts";
import type { OwnedResourceSampler, ProcessGroupSnapshot } from "@/server/resource-monitor";
import { emptyRunResources, observeRunResources } from "./run-resources";
import { compareResources } from "./resource-statistics";

const member = (pid = 42, ticks = 10, startTicks = pid, rssBytes = 100) => ({ pid, startTicks, cpuTicks: ticks, rssBytes, processGroupId: 42, state: "S" });
const snapshot = (members = [member()], at = 0, extra: Partial<ProcessGroupSnapshot> = {}): ProcessGroupSnapshot => ({
  members, hostCpuTicks: 100 + at / 10, observedAtMs: at, cpuCount: 2, incomplete: false, ...extra,
});
const summary = (resources: TestRunResources) => ({ telemetry: { resources } }) as TestRunSummary;
const compare = (a: TestRunResources, b = a) => compareResources(summary(a), summary(b), true);
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

async function observed(mode: "exit" | "late" | "identity" | "read" | "owned_read" | "counter" | "short") {
  vi.useFakeTimers();
  const state = emptyRunResources("pending");
  let alive = true, release!: (s: ProcessGroupSnapshot) => void;
  const sampler: OwnedResourceSampler = { supported: true, capture: async () => ({ pid: 42, startTicks: 42 }), snapshot: vi.fn() };
  const sample = vi.mocked(sampler.snapshot);
  sample.mockResolvedValueOnce(snapshot([member(), member(43)]));
  sample.mockResolvedValueOnce(snapshot([member(42, 20), member(44, 900)], 1000, { processChurn: true }));
  if (mode === "late") sample.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  else if (mode === "read") sample.mockRejectedValueOnce(Error("EACCES"));
  else if (mode === "owned_read") sample.mockResolvedValueOnce(snapshot([member(42, 30)], 2000, { incomplete: true }));
  else if (mode === "identity") sample.mockResolvedValueOnce(snapshot([member(42, 30, 999)], 2000));
  else if (mode === "counter") sample.mockResolvedValueOnce(snapshot([member(42, 19), member(44, 910)], 2000));
  else sample.mockResolvedValueOnce(snapshot([], 2000));
  const observer = observeRunResources(state, 42, () => alive, () => {}, { sampler });
  await drain();
  if (mode !== "short") {
    await vi.advanceTimersByTimeAsync(1000);
    if (mode === "exit") alive = false;
    await vi.advanceTimersByTimeAsync(1000);
  }
  observer.stop();
  const final = structuredClone(state);
  if (mode === "late") { release(snapshot([], 2000)); await drain(); expect(state).toEqual(final); }
  expect(vi.getTimerCount()).toBe(0);
  return state;
}

describe("comparison quality from real observer summaries", () => {
  it.each(["exit", "late"] as const)("retains descriptive deltas through membership/global churn and %s final tick", async mode => {
    const state = await observed(mode);
    expect(state).toMatchObject({ status: "partial", sampleCount: 2, cpuIntervalCount: 1, peakSampledCpuPercent: 20 });
    expect(state.reasons).toContain("process_churn");
    expect(state.reasons).toContain("membership_changed");
    expect(state.reasons).toContain(mode === "exit" ? "group_exited" : "inflight_discarded");
    expect(state.reasons).not.toContain("identity_lost");
    const other = { ...state, peakSampledRssBytes: 500, peakSampledCpuPercent: 40 };
    expect(compare(state, other)).toMatchObject({ rss: { delta: 300 }, cpu: { delta: 20 } });
  });

  it.each(["identity", "read", "owned_read"] as const)("excludes %s integrity loss despite preceding usable peaks", async mode => {
    const state = await observed(mode);
    expect(state.sampleCount).toBeGreaterThanOrEqual(2);
    expect(compare(state)).toMatchObject({ rss: { delta: null }, cpu: { delta: null } });
    expect(state.reasons).toContain({ identity: "identity_lost", read: "read_failed", owned_read: "incomplete_scan" }[mode]);
  });

  it("does not add a CPU interval containing one regressed counter; keeps RSS comparison", async () => {
    const state = await observed("counter");
    expect(state).toMatchObject({ cpuIntervalCount: 1, observedCpuWindowMs: 1000, peakSampledCpuPercent: 20 });
    expect(state.reasons).toContain("counter_gap");
    expect(compare(state)).toMatchObject({ rss: { delta: 0 }, cpu: { delta: null } });
  });

  it("permits only RSS with no observed CPU interval", async () => {
    const state = await observed("short");
    expect(state.reasons).toContain("no_cpu_interval");
    expect(compare(state)).toMatchObject({ rss: { delta: 0 }, cpu: { left: null, delta: null } });
  });

  it("rejects incompatible source/cadence, unqualified old partial, missing and legacy summaries", async () => {
    const state = await observed("exit");
    for (const other of [
      { ...state, intervalMs: 2000 }, { ...state, source: "other" } as unknown as TestRunResources,
      { ...state, cpuNormalization: "other" } as unknown as TestRunResources,
      { ...state, coverage: "other" } as unknown as TestRunResources,
      { ...state, reasons: [] }, { ...state, reasons: ["incomplete_scan"] } as TestRunResources,
      emptyRunResources(), emptyRunResources("unavailable"),
    ]) expect(compare(state, other)).toMatchObject({ rss: { delta: null }, cpu: { delta: null } });
    expect(compareResources(summary(state), summary(state), false)).toMatchObject({ rss: { delta: null }, cpu: { delta: null } });
  });
});
