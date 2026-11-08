import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "dist/private-auth-provider");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true, mode: 0o700 });
const source = join(root, "packages/auth-provider-better-auth-proof");
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
await exec(process.execPath, [join(root, "node_modules/tsup/dist/cli-default.js"), join(source, "src/index.ts"),
  "--format", "esm", "--platform", "node", "--target", "node22", "--out-dir", join(target, "dist"),
  ...Object.keys(manifest.dependencies).flatMap(name => ["--external", name])], { cwd: root, timeout: 60_000 });
await writeFile(join(target, "package.json"), JSON.stringify({ ...manifest,
  description: "Optional local integrated Better Auth adapter for Worktree Control. Separately installed; excluded from Community.",
  main: "dist/index.js", exports: "./dist/index.js", files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md"], engines: { node: ">=22" } }, null, 2) + "\n");
await copyFile(join(root, "LICENSE"), join(target, "LICENSE"));
await copyFile(join(source, "THIRD_PARTY_NOTICES.md"), join(target, "THIRD_PARTY_NOTICES.md"));
const packed = JSON.parse((await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", target], { cwd: target, timeout: 60_000 })).stdout)[0];
const path = join(target, packed.filename);
const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
await writeFile(join(target, "artifact.json"), JSON.stringify({ path, sha256, providerId: "better-auth", contract: 5,
  implementationVersion: "0.0.0-proof.5", dependencies: manifest.dependencies }, null, 2) + "\n");
console.log(JSON.stringify({ path, sha256, distribution: "private-local-optional", communityIncluded: false }));
