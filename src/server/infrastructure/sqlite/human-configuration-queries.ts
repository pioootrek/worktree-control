import { humanConfigurationMutationSchema } from "@/shared/contracts/human-configuration";
import type Database from "better-sqlite3";
import { z } from "zod";
import { humanRuntimePermissionsSchema } from "@/shared/contracts/runtime-memberships";
import type { ScopedConfigurationReceipt } from "@/shared/contracts/scoped-configuration";
import { humanConfigurationFingerprint, type HumanConfigurationIntent } from "@/server/modules/environments";
import { RuntimeAccessDenied, ScopedRuntimeError, sameHumanRuntimeAuthority, HUMAN_RUNTIME_LIMITS } from "@/server/modules/runtime";
import { HumanRuntimeQueries } from "./human-runtime-queries";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime();
const contextSchema = z.strictObject({
  request: humanConfigurationMutationSchema,
  authority: z.strictObject({ principalId: z.string().min(1).max(160), sessionKey: digest, evidenceKey: digest,
    generation: z.number().int().nonnegative(), membershipRevision: z.number().int().positive(), deadline: instant,
    permissions: humanRuntimePermissionsSchema }),
  projectId: z.string().min(1), key: z.string().min(1).max(120), fingerprint: digest,
  reservationId: z.string().uuid().nullable(), worktreePath: z.string().min(1).max(4096).nullable(),
});
const receiptBase = { schemaVersion: z.literal(1), operationId: z.string().uuid(), projectId: z.string().uuid(),
  configurationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), outcome: z.enum(["completed", "noop"]),
  replayed: z.literal(false), observedAt: instant };
const receiptSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...receiptBase, operation: z.literal("select_environment_profile"), selectedProfile: z.string().min(1).max(40) }),
  z.strictObject({ ...receiptBase, operation: z.literal("set_test_preset_timeout"), presetId: z.string().min(1).max(160), timeoutMs: z.number().int().min(1).max(86400000).nullable() }),
]);
type IntentRow = { session_key: string; idempotency_key: string; principal_id: string; project_id: string;
  membership_revision: number; fingerprint: string; reservation_id: string | null; state: "pending" | "complete";
  configuration_bound: number; result_json: string | null; retain_until: string; configuration_context_json: string | null };
