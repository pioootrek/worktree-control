import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { LaunchPreset, ProjectSnapshot, ProjectView } from "../shared/contracts";
import type { WebExportStatus } from "../shared/contracts/godot-web";
import { localizeServerMessage } from "../i18n/server-errors";
import { type Locale, translate } from "../i18n/messages";
import { ControlService } from "../server/control-service";
import { AdminRequestError, requestAdminSocket } from "../server/admin-socket";
import { acquireControllerLock, ControllerAlreadyRunningError, type ControllerLock } from "../server/controller-lock";
import { SystemGitWorktreeReader } from "../server/git-worktrees";
import { detectLaunchPreset } from "../server/launch-command";
import { nullLogWriter } from "../server/log-writer";
import type { AppPaths } from "../server/paths";
import { ProcessManager } from "../server/process-manager";
import { ProjectLifecycle } from "../server/modules/lifecycle";
import { createGodotWebRuntime } from "./godot-web-runtime";
import { discoverProjectRegistrationTarget } from "../server/project-registration";
import { SqliteStateStore } from "../server/sqlite-store";
import { controllerAccessToken, localDashboardEndpoint, readServiceAccess } from "./service-access";

const execFileAsync = promisify(execFile);

export interface ProjectGateway {
  readonly mode: "controller" | "offline";
  dashboard(): Promise<ProjectOverview>;
  addProject(input: ProjectAddInput): Promise<ProjectView>;
  removeProject(projectId: string): Promise<ProjectView>;
  configureGodotWeb(projectId: string, config: unknown): Promise<ProjectView>;
  rebuildWebExport(projectId: string): Promise<WebExportStatus>;
  close(): Promise<void>;
}

/** The dashboard fields project commands read; a full dashboard response satisfies it. */
export interface ProjectOverview {
  projects: Array<Pick<ProjectSnapshot, "project" | "runtime" | "reservation" | "discoveryError">>;
}

/** Localizes the overview's error text, as the HTTP API does for its dashboard. */
function localizedOverview(overview: ProjectOverview, locale: Locale): ProjectOverview {
  if (locale === "pl") return overview;
  return {
    projects: overview.projects.map((entry) => ({
      ...entry,
      ...(entry.discoveryError ? { discoveryError: localizeServerMessage(entry.discoveryError, locale) } : {}),
      runtime: { ...entry.runtime, error: entry.runtime.error ? localizeServerMessage(entry.runtime.error, locale) : null },
    })),
  };
}

export interface ProjectAddInput { name: string; repositoryPath: string; port: number; launchPreset: LaunchPreset; godotWeb?: unknown }

/** Reads a bounded JSON configuration file named on the command line. */
function readConfigFile(path: string): unknown {
  const absolute = resolve(path);
  if (statSync(absolute).size > 64 * 1024) throw new Error("The Godot Web configuration file is larger than 64 KiB.");
  return JSON.parse(readFileSync(absolute, "utf8"));
}

export interface ProjectCommandDependencies {
  isPortAvailable?: (port: number) => Promise<boolean>;
  write?: (line: string) => void;
}

export async function openProjectGateway(paths: AppPaths, locale: Locale): Promise<ProjectGateway> {
  const access = readServiceAccess(paths.serviceAccessPath);
  if (access && processExists(access.pid)) {
    const token = controllerAccessToken(access);
    if (!token && access.authenticationMode === "token") throw new Error(translate(locale, "cli.project.installationTokenRequired"));
    // An open-mode controller authenticates nobody, so no token is needed.
    const credential = access.authenticationMode === "open" ? token ?? "" : token;
    // Account modes issue no CLI credential; the owner-only admin socket replaces it.
    if (credential === null) return new AdminSocketProjectGateway(paths.adminSocketPath, access.pid, locale);
    return new ControllerProjectGateway(localDashboardEndpoint(access), credential, locale);
  }

  let lock: ControllerLock;
  try {
    lock = acquireControllerLock(paths.controllerLockPath);
  } catch (error) {
    if (error instanceof ControllerAlreadyRunningError) {
      throw new Error(translate(locale, "cli.project.controllerUnavailable"));
    }
    throw error;
  }

  try {
    const store = new SqliteStateStore(paths.databasePath);
    const processes = new ProcessManager(() => undefined, nullLogWriter);
    const git = new SystemGitWorktreeReader();
    const lifecycle = new ProjectLifecycle(store, processes);
    // Offline access configures projects only; no runtime runs, so no export can be queued.
    const offlineJobs = {
      enqueue: () => { throw new Error("Exports run only in a running controller."); },
      cancel: () => Promise.reject(new Error("Exports run only in a running controller.")),
    };
    const { commands, godotWeb } = createGodotWebRuntime(paths.stateDirectory, {
      store, git, processes, jobs: offlineJobs, lifecycle, logs: nullLogWriter, notify: () => undefined,
    });
    const service = new ControlService(store, git, processes, nullLogWriter, commands, undefined, undefined, undefined, undefined, lifecycle, undefined, undefined, undefined, godotWeb);
    return new OfflineProjectGateway(service, lock, locale);
  } catch (error) {
    lock.release();
    throw error;
  }
}

