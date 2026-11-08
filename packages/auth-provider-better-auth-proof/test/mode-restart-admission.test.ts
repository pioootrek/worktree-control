import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthCommand } from "@/cli/auth-management";
import { mcpConfigToken, INSTALLATION_TOKEN_PLACEHOLDER } from "@/cli/mcp-config";
import { removeServiceAccess, writeServiceAccess } from "@/cli/service-access";
import { listenAdminSocket } from "@/server/admin-socket";
import { authenticationAdminHandler } from "@/server/authentication-admin";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { ControlService } from "@/server/control-service";
import { acquireControllerLock } from "@/server/controller-lock";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { createMcpControllerServer } from "@/server/mcp-http-server";
import { AuthenticationService, type AuthenticationStatus } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { resolveAppPaths, type AppPaths } from "@/server/paths";
import { ProcessManager } from "@/server/process-manager";
import type { ProofFaultInjection } from "../src/index";
import { loadProof } from "./fixture";
import { pauseProvisioning } from "./strict-fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function listen(server: Server, path: string) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
}
function call(socketPath: string, path: string, token?: string, body?: unknown, session?: string) {
  return new Promise<{ status: number; body: Record<string, unknown>; session?: string }>((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: body === undefined ? "GET" : "POST", headers: {
      host: "localhost", connection: "close", accept: "application/json, text/event-stream", "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { "mcp-session-id": session } : {}),
    } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); let parsed = {}; try { parsed = JSON.parse(raw); } catch { /* Unknown public routes may return static HTML. */ }
        resolve({ status: res.statusCode!, body: parsed, session: res.headers["mcp-session-id"] as string | undefined }); });
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function cli(paths: AppPaths, args: string[]): Promise<AuthenticationStatus> {
  const output: string[] = [];
  await runAuthCommand(args, paths, { write: line => output.push(line) });
  return JSON.parse(output[0]!);
}
async function fixture(mode: "token" | "open" | "legacy", withToken = true) {
  const root = mkdtempSync(join(tmpdir(), "mode-boot-")); roots.push(root);
  const paths = resolveAppPaths(join(root, "data"), join(root, "state"));
  const lock = acquireControllerLock(paths.controllerLockPath), store = new SqliteStateStore(paths.databasePath);
  let token: string | undefined;
  try {
    const config = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
    if (withToken) token = config.generateToken("fixture").token;
    if (mode === "legacy") store.saveAuthenticationPolicy({ ...store.getAuthenticationPolicy(), mode }, "fixture", "fixture");
    else if (mode !== "token") config.setMode(mode, "fixture");
  } finally { store.close(); lock.release(); }
  return { root, paths, token };
}
async function boot(root: string, paths: AppPaths) {
  const controllerLock = acquireControllerLock(paths.controllerLockPath);
  let store: SqliteStateStore | undefined;
  let authentication: AuthenticationService;
  try { store = new SqliteStateStore(paths.databasePath); authentication = new AuthenticationService(store); authentication.assertStartupPolicy(); }
  catch (error) { store?.close(); controllerLock.release(); throw error; }
  const identity = new IdentityService(store, undefined, undefined, undefined, authentication, store);
  const owner = store.getOwnerPrincipal() ? identity.recoverOwnerSession() : identity.bootstrapOwnerSession(), ownerActor = identity.authenticateBearer(owner.token);
  store.requireAdmission();
  const run = <T>(op: () => T | Promise<T>) => store.admission.run(op);
  const faults: ProofFaultInjection = {}, { runtime, evidence } = await loadProof(store, faults);
  const service = new ControlService(store, { list: async () => [] } as never, new ProcessManager());
  const events = new EventStream(store.admission);
  let maintenance = false;
  const controller = createControllerServer({ service, identity, authentication, admission: store.admission,
    events, directoryBrowser: {} as DirectoryBrowser, webRoot: root, host: "127.0.0.1", port: 0, accessToken: "legacy-pairing",
    maintenance: () => maintenance,
    mcpStatus: () => ({ phase: "running", endpoint: null, transport: "streamable-http", network: "loopback", authentication: authentication.mode() === "open" ? "none" : "bearer", activeSessions: 0 }) });
  const mcp = createMcpControllerServer({ service, identity, authentication, port: 0, accessToken: "legacy-mcp" });
  const disconnect = vi.spyOn(events, "disconnectAll"), closeSessions = vi.spyOn(mcp, "closeSessions");
  const publish = vi.fn(() => writeServiceAccess(paths.serviceAccessPath, { pid: process.pid, startedAt: new Date().toISOString(), version: "fixture",
    dashboardEndpoint: "http://localhost", mcpEndpoint: "http://localhost/mcp", accessUrl: authentication.mode() === "legacy" ? "http://localhost/#token=legacy-pairing" : "http://localhost", logDirectory: root, authenticationMode: authentication.mode() }));
  publish();
  const adminHandler = authenticationAdminHandler({ authentication, maintenance: () => maintenance,
    closeMcpSessions: () => store.admission.idle(() => mcp.closeSessions()), disconnectEvents: () => events.disconnectAll(), onPolicyChanged: publish });
  const admin = await listenAdminSocket(paths.adminSocketPath, body => store.admission.run(() => adminHandler(body)));
  const httpPath = join(root, "http.sock"), mcpPath = join(root, "mcp.sock");
  await listen(controller.server, httpPath); await listen(mcp.server, mcpPath);
  const shutdown = createControllerShutdown({ service: { closeAdmission: () => { maintenance = true; service.closeAdmission(); }, shutdown: async () => { await runtime.dispose(); await service.shutdown(); } },
    stopping: () => undefined, userSchedules: undefined, backups: { close: () => undefined }, remoteVerification: null, mcp, controller, adminSocket: admin,
    removeServiceAccess: () => removeServiceAccess(paths.serviceAccessPath), controllerLock });
  const rpc = (token: string | undefined, method: string, params = {}, session?: string) => call(mcpPath, "/mcp", token, { jsonrpc: "2.0", id: 1, method, params }, session);
  const initialize = (token?: string) => rpc(token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mode-proof", version: "1" } });
  return { root, path: paths.databasePath, paths, store, authentication, identity, owner, ownerActor, runtime, evidence, run, faults, httpPath, mcpPath,
    disconnect, closeSessions, publish, shutdown, rpc, initialize, maintenance: () => { maintenance = true; } };
}

describe("restart-only CLI mode selection across real private/public listeners", () => {
  it.each(["token", "open", "legacy"] as const)("keeps %s authority until owning shutdown and a new boot", async mode => {
    const f = await fixture(mode), live = await boot(f.root, f.paths);
    const credential = mode === "token" ? f.token : mode === "legacy" ? "legacy-mcp" : undefined;
    const next = mode === "token" ? "open" : "token";
    const init = await live.initialize(credential); expect(init.status).toBe(200); expect(init.session).toBeTypeOf("string");
    const access = readFileSync(f.paths.serviceAccessPath, "utf8");
    try {
      const status = await cli(f.paths, ["mode", "set", next]);
      expect(status).toMatchObject({ mode, activeMode: mode, configuredMode: next, restartRequired: true, generation: 1 });
      expect((await live.rpc(credential, "tools/list", {}, init.session)).status).toBe(200);
      expect(live.disconnect).not.toHaveBeenCalled(); expect(live.closeSessions).not.toHaveBeenCalled(); expect(live.publish).toHaveBeenCalledOnce();
      expect(readFileSync(f.paths.serviceAccessPath, "utf8")).toBe(access);
      expect(await mcpConfigToken(f.paths, { environment: {}, processExists: () => false })).toEqual(mode === "open" ? null : mode === "legacy" ? expect.any(String) : INSTALLATION_TOKEN_PLACEHOLDER);
      expect(await mcpConfigToken(f.paths, { environment: {} })).toEqual(mode === "open" ? null : mode === "legacy" ? expect.any(String) : INSTALLATION_TOKEN_PLACEHOLDER);
      expect((await call(live.httpPath, "/api/metrics")).status).toBe(mode === "open" ? 200 : 401);
      expect(() => new SqliteStateStore(f.paths.databasePath)).toThrow();
    } finally { await live.shutdown(); }
    expect(existsSync(f.paths.controllerLockPath)).toBe(false); expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    expect(await cli(f.paths, ["status"])).toMatchObject({ mode: next, activeMode: null, configuredMode: next, restartRequired: false });
    const restarted = await boot(f.root, f.paths);
    try {
      expect(await cli(f.paths, ["status"])).toMatchObject({ mode: next, activeMode: next, configuredMode: next, restartRequired: false });
      expect((await call(restarted.httpPath, "/api/metrics")).status).toBe(next === "open" ? 200 : 401);
      expect((await restarted.initialize(next === "token" ? f.token : undefined)).status).toBe(200);
      if (next === "token") expect((await restarted.initialize("legacy-mcp")).status).toBe(401);
    } finally { await restarted.shutdown(); }
  });

  it("generates a prerequisite in open mode, selects/cancels/no-ops without rotation or disconnect", async () => {
    const f = await fixture("open", false), live = await boot(f.root, f.paths);
    try {
      await expect(cli(f.paths, ["mode", "set", "token"])).rejects.toThrow("auth token generate");
      const generated: string[] = [];
      await runAuthCommand(["token", "generate"], f.paths, { write: line => generated.push(line) });
      expect(JSON.parse(generated[0]!).status).toMatchObject({ mode: "open", generation: 1 });
      expect(await cli(f.paths, ["mode", "set", "token"])).toMatchObject({ restartRequired: true, generation: 1 });
      expect(await cli(f.paths, ["mode", "set", "token"])).toMatchObject({ restartRequired: true, generation: 1 });
      expect(await cli(f.paths, ["mode", "set", "open"])).toMatchObject({ restartRequired: false, generation: 1 });
      await expect(cli(f.paths, ["mode", "set", "legacy"])).rejects.toThrow("Dostępne tryby");
      await expect(cli(f.paths, ["mode", "set", "better-auth"])).rejects.toThrow("Account authentication");
      expect((await call(live.httpPath, "/api/metrics")).status).toBe(200);
      expect(live.closeSessions).not.toHaveBeenCalled(); expect(live.disconnect).not.toHaveBeenCalled();
    } finally { await live.shutdown(); }
  });

  it.each(["token", "open"] as const)("rotates immediately with %s active and the other mode pending", async mode => {
    const f = await fixture(mode), live = await boot(f.root, f.paths);
    try {
      const session = await live.initialize(mode === "token" ? f.token : undefined);
      expect(session.status).toBe(200);
      const actor = await live.run(() => mode === "token" ? live.authentication.authenticateInstallation(f.token!)! : live.authentication.anonymousInstallation()!);
      await cli(f.paths, ["mode", "set", mode === "token" ? "open" : "token"]);
      expect((await live.rpc(mode === "token" ? f.token : undefined, "tools/list", {}, session.session)).status).toBe(200);
      const output: string[] = []; await runAuthCommand(["token", "rotate"], f.paths, { write: line => output.push(line) });
      const rotated = JSON.parse(output[0]!) as { token: string };
      expect((await call(live.httpPath, "/api/metrics", f.token)).status).toBe(mode === "token" ? 401 : 200);
      expect((await call(live.httpPath, "/api/metrics", rotated.token)).status).toBe(200);
      expect(await live.run(() => live.authentication.isCurrentInstallationActor(actor))).toBe(mode === "open");
      expect(live.closeSessions).toHaveBeenCalledOnce(); expect(live.disconnect).toHaveBeenCalledOnce();
      expect((await live.rpc(mode === "token" ? rotated.token : undefined, "tools/list", {}, session.session)).status).toBe(404);
      // A later selection rereads and preserves the newly rotated verifier/generation.
      await cli(f.paths, ["mode", "set", mode]);
      expect(await live.run(() => live.authentication.verifyInstallationToken(rotated.token))).toBe(true);
      expect(await cli(f.paths, ["status"])).toMatchObject({ generation: 2, restartRequired: false });
    } finally { await live.shutdown(); }
  });

  it("selects after a queued rotation using its fresh verifier and generation", async () => {
    const f = await fixture("token"), live = await boot(f.root, f.paths);
    const hold = pauseProvisioning(live, live.faults, "rollback");
    try {
      await hold.paused;
      const rotation = live.run(() => live.authentication.rotateToken("fixture"));
      const selection = cli(f.paths, ["mode", "set", "open"]);
      await vi.waitFor(() => expect(live.store.admissionSnapshot().queuedCore).toBe(2));
      hold.resume(); await hold.pending;
      const issued = await rotation;
      expect(await selection).toMatchObject({ activeMode: "token", configuredMode: "open", restartRequired: true, generation: 2 });
      expect(await live.run(() => live.authentication.verifyInstallationToken(issued.token))).toBe(true);
      expect(await live.run(() => live.authentication.verifyInstallationToken(f.token!))).toBe(false);
    } finally { hold.resume(); await hold.pending; await live.shutdown(); }
  });

  it("rejects public selectors, identity admin and MCP tools/resources without policy or audit writes", async () => {
    const f = await fixture("token"), live = await boot(f.root, f.paths);
    const save = vi.spyOn(live.store, "saveAuthenticationPolicy");
    const before = await live.run(() => live.store.getAuthenticationPolicy());
    try {
      for (const path of ["/auth", "/api/auth/mode", "/api/auth/mode/set", "/api/identity/admin", "/api/config"]) {
        await call(live.httpPath, path, f.token, { command: "mode set", value: "open", action: "mode set", mode: "open" });
      }
      const init = await live.initialize(f.token);
      for (const method of ["tools/call", "resources/read"]) {
        const response = await live.rpc(f.token, method, method === "tools/call" ? { name: "auth_mode_set", arguments: { value: "open" } } : { uri: "worktree-control://auth/mode?value=open" }, init.session);
        expect(Boolean(response.body.error || (response.body.result as { isError?: boolean } | undefined)?.isError)).toBe(true);
      }
      expect(save).not.toHaveBeenCalled();
      expect(await live.run(() => live.store.getAuthenticationPolicy())).toEqual(before);
    } finally { await live.shutdown(); }
  });

  it("refuses a queued selector after maintenance starts, preserving fresh rotated credentials", async () => {
    const f = await fixture("token"), live = await boot(f.root, f.paths);
    const save = vi.spyOn(live.store, "saveAuthenticationPolicy");
    const hold = pauseProvisioning(live, live.faults, "rollback");
    try {
      await hold.paused;
      const rotation = live.run(() => live.authentication.rotateToken("fixture"));
      const selection = cli(f.paths, ["mode", "set", "open"]);
      const refused = expect(selection).rejects.toThrow("maintenance");
      await vi.waitFor(() => expect(live.store.admissionSnapshot().queuedCore).toBe(2));
      live.maintenance(); hold.resume(); await hold.pending;
      const issued = await rotation; await refused;
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[1]).toBe("authentication.token_rotated");
      expect(await live.run(() => live.authentication.verifyInstallationToken(issued.token))).toBe(true);
      expect(await live.run(() => live.authentication.status())).toMatchObject({ mode: "token", configuredMode: "token", generation: 2 });
    } finally { hold.resume(); await hold.pending; await live.shutdown(); }
  });
});


