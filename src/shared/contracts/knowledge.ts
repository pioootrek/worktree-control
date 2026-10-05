import { z } from "zod";
import { memorySchemas } from "./knowledge-memory-schemas";

export interface KnowledgeProject {
  id: string;
  name: string;
  status: "active" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type KnowledgeRecordKind = "thread" | "reply" | "task" | "memory";
export type KnowledgeTaskStatus = "open" | "in_progress" | "blocked" | "done" | "archived";
export type KnowledgeTaskPriority = "now" | "next" | "later";
export type KnowledgeRelationType = "derived_from" | "blocks" | "relates_to" | "supersedes";

export interface KnowledgeThread {
  id: string;
  projectId: string;
  title: string;
  body: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  presentation?: {
    displayTitle: string;
    preview: string;
    imported: boolean;
    replyCount: number;
  };
}

export interface KnowledgeReply {
  id: string;
  projectId: string;
  threadId: string;
  body: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  historicalImport?: {
    sourceAttribution: "verified" | "unverified";
    sourceAuthor: string | null;
    sourceDate: string | null;
    sourceDateStatus: "valid" | "missing" | "invalid" | "unverified";
    sourceOrder: "verified" | "unverified";
  };
}

export interface KnowledgeTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: KnowledgeTaskStatus;
  priority: KnowledgeTaskPriority;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Current SQLite rows permit task, thread and reply endpoints. Memory is supported by the read projection when persistence permits it. */
export interface KnowledgeRelation {
  id: string;
  projectId: string;
  type: KnowledgeRelationType;
  sourceKind: KnowledgeRecordKind;
  sourceId: string;
  targetKind: KnowledgeRecordKind;
  targetId: string;
  revision: number;
  createdBy: string;
  createdAt: string;
}

/** Read-only navigation data; never stored in a relation or project export. */
export interface KnowledgeRelationDestination {
  kind: KnowledgeRecordKind;
  id: string;
  title: string;
  status?: KnowledgeTaskStatus | "active" | "superseded";
  threadId?: string;
}
export interface KnowledgeRelationView extends KnowledgeRelation {
  destination: KnowledgeRelationDestination | null;
}

export interface KnowledgeReplyPage extends KnowledgePage<KnowledgeReply> {
  offset: number;
  targetFound?: boolean;
}

export interface KnowledgeHistoryEntry {
  id: number;
  projectId: string;
  recordKind: KnowledgeRecordKind | "project" | "relation";
  recordId: string;
  operation: "created" | "updated" | "archived" | "linked" | "unlinked" | "approved" | "superseded";
  previousJson: string | null;
  principalId: string;
  authenticationMethod: "owner_session" | "agent_token" | "worker_token" | "installation_token" | "none";
  revision: number;
  createdAt: string;
  /** Read-only, verified Memory snapshots. Null means the comparison cannot be established. */
  comparison?: { before: KnowledgeMemoryHistorySnapshot | null; after: KnowledgeMemoryHistorySnapshot } | null;
}

export interface KnowledgeMemoryHistorySnapshot {
  title: string;
  body: string;
  category: "decision" | "question" | "note";
  status: "active" | "archived" | "superseded";
  tags: string[];
  legacyId: string | null;
  sources: import("./knowledge-memory").KnowledgeSource[];
  approval: { revision: number; principalId: string; approvedAt: string } | null;
  supersededBy: { id: string; revision: number } | null;
}

export interface KnowledgeMutationResult<T> {
  value: T;
  replayed: boolean;
}

export interface KnowledgePage<T> {
  items: T[];
  nextOffset: number | null;
}

export interface KnowledgePageOptions {
  limit?: number;
  offset?: number;
}

export interface KnowledgeHistoryOptions extends KnowledgePageOptions {
  includeComparison?: boolean;
}


export interface KnowledgeFilters {
  query?: string;
  activeOnly?: boolean;
  status?: KnowledgeTaskStatus;
  priority?: KnowledgeTaskPriority;
}
export interface KnowledgeTaskCounts { active: number; now: number; next: number; blocked: number; done: number; all: number }
export interface KnowledgeTaskPage<T = KnowledgeTaskSummary> extends KnowledgePage<T> { counts: KnowledgeTaskCounts; total: number }
export type KnowledgeThreadSummary = Omit<KnowledgeThread, "body">;
export type KnowledgeTaskSummary = Omit<KnowledgeTask, "description">;
export interface KnowledgeProjectSummary extends KnowledgeProject { writable: boolean }

const id = z.string().trim().min(1).max(160);
const page = { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1000000).optional() };
const project = { projectId: id };
const write = { idempotencyKey: z.string().trim().min(1).max(200) };
const revision = { expectedRevision: z.number().int().positive() };
const title = z.string().trim().min(1).max(200);
const body = z.string().trim().min(1).max(65536);
const query = z.string().trim().max(200).optional();
export const knowledgeStatus = z.enum(["open", "in_progress", "blocked", "done", "archived"]);
export const knowledgePriority = z.enum(["now", "next", "later"]);
const record = { ...project, recordId: id, recordKind: z.enum(["thread", "reply", "task", "memory"]) };
const filename = z.string().min(1).max(255).refine(value => value !== "." && value !== ".." && !/[/\\\u0000-\u001f\u007f]/.test(value));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const knowledgeEvidenceSchema = z.strictObject({
  setId: id, taskId: id, commit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
  command: z.string().trim().min(1).max(4096), result: z.enum(["passed", "failed", "interrupted", "inconclusive"]),
  executedAt: z.string().datetime({ offset: true }), scope: z.string().trim().min(1).max(4096),
});