export async function runProjectCommand(
  args: string[],
  gateway: ProjectGateway,
  locale: Locale,
  dependencies: ProjectCommandDependencies = {},
): Promise<void> {
  const write = dependencies.write ?? ((line) => process.stdout.write(`${line}\n`));
  const action = args[0];
  if (action === "list") {
    const dashboard = await gateway.dashboard();
    if (args.includes("--json")) {
      write(JSON.stringify(dashboard.projects.map(({ project, runtime, reservation, discoveryError }) => ({
        id: project.id,
        name: project.name,
        repositoryPath: project.repositoryPath,
        port: project.port,
        launchPreset: project.launchPreset,
        selectedWorktreePath: project.selectedWorktreePath,
        runtimePhase: project.launchPreset === "none" ? "no_server" : runtime.phase,
        reservedBy: reservation?.owner ?? null,
        discoveryError: discoveryError ?? null,
      })), null, 2));
      return;
    }
    if (dashboard.projects.length === 0) {
      write(translate(locale, "cli.project.empty"));
      return;
    }
    write(translate(locale, "cli.project.listHeader"));
    for (const { project, runtime } of dashboard.projects) {
      write([project.id, project.name, project.port, project.launchPreset, project.launchPreset === "none" ? "no_server" : runtime.phase, project.selectedWorktreePath ?? "-"].join("\t"));
    }
    return;
  }

  if (action === "add") {
    const repositoryPath = positionalArgument(args, 1, ["--name", "--port", "--preset", "--godot-web-config"]);
    if (!repositoryPath) throw new Error(translate(locale, "cli.project.addUsage"));
    const preset = optionValue(args, "--preset", locale) ?? "auto";
    if (preset !== "auto" && preset !== "node" && preset !== "django" && preset !== "none" && preset !== "godot-web") {
      throw new Error(translate(locale, "cli.project.invalidPreset"));
    }
    const dashboard = await gateway.dashboard();
    const requestedPort = optionValue(args, "--port", locale);
    const configuredPorts = new Map(dashboard.projects.map(({ project }) => [project.port, project.name]));
    const resolvedPath = resolve(repositoryPath);
    let port: number;
    if (requestedPort) {
      port = parseProjectPort(requestedPort, locale);
      const assignedProject = configuredPorts.get(port);
      if (assignedProject) throw new Error(translate(locale, "cli.project.portAssigned", { port, name: assignedProject }));
    } else {
      let resolvedPreset = preset;
      if (preset === "auto") {
        const git = new SystemGitWorktreeReader();
        try {
          const { selectedWorktree } = await discoverProjectRegistrationTarget(git, resolvedPath);
          resolvedPreset = detectLaunchPreset(selectedWorktree.path);
        } finally {
          git.close();
        }
      }
      try {
        port = await findAvailablePort(
          new Set(configuredPorts.keys()),
          resolvedPreset === "none" ? async () => true : dependencies.isPortAvailable ?? isPortAvailable,
        );
      } catch {
        throw new Error(translate(locale, "cli.project.noAvailablePort"));
      }
    }
    const configPath = optionValue(args, "--godot-web-config", locale);
    if (configPath && preset !== "godot-web") throw new Error(translate(locale, "cli.project.godotWebConfigRequiresPreset"));
    const project = await gateway.addProject({
      name: optionValue(args, "--name", locale) ?? basename(resolvedPath),
      repositoryPath: resolvedPath,
      port,
      launchPreset: preset,
      ...(configPath ? { godotWeb: readConfigFile(configPath) } : {}),
    });
    write(translate(locale, "cli.project.added", { name: project.name, id: project.id, port: project.port }));
    return;
  }

  if (action === "godot-web") {
    const projectId = positionalArgument(args, 1, ["--config"]);
    const configPath = optionValue(args, "--config", locale);
    const disable = args.includes("--disable");
    if (!projectId || Boolean(configPath) === disable) throw new Error(translate(locale, "cli.project.godotWebUsage"));
    const project = await gateway.configureGodotWeb(projectId, disable ? null : readConfigFile(configPath!));
    write(translate(locale, "cli.project.godotWebConfigured", { name: project.name, preset: project.launchPreset }));
    return;
  }

  if (action === "rebuild-web") {
    const projectId = positionalArgument(args, 1, []);
    if (!projectId) throw new Error(translate(locale, "cli.project.rebuildWebUsage"));
    const status = await gateway.rebuildWebExport(projectId);
    write(translate(locale, "cli.project.rebuildWebRequested", { state: status.state }));
    return;
  }

  if (action === "remove") {
    const projectId = positionalArgument(args, 1, []);
    if (!projectId) throw new Error(translate(locale, "cli.project.removeUsage"));
    const project = await gateway.removeProject(projectId);
    write(translate(locale, "cli.project.removed", { name: project.name, id: project.id }));
    return;
  }

  throw new Error(translate(locale, "cli.project.commands"));
}

