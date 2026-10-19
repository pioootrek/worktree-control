import type { TestRunResources, TestRunSummary } from "@/shared/contracts";
import type { TestMetricPopulation, TestResourceMetrics, TestResourceStatistic, TestRunComparison } from "@/shared/contracts/verification-history";
import { emptyRunResources } from "./run-resources";

const value = (s: TestRunResources, key: "peakSampledRssBytes" | "peakSampledCpuPercent") => {
  const n = s[key];
  return (s.status === "sampled" || s.status === "partial") && s.sampleCount > 0 && typeof n === "number" && Number.isFinite(n) && n >= 0
    && (key !== "peakSampledCpuPercent" || s.cpuIntervalCount > 0) ? n : null;
};
function statistic(summaries: TestRunSummary[], key: "peakSampledRssBytes" | "peakSampledCpuPercent"): TestResourceStatistic {
  const states = summaries.map(s => s.telemetry.resources ?? emptyRunResources());
  const statuses: TestResourceStatistic["statuses"] = { pending: 0, sampled: 0, partial: 0, unavailable: 0, unsupported: 0, legacy_unknown: 0 };
  for (const state of states) statuses[state.status]++;
  const values = states.map(s => value(s, key)).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const n = values.length;
  return { median: n ? values[Math.floor((n - 1) / 2)] / 2 + values[Math.floor(n / 2)] / 2 : null,
    p95: n ? values[Math.ceil(n * 0.95) - 1] : null, valid: n, missing: states.length - n, denominator: states.length,
    statuses, sampleCount: states.reduce((sum, s) => sum + s.sampleCount, 0), cpuIntervalCount: states.reduce((sum, s) => sum + s.cpuIntervalCount, 0) };
}
export function resourceMetrics(groups: Record<TestMetricPopulation, TestRunSummary[]>): TestResourceMetrics {
  const cpu = {} as TestResourceMetrics["cpu"]["populations"], rss = {} as TestResourceMetrics["rss"]["populations"];
  for (const name of Object.keys(groups) as TestMetricPopulation[]) {
    cpu[name] = statistic(groups[name], "peakSampledCpuPercent");
    rss[name] = statistic(groups[name], "peakSampledRssBytes");
  }
  return { cpu: { metric: "peak_sampled_cpu_percent", unit: "percent_one_core", populations: cpu },
    rss: { metric: "peak_sampled_summed_rss", unit: "bytes", populations: rss }, runnerWait: "unavailable" };
}
export function compareResources(a: TestRunSummary, b: TestRunSummary, completed: boolean): TestRunComparison["resources"] {
  const left = a.telemetry.resources ?? emptyRunResources(), right = b.telemetry.resources ?? emptyRunResources();
  const compatible = completed && left.status === "sampled" && right.status === "sampled"
    && left.intervalMs === right.intervalMs && left.source === right.source;
  const metric = (key: "peakSampledRssBytes" | "peakSampledCpuPercent") => {
    const l = value(left, key), r = value(right, key);
    return { left: l, right: r, delta: compatible && l !== null && r !== null ? r - l : null,
      interpretation: "descriptive_sampled_peaks_only" as const };
  };
  return { cpu: metric("peakSampledCpuPercent"), rss: metric("peakSampledRssBytes"), runnerWait: "unavailable" };
}
