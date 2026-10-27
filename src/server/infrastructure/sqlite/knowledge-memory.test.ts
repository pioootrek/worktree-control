import { stripMigrationProvenance } from "./fixtures/legacy-registry";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import type { KnowledgeInput, KnowledgeOperation, KnowledgeMutationResult, KnowledgePage, KnowledgeTask } from "@/shared/contracts/knowledge";
import type { KnowledgeMemory, KnowledgeSearchHit, KnowledgeTaskContext, KnowledgeExport } from "@/shared/contracts/knowledge-memory";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-k4-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite3");
  const store = new SqliteStateStore(path); cleanups.push(() => store.close());
  const identity = new IdentityService(store);
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = identity.createKnowledgeProject({ name: "Synthetic project" }, owner);
  const privateProject = identity.createKnowledgeProject({ name: "Private" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: privateProject.id, permissions: ["knowledge:read", "knowledge:write"] }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:approve", "knowledge:export"] }, owner);
  const agent = identity.createAgent(owner);
  identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:export"] }, owner);
  const actor = identity.authenticateBearer(identity.issueAgentToken({ principalId: agent.id, label: "test" }, owner).token);
  const changed = vi.fn();
  let next = 0;
  const service = new KnowledgeService(store, identity, undefined, () => `record-${++next}`, changed);
  const call = <T>(operation: KnowledgeOperation, input: Record<string, unknown> = {}, who = actor): T => service.execute({ operation, input: { projectId: project.id, ...input } }, who) as T;
  const task = call<KnowledgeMutationResult<KnowledgeTask>>("create_task", { title: "Task", description: "Deliver one verified change", idempotencyKey: "task" }).value;
  const input = { title: "Decision", body: "Use SQLite", category: "decision" as KnowledgeMemory["category"], tags: ["żółć"], legacyId: "NOTE-42", sources: [{ kind: "task" as const, id: task.id, revision: task.revision }], idempotencyKey: "memory" };
  const create = (patch: Partial<typeof input> = {}) => call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { ...input, ...patch }).value;
  const change = (operation: KnowledgeOperation, memory: KnowledgeMemory, extra: Record<string, unknown> = {}, who = owner) => call<KnowledgeMutationResult<KnowledgeMemory>>(operation, { memoryId: memory.id, expectedRevision: memory.revision, idempotencyKey: `${operation}-${memory.id}-${memory.revision}`, ...extra }, who).value;
  return { path, store, identity, owner, actor, agent, project, privateProject, service, changed, call, task, input, create, change };
}

