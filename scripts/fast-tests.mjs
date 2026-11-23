// Fast unit-test tier for `pnpm test:fast`.
//
// Every file matched by the repository's vitest `include` rule runs here,
// in one vitest process with the configuration unchanged, unless its leading
// comment lines declare it heavy:
//
//   // test-tier: heavy (<short reason>)
//
// The full `pnpm check` still runs every file. This gate fails when a test
// fails, when a tier marker is malformed or misplaced, or when a fast-tier
// file takes longer than FAST_FILE_BUDGET_MS.

import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

/**
 * Per-file budget for a fast-tier file, in milliseconds: the time the file
 * spends importing its modules plus running its tests and hooks. Files are
 * classified heavy at about 3 s on a CI runner; this host runs the suite about
 * twice as slowly, and another queued job or agent can slow it further. Five
 * times the classification threshold leaves room for that load while still
 * catching a file that belongs in the heavy tier.
 */
export const FAST_FILE_BUDGET_MS = 15_000;

export const MARKER_EXAMPLE = "// test-tier: heavy (<what makes it slow>)";

const MARKER = /^\/\/ test-tier: (\S+) \(([^()]*)\)$/;
const REASON = /^[A-Za-z0-9](?:[A-Za-z0-9 ,./+'-]{1,58})[A-Za-z0-9]$/;
const KNOWN_TIERS = new Set(["heavy"]);
// Anything that looks like an attempt at a marker, in a line or block comment.
const MARKER_ATTEMPT = /(?:\/\/|\/\*|^\s*\*)\s*test[\s_-]*tiers?\b/i;
const HEADER_LINE = /^\s*(?:\/\/.*)?$/;

/**
 * Reads the tier marker of a test file from its whole source.
 *
 * The header is the run of lines at the top of the file that are empty or
 * line comments (`//`); the first other line (an import, a statement or a
 * block comment) ends it. Exactly one header line may be the marker, written
 * exactly as `// test-tier: heavy (<reason>)` from column 0, where the reason
 * is 3 to 60 characters of letters, digits, spaces and `,./+'-`, beginning and
 * ending with a letter or digit. A header line that resembles a marker but does
 * not match, an unknown tier, a second marker, or a marker-like comment after
 * the header, anywhere in the rest of the file, is an error, so a typo cannot
 * move a file between tiers.
 *
 * @param {string} source The complete file, decoded as UTF-8.
 * @returns {{ tier: "fast" } | { tier: "heavy", reason: string, line: number } | { error: string, line: number }}
 */
export function parseTierMarker(source) {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);

  let index = 0;
  let marker;
  for (; index < lines.length && HEADER_LINE.test(lines[index]); index += 1) {
    const line = lines[index].trimEnd();
    if (!MARKER_ATTEMPT.test(line)) continue;
    const lineNumber = index + 1;
    const match = MARKER.exec(line);
    if (!match) {
      return { error: `malformed test-tier marker; write it as "${MARKER_EXAMPLE}"`, line: lineNumber };
    }
    const [, tier, reason] = match;
    if (!KNOWN_TIERS.has(tier)) {
      return { error: `unknown test tier "${tier}"; the only tier marker is "${MARKER_EXAMPLE}"`, line: lineNumber };
    }
    if (!REASON.test(reason)) {
      return {
        error: `test-tier reason "${reason}" must be 3 to 60 characters of letters, digits, spaces and ,./+'- , beginning and ending with a letter or digit`,
        line: lineNumber,
      };
    }
    if (marker) {
      return { error: `second test-tier marker; the first is on line ${marker.line}`, line: lineNumber };
    }
    marker = { tier: "heavy", reason, line: lineNumber };
  }

  for (; index < lines.length; index += 1) {
    if (MARKER_ATTEMPT.test(lines[index])) {
      return {
        error: "test-tier marker after the first statement; it must be in the leading comment lines",
        line: index + 1,
      };
    }
  }

  return marker ?? { tier: "fast" };
}

/**
 * Splits candidate test files into the fast and heavy tiers.
 *
 * @param {{ file: string, source: string }[]} entries Candidate files with their complete sources.
 * @returns {{ fast: string[], heavy: { file: string, reason: string }[], errors: { file: string, line: number, message: string }[] }}
 */
export function selectTiers(entries) {
  const fast = [];
  const heavy = [];
  const errors = [];
  for (const { file, source } of entries) {
    const result = parseTierMarker(source);
    if ("error" in result) errors.push({ file, line: result.line, message: result.error });
    else if (result.tier === "heavy") heavy.push({ file, reason: result.reason });
    else fast.push(file);
  }
  return { fast, heavy, errors };
}

/**
 * Returns the fast-tier files that took longer than the budget, slowest first.
 *
 * @param {{ file: string, durationMs: number }[]} results Measured fast-tier files.
 * @param {number} [budgetMs]
 */
export function findOverBudget(results, budgetMs = FAST_FILE_BUDGET_MS) {
  return results.filter((result) => result.durationMs > budgetMs).sort((a, b) => b.durationMs - a.durationMs);
}

/** @param {{ file: string, durationMs: number }} result */
export function formatOverBudget(result, budgetMs = FAST_FILE_BUDGET_MS) {
  return [
    `${result.file} took ${formatSeconds(result.durationMs)}, over the fast-tier budget of ${formatSeconds(budgetMs)}.`,
    `  If it is slow by design, add this line at the top of the file, with a truthful reason:`,
    `  ${MARKER_EXAMPLE}`,
  ].join("\n");
}

/**
 * Returns the `count` slowest files.
 *
 * @param {{ file: string, durationMs: number }[]} results
 */
export function slowest(results, count = 5) {
  return [...results].sort((a, b) => b.durationMs - a.durationMs).slice(0, count);
}

/** @param {number} ms */
export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Vitest treats exclude entries as globs; accept only paths without glob syntax.
 *
 * @param {string} file
 */
export function isPlainRelativePath(file) {
  return /^[A-Za-z0-9._/-]+$/.test(file) && !file.startsWith("/") && !file.split("/").includes("..");
}

function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

async function main() {
  const startedAt = performance.now();
  const { createVitest, startVitest } = await import("vitest/node");

  // Candidate files: the configuration's own include/exclude rules.
  const lister = await createVitest("test", { watch: false });
  let root;
  let candidates;
  try {
    root = lister.config.root;
    const specifications = await lister.globTestSpecifications();
    candidates = [...new Set(specifications.map((specification) => specification.moduleId))]
      .map((moduleId) => toPosix(relative(root, moduleId)))
      .sort();
  } finally {
    await lister.close();
  }

  // Whole files: a marker attempt anywhere in a file must be seen to be rejected.
  const entries = candidates.map((file) => ({ file, source: readFileSync(`${root}/${file}`, "utf8") }));
  const { fast, heavy, errors } = selectTiers(entries);
  const unsafe = heavy.filter(({ file }) => !isPlainRelativePath(file));
  if (errors.length > 0 || unsafe.length > 0) {
    for (const error of errors) console.error(`${error.file}:${error.line}: ${error.message}`);
    for (const { file } of unsafe) console.error(`${file}: heavy test path contains glob syntax and cannot be excluded exactly`);
    console.error(`\ntest:fast: ${errors.length + unsafe.length} test-tier marker error(s); no tests were run.`);
    process.exitCode = 1;
    return;
  }
  if (fast.length === 0) {
    console.error("test:fast: no fast-tier test files were found.");
    process.exitCode = 1;
    return;
  }

  // Equivalent to `vitest run --exclude <heavy file>...` with the configuration unchanged.
  const vitest = await startVitest("test", [], {
    run: true,
    watch: false,
    cliExclude: heavy.map(({ file }) => file),
  });

  let failed = process.exitCode !== undefined && process.exitCode !== 0;
  const problems = [];
  const modules = vitest.state.getTestModules();
  const results = modules.map((module) => {
    const diagnostic = module.diagnostic();
    return {
      file: toPosix(relative(root, module.moduleId)),
      durationMs: diagnostic.collectDuration + diagnostic.duration,
      tests: [...module.children.allTests()].length,
      ok: module.ok(),
    };
  });

  const ran = new Set(results.map((result) => result.file));
  const expected = new Set(fast);
  const missing = fast.filter((file) => !ran.has(file));
  const unexpected = [...ran].filter((file) => !expected.has(file));
  if (missing.length > 0 || unexpected.length > 0) {
    failed = true;
    for (const file of missing) problems.push(`${file}: fast-tier file did not run`);
    for (const file of unexpected) problems.push(`${file}: ran although it is not in the fast tier`);
  }
  for (const result of results) {
    if (!result.ok) failed = true;
  }
  const unhandled = vitest.state.getUnhandledErrors().length;
  if (unhandled > 0) failed = true;

  const fastResults = results.filter((result) => expected.has(result.file));
  const overBudget = findOverBudget(fastResults);
  if (overBudget.length > 0) {
    failed = true;
    for (const result of overBudget) problems.push(formatOverBudget(result));
  }

  const testCount = results.reduce((sum, result) => sum + result.tests, 0);
  const failedFiles = results.filter((result) => !result.ok).length;
  const lines = [
    "",
    "test:fast summary",
    `  fast tier: ${results.length} files, ${testCount} tests${failedFiles > 0 ? `, ${failedFiles} files failed` : ""}`,
    `  left out as heavy: ${heavy.length} of ${candidates.length} files (run by pnpm check)`,
    `  total duration: ${formatSeconds(performance.now() - startedAt)} (budget per fast file: ${formatSeconds(FAST_FILE_BUDGET_MS)})`,
    "  slowest fast files:",
    ...slowest(fastResults).map((result) => `    ${formatSeconds(result.durationMs).padStart(7)}  ${result.file}`),
  ];
  if (unhandled > 0) lines.push(`  unhandled errors: ${unhandled}`);
  console.log(lines.join("\n"));
  if (problems.length > 0) console.error(`\n${problems.join("\n")}`);
  console.log(failed ? "\ntest:fast: FAILED" : "\ntest:fast: passed");

  process.exitCode = failed ? 1 : 0;
  // Same teardown as the vitest CLI: close, and exit if something keeps the process alive.
  await vitest.exit();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
