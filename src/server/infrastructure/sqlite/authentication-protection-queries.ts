import type Database from "better-sqlite3";
import {
  passkeyFingerprint, totpBinding,
  type BoundedProtectionTable, type NativeProtectionState, type ProtectionContextRow, type ProtectionReceiptRow,
  type ProtectionStagedRow, type ProtectionStore, type ProtectionTrustRow, type ProviderAccountState, type ProviderSessionEvidence, type ProviderSessionState,
} from "@/server/modules/authentication";

const TABLES: Record<BoundedProtectionTable, string> = {
  contexts: "authentication_factor_contexts", receipts: "authentication_factor_receipts",
  budgets: "authentication_factor_budgets", staged: "authentication_passkey_staged",
};
const flag = (value: unknown) => value === 1;
const instant = (value: string | number) => new Date(value).toISOString();
const milliseconds = (value: unknown) => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
const CONTEXT = `capability, purpose, subject, principal_id AS principalId, session_id AS sessionId, native_id AS nativeId, handle, credential, binding,
  generation, policy_revision AS policyRevision, authenticated_at AS authenticatedAt, original_deadline AS originalDeadline, deadline, used`;
const RECEIPT = `attempt_id AS attemptId, capability, purpose, subject, principal_id AS principalId, credential, binding, generation,
  policy_revision AS policyRevision, epoch, deadline, state, session_id AS sessionId`;
const STAGED = `credential_id AS credential, native_id AS nativeId, capability, subject, handle, fingerprint, generation,
  policy_revision AS policyRevision, session_id AS sessionId, original_deadline AS originalDeadline, deadline`;
const EVIDENCE = `session_id AS sessionId, subject, method, authenticated_at AS authenticatedAt, original_deadline AS originalDeadline, generation,
  policy_revision AS policyRevision, credential, credential_binding AS credentialBinding, attempt_id AS attemptId`;

/**
 * Migration 40 row operations on the guarded core handle. Runs inside a provider
 * borrow or a core admission and joins any open transaction. It opens nothing,
 * and policy lives in `AccountProtection`.
 */
export class AuthenticationProtectionQueries implements ProtectionStore {
  constructor(private readonly database: Database.Database, private readonly providerId: string) {}

  activePrincipal(subject: string): string | null {
    const row = this.database.prepare(`SELECT s.principal_id FROM authentication_provider_subjects s
      JOIN remote_principals p ON p.id = s.principal_id
      WHERE s.provider_id = ? AND s.subject = ? AND s.status = 'active' AND s.revoked_at IS NULL AND p.kind = 'owner' AND p.status = 'active'`)
      .get(this.providerId, subject) as { principal_id: string } | undefined;
    return row?.principal_id ?? null;
  }

  account(subject: string): Omit<ProviderAccountState, "consistent"> | null {
    const row = this.database.prepare(`SELECT generation, policy_revision, totp_selected, passkey_selected FROM authentication_account_policies
      WHERE provider_id = ? AND subject = ?`).get(this.providerId, subject) as { generation: number; policy_revision: number; totp_selected: number; passkey_selected: number } | undefined;
    return row ? { generation: row.generation, policyRevision: row.policy_revision, totpSelected: flag(row.totp_selected), passkeySelected: flag(row.passkey_selected) } : null;
  }

  createAccount(subject: string, now: string): void {
    this.database.prepare(`INSERT INTO authentication_account_policies(provider_id, subject, generation, policy_revision, totp_selected, passkey_selected, updated_at)
      VALUES (?, ?, 1, 1, 0, 0, ?)`).run(this.providerId, subject, now);
  }

  advanceAccount(subject: string, select: "totp" | "passkey", expected: { generation: number; policyRevision: number }, now: string): boolean {
    const column = select === "totp" ? "totp_selected" : "passkey_selected";
    return this.database.prepare(`UPDATE authentication_account_policies SET generation = generation + 1, policy_revision = policy_revision + 1, ${column} = 1, updated_at = ?
      WHERE provider_id = ? AND subject = ? AND generation = ? AND policy_revision = ? AND ${column} = 0`)
      .run(now, this.providerId, subject, expected.generation, expected.policyRevision).changes === 1;
  }

