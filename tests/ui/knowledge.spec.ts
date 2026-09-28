import { expect, test, type Page } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

async function mountKnowledge(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("worktree-switcher-knowledge-token", "knowledge-fixture"));
  const data = dashboardFixture(); data.projects = [];
  const fixture = await mountDashboard(page, data);
  const project = { id: "knowledge-only", name: "Knowledge without server", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
  const records: Array<{ id: string; projectId: string; title: string; body?: string; description?: string; priority?: string; status?: string; revision: number; createdBy: string }> = [];
  const replies: Array<{ id: string; threadId: string; body: string; revision: number; createdBy: string; historicalImport?: { sourceAuthor: string | null; sourceDate: string | null; sourceDateStatus: "valid" | "missing" | "invalid" } }> = [];
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const saved = new Map<string, unknown>();
  const savedInputs = new Map<string, string>();
  let failSave = false;
  let loseResponse = false;
  await page.route("**/api/identity", route => route.fulfill({ json: { principal: { id: "owner", kind: "owner" }, credential: { kind: "owner_session" } } }));
  await page.route("**/api/knowledge", async route => {
    const request = route.request().postDataJSON(); calls.push(request);
    const { operation, input } = request;
    const pageResult = (items: unknown[]) => ({ items, nextOffset: null });
    if (operation === "projects") return route.fulfill({ json: pageResult([project]) });
    if (operation === "project") return route.fulfill({ json: project });
    if (operation === "tasks" || operation === "threads") {
      const matching = records.filter(record => (operation === "tasks" ? "description" in record : "body" in record) && (!input.query || record.title.toLowerCase().includes(input.query.toLowerCase())));
      const active = matching.filter(record => record.status !== "done" && record.status !== "archived");
      const filtered = matching.filter(record => (!input.activeOnly || (record.status !== "done" && record.status !== "archived")) && (!input.status || record.status === input.status) && (!input.priority || record.priority === input.priority));
      const offset = input.offset ?? 0, limit = input.limit ?? 25;
      return route.fulfill({ json: { items: filtered.slice(offset, offset + limit), nextOffset: filtered.length > offset + limit ? offset + limit : null, ...(operation === "tasks" ? { total: filtered.length, counts: { active: active.length, now: active.filter(r => r.priority === "now").length, next: active.filter(r => r.priority === "next").length, blocked: active.filter(r => r.status === "blocked").length, done: matching.filter(r => r.status === "done").length, all: matching.length } } : {}) } });
    }
    if (operation === "task" || operation === "thread") return route.fulfill({ json: records.find(record => record.id === (input.taskId ?? input.threadId)) });
    if (operation === "relations") return route.fulfill({ json: pageResult([]) });
    if (operation === "replies") return route.fulfill({ json: pageResult(replies.filter(reply => reply.threadId === input.threadId)) });
    if (failSave) return route.fulfill({ status: 503, json: { code: "unavailable", error: "Unavailable" } });
    if (saved.has(input.idempotencyKey)) {
      if (savedInputs.get(input.idempotencyKey) !== JSON.stringify(input)) return route.fulfill({ status: 409, json: { code: "idempotency_conflict", error: "Different committed input" } });
      return route.fulfill({ json: { value: saved.get(input.idempotencyKey), replayed: true } });
    }
    savedInputs.set(input.idempotencyKey, JSON.stringify(input));
    if (operation === "create_reply") {
      const reply = { id: `r${replies.length}`, threadId: input.threadId, body: input.body, revision: 1, createdBy: "owner" }; replies.push(reply); saved.set(input.idempotencyKey, reply);
      return route.fulfill({ json: { value: reply, replayed: false } });
    }
    if (operation === "update_task") {
      const record = records.find(record => record.id === input.taskId)!;
      if (record.revision !== input.expectedRevision) return route.fulfill({ status: 409, json: { code: "revision_conflict", currentRevision: record.revision, error: "Conflict" } });
      Object.assign(record, { title: input.title, description: input.description, priority: input.priority, status: input.status, revision: record.revision + 1 }); saved.set(input.idempotencyKey, record);
      return route.fulfill({ json: { value: record, replayed: false } });
    }
    const record = { id: `k${records.length}`, projectId: project.id, title: input.title, ...(operation === "create_thread" ? { body: input.body } : { description: input.description, status: "open", priority: input.priority ?? "later" }), revision: 1, createdBy: "owner" };
    records.push(record);
    const value = operation === "task_from_thread" ? { task: record, relation: { targetId: input.threadId } } : record;
    saved.set(input.idempotencyKey, value);
    if (loseResponse) { loseResponse = false; return route.abort("failed"); }
    return route.fulfill({ json: { value, replayed: false } });
  });
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue(project.id);
  return { ...fixture, records, replies, calls, setFailure: (value: boolean) => { failSave = value; }, loseNextResponse: () => { loseResponse = true; } };
}

