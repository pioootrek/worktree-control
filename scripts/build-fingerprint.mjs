import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marker = join(root, "dist", "build-source.sha256");
const inputs = [
  "src",
  "components.json",
  "next.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  // Workspace importers and overrides decide the installed Community graph.
  // The optional provider under packages/ is not a Community build input.
  "pnpm-workspace.yaml",
  "postcss.config.mjs",
  "tsconfig.json",
];

function files(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => files(join(path, entry.name)));
}

function fingerprint() {
  const hash = createHash("sha256");
  for (const path of inputs.flatMap((input) => files(join(root, input))).sort()) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const mode = process.argv[2];
if (mode === "--write") {
  writeFileSync(marker, `${fingerprint()}\n`, { mode: 0o600 });
} else if (mode === "--check") {
  const expected = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (!expected || expected !== fingerprint()) {
    console.error("Build artifacts do not match the current sources. Run pnpm build first.");
    process.exitCode = 1;
  }
} else {
  throw new Error("Usage: node scripts/build-fingerprint.mjs --write|--check");
}