describe("K4 memory and session context", () => {
  it("projects exact revision changes across history pages while keeping raw audit snapshots", () => {
    const f = setup();
    let memory = f.create();
    memory = f.change("approve_memory", memory);
    expect(memory.approval?.revision).toBe(2);
    memory = f.change("update_memory", memory, { ...f.input, idempotencyKey: "edit-3", body: "Revised decision" });
    memory = f.change("archive_memory", memory);
    memory = f.change("restore_memory", memory);
    for (let revision = 6; revision <= 27; revision++) {
      memory = f.change("update_memory", memory, { ...f.input, idempotencyKey: `edit-${revision}`, body: `Revision ${revision}` });
    }
    const raw = f.service.history(f.project.id, "memory", memory.id, f.owner, { limit: 1 });
    expect(raw.items[0]).not.toHaveProperty("comparison");
    const first = f.service.history(f.project.id, "memory", memory.id, f.owner, { limit: 25, includeComparison: true });
    const second = f.service.history(f.project.id, "memory", memory.id, f.owner, { limit: 25, offset: first.nextOffset!, includeComparison: true });
    expect(() => f.service.history(f.privateProject.id, "memory", memory.id, f.actor)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(first.items).toHaveLength(25);
    expect(first.nextOffset).toBe(25);
    expect(first.items[0]?.comparison).toEqual({ before: null, after: expect.objectContaining({ title: "Decision" }) });
    expect(first.items[1]?.comparison?.after.approval).toMatchObject({ revision: 2, principalId: f.owner.principalId });
    expect(first.items[2]?.comparison).toMatchObject({ before: { approval: { revision: 2 } }, after: { approval: null, body: "Revised decision" } });
    expect(first.items[3]?.comparison?.after.status).toBe("archived");
    expect(first.items[4]?.comparison).toMatchObject({ before: { status: "archived" }, after: { status: "active" } });
    expect(first.items[24]?.comparison?.after.body).toBe("Revision 25");
    expect(second.items[0]?.comparison?.after.body).toBe("Revision 26");
    expect(second.items.at(-1)?.comparison?.after.body).toBe("Revision 27");
    expect(JSON.parse(first.items[2]!.previousJson!)).toMatchObject({ revision: 2, approval: { revision: 2 } });
    const replacement = f.create({ title: "Replacement", idempotencyKey: "replacement" });
    const superseded = f.change("supersede_memory", memory, { replacementId: replacement.id, replacementRevision: replacement.revision });
    expect(f.service.history(f.project.id, "memory", memory.id, f.owner, { limit: 25, offset: 25, includeComparison: true }).items.at(-1)?.comparison?.after)
      .toMatchObject({ status: "superseded", supersededBy: { id: replacement.id, revision: replacement.revision } });
    expect(superseded.revision).toBe(28);
  });

  it("withholds the current comparison when imported current metadata is malformed", () => {
    const f = setup();
    const memory = f.create();
    f.store.close();
    const database = new Database(f.path);
    database.prepare("UPDATE knowledge_memories SET approval_json=? WHERE project_id=? AND id=?").run("{", f.project.id, memory.id);
    database.close();
    const reopened = new SqliteStateStore(f.path); cleanups.push(() => reopened.close());
    const event = reopened.listHistory(f.project.id, "memory", memory.id, 25, 0, true).items[0];
    expect(event).toMatchObject({ operation: "created", previousJson: null, comparison: null });
  });

  it("does not bridge an imported history revision gap or pair it with the current record", () => {
    const f = setup();
    const memory = f.create();
    f.store.close();
    const database = new Database(f.path);
    database.prepare(`INSERT INTO knowledge_history(project_id,record_kind,record_id,operation,previous_json,principal_id,authentication_method,revision,created_at)
      VALUES (?,'memory',?,'updated',?,?,?,3,?)`).run(f.project.id, memory.id, JSON.stringify({ ...memory, revision: 2 }), f.owner.principalId, "owner_session", memory.createdAt);
    database.close();
    const reopened = new SqliteStateStore(f.path); cleanups.push(() => reopened.close());
    const events = reopened.listHistory(f.project.id, "memory", memory.id, 25, 0, true).items;
    expect(events.map(event => event.comparison)).toEqual([null, null]);
    expect(events[1]?.previousJson).toBe(JSON.stringify({ ...memory, revision: 2 }));
  });

  it("pins approval to a revision, audits it, clears it on editing and persists after restart", () => {
    const f = setup(); const memory = f.create();
    expect(() => f.change("approve_memory", memory, {}, f.actor)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    const approved = f.change("approve_memory", memory);
    expect(approved.approval).toMatchObject({ revision: 2, principalId: f.owner.principalId });
    expect(f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id }).decisions[0].id).toBe(memory.id);
    const updated = f.change("update_memory", approved, { ...f.input, body: "Try PostgreSQL" });
    expect(updated).toMatchObject({ revision: 3, approval: null });
    expect(() => f.change("approve_memory", approved, { idempotencyKey: "stale-approval" })).toThrowError(expect.objectContaining({ code: "revision_conflict", currentRevision: 3 }));
    const history = f.store.listHistory(f.project.id, "memory", memory.id, 25, 0).items;
    expect(history.map(entry => entry.operation)).toEqual(["created", "approved", "updated"]);
    expect(JSON.parse(history[2].previousJson!).approval.revision).toBe(2);
    f.store.close();
    const reopened = new SqliteStateStore(f.path); cleanups.push(() => reopened.close());
    expect(reopened.getMemory(f.project.id, memory.id)).toEqual(updated);
    expect(reopened.listHistory(f.project.id, "memory", memory.id, 25, 0).items).toEqual(history);
  });

  it("replays before stale checks but reauthorizes each replay and emits one event", () => {
    const f = setup(); const memory = f.create(); const events = f.changed.mock.calls.length;
    const replay = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", f.input);
    expect(replay).toEqual({ value: memory, replayed: true }); expect(f.changed).toHaveBeenCalledTimes(events);
    expect(() => f.create({ body: "Other" })).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    const approved = f.change("approve_memory", memory);
    f.change("update_memory", approved, { ...f.input, body: "Changed" });
    expect(f.change("approve_memory", memory)).toEqual(approved);
    f.identity.revokeKnowledgeGrant(f.agent.id, f.project.id, f.owner);
    expect(() => f.create()).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(() => f.call("search", { query: "SQLite" })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(() => f.call("export_context", { taskId: f.task.id, format: "json" })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
  });

  it.each(["create_memory", "update_memory", "archive_memory", "restore_memory", "supersede_memory"] as const)("requires read access for %s and its replay after grant removal", operation => {
    const f = setup();
    let memory = f.create();
    const replacement = f.create({ idempotencyKey: "replacement" });
    if (operation === "restore_memory") memory = f.change("archive_memory", memory);
    const input = { ...f.input, memoryId: memory.id, expectedRevision: memory.revision, idempotencyKey: "permitted" };
    const request: Record<string, unknown> = operation === "create_memory" ? { ...f.input, idempotencyKey: "permitted" }
      : operation === "update_memory" ? input
        : { memoryId: memory.id, expectedRevision: memory.revision, idempotencyKey: "permitted",
          ...(operation === "supersede_memory" ? { replacementId: replacement.id, replacementRevision: replacement.revision } : {}) };
    const result = f.call<KnowledgeMutationResult<KnowledgeMemory>>(operation, request);
    const history = f.store.listHistory(f.project.id, "memory", result.value.id, 100, 0);
    const events = f.changed.mock.calls.length;
    f.identity.setKnowledgeGrant({ principalId: f.agent.id, projectId: f.project.id, permissions: ["knowledge:write"] }, f.owner);
    expect(() => f.call("memory", { memoryId: result.value.id })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    for (const idempotencyKey of ["permitted", "fresh-denied"]) {
      expect(() => f.call(operation, { ...request, idempotencyKey })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    }
    expect(f.store.getMemory(f.project.id, result.value.id)).toEqual(result.value);
    expect(f.store.listHistory(f.project.id, "memory", result.value.id, 100, 0)).toEqual(history);
    expect(f.changed).toHaveBeenCalledTimes(events);
  });

  it("rejects cross-project, stale and self sources, spoofed approval and oversized writes", () => {
    const f = setup();
    const foreign = f.call<KnowledgeMutationResult<KnowledgeTask>>("create_task", { projectId: f.privateProject.id, title: "Private", description: "Secret", idempotencyKey: "private" }, f.owner).value;
    expect(() => f.create({ sources: [{ kind: "task", id: foreign.id, revision: 1 }] })).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() => f.create({ sources: [{ kind: "task", id: f.task.id, revision: 9 }] })).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
    expect(() => f.call("create_memory", { ...f.input, approval: { principalId: "human:owner" } })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => f.create({ body: "ą".repeat(40000) })).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
    const memory = f.create();
    expect(() => f.change("update_memory", memory, { ...f.input, sources: [{ kind: "memory", id: memory.id, revision: 1 }] })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => f.call("search", { projectId: f.privateProject.id })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(f.store.listMemories(f.project.id, 100, 0, "", true).items).toHaveLength(1);
  });

  it("supersedes and archives explicitly; default search/context omit inactive records", () => {
    const f = setup(); const old = f.change("approve_memory", f.create());
    const replacement = f.change("approve_memory", f.create({ title: "New decision", idempotencyKey: "new" }));
    expect(() => f.change("supersede_memory", old, { replacementId: old.id, replacementRevision: old.revision })).toThrow();
    const superseded = f.change("supersede_memory", old, { replacementId: replacement.id, replacementRevision: replacement.revision });
    expect(superseded.supersededBy).toEqual({ id: replacement.id, revision: replacement.revision });
    expect(superseded.approval).toEqual(old.approval);
    expect(superseded.approval!.revision).toBeLessThan(superseded.revision);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { status: "superseded" }).items.map(item => item.id)).toEqual([old.id]);
    expect(() => f.change("supersede_memory", replacement, { replacementId: old.id, replacementRevision: superseded.revision })).toThrow();
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id });
    expect(context.decisions.map(item => item.id)).toEqual([replacement.id]);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { kind: "memory" }).items.map(item => item.id)).toEqual([replacement.id]);
    expect(f.call<KnowledgeMemory>("memory", { memoryId: old.id })).toEqual(superseded);
    const archived = f.change("archive_memory", replacement);
    f.call("update_task", { taskId: f.task.id, title: f.task.title, description: f.task.description, priority: f.task.priority, status: "archived", expectedRevision: f.task.revision, idempotencyKey: "archive-task" });
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { status: "archived" }).items.map(item => item.id).sort()).toEqual([replacement.id, f.task.id].sort());
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { kind: "memory", status: "archived", includeInactive: false }).items.map(item => item.id)).toEqual([replacement.id]);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { kind: "memory" }).items).toEqual([]);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { kind: "memory", includeInactive: true }).items).toHaveLength(2);
    expect(f.change("restore_memory", archived)).toMatchObject({ status: "active", approval: null });
  });

  it("searches Unicode body, tags and legacy IDs with literal syntax, filters and pagination", () => {
    const f = setup(); const memory = f.create({ body: "Zażółć gęślą jaźń, 100% _ ' OR 1=1" });
    for (const query of ["ZAŻÓŁĆ", "ŻÓŁĆ", "NOTE-42", "100% _ ' OR 1=1"]) {
      expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { query }).items[0].id).toBe(memory.id);
    }
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { tag: "ŻÓŁĆ", legacyId: "NOTE-42" }).items).toHaveLength(1);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { tag: "no match" }).items).toEqual([]);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { query: "[]" }).items).toEqual([]);
    const thread = f.call<KnowledgeMutationResult<{ id: string }>>("create_thread", { title: "Thread", body: "unique body needle", idempotencyKey: "thread" }).value;
    f.call("create_reply", { threadId: thread.id, body: "unique reply needle", idempotencyKey: "reply" });
    const found = f.call<KnowledgePage<KnowledgeSearchHit>>("search", { query: "needle", limit: 1 });
    expect(found.items).toHaveLength(1); expect(found.nextOffset).toBe(1);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { query: "needle", limit: 1, offset: 1 }).items[0].id).not.toBe(found.items[0].id);
    expect(f.call<KnowledgePage<KnowledgeSearchHit>>("search", { kind: "task", status: "open", query: "verified" }).items[0].id).toBe(f.task.id);
  });

  it("gives a new session scope, current decisions and questions; exports disclose stale sources and revisions", () => {
    const f = setup(); f.change("approve_memory", f.create());
    f.create({ title: "Unresolved cost?", category: "question", idempotencyKey: "question" });
    const first = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id });
    expect(first).toMatchObject({ scope: f.task.description, nextOffset: null, scopeTruncated: false });
    expect(first.decisions).toHaveLength(1); expect(first.openQuestions).toHaveLength(1);
    const exported = f.call<KnowledgeExport>("export_context", { taskId: f.task.id, format: "json" });
    expect(JSON.parse(exported.content)).toMatchObject({ fingerprint: first.fingerprint, formatVersion: 1 });
    f.call("update_task", { taskId: f.task.id, title: f.task.title, description: "New scope", priority: "now", status: "in_progress", expectedRevision: 1, idempotencyKey: "scope" });
    const next = new KnowledgeService(f.store, f.identity).execute({ operation: "task_context", input: { projectId: f.project.id, taskId: f.task.id } }, f.actor) as KnowledgeTaskContext;
    expect(next.fingerprint).not.toBe(exported.fingerprint);
    expect(next.decisions[0].sourceStates[0]).toMatchObject({ stale: true, currentRevision: 2 });
    const markdown = f.call<KnowledgeExport>("export_context", { taskId: f.task.id, format: "markdown" });
    expect(markdown.content).toContain("## Open questions"); expect(markdown.content).toContain("Unresolved cost?");
    expect(markdown.content).toContain('"stale":true');
  });

  it("bounds context, discloses excerpt truncation and requires separate export permission", () => {
    const f = setup();
    for (let i = 0; i < 27; i++) f.create({ body: "ą".repeat(3000), idempotencyKey: `large-${i}` });
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id });
    expect(context.nextOffset).toBe(25); expect(context.proposals).toHaveLength(25);
    expect(context.proposals.every(item => item.bodyTruncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(262144);
    f.identity.setKnowledgeGrant({ principalId: f.agent.id, projectId: f.project.id, permissions: ["knowledge:read"] }, f.owner);
    expect(() => f.call("export_context", { taskId: f.task.id, format: "json" })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, offset: 25 }).proposals).toHaveLength(2);
  });

  it("opts into A/B/C predecessor history in both export formats without promoting old approvals", () => {
    const f = setup();
    const a = f.change("approve_memory", f.create({ title: "A <script>old</script>" }));
    const b = f.change("approve_memory", f.create({ title: "B", idempotencyKey: "b" }));
    const oldA = f.change("supersede_memory", a, { replacementId: b.id, replacementRevision: b.revision });
    const c = f.change("approve_memory", f.create({ title: "C", idempotencyKey: "c" }));
    const oldB = f.change("supersede_memory", b, { replacementId: c.id, replacementRevision: c.revision });
    const input = { taskId: f.task.id };
    const plain = f.call<KnowledgeTaskContext>("task_context", input);
    expect(plain).not.toHaveProperty("supersessionHistory");
    expect(f.call<KnowledgeTaskContext>("task_context", { ...input, includeSuperseded: false }).fingerprint).toBe(plain.fingerprint);
    const context = f.call<KnowledgeTaskContext>("task_context", { ...input, includeSuperseded: true });
    expect(context.decisions.map(item => item.id)).toEqual([c.id]);
    expect(context.proposals).toEqual([]);
    expect(context.supersessionHistory?.chains).toEqual([{ decisionId: c.id, truncated: false, predecessors: [
      expect.objectContaining({ id: oldB.id, status: "superseded", revision: oldB.revision, updatedAt: oldB.updatedAt, supersededBy: { id: c.id, revision: c.revision } }),
      expect.objectContaining({ id: oldA.id, status: "superseded", revision: oldA.revision, updatedAt: oldA.updatedAt, supersededBy: { id: b.id, revision: b.revision } }),
    ] }]);
    const json = f.call<KnowledgeExport>("export_context", { ...input, includeSuperseded: true, format: "json" });
    expect(JSON.parse(json.content).supersessionHistory).toEqual(context.supersessionHistory);
    expect(json.fingerprint).toBe(context.fingerprint);
    expect(f.call("check_context_export", { ...input, includeSuperseded: true, fingerprint: json.fingerprint })).toMatchObject({ current: true });
    expect(f.call("check_context_export", { ...input, fingerprint: json.fingerprint })).toMatchObject({ current: false });
    const markdown = f.call<KnowledgeExport>("export_context", { ...input, includeSuperseded: true, format: "markdown" });
    expect(markdown.content).toContain("## Superseded history (not current decisions or proposals)");
    expect(markdown.content).toContain("Status: superseded");
    expect(markdown.content).toContain('"supersededBy"');
    expect(markdown.content).toContain("&lt;script&gt;old&lt;/script&gt;");
    expect(markdown.content).not.toContain("<script>");
    expect(f.call<KnowledgeExport>("export_context", { ...input, format: "markdown" }).content).not.toContain("## Superseded history");
  });

  it("keeps active pagination and follows predecessors without a direct task citation", () => {
    const f = setup();
    const hidden = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { ...f.input,
      sources: [{ kind: "external", label: "Original discussion", url: "https://example.test" }] }).value;
    const c = f.change("approve_memory", f.create({ idempotencyKey: "current" }));
    f.change("supersede_memory", hidden, { replacementId: c.id, replacementRevision: c.revision });
    f.create({ category: "question", idempotencyKey: "question" });
    f.create({ category: "note", idempotencyKey: "proposal" });
    const found: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const plain = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, limit: 1, offset });
      const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, limit: 1, offset, includeSuperseded: true });
      expect(context).toMatchObject({ decisions: plain.decisions, proposals: plain.proposals, openQuestions: plain.openQuestions, nextOffset: plain.nextOffset });
      expect(context.supersessionHistory?.chains.map(chain => chain.decisionId)).toEqual(context.decisions.map(item => item.id));
      found.push(...context.supersessionHistory!.chains.flatMap(chain => chain.predecessors.map(item => item.id)));
    }
    expect(found).toEqual([hidden.id]);
  });

  it("invalidates the history fingerprint when a new predecessor is attached", () => {
    const f = setup();
    const current = f.change("approve_memory", f.create());
    const hidden = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { ...f.input, idempotencyKey: "hidden",
      sources: [{ kind: "external", label: "History", url: "https://example.test" }] }).value;
    const input = { taskId: f.task.id };
    const plain = f.call<KnowledgeTaskContext>("task_context", input);
    const history = f.call<KnowledgeTaskContext>("task_context", { ...input, includeSuperseded: true });
    f.change("supersede_memory", hidden, { replacementId: current.id, replacementRevision: current.revision });
    expect(f.call("check_context_export", { ...input, fingerprint: plain.fingerprint })).toMatchObject({ current: true });
    expect(f.call("check_context_export", { ...input, includeSuperseded: true, fingerprint: history.fingerprint })).toMatchObject({ current: false });
  });

  it("bounds deep chains and discloses omitted predecessors", () => {
    const f = setup();
    let current = f.create();
    for (let index = 0; index < 10; index++) {
      const replacement = f.create({ idempotencyKey: `depth-${index}` });
      f.change("supersede_memory", current, { replacementId: replacement.id, replacementRevision: replacement.revision });
      current = replacement;
    }
    current = f.change("approve_memory", current);
    const read = vi.spyOn(f.store, "listSupersededPredecessors");
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, includeSuperseded: true });
    expect(context.supersessionHistory?.chains[0]).toMatchObject({ decisionId: current.id, truncated: true });
    expect(context.supersessionHistory?.chains[0].predecessors).toHaveLength(8);
    expect(read).toHaveBeenCalledTimes(9);
  });

  it("caps broad history across a page and reports byte truncation without consuming current entries", () => {
    const f = setup();
    const current = f.change("approve_memory", f.create());
    for (let index = 0; index < 51; index++) {
      const old = f.create({ idempotencyKey: `branch-${index}` });
      f.change("supersede_memory", old, { replacementId: current.id, replacementRevision: current.revision });
    }
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, includeSuperseded: true });
    expect(context.supersessionHistory?.chains[0].truncated).toBe(true);
    expect(context.supersessionHistory!.chains[0].predecessors.length).toBeGreaterThan(0);
    expect(context.supersessionHistory!.chains[0].predecessors.length).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(context.supersessionHistory))).toBeLessThanOrEqual(32768);
    expect(context.nextOffset).toBeNull();
    const huge = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { ...f.input, idempotencyKey: "huge",
      sources: Array.from({ length: 20 }, (_, i) => ({ kind: "external", label: `source-${i}`, url: `https://example.test/${"ą".repeat(1800)}` })) }).value;
    const newest = f.change("approve_memory", f.create({ idempotencyKey: "newest" }));
    f.change("supersede_memory", huge, { replacementId: newest.id, replacementRevision: newest.revision });
    for (const format of ["json", "markdown"] as const) {
      const exported = f.call<KnowledgeExport>("export_context", { taskId: f.task.id, includeSuperseded: true, format });
      expect(Buffer.byteLength(JSON.stringify(exported))).toBeLessThanOrEqual(262144);
    }
    const withHuge = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, includeSuperseded: true });
    expect(withHuge.supersessionHistory?.chains.find(chain => chain.decisionId === newest.id)).toMatchObject({ truncated: true, predecessors: [] });
  });

  it("bounds chain metadata for pages with long Unicode record IDs", () => {
    const f = setup();
    const template = f.change("approve_memory", f.create());
    const items = Array.from({ length: 100 }, (_, index) => ({ ...template, id: `${index}${"界".repeat(155)}` }));
    vi.spyOn(f.store, "listMemories").mockReturnValue({ items, nextOffset: null });
    const plain = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, limit: 100 });
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, limit: 100, includeSuperseded: true });
    expect(context.decisions).toEqual(plain.decisions);
    expect(context.nextOffset).toEqual(plain.nextOffset);
    expect(context.supersessionHistory?.truncated).toBe(true);
    expect(context.supersessionHistory!.chains.length).toBeLessThan(context.decisions.length);
    expect(Buffer.byteLength(JSON.stringify(context.supersessionHistory))).toBeLessThanOrEqual(32768);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(262144);
  });

  it("stops on a repeated predecessor instead of recursively duplicating it", () => {
    const f = setup();
    const current = f.change("approve_memory", f.create());
    const old = f.create({ idempotencyKey: "old" });
    const superseded = f.change("supersede_memory", old, { replacementId: current.id, replacementRevision: current.revision });
    const read = vi.spyOn(f.store, "listSupersededPredecessors").mockReturnValue({ items: [superseded], nextOffset: null });
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id, includeSuperseded: true });
    expect(context.supersessionHistory?.chains[0]).toMatchObject({ truncated: true, predecessors: [expect.objectContaining({ id: old.id })] });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps predecessor reads project-scoped and enforces current read/export grants", () => {
    const f = setup();
    const current = f.change("approve_memory", f.create());
    const foreign = f.call<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { ...f.input, projectId: f.privateProject.id,
      sources: [{ kind: "external", label: "Private", url: "https://private.test" }] }, f.owner).value;
    // Simulate an imported cross-project pointer; the public mutation API rejects this edge.
    f.store.saveMemory({ ...foreign, revision: 2, status: "superseded", supersededBy: { id: current.id, revision: current.revision } }, 1,
      "supersede_memory", { projectId: foreign.projectId, actor: f.owner, idempotencyKey: "import-edge", requestHash: "import-edge" });
    const input = { taskId: f.task.id, includeSuperseded: true };
    expect(f.call<KnowledgeTaskContext>("task_context", input).supersessionHistory?.chains[0]).toMatchObject({ predecessors: [], truncated: false });
    expect(() => f.call("task_context", { ...input, projectId: f.privateProject.id })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    f.identity.setKnowledgeGrant({ principalId: f.agent.id, projectId: f.project.id, permissions: ["knowledge:read"] }, f.owner);
    expect(() => f.call("export_context", { ...input, format: "json" })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    f.identity.setKnowledgeGrant({ principalId: f.agent.id, projectId: f.project.id, permissions: ["knowledge:export"] }, f.owner);
    expect(() => f.call("export_context", { ...input, format: "json" })).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(() => f.call("task_context", input)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
  });

  it("keeps K3 history during migration and rolls back failed memory writes with history/idempotency", () => {
    const f = setup(); const before = f.store.listHistory(f.project.id, "task", f.task.id, 25, 0);
    f.store.close();
    const old = new Database(f.path);
    stripMigrationProvenance(old); old.exec("DROP TABLE knowledge_memories; DELETE FROM schema_migrations WHERE version >= 20;"); old.close();
    const migrated = new SqliteStateStore(f.path); cleanups.push(() => migrated.close());
    expect(migrated.listHistory(f.project.id, "task", f.task.id, 25, 0)).toEqual(before);
    const service = new KnowledgeService(migrated, new IdentityService(migrated), undefined, () => "collision");
    const input: KnowledgeInput<"create_memory"> = { ...f.input, projectId: f.project.id };
    service.execute({ operation: "create_memory", input }, f.actor);
    expect(() => service.execute({ operation: "create_memory", input: { ...input, idempotencyKey: "failed" } }, f.actor)).toThrow();
    expect(migrated.listHistory(f.project.id, "memory", "collision", 100, 0).items).toHaveLength(1);
    const recovered = new KnowledgeService(migrated, new IdentityService(migrated));
    expect(recovered.execute({ operation: "create_memory", input: { ...input, idempotencyKey: "failed" } }, f.actor)).toMatchObject({ replayed: false });
  });
  it("keeps Unicode source URLs bounded and never returns a non-advancing context cursor", () => {
    const f = setup();
    const url = `https://example.test/${"ą".repeat(1800)}`;
    f.call("create_memory", { ...f.input, sources: [...f.input.sources, ...Array.from({ length: 16 }, (_, index) => ({ kind: "external", label: `evidence-${index}`, url }))] });
    const context = f.call<KnowledgeTaskContext>("task_context", { taskId: f.task.id });
    expect(context.proposals).toHaveLength(1); expect(context.nextOffset).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThanOrEqual(262144);
    const exported = f.call<KnowledgeExport>("export_context", { taskId: f.task.id, format: "json" });
    expect(Buffer.byteLength(JSON.stringify(exported), "utf8")).toBeLessThanOrEqual(262144);
    expect(() => f.call("create_memory", { ...f.input, idempotencyKey: "unsafe", sources: [{ kind: "external", label: "Unsafe", url: "javascript:alert(1)" }] })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });

});
