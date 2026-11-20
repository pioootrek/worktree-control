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
function titles(file: string, text: string): Set<string> {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node, skipped = false) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (/^(?:it|test|describe)(?:$|[.(])/.test(expression)) {
        skipped ||= /\.(?:skip|todo|fails)(?:\b|\()/.test(expression);
        if (ts.isCallExpression(node.expression) && /\.each$/.test(node.expression.expression.getText(source))) {
          let table = node.expression.arguments[0];
          while (table && ts.isAsExpression(table)) table = table.expression;
          skipped ||= !!table && ts.isArrayLiteralExpression(table) && table.elements.length === 0;
        }
      }
      if (!skipped && /^(?:it|test|step)(?:$|[.(])/.test(expression)) {
        const title = node.arguments[0];
        if (title && (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))) {
          found.add(ts.isStringLiteralLike(title) ? title.text : title.getText(source).slice(1, -1));
        }
      }
    }
    ts.forEachChild(node, child => visit(child, skipped));
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
    if (words[0] === "pnpm") return presetRuns(file, words[1], read, seen);
    if (file.startsWith("scripts/")) return words.includes(file);
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
function missing(row: Evidence, read: Read): string[] {
  let source: string;
  try { source = read(row.file); } catch { return [`gate_audit_missing_file: ${row.file}`]; }
  const errors = titles(row.file, source).has(row.title) ? [] : [`gate_audit_missing_title: ${row.file}: ${row.title}`];
  if (!presetRuns(row.file, row.preset, read)) errors.push(`gate_audit_wrong_preset: ${row.file}: ${row.preset}`);
  return errors;
}
function matrixKeys(rows: Evidence[]) {
  const surfaces: Record<string, string> = { "API bearer": "api-bearer", "unix": "unix", "worker TLS": "worker-tls", "MCP initialize/list/call": "mcp", "CLI socket": "cli-socket", "CLI offline": "cli-offline", "API cookie": "api-cookie" };
  return rows.filter(row => row.item.startsWith("Installed ")).map(row => {
    const match = /^Installed (.*): (.*)$/.exec(row.item);
    return match && surfaces[match[1]] ? `${surfaces[match[1]]}/${match[2]}` : "invalid-cell";
  }).sort();
}
function inventory(markdown: string, read: Read) {
  const rows = evidence(markdown), errors: string[] = [];
  const totals = /Gate rows: (\d+)\. Artifact cells: (\d+)\./.exec(markdown);
  const cells = matrixKeys(rows);
  if (!totals || rows.length - cells.length !== Number(totals[1]) || cells.length !== Number(totals[2])) errors.push("gate_audit_totals");
  // The script's explicit expected set must match the document, not just size 21.
  const script = read("scripts/package-rbac.mjs");
  const expected = /const EXPECTED_OPERATIONS_MATRIX_KEYS = (\[[\s\S]*?\]);/.exec(script);
  if (!expected || JSON.stringify(cells) !== JSON.stringify(JSON.parse(expected[1]).sort()) || new Set(cells).size !== cells.length) errors.push("gate_audit_matrix");
  for (const row of rows) {
    if (/^(?:defect:|partially proven:|deferral:|not applicable:)/.test(row.status)) continue;
    errors.push(...missing(row, read));
    if (!["proven before this step", "added in this step"].includes(row.status)) errors.push(`gate_audit_status: ${row.item}`);
  }
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
  it("negative control: deleting a row or replacing a matrix key fails despite unchanged counts", () => fixture((read, put) => {
    put(row.file, 'it("expected title", () => {});');
    put("scripts/package-rbac.mjs", 'const EXPECTED_OPERATIONS_MATRIX_KEYS = ["mcp/open"];\nstep("expected title", () => {});');
    put("package.json", JSON.stringify({ scripts: { check: "vitest run", artifact: "node scripts/package-rbac.mjs" } }));
    const gate = '| fixture | `src/fixture.test.ts` | `expected title` | `node:check` | added in this step |';
    const cell = '| Installed MCP initialize/list/call: open | `scripts/package-rbac.mjs` | `expected title` | `node:artifact` | added in this step |';
    const document = `Gate rows: 1. Artifact cells: 1.\n${gate}\n${cell}`;
    expect(inventory(document, read)).toEqual([]);
    expect(inventory(document.replace(gate, ""), read)).toContain("gate_audit_totals");
    expect(inventory(document.replace(cell, ""), read)).toContain("gate_audit_totals");
    expect(inventory(document.replace("call: open", "call: token"), read)).toContain("gate_audit_matrix");
    put("scripts/package-rbac.mjs", 'const EXPECTED_OPERATIONS_MATRIX_KEYS = ["mcp/token"];\nstep("expected title", () => {});');
    expect(inventory(document, read)).toContain("gate_audit_matrix");
  }));
});
