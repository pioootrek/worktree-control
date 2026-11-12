import { spawn, type ChildProcess } from "node:child_process";
import { fstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { acquireControllerLock } from "../server/controller-lock";
import { AuthenticationService, executeAuthenticationCommand, type IssuedInstallationToken } from "../server/modules/authentication";
import type { KnowledgePermission } from "../server/modules/identity";
import { resolveAppPaths, type AppPaths } from "../server/paths";
import { SqliteStateStore } from "../server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import { readServiceAccess } from "./service-access";

/** Consumers check this before reading any other field; it changes only with an incompatible output. */
export const SANDBOX_FORMAT = "worktree-control-sandbox/1";

const SANDBOX_ACTOR = "local-sandbox";
const PERMISSIONS: readonly KnowledgePermission[] = [
  "knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export", "knowledge:import",
  "attachments:read", "attachments:write",
];
const DEFAULT_PERMISSIONS: KnowledgePermission[] = ["knowledge:read", "knowledge:write"];
const USAGE = "Usage: worktree-control sandbox [--project-name NAME] [--permissions LIST] [--ready-timeout-seconds N]";
const STOP_GRACE_MS = 15_000;
const START_ATTEMPTS = 3;
const OUTPUT_TAIL_BYTES = 8 * 1024;
/** How long an exited controller's remaining output may take to arrive. */
const OUTPUT_CLOSE_MS = 2_000;
/** How long buffered output may take to reach a slow reader before the command exits anyway. */
const OUTPUT_DRAIN_MS = 5_000;

export interface SandboxOptions {
  projectName: string;
  permissions: KnowledgePermission[];
  readyTimeoutMs: number;
}

/** The single JSON line a sandbox prints once its controller accepts requests. */
export interface SandboxDescriptor {
  format: typeof SANDBOX_FORMAT;
  version: string;
  pid: number;
  url: string;
  mcpUrl: string;
  dataDirectory: string;
  stateDirectory: string;
  /** Acts as the installation owner in token mode: identity administration and every Knowledge project. */
  installationToken: string;
  project: { id: string; name: string };
  agent: { principalId: string; token: string; permissions: KnowledgePermission[] };
}

export interface SandboxSetup {
  /** Command that runs this CLI; the sandbox appends `start` and its own options. */
  entry: { command: string; args: readonly string[] };
  version: string;
  temporaryDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface SandboxDependencies extends SandboxSetup {
  /** Receives the descriptor line on standard output. */
  write: (line: string) => void;
  /** Receives the controller's own output, which never reaches standard output. */
  log: (chunk: string | Buffer) => void;
  /** Aborting stops the controller and removes every sandbox file. */
  stop: AbortSignal;
}

export function parseSandboxArgs(args: readonly string[]): SandboxOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!["--project-name", "--permissions", "--ready-timeout-seconds"].includes(name)) throw new Error(`Unsupported sandbox option: ${name.split("=")[0]}. ${USAGE}`);
    if (values.has(name)) throw new Error(`${name} must occur once. ${USAGE}`);
    if (value === undefined || value.startsWith("--") || !value.trim() || value.includes("\0")) throw new Error(`Missing value for ${name}. ${USAGE}`);
    values.set(name, value);
  }
  const permissions = values.has("--permissions")
    ? values.get("--permissions")!.split(",").map(value => value.trim()).filter(Boolean)
    : DEFAULT_PERMISSIONS;
  if (!permissions.length || permissions.some(value => !PERMISSIONS.includes(value as KnowledgePermission)) || new Set(permissions).size !== permissions.length) {
    throw new Error(`Invalid --permissions. Allowed values: ${PERMISSIONS.join(", ")}.`);
  }
  const timeout = values.get("--ready-timeout-seconds") ?? "30";
  if (!/^[1-9][0-9]{0,2}$/.test(timeout)) throw new Error("--ready-timeout-seconds must be an integer from 1 to 999.");
  return { projectName: values.get("--project-name") ?? "Sandbox", permissions: permissions as KnowledgePermission[], readyTimeoutMs: Number(timeout) * 1000 };
}

