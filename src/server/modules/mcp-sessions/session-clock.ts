/** Timer port for session policy and claim renewal, replaceable by a manual clock in tests. */
export type McpTimer = unknown;

export interface McpSessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): McpTimer;
  clearTimeout(timer: McpTimer): void;
}

export const systemMcpSessionClock: McpSessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    // Session timers never keep the controller alive on their own.
    timer.unref();
    return timer;
  },
  clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout),
};
