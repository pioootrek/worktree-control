import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRemoteBackupOptions, remoteBackupArguments, resolveServiceRemoteBackupOptions } from "./remote-backup-options";
import { buildServiceStartArguments, resolveServiceBackupArguments } from "./service-install";
import { parseBackupPolicyOptions } from "./backup-policy-options";
import { parseMigrationBackupOptions } from "./migration-backup-options";

const roots: string[] = []; afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remote-options-")); roots.push(root);
  const key = join(root, "key"), credentials = join(root, "credentials.json");
  writeFileSync(key, "fixture-encryption-password", { mode: 0o600 }); writeFileSync(credentials, JSON.stringify({ username: "fixture-user", password: "fixture-backend-password" }), { mode: 0o600 });
  const args = ["--backup-remote-enabled", "--backup-remote-restic", process.execPath, "--backup-remote-repository", "rest:https://backup.example.test/installation/", "--backup-remote-repository-id", "a".repeat(64), "--backup-remote-password-file", key, "--backup-remote-credentials-file", credentials];
  return { root, key, credentials, args };
}
describe("operator-only remote startup policy", () => {
  it("defaults off and uses argv as the entire non-secret policy", () => {
    expect(parseRemoteBackupOptions([])).toEqual({}); expect(parseRemoteBackupOptions(["--backup-remote-disabled"])).toEqual({});
    const f = fixture(), parsed = parseRemoteBackupOptions(f.args); expect(parseRemoteBackupOptions(remoteBackupArguments(parsed))).toEqual(parsed);
    expect(remoteBackupArguments(parsed).join(" ")).not.toContain("fixture-backend-password");
    expect(remoteBackupArguments(parsed).join(" ")).not.toContain("fixture-encryption-password");
  });
  it.each([["--backup-remote-enabled"], ["--backup-remote-disabled", "--backup-remote-enabled"], ["--backup-remote-config", "secret"], ["--backup-remote-retry-seconds", "10"], ["--backup-remote-enabled", "yes"], ["--backup-remote-disabled", "--backup-remote-pending-limit", "1"]])("rejects malformed or ambiguous deployment policy %j", args => expect(() => parseRemoteBackupOptions(args)).toThrow());
  it("rejects unsafe targets and secret inputs without echoing paths or values", () => {
    const f = fixture();
    for (const repository of ["/local", "rest:http://unsafe/", "rest:https://user:secret@host/", "rest:https://host/?secret", "sftp:user@host:/repo"]) {
      const args = [...f.args]; args[args.indexOf("--backup-remote-repository") + 1] = repository;
      try { parseRemoteBackupOptions(args); throw new Error("accepted"); } catch (error) { expect((error as Error).message).not.toContain(repository); expect((error as Error).message).not.toContain(f.root); }
    }
    chmodSync(f.credentials, 0o644); expect(() => parseRemoteBackupOptions(f.args)).toThrow("Invalid remote backup configuration");
    chmodSync(f.credentials, 0o600); writeFileSync(f.key, Buffer.alloc(16385)); expect(() => parseRemoteBackupOptions(f.args)).toThrow();
    const alias = join(f.root, "alias"); symlinkSync(f.credentials, alias); const args = [...f.args]; args[args.indexOf("--backup-remote-credentials-file") + 1] = alias; expect(() => parseRemoteBackupOptions(args)).toThrow();
  });
  it("preserves and revalidates installed local/remote arguments on refresh, with explicit replacement and disable", () => {
    const f = fixture(), remote = parseRemoteBackupOptions(f.args), local = ["--backup-dir", join(f.root, "copies"), "--backup-interval-seconds", "60"];
    const generated = buildServiceStartArguments({ host: "localhost", port: 4000, mcpPort: 4001, browseRoot: f.root, dataDirectory: f.root, stateDirectory: f.root, webRoot: f.root, noMcp: true, memoryWarningMiB: null, backupDirectory: local[1], backupPolicy: parseBackupPolicyOptions(local), remoteBackupOptions: remote });
    expect(resolveServiceRemoteBackupOptions(["--refresh"], () => generated)).toEqual(remote);
    expect(parseBackupPolicyOptions(resolveServiceBackupArguments(["--refresh"], () => generated))).toEqual(parseBackupPolicyOptions(local));
    expect(parseMigrationBackupOptions(generated)).toMatchObject({ backupDirectory: local[1] });
    expect(resolveServiceRemoteBackupOptions(["--refresh", "--backup-remote-disabled"], () => generated)).toEqual({});
    expect(() => resolveServiceRemoteBackupOptions(["--refresh", "--backup-remote-pending-limit", "1"], () => generated)).toThrow();
    chmodSync(f.key, 0o644); expect(() => resolveServiceRemoteBackupOptions(["--refresh"], () => generated)).toThrow();
    expect(() => parseRemoteBackupOptions(f.args, false)).toThrow();
  });
});
