import { describe, expect, it } from "vitest";

import { compactPreview, importedTaskPreview } from "./knowledge-thread-presentation";

describe("discussion previews", () => {
  it("keeps a whole Unicode character at the truncation boundary", () => {
    const source = `${"a".repeat(178)}😀tail`;
    const expected = `${"a".repeat(178)}😀…`;
    expect(compactPreview(source)).toBe(expected);
    expect(importedTaskPreview(JSON.stringify({ problem: [source] }))).toBe(expected);
    expect(Array.from(expected)).toHaveLength(180);
  });
});
