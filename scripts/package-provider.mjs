#!/usr/bin/env node
// Packs the optional Better Auth provider as a separate release artifact beside
// the Community tarball. It is never an npm dependency of `worktree-control`
// and this script never publishes anything.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROVIDER_CONTRACT, PROVIDER_IMPLEMENTATION, PROVIDER_RELEASE_FILES } from "./provider-release.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const run = (file, args) => exec(file, args, { cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 });
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");

const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim() !== "";
const head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
const commit = argument("--commit") ?? head;
if (commit !== head) throw new Error("The requested source commit does not match the checked-out build.");
// The default directory is this script's own ignored build output and is replaced.
const output = resolve(root, argument("--output") ?? "dist/provider-release");
if (!argument("--output")) await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
if ((await readdir(output)).length !== 0) throw new Error(`Provider output directory must be empty: ${output}`);

const work = await mkdtemp(join(tmpdir(), "wtc-provider-release-"));
try {
  // Two independent builds must produce byte-identical tarballs.
  const builds = [];
  for (const name of ["first", "second"]) {
    await run(process.execPath, ["scripts/build-auth-provider.mjs", "--out", join(work, name)]);
    builds.push(JSON.parse(await readFile(join(work, name, "artifact.json"), "utf8")));
  }
  if (builds[0].sha256 !== builds[1].sha256 || builds[0].dependencyLockSha256 !== builds[1].dependencyLockSha256) {
    throw new Error("Provider artifact is not reproducible: two builds differ.");
  }
  const built = join(work, "first"), artifact = builds[0];
  const core = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(built, "package.json"), "utf8"));
  const { checksums, provenance: provenanceName, ...companions } = PROVIDER_RELEASE_FILES;
  const files = { tarball: artifact.filename, ...companions };
  await Promise.all([
    copyFile(join(built, artifact.filename), join(output, files.tarball)),
    copyFile(join(built, "npm-shrinkwrap.json"), join(output, files.lock)),
    copyFile(join(built, "THIRD_PARTY_NOTICES.md"), join(output, files.notices)),
    copyFile(join(built, "LICENSE"), join(output, files.license)),
    copyFile(join(root, "docs/release-packaging.md"), join(output, files.guide)),
  ]);
  const sums = await Promise.all(Object.values(files).map(async file => [file, await digest(join(output, file))]));
  const provenance = {
    schemaVersion: 1,
    kind: "optional-authentication-provider",
    package: { name: manifest.name, version: manifest.version, private: manifest.private === true, license: manifest.license },
    provider: { id: artifact.providerId, contract: PROVIDER_CONTRACT, implementationVersion: PROVIDER_IMPLEMENTATION },
    compatibleCore: { name: core.name, version: core.version },
    source: { commit, dirty },
    artifact: { filename: files.tarball, sha256: artifact.sha256, bytes: (await stat(join(output, files.tarball))).size },
    dependencyLock: { filename: files.lock, sha256: artifact.dependencyLockSha256, pinnedTo: "pnpm-lock.yaml", dependencies: artifact.dependencies },
    reproducibility: { builds: 2, identical: true },
    build: { node: process.version, npm: (await run("npm", ["--version"])).stdout.trim() },
    ci: process.env.GITHUB_RUN_ID ? { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : null,
    // A separate GitHub Release asset; private:true still refuses npm publication.
    distribution: "separate-optional-artifact",
    files,
  };
  await writeFile(join(output, checksums), sums.map(([file, hash]) => `${hash}  ${file}`).join("\n") + "\n", { mode: 0o600 });
  await writeFile(join(output, provenanceName), JSON.stringify(provenance, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ output, provenance }, null, 2));
} finally { await rm(work, { recursive: true, force: true }); }
