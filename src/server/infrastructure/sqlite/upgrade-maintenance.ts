import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AppPaths } from "../../paths";
import { acquireControllerLock, ControllerAlreadyRunningError, type ControllerLock } from "../../controller-lock";
import { SecurityFence, securityFenceBinding } from "./security-fence";
import { OwnedSqliteDatabase } from "./owned-database";
import { assertDurability, configureDurability, validateDatabase } from "./database-validation";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { BACKUP_LIMITS, parseManifest, readBoundedJson, validateBackup } from "./backup-validation";
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
/** What the injected backup may use: a read-only Backup API copy of the owned connection. */
export interface UpgradeBackupSource { backup(destination: string, options?: { progress: () => number }): Promise<void>; schemaVersion(): number }
/**
 * Writes the pre-upgrade backup (the composition passes `createControllerBackup`
 * with its destination) and returns its root and manifest. The upgrade then
 * validates that tree itself at the target ceiling before changing anything.
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
function installation(database: Database.Database): string {
  return (database.prepare("SELECT installation FROM security_checkpoint WHERE singleton=1").get() as { installation: string }).installation;
}
/** Both singleton locks, as the fence maintenance takes them; the caller releases. */
function ownership(paths: AppPaths, target: number): { lock: ControllerLock; owner: OwnedSqliteDatabase } {
  let lock: ControllerLock;
  try { lock = acquireControllerLock(paths.controllerLockPath); } catch (error) {
    if (error instanceof ControllerAlreadyRunningError) throw new UpgradeError("upgrade_owner_running", "stop the controller");
    throw error;
  }
  try { return { lock, owner: new OwnedSqliteDatabase(paths.databasePath, false, target) }; } catch (error) {
    lock.release();
    if (error instanceof ControllerAlreadyRunningError) throw new UpgradeError("upgrade_owner_running", "stop the controller");
    throw error;
  }
}
function release(lock: ControllerLock, owner: OwnedSqliteDatabase): void {
  // Do not release controller ownership if closing SQLite failed.
  owner.close();
  lock.release();
}

/**
 * Offline and read-only on the database. Recognises the state; only in
 * `upgrade_needed` it writes the plan (replacing any earlier one) and returns
 * it with its hash. In every other state it writes nothing and reports the
 * operator's next step.
 */
export function inspectSqliteUpgrade(paths: AppPaths, target?: number): UpgradeInspection {
  const version = upgradeTarget(target);
  const { lock, owner } = ownership(paths, version);
  try {
    const path = owner.canonicalPath, source = owner.inspection.version;
    const status = recognize(path, owner.database, source, version);
    if (status.state !== "upgrade_needed") return status;
    const plan: UpgradePlan = {
      kind: UPGRADE_PLAN_KIND, format: UPGRADE_PLAN_FORMAT, binding: securityFenceBinding(path), installation: installation(owner.database),
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

async function writeBackup(owner: OwnedSqliteDatabase, path: string, source: number, target: number, backup: UpgradeBackup): Promise<string> {
  const created = await backup({ backup: (destination, options) => owner.backup(destination, options), schemaVersion: () => source }, { database: path, schemaVersion: source });
  if (!created || typeof created.root !== "string") throw new Error("Backup returned no tree.");
  const manifest = parseManifest(created.manifest, target);
  if (manifest.database.schemaVersion !== source) throw new Error("Backup schema version differs from the database.");
  // The tree's own manifest is the one returned, and the tree matches it.
  const stored = parseManifest(readBoundedJson(join(created.root, "manifest.json"), BACKUP_LIMITS.manifestBytes, true), target);
  if (JSON.stringify(stored) !== JSON.stringify(manifest)) throw new Error("Backup manifest differs from the returned one.");
  validateBackup(created.root, manifest, true, target);
  return created.root;
}

/**
 * Offline. Executes exactly the plan named by `expect`, in the protocol's order:
 * both locks; state `upgrade_needed` (or "already applied" for the plan the
 * `complete` marker records); owner continuity; the plan, its hash, binding,
 * base and steps; a validated backup and the base again; the pending witness
 * with the upgrade receipt; one schema transaction (steps, acts, marker, audit
 * event); validation and the confirmed witness; the plan removed.
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
  // From the first attempt to publish the pending witness on, a failure leaves
  // the database fenced, and only `auth fence resume` recovers it.
  let fenced = false, committed = false, receipt: string | undefined;
  const source = owner.inspection.version;
  try {
    const path = owner.canonicalPath;
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
    if (plan.binding !== securityFenceBinding(path) || plan.installation !== installation(owner.database)) throw new UpgradeError("upgrade_plan_foreign", "upgrade inspect");
    if (plan.base !== status.preflight) throw new UpgradeError("upgrade_base_changed", "upgrade inspect");
    if (plan.source !== source || plan.target !== version || canonicalJson(plan.steps) !== canonicalJson(structuralSteps(source, version))) throw new UpgradeError("upgrade_step_mismatch", "upgrade inspect");
    let backupRoot: string;
    try { backupRoot = await writeBackup(owner, path, source, version, backup); } catch { throw new UpgradeError("upgrade_backup_failed", "upgrade apply"); }
    // The Backup API copy reads through the read-only connection, which writes
    // neither the database nor its WAL, so the base must still hold exactly.
    const after = recognize(path, owner.database, source, version);
    if (after.state !== "upgrade_needed" || after.preflight !== plan.base) throw new UpgradeError("upgrade_base_changed", "upgrade inspect");
    const runReceipt = receipt = randomUUID();
    fenced = true;
    SecurityFence.beginUpgrade(path, { receipt: runReceipt, plan: hash, at: new Date().toISOString() });
    const database = owner.enableWrites();
    configureDurability(database);
    SecurityFence.registerUpgradeObserver(path, database, runReceipt);
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
    if (!fenced) throw error;
    // Prove a committed change from durable facts written in the transaction,
    // even if its post-commit work threw: a raised schema version, or this run's
    // audit event (from a step-50 source no version changes). Use only the
    // still-owned connection, outside a transaction.
    if (!committed && owner.database.open && !owner.database.inTransaction) {
      try { committed = (owner.database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version > source; } catch { /* Keep the original uncertainty. */ }
      if (!committed && receipt) { try { committed = upgradeCommitted(owner.database, receipt); } catch { /* As above. */ } }
    }
    throw new UpgradeError("upgrade_outcome_uncertain", "auth fence resume", committed, "fenced");
  } finally { release(lock, owner); }
}
