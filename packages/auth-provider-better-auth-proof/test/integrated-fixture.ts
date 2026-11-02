import { expect, vi } from "vitest";
import { AuthenticationProviderError, loadAuthenticationProvider, ProviderKnowledgeApplication, type ProviderFactorLimits, type ProviderFactorOptions, type ProviderSqliteConnection } from "@/server/modules/authentication";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import type { ProofFaultInjection } from "../src/index";
import { Authenticator, Browser } from "./factor-fixture";
import { BASE_URL, IP_HEADER, loadProof, OWNER_EMAIL, OWNER_PASSWORD, PROVIDER_ENTRY, SECRET } from "./fixture";
import { PasskeyAuthenticator, type AuthenticatorInput, type CeremonyOptions } from "./passkey-authenticator";
import { strictProof } from "./strict-fixture";

export { BASE_URL, IP_HEADER, loadAuthenticationProvider, PROVIDER_ENTRY, SECRET };
export const STEP = 30_000;
/** Test integration limits, stated here so no fixture value can become a product default. */
export const LIMITS: ProviderFactorLimits = {
  totp: { attempts: 32, windowMs: 60_000 }, passkey: { attempts: 32, windowMs: 60_000 },
  ticketMs: 15_000, stagingMs: 600_000, capacity: 256, pruneBatch: 16,
};
export const factorOptions = (limits: ProviderFactorLimits = LIMITS): ProviderFactorOptions => ({ rpId: "controller.test", rpName: "Worktree Control proof", limits });
export const advance = (milliseconds: number) => { vi.setSystemTime(Date.now() + milliseconds); };

export async function integrated(faults: ProofFaultInjection = {}, limits?: ProviderFactorLimits) {
  const f = await strictProof(faults, {}, undefined, factorOptions(limits));
  const { subject } = await f.runtime.provisionLocal({ principalId: f.owner.principalId, email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD, actor: "test" });
  const identity = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store, f.runtime);
  const project = await f.run(() => f.identity.createKnowledgeProject({ name: "Granted" }, f.ownerActor));
  const knowledge = new KnowledgeService(f.store, identity);
  const app = new ProviderKnowledgeApplication(f.store.admission, identity, knowledge);
  const grant = () => f.run(() => f.identity.setKnowledgeGrant({ principalId: f.owner.principalId, projectId: project.id, permissions: ["knowledge:read"] }, f.ownerActor));
  const authenticate = (browser: Browser) => f.runtime.authenticate(new Headers({ cookie: browser.cookieHeader() }));
  const read = (actor: ProviderSessionActor) => app.execute({ operation: "tasks", input: { projectId: project.id } }, actor);
  return { ...f, storage: f.store.authenticationProviderStorage(), subject, project, knowledge, identity, app, grant, authenticate, read, browser: () => new Browser(f) };
}
export type Integrated = Awaited<ReturnType<typeof integrated>>;

/** Committed rows. Credential columns appear only as booleans or counts. */
export async function protectionState(f: Pick<Integrated, "storage">) {
  return f.storage.borrow(async () => {
    const db = f.storage.createProviderConnection();
    const rows = <T>(sql: string) => db.prepare(sql).all([]) as T[];
    try {
      return {
        policy: rows<{ generation: number; policy_revision: number; totp_selected: number; passkey_selected: number }>("SELECT generation, policy_revision, totp_selected, passkey_selected FROM authentication_account_policies")[0] ?? null,
        step: rows<{ last_step: number }>("SELECT last_step FROM authentication_totp_steps")[0]?.last_step ?? null,
        sessions: rows<{ id: string }>('SELECT "id" AS id FROM "authentication_ba_session" ORDER BY "id"').map(row => row.id),
        evidence: rows<{ method: string; generation: number; session_id: string; authenticated_at: string; original_deadline: string; attempt_id: string }>("SELECT method, generation, session_id, authenticated_at, original_deadline, attempt_id FROM authentication_session_evidence ORDER BY session_id"),
        receipts: rows<{ state: string; purpose: string }>("SELECT state, purpose FROM authentication_factor_receipts ORDER BY rowid"),
        charged: rows<{ n: number | null }>("SELECT sum(charged) n FROM authentication_factor_budgets")[0]?.n ?? 0,
        contexts: rows<{ purpose: string; used: number }>("SELECT purpose, used FROM authentication_factor_contexts ORDER BY rowid"),
        staged: rows<{ n: number }>("SELECT count(*) n FROM authentication_passkey_staged")[0]!.n,
        trusted: rows<{ n: number }>("SELECT count(*) n FROM authentication_passkey_trust")[0]!.n,
        credentials: rows<{ counter: number }>('SELECT counter FROM "authentication_ba_passkey"'),
        failed: rows<{ failed: number | null }>('SELECT "failedVerificationCount" failed FROM "authentication_ba_two_factor"')[0]?.failed ?? null,
      };
    } finally { db.close(); }
  });
}
export type ProtectionState = Awaited<ReturnType<typeof protectionState>>;

