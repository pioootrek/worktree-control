import { describe, expect, it } from "vitest";
import { readingFromImport } from "./knowledge-memory-reading";

describe("imported memory reading projection", () => {
  it("reconstructs the importer's body normalization before projecting", () => {
    expect(readingFromImport(JSON.stringify({ body: "  Text  " }), "Text")).toEqual({ kind: "imported-note", bodyFormat: "text", summary: null });
    expect(readingFromImport(JSON.stringify({ body: { description: "Body description" } }), '{"description":"Body description"}'))
      .toEqual({ kind: "imported-note", bodyFormat: "metadata", summary: "Body description" });
    const manifest = { id: "NOTE-one", summary: "Manifest description" };
    expect(readingFromImport(JSON.stringify(manifest), JSON.stringify(manifest)))
      .toEqual({ kind: "imported-note", bodyFormat: "manifest", summary: "Manifest description" });
    expect(readingFromImport(JSON.stringify({ body: "  " }), "Imported empty note")?.bodyFormat).toBe("text");
    expect(readingFromImport(JSON.stringify({ body: null }), '{"body":null}')?.bodyFormat).toBe("manifest");
  });

  it("fails closed on changed or malformed bodies and bounds the source summary", () => {
    expect(readingFromImport(JSON.stringify({ body: { summary: "Source" } }), "Native edit")).toBeNull();
    expect(readingFromImport("{bad", "{bad")).toBeNull();
    expect(readingFromImport("[]", "[]")).toBeNull();
    const body = { summary: "a".repeat(3000) };
    expect(readingFromImport(JSON.stringify({ body }), JSON.stringify(body))?.summary).toHaveLength(2000);
    expect(readingFromImport(JSON.stringify({ body: { summary: 42, description: "Actual" } }), '{"summary":42,"description":"Actual"}')?.summary).toBe("Actual");
    expect(readingFromImport(JSON.stringify({ body: "x".repeat(131073) }), "x".repeat(131073))).toBeNull();
  });
});
