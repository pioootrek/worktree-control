import { systemMcpSessionClock, type McpSessionClock, type McpTimer } from "./session-clock";
import { resolveMcpSessionLimits, type McpSessionLimits } from "./session-limits";
import {
  claimRenewalAllowed,
  sessionDeadline,
  transportPhase,
  type McpLivenessState,
  type McpPolicyCloseReason,
  type McpSessionDeadline,
  type McpTransportPhase,
} from "./session-liveness";

export type McpAdmissionScope = "global" | "credential";
export type McpAdmission =
  | { admitted: true; session: GovernedMcpSession }
  | { admitted: false; scope: McpAdmissionScope; limit: number };
export type McpGovernedState = "open" | "draining" | "closed";
export type McpSessionTimerKind = "deadline" | "drain";

/** One session-bound HTTP response; idempotent close. */
export interface McpResponseHandle {
  /** The response became the session's standalone SSE stream. */
  markStream(): void;
  close(): void;
}

const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * Admission and liveness authority for logical MCP sessions. It owns no
 * transport, claim or runtime: the adapter reports observations, and this
 * policy decides admission, renewal eligibility, expiry and drain completion.
 */
export class McpSessionGovernor {
  readonly limits: McpSessionLimits;
  private total = 0;
  private readonly perCredential = new Map<string, number>();

  constructor(limits: Partial<McpSessionLimits> = {}, readonly clock: McpSessionClock = systemMcpSessionClock) {
    this.limits = resolveMcpSessionLimits(limits);
  }

  /**
   * Admit one initialize request. The slot stays counted while initializing,
   * open and draining, until the closed session's accepted work settles.
   */
  admit(credentialKey: string): McpAdmission {
    if (this.total >= this.limits.maxSessions) return { admitted: false, scope: "global", limit: this.limits.maxSessions };
    const held = this.perCredential.get(credentialKey) ?? 0;
    if (held >= this.limits.maxSessionsPerCredential) {
      return { admitted: false, scope: "credential", limit: this.limits.maxSessionsPerCredential };
    }
    this.total += 1;
    this.perCredential.set(credentialKey, held + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const remaining = (this.perCredential.get(credentialKey) ?? 1) - 1;
      if (remaining > 0) this.perCredential.set(credentialKey, remaining);
      else this.perCredential.delete(credentialKey);
    };
    return { admitted: true, session: new GovernedMcpSession(this.limits, this.clock, release) };
  }

  /** Aggregate admission usage and configured policy, without credential identifiers. */
  describe() {
    let largestCredential = 0;
    for (const count of this.perCredential.values()) largestCredential = Math.max(largestCredential, count);
    const limits = this.limits;
    return {
      admission: {
        admittedSessions: this.total,
        credentials: this.perCredential.size,
        largestCredentialSessions: largestCredential,
        limit: limits.maxSessions,
        perCredentialLimit: limits.maxSessionsPerCredential,
      },
      policy: {
        claimRenewalIdleSeconds: limits.claimRenewalIdleMs / 1000,
        sessionIdleSeconds: limits.sessionIdleMs / 1000,
        openSessionIdleSeconds: limits.openSessionIdleMs / 1000,
        reconnectGraceSeconds: limits.reconnectGraceMs / 1000,
        drainSeconds: limits.drainMs / 1000,
        absoluteLifetimeSeconds: limits.absoluteLifetimeMs / 1000,
      },
    };
  }
}

export class GovernedMcpSession {
  private readonly liveness: McpLivenessState;
  private current: McpGovernedState = "open";
  private inFlight = 0;
  private requestResponses = 0;
  private deadlineTimer: McpTimer | null = null;
  private drainTimer: McpTimer | null = null;
  private expire: ((reason: McpPolicyCloseReason) => void) | null = null;
  private drained: (() => void) | null = null;
  private renewalStoppedByPolicy = false;
  private timerObserver: (kind: McpSessionTimerKind, delta: 1 | -1) => void = () => undefined;

  constructor(
    private readonly limits: McpSessionLimits,
    private readonly clock: McpSessionClock,
    private readonly release: () => void,
  ) {
    this.liveness = { createdAt: clock.now(), lastQualifyingActivityAt: null, openResponses: 0, streamObserved: false, interruptedAt: null };
  }

