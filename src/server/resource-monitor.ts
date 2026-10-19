import { open, readFile, readdir } from "node:fs/promises";
import { cpus } from "node:os";

export interface RawResourceSample {
  rssBytes: number;
  processCount: number;
  processCpuTicks: number;
  hostCpuTicks: number;
  cpuCount: number;
}

export interface ProcessResourceSampler {
  readonly supported: boolean;
  sample(processGroupId: number): Promise<RawResourceSample>;
}

export interface ProcessStat {
  pid: number;
  startTicks: number;
  state: string;
  processGroupId: number;
  cpuTicks: number;
}

export function parseProcessStat(value: string): ProcessStat | null {
  const commandEnd = value.lastIndexOf(")");
  if (commandEnd < 0) return null;
  const fields = value.slice(commandEnd + 1).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  if (![processGroupId, userTicks, systemTicks].every(Number.isFinite)) return null;
  const pid = Number(value.slice(0, value.indexOf(" ")));
  const startTicks = Number(fields[19]);
  if (![pid, startTicks].every(Number.isSafeInteger)) return null;
  return { pid, startTicks, state: fields[0], processGroupId, cpuTicks: userTicks + systemTicks };
}

function parseRssBytes(status: string): number | null {
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}

function parseHostCpuTicks(stat: string): number {
  const line = stat.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) throw new Error("Host CPU counters are unavailable.");
  return line.trim().split(/\s+/).slice(1, 9).reduce((total, value) => total + Number(value), 0);
}

class ProcessRecordTooLargeError extends Error {}

// Per-process stat/status records are small. Reject unexpectedly large records
// rather than allocating readFile's buffers for size-zero procfs files.
async function readProcessFile(path: string, buffer: Buffer): Promise<string> {
  const file = await open(path, "r");
  try {
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) return buffer.toString("utf8", 0, size);
      size += bytesRead;
    }
    // Probe EOF using the same buffer; a full 8 KiB record is valid.
    const { bytesRead } = await file.read(buffer, 0, 1, null);
    if (bytesRead === 0) return buffer.toString("utf8", 0, size);
    throw new ProcessRecordTooLargeError("Process resource record exceeds the read limit.");
  } finally {
    await file.close();
  }
}

export interface ProcessGroupSnapshot {
  members: Array<ProcessStat & { rssBytes: number }>;
  hostCpuTicks: number;
  cpuCount: number;
  observedAtMs: number;
  incomplete: boolean;
  /** A process vanished during global stat enumeration; membership is unknown. */
  processChurn?: boolean;
}
export interface OwnedResourceIdentity {
  pid: number;
  startTicks: number;
  /** Collector-local freshness boundary, not persisted process identity. */
  minimumScanGeneration?: number;
}
export interface OwnedResourceSampler {
  readonly supported: boolean;
  capture(pid: number): Promise<OwnedResourceIdentity>;
  snapshot(processGroupId: number, minimumScanGeneration?: number): Promise<ProcessGroupSnapshot>;
}

/** Shared by runtime and finite jobs. One cached/single-flight enumeration, eight
 * file readers globally, bounded records and no timers when there are no callers.
 * The cache contains stat identities/counters only; RSS is read for requested groups.
 */
export class LinuxProcessResourceSampler implements ProcessResourceSampler, OwnedResourceSampler {
  readonly supported = process.platform === "linux";
  private scan: Promise<{ records: ProcessStat[]; hostCpuTicks: number; cpuCount: number; observedAtMs: number; incomplete: boolean; processChurn: boolean }> | null = null;
  private scanAt = -Infinity;
  private scanGeneration = 0;
  private cachedGeneration = 0;
  private readonly buffers: Buffer[] = Array.from({ length: 8 }, () => Buffer.allocUnsafe(8192));
  private readonly waiters: Array<(buffer: Buffer) => void> = [];

  private async read<T>(operation: (buffer: Buffer) => Promise<T>): Promise<T> {
    const buffer = this.buffers.pop() ?? await new Promise<Buffer>((resolve, reject) => {
      if (this.waiters.length >= 256) { reject(new Error("Resource read queue is full.")); return; }
      this.waiters.push(resolve);
    });
    try { return await operation(buffer); }
    finally {
      const waiter = this.waiters.shift();
      if (waiter) waiter(buffer); else this.buffers.push(buffer);
    }
  }

  async capture(pid: number): Promise<OwnedResourceIdentity> {
    const stat = await this.read(async buffer => parseProcessStat(await readProcessFile(`/proc/${pid}/stat`, buffer)));
    if (!stat || stat.pid !== pid || stat.processGroupId !== pid || stat.state === "Z") throw new Error("Spawned group identity unavailable.");
    // Even a pending enumeration can have listed /proc before this spawn.
    // Require a scan STARTED after capture, independent of completion time.
    return { pid, startTicks: stat.startTicks, minimumScanGeneration: this.scanGeneration + 1 };
  }

