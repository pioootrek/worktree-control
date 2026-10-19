import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  active: 0, peak: 0, reads: 0, scans: 0, spawned: false, pauseListing: null as (() => Promise<void>) | null,
  hostTicks: 10, processTicks: 10, buffers: new Set<Buffer>(), recordPath: "", recordSize: 0,
  reusedPid: 0, missingRssPid: 0, zombiePid: 0, wrongGroupPid: 0, wrongPid: 0, malformedPid: 0, malformedEnumerationPid: 0,
  missingStatCode: "ENOENT",
  statusPids: new Set<number>(),
  fault: null as { pid: number; file: "stat" | "status"; phase: "enumeration" | "member"; at: "open" | "read"; code: string } | null,
}));
vi.mock("node:fs/promises", () => ({
  readdir: async () => {
    fixture.scans++;
    fixture.statusPids.clear();
    const entries = Array.from({ length: fixture.spawned ? 122 : 120 }, (_, index) => ({ name: String(index + 1), isDirectory: () => true }));
    const pause = fixture.pauseListing; fixture.pauseListing = null;
    await pause?.();
    return entries;
  },
  readFile: async (path: string) => {
    if (path !== "/proc/stat") throw new Error("Unbounded process read");
    return `cpu ${fixture.hostTicks} 0 0 0\n`;
  },
  open: async (path: string) => {
    const pid = Number(path.split("/")[2]);
    if (path.endsWith("/stat")) fixture.reads++;
    if (pid === 3 && fixture.missingStatCode) throw Object.assign(new Error("process unavailable"), { code: fixture.missingStatCode });
    const fault = fixture.fault;
    if (path.endsWith("/status")) fixture.statusPids.add(pid);
    const memberRead = fixture.statusPids.has(pid);
    const fail = fault?.pid === pid && path.endsWith(`/${fault.file}`)
      && (fault.phase === "member" ? memberRead : !memberRead);
    const error = () => Object.assign(new Error("injected process read failure"), { code: fault?.code });
    if (fail && fault?.at === "open") throw error();
    const fields = Array<string>(20).fill("0");
    fields[0] = pid === fixture.zombiePid && memberRead ? "Z" : "S";
    fields[2] = pid === fixture.wrongGroupPid && memberRead ? "999" : pid > 120 ? "121" : pid <= 2 ? "42" : "99";
    fields[11] = String(fixture.processTicks); fields[12] = "5"; fields[19] = pid === fixture.reusedPid && memberRead ? "999" : "100";
    const stat = (pid === fixture.malformedPid && memberRead) || (pid === fixture.malformedEnumerationPid && !memberRead)
      ? "malformed" : `${pid === fixture.wrongPid && memberRead ? 999 : pid} (fixture worker) ${fields.join(" ")}`;
    const value = path.endsWith("/status") ? pid === fixture.missingRssPid ? "Name: missing\n" : "VmRSS: 123 kB\n" : stat;
    const contents = Buffer.from(path === fixture.recordPath ? value.padEnd(fixture.recordSize, " ") : value);
    let position = 0;
    fixture.active++;
    fixture.peak = Math.max(fixture.peak, fixture.active);
    return {
      read: async (buffer: Buffer, offset: number, length: number) => {
        fixture.buffers.add(buffer);
        await new Promise<void>(resolve => setImmediate(resolve));
        if (fail && fault?.at === "read") throw error();
        // Short reads must be accumulated before parsing.
        const bytesRead = Math.min(64, length, contents.length - position);
        contents.copy(buffer, offset, position, position + bytesRead);
        position += bytesRead;
        return { bytesRead };
      },
      close: async () => { fixture.active--; },
    };
  },
}));

import { LinuxProcessResourceSampler } from "./resource-monitor";
import { emptyRunResources, observeRunResources } from "./modules/verification/run-resources";
import { compareResources } from "./modules/verification/resource-statistics";
import type { TestRunSummary } from "@/shared/contracts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

