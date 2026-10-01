import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseBackupPolicyOptions, validateBackupPolicyDestination } from "./backup-policy-options";
import { parseMigrationBackupOptions } from "./migration-backup-options";
import { buildServiceStartArguments } from "./service-install";

describe("CLI backup deployment policy", () => {
  it("defaults to no automation/web actions and a directory alone does not enable them", () => {
    expect(parseBackupPolicyOptions([])).toMatchObject({ intervalSeconds: null, uiActions: [] });
    expect(parseBackupPolicyOptions(["--backup-dir", "/private/copies"])).toMatchObject({ directory: "/private/copies", intervalSeconds: null, uiActions: [] });
  });
  it.each([
    ["--backup-interval-seconds", "60"], ["--backup-ui-actions", "create"],
    ["--backup-dir"], ["--backup-interval-seconds", "0"], ["--backup-interval-seconds", "60.5"],
    ["--backup-retain-count", "1001"], ["--backup-max-bytes", "1"], ["--backup-queue-limit", "0"],
    ["--backup-ui-actions", "restore,restore"], ["--backup-retain-days", "1", "--backup-retain-days", "2"],
    ["--backup-user-schedules"], ["--backup-dir", "bad\0path"], ["--backup-timeout-seconds", "-1"],
  ])("rejects invalid startup arguments %j", (...args) => expect(() => parseBackupPolicyOptions(args)).toThrow());
  it("rejects startup flags on non-start commands", () => expect(() => parseBackupPolicyOptions(["--backup-retain-days", "10"], false)).toThrow());
  it("validates a destination without creating it and refuses files or public directories", () => {
    const root = mkdtempSync(join(tmpdir(), "backup-policy-"));
    try {
      const absent = join(root, "absent");
      validateBackupPolicyDestination(parseBackupPolicyOptions(["--backup-dir", absent]));
      expect(existsSync(absent)).toBe(false);
      const publicPath = join(root, "public"), file = join(root, "file");
      mkdirSync(publicPath, { mode: 0o755 }); chmodSync(publicPath, 0o755); writeFileSync(file, "fixture");
      for (const path of [publicPath, file]) expect(() => validateBackupPolicyDestination(parseBackupPolicyOptions(["--backup-dir", path]))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("preserves migration protection and operational parameters in the service definition", () => {
    const args = ["--backup-dir", "/private/backups", "--backup-before-migration", "--backup-interval-seconds", "1800", "--backup-retain-count", "3", "--backup-ui-actions", "create,restore"];
    const policy = parseBackupPolicyOptions(args), migration = parseMigrationBackupOptions(args);
    const generated = buildServiceStartArguments({ host: "127.0.0.1", port: 4000, mcpPort: 4001, browseRoot: "/repo", dataDirectory: "/data", stateDirectory: "/state", webRoot: "/web", noMcp: true, memoryWarningMiB: null, ...migration, backupPolicy: policy });
    expect(parseBackupPolicyOptions(generated)).toEqual(policy);
    expect(parseMigrationBackupOptions(generated)).toEqual(migration);
  });
});
