import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import UnitTestTotalsReporter, { compareBlobNames, compareFiles, expectedBlobNames, summarizeModules } from './unit-test-totals.mjs';

const exec = promisify(execFile);
const script = new URL('./unit-test-totals.mjs', import.meta.url).pathname;

function testModule(moduleId, state, cases, duration) {
  return {
    moduleId,
    state: () => state,
    diagnostic: () => ({ duration, collectDuration: 1.4, setupDuration: 0, prepareDuration: 2.6, environmentSetupDuration: 0 }),
    children: { *allTests() { yield* cases.map(([caseState, mode = 'run']) => ({ options: { mode }, result: () => ({ state: caseState }) })); } },
  };
}

test('expects one blob report per shard under the blob reporter names', () => {
  assert.deepEqual(expectedBlobNames(4), ['blob-1-4.json', 'blob-2-4.json', 'blob-3-4.json', 'blob-4-4.json']);
  assert.throws(() => expectedBlobNames(0), /positive integer/);
  assert.deepEqual(compareBlobNames(['blob-1-4.json', 'blob-3-4.json', 'blob-4-4.json', 'blob-5-5.json'], 4),
    { missing: ['blob-2-4.json'], unexpected: ['blob-5-5.json'] });
  assert.deepEqual(compareBlobNames(expectedBlobNames(4), 4), { missing: [], unexpected: [] });
});

test('reports listed files that are missing, unexpected or reported twice', () => {
  assert.deepEqual(compareFiles(['a', 'b', 'c'], ['a', 'c', 'd', 'c']), { missing: ['b'], unexpected: ['d'], duplicates: ['c'] });
  assert.deepEqual(compareFiles(['a', 'b'], ['b', 'a']), { missing: [], unexpected: [], duplicates: [] });
});

test('summarizes test states and orders files by duration', () => {
  const summary = summarizeModules([
    testModule('/repo/src/a.test.ts', 'passed', [['passed'], ['skipped'], ['skipped', 'todo']], 10.4),
    testModule('/repo/src/b.test.ts', 'failed', [['passed'], ['failed'], ['pending']], 250.6),
  ], '/repo');
  assert.equal(summary.fileCount, 2);
  assert.deepEqual(summary.tests, { total: 6, passed: 2, failed: 1, skipped: 1, todo: 1, pending: 1 });
  assert.deepEqual(summary.files.map(file => [file.file, file.state, file.durationMs]), [['src/b.test.ts', 'failed', 251], ['src/a.test.ts', 'passed', 10]]);
  assert.deepEqual(summary.files[1], {
    file: 'src/a.test.ts', state: 'passed', tests: { total: 3, passed: 1, failed: 0, skipped: 1, todo: 1, pending: 0 },
    durationMs: 10, collectMs: 1, setupMs: 0, prepareMs: 3, environmentSetupMs: 0,
  });
});

test('the reporter writes its totals to --outputFile.totals and refuses to run without it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wtc-unit-totals-'));
  try {
    const reporter = new UnitTestTotalsReporter();
    reporter.onInit({ config: { root: directory, outputFile: { totals: 'out/totals.json' } } });
    await reporter.onTestRunEnd([testModule(join(directory, 'src/a.test.ts'), 'passed', [['passed']], 5)]);
    const written = JSON.parse(await readFile(join(directory, 'out/totals.json'), 'utf8'));
    assert.equal(written.fileCount, 1);
    assert.equal(written.files[0].file, 'src/a.test.ts');

    const bare = new UnitTestTotalsReporter();
    bare.onInit({ config: { root: directory, outputFile: 'report.json' } });
    await assert.rejects(bare.onTestRunEnd([]), /--outputFile\.totals/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the commands fail on a missing shard report and on a file-count mismatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wtc-unit-totals-'));
  const run = (...args) => exec(process.execPath, [script, ...args], { cwd: directory });
  try {
    const blobs = join(directory, 'blobs');
    await mkdir(blobs);
    for (const name of ['blob-1-2.json', 'blob-2-2.json']) await writeFile(join(blobs, name), '[]');
    await run('blobs', blobs, '2');
    await rm(join(blobs, 'blob-2-2.json'));
    await assert.rejects(run('blobs', blobs, '2'), error => error.code === 1 && /Missing: blob-2-2\.json/.test(error.stderr));
    await assert.rejects(run('blobs', join(directory, 'absent'), '2'), error => error.code === 1);

    const list = join(directory, 'list.json');
    const totals = join(directory, 'totals.json');
    await writeFile(list, JSON.stringify([{ file: join(directory, 'src/a.test.ts') }, { file: join(directory, 'src/b.test.ts') }]));
    const summary = summarizeModules([testModule(join(directory, 'src/a.test.ts'), 'passed', [['passed']], 5)], directory);
    await writeFile(totals, JSON.stringify(summary));
    await assert.rejects(run('files', list, totals), error => error.code === 1 && /src\/b\.test\.ts/.test(error.stderr));

    summary.files.push({ ...summary.files[0], file: 'src/b.test.ts' });
    summary.fileCount = 2;
    await writeFile(totals, JSON.stringify(summary));
    const { stdout } = await run('files', list, totals);
    assert.match(stdout, /2 files \(vitest lists 2\)/);

    await assert.rejects(run('unknown'), error => error.code === 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
