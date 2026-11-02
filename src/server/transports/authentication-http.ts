import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { containsProviderCookie, browserChangePasswordSchema, browserFactorSchemas, browserSignInSchema, browserSignOutSchema, browserTotpEnableSchema, browserTotpVerifySchema, type BrowserAuthenticationStatus } from "@/shared/contracts/authentication";
import { IdentityError, type ProviderSessionActor } from "@/server/modules/identity";
import { knowledgeFailure } from "@/server/modules/knowledge";
import { admitWithRetry, databaseAdmissionFailure, type DatabaseAdmission } from "@/server/database-admission";
import { AuthenticationProviderError, BROWSER_OPERATIONS, browserOperationRequires, type AuthenticationProviderRuntime, type BrowserOperation, type BrowserRelease, type ProviderKnowledgeApplication } from "@/server/modules/authentication";
import {
  approvedAuthenticationCookies, BoundaryError, CHALLENGE_COOKIE, COOKIE_POLICY, deletionCookie, fail, parseStrictJson, PASSKEY_COOKIE, readBoundedBody, requestCookies, SESSION_COOKIE,
  validateTransportLimits, type AuthenticationTransportLimits,
} from "./authentication-http-boundary";

export { approvedAuthenticationCookies, type AuthenticationTransportLimits } from "./authentication-http-boundary";

