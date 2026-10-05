import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SYSTEMD_UNIT_NAME = "worktree-control.service";
export const LAUNCHD_LABEL = "dev.worktree-control.controller";
/** Service names used before the 2026-10-05 rename; `install` migrates them and `uninstall` removes them. */
export const LEGACY_SYSTEMD_UNIT_NAME = "worktree-switcher.service";
export const LEGACY_LAUNCHD_LABEL = "dev.worktree-switcher.controller";

export interface ServiceCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ServiceCommandRunner {
  run(command: string, args: string[]): ServiceCommandResult;
}

export interface ServiceInstallOptions {
  nodePath: string;
  entrypointPath: string;
  workingDirectory: string;
  startArguments: string[];
  stateDirectory: string;
  refresh: boolean;
}

export interface ServiceStatus {
  platform: "systemd" | "launchd";
  installed: boolean;
  active: boolean;
  state: string;
  pid: number | null;
  restarts: number | null;
  lastExitStatus: number | null;
  definitionPath: string;
  uptimeSeconds: number | null;
  residentMemoryBytes: number | null;
  cpuPercent: number | null;
  /** Definition of a pre-rename service that is still installed, or null. */
  legacyDefinitionPath: string | null;
}

export interface LegacyServiceRemoval {
  definitionPath: string;
  /** Whether the legacy service was running before it was stopped. */
  wasActive: boolean;
}

export interface ServiceManagerOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  uid?: number;
  environment?: NodeJS.ProcessEnv;
  runner?: ServiceCommandRunner;
}

