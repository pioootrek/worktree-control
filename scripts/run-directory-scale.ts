/**
 * Opt-in scale measurement for run-directory removal (`pnpm test:run-directory-scale`).
 *
 * On two file systems, the operating system's temporary directory (RAM-backed
 * tmpfs on many Linux hosts) and a disk-backed directory inside the checkout
 * that Git ignores (`node_modules/.cache/`), it builds and removes with the
 * production removal function:
 *
 * - `wide`: 200,000 empty files spread over four directories;
 * - `deep`: a chain of 400 nested directories, each with one file;
 * - `siblings-5k` and `siblings-20k`: 5,000 and 20,000 sibling directories
 *   with one empty file each. Comparing the two shows whether removal time
 *   grows faster than linearly with the number of sibling directories.
 *
 * It reports wall time, the longest event-loop delay during removal, peak RSS
 * and the most open descriptors sampled, and fails when the event loop is
 * blocked longer than 250 ms at a time. Files are empty: on tmpfs they use no
 * data pages, and removal cost is per entry, not per byte. Each file system's
 * scratch directory is removed on success, failure and termination signals.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { removeOwnedTree } from "../src/server/infrastructure/run-directories/owned-tree-removal";

const WIDE_FILES = 200_000;
const WIDE_DIRECTORIES = 4;
const DEPTH = 400;
const SIBLING_COUNTS = [5_000, 20_000];
const MAX_BLOCKED_MS = 250;
const CREATE_BATCH = 256;

const diskParent = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
const bases: string[] = [];
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  for (const base of bases) {
    try { rmSync(base, { recursive: true, force: true }); }
    catch (error) { console.error(`cleanup of ${base} failed: ${String(error)}`); }
  }
}
process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => { cleanup(); process.exit(1); });
}

function scratchBase(parent: string): string {
  mkdirSync(parent, { recursive: true });
  const base = mkdtempSync(join(parent, "wtc-scale-"));
  bases.push(base);
  return base;
}

async function inBatches(count: number, create: (index: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < count; start += CREATE_BATCH) {
    const batch: Promise<void>[] = [];
    for (let index = start; index < Math.min(start + CREATE_BATCH, count); index += 1) batch.push(create(index));
    await Promise.all(batch);
  }
}

async function createWide(path: string): Promise<void> {
  mkdirSync(path);
  const perDirectory = Math.ceil(WIDE_FILES / WIDE_DIRECTORIES);
  for (let directory = 0; directory < WIDE_DIRECTORIES; directory += 1) {
    const parent = join(path, `d${directory}`);
    mkdirSync(parent);
    await inBatches(perDirectory, index => writeFile(join(parent, `f${index}`), ""));
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

async function createSiblings(path: string, count: number): Promise<void> {
  mkdirSync(path);
  await inBatches(count, async index => {
    const directory = join(path, `s${index}`);
    await mkdir(directory);
    await writeFile(join(directory, "f"), "");
  });
}

function openDescriptors(): number {
  try { return readdirSync("/proc/self/fd").length; } catch { return -1; }
}

async function measure(fileSystem: string, label: string, path: string, entries: number) {
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
    fileSystem,
    label,
    entries,
    removed,
    wallMs: Math.round(wallMs),
    microsecondsPerEntry: Math.round((wallMs * 1000) / entries),
    maxEventLoopDelayMs: Math.round(delay.max / 1e6),
    p99EventLoopDelayMs: Math.round(delay.percentile(99) / 1e6),
    peakRssMiB: Math.round(peakRss / 1024 / 1024),
    baselineDescriptors,
    peakSampledDescriptors: peakDescriptors,
  };
}

async function measureFileSystem(fileSystem: string, parent: string) {
  const base = scratchBase(parent);
  console.log(JSON.stringify({ fileSystem, base }));
  const results: Awaited<ReturnType<typeof measure>>[] = [];
  const wide = join(base, "wide");
  let started = performance.now();
  await createWide(wide);
  console.log(JSON.stringify({ fileSystem, created: "wide", files: WIDE_FILES, directories: WIDE_DIRECTORIES, ms: Math.round(performance.now() - started) }));
  results.push(await measure(fileSystem, "wide", wide, WIDE_FILES + WIDE_DIRECTORIES));

  const deep = join(base, "deep");
  createDeep(deep);
  results.push(await measure(fileSystem, "deep", deep, DEPTH * 2));

  for (const count of SIBLING_COUNTS) {
    const siblings = join(base, `siblings-${count}`);
    started = performance.now();
    await createSiblings(siblings, count);
    console.log(JSON.stringify({ fileSystem, created: `siblings-${count / 1000}k`, directories: count, ms: Math.round(performance.now() - started) }));
    results.push(await measure(fileSystem, `siblings-${count / 1000}k`, siblings, count * 2));
  }
  for (const result of results) console.log(JSON.stringify(result));
  const [small, large] = SIBLING_COUNTS.map(count => results.find(result => result.label === `siblings-${count / 1000}k`)!);
  // 1.0 is linear growth; clearly above it means time per sibling grows with their number.
  console.log(JSON.stringify({ fileSystem, siblingGrowth: Number(((large!.wallMs / small!.wallMs) / (SIBLING_COUNTS[1]! / SIBLING_COUNTS[0]!)).toFixed(2)) }));
  rmSync(base, { recursive: true, force: true });
  return results;
}

async function main(): Promise<number> {
  const results = [
    ...await measureFileSystem("os-temporary", tmpdir()),
    ...await measureFileSystem("checkout-disk", diskParent),
  ];
  console.log(JSON.stringify({ processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));

  const failures = results.flatMap(result => [
    ...(result.removed ? [] : [`${result.fileSystem}/${result.label}: tree not removed`]),
    ...(result.maxEventLoopDelayMs > MAX_BLOCKED_MS ? [`${result.fileSystem}/${result.label}: event loop blocked ${result.maxEventLoopDelayMs} ms > ${MAX_BLOCKED_MS} ms`] : []),
  ]);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (!failures.length) console.log("PASS run-directory removal scale");
  return failures.length ? 1 : 0;
}

main()
  .then(code => { cleanup(); process.exitCode = code; })
  .catch((error: unknown) => { cleanup(); console.error(error); process.exitCode = 1; });
