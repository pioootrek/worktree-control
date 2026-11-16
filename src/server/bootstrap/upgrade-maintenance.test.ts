import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAppPaths, type AppPaths } from "../paths";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../modules/backups";
import { SqliteStateStore } from "../infrastructure/sqlite/sqlite-state-store";
import { maintainSqliteSecurityFence } from "../infrastructure/sqlite/security-maintenance";
import { securityFenceRoot } from "../infrastructure/sqlite/security-fence";
import { enableProvisionalSchema } from "../infrastructure/sqlite/provisional-schema-gate";
import { inspectSchema } from "../infrastructure/sqlite/schema-inspection";
import { parseManifest, readBoundedJson, validateBackup, BACKUP_LIMITS } from "../infrastructure/sqlite/backup-validation";
import { upgradePlanPath } from "../infrastructure/sqlite/upgrade-plan";
import { applyUpgrade, inspectUpgrade } from "./upgrade-maintenance";

// The collision case fixes the backup's UUID; every other test uses the real one.
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>() }));

/*
 * The upgrade through its bootstrap composition: the real createControllerBackup
 * writes the pre-upgrade backup into the operator's directory. Every test needs
 * the provisional target 52; the switch is restored after each one. A full
 * upgrade cycle flushes files several times: each such test has an explicit
 * 30 s timeout, since the hosted runner is about twice as slow as a workstation.
 */
const TARGET = 52;
const CYCLE = 30_000;
const roots: string[] = [];
let restoreGate: () => void;
beforeEach(() => { restoreGate = enableProvisionalSchema(); });
afterEach(() => { vi.restoreAllMocks(); restoreGate(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "bootstrap-upgrade-")); roots.push(root); return root; };

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");
const witnessFile = (paths: AppPaths) => join(securityFenceRoot(canonical(paths)), "witness.json");
/** What a refused apply must leave as it was: database and WAL bytes, the witness and the plan file. A missing and an empty WAL are the same state. */
const files = (paths: AppPaths) => {
  const wal = `${paths.databasePath}-wal`;
  return { database: sha(readFileSync(paths.databasePath)), wal: !existsSync(wal) || lstatSync(wal).size === 0 ? "empty" : sha(readFileSync(wal)),
    witness: existsSync(witnessFile(paths)) ? readFileSync(witnessFile(paths), "utf8") : "missing",
    plan: existsSync(upgradePlanPath(canonical(paths))) ? readFileSync(upgradePlanPath(canonical(paths)), "utf8") : "missing" };
};
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
const OPTIONS = (directory: string) => ({ directory, applicationVersion: "0.0.0-fixture" });
async function failure(operation: () => Promise<unknown>) {
  try { await operation(); } catch (error) {
    const { name, code, nextStep, committed, state, message } = error as { name: string; code: string; nextStep: string; committed: boolean; state?: string; message: string };
    return { name, code, nextStep, committed, state, message };
  }
  throw new Error("expected a refusal");
}

