import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RemoteVerificationAttempt, RemoteVerificationRequest } from "../../src/server/modules/remote-verification/contracts";
import type { RemoteWorkerReport } from "../../src/shared/contracts/remote-verification";
import type { TestQueueStatus, WorktreeTestPresets } from "../../src/shared/contracts";
import { waitFor } from "../support/controller-fixture";
import { identityEnded, observeWorkerTicks, recoveryCommand, RemoteCliRecoveryFixture, type Inspection, type RecoveryMcp } from "../support/remote-cli-recovery-fixture";

type Status = { request: RemoteVerificationRequest; attempt: RemoteVerificationAttempt | null; result: RemoteWorkerReport | null; executionUncertain: boolean };
describe.skipIf(process.platform !== "linux")("full CLI recovery acceptance", () => {
let fixture: RemoteCliRecoveryFixture | undefined;
beforeAll(async () => {
  // Keep direct vitest invocation behind the same artifact guard as the public script.
  expect((await recoveryCommand(process.execPath, ["scripts/build-fingerprint.mjs", "--check"])).code, "Run the managed build preset before this acceptance preset").toBe(0);
});
afterEach(async context => {
  if (fixture) {
    fixture.preserve ||= context.task.result?.state === "fail";
    const current = fixture; fixture = undefined; await current.close();
  }
}, 120_000);

function submission(f: RemoteCliRecoveryFixture, key: string) {
  return { projectId: "recovery-project", workerId: "recovery-worker", commitSha: f.sha, presetId: "node:test", idempotencyKey: key };
}
async function status(client: RecoveryMcp, requestId: string) { return client.call<Status>("get_remote_verification", { requestId }); }
async function active(f: RemoteCliRecoveryFixture, client: RecoveryMcp, requestId: string) {
  return waitFor(async () => {
    const current = await status(client, requestId);
    const starts = (await f.events()).filter(event => event.event === "start");
    if (current.attempt?.phase !== "running" || starts.length !== 2) return null;
    expect(starts.map(event => event.role).sort()).toEqual(["descendant", "launcher"]);
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    for (const event of starts) {
      expect(event).toMatchObject({ sha: f.sha, attemptId: current.attempt.id, boot });
      expect(await identityEnded(event.process)).toBe(false);
    }
    expect(current.attempt).toMatchObject({ executedCommitSha: f.sha, localRunId: current.result?.localRunId });
    expect(current.result).toMatchObject({ attemptId: current.attempt.id, executedCommitSha: f.sha, phase: "running" });
    return current;
  }, 20_000, () => "fixture_remote_command_and_descendant_not_running");
}
async function inspect(f: RemoteCliRecoveryFixture, attemptId: string) {
  return JSON.parse((await f.worker.cli(["remote-verification", "inspect", "--attempt-id", attemptId])).stdout) as Inspection;
}
async function singleExecution(f: RemoteCliRecoveryFixture, attemptId: string) {
  const events = await f.events();
  expect(events.filter(event => event.event === "start").map(event => event.role).sort()).toEqual(["descendant", "launcher"]);
  expect(events.every(event => event.sha === f.sha && event.attemptId === attemptId)).toBe(true);
  expect(await readFile(join(f.human, "uncommitted.txt"), "utf8")).toBe("preserve human work\n");
}

it("recovers a full broker CLI SIGKILL, replays the exact request and receives the original command result", async () => {
  const f = await RemoteCliRecoveryFixture.create(value => { fixture = value; });
  let client = await f.broker.mcp();
  const input = submission(f, "broker-cli-crash");
  const request = await client.call<RemoteVerificationRequest>("submit_remote_verification", input);
  await f.save(join(f.root, "submission.json"), { input, requestId: request.id });
  const running = await active(f, client, request.id);
  const attemptId = running.attempt!.id, localRunId = running.result!.localRunId;
  await f.broker.stop(true);
  // Worker command is still gated while the same broker installation reopens.
  expect((await f.events()).filter(event => event.event === "exit")).toEqual([]);
  await f.broker.start(); client = await f.broker.mcp();
  expect((await client.call<RemoteVerificationRequest>("submit_remote_verification", input)).id).toBe(request.id);
  const recovered = await status(client, request.id);
  expect(recovered).toMatchObject({ executionUncertain: true, attempt: { id: attemptId, phase: "uncertain", localRunId, executedCommitSha: f.sha }, result: running.result });
  await singleExecution(f, attemptId);
  await f.release();
  const completed = await waitFor(async () => {
    const current = await status(client, request.id); return current.attempt?.phase === "succeeded" ? current : null;
  }, 20_000, () => "fixture_original_result_not_delivered_after_broker_restart");
  expect(completed).toMatchObject({ executionUncertain: false, request: { id: request.id, commitSha: f.sha, phase: "completed" },
    attempt: { id: attemptId, localRunId, executedCommitSha: f.sha }, result: { attemptId, localRunId, executedCommitSha: f.sha, exitCode: 0,
      phase: "succeeded", execution: { cleanup: "confirmed" }, source: { attribution: "observed_match", finishCommitSha: f.sha } } });
  expect(completed.result!.presetFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(completed.result!.environmentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  await f.waitNaturalExit();
  expect((await f.events()).filter(event => event.event === "exit").map(event => event.reason)).toEqual(["released", "released"]);
  expect((await client.call<RemoteVerificationRequest>("submit_remote_verification", input)).id).toBe(request.id);
  await observeWorkerTicks();
  expect((await status(client, request.id)).result).toEqual(completed.result);
  await singleExecution(f, attemptId);
  await f.save(join(f.root, "broker-recovery.json"), { running, recovered, completed });
  await f.evidence("broker-cli-crash", { requestId: request.id, attemptId, localRunId, executedCommitSha: completed.result!.executedCommitSha, phase: completed.result!.phase });
}, 180_000);

it("quarantines a full worker CLI SIGKILL, refuses same-boot owner recovery and blocks finite admission without remote configuration", async () => {
  const f = await RemoteCliRecoveryFixture.create(value => { fixture = value; });
  // Keep original signed installation, artifacts and private diagnostics for independent review.
  f.preserve = true;
  const client = await f.broker.mcp(), input = submission(f, "worker-cli-crash");
  const request = await client.call<RemoteVerificationRequest>("submit_remote_verification", input);
  await f.save(join(f.root, "submission.json"), { input, requestId: request.id });
  const running = await active(f, client, request.id), attemptId = running.attempt!.id;
  await f.worker.stop(true);
  for (const event of (await f.events()).filter(event => event.event === "start")) expect(await identityEnded(event.process)).toBe(false);
  const before = await inspect(f, attemptId);
  expect(before).toMatchObject({ attemptId, localRunId: running.result!.localRunId, workerId: "recovery-worker", lastPhase: "running",
    blocked: true, recoverable: false, code: "recovery_same_boot_unconfirmed", recovery: null });
  const assignment = { projectId: input.projectId, workerId: input.workerId, commitSha: input.commitSha, presetId: input.presetId, requestId: request.id, attemptId };
  expect(before.provenance).toMatchObject({ version: 1, attemptId, localRunId: running.result!.localRunId,
    assignmentDigest: createHash("sha256").update(JSON.stringify(assignment)).digest("hex"),
    boot: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), root: await f.pathIdentity(f.workspaces), cache: await f.pathIdentity(f.cache) });
  expect(before.provenance.signature).toMatch(/^[a-f0-9]{64}$/);
  expect(before.provenance.retainedPaths).toEqual([join(f.workspaces, attemptId), join(f.workspaces, `.home-${attemptId}`), join(f.workspaces, `.tmp-${attemptId}`), f.cache]);
  const operationId = "worker-cli-crash-same-boot";
  const refused = await f.worker.cli(["remote-verification", "reconcile", "--attempt-id", attemptId, "--operation-id", operationId], true);
  expect(refused.code).not.toBe(0);
  expect(refused.sameBootRefused).toBe(true);
  // Refusal is checked by unchanged public inspection, not by accepting any CLI failure as proof.
  expect(await inspect(f, attemptId)).toEqual(before);
  await f.worker.start(false);
  const local = await f.worker.mcp(true);
  expect(await local.call<TestQueueStatus>("get_test_queue")).toMatchObject({ admissionBlockReason: "remote_execution_cleanup_unconfirmed", running: 0, queued: 0 });
  const worktrees = await local.call<Array<{ path: string }>>("list_worktrees", { projectId: f.worker.projectId });
  const exact = worktrees.find(worktree => worktree.path === f.human); expect(exact).toBeDefined();
  const presets = await local.call<WorktreeTestPresets[]>("list_test_presets", { projectId: f.worker.projectId });
  expect(presets.find(entry => entry.worktreePath === exact!.path)?.presets.some(preset => preset.id === "node:test")).toBe(true);
  expect(await local.refused("run_test", { projectId: f.worker.projectId, worktreePath: exact!.path, presetId: "node:test", idempotencyKey: "blocked-without-remote-config" }, "remote_execution_cleanup_unconfirmed")).toBe(true);
  await f.worker.stop();
  await f.worker.start();
  const uncertain = await waitFor(async () => { const current = await status(client, request.id); return current.result?.phase === "uncertain" ? current : null; }, 20_000, () => "fixture_worker_uncertain_report_missing");
  expect(uncertain).toMatchObject({ executionUncertain: true, attempt: { id: attemptId, localRunId: running.result!.localRunId, phase: "uncertain", executedCommitSha: f.sha },
    result: { attemptId, localRunId: running.result!.localRunId, phase: "uncertain" } });
  const restarted = await f.worker.mcp(true);
  expect(await restarted.call<TestQueueStatus>("get_test_queue")).toMatchObject({ admissionBlockReason: "remote_execution_cleanup_unconfirmed" });
  expect((await client.call<RemoteVerificationRequest>("submit_remote_verification", input)).id).toBe(request.id);
  await observeWorkerTicks(); await singleExecution(f, attemptId);
  await f.release(); await f.waitNaturalExit();
  await observeWorkerTicks();
  // Natural orphan exit is not authority to upgrade the immutable outcome or release admission.
  expect((await status(client, request.id)).result).toEqual(uncertain.result);
  expect(await restarted.call<TestQueueStatus>("get_test_queue")).toMatchObject({ admissionBlockReason: "remote_execution_cleanup_unconfirmed" });
  await f.worker.stop();
  const after = await inspect(f, attemptId);
  expect(after).toMatchObject({ blocked: true, recoverable: false, code: "recovery_same_boot_unconfirmed", lastPhase: "uncertain", recovery: null, provenance: before.provenance });
  for (const path of before.provenance.retainedPaths) expect((await f.pathIdentity(path)).path).toBe(path);
  await singleExecution(f, attemptId);
  await f.save(join(f.root, "worker-recovery.json"), { requestId: request.id, attemptId, operationId, before, after, uncertain, events: await f.events(),
    actualRebootExecuted: false, interactiveT3AcceptanceExecuted: false });
  await f.evidence("worker-cli-crash", { requestId: request.id, attemptId, localRunId: running.result!.localRunId, executedCommitSha: f.sha,
    phase: uncertain.result!.phase, admissionBlockReason: "remote_execution_cleanup_unconfirmed", actualRebootExecuted: false });
}, 180_000);
it("refuses a pending controller restart once fixture teardown begins", async () => {
  const f = await RemoteCliRecoveryFixture.create(value => { fixture = value; });
  await f.worker.stop();
  const restart = f.worker.start(false);
  const closed = f.close();
  await expect(restart).rejects.toThrow("fixture_closing");
  await closed;
  await expect(f.worker.start()).rejects.toThrow("fixture_closing");
  await expect(f.broker.start()).rejects.toThrow("fixture_closing");
  fixture = undefined;
}, 90_000);
});
