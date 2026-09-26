import type { KnowledgeTaskPage } from "@/shared/contracts/knowledge";
import type { KnowledgeMemory, KnowledgeSearchHit, KnowledgeSearchOptions } from "@/shared/contracts/knowledge-memory";
import type { AuthenticatedPrincipal, KnowledgeProject, KnowledgeProjectRuntimeLink } from "@/server/modules/identity";

import type { KnowledgeRecordKind, KnowledgeThread, KnowledgeReply, KnowledgeTask, KnowledgeRelation, KnowledgeHistoryEntry, KnowledgeMutationResult, KnowledgePage, KnowledgeFilters, KnowledgeProjectSummary } from "@/shared/contracts/knowledge";
import type { KnowledgeAttachment } from "@/shared/contracts/knowledge-attachments";
export type { KnowledgeRecordKind, KnowledgeTaskStatus, KnowledgeTaskPriority, KnowledgeRelationType, KnowledgeThread, KnowledgeReply, KnowledgeTask, KnowledgeRelation, KnowledgeHistoryEntry, KnowledgeMutationResult, KnowledgePage, KnowledgePageOptions, KnowledgeFilters, KnowledgeProjectSummary } from "@/shared/contracts/knowledge";

export interface KnowledgeMutationContext {
  actor: AuthenticatedPrincipal;
  projectId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface KnowledgeRuntimeLinkResult {
  link: KnowledgeProjectRuntimeLink;
  project: KnowledgeProject;
}

export interface KnowledgeProjectSnapshot {
  project: Record<string, unknown>;
  threads: Array<Record<string, unknown>>;
  replies: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  importSources: Array<Record<string, unknown>>;
  requiredPrincipals: string[];
}
export interface KnowledgeProjectExportManifest {
  formatVersion: 1;
  applicationVersion: string;
  schemaVersion: number;
  createdAt: string;
  projectId: string;
  data: { file: "project.json"; size: number; sha256: string };
  attachments: Array<{ file: string; size: number; sha256: string }>;
  counts: Record<string, number>;
}

export interface KnowledgeStore {
  saveAttachment(attachment: KnowledgeAttachment, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeAttachment>;
  getAttachment(projectId: string, id: string): KnowledgeAttachment | null;
  listAttachments(projectId: string, recordKind: KnowledgeAttachment["recordKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeAttachment>;
  attachmentBytesForProject(projectId: string): number;
  attachmentCountForProject(projectId: string): number;
  attachmentTargetExists(projectId: string, recordKind: KnowledgeAttachment["recordKind"], recordId: string): boolean;
  getMemory(projectId: string, id: string): KnowledgeMemory | null;
  getReply(projectId: string, id: string): KnowledgeReply | null;
  listMemories(projectId: string, limit: number, offset: number, query: string, includeInactive: boolean, taskId?: string): KnowledgePage<KnowledgeMemory>;
  saveMemory(memory: KnowledgeMemory, expectedRevision: number | null, operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeMemory>;
  searchKnowledge(projectId: string, limit: number, offset: number, options: KnowledgeSearchOptions): KnowledgePage<KnowledgeSearchHit>;
  listKnowledgeProjects(principalId: string | null, limit: number, offset: number): KnowledgePage<KnowledgeProjectSummary>;
  createTask(task: KnowledgeTask, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeTask>;
  getKnowledgeProject(id: string): KnowledgeProject | null;
  hasRuntimeProject(id: string): boolean;
  getRuntimeLinkOwner(runtimeProjectId: string): string | null;
  findIdempotentResult<T>(operation: string, context: KnowledgeMutationContext): KnowledgeMutationResult<T> | null;
  listThreads(projectId: string, limit: number, offset: number, filters?: KnowledgeFilters): KnowledgePage<KnowledgeThread>;
  getThread(projectId: string, id: string): KnowledgeThread | null;
  listReplies(projectId: string, threadId: string, limit: number, offset: number): KnowledgePage<KnowledgeReply>;
  listRelations(projectId: string, recordKind: KnowledgeRecordKind, recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeRelation>;
  getTask(projectId: string, id: string): KnowledgeTask | null;
  listTasks(projectId: string, limit: number, offset: number, filters?: KnowledgeFilters): KnowledgeTaskPage<KnowledgeTask>;
  listHistory(projectId: string, recordKind: KnowledgeHistoryEntry["recordKind"], recordId: string, limit: number, offset: number): KnowledgePage<KnowledgeHistoryEntry>;
  createThread(thread: KnowledgeThread, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeThread>;
  createReply(reply: KnowledgeReply, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeReply>;
  createTaskFromThread(task: KnowledgeTask, relation: KnowledgeRelation, context: KnowledgeMutationContext): KnowledgeMutationResult<{ task: KnowledgeTask; relation: KnowledgeRelation }>;
  updateTask(task: KnowledgeTask, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeTask>;
  updateKnowledgeProject(project: KnowledgeProject, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeProject>;
  setKnowledgeProjectRuntimeLink(link: KnowledgeProjectRuntimeLink, expectedRevision: number, context: KnowledgeMutationContext): KnowledgeMutationResult<KnowledgeRuntimeLinkResult>;
}
