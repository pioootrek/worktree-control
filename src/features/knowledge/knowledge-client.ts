import type { KnowledgeFailure, KnowledgeInput, KnowledgeOperation } from "@/shared/contracts/knowledge";

export class KnowledgeClientError extends Error {
  constructor(readonly failure: KnowledgeFailure, readonly status: number) { super(failure.error); }
}

export async function knowledgeRequest<T, K extends KnowledgeOperation = KnowledgeOperation>(token: string, operation: K, input: KnowledgeInput<K>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/knowledge", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, input }), signal,
  });
  const value = await response.json();
  if (!response.ok) throw new KnowledgeClientError(value, response.status);
  return value as T;
}

export interface KnowledgeIdentity { principal: { id: string; kind: string }; credential: { kind: string } | null; installationAuthority?: boolean }
export async function knowledgeIdentity(token: string, signal?: AbortSignal): Promise<KnowledgeIdentity> {
  const response = await fetch("/api/identity", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal });
  if (!response.ok) throw new KnowledgeClientError(response.status === 401 || response.status === 403
    ? { code: "invalid_credential", error: "Knowledge access denied." }
    : { code: "load_failed", error: "Could not load knowledge identity." }, response.status);
  return response.json();
}

export function isKnowledgeAccessError(error: unknown): boolean {
  return error instanceof KnowledgeClientError && (error.status === 401 || error.status === 403);
}
