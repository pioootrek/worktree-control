import type { KnowledgeTaskPage } from "@/shared/contracts/knowledge";
import type { KnowledgeMemory, KnowledgeMemoryReading, KnowledgeSearchHit, KnowledgeSearchOptions } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeFilters, KnowledgeProjectSummary, KnowledgeRelationDestination, KnowledgeReplyPage } from "@/shared/contracts/knowledge";
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
import { readingFromImport } from "./knowledge-memory-reading";
import { searchExcerpt } from "./knowledge-search-snippet";
import { compactPreview, importedRecordId, importedTaskPreview, importedTaskTopic, verifiedThreadSourceSql } from "./knowledge-thread-presentation";

type ThreadRow = { id: string; project_id: string; title: string; body: string; revision: number; created_by: string; created_at: string; updated_at: string; display_title?: string | null; source_preview?: string | null; reply_count?: number };
type ReplyRow = { id: string; project_id: string; thread_id: string; body: string; revision: number; created_by: string; created_at: string; updated_at: string; source_count: number; source_ordinal: number | null; source_attribution_verified: number; source_author: unknown; source_date: unknown };
type TaskRow = { id: string; project_id: string; title: string; description: string; status: KnowledgeTask["status"]; priority: KnowledgeTask["priority"]; revision: number; created_by: string; created_at: string; updated_at: string };
type HistoryRow = { id: number; project_id: string; record_kind: KnowledgeHistoryEntry["recordKind"]; record_id: string; operation: KnowledgeHistoryEntry["operation"]; previous_json: string | null; principal_id: string; authentication_method: KnowledgeHistoryEntry["authenticationMethod"]; revision: number; created_at: string };
type RelationRow = { id: string; project_id: string; type: KnowledgeRelation["type"]; source_kind: KnowledgeRelation["sourceKind"]; source_id: string; target_kind: KnowledgeRelation["targetKind"]; target_id: string; revision: number; created_by: string; created_at: string };

type MemoryRow = { id: string; project_id: string; title: string; body: string; category: KnowledgeMemory["category"]; tags_json: string; legacy_id: string | null; sources_json: string; status: KnowledgeMemory["status"]; superseded_by_json: string | null; approval_json: string | null; revision: number; created_by: string; created_at: string; updated_at: string };
const mapMemory = (row: MemoryRow): KnowledgeMemory => ({ id: row.id, projectId: row.project_id, title: row.title, body: row.body, category: row.category, tags: JSON.parse(row.tags_json), legacyId: row.legacy_id, sources: JSON.parse(row.sources_json), status: row.status, supersededBy: row.superseded_by_json ? JSON.parse(row.superseded_by_json) : null, approval: row.approval_json ? JSON.parse(row.approval_json) : null, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });

type IdempotencyRow = { request_hash: string; result_json: string };

const mapThread = (row: ThreadRow): KnowledgeThread => ({ id: row.id, projectId: row.project_id, title: row.title, body: row.body, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.reply_count === undefined ? {} : { presentation: { displayTitle: row.display_title ?? row.title,
    preview: row.display_title ? row.source_preview ?? "" : compactPreview(row.body), imported: Boolean(row.display_title), replyCount: row.reply_count } }) });
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
  ...(row.source_count ? { historicalImport: {
    sourceAttribution: row.source_attribution_verified ? "verified" as const : "unverified" as const,
    sourceAuthor: row.source_attribution_verified && typeof row.source_author === "string" && row.source_author.trim() ? row.source_author : null,
    ...(row.source_attribution_verified ? historicalDate(row.source_date) : {sourceDate:null,sourceDateStatus:"unverified" as const}),
    sourceOrder: row.source_ordinal === null ? "unverified" as const : "verified" as const,
  } } : {}) });

