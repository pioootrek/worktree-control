import type Database from "better-sqlite3";
import type { SessionIssuanceState, SessionIssuanceStore } from "@/server/modules/authentication";

/** A row counted only with its native session and its unchanged evidence deadline. */
const OWNED = `FROM authentication_session_issuance i
  JOIN authentication_session_evidence e ON e.session_id = i.session_id AND e.original_deadline = i.original_deadline
  JOIN "authentication_ba_session" s ON s."id" = i.session_id`;

/**
 * Migration 41 row operations on the guarded core handle. They open nothing and
 * hold no policy. Each `Batch` deletes native rows only, in one short transaction
 * of its own; the foreign keys remove evidence and issuance with them.
 */
export class AuthenticationSessionIssuanceQueries implements SessionIssuanceStore {
  constructor(private readonly database: Database.Database) {}

  inTransaction(): boolean { return this.database.inTransaction; }

  nativeSessions(limit: number): number {
    return (this.database.prepare('SELECT count(*) n FROM (SELECT 1 FROM "authentication_ba_session" LIMIT ?)').get(limit) as { n: number }).n;
  }

  insertPending(sessionId: string, originalDeadline: string): void {
    this.database.prepare("INSERT INTO authentication_session_issuance(session_id, state, original_deadline) VALUES (?, 'pending', ?)").run(sessionId, originalDeadline);
  }

  state(sessionId: string): SessionIssuanceState {
    const row = this.database.prepare(`SELECT i.state AS state FROM "authentication_ba_session" s
      LEFT JOIN authentication_session_issuance i ON i.session_id = s."id" WHERE s."id" = ?`).get(sessionId) as { state: "pending" | "may_publish" | null } | undefined;
    return !row ? "absent" : row.state ?? "unclassified";
  }

  markMayPublish(sessionId: string, originalDeadline: string): boolean {
    return this.#commit(() => this.database.prepare(`UPDATE authentication_session_issuance SET state = 'may_publish'
      WHERE session_id = ? AND state = 'pending' AND original_deadline = ? AND EXISTS (SELECT 1 FROM authentication_session_evidence e
        WHERE e.session_id = authentication_session_issuance.session_id AND e.original_deadline = authentication_session_issuance.original_deadline)`)
      .run(sessionId, originalDeadline).changes === 1);
  }

  removePendingBatch(batch: number): { removed: number; remaining: boolean } {
    return this.#commit(() => {
      const removed = this.database.prepare(`DELETE FROM "authentication_ba_session" WHERE "id" IN
        (SELECT i.session_id ${OWNED} WHERE i.state = 'pending' ORDER BY i.state, i.session_id LIMIT ?)`).run(batch).changes;
      return { removed, remaining: Boolean(this.database.prepare("SELECT 1 FROM authentication_session_issuance WHERE state = 'pending' LIMIT 1").get()) };
    });
  }

  pruneExpiredBatch(now: string, batch: number): number {
    return this.#commit(() => this.database.prepare(`DELETE FROM "authentication_ba_session" WHERE "id" IN
      (SELECT i.session_id ${OWNED} WHERE i.state = 'may_publish' AND i.original_deadline <= ? ORDER BY i.state, i.original_deadline, i.session_id LIMIT ?)`).run(now, batch).changes);
  }

  /** Its own COMMIT is the point: joining a caller's open transaction would commit later. */
  #commit<T>(work: () => T): T {
    if (this.database.inTransaction) throw new Error("Session issuance requires its own transaction.");
    return this.database.transaction(work).immediate();
  }
}
