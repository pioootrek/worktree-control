import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";

import type { Project, RuntimeFailure, RuntimeResourceMetrics, RuntimeSnapshot } from "@/shared/contracts";
import { type LogWriter, nullLogWriter } from "./log-writer";
import { defaultProcessResourceSampler, type ProcessResourceSampler, type RawResourceSample } from "./resource-monitor";
import { inheritedRuntimeEnvironment } from "./runtime-environment";
import { portInUseFailure, processExitFailure, spawnFailure, timeoutFailure } from "./runtime-failure";

import { OwnedProcessGroup } from "./owned-process-group";

const MAX_LOG_LINES = 400;
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_MAX_HISTORY_POINTS = 60;

type RuntimeEntry = RuntimeSnapshot & {
  child: ChildProcess | null;
  group: OwnedProcessGroup | null;
  cleanup: Promise<void> | null;
  projectId: string;
  resourceTimer: NodeJS.Timeout | null;
  previousResourceSample: RawResourceSample | null;
};

export type RuntimeStatusSummary = Pick<RuntimeSnapshot, "phase" | "worktreePath" | "startedAt"> & {
  failureCode: string | null;
  /** True while the manager still owns a process group or is confirming its cleanup. */
  ownsProcess: boolean;
};

export interface ProcessManagerOptions {
  resourceSampler?: ProcessResourceSampler;
  resourceSampleIntervalMs?: number;
  maxResourceHistoryPoints?: number;
  memoryWarningThresholdBytes?: number | null;
}

function emptyResources(status: RuntimeResourceMetrics["status"] = "idle", warningThresholdBytes: number | null = null): RuntimeResourceMetrics {
  return {
    status,
    currentRssBytes: null,
    peakRssBytes: null,
    cpuPercent: null,
    processCount: null,
    sampledAt: null,
    sampleAgeSeconds: null,
    warningThresholdBytes,
    history: [],
  };
}

function emptyRuntime(projectId = "unknown"): RuntimeEntry {
  return {
    projectId,
    phase: "stopped",
    pid: null,
    worktreePath: null,
    startedAt: null,
    error: null,
    failure: null,
    logs: [],
    resources: emptyResources(),
    child: null,
    group: null,
    cleanup: null,
    resourceTimer: null,
    previousResourceSample: null,
  };
}

function localAddresses(): string[] {
  const addresses = new Set(["127.0.0.1", "::1"]);
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) addresses.add(address.address);
  }
  return [...addresses];
}

async function isAddressOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(250);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  const results = await Promise.all(localAddresses().map((host) => isAddressOpen(host, port)));
  return results.some(Boolean);
}

export class ProcessManager {
  private closing = false;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly onChange: (projectId: string) => void;
  private readonly logs: LogWriter;
  private readonly resourceSampler: ProcessResourceSampler;
  private readonly resourceSampleIntervalMs: number;
  private readonly maxResourceHistoryPoints: number;
  private readonly memoryWarningThresholdBytes: number | null;

  constructor(onChange: (projectId: string) => void = () => undefined, logs: LogWriter = nullLogWriter, options: ProcessManagerOptions = {}) {
    this.onChange = onChange;
    this.logs = logs;
    this.resourceSampler = options.resourceSampler ?? defaultProcessResourceSampler();
    this.resourceSampleIntervalMs = options.resourceSampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.maxResourceHistoryPoints = options.maxResourceHistoryPoints ?? DEFAULT_MAX_HISTORY_POINTS;
    this.memoryWarningThresholdBytes = options.memoryWarningThresholdBytes ?? null;
  }

  snapshot(projectId: string): RuntimeSnapshot {
    const runtime = this.runtimes.get(projectId) ?? emptyRuntime();
    return {
      phase: runtime.phase,
      pid: runtime.pid,
      worktreePath: runtime.worktreePath,
      startedAt: runtime.startedAt,
      error: runtime.error,
      failure: runtime.failure,
      logs: [...runtime.logs],
      resources: {
        ...runtime.resources,
        sampleAgeSeconds: runtime.resources.sampledAt
          ? Math.max(0, Math.round((Date.now() - new Date(runtime.resources.sampledAt).getTime()) / 1_000))
          : null,
        history: [...runtime.resources.history],
      },
    };
  }

