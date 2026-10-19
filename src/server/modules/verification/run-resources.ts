import type { TestResourceReason, TestRunResources } from "@/shared/contracts";
import { defaultProcessResourceSampler, type OwnedResourceIdentity, type OwnedResourceSampler, type ProcessGroupSnapshot } from "@/server/resource-monitor";

export const TEST_RESOURCE_INTERVAL_MS = 1000;
export function emptyRunResources(status: TestRunResources["status"] = "legacy_unknown", intervalMs: number | null = null): TestRunResources {
  return { version: 1, source: "linux_proc_process_group", cpuNormalization: "one_core_100_percent", coverage: "sampled_members_remaining_in_owned_pgid", status, intervalMs, sampleCount: 0, attemptCount: 0,
    missingSampleCount: 0, partialSampleCount: 0, cpuIntervalCount: 0, observedCpuWindowMs: 0,
    peakSampledRssBytes: null, peakSampledCpuPercent: null, peakSampledProcessCount: null,
    firstSampledAt: null, lastSampledAt: null, reasons: status === "legacy_unknown" ? ["legacy_unknown"] : [] };
}
export function resourceReason(summary: TestRunResources, reason: TestResourceReason): void {
  if (!summary.reasons.includes(reason)) summary.reasons.push(reason);
}

/** Keeps only the preceding bounded membership, never lifetime CPU totals. */
export class RunResourceAccumulator {
  private known = new Map<number, number>();
  private previous: ProcessGroupSnapshot | null = null;
  private lost = false;
  constructor(readonly summary: TestRunResources, private readonly identity: OwnedResourceIdentity) {}

  missing(reason: TestResourceReason): void {
    this.summary.missingSampleCount++;
    resourceReason(this.summary, reason);
    this.previous = null;
    this.summary.status = this.summary.sampleCount ? "partial" : "unavailable";
  }

  add(snapshot: ProcessGroupSnapshot, wallNow: string): boolean {
    if (this.lost) return false;
    const leader = snapshot.members.find(m => m.pid === this.identity.pid);
    const anchored = leader ? leader.startTicks === this.identity.startTicks
      : snapshot.members.some(m => this.known.get(m.pid) === m.startTicks);
    if (!anchored) {
      this.lost = true; this.missing("identity_lost"); return false;
    }
    const s = this.summary;
    const members = snapshot.members;
    const current = new Map(members.map(m => [m.pid, m.startTicks]));
    let partial = snapshot.incomplete;
    if (snapshot.incomplete) resourceReason(s, "incomplete_scan");
    const previous = this.previous;
    if (previous) {
      const previousMembers = new Map(previous.members.map(m => [m.pid, m]));
      const changed = current.size !== this.known.size || members.some(m => this.known.get(m.pid) !== m.startTicks);
      if (changed) { partial = true; resourceReason(s, "membership_changed"); }
      const hostDelta = snapshot.hostCpuTicks - previous.hostCpuTicks;
      const elapsed = snapshot.observedAtMs - previous.observedAtMs;
      let ticks = 0, pairs = 0;
      for (const member of members) {
        const before = previousMembers.get(member.pid);
        if (!before || before.startTicks !== member.startTicks) continue;
        const delta = member.cpuTicks - before.cpuTicks;
        if (delta < 0) { partial = true; resourceReason(s, "counter_gap"); continue; }
        ticks += delta; pairs++;
      }
      if (pairs && hostDelta > 0 && elapsed > 0 && snapshot.cpuCount === previous.cpuCount) {
        const percent = ticks / hostDelta * snapshot.cpuCount * 100;
        if (Number.isFinite(percent)) {
          s.peakSampledCpuPercent = Math.max(s.peakSampledCpuPercent ?? 0, percent);
          s.cpuIntervalCount++; s.observedCpuWindowMs += elapsed;
        }
      } else { partial = true; resourceReason(s, "counter_gap"); }
    }
    const rss = members.reduce((sum, m) => sum + m.rssBytes, 0);
    s.peakSampledRssBytes = Math.max(s.peakSampledRssBytes ?? 0, rss);
    s.peakSampledProcessCount = Math.max(s.peakSampledProcessCount ?? 0, members.length);
    s.sampleCount++;
    if (partial) s.partialSampleCount++;
    s.firstSampledAt ??= wallNow; s.lastSampledAt = wallNow;
    s.status = s.partialSampleCount || s.missingSampleCount ? "partial" : "sampled";
    this.known = current; this.previous = snapshot;
    return true;
  }
}

export interface RunResourceObservation { stop(): void }
export interface RunResourceOptions { sampler?: OwnedResourceSampler; intervalMs?: number; wallNow?: () => string }

/** One self-scheduling observer per run. Closing it never waits on procfs, and
 * late reads are discarded. The shared collector drains/ closes its descriptors.
 * isSpawnedChild must verify the just-spawned ChildProcess has not exited while
 * its initial generation is captured; persisted PIDs must never enter this path.
 */
export function observeRunResources(
  summary: TestRunResources, pid: number, isSpawnedChild: () => boolean,
  onUpdate: () => void, options: RunResourceOptions = {},
): RunResourceObservation {
  const sampler = options.sampler ?? defaultProcessResourceSampler();
  const intervalMs = typeof options.intervalMs === "number" && Number.isFinite(options.intervalMs) && options.intervalMs >= 1
    ? options.intervalMs : TEST_RESOURCE_INTERVAL_MS;
  const wallNow = options.wallNow ?? (() => new Date().toISOString());
  summary.intervalMs = intervalMs;
  let stopped = false, inflight = false;
  let timer: NodeJS.Timeout | null = null;
  let accumulator: RunResourceAccumulator | null = null;
  let minimumScanGeneration: number | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (inflight) { summary.missingSampleCount++; resourceReason(summary, "inflight_discarded"); }
    if (!summary.cpuIntervalCount && summary.sampleCount) resourceReason(summary, "no_cpu_interval");
    if (summary.status !== "unsupported") summary.status = summary.sampleCount ?
      (summary.missingSampleCount || summary.partialSampleCount ? "partial" : "sampled") : "unavailable";
  };
  const notify = () => { try { onUpdate(); } catch { /* Best-effort observer checkpoint. */ } };
  const tick = async () => {
    if (stopped) return;
    inflight = true; summary.attemptCount++;
    try {
      if (!accumulator) {
        const identity = await sampler.capture(pid);
        if (stopped) return;
        if (!isSpawnedChild()) { resourceReason(summary, "identity_unavailable"); stop(); notify(); return; }
        accumulator = new RunResourceAccumulator(summary, identity);
        minimumScanGeneration = identity.minimumScanGeneration;
      }
      const snapshot = await sampler.snapshot(pid, minimumScanGeneration);
      if (stopped) return;
      if (!accumulator.add(snapshot, wallNow())) {
        inflight = false; stop(); notify(); return;
      }
    } catch {
      if (stopped) return;
      if (accumulator) accumulator.missing("read_failed");
      else { summary.missingSampleCount++; summary.status = "unavailable"; resourceReason(summary, "identity_unavailable"); inflight = false; stop(); notify(); }
    } finally {
      inflight = false;
      if (!stopped) {
        // No persistence callback can turn observation failure into test failure.
        notify();
        timer = setTimeout(() => { timer = null; void tick(); }, intervalMs);
        timer.unref();
      }
    }
  };
  if (!sampler.supported) { summary.status = "unsupported"; resourceReason(summary, "unsupported"); }
  else void tick();
  return { stop };
}
