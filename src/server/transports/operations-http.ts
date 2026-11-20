import type { ServerResponse, IncomingMessage } from "node:http";
import { CONTROLLER_TOKEN_HEADER, LEGACY_CONTROLLER_TOKEN_HEADER } from "@/shared/controller-token";
import { containsProviderCookie } from "@/shared/contracts/authentication";
import {
  classifyBearer, OperationError, publicError,
  type AuthenticationContext, type OperationRegistry, type OperationRunner, type OperationRuntime, type PresentedCredentials,
} from "../modules/operations";
import type { DatabaseAdmissionOptions } from "../database-admission";
import type { VerifiedProviderSession, AuthenticationProviderRuntime } from "../modules/authentication";
import type { ProviderSessionEligibility } from "../bootstrap/authentication-provider-lifetime";
import type { AuthenticationRequestBudget, AuthenticationRequestSlot } from "../bootstrap/authentication-request-budget";
import { authenticationRequestBoundary, authenticationProviderHeaders, authenticationRequestOrigin, authenticationJsonContentType } from "./authentication-http";
import type { PublicOperationError } from "@/shared/contracts/operations";
import { BodyReadAbortedError, BoundaryError, parseStrictJson, readBoundedBody, requestCookies, SESSION_COOKIE } from "./authentication-http-boundary";
import { parseOperationsPath } from "./operations-path";

type Mint = (listener: "api" | "mcp" | "unix" | "worker", presented: PresentedCredentials, session: VerifiedProviderSession | null, options: DatabaseAdmissionOptions) => Promise<
  { readonly ok: true; readonly context: AuthenticationContext } | { readonly ok: false; readonly error: PublicOperationError }>;
/** Value supplied by the one bootstrap composition. No boundary is constructed here. */
export type OperationsHttpRuntime = { supported: false; mint: Mint } | {
  supported: true; mint: Mint; eligible(): boolean;
  requestBudget: AuthenticationRequestBudget;
  resolveSession: AuthenticationProviderRuntime["resolveRequest"];
  providerSessionEligibility(): ProviderSessionEligibility;
  runtime: Pick<OperationRuntime, "now">;
  registry: Pick<OperationRegistry, "get" | "idsOn">;
  runner: Pick<OperationRunner, "readRelease" | "queryRelease">;
};

/** API's existing 64 KiB ceiling; unix's ordinary-command ceiling is stricter. */
export const OPERATIONS_HTTP_LIMITS = Object.freeze({ bodyBytes: 64 * 1024, unixBodyBytes: 16 * 1024,
  responseBytes: 256 * 1024, deadlineMs: 10_000, maxInFlight: 32, json: Object.freeze({ maxDepth: 8, maxFields: 128 }) });

/** Preserve raw multiplicity, including headers Node would otherwise discard. */
export function presentedCredentials(request: IncomingMessage, legacyHeaders: "tokens" | "refuse" = "tokens"): PresentedCredentials {
  const bearers: PresentedCredentials["bearers"][number][] = [];
  let cookie = false, browserHeaders = false, legacySecret = false;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase(), value = request.rawHeaders[i + 1];
    if (name === "authorization" || name === CONTROLLER_TOKEN_HEADER.toLowerCase() || name === LEGACY_CONTROLLER_TOKEN_HEADER.toLowerCase()) {
      const secret = name === "authorization" ? (/^Bearer\s+(.+)$/i.exec(value)?.[1] ?? "") : value;
      const credentialClass = classifyBearer(secret);
      if (name !== "authorization" && (legacyHeaders === "refuse" || credentialClass === "unrecognized") && !legacySecret) legacySecret = true;
      else bearers.push({ class: name !== "authorization" && legacyHeaders === "refuse" ? "unrecognized" : credentialClass, secret });
    }
    if (name === "cookie") cookie ||= containsProviderCookie(value);
    if (name === "cookie" || name === "origin" || name.startsWith("sec-fetch-")) browserHeaders = true;
  }
  return { bearers, providerSession: cookie ? { secret: "" } : null, legacySecret, browserHeaders };
}

export function operationsFailure(response: ServerResponse, error: PublicOperationError): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  if (error.retry === "retry") response.setHeader("Retry-After", "1");
  // Refused bodies are not drained. Close this connection after the finite response.
  response.setHeader("Connection", "close");
  writeOperationsResponse(response, error.status, JSON.stringify({ error }));
}
export function writeOperationsResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
  response.end(body);
}
const failure = (category: ConstructorParameters<typeof OperationError>[0], reason: string) => publicError(new OperationError(category, reason));

