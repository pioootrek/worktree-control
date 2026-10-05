import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HISTORICAL_COMMIT, verifyHistoricalArtifact, verifyTrialFiles } from "./package-artifact.mjs";
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
  for (const required of ["package.json", "CHANGELOG.md", "LICENSE", "README.md", "skills/worktree-control/SKILL.md"]) assert(files.includes(required), `missing ${required}`);
  const allowed = /^(?:package\.json|CHANGELOG\.md|LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|dist\/cli\/|out\/|skills\/|docs\/(?:authentication|controller-https|dependency-licenses|package-trial|user-service|reservations-and-mcp|knowledge-evidence)\.md$)/;
  assert.deepEqual(files.filter(file => !allowed.test(file)), []);
  assert.deepEqual(files.filter(file => /(?:^|\/)(?:site|tests?|\.claude|\.github|src|scripts|measurements|node_modules|\.env[^/]*|state\.sqlite3[^/]*|[^/]*\.log)(?:\/|$)/.test(file)), []);
});
