import type Database from "better-sqlite3";
import { AuthenticationProviderError, type ProviderAuditEvent, type ProviderSubjectMapping, type ProviderSubjectStore } from "@/server/modules/authentication";

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

  isActiveOwner(principalId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM remote_principals WHERE id = ? AND kind = 'owner' AND status = 'active'").get(principalId));
  }

  hasSubjectHistory(principalId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM authentication_provider_subjects WHERE provider_id = ? AND principal_id = ? LIMIT 1").get(this.providerId, principalId));
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
    const row = this.database.prepare("SELECT * FROM authentication_provider_subjects WHERE provider_id = ? AND principal_id = ? AND status = 'active' AND revoked_at IS NULL").get(this.providerId, principalId) as SubjectRow | undefined;
    return row ? map(row) : null;
  }

  resolveActivePrincipal(subject: string): string | null {
    const row = this.database.prepare(`SELECT s.principal_id FROM authentication_provider_subjects s
      JOIN remote_principals p ON p.id = s.principal_id
      WHERE s.provider_id = ? AND s.subject = ? AND s.status = 'active' AND s.revoked_at IS NULL AND p.kind = 'owner' AND p.status = 'active'`)
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