/** The child must not inherit the host installation's directories, tokens or startup settings. */
export function sandboxEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !/^WORKTREE_(CONTROL|SWITCHER)_/.test(key)) result[key] = value;
  }
  return result;
}

/**
 * Offline, under the controller lock of the fresh directories: the token-mode installation token,
 * one Knowledge project and one agent with a scoped grant. Nothing here can reach another installation.
 */
export function prepareSandboxInstallation(paths: AppPaths, options: Pick<SandboxOptions, "projectName" | "permissions">) {
  const lock = acquireControllerLock(paths.controllerLockPath);
  let store: SqliteStateStore | null = null;
  try {
    store = new SqliteStateStore(paths.databasePath);
    const authentication = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
    const { result } = executeAuthenticationCommand(authentication, { command: "token generate" }, SANDBOX_ACTOR);
    const installationToken = (result as IssuedInstallationToken).token;
    const { identity, actor } = authenticateOfflineActor(store, installationToken);
    const project = identity.createKnowledgeProject({ name: options.projectName }, actor);
    const agent = identity.createAgent(actor);
    identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: options.permissions }, actor);
    const issued = identity.issueAgentToken({ principalId: agent.id, label: "sandbox" }, actor);
    return {
      installationToken,
      project: { id: project.id, name: project.name },
      agent: { principalId: agent.id, token: issued.token, permissions: [...options.permissions] },
    };
  } finally {
    store?.close();
    lock.release();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a sandbox port."));
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true when `promise` settles within `timeoutMs`, false otherwise. */
async function within(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A spawned controller. Its promises exist from the moment of spawning, so no exit can be missed. */
interface Controller {
  child: ChildProcess;
  /** Settles when the process has exited, or failed to start at all. */
  exit: Promise<void>;
  /** Settles when its output pipes have closed, after the last forwarded chunk. */
  closed: Promise<void>;
  startError: () => Error | null;
  tail: () => string;
}

async function spawnController(paths: AppPaths, root: string, dependencies: SandboxDependencies): Promise<Controller> {
  const [port, mcpPort] = [await freePort(), await freePort()];
  const child: ChildProcess = spawn(dependencies.entry.command, [
    ...dependencies.entry.args, "start", "--service-mode", "--no-open",
    "--host", "127.0.0.1", "--port", String(port), "--mcp-port", String(mcpPort),
    "--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory, "--browse-root", root,
  ], {
    env: sandboxEnvironment(dependencies.environment) as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"],
    // A terminal interrupt reaches only the sandbox, which sends exactly one SIGTERM; a second
    // signal would end the controller during its own shutdown.
    detached: true,
  });
  let startError: Error | null = null;
  const exit = new Promise<void>(resolveExit => {
    child.once("exit", () => resolveExit());
    child.on("error", error => {
      // Without a pid the process never started and no `exit` follows.
      if (child.pid === undefined) { startError = error; resolveExit(); }
    });
  });
  const closed = new Promise<void>(resolveClose => child.once("close", () => resolveClose()));
  let tail = "";
  const capture = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    dependencies.log(chunk);
  };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  return { child, exit, closed, startError: () => startError, tail: () => tail };
}

/**
 * Sends exactly one SIGTERM, then SIGKILL after the grace period, and waits briefly for the
 * controller's remaining output. Stopping an exited controller only collects that output.
 */
async function stopController(controller: Controller): Promise<void> {
  const { child } = controller;
  if (child.pid === undefined) return;
  if (!exited(child)) {
    child.kill("SIGTERM");
    if (!await within(controller.exit, STOP_GRACE_MS)) {
      child.kill("SIGKILL");
      if (!await within(controller.exit, 5_000)) throw new Error(`Sandbox controller ${child.pid} did not exit after SIGKILL.`);
    }
  }
  await within(controller.closed, OUTPUT_CLOSE_MS);
}

class StartupFailure extends Error {
  constructor(message: string, readonly portConflict: boolean) { super(message); }
}

/**
 * Waits for the record a service-mode controller publishes only after both listeners are bound.
 * Returns null when `stop` aborts first. The caller stops the controller on every outcome.
 */
async function waitForReady(controller: Controller, paths: AppPaths, options: SandboxOptions, stop: AbortSignal) {
  const { child } = controller;
  const deadline = Date.now() + options.readyTimeoutMs;
  for (;;) {
    const access = readServiceAccess(paths.serviceAccessPath);
    const startError = controller.startError();
    if (startError) throw new StartupFailure(`Sandbox controller could not start: ${startError.message}`, false);
    // The record outlives its writer, so a controller that has exited is never ready.
    if (exited(child)) {
      await within(controller.closed, OUTPUT_CLOSE_MS);
      const tail = controller.tail();
      throw new StartupFailure(`Sandbox controller exited during startup (${child.exitCode ?? child.signalCode}).\n${tail}`, /EADDRINUSE/.test(tail));
    }
    if (access && access.pid === child.pid && access.mcpEndpoint) {
      const dashboard = access.localDashboardEndpoint ?? access.dashboardEndpoint;
      if (!URL.canParse(dashboard) || !URL.canParse(access.mcpEndpoint)) {
        throw new StartupFailure("Sandbox controller published a service record without valid endpoints.", false);
      }
      return { url: new URL(dashboard).origin, mcpUrl: access.mcpEndpoint };
    }
    if (stop.aborted) return null;
    if (Date.now() > deadline) throw new StartupFailure(`Sandbox controller was not ready within ${options.readyTimeoutMs / 1000} seconds.\n${controller.tail()}`, false);
    await delay(50);
  }
}

/**
 * Runs one throwaway controller on private temporary directories, loopback only, and prints its
 * descriptor once. Resolves after `stop` aborts or the controller exits; every file is removed and
 * every controller it spawned has exited before it settles.
 */
export async function runSandbox(options: SandboxOptions, dependencies: SandboxDependencies): Promise<void> {
  const root = mkdtempSync(join(dependencies.temporaryDirectory, "worktree-control-sandbox-"));
  let controller: Controller | null = null;
  try {
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const paths = resolveAppPaths(join(root, "data"), join(root, "state"), { environment: {} });
    const installation = prepareSandboxInstallation(paths, options);
    let endpoints: Awaited<ReturnType<typeof waitForReady>> = null;
    for (let attempt = 1; ; attempt++) {
      if (dependencies.stop.aborted) return;
      controller = await spawnController(paths, root, dependencies);
      try {
        endpoints = await waitForReady(controller, paths, options, dependencies.stop);
        break;
      } catch (error) {
        // Ports are probed, then bound by the child; another process can take one in between.
        if (!(error instanceof StartupFailure) || !error.portConflict || attempt >= START_ATTEMPTS) throw error;
        await stopController(controller);
        controller = null;
      }
    }
    if (!endpoints || !controller) return;
    const descriptor: SandboxDescriptor = {
      format: SANDBOX_FORMAT, version: dependencies.version, pid: controller.child.pid!,
      url: endpoints.url, mcpUrl: endpoints.mcpUrl,
      dataDirectory: paths.dataDirectory, stateDirectory: paths.stateDirectory,
      ...installation,
    };
    dependencies.write(JSON.stringify(descriptor));
    const requested = new Promise<"stop">(resolveStop => {
      if (dependencies.stop.aborted) resolveStop("stop");
      else dependencies.stop.addEventListener("abort", () => resolveStop("stop"), { once: true });
    });
    if (await Promise.race([controller.exit.then(() => "exited" as const), requested]) === "exited") {
      throw new Error(`Sandbox controller exited unexpectedly (${controller.child.exitCode ?? controller.child.signalCode}).`);
    }
  } finally {
    try {
      if (controller) await stopController(controller);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface SandboxStopTrigger {
  signal: AbortSignal;
  /** Requests a stop; repeating it has no further effect. */
  stop: () => void;
  /** Removes the handlers. Call it only after the controller has exited and the files are gone. */
  dispose: () => void;
}

/**
 * Stops on SIGINT, SIGTERM or SIGHUP, and on end of standard input when it is a pipe or socket, so
 * a test harness that dies or closes its end also stops the sandbox. A terminal or /dev/null never ends it.
 * The signal handlers stay installed until `dispose`, so a repeated signal cannot interrupt cleanup.
 */
export function watchSandboxStop(input: Readable & { fd: number } = process.stdin, signals: NodeJS.EventEmitter = process): SandboxStopTrigger {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of STOP_SIGNALS) signals.on(signal, stop);
  let watched = false;
  try {
    const stat = fstatSync(input.fd);
    watched = stat.isFIFO() || stat.isSocket();
  } catch { /* Without a readable descriptor only signals stop the sandbox. */ }
  const ignore = () => { /* Input is ignored; only its end matters. */ };
  if (watched) {
    input.on("data", ignore);
    input.once("end", stop);
    input.once("close", stop);
    input.resume();
  }
  return {
    signal: controller.signal,
    stop,
    dispose: () => {
      for (const signal of STOP_SIGNALS) signals.removeListener(signal, stop);
      if (!watched) return;
      input.removeListener("data", ignore);
      input.removeListener("end", stop);
      input.removeListener("close", stop);
      input.pause();
    },
  };
}

/** The process streams and signal source the command uses; tests substitute their own. */
export interface SandboxProcessIo {
  stdin: Readable & { fd: number };
  stdout: Writable;
  stderr: Writable;
  signals: NodeJS.EventEmitter;
}

function processIo(): SandboxProcessIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signals: process };
}

/**
 * A process stream whose reader may go away. A write error such as EPIPE stops the sandbox
 * instead of ending the process before cleanup, and nothing more is written to that stream.
 */
function guardOutput(stream: Writable, stop: () => void) {
  let failed = false;
  // Stays installed: a write still in flight may fail after the sandbox has finished.
  stream.on("error", () => { failed = true; stop(); });
  const usable = () => !failed && !stream.destroyed && stream.writable;
  return {
    failed: () => failed,
    write: (chunk: string | Buffer) => { if (usable()) stream.write(chunk); },
    /** Waits until buffered output has reached the reader, the stream fails, or the time runs out. */
    drain: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (usable() && stream.writableLength > 0 && Date.now() < deadline) await delay(20);
    },
  };
}