describe.skipIf(process.platform !== "linux")("bounded process inspection", () => {
  beforeEach(() => {
    fixture.active = 0; fixture.peak = 0; fixture.reads = 0; fixture.scans = 0;
    fixture.spawned = false; fixture.pauseListing = null; fixture.hostTicks = 10;
    fixture.processTicks = 10; fixture.zombiePid = 0; fixture.wrongGroupPid = 0;
    fixture.wrongPid = 0; fixture.malformedPid = 0; fixture.malformedEnumerationPid = 0; fixture.fault = null;
    fixture.statusPids.clear();
    fixture.buffers.clear(); fixture.recordPath = ""; fixture.recordSize = 0; fixture.reusedPid = 0; fixture.missingRssPid = 0;
    fixture.missingStatCode = "ENOENT";
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["completed", "inflight", "rejected"])("observes a fresh job after a %s enumeration predating spawn, then keeps sampling", async mode => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const sampler = new LinuxProcessResourceSampler(), listed = deferred(), release = deferred();
    const failure = new Error("stale listing failed");
    if (mode !== "completed") fixture.pauseListing = async () => {
      listed.resolve(); await release.promise;
      if (mode === "rejected") throw failure;
    };
    const old = sampler.snapshot(42).then(value => value, error => error);
    if (mode === "completed") await old; else await listed.promise;
    fixture.spawned = true;
    const capture = vi.spyOn(sampler, "capture");
    const summary = emptyRunResources("pending"), first = deferred(), second = deferred();
    let updates = 0;
    const observer = observeRunResources(summary, 121, () => true, () => {
      if (++updates === 1) first.resolve(); else second.resolve();
    }, { sampler });
    try {
      // Finish capture before the pre-spawn listing is allowed to complete.
      const identity = await capture.mock.results[0].value;
      const concurrent = Promise.all(Array.from({ length: 8 }, () => sampler.snapshot(121, identity.minimumScanGeneration)));
      if (mode !== "completed") expect(fixture.scans).toBe(1);
      release.resolve();
      if (mode === "rejected") expect(await old).toBe(failure); else expect((await old).members).toHaveLength(2);
      await first.promise;
      expect((await concurrent).every(sample => sample.members.length === 2)).toBe(true);
      expect(summary).toMatchObject({ sampleCount: 1, peakSampledProcessCount: 2, missingSampleCount: 0 });
      expect(summary.reasons).not.toContain("identity_lost");
      expect(fixture.scans).toBe(2);
      // The fresh result remains shareable by runtime and other job consumers.
      await Promise.all([sampler.sample(42), sampler.snapshot(99)]);
      expect(fixture.scans).toBe(2);
      now.mockReturnValue(1000); fixture.hostTicks = 110;
      await vi.advanceTimersByTimeAsync(1000); await second.promise;
      expect(summary).toMatchObject({ sampleCount: 2, cpuIntervalCount: 1, missingSampleCount: 0 });
      expect(fixture.scans).toBe(3);
      expect(fixture.peak).toBeLessThanOrEqual(8);
      expect(fixture.active).toBe(0);
      expect(fixture.buffers.size).toBe(8);
    } finally { release.resolve(); observer.stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reuses bounded buffers, handles short reads and closes descriptors on a busy host", async () => {
    const result = await new LinuxProcessResourceSampler().sample(42);
    expect(fixture.reads).toBe(122);
    expect(fixture.peak).toBeLessThanOrEqual(8);
    expect(fixture.active).toBe(0);
    expect(fixture.buffers.size).toBe(8);
    expect([...fixture.buffers].every(buffer => buffer.length === 8192)).toBe(true);
    expect(result).toMatchObject({ processCount: 2, rssBytes: 246 * 1024, processCpuTicks: 30, hostCpuTicks: 10 });
  });

  it("propagates the eligible fresh scan failure to every consumer after draining a failed stale flight", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const sampler = new LinuxProcessResourceSampler(), listed = deferred(), release = deferred();
    const staleFailure = new Error("stale listing failed"), freshFailure = new Error("fresh listing failed");
    fixture.pauseListing = async () => { listed.resolve(); await release.promise; throw staleFailure; };
    const old = sampler.snapshot(42).catch(error => error);
    try {
      await listed.promise;
      fixture.spawned = true;
      const identity = await sampler.capture(121);
      fixture.pauseListing = async () => { throw freshFailure; };
      const fresh = Promise.allSettled(Array.from({ length: 8 }, () => sampler.snapshot(121, identity.minimumScanGeneration)));
      release.resolve();
      expect(await old).toBe(staleFailure);
      for (const result of await fresh) expect(result).toEqual({ status: "rejected", reason: freshFailure });
      expect(fixture.scans).toBe(2);
      expect(fixture.active).toBe(0);
      expect(fixture.peak).toBeLessThanOrEqual(8);
    } finally { release.resolve(); await old; }
  });

  const fileFaults = (["stat", "status"] as const).flatMap(file =>
    (["open", "read"] as const).flatMap(at => ["ENOENT", "ESRCH", "EACCES", "EIO"].map(code => ({ file, at, code }))));
  it.each(fileFaults)("classifies owned $file $at $code without attributing the vanished/unreadable member", async fault => {
    fixture.missingStatCode = "";
    fixture.fault = { ...fault, pid: 1, phase: "member" };
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    const churn = fault.code === "ENOENT" || fault.code === "ESRCH";
    expect(sample).toMatchObject({ incomplete: !churn, processChurn: churn });
    expect(sample.members.map(m => m.pid)).toEqual([2]);
    expect(sample.members[0].rssBytes).toBe(123 * 1024);
    expect(fixture.active).toBe(0);
    expect(fixture.peak).toBeLessThanOrEqual(8);
  });

  it.each([false, true])("classifies a verified same-generation zombie as churn (missing RSS: %s)", async missingRss => {
    fixture.missingStatCode = ""; fixture.zombiePid = 1;
    if (missingRss) fixture.missingRssPid = 1;
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    expect(sample).toMatchObject({ incomplete: false, processChurn: true });
    expect(sample.members.map(m => m.pid)).toEqual([2]);
    expect(fixture.active).toBe(0);
  });

  it.each((["reusedPid", "wrongPid", "wrongGroupPid", "malformedPid"] as const).flatMap(field =>
    [false, true].map(zombie => ({ field, zombie }))))("rejects $field with zombie=$zombie, including missing RSS on zombies", async ({ field, zombie }) => {
    fixture.missingStatCode = ""; fixture[field] = 1;
    if (zombie) { fixture.zombiePid = 1; fixture.missingRssPid = 1; }
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    expect(sample).toMatchObject({ incomplete: true, processChurn: false });
    expect(sample.members.map(m => m.pid)).toEqual([2]);
    expect(fixture.active).toBe(0);
  });

  it.each([
    ...fileFaults.filter(fault => fault.code === "ENOENT" || fault.code === "ESRCH").map(fault => ({ name: `${fault.file}/${fault.at}/${fault.code}`, fault, zombie: false, missingRss: false, pid: 122 })),
    { name: "zombie with RSS", fault: null, zombie: true, missingRss: false, pid: 122 },
    { name: "zombie without RSS", fault: null, zombie: true, missingRss: true, pid: 122 },
    { name: "leader disappearance", fault: { file: "stat", at: "read", code: "ENOENT" } as const, zombie: false, missingRss: false, pid: 121 },
    { name: "leader zombie without RSS", fault: null, zombie: true, missingRss: true, pid: 121 },
  ])("retains observer comparisons through owned $name with a surviving anchor", async mode => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    fixture.spawned = true; fixture.missingStatCode = "";
    const state = emptyRunResources("pending"), first = deferred(), second = deferred();
    let updates = 0, alive = true;
    const observer = observeRunResources(state, 121, () => alive, () => {
      if (++updates === 1) first.resolve(); else second.resolve();
    }, { sampler: new LinuxProcessResourceSampler() });
    try {
      await first.promise;
      if (mode.fault) fixture.fault = { ...mode.fault, pid: mode.pid, phase: "member" };
      if (mode.zombie) fixture.zombiePid = mode.pid;
      if (mode.missingRss) fixture.missingRssPid = mode.pid;
      if (mode.pid === 121) alive = false;
      now.mockReturnValue(1000); fixture.hostTicks = 110; fixture.processTicks = 20;
      await vi.advanceTimersByTimeAsync(1000); await second.promise;
      observer.stop();
      expect(state).toMatchObject({ status: "partial", sampleCount: 2, cpuIntervalCount: 1, partialSampleCount: 1, missingSampleCount: 0 });
      expect(state.reasons).toEqual(expect.arrayContaining(["membership_changed", "process_churn"]));
      expect(state.reasons).not.toContain("incomplete_scan");
      const left = { telemetry: { resources: state } } as TestRunSummary;
      const right = { telemetry: { resources: { ...state, peakSampledRssBytes: state.peakSampledRssBytes! + 100, peakSampledCpuPercent: state.peakSampledCpuPercent! + 10 } } } as TestRunSummary;
      expect(compareResources(left, right, true)).toMatchObject({ rss: { delta: 100 }, cpu: { delta: 10 } });
      expect(fixture.scans).toBe(2);
      expect(fixture.active).toBe(0);
      expect(fixture.peak).toBeLessThanOrEqual(8);
    } finally { observer.stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disappeared", "zombie"])("does not accept an unobserved survivor when the leader %s before its first sample", async mode => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture.spawned = true; fixture.missingStatCode = "";
    if (mode === "zombie") { fixture.zombiePid = 121; fixture.missingRssPid = 121; }
    else fixture.fault = { pid: 121, file: "status", phase: "member", at: "read", code: "ESRCH" };
    const state = emptyRunResources("pending"), updated = deferred();
    const sampler = new LinuxProcessResourceSampler(), sample = vi.spyOn(sampler, "snapshot");
    const observer = observeRunResources(state, 121, () => true, updated.resolve, { sampler });
    try {
      await updated.promise;
      fixture.fault = null; fixture.zombiePid = 0; fixture.missingRssPid = 0;
      await vi.advanceTimersByTimeAsync(5000);
      expect(state).toMatchObject({ status: "unavailable", sampleCount: 0, missingSampleCount: 1, reasons: ["identity_lost"] });
      expect(sample).toHaveBeenCalledTimes(1);
      expect(fixture.active).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { observer.stop(); }
  });

  it("coalesces different groups and bounds all descriptors across simultaneous consumers", async () => {
    const sampler = new LinuxProcessResourceSampler();
    const samples = await Promise.all([sampler.snapshot(42), sampler.snapshot(99), sampler.sample(42)]);
    expect(fixture.scans).toBe(1);
    expect(samples[0]).toMatchObject({ members: expect.any(Array), incomplete: false, processChurn: true });
    expect(fixture.peak).toBeLessThanOrEqual(8);
    expect(fixture.active).toBe(0);
    expect(fixture.buffers.size).toBe(8);
    await sampler.sample(42);
    expect(fixture.scans).toBe(1);
  });

  it.each(["reused_pid", "missing_rss"])("does not attribute %s as an observed zero or a member", async mode => {
    fixture.missingStatCode = "";
    if (mode === "reused_pid") fixture.reusedPid = 1; else fixture.missingRssPid = 1;
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    expect(sample).toMatchObject({ incomplete: true, processChurn: false });
    expect(sample.members.map(m => m.pid)).toEqual([2]);
    expect(sample.members[0].rssBytes).toBe(123 * 1024);
    expect(fixture.active).toBe(0);
  });

  it.each((["open", "read"] as const).flatMap(at => ["ENOENT", "ESRCH", "EACCES", "EIO"].map(code => ({ at, code }))))(
    "classifies global stat $at $code without confusing disappearance with integrity", async ({ at, code }) => {
    fixture.missingStatCode = "";
    fixture.fault = { pid: 3, file: "stat", phase: "enumeration", at, code };
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    const churn = code === "ENOENT" || code === "ESRCH";
    expect(sample).toMatchObject({ incomplete: !churn, processChurn: churn });
    expect(sample.members).toHaveLength(2);
    expect(fixture.active).toBe(0);
  });

  it("keeps malformed global records as integrity failures", async () => {
    fixture.missingStatCode = ""; fixture.malformedEnumerationPid = 3;
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    expect(sample).toMatchObject({ incomplete: true, processChurn: false });
    expect(sample.members).toHaveLength(2);
    expect(fixture.active).toBe(0);
  });

  it.each([ ["stat", 8191], ["stat", 8192], ["status", 8191], ["status", 8192] ] as const)(
    "includes a %s record of %i bytes in the complete group total", async (name, size) => {
      fixture.recordPath = `/proc/1/${name}`; fixture.recordSize = size;
      const result = await new LinuxProcessResourceSampler().sample(42);
      expect(result).toMatchObject({ processCount: 2, rssBytes: 246 * 1024, processCpuTicks: 30 });
      expect(fixture.active).toBe(0);
      expect(fixture.buffers.size).toBe(8);
      expect([...fixture.buffers].every(buffer => buffer.length === 8192)).toBe(true);
    },
  );

  it.each(["stat", "status"])("rejects an oversized %s instead of publishing a smaller group", async name => {
    fixture.recordPath = `/proc/1/${name}`; fixture.recordSize = 8193;
    await expect(new LinuxProcessResourceSampler().sample(42)).rejects.toThrow("exceeds the read limit");
    expect(fixture.active).toBe(0);
    expect(fixture.reads).toBe(name === "stat" ? 120 : 121);
  });

});
