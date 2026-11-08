import type { RuntimeReadRequest, RuntimeReadResult } from "@/shared/contracts/runtime-read";
import type { RuntimeMutateRequest, RuntimeMutateResult } from "@/shared/contracts/runtime-mutate";
import type { HumanVerificationRequest } from "@/shared/contracts/human-verification";
import type { HumanConfigurationRequest } from "@/shared/contracts/human-configuration";
import type { ScopedTestRunStatus } from "@/shared/contracts/scoped-verification";

/**
 * Cookie-authenticated scoped runtime routes. Authority is entirely
 * server-owned: the GUI sends resource/intent DTOs only and presents the
 * backend's denial codes honestly instead of inferring rights.
 */
export class RuntimeApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Runtime request failed (${status} ${code}).`);
    this.name = "RuntimeApiError";
  }
}

/** Long-poll status envelope shared by the tests route; mirrors the server's compact status service shape. */
export interface CompactEnvelope<T> {
  schemaVersion: 1;
  epoch: string;
  cursor: string;
  observedAt: string;
  retryAfterMs: number | null;
  status: T;
}
export type ScopedTestRunEnvelope = CompactEnvelope<ScopedTestRunStatus>;
export type ScopedTestPresets = Array<{ worktreePath: string; presets: Array<{ id: string; timeoutMs: number }> }>;

async function call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const value = await response.json().catch(() => ({})) as { code?: string };
  if (!response.ok) throw new RuntimeApiError(response.status, typeof value.code === "string" ? value.code : "runtime_read_unavailable");
  return value as T;
}

export function runtimeRead<R extends RuntimeReadRequest>(request: R, signal?: AbortSignal): Promise<Extract<RuntimeReadResult, { operation: R["operation"] }>> {
  return call("/api/runtime/read", request, signal);
}
export function runtimeMutate(request: RuntimeMutateRequest, signal?: AbortSignal): Promise<RuntimeMutateResult> {
  return call("/api/runtime/mutate", request, signal);
}
export function runtimeConfiguration(request: HumanConfigurationRequest, signal?: AbortSignal): Promise<unknown> {
  return call("/api/runtime/configuration", request, signal);
}

export function testPresets(projectId: string, signal?: AbortSignal): Promise<ScopedTestPresets> {
  return call("/api/runtime/tests", { operation: "presets", projectId } satisfies HumanVerificationRequest, signal);
}
export function enqueueTest(input: { projectId: string; worktreePath: string; presetId: string; idempotencyKey: string; reservationId?: string }, signal?: AbortSignal): Promise<ScopedTestRunEnvelope> {
  return call("/api/runtime/tests", { operation: "enqueue", ...input } satisfies HumanVerificationRequest, signal);
}
export function testRunStatus(runId: string, projectId: string, signal?: AbortSignal): Promise<ScopedTestRunEnvelope> {
  return call("/api/runtime/tests", { operation: "status", runId, projectId } satisfies HumanVerificationRequest, signal);
}
export function cancelTestRun(runId: string, projectId: string, signal?: AbortSignal): Promise<ScopedTestRunEnvelope> {
  return call("/api/runtime/tests", { operation: "cancel", runId, projectId } satisfies HumanVerificationRequest, signal);
}
export function waitTestRun(runId: string, cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<ScopedTestRunEnvelope> {
  return call("/api/runtime/tests", { operation: "wait", runId, cursor, timeoutMs } satisfies HumanVerificationRequest, signal);
}

/** A 401 means the session cookie stopped being the authority; the app returns to sign-in. */
export function isRuntimeSessionLoss(error: unknown): boolean {
  return error instanceof RuntimeApiError && error.status === 401;
}
/** The fixed one-time-use key for one user intent; retries of the same click reuse it, new intents mint a new one. */
export function idempotencyKey(): string {
  return crypto.randomUUID();
}
