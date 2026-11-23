import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import UnitTestTotalsReporter, { compareFiles, expectedBlobNames, selectLatestBlobs, summarizeModules } from './unit-test-totals.mjs';

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
});

test('selects the latest attempt of each shard and keeps shards that were not run again', () => {
  const names = [
    'blob-1-4-attempt-1.json', 'blob-2-4-attempt-1.json', 'blob-4-4-attempt-1.json',
    'blob-3-4-attempt-2.json', 'blob-3-4-attempt-10.json', 'blob-3-4-attempt-1.json', 'blob-3-4-attempt-3.json',
  ];
  assert.deepEqual(selectLatestBlobs(names, 4), {
    selected: [
      { target: 'blob-1-4.json', source: 'blob-1-4-attempt-1.json', attempt: 1 },
      { target: 'blob-2-4.json', source: 'blob-2-4-attempt-1.json', attempt: 1 },
      { target: 'blob-3-4.json', source: 'blob-3-4-attempt-10.json', attempt: 10 },
      { target: 'blob-4-4.json', source: 'blob-4-4-attempt-1.json', attempt: 1 },
    ],
    superseded: ['blob-3-4-attempt-1.json', 'blob-3-4-attempt-2.json', 'blob-3-4-attempt-3.json'],
    missing: [],
    unexpected: [],
  });
});

test('reports missing shards and entries that are not attempt reports of this shard count', () => {
  const result = selectLatestBlobs([
    'blob-1-4-attempt-2.json', 'blob-3-4-attempt-1.json', 'blob-4-4-attempt-1.json',
    'blob-2-4.json', 'blob-5-5-attempt-1.json', 'blob-5-4-attempt-1.json', 'blob-2-4-attempt-0.json', 'blob-02-4-attempt-1.json',
  ], 4);
  assert.deepEqual(result.missing, ['blob-2-4.json']);
  assert.deepEqual(result.unexpected, ['blob-02-4-attempt-1.json', 'blob-2-4-attempt-0.json', 'blob-2-4.json', 'blob-5-4-attempt-1.json', 'blob-5-5-attempt-1.json']);
  assert.deepEqual(result.selected.map(entry => entry.source), ['blob-1-4-attempt-2.json', 'blob-3-4-attempt-1.json', 'blob-4-4-attempt-1.json']);
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
    for (const [name, content] of [['blob-1-2-attempt-1.json', 'one'], ['blob-2-2-attempt-1.json', 'two, failed'], ['blob-2-2-attempt-2.json', 'two, passed']]) {
      await writeFile(join(blobs, name), content);
    }
    const merge = join(directory, 'merge');
    const { stdout: selected } = await run('blobs', blobs, '2', merge);
    assert.match(selected, /Superseded by a later attempt: blob-2-2-attempt-1\.json\./);
    assert.deepEqual((await readdir(merge)).sort(), ['blob-1-2.json', 'blob-2-2.json']);
    assert.equal(await readFile(join(merge, 'blob-1-2.json'), 'utf8'), 'one');
    assert.equal(await readFile(join(merge, 'blob-2-2.json'), 'utf8'), 'two, passed');
    await assert.rejects(run('blobs', blobs, '2', merge), error => error.code === 1 && /not empty/.test(error.stderr));

    await rm(join(blobs, 'blob-2-2-attempt-1.json'));
    await rm(join(blobs, 'blob-2-2-attempt-2.json'));
    await assert.rejects(run('blobs', blobs, '2', join(directory, 'merge-missing')), error => error.code === 1 && /Missing: blob-2-2\.json/.test(error.stderr));
    await assert.rejects(run('blobs', join(directory, 'absent'), '2', join(directory, 'merge-absent')), error => error.code === 1);
    await assert.rejects(run('blobs', blobs, '2'), error => error.code === 2);

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
