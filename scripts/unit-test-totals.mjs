#!/usr/bin/env node
// Totals of the sharded unit-test run in CI.
//
// As a vitest reporter, given to `vitest --merge-reports` together with
// `--outputFile.totals=<file>`, it writes the merged file and test counts and
// the per-file durations to <file>.
//
// As a command:
//   node scripts/unit-test-totals.mjs blobs <directory> <shard count> <merge directory>
//     fails unless the directory holds a report of every shard and nothing else,
//     and copies the report of each shard's latest run attempt into the empty
//     merge directory under the blob reporter's name;
//   node scripts/unit-test-totals.mjs files <vitest list --json file> <totals file>
//     fails unless the merged report covers exactly the files vitest lists.
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The file names vitest's blob reporter uses for `--shard=<index>/<count>`. */
export function expectedBlobNames(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer, got ${count}.`);
  return Array.from({ length: count }, (_, index) => `blob-${index + 1}-${count}.json`);
}

/** A shard's report from one run attempt: blob-<index>-<count>-attempt-<run attempt>.json. */
const attemptBlobName = /^blob-([1-9]\d*)-([1-9]\d*)-attempt-([1-9]\d*)\.json$/;

/**
 * Chooses the report of each shard's latest run attempt.
 * `selected` maps each blob reporter name to its source entry; `superseded` lists the reports of
 * earlier attempts, `missing` the shards without a report, `unexpected` every other entry.
 */
export function selectLatestBlobs(names, count) {
  const expected = expectedBlobNames(count);
  const latest = new Map();
  const unexpected = [];
  for (const name of names) {
    const match = attemptBlobName.exec(name);
    const [index, shardCount, attempt] = match ? match.slice(1).map(Number) : [];
    if (!match || shardCount !== count || index > count) {
      unexpected.push(name);
      continue;
    }
    const target = expected[index - 1];
    const current = latest.get(target);
    if (!current || attempt > current.attempt) latest.set(target, { source: name, attempt });
  }
  const selected = expected.filter(target => latest.has(target)).map(target => ({ target, ...latest.get(target) }));
  const chosen = new Set(selected.map(entry => entry.source));
  return {
    selected,
    superseded: names.filter(name => attemptBlobName.test(name) && !unexpected.includes(name) && !chosen.has(name)).sort(),
    missing: expected.filter(target => !latest.has(target)),
    unexpected: unexpected.sort(),
  };
}

/** Files listed but not reported, and files reported but not listed. */
export function compareFiles(listed, reported) {
  const listedSet = new Set(listed);
  const reportedSet = new Set(reported);
  return {
    missing: [...listedSet].filter(file => !reportedSet.has(file)).sort(),
    unexpected: [...reportedSet].filter(file => !listedSet.has(file)).sort(),
    duplicates: reported.filter((file, index) => reported.indexOf(file) !== index).sort(),
  };
}

const round = value => Math.round(value ?? 0);

/** Counts and durations of merged vitest test modules, longest file first; paths are relative to root. */
export function summarizeModules(testModules, root) {
  const tests = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, pending: 0 };
  const files = [];
  for (const testModule of testModules) {
    const counts = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, pending: 0 };
    for (const testCase of testModule.children.allTests()) {
      const state = testCase.options?.mode === "todo" ? "todo" : testCase.result().state;
      counts.total += 1;
      counts[state in counts ? state : "pending"] += 1;
    }
    for (const key of Object.keys(tests)) tests[key] += counts[key];
    const diagnostic = testModule.diagnostic();
    files.push({
      file: relative(root, testModule.moduleId),
      state: testModule.state(),
      tests: counts,
      durationMs: round(diagnostic.duration),
      collectMs: round(diagnostic.collectDuration),
      setupMs: round(diagnostic.setupDuration),
      prepareMs: round(diagnostic.prepareDuration),
      environmentSetupMs: round(diagnostic.environmentSetupDuration),
    });
  }
  files.sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file));
  return { fileCount: files.length, tests, files };
}

export default class UnitTestTotalsReporter {
  onInit(vitest) {
    this.vitest = vitest;
  }

  async onTestRunEnd(testModules) {
    const { root, outputFile } = this.vitest.config;
    const target = typeof outputFile === "object" && outputFile ? outputFile.totals : undefined;
    if (!target) throw new Error("unit-test-totals reporter needs --outputFile.totals=<file>.");
    const path = resolve(root, target);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(summarizeModules(testModules, root), null, 2)}\n`);
  }
}

async function readEntries(directory) {
  try {
    return await readdir(directory);
  } catch (cause) {
    if (cause?.code === "ENOENT") return [];
    throw cause;
  }
}

async function main([command, ...args]) {
  if (command === "blobs" && args.length === 3) {
    const [directory, countText, mergeDirectory] = args;
    const count = Number(countText);
    const { selected, superseded, missing, unexpected } = selectLatestBlobs(await readEntries(directory), count);
    if (missing.length || unexpected.length) {
      console.error(`Unit-test shard reports in ${directory} are incomplete.`);
      if (missing.length) console.error(`Missing: ${missing.join(", ")}`);
      if (unexpected.length) console.error(`Unexpected: ${unexpected.join(", ")}`);
      return 1;
    }
    await mkdir(mergeDirectory, { recursive: true });
    const present = await readEntries(mergeDirectory);
    if (present.length) {
      console.error(`The merge directory ${mergeDirectory} is not empty: ${present.sort().join(", ")}`);
      return 1;
    }
    for (const { target, source } of selected) await copyFile(join(directory, source), join(mergeDirectory, target));
    console.log(`All ${count} unit-test shard reports are present: ${selected.map(({ source }) => source).join(", ")}.`);
    if (superseded.length) console.log(`Superseded by a later attempt: ${superseded.join(", ")}.`);
    return 0;
  }
  if (command === "files" && args.length === 2) {
    const [listPath, totalsPath] = args;
    const root = process.cwd();
    const listed = JSON.parse(await readFile(listPath, "utf8")).map(entry => relative(root, entry.file));
    const totals = JSON.parse(await readFile(totalsPath, "utf8"));
    const { missing, unexpected, duplicates } = compareFiles(listed, totals.files.map(entry => entry.file));
    const { tests } = totals;
    console.log(`Merged unit tests: ${totals.fileCount} files (vitest lists ${listed.length}), ${tests.total} tests: ` +
      `${tests.passed} passed, ${tests.failed} failed, ${tests.skipped} skipped, ${tests.todo} todo, ${tests.pending} not run.`);
    if (missing.length || unexpected.length || duplicates.length) {
      if (missing.length) console.error(`Listed but not in the merged report:\n  ${missing.join("\n  ")}`);
      if (unexpected.length) console.error(`In the merged report but not listed:\n  ${unexpected.join("\n  ")}`);
      if (duplicates.length) console.error(`Reported by more than one shard:\n  ${duplicates.join("\n  ")}`);
      return 1;
    }
    return 0;
  }
  console.error("Usage: unit-test-totals.mjs blobs <directory> <shard count> <merge directory> | files <vitest list json> <totals json>");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
