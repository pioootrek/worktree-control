import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PROVISIONAL_SCHEMA_VERSION, schemaTarget, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";

/**
 * Provisional schema steps stay switched off (C1b): no non-test source file
 * under `src` may reference the provisional constant, import the provisional
 * step or its fence coverage, or pass a schema target or ceiling other than the
 * default, outside the files listed here. Activation raises
 * SUPPORTED_SCHEMA_VERSION, which fails the first test below, so it is a
 * visible edit of this file.
 *
 * Calls are recognised by the callee's name (identifier or property access).
 * An aliased function reference is not followed; the listed functions are only
 * exported from the SQLite adapter, whose files this guard reads.
 */
const STEP_FILES = Object.freeze(["src/server/infrastructure/sqlite/upgrade-marker-migration.ts"]);
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  "src/server/infrastructure/sqlite/migration-registry.ts": "defines the provisional constant and the target validation",
  "src/server/infrastructure/sqlite/security-coverage.ts": "lists the fence coverage of each step, including step 50",
  "src/server/infrastructure/sqlite/migrations.ts": "applies step 50 when initializeSchema is given the target",
  "src/server/infrastructure/sqlite/schema-inspection.ts": "recognises step 50 and builds its reference at the ceiling",
  "src/server/infrastructure/sqlite/backup-validation.ts": "forwards the manifest and snapshot ceiling",
  "src/server/infrastructure/sqlite/owned-database.ts": "forwards the inspection ceiling",
  "src/server/infrastructure/sqlite/security-maintenance.ts": "forwards the maintenance target to inspection, schema and quarantine",
  "src/server/infrastructure/sqlite/fixtures/schema-rewind.ts": "rewinds a synthetic step-50 fixture",
});
/** The callee name and the highest argument count that still means the default target. */
const DEFAULT_ARITY: Readonly<Record<string, number>> = Object.freeze({
  inspectSchema: 1, maintainSqliteSecurityFence: 3, quarantineAuthority: 3, parseManifest: 1,
  validateSnapshot: 2, validateBackup: 3, OwnedSqliteDatabase: 2, schemaTarget: 0,
});
const PROVISIONAL_MODULES = /(?:^|[\\/])(?:upgrade-marker-migration|security-coverage)(?:\.[cm]?[jt]s)?$/;

function findings(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node) => `line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const calleeName = (callee: ts.Expression) => ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  const checkCall = (node: ts.CallExpression | ts.NewExpression) => {
    const name = calleeName(node.expression), args = node.arguments ?? ts.factory.createNodeArray();
    if (name === "initializeSchema") {
      const options = args[3];
      const defaultOptions = !options || (ts.isObjectLiteralExpression(options)
        && options.properties.every(property => !ts.isSpreadAssignment(property) && property.name !== undefined
          && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text !== "target"));
      if (!defaultOptions || args.some(ts.isSpreadElement)) found.push(`initializeSchema with a target or unchecked options at ${at(node)}`);
      return;
    }
    if (!name || !(name in DEFAULT_ARITY)) return;
    if (ts.isNewExpression(node) !== (name === "OwnedSqliteDatabase")) return;
    if (args.length > DEFAULT_ARITY[name] || args.some(ts.isSpreadElement)) found.push(`${name} with a target at ${at(node)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "PROVISIONAL_SCHEMA_VERSION") found.push(`references PROVISIONAL_SCHEMA_VERSION at ${at(node)}`);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
      && PROVISIONAL_MODULES.test(node.moduleSpecifier.text)) found.push(`imports ${node.moduleSpecifier.text}`);
    // Non-literal loaders are the unmounted guard's concern (src/server/modules/operations/unmounted.test.ts).
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first) && PROVISIONAL_MODULES.test(first.text)) found.push(`imports a provisional module dynamically at ${at(node)}`);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) checkCall(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sources(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(root, "src"));
  return files.map(file => relative(root, file).split(sep).join("/")).sort();
}

const repository = resolve(".");

describe("provisional schema steps stay switched off", () => {
  it("keeps schema 49 supported and step 50 provisional", () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(49);
    expect(PROVISIONAL_SCHEMA_VERSION).toBe(50);
    expect(schemaTarget()).toBe(49);
    expect(schemaTarget(50)).toBe(50);
    for (const invalid of [48, 51, 49.5, Number.NaN]) expect(() => schemaTarget(invalid)).toThrow("Unsupported schema target.");
  });

  it("finds no provisional reference or non-default target outside the listed files", () => {
    const files = sources(repository);
    expect(files.length).toBeGreaterThan(100);
    const violations = files.filter(file => !STEP_FILES.includes(file) && !(file in ALLOWED))
      .flatMap(file => findings(file, readFileSync(join(repository, file), "utf8")).map(finding => `${file}: ${finding}`));
    expect(violations).toEqual([]);
  });

  it("lists only existing files that need the exception", () => {
    for (const file of STEP_FILES) expect(existsSync(join(repository, file)), file).toBe(true);
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(findings(file, readFileSync(join(repository, file), "utf8")).length, file).toBeGreaterThan(0);
    }
  });

  it("would catch every route to a provisional step", () => {
    const text = [
      'import { PROVISIONAL_SCHEMA_VERSION } from "./migration-registry";',
      'import { applyUpgradeMarkerMigration } from "./upgrade-marker-migration";',
      'export * from "../sqlite/security-coverage.ts";',
      'const lazy = import("./upgrade-marker-migration");',
      'const loaded = require("../sqlite/security-coverage");',
      "inspectSchema(database, 50);",
      "store.inspectSchema(database, ...rest);",
      "initializeSchema(database, false, inspectSchema, { target: 50 });",
      "initializeSchema(database, false, undefined, options);",
      "initializeSchema(database, false, undefined, { ...options });",
      "maintainSqliteSecurityFence(paths, command, handoff, 50);",
      'quarantineAuthority(database, receipt, "token", 50);',
      "parseManifest(value, 50);",
      "validateSnapshot(path, manifest, 50);",
      "validateBackup(root, manifest, true, 50);",
      "new OwnedSqliteDatabase(path, true, 50);",
      "schemaTarget(50);",
    ].join("\n");
    expect(findings("src/example.ts", text).map(entry => entry.replace(/ at line \d+$/, ""))).toEqual([
      "references PROVISIONAL_SCHEMA_VERSION", "imports ./upgrade-marker-migration", "imports ../sqlite/security-coverage.ts",
      "imports a provisional module dynamically", "imports a provisional module dynamically",
      "inspectSchema with a target", "inspectSchema with a target",
      "initializeSchema with a target or unchecked options", "initializeSchema with a target or unchecked options", "initializeSchema with a target or unchecked options",
      "maintainSqliteSecurityFence with a target", "quarantineAuthority with a target", "parseManifest with a target",
      "validateSnapshot with a target", "validateBackup with a target", "OwnedSqliteDatabase with a target", "schemaTarget with a target",
    ]);
    // Default calls, as production makes them, are not findings.
    expect(findings("src/example.ts", [
      "inspectSchema(database);", "initializeSchema(database, fresh, inspectSchema);", "initializeSchema(database, fresh, undefined, { acts });",
      "maintainSqliteSecurityFence(paths, command, handoff);", 'quarantineAuthority(database, receipt, "token");', "parseManifest(value);",
      "validateSnapshot(path, manifest);", "validateBackup(root, manifest, true);", "new OwnedSqliteDatabase(path, true);", "schemaTarget();",
      'import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";',
    ].join("\n"))).toEqual([]);
  });
});
