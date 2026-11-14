/**
 * Provider session fixtures for the session-freshness tests. Test-only; not
 * exported from the module's public API and not used by production code.
 *
 * Every session and its evidence are written by the real `AccountProtection`
 * and `SessionIssuance`: password login, TOTP and passkey enrollment, TOTP
 * login, passkey login and the inheritance of a password change. Only the
 * rows below them are hand-written: `MemoryProviderStore` is an in-memory
 * double of the SQLite row adapter (`AuthenticationProtectionQueries`), and
 * the native rows a provider library would write (users, sessions, the TOTP
 * secret, passkey rows, verification challenges) are set by the helpers here.
 */
import {
  AccountProtection, passkeyFingerprint, SessionIssuance, totpBinding,
  type BoundedProtectionTable, type NativeProtectionState, type ProtectionContextRow, type ProtectionReceiptRow, type ProtectionStagedRow,
  type ProtectionStore, type ProtectionTrustRow, type ProviderAccountState, type ProviderFactorLimits, type ProviderFactorTicket,
  type ProviderSessionEvidence, type ProviderSessionState, type SessionIssuanceState, type SessionIssuanceStore, type VerifiedProviderSession,
} from "@/server/modules/authentication";

export const PROVIDER_ID = "better-auth";
/** Native session lifetime the fixture gives every new session. */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow { subject: string; createdAt: string; expiresAt: string }
interface PrincipalRow { kind: "owner" | "human" | "agent"; status: "active" | "disabled" }
interface MappingRow { principalId: string; status: "active" | "revoked"; linkedAt: string }
interface NativeUser { twoFactorEnabled: boolean; totp: { id: string; secret: string; verified: boolean } | null }

const iso = (time: number) => new Date(time).toISOString();
const copy = <T>(value: T): T => structuredClone(value);

/**
 * In-memory rows for one provider. Mirrors the SQLite projection of
 * `AuthenticationProtectionQueries.sessionState`: a session counts only while
 * its subject's mapping and principal are active and the principal is an owner
 * or human; `consistent` and `currentBinding` are derived from native rows as
 * there.
 */
export class MemoryProviderStore implements ProtectionStore {
  readonly sessions = new Map<string, SessionRow>();
  readonly principals = new Map<string, PrincipalRow>();
  readonly mappings = new Map<string, MappingRow>();
  readonly users = new Map<string, NativeUser>();
  readonly accounts = new Map<string, Omit<ProviderAccountState, "consistent">>();
  readonly evidenceRows = new Map<string, ProviderSessionEvidence>();
  readonly passkeys = new Map<string, { nativeId: string; subject: string; publicKey: string }>();
  readonly trusts = new Map<string, ProtectionTrustRow>();
  readonly stagedRows = new Map<string, ProtectionStagedRow>();
  readonly contexts = new Map<string, ProtectionContextRow>();
  readonly receipts = new Map<string, ProtectionReceiptRow>();
  readonly budgets = new Map<string, number>();
  readonly verifications = new Map<string, { value: string; expiresAt: number }>();
  readonly steps = new Map<string, number>();
  readonly pending = new Set<string>();
  transaction = false;
  /** Every `sessionState` call, for tests that count reads. */
  reads = 0;

  /** Runs `body` as one native transaction. A throw discards nothing here: callers expect success. */
  inNativeTransaction<T>(body: () => T): T {
    this.transaction = true;
    try { return body(); } finally { this.transaction = false; }
  }

