import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "./migration-registry";
import { enableProvisionalSchema } from "./provisional-schema-gate";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { ProjectDirectoryQueries } from "./project-directory-queries";
import { normaliseMappingDecisions } from "./mapping-upgrade-acts";
import { normaliseAuthorityDecisions } from "./authority-upgrade-acts";
import { assertUpgradeAvailable, structuralSteps, upgradeTarget } from "./upgrade-plan";

/**
 * C3c-1: the fence base and the supported version are separate constants.
 *
 * Both are 49 until the activation raises SUPPORTED_SCHEMA_VERSION, so no test
 * against the real constants can tell them apart. This file runs the code with
 * the registry's supported version at 52 (what the activation sets) while
 * every other export of the registry is the real one: each module that imports
 * the supported version or `schemaTarget` sees 52, and `schemaTarget` here is
 * built from the real `schemaTargetRange`, so its lower bound is the production
 * one. A fence-base use still tied to the supported version refuses 49, 50 or
 * 51 below; the first describe shows that the real `schemaTarget` is exactly
 * this construction at the real supported version.
 */
// Hoisted with the mock below, which runs before the module's other top-level code.
const { ACTIVATED, UNSUPPORTED, checked } = vi.hoisted(() => {
  const unsupported = "Unsupported schema target.";
  return {
    ACTIVATED: 52,
    UNSUPPORTED: unsupported,
    /** `schemaTarget`'s check over a range: the same comparison as migration-registry.ts. */
    checked(range: { lowest: number; highest: number; fallback: number }, target?: number): number {
      const value = target === undefined ? range.fallback : target;
      if (!Number.isSafeInteger(value) || value < range.lowest || value > range.highest) throw new Error(unsupported);
      return value;
    },
  };
});
vi.mock("./migration-registry", async original => {
  const actual = await original<typeof import("./migration-registry")>();
  // After the activation the switch no longer matters: the supported version is the provisional one.
  return { ...actual, SUPPORTED_SCHEMA_VERSION: ACTIVATED, schemaTarget: (target?: number) => checked(actual.schemaTargetRange(ACTIVATED, false), target) };
});

let restoreGate: (() => void) | undefined;
afterEach(() => { restoreGate?.(); restoreGate = undefined; });
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } return "accepted"; };
const at = (target: number) => (database: Database.Database) => { inspectSchema(database, target); };
const freshAt = (target?: number) => {
  const database = new Database(":memory:");
  initializeSchema(database, true, target === undefined ? inspectSchema : at(target), { target });
  return database;
};

describe("the real schema target is the range check at the real supported version", () => {
  it("keeps both constants at 49 and the fence base as the lowest bound of every range", async () => {
    const actual = await vi.importActual<typeof import("./migration-registry")>("./migration-registry");
    expect(actual.SUPPORTED_SCHEMA_VERSION).toBe(49);
    expect(actual.SECURITY_FENCE_SCHEMA_VERSION).toBe(49);
    expect(actual.PROVISIONAL_SCHEMA_VERSION).toBe(52);
    expect(actual.schemaTargetRange(49, false)).toEqual({ lowest: 49, highest: 49, fallback: 49 });
    expect(actual.schemaTargetRange(49, true)).toEqual({ lowest: 49, highest: 52, fallback: 49 });
    // The activation's supported version: the lowest bound stays the fence base.
    expect(actual.schemaTargetRange(52, false)).toEqual({ lowest: 49, highest: 52, fallback: 52 });
    expect(actual.schemaTargetRange(52, true)).toEqual({ lowest: 49, highest: 52, fallback: 52 });
  });

  it.each([false, true])("gives the real schemaTarget's result for every value with the switch %s", async provisional => {
    const actual = await vi.importActual<typeof import("./migration-registry")>("./migration-registry");
    if (provisional) restoreGate = enableProvisionalSchema();
    const range = actual.schemaTargetRange(actual.SUPPORTED_SCHEMA_VERSION, provisional);
    for (const value of [undefined, 47, 48, 49, 50, 51, 52, 53, 49.5, Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number]) {
      expect(message(() => actual.schemaTarget(value)), String(value)).toBe(message(() => checked(range, value)));
    }
    expect(actual.schemaTarget()).toBe(49);
  });
});

describe("with the supported version at 52 (simulated activation)", () => {
  it("accepts the explicit targets 49 to 52, defaults to 52 and refuses outside them", () => {
    expect(registry.SUPPORTED_SCHEMA_VERSION).toBe(ACTIVATED);
    expect(registry.SECURITY_FENCE_SCHEMA_VERSION).toBe(49);
    expect(registry.schemaTarget()).toBe(52);
    for (const target of [49, 50, 51, 52]) expect(registry.schemaTarget(target)).toBe(target);
    for (const invalid of [48, 53]) expect(() => registry.schemaTarget(invalid)).toThrow(UNSUPPORTED);
  });

  it("plans the structural steps from the fence base 49 and from 50 and 51, not only from the supported version", () => {
    expect(structuralSteps(49, 52).map(step => step.version)).toEqual([50, 51, 52]);
    expect(structuralSteps(50, 52).map(step => step.version)).toEqual([51, 52]);
    expect(structuralSteps(51, 52).map(step => step.version)).toEqual([52]);
    expect(structuralSteps(52, 52)).toEqual([]);
    expect(structuralSteps(49, 50).map(step => step.version)).toEqual([50]);
    expect(() => structuralSteps(48, 52)).toThrowError(expect.objectContaining({ code: "upgrade_step_mismatch" }));
  });

  it("defaults the upgrade to 52, accepts the explicit targets 50 and 51, and keeps the upgrade and the step domains available", () => {
    expect(upgradeTarget()).toBe(52);
    expect(upgradeTarget(50)).toBe(50);
    expect(upgradeTarget(51)).toBe(51);
    // Below the marker step the upgrade has nothing to do, whatever is supported.
    expect(() => upgradeTarget(49)).toThrowError(expect.objectContaining({ code: "upgrade_unsupported" }));
    expect(() => assertUpgradeAvailable()).not.toThrow();
    // Each step's availability check passes the step's own version through schemaTarget.
    expect(normaliseMappingDecisions({})).toEqual(expect.any(Object));
    expect(normaliseAuthorityDecisions({})).toEqual(expect.any(Object));
    const database = freshAt(51);
    try { expect(() => new ProjectDirectoryQueries(database)).not.toThrow(); } finally { database.close(); }
  });

  it("creates and recognises a database at each explicit target 49 to 51, and at 52 by default", () => {
    for (const target of [49, 50, 51, 52, undefined]) {
      const database = freshAt(target);
      try {
        // Steps 50 to 52 check their own availability inside initializeSchema.
        expect(inspectSchema(database, target ?? 52), String(target)).toEqual({ version: target ?? 52, fresh: false });
        if (target !== undefined && target < 52) expect(message(() => inspectSchema(database, target + 1))).toBe("accepted");
      } finally { database.close(); }
    }
  });
});
