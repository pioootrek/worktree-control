import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessGroupSnapshot, OwnedResourceSampler } from "@/server/resource-monitor";
import { emptyRunResources, observeRunResources, RunResourceAccumulator } from "./run-resources";

const member = (pid = 42, startTicks = 100, cpuTicks = 5, rssBytes = 100) => ({ pid, startTicks, cpuTicks, rssBytes, processGroupId: 42, state: "S" });
const snapshot = (members = [member()], at = 0, extra: Partial<ProcessGroupSnapshot> = {}): ProcessGroupSnapshot => ({
  members, observedAtMs: at, hostCpuTicks: 100 + at / 10, cpuCount: 2, incomplete: false, ...extra,
});
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("per-generation observed resources", () => {
  it("computes one-core percentages from matching generations, not changing aggregate sums", () => {
    const summary = emptyRunResources("pending", 1000), a = new RunResourceAccumulator(summary, { pid: 42, startTicks: 100 });
    a.add(snapshot([member(), member(43, 101, 500, 200)]), "t0");
    a.add(snapshot([member(42, 100, 15), member(44, 102, 900, 300)], 1000), "t1");
    expect(summary).toMatchObject({ peakSampledRssBytes: 400, peakSampledProcessCount: 2, peakSampledCpuPercent: 20,
      cpuIntervalCount: 1, observedCpuWindowMs: 1000, partialSampleCount: 1, status: "partial", reasons: ["membership_changed"] });
    // Reusing the child PID does not add its new generation's cumulative CPU.
    a.add(snapshot([member(42, 100, 25), member(44, 103, 1000)], 2000), "t2");
    expect(summary.peakSampledCpuPercent).toBe(20);
  });

  it("continues after leader exit through an observed member, then rejects group reuse permanently", () => {
    const summary = emptyRunResources(), a = new RunResourceAccumulator(summary, { pid: 42, startTicks: 100 });
    expect(a.add(snapshot([member(), member(43, 101)]), "t0")).toBe(true);
    expect(a.add(snapshot([member(43, 101, 10), member(44, 102)], 1000), "t1")).toBe(true);
    expect(a.add(snapshot([member(43, 201, 90000)], 2000), "t2")).toBe(false);
    expect(a.add(snapshot([member()], 3000), "t3")).toBe(false);
    expect(summary.sampleCount).toBe(2);
    expect(summary.reasons).toContain("identity_lost");
  });

  it("rejects a reused leader even if a previous member is included", () => {
    const summary = emptyRunResources(), a = new RunResourceAccumulator(summary, { pid: 42, startTicks: 100 });
    a.add(snapshot([member(), member(43, 101)]), "t0");
    expect(a.add(snapshot([member(42, 999), member(43, 101)], 1000), "t1")).toBe(false);
    expect(summary).toMatchObject({ sampleCount: 1, missingSampleCount: 1, peakSampledCpuPercent: null });
  });

  it("keeps incomplete RSS and read failures explicit and never bridges missing CPU endpoints", () => {
    const summary = emptyRunResources(), a = new RunResourceAccumulator(summary, { pid: 42, startTicks: 100 });
    a.add(snapshot(), "t0"); a.missing("read_failed");
    a.add(snapshot([member(42, 100, 100)], 2000, { incomplete: true }), "t2");
    expect(summary).toMatchObject({ status: "partial", missingSampleCount: 1, partialSampleCount: 1, cpuIntervalCount: 0, peakSampledCpuPercent: null });
    a.add(snapshot([member(42, 100, 90)], 3000), "t3");
    expect(summary.reasons).toContain("counter_gap");
    expect(summary.peakSampledCpuPercent).toBeNull();
  });
});

function sampler(): OwnedResourceSampler {
  return { supported: true, capture: vi.fn(async () => ({ pid: 42, startTicks: 100 })), snapshot: vi.fn(async () => snapshot()) };
}
describe("passive observer lifetime", () => {
  it("does not overlap slow samples and discards in-flight completion without waiting", async () => {
    vi.useFakeTimers();
    const s = sampler(), summary = emptyRunResources("pending"), updated = vi.fn();
    let release!: (value: ProcessGroupSnapshot) => void;
    vi.mocked(s.snapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const observer = observeRunResources(summary, 42, () => true, updated, { sampler: s });
    await drain(); await vi.advanceTimersByTimeAsync(5000);
    expect(s.snapshot).toHaveBeenCalledTimes(1);
    observer.stop(); const before = structuredClone(summary);
    release(snapshot()); await drain(); await vi.advanceTimersByTimeAsync(5000);
    expect(summary).toEqual(before); expect(updated).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ status: "unavailable", sampleCount: 0, missingSampleCount: 1, peakSampledRssBytes: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["unsupported", "capture_failure", "exited_before_capture", "short", "read_failure"])("reports %s without throwing or manufacturing zero", async mode => {
    vi.useFakeTimers(); const s = sampler(), summary = emptyRunResources("pending"), updated = vi.fn();
    if (mode === "unsupported") Object.assign(s, { supported: false });
    if (mode === "capture_failure") vi.mocked(s.capture).mockRejectedValue(Error("missing"));
    if (mode === "read_failure") vi.mocked(s.snapshot).mockRejectedValue(Error("EACCES"));
    const observer = observeRunResources(summary, 42, () => mode !== "exited_before_capture", updated, { sampler: s });
    if (mode === "short") observer.stop();
    await drain(); observer.stop();
    expect(summary.peakSampledRssBytes).toBeNull(); expect(summary.peakSampledCpuPercent).toBeNull();
    expect(summary.status).toBe(mode === "unsupported" ? "unsupported" : "unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes after read failure, reports actual CPU window, and disposes exactly once", async () => {
    vi.useFakeTimers(); const s = sampler(), summary = emptyRunResources("pending");
    vi.mocked(s.snapshot).mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(Error("EIO"))
      .mockResolvedValueOnce(snapshot([member(42, 100, 10)], 2000)).mockResolvedValueOnce(snapshot([member(42, 100, 20)], 3000));
    const observer = observeRunResources(summary, 42, () => true, () => {}, { sampler: s });
    await drain(); await vi.advanceTimersByTimeAsync(3000); observer.stop(); observer.stop();
    expect(summary).toMatchObject({ attemptCount: 4, sampleCount: 3, missingSampleCount: 1, cpuIntervalCount: 1,
      peakSampledCpuPercent: 20, observedCpuWindowMs: 1000, status: "partial" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