const defaultRunner: ServiceCommandRunner = {
  run(command, args) {
    try {
      const stdout = execFileSync(command, args, {
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      return {
        status: failure.status ?? 1,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? failure.message ?? ""),
      };
    }
  },
};

export class UserServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly definitionPath: string;
  readonly legacyDefinitionPath: string;
  private readonly runner: ServiceCommandRunner;
  private readonly uid: number;

  constructor(options: ServiceManagerOptions = {}) {
    const platform = options.platform ?? process.platform;
    const home = resolve(options.homeDirectory ?? homedir());
    const environment = options.environment ?? process.env;
    this.runner = options.runner ?? defaultRunner;
    this.uid = options.uid ?? process.getuid?.() ?? -1;
    if (platform === "linux") {
      this.kind = "systemd";
      const configHome = resolve(environment.XDG_CONFIG_HOME ?? join(home, ".config"));
      this.definitionPath = join(configHome, "systemd", "user", SYSTEMD_UNIT_NAME);
      this.legacyDefinitionPath = join(configHome, "systemd", "user", LEGACY_SYSTEMD_UNIT_NAME);
    } else if (platform === "darwin") {
      this.kind = "launchd";
      this.definitionPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
      this.legacyDefinitionPath = join(home, "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`);
    } else {
      throw new Error("Persistent user service installation is supported on Linux and macOS only.");
    }
  }

  /**
   * Read our generated argument array without executing or evaluating the definition. Until the
   * renamed service is installed, a legacy definition supplies the arguments to inherit.
   */
  readStartArguments(): string[] | null {
    const path = existsSync(this.definitionPath) || !existsSync(this.legacyDefinitionPath) ? this.definitionPath : this.legacyDefinitionPath;
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Installed service definition cannot be safely read; supply the complete user backup policy.");
    const definition = readFileSync(path, "utf8");
    let command: string[];
    if (this.kind === "systemd") {
      const lines = definition.split(/\r?\n/).filter(line => line.startsWith("ExecStart="));
      const value = lines.length === 1 ? lines[0].slice("ExecStart=".length) : "";
      const quoted = /"((?:\\[\\"]|[^"\\])*)"/g;
      const matches = [...value.matchAll(quoted)];
      if (!matches.length || matches.map(match => match[0]).join(" ") !== value || matches.some(match => match[1].replaceAll("%%", "").includes("%"))) throw new Error("Installed service command cannot be safely read; supply the complete user backup policy.");
      command = matches.map(match => match[1].replace(/\\([\\"])/g, "$1").replaceAll("%%", "%"));
    } else {
      const arrays = [...definition.matchAll(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g)];
      const value = arrays.length === 1 ? arrays[0][1] : "";
      const strings = /<string>([^<]*)<\/string>/g;
      const matches = [...value.matchAll(strings)];
      if (!matches.length || value.replace(strings, "").trim() !== "" || matches.some(match => /&(?!(?:amp|lt|gt|quot|apos);)/.test(match[1]))) throw new Error("Installed service command cannot be safely read; supply the complete user backup policy.");
      const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      command = matches.map(match => match[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name]));
    }
    if (command.length < 3 || command[2] !== "start" || command.some(value => value.includes("\0"))) throw new Error("Installed service command cannot be safely read; supply the complete user backup policy.");
    return command.slice(3);
  }

  /**
   * Installs and starts the service. A legacy `worktree-switcher` service is stopped just before the
   * new one starts, because both would claim the same ports and controller lock. After the new
   * service has started, the legacy one is disabled and its definition removed. If the start fails,
   * a legacy service that was running is started again and the error is rethrown.
   */
  install(options: ServiceInstallOptions): { changed: boolean; definitionPath: string; legacy: LegacyServiceRemoval | null } {
    const definition = this.kind === "systemd" ? renderSystemdUnit(options) : renderLaunchAgent(options);
    const previous = existsSync(this.definitionPath) ? readFileSync(this.definitionPath, "utf8") : null;
    if (previous !== null && previous !== definition && !options.refresh) {
      throw new Error(`The service definition is outdated. Review the installed path and run service install --refresh: ${this.definitionPath}`);
    }
    const changed = previous !== definition;
    if (changed) writeDefinition(this.definitionPath, definition);
    const legacyInstalled = existsSync(this.legacyDefinitionPath);
    let legacyWasActive = false;

    if (this.kind === "systemd") {
      this.requireSuccess("systemctl", ["--user", "daemon-reload"]);
      this.requireSuccess("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME]);
      if (legacyInstalled) {
        legacyWasActive = this.runner.run("systemctl", ["--user", "is-active", "--quiet", LEGACY_SYSTEMD_UNIT_NAME]).status === 0;
        this.requireSuccess("systemctl", ["--user", "stop", LEGACY_SYSTEMD_UNIT_NAME]);
      }
      this.startWithLegacyRollback(legacyWasActive, () => {
        if (options.refresh && previous !== null) this.requireSuccess("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
        else this.requireSuccess("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
      });
      if (legacyInstalled) {
        this.requireSuccess("systemctl", ["--user", "disable", LEGACY_SYSTEMD_UNIT_NAME]);
        rmSync(this.legacyDefinitionPath, { force: true });
        this.requireSuccess("systemctl", ["--user", "daemon-reload"]);
      }
    } else {
      const target = this.launchdTarget();
      const legacyTarget = `${target}/${LEGACY_LAUNCHD_LABEL}`;
      if (legacyInstalled) {
        legacyWasActive = this.runner.run("launchctl", ["print", legacyTarget]).status === 0;
        if (legacyWasActive) this.requireSuccess("launchctl", ["bootout", legacyTarget]);
      }
      this.startWithLegacyRollback(legacyWasActive, () => {
        const loaded = this.runner.run("launchctl", ["print", `${target}/${LAUNCHD_LABEL}`]).status === 0;
        if (loaded && changed) this.requireSuccess("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`]);
        if (!loaded || changed) this.requireSuccess("launchctl", ["bootstrap", target, this.definitionPath]);
        this.requireSuccess("launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`]);
        if (!loaded || changed) this.requireSuccess("launchctl", ["kickstart", "-k", `${target}/${LAUNCHD_LABEL}`]);
      });
      // bootout unloads the agent; removing its plist keeps it from loading at the next login.
      if (legacyInstalled) rmSync(this.legacyDefinitionPath, { force: true });
    }
    return {
      changed,
      definitionPath: this.definitionPath,
      legacy: legacyInstalled ? { definitionPath: this.legacyDefinitionPath, wasActive: legacyWasActive } : null,
    };
  }

  private startWithLegacyRollback(legacyWasActive: boolean, start: () => void): void {
    try {
      start();
    } catch (error) {
      if (legacyWasActive) {
        if (this.kind === "systemd") this.runner.run("systemctl", ["--user", "start", LEGACY_SYSTEMD_UNIT_NAME]);
        else {
          const target = this.launchdTarget();
          this.runner.run("launchctl", ["bootstrap", target, this.legacyDefinitionPath]);
          this.runner.run("launchctl", ["kickstart", `${target}/${LEGACY_LAUNCHD_LABEL}`]);
        }
      }
      throw error;
    }
  }

  start(): void {
    if (!existsSync(this.definitionPath)) throw new Error("The Worktree Control user service is not installed.");
    if (this.kind === "systemd") this.requireSuccess("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
    else {
      const target = this.launchdTarget();
      const serviceTarget = `${target}/${LAUNCHD_LABEL}`;
      if (this.runner.run("launchctl", ["print", serviceTarget]).status !== 0) {
        this.requireSuccess("launchctl", ["bootstrap", target, this.definitionPath]);
      }
      this.requireSuccess("launchctl", ["enable", serviceTarget]);
      this.requireSuccess("launchctl", ["kickstart", serviceTarget]);
    }
  }

  stop(): void {
    if (!existsSync(this.definitionPath)) return;
    if (this.kind === "systemd") this.requireSuccess("systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]);
    else {
      const target = `${this.launchdTarget()}/${LAUNCHD_LABEL}`;
      if (this.runner.run("launchctl", ["print", target]).status === 0) this.requireSuccess("launchctl", ["bootout", target]);
    }
  }

  restart(): void {
    if (!existsSync(this.definitionPath)) throw new Error("The Worktree Control user service is not installed.");
    if (this.kind === "systemd") this.requireSuccess("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
    else {
      const target = this.launchdTarget();
      const serviceTarget = `${target}/${LAUNCHD_LABEL}`;
      if (this.runner.run("launchctl", ["print", serviceTarget]).status === 0) {
        this.requireSuccess("launchctl", ["kickstart", "-k", serviceTarget]);
      } else {
        this.requireSuccess("launchctl", ["bootstrap", target, this.definitionPath]);
        this.requireSuccess("launchctl", ["enable", serviceTarget]);
        this.requireSuccess("launchctl", ["kickstart", serviceTarget]);
      }
    }
  }

  /** Removes the service and, when still present, the pre-rename legacy service. */
  uninstall(): { removed: boolean; definitionPath: string; legacyDefinitionPath: string | null } {
    const installed = existsSync(this.definitionPath);
    const legacyInstalled = existsSync(this.legacyDefinitionPath);
    if (this.kind === "systemd") {
      this.runner.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
      if (installed) rmSync(this.definitionPath);
      if (legacyInstalled) {
        this.runner.run("systemctl", ["--user", "disable", "--now", LEGACY_SYSTEMD_UNIT_NAME]);
        rmSync(this.legacyDefinitionPath, { force: true });
      }
      this.requireSuccess("systemctl", ["--user", "daemon-reload"]);
    } else {
      const launchdTarget = this.launchdTarget();
      const target = `${launchdTarget}/${LAUNCHD_LABEL}`;
      if (this.runner.run("launchctl", ["print", target]).status === 0) this.runner.run("launchctl", ["bootout", target]);
      if (installed) rmSync(this.definitionPath);
      if (legacyInstalled) {
        const legacyTarget = `${launchdTarget}/${LEGACY_LAUNCHD_LABEL}`;
        if (this.runner.run("launchctl", ["print", legacyTarget]).status === 0) this.runner.run("launchctl", ["bootout", legacyTarget]);
        rmSync(this.legacyDefinitionPath, { force: true });
      }
    }
    return { removed: installed, definitionPath: this.definitionPath, legacyDefinitionPath: legacyInstalled ? this.legacyDefinitionPath : null };
  }

  status(): ServiceStatus {
    const legacyDefinitionPath = existsSync(this.legacyDefinitionPath) ? this.legacyDefinitionPath : null;
    return { ...this.currentStatus(), legacyDefinitionPath };
  }

  private currentStatus(): Omit<ServiceStatus, "legacyDefinitionPath"> {
    if (!existsSync(this.definitionPath)) return this.emptyStatus();
    if (this.kind === "systemd") {
      const result = this.runner.run("systemctl", [
        "--user", "show", SYSTEMD_UNIT_NAME,
        "--property=ActiveState", "--property=SubState", "--property=MainPID",
        "--property=NRestarts", "--property=ExecMainStatus", "--property=Result",
      ]);
      if (result.status !== 0) return { ...this.emptyStatus(), installed: true, state: "unavailable" };
      const values = Object.fromEntries(result.stdout.split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key]) => key));
      const pid = positiveInteger(values.MainPID);
      return {
        ...this.resourceStatus(pid),
        platform: this.kind,
        installed: true,
        active: values.ActiveState === "active",
        state: [values.ActiveState, values.SubState].filter(Boolean).join("/") || values.Result || "unknown",
        pid,
        restarts: nonNegativeInteger(values.NRestarts),
        lastExitStatus: nonNegativeInteger(values.ExecMainStatus),
        definitionPath: this.definitionPath,
      };
    }
    const result = this.runner.run("launchctl", ["print", `${this.launchdTarget()}/${LAUNCHD_LABEL}`]);
    if (result.status !== 0) return { ...this.emptyStatus(), installed: true, state: "not loaded" };
    const pid = positiveInteger(result.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1]);
    const state = result.stdout.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() ?? "loaded";
    const lastExitStatus = nonNegativeInteger(result.stdout.match(/\blast exit code\s*=\s*(-?\d+)/)?.[1]);
    return {
      ...this.resourceStatus(pid),
      platform: this.kind,
      installed: true,
      active: pid !== null,
      state,
      pid,
      restarts: null,
      lastExitStatus,
      definitionPath: this.definitionPath,
    };
  }

  private emptyStatus(): Omit<ServiceStatus, "legacyDefinitionPath"> {
    return {
      platform: this.kind,
      installed: false,
      active: false,
      state: "not installed",
      pid: null,
      restarts: null,
      lastExitStatus: null,
      definitionPath: this.definitionPath,
      uptimeSeconds: null,
      residentMemoryBytes: null,
      cpuPercent: null,
    };
  }

  private resourceStatus(pid: number | null): Pick<ServiceStatus, "uptimeSeconds" | "residentMemoryBytes" | "cpuPercent"> {
    if (!pid) return { uptimeSeconds: null, residentMemoryBytes: null, cpuPercent: null };
    const result = this.runner.run("ps", ["-p", String(pid), "-o", "etimes=,rss=,%cpu="]);
    const match = result.status === 0 ? result.stdout.trim().match(/^(\d+)\s+(\d+)\s+([\d.,]+)$/) : null;
    return match
      ? { uptimeSeconds: Number(match[1]), residentMemoryBytes: Number(match[2]) * 1024, cpuPercent: Number(match[3].replace(",", ".")) }
      : { uptimeSeconds: null, residentMemoryBytes: null, cpuPercent: null };
  }

  private launchdTarget(): string {
    if (this.uid < 0) throw new Error("Could not determine the current user ID for launchd.");
    return `gui/${this.uid}`;
  }

  private requireSuccess(command: string, args: string[]): void {
    const result = this.runner.run(command, args);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
      throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
    }
  }
}

export function renderSystemdUnit(options: ServiceInstallOptions): string {
  const command = [options.nodePath, options.entrypointPath, "start", ...options.startArguments]
    .map(systemdQuote)
    .join(" ");
  const servicePath = resolveServiceExecutablePath(options.nodePath);
  return `[Unit]\nDescription=Worktree Control local control plane\nAfter=network.target\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=${command}\nWorkingDirectory=${systemdDirectivePath(options.workingDirectory)}\nEnvironment=NODE_ENV=production\nEnvironment=${systemdQuote(`PATH=${servicePath}`)}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderLaunchAgent(options: ServiceInstallOptions): string {
  const stdoutPath = join(options.stateDirectory, "logs", "service.stdout.log");
  const stderrPath = join(options.stateDirectory, "logs", "service.stderr.log");
  const args = [options.nodePath, options.entrypointPath, "start", ...options.startArguments]
    .map((value) => `    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args}\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(options.workingDirectory)}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>NODE_ENV</key><string>production</string>\n    <key>PATH</key><string>${xmlEscape(controlledServicePath(options.nodePath))}</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key>\n  <integer>5</integer>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>AbandonProcessGroup</key>\n  <false/>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderrPath)}</string>\n</dict>\n</plist>\n`;
}

function writeDefinition(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function systemdQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Service arguments cannot contain NUL or newline characters.");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdDirectivePath(value: string): string {
  if (!value.startsWith("/") || /[\0\r\n]/.test(value)) throw new Error("The service working directory must be an absolute path without control characters.");
  return value.replaceAll("%", "%%");
}

function xmlEscape(value: string): string {
  if (/[\0]/.test(value)) throw new Error("Service arguments cannot contain NUL characters.");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function resolveServiceExecutablePath(nodePath: string, environmentPath = process.env.PATH ?? ""): string {
  const packageManagers = ["pnpm", "npm", "yarn", "bun"];
  const discoveredDirectories = environmentPath
    .split(":")
    .filter((directory) => directory.startsWith("/"))
    .filter((directory) => packageManagers.some((executable) => isExecutableFile(join(directory, executable))));
  const directories = [dirname(nodePath), ...discoveredDirectories, "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(directories)].join(":");
}

function controlledServicePath(nodePath: string): string {
  return resolveServiceExecutablePath(nodePath);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
