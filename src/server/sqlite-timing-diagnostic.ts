import { existsSync } from "node:fs";
import { afterAll } from "vitest";
import type { SqliteStateStore } from "./infrastructure/sqlite/sqlite-state-store";

const timings = new Map<string, number[]>();
export function recordTiming(label: string, started: number) {
  const values = timings.get(label) ?? [];
  values.push(performance.now() - started);
  timings.set(label, values);
}

export function timedSqliteStore(store: typeof SqliteStateStore): typeof SqliteStateStore {
  return new Proxy(store, {
    construct(target, args, newTarget) {
      const label = existsSync(args[0]) ? "existing-open" : "fresh-init";
      const started = performance.now();
      let outcome = "refused";
      try {
        const result = Reflect.construct(target, args, newTarget);
        outcome = "opened";
        return result;
      } finally { recordTiming(`${label}-${outcome}`, started); }
    },
  });
}

afterAll(() => {
  for (const [label, values] of timings) {
    values.sort((a, b) => a - b);
    const round = (value: number) => Math.round(value * 100) / 100;
    console.log("[DEBUG-a3-i23]", JSON.stringify({ label, count: values.length,
      minMs: round(values[0]), medianMs: round(values[Math.floor(values.length / 2)]),
      maxMs: round(values.at(-1)!), totalMs: round(values.reduce((a, b) => a + b, 0)) }));
  }
});