/** A total deadline wins; cancellation only replaces the reader's explicit abort. */
export function operationsRequestFailure(error: unknown, signal: AbortSignal, timedOut: boolean): PublicOperationError {
  if (timedOut) return publicError(new OperationError("unavailable", "request_timed_out", { retry: "retry" }));
  if (signal.aborted && error instanceof BodyReadAbortedError) {
    return publicError(new OperationError("unavailable", "request_cancelled", { retry: "retry" }));
  }
  return error instanceof BoundaryError
    ? failure(error.status === 413 ? "payload_too_large" : error.status === 403 ? "forbidden" : error.status === 503 ? "unavailable" : "invalid_request", error.code)
    : publicError(error);
}

/** Keep Node's protocol ownership: neither listener registers connect or upgrade.
 * Node closes CONNECT without dispatch or a response. Without an upgrade listener,
 * Upgrade requests use normal HTTP dispatch on every supported Node 22/24 release,
 * including those before shouldUpgradeCallback (22.21 / 24.9).
 * Lifetime includes Node response completion AND all started application work.
 */
export function createOperationsHttp(options: {
  runtime: OperationsHttpRuntime; listener: "api" | "unix" | "worker";
  cookieBoundary?: { origin: string; cookieBytes: number };
  originAllowed?(request: IncomingMessage): boolean;
  /** Unix passes its existing owner; it must never acquire a second slot here. */
  externallyOwned?: boolean;
  limits?: { bodyBytes?: number; responseBytes?: number; deadlineMs?: number; maxInFlight?: number };
}) {
  const { runtime, listener } = options, limits = { ...OPERATIONS_HTTP_LIMITS, ...options.limits };
  const accepted = new Set<Promise<void>>();
  const cancellations = new Set<() => void>();
  let closing = false;
  const path = (request: IncomingMessage) => parseOperationsPath(request.url ?? "", runtime.supported ? runtime.registry.idsOn(listener) : ["session.describe"]);
  const preflight = (request: IncomingMessage, response: ServerResponse): boolean => {
    // One fixed refusal, independent of mode, method, malformed path or other credentials.
    if (presentedCredentials(request).providerSession && (listener !== "api" || !runtime.supported)) {
      operationsFailure(response, failure("unauthenticated", "provider_cookie_not_supported")); return false;
    }
    return true;
  };
  const execute = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      if (response.writableEnded && !response.writableFinished) response.destroy();
    };
    cancellations.add(cancel);
    let slot: AuthenticationRequestSlot | null = null;
    const started: Promise<void>[] = [];
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const finished = () => { slot?.responseFinished(); complete(); };
    const closed = () => { if (!response.writableFinished) cancel(); finished(); };
    request.once("aborted", cancel); request.once("error", cancel);
    response.once("finish", finished); response.once("close", closed);
    if (response.writableFinished || response.destroyed) closed();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, limits.deadlineMs); timer.unref();
    const connected = () => !abort.signal.aborted && !response.destroyed && !response.writableEnded;
    try {
      const parsed = path(request);
      if (!parsed.claimed || !parsed.operation || parsed.surface !== "api") {
        operationsFailure(response, failure("not_found", "operation_not_found")); return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        operationsFailure(response, failure("invalid_request", "method_not_allowed")); return;
      }
      if (!runtime.supported) {
        await runtime.mint(listener, presentedCredentials(request), null, { signal: abort.signal });
        operationsFailure(response, failure("unauthenticated", "unknown_mode"));
        return;
      }
      if (closing || !runtime.eligible()) { operationsFailure(response, failure("unavailable", "release_not_eligible")); return; }
      const presented = presentedCredentials(request);
      const cookie = presented.providerSession !== null;
      let nativeHeaders: Headers | undefined;
      if (cookie) {
        // Without a configured browser origin this mode cannot accept a session.
        // Let the existing acceptance table choose its exact public refusal.
        if (!options.cookieBoundary) {
          const minted = await runtime.mint(listener, presented, null, { signal: abort.signal });
          if (!minted.ok && minted.error.reason !== "provider_session_unavailable") operationsFailure(response, minted.error);
          else operationsFailure(response, failure("unauthenticated", "invalid_credential"));
          return;
        }
        authenticationRequestBoundary(request, options.cookieBoundary);
        const cookies = requestCookies(request.headers.cookie);
        authenticationRequestOrigin(request, options.cookieBoundary.origin);
        nativeHeaders = authenticationProviderHeaders(request);
        const session = cookies.get(SESSION_COOKIE);
        if (session !== undefined) nativeHeaders.set("cookie", `${SESSION_COOKIE}=${session}`);
        slot = runtime.requestBudget.acquire("initiating");
        if (!slot) { operationsFailure(response, failure("busy", "listener_capacity")); return; }
        if (response.writableFinished || response.destroyed) slot.responseFinished();
        // The browser checks the pinned configuration before any body read.
        // Reuse the current policy; preserve mint's acceptance-table refusals.
        const eligibility = runtime.providerSessionEligibility();
        if (eligibility === "busy") throw new OperationError("busy", "admission_refused");
        if (eligibility === "ineligible") {
          const minted = await runtime.mint(listener, presented, null, { signal: abort.signal });
          // No session was resolved. Readiness may change during mint, but it
          // cannot turn this pre-body refusal into a credential verdict or success.
          if (!minted.ok && minted.error.reason !== "invalid_credential") operationsFailure(response, minted.error);
          else throw new OperationError("unavailable", "provider_session_unavailable", { retry: "retry" });
          return;
        }
      }
      if (!cookie && options.originAllowed && !options.originAllowed(request)) { operationsFailure(response, failure("forbidden", "origin_forbidden")); return; }
      // Do not let Node collapse singleton transport fields into an accepted value.
      validateOperationsSingletonHeaders(request);
      if (cookie) authenticationJsonContentType(request);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) throw new BoundaryError(400, "invalid_request");
      const deadline = runtime.runtime.now() + limits.deadlineMs;
      const body = parseStrictJson(await readBoundedBody(request, {
        limit: listener === "unix" ? Math.min(limits.bodyBytes, limits.unixBodyBytes) : limits.bodyBytes,
        timeoutMs: limits.deadlineMs, signal: abort.signal,
      }), limits.json);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new BoundaryError(400, "invalid_request");
      let session: VerifiedProviderSession | null = null;
      if (nativeHeaders) {
        const resolution = runtime.resolveSession(nativeHeaders, { signal: abort.signal });
        started.push(resolution.settled);
        session = (await resolution.result)?.session ?? null;
      }
      const minted = await runtime.mint(listener, presented, session, { signal: abort.signal });
      if (!minted.ok) { operationsFailure(response, minted.error); return; }
      const operation = runtime.registry.get(parsed.operation);
      if (!operation) { operationsFailure(response, failure("not_found", "operation_not_found")); return; }
      const releaseOptions = {
        eligible: () => !closing && runtime.eligible(), connected, deadline, signal: abort.signal,
        commit(value: object) {
          const serialized = JSON.stringify(value);
          if (Buffer.byteLength(serialized) > limits.responseBytes) {
            // This refusal is itself committed inside admission. Returning normally
            // reports `committed` to the runner, preventing a second, outside-phase write.
            operationsFailure(response, failure("payload_too_large", "response_too_large")); return;
          }
          writeOperationsResponse(response, 200, serialized);
        },
      };
      // Reads and queries both release inside an admitted phase; the registry holds no other kind yet.
      const result = operation.kind === "query"
        ? await runtime.runner.queryRelease(operation, minted.context, body, releaseOptions)
        : await runtime.runner.readRelease(operation, minted.context, body, releaseOptions);
      if (result.status !== "committed") operationsFailure(response, result.error);
    } catch (error) {
      operationsFailure(response, operationsRequestFailure(error, abort.signal, timedOut));
    } finally {
      // Never relinquish ownership merely because the handler returned or the client disconnected.
      // settle is called once; failed cleanup retains capacity. No race against
      // result cancellation: the provider's settled promise owns its real work.
      try { if (slot) await slot.settle(Promise.all(started)); else await Promise.all(started); }
      finally {
        await completed;
        clearTimeout(timer);
        cancellations.delete(cancel);
        request.off("aborted", cancel); request.off("error", cancel);
        response.off("finish", finished); response.off("close", closed);
      }
    }
  };
  return {
    claims(request: IncomingMessage) { const parsed = path(request); return parsed.claimed; },
    preflight,
    handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (!preflight(request, response)) return Promise.resolve();
      if (closing || (!options.externallyOwned && accepted.size >= limits.maxInFlight)) {
        operationsFailure(response, failure("busy", "listener_capacity")); return Promise.resolve();
      }
      const work = execute(request, response);
      if (!options.externallyOwned) {
        accepted.add(work);
        const forget = () => { accepted.delete(work); }; work.then(forget, forget);
      }
      return work;
    },
    stop() { closing = true; for (const cancel of cancellations) cancel(); },
    async drain() { await Promise.allSettled([...accepted]); },
  };
}

/** Shared raw singleton validation; credentials retain multiplicity for mint. */
export function validateOperationsSingletonHeaders(request: IncomingMessage, additional: readonly string[] = []): void {
  const single = new Set(["host", "origin", "content-type", "content-length", "content-encoding", "transfer-encoding", ...additional]);
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    if (single.has(name) && seen.has(name)) throw new BoundaryError(400, "invalid_request");
    seen.add(name);
  }
}
