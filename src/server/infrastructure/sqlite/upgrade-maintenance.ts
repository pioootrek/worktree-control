import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { AppPaths } from "../../paths";
import { acquireControllerLock, ControllerAlreadyRunningError, type ControllerLock } from "../../controller-lock";
import { SecurityFence, securityFenceBinding } from "./security-fence";
import { OwnedSqliteDatabase, ReopenedDatabaseChangedError, UnfinishedRestoreError } from "./owned-database";
import { assertDurability, configureDurability, validateDatabase } from "./database-validation";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { BACKUP_LIMITS, hashFile, parseManifest, readBoundedJson, validateBackup } from "./backup-validation";
import {
  canonicalJson, describeUpgradeActs, executeUpgradeActs, proposeUpgradeActs, readUpgradePlan, removeUpgradePlan, structuralSteps,
  UPGRADE_PLAN_FORMAT, UPGRADE_PLAN_KIND, UpgradeError, upgradePlanPath, upgradeTarget, writeUpgradePlan,
  type UpgradeNextStep, type UpgradePlan, type UpgradeState,
} from "./upgrade-plan";

/**
 * The explicit offline upgrade (integration branch, provisional, not registered
 * or composed anywhere): `inspect` writes the plan the operator reads, `apply
 * --expect <plan hash>` executes exactly that plan. The protocol, its states and
 * its failure table are in `docs/architecture.md`. Every entry point refuses as
 * unsupported before any lock or file unless the schema target is at least 50,
 * which only the provisional switch allows.
 *
 * Both commands take ownership inspection-only: an unfinished restore is
 * refused, never recovered, and no file mode is normalised. `apply` switches to
 * writing only after its pending witness, through
 * `OwnedSqliteDatabase.enableVerifiedWrites`.
 */

export interface UpgradeStatus {
  state: UpgradeState;
  nextStep: UpgradeNextStep;
  /** The database's schema version and the target of this run. */
  schemaVersion: number;
  target: number;
  /** `SecurityFence.preflight` over the database, its WAL and the witness. */
  preflight: string;
  marker: "absent" | "pending" | "complete";
  /** The hash of the plan the `complete` marker records; null on a fresh installation. */
  appliedPlan: string | null;
}
export interface UpgradeInspection extends UpgradeStatus {
  /** Present only in `upgrade_needed`: the plan written, its hash and the operator's lines for its acts. */
  plan?: UpgradePlan;
  planHash?: string;
  acts?: string[];
}
/**
 * What the injected backup may use: a read-only Backup API copy of the owned
 * connection. `backup` takes exactly one snapshot; a second call is refused.
 */
export interface UpgradeBackupSource { backup(destination: string, options?: { progress: () => number }): Promise<void>; schemaVersion(): number }
/**
 * Writes the pre-upgrade backup (the composition passes `createControllerBackup`
 * with its destination) and returns its root and manifest. The upgrade accepts
 * the tree only as a copy of this source made in this run (see `writeBackup`)
 * and validates it itself at the target ceiling before changing anything.
 */
export type UpgradeBackup = (source: UpgradeBackupSource, context: { database: string; schemaVersion: number }) => Promise<{ root: string; manifest: unknown }>;
export interface UpgradeApplyResult {
  state: "current";
  /** True when the database already recorded this plan: nothing changed in this run. */
  alreadyApplied: boolean;
  planHash: string;
  /** This run's upgrade receipt; null when already applied. */
  receipt: string | null;
  /** The validated pre-upgrade backup; null when already applied. */
  backup: string | null;
  /** Whether no plan file remains; false only when removing the executed plan failed (or, when already applied, a plan file is left). */
  planRemoved: boolean;
  schemaVersion: number;
}

