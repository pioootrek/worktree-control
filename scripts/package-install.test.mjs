import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyInstalledDriver } from "./package-install.mjs";
async function driver(source, check) {
  const root = await mkdtemp(join(tmpdir(), "wts-driver-protocol-"));
  try { const path = join(root, "driver.mjs"); await writeFile(path, source); await check(path, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("bounded explicit driver accepts JSON only after clean process exit", () => driver('console.log(JSON.stringify({evidence:"fixture",cleanup:{ok:true},steps:[{name:"completed"}]}))', async (path, root) => {
  assert.equal((await verifyInstalledDriver(path, root, [], root)).evidence.cleanup.ok, true);
}));
test("driver failure diagnostics preserve safe phase and cleanup without child secrets", () => driver('console.error("wsi_PRIVATE secret/path"); console.log(JSON.stringify({errorCode:"fixture_failed",failureStep:"cleanup",cleanup:{ok:false},steps:[{name:"restore"}],secret:"PRIVATE"})); process.exitCode=1', async (path, root) => {
  await assert.rejects(verifyInstalledDriver(path, root, [], root), error => error.message.includes('"exitCode":1') && error.message.includes('"failureStep":"cleanup"') && error.message.includes('"cleanup":"failed"') && !error.message.includes("PRIVATE") && !error.message.includes("secret/path"));
}));
test("malformed driver output cannot enter public failure diagnostics", () => driver('console.log("wsi_PRIVATE secret/path"); process.exitCode=1', async (path, root) => {
  await assert.rejects(verifyInstalledDriver(path, root, [], root), error => error.message.includes('"outputKind":"invalid-json"') && !error.message.includes("PRIVATE") && !error.message.includes("secret/path"));
}));

test("valid JSON with malformed diagnostic fields stays a bounded failure", () => driver('console.log(JSON.stringify({errorCode:"fixture_failed",failureStep:"wsi_PRIVATE secret/path",steps:{at:"PRIVATE"}})); process.exitCode=1', async (path, root) => {
  await assert.rejects(verifyInstalledDriver(path, root, [], root), error => error.message.includes('"outputKind":"fixture-error"') && error.message.includes('"lastCompletedStep":null') && !error.message.includes("PRIVATE") && !error.message.includes("secret/path"));
}));
