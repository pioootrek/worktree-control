import type { CredentialAuthenticationRecord, RuntimeAccessStore } from "@/server/modules/identity";
import { isRuntimeAction, type RuntimeAction, type RuntimeCredentialScope, type RuntimeDelegation } from "@/shared/contracts/runtime-access";
import type Database from "better-sqlite3";

type DelegationRow = {
  principal_id: string; project_id: string; sponsor_id: string; actions_json: string;
  revision: number; expires_at: string | null; updated_at: string; revoked_at: string | null;
};
type ScopeRow = { credential_id: string; project_id: string; actions_json: string; created_at: string };

/** Unknown stored actions are dropped, never widened into another permission. */
function actions(json: string): RuntimeAction[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isRuntimeAction) : [];
  } catch {
    return [];
  }
}

function mapDelegation(row: DelegationRow): RuntimeDelegation {
  return {
    principalId: row.principal_id, projectId: row.project_id, sponsorId: row.sponsor_id, actions: actions(row.actions_json),
    revision: row.revision, expiresAt: row.expires_at, updatedAt: row.updated_at, revokedAt: row.revoked_at,
  };
}

function mapScope(row: ScopeRow): RuntimeCredentialScope {
  return { credentialId: row.credential_id, projectId: row.project_id, actions: actions(row.actions_json), createdAt: row.created_at };
}

/** Borrows the controller's singleton connection and never owns database lifecycle. */
export class RuntimeAccessQueries implements RuntimeAccessStore {
  constructor(private readonly database: Database.Database) {}

  hasRuntimeProject(projectId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId));
  }

  getRuntimeDelegation(principalId: string, projectId: string): RuntimeDelegation | null {
    const row = this.database.prepare("SELECT * FROM runtime_delegations WHERE principal_id = ? AND project_id = ?")
      .get(principalId, projectId) as DelegationRow | undefined;
    return row ? mapDelegation(row) : null;
  }

  listRuntimeDelegations(principalId: string): RuntimeDelegation[] {
    return (this.database.prepare("SELECT * FROM runtime_delegations WHERE principal_id = ? ORDER BY project_id")
      .all(principalId) as DelegationRow[]).map(mapDelegation);
  }

  saveRuntimeDelegation(delegation: RuntimeDelegation, expectedRevision: number, actor: string): boolean {
    return this.database.transaction(() => {
      const current = this.getRuntimeDelegation(delegation.principalId, delegation.projectId);
      if ((current?.revision ?? 0) !== expectedRevision || delegation.revision !== expectedRevision + 1) return false;
      this.database.prepare(`INSERT INTO runtime_delegations(principal_id, project_id, sponsor_id, actions_json, revision, expires_at, updated_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(principal_id, project_id) DO UPDATE SET
        sponsor_id = excluded.sponsor_id, actions_json = excluded.actions_json, revision = excluded.revision,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`)
        .run(delegation.principalId, delegation.projectId, delegation.sponsorId, JSON.stringify(delegation.actions),
          delegation.revision, delegation.expiresAt, delegation.updatedAt, delegation.revokedAt);
      this.audit(delegation.revokedAt === null ? "runtime.delegation_saved" : "runtime.delegation_revoked", actor, {
        principalId: delegation.principalId, projectId: delegation.projectId, sponsorId: delegation.sponsorId,
        actions: delegation.actions, revision: delegation.revision, expiresAt: delegation.expiresAt,
      });
      return true;
    }).immediate();
  }

  getRuntimeCredentialScope(credentialId: string, projectId: string): RuntimeCredentialScope | null {
    const row = this.database.prepare("SELECT * FROM runtime_credential_scopes WHERE credential_id = ? AND project_id = ?")
      .get(credentialId, projectId) as ScopeRow | undefined;
    return row ? mapScope(row) : null;
  }

  listRuntimeCredentialScopes(credentialId: string): RuntimeCredentialScope[] {
    return (this.database.prepare("SELECT * FROM runtime_credential_scopes WHERE credential_id = ? ORDER BY project_id")
      .all(credentialId) as ScopeRow[]).map(mapScope);
  }

  issueScopedCredential(credential: CredentialAuthenticationRecord, scopes: RuntimeCredentialScope[], actor: string): void {
    this.database.transaction(() => {
      this.insertCredential(credential, scopes, actor);
    }).immediate();
  }

  rotateScopedCredential(replacedId: string, revokedAt: string, credential: CredentialAuthenticationRecord, scopes: RuntimeCredentialScope[], actor: string): boolean {
    return this.database.transaction(() => {
      const revoked = this.database.prepare(`UPDATE principal_credentials SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND status = 'active' AND kind = 'agent_token' AND principal_id = ?`).run(revokedAt, replacedId, credential.principalId);
      if (revoked.changes !== 1) return false;
      this.insertCredential(credential, scopes, actor);
      this.audit("identity.credential_rotated", actor, { replacedCredentialId: replacedId, credentialId: credential.id, principalId: credential.principalId });
      return true;
    }).immediate();
  }

  private insertCredential(credential: CredentialAuthenticationRecord, scopes: RuntimeCredentialScope[], actor: string): void {
    this.database.prepare(`INSERT INTO principal_credentials(
        id, principal_id, kind, label, token_prefix, verifier_hash, status, expires_at, created_at, revoked_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      credential.id, credential.principalId, credential.kind, credential.label, credential.tokenPrefix, credential.verifierHash,
      credential.status, credential.expiresAt, credential.createdAt, credential.revokedAt, credential.lastUsedAt,
    );
    const insert = this.database.prepare("INSERT INTO runtime_credential_scopes(credential_id, project_id, actions_json, created_at) VALUES (?, ?, ?, ?)");
    for (const scope of scopes) {
      if (scope.credentialId !== credential.id) throw new Error("Credential scope does not belong to the issued credential.");
      insert.run(scope.credentialId, scope.projectId, JSON.stringify(scope.actions), scope.createdAt);
    }
    this.audit("identity.credential_issued", actor, {
      credentialId: credential.id, principalId: credential.principalId, kind: credential.kind, label: credential.label,
      tokenPrefix: credential.tokenPrefix, expiresAt: credential.expiresAt,
      runtimeScopes: scopes.map(({ projectId, actions: scoped }) => ({ projectId, actions: scoped })),
    });
  }

  private audit(eventType: string, actor: string, details: unknown): void {
    this.database.prepare("INSERT INTO controller_audit_events(event_type, actor, details_json, created_at) VALUES (?, ?, ?, ?)")
      .run(eventType, actor, JSON.stringify(details), new Date().toISOString());
  }
}
