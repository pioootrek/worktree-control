// Shared release metadata and offline lock checks for the optional Better Auth
// provider artifact. The Community package never imports this module.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";

// GitHub Release asset names share one namespace with the Community companions.
export const PROVIDER_RELEASE_FILES = Object.freeze({
  lock: "worktree-control-provider-npm-shrinkwrap.json",
  notices: "worktree-control-provider-THIRD_PARTY_NOTICES.md",
  license: "worktree-control-provider-LICENSE",
  guide: "worktree-control-provider-INSTALL.md",
  checksums: "worktree-control-provider-SHA256SUMS",
  provenance: "worktree-control-provider-provenance.json",
});

export function assertReleasePair(community, provider) {
  assert.equal(community.source?.dirty, false, "Community source must be clean.");
  assert.equal(provider.source?.dirty, false, "Provider source must be clean.");
  assert.match(community.source?.commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(provider.source?.commit, community.source.commit, "Release artifacts must use the same commit.");
  assert.deepEqual(provider.compatibleCore, { name: community.package.name, version: community.package.version }, "Provider must match the Community package.");
  if (community.ci || provider.ci) {
    for (const key of ["repository", "runId", "runAttempt"]) {
      assert.equal(typeof community.ci?.[key], "string", "CI provenance must identify the build run.");
      assert.equal(provider.ci?.[key], community.ci[key], "Release artifacts must use the same CI run and attempt.");
    }
  }
}

export const PROVIDER_SOURCE = "packages/auth-provider-better-auth-proof";
/** Committed npm lock shipped inside the provider tarball; generated only by `provider-lock.mjs --write`. */
export const PROVIDER_LOCK = `${PROVIDER_SOURCE}/release/npm-shrinkwrap.json`;
export const PROVIDER_NOTICES = `${PROVIDER_SOURCE}/THIRD_PARTY_NOTICES.md`;
/** Must equal provider-runtime's recognized contract and implementation. */
export const PROVIDER_CONTRACT = 5;
export const PROVIDER_IMPLEMENTATION = "0.0.0-proof.5";
// The WebAuthn engine is pinned as a direct dependency of the artifact as well
// as the adapter's own direct dependencies.
const WEBAUTHN_PINS = { "@simplewebauthn/server": "13.3.3", "@simplewebauthn/browser": "13.3.0" };

export async function releaseDependencies(root) {
  const manifest = JSON.parse(await readFile(join(root, PROVIDER_SOURCE, "package.json"), "utf8"));
  return { manifest, dependencies: { ...manifest.dependencies, ...WEBAUTHN_PINS } };
}

/** `name@version` keys of the pnpm lockfile `packages:` section (no peer suffixes). */
export function pnpmLockedPackages(text) {
  const found = new Set();
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) { inPackages = line.trim() === "packages:"; continue; }
    if (!inPackages) continue;
    const match = /^ {2}'?((?:@[^@/'\s]+\/)?[^@'\s]+)@([^'():\s]+)'?:\s*$/.exec(line);
    if (match) found.add(`${match[1]}@${match[2]}`);
  }
  return found;
}

/** Installed closure of an npm v3 lockfile, keyed by `name@version`. */
export function shrinkwrapClosure(lock) {
  return new Set(Object.entries(lock.packages ?? {}).filter(([path]) => path !== "")
    .map(([path, entry]) => `${path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`));
}

export function noticeEntries(text) {
  return new Set([...text.matchAll(/^## (\S+@\S+)\s*$/gm)].map(match => match[1]));
}

/** Offline consistency of the shipped lock with the tested pnpm resolution and notices. */
export function providerLockProblems({ lock, dependencies, pnpmLock, notices }) {
  const problems = [];
  const root = lock.packages?.[""];
  if (lock.lockfileVersion !== 3 || !root) problems.push("lock must be an npm lockfileVersion 3 shrinkwrap");
  if (JSON.stringify(root?.dependencies ?? {}) !== JSON.stringify(dependencies)) problems.push("lock root dependencies differ from the release manifest");
  const locked = pnpmLockedPackages(pnpmLock), closure = shrinkwrapClosure(lock), listed = noticeEntries(notices);
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (entry.dev || entry.optional || entry.peer) problems.push(`${path} is dev/optional/peer and must not ship`);
    if (!/^sha512-/.test(entry.integrity ?? "") || !String(entry.resolved ?? "").startsWith("https://registry.npmjs.org/")) problems.push(`${path} lacks registry integrity`);
  }
  for (const item of closure) if (!locked.has(item)) problems.push(`${item} is not the version tested through pnpm-lock.yaml`);
  for (const item of closure) if (!listed.has(item)) problems.push(`${item} has no third-party notice`);
  for (const item of listed) if (!closure.has(item)) problems.push(`notice ${item} is not shipped`);
  return problems;
}

export async function checkProviderLock(root) {
  const [{ dependencies }, lock, pnpmLock, notices] = await Promise.all([releaseDependencies(root),
    readFile(join(root, PROVIDER_LOCK), "utf8").then(JSON.parse), readFile(join(root, "pnpm-lock.yaml"), "utf8"), readFile(join(root, PROVIDER_NOTICES), "utf8")]);
  return providerLockProblems({ lock, dependencies, pnpmLock, notices });
}
