import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/integration/**/*.test.ts"], fileParallelism: false, maxWorkers: 1, testTimeout: 60_000, hookTimeout: 60_000 },
});