export async function runDoctorCommand(
  gateway: ProjectGateway,
  locale: Locale,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<boolean> {
  let healthy = true;
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 22) write(translate(locale, "cli.doctor.nodeOk", { version: process.versions.node }));
  else {
    healthy = false;
    write(translate(locale, "cli.doctor.nodeFailed", { version: process.versions.node }));
  }

  try {
    const { stdout } = await execFileAsync("git", ["--version"], { encoding: "utf8", timeout: 5_000 });
    write(translate(locale, "cli.doctor.gitOk", { version: stdout.trim() }));
  } catch {
    healthy = false;
    write(translate(locale, "cli.doctor.gitFailed"));
  }

  try {
    const dashboard = await gateway.dashboard();
    write(translate(locale, "cli.doctor.stateOk", { mode: gateway.mode, count: dashboard.projects.length }));
    for (const snapshot of dashboard.projects) {
      if (!snapshot.discoveryError) continue;
      healthy = false;
      write(translate(locale, "cli.doctor.projectFailed", {
        name: snapshot.project.name,
        error: localizeServerMessage(snapshot.discoveryError, locale),
      }));
    }
  } catch (error) {
    healthy = false;
    write(translate(locale, "cli.doctor.stateFailed", { error: messageFrom(error) }));
  }

  write(translate(locale, healthy ? "cli.doctor.healthy" : "cli.doctor.unhealthy"));
  return healthy;
}

export async function findAvailablePort(
  configured: ReadonlySet<number>,
  available: (port: number) => Promise<boolean> = isPortAvailable,
): Promise<number> {
  for (let port = 3000; port <= 3999; port += 1) {
    if (!configured.has(port) && await available(port)) return port;
  }
  throw new Error("No free project port was found between 3000 and 3999.");
}

class OfflineProjectGateway implements ProjectGateway {
  readonly mode = "offline" as const;
  private closed = false;

  constructor(private readonly service: ControlService, private readonly lock: ControllerLock, private readonly locale: Locale) {}

  async dashboard(): Promise<ProjectOverview> {
    return localizedOverview(await this.service.dashboard(), this.locale);
  }

  addProject(input: ProjectAddInput): Promise<ProjectView> {
    return this.service.addProject(input as Parameters<ControlService["addProject"]>[0]);
  }

  configureGodotWeb(projectId: string, config: unknown): Promise<ProjectView> {
    return this.service.configureGodotWeb(projectId, config);
  }

  rebuildWebExport(projectId: string): Promise<WebExportStatus> {
    return this.service.rebuildWebExport(projectId);
  }

  removeProject(projectId: string): Promise<ProjectView> {
    return this.service.removeProject(projectId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.service.shutdown();
    } finally {
      this.lock.release();
    }
  }
}

/** Upper bound for one admin socket reply; the project overview carries no test history or logs. */
const ADMIN_PROJECT_RESPONSE_LIMIT = 8 * 1024 * 1024;

/**
 * Reaches a running controller through its owner-only admin socket when the CLI has no HTTP
 * credential, as in better-auth mode. Operating-system permissions authorize the request.
 */
class AdminSocketProjectGateway implements ProjectGateway {
  readonly mode = "controller" as const;

  constructor(private readonly socketPath: string, private readonly pid: number, private readonly locale: Locale) {}

  async dashboard(): Promise<ProjectOverview> {
    return localizedOverview(await this.request<ProjectOverview>({ action: "dashboard" }), this.locale);
  }

  async addProject(input: ProjectAddInput): Promise<ProjectView> {
    return (await this.request<{ project: ProjectView }>({ action: "add", input })).project;
  }

