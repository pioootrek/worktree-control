import { describe, expect, it } from "vitest";
import type { TaskCurrentState } from "@/shared/contracts/knowledge-task-state";
import { assessTaskState, OWNER_CONSENT_METHODS, taskStateSources, type TaskStateFacts } from "./task-state-assessment";

const at = "2026-10-27T10:00:00.000Z";
const HEAD = "a".repeat(40), OTHER = "b".repeat(40), MAIN = "c".repeat(40);
const pr = { kind: "external" as const, label: "PR", url: "https://example.invalid/pr/1" };
const facts = (patch: Partial<TaskStateFacts> = {}): TaskStateFacts => ({
  changes: { descriptionChanged: false, memoriesChanged: 0, attachmentsAdded: 0, repliesAdded: 0, staleSources: 0, inactiveSources: 0 },
  presentAttachments: new Set(["att-1"]), decision: null, ...patch,
});
function state(patch: Partial<TaskCurrentState> = {}): TaskCurrentState {
  return {
    formatVersion: 1, taskRevision: 4, statusAtWrite: "in_progress", writtenAt: at, writtenBy: { principalId: "agent", authenticationMethod: "agent_token" },
    changeNote: "note", outcome: { known: true, text: "Merged", sources: [pr] }, blockers: [],
    nextStep: { known: true, action: "Deploy", actor: "owner", sources: [] }, ownerDecision: { state: "not_needed" },
    delivery: {
      merge: { applies: true, state: "merged", commit: HEAD, resultCommit: MAIN, observedAt: at, sources: [pr] },
      ci: { applies: true, state: "passed", commit: HEAD, observedAt: at, sources: [pr] },
      review: { applies: true, state: "findings_closed", openFindings: 0, observedAt: at, sources: [pr] },
      evidence: { applies: true, state: "verified", attachments: ["att-1"], observedAt: at, sources: [] },
      deploy: { applies: true, state: "pending", observedAt: at, sources: [] },
    },
    ...patch,
  };
}
const codes = (value: ReturnType<typeof assessTaskState>) => value.findings.map(finding => `${finding.severity}:${finding.code}`);
const task = { status: "in_progress" as const, revision: 4 };
const blocker = { key: "b", text: "Blocked", unblockedBy: "owner" as const, condition: "Decide", since: at, state: "open" as const, sources: [] };

