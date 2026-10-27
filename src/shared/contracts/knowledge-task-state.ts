import { z } from "zod";
import type { KnowledgeTaskStatus, KnowledgeTaskSummary } from "./knowledge";

const id = z.string().trim().min(1).max(160);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const revision = z.number().int().positive();
const time = z.string().datetime({ offset: true });
const commit = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);

export const taskStateActorSchema = z.enum(["owner", "agent", "operator", "external"]);
export const taskStateSourceSchema = z.union([
  z.strictObject({ kind: z.enum(["thread", "reply", "task", "memory"]), id, revision }),
  z.strictObject({ kind: z.literal("attachment"), id }),
  z.strictObject({ kind: z.literal("external"), label: text(200), url: z.string().url().max(2048).refine(value => /^https?:\/\//i.test(value)) }),
  z.strictObject({ kind: z.literal("repository"), sourceId: id, repository: text(4096), commit: z.string().regex(/^[a-f0-9]{40}$/), path: text(4096) }),
]);
const sources = z.array(taskStateSourceSchema).max(20);
const unknown = z.strictObject({ known: z.literal(false), reason: text(200).optional() });
const memoryRef = z.strictObject({ id, revision });

const blocker = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  text: text(200),
  unblockedBy: taskStateActorSchema,
  condition: text(200),
  since: time,
  state: z.enum(["open", "resolved"]),
  resolvedAt: time.optional(),
  resolution: text(200).optional(),
  sources,
}).refine(value => (value.state === "resolved") === (value.resolvedAt !== undefined && value.resolution !== undefined), { message: "Resolved blockers need resolvedAt and resolution; open blockers must not have them." });

/** One delivery stage. `applies: false` means not applicable; `known: false` means nobody has recorded it. */
const fact = <const S extends readonly [string, ...string[]]>(states: S) => z.union([
  z.strictObject({
    applies: z.literal(true),
    state: z.enum(states),
    commit: commit.optional(),
    resultCommit: commit.optional(),
    target: text(80).optional(),
    detail: text(200).optional(),
    openFindings: z.number().int().min(0).max(10000).optional(),
    attachments: z.array(id).max(50).optional(),
    observedAt: time,
    sources,
  }),
  z.strictObject({ applies: z.literal(false) }),
  unknown,
]);

export const taskDeliverySchema = z.strictObject({
  merge: fact(["not_started", "pr_open", "merged", "closed_unmerged"]),
  ci: fact(["not_run", "running", "passed", "failed"]),
  review: fact(["not_requested", "in_progress", "findings_open", "findings_closed"]),
  evidence: fact(["none", "stored", "verified"]),
  deploy: fact(["not_planned", "pending", "done", "failed"]),
});

export const taskOwnerDecisionSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("not_needed") }),
  z.strictObject({ state: z.literal("needed"), question: text(500), options: z.array(text(200)).max(5).optional(), proposalRef: memoryRef.optional() }),
  z.strictObject({ state: z.literal("recorded"), decisionRef: memoryRef }),
  z.strictObject({ state: z.literal("unknown"), reason: text(200).optional() }),
]);

/** What a writer submits. Consent is never writable: `recorded` only points to a decision memory. */
export const taskStateInputSchema = z.strictObject({
  declaredBy: text(120).nullable().optional(),
  changeNote: text(280),
  outcome: z.union([z.strictObject({ known: z.literal(true), text: text(280), sources }), unknown]),
  blockers: z.array(blocker).max(10).refine(items => new Set(items.map(item => item.key)).size === items.length, { message: "Blocker keys must be unique." }),
  nextStep: z.union([
    z.strictObject({ known: z.literal(true), none: z.literal(true) }),
    z.strictObject({ known: z.literal(true), action: text(280), actor: taskStateActorSchema, sources }),
    unknown,
  ]),
  ownerDecision: taskOwnerDecisionSchema,
  delivery: taskDeliverySchema,
});

const authenticationMethod = z.enum(["owner_session", "agent_token", "worker_token", "installation_token", "none"]);
/** The stored form adds server-owned fields. */
export const taskCurrentStateSchema = taskStateInputSchema.safeExtend({
  formatVersion: z.literal(1),
  taskRevision: revision,
  statusAtWrite: z.enum(["open", "in_progress", "blocked", "done", "archived"]),
  writtenAt: time,
  writtenBy: z.strictObject({ principalId: id, authenticationMethod }),
});

export type TaskStateActor = z.infer<typeof taskStateActorSchema>;
export type TaskStateSource = z.infer<typeof taskStateSourceSchema>;
export type TaskStateInput = z.infer<typeof taskStateInputSchema>;
export type TaskCurrentState = z.infer<typeof taskCurrentStateSchema>;
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;
export type TaskDeliveryStage = keyof TaskDelivery;
export type TaskStateAuthenticationMethod = z.infer<typeof authenticationMethod>;

/** Serialized stored state, bounded independently of the 64 KiB request limit. */
export const TASK_STATE_MAX_BYTES = 16 * 1024;
/** Unique sources across one state, bounding read-time source checks. */
export const TASK_STATE_MAX_SOURCES = 60;

export type TaskStateFindingCode =
  | "done_with_open_blocker" | "blocked_without_blocker" | "open_blocker_not_blocked"
  | "deploy_without_merge" | "ci_not_merged_head" | "deploy_not_merged_head"
  | "evidence_missing" | "claim_without_source" | "source_stale" | "source_inactive"
  | "consent_missing" | "consent_method_not_accepted" | "next_step_on_done";

export interface TaskStateFinding {
  code: TaskStateFindingCode;
  severity: "conflict" | "attention";
  /** Field paths in the state, e.g. "delivery.ci" or "blockers.ci-runner". */
  fields: string[];
  /** Plain values for the message, such as short commits; never HTML. */
  values: Record<string, string>;
}

export type TaskOwnerConsent = "not_needed" | "needed" | "unknown" | "proposal_only" | "approved" | "approved_method_not_accepted" | "approval_invalidated";

export interface TaskStateChanges {
  taskRevisions: number;
  statusChanged: boolean;
  descriptionChanged: boolean;
  memoriesChanged: number;
  attachmentsAdded: number;
  repliesAdded: number;
  staleSources: number;
  inactiveSources: number;
}

export interface TaskStateAssessment {
  freshness: "missing" | "current" | "changed_since";
  changes: TaskStateChanges;
  /** Sum shown to readers; status and description changes explain task revisions rather than adding to them. */
  changeCount: number;
  findings: TaskStateFinding[];
  ownerConsent: TaskOwnerConsent;
  approvalMethod: TaskStateAuthenticationMethod | null;
  evidence: { listed: number; present: number; missing: string[] } | null;
}

export interface KnowledgeTaskStateView {
  task: KnowledgeTaskSummary;
  state: TaskCurrentState | null;
  /** True when a stored state exists but fails validation; it is never shown as missing. */
  stateUnreadable: boolean;
  assessment: TaskStateAssessment;
  /** Facts known to the system without a recorded state. */
  systemFacts: { approvedDecisions: number; proposals: number; openQuestions: number; attachments: number };
}

export type { KnowledgeTaskStatus };
