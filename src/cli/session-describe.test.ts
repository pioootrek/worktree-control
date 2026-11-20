import * as fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createBoundaryDriver } from "../server/modules/operations/http-boundary-driver";
import { createRemoteVerificationServer } from "../server/transports/remote-verification-http";
import type { RemoteVerificationController } from "../server/modules/remote-verification";
import { createMcpControllerServer } from "../server/mcp-http-server";
import { IdentityService } from "../server/modules/identity";
import type { ControlService } from "../server/control-service";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as adminSocket from "../server/admin-socket";
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
import { createFencedAt49 } from "../server/infrastructure/sqlite/fixtures/released-schema";
import { OwnedSqliteDatabase } from "../server/infrastructure/sqlite/owned-database";
import { ownedFixtureDatabase } from "../server/unmanaged-sqlite-fixture";
import { hash, token, presentedBearer, none } from "../server/modules/operations/adapters/credential-verifier-fixture";
import { FRESH_LOGIN_WINDOW_MS } from "../shared/contracts/operations";
import { createProviderWorld } from "../server/modules/operations/adapters/provider-session-fixture";
import { sessionDescribe } from "../server/modules/operations";
import { resolveAppPaths } from "../server/paths";
import { SystemGitWorktreeReader } from "../server/git-worktrees";
import { createSessionDescribeOutput, parseProjectsCommand, runProjectsCommand, runSessionDescribe } from "./session-describe";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

