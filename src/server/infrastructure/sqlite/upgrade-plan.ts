import { createHash } from "node:crypto";
import { existsSync, lstatSync, opendirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { parseStrictProviderJson } from "../../modules/authentication";
import { durableJson, privateDirectory, readPrivateBoundedFile, syncDirectory, validateSensitivePath } from "../../private-storage";
import { schemaTarget, SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { UPGRADE_MARKER_VERSION, upgradeMarkerChecksum, upgradeMarkerMigration } from "./upgrade-marker-migration";
import { PROJECT_MAPPING_VERSION, projectMappingChecksum, projectMappingMigration } from "./mapping-structure-migration";
import { ACCOUNT_GRANTS_VERSION, accountGrantsChecksum, accountGrantsMigration } from "./account-grants-migration";
import { MAPPING_ACT_DOMAIN } from "./mapping-upgrade-acts";
import { AUTHORITY_ACT_DOMAIN } from "./authority-upgrade-acts";
import {
  canonicalJson, FindingList, UPGRADE_PLAN_LIMITS, UpgradeError,
  type UpgradeAct, type UpgradeActContext, type UpgradeActDomain, type UpgradeActKind, type UpgradeProposalContext,
} from "./upgrade-contract";

/**
 * The plan of the explicit offline upgrade (integration branch, provisional).
 * `upgrade inspect` writes one plan beside the database; `upgrade apply --expect
 * <hash>` executes exactly that plan (see `upgrade-maintenance.ts`). Nothing here
 * is registered or reachable from production: every entry point that reads or
 * writes a file needs a schema target of at least 50, which only the provisional
 * switch allows ({@link assertUpgradeAvailable}).
 */

export {
  boundedFindings, canonicalJson, compareText, escapeDisplay, FindingList, sampled, UPGRADE_DETAILS_LIMITS, UPGRADE_FINDINGS_LIMIT, UPGRADE_PLAN_LIMITS, UpgradeError,
  type UpgradeAct, type UpgradeActContext, type UpgradeActDomain, type UpgradeActKind, type UpgradeErrorCode, type UpgradeFinding, type UpgradeFindings,
  type UpgradeNextStep, type UpgradeProposalContext, type UpgradeState,
} from "./upgrade-contract";

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
/**
 * Format 2 carries the operator's decisions and the review under the hash; a
 * format-1 plan (an act list only) is refused as malformed.
 */
export const UPGRADE_PLAN_FORMAT = 2;

/** What a structural step is known as: its registry name and checksum. */
export interface UpgradeStep { version: number; name: string; checksum: string }
/** Steps the upgrade may run, above the released schema 49 the fence requires. */
const STRUCTURAL_STEPS: ReadonlyMap<number, Omit<UpgradeStep, "version">> = new Map([
  [UPGRADE_MARKER_VERSION, { name: upgradeMarkerMigration.name, checksum: upgradeMarkerChecksum }],
  [PROJECT_MAPPING_VERSION, { name: projectMappingMigration.name, checksum: projectMappingChecksum }],
  [ACCOUNT_GRANTS_VERSION, { name: accountGrantsMigration.name, checksum: accountGrantsChecksum }],
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

/**
 * The act domains, in the order their acts run: the project mapping (from 51),
 * then the authority reset and the first grant (from 52), whose acts run after
 * every mapping act.
 */
export const UPGRADE_ACT_DOMAINS: ReadonlyArray<UpgradeActDomain> = Object.freeze([MAPPING_ACT_DOMAIN as unknown as UpgradeActDomain, AUTHORITY_ACT_DOMAIN as unknown as UpgradeActDomain]);
/** The domains a plan of this target carries. */
export function upgradeDomains(target: number, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): UpgradeActDomain[] {
  return domains.filter(domain => target >= domain.minimumTarget);
}

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
  /** The operator's normalised decisions, by domain; exactly the domains of the target. */
  decisions: Record<string, unknown>;
  acts: UpgradeAct[];
  /** What the operator approves, by domain, computed by the same pass as the acts. */
  review: Record<string, unknown>;
}

const stepSchema = z.object({ version: z.number().int().min(1).max(1_000_000), name: z.string().min(1).max(128), checksum: hex }).strict();
const planSchemas = new WeakMap<ReadonlyArray<UpgradeActDomain>, z.ZodType<UpgradePlan>>();
function planSchema(domains: ReadonlyArray<UpgradeActDomain>): z.ZodType<UpgradePlan> {
  const cached = planSchemas.get(domains);
  if (cached) return cached;
  const kinds = domains.flatMap(domain => domain.kinds);
  const options = kinds.map(entry => z.object({ kind: z.literal(entry.kind), payload: entry.payload }).strict());
  // Without a registered kind no act is valid.
  const act = options.length === 0 ? z.never() : options.length === 1 ? options[0] : z.union(options as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  const owner = new Map(domains.flatMap(domain => domain.kinds.map(entry => [entry.kind, domain] as const)));
  const schema = z.object({
    kind: z.literal(UPGRADE_PLAN_KIND), format: z.literal(UPGRADE_PLAN_FORMAT), binding: hex, installation: hex, base: hex,
    source: z.number().int().min(1).max(1_000_000), target: z.number().int().min(1).max(1_000_000),
    steps: z.array(stepSchema).max(64),
    decisions: z.object(Object.fromEntries(domains.map(domain => [domain.name, domain.decisions.optional()]))).strict(),
    acts: z.array(act).max(UPGRADE_PLAN_LIMITS.acts),
    review: z.object(Object.fromEntries(domains.map(domain => [domain.name, domain.review.optional()]))).strict(),
  }).strict().superRefine((plan, context) => {
    // Exactly the target's domains carry decisions and a review, and every act belongs to one of them, in registry order.
    const applicable = upgradeDomains(plan.target, domains);
    for (const domain of domains) {
      const applies = applicable.includes(domain);
      if (Object.hasOwn(plan.decisions, domain.name) !== applies || Object.hasOwn(plan.review, domain.name) !== applies) context.addIssue({ code: "custom", message: "domain" });
    }
    const order = (plan.acts as UpgradeAct[]).map(entry => applicable.indexOf(owner.get(entry.kind)!));
    if (order.some((index, position) => index < 0 || (position > 0 && index < order[position - 1]))) context.addIssue({ code: "custom", message: "act domain" });
  }) as unknown as z.ZodType<UpgradePlan>;
  planSchemas.set(domains, schema);
  return schema;
}
const envelopeSchema = z.object({ payload: z.unknown(), sha256: hex }).strict();

/** SHA-256 (lowercase hex) of the UTF-8 bytes of the plan's canonical JSON. */
export function upgradePlanHash(plan: UpgradePlan): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

/** Validates a plan payload against the registered act domains. */
export function parseUpgradePlan(value: unknown, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): UpgradePlan {
  const parsed = planSchema(domains).safeParse(value);
  if (!parsed.success) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
  return parsed.data;
}

/**
 * The operator's decisions for a target, before any lock or file: a plain
 * object whose keys each belong to a domain of the target, split by domain
 * and normalised by it. No decision (`undefined` or `{}`) is valid at every
 * target; an explicit `null` is refused like any other value that is not a
 * plain object. At target 50, where no domain applies, any key is refused.
 */
export function normaliseUpgradeDecisions(input: unknown, target: number, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): Record<string, unknown> {
  upgradeTarget(target);
  const value = input === undefined ? {} : input;
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new UpgradeError("upgrade_decisions_invalid", "upgrade inspect");
  const keys = Object.keys(value), applicable = upgradeDomains(target, domains);
  const unknown = keys.filter(entry => !applicable.some(domain => domain.decisionKeys.includes(entry)));
  const refused = new FindingList();
  for (const entry of unknown) refused.add("decisions", entry, "not a decision at this target");
  refused.raise("upgrade_decisions_invalid");
  return Object.fromEntries(applicable.map(domain => [domain.name,
    domain.normalise(Object.fromEntries(keys.filter(entry => domain.decisionKeys.includes(entry)).map(entry => [entry, (value as Record<string, unknown>)[entry]])))]));
}

/**
 * The single proposal of every domain of the target, in registry order: the
 * plan's act list and review. `prior` is an earlier plan's act list whose
 * generated values may be reused; `fresh` false forbids generating any
 * (a replay). Refusals are the domains' own.
 */
export function proposeUpgrade(database: Database.Database, context: UpgradeProposalContext, decisions: Record<string, unknown>, prior: readonly UpgradeAct[] | null,
  fresh: boolean, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): { acts: UpgradeAct[]; review: Record<string, unknown> } {
  upgradeTarget(context.target);
  const acts: UpgradeAct[] = [], review: Record<string, unknown> = {};
  for (const domain of upgradeDomains(context.target, domains)) {
    const proposal = domain.propose(database, context, decisions[domain.name], prior, fresh);
    acts.push(...proposal.acts);
    review[domain.name] = proposal.review;
  }
  if (acts.length > UPGRADE_PLAN_LIMITS.acts) {
    throw new UpgradeError("upgrade_plan_bounds", "upgrade inspect", false, undefined, { findings: [{ table: "plan", id: "acts", problem: `${acts.length} acts exceed ${UPGRADE_PLAN_LIMITS.acts}` }], count: 1, truncated: false });
  }
  return { acts, review };
}

/**
 * Whole-plan validation: the plan's decisions are in normalised form, and its
 * acts and review are exactly what the proposal gives for this database, these
 * decisions and the plan's own generated values (replayed, nothing generated).
 * `schemaVersion` is the schema of the connection read: the source before the
 * backup, the target inside the schema transaction. Every refusal is
 * `upgrade_plan_unproposed` (next step `upgrade inspect`), carrying a domain
 * refusal's findings when one stopped the replay, and otherwise naming what
 * differs: the decisions' form, the acts, the review (the acts are compared
 * first and on their own, so a forged act list is refused for its acts even
 * when its review was forged to match it).
 */
export function validateUpgradeProposal(database: Database.Database, plan: UpgradePlan, schemaVersion: number, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): void {
  upgradeTarget(plan.target);
  let proposal: { acts: UpgradeAct[]; review: Record<string, unknown> };
  try {
    const normalised = Object.fromEntries(upgradeDomains(plan.target, domains).map(domain => [domain.name, domain.normalise(plan.decisions[domain.name] as Record<string, unknown>)]));
    if (canonicalJson(normalised) !== canonicalJson(plan.decisions)) {
      const differs = new FindingList();
      differs.add("plan", "decisions", "the decisions are not in normalised form");
      differs.raise("upgrade_plan_unproposed");
    }
    proposal = proposeUpgrade(database, { schemaVersion, source: plan.source, target: plan.target }, plan.decisions, plan.acts, false, domains);
  } catch (error) {
    if (error instanceof UpgradeError && error.code !== "upgrade_unsupported") throw new UpgradeError("upgrade_plan_unproposed", "upgrade inspect", false, undefined, error.details);
    throw error;
  }
  const differs = new FindingList();
  if (canonicalJson(proposal.acts) !== canonicalJson(plan.acts)) differs.add("plan", "acts", "the acts differ from the proposal for this database and the plan's decisions");
  if (canonicalJson(proposal.review) !== canonicalJson(plan.review)) differs.add("plan", "review", "the review differs from the proposal for this database and the plan's decisions");
  differs.raise("upgrade_plan_unproposed");
}

/** Executes a parsed plan's acts in their order, inside the caller's transaction. */
export function executeUpgradeActs(database: Database.Database, plan: UpgradePlan, context: UpgradeActContext, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): void {
  upgradeTarget(plan.target);
  if (!database.inTransaction) throw new Error("Upgrade acts run inside the schema transaction.");
  const kinds: UpgradeActKind[] = upgradeDomains(plan.target, domains).flatMap(domain => [...domain.kinds]);
  for (const act of plan.acts) {
    const entry = kinds.find(candidate => candidate.kind === act.kind);
    if (!entry) throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
    entry.execute(database, entry.payload.parse(act.payload), context);
  }
}

/** The operator's lines for a plan's acts and review, domain by domain. */
export function describeUpgradeActs(plan: UpgradePlan, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): string[] {
  return upgradeDomains(plan.target, domains).flatMap(domain => {
    const own = new Set(domain.kinds.map(entry => entry.kind));
    return domain.describe(plan.acts.filter(act => own.has(act.kind)), plan.review[domain.name]);
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
export function readUpgradePlan(database: string, domains: ReadonlyArray<UpgradeActDomain> = UPGRADE_ACT_DOMAINS): { plan: UpgradePlan; hash: string } {
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
  const plan = parseUpgradePlan(envelope.data.payload, domains);
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