  async configureGodotWeb(projectId: string, config: unknown): Promise<ProjectView> {
    return (await this.request<{ project: ProjectView }>({ action: "configure-godot-web", projectId, config })).project;
  }

  async rebuildWebExport(projectId: string): Promise<WebExportStatus> {
    return (await this.request<{ webExport: WebExportStatus }>({ action: "rebuild-web-export", projectId })).webExport;
  }

  async removeProject(projectId: string): Promise<ProjectView> {
    return (await this.request<{ project: ProjectView }>({ action: "remove", projectId })).project;
  }

  async close(): Promise<void> {}

  private async request<T>(body: Record<string, unknown>): Promise<T> {
    try {
      return await requestAdminSocket(this.socketPath, { command: "project", ...body }, 60_000, ADMIN_PROJECT_RESPONSE_LIMIT) as T;
    } catch (error) {
      if (error instanceof AdminRequestError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        throw new Error(translate(this.locale, "cli.project.adminSocketUnavailable", { pid: this.pid, path: this.socketPath }));
      }
      throw error;
    }
  }
}

class ControllerProjectGateway implements ProjectGateway {
  readonly mode = "controller" as const;
  private readonly token: string;
  private readonly endpoints: string[];

  /** An empty token sends no credential header. */
  constructor(endpoint: string, token: string, private readonly locale: Locale) {
    this.token = token;
    this.endpoints = controllerEndpoints(endpoint);
  }

  async dashboard(): Promise<ProjectOverview> {
    return this.request<ProjectOverview>("/api/dashboard");
  }

  async addProject(input: ProjectAddInput): Promise<ProjectView> {
    const result = await this.request<{ project: ProjectView }>("/api/projects", { method: "POST", body: JSON.stringify(input) });
    return result.project;
  }

  async configureGodotWeb(projectId: string, config: unknown): Promise<ProjectView> {
    const result = await this.request<{ project: ProjectView }>(`/api/projects/${encodeURIComponent(projectId)}/godot-web`, { method: "POST", body: JSON.stringify({ config }) });
    return result.project;
  }

  async rebuildWebExport(projectId: string): Promise<WebExportStatus> {
    const result = await this.request<{ webExport: WebExportStatus }>(`/api/projects/${encodeURIComponent(projectId)}/godot-web/rebuild`, { method: "POST", body: "{}" });
    return result.webExport;
  }

  async removeProject(projectId: string): Promise<ProjectView> {
    const result = await this.request<{ project: ProjectView }>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
    return result.project;
  }

  async close(): Promise<void> {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const failures: string[] = [];
    for (const endpoint of this.endpoints) {
      let response: Response;
      try {
        response = await fetch(`${endpoint}${path}`, {
          ...init,
          headers: {
            "Accept-Language": this.locale,
            "Content-Type": "application/json",
            ...(this.token ? { "X-Worktree-Control-Token": this.token } : {}),
            ...init.headers,
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        failures.push(`${endpoint}: ${messageWithCause(error)}`);
        continue;
      }
      let body: { error?: string } & T;
      try {
        body = await response.json() as { error?: string } & T;
      } catch {
        throw new Error(translate(this.locale, "cli.project.controllerInvalidResponse", {
          endpoint,
          status: response.status,
        }));
      }
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    }
    throw new Error(translate(this.locale, "cli.project.controllerRequestFailed", {
      endpoint: this.endpoints.join(", "),
      error: failures.join("; "),
    }));
  }
}

function optionValue(args: string[], name: string, locale: Locale): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(translate(locale, "cli.optionMissing", { option: name }));
  return value;
}

function controllerEndpoints(endpoint: string): string[] {
  const recorded = new URL(endpoint);
  recorded.pathname = recorded.pathname.replace(/\/$/, "");
  const loopback = new URL(recorded);
  loopback.hostname = "127.0.0.1";
  return [...new Set([loopback.toString().replace(/\/$/, ""), recorded.toString().replace(/\/$/, "")])];
}

function positionalArgument(args: string[], targetIndex: number, optionsWithValues: string[]): string | undefined {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.includes(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) positional.push(args[index]);
  }
  return positional[targetIndex];
}

function parseProjectPort(value: string, locale: Locale): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(translate(locale, "cli.project.invalidPort"));
  return port;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageWithCause(error: unknown): string {
  const message = messageFrom(error);
  if (!(error instanceof Error) || !("cause" in error) || !error.cause) return message;
  const cause = error.cause as NodeJS.ErrnoException;
  return `${message}${cause.code ? ` (${cause.code})` : ""}${cause.message ? `: ${cause.message}` : ""}`;
}