const RealStore = stores.SqliteStateStore;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const operationError = (reason: string, category = "unavailable", retry = "none", status = 503) => ({ category, status, reason, retry, effect: null });
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
  logs: { controller: vi.fn() }, projectReads: { placement: { statusSummary: () => ({ phase: "stopped", worktreePath: null, startedAt: null }) }, git: { list: async () => [] } }, requestBudget: new AuthenticationRequestBudget(16, 4), provider: null,
  eligibility: { controllerEligible: () => true, providerSessionEligible: () => false }, listeners: { unix: () => true, api: () => true, worker: () => true, mcp: () => true } });

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
    expect(f.lines).toHaveLength(1); expect(seen.opened).toHaveLength(1);
    expect(seen.acquire.mock.calls.filter(([path]) => path === f.paths.controllerLockPath)).toHaveLength(1);
    expect(seen.acquire.mock.calls.filter(([path]) => path === `${f.paths.databasePath}.owner.lock`)).toHaveLength(1);
    expect(legacy).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });

  it("destroyed stdout is a failed admitted commit, then drains/closes before release", async () => {
    const f = fixture(), seen = observe(), build = offline.buildOfflineOperationsRuntime, events: string[] = [];
    let outcome: unknown;
    vi.spyOn(offline, "buildOfflineOperationsRuntime").mockImplementation(config => {
      const runtime = build(config);
      if (runtime.supported) {
        const release = runtime.runner.readRelease.bind(runtime.runner);
        vi.spyOn(runtime.runner, "readRelease").mockImplementation(async (...args) => {
          outcome = await release(...args); return outcome as Awaited<ReturnType<typeof release>>;
        });
      }
      return runtime;
    });
    const drain = RealStore.prototype.closeAfterDrain, close = RealStore.prototype.close;
    const drainSpy = vi.spyOn(RealStore.prototype, "closeAfterDrain").mockImplementation(async function (this: stores.SqliteStateStore) {
      expect(existsSync(f.paths.controllerLockPath)).toBe(true); events.push("drain"); await drain.call(this);
    });
    const closeSpy = vi.spyOn(RealStore.prototype, "close").mockImplementation(function (this: stores.SqliteStateStore) {
      expect(existsSync(f.paths.controllerLockPath)).toBe(true); events.push("close"); close.call(this);
    });
    const stdout = new Writable({ write(_chunk, _encoding, done) { done(); } });
    stdout.destroy();
    const io = createSessionDescribeOutput(stdout, new Writable({ write(_chunk, _encoding, done) { done(); } }), vi.fn());
    await expect(runSessionDescribe(["describe"], f.paths, line => {
      seen.opened[0].getAuthenticationPolicy(); events.push("write"); io.write(line);
    })).rejects.toMatchObject({ error: operationError("output_unavailable") });
    expect(outcome).toMatchObject({ status: "commit_failed", error: { reason: "release_commit_failed" } });
    expect(events).toEqual(["write", "drain", "close"]); expect(f.lines).toEqual([]);
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);
    drainSpy.mockRestore(); closeSpy.mockRestore();
    const reopened = new RealStore(f.paths.databasePath); await reopened.closeAfterDrain();
  });

  it("a malformed lock refuses offline_lock_unavailable before socket or store construction", async () => {
    const f = fixture(), seen = observe(), request = vi.spyOn(adminSocket, "requestAdminSocket");
    mkdirSync(f.paths.stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(f.paths.controllerLockPath, "private malformed lock", { mode: 0o600 });
    await expect(f.run()).rejects.toMatchObject({ error: operationError("offline_lock_unavailable") });
    expect(request).not.toHaveBeenCalled(); expect(stores.SqliteStateStore).not.toHaveBeenCalled();
    expect(seen.opened).toEqual([]); expect(f.lines).toEqual([]);
  });

  it("ordinary store opening keeps its fence refusal and releases the controller lock", async () => {
    const f = fixture(); rmSync(`${f.paths.databasePath}.security/witness.json`);
    const seen = observe();
    await expect(f.run()).rejects.toMatchObject({ code: "security_fence_recovery_required" });
    expect(seen.opened).toEqual([]); expect(stores.SqliteStateStore).toHaveBeenCalledTimes(1);
    expect(f.lines).toEqual([]); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  });

  // Spawns the real CLI, including TypeScript loader startup.
  it("upgrade-required offline command preserves the diagnostic, never enables writes, and releases both locks", async () => {
    const f = fixture();
    rmSync(f.paths.dataDirectory, { recursive: true });
    createFencedAt49(f.paths.databasePath);
    const before = readFileSync(f.paths.databasePath), witness = readFileSync(`${f.paths.databasePath}.security/witness.json`);
    const enableWrites = vi.spyOn(OwnedSqliteDatabase.prototype, "enableWrites"), seen = observe();
    let refusal: unknown;
    try { await f.run(); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: "upgrade_required", nextStep: "upgrade inspect" });
    expect(enableWrites).not.toHaveBeenCalled(); expect(seen.opened).toEqual([]); expect(f.lines).toEqual([]);
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);
    expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", join(repository, "src/cli/index.ts"), "session", "describe",
        "--data-dir", f.paths.dataDirectory, "--state-dir", f.paths.stateDirectory], {
        cwd: repository, env: { PATH: process.env.PATH, HOME: f.root, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 20_000);
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject); child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code).toBe(1); expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ code: "upgrade_required",
      error: "upgrade_required: This database requires an explicit offline upgrade before ordinary access. Next step: upgrade inspect.",
      nextStep: "upgrade inspect", state: "upgrade_needed" });
    expect(readFileSync(f.paths.databasePath)).toEqual(before);
    expect(readFileSync(`${f.paths.databasePath}.security/witness.json`)).toEqual(witness);
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);
    expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
  }, 40_000);

  it("legacy is refused by the boundary without output", async () => {
    const f = fixture("legacy");
    await expect(f.run()).rejects.toMatchObject({ error: operationError("unknown_mode", "unauthenticated", "reauthenticate", 401) });
    expect(f.lines).toEqual([]); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  });

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
    const identity = new IdentityService(store);
    const worker = createRemoteVerificationServer({ identity, controller: {} as RemoteVerificationController,
      admission: store.admission, allowLoopbackHttpFixture: true, operations: runtime });
    const mcpOptions = { service: { admission: store.admission, remoteVerificationEnabled: () => false } as unknown as ControlService,
      port: 0, accessToken: "fixture", identity, authentication: { mode: () => mode as "open", authenticateInstallation: vi.fn(), anonymousInstallation: vi.fn() }, operations: runtime };
    const mcp = createMcpControllerServer(mcpOptions);
    cleanup.push(() => worker.close(), () => mcp.close());
    await new Promise<void>(resolve => worker.server.listen(0, "127.0.0.1", resolve));
    await new Promise<void>(resolve => mcp.server.listen(0, "127.0.0.1", resolve));
    mcpOptions.port = (mcp.server.address() as AddressInfo).port;
    for (const listener of ["worker", "mcp"] as const) {
      const driver = createBoundaryDriver({ kind: listener, server: listener === "worker" ? worker.server : mcp.server,
        close: () => listener === "worker" ? worker.close() : mcp.close(), legacyPath: "/", acceptedCredentials: [] });
      const reply = await driver.send({ headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(mode === "open" ? {} : { Authorization: `Bearer ${secret}` }) } }).reply;
      expect(reply.status).toBe(200);
      const dto = listener === "mcp" ? reply.body.result.structuredContent : reply.body;
      expect(dto).toEqual({ ...unixDto, listener,
        actor: { kind: mode === "better-auth" ? "agent" : "installation", accountId: mode === "better-auth" ? "fixture-agent" : null },
        fullAuthority: mode !== "better-auth", installationPermissions: mode === "better-auth" ? [] : unixDto.installationPermissions,
        freshLogin: { state: mode === "better-auth" ? "unavailable" : "exempt", validUntil: null } });
    }
    expect(seen.opened).toEqual([]); expect(seen.acquire).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.paths.controllerLockPath, "utf8")).toBe(record); expect(lock.held()).toBe(true);
    expect(legacy).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
    expect(JSON.stringify([f.lines, policy.logs.controller.mock.calls])).not.toContain(credentialId);
    expect(JSON.stringify([f.lines, policy.logs.controller.mock.calls])).not.toMatch(/sessionId|credentialId|verifierHash|last_used_at/);
  });

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
  });

  it("legacy on the real unix listener refuses unknown_mode without fallback", async () => {
    const f = fixture("legacy"); owner(f); const store = new RealStore(f.paths.databasePath); cleanup.push(() => store.closeAfterDrain());
    const server = await listenAdminSocket(f.paths.adminSocketPath, vi.fn(), buildOperationsRuntime(options(store, "legacy")));
    cleanup.push(() => server.close()); const seen = observe();
    await expect(f.run()).rejects.toMatchObject({ error: operationError("unknown_mode", "unauthenticated", "reauthenticate", 401) });
    expect(seen.opened).toEqual([]); expect(seen.acquire).toHaveBeenCalledTimes(1); expect(f.lines).toEqual([]);
  });

  // The timeout variant waits for the real admin socket client deadline.
  it.each(["missing", "stale", "reset", "timeout", "maintenance", "release_not_eligible", "garbage", "oversize", "extra-field", "duplicate-key", "invalid-utf8", "wrong-status", "invalid-outcome", "depth", "c0"])(
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
          if (kind === "depth") { response.end('['.repeat(33) + '0' + ']'.repeat(33)); return; }
          if (kind === "c0") { response.end(JSON.stringify({ ...dto, listener: "unix", projects: [{ projectId: "allowed\u0001field", permissions: [] }] })); return; }
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
        garbage: "admin_invalid_response", oversize: "admin_response_limit", "extra-field": "admin_invalid_response", "duplicate-key": "admin_invalid_response", "invalid-utf8": "admin_invalid_response", "wrong-status": "admin_invalid_response", "invalid-outcome": "admin_invalid_response", depth: "admin_invalid_response", c0: "admin_invalid_response" } as Record<string, string>)[kind] ?? kind;
      await expect(f.run()).rejects.toMatchObject({ error: operationError(reason) });
      expect(seen.opened).toEqual([]); expect(seen.acquire).toHaveBeenCalledTimes(1);
      expect(readFileSync(f.paths.controllerLockPath, "utf8")).toBe(before); expect(lock.held()).toBe(true); expect(f.lines).toEqual([]);
    }, 30_000);

  it("another offline owner with no controller has the same no-fallback refusal", async () => {
    const f = fixture(), lock = owner(f), seen = observe();
    await expect(f.run()).rejects.toMatchObject({ error: operationError("admin_socket_missing") });
    expect(lock.held()).toBe(true); expect(seen.opened).toHaveLength(0); expect(seen.acquire).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "malformed", "unreadable"])("%s restore handoff stops before store construction", async kind => {
    const f = fixture(), directory = `${f.paths.databasePath}.backup-operations`; mkdirSync(directory, { mode: 0o700 });
    const payload = { format: 1, actor: { actorId: "local-admin", idempotencyKey: "fixture", backupId: "00000000-0000-4000-8000-000000000001" },
      operationId: "00000000-0000-4000-8000-000000000002", createdAt: "2026-01-01T00:00:00.000Z", state: "executing", authentication: null, local: true };
    const path = join(directory, "handoff.json");
    writeFileSync(path, kind === "malformed" ? "private-session-row" : JSON.stringify({ payload, sha256: recordHash(payload) }), { mode: 0o600 });
    const seen = observe();
    if (kind === "pending") {
      expect(() => assertBackupHandoffCompleted(f.paths.databasePath)).toThrow("Start the controller to complete restore authentication recovery before offline administration.");
      await expect(f.run()).rejects.toThrow("Start the controller to complete restore authentication recovery before offline administration.");
    } else if (kind === "unreadable") {
      if (process.getuid?.() !== 0) {
        chmodSync(path, 0o000);
        await expect(f.run()).rejects.toMatchObject({ error: operationError("restore_handoff_unreadable") });
        chmodSync(path, 0o600);
      }
      // Exercise the privileged-runner fallback on every host.
      const open = fs.openSync;
      const denied = vi.fn(() => { throw Object.assign(new Error("fixture open denied"), { code: "EACCES" }); });
      vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) =>
        file === path ? denied() : open(file, flags, mode));
      await expect(f.run()).rejects.toMatchObject({ error: operationError("restore_handoff_unreadable") });
      expect(denied).toHaveBeenCalled();
    } else await expect(f.run()).rejects.toMatchObject({ error: operationError("restore_handoff_unreadable") });
    expect(seen.opened).toEqual([]); expect(f.lines).toEqual([]); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  });

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
  });

  it("close failure retains the owner and reports disposal_unconfirmed", async () => {
    const f = fixture(), close = vi.spyOn(RealStore.prototype, "close").mockImplementation(() => { throw new Error("private-row"); });
    const retain = vi.spyOn(ownership, "retainAuthenticationOwnership").mockImplementation(() => {}), seen = observe();
    await expect(f.run()).rejects.toMatchObject({ code: "disposal_unconfirmed", cleanupConfirmed: false });
    expect(retain).toHaveBeenCalledTimes(1); expect(existsSync(f.paths.controllerLockPath)).toBe(true);
    close.mockRestore(); await seen.opened[0].closeAfterDrain();
  });


  it("negative control: socket fallback is detected as an unexpected store open", async () => {
    const f = fixture(), lock = owner(f), request = adminSocket.requestAdminSocket, seen = observe();
    let failedSocket: string | undefined;
    // Fault injection in the shared client: after its REAL failure, wrongly relinquish
    // the fixture owner and re-enter offline execution in this same outer invocation.
    vi.spyOn(adminSocket, "requestAdminSocket").mockImplementation(async (...args) => {
      try { return await request(...args); }
      catch (cause) {
        failedSocket = (cause as NodeJS.ErrnoException).code;
        lock.release(); let dto: unknown;
        await runSessionDescribe(["describe"], f.paths, line => { dto = JSON.parse(line); });
        return dto;
      }
    });
    await f.run(); expect(failedSocket).toBe("ENOENT");
    expect(JSON.parse(f.lines[0]).listener).toBe("offline");
    const observed = seen.opened.length, expected = 0;
    expect(observed).toBe(1);
    expect(() => expect(observed, "socket failure store opens").toBe(expected)).toThrow("expected 1 to be +0");
    const acquisitions = seen.acquire.mock.calls.filter(([path]) => path === f.paths.controllerLockPath).length;
    expect(acquisitions).toBe(2);
    expect(() => expect(acquisitions, "controller lock acquisition attempts").toBe(1)).toThrow("expected 2 to be 1");
  });

  it("negative control: omitted handoff guard is detected by constructor count", async () => {
    const f = fixture(), directory = `${f.paths.databasePath}.backup-operations`; mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "handoff.json"), "private-row", { mode: 0o600 });
    vi.spyOn(backups, "assertBackupHandoffCompleted").mockImplementation(() => {});
    const seen = observe(); await f.run();
    const observed = seen.opened.length, expected = 0;
    expect(observed).toBe(1);
    expect(() => expect(observed, "handoff refusal store opens").toBe(expected)).toThrow("expected 1 to be +0");
  });

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
  });

  it("negative control: premature release fails the exact held-before-close assertion", async () => {
    const f = fixture(), close = closeOwnership.closeOfflineStore;
    vi.spyOn(closeOwnership, "closeOfflineStore").mockImplementation(async (store, lock) => { lock.release(); await close(store, lock); });
    let held = true; const actualClose = RealStore.prototype.close;
    vi.spyOn(RealStore.prototype, "close").mockImplementation(function (this: stores.SqliteStateStore) {
      held = existsSync(f.paths.controllerLockPath); actualClose.call(this);
    });
    await f.run(); expect(held).toBe(false);
    expect(() => expect(held, "lock held before store close").toBe(true)).toThrow("expected false to be true");
  });

  it("rejects path-selection switches before ownership", async () => {
    const f = fixture(), seen = observe();
    for (const args of [["describe", "--offline"], ["describe", "--socket"], [], ["unknown"]]) {
      await expect(runSessionDescribe(args, f.paths)).rejects.toThrow("Usage: session describe");
    }
    expect(seen.acquire).not.toHaveBeenCalled(); expect(seen.opened).toEqual([]);
  });
});

