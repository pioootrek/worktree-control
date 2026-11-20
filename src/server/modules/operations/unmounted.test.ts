import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Decision U: only the exact approved bootstrap importers may import the
 * module or its shared contract. Only session.describe is mounted.
 *
 * Inventory: every source file under `src`, `packages`, `scripts` and `tests`,
 * without build or dependency trees, plus the root entry and configuration
 * files below. Within it:
 *
 * - every literal specifier (static, re-export, type, `import()`, `require()`,
 *   `require.resolve()`, `import.meta.resolve()`, `import x = require()`) is
 *   resolved: relative, `@/` alias, absolute and `file:` URL; a resolved file
 *   is compared by its real path, so a symlinked file or directory cannot hide
 *   the target;
 * - every non-literal specifier fails, unless the file is on `ALLOWLIST` with
 *   a reason. The result of `createRequire` may only be bound to `require` or
 *   used as `createRequire(...).resolve("literal")`, so it cannot become an
 *   unchecked loader;
 * - a symbolic link inside the inventory fails.
 */
const ROOT_FILES = Object.freeze([
  "eslint.config.mjs", "next-env.d.ts", "next.config.ts", "playwright.config.ts", "playwright.e2e.config.ts", "postcss.config.mjs",
  "vitest.auth-provider-proof.config.ts", "vitest.config.ts", "vitest.https.config.ts", "vitest.integration.config.ts",
  "vitest.provider-administration.config.ts", "vitest.remote-recovery.config.ts",
]);
const INVENTORY_DIRECTORIES = Object.freeze(["src", "packages", "scripts", "tests"]);
/** Untracked build and dependency trees; never scanned, so the inventory does not depend on local builds. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".next", "dist", "out", "build", "coverage", ".turbo", "test-results", "playwright-report"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".jsx"]);
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

/**
 * Files allowed to contain non-literal specifiers, each with its reason. Their
 * literal specifiers are still resolved and checked. Existing files are listed
 * as they are; they are not changed for this guard.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  "src/server/modules/authentication/provider-runtime.ts": "loads the optional external authentication provider from its configured file URL",
  "packages/auth-provider-better-auth-proof/test/better-auth-proof.test.ts": "imports frozen fixture modules of the provider proof by computed file URL",
  "scripts/auth-provider-session-restart.mjs": "imports an emitted passkey authenticator from a build output path",
  "scripts/https-caddy.mjs": "reads the pinned Caddy manifest through createRequire from a computed path",
  "scripts/package-install.mjs": "loads better-sqlite3 from the installed package directory under test",
  "scripts/package-installed-fault.mjs": "loads the installed package's CLI and better-sqlite3 from a temporary install",
  "scripts/package-rbac.mjs": "loads the MCP SDK from the installed package directory under test",
  "scripts/package-smoke.mjs": "loads the MCP SDK from the packed package directory under test",
  "scripts/package-smoke.test.mjs": "imports a copy of package-smoke.mjs from a temporary directory",
});

/** Exact production and mounted-provider proof consumers. No legacy handler imports the module. */
const APPROVED_IMPORTERS: Readonly<Record<string, string>> = Object.freeze({
  "src/cli/session-describe.ts": "mounts the one offline CLI read and validates private socket DTOs and public failures",
  "packages/auth-provider-better-auth-proof/test/cli-provider-lifecycle-operations-cookie.test.ts": "runs cookie listener proofs through production bootstrap and reuses the mounted boundary driver and exact conformance assertions",
  "src/server/bootstrap/operations-runtime.ts": "composes the runtime from the store owner's read ports and controller policies",
  "src/server/bootstrap/offline-operations-runtime.ts": "binds the real offline owner lock; offline CLI session describe uses the real owner lock",
  "src/server/transports/operations-mcp.ts": "mounted request adapter uses public release and error policy and receives the runtime as a value",
  "src/server/transports/operations-http.ts": "uses the public classifier and error serializer to avoid duplicating wire and failure policy; receives the runtime as a value",
});
const COMPOSITION = "src/server/bootstrap/operations-runtime.ts";

interface Analysis { literals: string[]; dynamic: string[] }

