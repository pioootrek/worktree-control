import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { parseStrictProviderJson } from "../../modules/authentication";
import { durableJson, privateDirectory, readPrivateBoundedFile, syncDirectory, validateSensitivePath } from "../../private-storage";
import { schemaTarget, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { UPGRADE_MARKER_VERSION, upgradeMarkerChecksum, upgradeMarkerMigration } from "./upgrade-marker-migration";

/**
 * The plan of the explicit offline upgrade (integration branch, provisional).
 * `upgrade inspect` writes one plan beside the database; `upgrade apply --expect
 * <hash>` executes exactly that plan (see `upgrade-maintenance.ts`). Nothing here
 * is registered or reachable from production: every entry point that reads or
 * writes a file needs a schema target of at least 50, which only the provisional
 * switch allows ({@link assertUpgradeAvailable}).
 */

/** The four states of an installation's database; see `docs/architecture.md`. */
export type UpgradeState = "current" | "upgrade_needed" | "pre_fence" | "fenced";
/** The operator's next step, named by its command. */
export type UpgradeNextStep = "none" | "upgrade inspect" | "upgrade apply" | "auth fence inspect" | "auth fence establish" | "auth fence resume" | "stop the controller";
export type UpgradeErrorCode =
  | "upgrade_unsupported" | "upgrade_invalid_input" | "upgrade_owner_running" | "upgrade_wrong_state" | "upgrade_owner_changed"
  | "upgrade_plan_missing" | "upgrade_plan_invalid" | "upgrade_plan_foreign" | "upgrade_plan_mismatch" | "upgrade_base_changed"
  | "upgrade_step_mismatch" | "upgrade_plan_storage" | "upgrade_backup_failed" | "upgrade_restore_unfinished" | "upgrade_witness_unchanged"
  | "upgrade_source_changed" | "upgrade_outcome_uncertain";
const MESSAGES: Readonly<Record<UpgradeErrorCode, string>> = {
  upgrade_unsupported: "Unsupported schema target.",
  upgrade_invalid_input: "The upgrade command is invalid.",
  upgrade_owner_running: "The controller is running; the upgrade runs offline only.",
  upgrade_wrong_state: "The database is not in the state this command needs.",
  upgrade_owner_changed: "The installation owner differs from the one the security witness records.",
  upgrade_plan_missing: "No upgrade plan exists for this database.",
  upgrade_plan_invalid: "The upgrade plan is unreadable, malformed, of another format or contains an unknown act.",
  upgrade_plan_foreign: "The upgrade plan belongs to another database.",
  upgrade_plan_mismatch: "The upgrade plan is not the one named by --expect.",
  upgrade_base_changed: "The database or its security witness changed after the plan was written.",
  upgrade_step_mismatch: "The plan's schema steps differ from this release's.",
  upgrade_plan_storage: "The upgrade plan directory is unsafe or holds unexpected entries.",
  upgrade_backup_failed: "The pre-upgrade backup could not be written or validated; nothing was changed.",
  upgrade_restore_unfinished: "An interrupted restore must be completed first; nothing was changed.",
  upgrade_witness_unchanged: "The pending security witness could not be published; the witness and the database are unchanged.",
  upgrade_source_changed: "The database reopened for writing is not the one inspected; nothing was written to it.",
  upgrade_outcome_uncertain: "The upgrade stopped after the security witness was set to pending.",
};

/**
 * Every refusal or failure of the upgrade. `nextStep` names the operator's next
 * command; `committed` is true only when this run's schema transaction is proven
 * committed. Messages carry no secrets, paths or file contents. The unsupported
 * refusal keeps the text of `schemaTarget`, as every other target refusal does.
 */
export class UpgradeError extends Error {
  constructor(readonly code: UpgradeErrorCode, readonly nextStep: UpgradeNextStep, readonly committed = false, readonly state?: UpgradeState) {
    super(code === "upgrade_unsupported" ? MESSAGES[code] : `${code}: ${MESSAGES[code]}${committed ? " The schema transaction committed." : ""} Next step: ${nextStep}.`);
    this.name = "UpgradeError";
  }
}

/**
 * The schema target of every upgrade entry point, checked before any lock or
 * file is touched: at least step 50 (the marker), and only what `schemaTarget`
 * allows, so nothing is available while the provisional switch is off.
 */
export function upgradeTarget(target?: number): number {
  let version: number;
  try { version = schemaTarget(target); } catch { throw new UpgradeError("upgrade_unsupported", "none"); }
  if (version < UPGRADE_MARKER_VERSION) throw new UpgradeError("upgrade_unsupported", "none");
  return version;
}
/**
 * Refuses, as {@link upgradeTarget} does, unless the upgrade's schema target is
 * allowed. Every upgrade-specific helper that reads or writes a file calls it
 * first, including those of `security-fence.ts`.
 */
export function assertUpgradeAvailable(): void {
  upgradeTarget(UPGRADE_MARKER_VERSION);
}

const hex = z.string().regex(/^[0-9a-f]{64}$/);
export const UPGRADE_PLAN_KIND = "worktree-control/upgrade-plan";
export const UPGRADE_PLAN_FORMAT = 1;
/**
 * The plan is read whole into memory by finite offline maintenance only. 8 MiB
 * matches the backup manifest bound (`BACKUP_LIMITS.manifestBytes`), which
 * already holds 50 000 entries; the later project mappings and role decisions
 * are one act per registration or grant, each a few hundred bytes, so 50 000
 * acts fit with room. A larger installation is refused, never truncated.
 */
export const UPGRADE_PLAN_LIMITS = { bytes: 8 * 1024 * 1024, acts: 50_000, depth: 16, temporaries: 64 } as const;

/** What a structural step is known as: its registry name and checksum. */
export interface UpgradeStep { version: number; name: string; checksum: string }
/** Steps the upgrade may run, above the released schema 49 the fence requires. */
const STRUCTURAL_STEPS: ReadonlyMap<number, Omit<UpgradeStep, "version">> = new Map([
  [UPGRADE_MARKER_VERSION, { name: upgradeMarkerMigration.name, checksum: upgradeMarkerChecksum }],
]);
/** The steps from `source` (exclusive) to `target`, as this code would run them. */
export function structuralSteps(source: number, target: number): UpgradeStep[] {
  if (!Number.isSafeInteger(source) || source < SUPPORTED_SCHEMA_VERSION || source > target) throw new UpgradeError("upgrade_step_mismatch", "upgrade inspect");
  const steps: UpgradeStep[] = [];
  for (let version = source + 1; version <= target; version++) {
    const step = STRUCTURAL_STEPS.get(version);
    if (!step) throw new UpgradeError("upgrade_step_mismatch", "upgrade inspect");
    steps.push({ version, ...step });
  }
  return steps;
}

/** Facts every act sees; acts must not depend on anything outside the plan and the database. */
export interface UpgradeActContext { source: number; target: number }
/**
 * One kind of data act. A later pull request adds a kind by appending one entry
 * to {@link UPGRADE_ACT_KINDS}:
 * - `propose` runs during inspect on the read-only connection at the source
 *   schema and returns the acts of this kind, in their order of execution;
 * - `payload` is the strict schema of one act's data; the plan carries it, and
 *   the plan hash covers it like every other field (values must be strings,
 *   safe integers, booleans, null, arrays or objects of those);
 * - `execute` runs inside the one schema transaction after the structural
 *   steps, at the target, with foreign keys off (see `initializeSchema`); it
 *   must leave no violation and must not write `upgrade_marker`;
 * - `describe` is the line the operator reads; it must not carry secrets.
 */
export interface UpgradeActKind<Payload = unknown> {
  readonly kind: string;
  readonly payload: z.ZodType<Payload>;
  propose(database: Database.Database, context: UpgradeActContext): Payload[];
  execute(database: Database.Database, payload: Payload, context: UpgradeActContext): void;
  describe(payload: Payload): string;
}
/** C1c defines no act kind: every plan has an empty act list, and any act is malformed. */
export const UPGRADE_ACT_KINDS: ReadonlyArray<UpgradeActKind> = Object.freeze([]);
export interface UpgradeAct { kind: string; payload: unknown }

export interface UpgradePlan {
  kind: typeof UPGRADE_PLAN_KIND;
  format: typeof UPGRADE_PLAN_FORMAT;
  /** `securityFenceBinding` of the canonical database path. */
  binding: string;
  /** `security_checkpoint.installation` of the database. */
  installation: string;
  /** `SecurityFence.preflight` over the database, its WAL and the witness at inspect. */
  base: string;
  source: number;
  target: number;
  steps: UpgradeStep[];
  acts: UpgradeAct[];
}

const stepSchema = z.object({ version: z.number().int().min(1).max(1_000_000), name: z.string().min(1).max(128), checksum: hex }).strict();
const planSchemas = new WeakMap<ReadonlyArray<UpgradeActKind>, z.ZodType<UpgradePlan>>();
function planSchema(kinds: ReadonlyArray<UpgradeActKind>): z.ZodType<UpgradePlan> {
  const cached = planSchemas.get(kinds);
  if (cached) return cached;
  const options = kinds.map(entry => z.object({ kind: z.literal(entry.kind), payload: entry.payload }).strict());
  // Without a registered kind no act is valid.
  const act = options.length === 0 ? z.never() : options.length === 1 ? options[0] : z.union(options as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  const schema = z.object({
    kind: z.literal(UPGRADE_PLAN_KIND), format: z.literal(UPGRADE_PLAN_FORMAT), binding: hex, installation: hex, base: hex,
    source: z.number().int().min(1).max(1_000_000), target: z.number().int().min(1).max(1_000_000),
    steps: z.array(stepSchema).max(64), acts: z.array(act).max(UPGRADE_PLAN_LIMITS.acts),
  }).strict() as unknown as z.ZodType<UpgradePlan>;
  planSchemas.set(kinds, schema);
  return schema;
}
const envelopeSchema = z.object({ payload: z.unknown(), sha256: hex }).strict();

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace, only
 * strings, safe integers, booleans, null, arrays and plain objects. Anything
 * else is refused rather than given a second spelling.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
    return String(value);
  }
  if (Array.isArray(value)) {
    // Every index, so a hole is refused rather than skipped (map skips holes).
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, entry]) => entry === undefined)) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
}
/** SHA-256 (lowercase hex) of the UTF-8 bytes of the plan's canonical JSON. */
export function upgradePlanHash(plan: UpgradePlan): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

