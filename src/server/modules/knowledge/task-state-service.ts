import { createHash } from "node:crypto";
import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import type { KnowledgeInput } from "@/shared/contracts/knowledge";
import {
  taskCurrentStateSchema, TASK_STATE_MAX_BYTES, TASK_STATE_MAX_SOURCES,
  type KnowledgeTaskStateView, type TaskCurrentState, type TaskStateInput,
} from "@/shared/contracts/knowledge-task-state";
import type { KnowledgeMutationContext, KnowledgeMutationResult, KnowledgeStore, KnowledgeTask } from "./contracts";
import { KnowledgeError } from "./knowledge-error";
import { assessTaskState, taskStateSources } from "./task-state-assessment";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Current task state: explicit writes, deterministic read-time assessment, no generated text. */
export class KnowledgeTaskStateService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly identity: Pick<IdentityService, "authorizeKnowledge">,
    private readonly clock: () => string,
    private readonly changed: (projectId: string) => void,
  ) {}

  read(input: KnowledgeInput<"task_state">, actor: AuthenticatedPrincipal): KnowledgeTaskStateView {
    this.identity.authorizeKnowledge(actor, input.projectId, "knowledge:read");
    const task = this.store.getTask(input.projectId, input.taskId);
    if (!task) throw new KnowledgeError("not_found", "Nie znaleziono zadania.");
    const raw = this.store.getTaskStateJson(input.projectId, input.taskId) ?? null;
    let state: TaskCurrentState | null = null;
    let stateUnreadable = false;
    if (raw !== null) {
      try {
        const parsed = taskCurrentStateSchema.safeParse(JSON.parse(raw));
        if (parsed.success) state = parsed.data; else stateUnreadable = true;
      } catch { stateUnreadable = true; }
    }
    const facts = state ? this.store.taskStateFacts(input.projectId, task, state) : null;
    const assessment = assessTaskState(task, state, facts ?? { changes: { descriptionChanged: false, memoriesChanged: 0, attachmentsAdded: 0, repliesAdded: 0, staleSources: 0, inactiveSources: 0 }, presentAttachments: new Set(), decision: null });
    const { description: _description, ...summary } = task;
    void _description;
    return { task: summary, state, stateUnreadable, assessment, systemFacts: this.store.taskSystemFacts(input.projectId, input.taskId) };
  }

  update(input: KnowledgeInput<"update_task_state">, actor: AuthenticatedPrincipal): KnowledgeMutationResult<{ task: KnowledgeTask; state: TaskCurrentState }> {
    const { projectId, taskId, expectedRevision } = input;
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    // Responses contain retained record content, as with other mutations.
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read", { allowArchived: true });
    const context: KnowledgeMutationContext = { actor, projectId, idempotencyKey: input.idempotencyKey,
      requestHash: createHash("sha256").update(canonical({ operation: "task.update_state", projectId, taskId, expectedRevision, status: input.status ?? null, state: input.state })).digest("hex") };
    const replay = this.store.findIdempotentResult<{ task: KnowledgeTask; state: TaskCurrentState }>("task.update_state", context);
    if (replay) return replay;
    if (this.store.getKnowledgeProject(projectId)?.status !== "active") throw new KnowledgeError("invalid_request", "Projekt wiedzy jest zarchiwizowany.");
    const current = this.store.getTask(projectId, taskId);
    if (!current) throw new KnowledgeError("not_found", "Nie znaleziono zadania.");
    if (current.revision !== expectedRevision) throw new KnowledgeError("revision_conflict", "Rewizja zadania uległa zmianie.", current.revision);
    this.validate(projectId, taskId, input.state);

    const now = this.clock();
    const status = input.status ?? current.status;
    const task: KnowledgeTask = { ...current, status, revision: expectedRevision + 1, updatedAt: now };
    const state: TaskCurrentState = { ...input.state, formatVersion: 1, taskRevision: task.revision, statusAtWrite: status, writtenAt: now,
      writtenBy: { principalId: actor.principalId, authenticationMethod: actor.authenticationMethod } };
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > TASK_STATE_MAX_BYTES) throw new KnowledgeError("limit_exceeded", "Task state exceeds 16 KiB; move narrative to a discussion reply or attachment.");
    const result = this.store.updateTaskState(task, state, expectedRevision, context);
    if (!result.replayed) this.changed(projectId);
    return result;
  }

  /** Structural checks only; contradictions between facts are accepted and reported on read. */
  private validate(projectId: string, taskId: string, state: TaskStateInput): void {
    const invalid = (message: string) => { throw new KnowledgeError("invalid_request", message); };
    const sources = taskStateSources(state);
    if (sources.length > TASK_STATE_MAX_SOURCES) invalid(`Task state cites more than ${TASK_STATE_MAX_SOURCES} unique sources.`);
    for (const source of sources) {
      if (source.kind === "external" || source.kind === "repository") continue;
      if (source.kind === "attachment") {
        if (!this.store.getAttachment(projectId, source.id)) throw new KnowledgeError("not_found", "Cited attachment not found in this project.");
        continue;
      }
      if (source.kind === "task" && source.id === taskId) invalid("A task state cannot cite its own task.");
      this.requireCurrent(projectId, source.kind, source.id, source.revision);
    }
    for (const stage of ["merge", "ci", "review", "evidence", "deploy"] as const) {
      const fact = state.delivery[stage];
      if (!("applies" in fact) || !fact.applies) continue;
      if (fact.openFindings !== undefined && stage !== "review") invalid("Only review records open findings.");
      if (fact.attachments !== undefined && stage !== "evidence") invalid("Only evidence lists attachments.");
      if (fact.resultCommit !== undefined && stage !== "merge") invalid("Only merge records a result commit.");
      if (stage === "review" && fact.state === "findings_closed" && (fact.openFindings ?? 0) > 0) invalid("Closed findings cannot have open findings.");
      for (const attachmentId of fact.attachments ?? []) {
        const attachment = this.store.getAttachment(projectId, attachmentId);
        if (!attachment || attachment.recordKind !== "task" || attachment.recordId !== taskId) invalid("Evidence attachments must belong to this task.");
      }
    }
    const decision = state.ownerDecision;
    const reference = decision.state === "recorded" ? decision.decisionRef : decision.state === "needed" ? decision.proposalRef : undefined;
    if (reference) {
      const memory = this.requireCurrent(projectId, "memory", reference.id, reference.revision);
      if (decision.state === "recorded" && (!("category" in memory) || memory.category !== "decision")) invalid("A recorded owner decision must reference a decision memory.");
    }
  }

  private requireCurrent(projectId: string, kind: "thread" | "reply" | "task" | "memory", id: string, revision: number) {
    const record = kind === "task" ? this.store.getTask(projectId, id) : kind === "thread" ? this.store.getThread(projectId, id)
      : kind === "reply" ? this.store.getReply(projectId, id) : this.store.getMemory(projectId, id);
    if (!record) throw new KnowledgeError("not_found", "Source not found in this project.");
    if (record.revision !== revision) throw new KnowledgeError("revision_conflict", "Source revision changed.", record.revision);
    return record;
  }
}
