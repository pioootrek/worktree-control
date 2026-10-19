import type { TestRunSummary } from "@/shared/contracts";
import type { TestRunComparison, TestSummaryEntry } from "@/shared/contracts/verification-history";

/**
 * Field values reproduced from the 2026-10-19 WinPath `node:typecheck` pilot
 * (run 2e5497e3…, observed_match, partial membership_changed). Paths are kept;
 * no credentials or environment values exist in summaries.
 */
export function pilotSummary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    version: 1, runId: "2e5497e3-3228-47d5-b2a6-8363d6294bd6", projectId: "17493a1a-8027-4c7d-81c4-b307541ac845",
    presetId: "node:typecheck", worktreePath: "/home/pioootrek/development/win-path-6",
    commandDigest: "e0acbef64a6b6c661820ef910fe16db4c03a7ae897d17f52cb5402419eaa6e89",
    profileDigest: "29c7c772b75b61f12585d60a2ef9eabac615948bac3df27647e584a91486acf6",
    sourceIdentity: { head: "1034e6a3bcaf84ba4ebb311652913397f9f29f09", statusDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", dirty: false },
    queuedAt: "2026-10-19T17:46:38.204Z", startedAt: "2026-10-19T17:46:41.564Z", finishedAt: "2026-10-19T17:47:14.652Z",
    phase: "passed", processOutcome: "passed", attribution: "observed_match", sourceReasonCodes: [], exitCode: 0, signal: null,
    telemetry: {
      version: 1, availability: "observed",
      resources: {
        version: 1, source: "linux_proc_process_group", cpuNormalization: "one_core_100_percent", coverage: "sampled_members_remaining_in_owned_pgid",
        status: "partial", intervalMs: 1000, sampleCount: 33, attemptCount: 33, missingSampleCount: 0, partialSampleCount: 2, cpuIntervalCount: 32,
        observedCpuWindowMs: 32739.056949000005, peakSampledRssBytes: 2944552960, peakSampledCpuPercent: 191.44736842105266, peakSampledProcessCount: 4,
        firstSampledAt: "2026-10-19T17:46:41.601Z", lastSampledAt: "2026-10-19T17:47:14.340Z", reasons: ["membership_changed"],
      },
      admittedAt: "2026-10-19T17:46:41.428Z", prepareFinishedAt: "2026-10-19T17:46:41.564Z", spawnedAt: "2026-10-19T17:46:41.569Z",
      exitedAt: "2026-10-19T17:47:14.621Z", stopRequestedAt: null, cleanupStartedAt: "2026-10-19T17:47:14.621Z", cleanupFinishedAt: "2026-10-19T17:47:14.651Z",
      finalizationStartedAt: "2026-10-19T17:47:14.651Z", finalizedAt: "2026-10-19T17:47:14.789Z", recoveredAt: null,
      durations: { queueMs: 3223.439403000004, prepareMs: 136.66182899999694, processMs: 33051.54788600001, cleanupMs: 30.73401400000148, finalizationMs: 137.73891900001036, totalMs: 36585.12195700001, runnerWaitMs: null },
      termination: "exit", cleanup: "confirmed",
    },
    ...overrides,
  };
}

export const pilotEntry = (overrides: Partial<TestRunSummary> = {}): TestSummaryEntry => ({ summary: pilotSummary(overrides), detailAvailable: true });

/** Comparison values from the same pilot pair (2e5497e3… vs 320af0b4…). */
export function pilotComparison(): TestRunComparison {
  const left = pilotEntry();
  const base = pilotSummary().telemetry;
  const right = pilotEntry({
    runId: "320af0b4-bf21-4857-99f1-4b3a2ef57933", queuedAt: "2026-10-19T17:47:49.952Z", startedAt: "2026-10-19T17:47:50.143Z", finishedAt: "2026-10-19T17:48:00.214Z",
    telemetry: {
      ...base,
      resources: { ...base.resources!, sampleCount: 10, attemptCount: 10, cpuIntervalCount: 9, observedCpuWindowMs: 9218.898174000002,
        peakSampledRssBytes: 1793646592, peakSampledCpuPercent: 219.24959216965743, firstSampledAt: "2026-10-19T17:47:50.176Z", lastSampledAt: "2026-10-19T17:47:59.394Z" },
      admittedAt: "2026-10-19T17:47:49.961Z", prepareFinishedAt: "2026-10-19T17:47:50.143Z", spawnedAt: "2026-10-19T17:47:50.150Z", exitedAt: "2026-10-19T17:48:00.207Z",
      cleanupStartedAt: "2026-10-19T17:48:00.207Z", cleanupFinishedAt: "2026-10-19T17:48:00.213Z", finalizationStartedAt: "2026-10-19T17:48:00.214Z", finalizedAt: "2026-10-19T17:48:00.375Z",
      durations: { queueMs: 9.056127999996534, prepareMs: 182.1204260000086, processMs: 10056.67261699999, cleanupMs: 6.480868999991799, finalizationMs: 161.80988100000832, totalMs: 10423.077072, runnerWaitMs: null },
    },
  });
  return {
    left, right,
    differences: { source: false, command: false, profile: false, preset: false, worktree: false },
    timings: {
      queueMs: { leftMs: 3223.439403000004, rightMs: 9.056127999996534, deltaMs: -3214.3832750000074 },
      prepareMs: { leftMs: 136.66182899999694, rightMs: 182.1204260000086, deltaMs: 45.45859700001165 },
      processMs: { leftMs: 33051.54788600001, rightMs: 10056.67261699999, deltaMs: -22994.87526900002 },
      cleanupMs: { leftMs: 30.73401400000148, rightMs: 6.480868999991799, deltaMs: -24.25314500000968 },
      finalizationMs: { leftMs: 137.73891900001036, rightMs: 161.80988100000832, deltaMs: 24.070961999997962 },
      totalMs: { leftMs: 36585.12195700001, rightMs: 10423.077072, deltaMs: -26162.04488500001 },
    },
    populations: { left: "completed_execution", right: "completed_execution" },
    caveats: [
      "Git identities do not prove identical files, environment, tools or external services; matching runs do not prove unnecessary duplication or flakiness.",
      "Profile digests identify policy selection, not environment values; process time includes unobserved runner wait.",
      "Resources are sampled peaks of summed RSS and observed per-generation CPU deltas (100% = one core), not complete job totals.",
    ],
    resources: {
      cpu: { left: 191.44736842105266, right: 219.24959216965743, delta: 27.802223748604774, interpretation: "descriptive_sampled_peaks_only" },
      rss: { left: 2944552960, right: 1793646592, delta: -1150906368, interpretation: "descriptive_sampled_peaks_only" },
      runnerWait: "unavailable",
    },
  };
}
