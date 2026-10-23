import { createHash, randomUUID } from "node:crypto";
import type { TestRun } from "@/shared/contracts";
import { REMOTE_REPORT_MAX_ENVELOPE_BYTES, remoteAssignmentSchema, remoteReportSchema, type RemoteAssignment, type RemotePollResult, type RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import type { EnqueueTestInput, VerificationJobs } from "@/server/modules/verification";
import { summarizeReceipt, type RemoteConnectionStore, type WorkerReceipt, type WorkerReceiptSummary } from "./connection-contracts";

export interface RemoteWorkerTransport {
  poll(): Promise<RemotePollResult>;
  report(report: RemoteWorkerReport): Promise<void>;
}
export interface RemoteWorkerExecution {
  /** Resolves local-only mapping and returns queue-owned, deferred preparation. */
  resolve(assignment: RemoteAssignment, receipt: WorkerReceipt, running: (evidence: Partial<RemoteWorkerReport>) => void): Promise<EnqueueTestInput>;
}
const settled = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

/** Outbound delivery/retry loop; admission and execution belong exclusively to VerificationJobs. */
export class RemoteVerificationWorker {
  private readonly receipts = new Map<string, WorkerReceiptSummary>();
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly workerId: string,
    private readonly connection: RemoteConnectionStore,
    private readonly jobs: Pick<VerificationJobs, "enqueue" | "cancel"> & { blockAdmission(reason: string): void },
    private readonly run: (id: string) => TestRun | null,
    private readonly execution: RemoteWorkerExecution,
    private readonly transport: RemoteWorkerTransport,
  ) {
    const savedReceipts = connection.receipts();
    if (hasUnconfirmedRemoteExecution(savedReceipts, run)) jobs.blockAdmission("remote_execution_cleanup_unconfirmed");
    for (const receipt of savedReceipts) {
      if (receipt.assignment.workerId !== workerId) continue;
      this.receipts.set(receipt.assignment.attemptId, receipt);
      // Receipt presence never authorizes enqueue after restart. Recover only saved evidence.
      if (!receipt.lastPhase || !settled.has(receipt.lastPhase)) {
        const body = this.connection.receipt(receipt.assignment.attemptId);
        if (body) this.collect(body, true);
      }
    }
  }
  start(intervalMs = 1000): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, intervalMs);
    this.timer.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending?.catch(() => undefined);
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.pending ??= this.synchronize().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async synchronize(): Promise<void> {
    // Collect and persist before networking, including while disconnected.
    for (const receipt of this.receipts.values()) {
      if (receipt.lastPhase && settled.has(receipt.lastPhase)) continue;
      const body = this.connection.receipt(receipt.assignment.attemptId);
      if (body) this.collect(body);
    }
    const poll = await this.transport.poll();
    for (const attemptId of poll.cancellations) {
      const receipt = this.receipts.has(attemptId) ? this.connection.receipt(attemptId) : null;
      if (!receipt) continue;
      receipt.cancellationRequested = true;
      this.save(receipt);
      if (this.active.has(attemptId)) await this.jobs.cancel(receipt.localRunId, this.actor());
    }
    for (const assignment of poll.assignments) await this.accept(assignment, poll.cancellations.includes(assignment.attemptId));
    let failure: unknown;
    for (const summary of this.receipts.values()) {
      if (summary.acknowledgedSequence >= summary.reportCount) continue;
      const receipt = this.connection.receipt(summary.assignment.attemptId);
      if (!receipt) continue;
      this.collect(receipt);
      for (const report of receipt.reports) {
        if (report.sequence <= receipt.acknowledgedSequence) continue;
        try {
          await this.transport.report(report);
        } catch (error) {
          // Keep rejected evidence immutable and ordered, but retry other attempts too.
          failure ??= error;
          break;
        }
        // Execution callbacks can append while a report is in flight. Merge the ACK
        // into the current outbox instead of overwriting it with this snapshot.
        const current = this.connection.receipt(receipt.assignment.attemptId);
        if (!current) throw new Error("worker_receipt_missing");
        current.acknowledgedSequence = Math.max(current.acknowledgedSequence, report.sequence);
        this.save(current);
      }
    }
    if (failure) throw failure;
  }

  private async accept(input: RemoteAssignment, cancelled: boolean): Promise<void> {
    const assignment = remoteAssignmentSchema.parse(input);
    if (assignment.workerId !== this.workerId) throw new Error("assignment_forbidden");
    const existing = this.receipts.get(assignment.attemptId);
    if (existing) {
      if (fingerprint(existing.assignment) !== fingerprint(assignment)) throw new Error("assignment_conflict");
      return;
    }
    const receipt = this.connection.accept({ assignment, localRunId: randomUUID(), cancellationRequested: cancelled, reports: [], acknowledgedSequence: 0 });
    if (fingerprint(receipt.assignment) !== fingerprint(assignment)) throw new Error("assignment_conflict");
    this.receipts.set(assignment.attemptId, summarizeReceipt(receipt));
    this.append(receipt, { phase: "preparing" });
    if (cancelled) { this.append(receipt, { phase: "cancelled" }); return; }
    try {
      const input = await this.execution.resolve(assignment, receipt, evidence => {
        const current = this.connection.receipt(assignment.attemptId);
        if (!current) throw new Error("worker_receipt_missing");
        this.append(current, { ...evidence, phase: "running" });
      });
      if (this.stopped) { this.append(receipt, { phase: "uncertain" }); return; }
      this.jobs.enqueue({ ...input, runId: receipt.localRunId, actor: this.actor(), idempotencyKey: assignment.attemptId });
      this.active.add(assignment.attemptId);
    } catch {
      this.append(receipt, { phase: "failed", failureKind: "setup", errorCode: "admission_failed" });
    }
  }
  private collect(receipt: WorkerReceipt, recovering = false): void {
    const previous = receipt.reports.at(-1);
    if (previous && settled.has(previous.phase)) return;
    const run = this.run(receipt.localRunId);
    if (!run || run.phase === "interrupted" || recovering && ["queued", "running"].includes(run.phase)) {
      if (recovering) this.append(receipt, { phase: "uncertain" });
      return;
    }
    if (["queued", "running"].includes(run.phase) || !run.telemetry?.finalizedAt) return;
    const executed = receipt.reports.find(report => report.phase === "running");
    let phase: RemoteWorkerReport["phase"] = run.phase === "passed" ? "succeeded" : "failed";
    if (run.telemetry?.spawnedAt && !executed) phase = "uncertain";
    if (run.phase === "cancelled") phase = receipt.cancellationRequested ? "cancelled" : "uncertain";
    this.append(receipt, {
      ...(executed ? { executedCommitSha: executed.executedCommitSha, presetFingerprint: executed.presetFingerprint, environmentFingerprint: executed.environmentFingerprint } : {}),
      phase,
      ...(phase === "failed" ? { failureKind: executed ? "execution" as const : "setup" as const, errorCode: executed ? "test_failed" : "preparation_failed" } : {}),
      exitCode: run.exitCode, signal: run.signal,
      execution: { queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, termination: run.telemetry?.termination ?? "unknown", cleanup: run.telemetry?.cleanup ?? "unknown" },
      source: { attribution: run.source.attribution, finishCommitSha: run.source.finish?.head ?? null, queueComparison: run.source.queueComparison, executionComparison: run.source.executionComparison, reasonCodes: run.source.reasonCodes.slice(0, 12) },
      logs: run.logs.slice(-200).map(line => line.slice(0, 2000)),
    });
    this.active.delete(receipt.assignment.attemptId);
  }
  private append(receipt: WorkerReceipt, evidence: Partial<RemoteWorkerReport> & Pick<RemoteWorkerReport, "phase">): void {
    const report = boundReport(this.workerId, remoteReportSchema.parse({ ...evidence, attemptId: receipt.assignment.attemptId, localRunId: receipt.localRunId, sequence: receipt.reports.length + 1 }));
    this.save({ ...receipt, reports: [...receipt.reports, report] });
    receipt.reports.push(report);
  }
  private save(receipt: WorkerReceipt): void {
    this.connection.saveReceipt(receipt);
    this.receipts.set(receipt.assignment.attemptId, summarizeReceipt(receipt));
  }
  private actor() { return `remote-worker:${this.workerId}`; }
}

