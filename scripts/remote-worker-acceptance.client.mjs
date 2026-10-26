import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assert, failureDiagnostic, failedSha, fixedSha, hostIdentity, json, load, markers, privateFile, save } from './remote-worker-acceptance.mjs';

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(['--root', '--case', '--action', '--timeout-seconds'].includes(args[index]) && args[index + 1] && !options[args[index]], 'invalid_client_arguments');
    options[args[index]] = args[index + 1];
  }
  assert(options['--root'], 'root_required');
  const config = load(options['--root']);
  assert(config.role === 'broker', 'broker_root_required');
  const caseName = options['--case'];
  const action = options['--action'] ?? 'capabilities';
  assert(['capabilities', 'submit', 'wait-running', 'wait-disconnected', 'cancel', 'wait', 'replay'].includes(action), 'invalid_action');
  assert(action === 'capabilities' || ['failed', 'fixed', 'disconnect', 'cancel'].includes(caseName), 'invalid_case');
  const timeout = Number(options['--timeout-seconds'] ?? (action === 'wait-disconnected' ? 60 : 900)) * 1000;
  assert(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 900_000, 'invalid_deadline');
  const client = new Client({ name: 'wtc-cross-host-angular-acceptance', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.mcpPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${privateFile(join(config.root, 'owner.token')).trim()}` }, signal: AbortSignal.timeout(timeout) },
  });
  const started = Date.now();
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['submit_remote_verification', 'get_remote_verification', 'get_remote_verification_logs', 'cancel_remote_verification']) assert(names.includes(name), 'required_mcp_tool_missing');
    if (action === 'capabilities') {
      const evidence = { actualMcpClient: true, tools: names.filter(name => name.includes('remote_verification')), client: hostIdentity() };
      const path = join(config.root, 'evidence', 'capabilities.json');
      if (!existsSync(path)) save(path, evidence);
      console.log(JSON.stringify(evidence));
      return;
    }
    const call = async (name, input) => {
      const result = await client.callTool({ name, arguments: input }, undefined, { timeout: Math.min(timeout, 30_000) });
      assert(!result.isError, 'mcp_operation_rejected');
      const content = result.content.find(item => item.type === 'text');
      assert(content, 'mcp_text_missing');
      return JSON.parse(content.text);
    };
    const inputPath = join(config.root, 'evidence', `${caseName}-submission.json`);
    const requestPath = join(config.root, 'evidence', `${caseName}-request.json`);
    const input = { projectId: 'angular-acceptance', workerId: 'acceptance-worker', commitSha: caseName === 'failed' ? failedSha : fixedSha,
      presetId: ['disconnect', 'cancel'].includes(caseName) ? 'node:test:remote:slow' : 'node:test:remote', idempotencyKey: `angular-acceptance-20261026-${caseName}` };
    if (!existsSync(inputPath)) save(inputPath, { input, client: hostIdentity(), submittedAt: new Date().toISOString() });
    assert(JSON.stringify(json(inputPath).input) === JSON.stringify(input), 'saved_submission_mismatch');
    if (action === 'submit') {
      const request = await call('submit_remote_verification', input);
      if (!existsSync(requestPath)) save(requestPath, { requestId: request.id });
      assert(json(requestPath).requestId === request.id, 'submission_replay_changed_request');
      console.log(JSON.stringify({ case: caseName, requestId: request.id, requestedCommitSha: input.commitSha }));
      return;
    }
    assert(existsSync(requestPath), 'submit_case_first');
    const { requestId } = json(requestPath);
    const read = () => call('get_remote_verification', { requestId });
    const outputPath = join(config.root, 'evidence', `${caseName}-${action}.json`);
    assert(!existsSync(outputPath), 'phase_evidence_already_exists');
    let status;
    if (action === 'replay') {
      const before = await read();
      assert(['succeeded', 'failed', 'cancelled'].includes(before.attempt?.phase), 'replay_requires_terminal_result');
      const request = await call('submit_remote_verification', input);
      assert(request.id === requestId, 'replay_changed_request');
      await sleep(4000); // More than one real worker tick, without manipulating delivery.
      status = await read();
      assert(status.attempt?.id === before.attempt.id && status.result?.localRunId === before.result.localRunId && JSON.stringify(status.result) === JSON.stringify(before.result), 'replay_changed_execution');
    } else if (action === 'cancel') {
      const before = await read();
      assert(before.executionUncertain && before.attempt?.phase === 'running', 'cancel_requires_observed_disconnect');
      assert((await call('cancel_remote_verification', { requestId })).cancellationRequested, 'cancel_intent_not_saved');
      status = await read();
      assert(status.cancellationRequested && status.executionUncertain, 'offline_cancel_not_observed');
    } else {
      while (Date.now() - started < timeout) {
        status = await read();
        assert(status.request.commitSha === input.commitSha, 'requested_sha_changed');
        assert(status.attempt?.phase !== 'uncertain', 'uncertain_attempt_stop_trial');
        const terminal = ['succeeded', 'failed', 'cancelled'].includes(status.attempt?.phase);
        if ((action === 'wait' && terminal) || (action === 'wait-running' && status.attempt?.phase === 'running') ||
          (action === 'wait-disconnected' && status.executionUncertain && status.attempt?.phase === 'running')) break;
        assert(!terminal, 'unexpected_terminal_before_observation');
        await sleep(1000);
        status = null;
      }
      assert(status, 'phase_deadline_preserve_state');
    }
    const result = status.result;
    const output = await call('get_remote_verification_logs', { requestId });
    assert(output.requestId === requestId && output.attemptId === status.attempt?.id, 'log_identity_mismatch');
    assert(output.logs.length <= 200 && output.logs.every(line => line.length <= 2000) && Buffer.byteLength(JSON.stringify(output.logs)) <= 512 * 1024, 'unbounded_output');
    const parsed = markers(output.logs);
    if (action === 'wait' || action === 'replay') {
      const expected = caseName === 'failed' ? 'failed' : caseName === 'cancel' ? 'cancelled' : 'succeeded';
      assert(status.attempt?.phase === expected && result?.phase === expected, 'wrong_terminal_phase');
      assert(result.executedCommitSha === input.commitSha && result.execution?.cleanup === 'confirmed' && result.source?.finishCommitSha === input.commitSha && result.source?.attribution === 'observed_match', 'missing_exact_sha_cleanup_evidence');
      assert(/^[a-f0-9]{64}$/.test(result.presetFingerprint) && /^[a-f0-9]{64}$/.test(result.environmentFingerprint), 'missing_fingerprints');
      if (expected === 'failed') assert(result.failureKind === 'execution' && Number.isInteger(result.exitCode) && result.exitCode !== 0, 'not_a_real_test_failure');
      if (expected === 'succeeded') assert(result.exitCode === 0, 'not_a_real_test_success');
      const roles = ['disconnect', 'cancel'].includes(caseName) ? ['slow', 'descendant'] : ['test'];
      for (const role of roles) {
        assert(parsed.filter(item => item.role === role && item.event === 'start').length === 1, 'execution_marker_count_mismatch');
        if (expected === 'succeeded') assert(parsed.filter(item => item.role === role && item.event === 'passed').length === 1, 'completion_marker_missing');
      }
      // Hostnames are display data; the stopped worker audit proves distinct machines.
      assert(parsed.every(item => item.sha === input.commitSha && item.boot !== config.identity.boot), 'cross_host_marker_mismatch');
    }
    const safe = {
      case: caseName, action, observedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      submissionElapsedMs: Date.now() - Date.parse(json(inputPath).submittedAt),
      requestId, attemptId: status.attempt?.id, localRunId: result?.localRunId, input,
      phase: status.attempt?.phase, requestedCommitSha: status.request.commitSha, executedCommitSha: result?.executedCommitSha,
      cancellationRequested: status.cancellationRequested, executionUncertain: status.executionUncertain, lastContactAt: status.lastContactAt,
      presetFingerprint: result?.presetFingerprint, environmentFingerprint: result?.environmentFingerprint,
      exitCode: result?.exitCode, signal: result?.signal, failureKind: result?.failureKind, errorCode: result?.errorCode,
      execution: result?.execution, source: result?.source, client: hostIdentity(),
      output: { lines: output.logs.length, bytes: Buffer.byteLength(JSON.stringify(output.logs)), markers: parsed },
    };
    save(outputPath, safe);
    console.log(JSON.stringify(safe));
  } finally { await client.close(); }
}
main().catch(error => { console.error(failureDiagnostic(error, 'acceptance_client_failed_preserve_state (check phase, prerequisites and private controller log)')); process.exitCode = 1; });
