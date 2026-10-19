import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { OwnedProcessGroup } from "../src/server/owned-process-group";

/** Signals request cancellation; listeners stay installed until cleanup drains. */
export class ProbeSignals {
  readonly controller = new AbortController();
  private readonly interrupt = () => this.controller.abort(new Error("Resource cost probe interrupted"));
  constructor() {
    process.on("SIGTERM", this.interrupt);
    process.on("SIGINT", this.interrupt);
  }
  check() { this.controller.signal.throwIfAborted(); }
  async wait(ms: number) { await delay(ms, undefined, { signal: this.controller.signal }); }
  dispose() {
    process.off("SIGTERM", this.interrupt);
    process.off("SIGINT", this.interrupt);
  }
}

/** Register immediately after spawn, before awaiting any child event. */
export class ProbeGroups {
  private readonly groups: Array<Pick<OwnedProcessGroup, "stop">> = [];
  private cleanup: Promise<void> | null = null;
  constructor(private readonly own: (child: ChildProcess) => Pick<OwnedProcessGroup, "stop"> = child => new OwnedProcessGroup(child)) {}
  add(child: ChildProcess) { this.groups.push(this.own(child)); }
  stop(): Promise<void> {
    return this.cleanup ??= (async () => {
      // A failed group must not skip the others. Each OwnedProcessGroup stop is
      // bounded and checks only a freshly spawned group's ownership.
      const results = await Promise.allSettled(this.groups.map(group => group.stop()));
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Fixture cleanup was not confirmed");
    })();
  }
}
