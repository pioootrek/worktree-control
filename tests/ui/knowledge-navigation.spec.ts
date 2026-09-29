import { expect, test, type Page } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

const projectId = "navigation-project";
const threadId = "thread-navigation";
const taskId = "task-navigation";
const memoryId = "memory-navigation";
const project = { id: projectId, name: "Navigation project", status: "active", writable: true, revision: 1, createdAt: "2026-09-01", updatedAt: "2026-09-29" };
const thread = { id: threadId, projectId, title: "Pilot topic", body: "Discussion body", revision: 1, createdBy: "owner", createdAt: "2026-09-01", updatedAt: "2026-09-29",
  presentation: { displayTitle: "Pilot topic", preview: "Discussion body", imported: false, replyCount: 31 } };
const otherThread = { ...thread, id: "other-thread", title: "Other discussion", presentation: { ...thread.presentation, displayTitle: "Other discussion", replyCount: 0 } };
const task = { id: taskId, projectId, title: "Route this work", description: "A task with useful related records.", status: "open", priority: "next", revision: 1, createdBy: "owner", createdAt: "2026-09-01", updatedAt: "2026-09-29" };
const memory = { id: memoryId, projectId, title: "Decision on navigation", body: "Use precise destinations.", category: "decision", tags: [], legacyId: null, sources: [], status: "active", supersededBy: null, approval: null, revision: 1, createdBy: "owner", createdAt: "2026-09-01", updatedAt: "2026-09-29" };
const replies = Array.from({ length: 31 }, (_, index) => ({ id: `reply-${index + 1}`, projectId, threadId, body: index === 29 ? `${"Earlier context. ".repeat(45)}Needle [literal] %_ at the decision.` : `Needle answer ${index + 1}`, revision: 1, createdBy: "owner", createdAt: `2026-09-29T10:${String(index).padStart(2, "0")}:00.000Z`, updatedAt: "2026-09-29" }));
const target = replies[29]!;
const relation = (id: string, type: string, sourceKind: string, sourceId: string, targetKind: string, targetId: string, destination: object | null) =>
  ({ id, projectId, type, sourceKind, sourceId, targetKind, targetId, revision: 1, createdBy: "owner", createdAt: "2026-09-29", destination });
const taskRelations = [
  relation("task-thread", "derived_from", "task", taskId, "thread", threadId, { kind: "thread", id: threadId, title: "Pilot topic" }),
  relation("task-memory", "relates_to", "task", taskId, "memory", memoryId, { kind: "memory", id: memoryId, title: memory.title, status: "active" }),
  relation("same-id-kind", "supersedes", "thread", taskId, "task", taskId, { kind: "thread", id: taskId, title: "Thread sharing an ID" }),
  relation("task-missing", "blocks", "task", taskId, "thread", "missing", null),
];
const threadRelations = [
  taskRelations[0],
  relation("thread-reply", "relates_to", "thread", threadId, "reply", target.id, { kind: "reply", id: target.id, title: "Pilot topic", threadId }),
  ...Array.from({length:24},(_,index)=>relation(`thread-extra-${index}`,"relates_to","thread",threadId,"task",taskId,{kind:"task",id:taskId,title:index===23?"Last relation page":"Route this work",status:"open"})),
];

