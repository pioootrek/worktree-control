import { createHash, randomUUID } from "node:crypto";
import type { TestRun } from "@/shared/contracts";
import { remoteAssignmentSchema, remoteReportSchema, type RemoteAssignment, type RemotePollResult, type RemoteWorkerReport } from "@/shared/contracts/remote-verification";
import type { EnqueueTestInput, VerificationJobs } from "@/server/modules/verification";
import type { RemoteConnectionStore, WorkerReceipt } from "./connection-contracts";

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
  private readonly receipts = new Map<string, WorkerReceipt>();
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly workerId: string,
    private readonly connection: RemoteConnectionStore,
    private readonly jobs: Pick<VerificationJobs, "enqueue" | "cancel">,
    private readonly run: (id: string) => TestRun | null,
    private readonly execution: RemoteWorkerExecution,
    private readonly transport: RemoteWorkerTransport,
  ) {
    for (const receipt of connection.receipts()) {
      if (receipt.assignment.workerId !== workerId) continue;
      this.receipts.set(receipt.assignment.attemptId, receipt);
      // Receipt presence never authorizes enqueue after restart. Recover only saved evidence.
      this.collect(receipt, true);
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
    for (const receipt of this.receipts.values()) this.collect(receipt);
    const poll = await this.transport.poll();
    for (const attemptId of poll.cancellations) {
      const receipt = this.receipts.get(attemptId);
      if (!receipt) continue;
      receipt.cancellationRequested = true;
      this.connection.saveReceipt(receipt);
      if (this.active.has(attemptId)) await this.jobs.cancel(receipt.localRunId, this.actor());
    }
    for (const assignment of poll.assignments) await this.accept(assignment, poll.cancellations.includes(assignment.attemptId));
    for (const receipt of this.receipts.values()) {
      this.collect(receipt);
      for (const report of receipt.reports) {
        if (report.sequence <= receipt.acknowledgedSequence) continue;
        await this.transport.report(report);
        receipt.acknowledgedSequence = report.sequence;
        this.connection.saveReceipt(receipt);
      }
    }
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
    this.receipts.set(assignment.attemptId, receipt);
    this.append(receipt, { phase: "preparing" });
    if (cancelled) { this.append(receipt, { phase: "cancelled" }); return; }
    try {
      const input = await this.execution.resolve(assignment, receipt, evidence => this.append(receipt, { ...evidence, phase: "running" }));
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
    const report = remoteReportSchema.parse({ ...evidence, attemptId: receipt.assignment.attemptId, localRunId: receipt.localRunId, sequence: receipt.reports.length + 1 });
    this.connection.saveReceipt({ ...receipt, reports: [...receipt.reports, report] });
    receipt.reports.push(report);
  }
  private actor() { return `remote-worker:${this.workerId}`; }
}

export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
