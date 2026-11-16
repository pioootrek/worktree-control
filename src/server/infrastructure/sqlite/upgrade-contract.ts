import type Database from "better-sqlite3";
import type { z } from "zod";

/**
 * The shared vocabulary of the explicit offline upgrade (integration branch,
 * provisional): its errors, canonical JSON, limits and the interface of an act
 * domain. It imports no upgrade module, so `upgrade-plan.ts` (the plan and its
 * registry) and each domain (`mapping-upgrade-acts.ts`, `authority-upgrade-acts.ts`) can both depend on it
 * without importing each other in a cycle. `upgrade-plan.ts` re-exports it.
 */

/** The four states of an installation's database; see `docs/architecture.md`. */
export type UpgradeState = "current" | "upgrade_needed" | "pre_fence" | "fenced";
/** The operator's next step, named by its command. */
export type UpgradeNextStep = "none" | "upgrade inspect" | "upgrade apply" | "auth fence inspect" | "auth fence establish" | "auth fence resume" | "stop the controller";
export type UpgradeErrorCode =
  | "upgrade_unsupported" | "upgrade_invalid_input" | "upgrade_owner_running" | "upgrade_wrong_state" | "upgrade_owner_changed"
  | "upgrade_plan_missing" | "upgrade_plan_invalid" | "upgrade_plan_foreign" | "upgrade_plan_mismatch" | "upgrade_base_changed"
  | "upgrade_step_mismatch" | "upgrade_plan_storage" | "upgrade_backup_failed" | "upgrade_restore_unfinished" | "upgrade_witness_unchanged"
  | "upgrade_source_changed" | "upgrade_outcome_uncertain"
  | "upgrade_decisions_invalid" | "upgrade_plan_unproposed" | "upgrade_plan_bounds"
  | "upgrade_mapping_collision" | "upgrade_mapping_dangling" | "upgrade_mapping_divergent" | "upgrade_mapping_unexpected"
  | "upgrade_mapping_journal" | "upgrade_mapping_malformed" | "upgrade_mapping_clock"
  | "upgrade_authority_malformed" | "upgrade_authority_unexpected"
  | "upgrade_required";
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
  upgrade_decisions_invalid: "The operator decisions are malformed, conflicting, not allowed at this target or name no such row; no plan was written.",
  upgrade_plan_unproposed: "The plan's acts or review are not what this database and the plan's decisions produce.",
  upgrade_plan_bounds: "The plan would exceed its limits; it is refused, never truncated, and no plan was written.",
  upgrade_mapping_collision: "One ID names rows of more than one of registrations, projects and remote identities; no plan was written.",
  upgrade_mapping_dangling: "A link, binding or parent names a missing row; no plan was written.",
  upgrade_mapping_divergent: "A remote identity's bindings lead to more than one project and need an explicit decision; no plan was written.",
  upgrade_mapping_unexpected: "A registration or remote identity has a parent project although the upgrade is needed; no plan was written.",
  upgrade_mapping_journal: "The project mapping journal is inconsistent; no plan was written.",
  upgrade_mapping_malformed: "A stored value the project mapping depends on is malformed; no plan was written.",
  upgrade_mapping_clock: "The project mapping clock cannot advance once for every attach and map act; no plan was written.",
  upgrade_authority_malformed: "A stored value the authority reset depends on is malformed, of an unknown kind or status, or cannot advance; no plan was written.",
  upgrade_authority_unexpected: "Grants of the new model are stored although the upgrade is needed; no plan was written.",
  upgrade_required: "This database requires an explicit offline upgrade before ordinary access.",
};

/** One offending row of a refusal: where it is, its ID (control characters escaped) and what is wrong. */
export interface UpgradeFinding { readonly table: string; readonly id: string; readonly problem: string }
/** The offending rows of a refusal, bounded: `count` is the total, `truncated` says whether `findings` is cut. */
export interface UpgradeFindings { readonly findings: readonly UpgradeFinding[]; readonly count: number; readonly truncated: boolean }
/** The most findings one refusal lists; the count is always complete. */
export const UPGRADE_FINDINGS_LIMIT = 100;
/**
 * The bounds of one refusal's details: a finding's table and problem text (code
 * points, cut with `…`), the samples a problem embeds from a list (see
 * {@link sampled}), and the serialised details as a whole (UTF-8 bytes of their
 * JSON). Beyond the byte bound the last findings are dropped and `truncated`
 * is set; `count` stays complete.
 */
