import type { KnowledgeTaskStatus } from "@/shared/contracts/knowledge";
import type {
  TaskCurrentState, TaskStateAssessment, TaskStateAuthenticationMethod, TaskStateChanges, TaskStateFinding, TaskStateSource, TaskOwnerConsent,
} from "@/shared/contracts/knowledge-task-state";

/**
 * Authentication methods whose approval counts as owner consent.
 * Owner decision 2026-10-27: owner and agents currently share the installation
 * token, so it counts as the owner. Remove "installation_token" once agents
 * receive their own credentials; stored approvals keep their recorded method.
 */
export const OWNER_CONSENT_METHODS: ReadonlySet<TaskStateAuthenticationMethod> = new Set(["owner_session", "installation_token"]);

/** Read-time facts collected by the store with bounded, indexed queries. */
export interface TaskStateFacts {
  changes: Omit<TaskStateChanges, "taskRevisions" | "statusChanged">;
  /** Evidence attachment IDs that exist on this task. */
  presentAttachments: ReadonlySet<string>;
  /** The decision memory referenced by `ownerDecision.recorded`, when it exists. */
  decision: { approvedAtCurrentRevision: boolean; matchesReferencedRevision: boolean; approvalMethod: TaskStateAuthenticationMethod | null; everApproved: boolean } | null;
}

const short = (commit: string) => commit.slice(0, 7);
const POSITIVE = new Set(["merged", "passed", "findings_closed", "stored", "verified", "done"]);

export function assessTaskState(task: { status: KnowledgeTaskStatus; revision: number }, state: TaskCurrentState | null, facts: TaskStateFacts,
  accepted: ReadonlySet<TaskStateAuthenticationMethod> = OWNER_CONSENT_METHODS): TaskStateAssessment {
  const noChanges: TaskStateChanges = { taskRevisions: 0, statusChanged: false, descriptionChanged: false, memoriesChanged: 0, attachmentsAdded: 0, repliesAdded: 0, staleSources: 0, inactiveSources: 0 };
  if (!state) return { freshness: "missing", changes: noChanges, changeCount: 0, findings: [], ownerConsent: "unknown", approvalMethod: null, evidence: null };

  const changes: TaskStateChanges = { ...facts.changes, taskRevisions: Math.max(0, task.revision - state.taskRevision), statusChanged: task.status !== state.statusAtWrite };
  const changeCount = changes.taskRevisions + changes.memoriesChanged + changes.attachmentsAdded + changes.repliesAdded + changes.staleSources + changes.inactiveSources;
  const findings: TaskStateFinding[] = [];
  const add = (code: TaskStateFinding["code"], severity: TaskStateFinding["severity"], fields: string[], values: Record<string, string> = {}) =>
    findings.push({ code, severity, fields, values });

  const open = (Array.isArray(state.blockers) ? state.blockers : []).filter(blocker => blocker.state === "open");
  if (task.status === "done" && open.length) add("done_with_open_blocker", "conflict", ["status", `blockers.${open[0].key}`], { blocker: open[0].text });
  if (task.status === "blocked" && Array.isArray(state.blockers) && !open.length) add("blocked_without_blocker", "conflict", ["status", "blockers"]);
  if (open.length && task.status !== "blocked" && task.status !== "done") add("open_blocker_not_blocked", "attention", ["status", `blockers.${open[0].key}`], { blocker: open[0].text, status: task.status });

  const { merge, ci, deploy, evidence } = state.delivery;
  const mergeFact = "applies" in merge && merge.applies ? merge : null;
  const ciFact = "applies" in ci && ci.applies ? ci : null;
  const deployFact = "applies" in deploy && deploy.applies ? deploy : null;
  if (deployFact?.state === "done" && mergeFact && mergeFact.state !== "merged") add("deploy_without_merge", "conflict", ["delivery.deploy", "delivery.merge"]);
  if (ciFact?.commit && mergeFact?.commit && ciFact.commit !== mergeFact.commit) add("ci_not_merged_head", "attention", ["delivery.ci", "delivery.merge"], { ci: short(ciFact.commit), merged: short(mergeFact.commit) });
  if (deployFact?.commit && mergeFact?.commit && deployFact.commit !== mergeFact.commit && deployFact.commit !== mergeFact.resultCommit) {
    add("deploy_not_merged_head", "attention", ["delivery.deploy", "delivery.merge"], { deployed: short(deployFact.commit), merged: short(mergeFact.commit) });
  }

  let evidenceSummary: TaskStateAssessment["evidence"] = null;
  if ("applies" in evidence && evidence.applies && evidence.attachments) {
    const missing = evidence.attachments.filter(id => !facts.presentAttachments.has(id));
    evidenceSummary = { listed: evidence.attachments.length, present: evidence.attachments.length - missing.length, missing };
    for (const id of missing) add("evidence_missing", "conflict", ["delivery.evidence"], { attachment: id });
  }

  if (state.outcome.known && !state.outcome.sources.length) add("claim_without_source", "attention", ["outcome"]);
  for (const stage of ["merge", "ci", "review", "evidence", "deploy"] as const) {
    const value = state.delivery[stage];
    if (!("applies" in value) || !value.applies || !POSITIVE.has(value.state)) continue;
    if (!value.sources.length && !(value.attachments?.length)) add("claim_without_source", "attention", [`delivery.${stage}`]);
  }
  if (changes.staleSources) add("source_stale", "attention", ["sources"], { count: String(changes.staleSources) });
  if (changes.inactiveSources) add("source_inactive", "attention", ["sources"], { count: String(changes.inactiveSources) });

  let ownerConsent: TaskOwnerConsent;
  let approvalMethod: TaskStateAuthenticationMethod | null = null;
  const decision = state.ownerDecision;
  if (decision.state === "recorded") {
    const memory = facts.decision;
    if (memory?.approvedAtCurrentRevision && memory.matchesReferencedRevision) {
      approvalMethod = memory.approvalMethod;
      ownerConsent = approvalMethod && accepted.has(approvalMethod) ? "approved" : "approved_method_not_accepted";
      if (ownerConsent === "approved_method_not_accepted") add("consent_method_not_accepted", "attention", ["ownerDecision"], { method: approvalMethod ?? "unknown" });
    } else {
      ownerConsent = memory?.everApproved ? "approval_invalidated" : "proposal_only";
      add("consent_missing", "attention", ["ownerDecision"]);
    }
  } else ownerConsent = decision.state;

  if (task.status === "done" && "action" in state.nextStep) add("next_step_on_done", "attention", ["status", "nextStep"]);

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "conflict" ? -1 : 1));
  return { freshness: changeCount === 0 ? "current" : "changed_since", changes, changeCount, findings, ownerConsent, approvalMethod, evidence: evidenceSummary };
}

/** Every source in a state, in reading order, without duplicates. */
export function taskStateSources(state: TaskStateInputLike): TaskStateSource[] {
  const all: TaskStateSource[] = [];
  if (state.outcome.known) all.push(...state.outcome.sources);
  for (const blocker of Array.isArray(state.blockers) ? state.blockers : []) all.push(...blocker.sources);
  if ("sources" in state.nextStep) all.push(...state.nextStep.sources);
  for (const stage of ["merge", "ci", "review", "evidence", "deploy"] as const) {
    const value = state.delivery[stage];
    if ("applies" in value && value.applies) all.push(...value.sources);
  }
  const seen = new Set<string>();
  return all.filter(source => {
    const key = JSON.stringify(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
type TaskStateInputLike = Pick<TaskCurrentState, "outcome" | "blockers" | "nextStep" | "delivery">;
