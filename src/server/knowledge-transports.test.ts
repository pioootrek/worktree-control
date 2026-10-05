import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-store";
import { IdentityService } from "./modules/identity";
import { KnowledgeAttachmentService, KnowledgeService } from "./modules/knowledge";
import { ControlService } from "./control-service";
import { ProcessManager } from "./process-manager";
import { createControllerServer } from "./http-server";
import { createMcpControllerServer } from "./mcp-http-server";
import { EventStream } from "./events";
import { DirectoryBrowser } from "./directory-browser";
import { runKnowledgeCommand } from "../cli/knowledge-management";
import { writeServiceAccess } from "../cli/service-access";
import type { AppPaths } from "./paths";
import type { KnowledgeTask, KnowledgeThread, KnowledgePage } from "@/shared/contracts/knowledge";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(clock?: () => string, limits?: import("@/shared/contracts/knowledge-attachments").KnowledgeAttachmentLimits) {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-transports-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "index.html"), "<title>Knowledge</title>");
  const store = new SqliteStateStore(join(directory, "state.sqlite3"));
  cleanups.push(() => store.close());
  const identity = new IdentityService(store, clock);
  const ownerSession = identity.bootstrapOwnerSession();
  const owner = identity.authenticateBearer(ownerSession.token);
  const project = identity.createKnowledgeProject({ name: "Knowledge without runtime" }, owner);
  const privateProject = identity.createKnowledgeProject({ name: "Private" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "attachments:read", "attachments:write"] }, owner);
  const agentTokens: string[] = [];
  const agents: string[] = [];
  for (const label of ["first", "second"]) {
    const agent = identity.createAgent(owner);
    agents.push(agent.id);
    identity.setKnowledgeGrant({ principalId: agent.id, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "attachments:read", "attachments:write"] }, owner);
    agentTokens.push(identity.issueAgentToken({ principalId: agent.id, label }, owner).token);
  }
  const events = new EventStream();
  cleanups.push(() => events.close());
  const attachmentDirectory=join(directory,"attachments"); const attachmentService=new KnowledgeAttachmentService(store,identity,attachmentDirectory,limits);
  const knowledge = new KnowledgeService(store, identity, undefined, undefined, events.publishKnowledge,attachmentService);
  const git = { list: vi.fn(() => { throw new Error("Knowledge must not scan Git"); }) };
  const processes = new ProcessManager();
  const service = new ControlService(store, git as never, processes, undefined, undefined, undefined, undefined, undefined, undefined, undefined, knowledge);
  const web = createControllerServer({ service, identity, events, directoryBrowser: {} as DirectoryBrowser, webRoot: directory, host: "127.0.0.1", port: 0, accessToken: "pairing", mcpStatus: () => ({ phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 }) });
  const mcp = createMcpControllerServer({ service, identity, port: 0, accessToken: "legacy" });
  for (const controller of [web, mcp]) {
    await new Promise<void>(resolve => controller.server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => controller.close());
  }
  const base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  const endpoint = new URL(`http://127.0.0.1:${(mcp.server.address() as AddressInfo).port}/mcp`);
  const clients: Client[] = [];
  for (const [index, token] of agentTokens.entries()) {
    const client = new Client({ name: `agent-${index}`, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client); cleanups.push(() => client.close());
  }
  const http = (operation: string, input: unknown, token = ownerSession.token, origin?: string) => fetch(`${base}/api/knowledge`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ operation, input }) });
  const call = async (index: number, operation: string, input: Record<string, unknown>) => {
    const result = await clients[index].callTool({ name: `knowledge_${operation}`, arguments: input });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { result, value: JSON.parse(text) };
  };
  const paths = { serviceAccessPath: join(directory, "access.json"), databasePath: join(directory, "never-open.sqlite3") } as AppPaths;
  writeServiceAccess(paths.serviceAccessPath, { pid: process.pid, startedAt: new Date().toISOString(), version: "test", dashboardEndpoint: base, mcpEndpoint: endpoint.href, accessUrl: base, logDirectory: directory });
  return { store, identity, owner, project, privateProject, agents, agentTokens, clients, base, http, call, paths, git, service, events };
}

