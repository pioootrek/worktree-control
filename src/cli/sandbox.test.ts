import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAppPaths } from "../server/paths";
import { SqliteStateStore } from "../server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import {
  parseSandboxArgs, prepareSandboxInstallation, runSandbox, runSandboxCommand, SANDBOX_FORMAT, sandboxEnvironment, watchSandboxStop,
  type SandboxDescriptor,
} from "./sandbox";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const pidFiles: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolveExit => child.once("exit", resolveExit));
    }
  }
  // A failed test must not leave a fake controller behind for the next one.
  for (const pid of pidFiles.splice(0).flatMap(fakePids)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * Stands in for `start`: records its pid, publishes the service record after "listening", per FAKE_MODE.
 * It ignores broken output pipes so that a sandbox which dies without cleanup leaves it running.
 */
const FAKE_CONTROLLER = `
import { appendFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const option = name => process.argv[process.argv.indexOf(name) + 1];
const mode = process.env.FAKE_MODE ?? "normal";
if (process.env.FAKE_PID_FILE) appendFileSync(process.env.FAKE_PID_FILE, process.pid + "\\n");
console.log("fake controller", process.argv.slice(2).join(" "));
if (mode === "exit") { console.error("listen EADDRINUSE"); process.exit(3); }
if (mode === "noisy-exit") {
  process.stderr.write("n".repeat(256 * 1024) + "\\nlisten EADDRINUSE\\n", () => process.exit(3));
  await new Promise(() => {});
}
const record = { pid: process.pid, startedAt: new Date().toISOString(), version: "fake", dashboardEndpoint: "http://127.0.0.1:" + option("--port"),
  localDashboardEndpoint: "http://127.0.0.1:" + option("--port"), mcpEndpoint: "http://127.0.0.1:" + option("--mcp-port") + "/mcp",
  accessUrl: "http://127.0.0.1:" + option("--port") + "/", logDirectory: join(option("--state-dir"), "logs"), authenticationMode: "token" };
if (mode === "bad-record") { record.dashboardEndpoint = "not a url"; delete record.localDashboardEndpoint; }
if (mode !== "never-ready") {
  writeFileSync(join(option("--state-dir"), "service-access.json.tmp"), JSON.stringify(record));
  renameSync(join(option("--state-dir"), "service-access.json.tmp"), join(option("--state-dir"), "service-access.json"));
}
if (mode === "ready-then-exit") process.exit(5);
if (mode === "crash-after-ready") setTimeout(() => process.exit(4), 200);
if (mode === "chatty") setInterval(() => console.error("chatty controller"), 20);
if (mode === "flood") {
  // 32 MiB on standard error, honouring the pipe's backpressure like a real controller, then a marker file.
  const chunk = "f".repeat(64 * 1024 - 1) + "\\n";
  let sent = 0;
  const pump = () => {
    while (sent < 512) { sent++; if (!process.stderr.write(chunk)) { process.stderr.once("drain", pump); return; } }
    process.stderr.write("flood done\\n", () => writeFileSync(process.env.FAKE_PID_FILE + ".flooded", "done"));
  };
  pump();
}
process.on("SIGTERM", () => {
  if (mode === "slow-stop") setTimeout(() => process.exit(0), 1500);
  else if (mode === "burst-on-stop") process.stderr.write("BURST-HEAD\\n" + "x".repeat(2 * 1024 * 1024) + "\\nFAKE-STOPPED\\n", () => process.exit(0));
  else process.exit(0);
});
setInterval(() => {}, 1000);
`;

/** Runs the sandbox command the way the CLI does, with the fake controller as its `start`. */
const HARNESS = (sandboxModule: string) => `
import { runSandboxCommand } from ${JSON.stringify(sandboxModule)};
const [script, parent, mode, inject] = process.argv.slice(2);
// Lets a test make standard input fail the way a reset socket does.
if (inject === "stdin-error") process.on("SIGUSR2", () => process.stdin.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
const status = await runSandboxCommand({ projectName: "Harness", permissions: ["knowledge:read"], readyTimeoutMs: 10_000 }, {
  entry: { command: process.execPath, args: [script] }, version: "9.9.9", temporaryDirectory: parent,
  environment: { PATH: process.env.PATH, FAKE_MODE: mode, FAKE_PID_FILE: process.env.FAKE_PID_FILE },
});
process.exit(status);
`;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function fakePids(pidFile: string): number[] {
  try { return readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number); } catch { return []; }
}

