import { describe, expect, it } from "vitest";
import { IssuanceWindow } from "./factor-issuance";

const limits = (change = {}) => ({ perPeer: { attempts: 2, windowMs: 100 }, global: { attempts: 100, windowMs: 100 }, peers: 3, nativeChallenges: 10, reservedContexts: 1, ...change });

describe("anonymous issuance window", () => {
  it("bounds one peer at its exact limit and resets after its window", () => {
    const window = new IssuanceWindow(limits());
    expect([window.admit("a", 0), window.admit("a", 1), window.admit("a", 2)]).toEqual([true, true, false]);
    expect(window.admit("b", 2)).toBe(true);
    expect(window.admit("a", 100)).toBe(true);
  });
  it("bounds all peers together, and a refused peer spends no global budget", () => {
    const window = new IssuanceWindow(limits({ global: { attempts: 3, windowMs: 100 } }));
    expect([window.admit("a", 0), window.admit("a", 0), window.admit("a", 0)]).toEqual([true, true, false]);
    expect([window.admit("b", 0), window.admit("c", 0)]).toEqual([true, false]);
    expect(window.admit("c", 100)).toBe(true);
  });
  it("never tracks more peers than its bound, refusing a new peer rather than evicting a live window", () => {
    const window = new IssuanceWindow(limits());
    for (const peer of ["a", "b", "c"]) expect(window.admit(peer, 0)).toBe(true);
    expect(window.admit("d", 1)).toBe(false);
    expect(window.peers).toBe(3);
    expect(window.admit("a", 1)).toBe(true);
    expect(window.admit("d", 100)).toBe(true);
    expect(window.peers).toBe(1);
  });
  it("removes a bounded batch of stale peers per call", () => {
    const window = new IssuanceWindow(limits({ peers: 64 }));
    for (let index = 0; index < 32; index++) window.admit(`peer-${index}`, 0);
    window.admit("fresh", 100);
    expect(window.peers).toBe(25);
  });
});
