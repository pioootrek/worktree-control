import type { TestHistoryFilter, TestHistoryPage, TestMetrics, TestRunComparison } from "@/shared/contracts/verification-history";
import { filterQuery, HISTORY_PAGE_SIZE } from "./telemetry-model";

export type TelemetryErrorKind = "unauthorized" | "forbidden" | "invalid" | "not_found" | "failed";

/** A safe, classified read failure. The message is the server's localized text when present. */
export class TelemetryRequestError extends Error {
  constructor(readonly kind: TelemetryErrorKind, message: string, readonly status: number | null) {
    super(message);
    this.name = "TelemetryRequestError";
  }
}

export interface TelemetryAccess { token: string; locale: string; fetcher?: typeof fetch }

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

async function read<T>(access: TelemetryAccess, path: string, signal: AbortSignal): Promise<T> {
  const response = await (access.fetcher ?? fetch)(path, {
    cache: "no-store",
    signal,
    headers: { "Accept-Language": access.locale, "X-Worktree-Control-Token": access.token },
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  if (response.ok) return body as T;
  const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
  const kind: TelemetryErrorKind = response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden"
    : response.status === 404 ? "not_found" : response.status === 400 ? "invalid" : "failed";
  throw new TelemetryRequestError(kind, message, response.status);
}

export function fetchTestMetrics(access: TelemetryAccess, filter: TestHistoryFilter, signal: AbortSignal) {
  return read<TestMetrics>(access, `${projectPath(filter.projectId)}/test-metrics?${filterQuery(filter)}`, signal);
}

export function fetchTestHistory(access: TelemetryAccess, filter: TestHistoryFilter, cursor: string | null, signal: AbortSignal, limit = HISTORY_PAGE_SIZE) {
  return read<TestHistoryPage>(access, `${projectPath(filter.projectId)}/test-runs?${filterQuery(filter, { limit, cursor })}`, signal);
}

export function fetchTestComparison(access: TelemetryAccess, projectId: string, leftRunId: string, rightRunId: string, signal: AbortSignal) {
  const query = new URLSearchParams({ leftRunId, rightRunId });
  return read<TestRunComparison>(access, `${projectPath(projectId)}/test-run-comparison?${query}`, signal);
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

/**
 * One slot of in-flight work: starting a request aborts its predecessor, and a
 * response is accepted only while it is still the newest request for the slot.
 */
export function latestRequestSlot() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      const id = ++generation;
      return { signal: own.signal, current: () => id === generation && !own.signal.aborted };
    },
    cancel() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}
