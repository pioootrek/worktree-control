import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fixedSha } from './remote-worker-acceptance.mjs';

const broker = { host: 'ubuntu', machine: 'a'.repeat(64), boot: '11111111-1111-1111-1111-111111111111', node: 'v24.19.0' };
const worker = { host: 'ubuntu', machine: 'b'.repeat(64), boot: '22222222-2222-2222-2222-222222222222', node: 'v24.19.0' };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t, { identity = broker, role = 'broker' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wtc-remote-acceptance-identity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  mkdirSync(join(root, 'evidence'));
  const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
  save('package.json', { type: 'module' });
  save('trial.json', { version: 1, root, role, identity, mcpPort: 49132 });
  // Keep the production file/schema/marker validators. Only host observation and
  // failure recording are replaced, so fixtures need no real host identity.
  writeFileSync(join(scripts, 'remote-worker-acceptance.mjs'), `
export * from ${JSON.stringify(new URL('./remote-worker-acceptance.mjs', import.meta.url).href)};
import { assert as actualAssert } from ${JSON.stringify(new URL('./remote-worker-acceptance.mjs', import.meta.url).href)};
import { writeFileSync } from 'node:fs';
export const hostIdentity = () => (${JSON.stringify(identity)});
export const assert = (condition, code) => {
  if (!condition) writeFileSync(${JSON.stringify(join(root, 'rejection.json'))}, JSON.stringify({ code }));
  actualAssert(condition, code);
};
`);
  return {
    root, save,
    run(name, args = []) {
      // Copy the actual entrypoint unchanged, including its main/error handling.
      copyFileSync(new URL(name, import.meta.url), join(scripts, name));
      return spawnSync(process.execPath, [join(scripts, name), '--root', root, ...args], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      });
    },
  };
}

function clientFixture(t, { markerHost = worker.host, markerBoot = worker.boot, markerSha = fixedSha,
  executedSha = fixedSha, finishSha = fixedSha, cleanup = 'confirmed', identity = broker } = {}) {
  const trial = fixture(t, { identity });
  const { root, save } = trial;
  writeFileSync(join(root, 'owner.token'), 'inert-fixture-token\n', { mode: 0o600 });
  const result = { phase: 'succeeded', executedCommitSha: executedSha, localRunId: 'fixture-run', exitCode: 0,
    execution: { cleanup }, source: { finishCommitSha: finishSha, attribution: 'observed_match' },
    presetFingerprint: 'c'.repeat(64), environmentFingerprint: 'd'.repeat(64) };
  const marker = { version: 1, role: 'test', executionId: '33333333-3333-3333-3333-333333333333',
    host: markerHost, boot: markerBoot, sha: markerSha, node: 'v24.19.0', pid: 12345, startTicks: '1', at: '2026-10-26T10:00:00.000Z' };
  save('mcp-fixture.json', {
    status: { request: { commitSha: fixedSha }, attempt: { id: 'fixture-attempt', phase: 'succeeded' }, result },
    output: { requestId: 'fixture-request', attemptId: 'fixture-attempt',
      logs: ['start', 'passed'].map(event => `WTC_ACCEPTANCE ${JSON.stringify({ ...marker, event })}`) },
  });
  save('evidence/fixed-request.json', { requestId: 'fixture-request' });
  // Local SDK stand-ins have no network implementation. Every call still goes
  // through the production client's action, status and evidence validation.
  const sdk = join(root, 'node_modules', '@modelcontextprotocol', 'sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ type: 'module', exports: {
    './client/index.js': './client.mjs', './client/streamableHttp.js': './transport.mjs',
  } }));
  writeFileSync(join(sdk, 'transport.mjs'), 'export class StreamableHTTPClientTransport {}\n');
  writeFileSync(join(sdk, 'client.mjs'), `
import { readFileSync, writeFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(${JSON.stringify(join(root, 'mcp-fixture.json'))}, 'utf8'));
const calls = [];
export class Client {
  async connect() {}
  async listTools() { return { tools: ['submit_remote_verification', 'get_remote_verification', 'get_remote_verification_logs', 'cancel_remote_verification'].map(name => ({ name })) }; }
  async callTool({ name, arguments: input }) {
    calls.push({ name, input });
    let value;
    if (name === 'get_remote_verification') value = fixture.status;
    else if (name === 'get_remote_verification_logs') value = fixture.output;
    else if (name === 'submit_remote_verification') value = { id: 'fixture-request' };
    else throw new Error('unexpected_fixture_operation');
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  async close() { writeFileSync(${JSON.stringify(join(root, 'sdk-calls.json'))}, JSON.stringify(calls)); }
}
`);
  return trial;
}

