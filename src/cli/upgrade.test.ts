import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAppPaths, type AppPaths } from "../server/paths";
import { createFencedAt49 } from "../server/infrastructure/sqlite/fixtures/released-schema";
import { enableProvisionalSchema } from "../server/infrastructure/sqlite/provisional-schema-gate";
import { SecurityFenceBackupError, SecurityFenceError } from "../server/infrastructure/sqlite/security-fence";
import { boundedFindings, UpgradeError } from "../server/infrastructure/sqlite/upgrade-contract";
import { ProviderAdminError } from "../server/modules/authentication";
import * as composition from "../server/bootstrap/upgrade-maintenance";
import { parseUpgradeArguments, runUpgradeCommand, UPGRADE_DECISIONS_FILE_BYTES, UPGRADE_FAILED, upgradeErrorBody } from "./upgrade";

// Spyable `node:fs`, for the descriptor open of the decisions reader.
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
// The real composition, observed: each test sees the parsed values it was called with.
vi.mock("../server/bootstrap/upgrade-maintenance", async original => {
  const actual = await original<typeof import("../server/bootstrap/upgrade-maintenance")>();
  return { ...actual, inspectUpgrade: vi.fn(actual.inspectUpgrade), applyUpgrade: vi.fn(actual.applyUpgrade) };
});
const inspectUpgrade = vi.mocked(composition.inspectUpgrade), applyUpgrade = vi.mocked(composition.applyUpgrade);

const TARGET = 52;
const HASH = "a".repeat(64);
const roots: string[] = [];
let restoreGate: () => void;
beforeEach(() => { restoreGate = enableProvisionalSchema(); inspectUpgrade.mockClear(); applyUpgrade.mockClear(); });
afterEach(() => { restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "cli-upgrade-")); roots.push(root); return root; };
/** Paths of a data directory that does not exist: any lock or database access would create something under it. */
const absent = () => { const root = temporary(); return { root, paths: resolveAppPaths(join(root, "data"), join(root, "state")) }; };
const OPTIONS = { applicationVersion: "0.0.0-fixture", target: TARGET };
/** Runs the command and returns the error body it would print (or null) and what it wrote. */
async function run(args: readonly string[], paths: AppPaths) {
  const lines: string[] = [];
  try { await runUpgradeCommand(args, paths, line => lines.push(line), OPTIONS); return { body: null, lines }; } catch (error) { return { body: upgradeErrorBody(error), lines, error }; }
}
const INVALID = { code: "upgrade_invalid_input", error: "upgrade_invalid_input: The upgrade command is invalid. Next step: upgrade inspect.", nextStep: "upgrade inspect" };

