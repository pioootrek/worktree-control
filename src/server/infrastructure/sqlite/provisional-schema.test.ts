import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { establishSqliteSecurityFence, maintainSqliteSecurityFence, quarantineAuthority } from "./security-maintenance";
import { hashFile, parseManifest, validateBackup, validateSnapshot } from "./backup-validation";
import { applyUpgradeMarkerMigration } from "./upgrade-marker-migration";
import { applyMappingQuarantine, applyProjectMappingMigration, planMappingQuarantine, projectMappingViolation } from "./mapping-structure-migration";
import { accountGrantsViolation, applyAccountGrantsMigration, clearAccountGrants } from "./account-grants-migration";
import { AUTHORITY_ACT_DOMAIN, normaliseAuthorityDecisions, proposeAuthority } from "./authority-upgrade-acts";
import { cancelRemoteWork, interruptTestRuns, releaseReservations, revokeCredentials, revokeOldGrants } from "./authority-reset";
import { ProjectDirectoryQueries } from "./project-directory-queries";
import { applySqliteUpgrade, inspectSqliteUpgrade } from "./upgrade-maintenance";
import {
  assertUpgradeAvailable, executeUpgradeActs, normaliseUpgradeDecisions, proposeUpgrade, readUpgradePlan, removeUpgradePlan, structuralSteps, upgradeTarget, UpgradeError,
  validateUpgradeProposal, writeUpgradePlan,
} from "./upgrade-plan";
import { MAPPING_ACT_DOMAIN, normaliseMappingDecisions, proposeProjectMapping } from "./mapping-upgrade-acts";
import { SecurityFence } from "./security-fence";

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
 * to the importer and module pairs of STEP_IMPORTS: each listed file may import
 * only the step modules listed for it, and no non-test file may import the
 * project directory. STEP_MODULES also holds the authority reset shared by the
 * quarantine and the upgrade (AUTHORITY_RESET): it is not provisional (the
 * schema-49 quarantine runs it with the switch off, so it has no gate), but its
 * revocations may be reached only through its two listed importers; and the
 * read-only predictor of the test-run recovery (RECOVERY_PREDICTION), whose
 * only importer is the authority acts: no other code may rely on its copies
 * of the recovery's rules.
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
const SQLITE = "src/server/infrastructure/sqlite";
const MARKER_STEP = `${SQLITE}/upgrade-marker-migration.ts`, COVERAGE = `${SQLITE}/security-coverage.ts`;
const MAPPING_STEP = `${SQLITE}/mapping-structure-migration.ts`, DIRECTORY = `${SQLITE}/project-directory-queries.ts`;
const MAPPING_ACTS = `${SQLITE}/mapping-upgrade-acts.ts`;
const GRANTS_STEP = `${SQLITE}/account-grants-migration.ts`, AUTHORITY_ACTS = `${SQLITE}/authority-upgrade-acts.ts`;
const AUTHORITY_RESET = `${SQLITE}/authority-reset.ts`, RECOVERY_PREDICTION = `${SQLITE}/test-run-recovery-prediction.ts`;
const STEP_MODULES = Object.freeze([MARKER_STEP, COVERAGE, MAPPING_STEP, DIRECTORY, MAPPING_ACTS, GRANTS_STEP, AUTHORITY_ACTS, AUTHORITY_RESET, RECOVERY_PREDICTION]);
/**
 * The only non-test importers of the step modules, each with the modules it may
 * import and why. The project directory (step 51) has no importer: it is not mounted.
 */
