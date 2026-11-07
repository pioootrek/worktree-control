import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerAuthentication, CONTROLLER_AUTHENTICATION_POLICY } from "@/server/bootstrap/authentication";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { acquireControllerLock } from "@/server/controller-lock";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { AuthenticationService, loadAuthenticationProvider, ProviderKnowledgeApplication, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { cliFixture } from "./cli-provider-fixture";
import { BrowserClient } from "./browser-authentication-fixture";
import { ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, PROVIDER_ENTRY, count, readCommitted } from "./fixture";
import { gate } from "./strict-fixture";
import type { ProofFaultInjection } from "../src/index";

const EXISTING_OWNER = "69849424-2aba-4fdd-b4fa-a394a77a193c";
let peerSequence = 1;
const enrollment = { email: OWNER_EMAIL, name: "Existing owner", password: OWNER_PASSWORD };
afterEach(() => vi.restoreAllMocks());

async function compositionFixture(options: { beforeLoad?(): Promise<void>; afterLoad?(): Promise<void>; faults?: ProofFaultInjection; configure?: boolean } = {}) {
  const files = cliFixture(), peer = `198.18.2.${peerSequence++}`;
  const lock = acquireControllerLock(files.paths.controllerLockPath), store = new SqliteStateStore(files.paths.databasePath);
  let firstId = true;
  const existingIdentity = new IdentityService(store, undefined, () => {
    if (firstId) { firstId = false; return EXISTING_OWNER; }
    return randomUUID();
  });
  // An existing account, credential, grant and authored history predate provider enrollment.
  const existing = existingIdentity.bootstrapOwnerSession(), ownerActor = existingIdentity.authenticateBearer(existing.token);
  const project = existingIdentity.createKnowledgeProject({ name: "Existing project" }, ownerActor);
  existingIdentity.setKnowledgeGrant({ principalId: EXISTING_OWNER, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] }, ownerActor);
  new KnowledgeService(store, existingIdentity).execute({ operation: "create_task", input: { projectId: project.id,
    title: "Before enrollment", description: "Preserved history", idempotencyKey: "before-provider" } }, ownerActor);
  const setup = new AuthenticationService(store, undefined, undefined, undefined, undefined, "offline");
  const token = setup.generateToken("fixture").token; setup.setMode("token", "fixture");
  const authentication = new AuthenticationService(store);
  store.requireAdmission();
  let runtime: AuthenticationProviderRuntime | undefined, maintenance = false;
  const releases: Array<() => void> = [];
  const load = vi.fn(async (input: Parameters<typeof loadAuthenticationProvider>[0]) => {
    await options.beforeLoad?.();
    runtime = await loadAuthenticationProvider({ ...input, options: { ...input.options, faultInjection: options.faults } as typeof input.options });
    await options.afterLoad?.();
    return runtime;
  });
  // The exact composition called by src/cli/index.ts, with the real loader and sole store.
  const composition = createControllerAuthentication({ store, dataDirectory: files.paths.dataDirectory, authentication,
    actor: "local-admin", maintenance: () => maintenance, loadProvider: load,
    holdLifetime: () => { const timer = setInterval(() => {}, 60_000); const release = () => clearInterval(timer); releases.push(release); return release; } });
  const knowledge = new KnowledgeService(store, composition.identity);
  const app = new ProviderKnowledgeApplication(store.admission, composition.identity, knowledge);
  const run = <T>(operation: () => T | Promise<T>) => store.admission.run(operation);
  const command = (action: "enroll" | "recover", input: unknown = enrollment, principalId = EXISTING_OWNER) => composition.execute({ command: "auth-provider", action, principalId, input });
  const browser = () => composition.prepareBrowserAuthentication({ origin: ORIGIN, knowledge });
  const listen = async () => {
    const socket = join(files.root, "composition.sock");
    const unixAdapter = await composition.prepareBrowserAuthentication({ origin: ORIGIN, knowledge, trustedFixturePeer: peer });
    const unix = createServer((request, response) => { void unixAdapter.handle(request, response); });
    await new Promise<void>(resolve => unix.listen(socket, resolve));
    return { client: new BrowserClient(socket), close: () => new Promise<void>((resolve, reject) => unix.close(error => error ? reject(error) : resolve())) };
  };
  let entries = 0;
  const configure = async (origin = ORIGIN, kind: "generate" | "preserve" = "preserve", source = PROVIDER_ENTRY) => {
    const entry = join(files.root, `shared-provider-${++entries}.mjs`);
    writeFileSync(entry, `export { authenticationProvider } from ${JSON.stringify(source)};`, { mode: 0o600 });
    return composition.execute({ command: "auth-provider", action: "configure", input: { module: entry, origin, signingSecret: { kind } } });
  };
  const activeRuntime = () => { if (!runtime) throw new Error("Provider is not loaded"); return runtime; };
  const stop = () => { maintenance = true; };
  const cleanup = async () => {
    await composition.dispose().catch(() => {});
    await store.closeAfterDrain(); lock.release(); releases.forEach(release => release()); files.remove();
  };
  if (options.configure !== false) await configure(ORIGIN, "generate");
  return { ...files, configure, store, lock, existing, ownerActor, project, authentication, token, composition, knowledge, app, load, run, command, browser, listen, activeRuntime, stop, cleanup };
}
type Fixture = Awaited<ReturnType<typeof compositionFixture>>;
const mutation = (f: Fixture, key = "provider-composition") => ({ operation: "create_task", input: {
  projectId: f.project.id, title: "After enrollment", description: "Current provider authority", idempotencyKey: key,
} });
async function actor(f: Fixture, client: BrowserClient): Promise<ProviderSessionActor> {
  const result = await f.activeRuntime().authenticate(new Headers({ cookie: client.cookie }));
  expect(result).not.toBeNull(); return result!;
}

