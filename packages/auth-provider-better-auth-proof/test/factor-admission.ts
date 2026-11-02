import { createHash, createHmac, randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import type { ProviderSqliteConnection } from "../../../src/server/modules/authentication/provider-contract";

/** Temporary fixture policy, deliberately unrelated to approved product defaults. */
export const FIXTURE_ADMISSION_POLICY = {
  attempts: 4, windowMs: 60_000, ticketMs: 15_000, capacity: 64, pruneBatch: 8, replayCapacity: 256,
} as const;
export type AdmissionPolicy = { -readonly [K in keyof typeof FIXTURE_ADMISSION_POLICY]: number };
export const ADMISSION = {
  subjects: "factor_admission_subjects", contexts: "factor_admission_contexts",
  budgets: "factor_admission_budgets", receipts: "factor_admission_receipts", evidence: "factor_admission_evidence",
  replay: "factor_consumed_presentations", replayKey: "factor_replay_key",
} as const;

/** Applied only by the temporary store owner, never by provider initialization. */
export const ADMISSION_DDL = [
  `CREATE TABLE ${ADMISSION.replayKey} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), commitment TEXT NOT NULL)`,
  `CREATE TABLE ${ADMISSION.replay} (marker TEXT PRIMARY KEY, attemptId TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE ${ADMISSION.subjects} (subject TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE ${ADMISSION.contexts} (capability TEXT PRIMARY KEY, subject TEXT NOT NULL, purpose TEXT NOT NULL, credential TEXT NOT NULL, principalId TEXT NOT NULL, factorId TEXT NOT NULL, originSessionId TEXT, generation INTEGER NOT NULL, deadline INTEGER NOT NULL, authenticatedAt TEXT NOT NULL, originalDeadline TEXT NOT NULL, nativeId TEXT, used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE ${ADMISSION.budgets} (subject TEXT NOT NULL, epoch INTEGER NOT NULL, charged INTEGER NOT NULL, PRIMARY KEY(subject, epoch))`,
  `CREATE TABLE ${ADMISSION.receipts} (attemptId TEXT PRIMARY KEY, subject TEXT NOT NULL, capability TEXT NOT NULL, purpose TEXT NOT NULL, credential TEXT NOT NULL, principalId TEXT NOT NULL, factorId TEXT NOT NULL, originSessionId TEXT, generation INTEGER NOT NULL, epoch INTEGER NOT NULL, sequence INTEGER NOT NULL, deadline INTEGER NOT NULL, authenticatedAt TEXT NOT NULL, originalDeadline TEXT NOT NULL, state TEXT NOT NULL, sessionId TEXT)`,
  `CREATE TABLE ${ADMISSION.evidence} (sessionId TEXT PRIMARY KEY REFERENCES authentication_ba_session(id) ON DELETE CASCADE, subject TEXT NOT NULL, method TEXT NOT NULL CHECK(method = 'password'), observation TEXT NOT NULL, authenticatedAt TEXT NOT NULL, originalDeadline TEXT NOT NULL, generation INTEGER NOT NULL, credential TEXT, authorizingMfa INTEGER NOT NULL CHECK(authorizingMfa = 0), attemptId TEXT NOT NULL UNIQUE)`,
];

/** A hash of a high-entropy issued capability, never a hash of a short OTP. */
export const capabilityId = (opaque: string) => createHash("sha256").update(opaque).digest("hex");
export const serverAttemptId = () => randomUUID();
/** Standard HMAC, domain-separated JSON arrays of strings; no short-code hashes. */
export const replayHmac = (key: Uint8Array, domain: string, ...fields: string[]) =>
  createHmac("sha256", key).update(JSON.stringify(["wtc-factor-replay-v1", domain, ...fields])).digest("hex");
export const replayKeyCommitment = (key: Uint8Array) => replayHmac(key, "key-check");
export const validTotpSyntax = (code: string) => code.length === 6 && !/[^0-9]/.test(code);
export interface ReplayBinding { key: Uint8Array; encryptionSecret: string }
export type Purpose = "login" | "enrollment" | "reauthentication";
export interface BoundContext {
  capability: string; subject: string; purpose: Purpose; credential: string;
  principalId: string; factorId: string; originSessionId: string | null;
  generation: number; deadline: number; authenticatedAt: string; originalDeadline: string; nativeId: string | null; used: number;
}
export interface Ticket extends Omit<BoundContext, "nativeId" | "used"> {
  attemptId: string; epoch: number; sequence: number; state: string; sessionId: string | null;
}
export interface SessionEvidence {
  sessionId: string; subject: string; authenticatedAt: string; originalDeadline: string;
  observation: "password" | "enrollment" | "password_totp" | "recovery_code" | "reauthentication";
}
export interface AdmissionPort {
  bindContext(opaque: string, purpose: Purpose, now: number): Promise<BoundContext | null>;
  admit(context: BoundContext, attemptId: string, now: number): Promise<Ticket | null>;
  settleSuccess(ticket: Ticket, session: SessionEvidence, now: number, marker?: string): Promise<void>;
  readReceipt(attemptId: string): Ticket | null;
}

/**
 * No connection ownership, queue or lock. All calls require the existing owner
 * borrow. The caller commits admit() before invoking any native factor handler;
 * settleSuccess() joins the caller's separate Kysely success transaction.
 */
export class FixtureAdmission implements AdmissionPort {
  constructor(readonly connection: ProviderSqliteConnection, readonly policy: AdmissionPolicy, readonly replay?: ReplayBinding) {
    for (const value of Object.values(policy)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid fixture policy.");
  }
  #rows<T>(sql: string, args: readonly unknown[] = []): T[] { return this.connection.prepare(sql).all(args) as T[]; }
  #run(sql: string, args: readonly unknown[] = []) { return this.connection.prepare(sql).run(args); }

  generation(subject: string): number {
    if (!this.#rows(`SELECT 1 FROM ${ADMISSION.subjects} WHERE subject = ?`, [subject]).length && this.#count(ADMISSION.subjects) >= this.policy.capacity) throw new Error("Subject capacity.");
    this.#run(`INSERT OR IGNORE INTO ${ADMISSION.subjects} (subject) VALUES (?)`, [subject]);
    return this.#rows<{ generation: number }>(`SELECT generation FROM ${ADMISSION.subjects} WHERE subject = ?`, [subject])[0]!.generation;
  }
  #current(subject: string): boolean {
    return this.#rows(`SELECT 1 FROM authentication_provider_subjects m JOIN remote_principals p ON p.id = m.principal_id WHERE m.subject = ? AND m.provider_id = 'better-auth' AND m.status = 'active' AND m.revoked_at IS NULL AND p.kind = 'owner' AND p.status = 'active'`, [subject]).length === 1;
  }
  factor(subject: string) {
    return this.#rows<{ id: string; secret: string; verified: number }>('SELECT id, secret, verified FROM authentication_ba_two_factor WHERE "userId" = ?', [subject])[0];
  }
  assertReplayKey(): void {
    const stored = this.#rows<{ commitment: string }>(`SELECT commitment FROM ${ADMISSION.replayKey} WHERE singleton = 1`)[0];
    if (!this.replay || this.replay.key.byteLength !== 32 || stored?.commitment !== replayKeyCommitment(this.replay.key)) throw new Error("Fixture replay key unavailable.");
  }
  /** Supported library decryption only, never OTP enumeration/verification. No cache or plaintext persistence. */
  async credential(subject: string): Promise<string | null> {
    this.assertReplayKey();
    const factor = this.factor(subject);
    if (!factor) return null;
    const secret = await symmetricDecrypt({ key: this.replay!.encryptionSecret, data: factor.secret });
    // This candidate admits native-generated secrets only, not alternate imported encodings.
    if (!secret.length || /[^A-Za-z0-9_-]/.test(secret)) throw new Error("Fixture factor binding unavailable.");
    return replayHmac(this.replay!.key, "incarnation", "better-auth", subject, secret);
  }
  async presentation(ticket: Ticket, code: string): Promise<string> {
    this.assertReplayKey();
    if (!validTotpSyntax(code) || await this.credential(ticket.subject) !== ticket.credential) throw new Error("Presentation refused.");
    return replayHmac(this.replay!.key, "presentation", "better-auth", ticket.subject, ticket.credential, code);
  }
  replayAvailable(marker: string): boolean {
    this.assertReplayKey();
    return this.#count(ADMISSION.replay) < this.policy.replayCapacity && !this.#rows(`SELECT 1 FROM ${ADMISSION.replay} WHERE marker = ?`, [marker]).length;
  }
  #principal(subject: string): string | null {
    return this.#rows<{ principal_id: string }>("SELECT principal_id FROM authentication_provider_subjects WHERE provider_id = 'better-auth' AND subject = ?", [subject])[0]?.principal_id ?? null;
  }

  /** Native session refresh cannot redefine the original password lifetime. */
  enrollmentOrigin(sessionId: string, subject: string, now: number): Pick<SessionEvidence, "authenticatedAt" | "originalDeadline"> | null {
    const row = this.#rows<{ authenticatedAt: string; originalDeadline: string }>(
      `SELECT e.authenticatedAt, e.originalDeadline FROM ${ADMISSION.evidence} e
       JOIN authentication_ba_session s ON s.id = e.sessionId AND s."userId" = e.subject
       JOIN ${ADMISSION.subjects} g ON g.subject = e.subject AND g.generation = e.generation
       WHERE e.sessionId = ? AND e.subject = ? AND e.method = 'password' AND e.authorizingMfa = 0 AND s."expiresAt" > ?`,
      [sessionId, subject, now],
    )[0];
    if (!row || !this.#current(subject)) return null;
    const start = Date.parse(row.authenticatedAt), deadline = Date.parse(row.originalDeadline);
    return Number.isFinite(start) && Number.isFinite(deadline) && start <= now && deadline > now && start < deadline ? row : null;
  }

  /** Only called with a capability from a completed, successful native outcome. */
  async issue(opaque: string, subject: string, purpose: Purpose, deadline: number, nativeId: string | null, now: number, origin: Pick<SessionEvidence, "authenticatedAt" | "originalDeadline">, originSessionId: string | null = null): Promise<void> {
    this.prune(now);
    const credential = await this.credential(subject);
    if (!credential || !this.#current(subject) || deadline <= now || this.#count(ADMISSION.contexts) >= this.policy.capacity) throw new Error("Context unavailable.");
    this.#run(`INSERT INTO ${ADMISSION.contexts} (capability, subject, purpose, credential, principalId, factorId, originSessionId, generation, deadline, authenticatedAt, originalDeadline, nativeId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [capabilityId(opaque), subject, purpose, credential, this.#principal(subject), this.factor(subject)!.id, originSessionId, this.generation(subject), deadline, origin.authenticatedAt, origin.originalDeadline, nativeId]);
  }

  async bindContext(opaque: string, purpose: Purpose, now: number): Promise<BoundContext | null> {
    const row = this.#rows<BoundContext>(`SELECT * FROM ${ADMISSION.contexts} WHERE capability = ?`, [capabilityId(opaque)])[0];
    return row && row.purpose === purpose && await this.valid(row, now) ? row : null;
  }
  async valid(row: BoundContext, now: number): Promise<boolean> {
    if (row.used || row.deadline <= now || !this.#current(row.subject)) return false;
    const generation = this.#rows<{ generation: number }>(`SELECT generation FROM ${ADMISSION.subjects} WHERE subject = ?`, [row.subject])[0]?.generation;
    const factor = this.factor(row.subject);
    if (generation !== row.generation || !factor || await this.credential(row.subject) !== row.credential || factor.id !== row.factorId || this.#principal(row.subject) !== row.principalId) return false;
    if (row.purpose !== "enrollment" && (factor.verified !== 1 || !this.#enabled(row.subject))) return false;
    if (row.purpose === "enrollment" && factor.verified !== 0) return false;
    if (!this.#sessionCurrent(row, now)) return false;
    if (row.nativeId) {
      const pending = this.#rows<{ value: string; expiresAt: number }>('SELECT value, "expiresAt" FROM authentication_ba_verification WHERE id = ?', [row.nativeId])[0];
      if (!pending || pending.value !== row.subject || Number(pending.expiresAt) <= now) return false;
    }
    return true;
  }

  /** Must run inside the short admission transaction. No refund/reset exists. */
  async admit(context: BoundContext, attemptId: string, now: number): Promise<Ticket | null> {
    this.prune(now);
    if (this.readReceipt(attemptId) || !await this.valid(context, now) || this.#count(ADMISSION.receipts) >= this.policy.capacity) return null;
    const epoch = Math.floor(now / this.policy.windowMs);
    const old = this.#rows<{ charged: number }>(`SELECT charged FROM ${ADMISSION.budgets} WHERE subject = ? AND epoch = ?`, [context.subject, epoch])[0];
    if ((old?.charged ?? 0) >= this.policy.attempts || (!old && this.#count(ADMISSION.budgets) >= this.policy.capacity)) return null;
    const sequence = (old?.charged ?? 0) + 1;
    this.#run(`INSERT INTO ${ADMISSION.budgets} (subject, epoch, charged) VALUES (?, ?, ?) ON CONFLICT(subject, epoch) DO UPDATE SET charged = excluded.charged`, [context.subject, epoch, sequence]);
    this.#run(`INSERT INTO ${ADMISSION.receipts} (attemptId, subject, capability, purpose, credential, principalId, factorId, originSessionId, generation, epoch, sequence, deadline, authenticatedAt, originalDeadline, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'charged')`,
      [attemptId, context.subject, context.capability, context.purpose, context.credential, context.principalId, context.factorId, context.originSessionId, context.generation, epoch, sequence, Math.min(context.deadline, now + this.policy.ticketMs), context.authenticatedAt, context.originalDeadline]);
    if (context.purpose === "reauthentication") this.#run(`UPDATE ${ADMISSION.contexts} SET used = 1 WHERE capability = ?`, [context.capability]);
    return this.readReceipt(attemptId);
  }

  readReceipt(attemptId: string): Ticket | null {
    return this.#rows<Ticket>(`SELECT * FROM ${ADMISSION.receipts} WHERE attemptId = ?`, [attemptId])[0] ?? null;
  }
  #enabled(subject: string) {
    return this.#rows('SELECT 1 FROM authentication_ba_user WHERE id = ? AND "twoFactorEnabled" = 1', [subject]).length === 1;
  }
  #sessionCurrent(context: BoundContext, now: number): boolean {
    if (!context.originSessionId) return context.purpose === "login";
    const origin = this.enrollmentOrigin(context.originSessionId, context.subject, now);
    return !!origin && origin.authenticatedAt === context.authenticatedAt && origin.originalDeadline === context.originalDeadline;
  }
  async usable(ticket: Ticket, now: number, settlement = false): Promise<boolean> {
    const current = this.readReceipt(ticket.attemptId);
    const context = this.#rows<BoundContext>(`SELECT * FROM ${ADMISSION.contexts} WHERE capability = ?`, [ticket.capability])[0];
    const generation = this.#rows<{ generation: number }>(`SELECT generation FROM ${ADMISSION.subjects} WHERE subject = ?`, [ticket.subject])[0]?.generation;
    if (current?.state !== "charged" || !context || context.deadline <= now || ticket.deadline <= now || ticket.epoch !== Math.floor(now / this.policy.windowMs)
      || generation !== ticket.generation || !this.#current(ticket.subject) || this.#principal(ticket.subject) !== ticket.principalId
      || await this.credential(ticket.subject) !== ticket.credential || this.factor(ticket.subject)?.id !== ticket.factorId) return false;
    for (const field of ["subject", "purpose", "credential", "principalId", "factorId", "originSessionId", "generation", "authenticatedAt", "originalDeadline"] as const) {
      if (current[field] !== ticket[field] || context[field] !== ticket[field]) return false;
    }
    if (context.used !== (ticket.purpose === "reauthentication" ? 1 : 0)) return false;
    if (settlement) {
      if (this.factor(ticket.subject)?.verified !== 1 || !this.#enabled(ticket.subject)) return false;
      // Native enrollment rotates/deletes its old session in this transaction.
      return ticket.purpose === "enrollment" || this.#sessionCurrent(context, now);
    }
    return this.valid({ ...context, used: 0 }, now);
  }
  async settleSuccess(ticket: Ticket, session: SessionEvidence, now: number, marker?: string): Promise<void> {
    if (!await this.usable(ticket, now, true) || session.subject !== ticket.subject) throw new Error("Stale settlement.");
    if (marker) {
      if (!this.replayAvailable(marker)) throw new Error("Presentation refused.");
      // Unique marker and success writes share the caller's actual success transaction.
      this.#run(`INSERT INTO ${ADMISSION.replay} (marker, attemptId) VALUES (?, ?)`, [marker, ticket.attemptId]);
    }
    if (ticket.purpose === "reauthentication") {
      if (session.sessionId !== ticket.originSessionId) throw new Error("Session changed.");
      this.#run(`UPDATE ${ADMISSION.evidence} SET observation = 'reauthentication', credential = ?, attemptId = ? WHERE sessionId = ? AND subject = ? AND generation = ?`, [ticket.credential, ticket.attemptId, session.sessionId, ticket.subject, ticket.generation]);
    } else {
      this.#run('UPDATE authentication_ba_session SET "expiresAt" = ? WHERE id = ?', [Math.min(Date.parse(session.originalDeadline), Date.parse(ticket.originalDeadline)), session.sessionId]);
      this.passwordEvidence(ticket.attemptId, { ...session, authenticatedAt: ticket.authenticatedAt, originalDeadline: ticket.originalDeadline }, ticket.generation, ticket.credential);
    }
    this.#run(`UPDATE ${ADMISSION.receipts} SET state = 'succeeded', sessionId = ? WHERE attemptId = ? AND state = 'charged'`, [session.sessionId, ticket.attemptId]);
    this.#run(`UPDATE ${ADMISSION.contexts} SET used = 1 WHERE capability = ?`, [ticket.capability]);
  }
  passwordEvidence(attemptId: string, session: SessionEvidence, generation: number, credential: string | null = null): void {
    const persisted = this.#rows('SELECT 1 FROM authentication_ba_session WHERE id = ? AND "userId" = ?', [session.sessionId, session.subject]);
    if (!this.#current(session.subject) || persisted.length !== 1) throw new Error("Session evidence refused.");
    if (this.#count(ADMISSION.evidence) >= this.policy.capacity || (session.observation === "password" && this.#count(ADMISSION.receipts) >= this.policy.capacity)) throw new Error("Evidence capacity.");
    this.#run(`INSERT INTO ${ADMISSION.evidence} (sessionId, subject, method, observation, authenticatedAt, originalDeadline, generation, credential, authorizingMfa, attemptId) VALUES (?, ?, 'password', ?, ?, ?, ?, ?, 0, ?)`,
      [session.sessionId, session.subject, session.observation, session.authenticatedAt, session.originalDeadline, generation, credential, attemptId]);
    if (session.observation === "password") this.#run(`INSERT INTO ${ADMISSION.receipts} (attemptId, subject, capability, purpose, credential, principalId, factorId, generation, epoch, sequence, deadline, authenticatedAt, originalDeadline, state, sessionId) VALUES (?, ?, '', 'password', '', ?, '', ?, 0, 0, ?, ?, ?, 'succeeded', ?)`,
      [attemptId, session.subject, this.#principal(session.subject), generation, Date.parse(session.originalDeadline), session.authenticatedAt, session.originalDeadline, session.sessionId]);
  }
  operationReceipt(attemptId: string, context: BoundContext, now: number): void {
    if (this.#count(ADMISSION.receipts) >= this.policy.capacity) throw new Error("Receipt capacity.");
    this.#run(`INSERT INTO ${ADMISSION.receipts} (attemptId, subject, capability, purpose, credential, principalId, factorId, originSessionId, generation, epoch, sequence, deadline, authenticatedAt, originalDeadline, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'succeeded')`,
      [attemptId, context.subject, context.capability, context.purpose, context.credential, context.principalId, context.factorId, context.originSessionId, context.generation, Math.floor(now / this.policy.windowMs), context.deadline, context.authenticatedAt, context.originalDeadline]);
  }
  finishFailure(attemptId: string): void {
    this.#run(`UPDATE ${ADMISSION.receipts} SET state = 'failed' WHERE attemptId = ? AND state = 'charged'`, [attemptId]);
  }
  #count(table: string) { return this.#rows<{ n: number }>(`SELECT count(*) n FROM ${table}`)[0]!.n; }
  prune(now: number): void {
    // A charged receipt is retained even past expiry until its execution settles.
    this.#run(`DELETE FROM ${ADMISSION.receipts} WHERE attemptId IN (SELECT attemptId FROM ${ADMISSION.receipts} WHERE state != 'charged' AND deadline <= ? LIMIT ?)`, [now, this.policy.pruneBatch]);
    this.#run(`DELETE FROM ${ADMISSION.contexts} WHERE capability IN (SELECT capability FROM ${ADMISSION.contexts} c WHERE deadline <= ? AND NOT EXISTS (SELECT 1 FROM ${ADMISSION.receipts} r WHERE r.capability = c.capability AND r.state = 'charged') LIMIT ?)`, [now, this.policy.pruneBatch]);
    this.#run(`DELETE FROM ${ADMISSION.budgets} WHERE rowid IN (SELECT rowid FROM ${ADMISSION.budgets} b WHERE epoch < ? AND NOT EXISTS (SELECT 1 FROM ${ADMISSION.receipts} r WHERE r.subject = b.subject AND r.epoch = b.epoch AND r.state = 'charged') LIMIT ?)`, [Math.floor(now / this.policy.windowMs), this.policy.pruneBatch]);
  }
}
