import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { legacyServiceWarning, renderLaunchAgent, renderSystemdUnit, resolveServiceExecutablePath, type ServiceClock, type ServiceCommandRunner, type ServiceHealthPolicy, UserServiceManager } from "./service-manager";

const directories: string[] = [];
const installOptions = {
  nodePath: "/opt/node/bin/node",
  entrypointPath: "/opt/worktree control/dist/cli/index.js",
  workingDirectory: "/opt/worktree control",
  startArguments: ["--service-mode", "--no-open", "--data-dir", "/home/me/data%dir"],
  stateDirectory: "/home/me/state",
  refresh: false,
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("user service definitions", () => {
  it("renders a bounded user systemd service without secrets", () => {
    const unit = renderSystemdUnit({
      ...installOptions,
      startArguments: [...installOptions.startArguments, "--public-url", "https://switcher.example.test"],
    });
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/worktree control/dist/cli/index.js" "start"');
    expect(unit).toContain("WorkingDirectory=/opt/worktree control");
    expect(unit).toContain('"/home/me/data%%dir"');
    expect(unit).toContain("Restart=on-failure\nRestartSec=5");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain('"--public-url" "https://switcher.example.test"');
    expect(unit).toContain(`Environment="PATH=${resolveServiceExecutablePath(installOptions.nodePath)}"`);
    expect(unit).not.toContain("token=");
  });

  it("renders a LaunchAgent with XML-safe argument arrays and private log paths", () => {
    const plist = renderLaunchAgent({ ...installOptions, startArguments: ["--browse-root", "/Users/me/a&b"] });
    expect(plist).toContain("<string>/Users/me/a&amp;b</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain("<key>AbandonProcessGroup</key>\n  <false/>");
    expect(plist).toContain("/home/me/state/logs/service.stderr.log");
    expect(plist).toContain(`<key>PATH</key><string>${resolveServiceExecutablePath(installOptions.nodePath)}</string>`);
    expect(plist).not.toContain("token=");
  });

  it("adds user-installed package managers without inheriting unrelated PATH entries", () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-control-path-"));
    directories.push(root);
    const packageBin = join(root, "package-bin");
    const unrelatedBin = join(root, "temporary-agent-bin");
    mkdirSync(packageBin);
    mkdirSync(unrelatedBin);
    writeFileSync(join(packageBin, "pnpm"), "#!/bin/sh\n", { mode: 0o700 });

    const servicePath = resolveServiceExecutablePath("/opt/node/bin/node", `${unrelatedBin}:${packageBin}:/usr/bin`);

    expect(servicePath.split(":")).toContain(packageBin);
    expect(servicePath.split(":")).not.toContain(unrelatedBin);
  });

  it("refuses dollar substitutions in newly rendered systemd arguments", () => {
    expect(() => renderSystemdUnit({ ...installOptions, startArguments: ["--data-dir", "/private/${DATA}"] })).toThrow("dollar");
  });
});

/** Deterministic clock: `sleep` advances time instead of blocking. */
function fakeClock(): ServiceClock & { readonly elapsed: number } {
  let now = 1_000_000;
  return {
    get elapsed() { return now - 1_000_000; },
    now: () => now,
    sleep: (milliseconds) => { now += milliseconds; },
  };
}

const running = "ActiveState=active\nSubState=running\nMainPID=42\nNRestarts=0\n";

interface LinuxOptions {
  legacy?: boolean;
  current?: boolean;
  fail?: (args: string[]) => boolean;
  /** Output of `systemctl show` for each poll, last entry repeated. */
  show?: string[];
  health?: Partial<ServiceHealthPolicy>;
  destinationExternalDropIn?: boolean;
}

function linuxHome(options: LinuxOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "worktree-control-service-"));
  directories.push(home);
  const calls: string[][] = [];
  let polls = 0;
  const runner: ServiceCommandRunner = {
    run(command, args) {
      calls.push([command, ...args]);
      if (options.fail?.(args)) return { status: 1, stdout: "", stderr: "failed" };
      if (args[1] === "show") {
        if (args.includes("--property=FragmentPath")) {
          const path = join(home, ".config", "systemd", "user", args[2]);
          const dropIns = existsSync(`${path}.d`) ? readdirSync(`${path}.d`).filter(name => name.endsWith(".conf")).map(name => join(`${path}.d`, name)) : [];
          if (options.destinationExternalDropIn && args[2] === "worktree-control.service") dropIns.push("/etc/systemd/user/worktree-control.service.d/override.conf");
          return { status: 0, stdout: `FragmentPath=${path}\nDropInPaths=${dropIns.join(" ")}\nNeedDaemonReload=no\n`, stderr: "" };
        }
        const outputs = options.show ?? [running];
        return { status: 0, stdout: outputs[Math.min(polls++, outputs.length - 1)], stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const clock = fakeClock();
  const manager = new UserServiceManager({
    platform: "linux", homeDirectory: home, environment: { NODE_ENV: "test" }, runner, clock,
    health: { stableMs: 0, ...options.health },
  });
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  if (options.legacy) writeFileSync(manager.legacyDefinitionPath, legacyUnit);
  if (options.current) writeFileSync(manager.definitionPath, "unit");
  return { home, calls, manager, clock };
}

const legacyUnit = 'ExecStart="/old/node" "/old/dist/cli/index.js" "start" "--data-dir" "/home/me/.local/share/worktree-switcher" "--backup-dir" "/backups"\n';

describe("safe installed configuration inheritance", () => {
  const arguments_ = [
    "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", "47831", "--mcp-port", "47832",
    "--browse-root", "/repos", "--data-dir", "/private/data", "--state-dir", "/private/state", "--web-root", "/old/out",
  ];
  const complete = { ...installOptions, startArguments: arguments_, stateDirectory: "/private/state" };

  it.each(["linux", "darwin"] as const)("reads complete generated definitions without manager calls on %s", platform => {
    const home = mkdtempSync(join(tmpdir(), "service-inheritance-")); directories.push(home);
    const calls: string[][] = [];
    const manager = new UserServiceManager({ platform, homeDirectory: home, environment: { NODE_ENV: "test" }, uid: 123,
      runner: { run: (command, args) => { calls.push([command, ...args]); throw new Error("Unexpected manager call"); } } });
    mkdirSync(join(manager.legacyDefinitionPath, ".."), { recursive: true });
    const definition = platform === "linux" ? renderSystemdUnit(complete) : renderLaunchAgent(complete);
    writeFileSync(manager.legacyDefinitionPath, definition);
    expect(manager.readInstallStartArguments()).toEqual(arguments_);
    expect(calls).toEqual([]);
    expect(readFileSync(manager.legacyDefinitionPath, "utf8")).toBe(definition);
  });

  it.each([
    ["missing serialized directories", (definition: string) => definition.replace(' "--data-dir" "/private/data"', "")],
    ["relative paths", (definition: string) => definition.replace('"/private/data"', '"relative-data"')],
    ["environment expansion", (definition: string) => definition.replace('"/private/data"', '"/private/${DATA}"')],
    ["custom environment", (definition: string) => `${definition}\n[Service]\nEnvironment=WORKTREE_CONTROL_DATA_DIR=/another\n`],
    ["extra unquoted PATH assignments", (definition: string) => definition.replace(/Environment="PATH=[^\n]*"/, "Environment=PATH=/bin NODE_OPTIONS=--require=/custom.js")],
    ["environment files", (definition: string) => `${definition}\n[Service]\nEnvironmentFile=/private/environment\n`],
    ["main-unit resource policy", (definition: string) => `${definition}\n[Service]\nMemoryMax=512M\n`],
    ["changed shutdown policy", (definition: string) => definition.replace("KillMode=control-group", "KillMode=process")],
  ] as const)("refuses %s without writing or contacting systemd", (_, change) => {
    const { manager, calls } = linuxHome();
    const definition = change(renderSystemdUnit(complete));
    writeFileSync(manager.legacyDefinitionPath, definition);
    expect(() => manager.readInstallStartArguments()).toThrow("Inspect and reconcile");
    expect(calls).toEqual([]);
    expect(readFileSync(manager.legacyDefinitionPath, "utf8")).toBe(definition);
    expect(existsSync(manager.definitionPath)).toBe(false);
  });

  it.each(["--backup-dir", "--backup-remote-restic", "--backup-remote-password-file", "--backup-remote-credentials-file", "--backup-remote-ca-file", "--user-backup-target"])("refuses relative inherited %s", flag => {
    const { manager } = linuxHome();
    writeFileSync(manager.legacyDefinitionPath, renderSystemdUnit({ ...complete, startArguments: [...arguments_, flag, flag === "--user-backup-target" ? "local=relative" : "relative"] }));
    expect(() => manager.readInstallStartArguments()).toThrow("Inspect and reconcile");
  });

  it("accepts identical resource drop-ins but refuses target-only or conflicting migration policy", () => {
    const { manager, calls } = linuxHome();
    writeFileSync(manager.legacyDefinitionPath, renderSystemdUnit(complete));
    mkdirSync(`${manager.legacyDefinitionPath}.d`); mkdirSync(`${manager.definitionPath}.d`);
    const source = join(`${manager.legacyDefinitionPath}.d`, "limits.conf");
    const target = join(`${manager.definitionPath}.d`, "limits.conf");
    writeFileSync(source, "[Service]\nMemoryMax=512M\nMemoryHigh=80%\nMemorySwapMax=0\nCPUQuota=50%\nTasksMax=64\n");
    writeFileSync(target, readFileSync(source));
    expect(manager.readInstallStartArguments()).toEqual(arguments_);
    writeFileSync(target, "[Service]\nMemoryMax=1G\n");
    expect(() => manager.readInstallStartArguments()).toThrow("Inspect and reconcile");
    writeFileSync(target, readFileSync(source));
    writeFileSync(join(`${manager.definitionPath}.d`, "extra.conf"), "[Service]\nMemoryMax=1G\n");
    expect(() => manager.readInstallStartArguments()).toThrow("Inspect and reconcile");
    expect(calls).toEqual([]);
  });

  it.each(["ExecStart=", "Environment=WORKTREE_CONTROL_STATE_DIR=/private/other", "WorkingDirectory=/other", "MemoryMax=%n"])("refuses effective startup overrides in local drop-ins: %s", directive => {
    const { manager, calls } = linuxHome();
    writeFileSync(manager.legacyDefinitionPath, renderSystemdUnit(complete));
    mkdirSync(`${manager.legacyDefinitionPath}.d`);
    writeFileSync(join(`${manager.legacyDefinitionPath}.d`, "override.conf"), `[Service]\n${directive}\n`);
    expect(() => manager.readInstallStartArguments()).toThrow("Inspect and reconcile");
    expect(calls).toEqual([]);
  });

  it.each([
    ["custom environment", (definition: string) => definition.replace("<key>NODE_ENV</key>", "<key>WORKTREE_CONTROL_DATA_DIR</key>")],
    ["custom policy", (definition: string) => definition.replace("<key>RunAtLoad</key>", "<key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>64</integer></dict><key>RunAtLoad</key>")],
    ["relative paths", (definition: string) => definition.replace("<string>/private/data</string>", "<string>relative</string>")],
    ["custom log destination", (definition: string) => definition.replace("/private/state/logs/service.stdout.log", "/private/custom.log")],
  ] as const)("refuses launchd %s", (_, change) => {
    const home = mkdtempSync(join(tmpdir(), "launchd-inheritance-")); directories.push(home);
    const manager = new UserServiceManager({ platform: "darwin", homeDirectory: home, uid: 123 });
    mkdirSync(join(manager.legacyDefinitionPath, ".."), { recursive: true });
    writeFileSync(manager.legacyDefinitionPath, change(renderLaunchAgent(complete)));
    expect(() => manager.readInstallStartArguments()).toThrow("Inspect and reconcile");
  });

  it.each(["matching", "external-drop-in", "stale", "different-fragment", "missing-local-drop-in"])("checks effective systemd configuration before install: %s", scenario => {
    const home = mkdtempSync(join(tmpdir(), "service-preflight-")); directories.push(home);
    const calls: string[][] = [];
    const manager: UserServiceManager = new UserServiceManager({ platform: "linux", homeDirectory: home, environment: { NODE_ENV: "test" }, runner: {
      run(command, args) {
        calls.push([command, ...args]);
        return { status: 0, stderr: "", stdout: `FragmentPath=${scenario === "different-fragment" ? "/etc/systemd/user/worktree-switcher.service" : manager.legacyDefinitionPath}\nDropInPaths=${scenario === "external-drop-in" ? "/run/user/123/systemd/user/service.d/limits.conf" : scenario === "missing-local-drop-in" ? "" : join(`${manager.legacyDefinitionPath}.d`, "limits.conf")}\nNeedDaemonReload=${scenario === "stale" ? "yes" : "no"}\n` };
      },
    } });
    mkdirSync(`${manager.legacyDefinitionPath}.d`, { recursive: true });
    writeFileSync(manager.legacyDefinitionPath, renderSystemdUnit(complete));
    writeFileSync(join(`${manager.legacyDefinitionPath}.d`, "limits.conf"), "[Service]\nMemoryMax=512M\n");
    expect(manager.readInstallStartArguments()).toEqual(arguments_);
    expect(calls).toEqual([]);
    if (scenario === "matching") expect(() => manager.assertInstalledServiceConfiguration()).not.toThrow();
    else expect(() => manager.assertInstalledServiceConfiguration()).toThrow("Inspect and reconcile");
    expect(calls).toEqual([["systemctl", "--user", "show", "worktree-switcher.service", "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]]);
    expect(existsSync(manager.definitionPath)).toBe(false);
  });

  it("skips manager preflight for a fresh install", () => {
    const { manager, calls } = linuxHome();
    expect(manager.readInstallStartArguments()).toBeNull();
    manager.assertInstalledServiceConfiguration();
    expect(calls).toEqual([]);
  });
});

describe("UserServiceManager", () => {
  it("installs idempotently and requires refresh when the executable changes", () => {
    const { calls, manager } = linuxHome();

    expect(manager.install(installOptions).changed).toBe(true);
    expect(manager.install(installOptions).changed).toBe(false);
    expect(() => manager.install({ ...installOptions, nodePath: "/new/node" })).toThrow("--refresh");
    expect(manager.install({ ...installOptions, nodePath: "/new/node", refresh: true }).changed).toBe(true);
    expect(readFileSync(manager.definitionPath, "utf8")).toContain('ExecStart="/new/node"');
    expect(calls).toContainEqual(["systemctl", "--user", "restart", "worktree-control.service"]);
  });

  it("enables the unit only after the started service stays healthy", () => {
    const { calls, manager, clock } = linuxHome({ health: { stableMs: 5_000, intervalMs: 500, timeoutMs: 30_000 } });

    manager.install(installOptions);

    const names = calls.filter(call => !call.includes("--property=FragmentPath")).map((call) => call[2]);
    expect(names.indexOf("start")).toBeLessThan(names.indexOf("show"));
    expect(names.lastIndexOf("show")).toBeLessThan(names.indexOf("enable"));
    expect(calls.filter((call) => call[2] === "show" && call.includes("--property=ActiveState"))).toHaveLength(11);
    expect(clock.elapsed).toBe(5_000);
  });

  it("rolls back a first install whose service exits right after start", () => {
    const { calls, manager } = linuxHome({ show: ["ActiveState=activating\nSubState=auto-restart\nMainPID=0\nNRestarts=1\n"] });

    expect(() => manager.install(installOptions)).toThrow("failed to start (activating/auto-restart)");

    expect(existsSync(manager.definitionPath)).toBe(false);
    expect(calls).not.toContainEqual(["systemctl", "--user", "enable", "worktree-control.service"]);
    expect(calls.slice(-3)).toEqual([
      ["systemctl", "--user", "stop", "worktree-control.service"],
      ["systemctl", "--user", "disable", "worktree-control.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it.each(["fresh", "refresh", "legacy"] as const)("refuses destination-only external overrides on %s without stopping the existing controller", mode => {
    const { manager, calls } = linuxHome({ legacy: mode === "legacy", current: mode === "refresh", destinationExternalDropIn: true });
    if (mode === "legacy") {
      mkdirSync(`${manager.legacyDefinitionPath}.d`);
      writeFileSync(join(`${manager.legacyDefinitionPath}.d`, "limits.conf"), "[Service]\nMemoryMax=512M\n");
    }
    expect(() => manager.install({ ...installOptions, refresh: mode === "refresh" })).toThrow("Inspect and reconcile");
    expect(calls.some(call => ["start", "stop", "restart", "enable", "disable"].includes(call[2]))).toBe(false);
    expect(calls).toContainEqual(["systemctl", "--user", "show", "worktree-control.service", "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"]);
    expect(calls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
    if (mode === "refresh") expect(readFileSync(manager.definitionPath, "utf8")).toBe("unit");
    else expect(existsSync(manager.definitionPath)).toBe(false);
    if (mode === "legacy") {
      expect(readFileSync(manager.legacyDefinitionPath, "utf8")).toBe(legacyUnit);
      expect(readFileSync(join(`${manager.legacyDefinitionPath}.d`, "limits.conf"), "utf8")).toBe("[Service]\nMemoryMax=512M\n");
      expect(existsSync(`${manager.definitionPath}.d`)).toBe(false);
    }
  });

  it("rolls back when the main process changes while waiting for stability", () => {
    const { manager } = linuxHome({ health: { stableMs: 5_000 }, show: [running, running.replace("MainPID=42", "MainPID=43")] });

    expect(() => manager.install(installOptions)).toThrow("restarted while starting");
    expect(existsSync(manager.definitionPath)).toBe(false);
  });

  it("restores the previous definition and restarts it when a refresh fails", () => {
    const { calls, manager } = linuxHome({ current: true, fail: (args) => args[1] === "restart" });

    expect(() => manager.install({ ...installOptions, refresh: true })).toThrow("systemctl --user restart worktree-control.service failed");

    expect(readFileSync(manager.definitionPath, "utf8")).toBe("unit");
    expect(calls.slice(-3)).toEqual([
      ["systemctl", "--user", "stop", "worktree-control.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "start", "worktree-control.service"],
    ]);
    expect(calls).not.toContainEqual(["systemctl", "--user", "disable", "worktree-control.service"]);
  });

  it("reports manager state plus lightweight process resource use", () => {
    const home = mkdtempSync(join(tmpdir(), "worktree-control-service-"));
    directories.push(home);
    const runner: ServiceCommandRunner = {
      run(command) {
        if (command === "systemctl") return { status: 0, stdout: "ActiveState=active\nSubState=running\nMainPID=42\nNRestarts=2\nExecMainStatus=0\nResult=success\n", stderr: "" };
        return { status: 0, stdout: "3601 2048 1.5\n", stderr: "" };
      },
    };
    const manager = new UserServiceManager({ platform: "linux", homeDirectory: home, environment: { NODE_ENV: "test" }, runner });
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(manager.definitionPath, "unit", { flag: "wx" });

    expect(manager.status()).toMatchObject({
      active: true,
      state: "active/running",
      pid: 42,
      restarts: 2,
      uptimeSeconds: 3601,
      residentMemoryBytes: 2 * 1024 * 1024,
      cpuPercent: 1.5,
      legacyDefinitionPath: null,
    });
  });

  it("names the pre-rename service in the status warning", () => {
    const warning = legacyServiceWarning("/home/me/.config/systemd/user/worktree-switcher.service");
    expect(warning).toContain("legacy worktree-switcher service is still installed at /home/me/.config/systemd/user/worktree-switcher.service");
    expect(warning).not.toContain("legacy worktree-control");
    expect(warning).toContain("worktree-control service install");
  });
});

describe("legacy worktree-switcher service migration", () => {
  it("uses the renamed unit and records where the legacy unit lives", () => {
    const { home, manager } = linuxHome();
    expect(manager.definitionPath).toBe(join(home, ".config", "systemd", "user", "worktree-control.service"));
    expect(manager.legacyDefinitionPath).toBe(join(home, ".config", "systemd", "user", "worktree-switcher.service"));
    expect(renderSystemdUnit(installOptions)).toContain("Description=Worktree Control local control plane");
  });

  it("stops the legacy unit before starting the new one, then enables, disables and removes after the health check", () => {
    const { calls, manager } = linuxHome({ legacy: true });

    const result = manager.install(installOptions);

    expect(result.legacy).toEqual({ definitionPath: manager.legacyDefinitionPath, wasActive: true, migratedDropIns: [], retainedDropInDirectory: null });
    expect(existsSync(manager.legacyDefinitionPath)).toBe(false);
    expect(existsSync(manager.definitionPath)).toBe(true);
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "show", "worktree-control.service", "--property=FragmentPath", "--property=DropInPaths", "--property=NeedDaemonReload"],
      ["systemctl", "--user", "is-active", "--quiet", "worktree-switcher.service"],
      ["systemctl", "--user", "stop", "worktree-switcher.service"],
      ["systemctl", "--user", "start", "worktree-control.service"],
      ["systemctl", "--user", "show", "worktree-control.service", "--property=ActiveState", "--property=SubState", "--property=MainPID", "--property=NRestarts"],
      ["systemctl", "--user", "enable", "worktree-control.service"],
      ["systemctl", "--user", "disable", "worktree-switcher.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("leaves the legacy unit installed and restarts it when the new unit cannot start", () => {
    const { calls, manager } = linuxHome({ legacy: true, fail: (args) => args[1] === "start" && args[2] === "worktree-control.service" });

    expect(() => manager.install(installOptions)).toThrow("systemctl --user start worktree-control.service failed");

    expect(existsSync(manager.legacyDefinitionPath)).toBe(true);
    expect(existsSync(manager.definitionPath)).toBe(false);
    expect(calls.slice(-4)).toEqual([
      ["systemctl", "--user", "stop", "worktree-control.service"],
      ["systemctl", "--user", "disable", "worktree-control.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "start", "worktree-switcher.service"],
    ]);
    expect(calls).not.toContainEqual(["systemctl", "--user", "enable", "worktree-control.service"]);
    expect(calls).not.toContainEqual(["systemctl", "--user", "disable", "worktree-switcher.service"]);
  });

  it("keeps the legacy unit when the new service crashes after a successful start command", () => {
    const { calls, manager } = linuxHome({ legacy: true, show: ["ActiveState=failed\nSubState=failed\nMainPID=0\nNRestarts=5\n"] });

    expect(() => manager.install(installOptions)).toThrow("failed to start (failed/failed)");

    expect(existsSync(manager.legacyDefinitionPath)).toBe(true);
    expect(existsSync(manager.definitionPath)).toBe(false);
    expect(calls.at(-1)).toEqual(["systemctl", "--user", "start", "worktree-switcher.service"]);
    expect(calls).not.toContainEqual(["systemctl", "--user", "disable", "worktree-switcher.service"]);
  });

  it("does not restart a legacy unit that was not running", () => {
    const { calls, manager } = linuxHome({
      legacy: true,
      fail: (args) => args[1] === "is-active" || (args[1] === "start" && args[2] === "worktree-control.service"),
    });

    expect(() => manager.install(installOptions)).toThrow();
    expect(calls).not.toContainEqual(["systemctl", "--user", "start", "worktree-switcher.service"]);
  });

  it("installs without migration steps when no legacy unit exists", () => {
    const { calls, manager } = linuxHome();
    expect(manager.install(installOptions).legacy).toBeNull();
    expect(calls.flat()).not.toContain("worktree-switcher.service");
  });

  it("copies legacy drop-ins to the new unit before the daemon reload and removes the legacy directory", () => {
    const { calls, manager } = linuxHome({ legacy: true });
    const legacyDropIns = `${manager.legacyDefinitionPath}.d`;
    mkdirSync(legacyDropIns);
    writeFileSync(join(legacyDropIns, "override.conf"), "[Service]\nMemoryMax=512M\n", { mode: 0o640 });
    const sourceMode = statSync(join(legacyDropIns, "override.conf")).mode & 0o777;
    const target = join(`${manager.definitionPath}.d`, "override.conf");

    const result = manager.install(installOptions);

    expect(result.legacy).toMatchObject({ migratedDropIns: [target], retainedDropInDirectory: null });
    expect(readFileSync(target, "utf8")).toBe("[Service]\nMemoryMax=512M\n");
    expect(statSync(target).mode & 0o777).toBe(sourceMode);
    expect(existsSync(legacyDropIns)).toBe(false);
    expect(calls[0]).toEqual(["systemctl", "--user", "daemon-reload"]);
  });

  it("removes copied drop-ins again when the migration rolls back", () => {
    const { manager } = linuxHome({ legacy: true, fail: (args) => args[1] === "start" && args[2] === "worktree-control.service" });
    const legacyDropIns = `${manager.legacyDefinitionPath}.d`;
    mkdirSync(legacyDropIns);
    writeFileSync(join(legacyDropIns, "override.conf"), "[Service]\nMemoryMax=512M\n");

    expect(() => manager.install(installOptions)).toThrow();

    expect(existsSync(`${manager.definitionPath}.d`)).toBe(false);
    expect(readFileSync(join(legacyDropIns, "override.conf"), "utf8")).toBe("[Service]\nMemoryMax=512M\n");
  });

  it("never overwrites a differing drop-in of the new unit and keeps the legacy directory for review", () => {
    const { manager } = linuxHome({ legacy: true });
    const legacyDropIns = `${manager.legacyDefinitionPath}.d`;
    const newDropIns = `${manager.definitionPath}.d`;
    mkdirSync(legacyDropIns);
    mkdirSync(newDropIns);
    writeFileSync(join(legacyDropIns, "override.conf"), "[Service]\nMemoryMax=512M\n");
    writeFileSync(join(legacyDropIns, "same.conf"), "[Service]\nNice=10\n");
    writeFileSync(join(newDropIns, "override.conf"), "[Service]\nMemoryMax=1G\n");
    writeFileSync(join(newDropIns, "same.conf"), "[Service]\nNice=10\n");

    const result = manager.install(installOptions);

    expect(result.legacy).toMatchObject({ migratedDropIns: [], retainedDropInDirectory: legacyDropIns });
    expect(readFileSync(join(newDropIns, "override.conf"), "utf8")).toBe("[Service]\nMemoryMax=1G\n");
    expect(existsSync(join(legacyDropIns, "override.conf"))).toBe(true);
    expect(existsSync(manager.legacyDefinitionPath)).toBe(false);
  });

  it("inherits start arguments from the legacy unit until the new unit exists", () => {
    const { manager } = linuxHome({ legacy: true });
    expect(manager.readStartArguments()).toEqual(["--data-dir", "/home/me/.local/share/worktree-switcher", "--backup-dir", "/backups"]);
    writeFileSync(manager.definitionPath, renderSystemdUnit(installOptions));
    expect(manager.readStartArguments()).toEqual(installOptions.startArguments);
  });

  it("reports a remaining legacy unit in status, even when the new unit is not installed", () => {
    const { manager } = linuxHome({ legacy: true });
    expect(manager.status()).toMatchObject({ installed: false, legacyDefinitionPath: manager.legacyDefinitionPath });
  });

  it("removes both the new and the legacy unit on uninstall", () => {
    const { calls, manager } = linuxHome({ legacy: true, current: true });

    expect(manager.uninstall()).toEqual({ removed: true, definitionPath: manager.definitionPath, legacyDefinitionPath: manager.legacyDefinitionPath });

    expect(existsSync(manager.definitionPath)).toBe(false);
    expect(existsSync(manager.legacyDefinitionPath)).toBe(false);
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "--now", "worktree-control.service"]);
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "--now", "worktree-switcher.service"]);
  });

  function darwinHome(options: { newAgentState?: string } = {}) {
    const home = mkdtempSync(join(tmpdir(), "worktree-control-service-"));
    directories.push(home);
    const calls: string[][] = [];
    let newAgentLoaded = false;
    const runner: ServiceCommandRunner = {
      run(command, args) {
        calls.push([command, ...args]);
        if (args[0] === "bootstrap" && args[2].endsWith("dev.worktree-control.controller.plist")) newAgentLoaded = true;
        if (args[0] === "bootout" && args[1] === "gui/501/dev.worktree-control.controller") newAgentLoaded = false;
        if (args[0] !== "print") return { status: 0, stdout: "", stderr: "" };
        // Only the legacy agent is loaded before the migration; the new one appears after bootstrap.
        if (args[1] === "gui/501/dev.worktree-switcher.controller") return { status: 0, stdout: "state = running\npid = 11\n", stderr: "" };
        if (newAgentLoaded) return { status: 0, stdout: `state = ${options.newAgentState ?? "running"}\npid = 77\nruns = 1\n`, stderr: "" };
        return { status: 1, stdout: "", stderr: "Could not find service" };
      },
    };
    const clock = fakeClock();
    const manager = new UserServiceManager({ platform: "darwin", homeDirectory: home, uid: 501, runner, clock, health: { stableMs: 0 } });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(manager.legacyDefinitionPath, "plist");
    return { calls, manager, clock };
  }

  it("boots out and removes a legacy LaunchAgent before bootstrapping the new one", () => {
    const { calls, manager } = darwinHome();
    expect(manager.definitionPath).toBe(join(manager.legacyDefinitionPath, "..", "dev.worktree-control.controller.plist"));

    expect(manager.install(installOptions).legacy).toEqual({ definitionPath: manager.legacyDefinitionPath, wasActive: true, migratedDropIns: [], retainedDropInDirectory: null });

    expect(existsSync(manager.legacyDefinitionPath)).toBe(false);
    expect(calls.slice(0, 3)).toEqual([
      ["launchctl", "print", "gui/501/dev.worktree-control.controller"],
      ["launchctl", "print", "gui/501/dev.worktree-switcher.controller"],
      ["launchctl", "bootout", "gui/501/dev.worktree-switcher.controller"],
    ]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", manager.definitionPath]);
    expect(calls.at(-1)).toEqual(["launchctl", "print", "gui/501/dev.worktree-control.controller"]);
    expect(readFileSync(manager.definitionPath, "utf8")).toContain("<string>dev.worktree-control.controller</string>");
  });

  it("restores the legacy LaunchAgent when the new one never reaches the running state", () => {
    const { calls, manager, clock } = darwinHome({ newAgentState: "waiting" });

    expect(() => manager.install(installOptions)).toThrow("did not become healthy within 30 seconds (waiting)");

    expect(clock.elapsed).toBeGreaterThanOrEqual(30_000);
    expect(existsSync(manager.legacyDefinitionPath)).toBe(true);
    expect(existsSync(manager.definitionPath)).toBe(false);
    expect(calls.slice(-4)).toEqual([
      ["launchctl", "bootout", "gui/501/dev.worktree-control.controller"],
      ["launchctl", "disable", "gui/501/dev.worktree-control.controller"],
      ["launchctl", "bootstrap", "gui/501", manager.legacyDefinitionPath],
      ["launchctl", "kickstart", "gui/501/dev.worktree-switcher.controller"],
    ]);
  });
});