describe("session describe output", () => {
  function output() {
    const chunks: Buffer[] = [], diagnostics: string[] = [];
    const stdout = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    let exitCode = 0;
    const fail = vi.fn(() => { exitCode = 1; });
    const syscall = vi.spyOn(fs, "writeSync").mockImplementation((fd, line: unknown) => {
      expect(fd).toBe(2); expect(typeof line).toBe("string");
      diagnostics.push(line as string); return Buffer.byteLength(line as string);
    });
    return { stdout, stderr, fail, chunks, diagnostics, syscall, get exitCode() { return exitCode; },
      io: createSessionDescribeOutput(stdout, stderr, fail) };
  }

  it("commits complete UTF-8 pretty JSON plus one newline to the stream despite backpressure", () => {
    const o = output(), expected = JSON.stringify({ example: "é", projects: Array(500).fill("x".repeat(500)) }, null, 2);
    let finish: (() => void) | undefined;
    o.stdout._write = (chunk, _encoding, done) => { o.chunks.push(Buffer.from(chunk)); finish = done; };
    const write = vi.spyOn(o.stdout, "write");
    o.io.write(expected);
    expect(write).toHaveReturnedWith(false);
    expect(Buffer.concat(o.chunks).toString()).toBe(`${expected}\n`);
    expect(o.syscall).not.toHaveBeenCalled(); expect(o.fail).not.toHaveBeenCalled();
    finish!();
  });

  it.each(["destroyed", "ended", "not-writable", "throws"])("%s stdout fails synchronously with only the public reason", state => {
    const o = output(), write = vi.spyOn(o.stdout, "write");
    if (state === "destroyed") o.stdout.destroy();
    if (state === "ended") o.stdout.end();
    if (state === "not-writable") Object.defineProperty(o.stdout, "writable", { value: false });
    if (state === "throws") write.mockImplementation(() => { throw new Error("private bytes and stack"); });
    expect(() => o.io.write("{}")).toThrow(expect.objectContaining({ error: operationError("output_unavailable") }));
    expect(o.chunks).toEqual([]); expect(o.syscall).not.toHaveBeenCalled();
    if (state === "throws") expect(write).toHaveBeenCalledTimes(1);
    else expect(write).not.toHaveBeenCalled();
  });

  it.each(["offline", "socket"])("%s handles a late stream error once after write returns, including during offline drain", async path => {
    const f = fixture(), o = output(), events: string[] = [];
    if (path === "socket") {
      owner(f); const server = createServer((_request, response) => response.end(JSON.stringify({
        actor: { kind: "operator", accountId: null }, mode: "token", listener: "unix", fullAuthority: true,
        installationPermissions: [], projects: [], projectsTruncated: false, freshLogin: { state: "exempt", validUntil: null },
      })));
      await new Promise<void>(resolve => server.listen(f.paths.adminSocketPath, resolve));
      cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    }
    const error = new Promise<void>(resolve => o.stdout.once("error", () => { events.push("error"); resolve(); }));
    o.stdout._write = (_chunk, _encoding, done) => { process.nextTick(() => done(new Error("late private EPIPE"))); };
    const write = (line: string) => { o.io.write(line); events.push("write-returned"); };
    const drain = RealStore.prototype.closeAfterDrain;
    if (path === "offline") vi.spyOn(RealStore.prototype, "closeAfterDrain").mockImplementation(async function (this: stores.SqliteStateStore) {
      events.push("drain"); expect(existsSync(f.paths.controllerLockPath)).toBe(true);
      await error; expect(existsSync(f.paths.controllerLockPath)).toBe(true);
      await drain.call(this); events.push("closed");
    });
    await runSessionDescribe(["describe"], f.paths, write); await error;
    o.stdout.emit("error", new Error("duplicate private error")); o.io.reportError("duplicate");
    expect(o.fail).toHaveBeenCalledTimes(1); expect(o.exitCode).toBe(1);
    expect(o.diagnostics).toEqual([`${JSON.stringify({ error: operationError("output_unavailable") })}\n`]);
    if (path === "offline") {
      expect(events).toEqual(["write-returned", "drain", "error", "closed"]);
      expect(existsSync(f.paths.controllerLockPath)).toBe(false);
    }
  });

  it.each(["EPIPE", "EAGAIN", "EIO"])("%s stderr stays silent without retries for synchronous and late errors", code => {
    const o = output(); o.syscall.mockImplementation(() => { throw Object.assign(new Error("private"), { code }); });
    expect(() => o.io.reportError(JSON.stringify({ error: operationError("output_unavailable") }))).not.toThrow();
    expect(() => o.stderr.emit("error", new Error("late stderr failure"))).not.toThrow();
    expect(() => o.stdout.emit("error", new Error("late stdout failure"))).not.toThrow();
    expect(o.exitCode).toBe(1); expect(o.diagnostics).toEqual([]); expect(o.syscall).toHaveBeenCalledTimes(1);
  });
});

