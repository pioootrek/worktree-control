import type { McpDiagnosticsResponse, McpSessionDiagnostics } from "../../src/shared/contracts/mcp-diagnostics";
export function mcpDiagnosticsFixture(): McpDiagnosticsResponse {
  const observedAt = new Date().toISOString();
  const at = (seconds: number) => new Date(Date.parse(observedAt) - seconds * 1000).toISOString();
  const session = (label: number, claims: number, idleSeconds: number | null): McpSessionDiagnostics => ({
    label, claims, createdAt: at(3600), initialized: true, closed: false,
    lastClientMessageAt: at(3), lastClientRequestAt: at(3), lastQualifyingActivityAt: idleSeconds === null ? null : at(idleSeconds),
    lastTransportEndedAt: null, lastAutomaticRenewalAt: at(60), closeReason: null,
    openResponses: 1, sseResponses: 1, operations: 0, renewalTimers: claims ? 1 : 0,
    lifetimeTimers: 1, drainTimers: 0, renewalsSkippedByPolicy: 0,
    agentState: "unknown", transportState: "response-open", state: "open", transportPhase: "open",
    renewalPolicyState: claims ? "renewing" : "none", closeDueAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
    closeDueReason: "idle-expired", statusWaits: { waiters: 0, waiterTimers: 0 },
  });
  const idle = session(2, 0, 1200);
  idle.transportPhase = "interrupted";
  const claimed = session(1, 2, 600);
  const draining = session(4, 0, 3600);
  Object.assign(draining, { closed: true, state: "draining", transportPhase: "closed", operations: 1, closeReason: "idle-expired", renewalPolicyState: "stopped-idle", drainTimers: 1, statusWaits: null });
  return { status: "enabled", statusWaits: { waiters: 0, waiterTimers: 0, targets: 0, samplerTimers: 0 }, mcp: {
    schemaVersion: 1, observedAt, logicalSessions: 3, initializingSessions: 1, drainingSessions: 1,
    connections: 2, openResponses: 4, sseResponses: 4, operations: 1, claims: 2,
    renewalTimers: 1, lifetimeTimers: 3, drainTimers: 1, runtimeRetryEntries: 0,
    resourceSubscriptions: 0, sdkInternalResources: "unknown", clientProcesses: "unknown", proxyProcesses: "unknown",
    automaticRenewals: 2, automaticRenewalFailures: 0, renewalsSkippedByPolicy: 1,
    closeReasons: { "client-delete": 0, "absolute-lifetime": 0, "authentication-policy": 0, "controller-shutdown": 0, "initialization-failed": 0, "transport-close": 0, "idle-expired": 1, "abandoned-transport": 0, "admission-refused": 1 },
    recentClosures: [{ at: at(60), reason: "admission-refused", operationsAtClose: 0 }, { at: at(20), reason: "idle-expired", operationsAtClose: 1 }],
    sessions: [idle, claimed, session(3, 0, null), draining], truncated: 1, omittedSessions: 1, sessionOrder: "claim holders first",
    controllerProcess: { sampledAt: at(2), rssBytes: 128 * 1024 ** 2, heapUsedBytes: 64 * 1024 ** 2, cpuPercent: null },
    processSampleAgeMs: 2000, processSampleIntervalMs: 5000, claimScope: "session-held renewal handles", operationScope: "registered handlers",
    admission: { admittedSessions: 5, credentials: 2, largestCredentialSessions: 3, limit: 128, perCredentialLimit: 48 },
    policy: { claimRenewalIdleSeconds: 900, sessionIdleSeconds: 900, openSessionIdleSeconds: 3600, reconnectGraceSeconds: 300, drainSeconds: 30, absoluteLifetimeSeconds: 28800 },
  } };
}
