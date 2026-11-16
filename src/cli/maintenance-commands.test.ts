import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "../server/paths";
import { unmanagedFixtureDatabase } from "../server/unmanaged-sqlite-fixture";
import { createFencedAt49 } from "../server/infrastructure/sqlite/fixtures/released-schema";
import { CLI_HELP } from "./help";

/**
 * The offline maintenance commands as mounted in the CLI entry (`src/cli/index.ts`,
 * run with tsx): `upgrade inspect|apply` and `auth fence establish --backup-dir`.
 * Each call is a real process: exit code, stdout JSON on success and the JSON
 * error body on the last line of stderr on failure.
 */
const exec = promisify(execFile);
const repositoryRoot = resolve(".");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const CALL = 60_000;

function installation(): { root: string; paths: AppPaths } {
  const root = mkdtempSync(join(tmpdir(), "cli-maintenance-")); roots.push(root);
  mkdirSync(join(root, "home"));
  return { root, paths: resolveAppPaths(join(root, "data"), join(root, "state")) };
}
/** A pre-fence schema-40 installation (no witness). */
function preFence() {
  const fixture = installation();
  mkdirSync(fixture.paths.dataDirectory, { mode: 0o700 });
  const database = unmanagedFixtureDatabase(fixture.paths.databasePath);
  try { database.exec(readFileSync(new URL("../server/infrastructure/sqlite/fixtures/schema-v40.sql", import.meta.url), "utf8")); } finally { database.close(); }
  chmodSync(fixture.paths.databasePath, 0o600);
  return fixture;
}
function fenced49() { const fixture = installation(); createFencedAt49(fixture.paths.databasePath); return fixture; }
async function cli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = join(root, "home");
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: home,
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CONFIG_HOME: join(home, ".config") };
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--import", "tsx", join(repositoryRoot, "src/cli/index.ts"), ...args],
      { cwd: repositoryRoot, env: environment, encoding: "utf8", timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) { const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string }; return { code, stdout, stderr }; }
}
const dirs = (paths: AppPaths) => ["--data-dir", paths.dataDirectory, "--state-dir", paths.stateDirectory];
const body = (result: { stderr: string }) => JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
const marker = (paths: AppPaths) => {
  const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
  try { return database.prepare("SELECT state, plan_hash FROM upgrade_marker").get(); } finally { database.close(); }
};
const sha = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
const witness = (paths: AppPaths) => join(`${join(realpathSync(paths.dataDirectory), "state.sqlite3")}.security`, "witness.json");
const HASH = "a".repeat(64);

