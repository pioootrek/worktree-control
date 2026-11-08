import { expect, test, type Page } from "@playwright/test";

import { SIGN_OUT_ATTEMPT_TIMEOUT_MS, SIGN_OUT_UNCONFIRMED_KEY } from "../../src/features/account/use-account-session";
import { knowledgeSourceHref } from "../../src/shared/contracts/knowledge-links";
import { FIXTURE_PROJECT_ID, FIXTURE_RESERVATION_ID, mockWebAuthn, mountAccount, type AccountFixture, type FixtureRawAnswer } from "./account-fixture";

test("rejects a wrong password and signs in with the right one without storing any credential", async ({ page }) => {
  const fixture = await mountAccount(page);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();

  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Sign-in failed. Check the credentials and try again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  await expect(page.getByText("Claim: none")).toBeVisible();

  // The cookie is the sole authority: no token or secret is stored or sent as a header.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  const apiRequests = fixture.requests.filter(request => request.path !== "/api/auth/status");
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(apiRequests.every(request => request.authorization === null)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

test("completes the TOTP challenge after a password sign-in", async ({ page }) => {
  await mountAccount(page, { totpCode: "123456" });
  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verification code" })).toBeVisible();

  await page.getByLabel("TOTP code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
});

test("signs in with a passkey through the platform credential API", async ({ page }) => {
  await mockWebAuthn(page);
  await mountAccount(page, { passkey: true });
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
});

test("resumes a live session after a reload and drops to sign-in when it is gone", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  const sessionProbes = fixture.requests.filter(request => request.path === "/api/auth/get-session").length;
  const [resumed] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/auth/get-session") && response.status() === 200),
    page.reload(),
  ]);
  expect(await resumed.json()).toMatchObject({ authenticated: true, principal: { id: "acct-1", kind: "human" } });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === "/api/auth/get-session")).toHaveLength(sessionProbes + 1);
  expect(fixture.requests.some(request => request.path === "/api/auth/sign-in/email")).toBe(false);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  await expireSessionOnRefresh(page, fixture);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(fixture.requests.every(request => request.authorization === null)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

/** Keep background reads from ending the session before the user can refresh. */
async function expireSessionOnRefresh(page: Page, fixture: AccountFixture): Promise<void> {
  const runtimeRead = "/api/runtime/read";
  const projectReads = () => fixture.requests.filter(request => request.path === runtimeRead
    && (request.body as { operation?: string } | null)?.operation === "list-projects").length;
  const before = projectReads();
  // The trace's losing request was a background configuration read. Hold all
  // scoped read paths while the session is live, including the manual refresh.
  for (const path of [runtimeRead, "/api/runtime/configuration", "/api/runtime/tests"]) fixture.holds.add(path);
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect.poll(projectReads).toBeGreaterThan(before);
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

    // Match requireSession's expired-session contract, but deliver it only
    // after the click and its list-projects request have both happened.
    fixture.session = null;
    const [expired] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith(runtimeRead) && response.status() === 401
        && response.request().postDataJSON()?.operation === "list-projects", { timeout: 10_000 }),
      fixture.releaseHeld(runtimeRead, { status: 401, json: { code: "invalid_credential", error: "Fixture invalid_credential" } }),
    ]);
    expect(await expired.json()).toEqual({ code: "invalid_credential", error: "Fixture invalid_credential" });
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  } finally {
    fixture.holds.clear();
    await fixture.releaseHeld();
  }
}

test("sign-out ends the session and leaves no stale project data", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).toBeNull();
  expect(fixture.requests.some(request => request.path === "/api/auth/sign-out")).toBe(true);
});

test("knowledge reads ride the session cookie and never send a bearer", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("tab", { name: "Knowledge" }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  const knowledgeRequests = fixture.requests.filter(request => request.path === "/api/knowledge");
  expect(knowledgeRequests.length).toBeGreaterThan(0);
  expect(knowledgeRequests.every(request => request.authorization === null)).toBe(true);
});