test("historical imported replies distinguish source attribution from the importing principal",async({page})=>{
  const f=await mountKnowledge(page);f.records.push({id:"historical-thread",projectId:"knowledge-only",title:"Imported discussion",body:"Context",revision:1,createdBy:"owner"});f.replies.push({id:"historical-reply",threadId:"historical-thread",body:"Historical comment",revision:1,createdBy:"import-owner",historicalImport:{sourceAuthor:"Ada",sourceDate:"2026-09-13",sourceDateStatus:"valid"}});
  await page.getByRole("tab",{name:"Discussions",exact:true}).click();await page.getByRole("button",{name:"Refresh",exact:true}).click();await page.getByRole("link",{name:"Imported discussion",exact:true}).click();
  await expect(page.getByText("Author: import-owner · revision 1",{exact:true})).toBeVisible();await expect(page.getByText("Historical import source — author: Ada · date: 2026-09-13",{exact:true})).toBeVisible();
  await selectLanguage(page);await expect(page.getByText("Źródło historyczne importu — autor: Ada · data: 2026-09-13",{exact:true})).toBeVisible();
});

test("knowledge uses the available list width, then gives discussions a readable, expandable reader", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await mountKnowledge(page);
  f.records.push({ id: "discussion-layout", projectId: "knowledge-only", title: "Storage tradeoffs", body: "Initial context", revision: 1, createdBy: "owner" });
  f.replies.push({ id: "reply-layout", threadId: "discussion-layout", body: "Use a single SQLite owner", revision: 1, createdBy: "reviewer" });
  await page.getByRole("tab", { name: "Discussions", exact: true }).click();
  const layout = page.locator("[data-knowledge-layout]");
  const list = page.locator("[data-knowledge-list]");
  await expect(page.locator("[data-knowledge-detail]")).toBeHidden();
  expect((await list.boundingBox())!.width).toBeGreaterThan((await layout.boundingBox())!.width * 0.9);
  await page.getByRole("link", { name: "Storage tradeoffs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage tradeoffs" })).toBeVisible();
  const reader = page.locator("[data-knowledge-detail]");
  expect((await reader.boundingBox())!.width).toBeGreaterThan((await list.boundingBox())!.width);
  const order = await reader.locator("article h3, article [aria-label='Replies'], article details").evaluateAll(nodes => nodes.map(node => node.tagName.toLowerCase()));
  expect(order.slice(0, 3)).toEqual(["h3", "section", "details"]);
  await expect(reader.getByText("Use a single SQLite owner", { exact: true })).toBeVisible();
  await reader.getByRole("button", { name: "Expand reader" }).click();
  await expect(list).toBeHidden();
  expect((await reader.boundingBox())!.width).toBeGreaterThan((await layout.boundingBox())!.width * 0.9);
  await reader.getByRole("button", { name: "Show list" }).click();
  await expect(list).toBeVisible();
  expect(f.errors).toEqual([]);
});