/** Validates a plan payload against the registered act kinds. */
export function parseUpgradePlan(value: unknown, kinds: ReadonlyArray<UpgradeActKind> = UPGRADE_ACT_KINDS): UpgradePlan {
  const parsed = planSchema(kinds).safeParse(value);
  if (!parsed.success) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
  return parsed.data;
}

/** Every registered kind's proposals, kind by kind in registry order. */
export function proposeUpgradeActs(database: Database.Database, context: UpgradeActContext, kinds: ReadonlyArray<UpgradeActKind> = UPGRADE_ACT_KINDS): UpgradeAct[] {
  const acts = kinds.flatMap(entry => entry.propose(database, context).map(payload => ({ kind: entry.kind, payload })));
  if (acts.length > UPGRADE_PLAN_LIMITS.acts) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
  return acts;
}
/** Executes a parsed plan's acts in their order, inside the caller's transaction. */
export function executeUpgradeActs(database: Database.Database, plan: UpgradePlan, kinds: ReadonlyArray<UpgradeActKind> = UPGRADE_ACT_KINDS): void {
  if (!database.inTransaction) throw new Error("Upgrade acts run inside the schema transaction.");
  const context = { source: plan.source, target: plan.target };
  for (const act of plan.acts) {
    const entry = kinds.find(candidate => candidate.kind === act.kind);
    if (!entry) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
    entry.execute(database, entry.payload.parse(act.payload), context);
  }
}
/** The operator's lines for a plan's acts, in order. */
export function describeUpgradeActs(plan: UpgradePlan, kinds: ReadonlyArray<UpgradeActKind> = UPGRADE_ACT_KINDS): string[] {
  return plan.acts.map(act => {
    const entry = kinds.find(candidate => candidate.kind === act.kind);
    if (!entry) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
    return entry.describe(entry.payload.parse(act.payload));
  });
}

