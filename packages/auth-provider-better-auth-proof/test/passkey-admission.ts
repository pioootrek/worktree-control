import { createHash } from "node:crypto";
import type { ProviderSqliteConnection } from "../../../src/server/modules/authentication/provider-contract";

/** Fixture tables only. The controller owner applies these, never provider initialization. */
export const PASSKEY_MODEL = "authentication_ba_passkey";
export const PASSKEY_DDL = [
  `CREATE TABLE passkey_fixture_generation (subject TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE passkey_fixture_context (capability TEXT PRIMARY KEY, purpose TEXT NOT NULL, subject TEXT, sessionId TEXT, handle TEXT, nativeId TEXT NOT NULL, deadline INTEGER NOT NULL, originalDeadline INTEGER NOT NULL, generation INTEGER, credential TEXT, used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE passkey_fixture_staged (credential TEXT PRIMARY KEY, capability TEXT NOT NULL UNIQUE, subject TEXT NOT NULL, handle TEXT NOT NULL, fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, sessionId TEXT NOT NULL, originalDeadline INTEGER NOT NULL, deadline INTEGER NOT NULL, purpose TEXT NOT NULL CHECK(purpose='enrollment-confirmation'))`,
  `CREATE TABLE passkey_fixture_trust (credential TEXT PRIMARY KEY, subject TEXT NOT NULL, handle TEXT NOT NULL, fingerprint TEXT NOT NULL, generation INTEGER NOT NULL, verifiedUv INTEGER NOT NULL CHECK(verifiedUv = 1))`,
  `CREATE TABLE passkey_fixture_budget (subject TEXT NOT NULL, epoch INTEGER NOT NULL, charged INTEGER NOT NULL, PRIMARY KEY(subject,epoch))`,
  `CREATE TABLE passkey_fixture_receipt (attemptId TEXT PRIMARY KEY, capability TEXT NOT NULL UNIQUE, subject TEXT NOT NULL, generation INTEGER NOT NULL, credential TEXT, fingerprint TEXT, deadline INTEGER NOT NULL, state TEXT NOT NULL, sessionId TEXT)`,
  `CREATE TABLE passkey_fixture_evidence (sessionId TEXT PRIMARY KEY REFERENCES authentication_ba_session(id) ON DELETE CASCADE, subject TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('password','passkey_uv')), authenticatedAt INTEGER NOT NULL, originalDeadline INTEGER NOT NULL, generation INTEGER NOT NULL, credential TEXT, authorizing INTEGER NOT NULL CHECK(authorizing = 0))`,
];
export const passkeyHash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface PasskeyContext { capability: string; purpose: string; subject: string | null; sessionId: string | null; handle: string | null; nativeId: string; deadline: number; originalDeadline: number; generation: number | null; credential: string | null; used: number }
export interface StagedPasskey { credential: string; capability: string; subject: string; handle: string; fingerprint: string; generation: number; sessionId: string; originalDeadline: number; deadline: number; purpose: string }
export interface PasskeyTicket { attemptId: string; capability: string; subject: string; generation: number; credential: string | null; fingerprint: string | null; deadline: number; state: string; sessionId: string | null }
export interface PasskeyRow { id: string; credentialID: string; userId: string; publicKey: string; counter: number }
export const PASSKEY_BOUNDS = { capacity: 64, attempts: 8, windowMs: 60_000, ticketMs: 15_000, pruneBatch: 8 };

