import { describe, expect, it } from "vitest";
import { searchExcerpt } from "./knowledge-search-snippet";

describe("knowledge search excerpts", () => {
  it("shows a late literal hit instead of the opening text", () => {
    const body = `${"Opening text. ".repeat(55)}A [literal] %_ match near the end.`;
    const result = searchExcerpt(body, "[literal] %_");
    expect(result).toMatchObject({ matchedBody: true });
    expect(result.excerpt).toContain("[literal] %_");
    expect(result.excerpt.startsWith("…")).toBe(true);
    expect(Array.from(result.excerpt).length).toBeLessThan(250);
  });

  it("maps decomposed accents, emoji, and contextual final sigma to source spans", () => {
    expect(searchExcerpt(`Prefix ${"x".repeat(240)} ŁO\u0301DZ\u0301 🧭 ending`, "łódź 🧭")).toMatchObject({matchedBody:true});
    expect(searchExcerpt(`Prefix ${"x".repeat(240)} ΟΣ ending`, "ος")).toMatchObject({matchedBody:true});
    expect(searchExcerpt(`Prefix ${"x".repeat(240)} ΟΣ ending`, "ος").excerpt).toContain("ΟΣ");
  });

  it("does not present an opening excerpt as a body hit", () => {
    expect(searchExcerpt("Opening body only", "thread topic")).toEqual({excerpt:"Opening body only",matchedBody:false});
  });
});