const linkedProject = { id: "linked-project", name: "Linked knowledge", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const linkedTask = { id: "linked-task", projectId: linkedProject.id, title: "Linked account task", description: "Private task context", status: "open", priority: "next", revision: 1, createdBy: "acct-1", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const secondLinkedTask = { ...linkedTask, id: "second-linked-task", title: "Second account task" };
const linkedSearch = knowledgeSourceHref(linkedProject.id, { kind: "task", id: linkedTask.id, revision: linkedTask.revision }) + "&unrelated=kept";

function accountKnowledge(body: Record<string, unknown>): { status?: number; json: unknown } {
  const { operation } = body;
  const input = body.input as Record<string, unknown>;
  const tasks = [linkedTask, secondLinkedTask];
  const empty = { items: [], nextOffset: null };
  if (operation === "projects") return { json: { ...empty, items: [{ ...linkedProject, id: "other-project", name: "Other knowledge" }, linkedProject] } };
  if (operation === "project") return { json: linkedProject };
  if (operation === "tasks") return { json: { ...empty, items: tasks, total: tasks.length, counts: { active: 2, now: 0, next: 2, blocked: 0, done: 0, all: 2 } } };
  if (operation === "task") return { json: tasks.find(task => task.id === input.taskId) };
  if (operation === "task_state") return { json: { state: null, assessment: {}, systemFacts: { approvedDecisions: 0, proposals: 0, openQuestions: 0, attachments: 0 } } };
  if (operation === "relations") return { json: empty };
  return { status: 400, json: { code: "invalid_request", error: `Unexpected fixture operation ${operation}` } };
}

async function expectLinkedTask(page: Page, task = linkedTask) {
  await expect(page.getByRole("tab", { name: "Knowledge", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Backlog", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue(linkedProject.id);
  await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
  const params = new URL(page.url()).searchParams;
  expect(params.get("view")).toBe("knowledge");
  expect(params.get("knowledgeProject")).toBe(linkedProject.id);
  expect(params.get("knowledgeTab")).toBe("backlog");
  expect(params.get("record")).toBe(task.id);
}

for (const knowledgeOnly of [false, true]) {
  test(`account Knowledge deep link survives an actual reload${knowledgeOnly ? " with Knowledge-only access" : ""}`, async ({ page }) => {
    const fixture = await mountAccount(page, {
      preAuthenticated: true, search: linkedSearch, knowledge: accountKnowledge,
      ...(knowledgeOnly ? { runtimeRead: () => ({ status: 403, json: { code: "forbidden", error: "No runtime access" } }) } : {}),
    });
    await expectLinkedTask(page);
    expect(new URL(page.url()).search).toBe(linkedSearch);
    const probes = fixture.requests.filter(request => request.path === "/api/auth/get-session").length;
    await page.reload();
    await expectLinkedTask(page);
    expect(new URL(page.url()).search).toBe(linkedSearch);
    expect(fixture.requests.filter(request => request.path === "/api/auth/get-session").length).toBeGreaterThan(probes);
    // Opening and reloading a Knowledge link must never mount the runtime panel.
    expect(fixture.requests.filter(request => request.path.startsWith("/api/runtime/"))).toEqual([]);
    expect(fixture.requests.every(request => request.authorization === null)).toBe(true);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(fixture.errors).toEqual([]);
  });
}

test("sign-in preserves the account Knowledge deep-link destination", async ({ page }) => {
  const fixture = await mountAccount(page, { search: linkedSearch, knowledge: accountKnowledge });
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectLinkedTask(page);
  expect(new URL(page.url()).search).toBe(linkedSearch);
  expect(fixture.requests.filter(request => request.path.startsWith("/api/runtime/"))).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("account tabs and Knowledge record links follow browser Back and Forward", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, knowledge: accountKnowledge });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  await page.getByLabel("Knowledge project", { exact: true }).selectOption(linkedProject.id);
  await page.getByRole("link", { name: linkedTask.title, exact: true }).click();
  await expectLinkedTask(page);
  await page.getByRole("link", { name: secondLinkedTask.title, exact: true }).click();
  await expectLinkedTask(page, secondLinkedTask);
  await page.getByRole("tab", { name: "Security", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enable TOTP" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("record")).toBe(secondLinkedTask.id);
  await page.getByRole("tab", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole("tab", { name: "Security", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expectLinkedTask(page, secondLinkedTask);
  await page.goBack();
  await expectLinkedTask(page);
  await page.goBack();
  await expect(page.getByRole("heading", { name: linkedTask.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: linkedTask.title, exact: true })).toBeVisible();
  await page.goForward();
  await expectLinkedTask(page);
  await page.goForward();
  await expectLinkedTask(page, secondLinkedTask);
  await page.goForward();
  await expect(page.getByRole("tab", { name: "Security", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

for (const source of ["/api/auth/get-session", "/api/knowledge"]) {
  test(`Knowledge refresh 401 from ${source} clears the account view and permits sign-in`, async ({ page }) => {
    const fixture = await mountAccount(page, { preAuthenticated: true, search: linkedSearch, knowledge: accountKnowledge });
    try {
      await expectLinkedTask(page);
      const reads = (path: string) => fixture.requests.filter(request => request.path === path).length;
      const before = reads(source);
      fixture.holds.add("/api/auth/get-session");
      fixture.holds.add("/api/knowledge");
      await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
      await expect.poll(() => reads(source)).toBeGreaterThan(before);
      fixture.session = null;
      const [expired] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith(source) && response.status() === 401),
        fixture.releaseHeld(source, { status: 401, json: { code: "invalid_credential", error: "Fixture invalid_credential" } }),
      ]);
      expect(await expired.json()).toMatchObject({ code: "invalid_credential" });
      await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
      await expect(page.getByText("The session expired or was revoked. Sign in again.")).toBeVisible();
      await expect(page.locator("[data-knowledge-workspace]")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: linkedTask.title, exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
      fixture.holds.clear();
      await fixture.releaseHeld();

      await page.getByLabel("Email address").fill("user@example.com");
      await page.getByLabel("Password", { exact: true }).fill("fixture-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expectLinkedTask(page);
      expect(new URL(page.url()).search).toBe(linkedSearch);
      expect(fixture.requests.every(request => request.authorization === null)).toBe(true);
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      expect(fixture.errors).toEqual([]);
    } finally {
      fixture.holds.clear();
      await fixture.releaseHeld();
    }
  });
}

for (const operation of ["projects", "tasks"]) {
  test(`Knowledge ${operation} 403 retains the account session and can recover`, async ({ page }) => {
    let denied = false;
    const fixture = await mountAccount(page, {
      preAuthenticated: true, search: linkedSearch,
      knowledge: body => denied && body.operation === operation
        ? { status: 403, json: { code: "forbidden", error: "No knowledge access" } } : accountKnowledge(body),
    });
    await expectLinkedTask(page);
    denied = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: linkedTask.title, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(fixture.session).not.toBeNull();
    // Another authorized account panel remains usable after the denial.
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
    denied = false;
    await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
    await expectLinkedTask(page);
    expect(fixture.requests.some(request => request.path === "/api/auth/sign-in/email" || request.path === "/api/auth/sign-out")).toBe(false);
    expect(fixture.errors).toEqual([]);
  });
}

test("a Knowledge record-read 401 ends the account session while the identity probe is held", async ({ page }) => {
  let denied = false;
  const fixture = await mountAccount(page, {
    preAuthenticated: true, search: linkedSearch,
    knowledge: body => denied && body.operation === "task"
      ? { status: 401, json: { code: "invalid_credential", error: "Fixture invalid_credential" } } : accountKnowledge(body),
  });
  try {
    await expectLinkedTask(page);
    fixture.holds.add("/api/auth/get-session");
    denied = true;
    const [expired] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/knowledge") && response.status() === 401
        && response.request().postDataJSON()?.operation === "task"),
      page.getByRole("button", { name: "Refresh", exact: true }).first().click(),
    ]);
    expect(await expired.json()).toMatchObject({ code: "invalid_credential" });
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
    await expect(page.getByText("The session expired or was revoked. Sign in again.")).toBeVisible();
    await expect(page.locator("[data-knowledge-workspace]")).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally {
    fixture.holds.clear();
    await fixture.releaseHeld();
  }
});

const linkedMemory = { id: "linked-memory", projectId: linkedProject.id, title: "Private account memory", body: "Private memory body", category: "decision", status: "active", revision: 1, tags: [], sources: [], createdBy: "acct-1", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const memorySearch = knowledgeSourceHref(linkedProject.id, { kind: "memory", id: linkedMemory.id, revision: 1 });
const independentOperations = ["task_context", "export_context", "search", "memory", "history", "task_state", "archive_memory"] as const;
type IndependentOperation = typeof independentOperations[number];

function independentKnowledge(body: Record<string, unknown>): { status?: number; json: unknown } {
  if (body.operation === "memory") return { json: linkedMemory };
  if (body.operation === "search") return { json: { items: [{ kind: "memory", id: linkedMemory.id, projectId: linkedProject.id, title: linkedMemory.title, excerpt: linkedMemory.body, revision: 1, status: "active", accessible: true }], nextOffset: null } };
  if (body.operation === "history") return { json: { items: [], nextOffset: null } };
  if (body.operation === "task_context") return { json: { scope: "Private exported task scope", decisions: [], proposals: [], openQuestions: [], nextOffset: null, fingerprint: "fixture-context" } };
  if (body.operation === "export_context") return { json: { content: "Private exported task scope", fingerprint: "fixture-context" } };
  return accountKnowledge(body);
}

function holdOtherKnowledge(fixture: AccountFixture, operation: IndependentOperation) {
  fixture.holds.add("/api/auth/get-session");
  for (const other of ["projects", "project", "tasks", "task", "threads", "thread", "replies", "relations", ...independentOperations]) {
    if (other !== operation) fixture.holds.add(`/api/knowledge:${other}`);
  }
}

async function triggerIndependentKnowledge(page: Page, operation: IndependentOperation) {
  if (operation === "task_context") await page.getByRole("button", { name: "Next session context", exact: true }).click();
  else if (operation === "export_context") await page.getByRole("button", { name: "Copy context for agent", exact: true }).click();
  else if (operation === "archive_memory") await page.getByRole("button", { name: "Archive memory", exact: true }).click();
  else if (operation === "history") await page.locator("[data-memory-detail] summary").filter({ hasText: "Revision history" }).click();
  else if (operation === "task_state") await page.locator("section").filter({ has: page.getByRole("heading", { name: "Current state", exact: true }) }).getByRole("button", { name: "Refresh", exact: true }).click();
  else {
    await page.getByLabel("Search titles, content and memory", { exact: true }).fill("Private");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
  }
}

for (const operation of independentOperations) for (const status of [401, 403]) {
  test(`independent Knowledge ${operation} ${status} ${status === 401 ? "clears privileged content" : "retains the session and recovers"}`, async ({ page }) => {
    const memory = ["search", "memory", "history", "archive_memory"].includes(operation);
    let denied = false;
    let stateUnavailable = operation === "task_state";
    const fixture = await mountAccount(page, {
      preAuthenticated: true, search: memory ? memorySearch : linkedSearch,
      knowledge: body => body.operation === operation && (denied || stateUnavailable)
        ? { status: denied ? status : 503, json: { code: status === 401 ? "invalid_credential" : "forbidden", error: "Independent request denied" } }
        : independentKnowledge(body),
    });
    try {
      await expect(page.getByRole("heading", { name: memory ? linkedMemory.title : linkedTask.title, exact: true })).toBeVisible();
      if (operation === "task_state") await expect(page.getByText("The current state could not be loaded.")).toBeVisible();
      holdOtherKnowledge(fixture, operation);
      stateUnavailable = false;
      denied = true;
      if (status === 401) fixture.session = null;
      const [answer] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith("/api/knowledge") && response.status() === status && response.request().postDataJSON()?.operation === operation),
        triggerIndependentKnowledge(page, operation),
      ]);
      await answer.finished();
      if (status === 401) {
        await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
        await expect(page.getByText("The session expired or was revoked. Sign in again.")).toBeVisible();
        await expect(page.locator("[data-knowledge-workspace]")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
        await expect(page.getByText(memory ? linkedMemory.body : linkedTask.description, { exact: true })).toHaveCount(0);
      } else {
        if (operation === "task_state") await expect(page.getByText("The current state could not be loaded.")).toBeVisible();
        else await expect(page.getByRole("alert").filter({ hasText: /Could not|Saving failed/i }).first()).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
        expect(fixture.session).not.toBeNull();
        // Recovery remounts Knowledge without another login, after removing the denial.
        fixture.holds.clear(); await fixture.releaseHeld(); denied = false;
        await page.getByRole("tab", { name: "Security", exact: true }).click();
        await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
        await expect(page.getByRole("heading", { name: memory ? linkedMemory.title : linkedTask.title, exact: true })).toBeVisible();
        if (operation === "task_context" || operation === "export_context" || operation === "history") {
          await triggerIndependentKnowledge(page, operation);
          await expect(page.getByText(operation === "history" ? "No recorded changes." : "Private exported task scope", { exact: true })).toBeVisible();
        }
        if (operation === "task_state") await expect(page.getByText("No current state recorded", { exact: true })).toBeVisible();
        expect(fixture.requests.some(request => request.path === "/api/auth/sign-in/email" || request.path === "/api/auth/sign-out")).toBe(false);
      }
      expect(fixture.errors).toEqual([]);
    } finally { fixture.holds.clear(); await fixture.releaseHeld(); }
  });
}

for (const operation of ["task_context", "export_context"] as const) {
  test(`obsolete independent Knowledge ${operation} 401 cannot end a newer session`, async ({ page }) => {
    const fixture = await mountAccount(page, { preAuthenticated: true, search: linkedSearch, knowledge: independentKnowledge });
    try {
      await expectLinkedTask(page);
      fixture.holds.add(`/api/knowledge:${operation}`);
      const before = fixture.requests.length;
      await triggerIndependentKnowledge(page, operation);
      await expect.poll(() => fixture.requests.slice(before).some(request => (request.body as { operation?: string })?.operation === operation)).toBe(true);
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
      fixture.holds.clear();
      await page.getByLabel("Email address").fill("user@example.com");
      await page.getByLabel("Password", { exact: true }).fill("fixture-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expectLinkedTask(page);
      // task_context is cancelled on unmount; export_context has no AbortSignal and really arrives late.
      const late = operation === "export_context" ? page.waitForResponse(response => response.url().endsWith("/api/knowledge") && response.status() === 401 && response.request().postDataJSON()?.operation === operation) : null;
      await fixture.releaseHeld(`/api/knowledge:${operation}`, { status: 401, json: { code: "invalid_credential", error: "Obsolete session" } });
      if (late) await (await late).finished();
      // A fresh context response acts as a processing barrier, without sleeps.
      const [fresh] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith("/api/knowledge") && response.status() === 200 && response.request().postDataJSON()?.operation === "task_context"),
        triggerIndependentKnowledge(page, "task_context"),
      ]);
      await fresh.finished();
      await expect(page.getByText("Private exported task scope", { exact: true })).toBeVisible();
      await expectLinkedTask(page);
      await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
      await expect(page.getByText("The session expired or was revoked. Sign in again.")).toHaveCount(0);
      expect(fixture.session).not.toBeNull();
      expect(fixture.errors).toEqual([]);
    } finally { fixture.holds.clear(); await fixture.releaseHeld(); }
  });
}

test("claims a worktree with one idempotent mutation", async ({ page }) => {
  const fixture = await mountAccount(page, {
    preAuthenticated: true,
    runtimeMutate: () => ({
      json: {
        operation: "claim", projectId: "web",
        claim: { reservationId: "res-1", worktreePath: "/fixture/web", expiresAt: "2030-01-01T00:30:00.000Z", maximumExpiresAt: null },
        startRequested: false, error: null, replayed: false,
      },
    }),
  });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  await page.getByLabel("Claim reason").fill("GUI proof");
  await page.getByRole("button", { name: "Claim", exact: true }).click();

  const mutation = fixture.requests.find(request => request.path === "/api/runtime/mutate");
  expect(mutation?.body).toMatchObject({ operation: "claim", projectId: FIXTURE_PROJECT_ID, worktreePath: "/fixture/web", reason: "GUI proof", ttlSeconds: 1800 });
  expect(String((mutation?.body as { idempotencyKey?: string })?.idempotencyKey)).toMatch(/^[0-9a-f-]{36}$/);
  expect(fixture.errors).toEqual([]);
});

test("shows a current-authority denial instead of reinterpreting it", async ({ page }) => {
  await mountAccount(page, {
    preAuthenticated: true,
    runtimeRead: () => ({ status: 403, json: { code: "project_access_denied", error: "Denied" } }),
  });
  await expect(page.getByText("This operation is not allowed for the account.")).toBeVisible();
  // A 403 is a denial, not session loss: the sign-in screen must not appear.
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
});

test("enrolling TOTP ends the session and returns to sign-in with a notice", async ({ page }) => {
  await mountAccount(page, { preAuthenticated: true, totpCode: "123456" });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("tab", { name: "Security" }).click();
  await page.getByLabel("Confirm with password").fill("fixture-password");
  await page.getByRole("button", { name: "Enable TOTP" }).click();
  await expect(page.getByLabel("Authenticator app URI")).toHaveValue(/otpauth:\/\/totp\//);
  await page.getByLabel("TOTP code").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByText("TOTP was enabled. Sign in again.")).toBeVisible();
});

test("registers a passkey in two steps and returns to sign-in", async ({ page }) => {
  await mockWebAuthn(page);
  await mountAccount(page, { preAuthenticated: true, passkey: true });
  await page.getByRole("tab", { name: "Security" }).click();

  await page.getByRole("button", { name: "Register a passkey" }).click();
  await expect(page.getByText("Passkey created. Confirm it to finish registration.")).toBeVisible();
  await page.getByRole("button", { name: "Confirm passkey" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByText("The passkey was registered. Sign in again.")).toBeVisible();
});

test("open and token modes keep the legacy dashboard untouched", async ({ page }) => {
  await mountAccount(page, { loginAvailable: false });
  // The legacy surface asks for the installation token; no account form renders.
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
});

test("a failed mode probe shows a retriable error instead of the legacy dashboard", async ({ page }) => {
  const fixture = await mountAccount(page, { authStatusFails: true });
  // A probe error is not a definitive answer: neither surface renders.
  await expect(page.getByText("Could not determine the sign-in mode")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);

  fixture.authStatusFails = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
});

for (const [name, answer] of [
  ["a dropped connection", "network"],
  ["a 200 without a usable body", { json: {} }],
  ["a 200 with an unknown mode", { json: { mode: "kerberos", loginAvailable: false } }],
  ["a 200 claiming a token mode with a login surface", { json: { mode: "token", loginAvailable: true } }],
] as const) {
  test(`${name} from the mode probe never selects the legacy token dashboard`, async ({ page }) => {
    await mountAccount(page, { authStatusAnswer: answer });
    await expect(page.getByText("Could not determine the sign-in mode")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
}

test("account mode with an unavailable provider shows a retriable notice, not the legacy dashboard", async ({ page }) => {
  await mountAccount(page, { authStatusAnswer: { json: { mode: "better-auth", loginAvailable: false } } });
  await expect(page.getByText("Account sign-in is temporarily unavailable")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
});

test("a failed session probe hides account data and the sign-in form until a retry answers", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, getSessionFailures: 1 });
  await expect(page.getByText("Could not check the session")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === "/api/auth/get-session")).toHaveLength(2);
});

test("sign-out retries once after a failure and then confirms", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 1 });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  // The first attempt failed with a 503; the bounded retry confirmed the sign-out.
  expect(fixture.requests.filter(request => request.path === "/api/auth/sign-out")).toHaveLength(2);
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(fixture.errors).toEqual([]);
});

test("an unconfirmed sign-out blocks the account UI until a manual retry confirms it", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  // Both bounded attempts failed: the honest unconfirmed state, never a fake sign-in screen.
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).not.toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY)).not.toBeNull();

  fixture.signOutFailures = 0;
  await page.getByRole("button", { name: "Retry sign-out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a reload with an unconfirmed sign-out marker finishes the sign-out instead of resuming the session", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  // The session survived server-side and the marker remembers the intent: a reload
  // must complete the sign-out, never silently resume the account.
  fixture.signOutFailures = 0;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a reload whose session probe fails keeps a pending sign-out unconfirmed instead of offering sign-in", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  fixture.getSessionFailures = 1;
  await page.reload();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  expect(fixture.session).not.toBeNull();

  await page.getByRole("button", { name: "Retry sign-out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a fresh sign-in supersedes a stale sign-out marker from another tab instead of ending the new session", async ({ page }) => {
  const fixture = await mountAccount(page);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  // Another tab of the same origin recorded an unconfirmed sign-out meanwhile.
  await page.evaluate(key => localStorage.setItem(key, "1"), SIGN_OUT_UNCONFIRMED_KEY);

  await page.getByLabel("Email address").fill("user@example.com");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === "/api/auth/sign-out")).toHaveLength(0);
  expect(fixture.session).not.toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY)).toBeNull();
});

test("a reload that cannot confirm the sign-out stays on the unconfirmed screen until the user chooses", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 99 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);

  // An explicit user choice returns to the account and clears the intent marker.
  await page.getByRole("button", { name: "Return to account" }).click();
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY)).toBeNull();
  fixture.signOutFailures = 0;
});

