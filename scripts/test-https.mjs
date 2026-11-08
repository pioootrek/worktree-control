import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveCaddyBinary } from "./https-caddy.mjs";

/**
 * Managed entry for the HTTPS suite: resolves the pinned Caddy fixture (or the
 * explicit CADDY_BIN CI provides), then runs vitest with it. The config keeps
 * its own CADDY_BIN assertion, so a direct vitest invocation still fails
 * truthfully instead of silently skipping the real browser proof.
 */

const { binary, origin } = await resolveCaddyBinary();
console.log(`[test:https] Caddy fixture (${origin}): ${binary}`);

const vitest = fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));
const child = spawn(process.execPath, [vitest, "run", "--config", "vitest.https.config.ts"], {
  stdio: "inherit",
  env: { ...process.env, CADDY_BIN: binary },
});

child.on("error", cause => {
  console.error(`[test:https] Failed to start vitest: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