const STEP_IMPORTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  [COVERAGE]: { [MARKER_STEP]: "lists step 50's fence coverage", [MAPPING_STEP]: "lists step 51's fence coverage and its other triggers",
    [GRANTS_STEP]: "lists step 52's fence coverage and its other triggers" },
  [`${SQLITE}/migrations.ts`]: { [MARKER_STEP]: "applies step 50 when initializeSchema is given the target", [MAPPING_STEP]: "applies step 51 when initializeSchema is given the target",
    [GRANTS_STEP]: "applies step 52 when initializeSchema is given the target" },
  [`${SQLITE}/schema-inspection.ts`]: { [MARKER_STEP]: "recognises step 50 by its text and checksum", [COVERAGE]: "builds the expected triggers of each version",
    [MAPPING_STEP]: "recognises step 51's tables, columns and checksum at ceiling 51", [GRANTS_STEP]: "recognises step 52's name and checksum at ceiling 52" },
  [`${SQLITE}/fixtures/schema-rewind.ts`]: { [MARKER_STEP]: "rewinds synthetic step-50 fixtures", [MAPPING_STEP]: "rewinds synthetic step-51 fixtures", [GRANTS_STEP]: "rewinds synthetic step-52 fixtures" },
  [`${SQLITE}/upgrade-plan.ts`]: { [MARKER_STEP]: "names step 50 and its checksum among the structural steps", [MAPPING_STEP]: "names step 51 and its checksum among the structural steps",
    [MAPPING_ACTS]: "registers the step-51 project-mapping act domain in the upgrade's registry", [GRANTS_STEP]: "names step 52 and its checksum among the structural steps",
    [AUTHORITY_ACTS]: "registers the step-52 authority act domain in the upgrade's registry, after the mapping domain" },
  [MAPPING_ACTS]: { [MAPPING_STEP]: "passes the step-51 gate with the step's version before reading the mapping columns" },
  [AUTHORITY_ACTS]: { [GRANTS_STEP]: "passes the step-52 gate with the step's version before reading or writing the grants table",
    [AUTHORITY_RESET]: "runs the quarantine's reset statements as the upgrade's revoke and release acts",
    [RECOVERY_PREDICTION]: "refuses what the test-run recovery could fail on and checks the recovery's outcome against its prediction" },
  [`${SQLITE}/database-validation.ts`]: { [MAPPING_STEP]: "validates the step-51 clock, stamps, parents and journal at version 51",
    [GRANTS_STEP]: "validates the shape of the step-52 grants at version 52" },
  [`${SQLITE}/security-maintenance.ts`]: { [MAPPING_STEP]: "plans and applies the step-51 mapping quarantine at target 51",
    [GRANTS_STEP]: "deletes every step-52 grant in the quarantine at target 52", [AUTHORITY_RESET]: "runs the reset statements it shares with the upgrade, in the quarantine's order, at every target" },
  [DIRECTORY]: { [MAPPING_STEP]: "passes the step-51 gate with the step's version" },
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
function gateFindings(fileName: string, text: string, imports = moduleImports(fileName, text)): string[] {
  return imports.filter(entry => reaches(fileName, entry.specifier, GATE))
    .filter(entry => !(fileName in GATE_IMPORTERS && entry.form === "import" && entry.readOnly))
    .map(entry => `${entry.form} of ${entry.specifier} at line ${entry.line}`);
}
/** Imports of a provisional step module, each with the module it resolves to. */
function stepImportEntries(fileName: string, text: string, imports = moduleImports(fileName, text)): Array<ModuleImport & { module: string }> {
  return imports.flatMap(entry => STEP_MODULES.filter(step => reaches(fileName, entry.specifier, step)).map(module => ({ ...entry, module })));
}
/** Imports of a provisional step module. */
function stepImports(fileName: string, text: string): string[] {
  return stepImportEntries(fileName, text).map(entry => `${entry.form} of ${entry.specifier} at line ${entry.line}`);
}
/** Imports of a step module that STEP_IMPORTS does not permit for this importer. */
function stepFindings(fileName: string, text: string, entries = stepImportEntries(fileName, text)): string[] {
  return entries.filter(entry => !Object.hasOwn(STEP_IMPORTS[fileName] ?? {}, entry.module))
    .map(entry => `${entry.form} of ${entry.specifier} (${entry.module}) at line ${entry.line}`);
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
/** Every entry under a directory: kind, bytes, mode and modification time. */
const tree = (root: string): Record<string, string> => Object.fromEntries(readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map(name => {
  const entry = join(root, name), stat = lstatSync(entry, { bigint: true });
  return [name, [stat.isFile() ? createHash("sha256").update(readFileSync(entry)).digest("hex") : stat.isDirectory() ? "directory" : "other", stat.mode, stat.mtimeNs].join(":")];
}));

describe("provisional schema steps stay switched off", () => {
  it("keeps schema 49 supported, steps 50 to 52 provisional and the switch off by default", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(49);
    expect(PROVISIONAL_SCHEMA_VERSION).toBe(52);
    expect(provisionalSchemaEnabled()).toBe(false);
    expect(schemaTarget()).toBe(49);
    expect(schemaTarget(49)).toBe(49);
    expect(() => schemaTarget(50)).toThrow(UNSUPPORTED);
    for (const invalid of [48, 51, 52, 53, 49.5, Number.NaN]) expect(() => schemaTarget(invalid)).toThrow(UNSUPPORTED);
  });

  it.each([50, 51, 52])("refuses target or ceiling %i at every public entry point while the switch is off, with the unsupported-target error", async target => {
    expect(provisionalSchemaEnabled()).toBe(false);
    const fixture = current49(), data = realpathSync(fixture.paths.dataDirectory), files = tree(data);
    const memory = new Database(":memory:"), current = new Database(fixture.paths.databasePath, { readonly: true });
    try {
      const refusals = {
        schemaTarget: () => schemaTarget(target),
        initializeSchema: () => initializeSchema(memory, undefined, undefined, { target }),
        applyUpgradeMarkerMigration: () => applyUpgradeMarkerMigration(memory, true),
        applyProjectMappingMigration: () => applyProjectMappingMigration(memory),
        planMappingQuarantine: () => planMappingQuarantine(memory),
        applyMappingQuarantine: () => applyMappingQuarantine(memory, { base: 0, final: 1, unstamped: { projects: 0, remote_project_identities: 0 } }),
        projectMappingViolation: () => projectMappingViolation(memory),
        applyAccountGrantsMigration: () => applyAccountGrantsMigration(memory),
        accountGrantsViolation: () => accountGrantsViolation(memory),
        clearAccountGrants: () => clearAccountGrants(memory),
        ProjectDirectoryQueries: () => new ProjectDirectoryQueries(memory),
        inspectSchema: () => inspectSchema(current, target),
        OwnedSqliteDatabase: () => new OwnedSqliteDatabase(fixture.paths.databasePath, false, target),
        maintainSqliteSecurityFence: () => maintainSqliteSecurityFence(fixture.paths, { action: "inspect" }, HANDOFF, target),
        quarantineAuthority: () => quarantineAuthority(memory, "receipt", "token", target),
        parseManifest: () => parseManifest({ ...fixture.manifest, database: { ...fixture.manifest.database, schemaVersion: target } }, target),
        validateSnapshot: () => validateSnapshot(fixture.snapshot, parseManifest(fixture.manifest), target),
        validateBackup: () => validateBackup(fixture.backup, parseManifest(fixture.manifest), false, target),
        upgradeTarget: () => upgradeTarget(target),
        inspectSqliteUpgrade: () => inspectSqliteUpgrade(fixture.paths, target),
        applySqliteUpgrade: () => applySqliteUpgrade(fixture.paths, { expect: "0".repeat(64) }, UNUSED_BACKUP, target),
        // Synchronously, before any lock or file.
        establishSqliteSecurityFence: () => establishSqliteSecurityFence(fixture.paths, { action: "establish", expect: "0".repeat(64) }, HANDOFF, UNUSED_BACKUP, target),
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
        () => inspectSqliteUpgrade(fixture.paths, target), () => applySqliteUpgrade(fixture.paths, { expect: "0".repeat(64) }, UNUSED_BACKUP, target)]) {
        expect(refusal).toThrowError(expect.objectContaining({ name: "UpgradeError", code: "upgrade_unsupported", message: unsupported }));
      }
      expect(new UpgradeError("upgrade_unsupported", "none").message).toBe(unsupported);
      expect(existsSync(`${fixture.paths.databasePath}.upgrade`)).toBe(false);
      expect(existsSync(fixture.paths.controllerLockPath)).toBe(false);
      // No file under the data directory was created, changed or touched.
      expect(tree(data)).toEqual(files);
    } finally { memory.close(); current.close(); }
    // The same entry points accept the default, so the refusal is the target's.
    const owner = new OwnedSqliteDatabase(fixture.paths.databasePath);
    try { expect(owner.inspection.version).toBe(49); } finally { owner.close(); }
    expect(() => validateBackup(fixture.backup, parseManifest(fixture.manifest))).not.toThrow();
    // Establishment with a backup at the default target needs no switch: it
    // passes the target and reaches the preflight comparison, before any backup.
    await expect(establishSqliteSecurityFence(fixture.paths, { action: "establish", expect: "0".repeat(64) }, HANDOFF, UNUSED_BACKUP))
      .rejects.toMatchObject({ name: "SecurityFenceError", code: "security_fence_preflight_changed" });
  });

  it("refuses every upgrade-specific helper of the fence and the plan while the switch is off, before any file is read or written", () => {
    expect(provisionalSchemaEnabled()).toBe(false);
    const fixture = current49(), data = realpathSync(fixture.paths.dataDirectory), path = join(data, "state.sqlite3");
    const database = new Database(path);
    try {
      // A trusted schema-49 witness: what beginUpgrade would replace with a format-2 pending one.
      SecurityFence.attach(path, database, true);
      const before = tree(data);
      expect(Object.keys(before)).toContain(join("state.sqlite3.security", "witness.json"));
      const receipt = "00000000-0000-4000-8000-000000000000";
      const plan = { kind: "worktree-control/upgrade-plan" as const, format: 2 as const, binding: "a".repeat(64), installation: "b".repeat(64), base: "c".repeat(64), source: 49, target: 49, steps: structuralSteps(49, 49), decisions: {}, acts: [], review: {} };
      const mappingPlan = { ...plan, source: 49, target: 51, decisions: { mapping: { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } } } };
      const context = { source: 49, target: 51, planHash: "0".repeat(64), receipt, at: new Date(0).toISOString() };
      const refusals = {
        assertUpgradeAvailable: () => assertUpgradeAvailable(),
        beginUpgrade: () => SecurityFence.beginUpgrade(path, { receipt, plan: "0".repeat(64), at: new Date().toISOString() }),
        registerUpgradeObserver: () => SecurityFence.registerUpgradeObserver(path, database, receipt),
        upgradeReceiptPending: () => SecurityFence.upgradeReceipt(path, database, receipt, "pending"),
        upgradeReceiptConfirmed: () => SecurityFence.upgradeReceipt(path, database, receipt, "confirmed"),
        writeUpgradePlan: () => writeUpgradePlan(path, plan),
        readUpgradePlan: () => readUpgradePlan(path),
        removeUpgradePlan: () => removeUpgradePlan(path),
        // C2b: the decisions, the proposal pass, the whole-plan validation and the acts.
        normaliseUpgradeDecisions: () => normaliseUpgradeDecisions({}, 51),
        proposeUpgrade: () => proposeUpgrade(database, { schemaVersion: 49, source: 49, target: 51 }, {}, null, true),
        validateUpgradeProposal: () => validateUpgradeProposal(database, mappingPlan, 49),
        executeUpgradeActs: () => database.transaction(() => executeUpgradeActs(database, mappingPlan, context))(),
        normaliseMappingDecisions: () => normaliseMappingDecisions({}),
        proposeProjectMapping: () => proposeProjectMapping(database, { schemaVersion: 49, source: 49, target: 51 }, { links: [], bindings: [], isolate: { registrations: [], remoteIdentities: [] } }, null, true),
        ...Object.fromEntries(MAPPING_ACT_DOMAIN.kinds.map(kind => [kind.kind, () => database.transaction(() => kind.execute(database, {}, context))()])),
        inspectSqliteUpgradeWithDecisions: () => inspectSqliteUpgrade(fixture.paths, 51, { isolate: { registrations: ["x"] } }),
        // C3a: the authority domain's decisions, proposal and acts, and the upgrade at its target.
        normaliseAuthorityDecisions: () => normaliseAuthorityDecisions({}),
        proposeAuthority: () => proposeAuthority(database, { schemaVersion: 49, source: 49, target: 52 }, {}, null, true),
        ...Object.fromEntries(AUTHORITY_ACT_DOMAIN.kinds.map(kind => [kind.kind, () => database.transaction(() => kind.execute(database, { accountId: "owner" }, { ...context, target: 52 }))()])),
        normaliseUpgradeDecisionsAt52: () => normaliseUpgradeDecisions({}, 52),
        inspectSqliteUpgradeAt52: () => inspectSqliteUpgrade(fixture.paths, 52),
      };
      for (const [entry, refusal] of Object.entries(refusals)) {
        expect(refusal, entry).toThrowError(expect.objectContaining({ name: "UpgradeError", code: "upgrade_unsupported", message: UNSUPPORTED }));
      }
      expect(tree(data)).toEqual(before);
      expect(existsSync(`${path}.upgrade`)).toBe(false);
      // The witness is still the trusted format-1 record.
      expect(() => SecurityFence.inspect(path, database, false)).not.toThrow();
      expect(JSON.parse(readFileSync(join(`${path}.security`, "witness.json"), "utf8")).payload).toMatchObject({ format: 1, state: "confirmed" });
    } finally { database.close(); }
  });

  it("finds no gate import outside the reader, and no step-module import outside its listed importer and module pairs", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(GATE);
    // Each file is read and parsed once; both rules use the same imports.
    const scanned = files.map(file => {
      const text = readFileSync(join(repository, file), "utf8"), imports = moduleImports(file, text);
      return { file, text, imports, steps: stepImportEntries(file, text, imports) };
    });
    expect(scanned.flatMap(({ file, text, imports }) => gateFindings(file, text, imports).map(finding => `${file}: ${finding}`))).toEqual([]);
    // Every file, listed importers included: each may import only its own listed modules.
    expect(scanned.flatMap(({ file, text, steps }) => stepFindings(file, text, steps).map(finding => `${file}: ${finding}`))).toEqual([]);
    // No non-test file imports the project directory.
    expect(Object.values(STEP_IMPORTS).some(modules => Object.hasOwn(modules, DIRECTORY))).toBe(false);
    expect(scanned.filter(({ steps }) => steps.some(entry => entry.module === DIRECTORY)).map(({ file }) => file)).toEqual([]);
  });

  it("lists only existing files that need the exception", () => {
    for (const file of [GATE, ...STEP_MODULES]) expect(existsSync(join(repository, file)), file).toBe(true);
    for (const [file, reason] of Object.entries(GATE_IMPORTERS)) {
      expect(reason.length).toBeGreaterThan(10);
      const text = readFileSync(join(repository, file), "utf8");
      expect(moduleImports(file, text).filter(entry => reaches(file, entry.specifier, GATE)).map(entry => [entry.form, entry.readOnly]), file).toEqual([["import", true]]);
    }
    for (const [file, modules] of Object.entries(STEP_IMPORTS)) {
      // Each listed pair is one the file actually needs: it imports exactly its listed modules.
      const imported = new Set(stepImportEntries(file, readFileSync(join(repository, file), "utf8")).map(entry => entry.module));
      expect([...imported].sort(), file).toEqual(Object.keys(modules).sort());
      for (const [module, reason] of Object.entries(modules)) {
        expect(STEP_MODULES, `${file} → ${module}`).toContain(module);
        expect(reason.length, `${file} → ${module}`).toBeGreaterThan(10);
      }
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

  it("reports a step module an allow-listed importer is not paired with, such as the project directory", () => {
    const strip = (findings: string[]) => findings.map(entry => entry.replace(/ at line \d+$/, ""));
    // database-validation.ts may import the mapping step, not the directory, the marker step or the coverage.
    expect(strip(stepFindings(`${SQLITE}/database-validation.ts`, [
      'import { projectMappingViolation } from "./mapping-structure-migration";',
      'import { ProjectDirectoryQueries } from "./project-directory-queries";',
      'export { ProjectDirectoryQueries as Directory } from "@/server/infrastructure/sqlite/project-directory-queries";',
      'type Directory = typeof import("./project-directory-queries.js");',
      'import { upgradeMarkerMigration } from "./upgrade-marker-migration";',
      'import { SECURITY_COVERAGE } from "./security-coverage";',
    ].join("\n")))).toEqual([
      `import of ./project-directory-queries (${DIRECTORY})`, `re-export of @/server/infrastructure/sqlite/project-directory-queries (${DIRECTORY})`,
      `import() type of ./project-directory-queries.js (${DIRECTORY})`, `import of ./upgrade-marker-migration (${MARKER_STEP})`,
      `import of ./security-coverage (${COVERAGE})`,
    ]);
    // Every listed importer is reported for the directory, and so is a file that is not listed.
    const specifier = "@/server/infrastructure/sqlite/project-directory-queries";
    for (const file of [...Object.keys(STEP_IMPORTS), `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, `import { ProjectDirectoryQueries } from "${specifier}";`)), file).toEqual([`import of ${specifier} (${DIRECTORY})`]);
    }
    // A listed pair is not a finding.
    expect(stepFindings(`${SQLITE}/security-maintenance.ts`, 'import { applyMappingQuarantine } from "./mapping-structure-migration";')).toEqual([]);
    // The mapping acts (C2b) are importable only by the plan's registry: the maintenance, the mapping step and any other file are reported.
    const actsModule = "@/server/infrastructure/sqlite/mapping-upgrade-acts";
    const acts = `import { MAPPING_ACT_DOMAIN } from "${actsModule}";`;
    expect(stepFindings(`${SQLITE}/upgrade-plan.ts`, acts)).toEqual([]);
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, MAPPING_STEP, `${SQLITE}/security-maintenance.ts`, "src/server/bootstrap/example.ts"]) {
      expect(strip(stepFindings(file, acts)), file).toEqual([`import of ${actsModule} (${MAPPING_ACTS})`]);
    }
    // So are the authority acts (C3a); the grants step is importable by its listed importers only, never by the maintenance or a module outside this directory.
    const authorityModule = "@/server/infrastructure/sqlite/authority-upgrade-acts", grantsModule = "./account-grants-migration";
    const authority = `import { AUTHORITY_ACT_DOMAIN } from "${authorityModule}";`, grants = `import { clearAccountGrants } from "${grantsModule}";`;
    expect(stepFindings(`${SQLITE}/upgrade-plan.ts`, authority)).toEqual([]);
    expect(stepFindings(`${SQLITE}/security-maintenance.ts`, grants)).toEqual([]);
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, MAPPING_ACTS, GRANTS_STEP, `${SQLITE}/security-maintenance.ts`, "src/server/bootstrap/example.ts"]) {
      expect(strip(stepFindings(file, authority)), file).toEqual([`import of ${authorityModule} (${AUTHORITY_ACTS})`]);
    }
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, MAPPING_ACTS, `${SQLITE}/sqlite-state-store.ts`]) {
      expect(strip(stepFindings(file, grants)), file).toEqual([`import of ${grantsModule} (${GRANTS_STEP})`]);
    }
    // The shared authority reset: the quarantine and the authority acts only; every other file is reported, in every literal form.
    const resetModule = "./authority-reset";
    const reset = `import { revokeCredentials } from "${resetModule}";`;
    for (const file of [`${SQLITE}/security-maintenance.ts`, AUTHORITY_ACTS]) expect(stepFindings(file, reset), file).toEqual([]);
    for (const file of [`${SQLITE}/upgrade-maintenance.ts`, `${SQLITE}/upgrade-plan.ts`, `${SQLITE}/test-run-queries.ts`, `${SQLITE}/sqlite-state-store.ts`, MAPPING_ACTS, GRANTS_STEP, `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, reset)), file).toEqual([`import of ${resetModule} (${AUTHORITY_RESET})`]);
    }
    expect(strip(stepFindings(`${SQLITE}/upgrade-maintenance.ts`, [
      'export { revokeCredentials as revoke } from "./authority-reset.js";',
      'const lazy = import("@/server/infrastructure/sqlite/authority-reset");',
      'type Reset = typeof import("./authority-reset");',
    ].join("\n")))).toEqual([
      `re-export of ./authority-reset.js (${AUTHORITY_RESET})`, `import() of @/server/infrastructure/sqlite/authority-reset (${AUTHORITY_RESET})`,
      `import() type of ./authority-reset (${AUTHORITY_RESET})`,
    ]);
    expect(strip(stepFindings("src/server/bootstrap/example.ts", 'import { revokeCredentials } from "@/server/infrastructure/sqlite/authority-reset";')))
      .toEqual([`import of @/server/infrastructure/sqlite/authority-reset (${AUTHORITY_RESET})`]);
    // The recovery's predictor: the authority acts only; the recovery itself, the quarantine and every other file are reported.
    const predictionModule = "./test-run-recovery-prediction";
    const prediction = `import { predictRecovery } from "${predictionModule}";`;
    expect(stepFindings(AUTHORITY_ACTS, prediction)).toEqual([]);
    for (const file of [`${SQLITE}/test-run-queries.ts`, `${SQLITE}/test-summary-queries.ts`, AUTHORITY_RESET, `${SQLITE}/security-maintenance.ts`, `${SQLITE}/upgrade-plan.ts`, `${SQLITE}/sqlite-state-store.ts`, `${SQLITE}/example.ts`]) {
      expect(strip(stepFindings(file, prediction)), file).toEqual([`import of ${predictionModule} (${RECOVERY_PREDICTION})`]);
    }
  });

  it("keeps the shared authority reset callable with the switch off, as the schema-49 quarantine needs", () => {
    expect(provisionalSchemaEnabled()).toBe(false);
    const memory = new Database(":memory:");
    try {
      initializeSchema(memory);
      // The fence triggers of the covered rows call the observer; outside an owner it is a no-op here.
      memory.function("worktree_security_pending", () => 0);
      const at = "2025-01-01T00:00:00.000Z";
      revokeCredentials(memory, at); revokeOldGrants(memory, at); releaseReservations(memory, at); cancelRemoteWork(memory, at);
      expect(() => interruptTestRuns(memory)).not.toThrow();
    } finally { memory.close(); }
  });

  describe("with the switch on", () => {
    let restore: () => void;
    beforeEach(() => { restore = enableProvisionalSchema(); });
    afterEach(() => { restore(); });

    it("accepts targets 50 to 52, still refuses anything above them, and restores the previous state", () => {
      expect(provisionalSchemaEnabled()).toBe(true);
      expect(schemaTarget()).toBe(49);
      expect(schemaTarget(50)).toBe(50);
      expect(schemaTarget(51)).toBe(51);
      expect(schemaTarget(52)).toBe(52);
      for (const invalid of [48, 53, 49.5, 50.5, 51.5, Number.NaN]) expect(() => schemaTarget(invalid)).toThrow(UNSUPPORTED);
      // Nested use restores the outer state, not "off".
      const inner = enableProvisionalSchema();
      inner();
      expect(provisionalSchemaEnabled()).toBe(true);
    });
  });
});
