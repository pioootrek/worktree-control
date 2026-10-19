/** Bounded sampler-only cost probe. No controller, service, ports or supervised repo. */
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { cpus, loadavg, release } from "node:os";
import { fileURLToPath } from "node:url";
import { LinuxProcessResourceSampler } from "../src/server/resource-monitor";
import { OwnedProcessGroup } from "../src/server/owned-process-group";

const intervals = 6, intervalMs = 1000, repeats = 3;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const median = (values: number[]) => { const v = [...values].sort((a, b) => a - b); return (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2; };
const workerMode = process.argv[process.argv.indexOf("--worker") + 1];
async function worker(mode: string) {
  const children: ChildProcess[] = [], sampler = new LinuxProcessResourceSampler();
  try {
    for (let i = 0; i < 3; i++) {
      const child = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
      children.push(child);
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    }
    await sleep(300);
    const pids = children.map(child => child.pid!);
    const identities = [];
    for (const pid of pids) identities.push(await sampler.capture(pid));
    const hostProcessCount = readdirSync("/proc").filter(name => /^\d+$/.test(name)).length;
    const cpu = process.cpuUsage(), start = performance.now(), samples = [], scanMs = [];
    for (let i = 0; i <= intervals; i++) {
      if (i) await sleep(intervalMs);
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
    // Only freshly spawned detached groups are owned. Cleanup failure fails the probe.
    for (const child of children) await new OwnedProcessGroup(child).stop();
  }
}
if (process.argv.includes("--worker")) {
  console.log(JSON.stringify(await worker(workerMode)));
} else {
  const start = new Date().toISOString(), observations = [], initialLoad = loadavg();
  for (let run = 0; run < repeats; run++) {
    const result: Record<string, Awaited<ReturnType<typeof worker>>> = {};
    for (const mode of ["baseline", "one_group", "three_groups"]) {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--worker", mode], { stdio: ["ignore", "pipe", "inherit"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", chunk => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error(`Cost worker failed: ${code}`))); });
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