/** A fake controller script, an empty parent for sandbox directories and a file collecting controller pids. */
function fixture() {
  const scripts = temporary("worktree-control-sandbox-script-");
  const script = join(scripts, "fake-controller.mjs");
  writeFileSync(script, FAKE_CONTROLLER);
  const pidFile = join(scripts, "pids");
  pidFiles.push(pidFile);
  return { scripts, script, pidFile, parent: temporary("worktree-control-sandbox-parent-") };
}

/** Every controller the sandbox started has exited and its directory is gone. */
function expectNoLeftovers({ parent, pidFile }: { parent: string; pidFile: string }) {
  expect(fakePids(pidFile).length).toBeGreaterThan(0);
  expect(fakePids(pidFile).filter(alive)).toEqual([]);
  expect(readdirSync(parent)).toEqual([]);
}

function sandboxHarness(mode: string, readyTimeoutMs = 10_000) {
  const files = fixture();
  const stop = new AbortController();
  const lines: string[] = [];
  let log = "";
  let resolveDescriptor!: (value: SandboxDescriptor) => void;
  const descriptor = new Promise<SandboxDescriptor>(resolve => { resolveDescriptor = resolve; });
  const run = runSandbox({ projectName: "Unit", permissions: ["knowledge:read", "knowledge:write"], readyTimeoutMs }, {
    entry: { command: process.execPath, args: [files.script] },
    version: "9.9.9",
    temporaryDirectory: files.parent,
    environment: { PATH: process.env.PATH, FAKE_MODE: mode, FAKE_PID_FILE: files.pidFile, WORKTREE_CONTROL_DATA_DIR: "/must/not/leak" },
    write: line => { lines.push(line); resolveDescriptor(JSON.parse(line) as SandboxDescriptor); },
    log: chunk => { log += chunk.toString(); },
    stop: stop.signal,
  });
  return { ...files, run, descriptor, stop, lines, output: () => log };
}

/** A standard error whose reader has stopped reading: writes are held, so any queued output stays in memory. */
function stalledWritable() {
  const held: Array<() => void> = [];
  let reading = false;
  let received = "";
  const stream = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.toString();
      if (reading) callback(); else held.push(callback);
    },
  });
  return { stream, received: () => received, resume: () => { reading = true; for (const callback of held.splice(0)) callback(); } };
}

/** The process streams `runSandboxCommand` is given in tests that do not use a child process. */
function commandIo(stderr: Writable, signals = new EventEmitter()) {
  const stdout = new PassThrough();
  stdout.resume();
  return { stdin: Object.assign(new PassThrough(), { fd: -1 }), stdout, stderr, signals };
}

/** Runs the harness as its own process: real signals, real pipes and the command's own exit. */
function harnessCommand(mode: string, inject?: string) {
  const files = fixture();
  // Plain JavaScript importing the TypeScript module through tsx: an `.mts` entry would make standard
  // error blocking and hide output that the built CLI loses when it exits too early.
  const harness = join(files.scripts, "harness.mjs");
  writeFileSync(harness, HARNESS(pathToFileURL(join(repositoryRoot, "src/cli/sandbox.ts")).href));
  // tsx resolves from the checkout.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", FAKE_PID_FILE: files.pidFile };
  return { ...files, env, args: [process.execPath, "--import", "tsx", harness, files.script, files.parent, mode, ...(inject ? [inject] : [])] };
}