export const UPGRADE_DETAILS_LIMITS = { table: 64, problem: 400, samples: 5, bytes: 64 * 1024 } as const;

function cutText(value: string, limit: number): string {
  const points = [...value];
  return points.length > limit ? `${points.slice(0, limit).join("")}…` : value;
}
/**
 * A bounded list for a finding's text: the first {@link UPGRADE_DETAILS_LIMITS}
 * `samples` items, then "and N more (M in all)" when there are more.
 */
export function sampled(items: readonly string[], limit: number = UPGRADE_DETAILS_LIMITS.samples): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} and ${items.length - limit} more (${items.length} in all)` : shown;
}
/**
 * The details of a refusal from its first findings and the complete count,
 * every text bounded and the whole JSON within the byte bound.
 */
export function boundedFindings(findings: readonly UpgradeFinding[], count: number): UpgradeFindings {
  const items = findings.slice(0, UPGRADE_FINDINGS_LIMIT).map(finding => ({
    table: cutText(finding.table, UPGRADE_DETAILS_LIMITS.table), id: escapeDisplay(finding.id, 200) ?? "", problem: cutText(finding.problem, UPGRADE_DETAILS_LIMITS.problem),
  }));
  const size = () => Buffer.byteLength(JSON.stringify({ findings: items, count, truncated: true }), "utf8");
  while (items.length > 0 && size() > UPGRADE_DETAILS_LIMITS.bytes) items.pop();
  return { findings: items, count, truncated: count > items.length };
}

/**
 * Every refusal or failure of the upgrade. `nextStep` names the operator's next
 * command; `committed` is true only when this run's schema transaction is proven
 * committed. Messages carry no secrets, paths or file contents. The unsupported
 * refusal keeps the text of `schemaTarget`, as every other target refusal does.
 * A refusal about rows carries them in `details` (IDs only), never in the message.
 */
export class UpgradeError extends Error {
  constructor(readonly code: UpgradeErrorCode, readonly nextStep: UpgradeNextStep, readonly committed = false, readonly state?: UpgradeState, readonly details?: UpgradeFindings) {
    super(code === "upgrade_unsupported" ? MESSAGES[code] : `${code}: ${MESSAGES[code]}${committed ? " The schema transaction committed." : ""} Next step: ${nextStep}.`);
    this.name = "UpgradeError";
  }
}

/**
 * Collects findings, keeping the first {@link UPGRADE_FINDINGS_LIMIT} and
 * counting all; the refusal's details are bounded by {@link boundedFindings}.
 */
export class FindingList {
  private readonly items: UpgradeFinding[] = [];
  private total = 0;
  add(table: string, id: string, problem: string): void {
    this.total++;
    if (this.items.length < UPGRADE_FINDINGS_LIMIT) this.items.push({ table, id, problem });
  }
  /** Counts `count` further findings that are not listed (a bounded query found more rows than it read). */
  more(count: number): void { this.total += count; }
  get count(): number { return this.total; }
  /** The bounded details of what was found. */
  details(): UpgradeFindings { return boundedFindings(this.items, this.total); }
  /** Throws the refusal when anything was found. */
  raise(code: UpgradeErrorCode): void {
    if (this.total === 0) return;
    throw new UpgradeError(code, "upgrade inspect", false, undefined, this.details());
  }
}

/**
 * A stored text for the operator's terminal: every C0 and C1 control character,
 * DEL, the bidirectional overrides and isolates and the line and paragraph
 * separators are written as `\u{hex}`, and a backslash as `\\`, so the escape is
 * unambiguous. Longer values are cut at `limit` code points and end with `…`.
 * A value that is not text is shown as null.
 */
export function escapeDisplay(value: unknown, limit = 200): string | null {
  if (typeof value !== "string") return null;
  const points = [...value];
  const shown = points.slice(0, limit).map(point => {
    const code = point.codePointAt(0)!;
    if (point === "\\") return "\\\\";
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      || code === 0x2028 || code === 0x2029 || code === 0x200e || code === 0x200f || code === 0x061c) return `\\u{${code.toString(16)}}`;
    return point;
  }).join("");
  return points.length > limit ? `${shown}…` : shown;
}

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
    return `{${entries.sort(([a], [b]) => compareText(a, b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new UpgradeError("upgrade_plan_invalid", "upgrade inspect");
}
/** UTF-16 code unit order, the order of canonical keys and of every sorted list in a plan. */
export function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/**
 * The plan is read whole into memory by finite offline maintenance only. 8 MiB
 * matches the backup manifest bound (`BACKUP_LIMITS.manifestBytes`), which
 * already holds 50 000 entries; a project mapping is one act per registration
 * or remote identity (and one per created project), each a few hundred bytes,
 * with a bounded review entry beside it. A larger installation is refused,
 * never truncated.
 */
export const UPGRADE_PLAN_LIMITS = { bytes: 8 * 1024 * 1024, acts: 50_000, depth: 16, temporaries: 64 } as const;

export interface UpgradeAct { kind: string; payload: unknown }
/**
 * Facts every act sees during execution, inside the one schema transaction:
 * the plan's source and target, its hash, this run's receipt and one time for
 * the whole run. Acts must not depend on anything outside these, the plan and
 * the database.
 */
export interface UpgradeActContext { source: number; target: number; planHash: string; receipt: string; at: string }
/**
 * Where a domain's proposal runs: `schemaVersion` is the schema of the
 * connection it reads (the source at inspect and in the pre-check, the target
 * inside the schema transaction), `source` and `target` are the plan's.
 */
export interface UpgradeProposalContext { schemaVersion: number; source: number; target: number }
/**
 * One kind of data act:
 * - `payload` is the strict schema of one act's data; the plan carries it, and
 *   the plan hash covers it like every other field (values must be strings,
 *   safe integers, booleans, null, arrays or objects of those);
 * - `execute` runs inside the one schema transaction after the structural
 *   steps, at the target, with foreign keys off (see `initializeSchema`); it
 *   re-checks its own preconditions and throws on a mismatch, must leave no
 *   violation and must not write `upgrade_marker`.
 */
export interface UpgradeActKind<Payload = unknown> {
  readonly kind: string;
  readonly payload: z.ZodType<Payload>;
  execute(database: Database.Database, payload: Payload, context: UpgradeActContext): void;
}
/**
 * A domain of data acts: one planner and its act kinds. The plan stores the
 * domain's normalised decisions and its review under its `name`, and its acts
 * in the plan's act list, after the acts of every earlier domain of the
 * registry. A domain applies only from `minimumTarget` on.
 *
 * - `decisionKeys` are the operator's input keys this domain owns; `normalise`
 *   validates that input strictly (shape and bounds only, no database) and
 *   returns the stored form; `decisions` is the stored form's strict schema.
 * - `propose` is the single proposal pass. It reads the database at
 *   `context.schemaVersion` and must give the same result at the source schema
 *   and at the target inside the schema transaction. It returns the domain's
 *   acts in execution order and its review, or throws an `UpgradeError`
 *   refusal (a stop or an invalid decision). `prior` is the act list of an
 *   earlier plan whose generated values may be reused; with `fresh` false
 *   nothing may be generated, so a replay of a plan reproduces it or refuses.
 * - `describe` gives the operator's lines from the acts and the review; it
 *   carries no secret.
 */
export interface UpgradeActDomain<Decisions = unknown, Review = unknown> {
  readonly name: string;
  readonly minimumTarget: number;
  readonly decisionKeys: readonly string[];
  readonly decisions: z.ZodType<Decisions>;
  readonly review: z.ZodType<Review>;
  readonly kinds: ReadonlyArray<UpgradeActKind>;
  normalise(input: Record<string, unknown>): Decisions;
  propose(database: Database.Database, context: UpgradeProposalContext, decisions: Decisions, prior: readonly UpgradeAct[] | null, fresh: boolean): { acts: UpgradeAct[]; review: Review };
  describe(acts: readonly UpgradeAct[], review: Review): string[];
}
