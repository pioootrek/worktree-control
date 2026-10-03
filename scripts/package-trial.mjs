#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function argumentsFor(name) {
  return process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
}

async function run(file, args) {
  return await exec(file, args, { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000 });
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main() {
  await run(process.execPath, ["scripts/build-fingerprint.mjs", "--check"]);
  const metadata = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  if (metadata.private !== true) throw new Error("Trial packaging requires package.json to remain private.");
  if (!/^0\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(metadata.version)) {
    throw new Error("Trial packaging requires an explicit pre-1.0 prerelease version.");
  }

  const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim() !== "";
  const head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const commit = argument("--commit") ?? head;
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full 40-character source commit is required.");
  if (commit !== head) throw new Error("The requested source commit does not match the checked-out build.");

  const output = resolve(repositoryRoot, argument("--output") ?? "dist/package-trial");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error(`Trial output directory must be empty: ${output}`);

  const packed = JSON.parse((await run("npm", ["pack", "--json", "--pack-destination", output])).stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename) {
    throw new Error("npm pack did not return exactly one artifact.");
  }
  if (packed[0].name !== metadata.name || packed[0].version !== metadata.version) {
    throw new Error("npm pack metadata does not match package.json.");
  }
  const tarball = join(output, packed[0].filename);
  const sha256 = await digest(tarball);
  const smokeSource = join(repositoryRoot, "scripts/package-smoke.mjs");
  const smokeTarget = join(output, "package-smoke.mjs");
  const lifecycleSource = join(repositoryRoot, "scripts/package-lifecycle-trial.mjs");
  const lifecycleTarget = join(output, "package-lifecycle-trial.mjs");
  const installSource = join(repositoryRoot, "docs/package-trial.md");
  const installTarget = join(output, "INSTALL.md");
  await Promise.all([
    copyFile(smokeSource, smokeTarget),
    copyFile(join(repositoryRoot, "scripts/package-install.mjs"), join(output, "package-install.mjs")),
    copyFile(lifecycleSource, lifecycleTarget),
    copyFile(installSource, installTarget),
  ]);

  const installText = await readFile(installTarget, "utf8");
  if (!installText.includes(packed[0].filename) || !installText.includes(metadata.version)) {
    throw new Error("The delivered installation guide does not identify this exact trial artifact.");
  }

  const verificationTargets = argumentsFor("--verification-target");
  const provenance = {
    schemaVersion: 1,
    package: { name: metadata.name, version: metadata.version, private: metadata.private },
    source: { commit, dirty },
    artifact: {
      filename: packed[0].filename,
      sha256,
      bytes: (await stat(tarball)).size,
    },
    build: {
      node: process.version,
      npm: (await run("npm", ["--version"])).stdout.trim(),
      pnpm: (await run("pnpm", ["--version"])).stdout.trim(),
    },
    ci: process.env.GITHUB_RUN_ID ? {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    } : null,
    verification: {
      status: "pending-package-smoke",
      targets: verificationTargets.length ? verificationTargets : [`${process.platform}-${process.arch}-node${process.versions.node}`],
    },
    files: {
      checksum: "SHA256SUMS",
      installGuide: "INSTALL.md",
      smoke: "package-smoke.mjs",
      smokeSha256: await digest(smokeTarget),
      installer: "package-install.mjs",
      installerSha256: await digest(join(output, "package-install.mjs")),
      lifecycle: "package-lifecycle-trial.mjs",
      lifecycleSha256: await digest(lifecycleTarget),
    },
  };
  await Promise.all([
    writeFile(join(output, "SHA256SUMS"), `${[[basename(tarball), sha256], [provenance.files.smoke, provenance.files.smokeSha256], [provenance.files.installer, provenance.files.installerSha256], [provenance.files.lifecycle, provenance.files.lifecycleSha256]].map(([file, hash]) => `${hash}  ${file}`).join("\n")}\n`, { mode: 0o600 }),
    writeFile(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 }),
  ]);
  process.stdout.write(`${JSON.stringify({ output, tarball, provenance }, null, 2)}\n`);
}

await main();