function startHarness(mode: string, inject?: string) {
  const command = harnessCommand(mode, inject);
  const child = spawn(command.args[0]!, command.args.slice(1), { cwd: repositoryRoot, env: command.env, stdio: ["pipe", "pipe", "pipe"] });
  processes.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  // `close` also waits for the last output, unlike `exit`.
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolveExit({ code, signal }));
  });
  const descriptor = async (): Promise<SandboxDescriptor> => {
    for (;;) {
      if (stdout.includes("\n")) return JSON.parse(stdout.slice(0, stdout.indexOf("\n"))) as SandboxDescriptor;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`harness exited before its descriptor:\n${stderr}`);
      await delay(20);
    }
  };
  return { ...command, child, exit, descriptor, stdout: () => stdout, stderr: () => stderr };
}

describe("sandbox options", () => {
  it("defaults to read and write in a project named Sandbox", () => {
    expect(parseSandboxArgs([])).toEqual({ projectName: "Sandbox", permissions: ["knowledge:read", "knowledge:write"], readyTimeoutMs: 30_000 });
    expect(parseSandboxArgs(["--project-name", "E09a", "--permissions", "knowledge:read,knowledge:approve", "--ready-timeout-seconds", "5"]))
      .toEqual({ projectName: "E09a", permissions: ["knowledge:read", "knowledge:approve"], readyTimeoutMs: 5_000 });
  });

  it.each([
    [["--data-dir", "/tmp/x"]], [["--state-dir", "/tmp/x"]], [["--port", "4000"]], [["--project-name"]],
    [["--project-name", "a", "--project-name", "b"]], [["--permissions", "knowledge:admin"]], [["--permissions", "knowledge:read,knowledge:read"]],
    [["--ready-timeout-seconds", "0"]], [["--ready-timeout-seconds", "1.5"]], [["--project-name", "--permissions"]],
  ])("rejects %j", args => {
    expect(() => parseSandboxArgs(args)).toThrow();
  });

  it("removes every product variable from the controller environment", () => {
    expect(sandboxEnvironment({ PATH: "/bin", WORKTREE_CONTROL_TOKEN: "secret", WORKTREE_SWITCHER_DATA_DIR: "/data", WORKTREE_CONTROL_STATE_DIR: "/state", OTHER: undefined }))
      .toEqual({ PATH: "/bin" });
  });
});

describe("sandbox installation", () => {
  it("issues an installation token and a scoped agent token offline", () => {
    const root = temporary("worktree-control-sandbox-prepare-");
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const paths = resolveAppPaths(join(root, "data"), join(root, "state"), { environment: {} });
    const installation = prepareSandboxInstallation(paths, { projectName: "Prepared", permissions: ["knowledge:read"] });
    expect(installation.project.name).toBe("Prepared");
    expect(installation.agent.permissions).toEqual(["knowledge:read"]);
    const store = new SqliteStateStore(paths.databasePath);
    try {
      const owner = authenticateOfflineActor(store, installation.installationToken);
      expect(owner.actor.principalKind).toBe("installation");
      const grants = owner.identity.listKnowledgeGrants(installation.agent.principalId, owner.actor);
      expect(grants.map(grant => [grant.projectId, grant.permissions])).toEqual([[installation.project.id, ["knowledge:read"]]]);
      expect(authenticateOfflineActor(store, installation.agent.token).actor.principalId).toBe(installation.agent.principalId);
    } finally {
      store.close();
    }
  });
});