/**
 * The plan's own private directory beside the database. It is not the fence's
 * `.security` directory, whose publication refuses unknown entries.
 */
export const upgradePlanRoot = (database: string) => `${database}.upgrade`;
export const upgradePlanPath = (database: string) => join(upgradePlanRoot(database), "plan.json");
const TEMPORARY = /^\.journal-[0-9a-f-]{36}$/;

function unsafePlanStorage(): never { throw new UpgradeError("upgrade_plan_storage", "upgrade inspect"); }
/** A regular private file of this user, without aliases; never followed or repaired. */
function assertPrivateEntry(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) unsafePlanStorage();
}

/**
 * Replaces the plan durably. Leftover temporaries of an interrupted write are
 * reaped (a bounded batch per call, as the witness publication does: the sole
 * database owner writes synchronously, so none can belong to a concurrent
 * write). Any other entry, a link or an entry that is not private refuses.
 * Returns the plan hash.
 */
export function writeUpgradePlan(database: string, plan: UpgradePlan): string {
  assertUpgradeAvailable();
  const checked = parseUpgradePlan(plan);
  const hash = upgradePlanHash(checked);
  const envelope = { payload: JSON.parse(canonicalJson(checked)) as unknown, sha256: hash };
  if (Buffer.byteLength(JSON.stringify(envelope)) > UPGRADE_PLAN_LIMITS.bytes) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
  const root = upgradePlanRoot(database), path = upgradePlanPath(database);
  try {
    validateSensitivePath(path, [], true);
    privateDirectory(root);
    validateSensitivePath(path, [], true);
  } catch (error) { if (error instanceof UpgradeError) throw error; unsafePlanStorage(); }
  const directory = opendirSync(root);
  let removed = false;
  try {
    for (let count = 0; ; count++) {
      const entry = directory.readSync();
      if (!entry) break;
      if (count >= UPGRADE_PLAN_LIMITS.temporaries || (entry.name !== "plan.json" && !TEMPORARY.test(entry.name))) unsafePlanStorage();
      const target = join(root, entry.name);
      assertPrivateEntry(target);
      if (entry.name !== "plan.json") { unlinkSync(target); removed = true; }
    }
  } finally { try { directory.closeSync(); } finally { if (removed) syncDirectory(root); } }
  durableJson(path, envelope);
  return hash;
}

