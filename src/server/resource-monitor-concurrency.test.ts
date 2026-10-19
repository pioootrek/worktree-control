import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ active: 0, peak: 0, reads: 0, scans: 0, buffers: new Set<Buffer>(), recordPath: "", recordSize: 0, reusedPid: 0, missingRssPid: 0, statReads: new Map<number, number>() }));
vi.mock("node:fs/promises", () => ({
  readdir: async () => { fixture.scans++; return Array.from({ length: 120 }, (_, index) => ({ name: String(index + 1), isDirectory: () => true })); },
  readFile: async (path: string) => {
    if (path !== "/proc/stat") throw new Error("Unbounded process read");
    return "cpu 1 2 3 4\n";
  },
  open: async (path: string) => {
    const pid = Number(path.split("/")[2]);
    if (path.endsWith("/stat")) { fixture.reads++; fixture.statReads.set(pid, (fixture.statReads.get(pid) ?? 0) + 1); }
    if (pid === 3) throw Object.assign(new Error("process exited"), { code: "ENOENT" });
    const fields = Array<string>(20).fill("0");
    fields[0] = "S"; fields[2] = pid <= 2 ? "42" : "99";
    fields[11] = "10"; fields[12] = "5"; fields[19] = pid === fixture.reusedPid && (fixture.statReads.get(pid) ?? 0) > 1 ? "999" : "100";
    const value = path.endsWith("/status") ? pid === fixture.missingRssPid ? "Name: missing\n" : "VmRSS: 123 kB\n" : `${pid} (fixture worker) ${fields.join(" ")}`;
    const contents = Buffer.from(path === fixture.recordPath ? value.padEnd(fixture.recordSize, " ") : value);
    let position = 0;
    fixture.active++;
    fixture.peak = Math.max(fixture.peak, fixture.active);
    return {
      read: async (buffer: Buffer, offset: number, length: number) => {
        fixture.buffers.add(buffer);
        await new Promise<void>(resolve => setImmediate(resolve));
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

describe.skipIf(process.platform !== "linux")("bounded process inspection", () => {
  beforeEach(() => {
    fixture.active = 0; fixture.peak = 0; fixture.reads = 0; fixture.scans = 0;
    fixture.buffers.clear(); fixture.recordPath = ""; fixture.recordSize = 0; fixture.reusedPid = 0; fixture.missingRssPid = 0; fixture.statReads.clear();
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

  it("coalesces different groups and bounds all descriptors across simultaneous consumers", async () => {
    const sampler = new LinuxProcessResourceSampler();
    const samples = await Promise.all([sampler.snapshot(42), sampler.snapshot(99), sampler.sample(42)]);
    expect(fixture.scans).toBe(1);
    expect(samples[0]).toMatchObject({ members: expect.any(Array), incomplete: true });
    expect(fixture.peak).toBeLessThanOrEqual(8);
    expect(fixture.active).toBe(0);
    expect(fixture.buffers.size).toBe(8);
    await sampler.sample(42);
    expect(fixture.scans).toBe(1);
  });

  it.each(["reused_pid", "missing_rss"])("does not attribute %s as an observed zero or a member", async mode => {
    if (mode === "reused_pid") fixture.reusedPid = 1; else fixture.missingRssPid = 1;
    const sample = await new LinuxProcessResourceSampler().snapshot(42);
    expect(sample.incomplete).toBe(true);
    expect(sample.members.map(m => m.pid)).toEqual([2]);
    expect(sample.members[0].rssBytes).toBe(123 * 1024);
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
