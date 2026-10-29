import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/** Real Better Auth proof tests for the optional provider package; never part of `pnpm test`. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["packages/auth-provider-better-auth-proof/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