/**
 * Reads the plan: private, bounded, strictly parsed (no duplicate keys), never
 * through a link, with the envelope hash verified against the canonical payload.
 */
export function readUpgradePlan(database: string, kinds: ReadonlyArray<UpgradeActKind> = UPGRADE_ACT_KINDS): { plan: UpgradePlan; hash: string } {
  assertUpgradeAvailable();
  const path = upgradePlanPath(database);
  let present: boolean;
  try { lstatSync(path); present = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
    present = false;
  }
  if (!present) throw new UpgradeError("upgrade_plan_missing", "upgrade inspect");
  let value: unknown;
  try {
    const bytes = readPrivateBoundedFile(path, UPGRADE_PLAN_LIMITS.bytes);
    value = parseStrictProviderJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { maxDepth: UPGRADE_PLAN_LIMITS.depth, maxFields: UPGRADE_PLAN_LIMITS.bytes });
  } catch { throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect"); }
  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
  const plan = parseUpgradePlan(envelope.data.payload, kinds);
  const hash = upgradePlanHash(plan);
  // The stored payload must be exactly the canonical plan: no field the schema
  // would strip, and the recorded hash its own.
  if (hash !== envelope.data.sha256 || canonicalJson(envelope.data.payload) !== canonicalJson(plan)) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
  return { plan, hash };
}

/** Removes the executed plan. Returns false (and keeps the result) when that fails; the gate refuses before. */
export function removeUpgradePlan(database: string): boolean {
  assertUpgradeAvailable();
  const path = upgradePlanPath(database);
  try {
    if (!existsSync(path)) return true;
    assertPrivateEntry(path);
    unlinkSync(path);
    syncDirectory(upgradePlanRoot(database));
    return true;
  } catch { return false; }
}
