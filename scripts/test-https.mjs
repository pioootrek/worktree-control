import { spawn } from "node:child_process";

import { CaddyResolveError, resolveCaddyBinary, resolveVitestEntry } from "./https-caddy.mjs";

/**
 * Managed entry for the HTTPS suite: resolves the pinned Caddy fixture (or the
 * explicit CADDY_BIN CI provides), then runs vitest with it. The config keeps
 * its own CADDY_BIN assertion, so a direct vitest invocation still fails
 * truthfully instead of silently skipping the real browser proof.
 */

let binary;
let origin;
let vitest;
try {
  ({ binary, origin } = await resolveCaddyBinary());
  vitest = resolveVitestEntry();
} catch (cause) {
  if (!(cause instanceof CaddyResolveError)) throw cause;
  console.error(`[test:https] ${cause.message}`);
  process.exit(1);
}
console.log(`[test:https] Caddy fixture (${origin}): ${binary}`);

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