async function mountNavigation(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("worktree-switcher-knowledge-token", "navigation-fixture"));
  const data = dashboardFixture(); data.projects = [];
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const fixture = await mountDashboard(page, data);
  await page.route("**/api/identity", route => route.fulfill({ json: { principal: { id: "owner", kind: "owner" }, credential: { kind: "owner_session" } } }));
  await page.route("**/api/knowledge", route => {
    const request = route.request().postDataJSON() as { operation: string; input: Record<string, unknown> };
    calls.push(request);
    const { operation, input } = request;
    const empty = { items: [], nextOffset: null };
    if (input.projectId && input.projectId !== projectId) return route.fulfill({ status: 403, json: { code: "knowledge_forbidden", error: "Forbidden" } });
    if (operation === "projects") return route.fulfill({ json: { items: [project], nextOffset: null } });
    if (operation === "project") return route.fulfill({ json: project });
    if (operation === "tasks") return route.fulfill({ json: { items: [task], nextOffset: null, total: 1, counts: { active: 1, now: 0, next: 1, blocked: 0, done: 0, all: 1 } } });
    if (operation === "task") return route.fulfill({ json: task });
    if (operation === "threads") return route.fulfill({ json: { items: [thread, otherThread], nextOffset: null } });
    if (operation === "thread") return route.fulfill({ json: input.threadId === otherThread.id ? otherThread : thread });
    if (operation === "replies") {
      const all = input.threadId === threadId ? replies : [];
      const found = input.targetReplyId ? all.findIndex(reply => reply.id === input.targetReplyId) : -1;
      const offset = found >= 0 ? Math.floor(found / 25) * 25 : Number(input.offset ?? 0);
      return route.fulfill({ json: { items: all.slice(offset, offset + 25), nextOffset: all.length > offset + 25 ? offset + 25 : null, offset,
        ...(input.targetReplyId ? { targetFound: found >= 0 } : {}) } });
    }
    if (operation === "relations") {
      const all = input.recordKind === "task" ? taskRelations : input.recordId === threadId ? threadRelations : [];
      const offset = Number(input.offset ?? 0);
      return route.fulfill({ json: { items: all.slice(offset, offset + 25), nextOffset: all.length > offset + 25 ? offset + 25 : null } });
    }
    if (operation === "search") {
      const kind = input.kind ?? "memory";
      const query = String(input.query ?? "").toLowerCase();
      const rows = kind === "reply" ? replies.map(reply => ({ id: reply.id, projectId, kind: "reply", title: thread.title, excerpt: reply.id === target.id ? "…Needle [literal] %_ at the decision." : reply.body, matchSource: "body", revision: 1, status: "active", updatedAt: reply.updatedAt, threadId }))
        : [{ ...memory, kind: "memory", excerpt: memory.body, threadId: null }];
      const matching = rows.filter(row => !query || `${row.title} ${row.excerpt}`.toLowerCase().includes(query));
      const offset = Number(input.offset ?? 0);
      return route.fulfill({ json: { items: matching.slice(offset, offset + 25), nextOffset: matching.length > offset + 25 ? offset + 25 : null } });
    }
    if (operation === "memory") return route.fulfill({ json: memory });
    if (operation === "history" || operation === "attachments") return route.fulfill({ json: empty });
    return route.fulfill({ status: 400, json: { code: "invalid_request", error: `Unexpected ${operation}` } });
  });
  const navigation = page.getByRole("button", { name: "Knowledge", exact: true });
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await navigation.click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue(projectId);
  return { ...fixture, calls };
}

test("advanced result opens the exact reply on page two and Back restores the result focus", async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  const fixture = await mountNavigation(page);
  await page.getByRole("tab", {name:"Memory",exact:true}).click();
  await page.getByRole("button", {name:"More filters"}).click();
  await page.getByLabel("Record type").selectOption("reply");
  await page.getByLabel("Search titles, content and memory").fill("Needle");
  await page.getByRole("button", {name:"Filter",exact:true}).click();
  await page.locator("[data-memory-list]").getByRole("button", {name:"Next page"}).click();
  const result = page.locator('[data-result-key="reply:reply-30"]');
  await expect(result).toBeVisible();
  await expect(result).toHaveAttribute("href", /record=thread-navigation.*reply=reply-30/);
  await result.click();
  await expect(page).toHaveURL(/reply=reply-30/);
  const selected=page.locator('[data-reply-id="reply-30"]');
  await expect(selected).toBeVisible();
  await expect(selected).toBeFocused();
  await expect(selected).toContainText("Needle [literal] %_");
  await expect(page.locator('[data-reply-id="reply-1"]')).toHaveCount(0);
  expect(fixture.calls.some(call=>call.operation==="replies" && call.input.targetReplyId===target.id)).toBe(true);
  await page.goBack();
  await expect(page.getByLabel("Search titles, content and memory")).toHaveValue("Needle");
  await expect(page.getByLabel("Record type")).toHaveValue("reply");
  await expect(result).toBeFocused();
  expect(new URL(page.url()).searchParams.get("memoryOffset")).toBe("25");
  expect(fixture.errors).toEqual([]);
});