  statusSummary(projectId: string): RuntimeStatusSummary {
    const runtime = this.runtimes.get(projectId) ?? emptyRuntime();
    return {
      phase: runtime.phase,
      worktreePath: runtime.worktreePath,
      startedAt: runtime.startedAt,
      failureCode: runtime.failure?.code ?? (runtime.error ? "runtime_error" : null),
      ownsProcess: Boolean(runtime.group || runtime.cleanup),
    };
  }

  logTail(projectId: string, limit: number): { lines: string[]; retainedLines: number; truncated: boolean } {
    const logs = this.runtimes.get(projectId)?.logs ?? [];
    const bounded = Math.max(1, Math.min(100, limit));
    return { lines: logs.slice(-bounded), retainedLines: logs.length, truncated: logs.length > bounded };
  }

  async start(project: Project, worktreePath: string, beforeSpawn?: () => void): Promise<void> {
    this.assertStartAdmission();
    const current = this.runtimes.get(project.id) ?? emptyRuntime(project.id);
    if (current.group || current.cleanup) throw new Error("Serwer projektu już działa.");
    if (await isPortOpen(project.port)) {
      const runtime = { ...emptyRuntime(project.id), worktreePath, startedAt: new Date().toISOString() };
      this.runtimes.set(project.id, runtime);
      const failure = portInUseFailure(project);
      this.markFailed(runtime, failure);
      throw new Error(failure.message);
    }
    this.assertStartAdmission();
    beforeSpawn?.();
    this.assertStartAdmission();

    const runtime: RuntimeEntry = {
      ...emptyRuntime(project.id),
      phase: "starting",
      worktreePath,
      startedAt: new Date().toISOString(),
    };
    this.runtimes.set(project.id, runtime);
    this.append(runtime, `$ ${project.executable} ${project.args.join(" ")}`);

    const child = spawn(project.executable, project.args, {
      cwd: worktreePath,
      env: {
        ...inheritedRuntimeEnvironment(),
        ...project.environment,
        PORT: String(project.port),
        NODE_ENV: "development",
      },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtime.child = child;
    runtime.group = new OwnedProcessGroup(child);
    runtime.pid = child.pid ?? null;
    runtime.resources = emptyResources(this.resourceSampler.supported ? "unavailable" : "unsupported", this.memoryWarningThresholdBytes);
    if (runtime.pid) this.startResourceMonitoring(runtime);
    child.stdout?.on("data", (chunk: Buffer) => this.appendChunk(runtime, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendChunk(runtime, chunk));
    child.once("error", (error) => {
      if (!child.pid) {
        runtime.group = null;
        runtime.child = null;
        runtime.pid = null;
        this.markFailed(runtime, spawnFailure(project, error));
      }
    });
    child.once("exit", (code, signal) => {
      runtime.child = null;
      if (runtime.cleanup || !runtime.group) return;
      const failure = processExitFailure(project, runtime.logs, code, signal);
      void this.cleanupRuntime(runtime).then(() => this.markFailed(runtime, failure), () => undefined);
    });
    this.onChange(project.id);

    const deadline = Date.now() + project.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.closing || !runtime.child || runtime.phase !== "starting") {
        if (this.closing) await this.cleanupRuntime(runtime);
        if (runtime.cleanup) await runtime.cleanup;
        throw new Error(runtime.error ?? "Proces zakończył się podczas startu.");
      }
      if (await this.isHealthy(project) && !this.closing && runtime.child && runtime.phase === "starting") {
        runtime.phase = "running";
        runtime.error = null;
        runtime.failure = null;
        this.onChange(project.id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.stop(project.id);
    this.markFailed(runtime, timeoutFailure(project));
    throw new Error(runtime.error!);
  }

  async stop(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId);
    if (!runtime) return;
    await this.cleanupRuntime(runtime);
  }

  private cleanupRuntime(runtime: RuntimeEntry): Promise<void> {
    if (runtime.cleanup) return runtime.cleanup;
    runtime.phase = "stopping";
    this.onChange(runtime.projectId);
    runtime.cleanup = (async () => {
      try {
        await runtime.group?.stop();
        runtime.group = null;
        runtime.child = null;
        runtime.pid = null;
        runtime.phase = "stopped";
        runtime.error = null;
        runtime.failure = null;
        this.stopResourceMonitoring(runtime);
        this.append(runtime, "process_stopped_by=worktree-switcher");
      } catch (error) {
        // Keep the group and PID, so capacity stays occupied and stop can be retried.
        this.markFailed(runtime, {
          code: "process_exit",
          title: "Nie udało się zatrzymać grupy procesów",
          message: error instanceof Error ? error.message : String(error),
          technicalDetails: `process_group=${runtime.pid} cleanup=unconfirmed`,
          suggestion: "Ponów zatrzymanie i sprawdź logi kontrolera.",
        });
        throw error;
      } finally {
        runtime.cleanup = null;
        this.onChange(runtime.projectId);
      }
    })();
    return runtime.cleanup;
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.runtimes.keys()].map((id) => this.stop(id)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Nie zakończono wszystkich serwerów.");
  }

  /** Closing is permanent for this controller; queued or preflight starts cannot spawn. */
  closeAdmission(): void { this.closing = true; }

  private assertStartAdmission(): void {
    if (this.closing) throw new Error("Kontroler jest zamykany i nie przyjmuje nowych operacji.");
  }

  private async isHealthy(project: Project): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${project.port}${project.healthcheckPath}`, {
        signal: AbortSignal.timeout(800),
      });
      return response.status < 500;
    } catch {
      // A dev server may intentionally expose HTTPS or bind only to a LAN address.
      // An owned child that has opened the configured TCP port is ready enough for switching.
      return isPortOpen(project.port);
    }
  }

  private appendChunk(runtime: RuntimeEntry, chunk: Buffer): void {
    for (const line of chunk.toString("utf8").split(/\r?\n/).filter(Boolean)) this.append(runtime, line);
  }

  private startResourceMonitoring(runtime: RuntimeEntry): void {
    if (!runtime.pid || runtime.resourceTimer) return;
    void this.sampleResources(runtime, runtime.pid);
    runtime.resourceTimer = setInterval(() => {
      if (runtime.pid) void this.sampleResources(runtime, runtime.pid);
    }, this.resourceSampleIntervalMs);
    runtime.resourceTimer.unref();
  }

  private stopResourceMonitoring(runtime: RuntimeEntry): void {
    if (runtime.resourceTimer) clearInterval(runtime.resourceTimer);
    runtime.resourceTimer = null;
    runtime.previousResourceSample = null;
    if (runtime.resources.status === "available" || runtime.resources.status === "unavailable") {
      runtime.resources = {
        ...runtime.resources,
        status: "stale",
        currentRssBytes: null,
        cpuPercent: null,
        processCount: null,
      };
    }
  }

  private async sampleResources(runtime: RuntimeEntry, processGroupId: number): Promise<void> {
    try {
      const sample = await this.resourceSampler.sample(processGroupId);
      if (runtime.pid !== processGroupId || !runtime.child) return;
      const sampledAt = new Date().toISOString();
      const previous = runtime.previousResourceSample;
      const processDelta = previous ? sample.processCpuTicks - previous.processCpuTicks : 0;
      const hostDelta = previous ? sample.hostCpuTicks - previous.hostCpuTicks : 0;
      const cpuPercent = previous && processDelta >= 0 && hostDelta > 0
        ? Math.round((processDelta / hostDelta) * sample.cpuCount * 10_000) / 100
        : null;
      const history = [...runtime.resources.history, { sampledAt, rssBytes: sample.rssBytes }]
        .slice(-this.maxResourceHistoryPoints);
      runtime.resources = {
        status: "available",
        currentRssBytes: sample.rssBytes,
        peakRssBytes: Math.max(runtime.resources.peakRssBytes ?? 0, sample.rssBytes),
        cpuPercent,
        processCount: sample.processCount,
        sampledAt,
        sampleAgeSeconds: 0,
        warningThresholdBytes: this.memoryWarningThresholdBytes,
        history,
      };
      runtime.previousResourceSample = sample;
    } catch {
      if (runtime.pid !== processGroupId || !runtime.child) return;
      runtime.resources = {
        ...runtime.resources,
        status: this.resourceSampler.supported ? "unavailable" : "unsupported",
        currentRssBytes: null,
        cpuPercent: null,
        processCount: null,
      };
    }
  }

  private append(runtime: RuntimeEntry, line: string): void {
    runtime.logs.push(line.slice(0, 4000));
    this.logs.project(runtime.projectId, line.slice(0, 4000));
    if (runtime.logs.length > MAX_LOG_LINES) runtime.logs.splice(0, runtime.logs.length - MAX_LOG_LINES);
    this.onChange(runtime.projectId);
  }

  private markFailed(runtime: RuntimeEntry, failure: RuntimeFailure): void {
    runtime.phase = "failed";
    runtime.error = failure.message;
    runtime.failure = failure;
    this.append(runtime, `ERROR: ${failure.code} ${failure.technicalDetails}`);
  }
}