  activePrincipal(subject: string): string | null {
    const mapping = this.mappings.get(subject);
    const principal = mapping && this.principals.get(mapping.principalId);
    return mapping?.status === "active" && principal?.status === "active" && (principal.kind === "owner" || principal.kind === "human") ? mapping.principalId : null;
  }
  account(subject: string) { const row = this.accounts.get(subject); return row ? { ...row } : null; }
  createAccount(subject: string): void { this.accounts.set(subject, { generation: 1, policyRevision: 1, totpSelected: false, passkeySelected: false }); }
  advanceAccount(subject: string, select: "totp" | "passkey", expected: { generation: number; policyRevision: number }): boolean {
    const row = this.accounts.get(subject), column = select === "totp" ? "totpSelected" : "passkeySelected";
    if (!row || row.generation !== expected.generation || row.policyRevision !== expected.policyRevision || row[column]) return false;
    this.accounts.set(subject, { ...row, generation: row.generation + 1, policyRevision: row.policyRevision + 1, [column]: true });
    return true;
  }
  native(subject: string): NativeProtectionState {
    const user = this.users.get(subject);
    const trusted = [...this.trusts.values()].filter(row => row.subject === subject).length;
    return { twoFactorEnabled: !!user?.twoFactorEnabled, totp: user?.totp ? { id: user.totp.id, verified: user.totp.verified, binding: totpBinding(user.totp.secret) } : null, trusted };
  }
  sessionState(sessionId: string): ProviderSessionState | null {
    this.reads++;
    const session = this.sessions.get(sessionId);
    const mapping = session && this.mappings.get(session.subject);
    if (!session || !mapping || this.activePrincipal(session.subject) !== mapping.principalId) return null;
    const principal = this.principals.get(mapping.principalId)!;
    const evidence = this.evidence(sessionId), account = this.account(session.subject), native = this.native(session.subject);
    const consistent = !!account && account.totpSelected === (native.twoFactorEnabled && native.totp?.verified === true) && account.passkeySelected === (native.trusted > 0);
    return { principalKind: principal.kind as "owner" | "human", mappingLinkedAt: mapping.linkedAt, subject: session.subject, principalId: mapping.principalId,
      createdAt: session.createdAt, expiresAt: session.expiresAt, evidence, account: account && { ...account, consistent },
      currentBinding: evidence ? this.#binding(evidence, native) : null };
  }
  #binding(evidence: ProviderSessionEvidence, native: NativeProtectionState): string | null {
    if (evidence.method === "password_totp") return native.totp?.verified && native.totp.id === evidence.credential ? native.totp.binding : null;
    if (evidence.method !== "passkey_uv" || !evidence.credential) return null;
    const trust = this.trust(evidence.credential), row = this.passkey(evidence.credential);
    return trust && row && trust.subject === evidence.subject && row.subject === evidence.subject && row.nativeId === trust.nativeId
      && passkeyFingerprint(row.nativeId, row.publicKey) === trust.fingerprint ? trust.fingerprint : null;
  }
  session(sessionId: string) { const row = this.sessions.get(sessionId); return row ? { ...row } : null; }
  evidence(sessionId: string) { const row = this.evidenceRows.get(sessionId); return row ? { ...row } : null; }
  evidenceAttempt(attemptId: string): boolean { return [...this.evidenceRows.values()].some(row => row.attemptId === attemptId); }
  insertEvidence(evidence: ProviderSessionEvidence): void {
    if (this.evidenceRows.has(evidence.sessionId) || !this.sessions.has(evidence.sessionId)) throw new Error("evidence constraint");
    this.evidenceRows.set(evidence.sessionId, { ...evidence });
  }
  clampSession(sessionId: string, originalDeadline: string): void {
    const row = this.sessions.get(sessionId);
    if (row && row.expiresAt > originalDeadline) row.expiresAt = originalDeadline;
  }
  advanceStep(subject: string, step: number): boolean {
    const last = this.steps.get(subject);
    if (last !== undefined && step <= last) return false;
    this.steps.set(subject, step);
    return true;
  }
  passkey(credential: string) { const row = this.passkeys.get(credential); return row ? { ...row } : null; }
  trust(credential: string) { const row = this.trusts.get(credential); return row ? { ...row } : null; }
  insertTrust(row: ProtectionTrustRow): void { this.trusts.set(row.credential, { ...row }); }
  stagedForCapability(capability: string) { const row = [...this.stagedRows.values()].find(entry => entry.capability === capability); return row ? { ...row } : null; }
  staged(credential: string) { const row = this.stagedRows.get(credential); return row ? { ...row } : null; }
  insertStaged(row: ProtectionStagedRow): void { this.stagedRows.set(row.credential, { ...row }); }
  removeStaged(credential: string): void { this.stagedRows.delete(credential); }
  context(capability: string) { const row = this.contexts.get(capability); return row ? { ...row } : null; }
  insertContext(row: ProtectionContextRow): void { this.contexts.set(row.capability, { ...row }); }
  replaceContexts(purpose: ProtectionContextRow["purpose"], sessionId: string): void {
    for (const [key, row] of this.contexts) if (row.purpose === purpose && row.sessionId === sessionId && !row.used) this.contexts.delete(key);
  }
  markContextUsed(capability: string): void { const row = this.contexts.get(capability); if (row) row.used = 1; }
  nativeVerification(nativeId: string) { const row = this.verifications.get(nativeId); return row ? { ...row } : null; }
  budget(scope: "totp" | "passkey", subject: string, epoch: number): number { return this.budgets.get(`${scope}\0${subject}\0${epoch}`) ?? 0; }
  charge(scope: "totp" | "passkey", subject: string, epoch: number, charged: number): void { this.budgets.set(`${scope}\0${subject}\0${epoch}`, charged); }
  receipt(attemptId: string) { const row = this.receipts.get(attemptId); return row ? { ...row } : null; }
  succeededReceipt(capability: string) { const row = [...this.receipts.values()].find(entry => entry.capability === capability && entry.state === "succeeded"); return row ? { ...row } : null; }
  insertReceipt(row: ProtectionReceiptRow): void { this.receipts.set(row.attemptId, { ...row }); }
  finishReceipt(attemptId: string, state: "succeeded" | "failed", sessionId: string | null): void {
    const row = this.receipts.get(attemptId);
    if (row) { row.state = state; row.sessionId = sessionId; }
  }
  count(table: BoundedProtectionTable): number {
    return { contexts: this.contexts, receipts: this.receipts, budgets: this.budgets, staged: this.stagedRows, verifications: this.verifications }[table].size;
  }
  prune(): void { /* Bounded by the test's size; nothing to reclaim. */ }