  get state(): McpGovernedState { return this.current; }
  get acceptsWork(): boolean { return this.current === "open"; }
  get transport(): McpTransportPhase { return transportPhase(this.liveness); }
  get lastQualifyingActivityAt(): number | null { return this.liveness.lastQualifyingActivityAt; }
  get renewalStopped(): boolean { return this.renewalStoppedByPolicy; }
  /** Pending policy deadline while the session is open. */
  get deadline(): McpSessionDeadline | null {
    return this.current === "open" && this.expire ? sessionDeadline(this.liveness, this.limits) : null;
  }

  /** Arm the session deadline; `onExpire` runs at most once. */
  start(onExpire: (reason: McpPolicyCloseReason) => void, observeTimers?: (kind: McpSessionTimerKind, delta: 1 | -1) => void): void {
    if (this.current !== "open" || this.expire) return;
    if (observeTimers) this.timerObserver = observeTimers;
    this.expire = onExpire;
    this.arm();
  }

  /**
   * Record an authenticated tool call or resource read. Returns true when
   * automatic renewal had stopped for idleness and may resume now.
   */
  activity(): boolean {
    const now = this.clock.now();
    this.liveness.lastQualifyingActivityAt = now;
    this.liveness.interruptedAt = this.liveness.openResponses === 0 ? now : null;
    const resumed = this.renewalStoppedByPolicy;
    this.renewalStoppedByPolicy = false;
    return resumed && this.current === "open";
  }

  /** Decide one automatic renewal; a refusal leaves the lease to expire with its remaining TTL. */
  renewalAllowed(): boolean {
    if (this.current !== "open") return false;
    const allowed = claimRenewalAllowed(this.liveness, this.limits, this.clock.now());
    if (!allowed) this.renewalStoppedByPolicy = true;
    return allowed;
  }

  /** Count one accepted protocol handler until its actual settlement. */
  callStarted(): () => void {
    this.inFlight += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.inFlight -= 1;
      this.settle();
    };
  }

  openResponse(): McpResponseHandle {
    this.liveness.openResponses += 1;
    this.requestResponses += 1;
    let stream = false;
    let closed = false;
    this.arm();
    return {
      markStream: () => {
        if (closed || stream) return;
        stream = true;
        this.requestResponses -= 1;
        this.liveness.streamObserved = true;
        this.arm();
        this.settle();
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.liveness.openResponses -= 1;
        if (!stream) this.requestResponses -= 1;
        if (this.liveness.openResponses === 0 && this.liveness.interruptedAt === null) this.liveness.interruptedAt = this.clock.now();
        this.arm();
        this.settle();
      },
    };
  }

  /**
   * Stop admitting work and stop the deadline. `onDrained` runs once, when
   * accepted calls and their responses settle or after the drain bound.
   */
  beginDrain(onDrained: () => void): void {
    if (this.current !== "open") return;
    this.current = "draining";
    this.expire = null;
    this.clearDeadline();
    this.drained = onDrained;
    if (this.inFlight === 0 && this.requestResponses === 0) {
      this.finishDrain();
      return;
    }
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = null;
      this.timerObserver("drain", -1);
      this.finishDrain();
    }, this.limits.drainMs);
    this.timerObserver("drain", 1);
  }

  /** Final close. Admission is released once accepted work and open responses settle. */
  markClosed(): void {
    if (this.current === "closed") return;
    this.current = "closed";
    this.expire = null;
    this.drained = null;
    this.clearDeadline();
    this.clearDrain();
    this.settle();
  }

  private settle(): void {
    if (this.current === "draining" && this.inFlight === 0 && this.requestResponses === 0) this.finishDrain();
    if (this.current === "closed" && this.inFlight === 0 && this.liveness.openResponses === 0) this.release();
  }

  private finishDrain(): void {
    this.clearDrain();
    const drained = this.drained;
    this.drained = null;
    drained?.();
  }

  private arm(): void {
    if (this.current !== "open" || !this.expire) return;
    this.clearDeadline();
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, sessionDeadline(this.liveness, this.limits).at - this.clock.now()));
    this.deadlineTimer = this.clock.setTimeout(() => this.check(), delay);
    this.timerObserver("deadline", 1);
  }

  private check(): void {
    this.deadlineTimer = null;
    this.timerObserver("deadline", -1);
    if (this.current !== "open" || !this.expire) return;
    const deadline = sessionDeadline(this.liveness, this.limits);
    if (this.clock.now() < deadline.at) {
      this.arm();
      return;
    }
    const expire = this.expire;
    this.expire = null;
    expire(deadline.reason);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer === null) return;
    this.clock.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.timerObserver("deadline", -1);
  }

  private clearDrain(): void {
    if (this.drainTimer === null) return;
    this.clock.clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.timerObserver("drain", -1);
  }
}
