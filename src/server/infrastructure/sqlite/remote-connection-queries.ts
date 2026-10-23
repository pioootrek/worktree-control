import type Database from "better-sqlite3";
import type { RemoteConnectionStore, WorkerReceipt, WorkerReceiptSummary } from "@/server/modules/remote-verification";
import type { RemoteWorkerReport } from "@/shared/contracts/remote-verification";

function payload<T>(row: unknown): T | null {
  return row ? JSON.parse((row as { payload_json: string }).payload_json) as T : null;
}
/** Borrows the singleton owner's SQLite connection. */
export class RemoteConnectionQueries implements RemoteConnectionStore {
  private readonly pendingCursors = new Map<string, [string, string]>();
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
  cancellationAttempts(workerId: string): string[] {
    return (this.database.prepare(`SELECT a.id FROM remote_verification_attempts a
      JOIN remote_verification_cancellations c ON c.request_id=a.request_id
      WHERE a.worker_id=? AND a.phase NOT IN ('succeeded','failed','cancelled') LIMIT 100`)
      .all(workerId) as { id: string }[]).map(x => x.id);
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
      json_extract(payload_json, '$.assignment') assignment_json,
      json_extract(payload_json, '$.localRunId') localRunId,
      json_extract(payload_json, '$.cancellationRequested') cancellationRequested,
      json_extract(payload_json, '$.acknowledgedSequence') acknowledgedSequence,
      json_array_length(payload_json, '$.reports') reportCount,
      json_extract(payload_json, '$.reports[#-1].phase') lastPhase,
      json_extract(payload_json, '$.reports[#-1].execution.cleanup') cleanup
      FROM remote_worker_receipts LIMIT 1001`).all() as Array<Omit<WorkerReceiptSummary, "assignment" | "cancellationRequested"> & { assignment_json: string; cancellationRequested: number }>;
    if (rows.length > 1000) throw new Error("worker_receipt_capacity_exhausted");
    return rows.map(({ assignment_json, cancellationRequested, ...row }) => ({
      ...row, assignment: JSON.parse(assignment_json), cancellationRequested: cancellationRequested === 1,
    }));
  }
  saveReceipt(receipt: WorkerReceipt): void {
    this.database.prepare("UPDATE remote_worker_receipts SET payload_json=? WHERE attempt_id=?").run(JSON.stringify(receipt), receipt.assignment.attemptId);
  }
}
