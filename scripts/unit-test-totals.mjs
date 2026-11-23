#!/usr/bin/env node
// Totals of the sharded unit-test run in CI.
//
// As a vitest reporter, given to `vitest --merge-reports` together with
// `--outputFile.totals=<file>`, it writes the merged file and test counts and
// the per-file durations to <file>.
//
// As a command:
//   node scripts/unit-test-totals.mjs blobs <directory> <shard count>
//     fails unless the directory holds exactly one blob report per shard;
//   node scripts/unit-test-totals.mjs files <vitest list --json file> <totals file>
//     fails unless the merged report covers exactly the files vitest lists.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The file names vitest's blob reporter uses for `--shard=<index>/<count>`. */
export function expectedBlobNames(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer, got ${count}.`);
  return Array.from({ length: count }, (_, index) => `blob-${index + 1}-${count}.json`);
}

/** Missing and unexpected entries of a blob directory, compared with the expected shard reports. */
export function compareBlobNames(names, count) {
  const expected = expectedBlobNames(count);
  return {
    missing: expected.filter(name => !names.includes(name)),
    unexpected: names.filter(name => !expected.includes(name)).sort(),
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
  if (command === "blobs" && args.length === 2) {
    const [directory, countText] = args;
    const count = Number(countText);
    const { missing, unexpected } = compareBlobNames(await readEntries(directory), count);
    if (missing.length || unexpected.length) {
      console.error(`Unit-test shard reports in ${directory} are incomplete.`);
      if (missing.length) console.error(`Missing: ${missing.join(", ")}`);
      if (unexpected.length) console.error(`Unexpected: ${unexpected.join(", ")}`);
      return 1;
    }
    console.log(`All ${count} unit-test shard reports are present.`);
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
  console.error("Usage: unit-test-totals.mjs blobs <directory> <shard count> | files <vitest list json> <totals json>");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
