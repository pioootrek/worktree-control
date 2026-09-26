import type { KnowledgeTaskPage } from "@/shared/contracts/knowledge";
import type { KnowledgeMemory, KnowledgeSearchHit, KnowledgeSearchOptions } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeFilters, KnowledgeProjectSummary } from "@/shared/contracts/knowledge";
import Database from "better-sqlite3";

import {
  KnowledgeError,
  type KnowledgeHistoryEntry,
  type KnowledgeMutationContext,
  type KnowledgeMutationResult,
  type KnowledgePage,
  type KnowledgeRelation,
  type KnowledgeReply,
  type KnowledgeRuntimeLinkResult,
  type KnowledgeStore,
  type KnowledgeTask,
  type KnowledgeThread,
} from "@/server/modules/knowledge";
import type { KnowledgeProject, KnowledgeProjectRuntimeLink } from "@/server/modules/identity";
import type { KnowledgeAttachment } from "@/shared/contracts/knowledge-attachments";

type ThreadRow = { id: string; project_id: string; title: string; body: string; revision: number; created_by: string; created_at: string; updated_at: string };
type ReplyRow = { id: string; project_id: string; thread_id: string; body: string; revision: number; created_by: string; created_at: string; updated_at: string; import_source_id?: string | null; source_author?: unknown; source_date?: unknown };
type TaskRow = { id: string; project_id: string; title: string; description: string; status: KnowledgeTask["status"]; priority: KnowledgeTask["priority"]; revision: number; created_by: string; created_at: string; updated_at: string };
type HistoryRow = { id: number; project_id: string; record_kind: KnowledgeHistoryEntry["recordKind"]; record_id: string; operation: KnowledgeHistoryEntry["operation"]; previous_json: string | null; principal_id: string; authentication_method: KnowledgeHistoryEntry["authenticationMethod"]; revision: number; created_at: string };
type RelationRow = { id: string; project_id: string; type: KnowledgeRelation["type"]; source_kind: KnowledgeRelation["sourceKind"]; source_id: string; target_kind: KnowledgeRelation["targetKind"]; target_id: string; revision: number; created_by: string; created_at: string };

type MemoryRow = { id: string; project_id: string; title: string; body: string; category: KnowledgeMemory["category"]; tags_json: string; legacy_id: string | null; sources_json: string; status: KnowledgeMemory["status"]; superseded_by_json: string | null; approval_json: string | null; revision: number; created_by: string; created_at: string; updated_at: string };
const mapMemory = (row: MemoryRow): KnowledgeMemory => ({ id: row.id, projectId: row.project_id, title: row.title, body: row.body, category: row.category, tags: JSON.parse(row.tags_json), legacyId: row.legacy_id, sources: JSON.parse(row.sources_json), status: row.status, supersededBy: row.superseded_by_json ? JSON.parse(row.superseded_by_json) : null, approval: row.approval_json ? JSON.parse(row.approval_json) : null, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });

type IdempotencyRow = { request_hash: string; result_json: string };

const mapThread = (row: ThreadRow): KnowledgeThread => ({ id: row.id, projectId: row.project_id, title: row.title, body: row.body, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });
function historicalDate(value: unknown): Pick<NonNullable<KnowledgeReply["historicalImport"]>, "sourceDate" | "sourceDateStatus"> {
  if (value === null || value === undefined || value === "") return { sourceDate: null, sourceDateStatus: "missing" };
  const sourceDate = typeof value === "string" ? value : JSON.stringify(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sourceDate);
  if (dateOnly) {
    const year=Number(dateOnly[1]),month=Number(dateOnly[2]),day=Number(dateOnly[3]);
    const valid=new Date(Date.UTC(year,month-1,day));
    return { sourceDate, sourceDateStatus: valid.getUTCFullYear()===year&&valid.getUTCMonth()===month-1&&valid.getUTCDate()===day ? "valid" : "invalid" };
  }
  return { sourceDate, sourceDateStatus: Number.isNaN(Date.parse(sourceDate)) ? "invalid" : "valid" };
}
const mapReply = (row: ReplyRow): KnowledgeReply => ({ id: row.id, projectId: row.project_id, threadId: row.thread_id, body: row.body, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.import_source_id ? { historicalImport: { sourceAuthor: typeof row.source_author === "string" && row.source_author.trim() ? row.source_author : null, ...historicalDate(row.source_date) } } : {}) });
const mapTask = (row: TaskRow): KnowledgeTask => ({ id: row.id, projectId: row.project_id, title: row.title, description: row.description, status: row.status, priority: row.priority, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });

