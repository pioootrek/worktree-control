import { describe, expect, it } from "vitest";
import { parseUserBackupOptions, userBackupArguments } from "./user-backup-options";
import { buildServiceStartArguments } from "./service-install";
import { resolveServiceInstallArguments } from "./service-options";
import { UserServiceManager, type ServiceCommandRunner } from "./service-manager";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("user backup startup policy", () => {
  it("defaults off and independently round-trips in a service definition", () => {
    expect(parseUserBackupOptions([]).enabled).toBe(false);
    const policy = parseUserBackupOptions(["--user-backup-enabled", "--user-backup-scopes", "knowledge-discussions", "--user-backup-projects", "project-one,project-two", "--user-backup-target", "local=/tmp/wts-new-user-target", "--user-backup-min-interval-seconds", "60"]);
    expect(parseUserBackupOptions(userBackupArguments(policy))).toEqual(policy);
    const args = buildServiceStartArguments({ host: "127.0.0.1", port: 3000, mcpPort: 4000, browseRoot: "/tmp", dataDirectory: "/tmp/data", stateDirectory: "/tmp/state", webRoot: "/tmp/web", noMcp: false, memoryWarningMiB: null, userBackupPolicy: policy });
    expect(parseUserBackupOptions(args)).toEqual(policy); expect(args).not.toContain("--backup-interval-seconds");
  });
  it.each([
    ["--user-backup-enabled"], ["--user-backup-enabled", "false"], ["--user-backup-scopes", "sqlite"], ["--user-backup-unknown", "1"], ["--user-backup-min-interval-seconds", "59"],
    ["--user-backup-min-interval-seconds", "2592001"], ["--user-backup-max-schedules", "33"], ["--user-backup-max-schedules", "0"],
    ["--user-backup-max-bytes", "1048575"], ["--user-backup-max-bytes", "1073741825"], ["--user-backup-timeout-seconds", "301"],
    ["--user-backup-queue-limit", "0"], ["--user-backup-retain-days", "366"], ["--user-backup-retain-count", "101"],
    ["--user-backup-max-schedules", "1.1"], ["--user-backup-target", "path"], ["--user-backup-projects", "one,one"],
    ["--user-backup-target", "one=/tmp/test", "--user-backup-target", "one=/tmp/other"],
    ["--user-backup-target", "one=/tmp/test", "--user-backup-target", "two=/tmp/test"],
    ["--user-backup-enabled", "--user-backup-enabled"],
  ])("rejects invalid flags %j", (...args: string[]) => { expect(() => parseUserBackupOptions(args)).toThrow(); });
  it("rejects policy flags on administrative commands", () => { expect(() => parseUserBackupOptions(["--user-backup-enabled"], false)).toThrow(); });
  it.each(["linux", "darwin"] as const)("refresh preserves enabled installed policy and escaped targets on %s", platform => {
    const root = mkdtempSync(join(tmpdir(), "user-policy-refresh-"));
    const calls: string[][] = [];
    // The health check needs a running main process; the fake managers report one.
    const healthy = (args: string[]) => args[1] === "show"
      ? args.includes("--property=FragmentPath")
        ? `FragmentPath=${join(root, ".config", "systemd", "user", args[2])}\nDropInPaths=\nNeedDaemonReload=no\n`
        : "ActiveState=active\nSubState=running\nMainPID=42\nNRestarts=0\n"
      : args[0] === "print" ? "state = running\npid = 42\n" : "";
    const runner: ServiceCommandRunner = { run: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: healthy(args), stderr: "" }; } };
    try {
      const manager = new UserServiceManager({ platform, homeDirectory: root, environment: { NODE_ENV: "test" }, uid: 123, runner, health: { stableMs: 0 } });
      const target = join(root, 'exports 100% & "quotes" \\ local');
      const policy = parseUserBackupOptions(["--user-backup-enabled", "--user-backup-projects", "one,two", "--user-backup-scopes", "knowledge-discussions", "--user-backup-target", `local=${target}`, "--user-backup-min-interval-seconds", "120", "--user-backup-max-schedules", "3"]);
      const base = { host: "127.0.0.1", port: 3000, mcpPort: 4000, browseRoot: root, dataDirectory: root, stateDirectory: root, webRoot: root, noMcp: false, memoryWarningMiB: null };
      const options = { nodePath: "/opt/node", entrypointPath: "/opt/old/index.js", workingDirectory: root, startArguments: buildServiceStartArguments({ ...base, userBackupPolicy: policy }), stateDirectory: root, refresh: false };
      manager.install(options);
      const inherited = parseUserBackupOptions(resolveServiceInstallArguments(["install", "--refresh"], manager.readStartArguments()).args);
      expect(inherited).toEqual(policy);
      manager.install({ ...options, entrypointPath: "/opt/new/index.js", refresh: true, startArguments: buildServiceStartArguments({ ...base, userBackupPolicy: inherited }) });
      expect(parseUserBackupOptions(manager.readStartArguments()!)).toEqual(policy);
      const before = readFileSync(manager.definitionPath, "utf8"), called = calls.length;
      expect(parseUserBackupOptions(resolveServiceInstallArguments(["install", "--refresh", "--user-backup-max-schedules", "2"], manager.readStartArguments()).args)).toMatchObject({ enabled: true, maxSchedules: 2, targets: policy.targets });
      expect(parseUserBackupOptions(resolveServiceInstallArguments(["install", "--refresh", "--unset", "--user-backup-enabled"], manager.readStartArguments()).args)).toMatchObject({ enabled: false, targets: policy.targets });
      expect(readFileSync(manager.definitionPath, "utf8")).toBe(before); expect(calls).toHaveLength(called);
      writeFileSync(manager.definitionPath, "unrecognized service definition", { mode: 0o600 });
      expect(() => resolveServiceInstallArguments(["install", "--refresh"], manager.readStartArguments())).toThrow("complete user backup policy");
      expect(readFileSync(manager.definitionPath, "utf8")).toBe("unrecognized service definition"); expect(calls).toHaveLength(called);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps fresh installs and legacy refresh without user arguments disabled", () => {
    expect(parseUserBackupOptions(resolveServiceInstallArguments(["install"], null).args).enabled).toBe(false);
    expect(parseUserBackupOptions(resolveServiceInstallArguments(["install", "--refresh"], null).args).enabled).toBe(false);
    expect(parseUserBackupOptions(resolveServiceInstallArguments(["install", "--refresh"], ["--service-mode"]).args).enabled).toBe(false);
  });
});
