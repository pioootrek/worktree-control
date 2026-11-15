import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppPaths } from "../../paths";
import { PROVISIONAL_SCHEMA_VERSION, schemaTarget, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { enableProvisionalSchema, provisionalSchemaEnabled } from "./provisional-schema-gate";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { OwnedSqliteDatabase } from "./owned-database";
import { maintainSqliteSecurityFence, quarantineAuthority } from "./security-maintenance";
import { hashFile, parseManifest, validateBackup, validateSnapshot } from "./backup-validation";
import { applyUpgradeMarkerMigration } from "./upgrade-marker-migration";
import { applySqliteUpgrade, inspectSqliteUpgrade } from "./upgrade-maintenance";
import { upgradeTarget, UpgradeError } from "./upgrade-plan";

/**
 * Provisional schema steps stay switched off (C1b).
 *
 * The gate: `schemaTarget` refuses every target or ceiling above
 * SUPPORTED_SCHEMA_VERSION unless the process-wide switch of
 * `provisional-schema-gate.ts` is on. Every target and ceiling passes through
 * `schemaTarget`, so an alias, re-export, wrapper or computed call of an entry
 * point gains nothing while the switch is off; the entry-point test below shows
 * that for each public entry point. Activation raises SUPPORTED_SCHEMA_VERSION,
 * which fails the first test, so it is a visible edit of this file.
 *
 * The guard: only tests may turn the switch on. No non-test source file under
 * `src/` (extensions in SOURCE_EXTENSIONS, names not matching TEST_FILE) may
 * import the gate module, except GATE_READER with a static named import of the
 * read function only, so it cannot turn the switch on or pass the setter on.
 * Recognised forms: static import (including type-only and side-effect),
 * `export ... from`, `import x = require()`, `import("...")` types, and
 * `import()` / `require()` calls with a literal specifier. Relative, `@/`,
 * absolute and `file:` specifiers are resolved to a file, lexically and by real
 * path, so a different file of the same name elsewhere is not a finding. A
 * second rule confines imports of the provisional step modules (STEP_MODULES)
 * to STEP_IMPORTERS.
 *
 * Limits, not covered here:
 * - non-literal specifiers (`import(name)`, `require(name)`, `createRequire`
 *   results, `eval`, `new Function`); `unmounted.test.ts` in
 *   `src/server/modules/operations` refuses them under `src` outside its own
 *   allow-list;
 * - files outside `src/` (scripts, tests, packages), test files, and files that
 *   are not scripts (JSON, Markdown, CSS); a symbolic link to the gate is
 *   resolved only when the link exists on disk;
 * - module specifiers that a bundler or loader resolves other than through the
 *   `@/` alias and relative paths; and code that reaches the module's state
 *   without importing it (the switch is a module-local variable, not a global);
 * - whether a test restores the switch: each test file does so in its teardown
 *   by convention, and Vitest isolates module state per test file.
 */
const GATE = "src/server/infrastructure/sqlite/provisional-schema-gate.ts";
const GATE_READER = "src/server/infrastructure/sqlite/migration-registry.ts";
/** The only non-test files that may import the gate, each with its reason. */
const GATE_IMPORTERS: Readonly<Record<string, string>> = Object.freeze({
  [GATE_READER]: "reads the switch in schemaTarget, through a static import of provisionalSchemaEnabled only",
});
const READ_FUNCTION = "provisionalSchemaEnabled";
const STEP_MODULES = Object.freeze(["src/server/infrastructure/sqlite/upgrade-marker-migration.ts", "src/server/infrastructure/sqlite/security-coverage.ts"]);
const STEP_IMPORTERS: Readonly<Record<string, string>> = Object.freeze({
  "src/server/infrastructure/sqlite/security-coverage.ts": "lists the fence coverage of each step, including step 50",
  "src/server/infrastructure/sqlite/migrations.ts": "applies step 50 when initializeSchema is given the target",
  "src/server/infrastructure/sqlite/schema-inspection.ts": "recognises step 50 and builds its reference at the ceiling",
  "src/server/infrastructure/sqlite/fixtures/schema-rewind.ts": "rewinds a synthetic step-50 fixture",
  "src/server/infrastructure/sqlite/upgrade-plan.ts": "names step 50 and its checksum among the structural steps an upgrade plan lists",
});
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];
/** An emitted-style specifier (`./x.js`) that TypeScript resolves to its source. */
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const repository = resolve(".");

interface ModuleImport { specifier: string; form: string; line: number; readOnly: boolean }

