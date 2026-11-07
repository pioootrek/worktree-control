import { createHash } from "node:crypto";
import type {
  ProviderAccountProtection,
  ProviderAuthenticationEvidence,
  ProviderFactorLimits,
  ProviderFactorOutcome,
  ProviderFactorPurpose,
  ProviderFactorTicket,
  ProviderSessionEvidence,
} from "./provider-contract";
import { SessionIssuanceError, type SessionIssuance } from "./session-issuance";

/** A guarded step update changed no row. The whole success transaction must roll back. */
export class ProviderStaleStepError extends Error {
  constructor() { super("Presentation refused."); this.name = "ProviderStaleStepError"; }
}

/** Current state no longer allows this settlement. It rolls back like any other stale result. */
export class ProviderSettlementRefusedError extends Error {
  constructor() { super("Settlement refused."); this.name = "ProviderSettlementRefusedError"; }
}

/** A valid attempt met exhausted limits. Anything else that refuses stays an unexplained null. */
export class ProviderAdmissionRefusedError extends Error {
  constructor(readonly reason: "budget" | "capacity") { super("Admission refused."); this.name = "ProviderAdmissionRefusedError"; }
}

/** Committed account policy. `consistent` is false when native flags and selection disagree. */
export interface ProviderAccountState {
  generation: number;
  policyRevision: number;
  totpSelected: boolean;
  passkeySelected: boolean;
  consistent: boolean;
}

/** Nonsecret current-state projection. Holds digests, never tokens, passwords or ciphertext. */
export interface ProviderSessionState {
  principalKind: "owner" | "human";
  mappingLinkedAt: string;
  subject: string;
  principalId: string;
  createdAt: string;
  expiresAt: string;
  evidence: ProviderSessionEvidence | null;
  account: ProviderAccountState | null;
  /** Digest of the credential the evidence names, as stored now. Null when it is gone. */
  currentBinding: string | null;
}

export interface ProviderSessionAuthority {
  authentication: ProviderAuthenticationEvidence;
  evidence: ProviderSessionEvidence;
  /** The earlier of the original deadline and the native expiry. Refresh cannot extend it. */
  deadline: string;
}

const AUTHENTICATION = {
  password: { method: "password", factors: 1 },
  password_totp: { method: "password_totp", factors: 2 },
  passkey_uv: { method: "passkey_uv", factors: 2 },
} as const satisfies Record<ProviderSessionEvidence["method"], ProviderAuthenticationEvidence>;

export function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * The single rule for whether committed evidence still authorizes. It runs on
 * every decision, so a lost notification can only delay a listener, never
 * authority. Missing, malformed or stale evidence refuses.
 */
export function evaluateSessionAuthority(state: ProviderSessionState, now: string): ProviderSessionAuthority | null {
  const { evidence, account } = state;
  if (!evidence || !account?.consistent || evidence.subject !== state.subject) return null;
  if (!canonicalInstant(now) || !canonicalInstant(state.createdAt) || !canonicalInstant(state.expiresAt)
    || !canonicalInstant(evidence.authenticatedAt) || !canonicalInstant(evidence.originalDeadline)) return null;
  if (state.createdAt >= state.expiresAt || state.createdAt > now || state.expiresAt <= now) return null;
  if (evidence.authenticatedAt >= evidence.originalDeadline || evidence.authenticatedAt > now || evidence.originalDeadline <= now) return null;
  if (evidence.generation !== account.generation || evidence.policyRevision !== account.policyRevision) return null;
  if (evidence.method === "password") {
    if (account.totpSelected || account.passkeySelected || evidence.credential !== null || evidence.credentialBinding !== null) return null;
  } else {
    const selected = evidence.method === "password_totp" ? account.totpSelected : account.passkeySelected;
    if (!selected || !evidence.credential || !evidence.credentialBinding || evidence.credentialBinding !== state.currentBinding) return null;
  }
  const authentication = AUTHENTICATION[evidence.method];
  if (!authentication) return null;
  return { authentication, evidence, deadline: evidence.originalDeadline < state.expiresAt ? evidence.originalDeadline : state.expiresAt };
}