function scriptKind(fileName: string): ts.ScriptKind {
  return /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Every module specifier of a source text, split into literal ones and non-literal loader calls. */
function analyse(fileName: string, text: string): Analysis {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const literals: string[] = [];
  const dynamic: string[] = [];
  const argument = (call: ts.CallExpression, what: string) => {
    const first = call.arguments[0];
    if (first && ts.isStringLiteralLike(first)) literals.push(first.text);
    else dynamic.push(`${what} at line ${source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1}`);
  };
  const isCreateRequireCall = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createRequire";
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) literals.push(node.moduleSpecifier.text);
      else dynamic.push("module specifier");
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteralLike(expression)) literals.push(expression.text); else dynamic.push("import = require()");
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      literals.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) argument(node, "import()");
      else if (ts.isIdentifier(callee) && callee.text === "require") argument(node, "require()");
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "resolve" && ts.isIdentifier(callee.expression) && callee.expression.text === "require") argument(node, "require.resolve()");
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "require" && ts.isIdentifier(callee.expression) && callee.expression.text === "module") argument(node, "module.require()");
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "resolve" && ts.isMetaProperty(callee.expression)) argument(node, "import.meta.resolve()");
      else if (isCreateRequireCall(callee)) argument(node, "createRequire()()");
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "resolve" && isCreateRequireCall(callee.expression)) argument(node, "createRequire().resolve()");
      if (isCreateRequireCall(node)) {
        const parent = node.parent;
        const boundToRequire = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.name.text === "require";
        const resolvedHere = ts.isPropertyAccessExpression(parent) && parent.name.text === "resolve" && ts.isCallExpression(parent.parent);
        const calledHere = ts.isCallExpression(parent) && parent.expression === node;
        if (!boundToRequire && !resolvedHere && !calledHere) {
          dynamic.push(`createRequire() alias at line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { literals, dynamic };
}

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** Guard over one repository root. Separate so that the self-test can run it on a temporary tree. */
function createGuard(root: string, composition = false, target?: string) {
  const moduleDirectory = realOrSelf(join(root, target ?? (composition ? COMPOSITION : "src/server/modules/operations")));
  const contractsFile = realOrSelf(join(root, target ?? (composition ? COMPOSITION : "src/shared/contracts/operations.ts")));
  const contractsBase = join(root, target ? target.slice(0, -3) : composition ? COMPOSITION.slice(0, -3) : "src/shared/contracts/operations");
  const moduleBase = join(root, target ? target.slice(0, -3) : composition ? COMPOSITION.slice(0, -3) : "src/server/modules/operations");

  const insideTarget = (path: string) => path === moduleDirectory || path.startsWith(moduleDirectory + sep) || path === contractsFile;

  function specifierBase(fromFile: string, specifier: string): string | null {
    if (specifier.startsWith("file:")) { try { return fileURLToPath(specifier); } catch { return null; } }
    if (specifier === "@" || specifier.startsWith("@/")) return join(root, "src", specifier.slice(2));
    if (specifier.startsWith(".")) return resolve(dirname(fromFile), specifier);
    return isAbsolute(specifier) ? resolve(specifier) : null;
  }

  /** Whether a literal specifier written in `fromFile` reaches the module or its contracts file. */
  function reaches(fromFile: string, specifier: string): boolean {
    const base = specifierBase(fromFile, specifier);
    if (!base) return false;
    // Lexical match first: a missing target with the module's name is still an import of it.
    const lexical = base.replace(/\.(?:[cm]?[jt]sx?|d\.ts)$/, "").replace(/[\\/]index$/, "");
    if (lexical === moduleBase || lexical.startsWith(moduleBase + sep) || lexical === contractsBase) return true;
    // Then by real path, so a symlink anywhere on the way cannot hide the target.
    for (const suffix of RESOLVE_EXTENSIONS) {
      const candidate = base + suffix;
      if (existsSync(candidate) && insideTarget(realOrSelf(candidate))) return true;
    }
    const withoutExtension = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    if (withoutExtension !== base) {
      for (const suffix of [".ts", ".tsx", ".mts", ".cts"]) if (existsSync(withoutExtension + suffix) && insideTarget(realOrSelf(withoutExtension + suffix))) return true;
    }
    return false;
  }

  const exempt = (file: string) => (composition || target) ? /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
    : file === join(root, "src/shared/contracts/operations.ts") || file.startsWith(moduleBase + sep);

  /** The inventory: files to scan and symbolic links found inside it. */
  function inventory(): { files: string[]; symlinks: string[]; missing: string[] } {
    const files: string[] = [], symlinks: string[] = [], missing: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) symlinks.push(path);
        else if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path); }
        else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path);
      }
    };
    for (const directory of INVENTORY_DIRECTORIES) {
      const path = join(root, directory);
      if (existsSync(path) && statSync(path).isDirectory()) walk(path); else missing.push(directory);
    }
    for (const file of ROOT_FILES) {
      const path = join(root, file);
      if (existsSync(path)) files.push(path); else missing.push(file);
    }
    const scanned = new Set(files.filter(file => !exempt(file)));
    if (target) {
      // Test files are exempt only while unreachable from production. Follow
      // literal edges transitively, including cycles and emitted .js specifiers.
      const byRealPath = new Map(files.map(file => [realOrSelf(file), file]));
      for (const file of scanned) {
        for (const specifier of analyse(file, readFileSync(file, "utf8")).literals) {
          const base = specifierBase(file, specifier);
          if (!base) continue;
          const bases = [base, base.replace(/\.(?:[cm]?js|jsx)$/, "")];
          for (const candidate of bases.flatMap(base => RESOLVE_EXTENSIONS.map(suffix => base + suffix))) {
            const imported = byRealPath.get(realOrSelf(candidate));
            if (imported) { scanned.add(imported); break; }
          }
        }
      }
    }
    return { files: [...scanned], symlinks, missing };
  }

  /** Every violation, as stable text lines. */
  function violations(allowlist: Readonly<Record<string, string>>, importers: Readonly<Record<string, string>> = {}): string[] {
    const { files, symlinks } = inventory();
    const found: string[] = [];
    for (const link of symlinks) found.push(`${relative(root, link)}: symbolic link inside the inventory`);
    for (const file of files) {
      const name = relative(root, file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const { literals, dynamic } = analyse(file, text);
      for (const specifier of literals) if (reaches(file, specifier) && !Object.prototype.hasOwnProperty.call(importers, name)) found.push(`${name}: imports ${specifier}`);
      // Text scan of allowlisted production files, including strings/templates
      // feeding computed imports. The module guard keeps its own allowlist semantics.
      if (composition && Object.prototype.hasOwnProperty.call(allowlist, name) && text.includes("operations-runtime")) {
        found.push(`${name}: composition name in allowlisted text scan`);
      }
      if (target && Object.prototype.hasOwnProperty.call(allowlist, name) && text.includes(target.split("/").at(-1)!.replace(/\.ts$/, ""))) {
        found.push(`${name}: target name in allowlisted text scan`);
      }
      if (dynamic.length > 0 && !Object.prototype.hasOwnProperty.call(allowlist, name)) {
        for (const each of dynamic) found.push(`${name}: non-literal ${each}`);
      }
    }
    return found;
  }

  function invalidImporters(importers: Readonly<Record<string, string>>): string[] {
    const files = new Set(inventory().files);
    return Object.entries(importers).flatMap(([name, reason]) => {
      const path = join(root, name);
      return reason.length > 10 && files.has(path) && analyse(path, readFileSync(path, "utf8")).literals.some(specifier => reaches(path, specifier))
        ? [] : [`${name}: approved importer must be a real inventory file importing the module`];
    });
  }
  return { reaches, inventory, violations, invalidImporters };
}

const repository = resolve(".");
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("authorization contract stays unmounted", () => {
  it("has exactly the approved importers and no unlisted non-literal specifier", () => {
    const guard = createGuard(repository);
    const { files, missing } = guard.inventory();
    expect(missing).toEqual([]);
    // The scan covers every inventory root and every root configuration file.
    const roots = new Set(files.map(file => relative(repository, file).split(sep)[0]));
    for (const root of [...INVENTORY_DIRECTORIES, ...ROOT_FILES]) expect(roots.has(root)).toBe(true);
    // Every root-level source file is in the fixed list, so a new one cannot escape the inventory.
    const rootSources = readdirSync(repository, { withFileTypes: true })
      .filter(entry => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))).map(entry => entry.name).sort();
    expect(rootSources).toEqual([...ROOT_FILES].sort());
    expect(guard.violations(ALLOWLIST, APPROVED_IMPORTERS)).toEqual([]);
    expect(guard.invalidImporters(APPROVED_IMPORTERS)).toEqual([]);
  }, 30_000);

  it("allows only the separate MCP listener to mount the request adapter, including indirect production importers", () => {
    const target = "src/server/transports/operations-mcp.ts";
    const approved = { "src/server/mcp-http-server.ts": "mounts request-scoped MCP beside the legacy endpoint with shared Origin and shutdown ownership" };
    const guard = createGuard(repository, false, target);
    expect(guard.violations(ALLOWLIST, approved)).toEqual([]);
    expect(guard.invalidImporters(approved)).toEqual([]);
    const root = mkdtempSync(join(tmpdir(), "unmounted-mcp-")); temporary.push(root);
    for (const name of ["src/server/mcp-http-server.ts", "src/server/http-server.ts", "src/cli/index.ts", "src/server/helper.ts"]) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), 'import "@/server/transports/operations-mcp";');
      expect(createGuard(root, false, target).violations(ALLOWLIST)).toContain(`${name}: imports @/server/transports/operations-mcp`);
    }
    writeFileSync(join(root, "src/server/mcp-http-server.ts"), 'import "./helper";');
    expect(createGuard(root, false, target).violations(ALLOWLIST)).toContain("src/server/helper.ts: imports @/server/transports/operations-mcp");
    expect(createGuard(root, false, target).violations(ALLOWLIST)).not.toContain("src/server/mcp-http-server.ts: imports ./helper");
  }, 30_000);

  it("follows production imports through test files, including emitted specifiers and cycles", () => {
    const target = "src/server/transports/operations-mcp.ts";
    const root = mkdtempSync(join(tmpdir(), "unmounted-mcp-test-hop-")); temporary.push(root);
    const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    write("src/support.test.ts", 'import "./nested.spec.js";');
    write("src/nested.spec.ts", 'import "./support.test"; import "@/server/transports/operations-mcp";');
    const guard = createGuard(root, false, target);
    expect(guard.violations(ALLOWLIST)).toEqual([]); // isolated tests remain exempt
    write("src/production.ts", 'import "./support.test";');
    expect(guard.violations(ALLOWLIST)).toEqual(["src/nested.spec.ts: imports @/server/transports/operations-mcp"]);
  });

  it("text-scans allowlisted production files for computed adapter imports without changing existing guards", () => {
    const target = "src/server/transports/operations-mcp.ts";
    const root = mkdtempSync(join(tmpdir(), "unmounted-mcp-computed-")); temporary.push(root);
    const name = "src/server/modules/authentication/provider-runtime.ts", file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'const path = "./external-provider"; await import(path);');
    expect(createGuard(root, false, target).violations(ALLOWLIST)).toEqual([]);
    for (const text of [
      'const path = "../../transports/operations-mcp"; await import(path);',
      'const path = `../../transports/operations-mcp.${extension}`; await import(path);',
      'const name = "operations-mcp"; await import(`../../transports/${name}`);',
    ]) {
      writeFileSync(file, text);
      expect(createGuard(root, false, target).violations(ALLOWLIST)).toEqual([`${name}: target name in allowlisted text scan`]);
      expect(createGuard(root).violations(ALLOWLIST)).toEqual([]);
      expect(createGuard(root, true).violations(ALLOWLIST)).toEqual([]);
    }
  });

  it("allows only controller start and the unmounted offline composition to import the composition", () => {
    const approved = { "src/cli/index.ts": "controller start constructs the one shared runtime",
      "src/server/bootstrap/offline-operations-runtime.ts": "unmounted offline composition binds the real owner lock" };
    const guard = createGuard(repository, true);
    expect(guard.violations(ALLOWLIST, approved)).toEqual([]);
    expect(guard.invalidImporters(approved)).toEqual([]);
  }, 30_000);

  it("allows exactly the session describe command to mount the offline composition", () => {
    const target = "src/server/bootstrap/offline-operations-runtime.ts";
    const approved = { "src/cli/session-describe.ts": "lock-first CLI read owns one store through drain and close" };
    const guard = createGuard(repository, false, target);
    expect(guard.violations(ALLOWLIST, approved)).toEqual([]);
    expect(guard.invalidImporters(approved)).toEqual([]);
    expect(guard.violations(ALLOWLIST)).toContain("src/cli/session-describe.ts: imports ../server/bootstrap/offline-operations-runtime");
  }, 30_000);

  it("text-scans allowlisted production files for computed composition imports", () => {
    const root = mkdtempSync(join(tmpdir(), "composition-allowlist-")); temporary.push(root);
    const name = "src/server/modules/authentication/provider-runtime.ts";
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    const guard = createGuard(root, true);
    writeFileSync(file, 'const path = "./external-provider"; await import(path);\n');
    expect(guard.violations(ALLOWLIST)).toEqual([]);
    for (const text of [
      'const path = "../../bootstrap/operations-runtime"; await import(path);',
      'const path = `../../bootstrap/operations-runtime.${extension}`; await import(path);',
      'const name = "operations-runtime"; await import(`../../bootstrap/${name}`);',
    ]) {
      writeFileSync(file, text);
      expect(guard.violations(ALLOWLIST)).toEqual([`${name}: composition name in allowlisted text scan`]);
      expect(createGuard(root).violations(ALLOWLIST)).toEqual([]);
    }
  });

  it("rejects unlisted importers and stale approved entries", () => {
    const root = mkdtempSync(join(tmpdir(), "approved-operations-importers-")); temporary.push(root);
    const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    const approved = { [COMPOSITION]: "concrete runtime composition" };
    const guard = createGuard(root);
    expect(guard.invalidImporters(approved)).toHaveLength(1);
    write(COMPOSITION, "export {};\n");
    expect(guard.invalidImporters(approved)).toHaveLength(1);
    write(COMPOSITION, 'import "../modules/operations";\n');
    expect(guard.invalidImporters(approved)).toEqual([]);
    expect(guard.violations({}, approved)).toEqual([]);
    write("src/unlisted.ts", 'import "@/server/modules/operations";\n');
    expect(guard.violations({}, approved)).toEqual(["src/unlisted.ts: imports @/server/modules/operations"]);
    // The second guard also sees production imports from inside the module.
    write("src/server/modules/operations/accidental.ts", 'import "../../bootstrap/operations-runtime";\n');
    expect(createGuard(root, true).violations({})).toEqual([
      "src/server/modules/operations/accidental.ts: imports ../../bootstrap/operations-runtime",
    ]);
  });

  it("lists only existing files that really use non-literal specifiers", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length).toBeGreaterThan(10);
      const path = join(repository, file);
      expect(existsSync(path)).toBe(true);
      expect(analyse(path, readFileSync(path, "utf8")).dynamic.length, file).toBeGreaterThan(0);
    }
  });

  it("would catch every literal import route into the module or its contract", () => {
    const guard = createGuard(repository);
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
      `const url = import(${JSON.stringify(pathToFileURL(resolve("src/server/modules/operations/runner.ts")).href)});`,
      "const template = import(`../operations/decide`);",
      'const resolved = require.resolve("../operations/release");',
      'const meta = import.meta.resolve("../operations/grants");',
    ].join("\n");
    const { literals, dynamic } = analyse(sibling, fixture);
    expect(dynamic).toEqual([]);
    expect(literals.filter(specifier => guard.reaches(sibling, specifier))).toHaveLength(12);
    expect(guard.reaches(modulesRoot, "./operations")).toBe(true);
    expect(guard.reaches(modulesRoot, "./operations/runner")).toBe(true);
    expect(guard.reaches(resolve("scripts/tool.mjs"), "../src/server/modules/operations/index.ts")).toBe(true);
    expect(guard.reaches(resolve("next.config.ts"), "./src/shared/contracts/operations")).toBe(true);
    expect(guard.reaches(resolve("next.config.ts"), pathToFileURL(resolve("src/shared/contracts/operations.ts")).href)).toBe(true);
    // Neighbours with similar names are not the module.
    for (const other of ["./operations-other", "@/server/modules/operationsx", "@/shared/contracts/operations-extra", "operations", "file:///nowhere/operations"]) {
      expect(guard.reaches(modulesRoot, other)).toBe(false);
    }
  });

  it("reports every non-literal specifier and createRequire alias", () => {
    const file = resolve("scripts/tool.mjs");
    const text = [
      'const name = "../src/server/modules/operations/runner";',
      "await import(name);",
      "await import(`../src/${name}`);",
      'require("../x" + name);',
      "require.resolve(name);",
      "import.meta.resolve(name);",
      "module.require(name);",
      'import { createRequire } from "node:module";',
      "const load = createRequire(import.meta.url);",
      'const require = createRequire(import.meta.url); require("node:fs");',
      'createRequire(import.meta.url).resolve("tsx");',
      "createRequire(import.meta.url)(name);",
    ].join("\n");
    const { dynamic, literals } = analyse(file, text);
    expect(dynamic.map(entry => entry.replace(/ at line \d+$/, ""))).toEqual([
      "import()", "import()", "require()", "require.resolve()", "import.meta.resolve()", "module.require()",
      "createRequire() alias", "createRequire()()",
    ]);
    expect(literals).toEqual(["node:module", "node:fs", "tsx"]);
  });

  it("reports a tests import of the module or contract, including a hop from src", () => {
    const root = mkdtempSync(join(tmpdir(), "unmounted-guard-hop-")); temporary.push(root);
    const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    write("src/server/modules/operations/index.ts", "export const x = 1;\n");
    write("src/shared/contracts/operations.ts", "export const y = 1;\n");
    write("tests/support/adapter.ts", 'import { x } from "../../src/server/modules/operations";\n');
    write("tests/types/contract.ts", 'import type { Actor } from "@/shared/contracts/operations";\n');
    const guard = createGuard(root);
    const violations = [
      "tests/support/adapter.ts: imports ../../src/server/modules/operations",
      "tests/types/contract.ts: imports @/shared/contracts/operations",
    ];
    expect(guard.violations({})).toEqual(violations);
    write("src/uses-adapter.ts", 'import "../tests/support/adapter";\n');
    expect(guard.inventory().files).toContain(join(root, "src/uses-adapter.ts"));
    // The hop cannot hide the import: its tests/ target is itself scanned.
    expect(guard.violations({})).toEqual(violations);
  });

  it("finds an import through a symlink and a symlink inside the inventory, and ignores build trees", () => {
    const root = mkdtempSync(join(tmpdir(), "unmounted-guard-")); temporary.push(root);
    const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    write("src/server/modules/operations/index.ts", "export const x = 1;\n");
    write("src/shared/contracts/operations.ts", "export const y = 1;\n");
    for (const file of ROOT_FILES) write(file, "export {};\n");
    write("packages/p/src/a.ts", "export {};\n");
    write("scripts/s.mjs", "export {};\n");
    write("src/clean.ts", 'import "./elsewhere";\n');
    // A dependency tree inside the inventory is not scanned.
    write("packages/p/node_modules/dep/index.js", 'require("../../../../src/server/modules/operations");\n');
    // A symlinked directory hides the module behind another name.
    mkdirSync(join(root, "vendor"));
    symlinkSync(join(root, "src/server/modules/operations"), join(root, "vendor/alias"), "dir");
    write("src/uses-alias.ts", 'import { x } from "../vendor/alias/index";\n');
    const guard = createGuard(root);
    expect(guard.violations({})).toEqual(["src/uses-alias.ts: imports ../vendor/alias/index"]);
    symlinkSync(join(root, "src/server/modules/operations/index.ts"), join(root, "src/link.ts"));
    expect(guard.violations({})).toEqual(["src/link.ts: symbolic link inside the inventory", "src/uses-alias.ts: imports ../vendor/alias/index"]);
    write("scripts/dynamic.mjs", "await import(process.argv[2]);\n");
    expect(guard.violations({})).toContain("scripts/dynamic.mjs: non-literal import() at line 1");
    expect(guard.violations({ "scripts/dynamic.mjs": "fixture" })).not.toContain("scripts/dynamic.mjs: non-literal import() at line 1");
  });
});