// Exercise the production writer and runner in a child without a build prerequisite.
// Seeding 500 projects through packaged CLI invocations would dominate artifact acceptance.
// Both SQLite and the socket belong to this temporary fixture; no host state is read.
describe("session describe real-process output", () => {
  // Spawns a real CLI after seeding 500 rows, with slow or closed pipe readers.
  it.each(["offline", "socket"].flatMap(path => ["slow", "gone", "gone-and-stderr"].map(reader => ({ path, reader }))))(
    "$path: large output with $reader reader releases ownership before pipe drain", async ({ path, reader }) => {
    const f = fixture(), seed = new RealStore(f.paths.databasePath), at = new Date().toISOString();
    for (let i = 0; i < 500; i++) seed.saveKnowledgeProject({ id: `p-${String(i).padStart(4, "0")}`, name: "Synthetic", status: "active",
      revision: 1, createdAt: at, updatedAt: at }, "fixture");
    await seed.closeAfterDrain();
    await f.run();
    const dto = JSON.parse(f.lines[0]);
    expect(dto.projects).toHaveLength(500); expect(dto.projectsTruncated).toBe(false);
    if (path === "socket") {
      owner(f); dto.listener = "unix";
      const server = createServer((_request, response) => response.end(JSON.stringify(dto)));
      await new Promise<void>(resolve => server.listen(f.paths.adminSocketPath, resolve));
      cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    }
    const expected = `${JSON.stringify(dto, null, 2)}\n`;
    expect(Buffer.byteLength(expected)).toBeGreaterThan(300 * 1024);
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    const source = `
      import { existsSync } from "node:fs";
      import { createSessionDescribeOutput, runSessionDescribe } from ${JSON.stringify(pathToFileURL(join(repository, "src/cli/session-describe.ts")).href)};
      const paths = ${JSON.stringify(f.paths)}, output = createSessionDescribeOutput();
      runSessionDescribe(["describe"], paths, output.write).catch(error => {
        output.reportError(JSON.stringify({ error: error.error }));
      }).finally(() => {
        process.send({ pending: process.stdout.writableLength, locked: existsSync(paths.controllerLockPath),
          databaseLocked: existsSync(paths.databasePath + ".owner.lock") });
        process.disconnect();
      });`;
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", HOME: f.root,
      WORKTREE_CONTROL_DATA_DIR: f.paths.dataDirectory, WORKTREE_CONTROL_STATE_DIR: f.paths.stateDirectory };
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: repository, env: environment,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "", stdout = "", forced = false;
    child.stderr!.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 20_000);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      type CleanupEvidence = { pending: number; locked: boolean; databaseLocked: boolean };
      const completed = await new Promise<CleanupEvidence>((resolve, reject) => {
        child.once("message", message => resolve(message as CleanupEvidence)); child.once("error", reject);
        child.once("exit", () => reject(new Error("Child exited before cleanup evidence")));
      });
      // Disconnect removes the child IPC handle: only pending stdout keeps it alive.
      if (child.connected) await new Promise<void>(resolve => child.once("disconnect", resolve));
      expect(completed.pending).toBeGreaterThan(0);
      if (path === "offline") {
        expect(completed.locked).toBe(false); expect(completed.databaseLocked).toBe(false);
        expect(existsSync(f.paths.controllerLockPath)).toBe(false);
        // A separate CLI process acquires and releases while the first pipe remains unread.
        const second = await promisify(execFile)(process.execPath, ["--import", "tsx", join(repository, "src/cli/index.ts"),
          "session", "describe", "--data-dir", f.paths.dataDirectory, "--state-dir", f.paths.stateDirectory],
        { cwd: repository, env: environment, timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
        expect(second.stderr).toBe(""); expect(second.stdout).toBe(expected);
        expect(existsSync(f.paths.controllerLockPath)).toBe(false);
      }
      if (reader === "slow") {
        await new Promise(resolve => setTimeout(resolve, 2_000));
        expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
        child.stdout!.on("data", chunk => { stdout += chunk; });
      } else {
        if (reader === "gone-and-stderr") await new Promise<void>(resolve => {
          child.stderr!.once("close", resolve); child.stderr!.destroy();
        });
        // Consume one prefix, then close while the large accepted write is still pending.
        child.stdout!.once("data", chunk => { stdout += chunk; child.stdout!.destroy(); });
      }
      const result = await closed;
      expect(forced).toBe(false); expect(result).toEqual({ code: reader === "slow" ? 0 : 1, signal: null });
      if (reader === "slow") {
        expect(stderr).toBe(""); expect(stdout).toBe(expected); expect(JSON.parse(stdout)).toEqual(dto);
      } else {
        expect(stdout.length).toBeGreaterThan(0); expect(stdout.length).toBeLessThan(expected.length);
        expect(expected.startsWith(stdout)).toBe(true);
        if (reader === "gone-and-stderr") expect(stderr).toBe("");
        else expect(stderr).toBe(`${JSON.stringify({ error: operationError("output_unavailable") })}\n`);
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL"); await closed;
      }
    }
  }, 40_000);
});

