import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteStateStore } from "./sqlite-state-store";
import { IdentityService, type AuthenticatedPrincipal, type CredentialAuthenticationRecord } from "@/server/modules/identity";
import { KnowledgeError, KnowledgeService } from "@/server/modules/knowledge";

const NOW = "2026-09-13T20:00:00.000Z";
const directories: string[] = [];

function setup(ids: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-knowledge-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite3");
  const store = new SqliteStateStore(path);
  store.savePrincipal({ id: "agent-1", kind: "agent", status: "active" }, "test");
  const credential: CredentialAuthenticationRecord = {
    id: "credential-1", principalId: "agent-1", kind: "agent_token", label: "test",
    tokenPrefix: "wts_credential-1", verifierHash: "a".repeat(64), status: "active",
    expiresAt: null, createdAt: NOW, revokedAt: null, lastUsedAt: null,
  };
  store.saveCredential(credential, "test");
  store.saveKnowledgeProject({ id: "project-1", name: "Knowledge", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW }, "test");
  store.saveKnowledgeProjectGrant({ principalId: "agent-1", projectId: "project-1", permissions: ["knowledge:read", "knowledge:write"], revokedAt: null }, "test");
  const actor: AuthenticatedPrincipal = { principalId: "agent-1", principalKind: "agent", credentialId: "credential-1", authenticationMethod: "agent_token" };
  let next = 0;
  const service = new KnowledgeService(store, new IdentityService(store, () => NOW), () => NOW, () => ids[next++] ?? `id-${next}`);
  return { directory, path, store, service, actor };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("knowledge service SQLite flow", () => {
  it("filters active tasks before pagination and counts the full authorized search", () => {
    const { store, service, actor } = setup();
    for (let i = 0; i < 30; i++) {
      const task = service.createTask("project-1", { title: `Archived work ${i}`, description: "Finished" }, { idempotencyKey: `create-${i}` }, actor).value;
      service.updateTask("project-1", task.id, { title: task.title, description: task.description, priority: "now", status: "done", expectedRevision: 1 }, { idempotencyKey: `finish-${i}` }, actor);
    }
    service.createTask("project-1", { title: "Active work", description: "Next step", priority: "next" }, { idempotencyKey: "active" }, actor);
    const page = service.listTasks("project-1", actor, { activeOnly: true, limit: 1 });
    expect(page.items.map(task => task.title)).toEqual(["Active work"]);
    expect(page.nextOffset).toBeNull();
    expect(page.total).toBe(1);
    expect(page.counts).toEqual({ active: 1, now: 0, next: 1, blocked: 0, done: 30, all: 31 });
    expect(service.listTasks("project-1", actor, { query: "aCTive", activeOnly: true }).counts.all).toBe(1);
    expect(service.listTasks("project-1", actor, { status: "done", limit: 1, offset: 25 })).toMatchObject({ total: 30, nextOffset: 26 });
    expect(service.execute({ operation: "tasks", input: { projectId: "project-1", activeOnly: true } }, actor)).toMatchObject({ total: 1 });
    expect(() => service.execute({ operation: "tasks", input: { projectId: "private", activeOnly: true } }, actor)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    store.close();
  });
  it("persists a thread, reply and atomically linked task across restart", () => {
    const { path, store, service, actor } = setup(["thread-1", "reply-1", "task-1", "relation-1"]);
    const thread = service.createThread("project-1", { title: "Finding", body: "Evidence" }, { idempotencyKey: "thread-key" }, actor).value;
    service.createReply("project-1", thread.id, { body: "Confirmed" }, { idempotencyKey: "reply-key" }, actor);
    const created = service.createTaskFromThread("project-1", thread.id, { title: "Act", description: "Do it", priority: "now" }, { idempotencyKey: "task-key" }, actor);
    expect(created.replayed).toBe(false);
    expect(service.relations("project-1", "thread", thread.id, actor).items).toEqual([created.value.relation]);
    expect(store.listHistory("project-1", "task", created.value.task.id, 25, 0).items).toHaveLength(1);
    store.close();

    const reopened = new SqliteStateStore(path);
    expect(reopened.listThreads("project-1", 25, 0).items).toMatchObject([thread]);
    expect(reopened.getThread("project-1",thread.id)?.presentation).toMatchObject({displayTitle:"Finding",preview:"Evidence",imported:false,replyCount:1});
    expect(reopened.listReplies("project-1", thread.id, 25, 0).items).toHaveLength(1);
    expect(reopened.listTasks("project-1", 25, 0).items[0]).toMatchObject({ id: "task-1", revision: 1 });
    reopened.close();
  });

  it("replays identical requests and rejects an idempotency key with different content", () => {
    const { store, service, actor } = setup(["thread-1", "unused"]);
    const first = service.createThread("project-1", { title: "Finding", body: "Evidence" }, { idempotencyKey: "same" }, actor);
    const replay = service.createThread("project-1", { title: "Finding", body: "Evidence" }, { idempotencyKey: "same" }, actor);
    expect(replay).toEqual({ value: first.value, replayed: true });
    expect(store.listThreads("project-1", 25, 0).items).toHaveLength(1);
    expect(() => service.createThread("project-1", { title: "Changed", body: "Evidence" }, { idempotencyKey: "same" }, actor))
      .toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    store.close();
  });

  it("detects a stale task revision without overwriting the current value", () => {
    const { store, service, actor } = setup(["thread-1", "task-1", "relation-1"]);
    service.createThread("project-1", { title: "Finding", body: "Evidence" }, { idempotencyKey: "thread" }, actor);
    const task = service.createTaskFromThread("project-1", "thread-1", { title: "Act", description: "First" }, { idempotencyKey: "task" }, actor).value.task;
    service.updateTask("project-1", task.id, { title: "Act", description: "Second", priority: "next", status: "in_progress", expectedRevision: 1 }, { idempotencyKey: "update-1" }, actor);
    expect(() => service.updateTask("project-1", task.id, { title: "Act", description: "Stale", priority: "later", status: "blocked", expectedRevision: 1 }, { idempotencyKey: "update-2" }, actor))
      .toThrowError(expect.objectContaining<Partial<KnowledgeError>>({ code: "revision_conflict", currentRevision: 2 }));
    expect(store.getTask("project-1", task.id)).toMatchObject({ description: "Second", revision: 2 });
    expect(store.listHistory("project-1", "task", task.id, 25, 0).items).toHaveLength(2);
    store.close();
  });

  it("rolls back task creation when its relation cannot be inserted", () => {
    const { store, service, actor } = setup(["thread-1", "task-1", "relation-1", "task-2", "relation-1"]);
    service.createThread("project-1", { title: "Finding", body: "Evidence" }, { idempotencyKey: "thread" }, actor);
    service.createTaskFromThread("project-1", "thread-1", { title: "First", description: "First" }, { idempotencyKey: "task-1" }, actor);
    expect(() => service.createTaskFromThread("project-1", "thread-1", { title: "Second", description: "Second" }, { idempotencyKey: "task-2" }, actor)).toThrow();
    expect(store.listTasks("project-1", 25, 0).items).toHaveLength(1);
    expect(store.getTask("project-1", "task-2")).toBeNull();
    expect(store.listHistory("project-1", "task", "task-2", 25, 0).items).toEqual([]);
    const retry = service.createTaskFromThread("project-1", "thread-1", { title: "Second", description: "Second" }, { idempotencyKey: "task-2" }, actor);
    expect(retry.replayed).toBe(false);
    expect(store.listTasks("project-1", 25, 0).items).toHaveLength(2);
    store.close();
  });

  it("preserves knowledge when its linked runtime project is removed", () => {
    const { store, service, actor } = setup(["thread-1"]);
    const runtime = store.addProject({ name: "Runtime", repositoryPath: "/tmp/knowledge-runtime", port: 4321, executable: "pnpm", args: ["run", "dev"] });
    store.saveKnowledgeProjectRuntimeLink({ projectId: "project-1", runtimeProjectId: runtime.id, linkedAt: NOW, unlinkedAt: null }, "test");
    service.createThread("project-1", { title: "Durable", body: "Keep me" }, { idempotencyKey: "thread" }, actor);

    store.removeProject(runtime.id, "test");

    expect(store.getKnowledgeProjectRuntimeLink("project-1")).toMatchObject({ runtimeProjectId: null, unlinkedAt: expect.any(String) });
    expect(store.listThreads("project-1", 25, 0).items).toHaveLength(1);
    store.close();
  });

  it("archives by revision and can explicitly relink an existing knowledge project", () => {
    const { store, service, actor } = setup();
    const first = store.addProject({ name: "First", repositoryPath: "/tmp/knowledge-runtime-first", port: 4322, executable: "pnpm", args: ["run", "dev"] });
    const second = store.addProject({ name: "Second", repositoryPath: "/tmp/knowledge-runtime-second", port: 4323, executable: "pnpm", args: ["run", "dev"] });
    service.setRuntimeLink("project-1", first.id, 1, { idempotencyKey: "link-first" }, actor);
    expect(() => service.setRuntimeLink("project-1", second.id, 1, { idempotencyKey: "stale-link" }, actor))
      .toThrowError(expect.objectContaining({ code: "revision_conflict", currentRevision: 2 }));
    expect(service.setRuntimeLink("project-1", second.id, 2, { idempotencyKey: "link-second" }, actor).value.link.runtimeProjectId).toBe(second.id);

    const archived = service.archiveProject("project-1", 3, { idempotencyKey: "archive" }, actor);
    expect(archived.value).toMatchObject({ status: "archived", revision: 4 });
    expect(service.archiveProject("project-1", 3, { idempotencyKey: "archive" }, actor)).toEqual({ ...archived, replayed: true });
    expect(service.listThreads("project-1", actor).items).toEqual([]);
    expect(() => service.createThread("project-1", { title: "No", body: "No" }, { idempotencyKey: "blocked" }, actor))
      .toThrowError(expect.objectContaining({ code: "invalid_request" }));
    const restored = service.restoreProject("project-1", 4, { idempotencyKey: "restore" }, actor);
    expect(restored.value).toMatchObject({ status: "active", revision: 5 });
    expect(service.createThread("project-1", { title: "Again", body: "Allowed" }, { idempotencyKey: "after-restore" }, actor).value.title).toBe("Again");
    store.close();
  });

  it("maps invalid runtime links to knowledge errors", () => {
    const { store, service, actor } = setup();
    expect(() => service.setRuntimeLink("project-1", "missing", 1, { idempotencyKey: "missing" }, actor))
      .toThrowError(expect.objectContaining<Partial<KnowledgeError>>({ code: "not_found" }));

    const runtime = store.addProject({ name: "Runtime", repositoryPath: "/tmp/knowledge-runtime-shared", port: 4324, executable: "pnpm", args: ["run", "dev"] });
    service.setRuntimeLink("project-1", runtime.id, 1, { idempotencyKey: "first-link" }, actor);
    store.saveKnowledgeProject({ id: "project-2", name: "Second", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW }, "test");
    store.saveKnowledgeProjectGrant({ principalId: "agent-1", projectId: "project-2", permissions: ["knowledge:read", "knowledge:write"], revokedAt: null }, "test");
    expect(() => service.setRuntimeLink("project-2", runtime.id, 1, { idempotencyKey: "duplicate-link" }, actor))
      .toThrowError(expect.objectContaining<Partial<KnowledgeError>>({ code: "invalid_request" }));
    store.close();
  });

  it("rejects non-integer project revisions without corrupting state", () => {
    const { store, service, actor } = setup();
    expect(() => service.archiveProject("project-1", "1" as never, { idempotencyKey: "archive" }, actor))
      .toThrowError(expect.objectContaining<Partial<KnowledgeError>>({ code: "invalid_request" }));
    expect(store.getKnowledgeProject("project-1")).toMatchObject({ status: "active", revision: 1 });
    store.close();
  });

  it("replays semantically identical updates regardless of input property order", () => {
    const { store, service, actor } = setup(["thread-1", "task-1", "relation-1"]);
    service.createThread("project-1", { title: "Finding", body: "Evidence" }, { idempotencyKey: "thread" }, actor);
    service.createTaskFromThread("project-1", "thread-1", { title: "Task", description: "Before" }, { idempotencyKey: "task" }, actor);
    const first = service.updateTask("project-1", "task-1", { title: "Task", description: "After", status: "done", priority: "now", expectedRevision: 1 }, { idempotencyKey: "update" }, actor);
    const reordered = { expectedRevision: 1, priority: "now" as const, status: "done" as const, description: "After", title: "Task" };
    expect(service.updateTask("project-1", "task-1", reordered, { idempotencyKey: "update" }, actor)).toEqual({ ...first, replayed: true });
    store.close();
  });

  it("paginates more than 100 replies without gaps or duplicates", () => {
    const ids = ["thread-1", ...Array.from({ length: 101 }, (_, index) => `reply-${index + 1}`)];
    const { store, service, actor } = setup(ids);
    service.createThread("project-1", { title: "Thread", body: "Body" }, { idempotencyKey: "thread" }, actor);
    for (let index = 0; index < 101; index += 1) {
      service.createReply("project-1", "thread-1", { body: `Reply ${index + 1}` }, { idempotencyKey: `reply-${index + 1}` }, actor);
    }
    const first = service.listReplies("project-1", "thread-1", actor, { limit: 100 });
    const second = service.listReplies("project-1", "thread-1", actor, { limit: 100, offset: first.nextOffset! });
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(101);
    expect(second.nextOffset).toBeNull();
    store.close();
  });

  it("paginates relation and history reads", () => {
    const { store, service, actor } = setup(["thread-1", "task-1", "relation-1"]);
    service.createThread("project-1", { title: "Thread", body: "Body" }, { idempotencyKey: "thread" }, actor);
    service.createTaskFromThread("project-1", "thread-1", { title: "Task", description: "First" }, { idempotencyKey: "task" }, actor);
    service.updateTask("project-1", "task-1", { title: "Task", description: "Second", status: "in_progress", priority: "next", expectedRevision: 1 }, { idempotencyKey: "update" }, actor);

    expect(service.relations("project-1", "thread", "thread-1", actor, { limit: 1 })).toMatchObject({ items: [{ id: "relation-1" }], nextOffset: null });
    const first = service.history("project-1", "task", "task-1", actor, { limit: 1 });
    const second = service.history("project-1", "task", "task-1", actor, { limit: 1, offset: first.nextOffset! });
    expect(first.items).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    expect(second.items).toHaveLength(1);
    expect(second.nextOffset).toBeNull();
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    store.close();
  });

  it("replays a successful write after the project is archived", () => {
    const { store, service, actor } = setup(["thread-1", "unused"]);
    const first = service.createThread("project-1", { title: "Saved", body: "Body" }, { idempotencyKey: "thread" }, actor);
    service.archiveProject("project-1", 1, { idempotencyKey: "archive" }, actor);
    expect(service.createThread("project-1", { title: "Saved", body: "Body" }, { idempotencyKey: "thread" }, actor)).toEqual({ ...first, replayed: true });
    store.close();
  });
});

describe("knowledge browsing", () => {
  it("matches Polish title casing and normalized accents before paging tasks and threads", () => {
    const { store, service, actor } = setup();
    for (const [index, title] of ["ŁÓDŹ", "łódź", "Other", "ŁÓDŹ".normalize("NFD")].entries()) {
      service.createTask("project-1", { title, description: "Details" }, { idempotencyKey: `task-${index}` }, actor);
      service.createThread("project-1", { title, body: "Details" }, { idempotencyKey: `thread-${index}` }, actor);
    }
    for (const query of ["łódź", "ŁÓDŹ", "ŁÓDŹ".normalize("NFD")]) {
      for (const operation of ["tasks", "threads"] as const) {
        const pages = [0, 1, 2].map(offset => service.execute({ operation, input: { projectId: "project-1", query, limit: 1, offset } }, actor) as { items: Array<{ id: string; title: string }>; nextOffset: number | null });
        expect(pages.map(page => page.items.length)).toEqual([1, 1, 1]);
        expect(new Set(pages.flatMap(page => page.items.map(item => item.id))).size).toBe(3);
        expect(pages.map(page => page.nextOffset)).toEqual([1, 2, null]);
      }
    }
    store.close();
  });

  it("filters before pagination, returns summaries, and lists only readable projects", () => {
    const { store, service, actor } = setup();
    for (let index = 0; index < 4; index++) service.createTask("project-1", { title: index % 2 ? "Chosen" : "Other", description: "Full description", priority: index % 2 ? "now" : "later" }, { idempotencyKey: `task-${index}` }, actor);
    const first = service.execute({ operation: "tasks", input: { projectId: "project-1", priority: "now", query: "chosen", limit: 1 } }, actor) as { items: Array<{ id: string }>; nextOffset: number };
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).not.toHaveProperty("description");
    expect(first.nextOffset).toBe(1);
    const second = service.execute({ operation: "tasks", input: { projectId: "project-1", priority: "now", offset: first.nextOffset, limit: 1 } }, actor) as { items: Array<{ id: string }>; nextOffset: null };
    expect(second.items[0].id).not.toBe(first.items[0].id); expect(second.nextOffset).toBeNull();
    expect(service.execute({ operation: "projects", input: {} }, actor)).toMatchObject({ items: [{ id: "project-1", writable: true }], nextOffset: null });
    expect(service.execute({ operation: "project", input: { projectId: "project-1" } }, actor)).toMatchObject({ id: "project-1", writable: true });
    store.close();
  });
});
