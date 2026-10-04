import type { KnowledgeTaskPage } from "@/shared/contracts/knowledge";
import { knowledgeSchemas, knowledgeRequestLimit, type KnowledgeRequest, type KnowledgeFilters, type KnowledgeRelationView } from "@/shared/contracts/knowledge";
import { createHash, randomUUID } from "node:crypto";

import type { AuthenticatedPrincipal, IdentityService, KnowledgeProject } from "@/server/modules/identity";
import type {
  KnowledgeMutationContext,
  KnowledgeMutationResult,
  KnowledgeHistoryEntry,
  KnowledgeHistoryOptions,
  KnowledgePage,
  KnowledgePageOptions,
  KnowledgeRelation,
  KnowledgeRecordKind,
  KnowledgeReply,
  KnowledgeRuntimeLinkResult,
  KnowledgeStore,
  KnowledgeTask,
  KnowledgeTaskPriority,
  KnowledgeTaskStatus,
  KnowledgeThread,
} from "./contracts";

import { KnowledgeError } from "./knowledge-error";
export { KnowledgeError } from "./knowledge-error";
export type { KnowledgeErrorCode } from "./knowledge-error";
import { KnowledgeMemoryService } from "./knowledge-memory-service";
import type { KnowledgeAttachmentService } from "./attachment-service";

export interface KnowledgeWriteOptions { idempotencyKey: string }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function recordSummary(record: KnowledgeTask | KnowledgeThread) {
  const { id, projectId, title, revision, createdBy, createdAt, updatedAt } = record;
  return { id, projectId, title, revision, createdBy, createdAt, updatedAt,
    ...("presentation" in record && record.presentation ? { presentation: record.presentation } : {}) };
}