/** Rejects absent or nonsense limits. Nothing is rounded, clamped or defaulted. */
export function validateFactorLimits(limits: unknown): ProviderFactorLimits {
  const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
  const input = limits as ProviderFactorLimits | undefined;
  const pair = (value: { attempts?: unknown; windowMs?: unknown } | undefined) => positive(value?.attempts) && positive(value?.windowMs);
  const issuance = input?.issuance, webauthn = input?.webauthn;
  if (!input || !pair(input.totp) || !pair(input.passkey) || !positive(input.ticketMs) || !positive(input.stagingMs)
    || !positive(input.capacity) || !positive(input.pruneBatch)) throw new Error("Invalid factor limits.");
  if (!issuance || !pair(issuance.perPeer) || !pair(issuance.global) || !positive(issuance.peers) || !positive(issuance.nativeChallenges)
    || !positive(issuance.reservedContexts) || issuance.reservedContexts >= input.capacity || issuance.reservedContexts >= issuance.nativeChallenges) throw new Error("Invalid factor limits.");
  if (!webauthn || WEBAUTHN_BOUNDS.some(name => !positive(webauthn[name]))) throw new Error("Invalid factor limits.");
  return Object.freeze({ totp: Object.freeze({ ...input.totp }), passkey: Object.freeze({ ...input.passkey }),
    ticketMs: input.ticketMs, stagingMs: input.stagingMs, capacity: input.capacity, pruneBatch: input.pruneBatch,
    issuance: Object.freeze({ ...issuance, perPeer: Object.freeze({ ...issuance.perPeer }), global: Object.freeze({ ...issuance.global }) }),
    webauthn: Object.freeze(Object.fromEntries(WEBAUTHN_BOUNDS.map(name => [name, webauthn[name]])) as unknown as ProviderFactorLimits["webauthn"]) });
}
const WEBAUTHN_BOUNDS = ["credentialIdBytes", "clientDataBytes", "attestationBytes", "authenticatorDataBytes", "publicKeyBytes", "signatureBytes",
  "userHandleBytes", "challengeBytes", "transports", "credentials", "responseBytes"] as const satisfies ReadonlyArray<keyof ProviderFactorLimits["webauthn"]>;

/**
 * An immutable description of what a provider result proved, captured in its own
 * borrow. Core-only: the provider never sees these, and the runtime keeps them
 * behind its private release objects.
 */
export type ProviderReleaseCapture =
  | Readonly<{ kind: "pending"; context: Readonly<ProtectionContextRow> }>
  | Readonly<{ kind: "staged"; stage: Readonly<ProtectionStagedRow> }>
  | Readonly<{ kind: "enrolled"; attemptId: string; purpose: "totp_enrollment" | "passkey_confirmation"; subject: string; principalId: string;
      credential: string; binding: string; generation: number; policyRevision: number }>;
/** Read-only checks on the core handle, plus anonymous issuance room. Not in the provider host. */
export interface ProviderReleaseProtection {
  capturePending(opaque: string, purpose: ProviderFactorPurpose, now: number): ProviderReleaseCapture | null;
  captureStaged(source: string, now: number): ProviderReleaseCapture | null;
  captureEnrolled(opaque: string, purpose: "totp_enrollment" | "passkey_confirmation"): ProviderReleaseCapture | null;
  releaseCurrent(capture: ProviderReleaseCapture, now: number): boolean;
  /** False once anonymous options must stop, so no native challenge is allocated for them. */
  issuanceRoom(now: number): boolean;
  /** Whether this exact row exists now. Cleanup asks this rather than trusting a thrown error. */
  sessionPresent(sessionId: string): boolean;
}

export interface ProtectionContextRow {
  capability: string; purpose: ProviderFactorPurpose; subject: string | null; principalId: string | null;
  sessionId: string | null; nativeId: string | null; handle: string | null; credential: string | null; binding: string | null;
  generation: number | null; policyRevision: number | null; authenticatedAt: string | null; originalDeadline: string | null;
  deadline: number; used: number;
}
export interface ProtectionReceiptRow extends ProviderFactorTicket {
  principalId: string; epoch: number; deadline: number; state: ProviderFactorOutcome;
}
export interface ProtectionStagedRow {
  credential: string; nativeId: string; capability: string; subject: string; handle: string; fingerprint: string;
  generation: number; policyRevision: number; sessionId: string; originalDeadline: string; deadline: number;
}
export interface ProtectionTrustRow { credential: string; nativeId: string; subject: string; handle: string; fingerprint: string }
export interface NativeProtectionState {
  twoFactorEnabled: boolean;
  totp: { id: string; verified: boolean; binding: string } | null;
  trusted: number;
}
export type BoundedProtectionTable = "contexts" | "receipts" | "budgets" | "staged" | "verifications";

