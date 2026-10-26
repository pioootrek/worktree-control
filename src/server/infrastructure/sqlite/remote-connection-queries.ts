import type Database from "better-sqlite3";
import type { RemoteConnectionStore, WorkerReceipt, WorkerReceiptSummary, WorkerRecoveryJournal } from "@/server/modules/remote-verification";
import { remoteAssignmentSchema, type RemoteWorkerReport } from "@/shared/contracts/remote-verification";

function payload<T>(row: unknown): T | null {
  return row ? JSON.parse((row as { payload_json: string }).payload_json) as T : null;
}
/** Borrows the singleton owner's SQLite connection. */
export class RemoteConnectionQueries implements RemoteConnectionStore {
  private readonly pendingCursors = new Map<string, [string, string]>();
  private readonly cancellationCursors = new Map<string, [string, string]>();
  constructor(private readonly database: Database.Database) {}
  atomic<T>(operation: () => T): T { return this.database.transaction(operation).immediate(); }
  contact(workerId: string, at: string): void {
    this.database.prepare("UPDATE remote_workers SET last_contact_at=? WHERE id=?").run(at, workerId);
  }
  pendingRequests(workerId: string): string[] {
    // Seek through bounded pages even when every candidate is no longer authorized.
    // Bound each indexed phase scan before filtering worker/attempt eligibility;
    // historical assigned/uncertain work must not cause an unbounded scan either.
    const page = (after: [string, string]) => this.database.prepare(`SELECT id,created_at,worker_id,
      (phase='pending' OR EXISTS (SELECT 1 FROM remote_verification_attempts a
        WHERE a.request_id=r.id AND a.phase='assigned')) deliverable
      FROM (
        SELECT * FROM (SELECT id,created_at,worker_id,phase FROM remote_verification_requests
          WHERE phase='pending' AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 100)
        UNION ALL
        SELECT * FROM (SELECT id,created_at,worker_id,phase FROM remote_verification_requests
          WHERE phase='assigned' AND (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 100)
      ) r ORDER BY created_at,id LIMIT 100`).all(...after, ...after) as Array<{
        id: string; created_at: string; worker_id: string; deliverable: number;
      }>;
    const cursor = this.pendingCursors.get(workerId);
    let rows = page(cursor ?? ["", ""]);
    if (!rows.length && cursor) rows = page(["", ""]);
    const last = rows.at(-1);
    if (last) this.pendingCursors.set(workerId, [last.created_at, last.id]);
    else this.pendingCursors.delete(workerId);
    return rows.filter(row => row.worker_id === workerId && row.deliverable).map(row => row.id);
  }
  cancellationAttempts(workerId: string, limit = 100): string[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("invalid_cancellation_page_limit");
    // Nonterminal attempts (including uncertain ones) retain assigned requests.
    // Page the existing queue index before filtering, so neither old cancellations
    // nor other workers' work can force an unbounded scan or starve later delivery.
    const page = (after: [string, string]) => this.database.prepare(`SELECT
      r.id,r.created_at,a.id attempt_id,a.worker_id,a.phase,c.request_id cancellation
      FROM (SELECT id,created_at FROM remote_verification_requests
        WHERE phase='assigned' AND (created_at,id)>(?,?)
        ORDER BY created_at,id LIMIT ?) r
      LEFT JOIN remote_verification_attempts a ON a.id=(
        SELECT id FROM remote_verification_attempts WHERE request_id=r.id
        ORDER BY sequence DESC LIMIT 1)
      LEFT JOIN remote_verification_cancellations c ON c.request_id=r.id
      ORDER BY r.created_at,r.id`).all(...after, limit) as Array<{
        id: string; created_at: string; attempt_id: string | null; worker_id: string | null;
        phase: string | null; cancellation: string | null;
      }>;
    const cursor = this.cancellationCursors.get(workerId);
    let rows = page(cursor ?? ["", ""]);
    if (!rows.length && cursor) rows = page(["", ""]);
    const last = rows.at(-1);
    if (last) this.cancellationCursors.set(workerId, [last.created_at, last.id]);
    else this.cancellationCursors.delete(workerId);
    return rows.flatMap(row => row.attempt_id && row.worker_id === workerId && row.cancellation
      && !["succeeded", "failed", "cancelled"].includes(row.phase ?? "") ? [row.attempt_id] : []);
  }
  requestCancellation(requestId: string, at: string): void {
    this.atomic(() => {
      this.database.prepare("INSERT OR IGNORE INTO remote_verification_cancellations VALUES (?,?)").run(requestId, at);
      this.database.prepare("UPDATE remote_verification_requests SET phase='cancelled',updated_at=? WHERE id=? AND phase='pending'").run(at, requestId);
    });
  }
  cancellationRequested(requestId: string): boolean {
    return !!this.database.prepare("SELECT 1 FROM remote_verification_cancellations WHERE request_id=?").get(requestId);
  }
  report(attemptId: string, sequence: number): RemoteWorkerReport | null {
    return payload(this.database.prepare("SELECT payload_json FROM remote_verification_reports WHERE attempt_id=? AND sequence=?").get(attemptId, sequence));
  }
  latestReport(attemptId: string): RemoteWorkerReport | null {
    return payload(this.database.prepare("SELECT payload_json FROM remote_verification_reports WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1").get(attemptId));
  }
  saveReport(report: RemoteWorkerReport): void {
    this.database.prepare("INSERT INTO remote_verification_reports VALUES (?,?,?)").run(report.attemptId, report.sequence, JSON.stringify(report));
  }
  accept(receipt: WorkerReceipt): WorkerReceipt {
    return this.atomic(() => {
      const existing = payload<WorkerReceipt>(this.database.prepare("SELECT payload_json FROM remote_worker_receipts WHERE attempt_id=?").get(receipt.assignment.attemptId));
      if (existing) return existing;
      // Retain tombstones for replay safety. Exhaustion needs explicit owner maintenance.
      if ((this.database.prepare("SELECT count(*) n FROM remote_worker_receipts").get() as { n: number }).n >= 1000) throw new Error("worker_receipt_capacity_exhausted");
      this.database.prepare("INSERT INTO remote_worker_receipts VALUES (?,?)").run(receipt.assignment.attemptId, JSON.stringify(receipt));
      return receipt;
    });
  }
  receipt(attemptId: string): WorkerReceipt | null {
    return payload(this.database.prepare("SELECT payload_json FROM remote_worker_receipts WHERE attempt_id=?").get(attemptId));
  }
  receipts(): WorkerReceiptSummary[] {
    // Project in SQL: .all() must never materialize historical report/log bodies.
    const rows = this.database.prepare(`SELECT
      substr(json_extract(payload_json, '$.recovery'),1,32769) recovery_json,
      substr(json_extract(payload_json, '$.assignment'),1,4097) assignment_json,
      json_extract(payload_json, '$.localRunId') localRunId,
      json_extract(payload_json, '$.cancellationRequested') cancellationRequested,
      json_extract(payload_json, '$.acknowledgedSequence') acknowledgedSequence,
      json_array_length(payload_json, '$.reports') reportCount,
      json_extract(payload_json, '$.reports[#-1].phase') lastPhase,
      json_extract(payload_json, '$.reports[#-1].execution.cleanup') cleanup
      FROM remote_worker_receipts LIMIT 1001`).all() as Array<Omit<WorkerReceiptSummary, "assignment" | "cancellationRequested"> & { assignment_json: string; recovery_json: string | null; cancellationRequested: number }>;
    if (rows.length > 1000) throw new Error("worker_receipt_capacity_exhausted");
    try {
      return rows.map(({ assignment_json, recovery_json, cancellationRequested, ...row }) => {
        if (assignment_json?.length > 4096 || recovery_json && recovery_json.length > 32768
          || typeof row.localRunId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.localRunId)
          || !Number.isInteger(row.reportCount) || row.reportCount < 0 || row.reportCount > 8
          || !Number.isInteger(row.acknowledgedSequence) || row.acknowledgedSequence < 0 || row.acknowledgedSequence > row.reportCount
          || ![0, 1].includes(cancellationRequested)
          || row.lastPhase !== null && !["preparing", "running", "succeeded", "failed", "cancelled", "uncertain"].includes(row.lastPhase)
          || row.reportCount === 0 && row.lastPhase !== null || row.reportCount > 0 && row.lastPhase === null
          || row.cleanup !== null && (typeof row.cleanup !== "string" || row.cleanup.length > 64)) throw new Error("metadata_invalid");
        return { ...row, ...(recovery_json ? { recovery: JSON.parse(recovery_json) } : {}),
          assignment: remoteAssignmentSchema.parse(JSON.parse(assignment_json)), cancellationRequested: cancellationRequested === 1 };
      });
    } catch { throw new Error("worker_receipt_metadata_invalid"); }
  }
  saveRecovery(attemptId: string, journal: WorkerRecoveryJournal): void {
    this.atomic(() => {
      const receipt = this.receipt(attemptId);
      if (!receipt) throw new Error("worker_receipt_missing");
      if (receipt.recovery && (JSON.stringify(receipt.recovery.provenance) !== JSON.stringify(journal.provenance)
        || receipt.recovery.audit && JSON.stringify(receipt.recovery.audit) !== JSON.stringify(journal.audit))) throw new Error("recovery_journal_conflict");
      this.database.prepare("UPDATE remote_worker_receipts SET payload_json=json_set(payload_json, '$.recovery', json(?)) WHERE attempt_id=?")
        .run(JSON.stringify(journal), attemptId);
    });
  }
  saveReceipt(receipt: WorkerReceipt): void {
    // A callback holding an older receipt must not erase independent recovery evidence.
    this.database.prepare(`UPDATE remote_worker_receipts SET payload_json=CASE
      WHEN json_type(payload_json, '$.recovery') IS NOT NULL
      THEN json_set(?, '$.recovery', json_extract(payload_json, '$.recovery')) ELSE ? END
      WHERE attempt_id=?`).run(JSON.stringify(receipt), JSON.stringify(receipt), receipt.assignment.attemptId);
  }
}
