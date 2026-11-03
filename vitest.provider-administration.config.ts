import { defineConfig } from "vitest/config";
import integration from "./vitest.integration.config";

export default defineConfig({
  ...integration,
  test: { ...integration.test, include: ["tests/integration/provider-administration.test.ts"] },
});