describe("task state assessment", () => {
  it("reports a missing state without inventing facts", () => {
    expect(assessTaskState(task, null, facts())).toMatchObject({ freshness: "missing", changeCount: 0, findings: [], ownerConsent: "unknown", evidence: null });
  });

  it("keeps a sourced merge-without-deployment state current and free of findings", () => {
    expect(assessTaskState(task, state(), facts())).toMatchObject({ freshness: "current", findings: [], ownerConsent: "not_needed", evidence: { listed: 1, present: 1, missing: [] } });
  });

  it("orders conflicts first and names each contradiction", () => {
    const value = assessTaskState({ status: "done", revision: 4 }, state({
      blockers: [blocker], outcome: { known: true, text: "Done", sources: [] },
      delivery: { ...state().delivery, ci: { applies: true, state: "passed", commit: OTHER, observedAt: at, sources: [pr] }, evidence: { applies: true, state: "stored", attachments: ["att-9"], observedAt: at, sources: [] } },
    }), facts());
    expect(codes(value)).toEqual(["conflict:done_with_open_blocker", "conflict:evidence_missing", "attention:ci_not_merged_head", "attention:claim_without_source", "attention:next_step_on_done"]);
    expect(value.findings.find(item => item.code === "ci_not_merged_head")?.values).toEqual({ ci: "bbbbbbb", merged: "aaaaaaa" });
  });

  it("separates blocked status from open blockers", () => {
    expect(codes(assessTaskState({ status: "blocked", revision: 4 }, state(), facts()))).toEqual(["conflict:blocked_without_blocker"]);
    expect(codes(assessTaskState(task, state({ blockers: [blocker] }), facts()))).toEqual(["attention:open_blocker_not_blocked"]);
    expect(codes(assessTaskState({ status: "blocked", revision: 4 }, state({ blockers: [blocker] }), facts()))).toEqual([]);
  });

  it("distinguishes unknown blockers from a known empty list", () => {
    const unknown = state({ blockers: { known: false, reason: "Not checked yet" } });
    expect(codes(assessTaskState({ status: "blocked", revision: 4 }, unknown, facts()))).toEqual([]);
    expect(taskStateSources(unknown)).toEqual([pr]);
    expect(codes(assessTaskState({ status: "blocked", revision: 4 }, state({ blockers: [] }), facts()))).toEqual(["conflict:blocked_without_blocker"]);
  });

  it("keeps deployment separate from merge", () => {
    const deployed = state({ delivery: { ...state().delivery, merge: { applies: true, state: "pr_open", commit: HEAD, observedAt: at, sources: [pr] }, deploy: { applies: true, state: "done", commit: MAIN, observedAt: at, sources: [pr] } } });
    expect(codes(assessTaskState(task, deployed, facts()))).toEqual(["conflict:deploy_without_merge", "attention:deploy_not_merged_head"]);
    const mainDeployed = state({ delivery: { ...state().delivery, deploy: { applies: true, state: "done", commit: MAIN, observedAt: at, sources: [pr] } } });
    expect(codes(assessTaskState(task, mainDeployed, facts()))).toEqual([]);
    const unsourced = state({ delivery: { ...state().delivery, deploy: { applies: true, state: "done", commit: HEAD, observedAt: at, sources: [] } } });
    expect(codes(assessTaskState(task, unsourced, facts()))).toEqual(["attention:claim_without_source"]);
  });

  it("counts changes since the summary, with status and description explaining task revisions", () => {
    const value = assessTaskState({ status: "done", revision: 6 }, state({ nextStep: { known: true, none: true } }), facts({ changes: { descriptionChanged: true, memoriesChanged: 1, attachmentsAdded: 0, repliesAdded: 2, staleSources: 1, inactiveSources: 1 } }));
    expect(value).toMatchObject({ freshness: "changed_since", changeCount: 7, changes: { taskRevisions: 2, statusChanged: true, descriptionChanged: true } });
    expect(codes(value)).toEqual(["attention:source_stale", "attention:source_inactive"]);
  });

  it("derives consent from approval and the accepted authentication methods", () => {
    const recorded = state({ ownerDecision: { state: "recorded", decisionRef: { id: "m", revision: 2 } } });
    expect(assessTaskState(task, recorded, facts())).toMatchObject({ ownerConsent: "proposal_only" });
    expect(assessTaskState(task, recorded, facts({ decision: { approvedAtCurrentRevision: false, approvalMethod: null, everApproved: true } }))).toMatchObject({ ownerConsent: "approval_invalidated" });
    const installation = facts({ decision: { approvedAtCurrentRevision: true, approvalMethod: "installation_token", everApproved: true } });
    expect(OWNER_CONSENT_METHODS.has("installation_token")).toBe(true);
    expect(assessTaskState(task, recorded, installation)).toMatchObject({ ownerConsent: "approved", approvalMethod: "installation_token", findings: [] });
    const separated = assessTaskState(task, recorded, installation, new Set(["owner_session"]));
    expect(separated).toMatchObject({ ownerConsent: "approved_method_not_accepted", approvalMethod: "installation_token" });
    expect(codes(separated)).toEqual(["attention:consent_method_not_accepted"]);
    expect(assessTaskState(task, state({ ownerDecision: { state: "needed", question: "A or B?" } }), facts())).toMatchObject({ ownerConsent: "needed" });
  });

  it("lists unique sources in reading order", () => {
    expect(taskStateSources(state())).toEqual([pr]);
  });
});