/** Row-level persistence. Joins the caller's transaction; owns no connection or policy. */
export interface ProtectionStore {
  resetLocalFactors?(subject: string): import("./provider-contract").LocalFactorResetSummary;
  activePrincipal(subject: string): string | null;
  account(subject: string): Omit<ProviderAccountState, "consistent"> | null;
  createAccount(subject: string, now: string): void;
  /** Compare-and-advance. False when the expected generation is no longer current. */
  advanceAccount(subject: string, select: "totp" | "passkey", expected: { generation: number; policyRevision: number }, now: string): boolean;
  native(subject: string): NativeProtectionState;
  sessionState(sessionId: string): ProviderSessionState | null;
  session(sessionId: string): { subject: string; createdAt: string; expiresAt: string } | null;
  evidence(sessionId: string): ProviderSessionEvidence | null;
  evidenceAttempt(attemptId: string): boolean;
  insertEvidence(evidence: ProviderSessionEvidence): void;
  /** Only ever lowers a native expiry to the original deadline. */
  clampSession(sessionId: string, originalDeadline: string): void;
  /** Guarded upsert. True only when exactly one row moved strictly forward. */
  advanceStep(subject: string, step: number): boolean;
  passkey(credential: string): { nativeId: string; subject: string; publicKey: string } | null;
  trust(credential: string): ProtectionTrustRow | null;
  insertTrust(row: ProtectionTrustRow, now: string): void;
  stagedForCapability(capability: string): ProtectionStagedRow | null;
  staged(credential: string): ProtectionStagedRow | null;
  insertStaged(row: ProtectionStagedRow): void;
  removeStaged(credential: string): void;
  context(capability: string): ProtectionContextRow | null;
  insertContext(row: ProtectionContextRow): void;
  /** Removes this session's unused contexts that have no unresolved attempt. */
  replaceContexts(purpose: ProviderFactorPurpose, sessionId: string): void;
  markContextUsed(capability: string): void;
  nativeVerification(nativeId: string): { value: string; expiresAt: number } | null;
  budget(scope: "totp" | "passkey", subject: string, epoch: number): number;
  charge(scope: "totp" | "passkey", subject: string, epoch: number, charged: number): void;
  receipt(attemptId: string): ProtectionReceiptRow | null;
  /** The one success of a capability: a success marks its context used. */
  succeededReceipt(capability: string): ProtectionReceiptRow | null;
  insertReceipt(row: ProtectionReceiptRow): void;
  finishReceipt(attemptId: string, state: "succeeded" | "failed", sessionId: string | null): void;
  count(table: BoundedProtectionTable): number;
  prune(now: number, pruneBatch: number, epochs: { totp: number; passkey: number }): void;
}

const capabilityId = (purpose: ProviderFactorPurpose, opaque: string) => createHash("sha256").update(`${purpose}\0${opaque}`).digest("hex");
const iso = (time: number) => new Date(time).toISOString();
const scopeOf = (purpose: ProviderFactorPurpose) => purpose.startsWith("totp") ? "totp" as const : "passkey" as const;
/** Fingerprint of a credential's public key row; signature counters may change beneath it. */
export const passkeyFingerprint = (nativeId: string, publicKey: string) => createHash("sha256").update(`${nativeId}:${publicKey}`).digest("hex");
/** Staleness only: re-encrypting or replacing a secret changes it. Replay state never depends on it. */
export const totpBinding = (ciphertext: string) => createHash("sha256").update(ciphertext).digest("hex");

/**
 * Selected-protection policy shared by TOTP and passkeys. A method is an
 * alternative, never an additional mandatory step. Selecting one advances the
 * account's generation, which atomically outdates all prior evidence. Protected
 * local recovery alone removes selections; replay steps remain monotonic.
 */
export class AccountProtection implements ProviderAccountProtection, ProviderReleaseProtection {
  readonly #limits: ProviderFactorLimits | null;

  constructor(private readonly store: ProtectionStore, limits?: ProviderFactorLimits, private readonly issuance?: SessionIssuance) {
    this.#limits = limits ? validateFactorLimits(limits) : null;
  }