describe("restart startup fence", () => {
  it.each(["missing-token", "malformed-token", "unavailable"])("opens no listener and retains selected configuration for %s", async invalid => {
    const f = await fixture("token", invalid !== "missing-token");
    const lock = acquireControllerLock(f.paths.controllerLockPath), store = new SqliteStateStore(f.paths.databasePath);
    try {
      const policy = store.getAuthenticationPolicy();
      if (invalid === "unavailable") store.saveAuthenticationPolicy({ ...policy, mode: "better-auth" }, "fixture", "fixture");
      if (invalid === "malformed-token") store.saveAuthenticationPolicy({ ...policy, token: { ...policy.token!, prefix: "invalid" } }, "fixture", "fixture");
    } finally { store.close(); lock.release(); }
    await expect(boot(f.root, f.paths)).rejects.toThrow();
    for (const path of [f.paths.adminSocketPath, join(f.root, "http.sock"), join(f.root, "mcp.sock"), f.paths.controllerLockPath, `${f.paths.databasePath}.owner.lock`]) expect(existsSync(path)).toBe(false);
    const reopened = new SqliteStateStore(f.paths.databasePath);
    try { expect(reopened.getAuthenticationPolicy().mode).toBe(invalid === "unavailable" ? "better-auth" : "token"); }
    finally { reopened.close(); }
  });
});