  /** The issuance marker rows on the same "connection". */
  issuanceStore(): SessionIssuanceStore {
    return {
      inTransaction: () => this.transaction,
      nativeSessions: limit => Math.min(this.sessions.size, limit),
      insertPending: sessionId => { this.pending.add(sessionId); },
      state: (sessionId): SessionIssuanceState => (this.pending.has(sessionId) ? "pending" : this.sessions.has(sessionId) ? "may_publish" : "absent"),
      markMayPublish: sessionId => this.pending.delete(sessionId),
      removePendingBatch: () => ({ removed: 0, remaining: false }),
      pruneExpiredBatch: () => 0,
    };
  }

  /** What `AuthenticationProviderStorage.currentSession` returns: a fresh projection, copied. */
  currentSession(providerId: string, sessionId: string): ProviderSessionState | null {
    if (providerId !== PROVIDER_ID) return null;
    const state = this.sessionState(sessionId);
    return state ? copy(state) : null;
  }
}

export const FACTOR_LIMITS: ProviderFactorLimits = {
  totp: { attempts: 5, windowMs: 60_000 }, passkey: { attempts: 5, windowMs: 60_000 },
  ticketMs: 60_000, stagingMs: 600_000, capacity: 1000, pruneBatch: 100,
  issuance: { perPeer: { attempts: 10, windowMs: 60_000 }, global: { attempts: 100, windowMs: 60_000 }, peers: 10, nativeChallenges: 1000, reservedContexts: 10 },
  webauthn: { credentialIdBytes: 1024, clientDataBytes: 4096, attestationBytes: 4096, authenticatorDataBytes: 4096, publicKeyBytes: 4096, signatureBytes: 4096,
    userHandleBytes: 64, challengeBytes: 64, transports: 8, credentials: 16, responseBytes: 65_536 },
};

/**
 * One provider: a store, the real protection policy over it and a clock in
 * milliseconds that the tests move. Every helper returns the `VerifiedProviderSession`
 * a provider's `resolveSession` would report for the new session.
 */