describe("upgrade CLI runner: arguments", () => {
  it.each([
    [["upgrade", "inspect"], { action: "inspect" }],
    [["upgrade", "inspect", "--decisions", "decisions.json"], { action: "inspect", decisions: resolve("decisions.json") }],
    [["upgrade", "inspect", "--data-dir", "/data", "--state-dir", "/state"], { action: "inspect" }],
    [["upgrade", "apply", "--expect", HASH, "--backup-dir", "backups"], { action: "apply", expect: HASH, backupDirectory: resolve("backups") }],
    [["upgrade", "apply", "--backup-dir", "/b", "--data-dir", "/data", "--expect", HASH], { action: "apply", expect: HASH, backupDirectory: "/b" }],
  ] as const)("parses %j", (args, expected) => {
    expect(parseUpgradeArguments(args)).toEqual(expected);
  });

  it.each([
    ["no action", ["upgrade"]],
    ["an unknown action", ["upgrade", "status"]],
    ["another command", ["auth", "inspect"]],
    ["an extra positional", ["upgrade", "inspect", "now"]],
    ["an extra positional after apply", ["upgrade", "apply", "--expect", HASH, "--backup-dir", "/b", "again"]],
    ["an unknown flag", ["upgrade", "inspect", "--force"]],
    ["a flag with an inline value", ["upgrade", "apply", `--expect=${HASH}`, "--backup-dir", "/b"]],
    ["a short flag", ["upgrade", "inspect", "-d", "x"]],
    ["a repeated flag", ["upgrade", "apply", "--expect", HASH, "--expect", HASH, "--backup-dir", "/b"]],
    ["a repeated data directory", ["upgrade", "inspect", "--data-dir", "/a", "--data-dir", "/b"]],
    ["a missing value", ["upgrade", "inspect", "--decisions"]],
    ["a flag as value", ["upgrade", "apply", "--expect", "--backup-dir", "/b"]],
    ["an empty value", ["upgrade", "inspect", "--decisions", ""]],
    ["a blank decisions file", ["upgrade", "inspect", "--decisions", "  "]],
    ["a NUL in a value", ["upgrade", "apply", "--expect", HASH, "--backup-dir", "/b\0c"]],
    ["a short hash", ["upgrade", "apply", "--expect", "a".repeat(63), "--backup-dir", "/b"]],
    ["an upper-case hash", ["upgrade", "apply", "--expect", "A".repeat(64), "--backup-dir", "/b"]],
    ["apply without --expect", ["upgrade", "apply", "--backup-dir", "/b"]],
    ["apply without --backup-dir", ["upgrade", "apply", "--expect", HASH]],
    ["a blank backup directory", ["upgrade", "apply", "--expect", HASH, "--backup-dir", " "]],
    ["apply with --decisions", ["upgrade", "apply", "--expect", HASH, "--backup-dir", "/b", "--decisions", "d.json"]],
    ["inspect with --expect", ["upgrade", "inspect", "--expect", HASH]],
    ["inspect with --backup-dir", ["upgrade", "inspect", "--backup-dir", "/b"]],
  ] as const)("refuses %s as upgrade_invalid_input before any lock or database access", async (_name, args) => {
    const { root, paths } = absent();
    const { body, lines } = await run(args, paths);
    expect(body).toEqual(INVALID);
    expect(lines).toEqual([]);
    expect(inspectUpgrade).not.toHaveBeenCalled();
    expect(applyUpgrade).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("upgrade CLI runner: decisions file", () => {
  const DECISIONS = { isolate: { registrations: [], remoteIdentities: [] } };

  it("reads a regular JSON file (a hard link too) and passes its value and the target to inspect", async () => {
    const { paths } = absent(), root = temporary(), file = join(root, "decisions.json"), link = join(root, "linked.json");
    writeFileSync(file, JSON.stringify(DECISIONS)); linkSync(file, link);
    for (const name of [file, link]) {
      inspectUpgrade.mockClear();
      inspectUpgrade.mockReturnValueOnce({ state: "pre_fence", nextStep: "auth fence establish", schemaVersion: 40, target: TARGET, preflight: HASH, marker: "absent", appliedPlan: null });
      const { body, lines } = await run(["upgrade", "inspect", "--decisions", name], paths);
      expect(body).toBeNull();
      expect(inspectUpgrade).toHaveBeenCalledWith(paths, DECISIONS, TARGET);
      expect(JSON.parse(lines.join("\n"))).toEqual({ state: "pre_fence", nextStep: "auth fence establish", schemaVersion: 40, target: TARGET, preflight: HASH, marker: "absent", appliedPlan: null });
    }
  });

  it.each([
    ["missing", (root: string) => join(root, "missing.json")],
    ["a directory", (root: string) => { const path = join(root, "directory.json"); mkdirSync(path); return path; }],
    ["a symbolic link to a valid file", (root: string) => { const path = join(root, "valid.json"); writeFileSync(path, "{}"); symlinkSync(path, join(root, "link.json")); return join(root, "link.json"); }],
    ["larger than the limit", (root: string) => { const path = join(root, "large.json"); writeFileSync(path, "{}"); truncateSync(path, UPGRADE_DECISIONS_FILE_BYTES + 1); return path; }],
    ["not JSON", (root: string) => { const path = join(root, "text.json"); writeFileSync(path, "links: []"); return path; }],
    ["JSON with a duplicate key", (root: string) => { const path = join(root, "duplicate.json"); writeFileSync(path, '{"links":[],"links":[]}'); return path; }],
    // The invalid byte sits inside a JSON string: decoded permissively it would be valid JSON, so only strict decoding refuses it.
    ["not UTF-8", (root: string) => { const path = join(root, "binary.json"); writeFileSync(path, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}')])); return path; }],
    ["a FIFO", (root: string) => { const path = join(root, "fifo.json"); execFileSync("mkfifo", [path]); return path; }],
  ] as const)("refuses a decisions file that is %s, naming neither the file nor its content, before any lock", async (_name, make) => {
    const { root, paths } = absent();
    const file = make(temporary());
    const { body, lines } = await run(["upgrade", "inspect", "--decisions", file], paths);
    expect(body).toEqual(INVALID);
    expect(lines).toEqual([]);
    expect(inspectUpgrade).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a regular file replaced by a FIFO between the lstat check and the open, without blocking", async () => {
    const { root, paths } = absent(), file = join(temporary(), "decisions.json");
    writeFileSync(file, JSON.stringify(DECISIONS));
    const open = fs.openSync, opens: number[] = [];
    let fifoOpened = false;
    const spy = vi.spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
      if (path !== file) return open(path, flags, mode);
      // The lstat check has passed on the regular file; now another process swaps in a FIFO.
      opens.push(flags as number);
      rmSync(file); execFileSync("mkfifo", [file]);
      // Without O_NONBLOCK this open would wait for a writer: refuse instead, so a regression fails the assertion below and never leaves a blocked open.
      if (typeof flags !== "number" || !(flags & fs.constants.O_NONBLOCK)) throw new Error("blocking open of a FIFO");
      const fd = open(path, flags, mode); fifoOpened = true; return fd;
    }) as typeof fs.openSync);
    try {
      const { body, lines } = await run(["upgrade", "inspect", "--decisions", file], paths);
      expect(opens).toHaveLength(1);
      expect(opens[0]! & fs.constants.O_NONBLOCK).not.toBe(0);
      expect(fifoOpened).toBe(true);
      expect(body).toEqual(INVALID);
      expect(lines).toEqual([]);
      expect(inspectUpgrade).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 5_000);

  it("accepts a file at the limit by size; the act domains then judge its content", async () => {
    const { paths } = absent(), file = join(temporary(), "padded.json");
    writeFileSync(file, `{}${" ".repeat(UPGRADE_DECISIONS_FILE_BYTES - 2)}`);
    inspectUpgrade.mockImplementationOnce(() => { throw new UpgradeError("upgrade_owner_running", "stop the controller"); });
    expect((await run(["upgrade", "inspect", "--decisions", file], paths)).body).toMatchObject({ code: "upgrade_owner_running" });
    expect(inspectUpgrade).toHaveBeenCalledWith(paths, {}, TARGET);
  });
});

describe("upgrade CLI runner: through the composition", () => {
  it("inspects without printing the raw plan, then applies with the backup directory and prints the result", async () => {
    const paths = resolveAppPaths(join(temporary(), "data")), backups = join(temporary(), "operator-backups");
    createFencedAt49(paths.databasePath);
    const inspected = await run(["upgrade", "inspect"], paths);
    expect(inspected.body).toBeNull();
    const output = JSON.parse(inspected.lines.join("\n"));
    expect(Object.keys(output).sort()).toEqual(["acts", "appliedPlan", "decisions", "marker", "nextStep", "planHash", "preflight", "review", "schemaVersion", "state", "target"]);
    expect(output).toMatchObject({ state: "upgrade_needed", schemaVersion: 49, target: TARGET, planHash: expect.stringMatching(/^[0-9a-f]{64}$/), acts: expect.any(Array) });
    // The plan stays in its file: none of its own fields is printed.
    const plan = inspectUpgrade.mock.results[0]!.value.plan as Record<string, unknown>;
    expect(output.plan).toBeUndefined();
    for (const field of ["binding", "installation"]) expect(inspected.lines.join("\n")).not.toContain(plan[field] as string);
    for (const key of ["binding", "installation", "steps"]) expect(inspected.lines.join("\n")).not.toContain(`"${key}"`);
    const applied = await run(["upgrade", "apply", "--expect", output.planHash, "--backup-dir", backups, "--data-dir", paths.dataDirectory], paths);
    expect(applied.body).toBeNull();
    expect(applyUpgrade).toHaveBeenCalledWith(paths, { expect: output.planHash }, { directory: backups, applicationVersion: "0.0.0-fixture" }, TARGET);
    expect(JSON.parse(applied.lines.join("\n"))).toMatchObject({ state: "current", alreadyApplied: false, planHash: output.planHash, backup: expect.stringContaining(join(backups, "pre-upgrade-v49-")) });
  }, 30_000);

  it("prints the error body of a refused apply without the paths involved", async () => {
    const paths = resolveAppPaths(join(temporary(), "data-sentinel")), blocked = join(temporary(), "backup-sentinel");
    createFencedAt49(paths.databasePath);
    writeFileSync(blocked, "a file, not a directory");
    const { planHash } = composition.inspectUpgrade(paths, undefined, TARGET);
    const { body, lines } = await run(["upgrade", "apply", "--expect", planHash!, "--backup-dir", blocked], paths);
    expect(lines).toEqual([]);
    expect(body).toEqual({ code: "upgrade_backup_failed", error: "upgrade_backup_failed: The pre-upgrade backup could not be written or validated; nothing was changed. Next step: upgrade apply.", nextStep: "upgrade apply" });
    expect(JSON.stringify(body)).not.toMatch(/sentinel|\/tmp|cli-upgrade-/);
  }, 30_000);

  it("refuses at the supported target before any lock, as the unregistered command would today", async () => {
    const { root, paths } = absent(), lines: string[] = [];
    let body: unknown;
    try { await runUpgradeCommand(["upgrade", "inspect"], paths, line => lines.push(line), { applicationVersion: "0.0.0-fixture" }); } catch (error) { body = upgradeErrorBody(error); }
    expect(body).toEqual({ code: "upgrade_unsupported", error: "Unsupported schema target.", nextStep: "none" });
    expect(inspectUpgrade).toHaveBeenCalledWith(paths, undefined, undefined);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(paths.controllerLockPath)).toBe(false);
  });
});

describe("upgrade CLI runner: error bodies", () => {
  it("gives an UpgradeError's code, message, next step and bounded details", () => {
    const details = boundedFindings([{ table: "runtime_projects", id: "registration\u0007a", problem: "links to a missing project" }], 1);
    const body = upgradeErrorBody(new UpgradeError("upgrade_mapping_dangling", "upgrade inspect", false, undefined, details));
    expect(body).toEqual({ code: "upgrade_mapping_dangling", error: expect.stringMatching(/^upgrade_mapping_dangling: .* Next step: upgrade inspect\.$/), nextStep: "upgrade inspect",
      details: { findings: [{ table: "runtime_projects", id: "registration\\u{7}a", problem: "links to a missing project" }], count: 1, truncated: false } });
  });

  it("gives a committed UpgradeError its state and committed flag", () => {
    expect(upgradeErrorBody(new UpgradeError("upgrade_outcome_uncertain", "auth fence resume", true, "fenced"))).toEqual({
      code: "upgrade_outcome_uncertain", error: "upgrade_outcome_uncertain: The upgrade stopped after the security witness was set to pending. The schema transaction committed. Next step: auth fence resume.",
      nextStep: "auth fence resume", state: "fenced", committed: true });
    // Not committed: no flag, as in the provider bodies.
    expect(upgradeErrorBody(new UpgradeError("upgrade_wrong_state", "auth fence establish", false, "pre_fence"))).toEqual({
      code: "upgrade_wrong_state", error: expect.any(String), nextStep: "auth fence establish", state: "pre_fence" });
  });

  it("gives fence and provider errors their fixed provider bodies", () => {
    expect(upgradeErrorBody(new SecurityFenceBackupError())).toEqual({ code: "security_fence_backup_failed",
      error: "The pre-establishment backup failed; nothing was changed. Run auth fence inspect, then establish again." });
    expect(upgradeErrorBody(new SecurityFenceError("security_fence_pending", true))).toEqual({ code: "security_fence_pending",
      error: "Security checkpoint publication is unconfirmed; use protected offline auth fence inspect.", committed: true });
    expect(upgradeErrorBody(new ProviderAdminError("invalid_input"))).toEqual({ code: "invalid_input", error: "Invalid protected provider administration input." });
  });

  it("gives any other error a fixed body without its message", () => {
    for (const error of [new Error("ENOENT: /home/operator/secret-token.json"), Object.assign(new Error("/data/state.sqlite3"), { code: "upgrade_backup_failed" }), "text", null]) {
      expect(upgradeErrorBody(error)).toEqual({ ...UPGRADE_FAILED });
    }
    expect(JSON.stringify(upgradeErrorBody(new Error("/home/operator/secret-token.json")))).not.toMatch(/home|secret|token/);
  });
});
