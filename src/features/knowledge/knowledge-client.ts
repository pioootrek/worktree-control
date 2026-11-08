import type { KnowledgeFailure, KnowledgeInput, KnowledgeOperation } from "@/shared/contracts/knowledge";
import type { BrowserSession } from "@/shared/contracts/authentication";

export class KnowledgeClientError extends Error {
  constructor(readonly failure: KnowledgeFailure, readonly status: number) { super(failure.error); }
}

/**
 * Sentinel selecting the closed account-session transport: the HttpOnly
 * session cookie is the sole credential, so requests carry no Authorization
 * header at all (cookie plus bearer is a 401 by contract) and no secret is
 * ever stored in the browser. Only knowledge routes that accept the cookie
 * are reachable this way; unconverted routes keep their token-only denial.
 */
export const ACCOUNT_SESSION = "__account_session__";

export interface AccountKnowledgeSession {
  readonly transport: typeof ACCOUNT_SESSION;
  sessionLost(signal?: AbortSignal): void;
}
export type KnowledgeCredential = string | AccountKnowledgeSession;

/** A capability owned by one mounted account session, never a global listener. */
export function createAccountKnowledgeSession(onSessionLost: () => void) {
  let active = false;
  let reported = false;
  const credential: AccountKnowledgeSession = {
    transport: ACCOUNT_SESSION,
    sessionLost(signal) {
      if (!active || reported || signal?.aborted) return;
      reported = true;
      onSessionLost();
    },
  };
  return { credential, activate() { active = true; return () => { active = false; }; } };
}

const accountMode = (token: KnowledgeCredential) => typeof token !== "string" || token === ACCOUNT_SESSION;
const sessionLost = (token: KnowledgeCredential, signal?: AbortSignal) => {
  if (typeof token !== "string") token.sessionLost(signal);
};

export async function knowledgeRequest<T, K extends KnowledgeOperation = KnowledgeOperation>(token: KnowledgeCredential, operation: K, input: KnowledgeInput<K>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/knowledge", {
    method: "POST", cache: "no-store",
    ...(accountMode(token) ? { credentials: "same-origin" as const } : {}),
    headers: {
      "Content-Type": "application/json",
      ...(accountMode(token) ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ operation, input }), signal,
  });
  // HTTP status is authoritative even if an expired-session answer has no JSON body.
  if (response.status === 401) sessionLost(token, signal);
  const value = await response.json();
  if (!response.ok) throw new KnowledgeClientError(value, response.status);
  return value as T;
}

export interface KnowledgeIdentity { principal: { id: string; kind: string }; credential: { kind: string } | null; installationAuthority?: boolean }
export async function knowledgeIdentity(token: KnowledgeCredential, signal?: AbortSignal): Promise<KnowledgeIdentity> {
  if (accountMode(token)) {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store", signal });
    if (response.status === 401) sessionLost(token, signal);
    const session = await response.json().catch(() => null) as BrowserSession | null;
    if (!response.ok || !session?.authenticated) {
      if (response.ok) sessionLost(token, signal);
      throw new KnowledgeClientError({ code: "invalid_credential", error: "Knowledge access denied." }, response.ok ? 401 : response.status);
    }
    return { principal: session.principal, credential: null };
  }
  const response = await fetch("/api/identity", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal });
  if (!response.ok) throw new KnowledgeClientError(response.status === 401 || response.status === 403
    ? { code: "invalid_credential", error: "Knowledge access denied." }
    : { code: "load_failed", error: "Could not load knowledge identity." }, response.status);
  return response.json();
}

export function isKnowledgeAccessError(error: unknown): boolean {
  return error instanceof KnowledgeClientError && (error.status === 401 || error.status === 403);
}

export function isKnowledgeSessionLoss(error: unknown): boolean {
  return error instanceof KnowledgeClientError && error.status === 401;
}
