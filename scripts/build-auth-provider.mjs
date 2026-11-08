import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROVIDER_CONTRACT, PROVIDER_IMPLEMENTATION, PROVIDER_LOCK, PROVIDER_NOTICES, PROVIDER_SOURCE, checkProviderLock, releaseDependencies } from "./provider-release.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const target = resolve(root, outIndex > 0 ? process.argv[outIndex + 1] : "dist/private-auth-provider");
// Ship the committed lock pinned to the pnpm-tested closure; never re-resolve
// dependencies from the registry at build time.
const problems = await checkProviderLock(root);
if (problems.length) throw new Error(`Provider lock is inconsistent; run node scripts/provider-lock.mjs --write:\n${problems.join("\n")}`);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true, mode: 0o700 });
const source = join(root, PROVIDER_SOURCE);
const { manifest, dependencies } = await releaseDependencies(root);
await exec(process.execPath, [join(root, "node_modules/tsup/dist/cli-default.js"), join(source, "src/index.ts"),
  "--format", "esm", "--platform", "node", "--target", "node22", "--out-dir", join(target, "dist"),
  ...Object.keys(manifest.dependencies).flatMap(name => ["--external", name])], { cwd: root, timeout: 60_000 });
await writeFile(join(target, "package.json"), JSON.stringify({ ...manifest,
  description: "Optional local integrated Better Auth adapter for Worktree Control. Separately installed; excluded from Community.",
  dependencies, main: "dist/index.js", exports: "./dist/index.js", files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md", "npm-shrinkwrap.json"], engines: { node: ">=22" } }, null, 2) + "\n");
await copyFile(join(root, "LICENSE"), join(target, "LICENSE"));
await copyFile(join(root, PROVIDER_NOTICES), join(target, "THIRD_PARTY_NOTICES.md"));
await copyFile(join(root, PROVIDER_LOCK), join(target, "npm-shrinkwrap.json"));
const dependencyLockSha256 = createHash("sha256").update(await readFile(join(target, "npm-shrinkwrap.json"))).digest("hex");
const packed = JSON.parse((await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", target], { cwd: target, timeout: 60_000 })).stdout)[0];
const path = join(target, packed.filename);
const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
const core = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(join(target, "artifact.json"), JSON.stringify({ path, filename: packed.filename, sha256, providerId: "better-auth", contract: PROVIDER_CONTRACT,
  implementationVersion: PROVIDER_IMPLEMENTATION, coreVersion: core.version, dependencies, dependencyLockSha256 }, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256, distribution: "private-local-optional", communityIncluded: false }));
