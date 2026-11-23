import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts"],
    // Files create durable SQLite databases and fork fixture processes; bound their combined resource use.
    maxWorkers: 2,
    // Tests use real SQLite and forked fixture processes; the 5 s default failed on loaded CI runners.
    testTimeout: 15_000,
  },
});
