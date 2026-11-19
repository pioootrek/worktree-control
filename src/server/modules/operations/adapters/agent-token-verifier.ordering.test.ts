import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentWorld, failure, hash, INVALID, token } from "./credential-verifier-fixture";

const events = vi.hoisted(() => [] as string[]);
// Observe the real constant-time comparison without measuring wall-clock time.
vi.mock("node:crypto", async original => {
  const crypto = await original<typeof import("node:crypto")>();
  return { ...crypto, timingSafeEqual: (...args: Parameters<typeof crypto.timingSafeEqual>) => {
    events.push("compare");
    return crypto.timingSafeEqual(...args);
  } };
});
beforeEach(() => { events.length = 0; });

describe("agent comparison precedes validation", () => {
  it.each(["valid", "wrong secret", "malformed hash", "missing"] as const)("compares before the remaining work for %s", kind => {
    const w = agentWorld(), read = w.reader.read, clock = w.clock.read;
    Object.defineProperty(w.row, "status", { get: () => { events.push("status"); return "active"; } });
    w.reader.read = id => { events.push("lookup"); return kind === "missing" ? null : read(id); };
    w.clock.read = () => { events.push("clock"); return clock(); };
    if (kind === "malformed hash") w.row.verifierHash = "malformed";
    const wire = kind === "wrong secret" ? token("wts", w.row.id) : w.secret;
    expect(failure(() => w.mint(wire))).toBe(kind === "valid" ? "succeeded" : INVALID);
    expect(events).toEqual(kind === "missing" ? ["lookup", "compare", "clock"] : ["lookup", "compare", "status", "clock"]);
  });

  it("copies the exact compared hash once, even if the reader's getter changes", () => {
    const w = agentWorld(), storedHash = w.row.verifierHash;
    let reads = 0;
    Object.defineProperty(w.row, "verifierHash", { get: () => ++reads === 1 ? storedHash : hash(token("wts", w.row.id)) });
    expect(w.agent.verify("agent_token", w.secret) !== null).toBe(true);
    expect(reads).toBe(1);
  });
});
