import type { McpSessionLimits } from "./session-limits";

/**
 * `open`: at least one session-bound HTTP response is open (SSE stream or call).
 * `interrupted`: an SSE stream was observed and no response is open now.
 * `request-only`: no SSE stream has ever been observed; liveness is unknown.
 */
export type McpTransportPhase = "open" | "interrupted" | "request-only";
export type McpPolicyCloseReason = "idle-expired" | "abandoned-transport" | "absolute-lifetime";

export interface McpLivenessState {
  createdAt: number;
  /** Last authenticated tool call or resource read started or settled by this session. */
  lastQualifyingActivityAt: number | null;
  openResponses: number;
  streamObserved: boolean;
  /** First interruption since the last qualifying activity; anchors the non-repeating reconnect grace. */
  interruptedAt: number | null;
}

export interface McpSessionDeadline {
  at: number;
  reason: McpPolicyCloseReason;
}

export function transportPhase(state: McpLivenessState): McpTransportPhase {
  if (state.openResponses > 0) return "open";
  return state.streamObserved ? "interrupted" : "request-only";
}

/**
 * When the session must close if nothing changes. Policy deadlines only move
 * later with qualifying activity; reconnects never restart the grace window.
 */
export function sessionDeadline(state: McpLivenessState, limits: McpSessionLimits): McpSessionDeadline {
  const absolute: McpSessionDeadline = { at: state.createdAt + limits.absoluteLifetimeMs, reason: "absolute-lifetime" };
  let policy: McpSessionDeadline;
  if (transportPhase(state) === "interrupted") {
    const graceEnd = (state.interruptedAt ?? state.createdAt) + limits.reconnectGraceMs;
    policy = {
      at: state.lastQualifyingActivityAt === null ? graceEnd : Math.max(graceEnd, state.lastQualifyingActivityAt + limits.sessionIdleMs),
      reason: "abandoned-transport",
    };
  } else {
    // An open transport, or one that never streamed, proves nothing about the
    // agent. It keeps the longer budget because observed gaps reached 62 min.
    policy = { at: (state.lastQualifyingActivityAt ?? state.createdAt) + limits.openSessionIdleMs, reason: "idle-expired" };
  }
  return policy.at < absolute.at ? policy : absolute;
}

/** Server-side renewal continues only while the client showed qualifying activity recently. */
export function claimRenewalAllowed(state: McpLivenessState, limits: McpSessionLimits, now: number): boolean {
  return state.lastQualifyingActivityAt !== null && now - state.lastQualifyingActivityAt < limits.claimRenewalIdleMs;
}