test("losing the session mid-work returns to sign-in with a session-lost notice", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await expireSessionOnRefresh(page, fixture);
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  await expect(page.getByText("The session expired or was revoked. Sign in again.")).toBeVisible();
});

test("selects an environment profile and saves a preset timeout with CAS and a re-fetch", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Environment profile").selectOption("ci");
  await page.getByRole("button", { name: "Select profile" }).click();
  await expect(page.getByText("Profile selected.")).toBeVisible();
  const select = fixture.requests.find(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "select_environment_profile");
  expect(select?.body).toMatchObject({ operation: "select_environment_profile", projectId: FIXTURE_PROJECT_ID, name: "ci", expectedRevision: 3 });

  await page.getByLabel("Timeout (ms)").fill("120000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Timeout saved.")).toBeVisible();
  const timeout = fixture.requests.find(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "set_test_preset_timeout");
  // Profile selection and timeouts share the project revision: the save after a select carries the re-read one.
  expect(timeout?.body).toMatchObject({
    operation: "set_test_preset_timeout", projectId: FIXTURE_PROJECT_ID,
    worktreePath: "/fixture/web", presetId: "node:test", timeoutMs: 120000, expectedRevision: 4,
  });

  // Both saves re-fetched the fresh state instead of trusting their own write.
  const reads = fixture.requests.filter(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "profiles");
  expect(reads.length).toBeGreaterThanOrEqual(2);
  const configurations = fixture.requests.filter(request => request.path === "/api/runtime/configuration"
    && (request.body as { operation?: string } | null)?.operation === "configuration");
  expect(configurations.length).toBeGreaterThanOrEqual(2);
  expect(fixture.errors).toEqual([]);
});

