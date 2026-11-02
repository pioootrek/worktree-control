import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BackupOperation } from "../../src/shared/contracts/backups";
import { SqliteStateStore } from "../../src/server/infrastructure/sqlite";
import { acquireControllerLock } from "../../src/server/controller-lock";
import { startControllerFixture, waitFor, type ControllerFixture, type FixtureCliResult } from "../support/controller-fixture";

const root = resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);
const password = "fixture-private-main-password-123";
const replacement = "fixture-private-main-recovered-456";
const faultHook = join(root, "tests/support/provider-driver-close-fault.mjs");
let emitted: string, entry: string, observedEntry: string, fixture: ControllerFixture | undefined;

beforeAll(async () => {
  emitted = await mkdtemp(join(tmpdir(), "provider-main-emitted-"));
  await symlink(join(root, "packages/auth-provider-better-auth-proof/node_modules"), join(emitted, "node_modules"), "dir");
  await exec(process.execPath, ["node_modules/tsup/dist/cli-default.js", "packages/auth-provider-better-auth-proof/src/index.ts",
    "--format", "esm", "--platform", "node", "--target", "node22", "--out-dir", emitted,
    "--external", "better-auth", "--external", "@better-auth/core", "--external", "kysely"], { cwd: root, timeout: 20_000 });
  entry = join(emitted, "index.js");
  observedEntry = join(emitted, "observed.mjs");
  await writeFile(observedEntry, `import { authenticationProvider as provider } from ${JSON.stringify(pathToFileURL(entry).href)};
export const authenticationProvider = { ...provider, async create(host, options) {
  const instance = await provider.create(host, options);
  return new Proxy(instance, { get(target, key) {
    if (key === "dispose") return async () => { await target.dispose(); process.stderr.write("fixture.provider_disposed\\n"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
} };`, { mode: 0o600 });
});
afterEach(async () => { const current = fixture; fixture = undefined; await current?.close(); });
afterAll(async () => { if (emitted) await rm(emitted, { recursive: true, force: true }); });

function body(result: FixtureCliResult, code = 0) {
  expect(result.code).toBe(code); expect(result.signal).toBeNull();
  expect(result.stdout + result.stderr).not.toContain(password);
  expect(result.stdout + result.stderr).not.toContain(replacement);
  if (code === 0) { expect(result.stderr).toBe(""); return JSON.parse(result.stdout); }
  expect(result.stdout).toBe(""); return JSON.parse(result.stderr);
}
async function provider(f: ControllerFixture, args: string[], input?: unknown, code = 0) {
  return body(await f.cliResult(["auth", "provider", ...args], input), code);
}
function inspect<T>(f: ControllerFixture, operation: (database: Database.Database) => T): T {
  // Committed observation only, never a second writable controller/store owner.
  const database = new Database(join(f.paths.data, "state.sqlite3"), { readonly: true, fileMustExist: true });
  try { return operation(database); } finally { database.close(); }
}
function authorityRows(f: ControllerFixture) {
  return inspect(f, database => Object.fromEntries(["principal_credentials", "knowledge_project_grants", "knowledge_role_bindings", "runtime_credential_scopes"]
    .map(table => [table, database.prepare(`SELECT * FROM ${table}`).all()])));
}
async function assertOwners(f: ControllerFixture, held: boolean) {
  for (const path of [join(f.paths.state, "controller.lock"), join(f.paths.data, "state.sqlite3.owner.lock")]) {
    expect(existsSync(path)).toBe(held);
    if (held) expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(f.processState().pid);
  }
  if (held) {
    expect(() => acquireControllerLock(join(f.paths.state, "controller.lock"))).toThrow(/already running/);
    expect(() => new SqliteStateStore(join(f.paths.data, "state.sqlite3"))).toThrow(/already running/);
  } else {
    const lock = acquireControllerLock(join(f.paths.state, "controller.lock"));
    let store: SqliteStateStore | undefined;
    try { store = new SqliteStateStore(join(f.paths.data, "state.sqlite3")); }
    finally { await store?.closeAfterDrain(); lock.release(); }
  }
}
async function enroll(f: ControllerFixture, source = entry) {
  expect(await provider(f, ["configure", "--input-stdin"], { module: source, origin: "https://controller.test", signingSecret: { kind: "generate" } }))
    .toEqual({ configured: true, configurationRestartRequired: false });
  const { principal } = await provider(f, ["owner", "create"]);
  const path = join(f.paths.base, "private-enrollment.json");
  await writeFile(path, JSON.stringify({ email: "owner@fixture.invalid", name: "Owner", password }), { mode: 0o600 });
  expect(await provider(f, ["enroll", "--principal-id", principal.id, "--input-file", path])).toEqual({ principalId: principal.id, enrolled: true });
  return principal.id as string;
}
async function assertNoSecrets(f: ControllerFixture) {
  const config = JSON.parse(await readFile(join(f.paths.data, "authentication-provider.json"), "utf8"));
  let logs = f.diagnostics();
  const files = await readdir(join(f.paths.state, "logs"), { recursive: true, withFileTypes: true });
  expect(files.length).toBeLessThan(100);
  for (const file of files) if (file.isFile()) logs += await readFile(join(file.parentPath, file.name), "utf8");
  for (const secret of [password, replacement, config.secret, "fixture-driver-close-private-sentinel"]) expect(logs.includes(secret), "Sensitive provider material must not appear in logs.").toBe(false);
}

