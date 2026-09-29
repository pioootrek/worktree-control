import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/knowledge-pilot-live.mjs <prepared pilot directory>");
const root = resolve(process.argv[2]);
process.umask(0o077);
const marker = JSON.parse(readFileSync(join(root, "pilot.json"), "utf8"));
const importPlan = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
assert.equal(marker.liveWrites, false);
const access = JSON.parse(readFileSync(join(root, "state/service-access.json"), "utf8"));
assert.equal(access.authenticationMode, "token");
const endpoint = new URL(access.localDashboardEndpoint);
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(new URL(access.mcpEndpoint).hostname, "127.0.0.1");
const implementation = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
// The installation token never leaves this process except through headers, pipes and child environments.
const installation = readFileSync(join(root, "installation-token"), "utf8").trim();
const projectId = marker.projectId;
const run = randomUUID();
const checks = [];
const clients = [];
const browser = await chromium.launch({ headless: true });
let page;

/** Runs the public CLI against this pilot only; credentials are passed by environment, never as arguments. */
function cli(args, credentials = {}) {
  const environment = { ...process.env };
  for (const name of ["WORKTREE_SWITCHER_TOKEN", "WORKTREE_SWITCHER_OWNER_TOKEN", "WORKTREE_SWITCHER_KNOWLEDGE_TOKEN", "WORKTREE_SWITCHER_DATA_DIR", "WORKTREE_SWITCHER_STATE_DIR"]) delete environment[name];
  Object.assign(environment, credentials);
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args, "--data-dir", join(root, "data"), "--state-dir", join(root, "state")], { encoding: "utf8", env: environment, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function cliJson(args, credentials) {
  const result = cli(args, credentials);
  assert.equal(result.status, 0, `CLI ${args.slice(0, 2).join(" ")} failed`);
  return JSON.parse(result.stdout);
}
async function connect(name, token) {
  const client = new Client({ name, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(access.mcpEndpoint), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined));
  clients.push(client);
  return client;
}
async function mcp(client, operation, input) {
  const result = await client.callTool({ name: `knowledge_${operation}`, arguments: { projectId, ...input } });
  const part = result.content.find(c => c.type === "text");
  const value = JSON.parse(part.text);
  if (result.isError) throw new Error(value.code ?? "MCP operation failed");
  return value;
}
async function signInThroughForm(target) {
  await target.goto(new URL("/", endpoint).href);
  await target.getByLabel("Access token", { exact: true }).fill(installation);
  await target.getByRole("button", { name: "Sign in", exact: true }).click();
  await target.getByRole("button", { name: "Sign in", exact: true }).waitFor({ state: "detached" });
}

try {
  // Token mode rejects anonymous and wrong credentials on every transport before any write.
  const wrong = `wsi_${randomUUID()}_${"0".repeat(64)}`;
  assert.equal((await fetch(new URL("/api/dashboard", endpoint))).status, 401);
  assert.equal((await fetch(new URL("/api/dashboard", endpoint), { headers: { "X-Worktree-Switcher-Token": wrong } })).status, 401);
  assert.equal((await fetch(new URL("/api/dashboard", endpoint), { headers: { "X-Worktree-Switcher-Token": installation } })).status, 200);
  for (const token of [null, wrong]) await assert.rejects(new Client({ name: "k7a-denied", version: "1" }).connect(new StreamableHTTPClientTransport(new URL(access.mcpEndpoint), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined)));
  const anonymous = cli(["knowledge", "tasks", "--json", JSON.stringify({ projectId, limit: 1 })]);
  assert.equal(anonymous.status, 1);
  assert.match(anonymous.stderr, /requires a credential/);
  const wrongCredential = cli(["identity", "list-agents"], { WORKTREE_SWITCHER_TOKEN: wrong });
  assert.equal(wrongCredential.status, 1);
  assert.match(wrongCredential.stderr, /A valid access token is required/);
  checks.push("token mode rejects missing and wrong credentials over HTTP, MCP and online CLI");

  // The owner provisions both agents through the online CLI with the installation token.
  const owner = { WORKTREE_SWITCHER_TOKEN: installation };
  const agentTokens = [];
  for (let i = 0; i < 2; i++) {
    const { principal } = cliJson(["identity", "create-agent"], owner);
    cliJson(["identity", "grant-knowledge", "--principal-id", principal.id, "--project-id", projectId, "--permissions", "knowledge:read,knowledge:write,knowledge:export,attachments:read"], owner);
    const issued = cliJson(["identity", "issue-agent-token", "--principal-id", principal.id, "--label", `K7a pilot ${run} agent ${i + 1}`], owner);
    agentTokens.push({ principalId: principal.id, token: issued.token });
  }
  const cliTasks = cliJson(["knowledge", "tasks", "--json", JSON.stringify({ projectId, limit: 5 })], { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: agentTokens[0].token });
  assert.ok(cliTasks.items.length > 0);
  checks.push("online CLI provisions two scoped agents with the installation token; an agent token reads knowledge through CLI");

  const first = await connect("k7a-agent-1", agentTokens[0].token);
  const second = await connect("k7a-agent-2", agentTokens[1].token);
  for (const [index, client] of [first, second].entries()) {
    const described = JSON.parse((await client.callTool({ name: "get_identity", arguments: {} })).content.find(c => c.type === "text").text);
    assert.equal(described.principal.id, agentTokens[index].principalId);
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes("knowledge_task_context"));
    assert.ok(!tools.includes("claim_project") && !tools.includes("run_test"));
  }
  checks.push("two MCP clients authenticate as distinct scoped agents without runtime or test-queue tools");
  const imported = await mcp(first, "tasks", { limit: 100 });
  assert.ok(imported.items.length > 0);
  checks.push("agent 1 reads imported backlog over real MCP");
  const completion = importPlan.mappings.find(mapping => mapping.targetKind === "task_completion" && Array.isArray(mapping.originalPayload?.summary) && mapping.originalPayload.summary.some(value => typeof value === "string" && value.trim()));
  assert.ok(completion);
  const summaryPhrase = completion.originalPayload.summary.find(value => typeof value === "string" && value.trim()).trim().slice(0, 120);
  const summarySearch = await mcp(first, "search", { query: summaryPhrase, kind: "task", limit: 25 });
  assert.ok(summarySearch.items.some(item => item.kind === "task" && item.excerpt.includes(summaryPhrase)));
  const historical = importPlan.mappings.find(mapping => mapping.targetKind === "historical_comment" && typeof mapping.originalPayload?.author === "string" && typeof mapping.originalPayload?.date === "string");
  assert.ok(historical);
  const parentLegacy = historical.legacyId.replace(/:note:\d+$/, "");
  const parentMapping = importPlan.mappings.find(mapping => mapping.targetKind === "task" && mapping.legacyId === parentLegacy);
  assert.ok(parentMapping);
  const parentTasks = await mcp(first, "tasks", { query: parentMapping.originalPayload.title, limit: 25 });
  const parentTask = parentTasks.items.find(item => item.title === parentMapping.originalPayload.title);
  assert.ok(parentTask);
  const parentRelations = await mcp(first, "relations", { recordKind: "task", recordId: parentTask.id, limit: 100 });
  const discussionRelation = parentRelations.items.find(relation => relation.sourceId === parentTask.id && relation.targetKind === "thread");
  assert.ok(discussionRelation);
  const historicalReplies = await mcp(first, "replies", { threadId: discussionRelation.targetId, limit: 100 });
  const historicalReply = historicalReplies.items.find(reply => reply.body === historical.originalPayload.text);
  assert.deepEqual(historicalReply.historicalImport, { sourceAuthor: historical.originalPayload.author, sourceDate: historical.originalPayload.date, sourceDateStatus: "valid", sourceOrder: "verified" });
  checks.push("summary content is searchable and imported comment provenance is exposed over real MCP");

  // The human signs in with the installation token through the real access form.
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => localStorage.setItem("worktree-switcher-locale", "en"));
  await page.goto(new URL("/", endpoint).href);
  await page.getByLabel("Access token", { exact: true }).fill(wrong);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("The token is invalid or has been rotated", { exact: false }).waitFor();
  await signInThroughForm(page);
  checks.push("GUI rejects a wrong token and signs in with the installation token through the access form");
  const url = new URL("/", endpoint);
  url.searchParams.set("view", "knowledge");
  url.searchParams.set("knowledgeProject", projectId);
  url.searchParams.set("knowledgeTab", "discussions");
  url.searchParams.set("record", discussionRelation.targetId);
  await page.goto(url.href);
  await page.locator("[data-historical-import]").filter({ hasText: historical.originalPayload.author }).first().waitFor();
  checks.push("GUI shows the historical source author and date separately from the importing principal");
  url.searchParams.set("knowledgeTab", "backlog");
  url.searchParams.delete("record");
  await page.goto(url.href);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  const title = `K7a human task ${run}`;
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body", { exact: true }).fill("Pilot copy only: verify a human can hand work to two agents.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit task", exact: true }).waitFor();
  await page.screenshot({ path: join(root, "human-task.png"), fullPage: true });
  const tasks = await mcp(first, "tasks", { query: title });
  assert.equal(tasks.items.length, 1);
  const task = tasks.items[0];
  checks.push("human creates a task in GUI; agent 1 reads the same record");

  const decisionInput = { title: `K7a decision ${run}`, body: "Hub remains the authoritative write location during the pilot.", category: "decision", tags: ["pilot"], legacyId: null, sources: [{ kind: "task", id: task.id, revision: task.revision }], idempotencyKey: `${run}-decision` };
  const decision = await mcp(first, "create_memory", decisionInput);
  assert.equal((await mcp(first, "create_memory", decisionInput)).replayed, true);
  const question = await mcp(second, "create_memory", { ...decisionInput, title: `K7a question ${run}`, body: "How should archived references be presented?", category: "question", idempotencyKey: `${run}-question` });
  const forbidden = await second.callTool({ name: "knowledge_approve_memory", arguments: { projectId, memoryId: decision.value.id, expectedRevision: 1, idempotencyKey: `${run}-forbidden` } });
  assert.equal(forbidden.isError, true);
  assert.equal(JSON.parse(forbidden.content.find(c => c.type === "text").text).code, "knowledge_forbidden");
  checks.push("agent 1 proposes a decision with an idempotent retry; agent 2 adds a question and cannot approve");
  url.searchParams.set("knowledgeTab", "memory");
  url.searchParams.set("record", decision.value.id);
  await page.goto(url.href);
  await page.getByRole("button", { name: "Approve this revision", exact: true }).click();
  await page.getByText("Active · Approved", { exact: true }).waitFor();
  await page.screenshot({ path: join(root, "approved-decision.png"), fullPage: true });
  const history = await mcp(first, "history", { recordKind: "memory", recordId: decision.value.id, limit: 20 });
  const created = history.items.find(entry => entry.operation === "created");
  const approved = history.items.find(entry => entry.operation === "approved");
  assert.deepEqual([created.principalId, created.authenticationMethod], [agentTokens[0].principalId, "agent_token"]);
  assert.deepEqual([approved.principalId, approved.authenticationMethod], ["installation", "installation_token"]);
  checks.push("owner approves in GUI; history attributes creation to agent 1 (agent_token) and approval to the installation (installation_token)");

  // A later session — new MCP connection, new browser context, and the CLI — sees the approved context.
  await second.close();
  clients.splice(clients.indexOf(second), 1);
  const nextSession = await connect("k7a-agent-2-next-session", agentTokens[1].token);
  const context = await mcp(nextSession, "task_context", { taskId: task.id });
  assert.ok(context.decisions.some(item => item.id === decision.value.id));
  assert.ok(context.openQuestions.some(item => item.id === question.value.id));
  const cliContext = cliJson(["knowledge", "task_context", "--json", JSON.stringify({ projectId, taskId: task.id })], { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: agentTokens[1].token });
  assert.ok(cliContext.decisions.some(item => item.id === decision.value.id));
  assert.ok(cliContext.openQuestions.some(item => item.id === question.value.id));
  const laterPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    laterPage.setDefaultTimeout(10000);
    await laterPage.addInitScript(() => localStorage.setItem("worktree-switcher-locale", "en"));
    await signInThroughForm(laterPage);
    await laterPage.goto(url.href);
    await laterPage.getByRole("heading", { name: decisionInput.title, exact: true }).waitFor();
    await laterPage.getByText("Active · Approved", { exact: true }).waitFor();
    await laterPage.getByText(`K7a question ${run}`, { exact: true }).waitFor();
  } finally { await laterPage.close(); }
  checks.push("a new MCP session and the CLI read the approved decision and open question in task context; a new browser session shows the approved decision and lists the question");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(root, "mobile-memory.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  checks.push("mobile memory view has no horizontal overflow");
  writeFileSync(join(root, "live-report.json"), JSON.stringify({ implementation, sourceDirty, authenticationMode: access.authenticationMode, checks, taskId: task.id, decisionId: decision.value.id, questionId: question.value.id, agentPrincipalIds: agentTokens.map(agent => agent.principalId), run, cutoverApproved: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ checks }));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, "live-failure.png"), fullPage: true });
    writeFileSync(join(root, "live-failure.txt"), await page.locator("body").innerText(), { mode: 0o600 });
  }
  throw error;
} finally {
  await browser.close();
  for (const client of clients) await client.close();
}
