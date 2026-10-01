#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { cpus, loadavg, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { controllerRequestEndpoints } from "./controller-access.mjs";
import { assess, limits, summarize } from "./resource-metrics.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const cli = join(root, "dist/cli/index.js");
const options = { runs: 3, warmup: 15, seconds: 30, cycles: 30, report: "resource-benchmark-report.json", negative: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--negative-control") options.negative = true;
  else if (arg === "--report") options.report = process.argv[++i];
  else if (["--runs", "--warmup", "--seconds", "--cycles"].includes(arg)) options[arg.slice(2)] = Number(process.argv[++i]);
  else throw new Error(`Unknown argument: ${arg}`);
}
for (const [name, min, max] of [["runs", 1, 5], ["warmup", 1, 120], ["seconds", 2, 300], ["cycles", 1, 60]]) {
  if (!Number.isInteger(options[name]) || options[name] < min || options[name] > max) throw new Error(`Invalid ${name}.`);
}
if (!options.report || process.platform !== "linux") throw new Error("A report path and Linux /proc ownership verification are required.");
const canonical = options.warmup >= 15 && options.seconds >= 30 && options.cycles >= 30 && options.runs >= 3 && !options.negative;
const command = (file, args, cwd = root) => exec(file, args, { cwd, timeout: 60_000, maxBuffer: 1_000_000 });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const report = { schemaVersion: 1, kind: options.negative ? "negative-control" : "measurement", canonical,
  options, limits, node: process.version, platform: `${process.platform}-${process.arch}`, kernel: release(),
  cpuModel: cpus()[0]?.model, cpuCount: cpus().length, runs: [], cleanup: "not-run", passed: false };
const startedAt = Date.now();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; });
function check(condition, message) { if (!condition) throw new Error(message); }

async function wait(read, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    check(!interrupted, "Benchmark interrupted.");
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

// Linux identity includes start ticks. A recycled PID is never signalled.
async function identity(pid) {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
}

function launch(args) {
  const child = spawn(process.execPath, ["--import", join(root, "scripts/resource-probe.mjs"), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const processState = { child, exit: null, error: null };
  child.on("error", error => { processState.error = error.message; });
  child.on("exit", (code, signal) => { processState.exit = { code, signal }; });
  // Drain output without storing private URLs or allocating an unbounded tail.
  child.stdout.resume(); child.stderr.resume();
  return processState;
}

let sequence = 0;
async function probe(processState, kind = "resource-sample") {
  check(!processState.exit && !processState.error, "Measured process exited unexpectedly.");
  const child = processState.child, id = ++sequence;
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => finish(new Error("Resource probe timed out.")), 3000);
    const listener = message => { if (message?.id === id) finish(null, message); };
    function finish(error, value) { clearTimeout(timer); child.off("message", listener); if (error) reject(error); else accept(value); }
    child.on("message", listener);
    child.send({ id, kind }, error => { if (error) finish(error); });
  });
}

async function sample(processState, name) {
  console.log(`Sampling ${name}: settle ${options.warmup}s, observe ${options.seconds}s`);
  for (let i = 0; i < options.warmup; i++) { check(!interrupted, "Benchmark interrupted."); await delay(1000); }
  const samples = [await probe(processState)];
  for (let i = 0; i < options.seconds; i++) { check(!interrupted, "Benchmark interrupted."); await delay(1000); samples.push(await probe(processState)); }
  const summary = summarize(samples);
  console.log(`${name}: RSS ${summary.medianRssMiB.toFixed(1)} MiB, CPU ${summary.cpuPercent.toFixed(2)}% of one core`);
  return { samples, summary };
}

async function stop(processState) {
  if (!processState) return;
  if (!processState.exit) {
    processState.child.kill("SIGTERM");
    // Cleanup must continue even when the run was interrupted.
    const deadline = Date.now() + 15_000;
    while (!processState.exit && Date.now() < deadline) await delay(100);
    if (!processState.exit) {
      processState.child.kill("SIGKILL");
      const killDeadline = Date.now() + 3000;
      while (!processState.exit && Date.now() < killDeadline) await delay(50);
      throw new Error("Measured process needed emergency termination.");
    }
  }
  check(!processState.error && processState.exit?.code === 0, "Measured process exited uncleanly.");
}

