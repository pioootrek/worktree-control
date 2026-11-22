import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths } from "../../paths";
import { schemaTarget, SECURITY_FENCE_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { ProjectDirectoryQueries } from "./project-directory-queries";
import { normaliseMappingDecisions } from "./mapping-upgrade-acts";
import { normaliseAuthorityDecisions } from "./authority-upgrade-acts";
import { structuralSteps, upgradeTarget } from "./upgrade-plan";
import { OwnedSqliteDatabase } from "./owned-database";
import { SecurityFence } from "./security-fence";
import { inspectSqliteUpgrade } from "./upgrade-maintenance";
import { createFencedAt49, schemaAt49 } from "./fixtures/released-schema";

/**
 * The fence base (49, a released fact) and the supported version (53, what this
 * release creates and runs) are separate constants. These tests run against the
 * real ones: every use that means "the fence's base" accepts 49 to 52, and every
 * default is the supported version.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const UNSUPPORTED = "Unsupported schema target.";
const installationPaths = () => { const root = mkdtempSync(join(tmpdir(), "schema-separation-")); roots.push(root); return resolveAppPaths(join(root, "data")); };
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } return "accepted"; };
const at = (target: number) => (database: Database.Database) => { inspectSchema(database, target); };
const freshAt = (target?: number) => {
  const database = new Database(":memory:");
  initializeSchema(database, true, target === undefined ? inspectSchema : at(target), { target });
  return database;
};

describe("the schema target with the supported version at 53", () => {
  it("keeps the fence base at 49, accepts the explicit targets 49 to 53, defaults to 53 and refuses outside them", () => {
    expect(SECURITY_FENCE_SCHEMA_VERSION).toBe(49);
    expect(SUPPORTED_SCHEMA_VERSION).toBe(53);
    expect(schemaTarget()).toBe(53);
    for (const target of [49, 50, 51, 52, 53]) expect(schemaTarget(target)).toBe(target);
    for (const invalid of [47, 48, 54, 49.5, Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number]) expect(message(() => schemaTarget(invalid)), String(invalid)).toBe(UNSUPPORTED);
  });

  it("plans the structural steps from the fence base 49 and from 50 to 52, not only from the supported version", () => {
    expect(structuralSteps(49, 53).map(step => step.version)).toEqual([50, 51, 52, 53]);
    expect(structuralSteps(50, 53).map(step => step.version)).toEqual([51, 52, 53]);
    expect(structuralSteps(51, 53).map(step => step.version)).toEqual([52, 53]);
    expect(structuralSteps(52, 53).map(step => step.version)).toEqual([53]);
    expect(structuralSteps(53, 53)).toEqual([]);
    expect(structuralSteps(49, 50).map(step => step.version)).toEqual([50]);
    expect(() => structuralSteps(48, 53)).toThrowError(expect.objectContaining({ code: "upgrade_step_mismatch" }));
  });

  it("defaults the upgrade to 53, accepts the explicit targets 50 to 52, refuses 49 and 54, and keeps the step domains available", () => {
    expect(upgradeTarget()).toBe(53);
    for (const target of [50, 51, 52]) expect(upgradeTarget(target)).toBe(target);
    // Below the marker step the upgrade has nothing to do; above the supported version nothing is known.
    for (const target of [49, 54]) expect(() => upgradeTarget(target)).toThrowError(expect.objectContaining({ code: "upgrade_unsupported" }));
    // Each step's availability check passes the step's own version through schemaTarget.
    expect(normaliseMappingDecisions({})).toEqual(expect.any(Object));
    expect(normaliseAuthorityDecisions({})).toEqual(expect.any(Object));
    const database = freshAt(51);
    try { expect(() => new ProjectDirectoryQueries(database)).not.toThrow(); } finally { database.close(); }
  });

  it("creates and recognises a database at each explicit target 49 to 52, and at 53 by default", () => {
    for (const target of [49, 50, 51, 52, 53, undefined]) {
      const database = freshAt(target);
      try {
        expect(inspectSchema(database, target ?? 53), String(target)).toEqual({ version: target ?? 53, fresh: false });
        // Every lower database is recognised at the default ceiling.
        expect(inspectSchema(database)).toEqual({ version: target ?? 53, fresh: false });
        if (target !== undefined && target < 53) expect(message(() => inspectSchema(database, target + 1))).toBe("accepted");
      } finally { database.close(); }
    }
  });
});

describe("the released schema-49 fixtures", () => {
  it("build schema 49 on a raw connection and as a fenced database the fence trusts", () => {
    const database = schemaAt49(new Database(":memory:"));
    try { expect(inspectSchema(database)).toEqual({ version: 49, fresh: false }); } finally { database.close(); }
    const paths = installationPaths();
    createFencedAt49(paths.databasePath);
    const owner = new OwnedSqliteDatabase(paths.databasePath, false, undefined, { inspectOnly: true });
    try {
      expect(owner.inspection).toEqual({ version: 49, fresh: false });
      expect(() => SecurityFence.inspect(owner.canonicalPath, owner.database, false)).not.toThrow();
    } finally { owner.close(); }
  });

  it("upgrades a fenced schema-49 fixture at the default target 53 through every step from the fence base", () => {
    const paths = installationPaths();
    createFencedAt49(paths.databasePath);
    const status = inspectSqliteUpgrade(paths);
    expect(status).toMatchObject({ state: "upgrade_needed", schemaVersion: 49, target: 53, marker: "absent" });
    expect(status.plan!.steps.map(step => step.version)).toEqual([50, 51, 52, 53]);
  }, 30_000);
});
