import type { McpDiagnosticsResponse, McpSessionDiagnostics } from "@/shared/contracts/mcp-diagnostics";

export interface McpDiagnosticsRead {
  body: McpDiagnosticsResponse | null;
  receivedAt: number;
  loading: boolean;
  error: "unauthorized" | "forbidden" | "failed" | null;
}
export type SessionSort = { field: "claims" | "idle"; descending: boolean };
export function qualifyingIdleMs(session: McpSessionDiagnostics, now: number): number | null {
  return session.lastQualifyingActivityAt === null ? null : Math.max(0, now - Date.parse(session.lastQualifyingActivityAt));
}
export function remainingLifetimeMs(session: McpSessionDiagnostics, seconds: number, now: number): number {
  return Math.max(0, Date.parse(session.createdAt) + seconds * 1000 - now);
}
export function sortSessions(sessions: McpSessionDiagnostics[], sort: SessionSort, now: number): McpSessionDiagnostics[] {
  return [...sessions].sort((left, right) => {
    const a = sort.field === "claims" ? left.claims : qualifyingIdleMs(left, now);
    const b = sort.field === "claims" ? right.claims : qualifyingIdleMs(right, now);
    if (a === null || b === null) return a === b ? left.label - right.label : a === null ? 1 : -1;
    return (sort.descending ? b - a : a - b) || left.label - right.label;
  });
}
