/**
 * Session admission, liveness and renewal limits. Defaults come from 43 hours
 * of production sampling (2026-10-05..07): inter-request gaps p95 12.6 min and
 * max 62 min, a cleanup-adjusted peak of about 20 retained sessions against 21
 * physical connections. See docs/reservations-and-mcp.md.
 */
export interface McpSessionLimits {
  /** Automatic claim renewal requires qualifying client activity within this window. */
  claimRenewalIdleMs: number;
  /** Close a session whose transport ended and whose last qualifying activity is older. */
  sessionIdleMs: number;
  /** Close a session with an open (or never streamed) transport after this much inactivity. */
  openSessionIdleMs: number;
  /** One non-repeating reconnect grace after the first transport interruption since the last activity. */
  reconnectGraceMs: number;
  /** Cooperative drain for accepted calls when a policy closes a session. */
  drainMs: number;
  /** Absolute session lifetime, independent of activity. */
  absoluteLifetimeMs: number;
  /** Logical sessions admitted globally, counting initializing and draining ones. */
  maxSessions: number;
  /** Logical sessions admitted per authenticated credential, including the shared installation credential. */
  maxSessionsPerCredential: number;
}

const MINUTE = 60_000;

export const defaultMcpSessionLimits: Readonly<McpSessionLimits> = Object.freeze({
  claimRenewalIdleMs: 15 * MINUTE,
  sessionIdleMs: 15 * MINUTE,
  openSessionIdleMs: 60 * MINUTE,
  reconnectGraceMs: 60_000,
  drainMs: 120_000,
  absoluteLifetimeMs: 8 * 60 * MINUTE,
  maxSessions: 64,
  maxSessionsPerCredential: 32,
});

/** Merge explicit overrides with the defaults and reject unusable values. */
export function resolveMcpSessionLimits(overrides: Partial<McpSessionLimits> = {}): McpSessionLimits {
  const limits: McpSessionLimits = { ...defaultMcpSessionLimits };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof McpSessionLimits, number | undefined]>) {
    if (!(key in defaultMcpSessionLimits)) throw new Error(`Unknown MCP session limit: ${String(key)}.`);
    if (value !== undefined) limits[key] = value;
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`MCP session limit ${key} must be a positive integer.`);
  }
  if (limits.maxSessionsPerCredential > limits.maxSessions) {
    throw new Error("The per-credential MCP session limit cannot exceed the global limit.");
  }
  return limits;
}