const conflictMessage = "The configuration changed meanwhile. The current values were reloaded; review them and try again.";
const configurationBodies = (fixture: { requests: Array<{ path: string; body: unknown }> }, operation: string) =>
  fixture.requests
    .filter(request => request.path === "/api/runtime/configuration" && (request.body as { operation?: string } | null)?.operation === operation)
    .map(request => request.body as { expectedRevision?: number; idempotencyKey?: string });

test("a profile revision conflict is shown once, reloads the current values and lets a retry succeed", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, configurationConflictOnce: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Environment profile").selectOption("ci");
  await page.getByRole("button", { name: "Select profile" }).click();
  // Exactly one alert: the panel owns the message, the project section does not repeat it.
  await expect(page.getByText(conflictMessage)).toHaveCount(1);
  await expect(page.getByText("Profile selected.")).toHaveCount(0);
  // The concurrent writer's values replaced the stale draft.
  await expect(page.getByLabel("Timeout (ms)")).toHaveValue("90000");
  await expect(page.getByLabel("Environment profile")).toHaveValue("dev");

  await page.getByLabel("Environment profile").selectOption("ci");
  await page.getByRole("button", { name: "Select profile" }).click();
  await expect(page.getByText("Profile selected.")).toBeVisible();
  await expect(page.getByText(conflictMessage)).toHaveCount(0);
  const selects = configurationBodies(fixture, "select_environment_profile");
  expect(selects.map(body => body.expectedRevision)).toEqual([3, 4]);
  // A retry after a reported conflict is a new intent with a new idempotency key.
  expect(new Set(selects.map(body => body.idempotencyKey)).size).toBe(2);
  expect(fixture.errors).toEqual([]);
});