/** Borrows the controller's singleton connection and owns no lifecycle. */
export class KnowledgeQueries implements KnowledgeStore {
  constructor(private readonly database: Database.Database) {
    database.function("knowledge_fold", { deterministic: true }, value => String(value).normalize("NFC").toLowerCase());
  }

  saveAttachment(value: KnowledgeAttachment, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeAttachment> {
    return this.mutate("attachment.create", context, () => { this.database.prepare(`INSERT INTO knowledge_attachments
      (id, project_id, record_kind, record_id, filename, media_type, size, sha256, created_by, created_at)
      VALUES (@id,@projectId,@recordKind,@recordId,@filename,@mediaType,@size,@sha256,@createdBy,@createdAt)`).run(value); return value; });
  }
  getAttachment(projectId: string, id: string): KnowledgeAttachment | null {
    const row = this.database.prepare(`SELECT id, project_id projectId, record_kind recordKind, record_id recordId,
      filename, media_type mediaType, size, sha256, created_by createdBy, created_at createdAt FROM knowledge_attachments WHERE project_id = ? AND id = ?`).get(projectId, id) as KnowledgeAttachment | undefined;
    return row ?? null;
  }
  listAttachments(projectId: string, recordKind: KnowledgeAttachment["recordKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeAttachment> {
    const rows=this.database.prepare(`SELECT id, project_id projectId, record_kind recordKind, record_id recordId,
      filename, media_type mediaType, size, sha256, created_by createdBy, created_at createdAt FROM knowledge_attachments
      WHERE project_id = ? AND record_kind = ? AND record_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`).all(projectId, recordKind, recordId, limit+1, offset) as KnowledgeAttachment[];
    return this.page(rows,limit,offset);
  }
  attachmentBytesForProject(projectId: string): number {
    return (this.database.prepare("SELECT coalesce(sum(size),0) total FROM knowledge_attachments WHERE project_id = ?").get(projectId) as { total: number }).total;
  }
  attachmentCountForProject(projectId: string): number { return (this.database.prepare("SELECT count(*) total FROM knowledge_attachments WHERE project_id=?").get(projectId) as {total:number}).total; }
  attachmentTargetExists(projectId: string, kind: KnowledgeAttachment["recordKind"], id: string): boolean {
    const table={thread:"knowledge_threads",reply:"knowledge_replies",task:"knowledge_tasks",memory:"knowledge_memories"}[kind];
    return Boolean(this.database.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND id=?`).get(projectId,id));
  }


  getMemory(projectId: string, id: string): KnowledgeMemory | null {
    const row = this.database.prepare("SELECT * FROM knowledge_memories WHERE project_id = ? AND id = ?").get(projectId, id) as MemoryRow | undefined;
    return row ? mapMemory(row) : null;
  }

  getReply(projectId: string, id: string): KnowledgeReply | null {
    const row = this.database.prepare(`SELECT r.*, s.id import_source_id,
      json_extract(s.original_payload_json, '$.author') source_author,
      json_extract(s.original_payload_json, '$.date') source_date
      FROM knowledge_replies r LEFT JOIN knowledge_import_sources s
        ON s.project_id=r.project_id AND s.target_kind='historical_comment' AND s.target_id=r.id
      WHERE r.project_id = ? AND r.id = ?`).get(projectId, id) as ReplyRow | undefined;
    return row ? mapReply(row) : null;
  }

  listMemories(projectId: string, limit: number, offset: number, query: string, includeInactive: boolean, taskId?: string): KnowledgePage<KnowledgeMemory> {
    const rows = this.database.prepare(`SELECT * FROM knowledge_memories
      WHERE project_id = @projectId AND (@inactive OR status = 'active')
      AND instr(knowledge_fold(title || char(10) || body || char(10) || coalesce((SELECT group_concat(value, char(10)) FROM json_each(tags_json)), '') || char(10) || coalesce(legacy_id, '')), knowledge_fold(@query)) > 0
      AND (@taskId IS NULL OR EXISTS(SELECT 1 FROM json_each(sources_json) s WHERE json_extract(s.value, '$.kind') = 'task' AND json_extract(s.value, '$.id') = @taskId))
      ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`).all({ projectId, limit: limit + 1, offset, query, inactive: Number(includeInactive), taskId: taskId ?? null }) as MemoryRow[];
    return this.page(rows.map(mapMemory), limit, offset);
  }

  saveMemory(memory: KnowledgeMemory, expectedRevision: number | null, operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeMemory> {
    return this.mutate(operation, context, () => {
      const previous = this.getMemory(memory.projectId, memory.id);
      const values = { id: memory.id, projectId: memory.projectId, title: memory.title, body: memory.body, category: memory.category,
        tags: JSON.stringify(memory.tags), legacyId: memory.legacyId, sources: JSON.stringify(memory.sources), status: memory.status,
        supersededBy: memory.supersededBy ? JSON.stringify(memory.supersededBy) : null, approval: memory.approval ? JSON.stringify(memory.approval) : null,
        revision: memory.revision, createdBy: memory.createdBy, createdAt: memory.createdAt, updatedAt: memory.updatedAt };
      if (expectedRevision === null) {
        this.database.prepare(`INSERT INTO knowledge_memories VALUES (@id, @projectId, @title, @body, @category, @tags, @legacyId, @sources, @status, @supersededBy, @approval, @revision, @createdBy, @createdAt, @updatedAt)`).run(values);
      } else {
        const result = this.database.prepare(`UPDATE knowledge_memories SET title = @title, body = @body, category = @category,
          tags_json = @tags, legacy_id = @legacyId, sources_json = @sources, status = @status, superseded_by_json = @supersededBy,
          approval_json = @approval, revision = @revision, updated_at = @updatedAt WHERE project_id = @projectId AND id = @id AND revision = @expectedRevision`).run({ ...values, expectedRevision });
        if (!result.changes) throw new KnowledgeError("revision_conflict", "Memory revision changed.", previous?.revision);
      }
      const historyOperation = operation === "create_memory" ? "created" : operation === "approve_memory" ? "approved"
        : operation === "supersede_memory" ? "superseded" : operation === "archive_memory" ? "archived" : "updated";
      this.history(memory.projectId, "memory", memory.id, historyOperation, previous ? JSON.stringify(previous) : null, memory.revision, context, memory.updatedAt);
      return memory;
    });
  }

  searchKnowledge(projectId: string, limit: number, offset: number, options: KnowledgeSearchOptions): KnowledgePage<KnowledgeSearchHit> {
    // Parameterized literal substring search matches Polish case folding and does not interpret SQL/FTS syntax.
    const rows = this.database.prepare(`WITH records AS (
      SELECT id, project_id, 'thread' AS kind, title, body, revision, 'active' AS status, updated_at, NULL AS thread_id, '[]' AS tags_json, NULL AS legacy_id FROM knowledge_threads WHERE project_id = @projectId
      UNION ALL SELECT id, project_id, 'reply', '', body, revision, 'active', updated_at, thread_id, '[]', NULL FROM knowledge_replies WHERE project_id = @projectId
      UNION ALL SELECT id, project_id, 'task', title, description, revision, status, updated_at, NULL, '[]', NULL FROM knowledge_tasks WHERE project_id = @projectId
      UNION ALL SELECT id, project_id, 'memory', title, body, revision, status, updated_at, NULL, tags_json, legacy_id FROM knowledge_memories WHERE project_id = @projectId
    ) SELECT id, project_id AS projectId, kind, title, substr(body, 1, 300) AS excerpt, revision, status, updated_at AS updatedAt, thread_id AS threadId FROM records
      WHERE (@inactive OR @status IN ('archived', 'superseded') OR status NOT IN ('archived', 'superseded'))
      AND (@kind IS NULL OR kind = @kind) AND (@status IS NULL OR status = @status)
      AND (@legacyId IS NULL OR legacy_id = @legacyId)
      AND (@tag IS NULL OR EXISTS(SELECT 1 FROM json_each(tags_json) WHERE knowledge_fold(value) = knowledge_fold(@tag)))
      AND instr(knowledge_fold(title || char(10) || body || char(10) || coalesce((SELECT group_concat(value, char(10)) FROM json_each(tags_json)), '') || char(10) || coalesce(legacy_id, '')), knowledge_fold(@query)) > 0
      ORDER BY updatedAt DESC, kind, id LIMIT @limit OFFSET @offset`).all({ projectId, limit: limit + 1, offset,
        query: options.query ?? '', kind: options.kind ?? null, status: options.status ?? null, legacyId: options.legacyId ?? null,
        tag: options.tag ?? null, inactive: Number(options.includeInactive ?? false) }) as KnowledgeSearchHit[];
    return this.page(rows, limit, offset);
  }

  /** A null principal is the installation authority: every project, always writable. */
  listKnowledgeProjects(principalId: string | null, limit: number, offset: number): KnowledgePage<KnowledgeProjectSummary> {
    const rows = (principalId === null
      ? this.database.prepare("SELECT p.*, 1 AS writable FROM knowledge_projects p ORDER BY p.name, p.id LIMIT ? OFFSET ?").all(limit + 1, offset)
      : this.database.prepare(`SELECT p.*, EXISTS(SELECT 1 FROM json_each(g.permissions_json) WHERE value = 'knowledge:write') AS writable
      FROM knowledge_projects p JOIN knowledge_project_grants g ON g.project_id = p.id
      WHERE g.principal_id = ? AND g.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(g.permissions_json) WHERE value = 'knowledge:read')
      ORDER BY p.name, p.id LIMIT ? OFFSET ?`).all(principalId, limit + 1, offset)) as Array<{ id: string; name: string; status: KnowledgeProject["status"]; revision: number; created_at: string; updated_at: string; writable: number }>;
    return this.page(rows.map(row => ({ id: row.id, name: row.name, status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, writable: Boolean(row.writable) })), limit, offset);
  }

  createTask(task: KnowledgeTask, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeTask> {
    return this.mutate("task.create", context, () => {
      this.insertTask(task);
      this.history(task.projectId, "task", task.id, "created", null, task.revision, context, task.createdAt);
      return task;
    });
  }

  getKnowledgeProject(id: string): KnowledgeProject | null {
    const row = this.database.prepare("SELECT id, name, status, revision, created_at, updated_at FROM knowledge_projects WHERE id = ?").get(id) as { id: string; name: string; status: KnowledgeProject["status"]; revision: number; created_at: string; updated_at: string } | undefined;
    return row ? { id: row.id, name: row.name, status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  hasRuntimeProject(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(id));
  }

  getRuntimeLinkOwner(runtimeProjectId: string): string | null {
    const row = this.database.prepare("SELECT knowledge_project_id FROM knowledge_project_runtime_links WHERE runtime_project_id = ?").get(runtimeProjectId) as { knowledge_project_id: string } | undefined;
    return row?.knowledge_project_id ?? null;
  }

  listThreads(projectId: string, limit: number, offset: number, filters: KnowledgeFilters = {}): KnowledgePage<KnowledgeThread> {
    return this.page((this.database.prepare("SELECT * FROM knowledge_threads WHERE project_id = ? AND instr(knowledge_fold(title), knowledge_fold(?)) > 0 ORDER BY updated_at DESC, id LIMIT ? OFFSET ?").all(projectId, filters.query ?? "", limit + 1, offset) as ThreadRow[]).map(mapThread), limit, offset);
  }
  getThread(projectId: string, id: string): KnowledgeThread | null {
    const row = this.database.prepare("SELECT * FROM knowledge_threads WHERE project_id = ? AND id = ?").get(projectId, id) as ThreadRow | undefined;
    return row ? mapThread(row) : null;
  }
  listReplies(projectId: string, threadId: string, limit: number, offset: number): KnowledgePage<KnowledgeReply> {
    return this.page((this.database.prepare(`SELECT r.*, s.id import_source_id,
      json_extract(s.original_payload_json, '$.author') source_author,
      json_extract(s.original_payload_json, '$.date') source_date
      FROM knowledge_replies r LEFT JOIN knowledge_import_sources s
        ON s.project_id=r.project_id AND s.target_kind='historical_comment' AND s.target_id=r.id
      WHERE r.project_id = ? AND r.thread_id = ? ORDER BY r.created_at, r.id LIMIT ? OFFSET ?`).all(projectId, threadId, limit + 1, offset) as ReplyRow[]).map(mapReply), limit, offset);
  }
  listRelations(projectId: string, recordKind: KnowledgeRelation["sourceKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeRelation> {
    const rows = (this.database.prepare(`SELECT * FROM knowledge_relations WHERE project_id = ? AND ((source_kind = ? AND source_id = ?) OR (target_kind = ? AND target_id = ?)) ORDER BY created_at, id LIMIT ? OFFSET ?`).all(projectId, recordKind, recordId, recordKind, recordId, limit + 1, offset) as RelationRow[]).map((row) => ({ id: row.id, projectId: row.project_id, type: row.type, sourceKind: row.source_kind, sourceId: row.source_id, targetKind: row.target_kind, targetId: row.target_id, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at }));
    return this.page(rows, limit, offset);
  }
  getTask(projectId: string, id: string): KnowledgeTask | null {
    const row = this.database.prepare("SELECT * FROM knowledge_tasks WHERE project_id = ? AND id = ?").get(projectId, id) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }
  listTasks(projectId: string, limit: number, offset: number, filters: KnowledgeFilters = {}): KnowledgeTaskPage<KnowledgeTask> {
    const groups = this.database.prepare("SELECT status, priority, count(*) AS count FROM knowledge_tasks WHERE project_id = ? AND instr(knowledge_fold(title), knowledge_fold(?)) > 0 GROUP BY status, priority").all(projectId, filters.query ?? "") as Array<{ status: KnowledgeTask["status"]; priority: KnowledgeTask["priority"]; count: number }>;
    const counts = { active: 0, now: 0, next: 0, blocked: 0, done: 0, all: 0 };
    let total = 0;
    for (const group of groups) {
      const active = group.status !== "done" && group.status !== "archived";
      counts.all += group.count;
      if (active) { counts.active += group.count; if (group.priority === "now" || group.priority === "next") counts[group.priority] += group.count; }
      if (group.status === "blocked" || group.status === "done") counts[group.status] += group.count;
      if ((!filters.activeOnly || active) && (!filters.status || filters.status === group.status) && (!filters.priority || filters.priority === group.priority)) total += group.count;
    }
    const rows = (this.database.prepare("SELECT * FROM knowledge_tasks WHERE project_id = ? AND instr(knowledge_fold(title), knowledge_fold(?)) > 0 AND (? = 0 OR status IN ('open','in_progress','blocked')) AND (? IS NULL OR status = ?) AND (? IS NULL OR priority = ?) ORDER BY updated_at DESC, id LIMIT ? OFFSET ?").all(projectId, filters.query ?? "", filters.activeOnly ? 1 : 0, filters.status ?? null, filters.status ?? null, filters.priority ?? null, filters.priority ?? null, limit + 1, offset) as TaskRow[]).map(mapTask);
    return { ...this.page(rows, limit, offset), counts, total };
  }
  listHistory(projectId: string, recordKind: KnowledgeHistoryEntry["recordKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeHistoryEntry> {
    const rows = (this.database.prepare("SELECT * FROM knowledge_history WHERE project_id = ? AND record_kind = ? AND record_id = ? ORDER BY id LIMIT ? OFFSET ?").all(projectId, recordKind, recordId, limit + 1, offset) as HistoryRow[]).map((row) => ({ id: row.id, projectId: row.project_id, recordKind: row.record_kind, recordId: row.record_id, operation: row.operation, previousJson: row.previous_json, principalId: row.principal_id, authenticationMethod: row.authentication_method, revision: row.revision, createdAt: row.created_at }));
    return this.page(rows, limit, offset);
  }

  findIdempotentResult<T>(operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<T> | null {
    const previous = this.database.prepare(`SELECT request_hash, result_json FROM knowledge_idempotency WHERE principal_id = ? AND project_id = ? AND operation = ? AND idempotency_key = ?`).get(context.actor.principalId, context.projectId, operation, context.idempotencyKey) as IdempotencyRow | undefined;
    if (!previous) return null;
    if (previous.request_hash !== context.requestHash) throw new KnowledgeError("idempotency_conflict", "Klucz idempotencji został użyty z inną treścią.");
    return { value: JSON.parse(previous.result_json) as T, replayed: true };
  }

  createThread(thread: KnowledgeThread, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeThread> {
    return this.mutate("thread.create", context, () => {
      this.database.prepare("INSERT INTO knowledge_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(thread.id, thread.projectId, thread.title, thread.body, thread.revision, thread.createdBy, thread.createdAt, thread.updatedAt);
      this.history(thread.projectId, "thread", thread.id, "created", null, thread.revision, context, thread.createdAt);
      return thread;
    });
  }

  createReply(reply: KnowledgeReply, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeReply> {
    return this.mutate("reply.create", context, () => {
      this.database.prepare("INSERT INTO knowledge_replies VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(reply.id, reply.projectId, reply.threadId, reply.body, reply.revision, reply.createdBy, reply.createdAt, reply.updatedAt);
      this.history(reply.projectId, "reply", reply.id, "created", null, reply.revision, context, reply.createdAt);
      return reply;
    });
  }

  createTaskFromThread(task: KnowledgeTask, relation: KnowledgeRelation, context: KnowledgeMutationContext): KnowledgeMutationResult<{ task: KnowledgeTask; relation: KnowledgeRelation }> {
    return this.mutate("task.create_from_thread", context, () => {
      this.insertTask(task);
      this.database.prepare("INSERT INTO knowledge_relations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(relation.id, relation.projectId, relation.type, relation.sourceKind, relation.sourceId, relation.targetKind, relation.targetId, relation.revision, relation.createdBy, relation.createdAt);
      this.history(task.projectId, "task", task.id, "created", null, task.revision, context, task.createdAt);
      this.history(relation.projectId, "relation", relation.id, "linked", null, relation.revision, context, relation.createdAt);
      return { task, relation };
    });
  }

  updateTask(task: KnowledgeTask, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeTask> {
    return this.mutate("task.update", context, () => {
      const previous = this.getTask(task.projectId, task.id);
      if (!previous) throw new KnowledgeError("not_found", "Nie znaleziono zadania.");
      const result = this.database.prepare(`UPDATE knowledge_tasks SET title = ?, description = ?, status = ?, priority = ?, revision = ?, updated_at = ? WHERE project_id = ? AND id = ? AND revision = ?`)
        .run(task.title, task.description, task.status, task.priority, task.revision, task.updatedAt, task.projectId, task.id, expectedRevision);
      if (result.changes === 0) {
        const current = this.getTask(task.projectId, task.id);
        throw new KnowledgeError("revision_conflict", "Rewizja zadania uległa zmianie.", current?.revision);
      }
      this.history(task.projectId, "task", task.id, task.status === "archived" ? "archived" : "updated", JSON.stringify(previous), task.revision, context, task.updatedAt);
      return task;
    });
  }

  updateKnowledgeProject(project: KnowledgeProject, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeProject> {
    const operation = project.status === "active" ? "project.restore" : "project.archive";
    return this.mutate(operation, context, () => {
      const previous = this.getKnowledgeProject(project.id);
      const result = this.database.prepare("UPDATE knowledge_projects SET name = ?, status = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(project.name, project.status, project.revision, project.updatedAt, project.id, expectedRevision);
      if (result.changes === 0) throw new KnowledgeError("revision_conflict", "Rewizja projektu wiedzy uległa zmianie.", this.getKnowledgeProject(project.id)?.revision);
      this.history(project.id, "project", project.id, project.status === "archived" ? "archived" : "updated", JSON.stringify(previous), project.revision, context, project.updatedAt);
      return project;
    });
  }

  setKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeRuntimeLinkResult> {
    return this.mutate("project.runtime_link", context, () => {
      const project = this.getKnowledgeProject(link.projectId);
      if (!project) throw new KnowledgeError("not_found", "Nie znaleziono projektu wiedzy.");
      const previous = this.database.prepare("SELECT runtime_project_id FROM knowledge_project_runtime_links WHERE knowledge_project_id = ?").get(link.projectId) as { runtime_project_id: string | null } | undefined;
      const revision = expectedRevision + 1;
      const updated = this.database.prepare("UPDATE knowledge_projects SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
        .run(revision, link.linkedAt, link.projectId, expectedRevision);
      if (updated.changes === 0) throw new KnowledgeError("revision_conflict", "Rewizja projektu wiedzy uległa zmianie.", this.getKnowledgeProject(link.projectId)?.revision);
      this.database.prepare(`INSERT INTO knowledge_project_runtime_links(knowledge_project_id, runtime_project_id, linked_at, unlinked_at) VALUES (?, ?, ?, ?) ON CONFLICT(knowledge_project_id) DO UPDATE SET runtime_project_id = excluded.runtime_project_id, linked_at = excluded.linked_at, unlinked_at = excluded.unlinked_at`)
        .run(link.projectId, link.runtimeProjectId, link.linkedAt, link.unlinkedAt);
      this.history(link.projectId, "project", link.projectId, link.runtimeProjectId === null ? "unlinked" : "linked", previous ? JSON.stringify(previous) : null, revision, context, link.linkedAt);
      return { link, project: { ...project, revision, updatedAt: link.linkedAt } };
    });
  }

  private insertTask(task: KnowledgeTask): void {
    this.database.prepare("INSERT INTO knowledge_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(task.id, task.projectId, task.title, task.description, task.status, task.priority, task.revision, task.createdBy, task.createdAt, task.updatedAt);
  }

  private mutate<T>(operation: string, context: KnowledgeMutationContext, work: () => T): KnowledgeMutationResult<T> {
    return this.database.transaction(() => {
      const previous = this.findIdempotentResult<T>(operation, context);
      if (previous) return previous;
      const value = work();
      this.database.prepare(`INSERT INTO knowledge_idempotency(principal_id, project_id, operation, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(context.actor.principalId, context.projectId, operation, context.idempotencyKey, context.requestHash, JSON.stringify(value), new Date().toISOString());
      return { value, replayed: false };
    }).immediate();
  }

  private page<T>(rows: T[], limit: number, offset: number): KnowledgePage<T> {
    return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
  }

  private history(projectId: string, recordKind: KnowledgeHistoryEntry["recordKind"], recordId: string, operation: KnowledgeHistoryEntry["operation"], previousJson: string | null, revision: number, context: KnowledgeMutationContext, createdAt: string): void {
    this.database.prepare(`INSERT INTO knowledge_history(project_id, record_kind, record_id, operation, previous_json, principal_id, authentication_method, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, recordKind, recordId, operation, previousJson, context.actor.principalId, context.actor.authenticationMethod, revision, createdAt);
  }
}