describe("the maintenance commands through the CLI entry", () => {
  it("refuses malformed upgrade and fence arguments with their JSON bodies and exit code 1, before touching the installation", async () => {
    const { root, paths } = installation(), backups = join(root, "backups");
    const cases: Array<[string[], string]> = [
      [["upgrade"], "upgrade_invalid_input"],
      [["upgrade", "inspect", "--expect", HASH], "upgrade_invalid_input"],
      [["upgrade", "apply", "--expect", "not-a-hash", "--backup-dir", backups], "upgrade_invalid_input"],
      [["upgrade", "apply", "--expect", HASH], "upgrade_invalid_input"],
      [["upgrade", "apply", "--expect", HASH, "--backup-dir", backups, "--backup-dir", backups], "upgrade_invalid_input"],
      [["upgrade", "apply", "--expect", HASH, "--backup-dir", "   "], "upgrade_invalid_input"],
      [["auth", "fence", "establish", "--expect", HASH], "invalid_input"],
      [["auth", "fence", "establish", "--expect", HASH, "--backup-dir", backups, "--backup-dir", backups], "invalid_input"],
      [["auth", "fence", "establish", "--expect", HASH, "--backup-dir", "  "], "invalid_input"],
      [["auth", "fence", "inspect", "--backup-dir", backups], "invalid_input"],
      [["auth", "fence", "resume", "--expect", HASH, "--mode", "token", "--backup-dir", backups], "invalid_input"],
    ];
    const results = await Promise.all(cases.map(([args]) => cli(root, [...args, ...dirs(paths)])));
    for (const [index, [args, code]] of cases.entries()) {
      expect(results[index]!.code, args.join(" ")).toBe(1);
      expect(body(results[index]!), args.join(" ")).toMatchObject({ code });
      expect(results[index]!.stdout, args.join(" ")).toBe("");
    }
    // No data directory, backup directory or lock was created by a refused argument list.
    expect(readdirSync(root).sort()).toEqual(["home"]);
  }, CALL);

  it("does not let the start parser swallow --backup-dir, and runs upgrade inspect and apply on a fenced schema-49 installation", async () => {
    const { root, paths } = fenced49(), backups = join(root, "maintenance");
    const refused = await cli(root, ["auth", "status", ...dirs(paths)]);
    expect(refused.code).toBe(1);
    expect(body(refused)).toEqual({ code: "upgrade_required", error: "upgrade_required: This database requires an explicit offline upgrade before ordinary access. Next step: upgrade inspect.",
      nextStep: "upgrade inspect", state: "upgrade_needed" });
    const inspected = await cli(root, ["upgrade", "inspect", ...dirs(paths)]);
    expect(inspected.code, inspected.stderr).toBe(0);
    const inspection = JSON.parse(inspected.stdout) as { state: string; nextStep: string; schemaVersion: number; target: number; planHash: string; review: Record<string, unknown> };
    expect(inspection).toMatchObject({ state: "upgrade_needed", nextStep: "upgrade apply", schemaVersion: 49, target: 52, marker: "absent" });
    expect(inspection.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(inspection.review).sort()).toEqual(["authority", "mapping"]);
    // Apply with --backup-dir after it: the upgrade parser, not the start parser, reads it.
    const applied = await cli(root, ["upgrade", "apply", "--expect", inspection.planHash, "--backup-dir", backups, ...dirs(paths)]);
    expect(applied.code, applied.stderr).toBe(0);
    const result = JSON.parse(applied.stdout) as { state: string; backup: string; planHash: string; schemaVersion: number };
    expect(result).toMatchObject({ state: "current", alreadyApplied: false, planHash: inspection.planHash, schemaVersion: 52, planRemoved: true });
    expect(readdirSync(backups)).toEqual([expect.stringMatching(/^pre-upgrade-v49-[0-9a-f-]{36}$/)]);
    expect(marker(paths)).toEqual({ state: "complete", plan_hash: inspection.planHash });
    // A repeated apply with the same hash answers "already applied"; another hash is refused in "current".
    const again = await cli(root, ["upgrade", "apply", "--expect", inspection.planHash, "--backup-dir", backups, ...dirs(paths)]);
    expect(JSON.parse(again.stdout)).toMatchObject({ state: "current", alreadyApplied: true, backup: null });
    const other = await cli(root, ["upgrade", "apply", "--expect", HASH, "--backup-dir", backups, ...dirs(paths)]);
    expect(other.code).toBe(1);
    expect(body(other)).toMatchObject({ code: "upgrade_wrong_state", nextStep: "none", state: "current" });
    expect(readdirSync(backups)).toHaveLength(1);
    // Ordinary access now opens; upgrade inspect reports current and writes no plan.
    const status = await cli(root, ["auth", "status", ...dirs(paths)]);
    expect(status.code, status.stderr).toBe(0);
    const current = await cli(root, ["upgrade", "inspect", ...dirs(paths)]);
    expect(JSON.parse(current.stdout)).toMatchObject({ state: "current", nextStep: "none", schemaVersion: 52, appliedPlan: inspection.planHash });
    expect(existsSync(join(`${join(realpathSync(paths.dataDirectory), "state.sqlite3")}.upgrade`, "plan.json"))).toBe(false);
  }, CALL);

  it("establishes a pre-fence installation with a backup at 52 with the marker pending, refuses a failing backup before the witness, and points to upgrade inspect", async () => {
    const { root, paths } = preFence(), occupied = join(root, "occupied");
    writeFileSync(occupied, "operator file", { mode: 0o600 });
    const inspected = await cli(root, ["auth", "fence", "inspect", ...dirs(paths)]);
    expect(inspected.code, inspected.stderr).toBe(0);
    const status = JSON.parse(inspected.stdout) as { preflight: string };
    expect(status).toMatchObject({ code: "security_fence_establishment_required", establishmentAllowed: true, schemaVersion: 40, nextStep: "auth fence establish" });
    // A backup that cannot be written refuses before the witness: nothing changed.
    const database = sha(paths.databasePath);
    const failed = await cli(root, ["auth", "fence", "establish", "--expect", status.preflight, "--backup-dir", occupied, ...dirs(paths)]);
    expect(failed.code).toBe(1);
    expect(body(failed)).toEqual({ code: "security_fence_backup_failed", error: "The pre-establishment backup failed; nothing was changed. Run auth fence inspect, then establish again." });
    expect(sha(paths.databasePath)).toBe(database);
    expect(existsSync(witness(paths))).toBe(false);
    expect(readFileSync(occupied, "utf8")).toBe("operator file");
    // With a usable directory: the structure reaches 52, the marker is pending, the result points to the upgrade.
    const backups = join(root, "backups");
    const established = await cli(root, ["auth", "fence", "establish", "--expect", status.preflight, "--backup-dir", backups, ...dirs(paths)]);
    expect(established.code, established.stderr).toBe(0);
    const result = JSON.parse(established.stdout) as { backup: string };
    expect(result).toMatchObject({ code: "security_fence_current", trusted: true, changed: true, schemaVersion: 52, nextStep: "upgrade inspect" });
    expect(result.backup).toMatch(/\/pre-establishment-v40-[0-9a-f-]{36}$/);
    expect(readdirSync(backups)).toHaveLength(1);
    expect(marker(paths)).toEqual({ state: "pending", plan_hash: null });
    const refused = await cli(root, ["project", "list", ...dirs(paths)]);
    expect(refused.code).toBe(1);
    expect(body(refused)).toMatchObject({ code: "upgrade_required", nextStep: "upgrade inspect" });
    // The trusted no-op takes no backup and writes nothing to the directory; it still points to the upgrade.
    const again = JSON.parse((await cli(root, ["auth", "fence", "inspect", ...dirs(paths)])).stdout) as { preflight: string; nextStep: string };
    expect(again.nextStep).toBe("upgrade inspect");
    const noop = await cli(root, ["auth", "fence", "establish", "--expect", again.preflight, "--backup-dir", join(root, "unused"), ...dirs(paths)]);
    expect(JSON.parse(noop.stdout)).toMatchObject({ trusted: true, changed: false, backup: null, nextStep: "upgrade inspect" });
    expect(existsSync(join(root, "unused"))).toBe(false);
    const upgrade = JSON.parse((await cli(root, ["upgrade", "inspect", ...dirs(paths)])).stdout) as Record<string, unknown>;
    expect(upgrade).toMatchObject({ state: "upgrade_needed", schemaVersion: 52, target: 52, marker: "pending" });
  }, CALL);

  it("returns at once on a trusted schema-49 fence: establish and resume point straight to upgrade inspect", async () => {
    const { root, paths } = fenced49();
    const status = JSON.parse((await cli(root, ["auth", "fence", "inspect", ...dirs(paths)])).stdout) as { preflight: string };
    expect(status).toMatchObject({ code: "security_fence_current", trusted: true, schemaVersion: 49, nextStep: "upgrade inspect" });
    const establish = await cli(root, ["auth", "fence", "establish", "--expect", status.preflight, "--backup-dir", join(root, "unused"), ...dirs(paths)]);
    const resume = await cli(root, ["auth", "fence", "resume", "--expect", status.preflight, "--mode", "token", ...dirs(paths)]);
    for (const result of [establish, resume]) expect(JSON.parse(result.stdout)).toMatchObject({ trusted: true, changed: false, schemaVersion: 49, nextStep: "upgrade inspect" });
    expect(existsSync(join(root, "unused"))).toBe(false);
  }, CALL);

  it("lists the maintenance commands, their arguments and the decisions keys in the help", () => {
    expect(CLI_HELP).toContain("upgrade            Offline database upgrade (stop the controller first): inspect [--decisions FILE]; apply --expect PLAN_HASH --backup-dir DIR");
    expect(CLI_HELP).toContain("fence            Protected offline security fence: inspect; establish --expect HASH --backup-dir DIR; resume --expect HASH --mode open|token|better-auth");
    for (const key of ["links", "bindings", "isolate"]) expect(CLI_HELP).toContain(key);
  });
});