test("a timeout revision conflict reloads the current override and a retry carries the fresh revision", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, configurationConflictOnce: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Timeout (ms)").fill("120000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(conflictMessage)).toHaveCount(1);
  await expect(page.getByText("Timeout saved.")).toHaveCount(0);
  await expect(page.getByLabel("Timeout (ms)")).toHaveValue("90000");

  await page.getByLabel("Timeout (ms)").fill("120000");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Timeout saved.")).toBeVisible();
  await expect(page.getByLabel("Timeout (ms)")).toHaveValue("120000");
  expect(configurationBodies(fixture, "set_test_preset_timeout").map(body => body.expectedRevision)).toEqual([3, 4]);
  expect(fixture.errors).toEqual([]);
});

test("renews an own claim from the claim controls", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByLabel("Claim reason").fill("GUI proof");
  await page.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(page.getByRole("button", { name: "Renew" })).toBeVisible();

  await page.getByRole("button", { name: "Renew" }).click();
  const renew = fixture.requests.find(request => request.path === "/api/runtime/mutate"
    && (request.body as { operation?: string } | null)?.operation === "renew");
  expect(renew?.body).toMatchObject({ operation: "renew", projectId: FIXTURE_PROJECT_ID, reservationId: FIXTURE_RESERVATION_ID, ttlSeconds: 1800 });
  expect(fixture.errors).toEqual([]);
});