export function createProviderWorld(clock: { now: number }) {
  const store = new MemoryProviderStore();
  const issuance = new SessionIssuance(store.issuanceStore(), { sessionRows: 1000, sessionReconcileBatch: 100 });
  const protection = new AccountProtection(store, FACTOR_LIMITS, issuance);
  let serial = 0;
  const next = (prefix: string) => `${prefix}-${++serial}`;

  /** Hand-written: the controller's principal and mapping rows and the native user, as provisioning writes them. */
  const account = (principalId: string, kind: "owner" | "human" = "human") => {
    const subject = `subject-${principalId}`;
    store.principals.set(principalId, { kind, status: "active" });
    store.mappings.set(subject, { principalId, status: "active", linkedAt: iso(clock.now - 86_400_000) });
    store.users.set(subject, { twoFactorEnabled: false, totp: null });
    return subject;
  };

  /** Hand-written: the native session row a provider writes when it signs a user in. */
  const nativeSession = (subject: string, createdAt = clock.now): string => {
    const sessionId = next("session");
    store.sessions.set(sessionId, { subject, createdAt: iso(createdAt), expiresAt: iso(createdAt + SESSION_MS) });
    return sessionId;
  };

  const claim = (sessionId: string): VerifiedProviderSession => {
    const row = store.sessions.get(sessionId)!, evidence = store.evidenceRows.get(sessionId);
    const method = evidence?.method ?? "password";
    return { providerId: PROVIDER_ID, sessionId, subject: row.subject, createdAt: row.createdAt, expiresAt: row.expiresAt,
      authentication: method === "password" ? { method, factors: 1 } : { method, factors: 2 } };
  };

  /** Password sign-in: the real `recordPasswordSession` writes the evidence. */
  const passwordLogin = (subject: string): VerifiedProviderSession => {
    const sessionId = nativeSession(subject);
    const recorded = store.inNativeTransaction(() => protection.recordPasswordSession({ sessionId, subject, attemptId: next("attempt"), now: clock.now }));
    if (!recorded) throw new Error("password login refused");
    issuance.publish(sessionId, store.evidenceRows.get(sessionId)!.originalDeadline);
    return claim(sessionId);
  };

  /** Hand-written native TOTP secret, then the real enrollment: context, admission, settlement. */
  const enrollTotp = (subject: string, from: VerifiedProviderSession): void => {
    const totpId = next("totp");
    store.users.set(subject, { twoFactorEnabled: false, totp: { id: totpId, secret: `ciphertext-${totpId}`, verified: false } });
    const opaque = next("opaque");
    if (!protection.issueTotpEnrollment({ opaque, sessionId: from.sessionId, subject, now: clock.now })) throw new Error("totp enrollment refused");
    const ticket = protection.admit({ opaque, purpose: "totp_enrollment", attemptId: next("attempt"), credential: null, now: clock.now })!;
    // The library verifies the code and enables the factor before the controller settles.
    store.users.set(subject, { twoFactorEnabled: true, totp: { id: totpId, secret: `ciphertext-${totpId}`, verified: true } });
    protection.settleTotpEnrollment(ticket, 1, clock.now);
  };

  /**
   * Password stage at the current time, TOTP code `totpDelayMs` later. The
   * session is created at the TOTP stage; its evidence keeps the password time.
   */
  const totpLogin = (subject: string, totpDelayMs = 1_000): VerifiedProviderSession => {
    const passwordAt = clock.now, nativeId = next("verification");
    store.verifications.set(nativeId, { value: subject, expiresAt: passwordAt + 3_600_000 });
    const opaque = next("opaque");
    if (!protection.issueTotpLogin({ opaque, subject, nativeId, nativeDeadline: passwordAt + 3_600_000, authenticatedAt: iso(passwordAt),
      originalDeadline: iso(passwordAt + SESSION_MS), now: passwordAt })) throw new Error("totp login refused");
    clock.now = passwordAt + totpDelayMs;
    const ticket: ProviderFactorTicket = protection.admit({ opaque, purpose: "totp_login", attemptId: next("attempt"), credential: null, now: clock.now })!;
    const sessionId = nativeSession(subject, clock.now);
    store.inNativeTransaction(() => protection.settleTotpLogin(ticket, sessionId, 1 + serial, clock.now));
    issuance.publish(sessionId, store.evidenceRows.get(sessionId)!.originalDeadline);
    return claim(sessionId);
  };

  /** Hand-written native passkey row, then the real registration, staging, confirmation and promotion. */
  const enrollPasskey = (subject: string, from: VerifiedProviderSession): string => {
    const credential = next("credential"), nativeId = next("passkey-row"), handle = `handle-${subject}`;
    const registrationChallenge = next("verification"), registration = next("opaque");
    store.verifications.set(registrationChallenge, { value: subject, expiresAt: clock.now + 3_600_000 });
    if (!protection.issuePasskeyRegistration({ opaque: registration, sessionId: from.sessionId, subject, handle, nativeId: registrationChallenge,
      nativeDeadline: clock.now + 3_600_000, now: clock.now })) throw new Error("passkey registration refused");
    const registered = protection.admit({ opaque: registration, purpose: "passkey_registration", attemptId: next("attempt"), credential: null, now: clock.now })!;
    store.passkeys.set(credential, { nativeId, subject, publicKey: `public-key-${credential}` });
    protection.stagePasskey(registered, credential, clock.now);
    const confirmationChallenge = next("verification"), confirmation = next("opaque");
    store.verifications.set(confirmationChallenge, { value: subject, expiresAt: clock.now + 3_600_000 });
    if (!protection.issuePasskeyConfirmation({ opaque: confirmation, source: registration, sessionId: from.sessionId, subject, nativeId: confirmationChallenge,
      nativeDeadline: clock.now + 3_600_000, now: clock.now })) throw new Error("passkey confirmation refused");
    const confirmed = protection.admit({ opaque: confirmation, purpose: "passkey_confirmation", attemptId: next("attempt"), credential, now: clock.now })!;
    protection.promotePasskey(confirmed, clock.now);
    return credential;
  };

  /** Passkey sign-in with user verification: the real authentication context, admission and settlement. */
  const passkeyLogin = (credential: string): VerifiedProviderSession => {
    const subject = store.passkeys.get(credential)!.subject, challenge = next("verification"), opaque = next("opaque");
    store.verifications.set(challenge, { value: "", expiresAt: clock.now + 3_600_000 });
    if (!protection.issuePasskeyAuthentication({ opaque, nativeId: challenge, nativeDeadline: clock.now + 3_600_000, now: clock.now })) throw new Error("passkey options refused");
    const ticket = protection.admit({ opaque, purpose: "passkey_authentication", attemptId: next("attempt"), credential, now: clock.now })!;
    const sessionId = nativeSession(subject);
    store.inNativeTransaction(() => protection.settlePasskeyLogin(ticket, sessionId, clock.now));
    issuance.publish(sessionId, store.evidenceRows.get(sessionId)!.originalDeadline);
    return claim(sessionId);
  };

  /**
   * Password change: a new native session inherits the old evidence through
   * the real `inheritSession` (same time and deadline), then the provider
   * revokes the old session. Hand-written: the native row and the revocation.
   */
  const changePassword = (from: VerifiedProviderSession): VerifiedProviderSession => {
    const evidence = store.evidenceRows.get(from.sessionId)!;
    const sessionId = nativeSession(from.subject);
    store.inNativeTransaction(() => protection.inheritSession({ ...evidence }, { sessionId, attemptId: next("attempt") }));
    issuance.publish(sessionId, evidence.originalDeadline);
    store.sessions.delete(from.sessionId);
    store.evidenceRows.delete(from.sessionId);
    return claim(sessionId);
  };

  /** Hand-written: a native refresh moves `updatedAt` and `expiresAt`; evidence is never rewritten. */
  const refresh = (session: VerifiedProviderSession): VerifiedProviderSession => {
    const row = store.sessions.get(session.sessionId)!;
    row.expiresAt = iso(clock.now + SESSION_MS);
    return claim(session.sessionId);
  };

  return { store, protection, issuance, account, passwordLogin, enrollTotp, totpLogin, enrollPasskey, passkeyLogin, changePassword, refresh, claim };
}
