import { z } from "zod";
import { ProviderAdminError } from "../../modules/authentication";
import { TestRunQueries } from "./test-run-queries";
import { randomUUID } from "node:crypto";
import type { AppPaths } from "../../paths";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../../controller-lock";
import { SecurityFence, SecurityFenceError } from "./security-fence";
import { OwnedSqliteDatabase } from "./owned-database";
import { configureDurability, assertDurability, validateDatabase } from "./database-validation";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";

const commandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("inspect")}).strict(),
  z.object({action:z.literal("establish"),expect:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
  z.object({action:z.literal("resume"),expect:z.string().regex(/^[0-9a-f]{64}$/),mode:z.enum(["token","open","better-auth"])}).strict(),
]);
export type SecurityMaintenanceCommand =
  | { action: "inspect" }
  | { action: "establish"; expect: string }
  | { action: "resume"; expect: string; mode: "token" | "open" | "better-auth" };

/** Offline only. This function acquires BOTH singleton locks; no transport boolean grants trust.
 * It never contacts HTTP/MCP, loads provider code, starts listeners, or starts/stops processes.
 */
export function maintainSqliteSecurityFence(paths: AppPaths, command: SecurityMaintenanceCommand, handoff: { preflight(database:string):void; acknowledge(database:string):void }) {
  const parsed=commandSchema.safeParse(command);
  if(!parsed.success)throw new ProviderAdminError("invalid_input");
  command=parsed.data;
  let lock;
  try { lock=acquireControllerLock(paths.controllerLockPath); } catch(error) {
    if(error instanceof ControllerAlreadyRunningError)throw new SecurityFenceError("security_fence_owner_running");
    throw error;
  }
  let owner: OwnedSqliteDatabase | undefined;
  let committed = false;
  try {
    owner = new OwnedSqliteDatabase(paths.databasePath);
    const databasePath = owner.canonicalPath;
    const status = SecurityFence.preflight(databasePath, owner.database, owner.inspection.version);
    if (command.action === "inspect") return status;
    if (command.expect !== status.preflight) throw new SecurityFenceError("security_fence_preflight_changed");
    // No incomplete move or operation may be acknowledged by this path. An executing
    // handoff is allowed only after the durable restore journal verifies its move.
    handoff.preflight(databasePath);
    if (status.trusted) return {...status, changed:false};
    if (command.action === "establish" && !status.establishmentAllowed) throw new SecurityFenceError("security_fence_recovery_required");
    const ownerId=SecurityFence.assertOwnerContinuity(databasePath,owner.database);
    const receipt = randomUUID();
    SecurityFence.beginMaintenance(databasePath, receipt, command.action === "resume" ? new Date().toISOString() : null,ownerId);
    const database = owner.enableWrites();
    configureDurability(database);
    SecurityFence.registerMaintenanceObserver(databasePath,database,receipt);
    initializeSchema(database, owner.inspection.fresh, inspectSchema);
    const now = new Date().toISOString();
    if (command.action === "resume") {
      database.transaction(() => {
        const old=JSON.parse((database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").get() as {value_json:string}).value_json);
        if(!Number.isSafeInteger(old.generation) || old.generation>=Number.MAX_SAFE_INTEGER
          || database.prepare("SELECT 1 FROM authentication_account_policies WHERE generation>=9007199254740991 OR policy_revision>=9007199254740991 LIMIT 1").get()) throw new SecurityFenceError("security_fence_recovery_required");
        // Quarantine ALL restored authentication material. Keep principals, IDs,
        // roles, membership rows, attribution, intent/run history, budgets and TOTP
        // steps. Regrant/reissue/recover are subsequent explicit protected acts.
        database.exec(`
          UPDATE principal_credentials SET status='revoked', revoked_at=coalesce(revoked_at,'${now}');
          UPDATE knowledge_project_grants SET revoked_at=coalesce(revoked_at,'${now}');
          UPDATE knowledge_role_bindings SET revoked_at=coalesce(revoked_at,'${now}'),revision=revision+1,updated_at='${now}';
          UPDATE runtime_delegations SET revoked_at=coalesce(revoked_at,'${now}'),revision=revision+1,updated_at='${now}';
          UPDATE runtime_human_memberships SET revoked_at=coalesce(revoked_at,'${now}'),revision=revision+1,updated_at='${now}';
          UPDATE remote_principal_project_grants SET revoked_at=coalesce(revoked_at,'${now}');
          UPDATE remote_worker_project_grants SET revoked_at=coalesce(revoked_at,'${now}');
          UPDATE authentication_ba_account SET password=NULL,accessToken=NULL,refreshToken=NULL,idToken=NULL;
          DELETE FROM authentication_ba_session;
          DELETE FROM authentication_ba_verification;
          DELETE FROM authentication_ba_passkey;
          DELETE FROM authentication_ba_two_factor;
          UPDATE authentication_ba_user SET twoFactorEnabled=0;
          UPDATE authentication_account_policies SET generation=generation+1,policy_revision=policy_revision+1,totp_selected=0,passkey_selected=0,updated_at='${now}';
          UPDATE authentication_factor_contexts SET used=1;
          UPDATE authentication_factor_receipts SET state='failed' WHERE state='charged';
          UPDATE reservations SET released_at=coalesce(released_at,'${now}');
          UPDATE remote_verification_requests SET phase='cancelled',updated_at='${now}' WHERE phase IN ('pending','assigned');
          UPDATE remote_verification_attempts SET phase='cancel_requested',version=version+1,last_reported_at='${now}' WHERE phase IN ('assigned','preparing','running');
        `);
        // Mode is an explicit protected decision, never a restored selection or fallback.
        // All shared and legacy verifier material is removed; first-run issuance is fresh.
        database.prepare("UPDATE controller_settings SET value_json=?,updated_at=? WHERE key='authentication'")
          .run(JSON.stringify({mode:command.mode,generation:old.generation+1,token:null}),now);
        new TestRunQueries(database).markInterruptedTestRuns();
        database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('authentication.security_quarantined','local-cli',?,?)")
          .run(JSON.stringify({receipt,mode:command.mode}),now);
      }).immediate();
      committed = true;
    }
    assertDurability(database);
    validateDatabase(database,49);
    SecurityFence.maintenanceReceipt(databasePath,database,receipt,"pending");
    // Handoff acknowledgement is AFTER quarantine and BEFORE the final receipt.
    // A failure leaves a pending witness and cannot resume an old identity.
    if (command.action === "resume") handoff.acknowledge(databasePath);
    SecurityFence.maintenanceReceipt(databasePath,database,receipt,"confirmed");
    owner.completeInitialization();
    return {...SecurityFence.preflight(databasePath,database,49),changed:true,receipt,quarantined:command.action === "resume"};
  } catch (error) {
    if (error instanceof SecurityFenceError) throw committed && !error.committed ? new SecurityFenceError(error.code as ConstructorParameters<typeof SecurityFenceError>[0],true) : error;
    if(error instanceof ControllerAlreadyRunningError)throw new SecurityFenceError("security_fence_owner_running");
    throw new SecurityFenceError("security_fence_pending", committed ? true : undefined);
  } finally {
    // Do not release controller ownership if closing SQLite failed.
    if (owner) owner.close();
    lock.release();
  }
}
