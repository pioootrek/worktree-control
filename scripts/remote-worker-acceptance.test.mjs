import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const harness = fileURLToPath(new URL('./remote-worker-acceptance.mjs', import.meta.url));
const options = { skip: process.platform !== 'linux', timeout: 20_000 };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 5_000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const result = predicate();
    if (result) return result;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function processStat(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { state: fields[0], group: Number(fields[2]), startTicks: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

// No listener, database, package setup or descendant. This fixture deliberately
// matches the CLI's removal of BOTH signal handlers before asynchronous cleanup.
const fakeController = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[process.argv.indexOf('--browse-root') + 1];
const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
let closing = false;
const shutdown = signal => {
  closing = true;
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  save('cleanup-start.json', { signal });
};
const interrupt = () => shutdown('SIGINT');
const terminate = () => shutdown('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
setInterval(() => {
  if (!closing || !existsSync(join(root, 'release.json'))) return;
  save('cleanup-done.json', { completed: true });
  process.exit(JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).code);
}, 10);
// Independent of supervisor timers: even an assertion failure cannot leave this
// inert child running indefinitely. The test waits for its exit before removal.
setTimeout(() => process.exit(97), 8_000);
save('ready.json', { pid: process.pid });
`;

async function startTrial(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wtc-remote-acceptance-signal-')));
  const fixture = join(root, 'fake-controller.mjs');
  const wrapper = join(root, 'supervisor.mjs');
  writeFileSync(fixture, fakeController);
  writeFileSync(join(root, 'trial.json'), JSON.stringify({
    version: 1, role: 'broker', root, nodeExecutable: process.execPath,
    cliEntry: fixture, port: 49131, mcpPort: 49132, webRoot: root,
  }), { mode: 0o600 });
  writeFileSync(join(root, 'runtime.json'), '{}');
  writeFileSync(wrapper, `
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
// Only the isolated supervisor's clock is virtual. Child signals, spawn and
// exit handling execute the unmodified harness entrypoint and real OS boundary.
setTimeout(() => process.exit(98), 12_000).unref();
mock.timers.enable({ apis: ['setTimeout'] });
// The inert fake CLI does not need the trial's pinned distribution. Do not make
// the script-test suite depend on that separately provisioned Node executable.
Object.defineProperty(process, 'version', { value: 'v24.19.0' });
process.argv = [process.execPath, ${JSON.stringify(harness)}, 'run', '--root', ${JSON.stringify(root)}];
process.on('message', milliseconds => {
  mock.timers.tick(milliseconds);
  process.send(milliseconds);
});
process.channel.unref();
await import(pathToFileURL(process.argv[1]).href);
`);
  // This NEW session/group belongs exclusively to this test, never the runner.
  const supervisor = spawn(process.execPath, [wrapper], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let exit;
  let stderr = '';
  supervisor.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
  const exited = new Promise(resolve => {
    supervisor.once('error', error => { exit = { error: error.message }; resolve(exit); });
    supervisor.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
  });
  let controller;
  const release = (code = 0) => writeFileSync(join(root, 'release.json'), JSON.stringify({ code }));
  t.after(async () => {
    release();
    if (!exit) {
      supervisor.kill('SIGCONT'); // Resume our own paused child on assertion failure.
      supervisor.kill('SIGTERM');
    }
    await waitFor(() => exit, 'finite supervisor exit', 15_000);
    // No signal is sent to a PID read from disk. The inert child has its own
    // lifetime bound; retain the temp files until it actually stops executing.
    if (controller) await waitFor(() => {
      const current = processStat(controller.pid);
      return !current || current.startTicks !== controller.startTicks || current.state === 'Z';
    }, 'finite fake-controller exit', 10_000);
    rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => {
    assert.equal(exit, undefined, `Supervisor exited before readiness: ${stderr}`);
    return existsSync(join(root, 'ready.json')) && existsSync(join(root, 'controller-process.json'));
  }, 'controller readiness');
  controller = readJson(join(root, 'controller-process.json'));
  assert.equal(controller.pid, readJson(join(root, 'ready.json')).pid);
  assert.equal(processStat(supervisor.pid).group, supervisor.pid);
  return {
    root, supervisor, controller, release,
    alive: () => assert.equal(exit, undefined, stderr),
    async advance(milliseconds) {
      let acknowledged;
      const receive = message => { acknowledged = message; };
      supervisor.once('message', receive);
      try {
        supervisor.send(milliseconds);
        await waitFor(() => {
          assert.equal(exit, undefined, stderr);
          return acknowledged === milliseconds;
        }, 'supervisor clock acknowledgement');
      } finally {
        supervisor.removeListener('message', receive);
      }
    },
    async result() {
      await waitFor(() => exit, 'supervisor result');
      return { supervisor: await exited, child: readJson(join(root, 'controller-exit.json')), stderr };
    },
  };
}

for (const signal of ['SIGINT', 'SIGHUP']) {
  test(`terminal process-group ${signal} permits exactly one graceful child stop`, options, async t => {
    const trial = await startTrial(t);
    const { root, supervisor, controller } = trial;
    // Put the lifetime deadline just after the signal, within the graceful
    // shutdown window, so exercising it does not also expire that window.
    await trial.advance(30 * 60_000 - 1);
    // Hold the supervisor so that, with the original shared-group spawn, the
    // child's SIGINT handler definitely removes its handlers BEFORE forwarding.
    // With isolation the child never receives this terminal-like group signal.
    const childGroup = processStat(controller.pid).group;
    assert.equal(supervisor.kill('SIGSTOP'), true);
    await waitFor(() => processStat(supervisor.pid)?.state === 'T', 'paused supervisor');
    process.kill(-supervisor.pid, signal); // Only this test's newly spawned group.
    if (childGroup === supervisor.pid) {
      await waitFor(() => existsSync(join(root, 'cleanup-start.json')), 'original shared-group interrupt');
    }
    assert.equal(supervisor.kill('SIGCONT'), true);
    await waitFor(() => {
      trial.alive();
      return existsSync(join(root, 'cleanup-start.json'));
    }, 'graceful cleanup start');
    if (childGroup === supervisor.pid) {
      // Keep cleanup gated until the original harness has recorded the forwarded
      // second signal's actual result. This makes the red run independent of how
      // quickly an assertion failure would otherwise release the fake controller.
      const result = await trial.result();
      assert.equal(result.child.signal, null, `Cleanup interrupted: ${JSON.stringify(result.child)}`);
    }
    trial.alive();
    assert.deepEqual(readJson(join(root, 'cleanup-start.json')), { signal: 'SIGTERM' });
    assert.equal(existsSync(join(root, 'cleanup-done.json')), false);
    assert.equal(existsSync(join(root, 'controller-exit.json')), false);
    // Repeated stop signals and the lifetime deadline must not signal the child
    // again while its handlers are removed and cleanup is deliberately pending.
    supervisor.kill('SIGINT');
    supervisor.kill('SIGTERM');
    supervisor.kill('SIGHUP');
    await trial.advance(1);
    trial.alive();
    trial.release();
    const result = await trial.result();
    assert.deepEqual(result.supervisor, { code: 0, signal: null });
    assert.equal(result.child.code, 0);
    assert.equal(result.child.signal, null);
    assert.equal(result.child.shutdownTimedOut, false);
    assert.deepEqual(readJson(join(root, 'cleanup-done.json')), { completed: true });
  });
}

test('deadline stop remains attached after shutdown timeout and retains failure evidence', options, async t => {
  const trial = await startTrial(t);
  await trial.advance(30 * 60_000);
  await waitFor(() => existsSync(join(trial.root, 'cleanup-start.json')), 'deadline cleanup start');
  assert.deepEqual(readJson(join(trial.root, 'cleanup-start.json')), { signal: 'SIGTERM' });
  await trial.advance(45_000);
  trial.supervisor.kill('SIGINT');
  trial.supervisor.kill('SIGTERM');
  trial.supervisor.kill('SIGHUP');
  await trial.advance(45_000);
  trial.alive();
  assert.equal(existsSync(join(trial.root, 'controller-exit.json')), false);
  assert.equal(existsSync(join(trial.root, 'cleanup-done.json')), false);
  trial.release();
  const result = await trial.result();
  assert.deepEqual(result.supervisor, { code: 1, signal: null });
  assert.equal(result.child.code, 0);
  assert.equal(result.child.signal, null);
  assert.equal(result.child.shutdownTimedOut, true);
  assert.equal(result.stderr.match(/trial_shutdown_unconfirmed_preserve_root/g)?.length, 1);
  assert.deepEqual(readJson(join(trial.root, 'cleanup-done.json')), { completed: true });
});

test('supervisor records the actual nonzero child exit after graceful cleanup', options, async t => {
  const trial = await startTrial(t);
  trial.supervisor.kill('SIGTERM');
  await waitFor(() => existsSync(join(trial.root, 'cleanup-start.json')), 'cleanup start');
  trial.release(23);
  const result = await trial.result();
  assert.deepEqual(result.supervisor, { code: 1, signal: null });
  assert.equal(result.child.code, 23);
  assert.equal(result.child.signal, null);
  assert.equal(result.child.shutdownTimedOut, false);
  assert.match(result.stderr, /trial_controller_failed_preserve_root/);
  assert.deepEqual(readJson(join(trial.root, 'cleanup-done.json')), { completed: true });
});