describe("sandbox lifecycle", () => {
  it("prints one descriptor, then stops the controller and removes its files", async () => {
    const harness = sandboxHarness("normal");
    const descriptor = await harness.descriptor;
    expect(descriptor).toMatchObject({ format: SANDBOX_FORMAT, version: "9.9.9", project: { name: "Unit" } });
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(descriptor.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(descriptor.dataDirectory.startsWith(harness.parent)).toBe(true);
    expect(harness.output()).toContain("--host 127.0.0.1");
    expect(harness.output()).toContain(`--browse-root ${join(descriptor.dataDirectory, "..")}`);
    expect(alive(descriptor.pid)).toBe(true);
    harness.stop.abort();
    await harness.run;
    expect(harness.lines).toHaveLength(1);
    expect(alive(descriptor.pid)).toBe(false);
    expectNoLeftovers(harness);
  }, 30_000);

  it("reports a controller that exits during startup and removes its files", async () => {
    const harness = sandboxHarness("exit");
    await expect(harness.run).rejects.toThrow(/exited during startup \(3\)[\s\S]*EADDRINUSE/);
    expect(harness.lines).toEqual([]);
    // Each port conflict is retried with a new controller; none of them may remain.
    expect(fakePids(harness.pidFile)).toHaveLength(3);
    expectNoLeftovers(harness);
  }, 30_000);

  it("stops a controller that never becomes ready", async () => {
    const harness = sandboxHarness("never-ready", 1_000);
    await expect(harness.run).rejects.toThrow(/not ready within 1 seconds/);
    expect(harness.lines).toEqual([]);
    expectNoLeftovers(harness);
  }, 30_000);

  it("fails when the controller exits after it was ready", async () => {
    const harness = sandboxHarness("crash-after-ready");
    await harness.descriptor;
    await expect(harness.run).rejects.toThrow(/exited unexpectedly \(4\)/);
    expectNoLeftovers(harness);
  }, 30_000);

  it("stops cleanly when asked to stop before the controller is ready", async () => {
    const harness = sandboxHarness("never-ready");
    while (!fakePids(harness.pidFile).length) await delay(20);
    harness.stop.abort();
    await harness.run;
    expect(harness.lines).toEqual([]);
    expectNoLeftovers(harness);
  }, 30_000);

  it("never accepts a record from a controller that has already exited", async () => {
    // The record outlives its writer. Whichever poll sees the exit, the sandbox must fail rather than wait.
    const harness = sandboxHarness("ready-then-exit");
    await expect(harness.run).rejects.toThrow(/exited (during startup|unexpectedly) \(5\)/);
    expect(harness.lines.length).toBeLessThanOrEqual(1);
    expectNoLeftovers(harness);
  }, 30_000);

  it("prints no descriptor when a stop was requested before the ready record was seen", async () => {
    // The controller never publishes; the test publishes for it and requests the stop in the same turn, so
    // the next poll finds a valid record and an aborted signal together, as when a stop arrives during the poll delay.
    const harness = sandboxHarness("never-ready");
    while (!fakePids(harness.pidFile).length) await delay(20);
    const [controllerPid] = fakePids(harness.pidFile);
    const [directory] = readdirSync(harness.parent);
    writeFileSync(join(harness.parent, directory!, "state", "service-access.json"), JSON.stringify({
      pid: controllerPid, startedAt: new Date().toISOString(), version: "fake", dashboardEndpoint: "http://127.0.0.1:1",
      mcpEndpoint: "http://127.0.0.1:2/mcp", accessUrl: "http://127.0.0.1:1/", logDirectory: "/nonexistent", authenticationMode: "token",
    }));
    harness.stop.abort();
    await harness.run;
    expect(harness.lines).toEqual([]);
    expectNoLeftovers(harness);
  }, 30_000);

  it("stops the controller when its service record cannot be used", async () => {
    const harness = sandboxHarness("bad-record");
    const failure = await harness.run.then(() => null, (error: unknown) => error);
    expectNoLeftovers(harness);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/service record/);
    expect(harness.lines).toEqual([]);
  }, 30_000);
});

