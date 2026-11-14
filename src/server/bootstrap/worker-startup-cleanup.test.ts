import { describe, expect, it } from "vitest";
import { abandonWorkerStartup } from "./worker-startup-cleanup";

function recorder() {
  const calls: string[] = [];
  const step = (name: string, failure?: Error) => async () => {
    calls.push(name);
    await Promise.resolve();
    if (failure) throw failure;
  };
  const lock = (failure?: Error) => ({ release() { calls.push("lock"); if (failure) throw failure; } });
  return { calls, step, lock };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error("Expected a rejection."); }, (error: unknown) => error);
}

describe("abandonWorkerStartup", () => {
  it("runs the steps newest first, releases the lock and rejects with the original error", async () => {
    const { calls, step, lock } = recorder();
    const original = new Error("store failed");
    const steps = [step("store"), step("logs"), step("tests")];
    expect(await rejection(abandonWorkerStartup(original, steps, lock()))).toBe(original);
    expect(calls).toEqual(["tests", "logs", "store", "lock"]);
    // The caller's registration order is left as it was.
    expect(steps).toHaveLength(3);
  });

  it("continues after a rejecting step, still releases the lock and aggregates the failures", async () => {
    const { calls, step, lock } = recorder();
    const original = new Error("invalid origin");
    const logs = new Error("log write failed"), store = new Error("store close failed");
    const thrown = await rejection(abandonWorkerStartup(original, [step("store", store), step("logs", logs), step("worker")], lock()));
    expect(calls).toEqual(["worker", "logs", "store", "lock"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([original, logs, store]);
    expect((thrown as AggregateError).message).toBe("invalid origin; worker startup cleanup did not complete (2 failed steps).");
  });

  it("reports a failed lock release after the original error", async () => {
    const { calls, step, lock } = recorder();
    const original = new Error("constructor failed"), release = new Error("lock unreadable");
    const thrown = await rejection(abandonWorkerStartup(original, [step("store")], lock(release)));
    expect(calls).toEqual(["store", "lock"]);
    expect((thrown as AggregateError).errors).toEqual([original, release]);
  });

  it("treats a synchronously throwing step like a rejecting one", async () => {
    const { calls, lock } = recorder();
    const original = new Error("git failed"), sync = new Error("sync close failed");
    const thrown = await rejection(abandonWorkerStartup(original, [() => { calls.push("root"); }, () => { calls.push("git"); throw sync; }], lock()));
    expect(calls).toEqual(["git", "root", "lock"]);
    expect((thrown as AggregateError).errors).toEqual([original, sync]);
  });

  it("keeps no timer or handle alive after any outcome", async () => {
    const before = process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length;
    const { step, lock } = recorder();
    await rejection(abandonWorkerStartup(new Error("failed"), [step("logs", new Error("close failed"))], lock(new Error("release failed"))));
    expect(process.getActiveResourcesInfo().filter(kind => kind === "Timeout").length).toBe(before);
  });
});