test("cancels a queued test run", async ({ page }) => {
  const runId = "44444444-4444-4444-8444-444444444444";
  const state = { phase: "queued" };
  const envelope = (phase: string) => ({
    schemaVersion: 1, epoch: "epoch-1", cursor: "cursor-1", observedAt: "2030-01-01T00:00:00.000Z", retryAfterMs: null,
    status: {
      runId, projectId: FIXTURE_PROJECT_ID, presetId: "node:test", worktreePath: "/fixture/web", phase,
      queuedAt: "2030-01-01T00:00:00.000Z", startedAt: null, finishedAt: null, exitCode: null, errorCode: null,
      source: { queuedHead: null, preflightHead: null, finishHead: null, attribution: "pending", processOutcome: null },
    },
  });
  const fixture = await mountAccount(page, {
    preAuthenticated: true,
    runtimeTests: body => {
      if (body.operation === "presets") return { json: [{ worktreePath: "/fixture/web", presets: [{ id: "node:test", timeoutMs: 60_000 }] }] };
      if (body.operation === "enqueue") return { json: envelope(state.phase) };
      if (body.operation === "status") return { json: envelope(state.phase) };
      if (body.operation === "cancel") { state.phase = "cancelled"; return { json: envelope(state.phase) }; }
      return { status: 400, json: { code: "invalid_request", error: "Unknown fixture test operation" } };
    },
  });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Cancelled")).toBeVisible();

  const cancel = fixture.requests.find(request => request.path === "/api/runtime/tests"
    && (request.body as { operation?: string } | null)?.operation === "cancel");
  expect(cancel?.body).toMatchObject({ operation: "cancel", runId, projectId: FIXTURE_PROJECT_ID });
  expect(fixture.errors).toEqual([]);
});

