import assert from "node:assert/strict";
import test from "node:test";
import {
  FAST_FILE_BUDGET_MS,
  findOverBudget,
  formatOverBudget,
  isPlainRelativePath,
  parseTierMarker,
  selectTiers,
  slowest,
} from "./fast-tests.mjs";

const IMPORT = 'import { describe, expect, it } from "vitest";';

test("a file without a marker is in the fast tier", () => {
  assert.deepEqual(parseTierMarker(`${IMPORT}\n\ndescribe("x", () => {});\n`), { tier: "fast" });
  assert.deepEqual(parseTierMarker(""), { tier: "fast" });
  assert.deepEqual(parseTierMarker("// Explains the fixture.\n\n" + IMPORT), { tier: "fast" });
});

test("a well-formed marker in the leading comment lines makes a file heavy", () => {
  assert.deepEqual(parseTierMarker(`// test-tier: heavy (child processes)\n${IMPORT}\n`), {
    tier: "heavy",
    reason: "child processes",
    line: 1,
  });
  assert.deepEqual(
    parseTierMarker(`// Copyright note.\n\n// test-tier: heavy (durable SQLite migrations)\r\n${IMPORT}\n`),
    { tier: "heavy", reason: "durable SQLite migrations", line: 3 },
  );
  assert.deepEqual(parseTierMarker(`﻿// test-tier: heavy (hundreds of rows)\n${IMPORT}`), {
    tier: "heavy",
    reason: "hundreds of rows",
    line: 1,
  });
});

test("a malformed marker is an error, not a silent fast file", () => {
  for (const line of [
    "// test-tier: heavy",
    "// test-tier: heavy(child processes)",
    "// test-tier heavy (child processes)",
    "//test-tier: heavy (child processes)",
    "// test-tier:  heavy (child processes)",
    "// test-tier: heavy (child processes) because",
    "  // test-tier: heavy (child processes)",
    "// test_tier: heavy (child processes)",
    "// Test-Tier: heavy (child processes)",
    "// test-tiers: heavy (child processes)",
  ]) {
    const result = parseTierMarker(`${line}\n${IMPORT}\n`);
    assert.equal(result.line, 1, line);
    assert.match(result.error, /malformed test-tier marker/, line);
  }
});

test("an unknown tier or an invalid reason is an error", () => {
  assert.match(parseTierMarker(`// test-tier: fast (cheap)\n${IMPORT}`).error, /unknown test tier "fast"/);
  assert.match(parseTierMarker(`// test-tier: Heavy (child processes)\n${IMPORT}`).error, /unknown test tier "Heavy"/);
  for (const reason of ["", "ab", " child processes", "child processes ", "x".repeat(61), "child processes!", "rows: 500"]) {
    const result = parseTierMarker(`// test-tier: heavy (${reason})\n${IMPORT}`);
    assert.match(result.error ?? "", /reason/, reason);
  }
  assert.equal(parseTierMarker(`// test-tier: heavy (${"x".repeat(60)})\n${IMPORT}`).tier, "heavy");
  assert.equal(parseTierMarker(`// test-tier: heavy (abc)\n${IMPORT}`).tier, "heavy");
});

test("a second marker is an error", () => {
  const result = parseTierMarker(`// test-tier: heavy (child processes)\n// test-tier: heavy (real clocks)\n${IMPORT}`);
  assert.deepEqual(result, { error: "second test-tier marker; the first is on line 1", line: 2 });
});

test("a marker after the first statement is an error", () => {
  for (const source of [
    `${IMPORT}\n// test-tier: heavy (child processes)\n`,
    `${IMPORT}\n\ndescribe("x", () => {}); // test-tier: heavy (child processes)\n`,
    `/* License. */\n// test-tier: heavy (child processes)\n${IMPORT}\n`,
    `/**\n * test-tier: heavy (child processes)\n */\n${IMPORT}\n`,
  ]) {
    const result = parseTierMarker(source);
    assert.match(result.error ?? "", /after the first statement/, source);
  }
});