/** Every literal module specifier of a source text, with its form. */
function moduleImports(fileName: string, text: string): ModuleImport[] {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: ModuleImport[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      // Read-only: a value import of named bindings that are all the read function.
      const clause = node.importClause, bindings = clause?.namedBindings;
      const readOnly = Boolean(clause && !clause.isTypeOnly && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every(element => !element.isTypeOnly && (element.propertyName ?? element.name).text === READ_FUNCTION));
      found.push({ specifier: node.moduleSpecifier.text, form: "import", line: line(node), readOnly });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, form: "re-export", line: line(node), readOnly: false });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, form: "import = require()", line: line(node), readOnly: false });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, form: "import() type", line: line(node), readOnly: false });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression, first = node.arguments[0];
      const form = callee.kind === ts.SyntaxKind.ImportKeyword ? "import()" : ts.isIdentifier(callee) && callee.text === "require" ? "require()" : undefined;
      if (form && first && ts.isStringLiteralLike(first)) found.push({ specifier: first.text, form, line: line(node), readOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function realOrSelf(path: string): string { try { return realpathSync(path); } catch { return path; } }

/** Whether a literal specifier written in `fromFile` (repository-relative) resolves to `target` (repository-relative). */
function reaches(fromFile: string, specifier: string, target: string): boolean {
  let base: string;
  if (specifier.startsWith("file:")) { try { base = fileURLToPath(specifier); } catch { return false; } }
  else if (specifier === "@" || specifier.startsWith("@/")) base = join(repository, "src", specifier.slice(2));
  else if (specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../")) base = resolve(repository, dirname(fromFile), specifier);
  else if (isAbsolute(specifier)) base = resolve(specifier);
  else return false;
  // Lexically, as written (this also covers in-memory fixtures), then by real path on disk.
  const name = relative(repository, base).split(sep).join(posix.sep);
  const targetBase = target.replace(SCRIPT_EXTENSION, "");
  if (name === target || name.replace(SCRIPT_EXTENSION, "") === targetBase) return true;
  const real = realOrSelf(join(repository, target));
  return [base, base.replace(SCRIPT_EXTENSION, "")].some(candidate => RESOLVE_EXTENSIONS.some(extension => {
    const path = candidate + extension;
    return existsSync(path) && realOrSelf(path) === real;
  }));
}

/** Gate imports a non-test source file may not make. */
function gateFindings(fileName: string, text: string): string[] {
  return moduleImports(fileName, text).filter(entry => reaches(fileName, entry.specifier, GATE))
    .filter(entry => !(fileName in GATE_IMPORTERS && entry.form === "import" && entry.readOnly))
    .map(entry => `${entry.form} of ${entry.specifier} at line ${entry.line}`);
}
/** Imports of a provisional step module (outside STEP_IMPORTERS these are violations). */
function stepImports(fileName: string, text: string): string[] {
  return moduleImports(fileName, text).filter(entry => STEP_MODULES.some(step => reaches(fileName, entry.specifier, step)))
    .map(entry => `${entry.form} of ${entry.specifier} at line ${entry.line}`);
}

function sources(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !TEST_FILE.test(entry.name)) files.push(path);
    }
  };
  walk(join(repository, "src"));
  return files.map(file => relative(repository, file).split(sep).join("/")).sort();
}

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (operation: () => unknown) => { try { operation(); } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };
const UNSUPPORTED = "Unsupported schema target.";
/** A private data directory with a schema-49 database, a backup tree of it and its manifest. */
function current49() {
  const root = mkdtempSync(join(tmpdir(), "provisional-gate-")); temporary.push(root);
  const paths = resolveAppPaths(join(root, "data")); mkdirSync(paths.dataDirectory, { mode: 0o700 });
  const database = new Database(paths.databasePath);
  try { initializeSchema(database, undefined, inspectSchema); } finally { database.close(); }
  chmodSync(paths.databasePath, 0o600);
  const backup = join(root, "backup"); mkdirSync(join(backup, "attachments"), { recursive: true });
  const snapshot = join(backup, "state.sqlite3");
  writeFileSync(snapshot, readFileSync(paths.databasePath));
  const manifest = { formatVersion: 1, applicationVersion: "test", createdAt: new Date().toISOString(),
    database: { file: "state.sqlite3", ...hashFile(snapshot), schemaVersion: 49 }, attachments: [] };
  writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest));
  return { paths, backup, snapshot, manifest };
}
const HANDOFF = { preflight: () => undefined, acknowledge: () => undefined };
const UNUSED_BACKUP = async (): Promise<never> => { throw new Error("fixture backup must not run"); };