const signOutRequests = (fixture: AccountFixture) => fixture.requests.filter(request => request.path === "/api/auth/sign-out").length;
const marker = (page: Page) => page.evaluate(key => localStorage.getItem(key), SIGN_OUT_UNCONFIRMED_KEY);

test("the sign-out intent is recorded before the request, so a reload during a stalled sign-out finishes it", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  try {
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
    fixture.holds.add("/api/auth/sign-out");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Signing out…")).toBeVisible();
    await expect.poll(() => signOutRequests(fixture)).toBe(1);
    // No answer exists yet, but the intent is already durable and the session is still live.
    expect(await marker(page)).toBe("1");
    expect(fixture.session).not.toBeNull();

    fixture.holds.clear();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
    expect(fixture.session).toBeNull();
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    await fixture.releaseHeld();
  } finally {
    fixture.holds.clear();
    await fixture.releaseHeld();
  }
});

test("a sign-out that never answers becomes unconfirmed in bounded time and keeps the intent", async ({ page }) => {
  await page.clock.install();
  const fixture = await mountAccount(page, { preAuthenticated: true });
  try {
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
    fixture.holds.add("/api/auth/sign-out");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => signOutRequests(fixture)).toBe(1);
    await page.clock.fastForward(SIGN_OUT_ATTEMPT_TIMEOUT_MS);
    await expect.poll(() => signOutRequests(fixture)).toBe(2);
    await expect(page.getByText("Signing out…")).toBeVisible();
    await page.clock.fastForward(SIGN_OUT_ATTEMPT_TIMEOUT_MS);
    await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
    expect(await marker(page)).toBe("1");
    expect(fixture.session).not.toBeNull();

    fixture.holds.clear();
    await fixture.releaseHeld();
    await page.getByRole("button", { name: "Retry sign-out" }).click();
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
    expect(fixture.session).toBeNull();
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  } finally {
    fixture.holds.clear();
    await fixture.releaseHeld();
  }
});

