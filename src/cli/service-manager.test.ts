import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderLaunchAgent, renderSystemdUnit, resolveServiceExecutablePath, type ServiceCommandRunner, UserServiceManager } from "./service-manager";

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
});

describe("UserServiceManager", () => {
  it("installs idempotently and requires refresh when the executable changes", () => {
    const home = mkdtempSync(join(tmpdir(), "worktree-control-service-"));
    directories.push(home);
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = {
      run(command, args) {
        calls.push([command, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const manager = new UserServiceManager({ platform: "linux", homeDirectory: home, environment: { NODE_ENV: "test" }, runner });

    expect(manager.install(installOptions).changed).toBe(true);
    expect(manager.install(installOptions).changed).toBe(false);
    expect(() => manager.install({ ...installOptions, nodePath: "/new/node" })).toThrow("--refresh");
    expect(manager.install({ ...installOptions, nodePath: "/new/node", refresh: true }).changed).toBe(true);
    expect(readFileSync(manager.definitionPath, "utf8")).toContain('ExecStart="/new/node"');
    expect(calls).toContainEqual(["systemctl", "--user", "restart", "worktree-control.service"]);
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
});

describe("legacy worktree-control service migration", () => {
  const legacyUnit = 'ExecStart="/old/node" "/old/dist/cli/index.js" "start" "--data-dir" "/home/me/.local/share/worktree-switcher" "--backup-dir" "/backups"\n';

  function linuxHome(options: { legacy?: boolean; current?: boolean; fail?: (args: string[]) => boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), "worktree-control-service-"));
    directories.push(home);
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = {
      run(command, args) {
        calls.push([command, ...args]);
        if (options.fail?.(args)) return { status: 1, stdout: "", stderr: "failed" };
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const manager = new UserServiceManager({ platform: "linux", homeDirectory: home, environment: { NODE_ENV: "test" }, runner });
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    if (options.legacy) writeFileSync(manager.legacyDefinitionPath, legacyUnit);
    if (options.current) writeFileSync(manager.definitionPath, "unit");
    return { home, calls, manager };
  }

  it("uses the renamed unit and records where the legacy unit lives", () => {
    const { home, manager } = linuxHome();
    expect(manager.definitionPath).toBe(join(home, ".config", "systemd", "user", "worktree-control.service"));
    expect(manager.legacyDefinitionPath).toBe(join(home, ".config", "systemd", "user", "worktree-switcher.service"));
    expect(renderSystemdUnit(installOptions)).toContain("Description=Worktree Control local control plane");
  });

  it("stops the legacy unit before starting the new one, then disables and removes it", () => {
    const { calls, manager } = linuxHome({ legacy: true });

    const result = manager.install(installOptions);

    expect(result.legacy).toEqual({ definitionPath: manager.legacyDefinitionPath, wasActive: true });
    expect(existsSync(manager.legacyDefinitionPath)).toBe(false);
    expect(existsSync(manager.definitionPath)).toBe(true);
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "worktree-control.service"],
      ["systemctl", "--user", "is-active", "--quiet", "worktree-switcher.service"],
      ["systemctl", "--user", "stop", "worktree-switcher.service"],
      ["systemctl", "--user", "start", "worktree-control.service"],
      ["systemctl", "--user", "disable", "worktree-switcher.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("leaves the legacy unit installed and restarts it when the new unit cannot start", () => {
    const { calls, manager } = linuxHome({ legacy: true, fail: (args) => args[1] === "start" && args[2] === "worktree-control.service" });

    expect(() => manager.install(installOptions)).toThrow("systemctl --user start worktree-control.service failed");

    expect(existsSync(manager.legacyDefinitionPath)).toBe(true);
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

  it("boots out and removes a legacy LaunchAgent before bootstrapping the new one", () => {
    const home = mkdtempSync(join(tmpdir(), "worktree-control-service-"));
    directories.push(home);
    const calls: string[][] = [];
    const runner: ServiceCommandRunner = {
      run(command, args) {
        calls.push([command, ...args]);
        // Only the legacy agent is loaded.
        const loaded = args[0] !== "print" || args[1] === "gui/501/dev.worktree-switcher.controller";
        return { status: loaded ? 0 : 1, stdout: "", stderr: "" };
      },
    };
    const manager = new UserServiceManager({ platform: "darwin", homeDirectory: home, uid: 501, runner });
    expect(manager.definitionPath).toBe(join(home, "Library", "LaunchAgents", "dev.worktree-control.controller.plist"));
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(manager.legacyDefinitionPath, "plist");

    expect(manager.install(installOptions).legacy).toEqual({ definitionPath: manager.legacyDefinitionPath, wasActive: true });

    expect(existsSync(manager.legacyDefinitionPath)).toBe(false);
    expect(calls.slice(0, 3)).toEqual([
      ["launchctl", "print", "gui/501/dev.worktree-switcher.controller"],
      ["launchctl", "bootout", "gui/501/dev.worktree-switcher.controller"],
      ["launchctl", "print", "gui/501/dev.worktree-control.controller"],
    ]);
    expect(calls).toContainEqual(["launchctl", "bootstrap", "gui/501", manager.definitionPath]);
    expect(readFileSync(manager.definitionPath, "utf8")).toContain("<string>dev.worktree-control.controller</string>");
  });
});