describe("provisional schema steps stay switched off", () => {
  it("keeps schema 49 supported, step 50 provisional and the switch off by default", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(49);
    expect(PROVISIONAL_SCHEMA_VERSION).toBe(50);
    expect(provisionalSchemaEnabled()).toBe(false);
    expect(schemaTarget()).toBe(49);
    expect(schemaTarget(49)).toBe(49);
    expect(() => schemaTarget(50)).toThrow(UNSUPPORTED);
    for (const invalid of [48, 51, 49.5, Number.NaN]) expect(() => schemaTarget(invalid)).toThrow(UNSUPPORTED);
  });

  it("refuses target or ceiling 50 at every public entry point while the switch is off, with the unsupported-target error", () => {
    expect(provisionalSchemaEnabled()).toBe(false);
    const fixture = current49();
    const memory = new Database(":memory:"), current = new Database(fixture.paths.databasePath, { readonly: true });
    try {
      const refusals = {
        schemaTarget: () => schemaTarget(50),
        initializeSchema: () => initializeSchema(memory, undefined, undefined, { target: 50 }),
        applyUpgradeMarkerMigration: () => applyUpgradeMarkerMigration(memory, true),
        inspectSchema: () => inspectSchema(current, 50),
        OwnedSqliteDatabase: () => new OwnedSqliteDatabase(fixture.paths.databasePath, false, 50),
        maintainSqliteSecurityFence: () => maintainSqliteSecurityFence(fixture.paths, { action: "inspect" }, HANDOFF, 50),
        quarantineAuthority: () => quarantineAuthority(memory, "receipt", "token", 50),
        parseManifest: () => parseManifest({ ...fixture.manifest, database: { ...fixture.manifest.database, schemaVersion: 50 } }, 50),
        validateSnapshot: () => validateSnapshot(fixture.snapshot, parseManifest(fixture.manifest), 50),
        validateBackup: () => validateBackup(fixture.backup, parseManifest(fixture.manifest), false, 50),
        upgradeTarget: () => upgradeTarget(50),
        inspectSqliteUpgrade: () => inspectSqliteUpgrade(fixture.paths, 50),
        applySqliteUpgrade: () => applySqliteUpgrade(fixture.paths, { expect: "0".repeat(64) }, UNUSED_BACKUP, 50),
      };
      const unsupported = message(() => schemaTarget(51));
      expect(unsupported).toBe(UNSUPPORTED);
      for (const [entry, refusal] of Object.entries(refusals)) expect(message(refusal), entry).toBe(unsupported);
      // Nothing was applied: the empty database stays empty, the schema-49 one unchanged.
      expect(memory.prepare("SELECT count(*) FROM sqlite_master").pluck().get()).toBe(0);
      expect(inspectSchema(current)).toEqual({ version: 49, fresh: false });
      // The upgrade needs step 50: at the default target it is unsupported too, with
      // its own code, and neither refusal took a lock or wrote a plan directory.
      for (const refusal of [() => inspectSqliteUpgrade(fixture.paths), () => applySqliteUpgrade(fixture.paths, { expect: "0".repeat(64) }, UNUSED_BACKUP),
        () => inspectSqliteUpgrade(fixture.paths, 50), () => applySqliteUpgrade(fixture.paths, { expect: "0".repeat(64) }, UNUSED_BACKUP, 50)]) {
        expect(refusal).toThrowError(expect.objectContaining({ name: "UpgradeError", code: "upgrade_unsupported", message: unsupported }));
      }
      expect(new UpgradeError("upgrade_unsupported", "none").message).toBe(unsupported);
      expect(existsSync(`${fixture.paths.databasePath}.upgrade`)).toBe(false);
      expect(existsSync(fixture.paths.controllerLockPath)).toBe(false);
    } finally { memory.close(); current.close(); }
    // The same entry points accept the default, so the refusal is the target's.
    const owner = new OwnedSqliteDatabase(fixture.paths.databasePath);
    try { expect(owner.inspection.version).toBe(49); } finally { owner.close(); }
    expect(() => validateBackup(fixture.backup, parseManifest(fixture.manifest))).not.toThrow();
  });

  it("finds no gate import outside the reader, and no step-module import outside the listed files", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(GATE);
    const read = (file: string) => readFileSync(join(repository, file), "utf8");
    expect(files.flatMap(file => gateFindings(file, read(file)).map(finding => `${file}: ${finding}`))).toEqual([]);
    expect(files.filter(file => !(file in STEP_IMPORTERS)).flatMap(file => stepImports(file, read(file)).map(finding => `${file}: ${finding}`))).toEqual([]);
  });

  it("lists only existing files that need the exception", () => {
    for (const file of [GATE, ...STEP_MODULES]) expect(existsSync(join(repository, file)), file).toBe(true);
    for (const [file, reason] of Object.entries(GATE_IMPORTERS)) {
      expect(reason.length).toBeGreaterThan(10);
      const text = readFileSync(join(repository, file), "utf8");
      expect(moduleImports(file, text).filter(entry => reaches(file, entry.specifier, GATE)).map(entry => [entry.form, entry.readOnly]), file).toEqual([["import", true]]);
    }
    for (const [file, reason] of Object.entries(STEP_IMPORTERS)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(stepImports(file, readFileSync(join(repository, file), "utf8")).length, file).toBeGreaterThan(0);
    }
  });

  it("reports every literal import form of the gate, resolved to the file, and not a namesake elsewhere", () => {
    const strip = (findings: string[]) => findings.map(entry => entry.replace(/ at line \d+$/, ""));
    const outside = "src/server/infrastructure/example.ts";
    expect(strip(gateFindings(outside, [
      'import { enableProvisionalSchema as on } from "./sqlite/provisional-schema-gate";',
      'import * as gate from "@/server/infrastructure/sqlite/provisional-schema-gate";',
      'import "./sqlite/provisional-schema-gate.ts";',
      'import type { provisionalSchemaEnabled } from "./sqlite/provisional-schema-gate.js";',
      'export * from "../infrastructure/sqlite/provisional-schema-gate";',
      'export { enableProvisionalSchema as enable } from "@/server/infrastructure/sqlite/provisional-schema-gate";',
      'const lazy = import("./sqlite/provisional-schema-gate");',
      'const loaded = require("./sqlite/provisional-schema-gate");',
      'import gate2 = require("./sqlite/provisional-schema-gate");',
      'type Gate = typeof import("./sqlite/provisional-schema-gate");',
      `import { enableProvisionalSchema } from "${join(repository, GATE)}";`,
    ].join("\n")))).toEqual([
      "import of ./sqlite/provisional-schema-gate", "import of @/server/infrastructure/sqlite/provisional-schema-gate",
      "import of ./sqlite/provisional-schema-gate.ts", "import of ./sqlite/provisional-schema-gate.js",
      "re-export of ../infrastructure/sqlite/provisional-schema-gate", "re-export of @/server/infrastructure/sqlite/provisional-schema-gate",
      "import() of ./sqlite/provisional-schema-gate", "require() of ./sqlite/provisional-schema-gate",
      "import = require() of ./sqlite/provisional-schema-gate", "import() type of ./sqlite/provisional-schema-gate",
      `import of ${join(repository, GATE)}`,
    ]);
    // The reader may import the read function only, statically and by name.
    expect(strip(gateFindings(GATE_READER, [
      'import { provisionalSchemaEnabled } from "./provisional-schema-gate";',
      'import { provisionalSchemaEnabled as enabled } from "./provisional-schema-gate";',
      'import { provisionalSchemaEnabled, enableProvisionalSchema } from "./provisional-schema-gate";',
      'import * as gate from "./provisional-schema-gate";',
      'export { provisionalSchemaEnabled, enableProvisionalSchema } from "./provisional-schema-gate";',
      'const lazy = import("./provisional-schema-gate");',
    ].join("\n")))).toEqual([
      "import of ./provisional-schema-gate", "import of ./provisional-schema-gate", "re-export of ./provisional-schema-gate", "import() of ./provisional-schema-gate",
    ]);
    // Not findings: a namesake in another directory, a longer name, a package, and (a stated limit) a non-literal specifier.
    expect(gateFindings("src/server/modules/example.ts", [
      'import { enableProvisionalSchema } from "./provisional-schema-gate";',
      'import { notes } from "../infrastructure/sqlite/provisional-schema-gate-notes";',
      'import { gate } from "provisional-schema-gate";',
      'const specifier = "../infrastructure/sqlite/provisional-schema-gate"; const lazy = import(specifier);',
    ].join("\n"))).toEqual([]);
  });

  it("reports imports of the provisional step modules by resolved file", () => {
    expect(stepImports("src/server/example.ts", [
      'import { applyUpgradeMarkerMigration as apply } from "./infrastructure/sqlite/upgrade-marker-migration";',
      'export * from "@/server/infrastructure/sqlite/security-coverage";',
      'const lazy = import("./infrastructure/sqlite/upgrade-marker-migration.js");',
      'import { other } from "./upgrade-marker-migration";',
    ].join("\n")).map(entry => entry.replace(/ at line \d+$/, ""))).toEqual([
      "import of ./infrastructure/sqlite/upgrade-marker-migration", "re-export of @/server/infrastructure/sqlite/security-coverage",
      "import() of ./infrastructure/sqlite/upgrade-marker-migration.js",
    ]);
  });

  describe("with the switch on", () => {
    let restore: () => void;
    beforeEach(() => { restore = enableProvisionalSchema(); });
    afterEach(() => { restore(); });

    it("accepts target 50, still refuses anything above it, and restores the previous state", () => {
      expect(provisionalSchemaEnabled()).toBe(true);
      expect(schemaTarget()).toBe(49);
      expect(schemaTarget(50)).toBe(50);
      for (const invalid of [48, 51, 49.5, Number.NaN]) expect(() => schemaTarget(invalid)).toThrow(UNSUPPORTED);
      // Nested use restores the outer state, not "off".
      const inner = enableProvisionalSchema();
      inner();
      expect(provisionalSchemaEnabled()).toBe(true);
    });
  });
});