  native(subject: string): NativeProtectionState {
    const user = this.database.prepare('SELECT "twoFactorEnabled" AS enabled FROM "authentication_ba_user" WHERE "id" = ?').get(subject) as { enabled: number | null } | undefined;
    const factor = this.database.prepare('SELECT "id" AS id, "secret" AS secret, "verified" AS verified FROM "authentication_ba_two_factor" WHERE "userId" = ?').get(subject) as { id: string; secret: string; verified: number | null } | undefined;
    const trusted = this.database.prepare("SELECT count(*) n FROM authentication_passkey_trust WHERE provider_id = ? AND subject = ?").get(this.providerId, subject) as { n: number };
    return { twoFactorEnabled: flag(user?.enabled), totp: factor ? { id: factor.id, verified: flag(factor.verified), binding: totpBinding(factor.secret) } : null, trusted: trusted.n };
  }

  /** Core-only authority projection: excludes token, password, ciphertext and contact data. */
  sessionState(sessionId: string): ProviderSessionState | null {
    const row = this.database.prepare(`SELECT s."userId" AS subject, s."createdAt" AS createdAt, s."expiresAt" AS expiresAt, m.principal_id AS principalId
      FROM "authentication_ba_session" s
      JOIN authentication_provider_subjects m ON m.provider_id = ? AND m.subject = s."userId"
      JOIN remote_principals p ON p.id = m.principal_id
      WHERE s."id" = ? AND m.status = 'active' AND m.revoked_at IS NULL AND p.kind = 'owner' AND p.status = 'active'`)
      .get(this.providerId, sessionId) as Omit<ProviderSessionState, "evidence" | "account" | "currentBinding"> | undefined;
    if (!row) return null;
    const evidence = this.evidence(sessionId), account = this.account(row.subject), native = this.native(row.subject);
    const consistent = !!account && account.totpSelected === (native.twoFactorEnabled && native.totp?.verified === true) && account.passkeySelected === (native.trusted > 0);
    return { ...row, evidence, account: account && { ...account, consistent }, currentBinding: evidence ? this.#binding(evidence, native) : null };
  }

  #binding(evidence: ProviderSessionEvidence, native: NativeProtectionState): string | null {
    if (evidence.method === "password_totp") return native.totp?.verified && native.totp.id === evidence.credential ? native.totp.binding : null;
    if (evidence.method !== "passkey_uv" || !evidence.credential) return null;
    const trust = this.trust(evidence.credential), row = this.passkey(evidence.credential);
    return trust && row && trust.subject === evidence.subject && row.subject === evidence.subject && row.nativeId === trust.nativeId
      && passkeyFingerprint(row.nativeId, row.publicKey) === trust.fingerprint ? trust.fingerprint : null;
  }

  session(sessionId: string): { subject: string; createdAt: string; expiresAt: string } | null {
    const row = this.database.prepare('SELECT "userId" AS subject, "createdAt" AS createdAt, "expiresAt" AS expiresAt FROM "authentication_ba_session" WHERE "id" = ?')
      .get(sessionId) as { subject: string; createdAt: string | number; expiresAt: string | number } | undefined;
    return row ? { subject: row.subject, createdAt: instant(row.createdAt), expiresAt: instant(row.expiresAt) } : null;
  }

  evidence(sessionId: string): ProviderSessionEvidence | null {
    return (this.database.prepare(`SELECT ${EVIDENCE} FROM authentication_session_evidence WHERE session_id = ? AND provider_id = ?`).get(sessionId, this.providerId) as ProviderSessionEvidence | undefined) ?? null;
  }

  evidenceAttempt(attemptId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM authentication_session_evidence WHERE attempt_id = ?").get(attemptId));
  }