/** A fenced schema-49 installation (trusted witness): upgrade needed. */
function installation() {
  const paths = resolveAppPaths(join(temporary(), "data"));
  new SqliteStateStore(paths.databasePath).close();
  return paths;
}
/** Schema 52 with the marker pending, as an operator reaches it: `auth fence resume` at target 52. */
function pending52() {
  const paths = installation();
  rmSync(witnessFile(paths));
  const preflight = maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET).preflight;
  expect(maintainSqliteSecurityFence(paths, { action: "resume", expect: preflight, mode: "token" }, HANDOFF, TARGET)).toMatchObject({ trusted: true, quarantined: true, schemaVersion: 52 });
  return paths;
}
/** The tree is a valid private backup at the target ceiling holding `schemaVersion`; returns its manifest. */
function validTree(root: string, schemaVersion: number) {
  const manifest = parseManifest(readBoundedJson(join(root, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), TARGET);
  validateBackup(root, manifest, true, TARGET);
  expect(manifest).toMatchObject({ applicationVersion: "0.0.0-fixture", database: { schemaVersion } });
  const copy = new Database(join(root, "state.sqlite3"), { readonly: true, fileMustExist: true });
  try { expect(inspectSchema(copy, TARGET).version).toBe(schemaVersion); } finally { copy.close(); }
  return manifest;
}

describe("upgrade bootstrap composition", () => {
  it("upgrades a fenced schema-49 database with a validated pre-upgrade-v49 backup in the given directory, and answers already applied without a second one", async () => {
    const paths = installation(), directory = join(temporary(), "operator", "backups");
    const inspection = inspectUpgrade(paths, undefined, TARGET);
    expect(inspection).toMatchObject({ state: "upgrade_needed", nextStep: "upgrade apply", schemaVersion: 49, target: TARGET, marker: "absent", planHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const result = await applyUpgrade(paths, { expect: inspection.planHash! }, OPTIONS(directory), TARGET);
    expect(result).toMatchObject({ state: "current", alreadyApplied: false, planHash: inspection.planHash, receipt: expect.any(String), planRemoved: true, schemaVersion: TARGET });
    // The directory did not exist: the backup created it privately, and the tree is the result's.
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    const entries = readdirSync(directory);
    expect(entries).toEqual([expect.stringMatching(/^pre-upgrade-v49-[0-9a-f-]{36}$/)]);
    expect(result.backup).toBe(join(directory, entries[0]!));
    validTree(result.backup!, 49);
    expect(inspectUpgrade(paths, undefined, TARGET)).toMatchObject({ state: "current", schemaVersion: TARGET, marker: "complete", appliedPlan: inspection.planHash });
    // Applying the same plan again changes nothing and writes no backup.
    const before = files(paths);
    expect(await applyUpgrade(paths, { expect: inspection.planHash! }, OPTIONS(directory), TARGET))
      .toEqual({ state: "current", alreadyApplied: true, planHash: inspection.planHash, receipt: null, backup: null, planRemoved: true, schemaVersion: TARGET });
    expect(readdirSync(directory)).toEqual(entries);
    expect(files(paths)).toEqual(before);
  }, CYCLE);

  it("backs up a schema-52 source whose marker a resume set to pending, at the target ceiling", async () => {
    const paths = pending52(), directory = join(temporary(), "backups");
    const inspection = inspectUpgrade(paths, undefined, TARGET);
    expect(inspection).toMatchObject({ state: "upgrade_needed", schemaVersion: 52, marker: "pending", planHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const result = await applyUpgrade(paths, { expect: inspection.planHash! }, OPTIONS(directory), TARGET);
    expect(result).toMatchObject({ state: "current", alreadyApplied: false, schemaVersion: 52 });
    expect(readdirSync(directory)).toEqual([expect.stringMatching(/^pre-upgrade-v52-[0-9a-f-]{36}$/)]);
    validTree(result.backup!, 52);
  }, CYCLE);

  describe("a failed pre-upgrade backup", () => {
    const refused = { name: "UpgradeError", code: "upgrade_backup_failed", nextStep: "upgrade apply", committed: false, state: undefined };
    /** Inspect, a refused apply with `directory`, then the checks every case shares; returns the plan hash. */
    async function refusedApply(paths: AppPaths, directory: string) {
      const { planHash } = inspectUpgrade(paths, undefined, TARGET);
      const before = files(paths);
      const error = await failure(() => applyUpgrade(paths, { expect: planHash! }, OPTIONS(directory), TARGET));
      expect(error).toMatchObject(refused);
      // The message is the code's fixed text: no path.
      expect(error.message).not.toContain(directory);
      expect(error.message).not.toContain(paths.dataDirectory);
      // Database, WAL, witness and plan are as they were; the fence is still trusted.
      expect(files(paths)).toEqual(before);
      expect(inspectUpgrade(paths, undefined, TARGET)).toMatchObject({ state: "upgrade_needed", planHash });
      return planHash!;
    }

    it("is refused when the directory cannot be created, leaving nothing behind, and apply succeeds again with a usable one", async () => {
      const paths = installation(), root = temporary(), file = join(root, "not-a-directory");
      writeFileSync(file, "operator file", { mode: 0o600 });
      const planHash = await refusedApply(paths, join(file, "backups"));
      expect(readdirSync(root)).toEqual(["not-a-directory"]);
      expect(readFileSync(file, "utf8")).toBe("operator file");
      // Nothing is pending: the same plan applies with a usable directory.
      expect(await applyUpgrade(paths, { expect: planHash }, OPTIONS(join(root, "backups")), TARGET)).toMatchObject({ state: "current", alreadyApplied: false });
    }, CYCLE);

    it("is refused when the backup directory is a file, leaving the file as it was", async () => {
      const paths = installation(), root = temporary(), file = join(root, "backups");
      writeFileSync(file, "operator file", { mode: 0o600 });
      await refusedApply(paths, file);
      expect(readdirSync(root)).toEqual(["backups"]);
      expect(readFileSync(file, "utf8")).toBe("operator file");
    }, CYCLE);

    it("is refused when the destination already exists, leaving the existing entry and no partial tree", async () => {
      const paths = installation(), directory = join(temporary(), "backups"), uuid = "00000000-0000-4000-8000-00000000c011";
      const existing = join(directory, `pre-upgrade-v49-${uuid}`);
      mkdirSync(existing, { recursive: true, mode: 0o700 });
      writeFileSync(join(existing, "operator.txt"), "kept");
      // The refusal comes before the run's receipt, so the fixed UUID names only the destination.
      vi.spyOn(crypto, "randomUUID").mockReturnValue(uuid);
      await refusedApply(paths, directory);
      expect(readdirSync(directory)).toEqual([`pre-upgrade-v49-${uuid}`]);
      expect(readdirSync(existing)).toEqual(["operator.txt"]);
    }, CYCLE);
  });
});