export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** A restarted queue cannot assume that an orphaned process tree has exited. */
export function hasUnconfirmedRemoteExecution(receipts: WorkerReceiptSummary[], run: (id: string) => TestRun | null): boolean {
  return receipts.some(receipt => {
    // A terminal uncertain outcome can still have confirmed process-tree cleanup.
    // This durable evidence outlives the queue's retained local history.
    if (["confirmed", "not_required"].includes(receipt.cleanup ?? "")) return false;
    // Admission failures and cancellation before enqueue have no execution envelope.
    // An explicit unknown/pending/failed cleanup must never use that exception.
    if (receipt.cleanup === null && receipt.lastPhase && ["succeeded", "failed", "cancelled"].includes(receipt.lastPhase)) return false;
    const local = run(receipt.localRunId);
    return !local?.telemetry?.finalizedAt || !["confirmed", "not_required"].includes(local.telemetry.cleanup);
  });
}

/** Trim only before durable append. Retries always send the exact persisted report. */
function boundReport(workerId: string, report: RemoteWorkerReport): RemoteWorkerReport {
  const envelope = { version: 1, workerId, report: { ...report, logs: [] } };
  let bytes = Buffer.byteLength(JSON.stringify(envelope));
  const logs: string[] = [];
  for (let index = report.logs.length - 1; index >= 0; index--) {
    const line = report.logs[index];
    const size = Buffer.byteLength(JSON.stringify(line)) + (logs.length ? 1 : 0);
    if (bytes + size > REMOTE_REPORT_MAX_ENVELOPE_BYTES) break;
    bytes += size;
    logs.push(line);
  }
  return { ...report, logs: logs.reverse() };
}