export const sql = (f: Pick<Integrated, "storage">, statement: string, parameters: readonly unknown[] = []) => f.storage.borrow(async () => {
  const db = f.storage.createProviderConnection();
  try { db.prepare(statement).run(parameters); } finally { db.close(); }
});
export const select = <T>(f: Pick<Integrated, "storage">, statement: string, parameters: readonly unknown[] = []) => f.storage.borrow(async () => {
  const db = f.storage.createProviderConnection();
  try { return db.prepare(statement).all(parameters) as T[]; } finally { db.close(); }
});

const verify = (browser: Browser, code: string, signal?: AbortSignal) => browser.post("/two-factor/verify-totp", { code }, { signal });

/** Real password session, real native enable, real authenticator code at the current step. */
export async function enrollTotp(f: Integrated, browser = f.browser()) {
  if (!browser.cookies.has("__Secure-wtc.session_token")) expect((await browser.signIn()).status).toBe(200);
  const started = await browser.post("/two-factor/enable", { password: OWNER_PASSWORD });
  expect(started.status).toBe(200);
  expect(Object.keys(started.json!).sort()).toEqual(["authorizing", "outcome", "totpURI"]);
  const authenticator = new Authenticator(started.json!.totpURI as string);
  const finished = await verify(browser, authenticator.code());
  expect(finished.status).toBe(200);
  expect(finished.json).toEqual({ outcome: "enrolled", authorizing: false });
  return { browser, authenticator };
}
export async function pendingLogin(f: Integrated, password = OWNER_PASSWORD) {
  const browser = f.browser(), result = await browser.signIn(password);
  expect(result.status).toBe(200);
  expect(result.json).toEqual({ outcome: "challenge" });
  return browser;
}
export async function totpLogin(f: Integrated, authenticator: Authenticator) {
  const browser = await pendingLogin(f);
  const result = await verify(browser, authenticator.code());
  expect(result.status).toBe(200);
  return browser;
}
export { verify };

export const passkeyOptions = async (browser: Browser, kind: "register" | "confirm" | "authenticate") => {
  const result = await browser.post(`/passkey/generate-${kind}-options`, {}, { method: "GET" });
  expect(result.status).toBe(200);
  return result.json!.options as unknown as CeremonyOptions;
};
export async function stagePasskey(f: Integrated, browser: Browser, input: AuthenticatorInput = {}, authenticator = new PasskeyAuthenticator()) {
  const registration = await browser.post("/passkey/verify-registration", { response: authenticator.register(await passkeyOptions(browser, "register"), { attestationNone: true, ...input }) });
  expect(registration.status).toBe(200);
  expect(registration.json).toEqual({ outcome: "staged", authorizing: false });
  return authenticator;
}
export async function enrollPasskey(f: Integrated, browser: Browser) {
  const authenticator = await stagePasskey(f, browser);
  const result = await browser.post("/passkey/verify-confirmation", { response: authenticator.assert(await passkeyOptions(browser, "confirm"), { counter: 0 }) });
  expect(result.status).toBe(200);
  expect(result.json).toEqual({ outcome: "enrolled", authorizing: false });
  return authenticator;
}
export async function passkeyLogin(f: Integrated, authenticator: PasskeyAuthenticator, input: AuthenticatorInput = {}) {
  const browser = f.browser(), options = await passkeyOptions(browser, "authenticate");
  const result = await browser.post("/passkey/verify-authentication", { response: authenticator.assert(options, input) });
  return { browser, result };
}

/** A deterministic FIFO fence on the sole connection, like a queued core wait. */
export async function fence(f: Integrated, mutation: (connection: ProviderSqliteConnection) => void) {
  const connection = f.storage.createProviderConnection();
  let opened!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { opened = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const pending = f.storage.borrow(async () => {
    connection.prepare("BEGIN IMMEDIATE").run([]);
    mutation(connection);
    opened(); await released;
    connection.prepare("COMMIT").run([]);
  }).finally(() => connection.close());
  await entered;
  return { release, pending };
}

export const refusedWithoutCookies = (result: { status: number; setCookie: string[] }) => {
  expect(result.status).toBeGreaterThanOrEqual(400);
  expect(result.setCookie.filter(line => !/max-age=0/i.test(line))).toEqual([]);
};
export const invalidCredential = (pending: Promise<unknown>) => expect(pending).rejects.toMatchObject({ code: "invalid_credential" });
export { AuthenticationProviderError, SqliteStateStore, loadProof };
