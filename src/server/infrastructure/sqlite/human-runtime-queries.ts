import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { HumanRuntimeAuthority } from "@/server/modules/identity";
import { HUMAN_RUNTIME_LIMITS, type HumanRuntimeLease, type HumanRuntimeStore, type HumanRuntimeIntent } from "@/server/modules/runtime";
import { ScopedRuntimeError } from "@/server/modules/runtime";
import { ReservationError } from "@/server/state-store";
import { mapReservation, type ReservationRow } from "./reservation-mapping";

export class HumanRuntimeQueries implements HumanRuntimeStore {
  constructor(private readonly db: Database.Database) {}
  begin(a: HumanRuntimeAuthority, projectId: string, key: string, fingerprint: string): HumanRuntimeIntent | null {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      // Keys are discarded only after their original authenticated session can no longer authorize.
      this.db.prepare("DELETE FROM human_runtime_intents WHERE retain_until<=?").run(now);
      // A permanent marker on reservations continues to deny all legacy owner-string paths.
      this.db.prepare("DELETE FROM human_runtime_leases WHERE maximum_expires_at<=?").run(now);
      const row = this.db.prepare("SELECT * FROM human_runtime_intents WHERE session_key=? AND idempotency_key=?")
        .get(a.sessionKey, key) as { fingerprint: string; principal_id: string; project_id: string; membership_revision: number; reservation_id: string | null; state: "pending" | "complete"; result_json: string | null } | undefined;
      if (row) {
        if (row.fingerprint !== fingerprint || row.principal_id !== a.principalId || row.project_id !== projectId) {
          throw new ScopedRuntimeError("idempotency_conflict", "The idempotency key has a different intent.");
        }
        return { fingerprint: row.fingerprint, membershipRevision: row.membership_revision,
          reservationId: row.reservation_id, state: row.state, result: row.result_json ? JSON.parse(row.result_json) : null };
      }
      const count = (sql: string, ...args: string[]) => (this.db.prepare(sql).get(...args) as {n:number}).n;
      if (count("SELECT count(*) n FROM human_runtime_intents") >= HUMAN_RUNTIME_LIMITS.intents
        || count("SELECT count(*) n FROM human_runtime_intents WHERE session_key=?", a.sessionKey) >= HUMAN_RUNTIME_LIMITS.sessionIntents) {
        throw new ScopedRuntimeError("capacity", "Runtime request capacity is exhausted.");
      }
      this.db.prepare(`INSERT INTO human_runtime_intents(session_key,idempotency_key,principal_id,project_id,membership_revision,fingerprint,reservation_id,state,result_json,retain_until)
        VALUES(?,?,?,?,?,?,NULL,'pending',NULL,?)`).run(a.sessionKey, key, a.principalId, projectId, a.membershipRevision, fingerprint, a.deadline);
      return null;
    }).immediate();
  }
  attach(a: HumanRuntimeAuthority, key: string, id: string): void {
    this.db.prepare("UPDATE human_runtime_intents SET reservation_id=? WHERE session_key=? AND idempotency_key=? AND state='pending' AND reservation_id IS NULL")
      .run(id, a.sessionKey, key);
  }
  finish(a: HumanRuntimeAuthority, key: string, result: unknown): void {
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > HUMAN_RUNTIME_LIMITS.receiptBytes) throw new ScopedRuntimeError("outcome_unknown", "Inspect the runtime before issuing another operation.");
    this.db.prepare("UPDATE human_runtime_intents SET state='complete',result_json=? WHERE session_key=? AND idempotency_key=? AND state='pending'")
      .run(json, a.sessionKey, key);
  }
  claim(a: HumanRuntimeAuthority, input: Parameters<HumanRuntimeStore["claim"]>[1]) {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const maximum = Math.min(Date.parse(a.deadline), Date.parse(now) + 8 * 3600_000);
      if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 1800 || maximum - Date.now() < 30_000) {
        throw new ScopedRuntimeError("claim_stale", "Insufficient authenticated session lifetime.");
      }
      if ((this.db.prepare("SELECT count(*) n FROM human_runtime_leases").get() as {n:number}).n >= HUMAN_RUNTIME_LIMITS.leases) {
        throw new ScopedRuntimeError("capacity", "Runtime lease capacity is exhausted.");
      }
      // Expiry follows the same reservation state machine, never a second runtime lock or engine.
      this.db.prepare(`UPDATE reservations SET released_at=?,released_by='lease-expired' WHERE project_id=? AND released_at IS NULL
        AND ((expires_at IS NOT NULL AND expires_at<=?) OR (provider_bound=1 AND NOT EXISTS
          (SELECT 1 FROM human_runtime_leases h WHERE h.reservation_id=reservations.id AND h.expires_at>?)))`)
        .run(now, input.projectId, now, now);
      if (this.db.prepare("SELECT 1 FROM reservations WHERE project_id=? AND released_at IS NULL").get(input.projectId)) {
        throw new ReservationError("claim_conflict", "The project already has an active claim.");
      }
      const id = randomUUID(), expiresAt = new Date(Math.min(maximum, Date.now() + input.ttlSeconds * 1000)).toISOString();
      this.db.prepare(`INSERT INTO reservations(id,project_id,worktree_path,kind,owner,reason,created_at,provider_bound,idempotency_key,request_fingerprint)
        VALUES(?,?,?,'human',?,?,?,1,?,?)`).run(id, input.projectId, input.worktreePath, `human:${a.principalId}`, input.reason, now, input.key, input.fingerprint);
      this.db.prepare(`INSERT INTO human_runtime_leases VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, a.principalId, a.sessionKey, a.evidenceKey,
        a.generation, a.membershipRevision, JSON.stringify(a.permissions), input.fingerprint, expiresAt, new Date(maximum).toISOString(), a.deadline);
      this.attach(a, input.key, id);
      this.audit(input.projectId, "human.claimed", a.principalId, {reservationId:id,expiresAt});
      return this.lease(id)!.reservation;
    }).immediate();
  }
  lease(id: string): HumanRuntimeLease | null {
    const row = this.db.prepare(`SELECT r.*,h.principal_id human_principal_id,h.session_key,h.evidence_key,h.generation,h.membership_revision,
      h.permissions_json,h.fingerprint,h.expires_at human_expires_at,h.maximum_expires_at human_maximum_expires_at,h.session_deadline
      FROM reservations r JOIN human_runtime_leases h ON h.reservation_id=r.id WHERE r.id=? AND r.provider_bound=1 AND r.kind='human' AND h.fingerprint=r.request_fingerprint AND r.owner=('human:'||h.principal_id)`).get(id) as
      (ReservationRow & { human_principal_id:string; session_key:string; evidence_key:string; generation:number; membership_revision:number;
        permissions_json:string; fingerprint:string; human_expires_at:string; human_maximum_expires_at:string; session_deadline:string }) | undefined;
    if (!row) return null;
    return { reservation: { ...mapReservation(row), expiresAt: row.human_expires_at, maximumExpiresAt: row.human_maximum_expires_at },
      released: row.released_at != null, fingerprint: row.fingerprint,
      authority: { principalId: row.human_principal_id, sessionKey: row.session_key, evidenceKey: row.evidence_key, generation: row.generation,
        membershipRevision: row.membership_revision, permissions: JSON.parse(row.permissions_json), deadline: row.session_deadline } };
  }
  renew(id: string, expiresAt: string) {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE human_runtime_leases SET expires_at=? WHERE reservation_id=? AND expires_at>? AND maximum_expires_at>=?")
        .run(expiresAt, id, new Date().toISOString(), expiresAt);
      if (changed.changes !== 1) throw new ScopedRuntimeError("claim_stale", "The claim is stale, expired, or no longer active.");
      const reservation = this.lease(id)!.reservation;
      this.audit(reservation.projectId, "human.claim_renewed", reservation.owner, {reservationId:id,expiresAt});
      return reservation;
    }).immediate();
  }
  release(id: string, actor: string): void {
    this.db.transaction(() => {
      const lease = this.lease(id);
      this.db.prepare("UPDATE reservations SET released_at=?,released_by=? WHERE id=? AND provider_bound=1 AND released_at IS NULL")
        .run(new Date().toISOString(), actor, id);
      if (lease) this.audit(lease.reservation.projectId, "human.claim_released", actor, {reservationId:id});
    }).immediate();
  }
  private audit(projectId: string, event: string, actor: string, details: unknown) {
    this.db.prepare("INSERT INTO audit_events(project_id,event_type,actor,details_json,created_at) VALUES(?,?,?,?,?)")
      .run(projectId,event,actor,JSON.stringify(details),new Date().toISOString());
  }
}
