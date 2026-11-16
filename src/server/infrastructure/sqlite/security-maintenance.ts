import { z } from "zod";
import { ProviderAdminError } from "../../modules/authentication";
import { randomUUID } from "node:crypto";
import type { AppPaths } from "../../paths";
import { acquireControllerLock, ControllerAlreadyRunningError } from "../../controller-lock";
import { SecurityFence, SecurityFenceBackupError, SecurityFenceError } from "./security-fence";
import { OwnedSqliteDatabase } from "./owned-database";
import { configureDurability, assertDurability, validateDatabase } from "./database-validation";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { schemaTarget } from "./migration-registry";
import { applyMappingQuarantine, planMappingQuarantine } from "./mapping-structure-migration";
import { clearAccountGrants } from "./account-grants-migration";
import { cancelRemoteWork, interruptTestRuns, releaseReservations, revokeCredentials, revokeOldGrants } from "./authority-reset";
import { takeBoundBackup, type MaintenanceBackup } from "./backup-binding";
import type Database from "better-sqlite3";

const commandSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("inspect")}).strict(),
  z.object({action:z.literal("establish"),expect:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
  z.object({action:z.literal("resume"),expect:z.string().regex(/^[0-9a-f]{64}$/),mode:z.enum(["token","open","better-auth"])}).strict(),
]);
export type SecurityMaintenanceCommand =
  | { action: "inspect" }
  | { action: "establish"; expect: string }
  | { action: "resume"; expect: string; mode: "token" | "open" | "better-auth" };

/** Runs as the acts of the schema transaction, so the structure becomes current
 * only together with the quarantine. Exported for the differential test that
 * runs the same statements under foreign-key enforcement. */
