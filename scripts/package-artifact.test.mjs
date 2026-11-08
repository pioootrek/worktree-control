import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HISTORICAL_COMMIT, PUBLIC_BASELINE, verifyHistoricalArtifact, verifyPublicBaseline, verifyTrialFiles } from "./package-artifact.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "wts-artifact-input-"));
  try {
    const bytes = Buffer.from("local-artifact-fixture"), tarball = join(root, "old.tgz"), record = join(root, "provenance.json");
    const provenance = { schemaVersion: 1, package: { name: "worktree-switcher", version: "0.1.0-trial.1", private: true }, source: { commit: HISTORICAL_COMMIT, dirty: false }, artifact: { filename: "old.tgz", sha256: sha(bytes), bytes: bytes.length }, build: { node: process.version } };
    await writeFile(tarball, bytes); await writeFile(record, JSON.stringify(provenance));
    await fn({ root, tarball, record, provenance });
  } finally { await rm(root, { recursive: true, force: true }); }
}
test("pins exact historical clean source and refuses substituted bytes before provisioning", async () => fixture(async f => {
  assert.equal((await verifyHistoricalArtifact(f.tarball, f.record)).source.commit, HISTORICAL_COMMIT);
  await writeFile(f.tarball, "different"); await assert.rejects(verifyHistoricalArtifact(f.tarball, f.record), /mismatch/);
}));
for (const kind of ["wrong-commit", "dirty", "unsupported-version"]) test(`refuses historical provenance ${kind}`, async () => fixture(async f => {
  if (kind === "wrong-commit") f.provenance.source.commit = "a".repeat(40);
  else if (kind === "dirty") f.provenance.source.dirty = true;
  else f.provenance.package.version = "0.2.0";
  await writeFile(f.record, JSON.stringify(f.provenance)); await assert.rejects(verifyHistoricalArtifact(f.tarball, f.record), /mismatch/);
}));
test("bounds historical provenance and refuses directory inputs", async () => fixture(async f => {
  await assert.rejects(verifyHistoricalArtifact(f.root, f.record), /regular-file/);
  await writeFile(f.record, "x".repeat(32769)); await assert.rejects(verifyHistoricalArtifact(f.tarball, f.record), /bounds/);
}));
test("checks the imported installer companion and checksum manifest before executing delivered smoke", async () => fixture(async f => {
  const files = { smoke: "package-smoke.mjs", installer: "package-install.mjs", lifecycle: "package-lifecycle-trial.mjs" };
  for (const key of Object.keys(files)) { await writeFile(join(f.root, files[key]), `fixture ${key}`); files[`${key}Sha256`] = sha(await readFile(join(f.root, files[key]))); }
  const provenance = { artifact: f.provenance.artifact, files };
  const sums = [[provenance.artifact.filename, provenance.artifact.sha256], ...["smoke", "installer", "lifecycle"].map(key => [files[key], files[`${key}Sha256`]])].map(([file, hash]) => `${hash}  ${file}`).join("\n");
  await writeFile(join(f.root, "SHA256SUMS"), sums); await verifyTrialFiles(f.root, provenance);
  await writeFile(join(f.root, files.installer), "tampered executable helper"); await assert.rejects(verifyTrialFiles(f.root, provenance), /companion/);
}));
test("current manifest is a publishable pre-1.0 worktree-control package whose file list stays on the allowlist", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "worktree-control");
  assert.match(manifest.version, /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.notEqual(manifest.private, true, "a private manifest cannot be published");
  assert.match(manifest.scripts?.prepublishOnly ?? "", /process\.exit\(1\)/, "publishing from a checkout must be refused by prepublishOnly");
  await assert.rejects(promisify(execFile)("npm", ["run", "--silent", "prepublishOnly"], { cwd: root }), error => /Refusing npm publish from a checkout/.test(error.stderr));
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const files = JSON.parse(stdout)[0].files.map(file => file.path);
  for (const required of ["package.json", "CHANGELOG.md", "LICENSE", "README.md", "skills/worktree-control/SKILL.md", "docs/dev-environment-vault.md", "docs/environment-runtime-plan.md", "docs/godot-web.md"]) assert(files.includes(required), `missing ${required}`);
  const allowed = /^(?:package\.json|CHANGELOG\.md|LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|dist\/cli\/|out\/|skills\/|docs\/(?:authentication|controller-https|dependency-licenses|dev-environment-vault|environment-runtime-plan|package-trial|user-service|reservations-and-mcp|knowledge-evidence|godot-web)\.md$)/;
  assert.deepEqual(files.filter(file => !allowed.test(file)), []);
  assert.deepEqual(files.filter(file => /(?:^|\/)(?:site|tests?|\.claude|\.github|src|scripts|measurements|node_modules|\.env[^/]*|state\.sqlite3[^/]*|[^/]*\.log)(?:\/|$)/.test(file)), []);
});
test("the optional Better Auth provider stays outside the Community manifest and root dependency graph", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const providerPackage = /^(?:better-auth|@better-auth\/|@simplewebauthn\/|kysely$|@worktree-control\/auth-provider)/;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies", "bundleDependencies", "bundledDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}).filter(name => providerPackage.test(name)), [], `${field} must not name the provider`);
  }
  const proof = JSON.parse(await readFile(join(root, "packages/auth-provider-better-auth-proof/package.json"), "utf8"));
  assert.equal(proof.private, true, "the proof package must never be publishable");
  assert.deepEqual(proof.dependencies, { "@better-auth/core": "1.7.14", "@better-auth/passkey": "1.7.14", "@better-auth/utils": "0.5.1", "better-auth": "1.7.14", kysely: "0.28.17" }, "provider pins stay exact");
  const notices = await readFile(join(root, "packages/auth-provider-better-auth-proof/THIRD_PARTY_NOTICES.md"), "utf8");
  for (const name of ["better-auth@1.7.14", "@better-auth/core@1.7.14", "kysely@0.28.17", "@better-auth/passkey@1.7.14", "@better-auth/utils@0.5.1", "@simplewebauthn/server@13.3.3", "@simplewebauthn/browser@13.3.0"]) assert(notices.includes(`## ${name}\n`), `missing notice for ${name}`);
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  const rootImporter = lock.slice(lock.indexOf("\n  .:\n"), lock.indexOf("\n  packages/auth-provider-better-auth-proof:\n"));
  assert(rootImporter.length > 0, "the lockfile lists the root importer before the proof importer");
  assert.doesNotMatch(rootImporter, /^\s{6}(?:better-auth|'@better-auth\/[^']+'|kysely):$/m, "the root importer must not resolve provider packages");
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout)[0].files.map(file => file.path).filter(path => path.startsWith("packages/")), []);
});
test("fresh Community CLI and dashboard assets contain no optional provider implementation", async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fingerprint = await promisify(execFile)("node", ["scripts/build-fingerprint.mjs", "--check"], { cwd: root }).then(() => true, () => false);
  if (!fingerprint) { t.skip("built assets are absent or stale; test:package:tools requires a fresh build before this scan"); return; }
  const { readdir } = await import("node:fs/promises");
  const markers = [/@better-auth\//, /@simplewebauthn\//, /passkey_fixture_/, /BETTER_AUTH_SECRET/, /auth-provider-better-auth-proof/, /from\s*["']kysely["']/, /require\(["']kysely["']\)/];
  const scan = async directory => {
    let count = 0;
    const hash = createHash("sha256");
    const visit = async current => {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) await visit(path);
        else {
          const bytes = await readFile(path);
          for (const marker of markers) assert.doesNotMatch(bytes.toString("utf8"), marker, `${path} contains provider code`);
          hash.update(path.slice(directory.length)); hash.update("\0"); hash.update(bytes); hash.update("\0"); count++;
        }
      }
    };
    await visit(directory);
    assert(count > 0, `${directory} must contain built files`);
    t.diagnostic(`provider exclusion scanned ${directory}: ${count} files, sha256 ${hash.digest("hex")}`);
  };
  await scan(join(root, "dist", "cli"));
  await scan(join(root, "out"));
});
test("pins the public npm baseline by size, sha256 and registry sha512 and refuses substituted bytes", async () => {
  assert.equal(PUBLIC_BASELINE.version, "0.1.1"); assert.equal(PUBLIC_BASELINE.schema, 28);
  assert.match(PUBLIC_BASELINE.sha256, /^[a-f0-9]{64}$/); assert.match(PUBLIC_BASELINE.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  const root = await mkdtemp(join(tmpdir(), "wtc-public-baseline-"));
  try {
    const short = join(root, "short.tgz"); await writeFile(short, "not the release");
    await assert.rejects(verifyPublicBaseline(short), /size mismatch/);
    const substituted = join(root, "worktree-control-0.1.1.tgz"); await writeFile(substituted, Buffer.alloc(PUBLIC_BASELINE.bytes));
    await assert.rejects(verifyPublicBaseline(substituted), /checksum mismatch/);
    await assert.rejects(verifyPublicBaseline(root), /size mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
