import { spawn, type ChildProcess } from "node:child_process";
import { fstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { acquireControllerLock } from "../server/controller-lock";
import { AuthenticationService, executeAuthenticationCommand, type IssuedInstallationToken } from "../server/modules/authentication";
import type { KnowledgePermission } from "../server/modules/identity";
import { resolveAppPaths, type AppPaths } from "../server/paths";
import { SqliteStateStore } from "../server/sqlite-store";
import { authenticateOfflineActor } from "./offline-actor";
import { visibleOutput } from "./output";
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

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return true;
  return new Promise(resolveExit => {
    const timer = setTimeout(() => { child.removeListener("exit", done); resolveExit(false); }, timeoutMs);
    function done() { clearTimeout(timer); resolveExit(true); }
    child.once("exit", done);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, STOP_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, 5_000)) throw new Error(`Sandbox controller ${child.pid} did not exit after SIGKILL.`);
}

class StartupFailure extends Error {
  constructor(message: string, readonly portConflict: boolean) { super(message); }
}

/** Waits for the record a service-mode controller publishes only after both listeners are bound. */
async function startController(paths: AppPaths, root: string, options: SandboxOptions, dependencies: SandboxDependencies) {
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
  let tail = "";
  const capture = (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    dependencies.log(chunk);
  };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  const spawnError = new Promise<Error>(resolveError => child.once("error", resolveError));
  const deadline = Date.now() + options.readyTimeoutMs;
  for (;;) {
    const access = readServiceAccess(paths.serviceAccessPath);
    if (access && access.pid === child.pid && access.mcpEndpoint) {
      return { child, url: new URL(access.localDashboardEndpoint ?? access.dashboardEndpoint).origin, mcpUrl: access.mcpEndpoint };
    }
    const failure = await Promise.race([spawnError, new Promise<null>(resolveWait => setTimeout(() => resolveWait(null), 50))]);
    if (failure) throw new StartupFailure(`Sandbox controller could not start: ${failure.message}`, false);
    if (exited(child)) {
      throw new StartupFailure(`Sandbox controller exited during startup (${child.exitCode ?? child.signalCode}).\n${tail}`, /EADDRINUSE/.test(tail));
    }
    if (dependencies.stop.aborted || Date.now() > deadline) {
      await stopChild(child);
      if (dependencies.stop.aborted) return null;
      throw new StartupFailure(`Sandbox controller was not ready within ${options.readyTimeoutMs / 1000} seconds.\n${tail}`, false);
    }
  }
}

/**
 * Runs one throwaway controller on private temporary directories, loopback only, and prints its
 * descriptor once. Resolves after `stop` aborts or the controller exits; every file is removed.
 */
export async function runSandbox(options: SandboxOptions, dependencies: SandboxDependencies): Promise<void> {
  const root = mkdtempSync(join(dependencies.temporaryDirectory, "worktree-control-sandbox-"));
  let child: ChildProcess | null = null;
  try {
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const paths = resolveAppPaths(join(root, "data"), join(root, "state"), { environment: {} });
    const installation = prepareSandboxInstallation(paths, options);
    let started: Awaited<ReturnType<typeof startController>> = null;
    for (let attempt = 1; ; attempt++) {
      try {
        started = await startController(paths, root, options, dependencies);
        break;
      } catch (error) {
        // Ports are probed, then bound by the child; another process can take one in between.
        if (!(error instanceof StartupFailure) || !error.portConflict || attempt >= START_ATTEMPTS) throw error;
      }
    }
    if (!started) return;
    const running = started.child;
    child = running;
    const descriptor: SandboxDescriptor = {
      format: SANDBOX_FORMAT, version: dependencies.version, pid: running.pid!,
      url: started.url, mcpUrl: started.mcpUrl,
      dataDirectory: paths.dataDirectory, stateDirectory: paths.stateDirectory,
      ...installation,
    };
    dependencies.write(JSON.stringify(descriptor));
    const unexpected = new Promise<"exited">(resolveExit => running.once("exit", () => resolveExit("exited")));
    const requested = new Promise<"stop">(resolveStop => {
      if (dependencies.stop.aborted) resolveStop("stop");
      else dependencies.stop.addEventListener("abort", () => resolveStop("stop"), { once: true });
    });
    if (await Promise.race([unexpected, requested]) === "exited") {
      throw new Error(`Sandbox controller exited unexpectedly (${running.exitCode ?? running.signalCode}).`);
    }
  } finally {
    try {
      if (child) await stopChild(child);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * Stops on SIGINT, SIGTERM or SIGHUP, and on end of standard input when it is a pipe or socket, so
 * a test harness that dies or closes its end also stops the sandbox. A terminal or /dev/null never ends it.
 */
export function sandboxStopSignal(input: Readable & { fd: number } = process.stdin, signals: NodeJS.EventEmitter = process): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.once(signal, stop);
  let watched = false;
  try {
    const stat = fstatSync(input.fd);
    watched = stat.isFIFO() || stat.isSocket();
  } catch { /* Without a readable descriptor only signals stop the sandbox. */ }
  if (watched) {
    input.on("data", () => { /* Input is ignored; only its end matters. */ });
    input.once("end", stop);
    input.once("close", stop);
    input.resume();
  }
  controller.signal.addEventListener("abort", () => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.removeListener(signal, stop);
    if (watched) input.pause();
  }, { once: true });
  return controller.signal;
}

/** The process streams and signal source the command uses; tests substitute their own. */
export interface SandboxProcessIo {
  stdin: Readable & { fd: number };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  signals: NodeJS.EventEmitter;
}

function processIo(): SandboxProcessIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signals: process };
}

/** The `sandbox` command: runs one sandbox on the process streams and returns its exit status. */
export async function runSandboxCommand(options: SandboxOptions, setup: SandboxSetup, io: SandboxProcessIo = processIo()): Promise<number> {
  try {
    await runSandbox(options, {
      ...setup,
      write: line => visibleOutput(io.stdout, io.stderr).write(`${line}\n`),
      log: chunk => io.stderr.write(chunk),
      stop: sandboxStopSignal(io.stdin, io.signals),
    });
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
