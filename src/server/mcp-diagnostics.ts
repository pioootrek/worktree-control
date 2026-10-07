/**
 * Observations only: admission, liveness, renewal and drain decisions belong to
 * the mcp-sessions application module; this records their outcomes.
 */
export type McpCloseReason = "client-delete" | "absolute-lifetime" | "authentication-policy" | "controller-shutdown" | "initialization-failed" | "transport-close"
  | "idle-expired" | "abandoned-transport" | "admission-refused";
type Gauge = "openResponses" | "sseResponses" | "operations" | "claims" | "renewalTimers" | "lifetimeTimers" | "drainTimers";
const DETAIL_LIMIT = 32;
export interface McpSessionObservation {
  label: number;
  createdAt: string;
  initialized: boolean;
  closed: boolean;
  lastClientMessageAt: string | null;
  lastClientRequestAt: string | null;
  /** Last authenticated tool call or resource read started or settled; the only input to idle policy. */
  lastQualifyingActivityAt: string | null;
  lastTransportEndedAt: string | null;
  lastAutomaticRenewalAt: string | null;
  closeReason: McpCloseReason | null;
  openResponses: number;
  sseResponses: number;
  operations: number;
  claims: number;
  renewalTimers: number;
  lifetimeTimers: number;
  drainTimers: number;
  renewalsSkippedByPolicy: number;
}
const zero = () => ({ openResponses: 0, sseResponses: 0, operations: 0, claims: 0, renewalTimers: 0, lifetimeTimers: 0, drainTimers: 0 });
const lastActivity = (entry: McpSessionObservation) => entry.lastQualifyingActivityAt ?? entry.lastClientMessageAt ?? entry.createdAt;
/** Claim holders and renewal timers first, then open responses or running operations, then most recent activity. */
function detailOrder(left: McpSessionObservation, right: McpSessionObservation): number {
  const claim = (entry: McpSessionObservation) => entry.claims > 0 || entry.renewalTimers > 0 ? 0 : 1;
  const open = (entry: McpSessionObservation) => entry.openResponses > 0 || entry.operations > 0 ? 0 : 1;
  return claim(left) - claim(right) || open(left) - open(right) || lastActivity(right).localeCompare(lastActivity(left)) || left.label - right.label;
}
export class McpDiagnostics {
  private sequence = 0;
  private readonly retained = new Map<number, McpSessionObservation>();
  private readonly totals = zero();
  private readonly reasons: Record<McpCloseReason, number> = { "client-delete": 0, "absolute-lifetime": 0, "authentication-policy": 0, "controller-shutdown": 0, "initialization-failed": 0, "transport-close": 0,
    "idle-expired": 0, "abandoned-transport": 0, "admission-refused": 0 };
  private readonly recent: Array<{ at: string; reason: McpCloseReason; operationsAtClose: number }> = [];
  private logicalSessions = 0;
  private initializingSessions = 0;
  private drainingSessions = 0;
  private connections = 0;
  private automaticRenewals = 0;
  private automaticRenewalFailures = 0;
  private renewalsSkippedByPolicy = 0;
  private sampledAt = 0;
  private cpu = process.cpuUsage();
  private sampledProcess: { sampledAt: string; rssBytes: number; heapUsedBytes: number; cpuPercent: number | null } | null = null;

