import type Database from "better-sqlite3";
import { AuthenticationProviderError, type ProviderAuditEvent, type ProviderSubjectMapping, type ProviderSubjectStore, type ProviderSessionState } from "@/server/modules/authentication";

type SubjectRow = { provider_id: string; subject: string; principal_id: string; status: "active" | "revoked"; linked_at: string; revoked_at: string | null };
const map = (row: SubjectRow): ProviderSubjectMapping => ({
  providerId: row.provider_id, subject: row.subject, principalId: row.principal_id,
  status: row.status, linkedAt: row.linked_at, revokedAt: row.revoked_at,
});

/**
 * Explicit provider-subject to owner-principal mapping (migration 38). Links
 * only by opaque subject ID; audit details hold IDs, never credentials or
 * contact data. Runs on the guarded core handle inside a provider borrow.
 */
export class AuthenticationProviderQueries implements ProviderSubjectStore {
  constructor(private readonly database: Database.Database, private readonly providerId: string) {}

  /** Core-only authority projection: deliberately excludes token, password and account contact data. */
  currentSession(sessionId: string): ProviderSessionState | null {
    if (this.providerId !== "better-auth") return null;
    const row = this.database.prepare(`SELECT s."userId" AS subject, s."createdAt" AS createdAt,
      s."expiresAt" AS expiresAt, m.principal_id AS principalId
      FROM authentication_ba_session s
      JOIN authentication_provider_subjects m ON m.provider_id = ? AND m.subject = s."userId"
      JOIN remote_principals p ON p.id = m.principal_id
      WHERE s.id = ? AND m.status = 'active' AND m.revoked_at IS NULL
        AND p.kind = 'owner' AND p.status = 'active'`).get(this.providerId, sessionId) as ProviderSessionState | undefined;
    return row ?? null;
  }

  link(input: { subject: string; principalId: string; actor: string }): ProviderSubjectMapping {
    return this.database.transaction(() => {
      const principal = this.database.prepare("SELECT kind, status FROM remote_principals WHERE id = ?").get(input.principalId) as { kind: string; status: string } | undefined;
      if (principal?.kind !== "owner" || principal.status !== "active") throw new AuthenticationProviderError("principal_unavailable", "Only an existing active owner principal can be linked.");
      if (!this.database.prepare('SELECT 1 FROM "authentication_ba_user" WHERE "id" = ?').get(input.subject)) throw new AuthenticationProviderError("invalid_input", "The provider account does not exist.");
      const existing = this.find(input.subject);
      if (existing) {
        if (existing.status === "active" && existing.principalId === input.principalId) return existing;
        throw new AuthenticationProviderError("subject_conflict", "The provider account is already linked.");
      }
      if (this.findByPrincipal(input.principalId)) throw new AuthenticationProviderError("subject_conflict", "The principal already has a provider account.");
      const now = new Date().toISOString();
      this.database.prepare("INSERT INTO authentication_provider_subjects(provider_id, subject, principal_id, status, linked_at, revoked_at) VALUES (?, ?, ?, 'active', ?, NULL)")
        .run(this.providerId, input.subject, input.principalId, now);
      return this.find(input.subject)!;
    })();
  }

  find(subject: string): ProviderSubjectMapping | null {
    const row = this.database.prepare("SELECT * FROM authentication_provider_subjects WHERE provider_id = ? AND subject = ?").get(this.providerId, subject) as SubjectRow | undefined;
    return row ? map(row) : null;
  }

  findByPrincipal(principalId: string): ProviderSubjectMapping | null {
    const row = this.database.prepare("SELECT * FROM authentication_provider_subjects WHERE provider_id = ? AND principal_id = ? AND status = 'active'").get(this.providerId, principalId) as SubjectRow | undefined;
    return row ? map(row) : null;
  }

  resolveActivePrincipal(subject: string): string | null {
    const row = this.database.prepare(`SELECT s.principal_id FROM authentication_provider_subjects s
      JOIN remote_principals p ON p.id = s.principal_id
      WHERE s.provider_id = ? AND s.subject = ? AND s.status = 'active' AND p.kind = 'owner' AND p.status = 'active'`)
      .get(this.providerId, subject) as { principal_id: string } | undefined;
    return row?.principal_id ?? null;
  }

  revoke(input: { subject: string; actor: string }): ProviderSubjectMapping {
    return this.database.transaction(() => {
      const current = this.find(input.subject);
      if (!current || current.status !== "active") throw new AuthenticationProviderError("not_linked", "The provider account is not linked.");
      this.database.prepare("UPDATE authentication_provider_subjects SET status = 'revoked', revoked_at = ? WHERE provider_id = ? AND subject = ? AND status = 'active'")
        .run(new Date().toISOString(), this.providerId, input.subject);
      this.record("authentication.provider.subject_revoked", { subject: input.subject, principalId: current.principalId, actor: input.actor });
      return this.find(input.subject)!;
    })();
  }

  record(event: ProviderAuditEvent, input: { subject: string; principalId: string; actor: string }): void {
    this.database.prepare("INSERT INTO controller_audit_events(event_type, actor, details_json, created_at) VALUES (?, ?, ?, ?)")
      .run(event, input.actor, JSON.stringify({ providerId: this.providerId, subject: input.subject, principalId: input.principalId }), new Date().toISOString());
  }
}
