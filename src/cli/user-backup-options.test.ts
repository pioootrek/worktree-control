import { describe, expect, it } from "vitest";
import { parseUserBackupOptions, userBackupArguments } from "./user-backup-options";
import { buildServiceStartArguments } from "./service-install";

describe("user backup startup policy", () => {
  it("defaults off and independently round-trips in a service definition", () => {
    expect(parseUserBackupOptions([]).enabled).toBe(false);
    const policy = parseUserBackupOptions(["--user-backup-enabled", "--user-backup-projects", "project-one,project-two", "--user-backup-target", "local=/tmp/wts-new-user-target", "--user-backup-min-interval-seconds", "60"]);
    expect(parseUserBackupOptions(userBackupArguments(policy))).toEqual(policy);
    const args = buildServiceStartArguments({ host: "127.0.0.1", port: 3000, mcpPort: 4000, browseRoot: "/tmp", dataDirectory: "/tmp/data", stateDirectory: "/tmp/state", webRoot: "/tmp/web", noMcp: false, memoryWarningMiB: null, userBackupPolicy: policy });
    expect(parseUserBackupOptions(args)).toEqual(policy); expect(args).not.toContain("--backup-interval-seconds");
  });
  it.each([
    ["--user-backup-enabled"], ["--user-backup-unknown", "1"], ["--user-backup-min-interval-seconds", "59"],
    ["--user-backup-min-interval-seconds", "2592001"], ["--user-backup-max-schedules", "33"], ["--user-backup-max-schedules", "0"],
    ["--user-backup-max-bytes", "1048575"], ["--user-backup-max-bytes", "1073741825"], ["--user-backup-timeout-seconds", "301"],
    ["--user-backup-queue-limit", "0"], ["--user-backup-retain-days", "366"], ["--user-backup-retain-count", "101"],
    ["--user-backup-max-schedules", "1.1"], ["--user-backup-target", "path"], ["--user-backup-projects", "one,one"],
    ["--user-backup-target", "one=/tmp/test", "--user-backup-target", "one=/tmp/other"],
    ["--user-backup-target", "one=/tmp/test", "--user-backup-target", "two=/tmp/test"],
    ["--user-backup-enabled", "--user-backup-enabled"],
  ])("rejects invalid flags %j", (...args: string[]) => { expect(() => parseUserBackupOptions(args)).toThrow(); });
  it("rejects policy flags on administrative commands", () => { expect(() => parseUserBackupOptions(["--user-backup-enabled"], false)).toThrow(); });
});
