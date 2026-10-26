// Run only after the foreground worker exits. tsx resolves the public source APIs.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { acquireControllerLock } from '../src/server/controller-lock.ts';
import { SqliteStateStore } from '../src/server/sqlite-store.ts';
import { IdentityService } from '../src/server/modules/identity/index.ts';
import { WorkerRecoveryService } from '../src/server/modules/remote-verification/index.ts';
import { LinuxWorkerRecoveryHost } from '../src/server/infrastructure/git/index.ts';
import { assert, failureDiagnostic, fixedSha, failedSha, hostIdentity, json, load, markers, privateFile, processIdentity, save } from './remote-worker-acceptance.mjs';

function exited(root) {
  const owned = json(join(root, 'controller-process.json'));
  const exit = json(join(root, 'controller-exit.json'));
  assert(exit.code === 0 && exit.signal === null && exit.shutdownTimedOut === false, 'controller_did_not_exit_cleanly');
  const current = processIdentity(owned.pid);
  assert(owned.boot === hostIdentity().boot && (!current || current.startTicks !== owned.startTicks), 'controller_exit_not_proven');
  return { ownedPid: owned.pid, ownedStartTicks: owned.startTicks, exit };
}

async function main() {
  const [flag, root, ...extra] = process.argv.slice(2);
  assert(flag === '--root' && root && !extra.length, 'usage: node --import tsx scripts/remote-worker-acceptance.audit.mjs --root TRIAL_ROOT');
  const config = load(root);
  const identity = hostIdentity();
  assert(config.identity.machine === identity.machine && config.identity.boot === identity.boot, 'host_or_boot_changed_preserve_root');
  const controllerExit = exited(config.root);
  const lock = acquireControllerLock(join(config.root, 'state', 'controller.lock'));
  let store;
  try {
    store = new SqliteStateStore(join(config.root, 'data', 'state.sqlite3'));
    if (config.role === 'broker') {
      const evidence = ['failed', 'fixed', 'disconnect', 'cancel'].map(name => json(join(config.root, 'evidence', `${name}-wait.json`)));
      for (const item of evidence) {
        assert(item.execution?.cleanup === 'confirmed' && !item.executionUncertain, 'broker_terminal_evidence_missing');
        assert(existsSync(join(config.root, 'evidence', `${item.case}-replay.json`)), 'replay_evidence_missing');
        const request = store.getRemoteVerificationRequest(item.requestId);
        const attempt = store.findRemoteVerificationAttemptForRequest(item.requestId);
        assert(request?.phase === (item.case === 'cancel' ? 'cancelled' : 'completed') && request.commitSha === item.requestedCommitSha && attempt?.id === item.attemptId && attempt.phase === item.phase, 'broker_database_evidence_mismatch');
      }
      save(join(config.root, 'evidence', 'broker-exit.json'), { identity, controllerExit, requestIds: evidence.map(item => item.requestId), at: new Date().toISOString() });
      return;
    }
    const service = new IdentityService(store);
    const actor = service.authenticateBearer(privateFile(join(config.root, 'owner.token')).trim());
    const recovery = new WorkerRecoveryService(store.remoteConnection, new LinuxWorkerRecoveryHost(join(config.root, 'data', 'state.sqlite3')), service);
    const assessment = recovery.inspectAll(actor);
    const receipts = store.remoteConnection.receipts();
    const runs = store.listTestRuns(undefined, 100);
    assert(receipts.length === 4 && runs.length === 4 && assessment.length === 4, 'extra_or_missing_execution');
    const rows = [];
    for (const name of ['failed', 'fixed', 'disconnect', 'cancel']) {
      const evidence = json(join(config.root, 'broker-evidence', `${name}-wait.json`));
      assert(evidence.client.machine !== identity.machine && evidence.client.boot !== identity.boot, 'co_located_trial_rejected');
      const replay = json(join(config.root, 'broker-evidence', `${name}-replay.json`));
      assert(replay.requestId === evidence.requestId && replay.attemptId === evidence.attemptId && replay.localRunId === evidence.localRunId, 'replay_execution_changed');
      const receipt = receipts.find(item => item.assignment.requestId === evidence.requestId);
      assert(receipt && receipt.assignment.attemptId === evidence.attemptId && receipt.localRunId === evidence.localRunId, 'receipt_identity_mismatch');
      const sha = name === 'failed' ? failedSha : fixedSha;
      const phase = name === 'failed' ? 'failed' : name === 'cancel' ? 'cancelled' : 'succeeded';
      const preset = ['cancel', 'disconnect'].includes(name) ? 'node:test:remote:slow' : 'node:test:remote';
      assert(receipt.assignment.commitSha === sha && receipt.assignment.presetId === preset && receipt.assignment.workerId === 'acceptance-worker', 'assignment_mismatch');
      const body = store.remoteConnection.receipt(receipt.assignment.attemptId);
      const report = body?.reports.at(-1);
      const run = store.getTestRun(receipt.localRunId);
      assert(run && report && report.phase === phase && report.execution?.cleanup === 'confirmed' && run.telemetry?.cleanup === 'confirmed', 'cleanup_unconfirmed');
      assert(report.executedCommitSha === sha && report.source?.finishCommitSha === sha && run.source.finish?.head === sha, 'worker_source_mismatch');
      assert(body.acknowledgedSequence === report.sequence && receipt.reportCount === report.sequence, 'unacknowledged_outbox');
      assert(report.presetFingerprint === evidence.presetFingerprint && report.environmentFingerprint === evidence.environmentFingerprint, 'fingerprint_mismatch');
      const checked = assessment.find(item => item.attemptId === receipt.assignment.attemptId);
      assert(checked && !checked.blocked && checked.provenance?.host === identity.machine && checked.provenance.boot === identity.boot, 'worker_provenance_mismatch');
      const parsed = markers(run.logs);
      assert(JSON.stringify(parsed) === JSON.stringify(evidence.output.markers), 'broker_worker_marker_mismatch');
      const starts = parsed.filter(item => item.event === 'start');
      assert(starts.length === (preset.endsWith(':slow') ? 2 : 1) && new Set(starts.map(item => item.executionId)).size === starts.length, 'execution_count_mismatch');
      for (const item of starts) {
        assert(item.host === identity.host && item.boot === identity.boot && item.sha === sha, 'marker_host_mismatch');
        const current = processIdentity(item.pid);
        // A reused PID or a zombie cannot execute the original check. Never signal it.
        assert(!current || current.startTicks !== item.startTicks || current.state === 'Z', 'owned_fixture_process_still_alive');
      }
      rows.push({ case: name, requestId: evidence.requestId, attemptId: receipt.assignment.attemptId, localRunId: receipt.localRunId,
        requestedCommitSha: sha, executedCommitSha: report.executedCommitSha, presetId: preset, phase,
        presetFingerprint: report.presetFingerprint, environmentFingerprint: report.environmentFingerprint,
        exitCode: report.exitCode, execution: report.execution, acknowledgedSequence: body.acknowledgedSequence,
        executionCount: 1, markers: parsed, ownedProcessesExited: true });
    }
    assert(rows[0].presetFingerprint === rows[1].presetFingerprint && rows[0].environmentFingerprint === rows[1].environmentFingerprint, 'failed_fixed_policy_changed');
    assert(readdirSync(config.workspaceRoot).length === 0, 'retained_workspace_preserve_root');
    const result = { identity, controllerExit, receipts: receipts.length, executions: runs.length, rows, at: new Date().toISOString(),
      ownedProcessesExited: true, retainedWorkspaces: 0, deletionAuthorizedByTool: false };
    save(join(config.root, 'evidence', 'worker-audit.json'), result);
    console.log(JSON.stringify(result));
  } finally { store?.close(); lock.release(); }
}
main().catch(error => { console.error(failureDiagnostic(error, 'acceptance_audit_failed_preserve_roots (no cleanup or recovery performed)')); process.exitCode = 1; });
