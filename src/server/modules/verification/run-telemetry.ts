import type { TestRun, TestRunTelemetry } from "@/shared/contracts";
import { emptyRunResources } from "./run-resources";

export interface VerificationClock {
  wallNow(): string;
  monotonicNow(): number;
}
export const verificationClock: VerificationClock = {
  wallNow: () => new Date().toISOString(),
  monotonicNow: () => performance.now(),
};
export function emptyTelemetry(availability: TestRunTelemetry["availability"] = "legacy_unknown"): TestRunTelemetry {
  return {
    version: 1, availability, resources: emptyRunResources(), admittedAt: null, prepareFinishedAt: null, spawnedAt: null,
    exitedAt: null, stopRequestedAt: null, cleanupStartedAt: null, cleanupFinishedAt: null,
    finalizationStartedAt: null, finalizedAt: null, recoveredAt: null,
    durations: { queueMs: null, prepareMs: null, processMs: null, cleanupMs: null, finalizationMs: null, totalMs: null, runnerWaitMs: null },
    termination: "unknown", cleanup: "unknown",
  };
}
type Milestone = "queuedAt" | "admittedAt" | "prepareFinishedAt" | "spawnedAt" | "exitedAt" | "stopRequestedAt" | "cleanupStartedAt" | "cleanupFinishedAt" | "finalizationStartedAt" | "finalizedAt";

/** Measurement state only; scheduling and process ownership remain in TestJobManager. */
export class RunTelemetryRecorder {
  private readonly observations = new Map<string, Partial<Record<Milestone, number | null>>>();
  constructor(private readonly clock: VerificationClock) {}

  mark(run: TestRun, milestone: Milestone): void {
    const telemetry = run.telemetry ??= emptyTelemetry("observed");
    const marks = this.observations.get(run.id) ?? {};
    if (milestone in marks) return;
    let tick: number | null = null;
    try {
      const value = this.clock.monotonicNow();
      if (Number.isFinite(value)) tick = value;
    } catch { /* Missing measurement must not alter the command result. */ }
    if (tick === null) telemetry.availability = "partial";
    marks[milestone] = tick;
    this.observations.set(run.id, marks);
    if (milestone !== "queuedAt") telemetry[milestone] = this.clock.wallNow();
    const duration = (start: Milestone, end: Milestone): number | null => {
      const a = marks[start], b = marks[end];
      return typeof a === "number" && typeof b === "number" && b >= a ? b - a : null;
    };
    telemetry.durations = {
      queueMs: duration("queuedAt", "admittedAt" in marks ? "admittedAt" : "stopRequestedAt"), prepareMs: duration("admittedAt", "prepareFinishedAt"),
      processMs: duration("spawnedAt", "exitedAt"), cleanupMs: duration("cleanupStartedAt", "cleanupFinishedAt"),
      finalizationMs: duration("finalizationStartedAt", "finalizedAt"), totalMs: duration("queuedAt", "finalizedAt"), runnerWaitMs: null,
    };
  }
  forget(runId: string): void { this.observations.delete(runId); }
}
