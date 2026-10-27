import type Database from "better-sqlite3";
import type { KnowledgeTask } from "@/shared/contracts/knowledge";
import type { KnowledgeTaskStateView, TaskCurrentState, TaskStateAuthenticationMethod } from "@/shared/contracts/knowledge-task-state";
import { taskStateSources, type TaskStateFacts } from "@/server/modules/knowledge";

/** Counting stops here; the reader only needs to know that changes exist. */
const COUNT_LIMIT = 1000;
const citesTask = "EXISTS(SELECT 1 FROM json_each(m.sources_json) s WHERE json_extract(s.value, '$.kind') = 'task' AND json_extract(s.value, '$.id') = @taskId)";

export function readTaskStateJson(database: Database.Database, projectId: string, taskId: string): string | null | undefined {
  const row = database.prepare("SELECT current_state_json FROM knowledge_tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as { current_state_json: string | null } | undefined;
  return row ? row.current_state_json : undefined;
}

/** Bounded reads on the controller's single connection; no write and no separate transaction. */
export function collectTaskStateFacts(database: Database.Database, projectId: string, task: KnowledgeTask, state: TaskCurrentState): TaskStateFacts {
  const since = state.writtenAt;
  const count = (sql: string, parameters: Record<string, unknown>) =>
    (database.prepare(`SELECT count(*) AS count FROM (${sql} LIMIT ${COUNT_LIMIT})`).get(parameters) as { count: number }).count;
  const parameters = { projectId, taskId: task.id, since };

  let descriptionChanged = false;
  if (task.revision > state.taskRevision) {
    // The first later entry stores the task exactly as it was when the state was written.
    const row = database.prepare("SELECT previous_json FROM knowledge_history WHERE project_id = ? AND record_kind = 'task' AND record_id = ? AND revision = ? ORDER BY id LIMIT 1")
      .get(projectId, task.id, state.taskRevision + 1) as { previous_json: string | null } | undefined;
    try {
      const previous = row?.previous_json ? JSON.parse(row.previous_json) as { description?: unknown } : null;
      descriptionChanged = typeof previous?.description === "string" && previous.description !== task.description;
    } catch { descriptionChanged = false; }
  }
  const memoriesChanged = count(`SELECT 1 FROM knowledge_memories m WHERE m.project_id = @projectId AND m.updated_at > @since AND ${citesTask}`, parameters);
  const attachmentsAdded = count("SELECT 1 FROM knowledge_attachments WHERE project_id = @projectId AND record_kind = 'task' AND record_id = @taskId AND created_at > @since", parameters);
  const repliesAdded = count(`SELECT 1 FROM knowledge_relations rel JOIN knowledge_replies r ON r.project_id = rel.project_id AND r.thread_id = rel.target_id
    WHERE rel.project_id = @projectId AND rel.type = 'derived_from' AND rel.source_kind = 'task' AND rel.source_id = @taskId AND rel.target_kind = 'thread' AND r.created_at > @since`, parameters);

  let staleSources = 0;
  let inactiveSources = 0;
  const knowledgeSources = taskStateSources(state).filter(source => source.kind === "thread" || source.kind === "reply" || source.kind === "task" || source.kind === "memory") as Array<{ kind: "thread" | "reply" | "task" | "memory"; id: string; revision: number }>;
  const decision = state.ownerDecision;
  if (decision.state === "recorded") knowledgeSources.push({ kind: "memory", ...decision.decisionRef });
  if (decision.state === "needed" && decision.proposalRef) knowledgeSources.push({ kind: "memory", ...decision.proposalRef });
  const table = { thread: "knowledge_threads", reply: "knowledge_replies", task: "knowledge_tasks", memory: "knowledge_memories" } as const;
  for (const source of knowledgeSources) {
    const status = source.kind === "task" || source.kind === "memory" ? ", status" : ", NULL AS status";
    const current = database.prepare(`SELECT revision${status} FROM ${table[source.kind]} WHERE project_id = ? AND id = ?`).get(projectId, source.id) as { revision: number; status: string | null } | undefined;
    if (!current || ["archived", "superseded"].includes(current.status ?? "")) inactiveSources += 1;
    else if (current.revision !== source.revision) staleSources += 1;
  }

  const delivery = state.delivery.evidence;
  const listed = "applies" in delivery && delivery.applies ? delivery.attachments ?? [] : [];
  const presentAttachments = new Set<string>();
  if (listed.length) {
    const rows = database.prepare(`SELECT id FROM knowledge_attachments WHERE project_id = ? AND record_kind = 'task' AND record_id = ? AND id IN (${listed.map(() => "?").join(",")})`)
      .all(projectId, task.id, ...listed) as Array<{ id: string }>;
    for (const row of rows) presentAttachments.add(row.id);
  }

  let decisionFacts: TaskStateFacts["decision"] = null;
  if (decision.state === "recorded") {
    const memory = database.prepare("SELECT revision, approval_json FROM knowledge_memories WHERE project_id = ? AND id = ?").get(projectId, decision.decisionRef.id) as { revision: number; approval_json: string | null } | undefined;
    if (memory) {
      const approval = memory.approval_json ? JSON.parse(memory.approval_json) as { revision: number } : null;
      const approvedAtCurrentRevision = approval?.revision === memory.revision;
      const approved = database.prepare("SELECT authentication_method FROM knowledge_history WHERE project_id = ? AND record_kind = 'memory' AND record_id = ? AND operation = 'approved' ORDER BY id DESC LIMIT 1")
        .get(projectId, decision.decisionRef.id) as { authentication_method: TaskStateAuthenticationMethod } | undefined;
      const atRevision = approvedAtCurrentRevision
        ? database.prepare("SELECT authentication_method FROM knowledge_history WHERE project_id = ? AND record_kind = 'memory' AND record_id = ? AND operation = 'approved' AND revision = ? ORDER BY id DESC LIMIT 1")
          .get(projectId, decision.decisionRef.id, memory.revision) as { authentication_method: TaskStateAuthenticationMethod } | undefined
        : undefined;
      decisionFacts = { approvedAtCurrentRevision, approvalMethod: atRevision?.authentication_method ?? null, everApproved: Boolean(approved) };
    }
  }

  return { changes: { descriptionChanged, memoriesChanged, attachmentsAdded, repliesAdded, staleSources, inactiveSources }, presentAttachments, decision: decisionFacts };
}

export function collectTaskSystemFacts(database: Database.Database, projectId: string, taskId: string): KnowledgeTaskStateView["systemFacts"] {
  const memories = database.prepare(`SELECT
      coalesce(sum(m.category = 'decision' AND json_extract(m.approval_json, '$.revision') = m.revision), 0) AS approved,
      coalesce(sum(m.category <> 'question' AND NOT (m.category = 'decision' AND coalesce(json_extract(m.approval_json, '$.revision') = m.revision, 0))), 0) AS proposals,
      coalesce(sum(m.category = 'question'), 0) AS questions
    FROM knowledge_memories m WHERE m.project_id = @projectId AND m.status = 'active' AND ${citesTask}`).get({ projectId, taskId }) as { approved: number; proposals: number; questions: number };
  const attachments = (database.prepare("SELECT count(*) AS count FROM knowledge_attachments WHERE project_id = ? AND record_kind = 'task' AND record_id = ?").get(projectId, taskId) as { count: number }).count;
  return { approvedDecisions: memories.approved, proposals: memories.proposals, openQuestions: memories.questions, attachments };
}
