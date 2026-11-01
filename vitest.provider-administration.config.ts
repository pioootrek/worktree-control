import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import integration from "./vitest.integration.config";

export default defineConfig({
  ...integration,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { ...integration.test, include: ["tests/integration/provider-administration.test.ts"] },
});