const NEXT: Readonly<Record<UpgradeState, UpgradeNextStep>> = { current: "none", upgrade_needed: "upgrade apply", pre_fence: "auth fence establish", fenced: "auth fence resume" };
const applyCommandSchema = z.object({ expect: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** The four states, from the fence's own verdict and the marker (read-only). */
function recognize(path: string, database: Database.Database, schemaVersion: number, target: number): UpgradeStatus {
  const fence = SecurityFence.preflight(path, database, schemaVersion);
  const row = schemaVersion >= 50 ? database.prepare("SELECT state,plan_hash FROM upgrade_marker WHERE singleton=1").get() as { state: "pending" | "complete"; plan_hash: string | null } : undefined;
  const marker = row?.state ?? "absent", appliedPlan = row?.state === "complete" ? row.plan_hash : null;
  // A confirmed witness with an earlier recovery receipt is trusted like any
  // other: `SecurityFence.preflight` decides trust, and nothing here refines it.
  const state: UpgradeState = fence.trusted ? (marker === "complete" ? "current" : "upgrade_needed") : fence.establishmentAllowed ? "pre_fence" : "fenced";
  return { state, nextStep: NEXT[state], schemaVersion, target, preflight: fence.preflight, marker, appliedPlan };
}
function checkpoint(database: Database.Database): { installation: string; epoch: string } {
  return database.prepare("SELECT installation,epoch FROM security_checkpoint WHERE singleton=1").get() as { installation: string; epoch: string };
}
/**
 * Both singleton locks, as the fence maintenance takes them, but inspection-only
 * on the database: nothing is recovered or normalised. An unfinished restore is
 * refused as `fenced`; `auth fence inspect` completes it (its ordinary ownership
 * recovers the restore) and reports the preflight for the resume that follows.
 * The caller releases.
 */
function ownership(paths: AppPaths, target: number): { lock: ControllerLock; owner: OwnedSqliteDatabase } {
  let lock: ControllerLock;
  try { lock = acquireControllerLock(paths.controllerLockPath); } catch (error) {
    if (error instanceof ControllerAlreadyRunningError) throw new UpgradeError("upgrade_owner_running", "stop the controller");
    throw error;
  }
  try { return { lock, owner: new OwnedSqliteDatabase(paths.databasePath, false, target, { inspectOnly: true }) }; } catch (error) {
    lock.release();
    if (error instanceof ControllerAlreadyRunningError) throw new UpgradeError("upgrade_owner_running", "stop the controller");
    if (error instanceof UnfinishedRestoreError) throw new UpgradeError("upgrade_restore_unfinished", "auth fence inspect", false, "fenced");
    throw error;
  }
}
function release(lock: ControllerLock, owner: OwnedSqliteDatabase): void {
  // Do not release controller ownership if closing SQLite failed.
  owner.close();
  lock.release();
}
/**
 * The bytes of the database and its WAL. A missing and an empty WAL are the same
 * state: SQLite's read-only open creates an empty WAL when none exists. Opening
 * and reading through a writable connection changes neither file (only its
 * close checkpoints), so the value is comparable across the reopen.
 */
function sourceImage(path: string): string {
  const wal = `${path}-wal`;
  return JSON.stringify([hashFile(path, BACKUP_LIMITS.fileBytes), existsSync(wal) && lstatSync(wal).size > 0 ? hashFile(wal, BACKUP_LIMITS.fileBytes) : "empty"]);
}

/**
 * Offline. Reads the database and the witness, writes neither. Recognises the
 * state; only in `upgrade_needed` it writes the plan (replacing any earlier
 * one) and returns it with its hash. In every other state it writes nothing and
 * reports the operator's next step. SQLite's read-only open may still create an
 * empty WAL and its shared-memory file beside a database that has none.
 */
export function inspectSqliteUpgrade(paths: AppPaths, target?: number): UpgradeInspection {
  const version = upgradeTarget(target);
  const { lock, owner } = ownership(paths, version);
  try {
    const path = owner.canonicalPath, source = owner.inspection.version;
    const status = recognize(path, owner.database, source, version);
    if (status.state !== "upgrade_needed") return status;
    const plan: UpgradePlan = {
      kind: UPGRADE_PLAN_KIND, format: UPGRADE_PLAN_FORMAT, binding: securityFenceBinding(path), installation: checkpoint(owner.database).installation,
      base: status.preflight, source, target: version, steps: structuralSteps(source, version),
      acts: proposeUpgradeActs(owner.database, { source, target: version }),
    };
    const planHash = writeUpgradePlan(path, plan);
    return { ...status, plan, planHash, acts: describeUpgradeActs(plan) };
  } finally { release(lock, owner); }
}

/** The schema transaction's acts: the plan's data acts, then the marker, then this run's commit evidence. */
function upgradeActs(database: Database.Database, plan: UpgradePlan, receipt: string, planHash: string): void {
  executeUpgradeActs(database, plan);
  const now = new Date().toISOString();
  if (database.prepare("UPDATE upgrade_marker SET state='complete',changed_at=?,plan_hash=? WHERE singleton=1").run(now, planHash).changes !== 1) throw new Error("Upgrade marker update failed.");
  // The last act and this run's durable commit evidence (see upgradeCommitted).
  database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('authentication.upgrade_applied','local-cli',?,?)")
    .run(JSON.stringify({ receipt, plan: planHash, source: plan.source, target: plan.target }), now);
}
/** True only when this run's upgrade committed: its audit event carries the receipt.
 * Only text values are parsed, as in the quarantine's lookup. */
function upgradeCommitted(database: Database.Database, receipt: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM controller_audit_events WHERE event_type='authentication.upgrade_applied'
    AND CASE WHEN typeof(details_json)<>'text' THEN NULL
      WHEN json_valid(details_json) THEN json_extract(details_json,'$.receipt') END=? LIMIT 1`).get(receipt));
}

/**
 * The pre-upgrade backup, bound to this source and this run. The callback gets a
 * Backup API source that takes exactly one snapshot and records the device and
 * inode of the file the snapshot was written to once the copy completed.
 * `createControllerBackup` switches that file's journal mode in place and
 * renames its staging directory to the destination, so the file keeps its
 * identity but not its path or bytes. The returned tree is accepted only if the
 * snapshot completed before the callback returned; its database file is that
 * file (same device and inode); its manifest is its own and valid; the tree
 * validates; and the copy holds the live source's schema version and checkpoint
 * (installation and epoch), so no authority write separates the two.
 */
async function writeBackup(owner: OwnedSqliteDatabase, path: string, source: number, target: number, backup: UpgradeBackup): Promise<string> {
  const taken: { calls: number; settled: boolean; snapshot?: { device: number; inode: number }; running?: Promise<void> } = { calls: 0, settled: false };
  const api: UpgradeBackupSource = {
    backup: (destination, options) => {
      if (++taken.calls > 1) return Promise.reject(new Error("The upgrade takes exactly one snapshot."));
      const running = (async () => {
        if (typeof destination !== "string") throw new Error("Invalid backup destination.");
        await owner.backup(destination, options);
        const stat = lstatSync(destination);
        if (!stat.isFile()) throw new Error("The snapshot is not a regular file.");
        taken.snapshot = { device: stat.dev, inode: stat.ino };
      })().finally(() => { taken.settled = true; });
      // Also handled here, so a rejection the callback ignores is never unhandled.
      running.catch(() => undefined);
      taken.running = running;
      return running;
    },
    schemaVersion: () => source,
  };
  let created: Awaited<ReturnType<UpgradeBackup>>, unfinished: boolean;
  try {
    created = await backup(api, { database: path, schemaVersion: source });
    unfinished = !taken.settled;
  } finally {
    // Never leave a Backup API copy running on the connection the upgrade closes.
    await taken.running?.catch(() => undefined);
  }
  const snapshot = taken.snapshot;
  if (taken.calls !== 1 || unfinished || !snapshot) throw new Error("The backup is not this run's single completed snapshot.");
  if (!created || typeof created.root !== "string") throw new Error("Backup returned no tree.");
  const manifest = parseManifest(created.manifest, target);
  if (manifest.database.schemaVersion !== source) throw new Error("Backup schema version differs from the database.");
  // The tree's own manifest is the one returned, and the tree matches it.
  const stored = parseManifest(readBoundedJson(join(created.root, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), target);
  if (JSON.stringify(stored) !== JSON.stringify(manifest)) throw new Error("Backup manifest differs from the returned one.");
  const file = join(created.root, "state.sqlite3"), stat = lstatSync(file);
  if (!stat.isFile() || stat.dev !== snapshot.device || stat.ino !== snapshot.inode) throw new Error("The backup's database is not this run's snapshot.");
  validateBackup(created.root, manifest, true, target);
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const point = checkpoint(copy), live = checkpoint(owner.database);
    if (inspectSchema(copy, target).version !== source || point.installation !== live.installation || point.epoch !== live.epoch) throw new Error("The snapshot is not of this source's current state.");
  } finally { copy.close(); }
  return created.root;
}

/**
 * After a failed publication of the pending witness, under the ownership still
 * held: true only when the fence is still trusted and the preflight (database,
 * WAL and witness bytes) still equals the plan's base. A rename that happened
 * before a failed directory sync leaves a pending witness, so this is false.
 */
function witnessUnchanged(path: string, database: Database.Database, source: number, target: number, base: string): boolean {
  try {
    const status = recognize(path, database, source, target);
    return status.state === "upgrade_needed" && status.preflight === base;
  } catch { return false; }
}

/**
 * Offline. Executes exactly the plan named by `expect`, in the protocol's order:
 * both locks; state `upgrade_needed` (or "already applied" for the plan the
 * `complete` marker records); owner continuity; the plan, its hash, binding,
 * base and steps; this run's validated backup and the base again; the pending
 * witness with the upgrade receipt; the reopened database proven to be the
 * inspected one; one schema transaction (steps, acts, marker, audit event);
 * validation and the confirmed witness; the plan removed.
 *
 * The target and the command are checked synchronously, before any lock or file.
 */
export function applySqliteUpgrade(paths: AppPaths, command: { expect: string }, backup: UpgradeBackup, target?: number): Promise<UpgradeApplyResult> {
  const version = upgradeTarget(target);
  const parsed = applyCommandSchema.safeParse(command);
  if (!parsed.success || typeof backup !== "function") throw new UpgradeError("upgrade_invalid_input", "upgrade inspect");
  return applyUpgrade(paths, parsed.data.expect, backup, version);
}

async function applyUpgrade(paths: AppPaths, expect: string, backup: UpgradeBackup, version: number): Promise<UpgradeApplyResult> {
  const { lock, owner } = ownership(paths, version);
  // `attempted`: from the attempt to publish the pending witness on, a failure is
  // examined before it is reported. `verified`: the connection reopened for
  // writing is the inspected database, so commit evidence may be read from it.
  let attempted = false, verified = false, committed = false, receipt: string | undefined;
  const source = owner.inspection.version, path = owner.canonicalPath;
  try {
    const status = recognize(path, owner.database, source, version);
    if (status.state === "current") {
      // How a success the operator did not see is reported. Nothing changes.
      if (status.appliedPlan === expect) return { state: "current", alreadyApplied: true, planHash: expect, receipt: null, backup: null, planRemoved: !existsSync(upgradePlanPath(path)), schemaVersion: source };
      throw new UpgradeError("upgrade_wrong_state", "none", false, "current");
    }
    if (status.state !== "upgrade_needed") throw new UpgradeError("upgrade_wrong_state", status.nextStep, false, status.state);
    try { SecurityFence.assertOwnerContinuity(path, owner.database); } catch { throw new UpgradeError("upgrade_owner_changed", "auth fence resume", false, "fenced"); }
    const { plan, hash } = readUpgradePlan(path);
    if (hash !== expect) throw new UpgradeError("upgrade_plan_mismatch", "upgrade inspect");
    if (plan.binding !== securityFenceBinding(path) || plan.installation !== checkpoint(owner.database).installation) throw new UpgradeError("upgrade_plan_foreign", "upgrade inspect");
    if (plan.base !== status.preflight) throw new UpgradeError("upgrade_base_changed", "upgrade inspect");
    if (plan.source !== source || plan.target !== version || canonicalJson(plan.steps) !== canonicalJson(structuralSteps(source, version))) throw new UpgradeError("upgrade_step_mismatch", "upgrade inspect");
    let backupRoot: string;
    try { backupRoot = await writeBackup(owner, path, source, version, backup); } catch { throw new UpgradeError("upgrade_backup_failed", "upgrade apply"); }
    // The final preflight. The Backup API copy reads through the read-only
    // connection, which writes neither the database nor its WAL, so the base
    // must still hold exactly. The source image is taken first, so a change
    // after it either moves this preflight or differs from it after the reopen.
    const image = sourceImage(path);
    const after = recognize(path, owner.database, source, version);
    if (after.state !== "upgrade_needed" || after.preflight !== plan.base) throw new UpgradeError("upgrade_base_changed", "upgrade inspect");
    const runReceipt = receipt = randomUUID();
    attempted = true;
    try { SecurityFence.beginUpgrade(path, { receipt: runReceipt, plan: hash, at: new Date().toISOString() }); } catch (error) {
      // Only the observed fence decides: the rename may have succeeded before a
      // directory sync threw.
      if (witnessUnchanged(path, owner.database, source, version, plan.base)) throw new UpgradeError("upgrade_witness_unchanged", "upgrade apply", false, "upgrade_needed");
      throw error;
    }
    let database: Database.Database;
    try {
      // Before durability settings, the observer or any write: the reopened
      // file and its checkpoint, policy and owner are the pending witness's
      // copy of the trusted record, and its bytes are the final preflight's.
      database = owner.enableVerifiedWrites(current => {
        try {
          SecurityFence.registerUpgradeObserver(path, current, runReceipt);
          if (sourceImage(path) !== image) throw new Error();
        } catch { throw new ReopenedDatabaseChangedError(); }
      });
    } catch (error) {
      if (error instanceof ReopenedDatabaseChangedError) throw new UpgradeError("upgrade_source_changed", "auth fence resume", false, "fenced");
      throw error;
    }
    verified = true;
    configureDurability(database);
    // Steps, acts, marker and audit event commit together or not at all.
    initializeSchema(database, owner.inspection.fresh, current => inspectSchema(current, version),
      { target: version, acts: current => upgradeActs(current, plan, runReceipt, hash) });
    committed = true;
    assertDurability(database);
    validateDatabase(database, version);
    SecurityFence.upgradeReceipt(path, database, runReceipt, "pending");
    SecurityFence.upgradeReceipt(path, database, runReceipt, "confirmed");
    return { state: "current", alreadyApplied: false, planHash: hash, receipt: runReceipt, backup: backupRoot, planRemoved: removeUpgradePlan(path), schemaVersion: version };
  } catch (error) {
    if (!attempted || (error instanceof UpgradeError && (error.code === "upgrade_witness_unchanged" || error.code === "upgrade_source_changed"))) throw error;
    // The witness may be pending: only `auth fence resume` recovers it. Prove a
    // committed change from durable facts written in the transaction, even if
    // its post-commit work threw: a raised schema version, or this run's audit
    // event (from a step-50 source no version changes). Use only the verified,
    // still-owned connection, outside a transaction.
    if (!committed && verified && owner.database.open && !owner.database.inTransaction) {
      try { committed = (owner.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version > source; } catch { /* Keep the original uncertainty. */ }
      if (!committed && receipt) { try { committed = upgradeCommitted(owner.database, receipt); } catch { /* As above. */ } }
    }
    throw new UpgradeError("upgrade_outcome_uncertain", "auth fence resume", committed, "fenced");
  } finally { release(lock, owner); }
}
