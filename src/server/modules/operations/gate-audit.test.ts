import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
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
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^(?:it|test|step)(?:$|[.(])/.test(node.expression.getText(source))) {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteralLike(title) || ts.isTemplateExpression(title))) {
        found.add(ts.isStringLiteralLike(title) ? title.text : title.getText(source).slice(1, -1));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return found;
}
function missing(row: Evidence, read: (file: string) => string): string[] {
  let source: string;
  try { source = read(row.file); } catch { return [`gate_audit_missing_file: ${row.file}`]; }
  return titles(row.file, source).has(row.title) ? [] : [`gate_audit_missing_title: ${row.file}: ${row.title}`];
}

describe("D1a gate audit drift guard", () => {
  it("every documented assertion and artifact step exists verbatim in the named source and preset", () => {
    const rows = evidence(readFileSync(resolve(root, "docs/authorization-gate-evidence.md"), "utf8"));
    expect(rows.length).toBeGreaterThanOrEqual(176);
    expect(new Set(rows.map(row => row.item)).size).toBe(rows.length);
    const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
    const cache = new Map<string, string>();
    const read = (file: string) => {
      if (!cache.has(file)) cache.set(file, readFileSync(resolve(root, file), "utf8"));
      return cache.get(file)!;
    };
    for (const row of rows) {
      expect(missing(row, read), row.item).toEqual([]);
      expect(scripts[row.preset.replace(/^node:/, "")], row.item).toBeTruthy();
      expect(["proven before this step", "added in this step"], row.item).toContain(row.status);
    }
  }, 20_000);

  it("negative control: renamed title fails for exactly the named file and title", () => {
    const row = { item: "fixture", file: "src/fixture.test.ts", title: "expected title", preset: "node:check", status: "added in this step" };
    expect(missing(row, () => 'it("renamed title", () => {});')).toEqual([
      "gate_audit_missing_title: src/fixture.test.ts: expected title",
    ]);
    expect(missing(row, () => 'const note = "expected title";')).toEqual([
      "gate_audit_missing_title: src/fixture.test.ts: expected title",
    ]);
    expect(missing(row, () => { throw new Error("absent"); })).toEqual(["gate_audit_missing_file: src/fixture.test.ts"]);
    expect(missing(row, () => 'it("expected title", () => {});')).toEqual([]);
  });
});
