import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, dirname, matchesGlob } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
type Evidence = { item: string; file: string; title: string; preset: string; status: string };
function evidence(markdown: string): Evidence[] {
  return markdown.split("\n").filter(line => /^\| .* \| `(?:src|packages|scripts)\//.test(line)).map(line => {
    const fields = line.split("|").slice(1, -1).map(value => value.trim().replace(/^`|`$/g, ""));
    if (fields.length !== 5) throw new Error("gate_audit_invalid_row");
    const [item, file, title, preset, status] = fields;
    return { item, file, title, preset, status };
  });
}
// Changing accepted totals, status counts or artifact keys is a review decision.
const ACCEPTED_GATE_ROWS = 191, ACCEPTED_ARTIFACT_CELLS = 21;
const ACCEPTED_STATUSES: Record<string, number> = { "proven before this step": 136, "added in this step": 72,
  "not applicable": 4, "partially proven": 0, deferral: 0, defect: 0 };
const ACCEPTED_MATRIX_KEYS = ["api-bearer", "api-cookie", "unix", "worker-tls", "mcp", "cli-socket", "cli-offline"]
  .flatMap(surface => ["open", "token", "better-auth"].map(mode => `${surface}/${mode}`)).sort();
function titles(file: string, text: string, expectedFailure = false): Set<string> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const script = file.startsWith("scripts/"), found = new Set<string>(), called = new Set<string>();
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  for (const node of source.statements) {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) functions.set(declaration.name.text, declaration.initializer);
    }
  }
  const unwrap = (node: ts.Expression): ts.Expression => ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const visit = (node: ts.Node) => {
    // Enter only known registration callbacks or directly called script helpers.
    if (ts.isFunctionLike(node)) return;
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      for (const statement of node.statements) {
        visit(statement);
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) break;
      }
      return;
    }
    if (ts.isConditionalExpression(node) || (ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))) return;
    if (ts.isIfStatement(node)) {
      if (node.expression.kind === ts.SyntaxKind.TrueKeyword) visit(node.thenStatement);
      if (node.expression.kind === ts.SyntaxKind.FalseKeyword && node.elseStatement) visit(node.elseStatement);
      return;
    }
    if (ts.isTryStatement(node)) {
      // The installed script's outer reporting boundary cannot swallow failure:
      // its catch unconditionally marks the process failed. All other try paths
      // are rejected, including test registration inside try/catch.
      const failsProcess = node.catchClause?.block.statements.some(statement => ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        statement.expression.left.getText(source) === "process.exitCode" && statement.expression.right.getText(source) === "1");
      if (script && ts.isSourceFile(node.parent) && failsProcess) visit(node.tryBlock);
      return;
    }
    if (ts.isForOfStatement(node)) {
      const array = unwrap(node.expression);
      if (ts.isArrayLiteralExpression(array) && array.elements.length && !array.elements.some(ts.isSpreadElement)) visit(node.statement);
      return;
    }
    // Index-based for loops have more ways to be empty; fail closed.
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)) return;
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      const registration = /^(?:it|test|describe|suite|step)(?:$|[.(])/.test(expression);
      if (registration) {
        const callee = ts.isCallExpression(node.expression) ? node.expression.expression.getText(source) : expression;
        if (!/^(?:(?:it|test|describe|suite)(?:\.fails)?(?:\.each)?|step)$/.test(callee)) return;
        if (/\.(?:skip|todo|only)(?:\b|\()/.test(expression)) return;
        const fails = /\.fails(?:\b|\()/.test(expression);
        if (fails && !expectedFailure) return;
        if (ts.isCallExpression(node.expression) && /\.each$/.test(node.expression.expression.getText(source))) {
          const table = node.expression.arguments[0];
          if (table && ts.isArrayLiteralExpression(unwrap(table)) && !(unwrap(table) as ts.ArrayLiteralExpression).elements.length) return;
        }
        const title = node.arguments[0];
        if (/^(?:it|test|step)(?:$|[.(])/.test(expression) && (!expectedFailure || fails) && title &&
          (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))) {
          found.add(ts.isStringLiteralLike(title) ? title.text : title.getText(source).slice(1, -1));
        }
        if (/^(?:describe|suite)(?:$|[.(])/.test(expression) || (script && expression === "step")) {
          for (const argument of node.arguments) if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) visit(argument.body);
        }
        return;
      }
      if (script && ts.isIdentifier(node.expression) && !called.has(node.expression.text)) {
        const fn = functions.get(node.expression.text);
        if (fn?.body) { called.add(node.expression.text); visit(fn.body); }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return found;
}
type Read = (file: string) => string;
function includesFromConfig(file: string, read: Read): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const patterns: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "include" && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) if (ts.isStringLiteralLike(element)) patterns.push(element.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return patterns;
}
function presetRuns(file: string, preset: string, read: Read, seen = new Set<string>()): boolean {
  const name = preset.replace(/^node:/, "");
  if (seen.has(name)) return false;
  seen.add(name);
  const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;
  const script = scripts[name];
  if (!script) return false;
  return script.split(/\s*&&\s*/).some(command => {
    const words = command.trim().split(/\s+/);
    if (["pnpm", "npm", "yarn"].includes(words[0])) {
      const name = words[1] === "run" ? words[2] : words[1];
      return !!name && presetRuns(file, name, read, seen);
    }
    if (file.startsWith("scripts/")) {
      if (words[0] !== "node") return false;
      let index = 1;
      // Accept flags before the entry point; reject eval/print and unknown flags
      // whose argument grammar could turn the file into ordinary argv data.
      while (index < words.length && words[index].startsWith("-")) {
        if (["--import", "--require", "-r", "--conditions"].includes(words[index])) index += 2;
        else if (/^--(?:no-warnings|enable-source-maps|trace-warnings|test|import=.+|require=.+|conditions=.+)$/.test(words[index])) index++;
        else return false;
      }
      return words[index] === file;
    }
    if (words[0] !== "vitest" || words[1] !== "run") return false;
    let config = "vitest.config.ts";
    const filters: string[] = [];
    for (let i = 2; i < words.length; i++) {
      if (words[i] === "--config") { config = words[++i]; continue; }
      if (words[i] === "--maxWorkers") { i++; continue; }
      if (words[i].startsWith("-")) return false;
      filters.push(words[i]);
    }
    // Read the selected config, including the provider config, rather than
    // duplicating its include grammar here. Vitest CLI filters are substrings.
    return includesFromConfig(config, read).some(pattern => matchesGlob(file, pattern)) &&
      (!filters.length || filters.some(filter => file.includes(filter)));
  });
}
function missing(row: Evidence, read: Read, cache?: Map<string, Set<string>>): string[] {
  let source: string;
  try { source = read(row.file); } catch { return [`gate_audit_missing_file: ${row.file}`]; }
  const expectedFailure = row.status.startsWith("defect: ");
  const cacheKey = `${row.file}/${expectedFailure}`;
  const active = cache?.get(cacheKey) ?? titles(row.file, source, expectedFailure);
  cache?.set(cacheKey, active);
  const errors = active.has(row.title) ? [] : [`gate_audit_missing_title: ${row.file}: ${row.title}`];
  if (!presetRuns(row.file, row.preset, read)) errors.push(`gate_audit_wrong_preset: ${row.file}: ${row.preset}`);
  return errors;
}
function matrixKeys(rows: Evidence[]) {
  const surfaces: Record<string, string> = { "API bearer": "api-bearer", "unix socket": "unix", "worker TLS": "worker-tls", "MCP initialize/list/call": "mcp", "CLI socket": "cli-socket", "CLI offline": "cli-offline", "API cookie": "api-cookie" };
  return rows.filter(row => row.item.startsWith("Installed ")).map(row => {
    const match = /^Installed (.*): (.*)$/.exec(row.item);
    return match && surfaces[match[1]] ? `${surfaces[match[1]]}/${match[2]}` : "invalid-cell";
  }).sort();
}
function inventory(markdown: string, read: Read) {
  const rows = evidence(markdown), errors: string[] = [], cache = new Map<string, Set<string>>();
  const totals = /Gate rows: (\d+)\. Artifact cells: (\d+)\./.exec(markdown);
  const cells = matrixKeys(rows);
  if (!totals || Number(totals[1]) !== ACCEPTED_GATE_ROWS || Number(totals[2]) !== ACCEPTED_ARTIFACT_CELLS || rows.length - cells.length !== ACCEPTED_GATE_ROWS || cells.length !== ACCEPTED_ARTIFACT_CELLS) errors.push("gate_audit_totals");
  // The script's explicit expected set must match the document, not just size 21.
  const script = read("scripts/package-rbac.mjs");
  const expected = /const EXPECTED_OPERATIONS_MATRIX_KEYS = (\[[\s\S]*?\]);/.exec(script);
  if (!expected || JSON.stringify(cells) !== JSON.stringify(ACCEPTED_MATRIX_KEYS) || JSON.stringify(JSON.parse(expected[1]).sort()) !== JSON.stringify(ACCEPTED_MATRIX_KEYS) || new Set(cells).size !== cells.length) errors.push("gate_audit_matrix");
  const statuses: Record<string, number> = {};
  for (const row of rows) {
    const status = row.status.split(":")[0]; statuses[status] = (statuses[status] ?? 0) + 1;
    errors.push(...missing(row, read, cache));
    if (!["proven before this step", "added in this step"].includes(row.status) && !/^(?:partially proven:|deferral:|not applicable:|defect:) .+/.test(row.status)) errors.push(`gate_audit_status: ${row.item}`);
  }
  if (Object.entries(ACCEPTED_STATUSES).some(([status, count]) => (statuses[status] ?? 0) !== count)) errors.push("gate_audit_status_totals");
  if (new Set(rows.map(row => row.item)).size !== rows.length) errors.push("gate_audit_duplicates");
  return errors;
}

// Each control uses real files in a disposable tree, including preset/config.
function fixture(run: (read: Read, put: (file: string, text: string) => void) => void) {
  const directory = mkdtempSync(resolve(tmpdir(), "gate-guard-"));
  const put = (file: string, text: string) => { mkdirSync(dirname(resolve(directory, file)), { recursive: true }); writeFileSync(resolve(directory, file), text); };
  put("package.json", JSON.stringify({ scripts: { check: "pnpm test", test: "vitest run", focused: "vitest run src/other.test.ts", provider: "vitest run --config provider.ts allowed", artifact: "node scripts/other.mjs" } }));
  put("vitest.config.ts", 'export default {test:{include:["src/**/*.test.ts"]}}');
  put("provider.ts", 'export default {test:{include:["packages/proof/**/*.test.ts"]}}');
  try { run(file => readFileSync(resolve(directory, file), "utf8"), put); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const row = { item: "fixture", file: "src/fixture.test.ts", title: "expected title", preset: "node:check", status: "added in this step" };
describe("D1a gate audit drift guard", () => {
  it("every documented assertion and artifact step exists verbatim in the named source and preset", () => {
    const cache = new Map<string, string>();
    const read = (file: string) => { if (!cache.has(file)) cache.set(file, readFileSync(resolve(root, file), "utf8")); return cache.get(file)!; };
    expect(inventory(read("docs/authorization-gate-evidence.md"), read)).toEqual([]);
  });
  it("negative control: renamed title fails for exactly the named file and title", () => fixture((read, put) => {
    for (const source of ['it("renamed title", () => {});', 'const note = "expected title";']) {
      put(row.file, source); expect(missing(row, read)).toEqual(["gate_audit_missing_title: src/fixture.test.ts: expected title"]);
    }
    expect(missing({ ...row, file: "src/absent.test.ts" }, read)).toEqual(["gate_audit_missing_file: src/absent.test.ts"]);
    put(row.file, 'it("expected title", () => {});'); expect(missing(row, read)).toEqual([]);
  }));
  it("negative control: skipped, todo, expected-failure and empty-table assertions are not proof", () => fixture((read, put) => {
    for (const source of ['it.skip("expected title", () => {});', 'it.todo("expected title");', 'test.skip("expected title", () => {});', 'describe.skip("outer", () => { describe("inner", () => {it("expected title", () => {});}); });', 'it.each([])("expected title", () => {});', 'test.each([] as const)("expected title", () => {});', 'it.fails("expected title", () => {});']) {
      put(row.file, source); expect(missing(row, read), source).toContain(`gate_audit_missing_title: ${row.file}: ${row.title}`);
    }
  }));
  it("negative control: unreachable registrations fail for false/dynamic conditions, uncalled functions, nested arrows and swallowed try", () => fixture((read, put) => {
    for (const source of [
      'if (false) { it("expected title", () => {}); }',
      'if (runtimeFlag) { it("expected title", () => {}); }',
      'function unused() { it("expected title", () => {}); }',
      'describe("outer", () => { () => it("expected title", () => {}); });',
      'try { it("expected title", () => {}); } catch {}',
      'false && it("expected title", () => {});',
      'runtimeFlag ? it("expected title", () => {}) : undefined;',
      'describe("outer", () => { return; it("expected title", () => {}); });',
      'it.skipIf(runtimeFlag)("expected title", () => {});',
    ]) {
      put(row.file, source); expect(missing(row, read), source).toContain(`gate_audit_missing_title: ${row.file}: ${row.title}`);
    }
    for (const source of [
      'suite("outer", () => { test("expected title", () => {}); });',
      'describe.each([1])("outer", () => { for (const n of [1, 2] as const) { it("expected title", () => {}); } });',
      'if (true) { it("expected title", () => {}); }',
    ]) { put(row.file, source); expect(missing(row, read), source).toEqual([]); }
    const script = { ...row, file: "scripts/other.mjs", preset: "node:artifact" };
    for (const source of [
      'if (false) { step("expected title", () => {}); }',
      'if (runtimeFlag) { step("expected title", () => {}); }',
      'function unused() { step("expected title", () => {}); }',
      '() => step("expected title", () => {});',
      'try { step("expected title", () => {}); } catch {}',
    ]) { put(script.file, source); expect(missing(script, read), source).toContain(`gate_audit_missing_title: ${script.file}: ${row.title}`); }
    put(script.file, 'async function run() { await step("expected title", () => {}); } await run();');
    expect(missing(script, read)).toEqual([]);
  }));
  it("negative control: echo and node eval cannot masquerade as script invocation", () => fixture((read, put) => {
    const script = { ...row, file: "scripts/fixture.mjs", preset: "node:artifact" };
    put(script.file, 'step("expected title", () => {});');
    for (const command of ["echo scripts/fixture.mjs", "node -e scripts/fixture.mjs", "node other.mjs scripts/fixture.mjs"]) {
      put("package.json", JSON.stringify({ scripts: { artifact: command } }));
      expect(missing(script, read), command).toContain(`gate_audit_wrong_preset: ${script.file}: node:artifact`);
    }
    for (const command of ["node scripts/fixture.mjs", "node --no-warnings --import tsx scripts/fixture.mjs", "pnpm run nested", "npm run nested", "yarn nested"]) {
      put("package.json", JSON.stringify({ scripts: { artifact: command, nested: "node scripts/fixture.mjs" } }));
      expect(missing(script, read), command).toEqual([]);
    }
  }));
  it("negative control: presets must select the file through their script, include pattern and filter", () => fixture((read, put) => {
    put(row.file, 'it("expected title", () => {});');
    expect(missing({ ...row, preset: "node:focused" }, read)).toContain(`gate_audit_wrong_preset: ${row.file}: node:focused`);
    put("vitest.config.ts", 'export default {test:{include:["different/**/*.test.ts"]}}');
    expect(missing(row, read)).toContain(`gate_audit_wrong_preset: ${row.file}: node:check`);
    put("scripts/fixture.mjs", 'step("expected title", () => {});');
    expect(missing({ ...row, file: "scripts/fixture.mjs", preset: "node:artifact" }, read)).toContain("gate_audit_wrong_preset: scripts/fixture.mjs: node:artifact");
    for (const file of ["packages/proof/denied.test.ts", "packages/outside/allowed.test.ts"]) {
      put(file, 'it("expected title", () => {});'); expect(missing({ ...row, file, preset: "node:provider" }, read)).toContain(`gate_audit_wrong_preset: ${file}: node:provider`);
    }
    put("packages/proof/allowed.test.ts", 'it("expected title", () => {});');
    expect(missing({ ...row, file: "packages/proof/allowed.test.ts", preset: "node:provider" }, read)).toEqual([]);
  }));
  it("negative control: deleting rows and their stated totals or replacing artifact keys fails anchored inventory", () => {
    const read = (file: string) => readFileSync(resolve(root, file), "utf8");
    const document = read("docs/authorization-gate-evidence.md");
    const rows = document.split("\n");
    const gate = rows.find(line => /^\| Unit:/.test(line))!;
    const cell = rows.find(line => /^\| Installed MCP initialize/.test(line))!;
    expect(inventory(document.replace(gate, "").replace("Gate rows: 191", "Gate rows: 190"), read)).toContain("gate_audit_totals");
    const removedCell = document.replace(cell, "").replace("Artifact cells: 21", "Artifact cells: 20");
    expect(inventory(removedCell, read)).toContain("gate_audit_totals");
    expect(inventory(removedCell, read)).toContain("gate_audit_matrix");
    expect(inventory(document.replace("call: open", "call: token"), read)).toContain("gate_audit_matrix");
    const changedScript: Read = file => file === "scripts/package-rbac.mjs" ? read(file).replace('"mcp/open"', '"mcp/unknown"') : read(file);
    expect(inventory(document, changedScript)).toContain("gate_audit_matrix");
  });
  it("negative control: downgrading proof or inventing a defect cannot bypass source validation or status totals", () => {
    const read = (file: string) => readFileSync(resolve(root, file), "utf8");
    const document = read("docs/authorization-gate-evidence.md");
    expect(inventory(document.replace("| proven before this step |", "| partially proven: review |"), read)).toContain("gate_audit_status_totals");
    const defect = document.replace("| proven before this step |", "| defect: expected failure |");
    expect(inventory(defect, read)).toContain("gate_audit_status_totals");
    expect(inventory(defect, read).some(error => error.startsWith("gate_audit_missing_title:"))).toBe(true);
  });
  it("negative control: defects still require an existing reachable expected-failure test and matching preset", () => fixture((read, put) => {
    const defect = { ...row, status: "defect: tracked failure" };
    expect(missing(defect, read)).toContain(`gate_audit_missing_file: ${row.file}`);
    put(row.file, 'it.fails("expected title", () => {});'); expect(missing(defect, read)).toEqual([]);
    expect(missing({ ...defect, preset: "node:focused" }, read)).toContain(`gate_audit_wrong_preset: ${row.file}: node:focused`);
    put(row.file, 'if (false) { it.fails("expected title", () => {}); }');
    expect(missing(defect, read)).toContain(`gate_audit_missing_title: ${row.file}: ${row.title}`);
  }));
});
