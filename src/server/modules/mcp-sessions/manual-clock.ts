import type { McpSessionClock, McpTimer } from "./session-clock";

/**
 * Deterministic clock for session-policy tests. It is not exported from the
 * module API and is never constructed by the controller.
 */
export class ManualMcpClock implements McpSessionClock {
  private current: number;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(start = Date.parse("2026-10-07T12:00:00.000Z"), private readonly sync: (now: number) => void = () => undefined) {
    this.current = start;
    this.sync(start);
  }

  now(): number { return this.current; }

  setTimeout(callback: () => void, delayMs: number): McpTimer {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback });
    return id;
  }

  clearTimeout(timer: McpTimer): void { this.timers.delete(timer as number); }

  get pendingTimers(): number { return this.timers.size; }

  /** Advance time, running due timers in deadline order, including timers they schedule. */
  advance(milliseconds: number): void {
    const target = this.current + milliseconds;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | null = null;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      if (next[1].at > this.current) { this.current = next[1].at; this.sync(this.current); }
      next[1].callback();
    }
    this.current = target;
    this.sync(target);
  }
}
