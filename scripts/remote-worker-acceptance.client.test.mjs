import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { failedSha, fixedSha } from './remote-worker-acceptance.mjs';

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
  save('trial.json', { version: 1, root, role, identity, mcpPort: 49132, workspaceRoot: join(root, 'workspaces') });
  // Keep every production validator and the actual assertion/error provenance.
  // Only host observation is replaced; no rejection recorder or fake assertion.
  writeFileSync(join(scripts, 'remote-worker-acceptance.mjs'), `
export * from ${JSON.stringify(new URL('./remote-worker-acceptance.mjs', import.meta.url).href)};
export const hostIdentity = () => (${JSON.stringify(identity)});
`);
  return {
    root, save,
    run(name, args = []) {
      // Copy the actual entrypoint unchanged, including its main/error handling.
      copyFileSync(new URL(name, import.meta.url), join(scripts, name));
      return spawnSync(process.execPath, [join(scripts, name), ...(name === 'remote-worker-acceptance.mjs' ? ['provision'] : []), '--root', root, ...args], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      });
    },
  };
}

function clientFixture(t, { markerHost = worker.host, markerBoot = worker.boot, markerSha = fixedSha,
  executedSha = fixedSha, finishSha = fixedSha, cleanup = 'confirmed', identity = broker, externalError = null } = {}) {
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
  async connect() {
    if (${JSON.stringify(externalError)} !== null) throw Object.assign(new Error(${JSON.stringify(externalError)}), { name: 'LocalAssertionError', code: 'co_located_trial_rejected' });
  }
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
      assert.equal(result.status, 0, result.stderr);
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
    assert.equal(result.stderr, `acceptance_client_failed_preserve_state (check phase, prerequisites and private controller log): ${code}\n`);
    assert.equal(existsSync(join(trial.root, 'evidence', 'fixed-wait.json')), false);
  });
}

