import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "../paths";
import { unmanagedFixtureDatabase } from "../unmanaged-sqlite-fixture";
import { providerAdminErrorBody } from "../modules/authentication";
import { securityFenceRoot } from "../infrastructure/sqlite/security-fence";
import { inspectSchema } from "../infrastructure/sqlite/schema-inspection";
import { parseManifest, readBoundedJson, validateBackup, BACKUP_LIMITS } from "../infrastructure/sqlite/backup-validation";
import { establishSecurityFenceWithBackup, maintainSecurityFence } from "./security-maintenance";

/*
 * Establishment with a pre-establishment backup through its bootstrap
 * composition, at the supported target: no provisional switch is needed, and
 * nothing outside tests calls it (provisional-schema.test.ts). Each test
 * migrates a schema-40 store and flushes files several times: explicit 30 s
 * timeouts, since the hosted runner is about twice as slow as a workstation.
 */
const CYCLE = 30_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "bootstrap-establish-")); roots.push(root); return root; };
const sha = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");

/** A schema-40 installation that never had a fence; `from` copies an existing one's database. */
function preFence(from?: AppPaths) {
  const paths = resolveAppPaths(join(temporary(), "data")); mkdirSync(paths.dataDirectory, { mode: 0o700 });
  if (from) copyFileSync(from.databasePath, paths.databasePath);
  else {
    const database = unmanagedFixtureDatabase(paths.databasePath);
    try { database.exec(readFileSync(new URL("../infrastructure/sqlite/fixtures/schema-v40.sql", import.meta.url), "utf8")); } finally { database.close(); }
  }
  chmodSync(paths.databasePath, 0o600);
  return paths;
}
/** The database, its WAL (missing and empty are the same state) and whether a fence directory exists. */
const untouched = (paths: AppPaths) => {
  const wal = `${paths.databasePath}-wal`;
  return { database: sha(paths.databasePath), wal: existsSync(wal) && lstatSync(wal).size > 0 ? sha(wal) : "empty", fence: existsSync(securityFenceRoot(canonical(paths))) };
};
const OPTIONS = (directory: string) => ({ directory, applicationVersion: "0.0.0-fixture" });
const establish = (paths: AppPaths, directory: string) =>
  establishSecurityFenceWithBackup(paths, { action: "establish", expect: maintainSecurityFence(paths, { action: "inspect" }).preflight }, OPTIONS(directory));

describe("fence establishment with a pre-establishment backup", () => {
  it("writes a validated pre-establishment-v40 tree and reports what establish without a backup reports, plus the tree", async () => {
    const paths = preFence(), twin = preFence(paths), directory = join(temporary(), "backups");
    const result = await establish(paths, directory);
    const plain = maintainSecurityFence(twin, { action: "establish", expect: maintainSecurityFence(twin, { action: "inspect" }).preflight });
    // Only the preflight hash (it binds the database path and the new checkpoint) and the receipt are per run.
    const { backup, ...established } = result;
    const comparable = (value: Record<string, unknown>) => ({ ...value, preflight: "<preflight>", receipt: "<receipt>" });
    expect(comparable(established)).toEqual(comparable(plain));
    expect(established).toMatchObject({ code: "security_fence_current", trusted: true, changed: true, quarantined: false, schemaVersion: 49 });
    const entries = readdirSync(directory);
    expect(entries).toEqual([expect.stringMatching(/^pre-establishment-v40-[0-9a-f-]{36}$/)]);
    expect(backup).toBe(join(directory, entries[0]!));
    const manifest = parseManifest(readBoundedJson(join(backup!, "manifest.json"), BACKUP_LIMITS.manifestBytes, true));
    validateBackup(backup!, manifest, true);
    expect(manifest).toMatchObject({ applicationVersion: "0.0.0-fixture", database: { schemaVersion: 40 } });
    const copy = new Database(join(backup!, "state.sqlite3"), { readonly: true, fileMustExist: true });
    try { expect(inspectSchema(copy).version).toBe(40); } finally { copy.close(); }
    // The trusted no-op takes no backup.
    expect(await establish(paths, directory)).toMatchObject({ trusted: true, changed: false, backup: null });
    expect(readdirSync(directory)).toEqual(entries);
  }, CYCLE);

  it("refuses a failed backup as security_fence_backup_failed with the database and the absent witness unchanged, and establishes on the next run", async () => {
    const paths = preFence(), root = temporary(), file = join(root, "backups");
    writeFileSync(file, "operator file", { mode: 0o600 });
    const before = untouched(paths);
    expect(before.fence).toBe(false);
    let error: unknown;
    try { await establish(paths, file); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ name: "SecurityFenceBackupError", code: "security_fence_backup_failed", committed: false,
      message: "security_fence_backup_failed: The pre-establishment backup failed; nothing was changed. Run protected offline auth fence inspect, then establish again with its current preflight." });
    // The operator's body is the new fixed message, without a path.
    expect(providerAdminErrorBody(error)).toEqual({ code: "security_fence_backup_failed",
      error: "The pre-establishment backup failed; nothing was changed. Run auth fence inspect, then establish again." });
    expect(JSON.stringify(providerAdminErrorBody(error))).not.toContain(root);
    expect(untouched(paths)).toEqual(before);
    expect(readdirSync(root)).toEqual(["backups"]);
    expect(readFileSync(file, "utf8")).toBe("operator file");
    // The database still needs establishment, which inspect reports with its own code.
    expect(maintainSecurityFence(paths, { action: "inspect" })).toMatchObject({ code: "security_fence_establishment_required", establishmentAllowed: true, schemaVersion: 40 });
    expect(await establish(paths, join(root, "usable"))).toMatchObject({ trusted: true, changed: true, backup: expect.stringContaining(join(root, "usable", "pre-establishment-v40-")) });
  }, CYCLE);
});