describe("actual built CLI provider administration (isolated controller, zero managed projects)", () => {
  it.each(["token", "open"] as const)("dispatches the complete private IPC workflow outside core admission with active %s and pending mode", async mode => {
    const f = fixture = await startControllerFixture(0);
    if (mode === "open") { body(await f.cliResult(["auth", "mode", "set", "open"])); await f.restart(); }
    body(await f.cliResult(["auth", "mode", "set", mode === "token" ? "open" : "token"]));
    const policy = body(await f.cliResult(["auth", "status"])), authority = authorityRows(f);
    expect(policy).toMatchObject({ activeMode: mode, configuredMode: mode === "token" ? "open" : "token", restartRequired: true });
    const id = await enroll(f);
    const configuration = await readFile(join(f.paths.data, "authentication-provider.json"));
    const before = inspect(f, database => database.prepare("SELECT * FROM authentication_ba_account").get()) as { id: string; userId: string; password: string };
    expect(await provider(f, ["recover", "--principal-id", id, "--input-stdin"], { newPassword: replacement })).toEqual({ principalId: id, recovered: true });
    const after = inspect(f, database => database.prepare("SELECT * FROM authentication_ba_account").get()) as typeof before;
    expect(after.id).toBe(before.id); expect(after.userId).toBe(before.userId); expect(after.password).not.toBe(before.password);
    expect(await provider(f, ["status", "--principal-id", id])).toMatchObject({ activeMode: mode, configuredMode: policy.configuredMode,
      modeRestartRequired: true, maintenance: "ready", productionAccountModeAvailable: false,
      principal: { id, kind: "owner", status: "active", enrollment: "active" } });
    expect(await provider(f, ["enroll", "--principal-id", id, "--input-stdin"], { email: "owner@fixture.invalid", name: "Owner", password }, 1))
      .toEqual({ code: "subject_conflict", error: "The principal has provider enrollment history; enrollment is refused." });
    expect(await provider(f, ["owner", "create"], undefined, 1)).toEqual({ code: "owner_already_initialized", error: "An owner principal already exists. Inspect private provider status." });
    const deniedMode = await f.cliResult(["auth", "mode", "set", "better-auth"]);
    expect(deniedMode.code).toBe(1); expect(deniedMode.stderr).toContain("Better Auth");
    expect(body(await f.cliResult(["auth", "status"]))).toEqual(policy);
    expect(createHash("sha256").update(await readFile(join(f.paths.data, "authentication-provider.json"))).digest("hex"))
      .toBe(createHash("sha256").update(configuration).digest("hex"));
    expect(authorityRows(f)).toEqual(authority);
    expect(inspect(f, database => database.prepare("SELECT count(*) n FROM principal_credentials").get())).toEqual({ n: 0 });
    expect(await (await fetch(`${f.endpoint}/api/auth/status`)).json()).toEqual({ mode, loginAvailable: false });
    expect((await f.requestResult("/api/dashboard")).status).toBe(200);
    expect((await f.requestResult("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: "owner@fixture.invalid", password: replacement }) })).status).toBe(401);
    await assertOwners(f, true); await assertNoSecrets(f);
    const pid = f.processState().pid!;
    await f.stop(); // Sends actual SIGTERM; checks exit 0 instead of accepting a killed fixture.
    expect(f.processState()).toEqual({ pid, code: 0, signal: null }); expect(() => process.kill(pid, 0)).toThrow();
    await assertOwners(f, false); expect(existsSync(join(f.paths.state, "admin.sock"))).toBe(false);
  });

  it("administers ordinary humans and CAS memberships through actual built CLI IPC, with no provider load for local metadata", async () => {
    const f = fixture = await startControllerFixture(0);
    const { principal } = await provider(f, ["human", "create"]);
    expect(principal).toMatchObject({ kind: "human", status: "active" });
    expect(await provider(f, ["human", "list", "--limit", "1"])).toMatchObject({ items: [{ id: principal.id, enrollment: "absent" }], nextAfter: null });
    expect(await provider(f, ["status"])).toMatchObject({ configuration: "missing", maintenance: "not_loaded", owner: { state: "none" } });
    // Create the content project through the existing installation-authorized CLI, independent of account enrollment.
    const created = body(await f.cliResult(["identity", "create-knowledge-project", "--name", "Human integration"]));
    const projectId = created.project.id as string;
    expect(typeof projectId).toBe("string");
    const input = { principalId: principal.id, scope: { kind: "knowledge-project", id: projectId }, role: "operator", permissions: ["knowledge:read", "knowledge:write"], expectedRevision: 0 };
    expect(await provider(f, ["knowledge-access", "set", "--input-stdin"], input)).toMatchObject({ revision: 1 });
    expect(await provider(f, ["knowledge-access", "set", "--input-stdin"], input, 1)).toMatchObject({ code: "membership_revision_conflict" });
    expect(await provider(f, ["knowledge-access", "list", "--principal-id", principal.id])).toMatchObject({ items: [{ revision: 1, role: "operator" }] });
    expect(await provider(f, ["status"])).toMatchObject({ maintenance: "not_loaded" });
    expect(await provider(f, ["configure", "--input-stdin"], { module: entry, origin: "https://controller.test", signingSecret: { kind: "generate" } })).toMatchObject({ configured: true });
    expect(await provider(f, ["enroll", "--principal-id", principal.id, "--input-stdin"], { email: "human@fixture.invalid", name: "Human", password })).toMatchObject({ enrolled: true });
    expect(await provider(f, ["recover", "--principal-id", principal.id, "--input-stdin"], { newPassword: replacement }, 1)).toMatchObject({ code: "principal_unavailable" });
    expect(await provider(f, ["knowledge-access", "revoke", "--input-stdin"], { principalId: principal.id, scope: input.scope, expectedRevision: 1 })).toMatchObject({ revision: 2, grant: { revokedAt: expect.any(String) } });
    expect(await provider(f, ["human", "disable", "--principal-id", principal.id])).toMatchObject({ changed: true });
    expect(await provider(f, ["human", "disable", "--principal-id", principal.id])).toMatchObject({ changed: false });
    expect(inspect(f, db => db.prepare("SELECT count(*) n FROM principal_credentials").get())).toEqual({ n: 0 });
    await assertNoSecrets(f); await assertOwners(f, true);
    await f.stop(); await assertOwners(f, false);
  });

  it("cleans both actual owners and HTTP listeners after a real admin listener start refusal", async () => {
    const f = fixture = await startControllerFixture(0);
    await f.stop();
    const socket = join(f.paths.state, "admin.sock"); await writeFile(socket, "fixture-foreign-file", { mode: 0o600 });
    await expect(f.restart()).rejects.toThrow("Refusing to replace non-socket file");
    expect(f.processState().code).toBe(1);
    expect(() => process.kill(f.processState().pid!, 0)).toThrow();
    await assertOwners(f, false); expect(await readFile(socket, "utf8")).toBe("fixture-foreign-file");
    await expect(fetch(`${f.endpoint}/api/auth/status`)).rejects.toThrow();
  });

  it("retains the actual SIGTERM process and both owners when SQLite close fails after successful provider disposal", async () => {
    const f = fixture = await startControllerFixture(0, [], { nodeArguments: ["--import", faultHook] });
    try {
      await enroll(f, observedEntry);
      await writeFile(join(f.paths.data, "fixture-driver-close-failure"), "armed");
      f.signal("SIGTERM");
      await waitFor(() => f.diagnostics().includes("Controller shutdown did not complete cleanly.") || null, 10_000, () => "Signal failure callback did not run.");
      await pause(250); expect(f.processState().code).toBeNull(); expect(f.processState().signal).toBeNull();
      await assertOwners(f, true); await assertNoSecrets(f);
      expect(f.diagnostics()).toContain("fixture.driver_close_refused");
      expect(f.diagnostics()).toContain("fixture.provider_disposed");
      expect(f.diagnostics().indexOf("fixture.provider_disposed")).toBeLessThan(f.diagnostics().indexOf("fixture.driver_close_refused"));
      expect(existsSync(join(f.paths.state, "admin.sock"))).toBe(false);
      await expect(fetch(`${f.endpoint}/api/auth/status`)).rejects.toThrow();
    } finally { await f.terminateFailedController(); }
  });

  it("retains the actual startup owner when admin binding refuses and subsequent SQLite cleanup fails", async () => {
    const f = fixture = await startControllerFixture(0, [], { nodeArguments: ["--import", faultHook] });
    await f.stop();
    await writeFile(join(f.paths.state, "admin.sock"), "fixture-foreign-file", { mode: 0o600 });
    await writeFile(join(f.paths.data, "fixture-driver-close-failure"), "armed");
    const restarting = f.restart().catch(error => error);
    try {
      await waitFor(() => f.diagnostics().includes("Provider cleanup is unconfirmed; ownership is retained.") || null,
        10_000, () => "Actual listener-start failure retention branch did not run.");
      expect(f.diagnostics()).toContain("fixture.driver_close_refused");
      await pause(250); expect(f.processState().code).toBeNull(); expect(f.processState().signal).toBeNull();
      await assertOwners(f, true);
      await expect(fetch(`${f.endpoint}/api/auth/status`)).rejects.toThrow();
    } finally { await f.terminateFailedController(); await restarting; }
  });

  it("retains the actual restore-failure process and both owners after successful provider disposal then failed SQLite close", async () => {
    const f = fixture = await startControllerFixture(0, [], { backups: true, nodeArguments: ["--import", faultHook] });
    try {
      await enroll(f, observedEntry);
      const copy = await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "create", idempotencyKey: "provider-restore-copy" }) });
      await waitFor(async () => (await f.request<BackupOperation>("/api/backups", { method: "POST", body: JSON.stringify({ action: "status", idempotencyKey: "provider-restore-copy" }) })).state === "succeeded" || null,
        10_000, () => "Pre-fault backup did not complete.");
      await writeFile(join(f.paths.data, "fixture-driver-close-failure"), "armed");
      await f.request("/api/backups", { method: "POST", body: JSON.stringify({ action: "restore", backupId: copy.backupId, idempotencyKey: "provider-restore-failure", confirmation: "replace-entire-installation" }) });
      await waitFor(() => f.diagnostics().includes("Restore cleanup is unconfirmed; ownership retained.") || null, 10_000, () => "Actual restore-failure callback did not run.");
      expect(f.diagnostics()).toContain("fixture.driver_close_refused");
      expect(f.diagnostics()).toContain("fixture.provider_disposed");
      expect(f.diagnostics().indexOf("fixture.provider_disposed")).toBeLessThan(f.diagnostics().indexOf("fixture.driver_close_refused"));
      // Wait for natural event-loop exhaustion, not merely the synchronous callback return.
      await pause(500);
      const paths = [join(f.paths.state, "controller.lock"), join(f.paths.data, "state.sqlite3.owner.lock")];
      const lockFilesPresent = paths.every(existsSync);
      const lockPidsMatch = (await Promise.all(paths.map(path => readFile(path, "utf8"))))
        .every(value => JSON.parse(value).pid === f.processState().pid);
      let ownerAlive = true;
      try { process.kill(f.processState().pid!, 0); } catch { ownerAlive = false; }
      console.log("restore-retention-evidence", JSON.stringify({ injectedDriverCloseFailure: true, providerDisposed: true,
        restoreFailureCallbackObserved: true, ...f.processState(), lockFilesPresent, lockPidsMatch, ownerAlive }));
      expect(lockFilesPresent).toBe(true); expect(lockPidsMatch).toBe(true);
      await assertNoSecrets(f);
      expect(f.processState(), "Restore cleanup claimed retained ownership, but the owner must remain alive.").toMatchObject({ code: null, signal: null });
      await assertOwners(f, true); await assertNoSecrets(f);
    } finally { await f.terminateFailedController(); }
  });
});