const ROUTES = new Map(Object.entries(BROWSER_OPERATIONS).map(([operation, definition]) => [`/api/auth${definition.path}`, operation as BrowserOperation]));
/** The headers whose repetition could otherwise change what a single value means. */
const SINGLE_HEADERS = ["host", "origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "content-type", "content-length", "content-encoding", "transfer-encoding"] as const;
/** Parsed after the body, inside no admission. Each returns the exact native body. */
type BodyParsers = Record<BrowserOperation, (input: unknown) => unknown>;
/** A closed response is cancellation. A request closing after its whole body is not. */
class RequestLifetime {
  readonly #controller = new AbortController();
  #finished = false;
  constructor(private readonly request: IncomingMessage, private readonly response: ServerResponse, private readonly finished: () => void) {
    request.once("aborted", this.#cancel); request.once("error", this.#cancel);
    response.once("finish", this.#done); response.once("close", this.#closed);
  }
  get signal(): AbortSignal { return this.#controller.signal; }
  get open(): boolean { return !this.#controller.signal.aborted && !this.response.destroyed && !this.response.writableEnded; }
  #cancel = () => { this.#controller.abort(); };
  #closed = () => { if (!this.response.writableFinished) this.#cancel(); this.#done(); };
  #done = () => {
    if (this.#finished) return;
    this.#finished = true;
    this.response.off("finish", this.#done); this.response.off("close", this.#closed);
    this.finished();
  };
  /** The request is finished with. Response listeners stay until the response closes. */
  detachRequest(): void { this.request.off("aborted", this.#cancel); this.request.off("error", this.#cancel); }
}

export function hasProviderCookie(request: IncomingMessage): boolean {
  return containsProviderCookie(request.headers.cookie);
}
export function authenticationJson(response: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.writeHead(status).end(JSON.stringify(body));
}

/** Explicit HTTPS boundary. Mounting this adapter does not select or enable a product mode. */
export class AuthenticationHttp {
  readonly #origin: string;
  readonly #authority: string;
  readonly #limits: AuthenticationTransportLimits;
  readonly #maxInFlight: number;
  readonly #parsers: BodyParsers;
  #active = 0;
  constructor(private readonly deps: {
    origin: string;
    runtime: AuthenticationProviderRuntime;
    admission: DatabaseAdmission;
    knowledge: ProviderKnowledgeApplication;
    status(): BrowserAuthenticationStatus;
    maintenance?(): boolean;
    /** Finite proof fixtures only; production derives peer exclusively from socket.remoteAddress. */
    trustedFixturePeer?: string;
    maxInFlight?: number;
    limits: AuthenticationTransportLimits;
  }) {
    const origin = new URL(deps.origin);
    if (origin.protocol !== "https:" || origin.origin !== deps.origin || origin.username || origin.password) throw new Error("Authentication requires a canonical HTTPS origin.");
    this.#maxInFlight = deps.maxInFlight ?? 8;
    if (!Number.isInteger(this.#maxInFlight) || this.#maxInFlight < 1 || this.#maxInFlight > 64) throw new Error("Invalid authentication capacity.");
    if (deps.trustedFixturePeer && !isIP(deps.trustedFixturePeer)) throw new Error("Invalid fixture peer.");
    this.#limits = validateTransportLimits(deps.limits, this.#maxInFlight);
    this.#origin = origin.origin; this.#authority = origin.host;
    this.#parsers = this.parsers();
  }

  private parsers(): BodyParsers {
    const bounds = this.deps.runtime.webAuthnBounds, schemas = bounds && browserFactorSchemas(bounds);
    const strict = (schema: { safeParse(input: unknown): { success: boolean; data?: unknown } } | undefined) => (input: unknown) => {
      const parsed = schema?.safeParse(input);
      if (!parsed?.success) fail(400, "invalid_request");
      return parsed.data;
    };
    const none = () => undefined;
    return {
      "sign-in": strict(browserSignInSchema), session: none,
      "sign-out": input => { strict(browserSignOutSchema)(input); return {}; },
      password: input => ({ ...strict(browserChangePasswordSchema)(input) as object, revokeOtherSessions: true }),
      "totp-enable": strict(browserTotpEnableSchema), "totp-verify": strict(browserTotpVerifySchema),
      "passkey-register-options": none, "passkey-registration": strict(schemas?.registration),
      "passkey-confirm-options": none, "passkey-confirmation": strict(schemas?.assertion),
      "passkey-authenticate-options": none, "passkey-authentication": strict(schemas?.assertion),
    };
  }

  /** Runs before blanket core admission. All body reads and provider work remain outside it. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const path = request.url ?? "";
    const cookie = hasProviderCookie(request);
    if (!path.includes("auth") && !cookie) return false;
    // The slot is held until the response closed AND real provider work ended.
    let counted = false, operationFinished = false, responseFinished = response.writableFinished || response.destroyed;
    const release = () => {
      if (counted && operationFinished && responseFinished) { counted = false; this.#active--; }
    };
    const lifetime = new RequestLifetime(request, response, () => { responseFinished = true; release(); });
    const started: Array<Promise<void>> = [];
    let unreleased: BrowserRelease | null = null, knowledge = false;
    try {
      this.boundary(request);
      if (this.deps.maintenance?.()) fail(503, "database_unavailable");
      if (path === "/api/auth/status" && request.method === "GET") {
        authenticationJson(response, 200, this.deps.status()); return true;
      }
      knowledge = path === "/api/knowledge" && cookie;
      const routed = ROUTES.get(path);
      // A closed factor route is the same generic denial as an unknown one.
      const operation = routed && (!browserOperationRequires(routed, "factor") || this.deps.runtime.factorsEnabled) ? routed : undefined;
      if (!operation && !knowledge) fail(401, "invalid_credential");
      if (request.method !== (knowledge ? "POST" : BROWSER_OPERATIONS[operation!].method)) fail(405, "method_not_allowed");
      const reserved = operation && browserOperationRequires(operation, "initiating") ? this.#limits.reservedCompletionSlots : 0;
      if (this.#active >= this.#maxInFlight - reserved) fail(503, "database_busy");
      this.#active++; counted = true;
      const cookies = requestCookies(request.headers.cookie);
      if (request.method === "POST" || (operation && browserOperationRequires(operation, "factor"))) {
        if (request.headers.origin !== this.#origin) fail(403, "origin_forbidden");
      }
      const nativeHeaders = this.headers(request);
      let input: unknown;
      if (request.method === "POST") {
        if (request.headers["content-type"] !== "application/json") fail(400, "invalid_request");
        const limit = knowledge ? this.#limits.knowledgeBodyBytes : operation!.startsWith("passkey-") ? this.#limits.webAuthnBodyBytes : this.#limits.passwordBodyBytes;
        const text = await readBoundedBody(request, { limit, timeoutMs: this.#limits.bodyTimeoutMs, signal: lifetime.signal });
        input = parseStrictJson(text, knowledge ? this.#limits.knowledgeJson : this.#limits.json);
      }
      lifetime.detachRequest();
      if (this.deps.maintenance?.()) fail(503, "database_unavailable");
      if (knowledge) {
        const cookieHeader = cookies.get(SESSION_COOKIE);
        if (cookieHeader !== undefined) nativeHeaders.set("cookie", `${SESSION_COOKIE}=${cookieHeader}`);
        const authenticated = this.deps.runtime.authenticateRequest(nativeHeaders, { signal: lifetime.signal });
        started.push(authenticated.settled);
        const actor = await authenticated.result;
        if (!actor) fail(401, "invalid_credential");
        await this.deps.admission.run(() => {
          if (this.deps.maintenance?.()) fail(503, "database_unavailable");
          if (!lifetime.open) return;
          let result: unknown;
          try { result = this.deps.knowledge.executeAdmitted(input, actor); }
          catch (error) {
            if (databaseAdmissionFailure(error)) throw error;
            const failure = knowledgeFailure(error);
            authenticationJson(response, failure.status, failure.body);
            return;
          }
          authenticationJson(response, 200, result);
        }, { signal: lifetime.signal }); return true;
      }
      const browser = operation!;
      const policy = COOKIE_POLICY[browser];
      if (policy.require.some(name => !cookies.has(name))) fail(401, "authentication_failed");
      if (browser === "totp-verify") {
        if (cookies.has(SESSION_COOKIE) && cookies.has(CHALLENGE_COOKIE)) fail(400, "invalid_request");
        if (!cookies.has(SESSION_COOKIE) && !cookies.has(CHALLENGE_COOKIE)) fail(401, "authentication_failed");
      }
      const body = this.#parsers[browser](input);
      nativeHeaders.delete("cookie");
      const forwarded = policy.forward.flatMap(name => (cookies.has(name) ? [`${name}=${cookies.get(name)!}`] : []));
      if (forwarded.length) nativeHeaders.set("cookie", forwarded.join("; "));
      let actor: ProviderSessionActor | null = null;
      if (browserOperationRequires(browser, "actor") || (browser === "totp-verify" && cookies.has(SESSION_COOKIE))) {
        const authenticated = this.deps.runtime.authenticateRequest(nativeHeaders, { signal: lifetime.signal });
        started.push(authenticated.settled);
        actor = await authenticated.result;
        if (!actor) fail(401, "authentication_failed");
      }
      const native = new Request(`${this.#origin}${path}`, { method: request.method, headers: nativeHeaders, signal: lifetime.signal,
        ...(request.method === "POST" ? { body: JSON.stringify(body) } : {}) });
      const execution = this.deps.runtime.browser(browser, native, { actor, signal: lifetime.signal });
      started.push(execution.settled);
      const result = await execution.result;
      unreleased = result;
      const lines = this.cookies(browser, result, cookies);
      // Last current-authority check, durable publication marker and response release form one
      // synchronous admitted completion phase, using reserved queue room for accepted work.
      // Nothing awaits between them, and a marked session stays marked
      // whatever happens to this response. No client acknowledgment exists or is implied.
      await admitWithRetry(this.deps.admission, () => {
        if (this.deps.maintenance?.()) fail(503, "database_unavailable");
        if (!lifetime.open) fail(499, "client_closed");
        const safe = this.deps.runtime.finishBrowserRelease(result);
        authenticationJson(response, 200, safe, lines);
        unreleased = null;
      }, { signal: lifetime.signal, reserved: true });
    } catch (error) {
      await this.failed(error, unreleased, knowledge, response, lifetime, started);
    } finally {
      lifetime.detachRequest();
      // No Promise.race: a timed-out borrow's execution keeps this slot until it really ends.
      await Promise.all(started);
      operationFinished = true; release();
    }
    return true;
  }

  /** Validates the whole set first, then adds the explicit deletions of stale state. */
  private cookies(operation: BrowserOperation, result: BrowserRelease, cookies: Map<string, string>): string[] {
    const lines = approvedAuthenticationCookies(this.deps.runtime.browserReleaseHeaders(result), COOKIE_POLICY[operation].live);
    const named = (name: string) => lines.some(line => line.startsWith(`${name}=`));
    const set = (name: string) => lines.some(line => line.startsWith(`${name}=`) && !line.startsWith(`${name}=;`));
    // A login either finished or is pending, never both.
    if (set(SESSION_COOKIE) && set(CHALLENGE_COOKIE)) fail(502, "provider_failed");
    const stale: string[] = [];
    // An old session must not sit beside a challenge: verify-totp would see both.
    if (result.outcome === "challenge" && cookies.has(SESSION_COOKIE)) stale.push(SESSION_COOKIE);
    if (operation === "totp-verify" && result.outcome === "session") stale.push(CHALLENGE_COOKIE);
    if (operation === "passkey-confirmation" || operation === "passkey-authentication") stale.push(PASSKEY_COOKIE);
    return [...lines, ...stale.filter(name => !named(name)).map(deletionCookie)];
  }

  private async failed(error: unknown, unreleased: BrowserRelease | null, knowledge: boolean, response: ServerResponse, lifetime: RequestLifetime, started: Array<Promise<void>>): Promise<void> {
    const committed = unreleased !== null && this.deps.runtime.browserReleaseCommitted(unreleased);
    if (unreleased) {
      // The answer waits for the public result. The slot waits for the cleanup callback itself.
      const cleanup = this.deps.runtime.discardBrowserRelease(unreleased);
      started.push(cleanup.settled);
      await cleanup.result;
    }
    // A closed response gets nothing, including an error.
    if (!lifetime.open) return;
    // Headers already on the wire cannot be replaced by an error response.
    // Preserve may_publish and end the partial response without a second write.
    if (response.headersSent) { response.destroy(); return; }
    // A failed success write may have staged its cookie without sending it.
    // Never carry that credential into the replacement error response.
    response.removeHeader("Set-Cookie");
    const known = committed ? new AuthenticationProviderError("outcome_committed", "The change committed.", true) : error;
    const { status, code, committed: proven } = failure(known, knowledge);
    if (status === 429 || status === 503) response.setHeader("Retry-After", status === 429 ? "60" : "1");
    response.setHeader("Connection", "close");
    authenticationJson(response, status, { code, ...(proven ? { committed: true } : {}) });
  }

  private boundary(request: IncomingMessage): void {
    const path = request.url ?? "";
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes("//") || path.endsWith("/")) fail(400, "invalid_request");
    if (request.headers.host !== this.#authority || countHeader(request, "host") > 1) fail(421, "invalid_authority");
    if (countHeader(request, "origin") > 1 || (request.headers.origin !== undefined && request.headers.origin !== this.#origin)
      || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin")) fail(403, "origin_forbidden");
    for (const name of SINGLE_HEADERS) if (countHeader(request, name) > 1) fail(name.startsWith("sec-fetch") ? 403 : 400, name.startsWith("sec-fetch") ? "origin_forbidden" : "invalid_request");
    const mode = request.headers["sec-fetch-mode"], destination = request.headers["sec-fetch-dest"];
    if ((mode !== undefined && mode !== "cors" && mode !== "same-origin") || (destination !== undefined && destination !== "empty")) fail(403, "origin_forbidden");
    if (request.method === "GET" && (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0"))) fail(400, "invalid_request");
    if (Buffer.byteLength(request.headers.cookie ?? "") > this.#limits.cookieBytes) fail(400, "invalid_request");
  }
  private headers(request: IncomingMessage): Headers {
    const peer = this.deps.trustedFixturePeer ?? request.socket.remoteAddress;
    if (!peer || !isIP(peer)) fail(503, "database_unavailable");
    // Rebuild from an allowlist; Authorization, product tokens, internal IP and all forwarding headers disappear.
    const canonicalPeer = isIP(peer) === 6 ? (peer.toLowerCase().startsWith("::ffff:") && isIP(peer.slice(7)) === 4 ? peer.slice(7) : new URL(`http://[${peer}]/`).hostname.slice(1, -1)) : peer;
    const headers = new Headers({ "x-worktree-control-client-ip": canonicalPeer, "content-type": "application/json" });
    for (const name of ["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] as const) {
      const value = request.headers[name]; if (typeof value === "string") headers.set(name, value);
    }
    return headers;
  }
}

/** One fixed public failure. No branch distinguishes account, mapping, generation or SQL detail. */
function failure(error: unknown, knowledge: boolean): { status: number; code: string; committed?: boolean } {
  if (error instanceof BoundaryError) return { status: error.status, code: error.code };
  const admission = databaseAdmissionFailure(error);
  if (admission) return { status: admission.status, code: admission.code };
  if (error instanceof AuthenticationProviderError) {
    if (error.code === "outcome_committed") return { status: 503, code: "completion_unconfirmed", committed: true };
    if (error.committed) return { status: 500, code: "committed_notification_failed", committed: true };
    switch (error.code) {
      case "outcome_unconfirmed": return { status: 503, code: "completion_unconfirmed" };
      case "invalid_session": return { status: 401, code: knowledge ? "invalid_credential" : "authentication_failed" };
      case "authentication_failed": return { status: 401, code: "authentication_failed" };
      case "rate_limited": return { status: 429, code: "rate_limited" };
      case "capacity": return { status: 503, code: "database_busy" };
      case "provider_failed": return { status: 502, code: "provider_failed" };
      case "provider_unavailable": case "provider_disposed": case "cancelled": return { status: 503, code: "database_unavailable" };
      default: return { status: 500, code: "authentication_failed" };
    }
  }
  if (error instanceof IdentityError && error.code === "invalid_credential") return { status: 401, code: "invalid_credential" };
  if ((error as { code?: string })?.code === "knowledge_forbidden") return { status: 403, code: "knowledge_forbidden" };
  return { status: 500, code: "authentication_failed" };
}

function countHeader(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < (request.rawHeaders?.length ?? 0); index += 2) if (request.rawHeaders[index].toLowerCase() === name) count++;
  return count;
}
