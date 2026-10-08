import { describe, expect, it } from "vitest";
import { backupPolicyArguments, parseBackupPolicyOptions } from "./backup-policy-options";
import { resolveServiceInstallArguments, serviceSettingChanges, validateServiceCommand } from "./service-options";

describe("service command validation", () => {
  it.each(["install", "status", "start", "stop", "restart", "url", "open", "uninstall"])("refuses help and unknown input for %s before dispatch", action => {
    for (const flag of ["--help", "-h", "--typo", "unexpected-value"]) {
      expect(() => validateServiceCommand([action, flag])).toThrow("Usage: service");
    }
  });
  it.each([
    ["install", "--host"], ["install", "--host", "--refresh"],
    ["install", "--port", "47831", "--port", "47832"],
    ["install", "--refresh", "false"], ["install", "--host=127.0.0.1"],
    ["restart", "--print"], ["uninstall", "--yes"], ["unknown"],
  ])("rejects malformed or misplaced options: %j", (...args) => {
    expect(() => validateServiceCommand(args)).toThrow("Usage: service");
  });
  it("accepts no-argument status, explicit paths and repeated export targets", () => {
    expect(() => validateServiceCommand([])).not.toThrow();
    expect(() => validateServiceCommand(["status", "--data-dir", "/data", "--state-dir", "/state"])).not.toThrow();
    expect(() => validateServiceCommand(["install", "--print", "--user-backup-target", "one=/one", "--user-backup-target", "two=/two"])).not.toThrow();
  });
});

describe("installed service settings", () => {
  const installed = [
    "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", "47835", "--mcp-port", "47836",
    "--browse-root", "/repos", "--data-dir", "/data", "--state-dir", "/state", "--web-root", "/old/out",
    "--public-url", "https://control.example.test", "--no-mcp", "--memory-warning-mib", "512",
    "--backup-dir", "/backups", "--backup-before-migration", "--backup-interval-seconds", "86400",
    "--backup-retain-count", "7", "--backup-retain-days", "14", "--backup-max-bytes", "6442450944",
    "--user-backup-enabled", "--user-backup-target", "one=/one", "--user-backup-target", "two=/two",
    "--mcp-max-sessions", "48", "--mcp-max-sessions-per-credential", "24",
  ];
  it("inherits every setting during migration and refresh while changing package assets", () => {
    for (const args of [["install"], ["install", "--refresh"]]) {
      const result = resolveServiceInstallArguments(args, installed);
      expect(result.changes).toEqual([]);
      expect(result.args).toEqual(installed.filter((value, index) => !["--service-mode", "--no-open", "--web-root"].includes(value) && installed[index - 1] !== "--web-root"));
    }
  });
  it("overrides only explicit settings, reports before/after and replaces repeated targets", () => {
    const result = resolveServiceInstallArguments(["install", "--host", "0.0.0.0", "--backup-retain-count", "10", "--user-backup-target", "new=/new"], installed);
    expect(result.changes).toEqual([
      '--host: ["127.0.0.1"] -> ["0.0.0.0"]', '--backup-retain-count: ["7"] -> ["10"]',
      '--user-backup-target: ["one=/one","two=/two"] -> ["new=/new"]',
    ]);
    expect(result.args).toContain("86400");
    expect(result.args).toContain("6442450944");
    expect(result.args).not.toContain("two=/two");
  });
  it("can explicitly disable the inherited remote policy without losing the local schedule", () => {
    const result = resolveServiceInstallArguments(["install", "--backup-remote-disabled"], [
      ...installed, "--backup-remote-enabled", "--backup-remote-repository", "private-repository",
      "--backup-remote-password-file", "/private/password",
    ]);
    expect(result.args).not.toContain("--backup-remote-enabled");
    expect(result.args).not.toContain("private-repository");
    expect(result.args).toContain("--backup-remote-disabled");
    expect(result.args).toContain("86400");
    expect(result.changes.join("\n")).not.toContain("private-repository");
  });
  it("refuses unrecognized installed options instead of dropping them", () => {
    expect(() => resolveServiceInstallArguments(["install"], [...installed, "--future-policy", "on"])).toThrow("Unsupported service option");
  });
  it("explicitly removes inherited enabled flags, schedules and optional configuration", () => {
    const result = resolveServiceInstallArguments(["install", "--unset", "--user-backup-enabled", "--unset", "--no-mcp", "--unset", "--backup-interval-seconds", "--unset", "--public-url"], installed);
    for (const flag of ["--user-backup-enabled", "--no-mcp", "--backup-interval-seconds", "--public-url"]) expect(result.args).not.toContain(flag);
    expect(result.args).toContain("--backup-dir");
    expect(result.args).toContain("--backup-retain-count");
    expect(result.changes).toHaveLength(4);
  });
  it.each([
    ["--unset"], ["--unset", "--typo"], ["--unset", "--refresh"],
    ["--unset", "--host", "--host", "127.0.0.1"], ["--unset", "--host", "--unset", "--host"],
  ])("rejects ambiguous or unknown removals: %j", (...options) => {
    expect(() => resolveServiceInstallArguments(["install", ...options], installed)).toThrow();
  });
  it("shows the generated default when an inherited numeric option is reset", () => {
    expect(serviceSettingChanges(["--backup-retain-count", "7"], [], ["--backup-retain-count", "30"]))
      .toEqual(['--backup-retain-count: ["7"] -> ["30"]']);
  });
  it.each([
    [[], ["--backup-ui-actions", "none"]],
    [["--backup-retain-count", "7"], ["--backup-retain-count", "007"]],
    [["--backup-retain-count", "30"], []],
  ])("does not report requested values that serialize to the installed setting: %j -> %j", (previous, intended) => {
    const effective = backupPolicyArguments(parseBackupPolicyOptions(intended));
    expect(serviceSettingChanges(previous, intended, effective)).toEqual([]);
  });
  it("reports disabling configured backup UI actions after serialization omits none", () => {
    const intended = ["--backup-ui-actions", "none"];
    const effective = backupPolicyArguments(parseBackupPolicyOptions(intended));
    expect(serviceSettingChanges(["--backup-ui-actions", "create"], intended, effective))
      .toEqual(['--backup-ui-actions: ["create"] -> (unset; controller default)']);
  });
});
