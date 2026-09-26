import type { KnowledgeMemory, KnowledgeTaskContext, KnowledgeExport } from "../../src/shared/contracts/knowledge-memory";
import { afterEach, describe, expect, it } from "vitest";
import { startControllerFixture, type ControllerFixture } from "../support/controller-fixture";
import type { KnowledgeMutationResult, KnowledgePage, KnowledgeTask, KnowledgeThread } from "../../src/shared/contracts/knowledge";

describe("built knowledge controller and CLI", () => {
  let fixture: ControllerFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  it("keeps knowledge and idempotency across restart with no runtime projects", async () => {
    fixture = await startControllerFixture(0);
    // The installation authority administers knowledge; owner bootstrap exists only in legacy mode.
    const owner = { token: fixture.installationToken };
    const admin = <T>(input: unknown) => fixture!.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify(input) });
    const { project } = await admin<{ project: { id: string } }>({ action: "create-knowledge-project", name: "Detached knowledge" });
    const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
    await admin({ action: "grant-knowledge", principalId: principal.id, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] });
    const agent = await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: "integration" });
    const mcp = await fixture.mcp(agent.token);
    let thread: KnowledgeThread;
    try {
      thread = (await mcp.call<KnowledgeMutationResult<KnowledgeThread>>("knowledge_create_thread", { projectId: project.id, title: "Finding", body: "Evidence", idempotencyKey: "finding" })).value;
      expect((await mcp.call<KnowledgePage<KnowledgeThread>>("knowledge_threads", { projectId: project.id })).items).toHaveLength(1);
    } finally { await mcp.close(); }
    const args = ["knowledge", "task_from_thread", "--json", JSON.stringify({ projectId: project.id, threadId: thread.id, title: "Fix", description: "Acceptance", idempotencyKey: "cli-task" })];
    const environment = { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: agent.token };
    const projects = JSON.parse(await fixture.cli(["knowledge", "projects"], environment, "flags")) as KnowledgePage<{ id: string }>;
    expect(projects.items.map(item => item.id)).toEqual([project.id]);
    const first = JSON.parse(await fixture.cli(args, environment, "flags")) as KnowledgeMutationResult<{ task: KnowledgeTask }>;
    await fixture.restart();
    const retry = JSON.parse(await fixture.cli(args, environment)) as KnowledgeMutationResult<{ task: KnowledgeTask }>;
    expect(retry.value).toEqual(first.value); expect(retry.replayed).toBe(true);
    const tasks = JSON.parse(await fixture.cli(["knowledge", "tasks", "--json", JSON.stringify({ projectId: project.id })], environment)) as KnowledgePage<KnowledgeTask>;
    expect(tasks.items).toHaveLength(1);
    const dashboard = await fixture.request<{ projects: unknown[] }>("/api/dashboard");
    expect(dashboard.projects).toEqual([]);
  });
  it("hands an approved decision and open question to a third MCP session and detects a stale CLI export", async () => {
    fixture = await startControllerFixture(0);
    // The installation authority administers knowledge; owner bootstrap exists only in legacy mode.
    const owner = { token: fixture.installationToken };
    const admin = <T>(input: unknown) => fixture!.request<T>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify(input) });
    const { project } = await admin<{ project: { id: string } }>({ action: "create-knowledge-project", name: "K4 synthetic" });
    const tokens: string[] = [];
    for (let index = 0; index < 3; index++) {
      const { principal } = await admin<{ principal: { id: string } }>({ action: "create-agent" });
      await admin({ action: "grant-knowledge", principalId: principal.id, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:export"] });
      tokens.push((await admin<{ token: string }>({ action: "issue-agent-token", principalId: principal.id, label: `session-${index}` })).token);
    }
    const http = <T>(operation: string, input: unknown) => fixture!.request<T>("/api/knowledge", { method: "POST", headers: { Authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ operation, input }) });
    const first = await fixture.mcp(tokens[0]);
    let task: KnowledgeTask; let decision: KnowledgeMemory;
    try {
      task = (await first.call<KnowledgeMutationResult<KnowledgeTask>>("knowledge_create_task", { projectId: project.id, title: "Storage", description: "Preserve history and scoped access", idempotencyKey: "task" })).value;
      decision = (await first.call<KnowledgeMutationResult<KnowledgeMemory>>("knowledge_create_memory", { projectId: project.id, title: "Use SQLite", body: "Keep a single database owner", category: "decision", tags: ["storage"], legacyId: null, sources: [{ kind: "task", id: task.id, revision: 1 }], idempotencyKey: "decision" })).value;
    } finally { await first.close(); }
    decision = (await http<KnowledgeMutationResult<KnowledgeMemory>>("approve_memory", { projectId: project.id, memoryId: decision.id, expectedRevision: 1, idempotencyKey: "approve" })).value;
    const second = await fixture.mcp(tokens[1]);
    try {
      await second.call("knowledge_create_memory", { projectId: project.id, title: "How long to retain history?", body: "Retention requires an owner decision", category: "question", tags: [], legacyId: null, sources: [{ kind: "task", id: task.id, revision: 1 }], idempotencyKey: "question" });
    } finally { await second.close(); }
    await fixture.restart();
    const third = await fixture.mcp(tokens[2]);
    try {
      const context = await third.call<KnowledgeTaskContext>("knowledge_task_context", { projectId: project.id, taskId: task.id });
      expect(context.scope).toBe(task.description);
      expect(context.decisions.map(item => item.id)).toEqual([decision.id]);
      expect(context.openQuestions.map(item => item.title)).toEqual(["How long to retain history?"]);
      const environment = { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: tokens[2] };
      const exported = JSON.parse(await fixture.cli(["knowledge", "export_context", "--json", JSON.stringify({ projectId: project.id, taskId: task.id, format: "json" })], environment)) as KnowledgeExport;
      expect(exported.fingerprint).toBe(context.fingerprint);
      const replacement = (await http<KnowledgeMutationResult<KnowledgeMemory>>("create_memory", { projectId: project.id, title: "New storage decision", body: "An explicit replacement", category: "decision", tags: [], legacyId: null, sources: [{ kind: "task", id: task.id, revision: 1 }], idempotencyKey: "replacement" })).value;
      await http("supersede_memory", { projectId: project.id, memoryId: decision.id, expectedRevision: decision.revision, replacementId: replacement.id, replacementRevision: replacement.revision, idempotencyKey: "supersede" });
      expect(await third.call("knowledge_check_context_export", { projectId: project.id, taskId: task.id, fingerprint: exported.fingerprint })).toMatchObject({ current: false });
      const updated = await third.call<KnowledgeTaskContext>("knowledge_task_context", { projectId: project.id, taskId: task.id });
      expect(updated.decisions).toEqual([]); expect(updated.proposals.map(item => item.id)).toEqual([replacement.id]);
      expect(await third.call("knowledge_memory", { projectId: project.id, memoryId: decision.id })).toMatchObject({ status: "superseded", supersededBy: { id: replacement.id, revision: 1 } });
      // One read restores scope/decisions/questions; three later reads inspect freshness, updated context and provenance.
      expect((await fixture.request<{ projects: unknown[] }>("/api/dashboard")).projects).toEqual([]);
    } finally { await third.close(); }
  });

});
