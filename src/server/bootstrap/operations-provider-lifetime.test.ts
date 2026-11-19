import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileProviderConfiguration } from "../authentication-provider-configuration";
import { SqliteStateStore } from "../sqlite-store";
import { resolveAppPaths } from "../paths";
import { AuthenticationProviderError, AuthenticationService, type AuthenticationProviderRuntime } from "../modules/authentication";
import { KnowledgeService } from "../modules/knowledge";
import { ProviderSessionVerifier, sessionDescribe, type AuthenticationContext } from "../modules/operations";
import { createProviderWorld } from "../modules/operations/adapters/provider-session-fixture";
import { hash, iso, none, NOW, presentedBearer, token } from "../modules/operations/adapters/credential-verifier-fixture";
import { createControllerAuthentication } from "./authentication-provider-lifetime";
import { buildOperationsRuntime } from "./operations-runtime";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const cookie = { ...none(), browserHeaders: true, providerSession: { secret: "synthetic-cookie" } };

async function fixture(failLoad = false) {
  const root = mkdtempSync(join(tmpdir(), "operations-provider-bootstrap-")), paths = resolveAppPaths(join(root, "data"));
  const store = new SqliteStateStore(paths.databasePath, undefined, { admission: "strict" });
  const authentication = await store.admission.run(() => new AuthenticationService(store));
  const world = createProviderWorld({ now: NOW });
  const session = world.passwordLogin(world.account("human"));
  const storage = store.authenticationProviderStorage();
  let available = true, maintenance = false, disposed = false;
  // The module fixture supplies native provider rows and real protection/evidence.
  // Administration, admission, composition and all other readers are production.
  const currentSession = vi.fn((id: string, sessionId: string) => {
    store.getAuthenticationPolicy(); // Strict admission proves every verifier read is admitted.
    return world.store.currentSession(id, sessionId);
  });
  vi.spyOn(store, "authenticationProviderStorage").mockReturnValue({ ...storage, currentSession, available: () => available && storage.available() });
  const started = gate(), resume = gate(), work = gate();
  let blocked = false;
  const resolveRequest = vi.fn<AuthenticationProviderRuntime["resolveRequest"]>(() => ({
    result: Promise.resolve({ session, principalId: "human" }), settled: blocked ? work.promise : Promise.resolve(),
  }));
  const runtime = {
    get disposed() { return disposed; }, issuanceBounded: true,
    isSessionAuthorityEligible: () => !disposed && available && storage.available(),
    resolveRequest,
    dispose: vi.fn(async () => { disposed = true; }),
  } as unknown as AuthenticationProviderRuntime;
  const loadProvider = vi.fn(async () => { started.resolve(); await resume.promise; if (failLoad) throw new AuthenticationProviderError("provider_unavailable", "Synthetic load failure."); return runtime; });
  const admin = createControllerAuthentication({ store, dataDirectory: paths.dataDirectory, authentication, actor: "local-admin",
    maintenance: () => maintenance, loadProvider, holdLifetime: () => () => {} });
  // Same wiring as the production start command. Construct before loading.
  const operations = buildOperationsRuntime({ store, activeMode: "better-auth", now: () => NOW, logs: { controller() {} },
    eligibility: admin, provider: admin.operationSessionAuthority(), requestBudget: admin.requestBudget,
    listeners: { api: () => true, unix: () => true } });
  if (!operations.supported) throw new Error("expected supported mode");
  const agentToken = token("wts"), id = agentToken.slice(4, 40);
  await store.admission.run(() => {
    store.savePrincipal({ id: "agent", kind: "agent", status: "active" }, "fixture");
    store.saveCredential({ id, principalId: "agent", kind: "agent_token", label: "fixture", tokenPrefix: agentToken.slice(0, 40),
      verifierHash: hash(agentToken), status: "active", expiresAt: null, createdAt: iso(NOW), revokedAt: null, lastUsedAt: null }, "fixture");
    store.humanAccounts().createHumanPrincipal({ id: "human", kind: "human", status: "active" }, "fixture");
  });
  const configuration = new FileProviderConfiguration(join(paths.dataDirectory, "authentication-provider.json"));
  const entry = join(root, "provider.mjs"); writeFileSync(entry, "export {};\n", { mode: 0o600 });
  const configure = (origin = "https://fixture.example") => configuration.configure({ module: entry, origin, signingSecret: { kind: "generate" } }, false);
  const knowledge = new KnowledgeService(store, admin.identity);
  const prepare = () => admin.prepareBrowserAuthentication({ origin: "https://fixture.example", knowledge });
  const mintHuman = () => operations.mint("api", cookie, session, {});
  const retained: AuthenticationContext[] = [];
  const otherPaths = async (open = true) => {
    for (const mint of [() => operations.mint("api", presentedBearer(agentToken), null, {}),
      () => operations.mint("unix", none(), null, {}), () => operations.mintOffline(() => true, {})]) {
      const result = await mint(); expect(result.ok).toBe(open);
      if (result.ok) expect(await operations.runner.run(sessionDescribe, result.context, {})).toMatchObject({ ok: true });
    }
    if (retained.length === 0 && open) {
      for (const result of [await operations.mint("api", presentedBearer(agentToken), null, {}),
        await operations.mint("unix", none(), null, {}), await operations.mintOffline(() => true, {})]) {
        if (!result.ok) throw new Error("expected retained context");
        retained.push(result.context);
      }
    }
    for (const context of retained) {
      expect((await operations.runner.run(sessionDescribe, context, {})).ok).toBe(open);
    }
  };
  cleanups.push(async () => { resume.resolve(); work.resolve(); await admin.dispose(); await store.closeAfterDrain(); rmSync(root, { recursive: true, force: true }); });
  return { store, operations, admin, runtime, session, started, resume, work, prepare, configure, mintHuman, otherPaths,
    currentSession, loadProvider, resolveRequest, setAvailable: (value: boolean) => { available = value; },
    setMaintenance: (value: boolean) => { maintenance = value; }, block: () => { blocked = true; } };
}

