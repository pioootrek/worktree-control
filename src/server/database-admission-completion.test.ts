import { afterEach, describe, expect, it, vi } from "vitest";
import { idleWithCompletion, type DatabaseAdmission } from "./database-admission";
import { ExclusiveConnectionError } from "./infrastructure/sqlite/exclusive-connection";

afterEach(() => vi.useRealTimers());
describe("bounded completion admission", () => {
  it.each(["success", "failure"] as const)("retains the %s outcome without replay after a refused re-admission", async kind => {
    vi.useFakeTimers();
    const failure = new Error("effect failed"), result = { done: true };
    const effect = vi.fn(async () => { if (kind === "failure") throw failure; return result; });
    let attempts = 0;
    const admission: Pick<DatabaseAdmission, "idle"> = { idle: async (operation, options) => {
      expect(options?.reserved).toBe(true); await operation();
      if (++attempts === 1) throw new ExclusiveConnectionError("admission_timeout", "fixture");
      return undefined as never;
    } };
    const pending = idleWithCompletion(admission, effect).then(value => ({ value }), error => ({ error }));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(kind === "success" ? { value: result } : { error: failure });
    expect(effect).toHaveBeenCalledOnce(); expect(attempts).toBe(2);
  });

  it("stops at the completion budget without repeating the effect", async () => {
    vi.useFakeTimers();
    const error = new ExclusiveConnectionError("queue_full", "fixture"), effect = vi.fn(async () => undefined);
    let attempts = 0;
    const admission: Pick<DatabaseAdmission, "idle"> = { idle: async operation => { await operation(); attempts++; throw error; } };
    const pending = idleWithCompletion(admission, effect, { deadlineMs: 80 }).catch(failure => failure);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(error); expect(effect).toHaveBeenCalledOnce(); expect(attempts).toBe(3);
  });

  it.each(["closed", "poisoned", "cancelled"] as const)("does not retry %s", async code => {
    const error = new ExclusiveConnectionError(code, "fixture"), effect = vi.fn(async () => undefined);
    let attempts = 0;
    const admission: Pick<DatabaseAdmission, "idle"> = { idle: async operation => { await operation(); attempts++; throw error; } };
    await expect(idleWithCompletion(admission, effect)).rejects.toBe(error);
    expect(effect).toHaveBeenCalledOnce(); expect(attempts).toBe(1);
  });

  it("starts its completion budget after long-running effects", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const effect = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 5_000)); return "done"; });
    const admission: Pick<DatabaseAdmission, "idle"> = { idle: async operation => {
      await operation(); if (++attempts === 1) throw new ExclusiveConnectionError("queue_full", "fixture"); return undefined as never;
    } };
    const pending = idleWithCompletion(admission, effect, { deadlineMs: 100 });
    await vi.runAllTimersAsync(); expect(await pending).toBe("done"); expect(effect).toHaveBeenCalledOnce();
  });
});
