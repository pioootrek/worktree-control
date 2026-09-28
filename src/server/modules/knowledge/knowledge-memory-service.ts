import { knowledgeSourceHref } from "@/shared/contracts/knowledge-links";
import { createHash } from "node:crypto";
import type { AuthenticatedPrincipal, IdentityService } from "@/server/modules/identity";
import type { KnowledgeSource, KnowledgeMemory, MemoryRequest, KnowledgeTaskContext, KnowledgeContextMemory, KnowledgeSourceState, KnowledgeExport } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeStore, KnowledgeMutationContext } from "./contracts";
import { KnowledgeError } from "./knowledge-error";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const clip = (value: string, length: number) => Array.from(value).slice(0, length).join("");

/** Invoked only after the shared HTTP/MCP/CLI schema validation. */
export class KnowledgeMemoryService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly identity: Pick<IdentityService, "authorizeKnowledge" | "describeIdentity">,
    private readonly clock: () => string,
    private readonly id: () => string,
    private readonly changed: (projectId: string) => void,
  ) {}

  execute(request: MemoryRequest, actor: AuthenticatedPrincipal) {
    const { projectId } = request.input;
    const permission = request.operation === "approve_memory" ? "knowledge:approve"
      : "idempotencyKey" in request.input ? "knowledge:write"
        : request.operation === "export_context" ? "knowledge:export" : "knowledge:read";
    this.identity.authorizeKnowledge(actor, projectId, permission, { allowArchived: true });
    // Mutation responses (including replay) contain retained record content.
    if ("idempotencyKey" in request.input || request.operation === "export_context") {
      this.identity.authorizeKnowledge(actor, projectId, "knowledge:read", { allowArchived: true });
    }
    const limit = "limit" in request.input ? request.input.limit ?? 25 : 25;
    const offset = "offset" in request.input ? request.input.offset ?? 0 : 0;
    switch (request.operation) {
      case "memory": return this.memory(projectId, request.input.memoryId);
      case "memories": {
        const page = this.store.listMemories(projectId, limit, offset, request.input.query ?? "", request.input.includeInactive ?? false);
        return { ...page, items: page.items.map(value => this.summary(value, true)) };
      }
      case "search": return this.store.searchKnowledge(projectId, limit, offset, request.input);
      case "check_context_export": {
        const context = this.taskContext(projectId, request.input.taskId, limit, offset);
        return { current: context.fingerprint === request.input.fingerprint, fingerprint: context.fingerprint, generatedAt: context.generatedAt };
      }
      case "task_context": return this.taskContext(projectId, request.input.taskId, limit, offset);
      case "export_context": return this.exportContext(this.taskContext(projectId, request.input.taskId, limit, offset), request.input.format);
      default: return this.mutate(request, actor);
    }
  }

  private memory(projectId: string, id: string) {
    const value = this.store.getMemory(projectId, id);
    if (!value) throw new KnowledgeError("not_found", "Memory not found.");
    return value;
  }

  private sourceRecord(projectId: string, source: KnowledgeSource) {
    switch (source.kind) {
      case "task": return this.store.getTask(projectId, source.id);
      case "thread": return this.store.getThread(projectId, source.id);
      case "reply": return this.store.getReply(projectId, source.id);
      case "memory": return this.store.getMemory(projectId, source.id);
      case "external": case "repository": return null;
    }
  }

  private validateSources(projectId: string, memoryId: string, sources: KnowledgeSource[]) {
    for (const source of sources) {
      if (source.kind === "external" || source.kind === "repository") continue;
      if (source.kind === "memory" && source.id === memoryId) throw new KnowledgeError("invalid_request", "Memory cannot cite itself.");
      const record = this.sourceRecord(projectId, source);
      if (!record) throw new KnowledgeError("not_found", "Source not found in this project.");
      if (record.revision !== source.revision) throw new KnowledgeError("revision_conflict", "Source revision changed.", record.revision);
    }
  }

  private mutate(request: Extract<MemoryRequest, { input: { idempotencyKey: string } }>, actor: AuthenticatedPrincipal) {
    const { input, operation } = request;
    const context: KnowledgeMutationContext = { actor, projectId: input.projectId, idempotencyKey: input.idempotencyKey, requestHash: hash(input) };
    const replay = this.store.findIdempotentResult<KnowledgeMemory>(operation, context);
    if (replay) return replay;
    if (this.store.getKnowledgeProject(input.projectId)?.status !== "active") throw new KnowledgeError("invalid_request", "Restore the project before changing memory.");
    const now = this.clock();
    let memory: KnowledgeMemory;
    let expectedRevision: number | null = null;
    if (request.operation === "create_memory") {
      const { title, body, category, sources, tags, legacyId } = request.input;
      memory = { id: this.id(), projectId: input.projectId, title, body, category, sources, tags: [...new Set(tags)], legacyId, status: "active", approval: null, supersededBy: null, revision: 1, createdBy: actor.principalId, createdAt: now, updatedAt: now };
      this.validateSources(input.projectId, memory.id, sources);
    } else {
      const previous = this.memory(request.input.projectId, request.input.memoryId);
      expectedRevision = request.input.expectedRevision;
      if (previous.revision !== expectedRevision) throw new KnowledgeError("revision_conflict", "Memory revision changed.", previous.revision);
      if (previous.status === "superseded") throw new KnowledgeError("invalid_request", "Superseded memory is immutable; open its replacement.");
      const { reading: _reading, ...stored } = previous;
      void _reading;
      memory = { ...stored, revision: previous.revision + 1, updatedAt: now, approval: null };
      if (request.operation !== "restore_memory" && previous.status !== "active") throw new KnowledgeError("invalid_request", "Restore archived memory first.");
      switch (request.operation) {
        case "update_memory": {
          const { title, body, category, tags, legacyId, sources } = request.input;
          this.validateSources(input.projectId, memory.id, sources);
          memory = { ...memory, title, body, category, tags: [...new Set(tags)], legacyId, sources };
          break;
        }
        case "approve_memory":
          this.validateSources(input.projectId, memory.id, memory.sources);
          memory.approval = { revision: memory.revision, principalId: actor.principalId, approvedAt: now };
          break;
        case "archive_memory": memory.status = "archived"; break;
        case "restore_memory":
          if (previous.status !== "archived") throw new KnowledgeError("invalid_request", "Memory is not archived.");
          memory.status = "active"; break;
        case "supersede_memory": {
          const replacement = this.memory(input.projectId, request.input.replacementId);
          if (replacement.id === memory.id || replacement.status !== "active") throw new KnowledgeError("invalid_request", "Choose a different active replacement.");
          if (replacement.revision !== request.input.replacementRevision) throw new KnowledgeError("revision_conflict", "Replacement revision changed.", replacement.revision);
          memory.approval = previous.approval;
          memory.status = "superseded";
          memory.supersededBy = { id: replacement.id, revision: replacement.revision };
          break;
        }
      }
    }
    const result = this.store.saveMemory(memory, expectedRevision, operation, context);
    if (!result.replayed) this.changed(input.projectId);
    return result;
  }

  private summary(memory: KnowledgeMemory, includeReading = false) {
    const { body: _body, sources: _sources, reading, ...stored } = memory;
    void _body; void _sources;
    const summary = includeReading && reading ? { ...stored, reading } : stored;
    return summary;
  }

  private sourceState(projectId: string, source: KnowledgeSource): KnowledgeSourceState {
    const current = this.sourceRecord(projectId, source);
    return { source, href: knowledgeSourceHref(projectId, source, current && "threadId" in current ? current.threadId : undefined), currentRevision: current?.revision ?? null,
      stale: source.kind !== "external" && source.kind !== "repository" && current?.revision !== source.revision,
      inactive: Boolean(current && "status" in current && ["archived", "superseded"].includes(current.status)) };
  }

  private taskContext(projectId: string, taskId: string, limit: number, offset: number): KnowledgeTaskContext {
    const record = this.store.getTask(projectId, taskId);
    if (!record) throw new KnowledgeError("not_found", "Task not found.");
    // All reads are synchronous on the controller's single SQLite connection.
    const page = this.store.listMemories(projectId, limit, offset, "", false, taskId);
    const { description, ...task } = record;
    const scope = clip(description, 4000);
    const data: Omit<KnowledgeTaskContext, "fingerprint"> = { formatVersion: 1, generatedAt: this.clock(), projectId, task,
      taskHref: knowledgeSourceHref(projectId, { kind: "task", id: taskId, revision: task.revision }), page: { limit, offset },
      scope, scopeTruncated: scope !== description, decisions: [], proposals: [], openQuestions: [],
      evidence: [], nextOffset: page.nextOffset };
    // Bound before adding each record; never silently discard an unread remainder.
    for (const memory of page.items) {
      const excerpt = clip(memory.body, 1200);
      const item: KnowledgeContextMemory = { ...this.summary(memory), href: knowledgeSourceHref(projectId, { kind: "memory", id: memory.id, revision: memory.revision }), excerpt, bodyTruncated: excerpt !== memory.body,
        sourceStates: memory.sources.map(source => this.sourceState(projectId, source)) };
      const group = memory.category === "question" ? data.openQuestions
        : memory.category === "decision" && memory.approval?.revision === memory.revision ? data.decisions : data.proposals;
      group.push(item);
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > 220000) {
        group.pop();
        data.nextOffset = offset + data.decisions.length + data.proposals.length + data.openQuestions.length;
        if (data.nextOffset === offset) throw new KnowledgeError("limit_exceeded", "Memory exceeds the context budget. Read the full memory separately.");
        break;
      }
    }
    const relations = this.store.listRelations(projectId, "task", taskId, 100, 0);
    // Scope's full thread is deliberately a separate read. A task has one derived thread in K2/K3.
    data.evidence = relations.items.filter(relation => relation.type === "derived_from" && relation.sourceKind === "task" && relation.sourceId === taskId).map(relation => {
      const source = { kind: relation.targetKind, id: relation.targetId, revision: 1 } as KnowledgeSource;
      const current = this.sourceRecord(projectId, source);
      return this.sourceState(projectId, { ...source, revision: current?.revision ?? 1 } as KnowledgeSource);
    });
    const { generatedAt: _generatedAt, ...fingerprintData } = data;
    void _generatedAt;
    const result = { ...data, fingerprint: hash(fingerprintData) };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 262144) throw new KnowledgeError("limit_exceeded", "Context exceeds 256 KiB. Request a smaller page.");
    return result;
  }

  private exportContext(context: KnowledgeTaskContext, format: "json" | "markdown"): KnowledgeExport {
    // Serialize user text as inert quoted data; consumers must not treat an export as instructions.
    const quote = (value: string) => value.replace(/[\\`*_{}\[\]()#+.!|~-]/g, char => `\\${char}`).replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!).split("\n").map(line => `> ${line}`).join("\n");
    const content = format === "json" ? JSON.stringify(context, null, 2) : [
      "# Task context", `Format: ${context.formatVersion}`, `Generated: ${context.generatedAt}`,
      `Project: ${context.projectId}`, `[Open task](${context.taskHref})`, `Page: ${context.page.offset}; limit: ${context.page.limit}`, `Task: ${context.task.id} (revision ${context.task.revision})`,
      `Fingerprint: ${context.fingerprint}`, `Next offset: ${context.nextOffset ?? "none"}`,
      "## Scope", quote(context.scope), `Scope truncated: ${context.scopeTruncated}`,
      ...([ ["Decisions", context.decisions], ["Proposals", context.proposals], ["Open questions", context.openQuestions] ] as const).flatMap(([label, items]) => [
        `## ${label}`, ...items.flatMap(item => [quote(item.title), `ID: ${item.id}; revision: ${item.revision}; truncated: ${item.bodyTruncated}`, `[Open memory](${item.href})`,
          quote(item.excerpt), quote(JSON.stringify({ approval: item.approval, sources: item.sourceStates }))]),
      ]), "## Evidence", quote(JSON.stringify(context.evidence)),
    ].join("\n\n");
    const result: KnowledgeExport = { formatVersion: 1, generatedAt: context.generatedAt, projectId: context.projectId, taskId: context.task.id,
      fingerprint: context.fingerprint, format, content, nextOffset: context.nextOffset };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 262144) throw new KnowledgeError("limit_exceeded", "Export exceeds 256 KiB. Request a smaller page.");
    return result;
  }
}
