#!/usr/bin/env node
// Maintainer tool for the optional provider's shipped npm lock.
//   --check  offline: lock ⊆ pnpm-lock.yaml, notices = shipped closure (default)
//   --write  registry access: regenerate the lock pinned to pnpm-lock.yaml versions
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROVIDER_LOCK, checkProviderLock, pnpmLockedPackages, releaseDependencies, shrinkwrapClosure } from "./provider-release.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function write() {
  const { manifest, dependencies } = await releaseDependencies(root);
  const locked = pnpmLockedPackages(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
  const versions = new Map();
  for (const item of locked) { const at = item.lastIndexOf("@"); const name = item.slice(0, at); versions.set(name, [...(versions.get(name) ?? []), item.slice(at + 1)]); }
  const work = await mkdtemp(join(tmpdir(), "wtc-provider-lock-"));
  try {
    const overrides = {};
    for (let round = 0; round < 8; round++) {
      await writeFile(join(work, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, dependencies, overrides }, null, 2));
      await rm(join(work, "package-lock.json"), { force: true });
      await exec("npm", ["install", "--package-lock-only", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, timeout: 120_000 });
      const lock = JSON.parse(await readFile(join(work, "package-lock.json"), "utf8"));
      const drift = [...shrinkwrapClosure(lock)].filter(item => !locked.has(item));
      if (drift.length === 0) {
        // Overrides only steer resolution here; npm ignores them in an installed dependency.
        delete lock.packages[""].overrides;
        lock.packages[""] = { name: manifest.name, version: manifest.version, dependencies };
        await writeFile(join(root, PROVIDER_LOCK), JSON.stringify(lock, null, 2) + "\n");
        return;
      }
      for (const item of drift) {
        const at = item.lastIndexOf("@"), name = item.slice(0, at), version = item.slice(at + 1);
        const candidates = versions.get(name) ?? [];
        if (candidates.length === 0) throw new Error(`${name} is absent from pnpm-lock.yaml; run pnpm install first.`);
        // Select by major so one name may keep several majors (for example tslib 1 and 2).
        const major = version.split(".")[0], pick = candidates.find(value => value.split(".")[0] === major);
        if (!pick) throw new Error(`No pnpm-locked ${name} matches resolved major ${major}.`);
        overrides[`${name}@^${major}`] = pick;
      }
    }
    throw new Error("Provider lock did not converge on pnpm-locked versions.");
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv.includes("--write")) await write();
const problems = await checkProviderLock(root);
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
else console.log(JSON.stringify({ lock: PROVIDER_LOCK, consistent: true }));