describe("production provider administration and operations composition", () => {
  it("keeps one accessor, verifier, boundary and runtime across absent/loading/ready and reversible fences", async () => {
    const staged = vi.spyOn(ProviderSessionVerifier.prototype, "stage");
    const verified = vi.spyOn(ProviderSessionVerifier.prototype, "verify");
    const current = vi.spyOn(ProviderSessionVerifier.prototype, "current");
    const f = await fixture(), c = f.operations, accessor = f.admin.operationSessionAuthority();
    const refs = { composition: c, runtime: c.runtime, api: c.boundaries.api, unix: c.boundaries.unix, eligible: c.providerSessionEligible };
    const identities = () => {
      expect(f.operations).toBe(refs.composition); expect(c.runtime).toBe(refs.runtime);
      expect(c.boundaries.api).toBe(refs.api); expect(c.boundaries.unix).toBe(refs.unix);
      expect(c.providerSessionEligible).toBe(refs.eligible); expect(f.admin.operationSessionAuthority()).toBe(accessor);
      expect(c.requestBudget).toBe(f.admin.requestBudget);
    };
    const refused = async () => {
      identities(); expect(c.providerSessionEligible()).toBe(false);
      expect(await f.mintHuman()).toMatchObject({ ok: false });
      const resolution = c.resolveSession(new Headers());
      expect(await resolution.result).toBeNull(); await resolution.settled;
    };
    await refused(); await f.otherPaths(); expect(f.loadProvider).not.toHaveBeenCalled();
    f.configure(); const prepared = f.prepare(); await f.started.promise;
    await refused(); await f.otherPaths(); expect(f.resolveRequest).not.toHaveBeenCalled();
    f.resume.resolve(); await prepared;
    identities(); expect(c.providerSessionEligible()).toBe(true);
    const resolution = c.resolveSession(new Headers());
    expect(await resolution.result).toMatchObject({ principalId: "human" }); await resolution.settled;
    const human = await f.mintHuman(); if (!human.ok) throw new Error("human refused");
    expect(await c.runner.run(sessionDescribe, human.context, {})).toMatchObject({ ok: true, value: { actor: { kind: "human" } } });
    await f.otherPaths();
    for (const fence of ["storage", "maintenance"] as const) {
      if (fence === "storage") f.setAvailable(false); else f.setMaintenance(true);
      await refused(); await f.otherPaths(fence !== "maintenance");
      expect(await c.runner.run(sessionDescribe, human.context, {})).toMatchObject({ ok: false });
      f.setAvailable(true); f.setMaintenance(false);
      identities(); expect(c.providerSessionEligible()).toBe(true);
      expect(await f.mintHuman()).toMatchObject({ ok: true }); await f.otherPaths();
    }
    // Configuration changes cannot reload this lifetime. The old resolved claim
    // never reaches staging, and retained human authority ends immediately.
    staged.mockClear(); f.configure("https://changed.example");
    await refused(); await f.otherPaths(); expect(staged).not.toHaveBeenCalled();
    expect(await c.runner.run(sessionDescribe, human.context, {})).toMatchObject({ ok: false });
    await expect(f.prepare()).rejects.toMatchObject({ code: "provider_configuration_restart_required" });
    expect(f.loadProvider).toHaveBeenCalledTimes(1);
    // All stage/verify/current calls used one verifier instance. No production
    // transition can occur between stage and verify's synchronous admission.
    const instances = [...verified.mock.contexts, ...current.mock.contexts];
    expect(instances.length).toBeGreaterThan(2);
    expect(new Set(instances).size).toBe(1);
    f.admin.stop(); await refused(); await f.otherPaths(false);
    expect(f.admin.requestBudget.acquire("completion")).toBeNull();
    await f.admin.dispose(); identities();
  });

  it("keeps failed loads failed without fencing agent, unix or offline access", async () => {
    const f = await fixture(true); f.configure();
    const prepared = f.prepare(); const outcome = prepared.catch(error => error);
    await f.started.promise; await f.otherPaths(); f.resume.resolve(); await outcome;
    expect(f.operations.providerSessionEligible()).toBe(false);
    expect(await f.mintHuman()).toMatchObject({ ok: false }); await f.otherPaths();
    await expect(f.prepare()).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(f.loadProvider).toHaveBeenCalledTimes(1);
    f.configure("https://changed.example");
    expect(await f.mintHuman()).toMatchObject({ ok: false }); await f.otherPaths();
  });

  it("refuses a disposed runtime while keeping the other paths open, then fences all on owner disposal", async () => {
    const f = await fixture(); f.configure(); const prepared = f.prepare(); await f.started.promise; f.resume.resolve(); await prepared;
    const human = await f.mintHuman(); if (!human.ok) throw new Error("human refused");
    await f.runtime.dispose();
    expect(f.operations.providerSessionEligible()).toBe(false);
    expect(await f.mintHuman()).toMatchObject({ ok: false }); await f.otherPaths();
    expect(await f.operations.runner.run(sessionDescribe, human.context, {})).toMatchObject({ ok: false });
    await f.admin.dispose(); await f.otherPaths(false);
  });

  it("passes the administration budget to the actual browser handler", async () => {
    const f = await fixture(); f.configure(); const prepared = f.prepare(); await f.started.promise; f.resume.resolve();
    const browser = await prepared;
    const slots = Array.from({ length: 16 }, () => f.operations.requestBudget.acquire("completion")!);
    const server = createServer((req, res) => { void browser.handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const status = await new Promise<number>(resolve => {
        const call = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/api/auth/session",
          headers: { Host: "fixture.example" } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
        call.end();
      });
      expect(status).toBe(503); expect(f.resolveRequest).not.toHaveBeenCalled();
      expect(f.admin.requestBudget.active).toBe(16);
    } finally {
      for (const slot of slots) { slot.responseFinished(); await slot.settle(Promise.resolve()); }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("holds resolution and the shared slot through real settlement, and shutdown joins that work", async () => {
    const f = await fixture(); f.configure(); const prepared = f.prepare(); await f.started.promise; f.resume.resolve(); await prepared;
    f.block(); const slot = f.admin.requestBudget.acquire("initiating")!;
    const signal = new AbortController(), resolution = f.operations.resolveSession(new Headers(), { signal: signal.signal });
    expect(f.resolveRequest.mock.calls[0]![1]?.signal).toBe(signal.signal);
    await resolution.result; signal.abort(); slot.responseFinished();
    const settlement = slot.settle(resolution.settled);
    const disposal = f.admin.dispose();
    expect(f.operations.providerSessionEligible()).toBe(false);
    expect(f.admin.requestBudget.active).toBe(1); expect(f.runtime.dispose).not.toHaveBeenCalled();
    await Promise.resolve(); expect(f.runtime.dispose).not.toHaveBeenCalled();
    f.work.resolve(); await settlement; await disposal;
    expect(f.runtime.dispose).toHaveBeenCalledTimes(1); expect(f.admin.requestBudget.active).toBe(0);
  });

  it("rechecks eligibility when an asynchronous resolution finishes", async () => {
    const f = await fixture(); f.configure(); const prepared = f.prepare(); await f.started.promise; f.resume.resolve(); await prepared;
    const ready = gate();
    f.resolveRequest.mockImplementation(() => ({ result: ready.promise.then(() => ({ session: f.session, principalId: "human" })), settled: ready.promise }));
    const resolution = f.operations.resolveSession(new Headers());
    f.configure("https://changed.example"); ready.resolve();
    expect(await resolution.result).toBeNull(); await resolution.settled;
    expect(await f.mintHuman()).toMatchObject({ ok: false }); await f.otherPaths();
  });
});