/** No owner/connection/lock lifecycle of its own; all calls use the existing exclusive borrow. */
export class PasskeyAdmission {
  constructor(readonly db: ProviderSqliteConnection) {}
  rows<T>(sql: string, args: readonly unknown[] = []) { return this.db.prepare(sql).all(args) as T[]; }
  run(sql: string, args: readonly unknown[] = []) { return this.db.prepare(sql).run(args); }
  current(subject: string) {
    return this.rows(`SELECT 1 FROM authentication_provider_subjects m JOIN remote_principals p ON p.id=m.principal_id WHERE m.provider_id='better-auth' AND m.subject=? AND m.status='active' AND m.revoked_at IS NULL AND p.kind='owner' AND p.status='active'`, [subject]).length === 1;
  }
  generation(subject: string): number {
    this.capacity("passkey_fixture_generation");
    this.run("INSERT OR IGNORE INTO passkey_fixture_generation(subject) VALUES (?)", [subject]);
    return this.rows<{ generation: number }>("SELECT generation FROM passkey_fixture_generation WHERE subject=?", [subject])[0]!.generation;
  }
  capacity(table: string) {
    if (this.rows<{ n: number }>(`SELECT count(*) n FROM ${table}`)[0]!.n >= PASSKEY_BOUNDS.capacity) throw new Error("Fixture capacity.");
  }
  context(opaque: string) { return this.rows<PasskeyContext>("SELECT * FROM passkey_fixture_context WHERE capability=?", [passkeyHash(opaque)])[0]; }
  ticketContext(ticket: PasskeyTicket) { return this.rows<PasskeyContext>("SELECT * FROM passkey_fixture_context WHERE capability=?", [ticket.capability])[0]; }
  staged(id: string) { return this.rows<StagedPasskey>("SELECT * FROM passkey_fixture_staged WHERE credential=?", [id])[0]; }
  candidate(context: PasskeyContext) { return context.credential ? this.staged(context.credential) : this.rows<StagedPasskey>("SELECT * FROM passkey_fixture_staged WHERE capability=?", [context.capability])[0]; }
  receipt(attempt: string) { return this.rows<PasskeyTicket>("SELECT * FROM passkey_fixture_receipt WHERE attemptId=?", [attempt])[0]; }
  credential(id: string) { return this.rows<PasskeyRow>(`SELECT id, "credentialID", "userId", "publicKey", counter FROM ${PASSKEY_MODEL} WHERE "credentialID"=?`, [id])[0]; }
  fingerprint(row: PasskeyRow) { return passkeyHash(`${row.id}:${row.publicKey}`); }
  trust(id: string) { return this.rows<{ subject: string; handle: string; fingerprint: string; generation: number; verifiedUv: number }>("SELECT * FROM passkey_fixture_trust WHERE credential=?", [id])[0]; }
  enrolled(subject: string) { return this.rows("SELECT 1 FROM passkey_fixture_trust WHERE subject=?", [subject]).length > 0; }
  protected(subject: string) { return this.enrolled(subject) || this.rows('SELECT 1 FROM authentication_ba_user WHERE id=? AND "twoFactorEnabled"=1', [subject]).length > 0; }
  origin(sessionId: string, subject: string, now: number) {
    const row = this.rows<{ originalDeadline: number; authenticatedAt: number }>(`SELECT e.originalDeadline,e.authenticatedAt FROM passkey_fixture_evidence e JOIN passkey_fixture_generation g ON g.subject=e.subject AND g.generation=e.generation JOIN authentication_ba_session s ON s.id=e.sessionId AND s."userId"=e.subject WHERE e.sessionId=? AND e.subject=? AND e.method='password' AND s."expiresAt">?`, [sessionId, subject, now])[0];
    return row && row.authenticatedAt <= now && row.originalDeadline > now && this.current(subject) ? row : null;
  }
  issue(opaque: string, context: Omit<PasskeyContext, "capability" | "used" | "credential"> & {credential?: string | null}) {
    this.prune(Date.now()); this.capacity("passkey_fixture_context");
    this.run("INSERT INTO passkey_fixture_context(capability,purpose,subject,sessionId,handle,nativeId,deadline,originalDeadline,generation,credential) VALUES (?,?,?,?,?,?,?,?,?,?)", [passkeyHash(opaque),context.purpose,context.subject,context.sessionId,context.handle,context.nativeId,context.deadline,context.originalDeadline,context.generation,context.credential ?? null]);
  }
  stage(row: PasskeyRow, context: PasskeyContext) {
    if (!context.subject || !context.sessionId || !context.handle || context.generation === null) throw new Error("Enrollment context missing.");
    const origin = this.origin(context.sessionId,context.subject,Date.now());
    if (!origin) throw new Error("Enrollment origin missing.");
    this.prune(Date.now()); this.capacity("passkey_fixture_staged");
    this.run("INSERT INTO passkey_fixture_staged VALUES (?,?,?,?,?,?,?,?,?,'enrollment-confirmation')", [row.credentialID,context.capability,context.subject,context.handle,this.fingerprint(row),context.generation,context.sessionId,context.originalDeadline,Math.min(context.deadline,origin.authenticatedAt+10*60_000)]);
  }
  stageUsable(stage: StagedPasskey, now: number) {
    const row = this.credential(stage.credential), origin = this.origin(stage.sessionId,stage.subject,now);
    return stage.purpose === "enrollment-confirmation" && stage.deadline > now && !!origin && origin.originalDeadline === stage.originalDeadline && !this.protected(stage.subject) && !!row && row.userId === stage.subject && this.fingerprint(row) === stage.fingerprint && this.rows<{generation:number}>("SELECT generation FROM passkey_fixture_generation WHERE subject=?",[stage.subject])[0]?.generation === stage.generation;
  }
  boundStage(context: PasskeyContext, now: number) {
    const stage = context.credential && this.staged(context.credential);
    return stage && this.stageUsable(stage,now) && context.purpose === stage.purpose && context.subject === stage.subject && context.sessionId === stage.sessionId && context.handle === stage.handle && context.generation === stage.generation && context.originalDeadline === stage.originalDeadline && context.deadline <= stage.deadline ? stage : null;
  }
  promote(ticket: PasskeyTicket, now: number) {
    const context = this.ticketContext(ticket), stage = context && this.boundStage(context,now);
    if (!stage || !this.usable(ticket,now)) throw new Error("Promotion refused.");
    this.settle(ticket,null,now);
    this.capacity("passkey_fixture_trust");
    this.run("INSERT INTO passkey_fixture_trust VALUES (?,?,?,?,?,1)",[stage.credential,stage.subject,stage.handle,stage.fingerprint,stage.generation]);
    this.run("DELETE FROM passkey_fixture_staged WHERE credential=? AND fingerprint=?",[stage.credential,stage.fingerprint]);
  }
  valid(context: PasskeyContext, now: number) {
    return !context.used && context.deadline > now && this.rows('SELECT 1 FROM authentication_ba_verification WHERE id=? AND "expiresAt">?', [context.nativeId, now]).length === 1;
  }
  /** Short committed charge and one-use capability reservation BEFORE native entry. */
  admit(context: PasskeyContext, attemptId: string, subject: string, credential: string | null, now: number): PasskeyTicket {
    if (!this.valid(context, now) || !this.current(subject) || (context.subject && context.subject !== subject) || this.receipt(attemptId)) throw new Error("Context refused.");
    const generation = this.generation(subject);
    if (context.generation !== null && context.generation !== generation) throw new Error("Stale generation.");
    let fingerprint: string | null = null;
    if (context.purpose === "enrollment-confirmation") {
      const stage = this.boundStage(context,now);
      if (!stage || credential !== stage.credential || subject !== stage.subject) throw new Error("Confirmation refused.");
      fingerprint = stage.fingerprint;
    } else if (credential) {
      const row = this.credential(credential), trust = this.trust(credential);
      if (!row || !trust || trust.verifiedUv !== 1 || row.userId !== subject || trust.subject !== subject || trust.generation !== generation || trust.fingerprint !== this.fingerprint(row)) throw new Error("Credential untrusted.");
      fingerprint = trust.fingerprint;
    } else if (!context.sessionId || !this.origin(context.sessionId, subject, now) || context.originalDeadline <= now || this.protected(subject)) throw new Error("Enrollment refused.");
    const epoch = Math.floor(now / PASSKEY_BOUNDS.windowMs);
    const charged = this.rows<{ charged: number }>("SELECT charged FROM passkey_fixture_budget WHERE subject=? AND epoch=?", [subject, epoch])[0]?.charged ?? 0;
    if (charged >= PASSKEY_BOUNDS.attempts) throw new Error("Budget spent.");
    this.capacity("passkey_fixture_receipt"); this.capacity("passkey_fixture_budget");
    this.run("INSERT INTO passkey_fixture_budget(subject,epoch,charged) VALUES (?,?,?) ON CONFLICT(subject,epoch) DO UPDATE SET charged=excluded.charged", [subject,epoch,charged+1]);
    this.run("UPDATE passkey_fixture_context SET used=1 WHERE capability=? AND used=0", [context.capability]);
    this.run("INSERT INTO passkey_fixture_receipt(attemptId,capability,subject,generation,credential,fingerprint,deadline,state) VALUES (?,?,?,?,?,?,?,'charged')", [attemptId,context.capability,subject,generation,credential,fingerprint,Math.min(context.deadline,now+PASSKEY_BOUNDS.ticketMs)]);
    return this.receipt(attemptId)!;
  }
  usable(ticket: PasskeyTicket, now: number) {
    const generation = this.rows<{ generation: number }>("SELECT generation FROM passkey_fixture_generation WHERE subject=?", [ticket.subject])[0]?.generation;
    if (this.receipt(ticket.attemptId)?.state !== "charged" || !this.current(ticket.subject) || generation !== ticket.generation || ticket.deadline <= now) return false;
    const context = this.ticketContext(ticket);
    if (!context || context.deadline <= now || context.originalDeadline <= now) return false;
    if (context.purpose === "enrollment-confirmation") {
      const stage = this.boundStage(context,now);
      return !!stage && stage.credential === ticket.credential && stage.fingerprint === ticket.fingerprint;
    }
    if (!ticket.credential) return !!context.sessionId && !!this.origin(context.sessionId,ticket.subject,now) && !this.protected(ticket.subject);
    const row = this.credential(ticket.credential), trust = this.trust(ticket.credential);
    return !!row && !!trust && trust.subject === ticket.subject && trust.verifiedUv === 1 && row.userId === ticket.subject && trust.generation === generation && this.fingerprint(row) === ticket.fingerprint && trust.fingerprint === ticket.fingerprint;
  }
  evidence(sessionId: string, subject: string, method: "password" | "passkey_uv", authenticatedAt: number, deadline: number, credential: string | null) {
    this.capacity("passkey_fixture_evidence");
    if (!this.current(subject) || !this.rows('SELECT 1 FROM authentication_ba_session WHERE id=? AND "userId"=?', [sessionId, subject]).length) throw new Error("Session refused.");
    this.run("INSERT INTO passkey_fixture_evidence VALUES (?,?,?,?,?,?,?,0)", [sessionId,subject,method,authenticatedAt,deadline,this.generation(subject),credential]);
  }
  settle(ticket: PasskeyTicket, sessionId: string | null, now: number) {
    if (!this.usable(ticket, now)) throw new Error("Settlement refused.");
    this.run("UPDATE passkey_fixture_receipt SET state='succeeded',sessionId=? WHERE attemptId=? AND state='charged'", [sessionId,ticket.attemptId]);
  }
  operationReceipt(attempt: string, subject: string | null, deadline: number, sessionId: string | null = null) {
    this.capacity("passkey_fixture_receipt");
    this.run("INSERT INTO passkey_fixture_receipt(attemptId,capability,subject,generation,deadline,state,sessionId) VALUES (?,?,?,?,?,'succeeded',?)", [attempt,`operation:${attempt}`,subject ?? "",subject ? this.generation(subject) : 0,deadline,sessionId]);
  }
  session(sessionId: string, subject: string, now: number) {
    if (!this.current(subject)) return null;
    const row = this.rows<{ method: "password" | "passkey_uv"; originalDeadline: number; credential: string | null; generation: number }>(`SELECT e.method,e.originalDeadline,e.credential,e.generation FROM passkey_fixture_evidence e JOIN authentication_ba_session s ON s.id=e.sessionId AND s."userId"=e.subject JOIN passkey_fixture_generation g ON g.subject=e.subject AND g.generation=e.generation WHERE e.sessionId=? AND e.subject=? AND s."expiresAt">? AND e.originalDeadline>?`,[sessionId,subject,now,now])[0];
    if (!row) return null;
    if (row.method === "passkey_uv") {
      const credential=row.credential && this.credential(row.credential),trust=row.credential && this.trust(row.credential);
      if (!credential || !trust || credential.userId!==subject || trust.subject!==subject || trust.generation!==row.generation || trust.fingerprint!==this.fingerprint(credential)) return null;
    }
    return {method:row.method,originalDeadline:row.originalDeadline,authorizing:false};
  }
  fail(attempt: string) { this.run("UPDATE passkey_fixture_receipt SET state='failed' WHERE attemptId=? AND state='charged'", [attempt]); }
  prune(now: number) {
    // Never delete a trusted/replaced native row, or a candidate with unresolved admission.
    const stale = this.rows<StagedPasskey>("SELECT * FROM passkey_fixture_staged s WHERE s.deadline<=? AND NOT EXISTS(SELECT 1 FROM passkey_fixture_receipt r WHERE r.credential=s.credential AND r.state='charged') LIMIT ?",[now,PASSKEY_BOUNDS.pruneBatch]);
    for (const stage of stale) {
      const row = this.credential(stage.credential);
      if (!this.trust(stage.credential) && row?.userId === stage.subject && this.fingerprint(row) === stage.fingerprint) this.run(`DELETE FROM ${PASSKEY_MODEL} WHERE id=? AND "credentialID"=?`,[row.id,stage.credential]);
      this.run("DELETE FROM passkey_fixture_staged WHERE credential=? AND fingerprint=?",[stage.credential,stage.fingerprint]);
    }
    this.run("DELETE FROM passkey_fixture_context WHERE capability IN (SELECT capability FROM passkey_fixture_context c WHERE deadline<=? AND NOT EXISTS(SELECT 1 FROM passkey_fixture_receipt r WHERE r.capability=c.capability AND r.state='charged') LIMIT ?)", [now,PASSKEY_BOUNDS.pruneBatch]);
    this.run("DELETE FROM passkey_fixture_receipt WHERE attemptId IN (SELECT attemptId FROM passkey_fixture_receipt WHERE deadline<=? AND state!='charged' LIMIT ?)", [now,PASSKEY_BOUNDS.pruneBatch]);
    this.run("DELETE FROM passkey_fixture_budget WHERE rowid IN (SELECT rowid FROM passkey_fixture_budget b WHERE epoch<? AND NOT EXISTS(SELECT 1 FROM passkey_fixture_receipt r WHERE r.subject=b.subject AND r.state='charged') LIMIT ?)", [Math.floor(now/PASSKEY_BOUNDS.windowMs),PASSKEY_BOUNDS.pruneBatch]);
  }
}
