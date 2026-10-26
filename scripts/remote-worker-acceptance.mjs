// Finite trial orchestration. All execution/authorization belongs to the real CLI.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const baseline = '681c0c1a763cb7e2659c35755fdbf696e90cb77a';
export const fixtureBaseline = 'a5cea6ea5a19ab07ad24bb780738a8f81513d8be';
export const failedSha = 'f3055ed4bc5e401b8e5bd8c6004ae6171471802b';
export const fixedSha = 'f6fbceed97875ab5d13755b37020599d5c185ff8';
export const presets = ['node:test:remote', 'node:test:remote:slow'];
// Only errors created by local gates may contribute a public diagnostic code.
// Never classify filesystem, SDK or dependency errors by their message/name/code.
const localFailures = new WeakMap();
function localFailure(code) {
  const error = new Error(code);
  if (/^[a-z][a-z0-9_]{0,79}$/.test(code)) localFailures.set(error, code);
  return error;
}
export const assert = (condition, code) => { if (!condition) throw localFailure(code); };
export function failureDiagnostic(error, context) {
  const code = localFailures.get(error);
  return code ? `${context}: ${code}` : context;
}
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function privateFile(path) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid() && stat.size <= 1024 * 1024, 'private_file_required');
  return readFileSync(path, 'utf8');
}
export function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export function hostIdentity() {
  return { host: hostname(), machine: createHash('sha256').update(JSON.stringify(readFileSync('/etc/machine-id', 'utf8').trim())).digest('hex'),
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), node: process.version };
}
export function processIdentity(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { pid, state: fields[0], startTicks: fields[19] };
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return null; throw error; }
}
export function load(root) {
  root = resolve(root);
  assert(basename(root).startsWith('wtc-remote-acceptance-') && realpathSync(root) === root, 'trial_root_required');
  const stat = lstatSync(root);
  assert(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'private_trial_root_required');
  const config = JSON.parse(privateFile(join(root, 'trial.json')));
  assert(config.root === root && config.version === 1 && ['broker', 'worker'].includes(config.role), 'trial_manifest_mismatch');
  return config;
}
export function markers(logs) {
  const result = [];
  for (const line of logs) {
    const position = line.indexOf('WTC_ACCEPTANCE ');
    if (position < 0) continue;
    const item = JSON.parse(line.slice(position + 'WTC_ACCEPTANCE '.length));
    assert(item.version === 1 && ['start', 'passed'].includes(item.event) && ['test', 'slow', 'descendant'].includes(item.role), 'invalid_marker');
    assert(/^[a-f0-9-]{36}$/.test(item.executionId) && /^[a-f0-9-]{36}$/.test(item.boot) && /^[a-f0-9]{40}$/.test(item.sha), 'invalid_marker_identity');
    assert(/^[A-Za-z0-9._-]{1,253}$/.test(item.host) && /^v24\.19\.0$/.test(item.node) && /^\d{1,30}$/.test(item.startTicks) && Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isFinite(Date.parse(item.at)), 'invalid_marker_process');
    // Only allowlisted fields enter shareable evidence; never arbitrary command output.
    result.push(Object.fromEntries(['version', 'event', 'role', 'executionId', 'host', 'boot', 'pid', 'startTicks', 'sha', 'node', 'at'].map(key => [key, item[key]])));
  }
  return result;
}

