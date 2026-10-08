import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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
  /** systemd drop-in files copied from the legacy unit's `.d` directory to the new unit's. */
  migratedDropIns: string[];
  /**
   * Legacy drop-in directory left in place because it holds files that could not be migrated
   * verbatim (a differing file already exists for the new unit, or an entry is not a `.conf` file).
   */
  retainedDropInDirectory: string | null;
}

interface InstallState {
  previous: string | null;
  changed: boolean;
  currentWasActive: boolean;
  legacyWasActive: boolean;
  copiedDropIns: string[];
  createdDropInDirectory: string | null;
  retainedDropInDirectory: string | null;
}

export interface ServiceClock {
  now(): number;
  sleep(milliseconds: number): void;
}

/** Bounds of the post-start health check in `install`. */
export interface ServiceHealthPolicy {
  /** Give up and roll back after this long. */
  timeoutMs: number;
  /** The same main process must keep running, without restarts, for this long. */
  stableMs: number;
  intervalMs: number;
}

export const DEFAULT_SERVICE_HEALTH: ServiceHealthPolicy = { timeoutMs: 30_000, stableMs: 5_000, intervalMs: 500 };

export interface ServiceManagerOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  uid?: number;
  environment?: NodeJS.ProcessEnv;
  runner?: ServiceCommandRunner;
  clock?: ServiceClock;
  health?: Partial<ServiceHealthPolicy>;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const defaultClock: ServiceClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => { Atomics.wait(sleepCell, 0, 0, milliseconds); },
};

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
  private readonly clock: ServiceClock;
  private readonly health: ServiceHealthPolicy;
  private readonly uid: number;

  constructor(options: ServiceManagerOptions = {}) {
    const platform = options.platform ?? process.platform;
    const home = resolve(options.homeDirectory ?? homedir());
    const environment = options.environment ?? process.env;
    this.runner = options.runner ?? defaultRunner;
    this.clock = options.clock ?? defaultClock;
    this.health = { ...DEFAULT_SERVICE_HEALTH, ...options.health };
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

  /** Read-only preview input. Refuse definitions whose effective settings cannot be preserved. */
  readInstallStartArguments(): string[] | null {
    const path = this.installDefinitionPath();
    if (path === null) {
      if (this.kind === "systemd" && readResourceDropIns(`${this.definitionPath}.d`).size) unsafeInstalledDefinition();
      return null;
    }
    const arguments_ = this.readStartArguments();
    if (arguments_ === null) unsafeInstalledDefinition();
    validateInstalledPaths(arguments_);
    const definition = readFileSync(path, "utf8");
    if (this.kind === "systemd") {
      validateInstalledSystemdDefinition(definition);
      this.installDropIns(path);
    } else validateInstalledLaunchAgent(definition, arguments_);
    return arguments_;
  }

  /** Actual-install preflight only: preview must never contact the service manager. */
  assertInstalledServiceConfiguration(): void {
    const path = this.installDefinitionPath();
    if (path === null || this.kind !== "systemd") return;
    const expectedDropIns = this.installDropIns(path);
    const unit = path === this.definitionPath ? SYSTEMD_UNIT_NAME : LEGACY_SYSTEMD_UNIT_NAME;
    const result = this.runner.run("systemctl", ["--user", "show", unit, "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]);
    const entries = result.stdout.trim().split(/\r?\n/).map(line => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
    const properties: Record<string, string> = Object.fromEntries(entries);
    const dropIns = properties.DropInPaths?.trim().split(/\s+/).filter(Boolean);
    if (result.status !== 0 || entries.length !== 3 || new Set(entries.map(([key]) => key)).size !== 3
      || properties.FragmentPath !== path || properties.NeedDaemonReload !== "no" || dropIns === undefined
      || dropIns.length !== expectedDropIns.size || dropIns.some(value => !expectedDropIns.has(value))) {
      throw new Error("Installed service manager configuration differs from the inspected local definition or needs daemon-reload. Inspect and reconcile its fragment and drop-ins before installing; no service was changed.");
    }
  }

  private installDefinitionPath(): string | null {
    const present = (path: string) => {
      try { lstatSync(path); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    };
    const current = present(this.definitionPath), legacy = present(this.legacyDefinitionPath);
    if (current && legacy) throw new Error("Both current and legacy service definitions exist. Inspect and reconcile them before installing; no service was changed.");
    const path = current ? this.definitionPath : legacy ? this.legacyDefinitionPath : null;
    if (path !== null && (!lstatSync(path).isFile() || lstatSync(path).size > 256 * 1024)) unsafeInstalledDefinition();
    return path;
  }

  private installDropIns(path: string): Map<string, string> {
    const selected = readResourceDropIns(`${path}.d`);
    if (path === this.legacyDefinitionPath) {
      const target = readResourceDropIns(`${this.definitionPath}.d`);
      for (const [destination, contents] of target) {
        const source = `${this.legacyDefinitionPath}.d${destination.slice(`${this.definitionPath}.d`.length)}`;
        if (selected.get(source) !== contents) unsafeInstalledDefinition();
      }
    }
    return selected;
  }

  /**
   * Installs the service and enables it only after a verified healthy start. A legacy
   * `worktree-switcher` service is stopped just before the new one starts, because both would claim
   * the same ports and controller lock, and is disabled and removed only after the health check
   * passes. systemd drop-ins of the legacy unit are copied to the new unit first, so limits keep
   * applying. If the start or health check fails, the new service is stopped, its previous
   * definition and enabled state are restored (or the new definition, copied drop-ins and enabled
   * state removed), a legacy service that was running is started again, and the error is rethrown.
   */
  install(options: ServiceInstallOptions): { changed: boolean; definitionPath: string; legacy: LegacyServiceRemoval | null } {
    const definition = this.kind === "systemd" ? renderSystemdUnit(options) : renderLaunchAgent(options);
    const previous = existsSync(this.definitionPath) ? readFileSync(this.definitionPath, "utf8") : null;
    if (previous !== null && previous !== definition && !options.refresh) {
      throw new Error(`The service definition is outdated. Review the installed path and run service install --refresh: ${this.definitionPath}`);
    }
    const changed = previous !== definition;
    const legacyInstalled = existsSync(this.legacyDefinitionPath);
    const state: InstallState = {
      previous, changed, currentWasActive: false, legacyWasActive: false,
      copiedDropIns: [], createdDropInDirectory: null, retainedDropInDirectory: null,
    };

    if (this.kind === "systemd") {
      if (previous !== null) state.currentWasActive = this.systemdActive(SYSTEMD_UNIT_NAME);
      if (changed) writeDefinition(this.definitionPath, definition);
      this.withRollback(state, () => {
        if (legacyInstalled) this.migrateDropIns(state);
        this.requireSuccess("systemctl", ["--user", "daemon-reload"]);
        if (legacyInstalled) {
          state.legacyWasActive = this.systemdActive(LEGACY_SYSTEMD_UNIT_NAME);
          this.requireSuccess("systemctl", ["--user", "stop", LEGACY_SYSTEMD_UNIT_NAME]);
        }
        if (options.refresh && previous !== null) this.requireSuccess("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
        else this.requireSuccess("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
        this.waitUntilHealthy();
        this.requireSuccess("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME]);
      });
      if (legacyInstalled) {
        this.requireSuccess("systemctl", ["--user", "disable", LEGACY_SYSTEMD_UNIT_NAME]);
        rmSync(this.legacyDefinitionPath, { force: true });
        if (state.retainedDropInDirectory === null) rmSync(`${this.legacyDefinitionPath}.d`, { recursive: true, force: true });
        this.requireSuccess("systemctl", ["--user", "daemon-reload"]);
      }
    } else {
      const target = this.launchdTarget();
      const serviceTarget = `${target}/${LAUNCHD_LABEL}`;
      const legacyTarget = `${target}/${LEGACY_LAUNCHD_LABEL}`;
      state.currentWasActive = this.runner.run("launchctl", ["print", serviceTarget]).status === 0;
      if (changed) writeDefinition(this.definitionPath, definition);
      this.withRollback(state, () => {
        if (legacyInstalled) {
          state.legacyWasActive = this.runner.run("launchctl", ["print", legacyTarget]).status === 0;
          if (state.legacyWasActive) this.requireSuccess("launchctl", ["bootout", legacyTarget]);
        }
        const loaded = state.currentWasActive;
        if (loaded && changed) this.requireSuccess("launchctl", ["bootout", serviceTarget]);
        if (!loaded || changed) this.requireSuccess("launchctl", ["bootstrap", target, this.definitionPath]);
        // A disabled override would block kickstart, so clear it before the health check.
        this.requireSuccess("launchctl", ["enable", serviceTarget]);
        if (!loaded || changed) this.requireSuccess("launchctl", ["kickstart", "-k", serviceTarget]);
        this.waitUntilHealthy();
      });
      // bootout unloads the agent; removing its plist keeps it from loading at the next login.
      if (legacyInstalled) rmSync(this.legacyDefinitionPath, { force: true });
    }
    return {
      changed,
      definitionPath: this.definitionPath,
      legacy: legacyInstalled
        ? {
          definitionPath: this.legacyDefinitionPath,
          wasActive: state.legacyWasActive,
          migratedDropIns: state.copiedDropIns,
          retainedDropInDirectory: state.retainedDropInDirectory,
        }
        : null,
    };
  }

  /**
   * Copies `worktree-switcher.service.d/*.conf` into the new unit's drop-in directory before the
   * daemon reload, so `MemoryMax`, sandbox settings and similar overrides keep applying. A file that
   * already exists for the new unit with the same contents counts as migrated; a differing one is
   * never overwritten. The legacy directory is retained whenever any entry could not be migrated.
   */
  private migrateDropIns(state: InstallState): void {
    const source = `${this.legacyDefinitionPath}.d`;
    if (!existsSync(source) || !statSync(source).isDirectory()) return;
    const target = `${this.definitionPath}.d`;
    const entries = readdirSync(source, { withFileTypes: true });
    let retained = false;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const from = join(source, entry.name);
      const to = join(target, entry.name);
      if (!entry.isFile() || !entry.name.endsWith(".conf")) {
        retained = true;
        continue;
      }
      const contents = readFileSync(from);
      if (existsSync(to)) {
        if (!readFileSync(to).equals(contents)) retained = true;
        continue;
      }
      if (!existsSync(target)) {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        state.createdDropInDirectory = target;
      }
      writeFileSync(to, contents, { mode: statSync(from).mode & 0o777 });
      state.copiedDropIns.push(to);
    }
    if (retained) state.retainedDropInDirectory = source;
  }

  /** Runs the start sequence; on failure restores the previous service state before rethrowing. */
  private withRollback(state: InstallState, start: () => void): void {
    try {
      start();
    } catch (error) {
      // Best-effort restoration: report the original failure, not a secondary cleanup error.
      if (this.kind === "systemd") {
        this.runner.run("systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]);
        if (state.previous === null) {
          this.runner.run("systemctl", ["--user", "disable", SYSTEMD_UNIT_NAME]);
          rmSync(this.definitionPath, { force: true });
        } else if (state.changed) {
          writeDefinition(this.definitionPath, state.previous);
        }
        for (const path of state.copiedDropIns) rmSync(path, { force: true });
        if (state.createdDropInDirectory) {
          try {
            rmdirSync(state.createdDropInDirectory);
          } catch {
            // Not empty or already gone: leave it for the operator.
          }
        }
        this.runner.run("systemctl", ["--user", "daemon-reload"]);
        if (state.previous !== null && state.currentWasActive) this.runner.run("systemctl", ["--user", "start", SYSTEMD_UNIT_NAME]);
        if (state.legacyWasActive) this.runner.run("systemctl", ["--user", "start", LEGACY_SYSTEMD_UNIT_NAME]);
      } else {
        const target = this.launchdTarget();
        const serviceTarget = `${target}/${LAUNCHD_LABEL}`;
        this.runner.run("launchctl", ["bootout", serviceTarget]);
        if (state.previous === null) {
          this.runner.run("launchctl", ["disable", serviceTarget]);
          rmSync(this.definitionPath, { force: true });
        } else {
          if (state.changed) writeDefinition(this.definitionPath, state.previous);
          if (state.currentWasActive) {
            this.runner.run("launchctl", ["bootstrap", target, this.definitionPath]);
            this.runner.run("launchctl", ["kickstart", serviceTarget]);
          }
        }
        if (state.legacyWasActive) {
          this.runner.run("launchctl", ["bootstrap", target, this.legacyDefinitionPath]);
          this.runner.run("launchctl", ["kickstart", `${target}/${LEGACY_LAUNCHD_LABEL}`]);
        }
      }
      throw error;
    }
  }

  /**
   * Waits until the started service keeps one main process running, without automatic restarts,
   * for `healthStableMs`. A crash, restart or timeout throws so the caller rolls back.
   */
  private waitUntilHealthy(): void {
    const deadline = this.clock.now() + this.health.timeoutMs;
    let baseline: { pid: number; restarts: number; since: number } | null = null;
    for (;;) {
      const sample = this.healthSample();
      const now = this.clock.now();
      // A Type=simple unit is active/running as soon as start returns, so any other first state
      // means the controller already exited; launchd may report a spawn state first.
      if (sample.failed || (!sample.running && this.kind === "systemd")) {
        throw new Error(`The new service failed to start (${sample.state}). Check its logs before retrying.`);
      }
      if (sample.running && sample.pid !== null) {
        if (baseline && (baseline.pid !== sample.pid || (sample.restarts !== null && sample.restarts !== baseline.restarts))) {
          throw new Error(`The new service restarted while starting (${sample.state}). Check its logs before retrying.`);
        }
        baseline ??= { pid: sample.pid, restarts: sample.restarts ?? 0, since: now };
        if (now - baseline.since >= this.health.stableMs) return;
      } else if (baseline) {
        throw new Error(`The new service stopped while starting (${sample.state}). Check its logs before retrying.`);
      }
      if (now >= deadline) throw new Error(`The new service did not become healthy within ${Math.round(this.health.timeoutMs / 1000)} seconds (${sample.state}).`);
      this.clock.sleep(this.health.intervalMs);
    }
  }

  private healthSample(): { running: boolean; failed: boolean; pid: number | null; restarts: number | null; state: string } {
    if (this.kind === "systemd") {
      const result = this.runner.run("systemctl", ["--user", "show", SYSTEMD_UNIT_NAME, "--property=ActiveState", "--property=SubState", "--property=MainPID", "--property=NRestarts"]);
      const values = Object.fromEntries(result.stdout.split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key]) => key));
      const state = [values.ActiveState, values.SubState].filter(Boolean).join("/") || "unknown";
      return {
        running: result.status === 0 && values.ActiveState === "active" && values.SubState === "running",
        failed: values.ActiveState === "failed",
        pid: positiveInteger(values.MainPID),
        restarts: nonNegativeInteger(values.NRestarts),
        state,
      };
    }
    const result = this.runner.run("launchctl", ["print", `${this.launchdTarget()}/${LAUNCHD_LABEL}`]);
    const state = result.stdout.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() ?? (result.status === 0 ? "loaded" : "not loaded");
    return {
      running: result.status === 0 && state === "running",
      failed: result.status !== 0,
      pid: positiveInteger(result.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1]),
      restarts: nonNegativeInteger(result.stdout.match(/\bruns\s*=\s*(\d+)/)?.[1]),
      state,
    };
  }

  private systemdActive(unit: string): boolean {
    return this.runner.run("systemctl", ["--user", "is-active", "--quiet", unit]).status === 0;
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

function unsafeInstalledDefinition(): never {
  throw new Error("Installed service configuration cannot be safely inherited. Inspect and reconcile the definition and drop-ins into generated absolute startup arguments and resource-only drop-ins before installing; no service was changed.");
}

const installedPathFlags = new Set([
  "--browse-root", "--data-dir", "--state-dir", "--web-root", "--backup-dir",
  "--backup-remote-restic", "--backup-remote-password-file", "--backup-remote-credentials-file", "--backup-remote-ca-file",
]);
function validateInstalledPaths(args: string[]): void {
  for (const flag of ["--service-mode", "--no-open", "--host", "--port", "--mcp-port", "--browse-root", "--data-dir", "--state-dir", "--web-root"]) {
    if (args.filter(value => value === flag).length !== 1) unsafeInstalledDefinition();
  }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!installedPathFlags.has(flag) && flag !== "--user-backup-target") continue;
    const value = args[++index];
    const path = flag === "--user-backup-target" ? value?.slice(value.indexOf("=") + 1) : value;
    if (!path || !isAbsolute(path) || /[\0\r\n]/.test(path)) unsafeInstalledDefinition();
  }
}

/** The generated unit grammar is deliberately small; custom policy belongs in preserved drop-ins. */
function systemdEntries(definition: string): Array<{ section: string; key: string; value: string }> {
  let section = "";
  const entries: Array<{ section: string; key: string; value: string }> = [];
  for (const source of definition.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (/^\[[A-Za-z]+\]$/.test(line)) { section = line.slice(1, -1); continue; }
    const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!section || !match || /[\0\r\n]/.test(line) || line.endsWith("\\")) unsafeInstalledDefinition();
    entries.push({ section, key: match[1], value: match[2] });
  }
  return entries;
}

function validateInstalledSystemdDefinition(definition: string): void {
  const fixed: Record<string, string> = {
    "Unit.After": "network.target", "Unit.StartLimitIntervalSec": "60", "Unit.StartLimitBurst": "5",
    "Service.Type": "simple", "Service.Restart": "on-failure", "Service.RestartSec": "5",
    "Service.KillMode": "control-group", "Service.TimeoutStopSec": "15", "Service.UMask": "0077",
    "Install.WantedBy": "default.target",
  };
  const seen = new Set<string>();
  for (const { section, key, value } of systemdEntries(definition)) {
    const name = `${section}.${key}`;
    if (name !== "Service.Environment" && seen.has(name)) unsafeInstalledDefinition();
    seen.add(name);
    // Dollar substitutions and unit-name specifiers can change meaning during migration.
    if (value.includes("$") || value.replaceAll("%%", "").includes("%")) unsafeInstalledDefinition();
    if (name === "Unit.Description") continue;
    if (name === "Service.ExecStart") continue; // Strict argv parsing is performed by readStartArguments.
    if (name === "Service.WorkingDirectory") {
      if (!isAbsolute(value)) unsafeInstalledDefinition();
      continue;
    }
    if (name === "Service.Environment") {
      const quoted = value.startsWith('"') && value.endsWith('"');
      if (!quoted && /\s/.test(value)) unsafeInstalledDefinition();
      const assignment = quoted ? value.slice(1, -1) : value;
      const variable = assignment.split("=", 1)[0];
      if (seen.has(`Environment.${variable}`)) unsafeInstalledDefinition();
      seen.add(`Environment.${variable}`);
      if (assignment === "NODE_ENV=production") continue;
      if (assignment.startsWith("PATH=") && assignment.slice(5).split(":").every(path => isAbsolute(path) && !/["\\]/.test(path))) continue;
      unsafeInstalledDefinition();
    }
    if (!(name in fixed) || value !== fixed[name]) unsafeInstalledDefinition();
  }
  if (!["Service.ExecStart", "Service.WorkingDirectory", "Environment.NODE_ENV", "Environment.PATH"].every(name => seen.has(name))) unsafeInstalledDefinition();
}

const resourceDropInKeys = new Set([
  "MemoryAccounting", "MemoryMin", "MemoryLow", "MemoryHigh", "MemoryMax", "MemorySwapMax", "MemoryZSwapMax",
  "CPUAccounting", "CPUWeight", "StartupCPUWeight", "CPUQuota", "CPUQuotaPeriodSec", "AllowedCPUs", "StartupAllowedCPUs",
  "AllowedMemoryNodes", "StartupAllowedMemoryNodes", "TasksAccounting", "TasksMax", "IOAccounting", "IOWeight",
  "StartupIOWeight", "IOReadBandwidthMax", "IOWriteBandwidthMax", "IOReadIOPSMax", "IOWriteIOPSMax", "Nice",
  "OOMScoreAdjust", "OOMPolicy", "ManagedOOMSwap", "ManagedOOMMemoryPressure", "ManagedOOMMemoryPressureLimit",
  "LimitAS", "LimitCORE", "LimitCPU", "LimitDATA", "LimitFSIZE", "LimitLOCKS", "LimitMEMLOCK", "LimitMSGQUEUE",
  "LimitNICE", "LimitNOFILE", "LimitNPROC", "LimitRSS", "LimitRTPRIO", "LimitRTTIME", "LimitSIGPENDING", "LimitSTACK",
]);
function readResourceDropIns(directory: string): Map<string, string> {
  let stat;
  try { stat = lstatSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
  if (!stat.isDirectory()) unsafeInstalledDefinition();
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > 128) unsafeInstalledDefinition();
  const result = new Map<string, string>();
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith(".conf")) continue;
    const path = join(directory, entry.name);
    if (!entry.isFile() || (bytes += lstatSync(path).size) > 1024 * 1024) unsafeInstalledDefinition();
    const contents = readFileSync(path, "utf8");
    for (const { section, key, value } of systemdEntries(contents)) {
      if (section !== "Service" || !resourceDropInKeys.has(key) || value.includes("$")
        || (value.includes("%") && !/^[0-9]+(?:\.[0-9]+)?%$/.test(value))) unsafeInstalledDefinition();
    }
    result.set(path, contents);
  }
  return result;
}

function validateInstalledLaunchAgent(definition: string, args: string[]): void {
  const body = definition
    .replace(/^\s*<\?xml[^?]*\?>\s*/, "")
    .replace(/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/, "")
    .match(/^<plist version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>\s*$/)?.[1];
  if (body === undefined) unsafeInstalledDefinition();
  const fields = /<key>([^<]*)<\/key>\s*(<string>[^<]*<\/string>|<array>[\s\S]*?<\/array>|<dict>[\s\S]*?<\/dict>|<(?:true|false)\s*\/>|<integer>[0-9]+<\/integer>)/g;
  if (body.replace(fields, "").trim()) unsafeInstalledDefinition();
  const seen = new Set<string>();
  const stateDirectory = args[args.indexOf("--state-dir") + 1];
  const fixed: Record<string, string> = {
    RunAtLoad: "<true/>", KeepAlive: "<dict><key>SuccessfulExit</key><false/></dict>",
    ThrottleInterval: "<integer>5</integer>", ProcessType: "<string>Background</string>", AbandonProcessGroup: "<false/>",
    StandardOutPath: `<string>${xmlEscape(join(stateDirectory, "logs", "service.stdout.log"))}</string>`,
    StandardErrorPath: `<string>${xmlEscape(join(stateDirectory, "logs", "service.stderr.log"))}</string>`,
  };
  for (const [, key, value] of body.matchAll(fields)) {
    if (seen.has(key)) unsafeInstalledDefinition();
    seen.add(key);
    if (key === "ProgramArguments") continue;
    if (key === "Label" && [LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL].some(label => value === `<string>${label}</string>`)) continue;
    if (key === "WorkingDirectory" && /^<string>\/[^<]*<\/string>$/.test(value)) continue;
    if (key === "EnvironmentVariables") {
      const environment = value.slice("<dict>".length, -"</dict>".length);
      const pairs = [...environment.matchAll(/<key>(NODE_ENV|PATH)<\/key>\s*<string>([^<]*)<\/string>/g)];
      if (pairs.length !== 2 || new Set(pairs.map(pair => pair[1])).size !== 2
        || environment.replace(/<key>(NODE_ENV|PATH)<\/key>\s*<string>([^<]*)<\/string>/g, "").trim()
        || pairs.some(([, name, contents]) => name === "NODE_ENV" ? contents !== "production" : !contents.split(":").every(path => isAbsolute(path)))) unsafeInstalledDefinition();
      continue;
    }
    if (!(key in fixed) || value.replace(/>\s+</g, "><") !== fixed[key]) unsafeInstalledDefinition();
  }
  if (!["Label", "ProgramArguments", "WorkingDirectory", "EnvironmentVariables"].every(key => seen.has(key))) unsafeInstalledDefinition();
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
  if (/[\0\r\n$]/.test(value)) throw new Error("Systemd service arguments cannot contain NUL, newline or dollar characters.");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdDirectivePath(value: string): string {
  if (!value.startsWith("/") || /[\0\r\n$]/.test(value)) throw new Error("The service working directory must be an absolute path without control or dollar characters.");
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

/** Status warning for a pre-rename service definition that is still installed. */
export function legacyServiceWarning(definitionPath: string): string {
  return `Warning: the legacy worktree-switcher service is still installed at ${definitionPath}. Run worktree-control service install to migrate it, or service uninstall to remove it.`;
}