// One scoped query serves list and direct reads. The target index makes every
// provenance lookup exact, including extra rows with unrelated source paths.
// A source ordinal is trusted only with a unique source, its deterministic
// imported identity, and the matching parent task/thread relation.
const replyOrderSql = "ORDER BY CASE WHEN source_ordinal IS NOT NULL THEN 0 WHEN source_count>0 THEN 1 ELSE 2 END, source_ordinal, created_at, id";
export const replyReadSql = (byId: boolean, locateTarget = false): string => `WITH reply_rows AS MATERIALIZED (
  SELECT * FROM knowledge_replies r WHERE r.project_id=@projectId AND ${byId ? "r.id=@replyId" : "r.thread_id=@threadId"}
), candidates AS (
  SELECT r.*, s.id provenance_id, s.source_path, s.legacy_id, s.source_id,
    s.source_repository, s.source_commit, s.mapping_version, s.target_revision,
    s.original_payload_json, p.id parent_id, p.legacy_id parent_legacy_id,
    p.source_path parent_path, p.mapping_version parent_mapping_version, p.target_revision parent_revision,
    task.revision task_revision, relation.id relation_id,
    substr(s.legacy_id,length(p.legacy_id)+7) note_ordinal
  FROM reply_rows r
  LEFT JOIN knowledge_import_sources s INDEXED BY knowledge_import_sources_target
    ON s.project_id=r.project_id AND s.target_kind='historical_comment' AND s.target_id=r.id
  LEFT JOIN knowledge_import_sources p INDEXED BY knowledge_import_sources_project
    ON p.project_id=r.project_id AND p.source_path=substr(s.source_path,1,instr(s.source_path,'#notes/')-1)
      AND p.target_kind='task' AND p.source_id=s.source_id
      AND p.source_repository=s.source_repository AND p.source_commit=s.source_commit
  LEFT JOIN knowledge_tasks task ON task.project_id=r.project_id AND task.id=p.target_id
    AND task.id=knowledge_import_record_id(r.project_id,p.source_id,p.source_path,'task')
  LEFT JOIN knowledge_relations relation ON relation.id=knowledge_import_record_id(r.project_id,p.source_id,p.source_path,'task-thread')
    AND relation.project_id=r.project_id AND relation.type='derived_from'
    AND relation.source_kind='task' AND relation.source_id=task.id
    AND relation.target_kind='thread' AND relation.target_id=r.thread_id
), scored AS (
  SELECT *, CASE WHEN provenance_id IS NOT NULL
    AND id=knowledge_import_record_id(project_id,source_id,source_path,'reply')
    AND mapping_version IN (1,2)
    AND (target_revision IS NULL OR target_revision<=revision)
    AND CASE WHEN json_valid(original_payload_json)
      THEN json_type(original_payload_json,'$.text')='text'
        AND knowledge_import_trim(json_extract(original_payload_json,'$.text'))=body
      ELSE 0 END
    THEN 1 ELSE 0 END verified_attribution,
    CASE WHEN provenance_id IS NOT NULL AND parent_id IS NOT NULL
    AND task_revision IS NOT NULL AND relation_id IS NOT NULL
    AND id=knowledge_import_record_id(project_id,source_id,source_path,'reply')
    AND thread_id=knowledge_import_record_id(project_id,source_id,parent_path,'thread')
    AND parent_legacy_id IS NOT NULL AND parent_legacy_id<>''
    AND legacy_id=parent_legacy_id || ':note:' || note_ordinal
    AND source_path=parent_path || '#notes/' || note_ordinal
    AND length(note_ordinal) BETWEEN 1 AND 15
    AND note_ordinal NOT GLOB '*[^0-9]*'
    AND CAST(CAST(note_ordinal AS INTEGER) AS TEXT)=note_ordinal
    AND mapping_version IN (1,2) AND parent_mapping_version IN (1,2)
    AND (target_revision IS NULL OR target_revision<=revision)
    AND (parent_revision IS NULL OR parent_revision<=task_revision)
    THEN CAST(note_ordinal AS INTEGER) END verified_ordinal
  FROM candidates
), collapsed AS (
  SELECT id,project_id,thread_id,body,revision,created_by,created_at,updated_at,
    count(provenance_id) source_count,
    CASE WHEN count(provenance_id)=1 AND count(verified_ordinal)=1 THEN max(verified_ordinal) END source_ordinal,
    CASE WHEN count(provenance_id)=1 AND max(verified_attribution)=1 THEN 1 ELSE 0 END source_attribution_verified,
    CASE WHEN count(provenance_id)=1 AND max(verified_attribution)=1
      THEN max(CASE WHEN json_valid(original_payload_json)
        THEN CASE WHEN json_type(original_payload_json,'$.author')='text'
          THEN json_extract(original_payload_json,'$.author') END END) END source_author,
    CASE WHEN count(provenance_id)=1 AND max(verified_attribution)=1
      THEN max(CASE WHEN json_valid(original_payload_json) THEN json_extract(original_payload_json,'$.date') END) END source_date
  FROM scored GROUP BY id
)
${locateTarget ? `SELECT ordinal - 1 AS offset FROM (SELECT id, row_number() OVER (${replyOrderSql}) AS ordinal FROM collapsed) WHERE id=@targetReplyId`
  : `SELECT * FROM collapsed ${byId ? "" : `${replyOrderSql} LIMIT @limit OFFSET @offset`}`}`;