  private async enumeration(minimumScanGeneration: number) {
    // Drain an older flight before starting its replacement. Concurrent captures
    // share that replacement; each caller waits at most one stale flight and
    // never loops/rescans in response to ongoing process churn.
    if (this.scan && this.scanGeneration < minimumScanGeneration) await this.scan;
    const now = performance.now();
    if (this.scan) return this.scan;
    // Retain a successful snapshot for a short coalescing window, including
    // consumers whose timers did not fire in the same event-loop turn.
    if (this.cached && this.cachedGeneration >= minimumScanGeneration && now - this.scanAt < 250) return this.cached;
    const generation = ++this.scanGeneration;
    this.scan = this.enumerate().then(value => {
      this.cached = value; this.cachedGeneration = generation; this.scanAt = performance.now(); return value;
    }).finally(() => { this.scan = null; });
    return this.scan;
  }
  private cached: Awaited<ReturnType<LinuxProcessResourceSampler["enumerate"]>> | null = null;

  private async enumerate() {
    if (!this.supported) throw new Error("Process resource monitoring is unsupported.");
    const [entries, hostStat] = await Promise.all([readdir("/proc", { withFileTypes: true }), readFile("/proc/stat", "utf8")]);
    const ids = entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(entry => entry.name);
    if (ids.length > 32768) throw new Error("Process enumeration exceeds the read limit.");
    const records: ProcessStat[] = [];
    let next = 0, incomplete = false, processChurn = false;
    let recordError: ProcessRecordTooLargeError | undefined;
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          const stat = await this.read(async buffer => parseProcessStat(await readProcessFile(`/proc/${id}/stat`, buffer)));
          if (stat) records.push(stat); else incomplete = true;
        } catch (error) {
          // ENOENT is expected global churn, with unknown membership. Other
          // errors leave integrity uncertain and must not qualify comparisons.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") processChurn = true;
          else incomplete = true;
          if (error instanceof ProcessRecordTooLargeError) recordError ??= error;
        }
      }
    }));
    if (recordError) throw recordError;
    const hostCpuTicks = parseHostCpuTicks(hostStat);
    if (!Number.isFinite(hostCpuTicks)) throw new Error("Host CPU counters unavailable.");
    return { records, hostCpuTicks, cpuCount: Math.max(1, cpus().length), observedAtMs: performance.now(), incomplete, processChurn };
  }

  async snapshot(processGroupId: number, minimumScanGeneration = 0): Promise<ProcessGroupSnapshot> {
    const scan = await this.enumeration(minimumScanGeneration);
    const candidates = scan.records.filter(stat => stat.processGroupId === processGroupId && stat.state !== "Z");
    if (candidates.length > 4096) throw new Error("Process group exceeds the read limit.");
    const members: ProcessGroupSnapshot["members"] = [];
    let next = 0, incomplete = scan.incomplete;
    let recordError: ProcessRecordTooLargeError | undefined;
    await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (next < candidates.length) {
        const before = candidates[next++];
        try {
          await this.read(async buffer => {
            const rssBytes = parseRssBytes(await readProcessFile(`/proc/${before.pid}/status`, buffer));
            const after = parseProcessStat(await readProcessFile(`/proc/${before.pid}/stat`, buffer));
            if (rssBytes === null || !after || after.pid !== before.pid || after.startTicks !== before.startTicks
              || after.processGroupId !== processGroupId || after.state === "Z") { incomplete = true; return; }
            // CPU counters use the common enumeration endpoint; RSS was read later.
            members.push({ ...before, rssBytes });
          });
        } catch (error) {
          incomplete = true;
          if (error instanceof ProcessRecordTooLargeError) recordError ??= error;
        }
      }
    }));
    if (recordError) throw recordError;
    return { members, hostCpuTicks: scan.hostCpuTicks, cpuCount: scan.cpuCount, observedAtMs: scan.observedAtMs, incomplete, processChurn: scan.processChurn };
  }

  private readonly runtimeSamples = new Map<number, Promise<RawResourceSample>>();
  sample(processGroupId: number): Promise<RawResourceSample> {
    const existing = this.runtimeSamples.get(processGroupId);
    if (existing) return existing;
    const pending = this.sampleRuntime(processGroupId).finally(() => this.runtimeSamples.delete(processGroupId));
    this.runtimeSamples.set(processGroupId, pending);
    return pending;
  }

  private async sampleRuntime(processGroupId: number): Promise<RawResourceSample> {
    const sample = await this.snapshot(processGroupId);
    if (!sample.members.length) throw new Error("The managed process group is no longer available.");
    return { rssBytes: sample.members.reduce((sum, member) => sum + member.rssBytes, 0),
      processCount: sample.members.length, processCpuTicks: sample.members.reduce((sum, member) => sum + member.cpuTicks, 0),
      hostCpuTicks: sample.hostCpuTicks, cpuCount: sample.cpuCount };
  }
}

// One collector for all production consumers; tests may inject isolated samplers.
const sharedSampler = new LinuxProcessResourceSampler();
export function defaultProcessResourceSampler(): LinuxProcessResourceSampler { return sharedSampler; }
