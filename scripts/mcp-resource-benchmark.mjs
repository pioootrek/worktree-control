#!/usr/bin/env node
// Finite isolated measurement. Never reads the installed controller's state or selects foreign PIDs.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, cpus, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { requestAdminSocket } from '../src/server/admin-socket.ts';
import { McpDiagnostics } from '../src/server/mcp-diagnostics.ts';
import { cleanupResourceFixture } from './mcp-resource-cleanup.mjs';
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist/cli/index.js');
const reportPath = process.argv[2] ?? join(root, 'test-results/mcp-resources.json');
const runs = Number(process.argv[3] ?? 3);
const proxyEntry = process.argv[4];
assert(proxyEntry, 'Usage: pnpm bench:mcp-resources REPORT RUNS /path/to/mcp-remote/dist/proxy.js');
const proxyPackage = JSON.parse(await readFile(resolve(dirname(proxyEntry), '../package.json'), 'utf8'));
assert.equal(proxyPackage.name, 'mcp-remote'); assert.equal(proxyPackage.version, '0.8.2');
const proxyEntrySha256 = createHash('sha256').update(await readFile(proxyEntry)).digest('hex');
assert(Number.isInteger(runs) && runs >= 1 && runs <= 3, 'Use 1–3 finite runs.');
assert.equal(process.platform, 'linux');
const hz = Number((await exec('getconf', ['CLK_TCK'])).stdout.trim());
const pageSize = Number((await exec('getconf', ['PAGESIZE'])).stdout.trim());
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  node: process.version, kernel: release(), cpuModel: cpus()[0]?.model, cpuCount: cpus().length, proxyVersion: proxyPackage.version, proxyEntrySha256, buildFingerprint: (await readFile(join(root, 'dist/build-source.sha256'), 'utf8')).trim(), cliSha256: createHash('sha256').update(await readFile(cli)).digest('hex'), benchmarkSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), hz, pageSize, runs: [], cleanup: 'pending' };
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function wait(read, label, ms = 15000) { const until = Date.now() + ms; while (Date.now() < until) { const r = await read(); if (r) return r; await delay(50); } throw new Error(`Timed out: ${label}`); }
async function processSample(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8'), fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { at: performance.now(), cpuTicks: Number(fields[11]) + Number(fields[12]), rssBytes: Number(fields[21]) * pageSize, startTicks: fields[19] };
}
async function measure(pid, seconds = 3, each = async () => {}) {
  const samples = [await processSample(pid)];
  for (let i = 0; i < seconds; i++) { await each(); await delay(1000); samples.push(await processSample(pid)); }
  const a = samples[0], b = samples.at(-1);
  assert.equal(a.startTicks, b.startTicks, 'Owned process identity changed.');
  return { samples, rssBytes: samples.map(s => s.rssBytes), cpuPercent: (b.cpuTicks - a.cpuTicks) / hz / ((b.at - a.at) / 1000) * 100, seconds: (b.at - a.at) / 1000 };
}
function launch(args, env = process.env) { const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); child.stdout.resume(); child.stderr.resume(); return child; }
async function stop(child, signal = 'SIGTERM') { if (child.exitCode !== null || child.signalCode !== null) throw new Error("Owned fixture exited before its requested stop; measurement failed."); child.kill(signal); await wait(() => child.exitCode !== null || child.signalCode !== null, 'owned child exit'); if (signal === 'SIGTERM') assert.equal(child.exitCode, 0, 'Fixture shutdown failed.'); }
let sequence = 0;
function loopSample(child) { const id = ++sequence; return new Promise((accept, reject) => { const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Event loop probe timeout')); }, 3000); const listener = msg => { if (msg.id === id) { clearTimeout(timer); child.off('message', listener); accept(msg.eventLoop); } }; child.on('message', listener); child.send({ id, kind: 'mcp-resource-sample' }); }); }
function ipc(child, command, args) { const id = ++sequence; return new Promise((accept, reject) => { const timer = setTimeout(() => end(new Error('Fixture IPC timeout.')), 25000); const onmessage = msg => { if (msg.id === id) end(msg.error ? new Error(msg.error) : null, msg.result); }; const end = (error, value) => { clearTimeout(timer); child.off('message', onmessage); if (error) reject(error); else accept(value); }; child.on('message', onmessage); child.send({ id, command, args }); }); }
const content = result => { assert(!result.isError, 'Tool returned an error.'); return JSON.parse(result.content.find(p => p.type === 'text').text); };
async function run(number) {
  const base = await mkdtemp(join(tmpdir(), 'wts-mcp-resources-')), data = join(base, 'data'), state = join(base, 'state'), repo = join(base, 'fixture');
  const env = { ...process.env, WORKTREE_CONTROL_DATA_DIR: data, WORKTREE_CONTROL_STATE_DIR: state };
  let token, p, m, app, endpoint;
  const result = { number, scenarios: [], cleanup: 'pending' }; report.runs.push(result);
  let controller, ownedClient, proxy, proxyClient; const directClients = [];
  const diag = () => requestAdminSocket(join(state, 'admin.sock'), { command: 'mcp-diagnostics' }, 5000, 64 * 1024);

  async function direct() { const t = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }); const c = new Client({ name: 'measurement', version: '1' }); await c.connect(t); directClients.push({ c, t }); return { c, t }; }
  async function point(name, extra = {}) { const snapshot = await diag(); assert(!JSON.stringify(snapshot).includes(token)); result.scenarios.push({ name, snapshot, controller: { ...await measure(controller.pid), eventLoop: await loopSample(controller) }, ...extra }); console.log(`Run ${number}: ${name}`); return snapshot; }
  try {
    await mkdir(repo); await mkdir(data, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
    p = await port(); m = await port(); app = await port(); endpoint = new URL(`http://127.0.0.1:${m}/mcp`);
    token = JSON.parse((await exec(process.execPath, [cli, 'auth', 'token', 'generate'], { env })).stdout).token;
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.mjs', test: 'node -e "setTimeout(()=>{},5000)"' } }));
    await writeFile(join(repo, 'server.mjs'), 'import {createServer} from "node:http"; createServer((q,s)=>s.end("ok")).listen(Number(process.env.PORT),"127.0.0.1");');
    for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']]) await exec('git', args, { cwd: repo });
    controller = launch(['--import', join(root, 'scripts/mcp-resource-probe.mjs'), cli, 'start', '--service-mode', '--host', '127.0.0.1', '--port', String(p), '--mcp-port', String(m), '--no-open', '--web-root', join(root, 'out'), '--browse-root', base], env);
    await wait(async () => { try { await diag(); return true; } catch { return false; } }, 'isolated admin listener');
    const req = async (path, body) => { const r = await fetch(`http://127.0.0.1:${p}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-worktree-control-token': token, Origin: `http://127.0.0.1:${p}` }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert(r.ok); return r.json(); };
    const projectId = (await req('/api/projects', { repositoryPath: repo, name: 'owned fixture', port: app, launchPreset: 'node' })).project.id;
    await delay(3000); await point('baseline');
    for (let i = 0; i < 3; i++) {
      const { c, t } = await direct(); await c.listTools(); await point(`connect-${i + 1}`);
      const start = performance.now(); await t.terminateSession(); await c.close();
      await wait(async () => (await diag()).mcp.logicalSessions === 0, 'DELETE cleanup');
      await point(`delete-${i + 1}`, { cleanupMs: performance.now() - start });
    }
    ownedClient = launch([join(root, 'scripts/mcp-fixture-client.mjs')], { ...env, MCP_FIXTURE_ENDPOINT: endpoint.href, MCP_FIXTURE_TOKEN: token });
    const sessionId = await new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error('Fixture initialize timeout')), 15000); ownedClient.on('message', msg => { if (msg.ready) { clearTimeout(timer); accept(msg.sessionId); } }); });
    const clientResource = await measure(ownedClient.pid);
    await point('owned-client-connected', { client: clientResource });
    await ipc(ownedClient, 'disconnect'); await wait(async () => (await diag()).mcp.openResponses === 0, 'transport disconnect');
    await point('transport-disconnected'); await delay(1000); await ipc(ownedClient, 'reconnect'); await point('transport-reconnected');
    const compact = content(await ipc(ownedClient, 'call', { name: 'get_project_status_compact', arguments: { projectId } }));
    const start = performance.now(), long = ipc(ownedClient, 'call', { name: 'wait_for_status_change', arguments: { projectId, cursor: compact.cursor, timeoutMs: 20000 } });
    await wait(async () => (await diag()).statusWaits.waiters === 1, 'long waiter admission'); await point('long-operation'); await long;
    await point('long-operation-complete', { durationMs: performance.now() - start });
    content(await ipc(ownedClient, 'call', { name: 'claim_project', arguments: { projectId, worktreePath: repo, reason: 'owned resource measurement', idempotencyKey: 'measurement-claim', ttlSeconds: 30, responseMode: 'compact' } }));
    const run = content(await ipc(ownedClient, 'call', { name: 'run_test', arguments: { projectId, worktreePath: repo, presetId: 'node:test', idempotencyKey: 'accepted-job' } }));
    await point('claim-before-crash'); const crashedAt = performance.now(); await stop(ownedClient, 'SIGKILL'); ownedClient = undefined;
    await delay(12000); await point('crash-after-renewal', { sinceCrashMs: performance.now() - crashedAt, client: { exited: true, rssBytes: 0 } });
    await delay(20000); await point('crash-after-original-ttl', { sinceCrashMs: performance.now() - crashedAt });
    // Delete only the fixture's own logical session; do not use force-release.
    const deletedAt = performance.now(); const deleted = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId } }); assert.equal(deleted.status, 200);
    await wait(async () => (await req('/api/dashboard')).projects?.[0]?.reservation === null, 'lease availability after DELETE', 35000);
    const availabilityMs = performance.now() - deletedAt;
    const stateRead = await direct();
    const status = content(await stateRead.c.callTool({ name: 'get_project_status_compact', arguments: { projectId } }));
    const test = content(await stateRead.c.callTool({ name: 'get_test_run', arguments: { runId: run.id } }));
    assert.equal(status.status.runtimePhase, 'running'); assert.equal(test.phase, 'passed');
    await stateRead.t.terminateSession(); await stateRead.c.close(); await point('lease-available-server-and-test-preserved', { availabilityMs, runtime: status.status.runtimePhase, test: test.phase });
    proxy = new StdioClientTransport({ command: process.execPath, args: [proxyEntry, endpoint.href, '--allow-http', '--transport', 'http-only', '--header', 'Authorization:${MCP_RESOURCE_HEADER}'], env: { ...env, MCP_RESOURCE_HEADER: `Bearer ${token}`, MCP_REMOTE_CONFIG_DIR: join(base, 'proxy-auth') }, stderr: 'pipe' });
    proxy.stderr?.resume(); proxyClient = new Client({ name: 'owned-proxy-client', version: '1' }); await proxyClient.connect(proxy); await proxyClient.listTools();
    await point('proxy-connected', { proxy: await measure(proxy.pid) });
    const proxyPid = proxy.pid, proxyIdentity = (await processSample(proxyPid)).startTicks;
    await proxyClient.close(); proxyClient = undefined;
    await wait(async () => { try { return (await processSample(proxyPid)).startTicks !== proxyIdentity; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; } }, 'owned proxy exit');
    await point('proxy-closed', { proxy: { exited: true, rssBytes: 0 } });
    result.idle = await measure(controller.pid, 5);
    result.polled = await measure(controller.pid, 5, diag);
    await stop(controller); controller = undefined; result.cleanup = 'owned controller and clients exited; temporary state removed';
  } finally {
    await cleanupResourceFixture({
      controller,
      cleanupClients: async () => {
        for (const { c } of directClients) await c.close().catch(() => {});
        await proxyClient?.close().catch(() => {});
        if (ownedClient) await stop(ownedClient, 'SIGKILL');
      },
      stopController: stop,
      removeState: () => rm(base, { recursive: true, force: true }),
    });
  }
}
try {
  for (let i = 1; i <= runs; i++) await run(i);
  // Bounded microbenchmark isolates added observation/read cost, not SDK/network cost.
  const d = new McpDiagnostics(), entries = Array.from({ length: 32 }, () => d.create()); entries.forEach(s => d.initialize(s));
  const start = performance.now(), cpu = process.cpuUsage();
  for (let i = 0; i < 10000; i++) { const s = entries[i % 32]; d.clientMessage(s, true); d.change(s, 'operations', 1); d.change(s, 'operations', -1); }
  const eventsMs = performance.now() - start, eventsCpu = process.cpuUsage(cpu);
  const readStart = performance.now(); let bytes = 0;
  for (let i = 0; i < 1000; i++) bytes = Buffer.byteLength(JSON.stringify(d.snapshot()));
  report.overhead = { events: 10000, eventsMs, eventsCpuMicros: eventsCpu.user + eventsCpu.system, reads: 1000, readAndSerializeMs: performance.now() - readStart, sampled32SessionResponseBytes: bytes };
  report.cleanup = 'passed'; report.result = 'passed';
} catch (error) { report.result = 'failed'; report.error = error.message; process.exitCode = 1; }
await mkdir(resolve(reportPath, '..'), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Measurement ${report.result}; report ${reportPath}`);
