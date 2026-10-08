/** Bounded observations shared by the owner CLI and dashboard. No credential or lease identifiers. */
export type McpCloseReason = "client-delete" | "absolute-lifetime" | "authentication-policy" | "controller-shutdown" | "initialization-failed" | "transport-close" | "idle-expired" | "abandoned-transport" | "admission-refused";
export interface McpStatusWaitDiagnostics { waiters: number; waiterTimers: number; targets?: number; samplerTimers?: number }
export interface McpSessionDiagnostics {
  label: number; createdAt: string; initialized: boolean; closed: boolean;
  lastClientMessageAt: string | null; lastClientRequestAt: string | null; lastQualifyingActivityAt: string | null;
  lastTransportEndedAt: string | null; lastAutomaticRenewalAt: string | null; closeReason: McpCloseReason | null;
  openResponses: number; sseResponses: number; operations: number; claims: number;
  renewalTimers: number; lifetimeTimers: number; drainTimers: number; renewalsSkippedByPolicy: number;
  agentState: "unknown"; transportState: "closed" | "response-open" | "no-open-response";
  state: "open" | "draining" | "closed";
  transportPhase: "open" | "interrupted" | "request-only" | "closed";
  renewalPolicyState: "none" | "renewing" | "stopped-idle";
  closeDueAt: string | null; closeDueReason: McpCloseReason | null; statusWaits: McpStatusWaitDiagnostics | null;
}
export interface McpDiagnosticsSnapshot {
  schemaVersion: number; observedAt: string; logicalSessions: number; initializingSessions: number; drainingSessions: number;
  connections: number; openResponses: number; sseResponses: number; operations: number; claims: number;
  renewalTimers: number; lifetimeTimers: number; drainTimers: number; runtimeRetryEntries: number;
  resourceSubscriptions: number; sdkInternalResources: string; clientProcesses: string; proxyProcesses: string;
  automaticRenewals: number; automaticRenewalFailures: number; renewalsSkippedByPolicy: number;
  closeReasons: Record<McpCloseReason, number>;
  recentClosures: Array<{ at: string; reason: McpCloseReason; operationsAtClose: number }>;
  sessions: McpSessionDiagnostics[]; truncated: number; omittedSessions: number; sessionOrder: string;
  controllerProcess: { sampledAt: string; rssBytes: number; heapUsedBytes: number; cpuPercent: number | null };
  processSampleAgeMs: number; processSampleIntervalMs: number; claimScope: string; operationScope: string;
  admission: { admittedSessions: number; credentials: number; largestCredentialSessions: number; limit: number; perCredentialLimit: number };
  policy: { claimRenewalIdleSeconds: number; sessionIdleSeconds: number; openSessionIdleSeconds: number; reconnectGraceSeconds: number; drainSeconds: number; absoluteLifetimeSeconds: number };
}
export interface McpDiagnosticsResponse {
  mcp: McpDiagnosticsSnapshot | null; status: "enabled" | "disabled"; statusWaits: McpStatusWaitDiagnostics;
}
