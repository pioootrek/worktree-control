import { describe, expect, it, vi } from "vitest";

import { ManualMcpClock } from "./manual-clock";
import { McpSessionGovernor } from "./session-governor";
import { defaultMcpSessionLimits, resolveMcpSessionLimits } from "./session-limits";
import { claimRenewalAllowed, sessionDeadline, type McpLivenessState } from "./session-liveness";

const MINUTE = 60_000;

describe("MCP session limits", () => {
  it("uses the measured defaults and rejects unusable overrides", () => {
    expect(resolveMcpSessionLimits()).toEqual({
      claimRenewalIdleMs: 15 * MINUTE, sessionIdleMs: 15 * MINUTE, openSessionIdleMs: 60 * MINUTE,
      reconnectGraceMs: 60_000, drainMs: 120_000, absoluteLifetimeMs: 8 * 60 * MINUTE, maxSessions: 64, maxSessionsPerCredential: 32,
    });
    expect(resolveMcpSessionLimits({ maxSessions: 80, sessionIdleMs: undefined })).toMatchObject({ maxSessions: 80, sessionIdleMs: 15 * MINUTE });
    expect(() => resolveMcpSessionLimits({ drainMs: 0 })).toThrow("drainMs must be a positive integer");
    expect(() => resolveMcpSessionLimits({ maxSessions: 1.5 })).toThrow("positive integer");
    expect(() => resolveMcpSessionLimits({ maxSessions: 8, maxSessionsPerCredential: 9 })).toThrow("cannot exceed");
    expect(() => resolveMcpSessionLimits({ bogus: 1 } as never)).toThrow("Unknown MCP session limit");
  });
});

describe("MCP session liveness decisions", () => {
  const limits = defaultMcpSessionLimits;
  const state = (overrides: Partial<McpLivenessState>): McpLivenessState => ({
    createdAt: 0, lastQualifyingActivityAt: null, openResponses: 0, streamObserved: true, interruptedAt: null, ...overrides,
  });

  it("closes a never-active session one grace after its first interruption", () => {
    expect(sessionDeadline(state({ interruptedAt: 5_000 }), limits)).toEqual({ at: 65_000, reason: "abandoned-transport" });
  });

  it("keeps an interrupted active session until its idle limit, with grace at most once", () => {
    expect(sessionDeadline(state({ lastQualifyingActivityAt: 0, interruptedAt: 1_000 }), limits)).toEqual({ at: 15 * MINUTE, reason: "abandoned-transport" });
    // An interruption just before the idle deadline adds at most one grace.
    expect(sessionDeadline(state({ lastQualifyingActivityAt: 0, interruptedAt: 15 * MINUTE - 1_000 }), limits).at).toBe(16 * MINUTE - 1_000);
  });

  it("gives open and never-streamed transports the longer idle budget", () => {
    expect(sessionDeadline(state({ openResponses: 1, lastQualifyingActivityAt: 10 * MINUTE }), limits)).toEqual({ at: 70 * MINUTE, reason: "idle-expired" });
    expect(sessionDeadline(state({ streamObserved: false, interruptedAt: 1_000 }), limits)).toEqual({ at: 60 * MINUTE, reason: "idle-expired" });
  });

  it("never exceeds the absolute lifetime", () => {
    expect(sessionDeadline(state({ openResponses: 1, lastQualifyingActivityAt: 8 * 60 * MINUTE - 1 }), limits)).toEqual({ at: 8 * 60 * MINUTE, reason: "absolute-lifetime" });
  });

  it("renews only within the claim idle window after qualifying activity", () => {
    expect(claimRenewalAllowed(state({}), limits, 1)).toBe(false);
    expect(claimRenewalAllowed(state({ lastQualifyingActivityAt: 0 }), limits, 15 * MINUTE - 1)).toBe(true);
    expect(claimRenewalAllowed(state({ lastQualifyingActivityAt: 0 }), limits, 15 * MINUTE)).toBe(false);
  });
});