/**
 * The `sandbox` command: runs one sandbox on the process streams and returns its exit status once
 * the controller has exited, the files are gone and buffered output has drained. The caller then
 * exits the process; a watched standard input would otherwise keep it alive.
 * The descriptor always goes to standard output, whatever the terminal state of the other streams.
 */
export async function runSandboxCommand(options: SandboxOptions, setup: SandboxSetup, io: SandboxProcessIo = processIo()): Promise<number> {
  const trigger = watchSandboxStop(io.stdin, io.signals);
  const stdout = guardOutput(io.stdout, trigger.stop);
  const stderr = guardOutput(io.stderr, trigger.stop);
  let status = 0;
  try {
    await runSandbox(options, {
      ...setup,
      write: line => stdout.write(`${line}\n`),
      log: chunk => stderr.write(chunk),
      stop: trigger.signal,
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    status = 1;
  }
  if (stdout.failed()) stderr.write("Sandbox stopped: its standard output was closed.\n");
  await Promise.all([stdout.drain(OUTPUT_DRAIN_MS), stderr.drain(OUTPUT_DRAIN_MS)]);
  // The handlers stay installed until the caller exits the process: removing them first would let a
  // late signal end it by default action, with a status that no longer reports the outcome.
  return stdout.failed() || stderr.failed() ? 1 : status;
}
