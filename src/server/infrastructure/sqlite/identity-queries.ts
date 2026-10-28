import type { KnowledgeRoleBinding } from "@/shared/contracts/authorization";
import type {
  CredentialAuthenticationRecord,
  IdentityStore,
  KnowledgeProject,
  KnowledgeProjectGrant,
  KnowledgeProjectRuntimeLink,
  Principal,
  PrincipalCredential,
} from "@/server/modules/identity";
import Database from "better-sqlite3";

type CredentialRow = {
  id: string;
  principal_id: string;
  kind: CredentialAuthenticationRecord["kind"];
  label: string;
  token_prefix: string;
  verifier_hash: string;
  status: CredentialAuthenticationRecord["status"];
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
type KnowledgeProjectRow = {
  id: string;
  name: string;
  status: KnowledgeProject["status"];
  revision: number;
  created_at: string;
  updated_at: string;
};
type KnowledgeGrantRow = {
  principal_id: string;
  project_id: string;
  permissions_json: string;
  revoked_at: string | null;
};
type RuntimeLinkRow = {
  knowledge_project_id: string;
  runtime_project_id: string | null;
  linked_at: string;
  unlinked_at: string | null;
};

function mapCredential(row: CredentialRow): CredentialAuthenticationRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    kind: row.kind,
    label: row.label,
    tokenPrefix: row.token_prefix,
    verifierHash: row.verifier_hash,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

function publicCredential(record: CredentialAuthenticationRecord): PrincipalCredential {
  return {
    id: record.id,
    principalId: record.principalId,
    kind: record.kind,
    label: record.label,
    tokenPrefix: record.tokenPrefix,
    status: record.status,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/** Borrows the controller's singleton connection and never owns database lifecycle. */
export class IdentityQueries implements IdentityStore {
  constructor(private readonly database: Database.Database) {}

  getPrincipal(id: string): Principal | null {
    return (this.database.prepare("SELECT id, kind, status FROM remote_principals WHERE id = ?")
      .get(id) as Principal | undefined) ?? null;
  }

  getOwnerPrincipal(): Principal | null {
    return (this.database.prepare("SELECT id, kind, status FROM remote_principals WHERE kind = 'owner' LIMIT 1")
      .get() as Principal | undefined) ?? null;
  }

  listPrincipals(kind?: Principal["kind"]): Principal[] {
    const rows = kind
      ? this.database.prepare("SELECT id, kind, status FROM remote_principals WHERE kind = ? ORDER BY id").all(kind)
      : this.database.prepare("SELECT id, kind, status FROM remote_principals ORDER BY kind, id").all();
    return rows as Principal[];
  }

  savePrincipal(principal: Principal, actor: string): void {
    const existing = this.getPrincipal(principal.id);
    if (existing && existing.kind !== principal.kind) {
      throw new Error("Nie można zmienić rodzaju istniejącej tożsamości zdalnej.");
    }
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO remote_principals(id, kind, status) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
      `).run(principal.id, principal.kind, principal.status);
      this.audit("identity.principal_saved", actor, { id: principal.id, kind: principal.kind, status: principal.status });
    })();
  }

  getCredentialForAuthentication(id: string): CredentialAuthenticationRecord | null {
    const row = this.database.prepare("SELECT * FROM principal_credentials WHERE id = ?").get(id) as CredentialRow | undefined;
    return row ? mapCredential(row) : null;
  }

  saveCredential(credential: CredentialAuthenticationRecord, actor: string): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO principal_credentials(
          id, principal_id, kind, label, token_prefix, verifier_hash, status,
          expires_at, created_at, revoked_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        credential.id, credential.principalId, credential.kind, credential.label,
        credential.tokenPrefix, credential.verifierHash, credential.status,
        credential.expiresAt, credential.createdAt, credential.revokedAt, credential.lastUsedAt,
      );
      this.audit("identity.credential_issued", actor, {
        credentialId: credential.id,
        principalId: credential.principalId,
        kind: credential.kind,
        label: credential.label,
        tokenPrefix: credential.tokenPrefix,
        expiresAt: credential.expiresAt,
      });
    })();
  }

  createFirstOwner(principal: Principal, credential: CredentialAuthenticationRecord, actor: string): boolean {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT 1 FROM remote_principals WHERE kind = 'owner' LIMIT 1").get();
      if (existing) return false;
      this.database.prepare("INSERT INTO remote_principals(id, kind, status) VALUES (?, 'owner', 'active')")
        .run(principal.id);
      this.database.prepare(`
        INSERT INTO principal_credentials(
          id, principal_id, kind, label, token_prefix, verifier_hash, status,
          expires_at, created_at, revoked_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        credential.id, credential.principalId, credential.kind, credential.label,
        credential.tokenPrefix, credential.verifierHash, credential.status,
        credential.expiresAt, credential.createdAt, credential.revokedAt, credential.lastUsedAt,
      );
      this.audit("identity.owner_bootstrapped", actor, {
        principalId: principal.id,
        credentialId: credential.id,
        tokenPrefix: credential.tokenPrefix,
        expiresAt: credential.expiresAt,
      });
      return true;
    }).immediate();
  }

  listPrincipalCredentials(principalId: string): PrincipalCredential[] {
    return (this.database.prepare(`
      SELECT * FROM principal_credentials WHERE principal_id = ? ORDER BY created_at, id
    `).all(principalId) as CredentialRow[]).map(mapCredential).map(publicCredential);
  }

  revokeCredential(id: string, revokedAt: string, actor: string): boolean {
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE principal_credentials SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND status = 'active'
      `).run(revokedAt, id);
      if (result.changes > 0) this.audit("identity.credential_revoked", actor, { credentialId: id });
      return result.changes > 0;
    })();
  }

  recordCredentialUsed(id: string, usedAt: string): void {
    this.database.prepare("UPDATE principal_credentials SET last_used_at = ? WHERE id = ?").run(usedAt, id);
  }

  getKnowledgeProject(id: string): KnowledgeProject | null {
    const row = this.database.prepare("SELECT * FROM knowledge_projects WHERE id = ?").get(id) as KnowledgeProjectRow | undefined;
    return row ? {
      id: row.id, name: row.name, status: row.status, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  saveKnowledgeProject(project: KnowledgeProject, actor: string): void {
    this.database.transaction(() => {
      const existing = this.getKnowledgeProject(project.id);
      if (existing && project.revision !== existing.revision + 1) throw new Error("Nieaktualna rewizja projektu wiedzy.");
      if (!existing && project.revision !== 1) throw new Error("Nowy projekt wiedzy musi zaczynać od rewizji 1.");
      this.database.prepare(`
        INSERT INTO knowledge_projects(id, name, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, status = excluded.status,
          revision = excluded.revision, updated_at = excluded.updated_at
      `).run(project.id, project.name, project.status, project.revision, project.createdAt, project.updatedAt);
      this.audit("knowledge.project_saved", actor, { projectId: project.id, revision: project.revision, status: project.status });
    }).immediate();
  }

  getKnowledgeProjectGrant(principalId: string, projectId: string): KnowledgeProjectGrant | null {
    const row = this.database.prepare(`
      SELECT principal_id, project_id, permissions_json, revoked_at
      FROM knowledge_project_grants WHERE principal_id = ? AND project_id = ?
    `).get(principalId, projectId) as KnowledgeGrantRow | undefined;
    return row ? {
      principalId: row.principal_id,
      projectId: row.project_id,
      permissions: JSON.parse(row.permissions_json) as KnowledgeProjectGrant["permissions"],
      revokedAt: row.revoked_at,
    } : null;
  }

  listKnowledgeProjectGrants(principalId: string): KnowledgeProjectGrant[] {
    return (this.database.prepare(`
      SELECT principal_id, project_id, permissions_json, revoked_at
      FROM knowledge_project_grants WHERE principal_id = ? ORDER BY project_id
    `).all(principalId) as KnowledgeGrantRow[]).map((row) => ({
      principalId: row.principal_id,
      projectId: row.project_id,
      permissions: JSON.parse(row.permissions_json) as KnowledgeProjectGrant["permissions"],
      revokedAt: row.revoked_at,
    }));
  }

  saveKnowledgeProjectGrant(grant: KnowledgeProjectGrant, actor: string): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO knowledge_project_grants(principal_id, project_id, permissions_json, revoked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(principal_id, project_id) DO UPDATE SET
          permissions_json = excluded.permissions_json, revoked_at = excluded.revoked_at
      `).run(grant.principalId, grant.projectId, JSON.stringify([...new Set(grant.permissions)].sort()), grant.revokedAt);
      this.audit("knowledge.grant_saved", actor, {
        principalId: grant.principalId,
        projectId: grant.projectId,
        permissions: [...new Set(grant.permissions)].sort(),
        revokedAt: grant.revokedAt,
      });
    })();
  }

  getKnowledgeRoleBinding(principalId: string, projectId: string): KnowledgeRoleBinding | null {
    return (this.database.prepare(`SELECT principal_id AS principalId, project_id AS projectId, role, revision,
      updated_at AS updatedAt, revoked_at AS revokedAt FROM knowledge_role_bindings WHERE principal_id=? AND project_id=?`)
      .get(principalId, projectId) as KnowledgeRoleBinding | undefined) ?? null;
  }

  listKnowledgeRoleBindings(principalId: string): KnowledgeRoleBinding[] {
    return this.database.prepare(`SELECT principal_id AS principalId, project_id AS projectId, role, revision,
      updated_at AS updatedAt, revoked_at AS revokedAt FROM knowledge_role_bindings WHERE principal_id=? ORDER BY project_id`)
      .all(principalId) as KnowledgeRoleBinding[];
  }

  saveKnowledgeRoleBinding(binding: KnowledgeRoleBinding, expectedRevision: number, actor: string): boolean {
    return this.database.transaction(() => {
      const current = this.getKnowledgeRoleBinding(binding.principalId, binding.projectId);
      if ((current?.revision ?? 0) !== expectedRevision || binding.revision !== expectedRevision + 1) return false;
      this.database.prepare(`INSERT INTO knowledge_role_bindings(principal_id,project_id,role,revision,updated_at,revoked_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(principal_id,project_id) DO UPDATE SET
        role=excluded.role, revision=excluded.revision, updated_at=excluded.updated_at, revoked_at=excluded.revoked_at`)
        .run(binding.principalId, binding.projectId, binding.role, binding.revision, binding.updatedAt, binding.revokedAt);
      this.audit("knowledge.role_saved", actor, binding);
      return true;
    }).immediate();
  }

  getKnowledgeProjectRuntimeLink(projectId: string): KnowledgeProjectRuntimeLink | null {
    const row = this.database.prepare(`
      SELECT knowledge_project_id, runtime_project_id, linked_at, unlinked_at
      FROM knowledge_project_runtime_links WHERE knowledge_project_id = ?
    `).get(projectId) as RuntimeLinkRow | undefined;
    return row ? {
      projectId: row.knowledge_project_id,
      runtimeProjectId: row.runtime_project_id,
      linkedAt: row.linked_at,
      unlinkedAt: row.unlinked_at,
    } : null;
  }

  saveKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, actor: string): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO knowledge_project_runtime_links(knowledge_project_id, runtime_project_id, linked_at, unlinked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(knowledge_project_id) DO UPDATE SET
          runtime_project_id = excluded.runtime_project_id,
          linked_at = excluded.linked_at,
          unlinked_at = excluded.unlinked_at
      `).run(link.projectId, link.runtimeProjectId, link.linkedAt, link.unlinkedAt);
      this.audit("knowledge.runtime_link_saved", actor, {
        projectId: link.projectId,
        runtimeProjectId: link.runtimeProjectId,
        unlinkedAt: link.unlinkedAt,
      });
    })();
  }

  private audit(eventType: string, actor: string, details: unknown): void {
    this.database.prepare(`
      INSERT INTO controller_audit_events(event_type, actor, details_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(eventType, actor, JSON.stringify(details), new Date().toISOString());
  }
}
