import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupResourceFixture } from './mcp-resource-cleanup.mjs';

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned fixture exited before its requested stop; measurement failed.');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('early owned-client exit still stops the controller and removes temporary state while preserving failure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wts-mcp-cleanup-'));
  const controller = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await once(controller, 'message');
    const client = spawn(process.execPath, ['-e', 'process.exit(17)'], { stdio: 'ignore' });
    await once(client, 'exit');
    assert.equal(client.exitCode, 17);
    await assert.rejects(cleanupResourceFixture({
      controller, cleanupClients: () => stop(client), stopController: stop,
      removeState: () => rm(base, { recursive: true, force: true }),
    }), /measurement failed/);
    assert.equal(controller.signalCode, 'SIGTERM');
    await assert.rejects(stat(base), { code: 'ENOENT' });
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) await stop(controller);
    await rm(base, { recursive: true, force: true });
  }
});

test('an already-exited controller permits state removal but never becomes a successful stop', async () => {
  const controller = spawn(process.execPath, ['-e', 'process.exit(19)'], { stdio: 'ignore' });
  await once(controller, 'exit');
  let removed = false;
  await assert.rejects(cleanupResourceFixture({
    controller, cleanupClients: async () => {}, stopController: stop,
    removeState: async () => { removed = true; },
  }), /measurement failed/);
  assert.equal(controller.exitCode, 19);
  assert.equal(removed, true);
});

test('state is retained when controller termination is unconfirmed', async () => {
  let removed = false;
  const controller = { exitCode: null, signalCode: null };
  await assert.rejects(cleanupResourceFixture({
    controller, cleanupClients: async () => {}, stopController: async () => { throw new Error('stop failed'); },
    removeState: async () => { removed = true; },
  }), /stop failed/);
  assert.equal(removed, false);
});