  insertEvidence(evidence: ProviderSessionEvidence): void {
    this.database.prepare(`INSERT INTO authentication_session_evidence(session_id, provider_id, subject, method, authenticated_at, original_deadline, generation, policy_revision, credential, credential_binding, attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(evidence.sessionId, this.providerId, evidence.subject, evidence.method, evidence.authenticatedAt, evidence.originalDeadline,
      evidence.generation, evidence.policyRevision, evidence.credential, evidence.credentialBinding, evidence.attemptId);
  }

  clampSession(sessionId: string, originalDeadline: string): void {
    const current = this.session(sessionId);
    if (current && current.expiresAt > originalDeadline) this.database.prepare('UPDATE "authentication_ba_session" SET "expiresAt" = ? WHERE "id" = ?').run(originalDeadline, sessionId);
  }

  advanceStep(subject: string, step: number): boolean {
    return this.database.prepare(`INSERT INTO authentication_totp_steps(provider_id, subject, last_step) VALUES (?, ?, ?)
      ON CONFLICT(provider_id, subject) DO UPDATE SET last_step = excluded.last_step WHERE excluded.last_step > authentication_totp_steps.last_step`)
      .run(this.providerId, subject, step).changes === 1;
  }

  passkey(credential: string): { nativeId: string; subject: string; publicKey: string } | null {
    return (this.database.prepare('SELECT "id" AS nativeId, "userId" AS subject, "publicKey" AS publicKey FROM "authentication_ba_passkey" WHERE "credentialID" = ?').get(credential) as { nativeId: string; subject: string; publicKey: string } | undefined) ?? null;
  }

  trust(credential: string): ProtectionTrustRow | null {
    return (this.database.prepare("SELECT credential_id AS credential, native_id AS nativeId, subject, handle, fingerprint FROM authentication_passkey_trust WHERE credential_id = ?").get(credential) as ProtectionTrustRow | undefined) ?? null;
  }

  insertTrust(row: ProtectionTrustRow, now: string): void {
    this.database.prepare(`INSERT INTO authentication_passkey_trust(credential_id, native_id, provider_id, subject, handle, fingerprint, verified_uv, trusted_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(row.credential, row.nativeId, this.providerId, row.subject, row.handle, row.fingerprint, now);
  }

  stagedForCapability(capability: string): ProtectionStagedRow | null {
    return (this.database.prepare(`SELECT ${STAGED} FROM authentication_passkey_staged WHERE capability = ?`).get(capability) as ProtectionStagedRow | undefined) ?? null;
  }

  staged(credential: string): ProtectionStagedRow | null {
    return (this.database.prepare(`SELECT ${STAGED} FROM authentication_passkey_staged WHERE credential_id = ?`).get(credential) as ProtectionStagedRow | undefined) ?? null;
  }

  insertStaged(row: ProtectionStagedRow): void {
    this.database.prepare(`INSERT INTO authentication_passkey_staged(credential_id, native_id, capability, provider_id, subject, handle, fingerprint, generation, policy_revision, session_id, original_deadline, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.credential, row.nativeId, row.capability, this.providerId, row.subject, row.handle, row.fingerprint, row.generation, row.policyRevision, row.sessionId, row.originalDeadline, row.deadline);
  }

  removeStaged(credential: string): void {
    this.database.prepare("DELETE FROM authentication_passkey_staged WHERE credential_id = ?").run(credential);
  }

  context(capability: string): ProtectionContextRow | null {
    return (this.database.prepare(`SELECT ${CONTEXT} FROM authentication_factor_contexts WHERE capability = ?`).get(capability) as ProtectionContextRow | undefined) ?? null;
  }

  insertContext(row: ProtectionContextRow): void {
    this.database.prepare(`INSERT INTO authentication_factor_contexts(capability, provider_id, purpose, subject, principal_id, session_id, native_id, handle, credential, binding, generation, policy_revision, authenticated_at, original_deadline, deadline, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.capability, this.providerId, row.purpose, row.subject, row.principalId, row.sessionId, row.nativeId, row.handle,
      row.credential, row.binding, row.generation, row.policyRevision, row.authenticatedAt, row.originalDeadline, row.deadline, row.used);
  }

  replaceContexts(purpose: ProtectionContextRow["purpose"], sessionId: string): void {
    this.database.prepare(`DELETE FROM authentication_factor_contexts WHERE purpose = ? AND session_id = ? AND used = 0
      AND NOT EXISTS (SELECT 1 FROM authentication_factor_receipts r WHERE r.capability = authentication_factor_contexts.capability AND r.state = 'charged')`).run(purpose, sessionId);
  }

  markContextUsed(capability: string): void {
    this.database.prepare("UPDATE authentication_factor_contexts SET used = 1 WHERE capability = ?").run(capability);
  }

  nativeVerification(nativeId: string): { value: string; expiresAt: number } | null {
    const row = this.database.prepare('SELECT "value" AS value, "expiresAt" AS expiresAt FROM "authentication_ba_verification" WHERE "id" = ?').get(nativeId) as { value: string; expiresAt: string | number } | undefined;
    return row ? { value: row.value, expiresAt: milliseconds(row.expiresAt) } : null;
  }

  budget(scope: "totp" | "passkey", subject: string, epoch: number): number {
    return (this.database.prepare("SELECT charged FROM authentication_factor_budgets WHERE provider_id = ? AND scope = ? AND subject = ? AND epoch = ?").get(this.providerId, scope, subject, epoch) as { charged: number } | undefined)?.charged ?? 0;
  }

  charge(scope: "totp" | "passkey", subject: string, epoch: number, charged: number): void {
    this.database.prepare(`INSERT INTO authentication_factor_budgets(provider_id, scope, subject, epoch, charged) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, scope, subject, epoch) DO UPDATE SET charged = excluded.charged`).run(this.providerId, scope, subject, epoch, charged);
  }

  receipt(attemptId: string): ProtectionReceiptRow | null {
    const row = this.database.prepare(`SELECT ${RECEIPT} FROM authentication_factor_receipts WHERE attempt_id = ?`).get(attemptId) as Omit<ProtectionReceiptRow, "handle"> | undefined;
    if (!row) return null;
    const context = this.context(row.capability);
    return { ...row, handle: context?.handle ?? null };
  }

  insertReceipt(row: ProtectionReceiptRow): void {
    this.database.prepare(`INSERT INTO authentication_factor_receipts(attempt_id, provider_id, capability, purpose, subject, principal_id, credential, binding, generation, policy_revision, epoch, deadline, state, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.attemptId, this.providerId, row.capability, row.purpose, row.subject, row.principalId, row.credential, row.binding,
      row.generation, row.policyRevision, row.epoch, row.deadline, row.state, row.sessionId);
  }

  finishReceipt(attemptId: string, state: "succeeded" | "failed", sessionId: string | null): void {
    this.database.prepare("UPDATE authentication_factor_receipts SET state = ?, session_id = ? WHERE attempt_id = ? AND state = 'charged'").run(state, sessionId, attemptId);
  }

  count(table: BoundedProtectionTable): number {
    return (this.database.prepare(`SELECT count(*) n FROM ${TABLES[table]}`).get() as { n: number }).n;
  }

  /**
   * Bounded per call. Admission holds the exclusive borrow, so an expired charged
   * attempt cannot still be running: it lost its process and is settled as failed.
   * Its charge remains. A promoted credential is never pruned.
   */
  prune(now: number, pruneBatch: number, epochs: { totp: number; passkey: number }): void {
    this.database.prepare(`UPDATE authentication_factor_receipts SET state = 'failed' WHERE attempt_id IN
      (SELECT attempt_id FROM authentication_factor_receipts WHERE state = 'charged' AND deadline <= ? LIMIT ?)`).run(now, pruneBatch);
    const stale = this.database.prepare(`SELECT ${STAGED} FROM authentication_passkey_staged s WHERE s.deadline <= ?
      AND NOT EXISTS (SELECT 1 FROM authentication_factor_receipts r WHERE r.credential = s.credential_id AND r.state = 'charged') LIMIT ?`).all(now, pruneBatch) as ProtectionStagedRow[];
    for (const stage of stale) {
      this.removeStaged(stage.credential);
      if (!this.trust(stage.credential)) this.database.prepare('DELETE FROM "authentication_ba_passkey" WHERE "id" = ? AND "credentialID" = ?').run(stage.nativeId, stage.credential);
    }
    this.database.prepare(`DELETE FROM authentication_factor_receipts WHERE attempt_id IN (SELECT attempt_id FROM authentication_factor_receipts WHERE state != 'charged' AND deadline <= ? LIMIT ?)`).run(now, pruneBatch);
    this.database.prepare(`DELETE FROM authentication_factor_contexts WHERE capability IN (SELECT c.capability FROM authentication_factor_contexts c WHERE c.deadline <= ?
      AND NOT EXISTS (SELECT 1 FROM authentication_factor_receipts r WHERE r.capability = c.capability AND r.state = 'charged') LIMIT ?)`).run(now, pruneBatch);
    for (const scope of ["totp", "passkey"] as const) {
      this.database.prepare(`DELETE FROM authentication_factor_budgets WHERE rowid IN (SELECT b.rowid FROM authentication_factor_budgets b WHERE b.scope = ? AND b.epoch < ?
        AND NOT EXISTS (SELECT 1 FROM authentication_factor_receipts r WHERE r.subject = b.subject AND r.epoch = b.epoch AND r.state = 'charged') LIMIT ?)`).run(scope, epochs[scope], pruneBatch);
    }
  }
}
