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

const accountMode = (token: string) => token === ACCOUNT_SESSION;

export async function knowledgeRequest<T, K extends KnowledgeOperation = KnowledgeOperation>(token: string, operation: K, input: KnowledgeInput<K>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/knowledge", {
    method: "POST", cache: "no-store",
    ...(accountMode(token) ? { credentials: "same-origin" as const } : {}),
    headers: {
      "Content-Type": "application/json",
      ...(accountMode(token) ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ operation, input }), signal,
  });
  const value = await response.json();
  if (!response.ok) throw new KnowledgeClientError(value, response.status);
  return value as T;
}

export interface KnowledgeIdentity { principal: { id: string; kind: string }; credential: { kind: string } | null; installationAuthority?: boolean }
export async function knowledgeIdentity(token: string, signal?: AbortSignal): Promise<KnowledgeIdentity> {
  if (accountMode(token)) {
    const response = await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store", signal });
    const session = await response.json().catch(() => null) as BrowserSession | null;
    if (!response.ok || !session?.authenticated) {
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
