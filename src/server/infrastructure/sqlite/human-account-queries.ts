import { effectiveKnowledgePermissions } from "@/server/modules/authorization";
import type Database from "better-sqlite3";
import { HumanAccountError, type HumanAccountStore, type Principal } from "@/server/modules/identity";
import type { HumanKnowledgeMembership, HumanKnowledgeSet, HumanKnowledgeRevoke, HumanMembershipPage, HumanPage } from "@/shared/contracts/human-accounts";
import { IdentityQueries } from "./identity-queries";

/** One owner connection; aggregate CAS, grant, binding and audit commit together. */
export class HumanAccountQueries implements HumanAccountStore {
  private readonly identity: IdentityQueries;
  constructor(private readonly database: Database.Database) { this.identity = new IdentityQueries(database); }
  createHumanPrincipal(principal: Principal, actor: string): void {
    if (principal.kind !== "human" || principal.status !== "active") throw new HumanAccountError("invalid_input");
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO remote_principals(id,kind,status) VALUES(?,'human','active')").run(principal.id);
      this.audit("identity.human_created", actor, { principalId: principal.id });
    }).immediate();
  }
  listHumanPrincipals(page: HumanPage) {
    const rows = this.database.prepare(`SELECT p.id,p.kind,p.status,
      CASE WHEN EXISTS(SELECT 1 FROM authentication_provider_subjects s WHERE s.principal_id=p.id AND s.provider_id='better-auth' AND s.status='active' AND s.revoked_at IS NULL)
        THEN 'active' WHEN EXISTS(SELECT 1 FROM authentication_provider_subjects s WHERE s.principal_id=p.id AND s.provider_id='better-auth') THEN 'revoked' ELSE 'absent' END AS enrollment
      FROM remote_principals p WHERE p.kind='human' AND p.id>? ORDER BY p.id LIMIT ?`)
      .all(page.after ?? "", page.limit + 1) as Array<Principal & { enrollment: "absent" | "active" | "revoked" }>;
    return { items: rows.slice(0, page.limit), nextAfter: rows.length > page.limit ? rows[page.limit - 1].id : null };
  }
  disableHumanPrincipal(id: string, actor: string) {
    return this.database.transaction(() => {
      const principal = this.human(id);
      const changed = this.database.prepare("UPDATE remote_principals SET status='revoked' WHERE id=? AND kind='human' AND status='active'").run(id).changes === 1;
      if (changed) this.audit("identity.human_disabled", actor, { principalId: id });
      return { principal: { ...principal, status: "revoked" as const }, changed };
    }).immediate();
  }
  listHumanMemberships(page: HumanMembershipPage) {
    const principal = this.human(page.principalId);
    const rows = this.database.prepare("SELECT project_id FROM knowledge_role_bindings WHERE principal_id=? AND project_id>? ORDER BY project_id LIMIT ?")
      .all(page.principalId, page.after ?? "", page.limit + 1) as Array<{ project_id: string }>;
    return { items: rows.slice(0, page.limit).map(row => this.membership(principal, row.project_id)), nextAfter: rows.length > page.limit ? rows[page.limit - 1].project_id : null };
  }
  saveHumanMembership(input: HumanKnowledgeSet | HumanKnowledgeRevoke, actor: string, now: string): HumanKnowledgeMembership {
    return this.database.transaction(() => {
      const principal = this.human(input.principalId);
      if (principal.status !== "active") throw new HumanAccountError("principal_unavailable");
      const projectId = input.scope.id, project = this.identity.getKnowledgeProject(projectId);
      const current = this.identity.getKnowledgeRoleBinding(principal.id, projectId);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new HumanAccountError("membership_revision_conflict");
      const set = "role" in input;
      if (!project || (set && project.status !== "active")) throw new HumanAccountError("invalid_input");
      if (!set && (!current || current.revokedAt !== null)) throw new HumanAccountError("membership_revision_conflict");
      const grant = this.identity.getKnowledgeProjectGrant(principal.id, projectId);
      const permissions = set ? [...input.permissions].sort() : grant?.permissions ?? [];
      const role = set ? input.role : current?.role, revokedAt = set ? null : now;
      if (!role) throw new HumanAccountError("membership_revision_conflict");
      this.database.prepare(`INSERT INTO knowledge_project_grants(principal_id,project_id,permissions_json,revoked_at) VALUES(?,?,?,?)
        ON CONFLICT(principal_id,project_id) DO UPDATE SET permissions_json=excluded.permissions_json,revoked_at=excluded.revoked_at`)
        .run(principal.id, projectId, JSON.stringify(permissions), revokedAt);
      this.database.prepare(`INSERT INTO knowledge_role_bindings(principal_id,project_id,role,revision,updated_at,revoked_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(principal_id,project_id) DO UPDATE SET role=excluded.role,revision=excluded.revision,updated_at=excluded.updated_at,revoked_at=excluded.revoked_at`)
        .run(principal.id, projectId, role, input.expectedRevision + 1, now, revokedAt);
      this.audit("knowledge.human_membership_saved", actor, { principalId: principal.id, scope: input.scope, oldRole: current?.role ?? null,
        role, oldRevision: input.expectedRevision, revision: input.expectedRevision + 1, permissions, revokedAt });
      return this.membership(principal, projectId);
    }).immediate();
  }
  private human(id: string): Principal {
    const principal = this.identity.getPrincipal(id);
    if (principal?.kind !== "human") throw new HumanAccountError("principal_unavailable");
    return principal;
  }
  private membership(principal: Principal, projectId: string): HumanKnowledgeMembership {
    const binding = this.identity.getKnowledgeRoleBinding(principal.id, projectId);
    if (!binding) throw new HumanAccountError("invalid_input");
    const grant = this.identity.getKnowledgeProjectGrant(principal.id, projectId);
    const permissions = effectiveKnowledgePermissions({ id: principal.id, kind: "human", humanSession: false }, projectId,
      { ordinaryHuman: true, grant: principal.status === "active" ? grant : null, binding });
    return { principalId: principal.id, scope: { kind: "knowledge-project", id: projectId }, role: binding.role,
      revision: binding.revision, updatedAt: binding.updatedAt, revokedAt: binding.revokedAt,
      grant: grant && { permissions: grant.permissions, revokedAt: grant.revokedAt },
      effectivePermissions: permissions.filter((p): p is "knowledge:read" | "knowledge:write" => p === "knowledge:read" || p === "knowledge:write") };
  }
  private audit(event: string, actor: string, details: unknown) {
    this.database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES(?,?,?,?)")
      .run(event, actor, JSON.stringify(details), new Date().toISOString());
  }
}