function absolute(path) { assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'absolute_path_required'); return path; }
function within(root, path) { absolute(path); assert(path.startsWith(root + '/'), 'trial_path_required'); return path; }
function port(value) { assert(Number.isInteger(value) && value >= 1024 && value <= 65535, 'invalid_trial_port'); return value; }
function cli(config, args, ownerToken) {
  const result = spawnSync(config.nodeExecutable, [config.cliEntry, ...args, '--data-dir', join(config.root, 'data'), '--state-dir', join(config.root, 'state')], {
    env: { PATH: `${dirname(config.nodeExecutable)}:/usr/local/bin:/usr/bin:/bin`, HOME: join(config.root, 'home'), LANG: 'C.UTF-8',
      ...(ownerToken ? { WORKTREE_CONTROL_OWNER_TOKEN: ownerToken } : {}) },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  // CLI output may contain freshly issued secrets. Never include it in an error.
  if (result.error || result.status !== 0 || result.signal) {
    save(join(config.root, 'provision-failure-private.json'), { operation: args[0], status: result.status, signal: result.signal,
      code: result.error?.code, stderr: result.stderr?.slice(-16_000) });
  }
  assert(!result.error && result.status === 0 && !result.signal, 'trial_cli_failed_preserve_root');
  return result.stdout.trim();
}
function init(path) {
  const input = JSON.parse(privateFile(path));
  assert(process.version === 'v24.19.0' && realpathSync(input.nodeExecutable) === realpathSync(process.execPath), 'pinned_node_required');
  const allowed = ['root', 'role', 'nodeExecutable', 'cliEntry', 'webRoot', 'repositoryPath', 'port', 'mcpPort',
    ...(input.role === 'broker' ? ['remotePort', 'keyFile', 'certFile'] : ['origin', 'caFile', 'pnpmEntryPoint', 'sourceCachePath', 'workspaceRoot'])];
  assert(Object.keys(input).every(key => allowed.includes(key)), 'unknown_trial_configuration_field');
  const root = absolute(input.root);
  assert(/^wtc-remote-acceptance-[A-Za-z0-9-]+$/.test(basename(root)) && realpathSync(dirname(root)) === dirname(root), 'fresh_trial_root_required');
  assert(['broker', 'worker'].includes(input.role), 'invalid_role');
  for (const name of ['nodeExecutable', 'cliEntry', 'webRoot']) absolute(input[name]);
  for (const name of ['repositoryPath', ...(input.role === 'worker' ? ['sourceCachePath', 'workspaceRoot'] : [])]) within(root, input[name]);
  port(input.port); port(input.mcpPort);
  assert(input.port !== input.mcpPort, 'distinct_ports_required');
  if (input.role === 'broker') {
    port(input.remotePort);
    assert(![input.port, input.mcpPort].includes(input.remotePort), 'distinct_ports_required');
    absolute(input.keyFile); absolute(input.certFile);
  } else {
    const url = new URL(input.origin);
    assert(url.protocol === 'https:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'tls_loopback_tunnel_required');
    absolute(input.caFile); absolute(input.pnpmEntryPoint);
    assert(input.repositoryPath === join(root, 'repository') && input.sourceCachePath === join(root, 'cache') && input.workspaceRoot === join(root, 'workspaces'), 'independent_sibling_paths_required');
  }
  mkdirSync(root, { mode: 0o700 }); // Exclusive; never adopt a previous trial.
  for (const name of ['home', 'evidence', 'workspaces']) mkdirSync(join(root, name), { mode: 0o700 });
  save(join(root, 'trial.json'), { ...input, version: 1, baseline, fixtureBaseline, created: new Date().toISOString(), identity: hostIdentity() });
  console.log(JSON.stringify({ phase: 'initialized', role: input.role, baseline }));
}
function provision(config) {
  const root = config.root;
  assert(!existsSync(join(root, 'data')), 'provision_once_preserve_partial_state');
  const owner = JSON.parse(cli(config, ['identity', 'bootstrap-owner', '--label', 'remote acceptance', '--lifetime-seconds', '3600']));
  assert(typeof owner.token === 'string' && typeof owner.principalId === 'string', 'invalid_owner_bootstrap');
  writeFileSync(join(root, 'owner.token'), owner.token + '\n', { mode: 0o600, flag: 'wx' });
  // Fresh token-mode installations refuse non-TTY first starts without this.
  const installation = JSON.parse(cli(config, ['auth', 'token', 'generate']));
  assert(typeof installation.token === 'string', 'installation_token_not_issued');
  writeFileSync(join(root, 'installation.token'), installation.token + '\n', { mode: 0o600, flag: 'wx' });
  cli(config, ['auth', 'mode', 'set', 'token']);
  cli(config, ['project', 'add', config.repositoryPath, '--name', 'Angular acceptance', '--preset', 'none'], owner.token);
  const projects = JSON.parse(cli(config, ['project', 'list', '--json'], owner.token));
  assert(projects.length === 1 && projects[0].launchPreset === 'none', 'verification_only_project_required');
  const broker = config.role === 'worker' ? JSON.parse(privateFile(join(root, 'broker-provision.json'))) : null;
  if (broker) assert(broker.projectId === 'angular-acceptance' && broker.workerId === 'acceptance-worker' && /^[a-f0-9-]{36}$/.test(broker.workerPrincipalId), 'broker_identity_required');
  const input = {
    project: { id: 'angular-acceptance', name: 'Angular acceptance', sourceRemote: 'origin' },
    worker: { id: 'acceptance-worker', name: 'Angular acceptance worker', ...(broker ? { principalId: broker.workerPrincipalId } : {}) },
    localProjectId: projects[0].id, presetIds: presets,
    callerPrincipalIds: config.role === 'broker' ? [owner.principalId] : [],
    ...(config.role === 'broker' ? { workerTokenFile: join(root, 'worker.token') } : {}),
  };
  save(join(root, 'provision-input.json'), input);
  const result = JSON.parse(cli(config, ['remote-verification', 'provision', '--file', join(root, 'provision-input.json')], owner.token));
  save(join(root, 'provision-result.json'), result);
  const runtime = config.role === 'broker'
    ? { version: 1, listener: { host: '127.0.0.1', port: config.remotePort, keyFile: config.keyFile, certFile: config.certFile } }
    : { version: 1, worker: { workerId: 'acceptance-worker', origin: config.origin, tokenFile: join(root, 'worker.token'), workspaceRoot: config.workspaceRoot,
      mappings: [{ projectId: 'angular-acceptance', localProjectId: projects[0].id, sourceCachePath: config.sourceCachePath, sourceRemote: 'origin', presetIds: presets,
        preparationTimeoutMs: 600_000, dependencySetup: { kind: 'pnpm', nodeExecutable: config.nodeExecutable, nodeVersion: '24.19.0',
          pnpmEntryPoint: config.pnpmEntryPoint, pnpmVersion: '11.22.0', scripts: 'ignore' } }] } };
  save(join(root, 'runtime.json'), runtime);
  console.log(JSON.stringify({ phase: 'provisioned', ...result }));
}
async function run(config) {
  const root = config.root;
  assert(process.version === 'v24.19.0', 'pinned_node_required');
  assert(existsSync(join(root, 'runtime.json')) && !existsSync(join(root, 'controller-process.json')), 'provisioned_unused_trial_required');
  const fd = openSync(join(root, 'controller-private.log'), 'wx', 0o600);
  const child = spawn(config.nodeExecutable, [config.cliEntry, 'start', '--host', '127.0.0.1', '--port', String(config.port), '--mcp-port', String(config.mcpPort),
    '--no-open', ...(config.role === 'worker' ? ['--no-mcp'] : []), '--data-dir', join(root, 'data'), '--state-dir', join(root, 'state'),
    '--web-root', config.webRoot, '--browse-root', root, '--remote-verification-config', join(root, 'runtime.json')], {
    env: { PATH: `${dirname(config.nodeExecutable)}:/usr/local/bin:/usr/bin:/bin`, HOME: join(root, 'home'), LANG: 'C.UTF-8',
      ...(config.role === 'worker' ? { NODE_EXTRA_CA_CERTS: config.caFile } : {}) }, stdio: ['ignore', fd, fd],
    // Terminal signals reach only the supervisor; it sends one graceful stop.
    // Keep the ChildProcess referenced and await its exit even after a timeout.
    detached: true,
  });
  closeSync(fd);
  let timer;
  let stopping = false;
  let shutdownTimedOut = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM'); // The live ChildProcess we just spawned; never a saved PID.
    timer = setTimeout(() => { shutdownTimedOut = true; console.error('trial_shutdown_unconfirmed_preserve_root'); process.exitCode = 1; }, 45_000);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  const deadline = setTimeout(stop, 30 * 60_000);
  try {
    await new Promise((resolveExit, reject) => {
      child.once('error', () => reject(localFailure('trial_controller_spawn_failed')));
      child.once('spawn', () => {
        save(join(root, 'controller-process.json'), { ...hostIdentity(), ...processIdentity(child.pid), role: config.role });
        console.log(JSON.stringify({ phase: 'spawned', role: config.role, ready: false }));
      });
      child.once('exit', (code, signal) => {
        save(join(root, 'controller-exit.json'), { code, signal, shutdownTimedOut, at: new Date().toISOString() });
        if (code === 0 && !signal) resolveExit(); else reject(localFailure('trial_controller_failed_preserve_root'));
      });
    });
  } finally {
    clearTimeout(timer); clearTimeout(deadline);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop);
  }
}

async function main() {
  const [phase, flag, value, ...extra] = process.argv.slice(2);
  assert(!extra.length && value && (phase === 'init' ? flag === '--config' : flag === '--root'), 'usage: init --config PRIVATE_JSON | provision/run --root TRIAL_ROOT');
  if (phase === 'init') return init(value);
  const config = load(value);
  if (phase === 'provision') return provision(config);
  if (phase === 'run') return run(config);
  throw localFailure('unknown_trial_phase');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(failureDiagnostic(error, 'acceptance_phase_failed_preserve_root')); process.exitCode = 1; });
}