/** One validated application contract for HTTP, MCP and CLI. */
export const knowledgeSchemas = {
  ...memorySchemas,
  project: z.strictObject({ ...project }),
  projects: z.strictObject({ ...page }),
  threads: z.strictObject({ ...project, ...page, query }),
  reply: z.strictObject({ ...project, replyId: id }),
  thread: z.strictObject({ ...project, threadId: id }),
  replies: z.strictObject({ ...project, threadId: id, ...page, targetReplyId: id.optional() }),
  tasks: z.strictObject({ ...project, ...page, query, activeOnly: z.boolean().optional(), status: knowledgeStatus.optional(), priority: knowledgePriority.optional() }),
  task: z.strictObject({ ...project, taskId: id }),
  relations: z.strictObject({ ...record, ...page }),
  history: z.strictObject({ ...record, recordKind: z.enum(["thread", "reply", "task", "memory", "project", "relation"]), ...page, includeComparison: z.boolean().optional() }),
  create_thread: z.strictObject({ ...project, ...write, title, body }),
  create_reply: z.strictObject({ ...project, ...write, threadId: id, body }),
  create_task: z.strictObject({ ...project, ...write, title, description: body, priority: knowledgePriority.optional() }),
  task_from_thread: z.strictObject({ ...project, ...write, threadId: id, title, description: body, priority: knowledgePriority.optional() }),
  update_task: z.strictObject({ ...project, ...write, ...revision, taskId: id, title, description: body, priority: knowledgePriority, status: knowledgeStatus }),
  archive_project: z.strictObject({ ...project, ...write, ...revision }),
  restore_project: z.strictObject({ ...project, ...write, ...revision }),
  link_runtime: z.strictObject({ ...project, ...write, ...revision, runtimeProjectId: id.nullable() }),
  attachments: z.strictObject({ ...record, ...page }),
  attachment_policy: z.strictObject({ ...project }),
  check_attachment_batch: z.strictObject({ ...record, files: z.array(z.strictObject({
    filename, size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256,
    mediaType: z.string().min(1).max(255).optional(), idempotencyKey: write.idempotencyKey.optional(),
  }).refine(file => !file.idempotencyKey || !!file.mediaType)).min(1).max(10000), evidence: knowledgeEvidenceSchema.optional() }),
  attachment: z.strictObject({ ...project, attachmentId: id }),
  create_attachment: z.strictObject({ ...record, ...write, filename, mediaType: z.string().min(1).max(255),
    dataBase64: z.string().max(14_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/), sha256: sha256.optional() }),
};
export type KnowledgeOperation = keyof typeof knowledgeSchemas;
export type KnowledgeInput<K extends KnowledgeOperation> = z.infer<(typeof knowledgeSchemas)[K]>;
export type KnowledgeRequest = { [K in KnowledgeOperation]: { operation: K; input: KnowledgeInput<K> } }[KnowledgeOperation];
export interface KnowledgeFailure { code: string; error: string; currentRevision?: number;
  details?: { violations: import("./knowledge-attachments").KnowledgeLimitViolation[]; recovery: string } }

export function knowledgeRequestLimit(operation: string): number {
  return operation === "create_attachment" ? 14_100_000 : operation === "check_attachment_batch" ? 4 * 1024 * 1024 : 65536;
}
