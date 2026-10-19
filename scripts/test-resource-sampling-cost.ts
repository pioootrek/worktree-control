/** Bounded sampler-only cost probe. No controller, service, ports or supervised repo. */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { cpus, loadavg, release } from "node:os";
import { fileURLToPath } from "node:url";
import { LinuxProcessResourceSampler, type OwnedResourceIdentity } from "../src/server/resource-monitor";
import { ProbeGroups, ProbeSignals } from "./resource-sampling-lifecycle";

const intervals = 6, intervalMs = 1000, repeats = 3;
const median = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2; };
const workerMode = process.argv[process.argv.indexOf("--worker") + 1];
const phase = (name: string, pids: number[] = []) => {
  // Diagnostics must never interrupt cleanup if the observing parent died.
  if (process.connected) { try { process.send?.({ phase: name, pids }, () => {}); } catch { /* Closed IPC. */ } }
};
async function worker(mode: string, signals: ProbeSignals) {
  const children: ChildProcess[] = [], groups = new ProbeGroups(), sampler = new LinuxProcessResourceSampler();
  try {
    for (let i = 0; i < 3; i++) {
      signals.check();
      const child = spawn(process.execPath, [fileURLToPath(new URL("./resource-sampling-fixture.mjs", import.meta.url))], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
      groups.add(child); children.push(child);
      child.stdin!.on("error", () => { /* An already-exited fixture is checked by sampling/cleanup. */ });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      phase("spawn", children.map(child => child.pid!));
      signals.check();
    }
    phase("setup", children.map(child => child.pid!));
    await signals.wait(300);
    const pids = children.map(child => child.pid!);
    const identities: OwnedResourceIdentity[] = [];
    for (const pid of pids) { signals.check(); identities.push(await sampler.capture(pid)); }
    signals.check();
    phase("measurement", pids);
    const hostProcessCount = readdirSync("/proc").filter(name => /^\d+$/.test(name)).length;
    const cpu = process.cpuUsage(), start = performance.now(), samples = [], scanMs = [];
    for (let i = 0; i <= intervals; i++) {
      signals.check();
      if (i) await signals.wait(intervalMs);
      if (mode !== "baseline") {
        const scanStart = performance.now();
        const snapshots = await Promise.all(pids.slice(0, mode === "one_group" ? 1 : 3).map((pid, index) => sampler.snapshot(pid, identities[index].minimumScanGeneration)));
        if (snapshots.some(s => s.members.length < 2)) throw Error("Fixture member missing");
        scanMs.push(performance.now() - scanStart);
      }
      samples.push({ elapsedMs: performance.now() - start, rssBytes: process.memoryUsage.rss() });
    }
    const elapsedMs = performance.now() - start, usage = process.cpuUsage(cpu);
    return { mode, hostProcessCount, elapsedMs, cpuMs: (usage.user + usage.system) / 1000, cpuPercentOneCore: (usage.user + usage.system) / (elapsedMs * 10),
      medianRssBytes: median(samples.map(s => s.rssBytes)), peakRssBytes: Math.max(...samples.map(s => s.rssBytes)), samples, scanMs };
  } finally {
    phase("cleanup", children.map(child => child.pid!));
    await groups.stop();
    phase("cleaned", children.map(child => child.pid!));
  }
}
async function main(signals: ProbeSignals) {
  if (process.argv.includes("--worker")) {
    const result = await worker(workerMode, signals);
    signals.check();
    console.log(JSON.stringify(result));
  } else {
    const start = new Date().toISOString(), observations = [], initialLoad = loadavg();
    for (let run = 0; run < repeats; run++) {
      const result: Record<string, Awaited<ReturnType<typeof worker>>> = {};
      for (const mode of ["baseline", "one_group", "three_groups"]) {
        signals.check();
        const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--worker", mode], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
        child.on("message", (message: { phase: string; pids: number[] }) => phase(message.phase, message.pids));
        const chunks: Buffer[] = [];
        child.stdout.on("data", chunk => chunks.push(chunk));
        await new Promise<void>((resolve, reject) => {
          let deadline: NodeJS.Timeout | undefined;
          const interrupt = () => {
            child.kill("SIGTERM");
            deadline ??= setTimeout(() => {
              child.kill("SIGKILL");
              reject(Error("Cost worker interruption cleanup timed out; not confirmed"));
            }, 10_000);
          };
          const finish = (error?: Error) => {
            signals.controller.signal.removeEventListener("abort", interrupt);
            clearTimeout(deadline);
            if (error) reject(error); else resolve();
          };
          child.once("error", finish);
          child.once("close", (code, signal) => finish(code === 0 ? undefined : Error(`Cost worker failed: ${code}/${signal}`)));
          signals.controller.signal.addEventListener("abort", interrupt, { once: true });
          if (signals.controller.signal.aborted) interrupt();
        });
        signals.check();
        result[mode] = JSON.parse(Buffer.concat(chunks).toString());
      }
      observations.push({ run: run + 1, ...result, deltas: Object.fromEntries(["one_group", "three_groups"].map(mode => [mode, {
        cpuPercentOneCore: result[mode].cpuPercentOneCore - result.baseline.cpuPercentOneCore,
        medianRssBytes: result[mode].medianRssBytes - result.baseline.medianRssBytes,
      }])) });
    }
    const report = { version: 1, canonicalReleaseBenchmark: false, source: "sampler_only_separate_fresh_node_workers",
      start, end: new Date().toISOString(), environment: { node: process.version, kernel: release(), logicalCpus: cpus().length, initialLoad, finalLoad: loadavg() },
      parameters: { repeats, intervals, intervalMs, pointsPerArm: intervals + 1, idleFixtureGroupsPerArm: 3, processesPerGroup: 2 },
      observations, cleanup: "confirmed", limitations: "Small idle fixtures; sampler-only cost, no database/controller/UI load, no resource accuracy or release-budget certification." };
    const reportPath = join(mkdtempSync(join(tmpdir(), "wtc-sampling-cost-")), "report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ reportPath, environment: report.environment, cleanup: report.cleanup,
      deltas: observations.map(r => ({ run: r.run, ...r.deltas })) }));
  }
}
const signals = new ProbeSignals();
try { await main(signals); }
catch (error) { console.error(error); process.exitCode = 1; }
finally { signals.dispose(); }