  create(): McpSessionObservation {
    const entry: McpSessionObservation = { label: ++this.sequence, createdAt: new Date().toISOString(), initialized: false, closed: false,
      lastClientMessageAt: null, lastClientRequestAt: null, lastQualifyingActivityAt: null, lastTransportEndedAt: null, lastAutomaticRenewalAt: null,
      closeReason: null, ...zero(), renewalsSkippedByPolicy: 0 };
    this.retained.set(entry.label, entry);
    this.initializingSessions++;
    return entry;
  }
  initialize(entry: McpSessionObservation): void { if (!entry.initialized) { entry.initialized = true; this.logicalSessions++; this.initializingSessions--; } }
  connection(delta: 1 | -1): void { this.connections += delta; }
  change(entry: McpSessionObservation, gauge: Gauge, delta: number): void {
    entry[gauge] += delta; this.totals[gauge] += delta;
    if (entry.closed && entry.operations === 0 && entry.openResponses === 0 && this.retained.delete(entry.label)) this.drainingSessions--;
  }
  clientMessage(entry: McpSessionObservation, applicationRequest: boolean): void {
    entry.lastClientMessageAt = new Date().toISOString();
    if (applicationRequest) entry.lastClientRequestAt = entry.lastClientMessageAt;
  }
  qualifyingActivity(entry: McpSessionObservation, at: string): void { entry.lastQualifyingActivityAt = at; }
  renewalSkipped(entry: McpSessionObservation): void { entry.renewalsSkippedByPolicy++; this.renewalsSkippedByPolicy++; }
  /** A refused initialize never becomes a session; only its fixed reason is counted. */
  refused(): void {
    this.reasons["admission-refused"]++;
    this.recent.push({ at: new Date().toISOString(), reason: "admission-refused", operationsAtClose: 0 });
    if (this.recent.length > 64) this.recent.shift();
  }
  renewed(entry: McpSessionObservation, succeeded: boolean): void {
    if (succeeded) { this.automaticRenewals++; entry.lastAutomaticRenewalAt = new Date().toISOString(); }
    else this.automaticRenewalFailures++;
  }
  close(entry: McpSessionObservation, reason: McpCloseReason): void {
    if (entry.closed) return;
    entry.closed = true; entry.closeReason = reason;
    if (entry.initialized) this.logicalSessions--; else this.initializingSessions--;
    this.reasons[reason]++;
    this.recent.push({ at: new Date().toISOString(), reason, operationsAtClose: entry.operations });
    if (this.recent.length > 64) this.recent.shift();
    if (entry.operations === 0 && entry.openResponses === 0) this.retained.delete(entry.label); else this.drainingSessions++;
  }
  snapshot() {
    const now = Date.now();
    if (!this.sampledProcess || now - this.sampledAt >= 5000) {
      const cpu = process.cpuUsage(), memory = process.memoryUsage();
      this.sampledProcess = { sampledAt: new Date(now).toISOString(), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
        cpuPercent: this.sampledAt ? (cpu.user - this.cpu.user + cpu.system - this.cpu.system) / ((now - this.sampledAt) * 10) : null };
      this.cpu = cpu; this.sampledAt = now;
    }
    while (this.recent.length && Date.parse(this.recent[0]!.at) < now - 15 * 60_000) this.recent.shift();
    // Retained entries are bounded by session admission; sort before truncating.
    const sessions = [...this.retained.values()].sort(detailOrder).slice(0, DETAIL_LIMIT).map(entry => ({ ...entry, agentState: "unknown" as const,
      transportState: entry.closed ? "closed" as const : entry.openResponses ? "response-open" as const : "no-open-response" as const }));
    const truncated = Math.max(0, this.retained.size - sessions.length);
    return { schemaVersion: 1, observedAt: new Date(now).toISOString(), logicalSessions: this.logicalSessions,
      initializingSessions: this.initializingSessions, drainingSessions: this.drainingSessions,
      connections: this.connections, ...this.totals,
      // Resource subscription handlers are not registered; SDK internal timer/stream maps have no public inspection API.
      resourceSubscriptions: 0, sdkInternalResources: "unknown", clientProcesses: "unknown", proxyProcesses: "unknown",
      automaticRenewals: this.automaticRenewals, automaticRenewalFailures: this.automaticRenewalFailures, renewalsSkippedByPolicy: this.renewalsSkippedByPolicy,
      closeReasons: { ...this.reasons }, recentClosures: [...this.recent], sessions, truncated, omittedSessions: truncated,
      sessionOrder: "claim holders and renewal timers, then open responses or running operations, then most recent activity",
      controllerProcess: this.sampledProcess, processSampleAgeMs: now - this.sampledAt, processSampleIntervalMs: 5000,
      claimScope: "session-held renewal handles; persisted reservations may outlive them",
      operationScope: "registered protocol handlers excluding initialize and ping" };
  }
}