describe("sandbox command", () => {
  it("keeps its signal handlers until it is disposed", () => {
    const signals = new EventEmitter();
    const trigger = watchSandboxStop(Object.assign(new PassThrough(), { fd: -1 }), signals);
    const counts = () => ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => signals.listenerCount(signal));
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    signals.emit("SIGHUP");
    expect(trigger.signal.aborted).toBe(true);
    // Without a listener, a repeated signal would end the process during cleanup.
    expect(counts()).toEqual([1, 1, 1]);
    trigger.dispose();
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("writes the descriptor to standard output even when only standard error is a terminal", async () => {
    const files = fixture();
    const [stdout, stderr] = [new PassThrough(), Object.assign(new PassThrough(), { isTTY: true })];
    let [written, logged] = ["", ""];
    stdout.on("data", chunk => { written += chunk; });
    stderr.on("data", chunk => { logged += chunk; });
    const status = await runSandboxCommand({ projectName: "Unit", permissions: ["knowledge:read"], readyTimeoutMs: 10_000 }, {
      entry: { command: process.execPath, args: [files.script] }, version: "9.9.9", temporaryDirectory: files.parent,
      environment: { PATH: process.env.PATH, FAKE_MODE: "crash-after-ready", FAKE_PID_FILE: files.pidFile },
    }, { stdin: Object.assign(new PassThrough(), { fd: -1 }), stdout, stderr, signals: new EventEmitter() });
    expect(status).toBe(1);
    expect(written.trim().split("\n").map(line => (JSON.parse(line) as SandboxDescriptor).format)).toEqual([SANDBOX_FORMAT]);
    expect(logged).not.toContain(SANDBOX_FORMAT);
    expect(logged).toContain("exited unexpectedly (4)");
    expectNoLeftovers(files);
  }, 30_000);

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/script"))(
    "writes the descriptor to standard output when it is redirected from an interactive terminal",
    async () => {
      const command = harnessCommand("crash-after-ready");
      const stdoutFile = join(command.scripts, "stdout");
      const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
      // `script` gives the command a terminal on standard input and standard error only.
      const child = spawn("/usr/bin/script", ["-qec", `${command.args.map(quote).join(" ")} > ${quote(stdoutFile)}`, "/dev/null"], {
        cwd: repositoryRoot, env: command.env, stdio: ["pipe", "pipe", "pipe"],
      });
      processes.push(child);
      let terminal = "";
      child.stdout!.on("data", (chunk: Buffer) => { terminal += chunk.toString(); });
      const code = await new Promise<number | null>(resolveExit => child.once("close", resolveExit));
      expect(terminal).toContain("exited unexpectedly (4)");
      expect(code).toBe(1);
      const lines = readFileSync(stdoutFile, "utf8").trim().split("\n");
      expect(lines.map(line => (JSON.parse(line) as SandboxDescriptor).format)).toEqual([SANDBOX_FORMAT]);
      expect(terminal).not.toContain(SANDBOX_FORMAT);
      expectNoLeftovers(command);
    },
    60_000,
  );

  it("finishes stopping when more signals arrive during cleanup", async () => {
    const harness = startHarness("slow-stop");
    const descriptor = await harness.descriptor();
    harness.child.kill("SIGTERM");
    await delay(300);
    harness.child.kill("SIGINT");
    await delay(300);
    harness.child.kill("SIGHUP");
    expect(await harness.exit).toEqual({ code: 0, signal: null });
    expect(alive(descriptor.pid)).toBe(false);
    expectNoLeftovers(harness);
  }, 60_000);

  it("stops and cleans up when the reader of its standard error goes away", async () => {
    const harness = startHarness("chatty");
    await harness.descriptor();
    while (!harness.stderr().includes("chatty controller")) await delay(20);
    harness.child.stderr!.destroy();
    expect(await harness.exit).toEqual({ code: 1, signal: null });
    expectNoLeftovers(harness);
  }, 60_000);

  it("stops and cleans up when its standard output is closed before the descriptor", async () => {
    const harness = startHarness("normal");
    harness.child.stdout!.destroy();
    expect(await harness.exit).toEqual({ code: 1, signal: null });
    expect(harness.stderr()).toContain("standard output was closed");
    expectNoLeftovers(harness);
  }, 60_000);

  it("delivers the output it accepted to a slow reader before exiting and reports what it dropped", async () => {
    // Two megabytes exceed what the pipe and this reader buffer: the head reaches the pipe, the next chunk
    // is queued, and the rest is dropped. The sandbox must still hold its queue until the reader has it.
    const harness = startHarness("burst-on-stop");
    await harness.descriptor();
    harness.child.stderr!.pause();
    harness.child.kill("SIGTERM");
    await delay(1_000);
    harness.child.stderr!.resume();
    expect(await harness.exit).toEqual({ code: 0, signal: null });
    expect(harness.stderr()).toContain("BURST-HEAD");
    expect(harness.stderr()).toMatch(/dropped \d+ bytes of controller output/);
    expectNoLeftovers(harness);
  }, 60_000);

  it("stops and cleans up when its standard input fails", async () => {
    // A reset socket raises a stream error; without a handler the process would end before any cleanup.
    const harness = startHarness("normal", "stdin-error");
    const descriptor = await harness.descriptor();
    harness.child.kill("SIGUSR2");
    expect(await harness.exit).toEqual({ code: 1, signal: null });
    expect(harness.stderr()).toContain("standard input");
    expect(alive(descriptor.pid)).toBe(false);
    expectNoLeftovers(harness);
  }, 60_000);

  it("drops controller output instead of queueing it while standard error is not read, then reports the amount", async () => {
    const files = fixture();
    const stalled = stalledWritable();
    const io = commandIo(stalled.stream);
    const status = runSandboxCommand({ projectName: "Unit", permissions: ["knowledge:read"], readyTimeoutMs: 10_000 }, {
      entry: { command: process.execPath, args: [files.script] }, version: "9.9.9", temporaryDirectory: files.parent,
      environment: { PATH: process.env.PATH, FAKE_MODE: "flood", FAKE_PID_FILE: files.pidFile },
    }, io);
    let maxQueued = 0;
    const sampler = setInterval(() => { maxQueued = Math.max(maxQueued, stalled.stream.writableLength); }, 5);
    try {
      while (!existsSync(`${files.pidFile}.flooded`)) await delay(20);
      // The last chunks may still be on their way from the controller's pipe.
      await delay(300);
      maxQueued = Math.max(maxQueued, stalled.stream.writableLength);
      // The controller wrote 32 MiB; the queue is bounded by the stream's mark plus one chunk, not by the volume.
      expect(maxQueued).toBeLessThan(512 * 1024);
      stalled.resume();
      let notice: RegExpExecArray | null = null;
      for (const deadline = Date.now() + 10_000; !notice && Date.now() < deadline; await delay(20)) notice = /dropped (\d+) bytes/.exec(stalled.received());
      expect(notice).not.toBeNull();
      expect(Number(notice![1])).toBeGreaterThan(30_000_000);
      expect(stalled.received().length).toBeLessThan(1024 * 1024);
      expect(stalled.received().match(/dropped \d+ bytes/g)).toHaveLength(1);
    } finally {
      clearInterval(sampler);
      io.signals.emit("SIGTERM");
    }
    expect(await status).toBe(0);
    expectNoLeftovers(files);
  }, 60_000);

  it("keeps the startup diagnostics while standard error is not read", async () => {
    const files = fixture();
    const stalled = stalledWritable();
    const status = runSandboxCommand({ projectName: "Unit", permissions: ["knowledge:read"], readyTimeoutMs: 10_000 }, {
      entry: { command: process.execPath, args: [files.script] }, version: "9.9.9", temporaryDirectory: files.parent,
      environment: { PATH: process.env.PATH, FAKE_MODE: "noisy-exit", FAKE_PID_FILE: files.pidFile },
    }, commandIo(stalled.stream));
    while (fakePids(files.pidFile).length < 3) await delay(20);
    await delay(500);
    stalled.resume();
    expect(await status).toBe(1);
    // The failure message carries the controller's own last lines although forwarding was dropping them.
    expect(stalled.received()).toMatch(/exited during startup \(3\)[\s\S]*EADDRINUSE/);
    expect(stalled.received()).toMatch(/dropped \d+ bytes/);
    expectNoLeftovers(files);
  }, 60_000);
});