const mapTask = (row: TaskRow): KnowledgeTask => ({ id: row.id, projectId: row.project_id, title: row.title, description: row.description, status: row.status, priority: row.priority, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });

/** Borrows the controller's singleton connection and owns no lifecycle. */
export class KnowledgeQueries implements KnowledgeStore {
  constructor(private readonly database: Database.Database) {
    database.function("knowledge_fold", { deterministic: true }, value => String(value).normalize("NFC").toLowerCase());
    database.function("knowledge_import_record_id", { deterministic: true }, importedRecordId);
    database.function("knowledge_import_topic", { deterministic: true }, importedTaskTopic);
    database.function("knowledge_import_preview", { deterministic: true }, importedTaskPreview);
    database.function("knowledge_import_trim", { deterministic: true }, value => typeof value === "string" ? value.trim() : null);
  }

  saveAttachment(value: KnowledgeAttachment, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeAttachment> {
    const { relativePath: _relativePath, ...stored } = value;
    void _relativePath;
    return this.mutate("attachment.create", context, () => { this.database.prepare(`INSERT INTO knowledge_attachments
      (id, project_id, record_kind, record_id, filename, media_type, size, sha256, created_by, created_at)
      VALUES (@id,@projectId,@recordKind,@recordId,@filename,@mediaType,@size,@sha256,@createdBy,@createdAt)`).run(stored); return stored; });
  }
  getAttachment(projectId: string, id: string): KnowledgeAttachment | null {
    const row = this.database.prepare(`SELECT id, project_id projectId, record_kind recordKind, record_id recordId,
      filename, media_type mediaType, size, sha256, created_by createdBy, created_at createdAt FROM knowledge_attachments WHERE project_id = ? AND id = ?`).get(projectId, id) as KnowledgeAttachment | undefined;
    if (!row) return null;
    return this.withAttachmentPaths(projectId, [row])[0]!;
  }
  listAttachments(projectId: string, recordKind: KnowledgeAttachment["recordKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeAttachment> {
    const rows=this.database.prepare(`SELECT id, project_id projectId, record_kind recordKind, record_id recordId,
      filename, media_type mediaType, size, sha256, created_by createdBy, created_at createdAt FROM knowledge_attachments
      WHERE project_id = ? AND record_kind = ? AND record_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`).all(projectId, recordKind, recordId, limit+1, offset) as KnowledgeAttachment[];
    return this.page(this.withAttachmentPaths(projectId, rows),limit,offset);
  }
  private withAttachmentPaths(projectId: string, attachments: KnowledgeAttachment[]): KnowledgeAttachment[] {
    const paths = new Map<string, string>();
    for (let start = 0; start < attachments.length; start += 100) {
      const batch = attachments.slice(start, start + 100).filter(item => item.recordKind === "memory");
      if (!batch.length) continue;
      const placeholders = batch.map(() => "?").join(",");
      const sources = this.database.prepare(`SELECT target_id, count(*) provenance_count, max(source_id) source_id,
        max(source_repository) source_repository, max(source_commit) source_commit,
        max(source_sha256) source_sha256, max(source_path) source_path
        FROM knowledge_import_sources WHERE project_id=? AND target_kind='attachment' AND target_id IN (${placeholders})
        GROUP BY target_id`).all(projectId, ...batch.map(item => item.id)) as Array<{
          target_id: string; provenance_count: number; source_id: string; source_repository: string; source_commit: string;
          source_sha256: string; source_path: string;
        }>;
      const byAttachment = new Map(sources.map(source => [source.target_id, source]));
      const eligible = batch.filter(item => {
        const source = byAttachment.get(item.id);
        return source?.provenance_count === 1 && source.source_sha256 === item.sha256;
      });
      if (!eligible.length) continue;
      const parentIds = [...new Set(eligible.map(item => item.recordId))];
      const parents = this.database.prepare(`SELECT target_id, source_id, source_repository, source_commit,
        count(*) provenance_count, max(source_path) source_path
        FROM knowledge_import_sources WHERE project_id=? AND target_kind='memory'
          AND target_id IN (${parentIds.map(() => "?").join(",")})
        GROUP BY target_id, source_id, source_repository, source_commit`).all(projectId, ...parentIds) as Array<{
          target_id: string; source_id: string; source_repository: string; source_commit: string;
          provenance_count: number; source_path: string;
        }>;
      const parentKey = (targetId: string, sourceId: string, repository: string, commit: string) =>
        JSON.stringify([targetId, sourceId, repository, commit]);
      const byParent = new Map(parents.map(parent => [
        parentKey(parent.target_id, parent.source_id, parent.source_repository, parent.source_commit), parent,
      ]));
      for (const attachment of eligible) {
        const source = byAttachment.get(attachment.id);
        if (!source) continue;
        const parent = byParent.get(parentKey(attachment.recordId, source.source_id, source.source_repository, source.source_commit));
        if (parent?.provenance_count !== 1) continue;
        const parentPath = parent.source_path;
        if (!parentPath.endsWith("/note.json")) continue;
        const prefix = parentPath.slice(0, -"note.json".length);
        if (!source.source_path.startsWith(prefix)) continue;
        const relativePath = source.source_path.slice(prefix.length);
        if (relativePath.split("/").some(part => !part || part === "." || part === ".." || /[\\\u0000-\u001f]/.test(part)) ||
            relativePath.split("/").at(-1) !== attachment.filename) continue;
        paths.set(attachment.id, relativePath);
      }
    }
    return attachments.map(item => paths.has(item.id) ? { ...item, relativePath: paths.get(item.id)! } : item);
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
    if (!row) return null;
    const memory = mapMemory(row);
    return this.withMemoryReadings(projectId, [memory])[0]!;
  }

  getReply(projectId: string, id: string): KnowledgeReply | null {
    const row = this.database.prepare(replyReadSql(true)).get({projectId,replyId:id}) as ReplyRow | undefined;
    return row ? mapReply(row) : null;
  }

  listMemories(projectId: string, limit: number, offset: number, query: string, includeInactive: boolean, taskId?: string): KnowledgePage<KnowledgeMemory> {
    const rows = this.database.prepare(`SELECT * FROM knowledge_memories
      WHERE project_id = @projectId AND (@inactive OR status = 'active')
      AND instr(knowledge_fold(title || char(10) || body || char(10) || coalesce((SELECT group_concat(value, char(10)) FROM json_each(tags_json)), '') || char(10) || coalesce(legacy_id, '')), knowledge_fold(@query)) > 0
      AND (@taskId IS NULL OR EXISTS(SELECT 1 FROM json_each(sources_json) s WHERE json_extract(s.value, '$.kind') = 'task' AND json_extract(s.value, '$.id') = @taskId))
      ORDER BY updated_at DESC, id LIMIT @limit OFFSET @offset`).all({ projectId, limit: limit + 1, offset, query, inactive: Number(includeInactive), taskId: taskId ?? null }) as MemoryRow[];
    return this.page(this.withMemoryReadings(projectId, rows.map(mapMemory)), limit, offset);
  }

  private withMemoryReadings<T extends { id: string }>(projectId: string, items: T[]): Array<T & { reading?: KnowledgeMemoryReading }> {
    const readings = new Map<string, KnowledgeMemoryReading>();
    for (let start = 0; start < items.length; start += 100) {
      const batch = items.slice(start, start + 100);
      if (!batch.length) continue;
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.database.prepare(`SELECT target_id, count(*) provenance_count,
        CASE WHEN count(*)=1 AND max(length(original_payload_json)) <= 131072 THEN max(original_payload_json) END original_payload_json
        FROM knowledge_import_sources WHERE project_id=? AND target_kind='memory' AND target_id IN (${placeholders})
        GROUP BY target_id`).all(projectId, ...batch.map(item => item.id)) as Array<{
          target_id: string; provenance_count: number; original_payload_json: string | null;
        }>;
      const eligible = rows.filter(row => row.provenance_count === 1 && row.original_payload_json !== null);
      if (!eligible.length) continue;
      const bodies = new Map<string, string>();
      for (const item of batch) {
        if ("body" in item && typeof item.body === "string") bodies.set(item.id, item.body);
      }
      const missing = eligible.map(row => row.target_id).filter(id => !bodies.has(id));
      if (missing.length) {
        const found = this.database.prepare(`SELECT id, body FROM knowledge_memories WHERE project_id=? AND id IN (${missing.map(() => "?").join(",")})`)
          .all(projectId, ...missing) as Array<{ id: string; body: string }>;
        for (const row of found) bodies.set(row.id, row.body);
      }
      for (const row of eligible) {
        const body = bodies.get(row.target_id);
        if (body === undefined) continue;
        const reading = readingFromImport(row.original_payload_json, body);
        if (reading) readings.set(row.target_id, reading);
      }
    }
    return items.map(item => readings.has(item.id) ? { ...item, reading: readings.get(item.id)! } : item);
  }

  saveMemory(memory: KnowledgeMemory, expectedRevision: number | null, operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeMemory> {
    return this.mutate(operation, context, () => {
      const { reading: _reading, ...storedMemory } = memory;
      void _reading;
      const previousRow = this.database.prepare("SELECT * FROM knowledge_memories WHERE project_id=? AND id=?").get(memory.projectId, memory.id) as MemoryRow | undefined;
      const previous = previousRow ? mapMemory(previousRow) : null;
      const values = { id: storedMemory.id, projectId: storedMemory.projectId, title: storedMemory.title, body: storedMemory.body, category: storedMemory.category,
        tags: JSON.stringify(storedMemory.tags), legacyId: storedMemory.legacyId, sources: JSON.stringify(storedMemory.sources), status: storedMemory.status,
        supersededBy: storedMemory.supersededBy ? JSON.stringify(storedMemory.supersededBy) : null, approval: storedMemory.approval ? JSON.stringify(storedMemory.approval) : null,
        revision: storedMemory.revision, createdBy: storedMemory.createdBy, createdAt: storedMemory.createdAt, updatedAt: storedMemory.updatedAt };
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
      return storedMemory;
    });
  }

  searchKnowledge(projectId: string, limit: number, offset: number, options: KnowledgeSearchOptions): KnowledgePage<KnowledgeSearchHit> {
    // Parameterized literal substring search matches Polish case folding and does not interpret SQL/FTS syntax.
    // A selected kind uses only its table. Task/memory searches never run the
    // verified imported-topic projection, which is needed only for discussions.
    const kinds = options.kind ? [options.kind] : ["thread", "reply", "task", "memory"];
    const needsTopic = kinds.includes("thread") || kinds.includes("reply");
    const arms = [] as string[];
    if (kinds.includes("thread")) arms.push(`SELECT t.id, t.project_id, 'thread' AS kind, coalesce(v.display_title,t.title) title, t.title raw_title, t.body, t.revision, 'active' AS status, t.updated_at, NULL AS thread_id, '[]' AS tags_json, NULL AS legacy_id
      FROM knowledge_threads t LEFT JOIN verified v ON v.thread_id=t.id WHERE t.project_id=@projectId`);
    if (kinds.includes("reply")) arms.push(`SELECT r.id, r.project_id, 'reply', coalesce(v.display_title,t.title), t.title, r.body, r.revision, 'active', r.updated_at, r.thread_id, '[]', NULL
      FROM knowledge_replies r JOIN knowledge_threads t ON t.project_id=r.project_id AND t.id=r.thread_id
      LEFT JOIN verified v ON v.thread_id=t.id WHERE r.project_id=@projectId`);
    if (kinds.includes("task")) arms.push("SELECT id, project_id, 'task', title, title, description, revision, status, updated_at, NULL, '[]', NULL FROM knowledge_tasks WHERE project_id = @projectId");
    if (kinds.includes("memory")) arms.push("SELECT id, project_id, 'memory', title, title, body, revision, status, updated_at, NULL, tags_json, legacy_id FROM knowledge_memories WHERE project_id = @projectId");
    const rows = this.database.prepare(`WITH ${needsTopic ? `verified AS (${verifiedThreadSourceSql(false)}),` : ""}
      records(id,project_id,kind,title,raw_title,body,revision,status,updated_at,thread_id,tags_json,legacy_id)
      AS (${arms.join(" UNION ALL ")})
      SELECT id, project_id AS projectId, kind, title, body, raw_title AS rawTitle, revision, status, updated_at AS updatedAt, thread_id AS threadId FROM records
      WHERE (@inactive OR @status IN ('archived', 'superseded') OR status NOT IN ('archived', 'superseded'))
      AND (@kind IS NULL OR kind = @kind) AND (@status IS NULL OR status = @status)
      AND (@legacyId IS NULL OR legacy_id = @legacyId)
      AND (@tag IS NULL OR EXISTS(SELECT 1 FROM json_each(tags_json) WHERE knowledge_fold(value) = knowledge_fold(@tag)))
      AND instr(knowledge_fold(title || char(10) || raw_title || char(10) || body || char(10) || coalesce((SELECT group_concat(value, char(10)) FROM json_each(tags_json)), '') || char(10) || coalesce(legacy_id, '')), knowledge_fold(@query)) > 0
      ORDER BY updatedAt DESC, kind, id LIMIT @limit OFFSET @offset`).all({ projectId, limit: limit + 1, offset,
        query: options.query ?? '', kind: options.kind ?? null, status: options.status ?? null, legacyId: options.legacyId ?? null,
        tag: options.tag ?? null, inactive: Number(options.includeInactive ?? false) }) as Array<Omit<KnowledgeSearchHit,"excerpt"> & {body:string;rawTitle:string}>;
    const hits = rows.map(({body,rawTitle,...item}) => {
      const snippet = searchExcerpt(body, options.query ?? "");
      const needle = (options.query ?? "").normalize("NFC").toLowerCase();
      const titleMatches = Boolean(needle && [item.title,rawTitle].some(value => value.normalize("NFC").toLowerCase().includes(needle)));
      return {...item,excerpt:snippet.excerpt,matchSource:snippet.matchedBody ? "body" as const : titleMatches ? "title" as const : "metadata" as const};
    });
    const memoryHits = hits.filter(item => item.kind === "memory");
    const projected = new Map(this.withMemoryReadings(projectId, memoryHits).map(item => [item.id, item.reading]));
    return this.page(hits.map(item => item.kind === "memory" && projected.get(item.id) ? { ...item, reading: projected.get(item.id)! } : item), limit, offset);
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
    const rows = this.database.prepare(`WITH verified AS (${verifiedThreadSourceSql(false)}), matched AS (
      SELECT t.*, v.display_title, v.source_preview FROM knowledge_threads t
      LEFT JOIN verified v ON v.thread_id=t.id WHERE t.project_id=@projectId
        AND (instr(knowledge_fold(coalesce(v.display_title,t.title)),knowledge_fold(@query))>0
          OR instr(knowledge_fold(t.title),knowledge_fold(@query))>0
          OR instr(knowledge_fold(t.id),knowledge_fold(@query))>0))
      SELECT matched.*, (SELECT count(*) FROM knowledge_replies r WHERE r.project_id=matched.project_id AND r.thread_id=matched.id) reply_count
      FROM matched ORDER BY updated_at DESC,id LIMIT @limit OFFSET @offset`)
      .all({ projectId, query: filters.query ?? "", limit: limit + 1, offset }) as ThreadRow[];
    return this.page(rows.map(mapThread), limit, offset);
  }
  getThread(projectId: string, id: string): KnowledgeThread | null {
    const row = this.database.prepare(`WITH verified AS (${verifiedThreadSourceSql(true)})
      SELECT t.*,v.display_title,v.source_preview,
        (SELECT count(*) FROM knowledge_replies r WHERE r.project_id=t.project_id AND r.thread_id=t.id) reply_count
      FROM knowledge_threads t LEFT JOIN verified v ON v.thread_id=t.id WHERE t.project_id=@projectId AND t.id=@id`)
      .get({ projectId, id }) as ThreadRow | undefined;
    return row ? mapThread(row) : null;
  }
  listReplies(projectId: string, threadId: string, limit: number, offset: number, targetReplyId?: string): KnowledgeReplyPage {
    const location = targetReplyId ? this.database.prepare(replyReadSql(false, true)).get({projectId,threadId,targetReplyId}) as {offset:number}|undefined : undefined;
    const actualOffset = targetReplyId && location ? Math.floor(location.offset / limit) * limit : offset;
    const page = this.page((this.database.prepare(replyReadSql(false)).all({projectId,threadId,limit:limit+1,offset:actualOffset}) as ReplyRow[]).map(mapReply), limit, actualOffset);
    return {...page,offset:actualOffset,...(targetReplyId ? {targetFound:Boolean(location)} : {})};
  }
  listRelations(projectId: string, recordKind: KnowledgeRelation["sourceKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeRelation> {
    const rows = (this.database.prepare(`SELECT * FROM knowledge_relations WHERE project_id = ? AND ((source_kind = ? AND source_id = ?) OR (target_kind = ? AND target_id = ?)) ORDER BY created_at, id LIMIT ? OFFSET ?`).all(projectId, recordKind, recordId, recordKind, recordId, limit + 1, offset) as RelationRow[]).map((row) => ({ id: row.id, projectId: row.project_id, type: row.type, sourceKind: row.source_kind, sourceId: row.source_id, targetKind: row.target_kind, targetId: row.target_id, revision: row.revision, createdBy: row.created_by, createdAt: row.created_at }));
    return this.page(rows, limit, offset);
  }
  relationDestinations(projectId: string, endpoints: Array<{kind: KnowledgeRelation["sourceKind"]; id: string}>): Array<KnowledgeRelationDestination | null> {
    if (!endpoints.length) return [];
    const rows = this.database.prepare(`WITH requested AS MATERIALIZED (
      SELECT json_extract(value,'$.kind') kind, json_extract(value,'$.id') id FROM json_each(@endpoints)
    ), thread_ids AS (
      SELECT id FROM requested WHERE kind='thread'
      UNION SELECT r.thread_id FROM knowledge_replies r JOIN requested q ON q.kind='reply' AND q.id=r.id WHERE r.project_id=@projectId
    ), verified AS (${verifiedThreadSourceSql(false, "AND t.id IN (SELECT id FROM thread_ids)")})
    SELECT q.kind, q.id,
      CASE q.kind WHEN 'task' THEN task.title WHEN 'memory' THEN memory.title
        WHEN 'thread' THEN coalesce(v.display_title,thread.title)
        WHEN 'reply' THEN coalesce(parent_v.display_title,parent.title) END title,
      CASE q.kind WHEN 'task' THEN task.status WHEN 'memory' THEN memory.status END status,
      CASE q.kind WHEN 'reply' THEN reply.thread_id END threadId
    FROM requested q
    LEFT JOIN knowledge_tasks task ON q.kind='task' AND task.project_id=@projectId AND task.id=q.id
    LEFT JOIN knowledge_memories memory ON q.kind='memory' AND memory.project_id=@projectId AND memory.id=q.id
    LEFT JOIN knowledge_threads thread ON q.kind='thread' AND thread.project_id=@projectId AND thread.id=q.id
    LEFT JOIN knowledge_replies reply ON q.kind='reply' AND reply.project_id=@projectId AND reply.id=q.id
    LEFT JOIN knowledge_threads parent ON parent.project_id=@projectId AND parent.id=reply.thread_id
    LEFT JOIN verified v ON v.thread_id=thread.id
    LEFT JOIN verified parent_v ON parent_v.thread_id=parent.id`).all({projectId,endpoints:JSON.stringify(endpoints)}) as Array<{kind:KnowledgeRelationDestination["kind"];id:string;title:string|null;status:KnowledgeRelationDestination["status"]|null;threadId:string|null}>;
    const found = new Map(rows.filter(row => row.title !== null && (row.kind !== "reply" || row.threadId)).map(row => [`${row.kind}\0${row.id}`,{
      kind:row.kind,id:row.id,title:row.title!,...(row.status ? {status:row.status} : {}),...(row.threadId ? {threadId:row.threadId} : {})
    }]));
    return endpoints.map(({kind,id}) => found.get(`${kind}\0${id}`) ?? null);
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
