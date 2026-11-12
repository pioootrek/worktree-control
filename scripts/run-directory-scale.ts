/**
 * Opt-in scale measurement for run-directory removal (`pnpm test:run-directory-scale`).
 *
 * Builds, under a private temporary directory, a wide tree of 200,000 empty
 * files spread over a few directories and a chain of 400 nested directories,
 * then removes each with the production removal function. Reports wall time,
 * the longest event-loop delay during removal, peak RSS and the most open
 * descriptors sampled, and fails when the event loop is blocked longer than
 * 250 ms at a time. Files are empty: on a RAM-backed tmpfs they then use no
 * data pages, and removal cost is per entry, not per byte.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { removeOwnedTree } from "../src/server/infrastructure/run-directories/owned-tree-removal";

const WIDE_FILES = 200_000;
const WIDE_DIRECTORIES = 4;
const DEPTH = 400;
const MAX_BLOCKED_MS = 250;
const CREATE_BATCH = 256;

const base = mkdtempSync(join(tmpdir(), "wtc-scale-"));
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  rmSync(base, { recursive: true, force: true });
}
process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { cleanup(); process.exit(1); });
}

async function createWide(path: string): Promise<void> {
  mkdirSync(path);
  const perDirectory = Math.ceil(WIDE_FILES / WIDE_DIRECTORIES);
  for (let directory = 0; directory < WIDE_DIRECTORIES; directory += 1) {
    const parent = join(path, `d${directory}`);
    mkdirSync(parent);
    for (let start = 0; start < perDirectory; start += CREATE_BATCH) {
      const batch: Promise<void>[] = [];
      for (let index = start; index < Math.min(start + CREATE_BATCH, perDirectory); index += 1) batch.push(writeFile(join(parent, `f${index}`), ""));
      await Promise.all(batch);
    }
  }
}

function createDeep(path: string): void {
  mkdirSync(path);
  let current = path;
  for (let level = 0; level < DEPTH; level += 1) {
    current = join(current, "d");
    mkdirSync(current);
    writeFileSync(join(current, "f"), "");
  }
}

function openDescriptors(): number {
  try { return readdirSync("/proc/self/fd").length; } catch { return -1; }
}

async function measure(label: string, path: string) {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  let peakRss = process.memoryUsage.rss();
  const baselineDescriptors = openDescriptors();
  let peakDescriptors = baselineDescriptors;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    peakDescriptors = Math.max(peakDescriptors, openDescriptors());
  }, 20);
  delay.enable();
  const started = performance.now();
  try {
    await removeOwnedTree(path, lstatSync(path));
  } finally {
    delay.disable();
    clearInterval(sampler);
  }
  const wallMs = performance.now() - started;
  let removed = false;
  try { lstatSync(path); } catch { removed = true; }
  return {
    label,
    removed,
    wallMs: Math.round(wallMs),
    maxEventLoopDelayMs: Math.round(delay.max / 1e6),
    p99EventLoopDelayMs: Math.round(delay.percentile(99) / 1e6),
    peakRssMiB: Math.round(peakRss / 1024 / 1024),
    baselineDescriptors,
    peakSampledDescriptors: peakDescriptors,
  };
}

async function main(): Promise<number> {
  const wide = join(base, "wide");
  const deep = join(base, "deep");
  let started = performance.now();
  await createWide(wide);
  console.log(JSON.stringify({ created: "wide", files: WIDE_FILES, directories: WIDE_DIRECTORIES, ms: Math.round(performance.now() - started) }));
  started = performance.now();
  createDeep(deep);
  console.log(JSON.stringify({ created: "deep", depth: DEPTH, ms: Math.round(performance.now() - started) }));

  const results = [await measure("wide", wide), await measure("deep", deep)];
  for (const result of results) console.log(JSON.stringify(result));
  console.log(JSON.stringify({ processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));

  const failures = results.flatMap(result => [
    ...(result.removed ? [] : [`${result.label}: tree not removed`]),
    ...(result.maxEventLoopDelayMs > MAX_BLOCKED_MS ? [`${result.label}: event loop blocked ${result.maxEventLoopDelayMs} ms > ${MAX_BLOCKED_MS} ms`] : []),
  ]);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (!failures.length) console.log("PASS run-directory removal scale");
  return failures.length ? 1 : 0;
}

main()
  .then(code => { cleanup(); process.exitCode = code; })
  .catch((error: unknown) => { cleanup(); console.error(error); process.exitCode = 1; });