test("direct reply URL reloads, browser history returns to the hit, and bad targets stay unavailable", async ({page}) => {
  const fixture=await mountNavigation(page);
  await page.goto(`http://switcher.test/?view=knowledge&knowledgeProject=${projectId}&knowledgeTab=discussions&record=${threadId}&reply=${target.id}`);
  await expect(page.locator('[data-reply-id="reply-30"]')).toBeFocused();
  await page.reload();
  await expect(page.locator('[data-reply-id="reply-30"]')).toBeFocused();
  await page.goto(`http://switcher.test/?view=knowledge&knowledgeProject=${projectId}&knowledgeTab=discussions&record=other-thread&reply=${target.id}`);
  await expect(page.getByRole("region",{name:"Record reader"}).getByRole("region",{name:"Replies"}).getByRole("alert")).toContainText("unavailable in the selected thread");
  await expect(page.locator('[data-reply-id="reply-30"]')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('[data-reply-id="reply-30"]')).toBeFocused();
  await page.goForward();
  await expect(page.getByRole("region",{name:"Record reader"}).getByRole("region",{name:"Replies"}).getByRole("alert")).toContainText("unavailable in the selected thread");
  expect(fixture.errors).toEqual([]);
});

test("readable relation rows navigate to thread, memory, and an exact reply in EN and PL", async ({page}) => {
  const fixture=await mountNavigation(page);
  await page.getByRole("link", {name:task.title,exact:true}).click();
  const relations=page.getByRole("region", {name:"Record reader"}).getByRole("region", {name:"Relations"});
  await expect(relations.getByRole("link", {name:/Pilot topic.*Thread.*Derived from/})).toBeVisible();
  await expect(relations.getByRole("link", {name:/Decision on navigation.*Memory.*Related to.*Active/})).toBeVisible();
  await expect(relations.getByRole("link", {name:/Thread sharing an ID.*Thread.*Superseded by/})).toBeVisible();
  await expect(relations.getByText("Related record unavailable")).toBeVisible();
  await relations.getByRole("link", {name:/Decision on navigation/}).click();
  await expect(page.getByRole("heading", {name:memory.title})).toBeVisible();
  await page.getByRole("tab", {name:"Discussions",exact:true}).click();
  await page.getByRole("link", {name:thread.title,exact:true}).click();
  await page.getByRole("region", {name:"Record reader"}).getByRole("region", {name:"Relations"}).getByRole("link", {name:/Reply in: Pilot topic/}).click();
  await expect(page.locator('[data-reply-id="reply-30"]')).toBeFocused();
  await selectLanguage(page);
  await expect(page.getByText("Wybrana odpowiedź")).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

test("reply paging keeps the reader and relation page, while SPA Back refocuses a remounted target", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const fixture=await mountNavigation(page);
  await page.goto(`http://switcher.test/?view=knowledge&knowledgeProject=${projectId}&knowledgeTab=discussions&record=${threadId}&reply=${target.id}`);
  const reader=page.getByRole("region",{name:"Record reader"});
  const selected=page.locator('[data-reply-id="reply-30"]');
  await expect(selected).toBeFocused();
  const relations=reader.getByRole("region",{name:"Relations"});
  await relations.getByRole("button",{name:"Next page"}).click();
  await expect(relations.getByText("Last relation page")).toBeVisible();
  await reader.getByRole("button",{name:"Previous replies"}).click();
  await expect(page).not.toHaveURL(/reply=/);
  await expect(reader.getByRole("heading",{name:thread.title})).toBeVisible();
  await expect(relations.getByText("Last relation page")).toBeVisible();
  await expect(page.locator('[data-reply-id="reply-1"]')).toBeVisible();
  await expect(reader.getByRole("heading",{name:thread.title})).not.toBeFocused();
  await reader.getByRole("button",{name:"Next replies"}).click();
  await expect(page.locator('[data-reply-id="reply-30"]')).toBeVisible();
  await expect(page.locator('[data-reply-id="reply-30"]')).not.toContainText("Selected reply");
  await page.evaluate(() => {
    const url=new URL(location.href);url.searchParams.set("reply","reply-30");
    history.pushState(null,"",url);dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(selected).toBeFocused();
  const replyCalls=fixture.calls.filter(call=>call.operation==="replies").length;
  const refresh=page.getByRole("button",{name:"Refresh",exact:true});
  await refresh.click();
  await expect.poll(()=>fixture.calls.filter(call=>call.operation==="replies").length).toBeGreaterThan(replyCalls);
  await expect(refresh).toBeFocused();
  await page.evaluate(() => {
    const url=new URL(location.href);url.searchParams.set("record","other-thread");
    history.pushState(null,"",url);dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("region",{name:"Record reader"}).getByRole("region",{name:"Replies"}).getByRole("alert")).toBeVisible();
  await page.goBack();
  await expect(selected).toBeFocused();
  expect(fixture.errors).toEqual([]);
});