// Included by the existing managed node:test:auth-provider-cli preset.
describe("production shared provider composition", () => {
  it("enrolls the existing owner without changing identity/grants/history, then login and recovery use the shared authority", async () => {
    const f = await compositionFixture(); let http: Awaited<ReturnType<Fixture["listen"]>> | undefined;
    try {
      const before = await f.run(() => ({ principal: f.store.getPrincipal(EXISTING_OWNER), grants: f.store.listKnowledgeProjectGrants(EXISTING_OWNER), credentials: f.store.listPrincipalCredentials(EXISTING_OWNER) }));
      const history = readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM knowledge_history").all());
      await expect(f.command("enroll")).resolves.toMatchObject({ principalId: EXISTING_OWNER, enrolled: true });
      expect(await f.run(() => ({ principal: f.store.getPrincipal(EXISTING_OWNER), grants: f.store.listKnowledgeProjectGrants(EXISTING_OWNER), credentials: f.store.listPrincipalCredentials(EXISTING_OWNER) }))).toEqual(before);
      expect(readCommitted(f.paths.databasePath, db => db.prepare("SELECT * FROM knowledge_history").all())).toEqual(history);
      expect(await f.run(() => f.store.listPrincipals("owner"))).toEqual([before.principal]);
      http = await f.listen(); expect(await http.client.login()).toMatchObject({ status: 200, body: { authenticated: true } });
      const retained = await actor(f, http.client);
      expect(await f.app.describeIdentity(retained)).toMatchObject({ principal: before.principal, credential: null });
      await expect(f.run(() => f.composition.identity.requireOwnerSession(retained))).rejects.toMatchObject({ code: "owner_authentication_required" });
      expect(await http.client.call("/api/knowledge", { body: mutation(f) })).toMatchObject({ status: 200, body: { replayed: false } });
      expect(await f.app.execute(mutation(f), retained)).toMatchObject({ replayed: true });
      await f.command("recover", { newPassword: "replacement-owner-password-1" });
      await expect(f.app.execute(mutation(f), retained)).rejects.toMatchObject({ code: "invalid_credential" });
      expect(await http.client.session()).toMatchObject({ status: 200, body: { authenticated: false } });
      expect(f.load).toHaveBeenCalledOnce();
      expect(await f.run(() => f.authentication.status())).toMatchObject({ activeMode: "token", configuredMode: "token", restartRequired: false });
      await expect(f.run(() => f.authentication.setMode("better-auth", "local-cli"))).rejects.toThrow("to be implemented");
    } finally { await http?.close(); await f.cleanup(); }
  });

  it("shares one load and guarded connection when enrollment and browser preparation contend", async () => {
    const entered = gate(), resume = gate(), f = await compositionFixture({ beforeLoad: async () => { entered.open(); await resume.opened; } });
    try {
      const enrollment = f.command("enroll"), prepared = f.browser();
      await entered.opened;
      expect(f.load).toHaveBeenCalledOnce();
      expect(await f.run(() => f.store.listPrincipals("owner"))).toHaveLength(1);
      resume.open(); await enrollment; await prepared;
      expect(f.load.mock.calls[0]![0]).toMatchObject({ unreleasedSessions: CONTROLLER_AUTHENTICATION_POLICY.unreleasedSessions,
        sessionRows: CONTROLLER_AUTHENTICATION_POLICY.sessionRows, sessionReconcileBatch: CONTROLLER_AUTHENTICATION_POLICY.sessionReconcileBatch });
      expect(f.activeRuntime().issuanceBounded).toBe(true);
      expect(() => new SqliteStateStore(f.paths.databasePath)).toThrow();
      await f.browser(); expect(f.load).toHaveBeenCalledOnce();
    } finally { resume.open(); await f.cleanup(); }
  });

  it.each(["logout", "revoke", "expiry", "config-change", "disposal"] as const)("rejects retained actors after %s, including a fresh admitted operation after waiting", async reason => {
    const f = await compositionFixture(); let http: Awaited<ReturnType<Fixture["listen"]>> | undefined;
    const waiting = gate(), resume = gate();
    try {
      await f.command("enroll"); http = await f.listen(); await http.client.authenticated(); const retained = await actor(f, http.client);
      const afterWait = f.run(async () => {
        await f.store.admission.idle(async () => { waiting.open(); await resume.opened; });
        return f.app.executeAdmitted(mutation(f, reason), retained);
      }).catch(error => error);
      await waiting.opened;
      if (reason === "logout") expect((await http.client.call("/api/auth/sign-out", { body: {} })).status).toBe(200);
      if (reason === "revoke") await f.activeRuntime().revokeSubject({ principalId: EXISTING_OWNER, actor: "test" });
      if (reason === "expiry") {
        const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
        try { await storage.borrow(async () => { connection.prepare('UPDATE authentication_ba_session SET "expiresAt"=?').run([new Date(Date.now() - 60_000).toISOString()]); }); }
        finally { connection.close(); }
      }
      if (reason === "config-change") await f.configure("https://changed.invalid", "preserve");
      if (reason === "disposal") await f.composition.dispose();
      resume.open(); expect(await afterWait).toMatchObject({ code: "invalid_credential" });
      await expect(f.app.execute(mutation(f, reason), retained)).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await f.run(() => f.store.listTasks(f.project.id, 10, 0))).items).toHaveLength(1);
    } finally { resume.open(); await http?.close(); await f.cleanup(); }
  });

  it("human-disable revokes actors through the same identity without invalidation notifications", async () => {
    const f = await compositionFixture(); let http: Awaited<ReturnType<Fixture["listen"]>> | undefined;
    try {
      const human = await f.composition.execute({ command: "auth-provider", action: "human-create" }) as { principal: { id: string } };
      await f.command("enroll", enrollment, human.principal.id); http = await f.listen(); await http.client.authenticated();
      const retained = await actor(f, http.client);
      expect(await f.app.describeIdentity(retained)).toMatchObject({ principal: { kind: "human" } });
      await f.composition.execute({ command: "auth-provider", action: "human-disable", principalId: human.principal.id });
      await expect(f.app.describeIdentity(retained)).rejects.toMatchObject({ code: "invalid_credential" });
      expect(await http.client.session()).toMatchObject({ status: 200, body: { authenticated: false } });
    } finally { await http?.close(); await f.cleanup(); }
  });

  it("fails closed on missing or incompatible configuration, retains the failed load and rejects origin mismatch", async () => {
    const f = await compositionFixture({ configure: false });
    try {
      await expect(f.browser()).rejects.toMatchObject({ code: "configuration_missing" }); expect(f.load).not.toHaveBeenCalled();
      await f.configure(ORIGIN, "generate");
      await expect(f.composition.prepareBrowserAuthentication({ origin: "http://controller.test", knowledge: f.knowledge })).rejects.toMatchObject({ code: "configuration_invalid" });
      const entry = join(f.root, "incompatible.mjs"); writeFileSync(entry, "export const authenticationProvider = {};", { mode: 0o600 });
      await f.configure(ORIGIN, "preserve", entry);
      await expect(f.command("enroll")).rejects.toMatchObject({ code: "provider_unavailable" });
      await expect(f.browser()).rejects.toMatchObject({ code: "provider_unavailable" }); expect(f.load).toHaveBeenCalledOnce();
      await f.configure(ORIGIN, "preserve");
      await expect(f.browser()).rejects.toMatchObject({ code: "provider_configuration_restart_required" }); expect(f.load).toHaveBeenCalledOnce();
    } finally { await f.cleanup(); }
  });

  it("rechecks changed configuration after initialization before enrollment or browser release", async () => {
    const entered = gate(), resume = gate(), f = await compositionFixture({ afterLoad: async () => { entered.open(); await resume.opened; } });
    try {
      const enroll = f.command("enroll").catch(error => error), browser = f.browser().catch(error => error);
      await entered.opened; await f.configure("https://changed.invalid", "preserve"); resume.open();
      expect(await enroll).toMatchObject({ code: "provider_configuration_restart_required" });
      expect(await browser).toMatchObject({ code: "provider_configuration_restart_required" });
      expect(count(f.paths.databasePath, "authentication_ba_user")).toBe(0); expect(f.load).toHaveBeenCalledOnce();
    } finally { resume.open(); await f.cleanup(); }
  });

  it("joins accepted shared preparation during shutdown and retains both owner locks on failed disposal", async () => {
    const faults: ProofFaultInjection = {}, entered = gate(), resume = gate();
    const f = await compositionFixture({ faults, afterLoad: async () => { entered.open(); await resume.opened; } });
    let closing: Promise<void> | undefined;
    try {
      const prepared = f.browser().catch(error => error); await entered.opened;
      faults.afterDispose = async () => { throw new Error("fixture disposal failed"); };
      const closeStore = vi.fn(() => f.store.closeAfterDrain());
      const shutdown = createControllerShutdown({ service: { closeAdmission: f.stop, shutdown: closeStore }, stopping() {},
        userSchedules: undefined, backups: { close() {} }, remoteVerification: null, mcp: null, controller: { close() {} }, adminSocket: { close() {} },
        authenticationProvider: f.composition, removeServiceAccess() {}, controllerLock: f.lock });
      closing = shutdown(); const outcome = closing.catch(error => error); expect(shutdown()).toBe(closing);
      expect(closeStore).not.toHaveBeenCalled(); resume.open();
      expect(await prepared).toMatchObject({ code: "maintenance" });
      expect(await outcome).toBeInstanceOf(AggregateError); expect(closeStore).not.toHaveBeenCalled();
      expect(existsSync(f.paths.controllerLockPath)).toBe(true); expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(true);
      expect(() => new SqliteStateStore(f.paths.databasePath)).toThrow();
      await expect(f.composition.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" }); expect(f.load).toHaveBeenCalledOnce();
    } finally { resume.open(); await closing?.catch(() => {}); await f.cleanup(); }
  });

  it("refuses restored pending rows before loading, without sweeping them as unpublished", async () => {
    const f = await compositionFixture(); let http: Awaited<ReturnType<Fixture["listen"]>> | undefined;
    let restored: SqliteStateStore | undefined, restoredComposition: ReturnType<typeof createControllerAuthentication> | undefined;
    try {
      await f.command("enroll"); http = await f.listen(); await http.client.authenticated();
      const storage = f.store.authenticationProviderStorage(), connection = storage.createProviderConnection();
      try { await storage.borrow(async () => { connection.prepare("UPDATE authentication_session_issuance SET state='pending'").run([]); }); }
      finally { connection.close(); }
      const backup = join(f.root, "snapshot"), target = join(f.root, "restored", "state.sqlite3");
      await createControllerBackup(f.store, backup, { applicationVersion: "test", attachmentDirectory: join(f.root, "attachments") });
      restoreControllerBackup(backup, target);
      restored = new SqliteStateStore(target);
      const authentication = new AuthenticationService(restored); restored.requireAdmission();
      const loader = vi.fn(loadAuthenticationProvider);
      restoredComposition = createControllerAuthentication({ store: restored, dataDirectory: f.paths.dataDirectory,
        authentication, actor: "local-admin", loadProvider: loader });
      expect(restored.databaseProvenance).toBe("restored");
      const markers = () => readCommitted(target, db => db.prepare("SELECT * FROM authentication_session_issuance").all());
      const before = markers(); expect(before).toHaveLength(1);
      await expect(restoredComposition.execute({ command: "auth-provider", action: "recover", principalId: EXISTING_OWNER,
        input: { newPassword: "restored-recovery-password-1" } })).rejects.toMatchObject({ code: "provider_failed" });
      await expect(restoredComposition.prepareBrowserAuthentication({ origin: ORIGIN,
        knowledge: new KnowledgeService(restored, restoredComposition.identity) })).rejects.toThrow("provenance");
      expect(loader).not.toHaveBeenCalled(); expect(markers()).toEqual(before);
      expect(restored.authenticationProviderStorage().sessionRecoveryComplete()).toBe(false);
    } finally { await restoredComposition?.dispose(); await restored?.closeAfterDrain(); await http?.close(); await f.cleanup(); }
  });

  it("invalid current configuration rejects an already retained actor without relying on notifications", async () => {
    const f = await compositionFixture(); let http: Awaited<ReturnType<Fixture["listen"]>> | undefined;
    try {
      await f.command("enroll"); http = await f.listen(); await http.client.authenticated(); const retained = await actor(f, http.client);
      const path = join(f.paths.dataDirectory, "authentication-provider.json"), material = readFileSync(path);
      writeFileSync(path, "{}", { mode: 0o600 });
      await expect(f.app.describeIdentity(retained)).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await http.client.session()).status).toBeGreaterThanOrEqual(400);
      writeFileSync(path, material, { mode: 0o600 });
    } finally { await http?.close(); await f.cleanup(); }
  });
});