function auditFixture(t, { client = broker, cleanup = 'confirmed', acknowledgedSequence = 3,
  retainedWorkspace = false, externalError = null } = {}) {
  const trial = fixture(t, { identity: worker, role: 'worker' });
  const { root, save } = trial;
  save('controller-process.json', { pid: 2147483647, startTicks: '1', boot: worker.boot });
  save('controller-exit.json', { code: 0, signal: null, shutdownTimedOut: false });
  mkdirSync(join(root, 'broker-evidence'));
  mkdirSync(join(root, 'workspaces'));
  if (retainedWorkspace) save('workspaces/retained.json', { preserve: true });
  writeFileSync(join(root, 'owner.token'), 'inert-fixture-token\n', { mode: 0o600 });
  const receipts = [], bodies = {}, runs = [], assessment = [];
  for (const name of ['failed', 'fixed', 'disconnect', 'cancel']) {
    const sha = name === 'failed' ? failedSha : fixedSha;
    const phase = name === 'failed' ? 'failed' : name === 'cancel' ? 'cancelled' : 'succeeded';
    const preset = ['disconnect', 'cancel'].includes(name) ? 'node:test:remote:slow' : 'node:test:remote';
    const requestId = `request-${name}`, attemptId = `attempt-${name}`, localRunId = `run-${name}`;
    const parsed = (preset.endsWith(':slow') ? ['slow', 'descendant'] : ['test']).map((role, index) => ({
      version: 1, event: 'start', role, executionId: `${index + 3}3333333-3333-3333-3333-333333333333`,
      host: worker.host, boot: worker.boot, pid: 2147483647, startTicks: '1', sha,
      node: worker.node, at: '2026-10-26T10:00:00.000Z',
    }));
    const fingerprints = { presetFingerprint: 'c'.repeat(64), environmentFingerprint: 'd'.repeat(64) };
    save(`broker-evidence/${name}-wait.json`, { client, requestId, attemptId, localRunId,
      ...fingerprints, output: { markers: parsed } });
    save(`broker-evidence/${name}-replay.json`, { requestId, attemptId, localRunId });
    receipts.push({ assignment: { requestId, attemptId, commitSha: sha, presetId: preset, workerId: 'acceptance-worker' }, localRunId, reportCount: 3 });
    bodies[attemptId] = { acknowledgedSequence, reports: [{ phase, executedCommitSha: sha,
      execution: { cleanup }, source: { finishCommitSha: sha }, sequence: 3, ...fingerprints }] };
    runs.push({ id: localRunId, telemetry: { cleanup }, source: { finish: { head: sha } },
      logs: parsed.map(item => `WTC_ACCEPTANCE ${JSON.stringify(item)}`) });
    assessment.push({ attemptId, blocked: false, provenance: { host: worker.machine, boot: worker.boot } });
  }
  save('audit-fixture.json', { receipts, bodies, runs, assessment });
  // Public adapter stand-ins are inert. All gate conditions, markers and failure
  // diagnostics execute in the unchanged production audit entrypoint.
  const loadFixture = `import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(${JSON.stringify(join(root, 'audit-fixture.json'))}, 'utf8'));`;
  const stubs = {
    'controller-lock.ts': 'export const acquireControllerLock = () => ({ release() {} });',
    'sqlite-store.ts': `${loadFixture}
export class SqliteStateStore {
  remoteConnection = { receipts: () => fixture.receipts, receipt: id => fixture.bodies[id] };
  listTestRuns() { return fixture.runs; }
  getTestRun(id) { return fixture.runs.find(run => run.id === id); }
  close() {}
}`,
    'modules/identity/index.ts': 'export class IdentityService { authenticateBearer() { return {}; } }',
    'modules/remote-verification/index.ts': `${loadFixture}
export class WorkerRecoveryService {
  inspectAll() {
    if (${JSON.stringify(externalError)} !== null) throw Object.assign(new Error(${JSON.stringify(externalError)}), { name: 'LocalAssertionError', code: 'cleanup_unconfirmed' });
    return fixture.assessment;
  }
}`,
    'infrastructure/git/index.ts': 'export class LinuxWorkerRecoveryHost {}',
  };
  for (const [name, source] of Object.entries(stubs)) {
    const path = join(root, 'src', 'server', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
  return trial;
}

for (const [label, options, code] of [
  ['same machine despite spoofed hostname and different boot', { client: { ...broker, host: 'spoofed-worker', machine: worker.machine } }, 'co_located_trial_rejected'],
  ['same boot despite a different machine and hostname', { client: { ...broker, host: 'spoofed-worker', boot: worker.boot } }, 'co_located_trial_rejected'],
  ['unconfirmed cleanup', { cleanup: 'unconfirmed' }, 'cleanup_unconfirmed'],
  ['unacknowledged outbox', { acknowledgedSequence: 2 }, 'unacknowledged_outbox'],
  ['retained workspace', { retainedWorkspace: true }, 'retained_workspace_preserve_root'],
]) {
  test(`stopped worker audit rejects ${label} with a safe local diagnostic`, t => {
    const trial = auditFixture(t, options);
    const result = trial.run('remote-worker-acceptance.audit.mjs');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, `acceptance_audit_failed_preserve_roots (no cleanup or recovery performed): ${code}\n`);
    assert.equal(existsSync(join(trial.root, 'evidence', 'worker-audit.json')), false);
    assert.equal(existsSync(join(trial.root, 'trial.json')), true);
    if (options.retainedWorkspace) assert.deepEqual(readJson(join(trial.root, 'workspaces', 'retained.json')), { preserve: true });
  });
}

test('stopped worker audit accepts complete inert evidence for distinct machines with shared hostnames', t => {
  const trial = auditFixture(t);
  const result = trial.run('remote-worker-acceptance.audit.mjs');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const evidence = readJson(join(trial.root, 'evidence', 'worker-audit.json'));
  assert.equal(evidence.rows.length, 4);
  assert.equal(evidence.retainedWorkspaces, 0);
});

for (const message of [
  'syntheticcredentialabc123', // Also matches the old supervisor's message regex.
  'cleanup_unconfirmed', // Even an exact local gate code is untrusted here.
  `/private/syntheticcredentialabc123/${'secret'.repeat(400)}`,
]) {
  for (const name of ['client', 'audit']) {
    test(`${name} hides unknown external errors (${message.length} bytes)`, t => {
      const trial = name === 'client' ? clientFixture(t, { externalError: message }) : auditFixture(t, { externalError: message });
      const result = trial.run(`remote-worker-acceptance.${name}.mjs`);
      const context = name === 'client'
        ? 'acceptance_client_failed_preserve_state (check phase, prerequisites and private controller log)'
        : 'acceptance_audit_failed_preserve_roots (no cleanup or recovery performed)';
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stderr, context + '\n');
      assert.equal(result.stdout, '');
      assert.ok(Buffer.byteLength(result.stderr) < 256);
      assert.equal(existsSync(join(trial.root, 'trial.json')), true);
    });
  }
}

test('supervisor reports a genuine local manifest gate and preserves the root', t => {
  const trial = fixture(t);
  trial.save('trial.json', { version: 0 });
  const result = trial.run('remote-worker-acceptance.mjs');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'acceptance_phase_failed_preserve_root: trial_manifest_mismatch\n');
  assert.equal(existsSync(join(trial.root, 'trial.json')), true);
});

test('supervisor hides external filesystem paths and synthetic credentials', t => {
  const trial = fixture(t);
  const secretRoot = join(trial.root, 'wtc-remote-acceptance-syntheticcredentialabc123');
  // Use a canonical but absent root to exercise a real filesystem exception.
  const entry = join(trial.root, 'scripts', 'remote-worker-acceptance.mjs');
  copyFileSync(new URL('./remote-worker-acceptance.mjs', import.meta.url), entry);
  const external = spawnSync(process.execPath, [entry, 'provision', '--root', secretRoot], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(external.error, undefined);
  assert.equal(external.status, 1);
  assert.equal(external.stderr, 'acceptance_phase_failed_preserve_root\n');
  assert.equal(external.stdout, '');
});