test("the whole file is scanned, so a marker attempt far below the header is an error", () => {
  const body = `describe("x", () => {});\n`.repeat(400);
  assert.ok(body.length > 4096);
  for (const attempt of ["// test-tier: heavy (child processes)", "// test-tier: hea", "  /* test tier */"]) {
    const source = `${IMPORT}\n${body}${attempt}\n${body}`;
    assert.deepEqual(
      parseTierMarker(source),
      { error: "test-tier marker after the first statement; it must be in the leading comment lines", line: 402 },
      attempt,
    );
  }
  assert.equal(parseTierMarker(`${IMPORT}\n${body}// test-tier: hea`).line, 402);
});

test("a valid first-line marker in a long file still makes it heavy", () => {
  const source = `// test-tier: heavy (child processes)\n${IMPORT}\n${`it("x", () => {});\n`.repeat(400)}`;
  assert.ok(source.length > 4096);
  assert.deepEqual(parseTierMarker(source), { tier: "heavy", reason: "child processes", line: 1 });
});

test("a long file without a marker is still fast", () => {
  const source = `// Explains the fixture.\n${IMPORT}\n${`it("x", () => {}); // tiers of retries\n`.repeat(400)}`;
  assert.ok(source.length > 4096);
  assert.deepEqual(parseTierMarker(source), { tier: "fast" });
});

test("selection splits files into tiers and collects every error", () => {
  const result = selectTiers([
    { file: "src/a.test.ts", source: IMPORT },
    { file: "src/b.test.ts", source: `// test-tier: heavy (network listeners)\n${IMPORT}` },
    { file: "src/c.test.ts", source: `// test-tier: heavy\n${IMPORT}` },
    { file: "src/d.test.ts", source: `${IMPORT}\n// test-tier: heavy (real clocks)` },
  ]);
  assert.deepEqual(result.fast, ["src/a.test.ts"]);
  assert.deepEqual(result.heavy, [{ file: "src/b.test.ts", reason: "network listeners" }]);
  assert.deepEqual(
    result.errors.map(({ file, line }) => [file, line]),
    [["src/c.test.ts", 1], ["src/d.test.ts", 2]],
  );
});

test("a fast file over the budget is reported with the marker to add", () => {
  const results = [
    { file: "src/quick.test.ts", durationMs: 900 },
    { file: "src/edge.test.ts", durationMs: FAST_FILE_BUDGET_MS },
    { file: "src/slow.test.ts", durationMs: FAST_FILE_BUDGET_MS + 2_200 },
    { file: "src/slower.test.ts", durationMs: FAST_FILE_BUDGET_MS * 3 },
  ];
  const over = findOverBudget(results);
  assert.deepEqual(over.map(({ file }) => file), ["src/slower.test.ts", "src/slow.test.ts"]);
  const message = formatOverBudget(over[1]);
  assert.match(message, /^src\/slow\.test\.ts took 17\.2 s, over the fast-tier budget of 15\.0 s\./);
  assert.match(message, /\/\/ test-tier: heavy \(<what makes it slow>\)/);
  assert.deepEqual(findOverBudget(results.slice(0, 2)), []);
});

test("the budget is several times the 3 s classification threshold", () => {
  assert.ok(FAST_FILE_BUDGET_MS >= 3 * 3_000);
});

test("slowest returns the slowest files without reordering the input", () => {
  const results = [1, 7, 3, 9, 5, 8].map((seconds) => ({ file: `src/${seconds}.test.ts`, durationMs: seconds * 1000 }));
  assert.deepEqual(slowest(results, 3).map(({ durationMs }) => durationMs), [9000, 8000, 7000]);
  assert.equal(results[0].durationMs, 1000);
  assert.equal(slowest(results).length, 5);
});

test("heavy files are excluded only by plain relative paths", () => {
  assert.ok(isPlainRelativePath("src/server/restore-recovery.test.ts"));
  for (const file of ["/abs/x.test.ts", "src/../x.test.ts", "src/[id].test.ts", "src/*.test.ts", "src/a b.test.ts"]) {
    assert.equal(isPlainRelativePath(file), false, file);
  }
});