  /** The one path to session evidence: all four writers meet here, in the native transaction. */
  #issue(evidence: ProviderSessionEvidence): void {
    if (!this.issuance) throw new SessionIssuanceError("Session issuance was refused.");
    this.issuance.record(evidence, value => { this.store.insertEvidence(value); });
  }

  resetLocalFactors(subject: string): import("./provider-contract").LocalFactorResetSummary {
    if (!this.store.activePrincipal(subject) || !this.store.resetLocalFactors) throw new ProviderSettlementRefusedError();
    return this.store.resetLocalFactors(subject);
  }

  get enabled(): boolean { return this.#limits !== null; }

  /** Creates the empty policy on first real use. Pre-existing factors without one refuse. */
  #account(subject: string, now: number): ProviderAccountState | null {
    if (!this.store.activePrincipal(subject)) return null;
    const native = this.store.native(subject);
    let row = this.store.account(subject);
    if (!row) {
      if (native.twoFactorEnabled || native.totp?.verified || native.trusted) return null;
      this.store.createAccount(subject, iso(now));
      row = this.store.account(subject);
      if (!row) return null;
    }
    return { ...row, consistent: row.totpSelected === (native.twoFactorEnabled && native.totp?.verified === true) && row.passkeySelected === (native.trusted > 0) };
  }

  currentEvidence(sessionId: string, now: number): ProviderSessionEvidence | null {
    const state = this.store.sessionState(sessionId);
    return state ? evaluateSessionAuthority(state, iso(now))?.evidence ?? null : null;
  }

  recordPasswordSession(input: { sessionId: string; subject: string; attemptId: string; now: number }): boolean {
    const account = this.#account(input.subject, input.now), session = this.store.session(input.sessionId);
    if (!account?.consistent || account.totpSelected || account.passkeySelected || session?.subject !== input.subject) return false;
    this.#issue({ sessionId: input.sessionId, subject: input.subject, method: "password", authenticatedAt: session.createdAt,
      originalDeadline: session.expiresAt, generation: account.generation, policyRevision: account.policyRevision,
      credential: null, credentialBinding: null, attemptId: input.attemptId });
    return true;
  }

  inheritSession(evidence: ProviderSessionEvidence, input: { sessionId: string; attemptId: string }): void {
    if (this.store.session(input.sessionId)?.subject !== evidence.subject) throw new ProviderSettlementRefusedError();
    this.#issue({ ...evidence, sessionId: input.sessionId, attemptId: input.attemptId });
    this.store.clampSession(input.sessionId, evidence.originalDeadline);
  }

  /** Enrollment starts from authority that is current for this account; it is never fresh proof of more. */
  #origin(sessionId: string, subject: string, now: number): ProviderSessionEvidence | null {
    const evidence = this.currentEvidence(sessionId, now);
    return evidence?.subject === subject ? evidence : null;
  }
  #stagingDeadline(evidence: Pick<ProviderSessionEvidence, "authenticatedAt" | "originalDeadline">): number {
    return Math.min(Date.parse(evidence.authenticatedAt) + this.#limits!.stagingMs, Date.parse(evidence.originalDeadline));
  }
  #room(table: BoundedProtectionTable): boolean { return this.store.count(table) < this.#limits!.capacity; }
  #prune(now: number): void {
    const limits = this.#limits!;
    this.store.prune(now, limits.pruneBatch, { totp: Math.floor(now / limits.totp.windowMs), passkey: Math.floor(now / limits.passkey.windowMs) });
  }
  /** `reserve` keeps rows for accepted ceremonies. `incoming` is a native row not yet written. */
  #issuable(reserve: number, incoming = 0): boolean {
    const limits = this.#limits!;
    return this.store.count("contexts") + reserve < limits.capacity && this.store.count("verifications") + incoming + reserve <= limits.issuance.nativeChallenges;
  }
  #insertContext(row: Omit<ProtectionContextRow, "used">, now: number, reserve = 0): boolean {
    this.#prune(now);
    if (row.deadline <= now || !this.#issuable(reserve)) return false;
    this.store.insertContext({ ...row, used: 0 });
    return true;
  }
  issuanceRoom(now: number): boolean {
    if (!this.#limits) return false;
    this.#prune(now);
    return this.#issuable(this.#limits.issuance.reservedContexts, 1);
  }

  issueTotpEnrollment({ opaque, sessionId, subject, now }: { opaque: string; sessionId: string; subject: string; now: number }): boolean {
    if (!this.#limits) return false;
    const origin = this.#origin(sessionId, subject, now), account = this.#account(subject, now), native = this.store.native(subject);
    if (!origin || !account?.consistent || account.totpSelected || !native.totp || native.totp.verified) return false;
    this.store.replaceContexts("totp_enrollment", sessionId);
    return this.#insertContext({ capability: capabilityId("totp_enrollment", opaque), purpose: "totp_enrollment", subject,
      principalId: this.store.activePrincipal(subject), sessionId, nativeId: null, handle: null, credential: native.totp.id, binding: native.totp.binding,
      generation: account.generation, policyRevision: account.policyRevision, authenticatedAt: origin.authenticatedAt,
      originalDeadline: origin.originalDeadline, deadline: this.#stagingDeadline(origin) }, now);
  }

  issueTotpLogin(input: { opaque: string; subject: string; nativeId: string; nativeDeadline: number; authenticatedAt: string; originalDeadline: string; now: number }): boolean {
    if (!this.#limits) return false;
    const { subject, now } = input, account = this.#account(subject, now), native = this.store.native(subject);
    if (!account?.consistent || !account.totpSelected || !native.totp?.verified) return false;
    return this.#insertContext({ capability: capabilityId("totp_login", input.opaque), purpose: "totp_login", subject,
      principalId: this.store.activePrincipal(subject), sessionId: null, nativeId: input.nativeId, handle: null, credential: native.totp.id, binding: native.totp.binding,
      generation: account.generation, policyRevision: account.policyRevision, authenticatedAt: input.authenticatedAt,
      originalDeadline: input.originalDeadline, deadline: Math.min(input.nativeDeadline, Date.parse(input.originalDeadline)) }, now);
  }

  issuePasskeyRegistration(input: { opaque: string; sessionId: string; subject: string; handle: string; nativeId: string; nativeDeadline: number; now: number }): boolean {
    if (!this.#limits) return false;
    const { subject, sessionId, now } = input, origin = this.#origin(sessionId, subject, now), account = this.#account(subject, now);
    if (!origin || !account?.consistent || account.passkeySelected) return false;
    return this.#insertContext({ capability: capabilityId("passkey_registration", input.opaque), purpose: "passkey_registration", subject,
      principalId: this.store.activePrincipal(subject), sessionId, nativeId: input.nativeId, handle: input.handle, credential: null, binding: null,
      generation: account.generation, policyRevision: account.policyRevision, authenticatedAt: origin.authenticatedAt,
      originalDeadline: origin.originalDeadline, deadline: Math.min(input.nativeDeadline, this.#stagingDeadline(origin)) }, now);
  }

  issuePasskeyConfirmation(input: { opaque: string; source: string; sessionId: string; subject: string; nativeId: string; nativeDeadline: number; now: number }): string | null {
    if (!this.#limits) return null;
    const stage = this.store.stagedForCapability(capabilityId("passkey_registration", input.source));
    if (!stage || stage.sessionId !== input.sessionId || stage.subject !== input.subject || !this.#stageUsable(stage, input.now)) return null;
    const issued = this.#insertContext({ capability: capabilityId("passkey_confirmation", input.opaque), purpose: "passkey_confirmation", subject: stage.subject,
      principalId: this.store.activePrincipal(stage.subject), sessionId: stage.sessionId, nativeId: input.nativeId, handle: stage.handle, credential: stage.credential, binding: stage.fingerprint,
      generation: stage.generation, policyRevision: stage.policyRevision, authenticatedAt: null, originalDeadline: stage.originalDeadline,
      deadline: Math.min(input.nativeDeadline, stage.deadline) }, input.now);
    return issued ? stage.credential : null;
  }

  issuePasskeyAuthentication(input: { opaque: string; nativeId: string; nativeDeadline: number; now: number }): boolean {
    if (!this.#limits) return false;
    return this.#insertContext({ capability: capabilityId("passkey_authentication", input.opaque), purpose: "passkey_authentication", subject: null, principalId: null,
      sessionId: null, nativeId: input.nativeId, handle: null, credential: null, binding: null, generation: null, policyRevision: null,
      authenticatedAt: null, originalDeadline: null, deadline: input.nativeDeadline }, input.now, this.#limits.issuance.reservedContexts);
  }

  #stageUsable(stage: ProtectionStagedRow, now: number): boolean {
    const account = this.#account(stage.subject, now), row = this.store.passkey(stage.credential), origin = this.#origin(stage.sessionId, stage.subject, now);
    return stage.deadline > now && !!origin && origin.originalDeadline === stage.originalDeadline && !!account?.consistent && !account.passkeySelected
      && account.generation === stage.generation && account.policyRevision === stage.policyRevision
      && row?.subject === stage.subject && row.nativeId === stage.nativeId && passkeyFingerprint(row.nativeId, row.publicKey) === stage.fingerprint;
  }

  /** Trust is deliberately independent of generation: adding a method must not distrust another. */
  #trusted(credential: string, subject: string): ProtectionTrustRow | null {
    const trust = this.store.trust(credential), row = this.store.passkey(credential);
    return trust && row && trust.subject === subject && row.subject === subject && row.nativeId === trust.nativeId
      && passkeyFingerprint(row.nativeId, row.publicKey) === trust.fingerprint ? trust : null;
  }

  #contextValid(context: ProtectionContextRow, now: number): boolean {
    if (context.used || context.deadline <= now) return false;
    if (context.nativeId) {
      const pending = this.store.nativeVerification(context.nativeId);
      if (!pending || !(pending.expiresAt > now)) return false;
      if (context.purpose === "totp_login" && pending.value !== context.subject) return false;
    }
    return true;
  }

  /** The state a purpose requires, before or at settlement. Native TOTP enrollment rotates its session. */
  #purposeCurrent(context: ProtectionContextRow, subject: string, credential: string | null, now: number, settlement: boolean): boolean {
    const account = this.store.account(subject), native = this.store.native(subject);
    if (!account || !this.store.activePrincipal(subject)) return false;
    if (context.generation !== null && (context.generation !== account.generation || context.policyRevision !== account.policyRevision)) return false;
    if (context.principalId !== null && context.principalId !== this.store.activePrincipal(subject)) return false;
    switch (context.purpose) {
      case "totp_enrollment":
        if (account.totpSelected || native.totp?.id !== context.credential || native.totp.binding !== context.binding) return false;
        if (settlement) return native.totp.verified && native.twoFactorEnabled;
        return !native.totp.verified && !native.twoFactorEnabled && this.#origin(context.sessionId ?? "", subject, now)?.originalDeadline === context.originalDeadline;
      case "totp_login":
        return account.totpSelected && native.twoFactorEnabled && native.totp?.verified === true
          && native.totp.id === context.credential && native.totp.binding === context.binding;
      case "passkey_registration":
        return !account.passkeySelected && this.#origin(context.sessionId ?? "", subject, now)?.originalDeadline === context.originalDeadline;
      case "passkey_confirmation": {
        const stage = context.credential ? this.store.staged(context.credential) : null;
        return !!stage && stage.fingerprint === context.binding && stage.subject === subject && this.#stageUsable(stage, now);
      }
      case "passkey_authentication":
        return account.passkeySelected && !!credential && !!this.#trusted(credential, subject);
    }
  }

  contextSubject(opaque: string, purpose: ProviderFactorPurpose, now: number): { subject: string | null; sessionId: string | null } | null {
    const context = this.store.context(capabilityId(purpose, opaque));
    return context && this.#contextValid(context, now) ? { subject: context.subject, sessionId: context.sessionId } : null;
  }

  admit({ opaque, purpose, attemptId, credential, now }: { opaque: string; purpose: ProviderFactorPurpose; attemptId: string; credential: string | null; now: number }): ProviderFactorTicket | null {
    if (!this.#limits) return null;
    this.#prune(now);
    const context = this.store.context(capabilityId(purpose, opaque));
    if (!context || !this.#contextValid(context, now) || this.store.receipt(attemptId)) return null;
    const subject = context.subject ?? (credential ? this.store.passkey(credential)?.subject ?? null : null);
    const principalId = subject && this.store.activePrincipal(subject);
    if (!subject || !principalId) return null;
    const account = this.#account(subject, now);
    if (!account?.consistent || !this.#purposeCurrent(context, subject, credential, now, false)) return null;
    if (context.purpose === "passkey_confirmation" && credential !== context.credential) return null;
    const scope = scopeOf(purpose), budget = this.#limits[scope], epoch = Math.floor(now / budget.windowMs);
    const charged = this.store.budget(scope, subject, epoch);
    if (charged >= budget.attempts) throw new ProviderAdmissionRefusedError("budget");
    if (!this.#room("receipts") || (!charged && !this.#room("budgets"))) throw new ProviderAdmissionRefusedError("capacity");
    this.store.charge(scope, subject, epoch, charged + 1);
    // A passkey ceremony is single use. A TOTP context survives a wrong code until its budget ends.
    if (scope === "passkey") this.store.markContextUsed(context.capability);
    const binding = context.purpose === "passkey_authentication" ? this.#trusted(credential!, subject)!.fingerprint : context.binding;
    this.store.insertReceipt({ attemptId, capability: context.capability, purpose, subject, principalId, credential: credential ?? context.credential, binding,
      generation: account.generation, policyRevision: account.policyRevision, sessionId: context.sessionId, handle: context.handle,
      epoch, deadline: Math.min(context.deadline, now + this.#limits.ticketMs), state: "charged" });
    return this.#ticket(attemptId);
  }

  #ticket(attemptId: string): ProviderFactorTicket | null {
    const row = this.store.receipt(attemptId);
    return row && Object.freeze({ attemptId: row.attemptId, capability: row.capability, purpose: row.purpose, subject: row.subject, credential: row.credential,
      binding: row.binding, generation: row.generation, policyRevision: row.policyRevision, sessionId: row.sessionId, handle: row.handle });
  }

  #usable(ticket: ProviderFactorTicket, now: number, settlement: boolean): ProtectionContextRow | null {
    const receipt = this.store.receipt(ticket.attemptId), context = this.store.context(ticket.capability);
    if (receipt?.state !== "charged" || !context || receipt.deadline <= now || context.deadline <= now) return null;
    if (receipt.subject !== ticket.subject || receipt.purpose !== ticket.purpose || receipt.binding !== ticket.binding || receipt.credential !== ticket.credential
      || receipt.generation !== ticket.generation || receipt.policyRevision !== ticket.policyRevision || context.purpose !== ticket.purpose) return null;
    if (context.originalDeadline && Date.parse(context.originalDeadline) <= now) return null;
    // Passkey admission reserved the one-use context; TOTP's stays open until success.
    const passkey = scopeOf(ticket.purpose) === "passkey";
    if (Boolean(context.used) !== passkey) return null;
    const account = this.store.account(ticket.subject);
    if (account?.generation !== ticket.generation || account.policyRevision !== ticket.policyRevision) return null;
    // Native WebAuthn consumes its challenge before our callback. Only a TOTP challenge outlives admission.
    if (ticket.purpose === "totp_login" && !settlement && !this.#contextValid({ ...context, used: 0 }, now)) return null;
    return this.#purposeCurrent(context, ticket.subject, ticket.credential, now, settlement) ? context : null;
  }
  usable(ticket: ProviderFactorTicket, now: number): boolean { return this.#usable(ticket, now, false) !== null; }

  passkeyAcceptable(ticket: ProviderFactorTicket, credential: string, userHandle: string | null | undefined, now: number): boolean {
    if (ticket.credential !== credential || !userHandle || !this.usable(ticket, now)) return false;
    if (ticket.purpose === "passkey_confirmation") return this.store.staged(credential)?.handle === userHandle;
    return ticket.purpose === "passkey_authentication" && this.#trusted(credential, ticket.subject)?.handle === userHandle;
  }

  #consume(subject: string, step: number): void {
    if (!Number.isSafeInteger(step) || step < 0 || !this.store.advanceStep(subject, step)) throw new ProviderStaleStepError();
  }
  #settled(ticket: ProviderFactorTicket, now: number): ProtectionContextRow {
    const context = this.#usable(ticket, now, true);
    if (!context) throw new ProviderSettlementRefusedError();
    return context;
  }
  #finish(ticket: ProviderFactorTicket, sessionId: string | null): void {
    this.store.finishReceipt(ticket.attemptId, "succeeded", sessionId);
    this.store.markContextUsed(ticket.capability);
  }
  #select(ticket: ProviderFactorTicket, method: "totp" | "passkey", now: number): void {
    if (!this.store.advanceAccount(ticket.subject, method, { generation: ticket.generation, policyRevision: ticket.policyRevision }, iso(now))) throw new ProviderSettlementRefusedError();
  }
  #login(ticket: ProviderFactorTicket, method: "password_totp" | "passkey_uv", sessionId: string, times: { authenticatedAt: string; originalDeadline: string }): void {
    const session = this.store.session(sessionId);
    if (session?.subject !== ticket.subject || !ticket.credential || !ticket.binding) throw new ProviderSettlementRefusedError();
    this.#issue({ sessionId, subject: ticket.subject, method, ...times, generation: ticket.generation, policyRevision: ticket.policyRevision,
      credential: ticket.credential, credentialBinding: ticket.binding, attemptId: ticket.attemptId });
    this.store.clampSession(sessionId, times.originalDeadline);
  }

  settleTotpEnrollment(ticket: ProviderFactorTicket, step: number, now: number): void {
    if (ticket.purpose !== "totp_enrollment") throw new ProviderSettlementRefusedError();
    this.#settled(ticket, now);
    this.#consume(ticket.subject, step);
    this.#select(ticket, "totp", now);
    this.#finish(ticket, null);
  }

  settleTotpLogin(ticket: ProviderFactorTicket, sessionId: string, step: number, now: number): void {
    if (ticket.purpose !== "totp_login") throw new ProviderSettlementRefusedError();
    const context = this.#settled(ticket, now);
    this.#consume(ticket.subject, step);
    this.#login(ticket, "password_totp", sessionId, { authenticatedAt: context.authenticatedAt!, originalDeadline: context.originalDeadline! });
    this.#finish(ticket, sessionId);
  }

  stagePasskey(ticket: ProviderFactorTicket, credential: string, now: number): void {
    const context = ticket.purpose === "passkey_registration" ? this.#settled(ticket, now) : null;
    const row = this.store.passkey(credential);
    if (!context || row?.subject !== ticket.subject || !context.handle || !context.sessionId || !context.originalDeadline || !context.authenticatedAt || !this.#room("staged")) throw new ProviderSettlementRefusedError();
    this.store.insertStaged({ credential, nativeId: row.nativeId, capability: context.capability, subject: ticket.subject, handle: context.handle,
      fingerprint: passkeyFingerprint(row.nativeId, row.publicKey), generation: ticket.generation, policyRevision: ticket.policyRevision, sessionId: context.sessionId,
      originalDeadline: context.originalDeadline, deadline: Math.min(context.deadline, this.#stagingDeadline({ authenticatedAt: context.authenticatedAt, originalDeadline: context.originalDeadline })) });
    this.#finish(ticket, null);
  }

  promotePasskey(ticket: ProviderFactorTicket, now: number): void {
    if (ticket.purpose !== "passkey_confirmation") throw new ProviderSettlementRefusedError();
    this.#settled(ticket, now);
    const stage = this.store.staged(ticket.credential ?? "");
    if (!stage) throw new ProviderSettlementRefusedError();
    this.store.insertTrust({ credential: stage.credential, nativeId: stage.nativeId, subject: stage.subject, handle: stage.handle, fingerprint: stage.fingerprint }, iso(now));
    this.store.removeStaged(stage.credential);
    this.#select(ticket, "passkey", now);
    this.#finish(ticket, null);
  }

  settlePasskeyLogin(ticket: ProviderFactorTicket, sessionId: string, now: number): void {
    if (ticket.purpose !== "passkey_authentication") throw new ProviderSettlementRefusedError();
    this.#settled(ticket, now);
    const session = this.store.session(sessionId);
    if (!session) throw new ProviderSettlementRefusedError();
    this.#login(ticket, "passkey_uv", sessionId, { authenticatedAt: session.createdAt, originalDeadline: session.expiresAt });
    this.#finish(ticket, sessionId);
  }

  /** Native flags and selection agree, read without creating a policy row. */
  #consistent(subject: string): ProviderAccountState | null {
    const row = this.store.account(subject), native = this.store.native(subject);
    return row && { ...row, consistent: row.totpSelected === (native.twoFactorEnabled && native.totp?.verified === true) && row.passkeySelected === (native.trusted > 0) };
  }
  #pendingCurrent(expected: ProtectionContextRow, now: number): boolean {
    const context = this.store.context(expected.capability);
    if (!context || (Object.keys(expected) as Array<keyof ProtectionContextRow>).some(key => context[key] !== expected[key])) return false;
    if (!this.#contextValid(context, now) || (context.originalDeadline && Date.parse(context.originalDeadline) <= now)) return false;
    // Generic login options have no account until a credential is presented.
    if (!context.subject) return context.purpose === "passkey_authentication";
    return !!this.#consistent(context.subject)?.consistent && this.#purposeCurrent(context, context.subject, context.credential, now, false);
  }
  #enrolledCurrent(capture: Extract<ProviderReleaseCapture, { kind: "enrolled" }>): boolean {
    const { subject, credential, binding } = capture, receipt = this.store.receipt(capture.attemptId), account = this.#consistent(subject);
    if (receipt?.state !== "succeeded" || !account?.consistent || this.store.activePrincipal(subject) !== capture.principalId) return false;
    if (account.generation !== capture.generation || account.policyRevision !== capture.policyRevision) return false;
    if (capture.purpose === "passkey_confirmation") return account.passkeySelected && this.#trusted(credential, subject)?.fingerprint === binding;
    const { totp } = this.store.native(subject);
    return account.totpSelected && totp?.verified === true && totp.id === credential && totp.binding === binding;
  }
  capturePending(opaque: string, purpose: ProviderFactorPurpose, now: number): ProviderReleaseCapture | null {
    const context = this.store.context(capabilityId(purpose, opaque));
    return context && this.#pendingCurrent(context, now) ? Object.freeze({ kind: "pending" as const, context: Object.freeze(context) }) : null;
  }
  captureStaged(source: string, now: number): ProviderReleaseCapture | null {
    const stage = this.store.stagedForCapability(capabilityId("passkey_registration", source));
    return stage && this.#stageUsable(stage, now) ? Object.freeze({ kind: "staged" as const, stage: Object.freeze(stage) }) : null;
  }
  /** The expectation is taken in the settling borrow, so a later change is never adopted as this result. */
  captureEnrolled(opaque: string, purpose: "totp_enrollment" | "passkey_confirmation"): ProviderReleaseCapture | null {
    const receipt = this.store.succeededReceipt(capabilityId(purpose, opaque)), account = receipt && this.store.account(receipt.subject);
    if (!receipt || !account || !receipt.credential || !receipt.binding) return null;
    if (account.generation !== receipt.generation + 1 || account.policyRevision !== receipt.policyRevision + 1) return null;
    const capture = Object.freeze({ kind: "enrolled" as const, attemptId: receipt.attemptId, purpose, subject: receipt.subject, principalId: receipt.principalId,
      credential: receipt.credential, binding: receipt.binding, generation: account.generation, policyRevision: account.policyRevision });
    return this.#enrolledCurrent(capture) ? capture : null;
  }
  releaseCurrent(capture: ProviderReleaseCapture, now: number): boolean {
    if (capture.kind === "pending") return this.#pendingCurrent(capture.context, now);
    if (capture.kind === "enrolled") return this.#enrolledCurrent(capture);
    const stage = this.store.staged(capture.stage.credential);
    return !!stage && (Object.keys(capture.stage) as Array<keyof ProtectionStagedRow>).every(key => stage[key] === capture.stage[key]) && this.#stageUsable(stage, now);
  }

  sessionPresent(sessionId: string): boolean { return this.store.session(sessionId) !== null; }

  fail(attemptId: string): void { this.store.finishReceipt(attemptId, "failed", null); }

  outcome(attemptId: string): ProviderFactorOutcome | null {
    return this.store.receipt(attemptId)?.state ?? (this.store.evidenceAttempt(attemptId) ? "succeeded" : null);
  }
}
