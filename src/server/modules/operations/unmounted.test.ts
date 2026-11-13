import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Slice 1 is unmounted: no file outside this module may import it or its
 * shared contract, by any route (relative, `@/` alias, directory index,
 * `export … from`, dynamic `import()` or `require`). Remove this guard in the
 * slice that mounts the module.
 */
const repository = resolve(".");
const moduleDirectory = resolve("src/server/modules/operations");
const contractsFile = resolve("src/shared/contracts/operations.ts");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".jsx"]);
const skippedDirectories = new Set(["node_modules", ".git", ".next", "dist", "out", "coverage", ".turbo"]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (!skippedDirectories.has(entry.name)) found.push(...sourceFiles(path)); }
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) found.push(path);
  }
  return found;
}

/** Every module specifier of a source text: static, re-export, type, `import()`, `require()` and `import x = require()`. */
function specifiersOf(fileName: string, text: string): string[] {
  const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) found.push(argument.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether a specifier written in `fromFile` resolves to the module directory (any file or its index) or to the contracts file. */
function reachesOperations(fromFile: string, specifier: string): boolean {
  const base = specifier.startsWith("@/") ? resolve("src", specifier.slice(2))
    : specifier.startsWith(".") ? resolve(dirname(fromFile), specifier)
      : specifier.startsWith("/") ? resolve(specifier) : null;
  if (!base) return false;
  const target = base.replace(/\.(?:[cm]?[jt]sx?|d\.ts)$/, "").replace(/[\\/]index$/, "");
  const contracts = contractsFile.replace(/\.ts$/, "");
  return target === moduleDirectory || target.startsWith(moduleDirectory + sep) || target === contracts;
}

const isExempt = (file: string) => file === contractsFile || file.startsWith(moduleDirectory + sep);

describe("authorization contract stays unmounted", () => {
  it("is imported by no file outside the module, in src, packages, scripts, tests or root entry points", () => {
    const files = sourceFiles(repository).filter(file => !isExempt(file));
    // The scan must actually cover the requested roots, not silently find nothing.
    const roots = new Set(files.map(file => relative(repository, file).split(sep)[0]));
    for (const root of ["src", "packages", "scripts", "next.config.ts", "vitest.config.ts", "eslint.config.mjs"]) expect(roots.has(root)).toBe(true);
    const importers = files.flatMap(file => specifiersOf(file, readFileSync(file, "utf8"))
      .filter(specifier => reachesOperations(file, specifier))
      .map(specifier => `${relative(repository, file)} -> ${specifier}`));
    expect(importers).toEqual([]);
  });

  it("would catch every import route into the module or its contract", () => {
    const sibling = resolve("src/server/modules/runtime/example.ts");
    const modulesRoot = resolve("src/server/modules/example.ts");
    const fixture = [
      'import { decide } from "../operations/decide";',
      'import { OperationRunner } from "../operations/runner";',
      'import type { Actor } from "../operations";',
      'export * from "../operations/index";',
      'const lazy = () => import("@/server/modules/operations");',
      'const loaded = require("@/shared/contracts/operations");',
      'type T = import("../../../shared/contracts/operations.js").ProjectId;',
      'import x = require("../operations/errors.ts");',
    ].join("\n");
    expect(specifiersOf(sibling, fixture).filter(specifier => reachesOperations(sibling, specifier))).toHaveLength(8);
    expect(reachesOperations(modulesRoot, "./operations")).toBe(true);
    expect(reachesOperations(modulesRoot, "./operations/runner")).toBe(true);
    expect(reachesOperations(resolve("scripts/tool.mjs"), "../src/server/modules/operations/index.ts")).toBe(true);
    expect(reachesOperations(resolve("next.config.ts"), "./src/shared/contracts/operations")).toBe(true);
    // Neighbours with similar names are not the module.
    for (const other of ["./operations-other", "@/server/modules/operationsx", "@/shared/contracts/operations-extra", "operations"]) {
      expect(reachesOperations(modulesRoot, other)).toBe(false);
    }
    expect(specifiersOf(resolve("scripts/tool.cjs"), 'const x = require("../src/server/modules/operations/runner");')).toEqual(["../src/server/modules/operations/runner"]);
  });
});
