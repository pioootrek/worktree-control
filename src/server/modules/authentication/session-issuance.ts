import type { ProviderSessionEvidence } from "./provider-contract";

/**
 * Installation-wide limits on persisted native sessions. `sessionRows` counts every
 * row of every boot: released, possibly published, expired but unpruned, revoked
 * but present, and unclassified. `sessionReconcileBatch` caps what one reconciliation
 * transaction examines or deletes. Both are required inputs with no default.
 */
export interface SessionRowPolicy { sessionRows: number; sessionReconcileBatch: number }

/** `unclassified`: a native row with no marker. It predates migration 41 and is never an orphan. */
export type SessionIssuanceState = "absent" | "pending" | "may_publish" | "unclassified";

/** Rows only: joins nothing it does not own, opens nothing, decides nothing. */
export interface SessionIssuanceStore {
  inTransaction(): boolean;
  /** Saturates at `limit`, so an oversized table is never counted past what a caller needs. */
  nativeSessions(limit: number): number;
  insertPending(sessionId: string, originalDeadline: string): void;
  /** Throws when unreadable. An error is never `absent`. */
  state(sessionId: string): SessionIssuanceState;
  /** Commits its own short transaction. True only when this exact pending row moved. */
  markMayPublish(sessionId: string, originalDeadline: string): boolean;
  removePendingBatch(batch: number): { removed: number; remaining: boolean };
  pruneExpiredBatch(now: string, batch: number): number;
}

/** Fixed text only. No session ID, deadline or SQLite message crosses this boundary. */
export class SessionIssuanceError extends Error {
  constructor(message: string) { super(message); this.name = "SessionIssuanceError"; }
}

const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/** Rejects absent or nonsense bounds. `sessionRows + 1` must stay exact, because it bounds a query. */
export function validateSessionRowPolicy(policy: unknown): SessionRowPolicy {
  const input = policy as Partial<SessionRowPolicy> | undefined;
  if (!positive(input?.sessionRows) || !positive(input?.sessionReconcileBatch) || !Number.isSafeInteger(input!.sessionRows! + 1)) throw new SessionIssuanceError("Invalid session row policy.");
  return Object.freeze({ sessionRows: input!.sessionRows!, sessionReconcileBatch: input!.sessionReconcileBatch! });
}

/**
 * The durable half of session issuance, on the core handle only. A provider never
 * receives this object. Without a policy nothing here can mint, which is what a
 * maintenance-only load gets.
 */
export class SessionIssuance {
  constructor(private readonly store: SessionIssuanceStore, private readonly policy: SessionRowPolicy | null) {}

  get bounded(): boolean { return this.policy !== null; }

  /** In the actual borrow, immediately before native work. A value read earlier authorizes nothing. */
  roomBeforeMint(now: string): boolean {
    if (!this.policy) return false;
    this.store.pruneExpiredBatch(now, this.policy.sessionReconcileBatch);
    return this.store.nativeSessions(this.policy.sessionRows) < this.policy.sessionRows;
  }

  /**
   * Evidence and its marker, in the native session's own open transaction. Every
   * throw goes through that transaction's rollback, so a guard failure can never
   * leave a committed session without a marker.
   */
  record(evidence: ProviderSessionEvidence, insertEvidence: (evidence: ProviderSessionEvidence) => void): void {
    if (!this.policy || !this.store.inTransaction()) throw new SessionIssuanceError("Session issuance was refused.");
    insertEvidence(evidence);
    this.store.insertPending(evidence.sessionId, evidence.originalDeadline);
    if (this.store.nativeSessions(this.policy.sessionRows + 1) > this.policy.sessionRows) throw new SessionIssuanceError("Session issuance was refused.");
  }

  /**
   * After this COMMIT a cookie may leave, and the session counts until its original
   * deadline or a revocation. A throw says nothing about what is stored: the
   * COMMIT may have happened, so a caller must read `state` before any cleanup.
   */
  publish(sessionId: string, originalDeadline: string): void {
    if (!this.store.markMayPublish(sessionId, originalDeadline)) throw new SessionIssuanceError("Session publication was refused.");
  }

  state(sessionId: string): SessionIssuanceState { return this.store.state(sessionId); }
}

/**
 * The ordinary-restart pass of one owner. It runs before any issuer can exist, which
 * is what makes every `pending` row a dead process's leftover. Each batch commits
 * alone on a fresh admission, so a kill loses at most the batch in progress and the
 * next boot resumes from current rows. Any row it cannot resolve fails readiness.
 */
export async function recoverIssuedSessions(input: {
  provenance: "ordinary" | "restored" | "unconfirmed";
  policy: SessionRowPolicy;
  store: SessionIssuanceStore;
  run: <T>(operation: () => T) => Promise<T>;
  now: () => string;
}): Promise<void> {
  // A snapshot's `pending` row may have been published after that snapshot was taken.
  if (input.provenance !== "ordinary") throw new SessionIssuanceError("Session recovery is refused for this database's provenance.");
  const batch = input.policy.sessionReconcileBatch;
  for (;;) {
    const { removed, remaining } = await input.run(() => input.store.removePendingBatch(batch));
    if (!remaining) break;
    if (removed === 0) throw new SessionIssuanceError("Session recovery could not resolve a pending session.");
  }
  while (await input.run(() => input.store.pruneExpiredBatch(input.now(), batch)) === batch) { /* The next batch takes a fresh admission. */ }
}