describe("projects CLI mount (D2a)", () => {
  it("parses only the documented forms", () => {
    expect(parseProjectsCommand(["list"])).toEqual({ operation: "project.list", input: {} });
    expect(parseProjectsCommand(["list", "--limit", "5", "--cursor", "abc"])).toEqual({ operation: "project.list", input: { limit: 5, cursor: "abc" } });
    expect(parseProjectsCommand(["status", "project-a"])).toEqual({ operation: "project.status", input: { projectId: "project-a" } });
    expect(parseProjectsCommand(["status", "project-a", "--compact"])).toEqual({ operation: "project.status", input: { projectId: "project-a", compact: true } });
    expect(parseProjectsCommand(["worktrees", "project-a"])).toEqual({ operation: "project.worktrees", input: { projectId: "project-a" } });
    for (const args of [[], ["list", "--limit"], ["list", "--limit", "x"], ["list", "--limit", "1", "--limit", "2"], ["list", "--other", "1"], ["status"],
      ["status", "--compact"], ["status", "a", "--other"], ["worktrees", "a", "--compact"], ["remove", "a"]]) {
      expect(() => parseProjectsCommand(args), args.join(" ")).toThrow(/Usage: projects/);
    }
  });

  it.each(["open", "token", "better-auth"])("%s: offline and through the private socket release the same operator DTOs", async mode => {
    const f = fixture(mode), seeded = new stores.SqliteStateStore(f.paths.databasePath);
    seeded.saveKnowledgeProject({ id: "project-a", name: "Alpha", status: "active", revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "fixture");
    const registration = seeded.addProject({ name: "alpha", repositoryPath: join(f.root, "missing-repository"), port: 7411, executable: "node", args: ["server.js"] }).id;
    const db = ownedFixtureDatabase(seeded);
    db.prepare("UPDATE project_mapping_clock SET value=value+1 WHERE singleton=1").run();
    db.prepare("UPDATE projects SET parent_project_id='project-a',mapping_version=(SELECT value FROM project_mapping_clock WHERE singleton=1) WHERE id=?").run(registration);
    seeded.close();
    const run = async (args: string[]) => { await runProjectsCommand(args, f.paths, f.write); return JSON.parse(f.lines.pop()!); };
    const offlineList = await run(["list"]), offlineStatus = await run(["status", "project-a"]), offlineWorktrees = await run(["worktrees", "project-a"]);
    expect(offlineList).toEqual({ nextCursor: null, items: [{ projectId: "project-a", name: "Alpha", status: "active", registrationsTruncated: false,
      registrations: [{ registrationId: registration, name: "alpha", port: 7411, phase: "stopped", worktreePath: null, claim: "none" }] }] });
    expect(offlineStatus).toMatchObject({ projectId: "project-a", revision: 1, writable: true, compact: false,
      registrations: [{ registrationId: registration, launch: { executable: "node", args: ["server.js"] }, managedServer: true }] });
    // A path that is no Git repository: discovery is unavailable, and nothing about why is released.
    expect(offlineWorktrees).toEqual({ projectId: "project-a", registrationsTruncated: false,
      registrations: [{ registrationId: registration, discovery: "unavailable", worktrees: [], worktreesTruncated: false }] });
    await expect(runProjectsCommand(["status", "missing"], f.paths, f.write)).rejects.toMatchObject({ error: operationError("resource_not_found", "not_found", "none", 404) });
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);

    owner(f);
    const store = new stores.SqliteStateStore(f.paths.databasePath);
    cleanup.push(() => store.closeAfterDrain());
    // The controller's own Git reader, so discovery matches the offline command's.
    const git = new SystemGitWorktreeReader(); cleanup.push(() => git.close());
    const server = await listenAdminSocket(f.paths.adminSocketPath, vi.fn(), buildOperationsRuntime({ ...options(store, mode), projectReads: { ...options(store, mode).projectReads, git } }));
    cleanup.push(() => server.close());
    expect(await run(["list"])).toEqual(offlineList);
    expect(await run(["status", "project-a"])).toEqual(offlineStatus);
    expect(await run(["worktrees", "project-a"])).toEqual(offlineWorktrees);
    await expect(runProjectsCommand(["status", "missing"], f.paths, f.write)).rejects.toMatchObject({ error: operationError("resource_not_found", "not_found", "none", 404) });
  });
});
