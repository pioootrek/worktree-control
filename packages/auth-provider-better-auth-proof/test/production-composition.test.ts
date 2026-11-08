import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerAuthentication } from "@/server/bootstrap/authentication";
import { authenticationAdminHandler } from "@/server/authentication-admin";
import { AuthenticationService } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { SqliteStateStore } from "@/server/sqlite-store";
import { createControllerServer } from "@/server/http-server";
import { EventStream } from "@/server/events";
import { ControlService } from "@/server/control-service";
import { ProcessManager } from "@/server/process-manager";
import { Authenticator } from "./factor-fixture";
import { PROVIDER_ENTRY } from "./fixture";

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of closes.splice(0).reverse()) await close(); });
let peers = 1;
const ownerId = "69849424-2aba-4fdd-b4fa-a394a77a193c";
const password = "production-finite-password-123";
const email = "owner@fixture.invalid";
async function fixture(enrolled = true) {
  const root = mkdtempSync(join(tmpdir(), "rbac-production-")); closes.push(() => rmSync(root, { recursive: true, force: true }));
  let store = new SqliteStateStore(join(root, "state.sqlite3"));
  let first = true;
  const oldIdentity = new IdentityService(store, undefined, () => { if (first) { first = false; return ownerId; } return crypto.randomUUID(); }, undefined, undefined, store);
  const owner = oldIdentity.bootstrapOwnerSession();
  const setup = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
  const installation = setup.generateToken("fixture").token; setup.setMode("token", "fixture");
  const entry = join(root, "provider.mjs"); writeFileSync(entry, `export { authenticationProvider } from ${JSON.stringify(PROVIDER_ENTRY)};`, { mode: 0o600 });
  let authentication = new AuthenticationService(store);
  let composition = createControllerAuthentication({ store, authentication, dataDirectory: root, actor: "local-cli" });
  const execute = (action: string, input?: unknown) => composition.execute({ command: "auth-provider", action, ...(input ? { input } : {}) });
  await execute("configure", { module: entry, origin: "https://controller.test", signingSecret: { kind: "generate" } });
  if (enrolled) await composition.execute({ command: "auth-provider", action: "enroll", principalId: ownerId, input: { email, name: "Owner", password } });
  const select = authenticationAdminHandler({ authentication, closeMcpSessions: async () => {}, disconnectEvents() {} });
  if (!enrolled) {
    closes.push(async () => { await composition.dispose(); await store.closeAfterDrain(); });
    return { select, authentication, store, composition, installation, owner };
  }
  await select({ command: "mode set", value: "better-auth" });
  expect(authentication.status()).toMatchObject({ activeMode: "token", configuredMode: "better-auth", restartRequired: true });
  expect(authentication.authenticateInstallation(installation)).not.toBeNull();
  await composition.dispose(); await store.closeAfterDrain();
  store = new SqliteStateStore(join(root, "state.sqlite3")); authentication = new AuthenticationService(store);
  composition = createControllerAuthentication({ store, authentication, dataDirectory: root, actor: "local-cli" });
  const service = new ControlService(store, { list: async () => [] } as never, new ProcessManager(), undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, composition.identity);
  const knowledge = new KnowledgeService(store, composition.identity);
  await authentication.prepareAccountMode();
  await store.admission.run(() => authentication.assertStartupPolicy());
  const browserAuthentication = await composition.prepareBrowserAuthentication({ origin: "https://controller.test", knowledge,
    runtimeReads: service, runtimeMutations: service, verification: service, configuration: service });
  const server = createControllerServer({ service, events: new EventStream(store.admission), directoryBrowser: {} as never,
    mcpStatus: () => ({} as never), webRoot: root, host: "127.0.0.1", port: 47831, accessToken: "old-pairing-secret",
    identity: composition.identity, authentication, publicOrigin: "https://controller.test", browserAuthentication, admission: store.admission });
  closes.push(async () => { await server.close(); await composition.dispose(); await store.closeAfterDrain(); });
  const cookie = new Map<string, string>(), peer = `198.18.10.${peers++}`;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") => {
    const incoming = Object.assign(new PassThrough(), { url: path, method, headers: { host: "controller.test", origin: "https://controller.test", "content-type": "application/json",
      ...(cookie.size ? { cookie: [...cookie].map(([key, value]) => `${key}=${value}`).join("; ") } : {}), ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) }, rawHeaders: [], socket: { remoteAddress: peer } });
    return new Promise<{ status: number; body: Record<string, unknown>; headers: Map<string, unknown> }>(resolve => {
      const values = new Map<string, unknown>(); let status = 0;
      const responseEvents = new EventEmitter();
      const response = Object.assign(responseEvents, { headersSent: false, writableFinished: false, destroyed: false,
        setHeader(key: string, value: unknown) { values.set(key.toLowerCase(), value); }, removeHeader(key: string) { values.delete(key.toLowerCase()); },
        writeHead(code: number, headers: Record<string, unknown> = {}) { status = code; this.headersSent = true; for (const [k, v] of Object.entries(headers)) values.set(k.toLowerCase(), v); return this; },
        end(text: string) {
          for (const line of (values.get("set-cookie") ?? []) as string[]) {
            const pair = line.split(";")[0]!, index = pair.indexOf("=");
            if (/Max-Age=0/i.test(line)) cookie.delete(pair.slice(0, index)); else cookie.set(pair.slice(0, index), pair.slice(index + 1));
          }
          this.writableFinished = true; responseEvents.emit("finish"); resolve({ status, body: JSON.parse(text), headers: values });
        }, destroy() { throw new Error("Unexpected incomplete response"); } });
      server.server.emit("request", incoming as unknown as IncomingMessage, response as unknown as ServerResponse);
      incoming.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  return { select, authentication, store, composition, installation, owner, call, cookie };
}

describe("actual controller production account composition", () => {
  it("does not mistake a surviving mapping for native enrollment after quarantine or account loss", async () => {
    const f = await fixture();
    const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
    try { await storage.borrow(async () => { connection.prepare("UPDATE authentication_ba_account SET password=NULL").run([]); }); }
    finally { connection.close(); }
    await expect(f.authentication.prepareAccountMode()).rejects.toThrow("unavailable");
    expect(await f.composition.execute({ command: "auth-provider", action: "status" })).toMatchObject({ productionAccountModeAvailable: false });
  });
  it("refuses missing owner enrollment without changing mode", async () => {
    const f = await fixture(false);
    await expect(f.select({ command: "mode set", value: "better-auth" })).rejects.toThrow();
    expect(f.authentication.status()).toMatchObject({ activeMode: "token", configuredMode: "token" });
  });
  it("prepares before restart, publicly logs in the same owner and denies every unsupported legacy surface", async () => {
    const f = await fixture(); if (!f.call) throw new Error("Missing public composition");
    expect(await f.composition.execute({ command: "auth-provider", action: "status" })).toMatchObject({ productionAccountModeAvailable: true, owner: { principal: { id: ownerId } } });
    expect((await f.call("/api/auth/status")).body).toEqual({ mode: "better-auth", loginAvailable: true });
    const login = await f.call("/api/auth/sign-in/email", { email, password });
    expect(login.status).toBe(200); expect(JSON.stringify(login.body)).not.toMatch(/token|password|hash/);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const session = await f.call("/api/auth/get-session"); expect(session.status).toBe(200); expect(JSON.stringify(session.body)).toContain(ownerId);
    for (const path of ["/api/dashboard", "/api/events", "/api/backups", "/api/user-backups", "/api/metrics", "/api/directories", "/api/identity/bootstrap", "/api/identity/admin",
      "/api/projects/x/environment", "/api/projects/x/storage/cache", "/api/projects/x/godot-web", "/api/dev-vault", "/api/auth/sign-up/email", "/api/auth/revoke-sessions", "/api/auth/update-user"]) {
      expect((await f.call(path, {})).status, path).toBe(401);
    }
    expect((await f.call("/api/auth/get-session", undefined, { Authorization: `Bearer ${f.installation}` })).status).toBe(401);
    const old = f.cookie!.get("__Secure-wtc.session_token")!;
    expect((await f.call("/api/auth/sign-out", {})).status).toBe(200);
    expect((await f.call("/api/auth/get-session", undefined, { cookie: `__Secure-wtc.session_token=${old}` })).body).toMatchObject({ authenticated: false });
    expect(f.authentication.authenticateInstallation(f.installation)).toBeNull();
    expect(() => f.composition.identity.describeIdentity({ principalId: ownerId, principalKind: "owner", credentialId: f.owner.credential.id, authenticationMethod: "owner_session" })).toThrow();
  });
  it("enforces integrated public TOTP enrollment/login replay and committed failed-guess budgets", async () => {
    const f = await fixture(); if (!f.call) throw new Error("Missing public composition");
    const clock = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock);
    expect((await f.call("/api/auth/sign-in/email", { email, password })).status).toBe(200);
    const start = await f.call("/api/auth/two-factor/enable", { password }); expect(start.status).toBe(200);
    const authenticator = new Authenticator(start.body.totpURI as string);
    const code = authenticator.code();
    expect((await f.call("/api/auth/two-factor/verify-totp", { code })).status).toBe(200);
    f.cookie!.clear();
    expect((await f.call("/api/auth/sign-in/email", { email, password })).body).toMatchObject({ outcome: "challenge", authenticated: false, method: "totp" });
    expect((await f.call("/api/auth/two-factor/verify-totp", { code })).status).toBe(401);
    vi.setSystemTime(clock + 31_000);
    const next = authenticator.code(); expect((await f.call("/api/auth/two-factor/verify-totp", { code: next })).status).toBe(200);
    f.cookie!.clear(); await f.call("/api/auth/sign-in/email", { email, password });
    expect((await f.call("/api/auth/two-factor/verify-totp", { code: next })).status).toBe(401);
    vi.setSystemTime(clock + 120_000);
    f.cookie!.clear(); await f.call("/api/auth/sign-in/email", { email, password });
    for (let i = 0; i < 5; i++) expect((await f.call("/api/auth/two-factor/verify-totp", { code: "invalid" })).status).toBe(400);
    // Validly-shaped wrong codes enter native verification and roll its failed transaction back.
    const charged = async () => {
      const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
      try { return await storage.borrow(async () => (connection.prepare("SELECT coalesce(sum(charged),0) n FROM authentication_factor_budgets WHERE epoch=? AND scope='totp'").all([Math.floor(Date.now()/60_000)])[0] as {n:number}).n); }
      finally { connection.close(); }
    };
    const before = await charged();
    expect((await f.call("/api/auth/two-factor/verify-totp", { code: authenticator.wrong() })).status).toBe(401);
    expect(await charged()).toBe(before + 1);
    // The native limiter may refuse sooner than the controller ceiling. Neither
    // a native rollback nor a refused guess restores a committed controller charge.
    for (let i = 0; i < 5; i++) expect([401, 429]).toContain((await f.call("/api/auth/two-factor/verify-totp", { code: authenticator.wrong() })).status);
    expect((await f.call("/api/auth/two-factor/verify-totp", { code: authenticator.code() })).status).toBe(429);
    expect(await charged()).toBeLessThanOrEqual(5);
  });
});
