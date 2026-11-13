import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Slice 1 is unmounted: no production file outside this module may import it
 * or its shared contract. Remove this check in the slice that mounts it.
 */
describe("authorization contract stays unmounted", () => {
  it("is imported by no production file outside the module", () => {
    const root = resolve("src");
    const own = "server/modules/operations/";
    const importers = readdirSync(root, { recursive: true })
      .filter((file): file is string => typeof file === "string" && /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map(file => relative(root, resolve(root, file)).replaceAll("\\", "/"))
      .filter(file => !file.startsWith(own))
      .filter(file => /(?:modules\/operations|contracts\/operations)["'/]/.test(readFileSync(resolve(root, file), "utf8")));
    expect(importers).toEqual([]);
  });
});
