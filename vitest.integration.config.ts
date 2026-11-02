import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const cli = fileURLToPath(new URL("./dist/cli/index.js", import.meta.url));
const dashboard = fileURLToPath(new URL("./out/index.html", import.meta.url));
if (!existsSync(cli) || !existsSync(dashboard)) {
  throw new Error("Integration artifacts are missing or stale. Run pnpm build before pnpm test:integration.");
}

// Integration fixtures may inspect source-owned locks/stores; the controller
// and CLI under test still execute the fingerprinted dist artifacts.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["tests/integration/remote-cli-recovery.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
