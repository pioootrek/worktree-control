import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_LOCK, PROVIDER_NOTICES, checkProviderLock, noticeEntries, pnpmLockedPackages, providerLockProblems, releaseDependencies, shrinkwrapClosure } from "./provider-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function committed() {
  const [{ dependencies }, lock, pnpmLock, notices] = await Promise.all([releaseDependencies(root),
    readFile(join(root, PROVIDER_LOCK), "utf8").then(JSON.parse), readFile(join(root, "pnpm-lock.yaml"), "utf8"), readFile(join(root, PROVIDER_NOTICES), "utf8")]);
  return { dependencies, lock, pnpmLock, notices };
}

test("the shipped provider lock is the pnpm-tested closure and every shipped package has a notice", async () => {
  assert.deepEqual(await checkProviderLock(root), []);
});

test("refuses a shipped version that pnpm-lock.yaml did not test", async () => {
  const input = await committed();
  input.lock.packages["node_modules/jose"].version = "6.2.15";
  assert.match(providerLockProblems(input).join("\n"), /jose@6\.2\.15 is not the version tested/);
});

test("refuses a missing or stale third-party notice", async () => {
  const input = await committed();
  const missing = { ...input, notices: input.notices.replace("## tslib@2.8.1", "## removed") };
  assert.match(providerLockProblems(missing).join("\n"), /tslib@2\.8\.1 has no third-party notice/);
  const stale = { ...input, notices: `${input.notices}\n## left-pad@1.3.0\n` };
  assert.match(providerLockProblems(stale).join("\n"), /notice left-pad@1\.3\.0 is not shipped/);
});

test("refuses dev entries, registry-less entries and changed direct dependencies", async () => {
  const input = await committed();
  input.lock.packages["node_modules/kysely"] = { ...input.lock.packages["node_modules/kysely"], dev: true, integrity: undefined };
  const problems = providerLockProblems({ ...input, dependencies: { ...input.dependencies, kysely: "0.28.18" } }).join("\n");
  assert.match(problems, /kysely is dev\/optional\/peer/);
  assert.match(problems, /kysely lacks registry integrity/);
  assert.match(problems, /root dependencies differ/);
});

test("parses pnpm package keys without peer suffixes or snapshot entries", () => {
  const text = "lockfileVersion: '9.0'\npackages:\n\n  '@scope/a@1.0.0':\n    resolution: {}\n\n  b@2.0.0:\n    resolution: {}\nsnapshots:\n\n  c@3.0.0(react@19.0.0):\n    dependencies: {}\n";
  assert.deepEqual([...pnpmLockedPackages(text)], ["@scope/a@1.0.0", "b@2.0.0"]);
  assert.deepEqual([...shrinkwrapClosure({ packages: { "": {}, "node_modules/x": { version: "1.0.0" }, "node_modules/x/node_modules/@s/y": { version: "2.0.0" } } })], ["x@1.0.0", "@s/y@2.0.0"]);
  assert.deepEqual([...noticeEntries("# T\n\n## @s/y@2.0.0\n\nLicense: MIT\n")], ["@s/y@2.0.0"]);
});
