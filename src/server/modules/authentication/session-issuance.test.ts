import { describe, expect, it, vi } from "vitest";
import { recoverIssuedSessions, SessionIssuance, SessionIssuanceError, validateSessionRowPolicy, type SessionIssuanceStore } from "./session-issuance";

const POLICY = { sessionRows: 2, sessionReconcileBatch: 1 };
const EVIDENCE = { sessionId: "new", subject: "subject", method: "password" as const, authenticatedAt: "2026-11-02T00:00:00.000Z", originalDeadline: "2026-11-02T08:00:00.000Z",
  generation: 1, policyRevision: 1, credential: null, credentialBinding: null, attemptId: "attempt" };
function store(overrides: Partial<SessionIssuanceStore> = {}): SessionIssuanceStore {
  return { inTransaction: () => true, nativeSessions: () => 0, insertPending: vi.fn(), state: () => "pending", markMayPublish: () => true,
    removePendingBatch: () => ({ removed: 0, remaining: false }), pruneExpiredBatch: () => 0, ...overrides };
}

describe("session row policy", () => {
  it.each([undefined, {}, { sessionRows: 1 }, { sessionReconcileBatch: 1 }, { sessionRows: 0, sessionReconcileBatch: 1 }, { sessionRows: 1, sessionReconcileBatch: 0 },
    { sessionRows: 1.5, sessionReconcileBatch: 1 }, { sessionRows: -1, sessionReconcileBatch: 1 }, { sessionRows: "1", sessionReconcileBatch: 1 },
    { sessionRows: Number.MAX_SAFE_INTEGER, sessionReconcileBatch: 1 }, { sessionRows: 1, sessionReconcileBatch: Number.MAX_VALUE }])("rejects %j, with no default", input => {
    expect(() => validateSessionRowPolicy(input)).toThrow(SessionIssuanceError);
  });
  it("keeps exact values, including the largest whose count limit stays exact", () => {
    expect(validateSessionRowPolicy({ sessionRows: Number.MAX_SAFE_INTEGER - 1, sessionReconcileBatch: 1 })).toEqual({ sessionRows: Number.MAX_SAFE_INTEGER - 1, sessionReconcileBatch: 1 });
  });
});

describe("session issuance", () => {
  it("cannot mint or record without a policy", () => {
    const issuance = new SessionIssuance(store(), null), insert = vi.fn();
    expect(issuance.bounded).toBe(false);
    expect(issuance.roomBeforeMint("2026-11-02T00:00:00.000Z")).toBe(false);
    expect(() => { issuance.record(EVIDENCE, insert); }).toThrow(SessionIssuanceError);
    expect(insert).not.toHaveBeenCalled();
  });
  it("prunes first, and treats a count at the bound as full", () => {
    const order: string[] = [];
    const issuance = new SessionIssuance(store({ pruneExpiredBatch: () => { order.push("prune"); return 0; }, nativeSessions: limit => { order.push(`count ${limit}`); return limit; } }), POLICY);
    expect(issuance.roomBeforeMint("2026-11-02T00:00:00.000Z")).toBe(false);
    expect(order).toEqual(["prune", "count 2"]);
  });
  it("refuses evidence outside an open transaction, so no marker can commit on its own", () => {
    const insertPending = vi.fn(), insert = vi.fn();
    expect(() => { new SessionIssuance(store({ inTransaction: () => false, insertPending }), POLICY).record(EVIDENCE, insert); }).toThrow(SessionIssuanceError);
    expect(insert).not.toHaveBeenCalled(); expect(insertPending).not.toHaveBeenCalled();
  });
  it("writes evidence then its marker with the exact deadline, and throws past the bound for the transaction to roll back", () => {
    const calls: unknown[] = [], tracked = (count: number) => store({ insertPending: (id, deadline) => { calls.push([id, deadline]); }, nativeSessions: () => count });
    new SessionIssuance(tracked(2), POLICY).record(EVIDENCE, () => { calls.push("evidence"); });
    expect(calls).toEqual(["evidence", ["new", EVIDENCE.originalDeadline]]);
    expect(() => { new SessionIssuance(tracked(3), POLICY).record(EVIDENCE, () => undefined); }).toThrow(SessionIssuanceError);
  });
  it("treats a refused mark as a failure, never as a success", () => {
    expect(() => { new SessionIssuance(store({ markMayPublish: () => false }), POLICY).publish("new", EVIDENCE.originalDeadline); }).toThrow(SessionIssuanceError);
  });
});

describe("ordinary-restart recovery", () => {
  const run = <T>(operation: () => T) => Promise.resolve().then(operation);
  const input = (overrides: Partial<SessionIssuanceStore>, provenance: "ordinary" | "restored" | "unconfirmed" = "ordinary") =>
    ({ provenance, policy: { sessionRows: 8, sessionReconcileBatch: 2 }, store: store(overrides), run, now: () => "2026-11-02T00:00:00.000Z" });

  it.each(["restored", "unconfirmed"] as const)("touches nothing for %s provenance", async provenance => {
    const removePendingBatch = vi.fn(), pruneExpiredBatch = vi.fn();
    await expect(recoverIssuedSessions(input({ removePendingBatch, pruneExpiredBatch }, provenance))).rejects.toThrow(SessionIssuanceError);
    expect(removePendingBatch).not.toHaveBeenCalled(); expect(pruneExpiredBatch).not.toHaveBeenCalled();
  });
  it("works in admitted batches until nothing is pending, then prunes while whole batches come back", async () => {
    const pending = [{ removed: 2, remaining: true }, { removed: 2, remaining: true }, { removed: 1, remaining: false }], expired = [2, 2, 0];
    let admissions = 0;
    await recoverIssuedSessions({ ...input({ removePendingBatch: () => pending.shift()!, pruneExpiredBatch: () => expired.shift()! }), run: operation => { admissions++; return run(operation); } });
    expect(pending).toEqual([]); expect(expired).toEqual([]);
    expect(admissions).toBe(6);
  });
  it("fails readiness when a pending row stays and nothing moved, without ever pruning past it", async () => {
    const pruneExpiredBatch = vi.fn();
    await expect(recoverIssuedSessions(input({ removePendingBatch: () => ({ removed: 0, remaining: true }), pruneExpiredBatch }))).rejects.toThrow("could not resolve");
    expect(pruneExpiredBatch).not.toHaveBeenCalled();
  });
  it("lets a store failure fail readiness", async () => {
    await expect(recoverIssuedSessions(input({ removePendingBatch: () => { throw new Error("SQLite detail"); } }))).rejects.toThrow("SQLite detail");
  });
});
