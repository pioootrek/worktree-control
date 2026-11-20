import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backups from "../server/modules/backups";
import * as closeOwnership from "../server/bootstrap/offline-store-ownership";
import * as locks from "../server/controller-lock";
import * as stores from "../server/sqlite-store";
import * as offline from "../server/bootstrap/offline-operations-runtime";
import * as ownership from "../server/bootstrap/authentication-administration";
import { AuthenticationRequestBudget } from "../server/bootstrap/authentication-request-budget";
import { buildOperationsRuntime } from "../server/bootstrap/operations-runtime";
import { listenAdminSocket } from "../server/admin-socket";
import { AuthenticationService } from "../server/modules/authentication";
import { assertBackupHandoffCompleted } from "../server/modules/backups";
import { recordHash } from "../server/modules/backups/records";
import { ownedFixtureDatabase } from "../server/unmanaged-sqlite-fixture";
import { hash, token, presentedBearer, none } from "../server/modules/operations/adapters/credential-verifier-fixture";
import { FRESH_LOGIN_WINDOW_MS } from "../shared/contracts/operations";
import { createProviderWorld } from "../server/modules/operations/adapters/provider-session-fixture";
import { sessionDescribe } from "../server/modules/operations";
import { resolveAppPaths } from "../server/paths";
import { runSessionDescribe } from "./session-describe";