/** Typed configuration extension of the existing ledger/budget, never a second connection. */
export class HumanConfigurationQueries {
  constructor(private readonly db: Database.Database, private readonly leases: HumanRuntimeQueries) {}
  begin(intent: HumanConfigurationIntent): ScopedConfigurationReceipt | null {
    return this.db.transaction(() => {
      this.authorize(intent);
      const prior = this.leases.begin(intent.authority, intent.projectId, intent.key, intent.fingerprint);
      if (prior) {
        const row = this.read(intent);
        if (row.state !== "complete") throw new ScopedRuntimeError("outcome_unknown", "The previous configuration outcome is unknown.");
        return JSON.parse(row.result_json!) as ScopedConfigurationReceipt;
      }
      const json = JSON.stringify(contextSchema.parse(intent));
      if (Buffer.byteLength(json) > HUMAN_RUNTIME_LIMITS.receiptBytes) throw new ScopedRuntimeError("capacity", "Configuration context exceeds the limit.");
      this.db.prepare(`UPDATE human_runtime_intents SET configuration_bound=1,configuration_context_json=?,reservation_id=? WHERE session_key=? AND idempotency_key=?`)
        .run(json, intent.reservationId, intent.authority.sessionKey, intent.key);
      return null;
    }).immediate();
  }
  read(intent: HumanConfigurationIntent): IntentRow {
    const row = this.db.prepare("SELECT * FROM human_runtime_intents WHERE session_key=? AND idempotency_key=?")
      .get(intent.authority.sessionKey, intent.key) as IntentRow | undefined;
    if (!row) throw new RuntimeAccessDenied();
    const context = this.validateRow(row);
    if (!sameHumanRuntimeAuthority(context.authority, intent.authority)) throw new RuntimeAccessDenied();
    if (JSON.stringify(context) !== JSON.stringify(contextSchema.parse(intent))) throw new ScopedRuntimeError("idempotency_conflict", "The idempotency key has a different configuration intent.");
    return row;
  }
  /** Current principal/membership/lease and the original absence contract, inside the effect transaction. */
  authorize(intent: HumanConfigurationIntent): void {
    this.validateContext(contextSchema.parse(intent));
    const action = intent.request.operation === "select_environment_profile" ? "profiles:select" : "config:write";
    if (!intent.authority.permissions.includes(action)) throw new RuntimeAccessDenied();
    const a = intent.authority, now = new Date().toISOString();
    const m = this.db.prepare(`SELECT m.* FROM runtime_human_memberships m JOIN remote_principals p ON p.id=m.principal_id
      WHERE m.principal_id=? AND m.project_id=? AND p.status='active' AND p.kind IN ('owner','human') AND m.revoked_at IS NULL`)
      .get(a.principalId, intent.projectId) as { revision: number; permissions_json: string } | undefined;
    if (a.deadline <= now || !m || m.revision !== a.membershipRevision || m.permissions_json !== JSON.stringify(a.permissions)) throw new RuntimeAccessDenied();
    const active = this.db.prepare("SELECT id,worktree_path FROM reservations WHERE project_id=? AND released_at IS NULL")
      .get(intent.projectId) as { id: string; worktree_path: string } | undefined;
    if (!intent.reservationId) { if (active) throw stale(); return; }
    const lease = this.leases.lease(intent.reservationId);
    if (!active || active.id !== intent.reservationId || active.worktree_path !== intent.worktreePath || !lease || lease.released
      || !sameHumanRuntimeAuthority(lease.authority, a) || !lease.reservation.expiresAt || lease.reservation.expiresAt <= now
      || lease.reservation.projectId !== intent.projectId || lease.reservation.worktreePath !== intent.worktreePath) throw stale();
  }
  finish(intent: HumanConfigurationIntent, receipt: ScopedConfigurationReceipt): void {
    if (this.read(intent).state !== "pending") throw new RuntimeAccessDenied();
    const json = JSON.stringify(receiptSchema.parse(receipt));
    if (Buffer.byteLength(json) > HUMAN_RUNTIME_LIMITS.receiptBytes) throw new ScopedRuntimeError("capacity", "Configuration receipt exceeds the limit.");
    const result = this.db.prepare(`UPDATE human_runtime_intents SET state='complete',result_json=? WHERE session_key=? AND idempotency_key=? AND state='pending'`)
      .run(json, intent.authority.sessionKey, intent.key);
    if (result.changes !== 1) throw new RuntimeAccessDenied();
  }
  validateRow(row: IntentRow): HumanConfigurationIntent {
    const context = contextSchema.parse(JSON.parse(row.configuration_context_json ?? "null"));
    this.validateContext(context);
    if (row.configuration_bound !== 1 || context.authority.sessionKey !== row.session_key || context.key !== row.idempotency_key || context.authority.principalId !== row.principal_id
      || context.projectId !== row.project_id || context.authority.membershipRevision !== row.membership_revision || context.fingerprint !== row.fingerprint
      || context.reservationId !== row.reservation_id || context.authority.deadline !== row.retain_until) throw new Error("Invalid human configuration context");
    if (row.state === "complete") {
      const r = receiptSchema.parse(JSON.parse(row.result_json!)), request = context.request;
      if (r.projectId !== context.projectId || r.operation !== request.operation || Buffer.byteLength(row.result_json!) > HUMAN_RUNTIME_LIMITS.receiptBytes
        || r.configurationRevision !== request.expectedRevision + (r.outcome === "completed" ? 1 : 0)
        || (r.operation === "select_environment_profile" && request.operation === r.operation && r.selectedProfile !== request.name)
        || (r.operation === "set_test_preset_timeout" && request.operation === r.operation && (r.presetId !== request.presetId || r.timeoutMs !== request.timeoutMs))) throw new Error("Invalid human configuration receipt");
    }
    return context;
  }
  private validateContext(context: HumanConfigurationIntent): void {
    const r = context.request;
    if (r.projectId !== context.projectId || r.idempotencyKey !== context.key || (r.reservationId ?? null) !== context.reservationId
      || (r.operation === "set_test_preset_timeout" && r.worktreePath !== context.worktreePath)
      || context.fingerprint !== humanConfigurationFingerprint(context)) throw new RuntimeAccessDenied();
  }
  validateAll(): void {
    for (const row of this.db.prepare("SELECT * FROM human_runtime_intents WHERE configuration_bound=1 OR configuration_context_json IS NOT NULL").iterate() as Iterable<IntentRow>) this.validateRow(row);
  }
}
function stale() { return new ScopedRuntimeError("claim_stale", "The original configuration reservation is unavailable."); }
