import { randomUUID } from "node:crypto";
import { isTotpCode, observeTotpStep, readNativeTotpSecret } from "./totp-step";
import { refusal, type FactorStage, type ProofFaultInjection } from "./library";
import type {
  ProviderAccountProtection,
  ProviderFactorPurpose,
  ProviderFactorTicket,
  ProviderSqliteConnection,
} from "../../../src/server/modules/authentication/provider-contract";

export const COOKIE = {
  session: "__Secure-wtc.session_token",
  challenge: "__Secure-wtc.two_factor",
  trust: "__Secure-wtc.trust_device",
  passkey: "__Secure-wtc.passkey_challenge",
} as const;

export const fixed = (status: number, body: Record<string, unknown>, cookies: readonly string[] = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const line of cookies) headers.append("set-cookie", line);
  return new Response(JSON.stringify(body), { status, headers });
};
export const denied = (status: number, reason: string, cookies: readonly string[] = []) => fixed(status, { outcome: "denied", reason }, cookies);
/** Thrown inside a transaction: its response is released only after the rollback. */
export class Rollback extends Error {
  constructor(readonly response: Response) { super("rollback"); }
}

export const isDeletion = (line: string) => /max-age=0/i.test(line) || /^[^=]+=;/.test(line);
const expiredSession = `${COOKIE.session}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
export const issuedCookie = (lines: readonly string[], name: string) => {
  // Native may refresh the old cookie before replacing its session. Match the
  // browser's final value, including a final deletion, not the earlier refresh.
  const line = lines.findLast(value => value.startsWith(`${name}=`));
  return line && !isDeletion(line) ? line.split(";")[0]?.slice(name.length + 1) : undefined;
};
/** Signed cookie values are `value.signature`; only the library verifies the signature. */
export const signedValue = (raw: string) => decodeURIComponent(raw).split(".")[0]!;
/** Duplicates are refused rather than resolved: a second value is never a choice to make here. */
export function parseCookies(header: string | null): Map<string, string> | null {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name)) return null;
    cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

type Kind = "enable" | "verify-totp" | "register-options" | "registration" | "confirm-options" | "confirmation" | "authenticate-options" | "authentication";
interface Route { kind: Kind; method: "GET" | "POST"; fields: readonly string[] }
/**
 * The closed factor surface. Recovery codes, removal, replacement, reauthentication
 * and every other native two-factor or passkey route stay unreachable until each
 * has an accepted management decision.
 */
export const FACTOR_ROUTES = new Map<string, Route>([
  ["/two-factor/enable", { kind: "enable", method: "POST", fields: ["password"] }],
  ["/two-factor/verify-totp", { kind: "verify-totp", method: "POST", fields: ["code"] }],
  ["/passkey/generate-register-options", { kind: "register-options", method: "GET", fields: [] }],
  ["/passkey/verify-registration", { kind: "registration", method: "POST", fields: ["response"] }],
  ["/passkey/generate-confirm-options", { kind: "confirm-options", method: "GET", fields: [] }],
  ["/passkey/verify-confirmation", { kind: "confirmation", method: "POST", fields: ["response"] }],
  ["/passkey/generate-authenticate-options", { kind: "authenticate-options", method: "GET", fields: [] }],
  ["/passkey/verify-authentication", { kind: "authentication", method: "POST", fields: ["response"] }],
]);
const NATIVE_PATH: Record<Kind, string> = {
  enable: "/two-factor/enable", "verify-totp": "/two-factor/verify-totp", "register-options": "/passkey/generate-register-options",
  registration: "/passkey/verify-registration", "confirm-options": "/passkey/generate-authenticate-options", confirmation: "/passkey/verify-authentication",
  "authenticate-options": "/passkey/generate-authenticate-options", authentication: "/passkey/verify-authentication",
};
const MAX_BODY = 32_768;
const MAX_NATIVE_RESPONSE = 65_536;
/** A wrong code writes native failure counters. Those are the only native failure kept. */
const ACCOUNTED_FAILURES = new Set(["INVALID_CODE", "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"]);

/** Everything a library hook needs to reach the running ceremony. */
export interface CeremonyOperation {
  signal: AbortSignal;
  ticket?: ProviderFactorTicket;
  subject?: string;
  origin?: { authenticatedAt: string; originalDeadline: string };
  startedAt?: number;
  verified?: boolean;
}
interface NativeSession { session: { id: string; token: string }; user: { id: string } }
type SessionQuery = { headers: Headers; query: { disableCookieCache: true; disableRefresh: true } };
/** The narrow structural view of a scoped auth instance that a ceremony uses. */
export interface ScopedLibrary {
  handler(request: Request): Promise<Response>;
  api: { getSession(input: SessionQuery): Promise<NativeSession | null> };
  $context: Promise<{
    secretConfig: Parameters<typeof readNativeTotpSecret>[0];
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ id: string; value: string; expiresAt: Date } | null>;
      deleteUserSessions(subject: string): Promise<void>;
    };
  }>;
}
export interface CeremonyHost {
  protection: ProviderAccountProtection;
  baseURL: string;
  clientIpHeader: string;
  connection(): ProviderSqliteConnection;
  faults(): ProofFaultInjection | undefined;
  transactionOpen(): boolean;
  root(): ScopedLibrary;
  /** One short committed transaction on the same borrow, for the attempt charge. */
  commit<T>(work: () => T): Promise<T>;
  atomic(input: { attemptId: string; ticket?: ProviderFactorTicket; work: (scoped: ScopedLibrary) => Promise<Response> }): Promise<Response>;
  withOperation<T>(operation: CeremonyOperation, work: () => Promise<T>): Promise<T>;
}

const sessionQuery = (cookie: string): SessionQuery => ({ headers: new Headers({ cookie }), query: { disableCookieCache: true, disableRefresh: true } });

/** Admission, native verification and settlement for every supported factor route. */
export class FactorCeremonies {
  constructor(private readonly host: CeremonyHost) {}

  async handle(route: Route, request: Request): Promise<Response> {
    const base = new URL(this.host.baseURL);
    if (request.headers.get("origin") !== base.origin) return denied(403, "origin_refused");
    if (!this.host.protection.enabled) return denied(404, "not_found");
    const text = request.method === "GET" ? "" : await request.text();
    if (text.length > MAX_BODY) return denied(413, "invalid_body");
    let input: Record<string, unknown> = {};
    if (request.method !== "GET") {
      try { input = JSON.parse(text) as Record<string, unknown>; } catch { return denied(400, "invalid_body"); }
      if (typeof input !== "object" || input === null || Array.isArray(input)) return denied(400, "invalid_body");
    }
    if (Object.keys(input).sort().join() !== [...route.fields].sort().join()) return denied(400, "invalid_fields");
    const cookies = parseCookies(request.headers.get("cookie"));
    if (!cookies) return denied(400, "ambiguous_cookies");
    switch (route.kind) {
      case "enable": return typeof input.password === "string" ? this.#enable(request, cookies, input.password) : denied(400, "invalid_fields");
      case "verify-totp": return typeof input.code === "string" && isTotpCode(input.code) ? this.#verifyTotp(request, cookies, input.code) : denied(400, "invalid_code_format");
      case "register-options": case "confirm-options": case "authenticate-options": return this.#options(route.kind, request, cookies);
      default: return this.#completion(route.kind, request, cookies, input);
    }
  }

  /** Forwards one fixed native request: chosen cookie, no trust cookie, no caller-selected body field. */
  #native(kind: Kind, request: Request, cookies: string | undefined, body?: unknown): Request {
    const headers = new Headers({ origin: new URL(this.host.baseURL).origin });
    const peer = request.headers.get(this.host.clientIpHeader);
    if (peer) headers.set(this.host.clientIpHeader, peer);
    if (cookies) headers.set("cookie", cookies);
    if (body !== undefined) headers.set("content-type", "application/json");
    return new Request(`${this.host.baseURL}${NATIVE_PATH[kind]}`, { method: body === undefined ? "GET" : "POST", headers, signal: request.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  async #pause(stage: FactorStage): Promise<void> { await this.host.faults()?.factorPause?.(stage, this.host.connection()); }
  #clock(sample: "start" | "finish"): number { return this.host.faults()?.observationClock?.(sample) ?? Date.now(); }
  #live(signal: AbortSignal): void { if (signal.aborted) throw new Rollback(denied(409, "cancelled")); }

  /** Called by the library's before-hook at actual native entry, after the charge committed. */
  async beforeNative(operation: CeremonyOperation, path: string): Promise<void> {
    if (!operation.ticket || !["/two-factor/verify-totp", "/passkey/verify-registration", "/passkey/verify-authentication"].includes(path)) return;
    await this.#pause("native-entry");
    if (operation.signal.aborted || !this.host.protection.usable(operation.ticket, Date.now())) throw refusal();
    if (path === "/two-factor/verify-totp") {
      operation.startedAt = this.#clock("start");
      await this.#pause("verification-start");
    }
  }
  registered(operation: CeremonyOperation | undefined, input: { verified: boolean; subject: string }): void {
    if (!input.verified || !operation?.ticket || operation.ticket.subject !== input.subject || !this.host.protection.usable(operation.ticket, Date.now())) throw refusal();
    operation.verified = true;
  }
  /** Native checks the signature. This binds its credential and user handle and requires signed UV. */
  authenticated(operation: CeremonyOperation | undefined, input: { userVerified: boolean; credential: string; userHandle: string | null | undefined }): void {
    if (!input.userVerified || !operation?.ticket || !this.host.protection.passkeyAcceptable(operation.ticket, input.credential, input.userHandle, Date.now())) throw refusal();
    operation.verified = true;
  }

  /** Commits the charge before any native evaluation, then rechecks it outside the transaction. */
  async #admit(opaque: string, purpose: ProviderFactorPurpose, attemptId: string, credential: string | null, signal: AbortSignal): Promise<ProviderFactorTicket | Response> {
    const { protection } = this.host;
    if (signal.aborted) return denied(409, "cancelled_before_admission");
    let ticket: ProviderFactorTicket | null;
    try {
      ticket = await this.host.commit(() => protection.admit({ opaque, purpose, attemptId, credential, now: Date.now() }));
    } catch {
      // Includes an error after real COMMIT. Reconcile, but never evaluate on this call.
      if (this.host.transactionOpen()) return fixed(503, { outcome: "outcome_unconfirmed" });
      const charged = protection.outcome(attemptId) !== null;
      if (charged) protection.fail(attemptId);
      return fixed(503, { outcome: "admission_error", charged, committed: charged });
    }
    if (!ticket) return denied(429, "admission_denied");
    if (this.host.transactionOpen() || protection.outcome(attemptId) !== "charged") return denied(503, "charge_unconfirmed");
    await this.#pause("after-admission");
    if (signal.aborted || !protection.usable(ticket, Date.now())) { protection.fail(attemptId); return denied(409, "cancelled_or_expired"); }
    return ticket;
  }

  async #enable(request: Request, cookies: Map<string, string>, password: string): Promise<Response> {
    const session = cookies.get(COOKIE.session);
    if (!session) return denied(401, "unauthenticated");
    const cookie = `${COOKIE.session}=${session}`, { protection } = this.host;
    return this.host.atomic({ attemptId: randomUUID(), work: async scoped => {
      const current = await scoped.api.getSession(sessionQuery(cookie));
      if (!current || !protection.currentEvidence(current.session.id, Date.now())) throw new Rollback(denied(401, "session_refused"));
      const native = await scoped.handler(this.#native("enable", request, cookie, { password, method: "totp" }));
      this.#live(request.signal);
      if (!native.ok) throw new Rollback(denied(native.status, "native_failure"));
      const parsed = await native.json() as { totpURI?: unknown };
      if (typeof parsed.totpURI !== "string" || !protection.issueTotpEnrollment({ opaque: session, sessionId: current.session.id, subject: current.user.id, now: Date.now() })) throw new Rollback(denied(409, "enrollment_refused"));
      await this.#pause("before-commit");
      this.#live(request.signal);
      return fixed(200, { outcome: "enrollment", totpURI: parsed.totpURI, authorizing: false });
    } });
  }

  async #verifyTotp(request: Request, cookies: Map<string, string>, code: string): Promise<Response> {
    const session = cookies.get(COOKIE.session), challenge = cookies.get(COOKIE.challenge), { protection } = this.host;
    if (session && challenge) return denied(400, "ambiguous_cookies");
    if (!session && !challenge) return denied(401, "unauthenticated");
    const purpose = challenge ? "totp_login" : "totp_enrollment", opaque = (challenge ?? session)!;
    const known = protection.contextSubject(opaque, purpose, Date.now());
    if (!known) return denied(401, "context_unavailable");
    const cookie = challenge ? `${COOKIE.challenge}=${challenge}` : `${COOKIE.session}=${session}`;
    if (session) {
      const current = await this.host.root().api.getSession(sessionQuery(cookie));
      if (!current || current.session.id !== known.sessionId) return denied(401, "context_unavailable");
    }
    const attemptId = randomUUID();
    const ticket = await this.#admit(opaque, purpose, attemptId, null, request.signal);
    if (ticket instanceof Response) return ticket;
    const operation: CeremonyOperation = { signal: request.signal, ticket };
    return this.host.atomic({ attemptId, ticket, work: scoped => this.host.withOperation(operation, async () => {
      const native = await scoped.handler(this.#native("verify-totp", request, cookie, { code, trustDevice: false }));
      const finishedAt = this.#clock("finish");
      await this.#pause("after-native");
      this.#live(request.signal);
      const lines = native.headers.getSetCookie();
      if (!native.ok) {
        const failure = await native.clone().json().catch(() => null) as { code?: unknown } | null;
        if (typeof failure?.code !== "string" || !ACCOUNTED_FAILURES.has(failure.code)) throw new Rollback(denied(native.status, "native_failure"));
        protection.fail(attemptId);
        return denied(native.status, "invalid_code", lines.filter(isDeletion));
      }
      if (lines.some(line => line.startsWith(`${COOKIE.trust}=`) && !isDeletion(line))) throw new Rollback(denied(500, "trust_cookie_refused"));
      const issued = issuedCookie(lines, COOKIE.session);
      const current = issued && await scoped.api.getSession(sessionQuery(`${COOKIE.session}=${issued}`));
      if (!current || current.user.id !== ticket.subject) throw new Rollback(denied(500, "session_unconfirmed"));
      const step = await this.#observe(scoped, ticket.subject, code, operation.startedAt, finishedAt, request.signal);
      try {
        if (purpose === "totp_login") protection.settleTotpLogin(ticket, current.session.id, step, Date.now());
        else protection.settleTotpEnrollment(ticket, step, Date.now());
      } catch (error) {
        if (error instanceof Error && error.name === "ProviderStaleStepError") throw new Rollback(denied(409, "presentation_refused"));
        throw error;
      }
      if (purpose === "totp_enrollment") {
        // Selection replaces every prior session. Enrollment never upgrades one and mints none.
        await (await scoped.$context).internalAdapter.deleteUserSessions(ticket.subject);
        await this.#beforeCommit(request.signal);
        return fixed(200, { outcome: "enrolled", authorizing: false }, [expiredSession]);
      }
      this.#confirm(current.session.id);
      await this.#beforeCommit(request.signal);
      this.#confirm(current.session.id);
      return fixed(200, { outcome: "session", method: "password_totp" }, lines.filter(line => line.startsWith(`${COOKIE.session}=`) && !isDeletion(line)));
    }) });
  }

  /**
   * Native success is already in hand. The observer and the guarded step update
   * can only refuse it. The witness is a strictly newer policy observation in a
   * bounded interval, not proof of the counter native matched.
   */
  async #observe(scoped: ScopedLibrary, subject: string, code: string, startedAt: number | undefined, finishedAt: number, signal: AbortSignal): Promise<number> {
    const refused = () => new Rollback(denied(409, "presentation_refused"));
    const [row] = this.host.connection().prepare('SELECT "secret" AS secret FROM "authentication_ba_two_factor" WHERE "userId" = ?').all([subject]) as Array<{ secret: string }>;
    if (!row || startedAt === undefined) throw refused();
    const { secretConfig } = await scoped.$context;
    const observation = await readNativeTotpSecret(secretConfig, row.secret)
      .then(async secret => (await Promise.all([observeTotpStep({ secret, code, startedAt, finishedAt }), this.#pause("observer-pending")]))[0])
      .catch(() => ({ ok: false as const }));
    this.#live(signal);
    if (!observation.ok) throw refused();
    return observation.step;
  }

  /** The login evidence just written must authorize now; a concurrent change rolls everything back. */
  #confirm(sessionId: string): void {
    if (!this.host.protection.currentEvidence(sessionId, Date.now())) throw new Rollback(denied(409, "cancelled_or_expired"));
  }
  async #beforeCommit(signal: AbortSignal): Promise<void> {
    this.#live(signal);
    await this.#pause("before-commit");
    this.#live(signal);
  }

  async #options(kind: "register-options" | "confirm-options" | "authenticate-options", request: Request, cookies: Map<string, string>): Promise<Response> {
    const { protection } = this.host, session = cookies.get(COOKIE.session), source = cookies.get(COOKIE.passkey);
    const needsSession = kind !== "authenticate-options";
    if (needsSession && !session) return denied(401, "unauthenticated");
    if (kind === "confirm-options" && !source) return denied(401, "context_unavailable");
    const sessionCookie = `${COOKIE.session}=${session}`;
    const nativeCookie = kind === "register-options" ? sessionCookie : undefined;
    const operation: CeremonyOperation = { signal: request.signal };
    return this.host.atomic({ attemptId: randomUUID(), work: scoped => this.host.withOperation(operation, async () => {
      const current = needsSession ? await scoped.api.getSession(sessionQuery(sessionCookie)) : null;
      if (needsSession && (!current || !protection.currentEvidence(current.session.id, Date.now()))) throw new Rollback(denied(401, "session_refused"));
      const native = await scoped.handler(this.#native(kind, request, nativeCookie));
      await this.#pause("after-native");
      this.#live(request.signal);
      if (!native.ok) throw new Rollback(denied(native.status, "native_failure"));
      const raw = await native.text();
      if (raw.length > MAX_NATIVE_RESPONSE) throw new Rollback(denied(500, "invalid_native_response"));
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const lines = native.headers.getSetCookie(), opaque = issuedCookie(lines, COOKIE.passkey);
      const pending = opaque && await (await scoped.$context).internalAdapter.findVerificationValue(signedValue(opaque));
      if (!opaque || !pending) throw new Rollback(denied(500, "challenge_unconfirmed"));
      const issued = JSON.parse(pending.value) as { type: string; expectedChallenge: string; userData: { id: string } };
      const expected = kind === "register-options" ? "registration" : "authentication";
      if (issued.type !== expected || issued.expectedChallenge !== parsed.challenge) throw new Rollback(denied(500, "challenge_unconfirmed"));
      const nativeDeadline = new Date(pending.expiresAt).getTime(), now = Date.now(), target = { opaque, nativeId: pending.id, nativeDeadline, now };
      if (kind === "register-options") {
        const handle = (parsed.user as { id?: unknown } | undefined)?.id;
        if (typeof handle !== "string" || issued.userData.id !== current!.user.id
          || !protection.issuePasskeyRegistration({ ...target, sessionId: current!.session.id, subject: current!.user.id, handle })) throw new Rollback(denied(409, "enrollment_refused"));
        parsed.attestation = "none"; // Privacy-preserving default. Every format still needs signed UV confirmation.
      } else if (kind === "confirm-options") {
        const credential = protection.issuePasskeyConfirmation({ ...target, source: source!, sessionId: current!.session.id, subject: current!.user.id });
        if (!credential) throw new Rollback(denied(409, "enrollment_refused"));
        parsed.allowCredentials = [{ id: credential, type: "public-key" }];
        parsed.userVerification = "required";
      } else {
        if (!protection.issuePasskeyAuthentication(target)) throw new Rollback(denied(503, "capacity"));
        // Native authentication hard-codes preferred. Completion independently requires signed UV.
        parsed.userVerification = "required";
      }
      await this.#beforeCommit(request.signal);
      return fixed(200, { outcome: "options", options: parsed }, lines.filter(line => line.startsWith(`${COOKIE.passkey}=`)));
    }) });
  }

  async #completion(kind: "registration" | "confirmation" | "authentication", request: Request, cookies: Map<string, string>, input: Record<string, unknown>): Promise<Response> {
    const { protection } = this.host, opaque = cookies.get(COOKIE.passkey), session = cookies.get(COOKIE.session);
    const response = input.response as { id?: unknown } | null;
    if (!opaque || !response || typeof response !== "object") return denied(opaque ? 400 : 401, opaque ? "invalid_fields" : "context_unavailable");
    const purpose = kind === "registration" ? "passkey_registration" : kind === "confirmation" ? "passkey_confirmation" : "passkey_authentication";
    const known = protection.contextSubject(opaque, purpose, Date.now());
    if (!known) return denied(403, "context_unavailable");
    const credential = kind === "registration" ? null : typeof response.id === "string" ? response.id : undefined;
    if (credential === undefined) return denied(400, "invalid_fields");
    const sessionCookie = `${COOKIE.session}=${session}`, passkeyCookie = `${COOKIE.passkey}=${opaque}`;
    if (kind !== "authentication") {
      const current = session ? await this.host.root().api.getSession(sessionQuery(sessionCookie)) : null;
      if (!current || current.user.id !== known.subject || current.session.id !== known.sessionId) return denied(403, "context_unavailable");
    }
    const attemptId = randomUUID();
    const ticket = await this.#admit(opaque, purpose, attemptId, credential, request.signal);
    if (ticket instanceof Response) return ticket;
    const operation: CeremonyOperation = { signal: request.signal, ticket };
    // A registration needs its session. A confirmation must prove the credential, not the session.
    const nativeCookie = kind === "registration" ? `${sessionCookie}; ${passkeyCookie}` : passkeyCookie;
    return this.host.atomic({ attemptId, ticket, work: scoped => this.host.withOperation(operation, async () => {
      if (request.signal.aborted || !protection.usable(ticket, Date.now())) throw new Rollback(denied(409, "cancelled_or_expired"));
      const native = await scoped.handler(this.#native(kind, request, nativeCookie, { response }));
      await this.#pause("after-native");
      this.#live(request.signal);
      if (!native.ok) throw new Rollback(denied(native.status, "native_failure"));
      if (!operation.verified) throw new Rollback(denied(500, "verification_unconfirmed"));
      const raw = await native.text();
      if (raw.length > MAX_NATIVE_RESPONSE) throw new Rollback(denied(500, "invalid_native_response"));
      const lines = native.headers.getSetCookie();
      if (lines.some(line => line.startsWith(`${COOKIE.trust}=`) && !isDeletion(line))) throw new Rollback(denied(500, "trust_cookie_refused"));
      if (kind === "registration") {
        const parsed = JSON.parse(raw) as { userId?: unknown; credentialID?: unknown };
        if (parsed.userId !== ticket.subject || typeof parsed.credentialID !== "string") throw new Rollback(denied(500, "registration_unconfirmed"));
        protection.stagePasskey(ticket, parsed.credentialID, Date.now());
        await this.#beforeCommit(request.signal);
        return fixed(200, { outcome: "staged", authorizing: false });
      }
      const issued = issuedCookie(lines, COOKIE.session);
      const current = issued && await scoped.api.getSession(sessionQuery(`${COOKIE.session}=${issued}`));
      if (!current || current.user.id !== ticket.subject) throw new Rollback(denied(500, "session_unconfirmed"));
      if (kind === "confirmation") {
        // Native always creates a session here. Selection removes it with every prior one.
        protection.promotePasskey(ticket, Date.now());
        await (await scoped.$context).internalAdapter.deleteUserSessions(ticket.subject);
        await this.#beforeCommit(request.signal);
        return fixed(200, { outcome: "enrolled", authorizing: false }, [expiredSession]);
      }
      protection.settlePasskeyLogin(ticket, current.session.id, Date.now());
      this.#confirm(current.session.id);
      await this.#beforeCommit(request.signal);
      this.#confirm(current.session.id);
      return fixed(200, { outcome: "session", method: "passkey_uv" }, lines.filter(line => line.startsWith(`${COOKIE.session}=`) && !isDeletion(line)));
    }) });
  }
}
