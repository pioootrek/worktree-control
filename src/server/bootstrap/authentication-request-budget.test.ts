import { describe, expect, it } from "vitest";
import { AuthenticationRequestBudget } from "./authentication-request-budget";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("shared browser and operations cookie request budget", () => {
  it("caps initiating work at twelve and keeps four of sixteen slots for completions", async () => {
    const owner = new AuthenticationRequestBudget(16, 4);
    // Both callers use the same acquisition. Operations cookies are initiating.
    const browser = Array.from({ length: 6 }, () => owner.acquire("initiating")!);
    const operations = Array.from({ length: 6 }, () => owner.acquire("initiating")!);
    expect(owner.active).toBe(12);
    expect(owner.acquire("initiating")).toBeNull();
    const completions = Array.from({ length: 4 }, () => owner.acquire("completion")!);
    expect(completions.every(Boolean)).toBe(true);
    expect(owner.active).toBe(16);
    expect(owner.acquire("completion")).toBeNull();
    for (const slot of [...browser, ...operations, ...completions]) { slot.responseFinished(); await slot.settle(Promise.resolve()); }
    expect(owner.active).toBe(0);
  });

  it.each(["response", "work"] as const)("releases only after both conditions, with %s first", async first => {
    const owner = new AuthenticationRequestBudget(1, 0), slot = owner.acquire("initiating")!, work = gate();
    const settlement = slot.settle(work.promise);
    if (first === "response") slot.responseFinished(); else { work.resolve(); await settlement; }
    expect(owner.active).toBe(1); expect(owner.acquire("completion")).toBeNull();
    if (first === "response") { work.resolve(); await settlement; } else slot.responseFinished();
    expect(owner.active).toBe(0);
    slot.responseFinished();
    expect(() => slot.settle(Promise.resolve())).toThrow("exactly once");
    expect(owner.active).toBe(0);
    expect(owner.acquire("initiating")).not.toBeNull();
  });

  it.each([false, true])("rejects a second settlement without changing accounting (released=%s)", async released => {
    const owner = new AuthenticationRequestBudget(1, 0), slot = owner.acquire("initiating")!;
    const first = gate(), later = gate();
    const settlement = slot.settle(first.promise);
    slot.responseFinished();
    if (released) { first.resolve(); await settlement; }
    const active = owner.active;
    expect(() => slot.settle(later.promise)).toThrow("exactly once");
    expect(owner.active).toBe(active);
    later.resolve(); await later.promise;
    expect(owner.active).toBe(active);
    first.resolve(); await settlement;
    expect(owner.active).toBe(0);
  });

  it("keeps disconnected/cancelled work owned until its actual settled promise ends", async () => {
    const owner = new AuthenticationRequestBudget(16, 4), work = gate();
    const slots = Array.from({ length: 12 }, () => owner.acquire("initiating")!);
    const settlements = slots.map(slot => { slot.responseFinished(); return slot.settle(work.promise); });
    expect(owner.acquire("initiating")).toBeNull();
    work.resolve(); await Promise.all(settlements);
    expect(owner.active).toBe(0); expect(owner.acquire("initiating")).not.toBeNull();
  });

  it("stops synchronously and retains outstanding ownership", async () => {
    const owner = new AuthenticationRequestBudget(16, 4), slot = owner.acquire("completion")!, work = gate();
    const settlement = slot.settle(work.promise);
    owner.stop(); owner.stop(); slot.responseFinished();
    expect(owner.active).toBe(1);
    expect(owner.acquire("initiating")).toBeNull(); expect(owner.acquire("completion")).toBeNull();
    work.resolve(); await settlement;
    expect(owner.active).toBe(0); expect(owner.acquire("completion")).toBeNull();
  });

  it("retains ownership when work settlement is unconfirmed", async () => {
    const owner = new AuthenticationRequestBudget(1, 0), slot = owner.acquire("completion")!;
    slot.responseFinished();
    await expect(slot.settle(Promise.reject(new Error("synthetic cleanup failure")))).rejects.toThrow("synthetic cleanup failure");
    expect(owner.active).toBe(1); expect(owner.acquire("completion")).toBeNull();
  });

  it.each([[0, 0], [65, 4], [16, -1], [16, 16], [16, 1.5]])("rejects invalid bounds %s/%s", (capacity, reserve) => {
    expect(() => new AuthenticationRequestBudget(capacity, reserve)).toThrow();
  });
});