async function run(number) {
  console.log(`Resource run ${number}/${options.runs}`);
  const base = await mkdtemp(join(tmpdir(), "switcher-resource-"));
  const result = { number, loadAverageBefore: loadavg(), phases: {}, checks: [], cleanup: "pending" };
  report.runs.push(result);
  let baseline, controller;
  const owned = new Map();
  const projects = [];
  // Capture descendants after transitions and again before teardown.
  async function capture() {
    if (!controller?.child.pid) return;
    const rows = (await Promise.all((await readdir("/proc")).filter(p => /^\d+$/.test(p)).map(identity))).filter(Boolean);
    const ids = new Set([controller.child.pid]);
    let changed = true;
    while (changed) { changed = false; for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
    for (const row of rows) if (ids.has(row.pid) && row.pid !== controller.child.pid) owned.set(`${row.pid}:${row.start}`, row);
  }
  let failure;
  try {
    const baselinePort = await freePort();
    baseline = launch(["--input-type=module", "-e", `import {createServer} from 'node:http'; const server=createServer((q,r)=>r.end('baseline'));server.listen(${baselinePort},'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`]);
    await probe(baseline);
    result.phases.baseline = await sample(baseline, "baseline");
    await stop(baseline); baseline = null;
    const data = join(base, "data"), state = join(base, "state");
    await mkdir(data, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
    const port = await freePort(), mcpPort = await freePort();
    check(port !== mcpPort, "Fixture port collision.");
    const bootStart = Date.now();
    controller = launch([cli, "start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(port), "--mcp-port", String(mcpPort), "--data-dir", data, "--state-dir", state, "--browse-root", base]);
    const access = await wait(async () => {
      check(!controller.exit && !controller.error, "Controller failed during startup.");
      try { const value = JSON.parse(await readFile(join(state, "service-access.json"), "utf8")); return value.pid === controller.child.pid ? value : null; }
      catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
    }, "private controller access");
    result.startupMs = Date.now() - bootStart;
    const token = new URLSearchParams(new URL(access.accessUrl).hash.slice(1)).get("token");
    const requestEndpoints = controllerRequestEndpoints(access);
    async function request(path, body) {
      const response = await fetch(`${requestEndpoints.local}${path}`, { method: body ? "POST" : "GET", signal: AbortSignal.timeout(60_000),
        headers: { "Content-Type": "application/json", Origin: requestEndpoints.origin, "X-Worktree-Switcher-Token": token }, body: body ? JSON.stringify(body) : undefined });
      check(response.ok, `Controller request failed (${response.status}): ${path}`);
      return response.json();
    }
    await request("/api/dashboard");
    result.phases.empty = await sample(controller, "empty");
    for (let i = 0; i < 3; i++) {
      const main = join(base, `project-${i}`), alternate = join(base, `project-${i}-alternate`);
      await mkdir(main);
      await writeFile(join(main, "package.json"), JSON.stringify({ scripts: { dev: "node server.mjs" } }));
      await writeFile(join(main, "server.mjs"), `import {createServer} from 'node:http';import {once} from 'node:events';const boot=Date.now();createServer(async(q,r)=>{if(q.url==='/burst'){for(let i=0;i<2000;i++){if(!process.stdout.write('resource-benchmark '+String(i).padStart(4,'0')+' '+'.'.repeat(104)+'\\n'))await once(process.stdout,'drain');}}r.setHeader('Content-Type','application/json');r.end(JSON.stringify({pid:process.pid,boot}));}).listen(Number(process.env.PORT),'127.0.0.1');`);
      await command("git", ["init", "-b", "main", main]);
      await command("git", ["add", "."], main);
      await command("git", ["-c", "user.name=Resource Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "resource fixture"], main);
      await command("git", ["worktree", "add", "-b", "alternate", alternate], main);
      const projectPort = await freePort();
      check(![port, mcpPort, ...projects.map(p => p.port)].includes(projectPort), "Fixture port collision.");
      const added = await request("/api/projects", { name: `resource-${i}`, repositoryPath: main, port: projectPort, launchPreset: "node" });
      projects.push({ id: added.project.id, main, alternate, port: projectPort });
    }
    await request("/api/dashboard");
    result.phases.registered = await sample(controller, "registered");
    async function operate(project, operation, worktreePath) {
      await request(`/api/projects/${project.id}/operation`, { operation, worktreePath });
      await capture();
    }
    for (const project of projects) await operate(project, "start", project.main);
    result.phases.running = await sample(controller, "running");
    for (let i = 0; i < options.cycles; i++) {
      check(!interrupted, "Benchmark interrupted.");
      const project = projects[i % 3];
      await operate(project, "switch", Math.floor(i / 3) % 2 ? project.main : project.alternate);
      const burst = await fetch(`http://127.0.0.1:${project.port}/burst`, { signal: AbortSignal.timeout(10_000) });
      check(burst.ok, "Log workload failed."); await burst.json();
    }
    result.workload = { cycles: options.cycles, logLines: options.cycles * 2000, lineBytes: 129, projects: 3, worktreesPerProject: 2 };
    if (options.negative) {
      const response = await probe(controller, "retain-memory");
      result.injectedBytes = response.retainedBytes;
    }
    result.phases.afterCycles = await sample(controller, "afterCycles");
    const dashboard = await request("/api/dashboard");
    result.retained = dashboard.projects.map(p => ({ logs: p.runtime.logs.length, history: p.runtime.resources.history.length }));
    check(result.retained.every(p => p.logs <= 400 && p.history <= 60), "Runtime logs/history exceeded their bounds.");
    result.checks = assess(result.phases);
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    try { await capture(); } catch (error) { cleanupErrors.push(error.message); }
    for (const processState of [controller, baseline]) try { await stop(processState); } catch (error) { cleanupErrors.push(error.message); }
    for (const row of owned.values()) {
      const current = await identity(row.pid);
      if (current?.start === row.start && current.state !== "Z") {
        // Only signal identities observed descending from our controller.
        try { process.kill(row.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") cleanupErrors.push(error.message); }
        cleanupErrors.push("An owned descendant survived controller shutdown.");
      }
    }
    result.cleanup = cleanupErrors.length ? "failed" : "graceful";
    result.trackedProcessCount = owned.size;
    result.loadAverageAfter = loadavg();
    if (cleanupErrors.length) failure = new Error([failure?.message, ...cleanupErrors].filter(Boolean).join(" "));
    await rm(base, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

try {
  await command(process.execPath, [join(root, "scripts/build-fingerprint.mjs"), "--check"]);
  report.sourceCommit = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
  report.workingTreeDirty = Boolean((await command("git", ["status", "--porcelain"])).stdout.trim());
  report.sourceFingerprint = (await readFile(join(root, "dist/build-source.sha256"), "utf8")).trim();
  report.bundleSha256 = await hash(cli);
  report.driverSha256 = await hash(fileURLToPath(import.meta.url));
  report.probeSha256 = await hash(join(root, "scripts/resource-probe.mjs"));
  report.metricsSha256 = await hash(join(root, "scripts/resource-metrics.mjs"));
  for (let i = 1; i <= options.runs; i++) await run(i);
  report.cleanup = "graceful";
  report.passed = report.runs.every(run => run.checks.every(check => check.passed));
} catch (error) {
  report.error = error.message;
  report.cleanup = report.runs.some(run => run.cleanup === "failed") ? "failed" : "incomplete";
} finally {
  report.durationMs = Date.now() - startedAt;
  await writeFile(resolve(options.report), JSON.stringify(report, null, 2) + "\n");
  console.log(`Resource report: ${report.passed ? "PASS" : "FAIL"}; cleanup=${report.cleanup}; ${options.report}`);
  if (!report.passed) process.exitCode = 1;
}
