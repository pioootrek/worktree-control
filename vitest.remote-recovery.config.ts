import { defineConfig } from "vitest/config";
import integration from "./vitest.integration.config";

// Explicit opt-in: the worker crash intentionally retains uncertain evidence.
export default defineConfig({
  test: {
    ...integration.test,
    include: ["tests/integration/remote-cli-recovery.test.ts"],
    exclude: [],
  },
});
