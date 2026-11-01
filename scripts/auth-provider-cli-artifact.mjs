import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

// Finite, private proof artifact only. Nothing is installed into the service or Community dist.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "provider-emitted-cli-"));
const emitted = join(temporary, `emitted-${randomUUID()}`);
const children = new Set();
const sentinel = "fixture-sensitive-cli-password-123";
function start(args, input) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 65536) child.kill("SIGKILL"); });
  child.stderr.on("data", bytes => { stderr += bytes; if (stderr.length > 65536) child.kill("SIGKILL"); });
  const done = new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => { children.delete(child); accept({ code, signal, stdout, stderr }); }); });
  child.stdin.on("error", () => {}); child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  assert(!child.spawnargs.some(value => value.includes(sentinel)));
  return { child, done, output: () => ({ stdout, stderr }) };
}
async function finish(run, timeoutMs = 15000) {
  let timeout;
  try { return await Promise.race([run.done, new Promise((_, reject) => { timeout = setTimeout(() => { run.child.kill("SIGKILL"); reject(new Error("Finite emitted CLI verification timed out.")); }, timeoutMs); })]); }
  finally { clearTimeout(timeout); }
}
async function cli(directory, args, input, expectedCode = 0) {
  const result = await finish(start(["dist/cli/index.js", "auth", "provider", ...args, "--data-dir", join(directory, "data"), "--state-dir", join(directory, "state")], input));
  assert.equal(result.code, expectedCode, `emitted CLI result: ${result.stderr}`);
  assert(!`${result.stdout}${result.stderr}`.includes(sentinel));
  return JSON.parse(expectedCode === 0 ? result.stdout : result.stderr);
}
try {
  mkdirSync(emitted, { recursive: true, mode: 0o700 });
  symlinkSync(join(root, "packages/auth-provider-better-auth-proof/node_modules"), join(emitted, "node_modules"), "dir");
  const build = await finish(start(["node_modules/tsup/dist/cli-default.js", "packages/auth-provider-better-auth-proof/src/index.ts",
    "--format", "esm", "--platform", "node", "--target", "node22", "--out-dir", emitted,
    "--external", "better-auth", "--external", "@better-auth/core", "--external", "kysely"]));
  assert.equal(build.code, 0, build.stderr);
  const entry = join(emitted, "index.js");
  assert(existsSync(entry));
  const installation = join(temporary, "healthy"); mkdirSync(installation, { mode: 0o700 });
  const configInput = { module: entry, origin: "https://controller.test", signingSecret: { kind: "generate" } };
  await cli(installation, ["configure", "--input-stdin"], configInput);
  const configuration = join(installation, "data/authentication-provider.json"), material = readFileSync(configuration);
  const principalId = (await cli(installation, ["owner", "create"])).principal.id;
  const enroll = { email: "owner@fixture.invalid", name: "Owner", password: sentinel };
  assert.deepEqual(await cli(installation, ["enroll", "--principal-id", principalId, "--input-stdin"], enroll), { principalId, enrolled: true });
  assert.deepEqual(await cli(installation, ["recover", "--principal-id", principalId, "--input-stdin"], { newPassword: sentinel }), { principalId, recovered: true });
  assert.deepEqual(readFileSync(configuration), material);
  const status = await cli(installation, ["status", "--principal-id", principalId]);
  assert.equal(status.principal.enrollment, "active"); assert.equal(status.maintenance, "not_loaded");
  assert.equal(status.productionAccountModeAvailable, false);
  assert(!existsSync(join(installation, "state/admin.sock")));
  assert(!existsSync(join(installation, "state/controller.lock")));
  assert(!existsSync(join(installation, "data/state.sqlite3.owner.lock")));
  // Exercise raw main dispatch before global stripping. No input read or data publication on duplicate paths.
  const invalid = await cli(installation, ["status", "--data-dir", join(temporary, "must-not-create")], undefined, 1);
  assert.equal(invalid.code, "invalid_input"); assert(!existsSync(join(temporary, "must-not-create")));

  // A real finite CLI child must remain alive with both actual locks after an uncertain dispose.
  const failingModule = join(emitted, "dispose-failure.mjs");
  writeFileSync(failingModule, `import { authenticationProvider as provider } from ${JSON.stringify(pathToFileURL(entry).href)};
export const authenticationProvider = { ...provider, async create(host, options) {
  const instance = await provider.create(host, options);
  return new Proxy(instance, { get(target, key) {
    if (key === 'dispose') return async () => { await target.dispose(); throw new Error('private-dispose-sentinel'); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
} };`, { mode: 0o600 });
  const fatal = join(temporary, "retained"); mkdirSync(fatal, { mode: 0o700 });
  await cli(fatal, ["configure", "--input-stdin"], { ...configInput, module: failingModule });
  const fatalId = (await cli(fatal, ["owner", "create"])).principal.id;
  const retained = start(["dist/cli/index.js", "auth", "provider", "enroll", "--principal-id", fatalId, "--input-stdin",
    "--data-dir", join(fatal, "data"), "--state-dir", join(fatal, "state")], enroll);
  const deadline = Date.now() + 12000;
  while (!retained.output().stderr.includes("cleanupConfirmed") && Date.now() < deadline) await pause(25);
  const error = JSON.parse(retained.output().stderr);
  assert.equal(error.code, "disposal_unconfirmed"); assert.equal(error.cleanupConfirmed, false); assert.equal(error.committed, true);
  assert(!JSON.stringify(retained.output()).includes(sentinel)); assert(!retained.output().stderr.includes("private-dispose-sentinel"));
  await pause(100); assert.equal(retained.child.exitCode, null); process.kill(retained.child.pid, 0);
  assert(existsSync(join(fatal, "state/controller.lock"))); assert(existsSync(join(fatal, "data/state.sqlite3.owner.lock")));
  assert.equal((await cli(fatal, ["status"], undefined, 1)).code, "admin_outcome_unknown");
  retained.child.kill("SIGKILL"); await retained.done; // Only our finite fixture process. Production never forces this exit.
  console.log(JSON.stringify({ result: "passed", emittedModuleSha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    verified: ["fresh-built-cli-local-js-import", "offline-configure-owner-enroll-recover", "strict-global-path-flags", "stable-material", "real-fatal-owner-process-retention"] }));
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(emitted, { recursive: true, force: true }); rmSync(temporary, { recursive: true, force: true });
}