describe("real knowledge HTTP, MCP and CLI", () => {
  it("preflights a whole manifest above 1 MiB consistently across transports", async () => {
    const f = await setup(), projectId = f.project.id;
    const task = (await f.call(0, "create_task", { projectId, title: "Manifest", description: "Manifest", idempotencyKey: "manifest-task" })).value.value;
    const input = { projectId, recordKind: "task", recordId: task.id,
      files: Array.from({ length: 5001 }, (_, index) => ({ filename: `${"proof".repeat(35)}-${index}.txt`, size: 1, sha256: "a".repeat(64) })) };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1024 * 1024);
    const http = await (await f.http("check_attachment_batch", input)).json();
    expect(http).toMatchObject({ incoming: { bytes: 5001, files: 5001 }, accepted: false, violations: [expect.objectContaining({ constraint: "projectFiles" })] });
    expect((await f.call(0, "check_attachment_batch", input)).value).toEqual(http);
    const lines: string[] = [];
    await runKnowledgeCommand(["check_attachment_batch", "--json", JSON.stringify(input)], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[0] }, write: line => lines.push(line) });
    expect(JSON.parse(lines[0])).toEqual(http);
  });

  it("admits one of two concurrent HTTP writes after non-reserving preflights and replays the winner", async () => {
    const f = await setup(undefined, { fileBytes: 10, projectBytes: 10, projectFiles: 1 }), projectId = f.project.id;
    const task = (await f.call(0, "create_task", { projectId, title: "Race", description: "Race", idempotencyKey: "race-task" })).value.value;
    const uploads = ["left", "right"].map(key => ({ projectId, recordKind: "task", recordId: task.id, filename: `${key}.bin`, mediaType: "application/octet-stream", dataBase64: Buffer.alloc(10).toString("base64"), idempotencyKey: key }));
    for (const upload of uploads) {
      expect((await f.call(0, "check_attachment_batch", { projectId, recordKind: "task", recordId: task.id, files: [{ filename: upload.filename, size: 10, sha256: "a".repeat(64) }] })).value.accepted).toBe(true);
    }
    const responses = await Promise.all(uploads.map(upload => f.http("create_attachment", upload)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 413]);
    const winner = responses.findIndex(response => response.status === 200);
    expect((await (await f.http("create_attachment", uploads[winner])).json()).replayed).toBe(true);
    expect((await f.call(1, "attachment_policy", { projectId })).value.used).toEqual({ bytes: 10, files: 1 });
  });
  it("carries the advertised 10 MiB file boundary through MCP and rejects one extra decoded byte", async () => {
    const f = await setup(), projectId = f.project.id;
    const task = (await f.call(0, "create_task", { projectId, title: "Boundary", description: "Boundary", idempotencyKey: "boundary-task" })).value.value;
    const input = { projectId, recordKind: "task", recordId: task.id, filename: "boundary.bin", mediaType: "application/octet-stream", dataBase64: Buffer.alloc(10 * 1024 * 1024, 7).toString("base64"), idempotencyKey: "boundary" };
    const saved = await f.call(0, "create_attachment", input);
    expect(saved.result.isError).not.toBe(true); expect(saved.value.value.size).toBe(10 * 1024 * 1024);
    expect((await f.call(0, "create_attachment", input)).value.replayed).toBe(true);
    expect((await f.call(0, "create_attachment", { ...input, dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1, 7).toString("base64"), idempotencyKey: "over-file" })).value).toMatchObject({ code: "limit_exceeded", details: { violations: [expect.objectContaining({ constraint: "fileBytes", incoming: 10 * 1024 * 1024 + 1 })] } });
  }, 20000);
  it("shares capacity/preflight across HTTP, MCP and CLI, checks grants and documents preparation", async () => {
    const f = await setup(undefined, { fileBytes: 10, projectBytes: 10, projectFiles: 1 }), projectId = f.project.id;
    const task = (await (await f.http("create_task", { projectId, title: "Proof", description: "Proof", idempotencyKey: "proof-task" })).json()).value;
    const policy = await (await f.http("attachment_policy", { projectId })).json();
    expect((await f.call(0, "attachment_policy", { projectId })).value).toEqual(policy);
    const lines: string[] = [];
    await runKnowledgeCommand(["attachment_policy", "--json", JSON.stringify({ projectId })], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[0] }, write: line => lines.push(line) });
    expect(JSON.parse(lines[0])).toEqual(policy);
    const input = { projectId, recordKind: "task", recordId: task.id, files: [{ filename: "proof.txt", size: 1, sha256: "a".repeat(64) }] };
    const checked = await (await f.http("check_attachment_batch", input)).json();
    expect((await f.call(1, "check_attachment_batch", input)).value).toEqual(checked);
    await runKnowledgeCommand(["check_attachment_batch", "--json", JSON.stringify(input)], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[0] }, write: line => lines.push(line) });
    expect(JSON.parse(lines[1])).toEqual(checked);
    const exceeded = { ...input, files: [{ ...input.files[0], size: policy.limits.projectBytes + 1 }] };
    expect((await f.call(0, "check_attachment_batch", exceeded)).value).toMatchObject({ accepted: false, violations: [expect.objectContaining({ constraint: "fileBytes" }), expect.objectContaining({ constraint: "projectBytes" })] });
    expect((await f.http("attachment_policy", { projectId: f.privateProject.id }, f.agentTokens[0])).status).toBe(403);
    const tools = (await f.clients[0].listTools()).tools;
    expect(tools.find(tool => tool.name === "knowledge_create_attachment")?.description).toContain("canonical padded RFC 4648 base64");
    expect(tools.find(tool => tool.name === "knowledge_check_attachment_batch")?.annotations?.readOnlyHint).toBe(true);
    const empty = { projectId, recordKind: "task", recordId: task.id, filename: "empty", mediaType: "text/plain", dataBase64: "", idempotencyKey: "empty" };
    expect((await f.call(0, "create_attachment", empty)).value.code).toBe("invalid_request");
    expect((await f.http("create_attachment", empty)).status).toBe(400);
    const upload = { ...empty, filename: "proof", dataBase64: Buffer.alloc(10).toString("base64"), idempotencyKey: "proof" };
    expect((await f.http("create_attachment", upload)).status).toBe(200);
    const rejected = { ...upload, idempotencyKey: "over" };
    const response = await f.http("create_attachment", rejected), failure = await response.json();
    expect(response.status).toBe(413);
    expect((await f.call(0, "create_attachment", rejected)).value).toEqual(failure);
    await expect(runKnowledgeCommand(["create_attachment", "--json", JSON.stringify(rejected)], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[0] } })).rejects.toThrow(JSON.stringify(failure));
    expect(failure.details.violations.map((item: { constraint: string }) => item.constraint)).toEqual(["projectBytes", "projectFiles"]);
    f.identity.revokeKnowledgeGrant(f.agents[0], projectId, f.owner);
    expect((await f.call(0, "attachment_policy", { projectId })).value.code).toBe("knowledge_forbidden");
    expect((await f.call(0, "check_attachment_batch", input)).value.code).toBe("knowledge_forbidden");
  });
  it("accepts a bounded attachment through real HTTP and CLI transports", async () => {
    const f=await setup(); const taskResponse=await f.http("create_task",{projectId:f.project.id,title:"Target",description:"Target",idempotencyKey:"target"});
    const task=(await taskResponse.json() as {value:{id:string}}).value;
    const input={projectId:f.project.id,recordKind:"task",recordId:task.id,filename:"evidence.bin",mediaType:"application/octet-stream",dataBase64:Buffer.alloc(64*1024,7).toString("base64"),idempotencyKey:"http-file"};
    const uploaded=await f.http("create_attachment",input); expect(uploaded.status).toBe(200);
    await runKnowledgeCommand(["create_attachment","--json",JSON.stringify({...input,idempotencyKey:"cli-file",filename:"cli.bin"})],f.paths,{environment:{WORKTREE_CONTROL_KNOWLEDGE_TOKEN:f.agentTokens[0]},write:()=>{}});
  });
  it.each(["grant", "credential", "expiry"] as const)("filters SSE with current %s state without recording passive credential usage", async kind => {
    let now = "2026-01-01T12:00:00.000Z";
    const f = await setup(() => now);
    f.identity.setKnowledgeGrant({ principalId: f.agents[0], projectId: f.privateProject.id, permissions: ["knowledge:read"] }, f.owner);
    const eventCredential = f.identity.issueAgentToken({ principalId: f.agents[0], label: "SSE", ...(kind === "expiry" ? { expiresAt: "2026-01-01T13:00:00.000Z" } : {}) }, f.owner);
    const eventToken = eventCredential.token;
    const used = vi.spyOn(f.store, "recordCredentialUsed");
    const abort = new AbortController();
    const response = await fetch(`${f.base}/api/events`, { headers: { "X-Worktree-Control-Token": "pairing", Authorization: `Bearer ${eventToken}` }, signal: abort.signal });
    expect(response.status).toBe(200);
    expect(used.mock.calls.filter(([id]) => id === eventCredential.credential.id)).toHaveLength(1);
    used.mockClear();
    const reader = response.body!.getReader();
    let frames = "";
    const read = (async () => {
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; frames += new TextDecoder().decode(chunk.value); } }
      catch { if (!abort.signal.aborted) throw new Error("Unexpected stream failure"); }
      finally { reader.releaseLock(); }
    })();
    try {
      f.events.publishKnowledge(f.project.id); f.events.publishKnowledge(f.privateProject.id);
      await vi.waitFor(() => expect(frames).toContain(`"projectIds":["${f.project.id}","${f.privateProject.id}"]`));
      expect(used.mock.calls.filter(([id]) => id === eventCredential.credential.id)).toHaveLength(0);
      if (kind === "grant") f.identity.revokeKnowledgeGrant(f.agents[0], f.project.id, f.owner);
      else if (kind === "credential") f.identity.revokeCredential(eventCredential.credential.id, f.owner);
      else now = "2100-01-01T00:00:00.000Z";
      frames = "";
      f.events.publishKnowledge(f.project.id); f.events.publishKnowledge(f.privateProject.id);
      f.events.publish({ kinds: ["runtime"] });
      await vi.waitFor(() => expect(frames).toContain("event: changed"));
      if (kind === "grant") {
        expect(frames).toContain(`"projectIds":["${f.privateProject.id}"]`);
        expect(frames).not.toContain(f.project.id);
      } else expect(frames).not.toContain("knowledge-changed");
      expect(used.mock.calls.filter(([id]) => id === eventCredential.credential.id)).toHaveLength(0);
    } finally { abort.abort(); await read; used.mockRestore(); }
  });

  it("shares an owner and two agent sessions, retries once and leaves runtime untouched", async () => {
    const f = await setup();
    const projectId = f.project.id;
    const threadInput = { projectId, title: "Finding", body: "Evidence", idempotencyKey: "thread-key" };
    const created = await (await f.http("create_thread", threadInput)).json() as { value: KnowledgeThread };
    const listed = await f.call(0, "threads", { projectId });
    expect(listed.value.items).toHaveLength(1);
    expect(listed.value.items[0]).not.toHaveProperty("body");
    await f.call(0, "create_reply", { projectId, threadId: created.value.id, body: "Agent A confirms", idempotencyKey: "reply-A" });
    const input = { projectId, threadId: created.value.id, title: "Fix", description: "Details", idempotencyKey: "task-B" };
    const first = await f.call(1, "task_from_thread", input);
    const retry = await f.call(1, "task_from_thread", input);
    expect(retry.value).toEqual({ ...first.value, replayed: true });
    const lines: string[] = [];
    await runKnowledgeCommand(["tasks", "--json", JSON.stringify({ projectId })], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[0] }, write: line => lines.push(line) });
    expect((JSON.parse(lines[0]) as KnowledgePage<KnowledgeTask>).items).toHaveLength(1);
    await runKnowledgeCommand(["create_reply", "--json", JSON.stringify({ projectId, threadId: created.value.id, body: "CLI confirms", idempotencyKey: "cli" })], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[1] }, write: () => undefined });
    expect((await (await f.http("replies", { projectId, threadId: created.value.id })).json()).items).toHaveLength(2);
    const relation = await f.call(0, "relations", { projectId, recordKind: "task", recordId: first.value.value.task.id });
    expect(relation.value.items[0].targetId).toBe(created.value.id);
    expect(f.store.listProjects()).toEqual([]);
    expect(f.git.list).not.toHaveBeenCalled();
    expect((await f.clients[0].listTools()).tools.some(tool => tool.name === "claim_project")).toBe(false);
  });

  it("enforces project scope, current grants, conflicts, strict input and byte limits", async () => {
    const f = await setup(); const projectId = f.project.id;
    const input = { projectId, title: "Task", description: "Original", idempotencyKey: "create" };
    const task = (await f.call(0, "create_task", input)).value.value as KnowledgeTask;
    expect((await f.call(0, "projects", {})).value.items.map((p: { id: string }) => p.id)).toEqual([projectId]);
    expect((await f.http("tasks", { projectId: f.privateProject.id }, f.agentTokens[0])).status).toBe(403);
    expect((await f.http("tasks", { projectId }, "legacy")).status).toBe(401);
    expect((await f.http("tasks", { projectId }, f.agentTokens[0], "https://foreign.test")).status).toBe(403);
    const edit = { projectId, taskId: task.id, title: "Task", description: "Second", priority: "now", status: "in_progress", expectedRevision: 1, idempotencyKey: "edit" };
    expect((await f.http("update_task", edit)).status).toBe(200);
    const conflict = await f.call(1, "update_task", { ...edit, description: "Stale", idempotencyKey: "other" });
    expect(conflict.value).toMatchObject({ code: "revision_conflict", currentRevision: 2 });
    expect((await f.http("create_task", { ...input, title: "Different" }, f.agentTokens[0])).status).toBe(409);
    expect((await f.http("update_task", { ...edit, expectedRevision: undefined })).status).toBe(400);
    expect((await f.http("tasks", { projectId, author: "human:owner" })).status).toBe(400);
    expect((await f.http("create_task", { ...input, description: "ą".repeat(33000) })).status).toBe(413);
    f.identity.revokeKnowledgeGrant(f.agents[0], projectId, f.owner);
    const replay = await f.call(0, "create_task", input);
    expect(replay.result.isError).toBe(true); expect(replay.value.code).toBe("knowledge_forbidden");
    expect((await f.call(0, "projects", {})).value.items).toEqual([]);
    await expect(runKnowledgeCommand(["tasks", "--json", JSON.stringify({ projectId })], f.paths, { environment: { WORKTREE_CONTROL_KNOWLEDGE_TOKEN: f.agentTokens[0] }, write: () => undefined })).rejects.toThrow("knowledge_forbidden");
  });
});