const RealStore = stores.SqliteStateStore;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const operationError = (reason: string, category = "unavailable", retry = "none", status = 503) => ({ category, reason, retry, status, effect: null });
function fixture(mode = "token") {
  const root = mkdtempSync(join(tmpdir(), "cli-session-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = resolveAppPaths(join(root, "data"), join(root, "state"));
  const store = new stores.SqliteStateStore(paths.databasePath);
  store.saveAuthenticationPolicy({ ...store.getAuthenticationPolicy(), mode: mode as "token" }, "fixture", "fixture");
  store.close();
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  return { root, paths, lines, write, run: () => runSessionDescribe(["describe"], paths, write) };
}
function owner(f: ReturnType<typeof fixture>) {
  const lock = locks.acquireControllerLock(f.paths.controllerLockPath);
  cleanup.push(() => lock.release()); return lock;
}
function observe() {
  const opened: stores.SqliteStateStore[] = [];
  vi.spyOn(stores, "SqliteStateStore").mockImplementation(class {
    constructor(...args: ConstructorParameters<typeof RealStore>) {
      const store = new RealStore(args[0], args[1], { ...args[2], admission: "strict" });
      opened.push(store); return store;
    }
  } as unknown as typeof RealStore);
  const acquire = vi.spyOn(locks, "acquireControllerLock");
  return { opened, acquire };
}
const options = (store: stores.SqliteStateStore, mode: string) => ({ store, activeMode: mode, now: Date.now,
  logs: { controller: vi.fn() }, requestBudget: new AuthenticationRequestBudget(16, 4), provider: null,
  eligibility: { controllerEligible: () => true, providerSessionEligible: () => false }, listeners: { unix: () => true, api: () => true } });

describe("session describe CLI mount", () => {
  it.each(["open", "token", "better-auth"])("offline %s writes the released DTO admitted, then closes before release", async mode => {
    const f = fixture(mode), seen = observe(), events: string[] = [];
    const legacy = vi.spyOn(AuthenticationService.prototype, "authenticateInstallation"), usage = vi.spyOn(RealStore.prototype, "recordCredentialUsed");
    const close = RealStore.prototype.close;
    vi.spyOn(RealStore.prototype, "close").mockImplementation(function (this: stores.SqliteStateStore) {
      expect(existsSync(f.paths.controllerLockPath)).toBe(true); events.push("closed"); close.call(this);
    });
    await runSessionDescribe(["describe"], f.paths, line => {
      // Real strict admission rejects reads outside a phase. isActive also confirms the actual write.
      seen.opened[0].getAuthenticationPolicy(); events.push("committed"); f.write(line);
    });
    expect(events).toEqual(["committed", "closed"]); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
    const dto = JSON.parse(f.lines[0]);
    expect(dto).toMatchObject({ actor: { kind: "operator", accountId: null }, listener: "offline", mode, fullAuthority: true,
      freshLogin: { state: "exempt", validUntil: null } });
    expect(f.lines).toHaveLength(1); expect(seen.opened).toHaveLength(1); expect(seen.acquire).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  }, 20_000);

  it("legacy is refused by the boundary without output", async () => {
    const f = fixture("legacy");
    await expect(f.run()).rejects.toMatchObject({ error: operationError("unknown_mode", "unauthenticated", "reauthenticate", 401) });
    expect(f.lines).toEqual([]); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  }, 20_000);

  it.each(["open", "token", "better-auth"])("unix %s equals offline and API authority with exactly actor/listener differences", async mode => {
    const f = fixture(mode);
    const seeded = new stores.SqliteStateStore(f.paths.databasePath), secret = token(mode === "better-auth" ? "wts" : "wsi"), credentialId = secret.slice(4, 40);
    if (mode === "token") seeded.saveAuthenticationPolicy({ ...seeded.getAuthenticationPolicy(), token: {
      id: credentialId, prefix: secret.slice(0, 40), verifierHash: hash(secret), createdAt: new Date().toISOString(),
    } }, "fixture", "fixture");
    if (mode === "better-auth") {
      seeded.savePrincipal({ id: "fixture-agent", kind: "agent", status: "active" }, "fixture");
      seeded.saveCredential({ id: credentialId, principalId: "fixture-agent", kind: "agent_token", label: "fixture", tokenPrefix: secret.slice(0, 40),
        verifierHash: hash(secret), status: "active", expiresAt: null, createdAt: new Date().toISOString(), revokedAt: null, lastUsedAt: null }, "fixture");
      ownedFixtureDatabase(seeded).prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)")
        .run("fixture-agent", "admin", "installation", null, new Date().toISOString());
    }
    seeded.close();
    await f.run(); const offlineDto = JSON.parse(f.lines.pop()!);
    const lock = owner(f), store = new stores.SqliteStateStore(f.paths.databasePath);
    cleanup.push(() => store.closeAfterDrain());
    const policy = options(store, mode), runtime = buildOperationsRuntime(policy);
    const legacy = vi.fn(); const server = await listenAdminSocket(f.paths.adminSocketPath, legacy, runtime);
    cleanup.push(() => server.close());
    const seen = observe(), record = readFileSync(f.paths.controllerLockPath, "utf8");
    const usage = vi.spyOn(store, "recordCredentialUsed");
    await f.run(); const unixDto = JSON.parse(f.lines[0]);
    expect(unixDto).toEqual({ ...offlineDto, listener: "unix" });
    if (runtime.supported) {
      const minted = await runtime.mint("api", mode === "open" ? none() : presentedBearer(secret), null, {}); if (!minted.ok) throw new Error("mint failed");
      const result = await runtime.runner.run(sessionDescribe, minted.context, {});
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.value).toEqual({ ...unixDto,
        actor: { kind: mode === "better-auth" ? "agent" : "installation", accountId: mode === "better-auth" ? "fixture-agent" : null },
        listener: "api", fullAuthority: mode !== "better-auth",
        // admin is human-only (grantAllowed); an agent never inherits this stored role.
        installationPermissions: mode === "better-auth" ? [] : unixDto.installationPermissions,
        freshLogin: { state: mode === "better-auth" ? "unavailable" : "exempt", validUntil: null } });
    }
    expect(seen.opened).toEqual([]); expect(seen.acquire).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.paths.controllerLockPath, "utf8")).toBe(record); expect(lock.held()).toBe(true);
    expect(legacy).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
    expect(JSON.stringify([f.lines, policy.logs.controller.mock.calls])).not.toContain(credentialId);
    expect(JSON.stringify([f.lines, policy.logs.controller.mock.calls])).not.toMatch(/sessionId|credentialId|verifierHash|last_used_at/);
  }, 20_000);

  it("better-auth human freshness differs exactly from the offline operator", async () => {
    const f = fixture("better-auth"), now = Date.now(), world = createProviderWorld({ now });
    const session = world.passwordLogin(world.account("fixture-human"));
    const store = new RealStore(f.paths.databasePath);
    store.humanAccounts().createHumanPrincipal({ id: "fixture-human", kind: "human", status: "active" }, "fixture");
    ownedFixtureDatabase(store).prepare("INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES(?,?,?,?,?)")
      .run("fixture-human", "admin", "installation", null, new Date(now).toISOString());
    store.close(); await f.run(); const offlineDto = JSON.parse(f.lines[0]);
    const opened = new RealStore(f.paths.databasePath); cleanup.push(() => opened.closeAfterDrain());
    const runtime = buildOperationsRuntime({ ...options(opened, "better-auth"), now: () => now,
      eligibility: { controllerEligible: () => true, providerSessionEligible: () => true },
      provider: { providerId: "better-auth", reader: world.store, isSessionAuthorityEligible: () => true,
        resolveRequest: () => ({ result: Promise.resolve(null), settled: Promise.resolve() }) } });
    if (!runtime.supported) throw new Error("unsupported fixture");
    const minted = await runtime.mint("api", { ...none(), providerSession: { secret: "fixture-cookie" }, browserHeaders: true }, session, {});
    if (!minted.ok) throw new Error("human mint failed");
    const result = await runtime.runner.run(sessionDescribe, minted.context, {});
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.value).toEqual({ ...offlineDto, actor: { kind: "human", accountId: "fixture-human" }, listener: "api", fullAuthority: false,
      freshLogin: { state: "satisfied", validUntil: new Date(now + FRESH_LOGIN_WINDOW_MS).toISOString() } });
    expect(JSON.stringify(f.lines)).not.toContain(session.sessionId);
  }, 20_000);

  it("legacy on the real unix listener refuses unknown_mode without fallback", async () => {
    const f = fixture("legacy"); owner(f); const store = new RealStore(f.paths.databasePath); cleanup.push(() => store.closeAfterDrain());
    const server = await listenAdminSocket(f.paths.adminSocketPath, vi.fn(), buildOperationsRuntime(options(store, "legacy")));
    cleanup.push(() => server.close()); const seen = observe();
    await expect(f.run()).rejects.toMatchObject({ error: operationError("unknown_mode", "unauthenticated", "reauthenticate", 401) });
    expect(seen.opened).toEqual([]); expect(seen.acquire).toHaveBeenCalledTimes(1); expect(f.lines).toEqual([]);
  }, 20_000);

  it.each(["missing", "stale", "reset", "timeout", "maintenance", "release_not_eligible", "garbage", "oversize", "extra-field", "duplicate-key", "invalid-utf8", "wrong-status", "invalid-outcome"])(
    "lock taken: %s fails exactly, never opens a store or acquires ownership", async kind => {
      const f = fixture(); await f.run(); const dto = JSON.parse(f.lines.pop()!);
      const lock = owner(f), before = readFileSync(f.paths.controllerLockPath, "utf8");
      if (kind === "stale") {
        // Publish a real socket inode with no listener by moving it before close.
        const path = join(f.root, "listening.sock"), server = createNetServer();
        await new Promise<void>(resolve => server.listen(path, resolve)); renameSync(path, f.paths.adminSocketPath);
        await new Promise<void>(resolve => server.close(() => resolve()));
      } else if (kind === "reset") {
        const server = createNetServer(socket => socket.destroy());
        await new Promise<void>(resolve => server.listen(f.paths.adminSocketPath, resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      } else if (kind !== "missing") {
        const server = createServer((_request, response) => {
          if (kind === "timeout") return;
          if (kind === "wrong-status" || kind === "invalid-outcome") {
            response.writeHead(503); response.end(JSON.stringify({ error: operationError("fixture", kind === "invalid-outcome" ? "outcome_unknown" : "unavailable", "none", kind === "wrong-status" ? 401 : 503) })); return;
          }
          if (kind === "invalid-utf8") { response.end(Buffer.from([0xff])); return; }
          if (kind === "duplicate-key") { response.end('{"actor":null,"actor":null}'); return; }
          if (kind === "maintenance" || kind === "release_not_eligible") {
            response.writeHead(503); response.end(JSON.stringify({ error: operationError(kind) }));
          } else response.end(kind === "oversize" ? "x".repeat(256 * 1024 + 1) : kind === "extra-field" ? JSON.stringify({ ...dto, credentialId: "secret-row" }) : "garbage");
        });
        await new Promise<void>(resolve => server.listen(f.paths.adminSocketPath, resolve));
        cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
      }
      const seen = observe();
      const reason = ({ missing: "admin_socket_missing", stale: "admin_socket_refused", reset: "admin_socket_failed", timeout: "admin_timeout",
        garbage: "admin_invalid_response", oversize: "admin_response_limit", "extra-field": "admin_invalid_response", "duplicate-key": "admin_invalid_response", "invalid-utf8": "admin_invalid_response", "wrong-status": "admin_invalid_response", "invalid-outcome": "admin_invalid_response" } as Record<string, string>)[kind] ?? kind;
      await expect(f.run()).rejects.toMatchObject({ error: operationError(reason) });
      expect(seen.opened).toEqual([]); expect(seen.acquire).toHaveBeenCalledTimes(1);
      expect(readFileSync(f.paths.controllerLockPath, "utf8")).toBe(before); expect(lock.held()).toBe(true); expect(f.lines).toEqual([]);
    }, 30_000);

  it("another offline owner with no controller has the same no-fallback refusal", async () => {
    const f = fixture(), lock = owner(f), seen = observe();
    await expect(f.run()).rejects.toMatchObject({ error: operationError("admin_socket_missing") });
    expect(lock.held()).toBe(true); expect(seen.opened).toHaveLength(0); expect(seen.acquire).toHaveBeenCalledTimes(1);
  }, 20_000);

  it.each(["pending", "unreadable"])("%s restore handoff stops before store construction", async kind => {
    const f = fixture(), directory = `${f.paths.databasePath}.backup-operations`; mkdirSync(directory, { mode: 0o700 });
    const payload = { format: 1, actor: { actorId: "local-admin", idempotencyKey: "fixture", backupId: "00000000-0000-4000-8000-000000000001" },
      operationId: "00000000-0000-4000-8000-000000000002", createdAt: "2026-01-01T00:00:00.000Z", state: "executing", authentication: null, local: true };
    const path = join(directory, "handoff.json");
    writeFileSync(path, kind === "pending" ? JSON.stringify({ payload, sha256: recordHash(payload) }) : "private-session-row", { mode: 0o600 });
    if (kind === "unreadable") chmodSync(path, 0o600);
    const seen = observe();
    if (kind === "pending") {
      expect(() => assertBackupHandoffCompleted(f.paths.databasePath)).toThrow("Start the controller to complete restore authentication recovery before offline administration.");
      await expect(f.run()).rejects.toThrow("Start the controller to complete restore authentication recovery before offline administration.");
    } else await expect(f.run()).rejects.toMatchObject({ error: operationError("restore_handoff_unreadable") });
    expect(seen.opened).toEqual([]); expect(f.lines).toEqual([]); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  }, 20_000);

  it.each(["before-mint", "after-mint", "before-release"])("replaced real record %s refuses without stdout", async point => {
    const f = fixture(), build = offline.buildOfflineOperationsRuntime;
    const replace = () => { renameSync(f.paths.controllerLockPath, join(f.root, "original.lock"));
      writeFileSync(f.paths.controllerLockPath, JSON.stringify({ pid: process.pid, token: "replacement", startedAt: "now" }), { mode: 0o600 }); };
    vi.spyOn(offline, "buildOfflineOperationsRuntime").mockImplementation(config => {
      const runtime = build(config);
      if (point === "before-mint") replace();
      if (runtime.supported && point === "before-release") {
        const release = runtime.runner.readRelease.bind(runtime.runner);
        vi.spyOn(runtime.runner, "readRelease").mockImplementation(async (...args) => {
          await runtime.runner.run(sessionDescribe, args[1], {}); replace(); return release(...args);
        });
      }
      return { ...runtime, mintOffline: async admission => { const minted = await runtime.mintOffline(admission); if (point === "after-mint") replace(); return minted; } };
    });
    await expect(f.run()).rejects.toMatchObject({ error: operationError("offline_lock_not_held", "unauthenticated", "reauthenticate", 401) });
    expect(f.lines).toEqual([]);
  }, 20_000);

  it("close failure retains the owner and reports disposal_unconfirmed", async () => {
    const f = fixture(), close = vi.spyOn(RealStore.prototype, "close").mockImplementation(() => { throw new Error("private-row"); });
    const retain = vi.spyOn(ownership, "retainAuthenticationOwnership").mockImplementation(() => {}), seen = observe();
    await expect(f.run()).rejects.toMatchObject({ code: "disposal_unconfirmed", cleanupConfirmed: false });
    expect(retain).toHaveBeenCalledTimes(1); expect(existsSync(f.paths.controllerLockPath)).toBe(true);
    close.mockRestore(); await seen.opened[0].closeAfterDrain();
  }, 20_000);


  it("negative control: socket fallback is detected as an unexpected store open", async () => {
    const f = fixture(), lock = owner(f), acquire = locks.acquireControllerLock, seen = observe();
    // Mutant drops the real owner's refusal and grants the command the existing owner.
    seen.acquire.mockImplementation(path => { try { return acquire(path); } catch { return lock; } });
    await f.run();
    const observed = seen.opened.length, expected = 0;
    expect(observed).toBe(1);
    expect(() => expect(observed, "socket failure store opens").toBe(expected)).toThrow("expected 1 to be +0");
  }, 20_000);

  it("negative control: omitted handoff guard is detected by constructor count", async () => {
    const f = fixture(), directory = `${f.paths.databasePath}.backup-operations`; mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "handoff.json"), "private-row", { mode: 0o600 });
    vi.spyOn(backups, "assertBackupHandoffCompleted").mockImplementation(() => {});
    const seen = observe(); await f.run();
    const observed = seen.opened.length, expected = 0;
    expect(observed).toBe(1);
    expect(() => expect(observed, "handoff refusal store opens").toBe(expected)).toThrow("expected 1 to be +0");
  }, 20_000);

  it("negative control: output before final admission fails the exact admitted-write assertion", async () => {
    const f = fixture(), seen = observe(), build = offline.buildOfflineOperationsRuntime;
    vi.spyOn(offline, "buildOfflineOperationsRuntime").mockImplementation(config => {
      const runtime = build(config);
      if (runtime.supported) vi.spyOn(runtime.runner, "readRelease").mockImplementation(async (_operation, _context, _input, release) => {
        release.commit({}); return { status: "committed" };
      });
      return runtime;
    });
    let admitted = true;
    await runSessionDescribe(["describe"], f.paths, () => {
      try { seen.opened[0].getAuthenticationPolicy(); } catch { admitted = false; }
    });
    expect(admitted).toBe(false);
    expect(() => expect(admitted, "stdout write admitted").toBe(true)).toThrow("expected false to be true");
  }, 20_000);

  it("negative control: premature release fails the exact held-before-close assertion", async () => {
    const f = fixture(), close = closeOwnership.closeOfflineStore;
    vi.spyOn(closeOwnership, "closeOfflineStore").mockImplementation(async (store, lock) => { lock.release(); await close(store, lock); });
    let held = true; const actualClose = RealStore.prototype.close;
    vi.spyOn(RealStore.prototype, "close").mockImplementation(function (this: stores.SqliteStateStore) {
      held = existsSync(f.paths.controllerLockPath); actualClose.call(this);
    });
    await f.run(); expect(held).toBe(false);
    expect(() => expect(held, "lock held before store close").toBe(true)).toThrow("expected false to be true");
  }, 20_000);

  it("rejects path-selection switches before ownership", async () => {
    const f = fixture(), seen = observe();
    for (const args of [["describe", "--offline"], ["describe", "--socket"], [], ["unknown"]]) {
      await expect(runSessionDescribe(args, f.paths)).rejects.toThrow("Usage: session describe");
    }
    expect(seen.acquire).not.toHaveBeenCalled(); expect(seen.opened).toEqual([]);
  }, 20_000);
});