for (const markerHost of ['ubuntu', 'worker-other']) {
  for (const action of ['wait', 'replay']) {
    test(`client ${action} accepts ${markerHost === broker.host ? 'shared' : 'distinct'} hostnames with a different boot`, t => {
      const trial = clientFixture(t, { markerHost });
      const result = trial.run('remote-worker-acceptance.client.mjs', ['--case', 'fixed', '--action', action]);
      assert.equal(result.error, undefined);
      const rejection = join(trial.root, 'rejection.json');
      assert.equal(result.status, 0, JSON.stringify({ stderr: result.stderr,
        rejection: existsSync(rejection) ? readJson(rejection) : null }));
      const evidence = readJson(join(trial.root, 'evidence', `fixed-${action}.json`));
      assert.equal(evidence.client.machine, broker.machine);
      assert.deepEqual(evidence.output.markers.map(item => item.host), [markerHost, markerHost]);
      assert.ok(evidence.output.markers.every(item => item.boot === worker.boot && item.sha === fixedSha));
      const calls = readJson(join(trial.root, 'sdk-calls.json'));
      assert.deepEqual(calls.map(call => call.name), action === 'replay'
        ? ['get_remote_verification', 'submit_remote_verification', 'get_remote_verification', 'get_remote_verification_logs']
        : ['get_remote_verification', 'get_remote_verification_logs']);
    });
  }
}

for (const [label, options, code] of [
  ['wrong marker SHA', { markerSha: 'e'.repeat(40) }, 'cross_host_marker_mismatch'],
  ['same boot despite a different hostname', { markerHost: 'spoofed-worker', markerBoot: broker.boot }, 'cross_host_marker_mismatch'],
  ['wrong executed SHA', { executedSha: 'e'.repeat(40) }, 'missing_exact_sha_cleanup_evidence'],
  ['wrong finish SHA', { finishSha: 'e'.repeat(40) }, 'missing_exact_sha_cleanup_evidence'],
  ['unconfirmed cleanup', { cleanup: 'unconfirmed' }, 'missing_exact_sha_cleanup_evidence'],
]) {
  test(`client rejects ${label}`, t => {
    const trial = clientFixture(t, options);
    const result = trial.run('remote-worker-acceptance.client.mjs', ['--case', 'fixed', '--action', 'wait']);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(readJson(join(trial.root, 'rejection.json')), { code });
    assert.equal(existsSync(join(trial.root, 'evidence', 'fixed-wait.json')), false);
  });
}

for (const [label, client] of [
  ['same machine despite spoofed hostname and different boot', { ...broker, machine: worker.machine }],
  ['same boot despite a different machine and hostname', { ...broker, boot: worker.boot }],
]) {
  test(`stopped worker audit rejects ${label}`, t => {
    const trial = fixture(t, { identity: { ...worker, host: 'worker-other' }, role: 'worker' });
    const { root, save } = trial;
    save('controller-process.json', { pid: 2147483647, startTicks: '1', boot: worker.boot });
    save('controller-exit.json', { code: 0, signal: null, shutdownTimedOut: false });
    mkdirSync(join(root, 'broker-evidence'));
    save('broker-evidence/failed-wait.json', { client });
    writeFileSync(join(root, 'owner.token'), 'inert-fixture-token\n', { mode: 0o600 });
    // The production audit must pass its stopped-process and cardinality gates
    // before rejecting the client identity. Never open a database/controller.
    const stubs = {
      'controller-lock.ts': 'export const acquireControllerLock = () => ({ release() {} });',
      'sqlite-store.ts': `export class SqliteStateStore {
        remoteConnection = { receipts: () => Array.from({ length: 4 }, () => ({})) };
        listTestRuns() { return Array.from({ length: 4 }, () => ({})); }
        close() {}
      }`,
      'modules/identity/index.ts': 'export class IdentityService { authenticateBearer() { return {}; } }',
      'modules/remote-verification/index.ts': 'export class WorkerRecoveryService { inspectAll() { return Array.from({ length: 4 }, () => ({})); } }',
      'infrastructure/git/index.ts': 'export class LinuxWorkerRecoveryHost {}',
    };
    for (const [name, source] of Object.entries(stubs)) {
      const path = join(root, 'src', 'server', name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, source);
    }
    const result = trial.run('remote-worker-acceptance.audit.mjs');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(readJson(join(root, 'rejection.json')), { code: 'co_located_trial_rejected' });
    assert.equal(existsSync(join(root, 'evidence', 'worker-audit.json')), false);
  });
}
