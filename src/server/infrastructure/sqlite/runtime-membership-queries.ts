import type Database from "better-sqlite3";
import { HumanAccountError, type RuntimeMembershipStore } from "@/server/modules/identity";
import {
  runtimeMembershipPageSchema, runtimeMembershipSetSchema, runtimeMembershipRevokeSchema,
  type RuntimeMembership, type RuntimeMembershipPage, type RuntimeMembershipSet, type RuntimeMembershipRevoke,
} from "@/shared/contracts/runtime-memberships";

type Row = { principal_id: string; project_id: string; scope_kind: "runtime-project"; role: "reader";
  permissions_json: string; revision: number; updated_at: string; revoked_at: string | null };
function membership(row: Row): RuntimeMembership {
  let permissions: Array<"projects:read"> = [];
  try {
    const value: unknown = JSON.parse(row.permissions_json);
    if (Array.isArray(value) && value.length === 1 && value[0] === "projects:read") permissions = ["projects:read"];
  } catch { /* Malformed current authority never grants access. */ }
  return { principalId: row.principal_id, scope: { kind: row.scope_kind, id: row.project_id }, role: row.role,
    permissions, revision: row.revision, updatedAt: row.updated_at, revokedAt: row.revoked_at };
}

/** Uses the sole controller connection. Validation also applies to direct store calls. */
export class RuntimeMembershipQueries implements RuntimeMembershipStore {
  constructor(private readonly database: Database.Database) {}
  getRuntimeMembership(principalId: string, projectId: string): RuntimeMembership | null {
    const row = this.database.prepare("SELECT * FROM runtime_human_memberships WHERE principal_id=? AND project_id=?").get(principalId, projectId) as Row | undefined;
    return row ? membership(row) : null;
  }
  listRuntimeMemberships(value: RuntimeMembershipPage) {
    const parsed = runtimeMembershipPageSchema.safeParse(value);
    if (!parsed.success) throw new HumanAccountError("invalid_input");
    const page = parsed.data;
    this.human(page.principalId, false);
    const rows = this.database.prepare("SELECT * FROM runtime_human_memberships WHERE principal_id=? AND project_id>? ORDER BY project_id LIMIT ?")
      .all(page.principalId, page.after ?? "", page.limit + 1) as Row[];
    return { items: rows.slice(0, page.limit).map(membership), nextAfter: rows.length > page.limit ? rows[page.limit - 1].project_id : null };
  }
  saveRuntimeMembership(value: RuntimeMembershipSet | RuntimeMembershipRevoke, actor: string, now: string): RuntimeMembership {
    const setValue = runtimeMembershipSetSchema.safeParse(value);
    const parsed = setValue.success ? setValue : runtimeMembershipRevokeSchema.safeParse(value);
    if (!parsed.success || !Number.isFinite(Date.parse(now))) throw new HumanAccountError("invalid_input");
    const input = parsed.data;
    return this.database.transaction(() => {
      this.human(input.principalId, true);
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id=?").get(input.scope.id)) throw new HumanAccountError("invalid_input");
      const current = this.getRuntimeMembership(input.principalId, input.scope.id), set = "role" in input;
      if ((current?.revision ?? 0) !== input.expectedRevision || (!set && (!current || current.revokedAt !== null))) {
        throw new HumanAccountError("membership_revision_conflict");
      }
      const row: RuntimeMembership = { principalId: input.principalId, scope: input.scope,
        role: "reader", permissions: ["projects:read"], revision: input.expectedRevision + 1, updatedAt: now, revokedAt: set ? null : now };
      this.database.prepare(`INSERT INTO runtime_human_memberships(principal_id,project_id,scope_kind,role,permissions_json,revision,updated_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,project_id) DO UPDATE SET
        role=excluded.role,permissions_json=excluded.permissions_json,revision=excluded.revision,updated_at=excluded.updated_at,revoked_at=excluded.revoked_at`)
        .run(row.principalId, row.scope.id, row.scope.kind, row.role, JSON.stringify(row.permissions), row.revision, now, row.revokedAt);
      this.database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES(?,?,?,?)")
        .run("runtime.human_membership_saved", actor, JSON.stringify({ ...row, oldRevision: input.expectedRevision }), now);
      return row;
    }).immediate();
  }
  private human(id: string, active: boolean): void {
    const principal = this.database.prepare("SELECT kind,status FROM remote_principals WHERE id=?").get(id) as { kind: string; status: string } | undefined;
    if (!principal || !["owner", "human"].includes(principal.kind) || (active && principal.status !== "active")) throw new HumanAccountError("principal_unavailable");
  }
}
