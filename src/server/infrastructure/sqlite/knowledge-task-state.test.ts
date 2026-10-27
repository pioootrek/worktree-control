import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeAttachmentService, KnowledgeService } from "@/server/modules/knowledge";
import { parseKnowledgeProjectSnapshot } from "@/server/modules/knowledge/project-transfer-schema";
import type { KnowledgeHistoryEntry, KnowledgeMutationResult, KnowledgeOperation, KnowledgePage, KnowledgeTask } from "@/shared/contracts/knowledge";
import type { KnowledgeMemory } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeTaskStateView, TaskCurrentState, TaskStateInput } from "@/shared/contracts/knowledge-task-state";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const HEAD = "a31f92c5e0d1b7f4c2a9e8d6b5c4a3f2e1d0c9b8";
const MAIN = "c672be1a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c";
const at = "2026-10-27T10:00:00.000Z";
const pr = { kind: "external" as const, label: "PR #112", url: "https://example.invalid/pr/112" };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-task-state-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite3");
  const store = new SqliteStateStore(path); cleanups.push(() => store.close());
  const identity = new IdentityService(store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = identity.createKnowledgeProject({ name: "State" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:approve", "attachments:read", "attachments:write"] }, owner);
  const agentPrincipal = identity.createAgent(owner);
  identity.setKnowledgeGrant({ principalId: agentPrincipal.id, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "attachments:read", "attachments:write"] }, owner);
  const agent = identity.authenticateBearer(identity.issueAgentToken({ principalId: agentPrincipal.id, label: "test" }, owner).token);
  const reader = identity.createAgent(owner);
  identity.setKnowledgeGrant({ principalId: reader.id, projectId: project.id, permissions: ["knowledge:read"] }, owner);
  const readOnly = identity.authenticateBearer(identity.issueAgentToken({ principalId: reader.id, label: "reader" }, owner).token);
  const changed = vi.fn();
  let tick = 0;
  const clock = () => new Date(Date.parse(at) + 1000 * ++tick).toISOString();
  const service = new KnowledgeService(store, identity, clock, undefined, changed, new KnowledgeAttachmentService(store, identity, join(directory, "attachments"), undefined, clock));
  const call = <T>(operation: KnowledgeOperation, input: Record<string, unknown> = {}, who = agent): T => service.execute({ operation, input: { projectId: project.id, ...input } }, who) as T;
  const task = call<KnowledgeMutationResult<KnowledgeTask>>("create_task", { title: "Export CSV", description: "Deliver CSV export", idempotencyKey: "task" }).value;
  const read = (who = agent) => call<KnowledgeTaskStateView>("task_state", { taskId: task.id }, who);
  const current = () => call<KnowledgeTask>("task", { taskId: task.id });
  const write = (state: TaskStateInput, extra: Record<string, unknown> = {}, who = agent) =>
    call<KnowledgeMutationResult<{ task: KnowledgeTask; state: TaskCurrentState }>>("update_task_state", { taskId: task.id, expectedRevision: current().revision, idempotencyKey: `state-${current().revision}`, state, ...extra }, who);
  return { path, store, identity, owner, agent, readOnly, project, service, changed, call, task, read, current, write };
}

function mergedNotDeployed(evidence: string[] = []): TaskStateInput {
  return {
    declaredBy: "codex · T3", changeNote: "PR #112 merged; blocker: none; next: owner — schedule deployment; decision: none",
    outcome: { known: true, text: "Merged to main; production deployment is a separate stage.", sources: [pr] },
    blockers: [{ key: "ci-runner", text: "CI runner cannot reach the test database", unblockedBy: "operator", condition: "Restore the secret", since: at, state: "resolved", resolvedAt: at, resolution: "Secret restored", sources: [] }],
    nextStep: { known: true, action: "Schedule the production deployment window", actor: "owner", sources: [] },
    ownerDecision: { state: "not_needed" },
    delivery: {
      merge: { applies: true, state: "merged", commit: HEAD, resultCommit: MAIN, observedAt: at, sources: [pr] },
      ci: { applies: true, state: "passed", commit: HEAD, observedAt: at, sources: [pr] },
      review: { applies: true, state: "findings_closed", openFindings: 0, observedAt: at, sources: [pr] },
      evidence: evidence.length ? { applies: true, state: "verified", attachments: evidence, observedAt: at, sources: [] } : { known: false },
      deploy: { applies: true, state: "pending", target: "production", observedAt: at, sources: [] },
    },
  };
}

describe("task current state", () => {
  it("adds the nullable column through migration 33 and reports a missing state honestly", () => {
    const f = setup();
    const database = new Database(f.path, { readonly: true });
    try {
      expect(database.prepare("SELECT max(version) AS version, name FROM schema_migrations WHERE version = 33").get()).toEqual({ version: 33, name: "knowledge-task-current-state" });
      expect((database.prepare("PRAGMA table_info(knowledge_tasks)").all() as Array<{ name: string; notnull: number }>).find(column => column.name === "current_state_json")).toMatchObject({ notnull: 0 });
    } finally { database.close(); }
    const view = f.read(f.readOnly);
    expect(view.state).toBeNull();
    expect(view.stateUnreadable).toBe(false);
    expect(view.assessment).toMatchObject({ freshness: "missing", findings: [], ownerConsent: "unknown" });
    expect(view.systemFacts).toEqual({ approvedDecisions: 0, proposals: 0, openQuestions: 0, attachments: 0 });
    expect(view.task).not.toHaveProperty("description");
  });

  it("writes state and status atomically, keeps the previous state in history and replays identical retries", () => {
    const f = setup();
    const evidence = f.call<KnowledgeMutationResult<{ id: string }>>("create_attachment", { recordKind: "task", recordId: f.task.id, filename: "report.json", mediaType: "application/json", dataBase64: Buffer.from("{}").toString("base64"), idempotencyKey: "evidence" }).value;
    const first = f.write(mergedNotDeployed([evidence.id]));
    expect(first.value.task).toMatchObject({ revision: 2, status: "open" });
    expect(first.value.state).toMatchObject({ formatVersion: 1, taskRevision: 2, statusAtWrite: "open", writtenBy: { principalId: f.agent.principalId, authenticationMethod: "agent_token" } });
    const retry = f.call<KnowledgeMutationResult<unknown>>("update_task_state", { taskId: f.task.id, expectedRevision: 1, idempotencyKey: "state-1", state: mergedNotDeployed([evidence.id]) });
    expect(retry.replayed).toBe(true);
    expect(f.changed).toHaveBeenCalledTimes(3);

    const blocked = mergedNotDeployed([evidence.id]);
    blocked.blockers.push({ key: "staging-health", text: "Staging /health returns 503", unblockedBy: "operator", condition: "Restore DATABASE_URL", since: at, state: "open", sources: [] });
    blocked.delivery.deploy = { applies: true, state: "failed", target: "staging", commit: MAIN, observedAt: at, sources: [] };
    const second = f.write(blocked, { status: "blocked" });
    expect(second.value.task).toMatchObject({ revision: 3, status: "blocked" });
    expect(f.current()).toMatchObject({ status: "blocked", description: "Deliver CSV export" });

    const history = f.call<KnowledgePage<KnowledgeHistoryEntry>>("history", { recordKind: "task", recordId: f.task.id });
    const previous = JSON.parse(history.items.at(-1)!.previousJson!) as { status: string; currentState: TaskCurrentState };
    expect(previous.status).toBe("open");
    expect(previous.currentState.delivery.deploy).toMatchObject({ state: "pending" });

    const view = f.read(f.readOnly);
    expect(view.assessment).toMatchObject({ freshness: "current", changeCount: 0, ownerConsent: "not_needed", evidence: { listed: 1, present: 1, missing: [] } });
    expect(view.assessment.findings).toEqual([]);
    expect(view.systemFacts.attachments).toBe(1);
  });

  it("rejects stale revisions, read-only writers and structural errors without contradiction checks", () => {
    const f = setup();
    expect(() => f.call("update_task_state", { taskId: f.task.id, expectedRevision: 9, idempotencyKey: "stale", state: mergedNotDeployed() })).toThrowError(expect.objectContaining({ code: "revision_conflict", currentRevision: 1 }));
    expect(() => f.write(mergedNotDeployed(), {}, f.readOnly)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    const self = mergedNotDeployed();
    self.outcome = { known: true, text: "Self", sources: [{ kind: "task", id: f.task.id, revision: 1 }] };
    expect(() => f.write(self)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    const closed = mergedNotDeployed();
    closed.delivery.review = { applies: true, state: "findings_closed", openFindings: 2, observedAt: at, sources: [] };
    expect(() => f.write(closed)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    const otherTask = f.call<KnowledgeMutationResult<KnowledgeTask>>("create_task", { title: "Other", description: "Other", idempotencyKey: "other" }).value;
    const foreign = f.call<KnowledgeMutationResult<{ id: string }>>("create_attachment", { recordKind: "task", recordId: otherTask.id, filename: "x.txt", mediaType: "text/plain", dataBase64: Buffer.from("x").toString("base64"), idempotencyKey: "foreign" }).value;
    expect(() => f.write(mergedNotDeployed([foreign.id]))).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    const note = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { title: "Note", body: "Not a decision", category: "note", tags: [], legacyId: null, sources: [{ kind: "task", id: otherTask.id, revision: 1 }], idempotencyKey: "note" }).value;
    const recorded = mergedNotDeployed();
    recorded.ownerDecision = { state: "recorded", decisionRef: { id: note.id, revision: note.revision } };
    expect(() => f.write(recorded)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    // A contradiction is accepted and reported on read.
    const contradictory = mergedNotDeployed();
    contradictory.blockers.push({ key: "headers", text: "Header format not approved", unblockedBy: "owner", condition: "Owner chooses", since: at, state: "open", sources: [] });
    f.write(contradictory, { status: "done" });
    expect(f.read().assessment.findings.map(finding => finding.code)).toEqual(["done_with_open_blocker", "next_step_on_done"]);
    expect(f.current().revision).toBe(2);
  });

  it("reports later task, memory, attachment and reply changes plus superseded sources", () => {
    const f = setup();
    const thread = f.call<KnowledgeMutationResult<{ id: string }>>("create_thread", { title: "Discussion", body: "Start", idempotencyKey: "thread" }).value;
    const derived = f.call<KnowledgeMutationResult<{ task: KnowledgeTask }>>("task_from_thread", { threadId: thread.id, title: "Derived", description: "From thread", idempotencyKey: "derived" }).value.task;
    const finding = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { title: "Date format", body: "ISO without zone", category: "decision", tags: [], legacyId: null, sources: [{ kind: "task", id: derived.id, revision: derived.revision }], idempotencyKey: "finding" }).value;
    const state = mergedNotDeployed();
    state.outcome = { known: true, text: "Merged", sources: [{ kind: "memory", id: finding.id, revision: finding.revision }] };
    const writeDerived = (input: TaskStateInput, extra: Record<string, unknown> = {}) => {
      const task = f.call<KnowledgeTask>("task", { taskId: derived.id });
      return f.call("update_task_state", { taskId: derived.id, expectedRevision: task.revision, idempotencyKey: `derived-${task.revision}`, state: input, ...extra });
    };
    writeDerived(state);
    const read = () => f.call<KnowledgeTaskStateView>("task_state", { taskId: derived.id });
    expect(read().assessment.freshness).toBe("current");

    const task = f.call<KnowledgeTask>("task", { taskId: derived.id });
    f.call("update_task", { taskId: derived.id, expectedRevision: task.revision, idempotencyKey: "edit", title: task.title, description: "Edited later", priority: task.priority, status: "done" });
    f.call("create_reply", { threadId: thread.id, body: "Later reply", idempotencyKey: "reply" });
    f.call("create_attachment", { recordKind: "task", recordId: derived.id, filename: "late.txt", mediaType: "text/plain", dataBase64: Buffer.from("late").toString("base64"), idempotencyKey: "late" });
    const replacement = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { title: "Date format", body: "ISO with zone", category: "decision", tags: [], legacyId: null, sources: [{ kind: "thread", id: thread.id, revision: 1 }], idempotencyKey: "replacement" }).value;
    f.call("supersede_memory", { memoryId: finding.id, expectedRevision: finding.revision, replacementId: replacement.id, replacementRevision: replacement.revision, idempotencyKey: "supersede" }, f.owner);

    const view = read();
    expect(view.assessment.changes).toEqual({ taskRevisions: 1, statusChanged: true, descriptionChanged: true, memoriesChanged: 1, attachmentsAdded: 1, repliesAdded: 1, staleSources: 0, inactiveSources: 1 });
    expect(view.assessment).toMatchObject({ freshness: "changed_since", changeCount: 5 });
    expect(view.assessment.findings.map(item => item.code)).toEqual(["source_inactive", "next_step_on_done"]);
  });

  it("derives consent from the approval and its authentication method", () => {
    const f = setup();
    // Approval revalidates sources; an external source keeps the decision independent of task revisions.
    const chat = { kind: "external" as const, label: "Owner conversation", url: "https://example.invalid/chat" };
    const decision = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { title: "Header variant B", body: "Use variant B", category: "decision", tags: [], legacyId: null, sources: [chat], idempotencyKey: "decision" }).value;
    const state = mergedNotDeployed();
    state.changeNote = "Agent: the owner agreed in chat (not confirmed)";
    state.ownerDecision = { state: "recorded", decisionRef: { id: decision.id, revision: decision.revision } };
    f.write(state);
    expect(f.read().assessment).toMatchObject({ ownerConsent: "proposal_only", approvalMethod: null });
    expect(f.read().assessment.findings.map(item => item.code)).toContain("consent_missing");
    expect(() => f.call("approve_memory", { memoryId: decision.id, expectedRevision: decision.revision, idempotencyKey: "agent-approve" })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));

    const approved = f.call<KnowledgeMutationResult<KnowledgeMemory>>("approve_memory", { memoryId: decision.id, expectedRevision: decision.revision, idempotencyKey: "approve" }, f.owner).value;
    expect(f.read().assessment).toMatchObject({ ownerConsent: "approved", approvalMethod: "owner_session" });
    // The approval advances the memory revision without changing the cited decision.
    expect(f.read().assessment.findings).toEqual([]);

    f.call("update_memory", { memoryId: decision.id, expectedRevision: approved.revision, idempotencyKey: "edit-decision", title: "Header variant B", body: "Use variant B with BOM", category: "decision", tags: [], legacyId: null, sources: [chat] }, f.owner);
    expect(f.read().assessment).toMatchObject({ ownerConsent: "approval_invalidated" });
  });

  it("keeps a task-citing decision approvable across state writes but not across task edits", () => {
    const f = setup();
    const cite = () => ({ kind: "task" as const, id: f.task.id, revision: f.current().revision });
    const cited = f.current().revision;
    const decision = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { title: "Header variant B", body: "Use variant B", category: "decision", tags: [], legacyId: null, sources: [cite()], idempotencyKey: "decision" }).value;
    const state = mergedNotDeployed();
    state.ownerDecision = { state: "recorded", decisionRef: { id: decision.id, revision: decision.revision } };
    f.write(state, { status: "in_progress" });
    state.changeNote = "Second write";
    f.write(state);
    expect(f.current().revision).toBe(cited + 2);
    expect(f.read().assessment).toMatchObject({ ownerConsent: "proposal_only" });

    const approved = f.call<KnowledgeMutationResult<KnowledgeMemory>>("approve_memory", { memoryId: decision.id, expectedRevision: decision.revision, idempotencyKey: "approve" }, f.owner).value;
    expect(f.read().assessment).toMatchObject({ ownerConsent: "approved", approvalMethod: "owner_session", findings: [] });
    // A new write cites the current revision; the approval-only revision is not reported as stale before that.
    state.ownerDecision = { state: "recorded", decisionRef: { id: decision.id, revision: approved.revision } };

    const proposal = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { title: "Footer", body: "Add a footer", category: "decision", tags: [], legacyId: null, sources: [cite()], idempotencyKey: "proposal" }).value;
    const task = f.current();
    f.call("update_task", { taskId: task.id, expectedRevision: task.revision, idempotencyKey: "edit", title: task.title, description: "Changed scope", priority: task.priority, status: task.status });
    f.write(state);
    expect(() => f.call("approve_memory", { memoryId: proposal.id, expectedRevision: proposal.revision, idempotencyKey: "approve-proposal" }, f.owner))
      .toThrowError(expect.objectContaining({ code: "revision_conflict" }));
  });

  it("exports the state column and accepts older exports without it", () => {
    const f = setup();
    f.write(mergedNotDeployed());
    const snapshot = f.store.exportKnowledgeProject(f.project.id)!;
    expect(typeof snapshot.tasks[0]!.current_state_json).toBe("string");
    expect(() => parseKnowledgeProjectSnapshot(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    const older = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    for (const task of older.tasks) delete task.current_state_json;
    expect(() => parseKnowledgeProjectSnapshot(older)).not.toThrow();
    const broken = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    broken.tasks[0]!.current_state_json = JSON.stringify({ formatVersion: 2 });
    expect(() => parseKnowledgeProjectSnapshot(broken)).toThrow();
  });
});