test("mobile reader hides list controls and returns focus to the selected discussion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await mountKnowledge(page);
  f.records.push({ id: "mobile-thread", projectId: "knowledge-only", title: "Mobile decision", body: "Readable context", revision: 1, createdBy: "owner" });
  await page.getByRole("tab", { name: "Discussions", exact: true }).click();
  await page.getByRole("link", { name: "Mobile decision", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mobile decision" })).toBeFocused();
  await expect(page.getByLabel("Search titles", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Back to list" }).click();
  await expect(page.getByRole("link", { name: "Mobile decision", exact: true })).toBeFocused();
  await expect(page.getByLabel("Search titles", { exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});

test("reading a project without write access keeps mutation controls disabled", async ({ page }) => {
  const f = await mountKnowledge(page);
  f.records.push({ id: "shared-task", projectId: "knowledge-only", title: "Shared task", description: "Readable evidence", status: "open", priority: "next", revision: 1, createdBy: "owner" });
  await page.route("**/api/knowledge", route => {
    if (route.request().postDataJSON().operation === "project") return route.fulfill({ json: { id: "knowledge-only", name: "Knowledge without server", status: "active", writable: false, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" } });
    return route.fallback();
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: "Shared task", exact: true }).click();
  await expect(page.getByText("Readable evidence", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add task", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit task", exact: true })).toBeDisabled();
  expect(f.errors).toEqual([]);
});

test("knowledge without runtime: discussion, reply, task, filters and static deep link", async ({ page }) => {
  const f = await mountKnowledge(page);
  await page.getByRole("tab", { name: "Discussions", exact: true }).click();
  await page.getByRole("button", { name: "Start discussion", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Finding"); await page.getByLabel("Body", { exact: true }).fill("Evidence");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Finding", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByLabel("Body", { exact: true }).fill("Confirmed"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Confirmed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create task from thread", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Fix finding"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fix finding", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/knowledgeTab=backlog.*record=/);
  await page.reload(); await expect(page.getByRole("heading", { name: "Fix finding", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("knowledge-desktop.png"), fullPage: true });
  await page.getByLabel("Search titles").fill("Absent"); await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page.getByText("No entries match these filters.")).toBeVisible();
  expect(f.calls.some(call => call.operation === "tasks" && call.input.query === "Absent")).toBe(true);
  expect(f.requests).toEqual([]); expect(f.errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { fixtureEvents: { active: number } }).fixtureEvents.active)).toBe(1);
});

test("conflict and failed save keep drafts after reload; knowledge events avoid dashboard refresh", async ({ page }) => {
  const f = await mountKnowledge(page);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Task"); await page.getByLabel("Body", { exact: true }).fill("Original");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Edit task", exact: true }).click();
  await page.getByLabel("Body", { exact: true }).fill("Local draft");
  f.records[0].description = "Other client"; f.records[0].revision = 2;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Someone changed this record.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Local draft");
  await page.reload();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Local draft");
  await expect(page.getByText("Someone changed this record.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Keep draft and use current revision" }).click();
  f.setFailure(true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saving failed.", { exact: false })).toBeVisible();
  const failedKey = f.calls.filter(call => call.operation === "update_task").at(-1)!.input.idempotencyKey;
  await page.reload(); await expect(page.getByText("Saving failed.", { exact: false })).toBeVisible();
  f.setFailure(false); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.operation === "update_task").at(-1)!.input.idempotencyKey).toBe(failedKey);
  let dashboardReads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/dashboard")) dashboardReads++; });
  f.records[0].description = "Live update"; f.records[0].revision = 4;
  await page.evaluate(() => (window as unknown as { fixtureEvents: { emit: (type: string, value: unknown) => void } }).fixtureEvents.emit("knowledge-changed", { projectIds: ["knowledge-only"] }));
  await expect(page.getByText("Live update", { exact: true })).toBeVisible(); expect(dashboardReads).toBe(0);
  expect(f.errors).toEqual([]);
});

test("Polish and mobile knowledge navigation has labeled fields and no overflow", async ({ page }) => {
  await mountKnowledge(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await selectLanguage(page);
  await expect(page.getByLabel("Projekt wiedzy", { exact: true })).toBeVisible();
  expect((await page.getByLabel("Projekt wiedzy", { exact: true }).boundingBox())!.width).toBeGreaterThan(280);
  expect((await page.getByLabel("Szukaj w tytułach", { exact: true }).boundingBox())!.width).toBeGreaterThan(280);
  await page.getByRole("button", { name: "Dodaj zadanie", exact: true }).click();
  await expect(page.getByLabel("Tytuł", { exact: true })).toBeFocused();
  await page.getByLabel("Tytuł", { exact: true }).fill("Zadanie"); await page.keyboard.press("Tab");
  await expect(page.getByLabel("Treść", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("knowledge-mobile-pl.png"), fullPage: true });
});

test("changing credentials clears the previous principal's visible knowledge before loading", async ({ page }) => {
  const f = await mountKnowledge(page);
  f.records.push({ id: "private", projectId: "knowledge-only", title: "Private task", description: "Private content", status: "open", priority: "now", revision: 1, createdBy: "owner" });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: "Private task", exact: true }).click();
  await expect(page.getByText("Private content", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out of knowledge" }).click();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route("**/api/identity", route => route.fulfill({ json: { principal: { id: "other-agent", kind: "agent" }, credential: { kind: "agent_token" } } }));
  await page.route("**/api/knowledge", async route => {
    requested = true;
    await gate;
    if (route.request().postDataJSON().operation === "projects") return route.fulfill({ json: { items: [], nextOffset: null } });
    return route.fulfill({ status: 403, json: { code: "knowledge_forbidden", error: "Denied" } });
  });
  try {
    await page.getByLabel("Knowledge credential", { exact: true }).fill("new-credential");
    await page.getByRole("button", { name: "Sign in to knowledge", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByText("Private content", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Private task", { exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByText("Could not read knowledge.", { exact: false })).toBeVisible();
  expect(f.errors).toEqual([]);
});


test("a committed save with a lost response keeps its retry key through edits and reload", async ({ page }) => {
  const f = await mountKnowledge(page);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Original title");
  await page.getByLabel("Body", { exact: true }).fill("Evidence");
  f.loseNextResponse();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saving failed.", { exact: false })).toBeVisible();
  const firstKey = f.calls.filter(call => call.operation === "create_task").at(-1)!.input.idempotencyKey;
  expect(f.records).toHaveLength(1);
  await page.getByLabel("Title", { exact: true }).fill("Edited after lost response");
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Edited after lost response");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("This draft was already saved with different content.", { exact: false })).toBeVisible();
  expect(f.calls.filter(call => call.operation === "create_task").at(-1)!.input.idempotencyKey).toBe(firstKey);
  expect(f.records).toHaveLength(1);
  await page.getByLabel("Title", { exact: true }).fill("Original title");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Original title", exact: true })).toBeVisible();
  expect(f.records).toHaveLength(1);
});

for (const target of ["identity", "projects"] as const) {
  test(`transient ${target} errors preserve the session and draft and offer retry after reload`, async ({ page }) => {
    const f = await mountKnowledge(page);
    await page.getByRole("button", { name: "Add task", exact: true }).click();
    await page.getByLabel("Title", { exact: true }).fill("Unsaved draft");
    let fail = true;
    await page.route(target === "identity" ? "**/api/identity" : "**/api/knowledge", async route => {
      if (!fail || (target === "projects" && route.request().postDataJSON().operation !== "projects")) return route.fallback();
      return target === "identity" ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) : route.abort("failed");
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Could not read knowledge.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsaved draft");
    await expect(page.getByLabel("Knowledge credential", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Could not read knowledge.", { exact: false })).toBeVisible();
    await expect(page.getByLabel("Knowledge credential", { exact: true })).toHaveCount(0);
    fail = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsaved draft");
    await expect(page.getByText("Could not read knowledge.", { exact: false })).toHaveCount(0);
    expect(f.errors).toEqual([]);
  });
}

for (const status of [401, 403]) {
  test(`knowledge discovery HTTP ${status} requires signing in again`, async ({ page }) => {
    await mountKnowledge(page);
    await page.route("**/api/identity", route => route.fulfill({ status, json: { error: "Denied" } }));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByLabel("Knowledge credential", { exact: true })).toBeVisible();
    await expect(page.getByText("The knowledge session expired", { exact: false })).toBeVisible();
  });
}

test("knowledge sign-in changes only the shared stream credential, not runtime bootstrap", async ({ page }) => {
  let dashboardReads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/dashboard")) dashboardReads++; });
  await mountKnowledge(page);
  const events = () => page.evaluate(() => {
    const value = (window as unknown as { fixtureEvents: { active: number; opened: number; lastKnowledgeToken: string } }).fixtureEvents;
    return { active: value.active, opened: value.opened, token: value.lastKnowledgeToken };
  });
  await expect.poll(events).toEqual({ active: 1, opened: 1, token: "Bearer knowledge-fixture" });
  expect(dashboardReads).toBe(1);
  await page.getByRole("button", { name: "Sign out of knowledge" }).click();
  await expect.poll(events).toEqual({ active: 1, opened: 2, token: "" });
  expect(dashboardReads).toBe(1);
  await page.getByLabel("Knowledge credential", { exact: true }).fill("second-credential");
  await page.getByRole("button", { name: "Sign in to knowledge", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toBeVisible();
  await expect.poll(events).toEqual({ active: 1, opened: 3, token: "Bearer second-credential" });
  expect(dashboardReads).toBe(1);
  // A runtime revision missed during credential replacement still requires reconciliation.
  await page.evaluate(() => { (window as unknown as { fixtureEvents: { version: { revision: number } } }).fixtureEvents.version.revision++; });
  await page.getByRole("button", { name: "Sign out of knowledge" }).click();
  await expect.poll(() => dashboardReads).toBe(2);
  await expect.poll(events).toEqual({ active: 1, opened: 4, token: "" });
});

test("Back and Forward never initialize an editor from the previous record", async ({ page }) => {
  const f = await mountKnowledge(page);
  f.records.push(
    { id: "a", projectId: "knowledge-only", title: "Task A", description: "Body A", status: "open", priority: "now", revision: 1, createdBy: "owner" },
    { id: "b", projectId: "knowledge-only", title: "Task B", description: "Body B", status: "open", priority: "now", revision: 1, createdBy: "owner" },
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: "Task A", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Task A", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Task B", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Task B", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit task", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Task B");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Task A", exact: true })).toBeVisible();
  let requested = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/knowledge", async route => {
    const { operation, input } = route.request().postDataJSON();
    if (operation === "task" && input.taskId === "b") { requested = true; await gate; }
    return route.fallback();
  });
  try {
    await page.goForward();
    await expect(page).toHaveURL(/record=b.*knowledgeEditor=edit/);
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Task A", exact: true })).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Task B");
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Body B");
  await page.getByLabel("Body", { exact: true }).fill("Updated B");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.operation === "update_task").at(-1)!.input.taskId).toBe("b");
  expect(f.records[0].description).toBe("Body A");
  expect(f.records[1].description).toBe("Updated B");
  expect(f.errors).toEqual([]);
});

async function mountMemory(page: Page) {
  const fixture = await mountKnowledge(page);
  const memories: import("../../src/shared/contracts/knowledge-memory").KnowledgeMemory[] = [];
  const saved = new Map<string, unknown>();
  const requestHashes = new Map<string, string>();
  const entries: unknown[] = [];
  let loseResponse = false;
  await page.route("**/api/knowledge", async route => {
    const { operation, input } = route.request().postDataJSON();
    const record = memories.find(item => item.id === input.memoryId);
    const pageResult = (items: unknown[]) => ({ items, nextOffset: null });
    if (operation === "search") return route.fulfill({ json: pageResult(memories.filter(item => (input.includeInactive || item.status === "active") && (!input.query || `${item.title} ${item.body}`.includes(input.query))).map(item => ({ ...item, kind: "memory", excerpt: item.body.slice(0, 300), threadId: null }))) });
    if (operation === "memory") return route.fulfill({ json: record });
    if (operation === "history") return route.fulfill({ json: pageResult(entries) });
    if (operation === "task_context" || operation === "export_context") {
      const task = fixture.records.find(item => item.id === input.taskId)!;
      const items = memories.filter(item => item.status === "active").map(item => ({ ...item, excerpt: item.body, bodyTruncated: false, sourceStates: item.sources.map(source => ({ source, currentRevision: 1, stale: false, inactive: false })) }));
      const context = { formatVersion: 1, generatedAt: "2026-09-14", projectId: input.projectId, task, scope: task.description, scopeTruncated: false, decisions: items.filter(item => item.category === "decision" && item.approval), proposals: items.filter(item => item.category !== "question" && !item.approval), openQuestions: items.filter(item => item.category === "question"), evidence: [], nextOffset: null, fingerprint: `version-${memories.map(item => item.revision).join("-")}` };
      if (operation === "task_context") return route.fulfill({ json: context });
      return route.fulfill({ json: { ...context, format: input.format, content: JSON.stringify(context) } });
    }
    if (!["create_memory", "update_memory", "approve_memory", "archive_memory", "restore_memory", "supersede_memory"].includes(operation)) return route.fallback();
    if (saved.has(input.idempotencyKey)) {
      if (requestHashes.get(input.idempotencyKey) !== JSON.stringify(input)) return route.fulfill({ status: 409, json: { code: "idempotency_conflict", error: "Different request" } });
      return route.fulfill({ json: { value: saved.get(input.idempotencyKey), replayed: true } });
    }
    if (operation !== "create_memory" && record?.revision !== input.expectedRevision) return route.fulfill({ status: 409, json: { code: "revision_conflict", currentRevision: record?.revision, error: "Conflict" } });
    let value = record;
    if (operation === "create_memory") {
      value = { ...input, id: `memory-${memories.length}`, revision: 1, status: "active", approval: null, supersededBy: null, createdBy: "owner", createdAt: "2026-09-14", updatedAt: "2026-09-14" };
      memories.push(value!);
    } else {
      entries.push({ id: entries.length, operation, revision: record!.revision + 1, previousJson: JSON.stringify(record), principalId: "owner" });
      Object.assign(record!, { revision: record!.revision + 1, approval: operation === "supersede_memory" ? record!.approval : null });
      if (operation === "update_memory") Object.assign(record!, { title: input.title, body: input.body, category: input.category, tags: input.tags, legacyId: input.legacyId, sources: input.sources });
      if (operation === "approve_memory") record!.approval = { revision: record!.revision, principalId: "owner", approvedAt: "2026-09-14" };
      if (operation === "archive_memory") record!.status = "archived";
      if (operation === "restore_memory") record!.status = "active";
      if (operation === "supersede_memory") { record!.status = "superseded"; record!.supersededBy = { id: input.replacementId, revision: input.replacementRevision }; }
    }
    saved.set(input.idempotencyKey, structuredClone(value));
    requestHashes.set(input.idempotencyKey, JSON.stringify(input));
    if (loseResponse) { loseResponse = false; return route.abort("failed"); }
    return route.fulfill({ json: { value, replayed: false } });
  });
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("K4 task");
  await page.getByLabel("Body", { exact: true }).fill("Preserve decisions between sessions");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "K4 task", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  return { ...fixture, memories, loseResponse: () => { loseResponse = true; } };
}

async function addMemory(page: Page, title: string, category = "decision") {
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Body", { exact: true }).fill("Use one SQLite owner");
  await page.getByLabel("Memory category", { exact: true }).selectOption(category);
  await page.getByLabel("Source record ID", { exact: true }).fill("k0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

test("memory list fills the workspace and mobile detail returns to its entry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await mountMemory(page);
  const layout = page.locator("[data-memory-layout]");
  const list = page.locator("[data-memory-list]");
  expect((await list.boundingBox())!.width).toBeGreaterThan((await layout.boundingBox())!.width * 0.9);
  await page.setViewportSize({ width: 390, height: 844 });
  await addMemory(page, "Navigation note");
  await expect(page.getByRole("heading", { name: "Navigation note" })).toBeFocused();
  await expect(list).toBeHidden();
  await expect(page.getByLabel("Search titles, content and memory", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Back to list", exact: true }).click();
  await expect(page.getByRole("link", { name: "Navigation note", exact: true })).toBeFocused();
  await expect(page.getByLabel("Search titles, content and memory", { exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});

test("memory approval, edit invalidation, archive, supersession and context export", async ({ page }) => {
  const f = await mountMemory(page);
  await addMemory(page, "Storage decision");
  await page.getByRole("button", { name: "Approve this revision", exact: true }).click();
  await expect(page.getByText("Approved by owner, revision 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  await page.getByLabel("Body", { exact: true }).fill("Use SQLite with revision history");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Active · Proposed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archive memory", exact: true }).click();
  await expect(page.getByText("Archived · Proposed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore memory", exact: true }).click();
  await page.getByRole("button", { name: "Approve this revision", exact: true }).click();
  await expect(page.getByText("Approved by owner, revision 6", { exact: true })).toBeVisible();
  await addMemory(page, "Retention question", "question");
  await page.getByRole("tab", { name: "Backlog", exact: true }).click();
  await page.getByRole("link", { name: "K4 task", exact: true }).click();
  await page.getByRole("button", { name: "Next session context", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approved decisions", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Retention question/ })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("task-context-k0-0.json");
  f.memories[1].revision++;
  await page.getByRole("button", { name: "Next session context", exact: true }).click();
  await expect(page.getByText("The downloaded export is now out of date. Download a new version.", { exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath("k4-context-desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await addMemory(page, "Replacement");
  await page.getByRole("link", { name: "Storage decision", exact: true }).click();
  await page.getByLabel("Replacement memory ID", { exact: true }).fill("memory-2");
  await page.getByRole("button", { name: "Supersede with this record", exact: true }).click();
  await expect(page.getByText("Superseded · Previously approved", { exact: true })).toBeVisible();
  await expect(page.getByText("Approved by owner, revision 6", { exact: true })).toBeVisible();
  await page.getByText("More details", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Replacement: memory-2 · r1", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await selectLanguage(page);
  await expect(page.getByRole("button", { name: "Zatwierdź tę rewizję", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Szukaj w tytułach, treści i pamięci", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Wróć do listy", exact: true }).click();
  await expect(page.getByLabel("Szukaj w tytułach, treści i pamięci", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("k4-memory-mobile-pl.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(f.errors).toEqual([]);
});

test("memory draft retries a lost response after reload without duplicating the record", async ({ page }) => {
  const f = await mountMemory(page);
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Recovered memory");
  await page.getByLabel("Body", { exact: true }).fill("Evidence");
  await page.getByLabel("Source record ID", { exact: true }).fill("k0");
  f.loseResponse();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saving failed.", { exact: false })).toBeVisible();
  expect(f.memories).toHaveLength(1);
  await page.reload();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Recovered memory");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Recovered memory", exact: true })).toBeVisible();
  expect(f.memories).toHaveLength(1);
  expect(f.errors).toEqual([]);
});

test("context pagination returns to the actual preceding page after a byte-limited page", async ({ page }) => {
  const f = await mountMemory(page);
  const offsets: number[] = [];
  await page.route("**/api/knowledge", route => {
    const { operation, input } = route.request().postDataJSON();
    if (operation !== "task_context") return route.fallback();
    offsets.push(input.offset);
    return route.fulfill({ json: { formatVersion: 1, projectId: input.projectId, task: f.records[0], scope: `Context page ${input.offset}`, decisions: [], proposals: [], openQuestions: [], evidence: [], nextOffset: input.offset === 0 ? 7 : input.offset === 7 ? 14 : null, fingerprint: "test", scopeTruncated: false } });
  });
  await page.getByRole("tab", { name: "Backlog", exact: true }).click();
  await page.getByRole("link", { name: "K4 task", exact: true }).click();
  await page.getByRole("button", { name: "Next session context", exact: true }).click();
  const section = page.getByRole("region", { name: "Next session context", exact: true });
  await expect(section.getByText("Context page 0", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(section.getByText("Context page 7", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(section.getByText("Context page 14", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(section.getByText("Context page 7", { exact: true })).toBeVisible();
  expect(offsets).toEqual([0, 7, 14, 7]);
  await section.getByLabel("Entries per context page", { exact: true }).selectOption("1");
  await expect(section.getByText("Context page 0", { exact: true })).toBeVisible();
  expect(f.errors).toEqual([]);
});

test("dashboard Refresh retries failed memory reads and clears their error", async ({ page }) => {
  const f = await mountMemory(page);
  let failed = true;
  await page.route("**/api/knowledge", route => {
    const { operation } = route.request().postDataJSON();
    if (operation === "search" && failed) return route.fulfill({ status: 503, json: { code: "unavailable", error: "Retry" } });
    return route.fallback();
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Could not read knowledge.", { exact: false })).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Could not read knowledge.", { exact: false })).toHaveCount(0);
  expect(f.errors).toEqual([]);
});


test("an edited retry can discard its conflicting draft and open the committed memory", async ({ page }) => {
  const f = await mountMemory(page);
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Committed memory");
  await page.getByLabel("Body", { exact: true }).fill("First body");
  await page.getByLabel("Source record ID", { exact: true }).fill("k0");
  f.loseResponse();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saving failed.", { exact: false })).toBeVisible();
  await page.getByLabel("Body", { exact: true }).fill("Edited after lost response");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Discard local draft", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Edited after lost response");
  await page.getByRole("button", { name: "Discard local draft", exact: true }).click();
  expect(f.memories).toHaveLength(1);
  await page.getByRole("link", { name: "Committed memory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Committed memory", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add memory", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
  expect(f.errors).toEqual([]);
});

test("memory selection and browser Back preserve filters and a later results page", async ({ page }) => {
  const f = await mountMemory(page);
  await addMemory(page, "Private A");
  await addMemory(page, "Private B");
  const searches: Record<string, unknown>[] = [];
  await page.route("**/api/knowledge", route => {
    const { operation, input } = route.request().postDataJSON();
    if (operation !== "search") return route.fallback();
    searches.push(input);
    const items = f.memories.map(item => ({ ...item, kind: "memory", excerpt: item.body, threadId: null }));
    return route.fulfill({ json: { items, nextOffset: input.offset === 0 ? 25 : null } });
  });
  await page.getByLabel("Search titles, content and memory", { exact: true }).fill("Private");
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("Tag", { exact: true }).fill("scope");
  await page.getByLabel("Legacy ID", { exact: true }).fill("OLD-1");
  await page.getByLabel("Status", { exact: true }).selectOption("archived");
  await page.getByLabel("Include archived and superseded", { exact: true }).check();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).first().click();
  await expect.poll(() => searches.at(-1)?.offset).toBe(25);
  await page.getByRole("link", { name: "Private A", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Private A", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Private A");
  await page.getByRole("button", { name: "Close and keep draft", exact: true }).click();
  await page.getByRole("link", { name: "Private B", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Private B", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Private A", exact: true })).toBeVisible();
  expect(searches.at(-1)).toMatchObject({ query: "Private", tag: "scope", legacyId: "OLD-1", kind: "memory", status: "archived", includeInactive: true, offset: 25 });
  await expect(page.getByLabel("Search titles, content and memory", { exact: true })).toHaveValue("Private");
  await expect(page.getByLabel("Tag", { exact: true })).toHaveValue("scope");
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("archived");
  await expect(page.getByRole("button", { name: "Next page", exact: true }).first()).toHaveCount(0);
  await page.getByRole("button", { name: "Edit memory", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Private A");
  expect(f.errors).toEqual([]);
});

test("task views count the whole search, preserve pagination on selection and use a mobile detail screen", async ({ page }) => {
  const f = await mountKnowledge(page);
  for (let i = 0; i < 32; i++) f.records.push({ id: `active-${i}`, projectId: "knowledge-only", title: `Active task ${i}`, description: `Context ${i}`, status: "open", priority: "next", revision: 1, createdBy: "owner" });
  f.records.push({ id: "done-1", projectId: "knowledge-only", title: "Finished task", description: "Archived outcome", status: "done", priority: "now", revision: 1, createdBy: "owner" });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const views = page.getByRole("navigation", { name: "Task views" });
  await expect(views.getByRole("button", { name: "Active 32", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: "Finished task", exact: true })).toHaveCount(0);
  const list = page.locator("[data-knowledge-list]");
  await list.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("link", { name: "Active task 30", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Active task 30", exact: true })).toBeVisible();
  await expect(list.getByText("Page 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Active task 30", exact: true })).toHaveAttribute("aria-current", "true");
  await views.getByRole("button", { name: "Done 1", exact: true }).click();
  await expect(page.getByRole("link", { name: "Finished task", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Finished task", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toBeHidden();
  await expect(page.getByRole("heading", { name: "Finished task", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to list", exact: true }).click();
  await expect(list).toBeVisible();
  await expect(views.getByRole("button", { name: "Done 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(f.errors).toEqual([]);
});

test("the desktop list scrolls inside the workspace while detail stays visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await mountKnowledge(page);
  for (let i = 0; i < 25; i++) f.records.push({ id: `task-${i}`, projectId: "knowledge-only", title: `Long working task ${i}`, description: "Useful context", status: "open", priority: "now", revision: 1, createdBy: "owner" });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: "Long working task 0", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Long working task 0", exact: true })).toBeVisible();
  const scroll = page.locator("[data-knowledge-list-scroll]");
  expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(page.getByRole("heading", { name: "Long working task 0", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.querySelector("[data-knowledge-workspace]")!.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  expect(f.errors).toEqual([]);
});

test("agent context remains copyable when clipboard access is denied", async ({ page }) => {
  const f = await mountMemory(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Denied"); } } }));
  await page.reload();
  await page.getByRole("tab", { name: "Backlog", exact: true }).click();
  await page.getByRole("link", { name: "K4 task", exact: true }).click();
  const exported = page.waitForRequest(request => request.url().endsWith("/api/knowledge") && request.postDataJSON()?.operation === "export_context");
  await page.getByRole("button", { name: "Copy context for agent", exact: true }).click();
  await expect(page.getByLabel("Context to copy", { exact: true })).not.toHaveValue("");
  await expect(page.getByText("The export contains this context page", { exact: false })).toBeVisible();
  expect((await exported).postDataJSON().input.format).toBe("markdown");
  expect(f.errors).toEqual([]);
});

test("an entry exposes authorized attachments and downloads their bytes", async ({ page }) => {
  const f = await mountKnowledge(page);
  f.records.push({ id: "attached", projectId: "knowledge-only", title: "With evidence", description: "Inspect the file", status: "open", priority: "now", revision: 1, createdBy: "owner" });
  const requests: string[] = [];
  await page.route("**/api/knowledge", route => {
    const { operation } = route.request().postDataJSON();
    const attachment = { id: "file-1", filename: "evidence.txt", size: 8 };
    if (operation === "attachments") return route.fulfill({ json: { items: [attachment], nextOffset: null } });
    if (operation === "attachment") { requests.push(operation); return route.fulfill({ json: { attachment, dataBase64: "ZXZpZGVuY2U=" } }); }
    return route.fallback();
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("link", { name: "With evidence", exact: true }).click();
  await page.getByRole("button", { name: "Attachments", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download: evidence.txt", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("evidence.txt");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile((await download.path())!, "utf8")).toBe("evidence");
  expect(requests).toEqual(["attachment"]);
  expect(f.errors).toEqual([]);
});


test("closing editors returns keyboard focus to the action that opened them", async ({ page }) => {
  await mountMemory(page);
  await addMemory(page, "Keyboard note");
  const editMemory = page.getByRole("button", { name: "Edit memory", exact: true });
  await editMemory.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editMemory).toBeFocused();
  await page.getByRole("tab", { name: "Backlog", exact: true }).click();
  await page.getByRole("link", { name: "K4 task", exact: true }).click();
  const editTask = page.getByRole("button", { name: "Edit task", exact: true });
  await editTask.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editTask).toBeFocused();
});


for (const mode of ["edit", "reply", "from_thread"] as const) {
  test(`a failed background read in ${mode} exposes retry and restores the record draft`, async ({ page }) => {
    const f = await mountKnowledge(page);
    const task = mode === "edit";
    f.records.push({ id: "existing", projectId: "knowledge-only", title: "Existing record", ...(task ? { description: "Original", status: "open", priority: "next" } : { body: "Original" }), revision: 1, createdBy: "owner" });
    if (!task) await page.getByRole("tab", { name: "Discussions", exact: true }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("link", { name: "Existing record", exact: true }).click();
    await page.getByRole("button", { name: task ? "Edit task" : mode === "reply" ? "Reply" : "Create task from thread", exact: true }).click();
    await page.getByLabel("Body", { exact: true }).fill("Unsaved record draft");
    let fail = true;
    await page.route("**/api/knowledge", route => {
      if (fail && route.request().postDataJSON().operation === (task ? "task" : "thread")) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
      return route.fallback();
    });
    await page.evaluate(() => (window as unknown as { fixtureEvents: { emit: (type: string, value: unknown) => void } }).fixtureEvents.emit("knowledge-changed", { projectIds: ["knowledge-only"] }));
    await expect(page.getByRole("alert").filter({ hasText: "Could not read knowledge." })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Knowledge credential", { exact: true })).toHaveCount(0);
    fail = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue("Unsaved record draft");
    await expect(page.getByRole("alert").filter({ hasText: "Could not read knowledge." })).toHaveCount(0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    const saved = f.calls.findLast(call => call.operation === (task ? "update_task" : mode === "reply" ? "create_reply" : "task_from_thread"));
    expect(saved?.input[task ? "taskId" : "threadId"]).toBe("existing");
    expect(saved?.input[mode === "reply" ? "body" : "description"]).toBe("Unsaved record draft");
    expect(f.errors).toEqual([]);
  });
}