describe("MCP session governor", () => {
  function setup(limits = {}) {
    const clock = new ManualMcpClock();
    return { clock, governor: new McpSessionGovernor({ maxSessions: 3, maxSessionsPerCredential: 2, ...limits }, clock) };
  }
  function admitted(governor: McpSessionGovernor, key: string) {
    const admission = governor.admit(key);
    if (!admission.admitted) throw new Error(`refused ${admission.scope}`);
    return admission.session;
  }

  it("refuses per credential and globally, and restores capacity only after settlement", () => {
    const { governor } = setup();
    const first = admitted(governor, "installation:a");
    admitted(governor, "installation:a");
    expect(governor.admit("installation:a")).toEqual({ admitted: false, scope: "credential", limit: 2 });
    const third = admitted(governor, "principal:b");
    expect(governor.admit("principal:c")).toEqual({ admitted: false, scope: "global", limit: 3 });
    expect(governor.describe().admission).toEqual({ admittedSessions: 3, credentials: 2, largestCredentialSessions: 2, limit: 3, perCredentialLimit: 2 });

    // A closed session with an accepted call still running keeps its slot.
    const settle = first.callStarted();
    first.markClosed();
    first.markClosed();
    expect(governor.admit("principal:c").admitted).toBe(false);
    settle();
    settle();
    expect(admitted(governor, "principal:c").state).toBe("open");
    third.markClosed();
    expect(governor.describe().admission).toMatchObject({ admittedSessions: 2, credentials: 2 });
  });

  it("expires at the policy deadline, and reconnects never restart the grace", () => {
    const { clock, governor } = setup();
    const session = admitted(governor, "legacy");
    const expire = vi.fn();
    session.start(expire);
    const stream = session.openResponse();
    stream.markStream();
    stream.close();
    clock.advance(30_000);
    const reconnect = session.openResponse();
    reconnect.markStream();
    clock.advance(10_000);
    reconnect.close();
    expect(session.transport).toBe("interrupted");
    clock.advance(19_999);
    expect(expire).not.toHaveBeenCalled();
    clock.advance(1);
    expect(expire).toHaveBeenCalledExactlyOnceWith("abandoned-transport");
  });

  it("starts grace at the first SSE interruption, not at initialize or discovery completion", () => {
    const { clock, governor } = setup();
    const session = admitted(governor, "legacy");
    const expire = vi.fn();
    session.start(expire);
    session.openResponse().close(); // initialize POST completes before SSE opens
    const stream = session.openResponse();
    stream.markStream();
    session.openResponse().close(); // discovery is not qualifying activity
    clock.advance(10 * MINUTE);
    stream.close();
    expect(session.deadline).toEqual({ at: clock.now() + MINUTE, reason: "abandoned-transport" });
    clock.advance(30_000);
    const reconnect = session.openResponse();
    reconnect.markStream();
    clock.advance(10_000);
    reconnect.close();
    clock.advance(19_999);
    expect(expire).not.toHaveBeenCalled();
    clock.advance(1);
    expect(expire).toHaveBeenCalledExactlyOnceWith("abandoned-transport");
  });

  it("keeps a reconnected session within grace and lets activity move the deadline later", () => {
    const { clock, governor } = setup();
    const session = admitted(governor, "legacy");
    const expire = vi.fn();
    session.start(expire);
    const call = session.openResponse();
    session.activity();
    call.close();
    const stream = session.openResponse();
    stream.markStream();
    clock.advance(10 * MINUTE);
    stream.close();
    clock.advance(30_000);
    session.openResponse().markStream();
    clock.advance(49 * MINUTE);
    expect(expire).not.toHaveBeenCalled();
    expect(session.deadline).toEqual({ at: clock.now() + 30_000, reason: "idle-expired" });
    clock.advance(30_000);
    expect(expire).toHaveBeenCalledExactlyOnceWith("idle-expired");
  });

  it("stops renewal after the idle window and resumes on activity", () => {
    const { clock, governor } = setup();
    const session = admitted(governor, "legacy");
    session.start(() => undefined);
    expect(session.renewalAllowed()).toBe(false);
    expect(session.activity()).toBe(true);
    clock.advance(15 * MINUTE - 1);
    expect(session.renewalAllowed()).toBe(true);
    clock.advance(1);
    expect(session.renewalAllowed()).toBe(false);
    expect(session.renewalStopped).toBe(true);
    expect(session.activity()).toBe(true);
    expect(session.renewalStopped).toBe(false);
    expect(session.activity()).toBe(false);
  });

  it("drains accepted calls until their responses close, bounded by the drain limit", () => {
    const { clock, governor } = setup();
    const quick = admitted(governor, "legacy");
    quick.start(() => undefined);
    const response = quick.openResponse();
    const settle = quick.callStarted();
    const drained = vi.fn();
    quick.beginDrain(drained);
    expect(quick.acceptsWork).toBe(false);
    settle();
    expect(drained).not.toHaveBeenCalled();
    response.close();
    expect(drained).toHaveBeenCalledOnce();

    const hung = admitted(governor, "legacy");
    hung.start(() => undefined);
    hung.openResponse();
    const settleHung = hung.callStarted();
    const timedOut = vi.fn();
    hung.beginDrain(timedOut);
    clock.advance(119_999);
    expect(timedOut).not.toHaveBeenCalled();
    clock.advance(1);
    expect(timedOut).toHaveBeenCalledOnce();
    hung.markClosed();
    // The unconfirmed call remains counted against admission until it settles.
    expect(governor.describe().admission.admittedSessions).toBe(2);
    settleHung();
  });

  it("disposes every timer and reports timer gauges back to zero", () => {
    const { clock, governor } = setup();
    const gauges = { deadline: 0, drain: 0 };
    const session = admitted(governor, "legacy");
    session.start(() => undefined, (kind, delta) => { gauges[kind] += delta; });
    const response = session.openResponse();
    session.callStarted();
    expect(gauges).toEqual({ deadline: 1, drain: 0 });
    session.beginDrain(() => undefined);
    expect(gauges).toEqual({ deadline: 0, drain: 1 });
    session.markClosed();
    response.close();
    expect(gauges).toEqual({ deadline: 0, drain: 0 });
    expect(clock.pendingTimers).toBe(0);
  });
});