export function quarantineAuthority(database: Database.Database, receipt: string, mode: "token" | "open" | "better-auth", target?: number): void {
  const version = schemaTarget(target);
  const now = new Date().toISOString();
  const old=JSON.parse((database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").get() as {value_json:string}).value_json);
  if(!Number.isSafeInteger(old.generation) || old.generation>=Number.MAX_SAFE_INTEGER
    || database.prepare("SELECT 1 FROM authentication_account_policies WHERE generation>=9007199254740991 OR policy_revision>=9007199254740991 LIMIT 1").get()) throw new SecurityFenceError("security_fence_recovery_required");
  // Provisional step 51: the mapping clock must be able to advance, checked like the
  // generation above before anything is written. The steps ran before the acts, so
  // the clock exists here both when this transaction created it and before.
  const mapping = version >= 51 ? planMappingQuarantine(database) : undefined;
  if (mapping === null) throw new SecurityFenceError("security_fence_recovery_required");
  // Quarantine ALL restored authentication material. Keep principals, IDs,
  // roles, membership rows, attribution, intent/run history, budgets and TOTP
  // steps. Regrant/reissue/recover are subsequent explicit protected acts.
  // Foreign keys are off here (see initializeSchema's acts): every row whose
  // parent a statement deletes is deleted explicitly, before that parent. All
  // sessions and passkeys go, so all their dependents go. The reset statements
  // shared with the upgrade's authority acts (authority-reset.ts) run in the
  // quarantine's own order around the statements only the quarantine runs.
  revokeCredentials(database, now);
  revokeOldGrants(database, now);
  database.exec(`
    UPDATE authentication_ba_account SET password=NULL,accessToken=NULL,refreshToken=NULL,idToken=NULL;
    DELETE FROM authentication_session_issuance;
    DELETE FROM authentication_session_evidence;
    DELETE FROM authentication_ba_session;
    DELETE FROM authentication_ba_verification;
    DELETE FROM authentication_passkey_staged;
    DELETE FROM authentication_passkey_trust;
    DELETE FROM authentication_ba_passkey;
    DELETE FROM authentication_ba_two_factor;
    UPDATE authentication_ba_user SET twoFactorEnabled=0;
    UPDATE authentication_account_policies SET generation=generation+1,policy_revision=policy_revision+1,totp_selected=0,passkey_selected=0,updated_at='${now}';
    UPDATE authentication_factor_contexts SET used=1;
    UPDATE authentication_factor_receipts SET state='failed' WHERE state='charged';
  `);
  releaseReservations(database, now);
  cancelRemoteWork(database, now);
  // Provisional step 50: a quarantined installation needs the data upgrade again,
  // whatever the marker said, and no applied plan stands for it any more. The
  // acts run after every schema step, so the marker exists here both when this
  // transaction created it and before.
  if (version >= 50) database.prepare("UPDATE upgrade_marker SET state='pending',changed_at=?,plan_hash=NULL WHERE singleton=1").run(now);
  // Provisional step 51: no restored project mapping stands. Every parent is cleared and
  // every registration and remote identity gets a mapping version from one advance of
  // the clock; projects (`knowledge_projects`), issued incarnations and the journal stay.
  if (mapping) applyMappingQuarantine(database, mapping);
  // Provisional step 52: no grant written after an upgrade stands either; the next
  // upgrade grants `admin` again when its rule holds.
  if (version >= 52) clearAccountGrants(database);
  // Mode is an explicit protected decision, never a restored selection or fallback.
  // All shared and legacy verifier material is removed; first-run issuance is fresh.
  database.prepare("UPDATE controller_settings SET value_json=?,updated_at=? WHERE key='authentication'")
    .run(JSON.stringify({mode,generation:old.generation+1,token:null}),now);
  // Its trimming deletes the requester rows of the runs it trims.
  interruptTestRuns(database);
  // The last act and this run's durable commit evidence (see the catch below).
  database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('authentication.security_quarantined','local-cli',?,?)")
    .run(JSON.stringify({receipt,mode}),now);
}

/** True only when this run's quarantine committed: its audit event carries the receipt. */
function quarantineCommitted(database: Database.Database, receipt: string): boolean {
  // details_json has no JSON constraint and the table is not STRICT: a historical
  // event may hold malformed text or a BLOB, and must not make this lookup throw
  // (the caller would then report a commit as absent). The receipt written above
  // is always JSON text, so only text values are parsed; the CASE tests the
  // storage class before json_valid/json_extract can see the value.
  return Boolean(database.prepare(`SELECT 1 FROM controller_audit_events WHERE event_type='authentication.security_quarantined'
    AND CASE WHEN typeof(details_json)<>'text' THEN NULL
      WHEN json_valid(details_json) THEN json_extract(details_json,'$.receipt') END=? LIMIT 1`).get(receipt));
}

/** Offline only. This function acquires BOTH singleton locks; no transport boolean grants trust.
 * It never contacts HTTP/MCP, loads provider code, starts listeners, or starts/stops processes.
 * `target` (default `SUPPORTED_SCHEMA_VERSION`) is both the recognition ceiling and the
 * schema target of establish and resume. It takes no backup; see
 * {@link establishSqliteSecurityFence} for establishment with one.
 */
export function maintainSqliteSecurityFence(paths: AppPaths, command: SecurityMaintenanceCommand, handoff: { preflight(database:string):void; acknowledge(database:string):void }, target?: number) {
  const run = maintenance(paths, command, handoff, target);
  const step = run.next();
  // Without a backup step the maintenance never yields.
  if (!step.done) { run.return(undefined as never); throw new Error("Security maintenance yielded without a backup step."); }
  return step.value;
}
export type SecurityMaintenanceResult = ReturnType<typeof maintainSqliteSecurityFence>;
const establishSchema=z.object({action:z.literal("establish"),expect:z.string().regex(/^[0-9a-f]{64}$/)}).strict();

/**
 * Offline. `auth fence establish` with a durable pre-establishment backup, for
 * the activation to compose (integration branch: no command or bootstrap path
 * calls it yet). Everything `maintainSqliteSecurityFence` does for establish
 * happens in the same order and through the same code: both locks and
 * ownership, the status, the `expect` comparison, `handoff.preflight`, the
 * trusted no-op (which takes no backup), `establishmentAllowed` and owner
 * continuity. Then `backup` runs on the owner's read-only connection and its
 * tree is accepted only as this run's bound copy of this source (see
 * `takeBoundBackup`); then the preflight must equal `expect` again; only then
 * are the pending witness published, the structure migrated and the receipts
 * published.
 *
 * A backup that fails, does not validate or is not this run's is refused as
 * {@link SecurityFenceBackupError} with the database and its WAL unchanged and
 * nothing pending; a moved preflight after it is
 * `security_fence_preflight_changed`. Either way establish can be run again.
 * As in every establish, ordinary ownership may already have created its lock
 * files, recovered an interrupted restore and narrowed file modes, and a
 * read-only open may have created an empty WAL and a shared-memory file; the
 * backup function's own output may remain. The result is the establishment's,
 * with the accepted backup's root (null for the trusted no-op).
 *
 * The command and the target are checked synchronously, before any lock or file.
 */
export function establishSqliteSecurityFence(paths: AppPaths, command: { action: "establish"; expect: string }, handoff: { preflight(database:string):void; acknowledge(database:string):void }, backup: MaintenanceBackup, target?: number): Promise<SecurityMaintenanceResult & { backup: string | null }> {
  const parsed=establishSchema.safeParse(command);
  if(!parsed.success || typeof backup !== "function")throw new ProviderAdminError("invalid_input");
  const version=schemaTarget(target);
  let root: string | null = null;
  const run = maintenance(paths, parsed.data, handoff, version, async (owner, path) => {
    root = await takeBoundBackup(owner, path, owner.inspection.version, version, backup);
  });
  return drive(run).then(result => ({ ...result, backup: root }));
}

/** Runs the maintenance to its end, awaiting the backup step under the locks it holds. */
async function drive<T>(run: Generator<Promise<void>, T, unknown>): Promise<T> {
  let step = run.next();
  while (!step.done) {
    let failed = false, failure: unknown;
    try { await step.value; } catch (error) { failed = true; failure = error; }
    // A failure re-enters the maintenance at its backup step, inside its error handling.
    step = failed ? run.throw(failure) : run.next();
  }
  return step.value;
}

/**
 * The one implementation of inspect, establish and resume. It yields only for
 * the backup step of an establishment, which only {@link establishSqliteSecurityFence}
 * supplies: the caller awaits it and resumes the maintenance, which still holds
 * both locks and the owned connection.
 */
function* maintenance(paths: AppPaths, command: SecurityMaintenanceCommand, handoff: { preflight(database:string):void; acknowledge(database:string):void }, target?: number,
  backup?: (owner: OwnedSqliteDatabase, database: string) => Promise<void>) {
  // The return type is inferred, so the synchronous entry point's stays what it was.
  const parsed=commandSchema.safeParse(command);
  if(!parsed.success)throw new ProviderAdminError("invalid_input");
  command=parsed.data;
  const version=schemaTarget(target);
  let lock;
  try { lock=acquireControllerLock(paths.controllerLockPath); } catch(error) {
    if(error instanceof ControllerAlreadyRunningError)throw new SecurityFenceError("security_fence_owner_running");
    throw error;
  }
  let owner: OwnedSqliteDatabase | undefined;
  let committed = false;
  let receipt: string | undefined;
  try {
    owner = new OwnedSqliteDatabase(paths.databasePath, false, version);
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
    if (backup && command.action === "establish") {
      // The pre-establishment backup, before anything is written. A failure
      // leaves the database, its WAL and the absent witness as they were.
      try { yield backup(owner, databasePath); } catch { throw new SecurityFenceBackupError(); }
      // The backup read through the owned read-only connection, which writes
      // neither the database nor its WAL (probed for the Backup API), so the
      // preflight must still equal the operator's exactly. That connection was
      // open at the first preflight too, so an empty WAL a read-only open
      // creates already existed then and cannot differ here.
      const after = SecurityFence.preflight(databasePath, owner.database, owner.inspection.version);
      if (after.preflight !== status.preflight || after.trusted || !after.establishmentAllowed) throw new SecurityFenceError("security_fence_preflight_changed");
    }
    const runReceipt = receipt = randomUUID();
    SecurityFence.beginMaintenance(databasePath, runReceipt, command.action === "resume" ? new Date().toISOString() : null,ownerId);
    const database = owner.enableWrites();
    configureDurability(database);
    SecurityFence.registerMaintenanceObserver(databasePath,database,runReceipt);
    // Resume commits the schema steps and the quarantine in ONE transaction: no
    // committed state has a current structure with the old authority intact.
    const mode = command.action === "resume" ? command.mode : undefined;
    initializeSchema(database, owner.inspection.fresh, current => inspectSchema(current, version),
      mode ? { target: version, acts: current => quarantineAuthority(current, runReceipt, mode, version) } : { target: version });
    if (mode) committed = true;
    assertDurability(database);
    validateDatabase(database,version);
    SecurityFence.maintenanceReceipt(databasePath,database,runReceipt,"pending");
    // Handoff acknowledgement is AFTER quarantine and BEFORE the final receipt.
    // A failure leaves a pending witness and cannot resume an old identity.
    if (command.action === "resume") handoff.acknowledge(databasePath);
    SecurityFence.maintenanceReceipt(databasePath,database,runReceipt,"confirmed");
    owner.completeInitialization();
    return {...SecurityFence.preflight(databasePath,database,version),changed:true,receipt:runReceipt,quarantined:command.action === "resume"};
  } catch (error) {
    // Initialization owns one outer transaction, which for resume also holds the
    // quarantine. Prove a committed change from durable facts written in it, even
    // if its post-commit/finally work threw: a raised schema version marker, or
    // this run's quarantine audit event (a resume at the current version changes
    // no version). Rolled-back statements and the external pending witness alone
    // do not prove a committed database change. Use only the still-owned connection.
    if (!committed && owner?.database.open && !owner.database.inTransaction) {
      try {
        const row = owner.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number };
        committed = row.version > owner.inspection.version;
      } catch { /* Preserve the original failure when commit evidence cannot be read. */ }
      if (!committed && receipt && command.action === "resume") {
        try { committed = quarantineCommitted(owner.database, receipt); } catch { /* As above. */ }
      }
    }
    if (error instanceof SecurityFenceError) throw committed && !error.committed ? new SecurityFenceError(error.code as ConstructorParameters<typeof SecurityFenceError>[0],true) : error;
    if(error instanceof ControllerAlreadyRunningError)throw new SecurityFenceError("security_fence_owner_running");
    throw new SecurityFenceError("security_fence_pending", committed ? true : undefined);
  } finally {
    // Do not release controller ownership if closing SQLite failed.
    if (owner) owner.close();
    lock.release();
  }
}