test("a 200 sign-out without the server's sign-out proof is not a confirmation", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  fixture.signOutAnswer = { json: {} };

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  expect(signOutRequests(fixture)).toBe(2);
  expect(fixture.session).not.toBeNull();
  expect(await marker(page)).toBe("1");

  fixture.signOutAnswer = null;
  await page.getByRole("button", { name: "Retry sign-out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  expect(fixture.session).toBeNull();
});

const liveSessionShape = { principal: { id: "acct-1", kind: "human" }, expiresAt: "2030-01-01T00:00:00.000Z", authentication: { method: "password", factors: 1 } };
for (const [name, answer] of [
  ["an empty 200", { json: {} }],
  ["a non-JSON proxy page", { body: "<html><body>Proxy sign-in</body></html>", contentType: "text/html" }],
  ["a string authentication flag", { json: { authenticated: "false" } }],
  ["an unknown principal kind", { json: { authenticated: true, ...liveSessionShape, principal: { id: "acct-1", kind: "agent" } } }],
  ["a non-canonical expiry", { json: { authenticated: true, ...liveSessionShape, expiresAt: 1893456000000 } }],
] as Array<[string, FixtureRawAnswer]>) {
  test(`${name} from get-session is neither anonymous nor a session`, async ({ page }) => {
    const fixture = await mountAccount(page, { preAuthenticated: true, getSessionAnswer: answer });
    await expect(page.getByText("Could not check the session")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);

    fixture.getSessionAnswer = null;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
  });
}

test("a malformed get-session answer keeps a pending sign-out unconfirmed and its marker", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true, signOutFailures: 2 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();

  fixture.getSessionAnswer = { json: {} };
  await page.reload();
  await expect(page.getByText("Sign-out was not confirmed")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Fixture Web" })).toHaveCount(0);
  // No proof arrived, so the intent survives.
  expect(await marker(page)).toBe("1");

  fixture.getSessionAnswer = null;
  await page.getByRole("button", { name: "Retry sign-out" }).click();
  await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
  expect(fixture.session).toBeNull();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a late 401 from the previous session's view cannot end the next session", async ({ page }) => {
  const fixture = await mountAccount(page, { preAuthenticated: true });
  try {
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
    const reads = () => fixture.requests.filter(request => request.path === "/api/runtime/read").length;
    const before = reads();

    // A manual refresh has no abort signal; hold its answer across a whole session change.
    fixture.holds.add("/api/runtime/read");
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect.poll(reads).toBeGreaterThan(before);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toBeVisible();
    fixture.holds.delete("/api/runtime/read");

    await page.getByLabel("Email address").fill("user@example.com");
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();

    const late = page.waitForResponse(response => response.url().endsWith("/api/runtime/read") && response.status() === 401, { timeout: 10_000 });
    await fixture.releaseHeld("/api/runtime/read", { status: 401, json: { code: "invalid_credential", error: "Fixture invalid_credential" } });
    await late;
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    await expect(page.getByRole("heading", { name: "Fixture Web" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Account sign-in" })).toHaveCount(0);
    await expect(page.getByText("The session expired or was revoked. Sign in again.")).toHaveCount(0);
    expect(fixture.session).not.toBeNull();
    expect(fixture.errors).toEqual([]);
  } finally {
    // Never leave a held request behind a failure; it would stall context teardown.
    fixture.holds.clear();
    await fixture.releaseHeld();
  }
});