export class KnowledgeService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly identity: Pick<IdentityService, "authorizeKnowledge" | "describeIdentity">,
    private readonly clock: () => string = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
    private readonly changed: (projectId: string) => void = () => undefined,
    private readonly attachments?: KnowledgeAttachmentService,
  ) {}

  execute(value: unknown, actor: AuthenticatedPrincipal) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeError("invalid_request", "Invalid knowledge request.");
    const envelope = value as Record<string, unknown>;
    if (Object.keys(envelope).some(key => key !== "operation" && key !== "input") || typeof envelope.operation !== "string" || !Object.hasOwn(knowledgeSchemas, envelope.operation)) throw new KnowledgeError("invalid_request", "Invalid knowledge operation.");
    const requestLimit = knowledgeRequestLimit(envelope.operation);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > requestLimit) throw new KnowledgeError("limit_exceeded", "Knowledge request exceeds its operation limit.");
    const parsed = knowledgeSchemas[envelope.operation as keyof typeof knowledgeSchemas].safeParse(envelope.input);
    if (!parsed.success) throw new KnowledgeError("invalid_request", "Invalid knowledge input.");
    const request = { operation: envelope.operation, input: parsed.data } as KnowledgeRequest;
    return this.dispatch(request, actor);
  }

  private dispatch(request: KnowledgeRequest, actor: AuthenticatedPrincipal) {
    switch (request.operation) {
      case "attachment_policy": return this.requireAttachments().policy(request.input.projectId, actor);
      case "check_attachment_batch": return this.requireAttachments().checkBatch(request.input.projectId, request.input.recordKind, request.input.recordId, request.input.files, actor, request.input.evidence);
      case "attachments": return this.requireAttachments().list(request.input.projectId, request.input.recordKind, request.input.recordId, actor,request.input.limit,request.input.offset);
      case "attachment": { const result = this.requireAttachments().download(request.input.projectId, request.input.attachmentId, actor); return { attachment: result.attachment, disposition: result.disposition, dataBase64: Buffer.from(result.data).toString("base64") }; }
      case "create_attachment": {
        const data = Buffer.from(request.input.dataBase64, "base64");
        if (data.toString("base64") !== request.input.dataBase64) throw new KnowledgeError("invalid_request", "Attachment requires canonical padded base64.");
        return this.requireAttachments().upload(request.input.projectId, request.input.recordKind, request.input.recordId, { filename: request.input.filename, mediaType: request.input.mediaType, data, sha256: request.input.sha256, idempotencyKey: request.input.idempotencyKey }, actor);
      }
      case "memories": case "memory": case "create_memory": case "update_memory":
      case "approve_memory": case "archive_memory": case "restore_memory": case "supersede_memory":
      case "search": case "task_context": case "export_context": case "check_context_export":
        return new KnowledgeMemoryService(this.store, this.identity, this.clock, this.id, this.changed).execute(request, actor);
      case "project": {
        this.identity.authorizeKnowledge(actor, request.input.projectId, "knowledge:read");
        const project = this.store.getKnowledgeProject(request.input.projectId)!;
        const identity = this.identity.describeIdentity(actor);
        const grant = identity.knowledgeGrants.find(grant => grant.projectId === project.id);
        return { ...project, writable: identity.installationAuthority === true || (grant?.permissions.includes("knowledge:write") ?? false) };
      }
      case "projects": {
        const identity = this.identity.describeIdentity(actor);
        const page = this.page(request.input);
        return this.store.listKnowledgeProjects(identity.installationAuthority ? null : actor.principalId, page.limit, page.offset);
      }
      case "threads": {
        const page = this.listThreads(request.input.projectId, actor, request.input);
        return { ...page, items: page.items.map(recordSummary) };
      }
      case "reply": {
        this.identity.authorizeKnowledge(actor, request.input.projectId, "knowledge:read");
        const reply = this.store.getReply(request.input.projectId, request.input.replyId);
        if (!reply) throw new KnowledgeError("not_found", "Reply not found.");
        return reply;
      }
      case "thread": return this.thread(request.input.projectId, request.input.threadId, actor);
      case "replies": return this.listReplies(request.input.projectId, request.input.threadId, actor, request.input);
      case "tasks": {
        const page = this.listTasks(request.input.projectId, actor, request.input);
        return { ...page, items: page.items.map(task => ({ ...recordSummary(task), status: task.status, priority: task.priority })) };
      }
      case "task": return this.task(request.input.projectId, request.input.taskId, actor);
      case "relations": return this.relations(request.input.projectId, request.input.recordKind, request.input.recordId, actor, request.input);
      case "history": return this.history(request.input.projectId, request.input.recordKind, request.input.recordId, actor, request.input);
      case "create_thread": return this.createThread(request.input.projectId, request.input, request.input, actor);
      case "create_reply": return this.createReply(request.input.projectId, request.input.threadId, request.input, request.input, actor);
      case "create_task": return this.createTask(request.input.projectId, request.input, request.input, actor);
      case "task_from_thread": return this.createTaskFromThread(request.input.projectId, request.input.threadId, request.input, request.input, actor);
      case "update_task": return this.updateTask(request.input.projectId, request.input.taskId, request.input, request.input, actor);
      case "archive_project": return this.archiveProject(request.input.projectId, request.input.expectedRevision, request.input, actor);
      case "restore_project": return this.restoreProject(request.input.projectId, request.input.expectedRevision, request.input, actor);
      case "link_runtime": return this.setRuntimeLink(request.input.projectId, request.input.runtimeProjectId, request.input.expectedRevision, request.input, actor);
    }
  }

  private requireAttachments(): KnowledgeAttachmentService {
    if (!this.attachments) throw new KnowledgeError("invalid_request", "Attachment service is unavailable.");
    return this.attachments;
  }

  createTask(projectId: string, input: { title: string; description: string; priority?: KnowledgeTaskPriority }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeTask> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    const title = this.text(input.title, "Tytuł", 200);
    const description = this.text(input.description, "Opis", 65536);
    const priority = input.priority ?? "later";
    if (!["now", "next", "later"].includes(priority)) throw new KnowledgeError("invalid_request", "Nieprawidłowy priorytet.");
    const context = this.context("task.create", projectId, { title, description, priority }, options, actor);
    const replay = this.store.findIdempotentResult<KnowledgeTask>("task.create", context);
    if (replay) return replay;
    this.requireActiveProject(projectId);
    const now = this.clock();
    return this.notify(projectId, this.store.createTask({ id: this.id(), projectId, title, description, priority, status: "open", revision: 1, createdBy: actor.principalId, createdAt: now, updatedAt: now }, context));
  }

  private notify<T>(projectId: string, result: KnowledgeMutationResult<T>): KnowledgeMutationResult<T> {
    if (!result.replayed) this.changed(projectId);
    return result;
  }

  listThreads(projectId: string, actor: AuthenticatedPrincipal, options: KnowledgePageOptions & KnowledgeFilters = {}): KnowledgePage<KnowledgeThread> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    const page = this.page(options);
    return this.store.listThreads(projectId, page.limit, page.offset, options);
  }

  thread(projectId: string, threadId: string, actor: AuthenticatedPrincipal): KnowledgeThread {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    const thread = this.store.getThread(projectId, threadId);
    if (!thread) throw new KnowledgeError("not_found", "Nie znaleziono wątku.");
    return thread;
  }

  listReplies(projectId: string, threadId: string, actor: AuthenticatedPrincipal, options: KnowledgePageOptions & { targetReplyId?: string } = {}) {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    if (!this.store.getThread(projectId, threadId)) throw new KnowledgeError("not_found", "Nie znaleziono wątku.");
    const page = this.page(options);
    return this.store.listReplies(projectId, threadId, page.limit, page.offset, options.targetReplyId);
  }

  listTasks(projectId: string, actor: AuthenticatedPrincipal, options: KnowledgePageOptions & KnowledgeFilters = {}): KnowledgeTaskPage<KnowledgeTask> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    const page = this.page(options);
    return this.store.listTasks(projectId, page.limit, page.offset, options);
  }

  task(projectId: string, taskId: string, actor: AuthenticatedPrincipal): KnowledgeTask {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    const task = this.store.getTask(projectId, taskId);
    if (!task) throw new KnowledgeError("not_found", "Nie znaleziono zadania.");
    return task;
  }

  relations(projectId: string, recordKind: KnowledgeRecordKind, recordId: string, actor: AuthenticatedPrincipal, options: KnowledgePageOptions = {}): KnowledgePage<KnowledgeRelationView> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    const page = this.page(options);
    const relations = this.store.listRelations(projectId, recordKind, recordId, page.limit, page.offset);
    const endpoints = relations.items.map(relation => relation.sourceKind === recordKind && relation.sourceId === recordId
      ? { kind: relation.targetKind, id: relation.targetId } : { kind: relation.sourceKind, id: relation.sourceId });
    const destinations = this.store.relationDestinations(projectId, endpoints);
    return { ...relations, items: relations.items.map((relation, index) => ({ ...relation, destination: destinations[index] ?? null })) };
  }

  history(projectId: string, recordKind: KnowledgeHistoryEntry["recordKind"], recordId: string, actor: AuthenticatedPrincipal, options: KnowledgeHistoryOptions = {}): KnowledgePage<KnowledgeHistoryEntry> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:read");
    const page = this.page(options);
    return this.store.listHistory(projectId, recordKind, recordId, page.limit, page.offset, options.includeComparison === true);
  }

  createThread(projectId: string, input: { title: string; body: string }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeThread> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    const title = this.text(input.title, "Tytuł", 200);
    const body = this.text(input.body, "Treść", 65_536);
    const context = this.context("thread.create", projectId, { title, body }, options, actor);
    const replay = this.store.findIdempotentResult<KnowledgeThread>("thread.create", context);
    if (replay) return replay;
    this.requireActiveProject(projectId);
    const now = this.clock();
    const thread: KnowledgeThread = { id: this.id(), projectId, title, body, revision: 1, createdBy: actor.principalId, createdAt: now, updatedAt: now };
    return this.notify(projectId, this.store.createThread(thread, context));
  }

  createReply(projectId: string, threadId: string, input: { body: string }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeReply> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    const body = this.text(input.body, "Treść", 65_536);
    const context = this.context("reply.create", projectId, { threadId, body }, options, actor);
    const replay = this.store.findIdempotentResult<KnowledgeReply>("reply.create", context);
    if (replay) return replay;
    this.requireActiveProject(projectId);
    if (!this.store.getThread(projectId, threadId)) throw new KnowledgeError("not_found", "Nie znaleziono wątku.");
    const now = this.clock();
    const reply: KnowledgeReply = { id: this.id(), projectId, threadId, body, revision: 1, createdBy: actor.principalId, createdAt: now, updatedAt: now };
    return this.notify(projectId, this.store.createReply(reply, context));
  }

  createTaskFromThread(projectId: string, threadId: string, input: { title: string; description: string; priority?: KnowledgeTaskPriority }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<{ task: KnowledgeTask; relation: KnowledgeRelation }> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    const title = this.text(input.title, "Tytuł", 200);
    const description = this.text(input.description, "Opis", 65_536);
    const priority = input.priority ?? "later";
    if (!["now", "next", "later"].includes(priority)) throw new KnowledgeError("invalid_request", "Nieprawidłowy priorytet.");
    const context = this.context("task.create_from_thread", projectId, { threadId, title, description, priority }, options, actor);
    const replay = this.store.findIdempotentResult<{ task: KnowledgeTask; relation: KnowledgeRelation }>("task.create_from_thread", context);
    if (replay) return replay;
    this.requireActiveProject(projectId);
    if (!this.store.getThread(projectId, threadId)) throw new KnowledgeError("not_found", "Nie znaleziono wątku.");
    const now = this.clock();
    const task: KnowledgeTask = { id: this.id(), projectId, title, description, priority, status: "open", revision: 1, createdBy: actor.principalId, createdAt: now, updatedAt: now };
    const relation: KnowledgeRelation = { id: this.id(), projectId, type: "derived_from", sourceKind: "task", sourceId: task.id, targetKind: "thread", targetId: threadId, revision: 1, createdBy: actor.principalId, createdAt: now };
    return this.notify(projectId, this.store.createTaskFromThread(task, relation, context));
  }

  updateTask(projectId: string, taskId: string, input: { title: string; description: string; status: KnowledgeTaskStatus; priority: KnowledgeTaskPriority; expectedRevision: number }, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeTask> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new KnowledgeError("invalid_request", "Oczekiwana rewizja musi być dodatnia.");
    const title = this.text(input.title, "Tytuł", 200);
    const description = this.text(input.description, "Opis", 65_536);
    if (!["open", "in_progress", "blocked", "done", "archived"].includes(input.status)) throw new KnowledgeError("invalid_request", "Nieprawidłowy stan.");
    if (!["now", "next", "later"].includes(input.priority)) throw new KnowledgeError("invalid_request", "Nieprawidłowy priorytet.");
    const payload = { taskId, title, description, status: input.status, priority: input.priority, expectedRevision: input.expectedRevision };
    const context = this.context("task.update", projectId, payload, options, actor);
    const replay = this.store.findIdempotentResult<KnowledgeTask>("task.update", context);
    if (replay) return replay;
    this.requireActiveProject(projectId);
    const current = this.store.getTask(projectId, taskId);
    if (!current) throw new KnowledgeError("not_found", "Nie znaleziono zadania.");
    const task = { ...current, title, description, status: input.status, priority: input.priority, revision: input.expectedRevision + 1, updatedAt: this.clock() };
    return this.notify(projectId, this.store.updateTask(task, input.expectedRevision, context));
  }

  archiveProject(projectId: string, expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeProject> {
    return this.setProjectStatus(projectId, "archived", expectedRevision, options, actor);
  }

  restoreProject(projectId: string, expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeProject> {
    return this.setProjectStatus(projectId, "active", expectedRevision, options, actor);
  }

  private setProjectStatus(projectId: string, status: KnowledgeProject["status"], expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeProject> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    this.revision(expectedRevision);
    const operation = status === "active" ? "project.restore" : "project.archive";
    const context = this.context(operation, projectId, { expectedRevision }, options, actor);
    const replay = this.store.findIdempotentResult<KnowledgeProject>(operation, context);
    if (replay) return replay;
    const current = this.store.getKnowledgeProject(projectId);
    if (!current) throw new KnowledgeError("not_found", "Nie znaleziono projektu wiedzy.");
    if (status === "archived" && current.status !== "active") throw new KnowledgeError("invalid_request", "Projekt wiedzy jest już zarchiwizowany.");
    const project = { ...current, status, revision: expectedRevision + 1, updatedAt: this.clock() };
    return this.notify(projectId, this.store.updateKnowledgeProject(project, expectedRevision, context));
  }

  setRuntimeLink(projectId: string, runtimeProjectId: string | null, expectedRevision: number, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationResult<KnowledgeRuntimeLinkResult> {
    this.identity.authorizeKnowledge(actor, projectId, "knowledge:write", { allowArchived: true });
    this.revision(expectedRevision);
    const context = this.context("project.runtime_link", projectId, { runtimeProjectId, expectedRevision }, options, actor);
    const replay = this.store.findIdempotentResult<KnowledgeRuntimeLinkResult>("project.runtime_link", context);
    if (replay) return replay;
    this.requireActiveProject(projectId);
    if (runtimeProjectId !== null) {
      if (!this.store.hasRuntimeProject(runtimeProjectId)) throw new KnowledgeError("not_found", "Nie znaleziono projektu runtime.");
      const owner = this.store.getRuntimeLinkOwner(runtimeProjectId);
      if (owner !== null && owner !== projectId) throw new KnowledgeError("invalid_request", "Projekt runtime jest już powiązany z innym projektem wiedzy.");
    }
    const now = this.clock();
    const link = { projectId, runtimeProjectId, linkedAt: now, unlinkedAt: runtimeProjectId === null ? now : null };
    return this.notify(projectId, this.store.setKnowledgeProjectRuntimeLink(link, expectedRevision, context));
  }

  private context(operation: string, projectId: string, payload: unknown, options: KnowledgeWriteOptions, actor: AuthenticatedPrincipal): KnowledgeMutationContext {
    const key = options.idempotencyKey.trim();
    if (!key || key.length > 200) throw new KnowledgeError("invalid_request", "Klucz idempotencji musi mieć od 1 do 200 znaków.");
    return { actor, projectId, idempotencyKey: key, requestHash: canonicalHash({ operation, projectId, payload }) };
  }

  private requireActiveProject(projectId: string): void {
    if (this.store.getKnowledgeProject(projectId)?.status !== "active") throw new KnowledgeError("invalid_request", "Projekt wiedzy jest zarchiwizowany.");
  }

  private text(value: string, label: string, maximum: number): string {
    const normalized = value.trim();
    if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum) throw new KnowledgeError("invalid_request", `${label} ma nieprawidłową długość.`);
    return normalized;
  }

  private revision(value: number): void {
    if (!Number.isInteger(value) || value < 1) throw new KnowledgeError("invalid_request", "Oczekiwana rewizja musi być dodatnia.");
  }

  private page(options: KnowledgePageOptions): { limit: number; offset: number } {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new KnowledgeError("invalid_request", "Limit musi wynosić od 1 do 100.");
    if (!Number.isInteger(offset) || offset < 0) throw new KnowledgeError("invalid_request", "Offset musi być nieujemny.");
    return { limit, offset };
  }
}
