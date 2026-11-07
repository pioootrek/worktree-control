import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!existsSync(fileURLToPath(new URL("./dist/cli/index.js", import.meta.url))) || !existsSync(fileURLToPath(new URL("./out/index.html", import.meta.url)))) {
  throw new Error("E2E artifacts are missing. Run pnpm build before pnpm test:e2e.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalTimeout: 360_000,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "off",
  },
});
