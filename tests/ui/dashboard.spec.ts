import { expect, test, type Route } from "@playwright/test";
import { translate } from "../../src/i18n/messages";
import { dashboardFixture, mountDashboard, testRunFixture } from "./dashboard-fixture";
import { openSystemDialog, selectLanguage } from "./shell-actions";

test("overview metrics lead to combined filters and persistent size sorting", async ({ page }) => {
  const data = dashboardFixture();
  const snapshot = data.projects[0];
  const initial = snapshot.worktrees[0];
  snapshot.worktrees = ["main", "done", "working"].map((branch) => ({ ...initial, branch, path: `/fixture/${branch}`, isDefaultBranch: branch === "main", merged: branch === "done", mergedInto: "main", lastCommitAt: "2020-01-01T00:00:00Z" }));
  snapshot.lastLaunchedAt = { "/fixture/done": "2020-01-01T00:00:00Z", "/fixture/working": new Date().toISOString() };
  snapshot.storage = snapshot.worktrees.slice(0, 2).map((w, index) => ({ worktreePath: w.path, status: "available", totalBytes: (index + 1) * 1024, nextBytes: 0, nextCacheBytes: 0, nodeModulesBytes: 0, otherBytes: 0, measuredAt: "2026-01-01T00:00:00Z", topDirectories: [], history: [], error: null }));
  const { requests, errors } = await mountDashboard(page, data);
  const overview = page.locator("[data-worktree-overview]");
  await expect(overview.getByText("No server is running", { exact: true })).toBeVisible();
  await overview.locator("details").last().locator("summary").click();
  await expect(overview.getByText("Measured 2 of 3 worktrees", { exact: true })).toBeVisible();
  await overview.getByRole("button", { name: /Disk usage/ }).click();
  await expect(page.locator("tbody tr").first()).toContainText("done");
  await expect(page.locator("tbody tr").last()).toContainText("working");
  await page.getByRole("combobox", { name: "Show", exact: true }).click();
  await page.getByRole("option", { name: "Inactive and merged", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("done");
  await page.screenshot({ path: test.info().outputPath("overview-filtered.png"), animations: "disabled", fullPage: true });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toContainText("Largest first");
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`worktree search and pagination retain row actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = dashboardFixture();
    const initial = data.projects[0].worktrees[0];
    data.projects[0].worktrees = Array.from({ length: 25 }, (_, i) => ({
      ...initial, path: `/fixture/checkout-${i}`, branch: `feature-${i}`, head: `${i.toString(16).padStart(8, "0")}abcdef`, shortHead: i.toString(16).padStart(8, "0"),
    }));
    data.projects[0].project.selectedWorktreePath = data.projects[0].worktrees[0].path;
    const { requests, errors } = await mountDashboard(page, data);
    const rows = page.locator("tbody tr");
    const pagination = page.getByRole("navigation", { name: "Worktree list pages" });
    const previous = pagination.getByRole("button", { name: "Previous", exact: true });
    const next = pagination.getByRole("button", { name: "Next", exact: true });
    await expect(rows).toHaveCount(10);
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(rows.first()).toContainText("feature-10");
    await next.click();
    await expect(rows).toHaveCount(5);
    await expect(next).toBeDisabled();
    await expect(rows.last().getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    const search = page.getByRole("searchbox", { name: "Search worktrees" });
    await search.fill("FEATURE-1");
    await expect(rows).toHaveCount(10);
    await expect(previous).toBeDisabled();
    await expect(pagination).toContainText("1 / 2");
    await search.fill("checkout-7");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("feature-7");
    await search.fill("00000018");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("feature-24");
    await search.fill("no-such-worktree");
    await expect(page.getByText("No matching worktrees.", { exact: true })).toBeVisible();
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    await expect(page.locator("#worktree-web")).toHaveCount(0);
    await search.fill("");
    await expect(rows).toHaveCount(10);
    await expect(page.locator("#worktree-web")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath("worktree-pagination.png"), animations: "disabled", fullPage: true });
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("sidebar scopes the test dashboard and follows the project picker", async ({ page }) => {
  const data = dashboardFixture();
  const initial = data.projects[0].worktrees[0];
  data.projects[0].worktrees.push({ ...initial, path: "/fixture/alternate", branch: "feature/alternate" });
  const second = structuredClone(data.projects[0]);
  second.project.id = "api";
  second.project.name = "Fixture API";
  second.runtime.logs = ["api-only-log-entry"];
  data.projects.push(second);
  const { requests, errors } = await mountDashboard(page, data);
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);
  await nav.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(nav.getByRole("button", { name: "Tests", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator("[data-tests-dashboard]")).toBeVisible();
  await expect(page.locator("#worktree-web")).toHaveCount(0);
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "Worktree", exact: true }).click();
  await page.getByRole("option", { name: /feature\/alternate/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await nav.getByRole("button", { name: "Resources", exact: true }).click();
  await expect(page.locator("[data-resources-dashboard]")).toBeVisible();
  await expect(page.getByRole("tabpanel").locator("tbody tr")).toHaveCount(2);
  await nav.getByRole("button", { name: "Worktrees", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select worktree feature/alternate", exact: true })).toHaveCount(0);
  await nav.getByRole("button", { name: "Logs", exact: true }).click();
  await page.getByRole("combobox", { name: /Choose project/ }).click();
  await page.getByRole("option", { name: /Fixture API/ }).click();
  await expect(nav.getByRole("button", { name: "Logs", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("api-only-log-entry", { exact: true })).toBeVisible();
  await expect(page.locator('[data-project-id="web"]')).toHaveCount(0);
  expect(requests).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureEvents: { active: number } }).fixtureEvents.active)).toBe(1);
  expect(errors).toEqual([]);
});

test("mobile sidebar supports keyboard dismissal, focus return and section selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await mountDashboard(page);
  const trigger = page.getByRole("button", { name: "Toggle navigation", exact: true });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: translate("en", "dashboard.navigation") });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Worktrees", exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("sidebar-mobile.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await sheet.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("heading", { name: "Tests", exact: true })).toBeVisible();
  await expect(page.locator("[data-tests-dashboard]")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await trigger.click();
  await expect(sheet.getByRole("button", { name: "Tests", exact: true })).toHaveAttribute("aria-current", "page");
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(errors).toEqual([]);
});

for (const locale of ["en", "pl"] as const) {
  test(`dashboard modules preserve actions and accessible dialogs (${locale})`, async ({ page }) => {
    const { requests, errors } = await mountDashboard(page);
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    await expect(page.locator('[data-project-id="web"]').getByText("Fixture Web", { exact: true })).toBeVisible();
    if (locale === "pl") await selectLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureEvents: { active: number } }).fixtureEvents.active)).toBe(1);
    await expect.poll(() => page.evaluate(() => {
      const events = (window as unknown as { fixtureEvents: { lastUrl: string; lastToken: string } }).fixtureEvents;
      return { url: events.lastUrl, token: events.lastToken };
    })).toEqual({ url: "/api/events", token: "ui-fixture-token" });
    await expect(page).toHaveURL("http://switcher.test/");

    await page.getByRole("button", { name: t("metadata.refresh"), exact: true }).click();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web/metadata/refresh", method: "POST", body: {} });
    const notice = page.getByRole("status");
    await expect(notice).toContainText(translate(locale, "metadata.refreshed", { name: "Fixture Web" }));
    await expect(notice).toBeInViewport();
    await notice.getByRole("button", { name: t("common.close"), exact: true }).click();
    await expect(notice).toBeEmpty();
    await page.getByRole("button", { name: t("metadata.refresh"), exact: true }).click();
    await expect(notice).toContainText(translate(locale, "metadata.refreshed", { name: "Fixture Web" }));
    await expect(page.getByRole("button", { name: t("row.start"), exact: true })).toBeVisible();

    await openSystemDialog(page, "capacity.openSettings", locale);
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("switch", { name: t("capacity.enabled"), exact: true }).click();
    await dialog.getByLabel(t("capacity.limit"), { exact: true }).fill("3");
    await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/settings/capacity", method: "POST", body: { enabled: true, limit: 3 } });

    await openSystemDialog(page, "tests.openSettings", locale);
    await dialog.getByLabel(t("tests.limit"), { exact: true }).fill("2");
    await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/settings/test-queue", method: "POST", body: { limit: 2 } });

    await page.getByText(t("worktreeLayout.projectSettings"), { exact: true }).click();
    await page.getByRole("button", { name: t("environment.settings"), exact: true }).click();
    await dialog.getByLabel(t("environment.variables"), { exact: true }).fill("APP_FEATURE=enabled");
    await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web/environment-profiles", method: "POST", body: { name: "default", environment: { APP_FEATURE: "enabled" }, restart: false } });

    await page.getByRole("button", { name: t("tls.settings"), exact: true }).click();
    await dialog.getByRole("combobox", { name: t("tls.mode"), exact: true }).click();
    await page.getByRole("option", { name: t("tls.generated"), exact: true }).click();
    await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web/tls", method: "POST", body: { mode: "generated", keyPath: null, certPath: null, caPath: null } });

    await page.getByRole("button", { name: t("row.start"), exact: true }).click();
    await expect(page.getByRole("button", { name: t("row.open"), exact: true })).toBeVisible();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web/operation", method: "POST", body: { operation: "start", worktreePath: "/fixture/web" } });
    await page.getByRole("button", { name: t("tls.settings"), exact: true }).click();
    await expect(dialog.getByRole("button", { name: t("common.save"), exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: t("tls.settings"), exact: true })).toBeFocused();
    await page.getByRole("button", { name: translate(locale, "worktreeLayout.moreForProject", { branch: "main", project: "Fixture Web" }), exact: true }).click();
    await page.getByRole("menuitem", { name: t("row.stop"), exact: true }).click();
    await expect(page.getByRole("button", { name: t("row.start"), exact: true })).toBeVisible();

    await page.getByRole("navigation").getByRole("button", { name: t("dashboard.navTests"), exact: true }).click();
    await page.getByRole("button", { name: t("tests.run"), exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: t("tests.run"), exact: true }).click();
    await expect(page.getByRole("button", { name: t("tests.cancel"), exact: true })).toBeVisible();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web/tests", method: "POST", body: { worktreePath: "/fixture/web", presetId: "node:test" } });
    await page.getByRole("button", { name: translate(locale, "testView.detailsFor", { name: "test", branch: "main" }), exact: true }).click();
    await expect(page.getByText("fixture test output", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("tests.cancel"), exact: true }).click();
    await expect(page.getByRole("button", { name: t("tests.cancel"), exact: true })).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/test-runs/run-1/cancel", method: "POST", body: {} });
    await page.keyboard.press("Escape");

    await openSystemDialog(page, "mcp.openStatus", locale);
    await expect(dialog.getByRole("heading", { name: t("mcp.title") })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("navigation").getByRole("button", { name: t("dashboard.navWorktrees"), exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("dashboard-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("combobox", { name: t("projectSwitcher.label") }).click();
    await page.getByRole("button", { name: t("add.trigger"), exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(t("add.name"), { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureEvents: { active: number } }).fixtureEvents.active)).toBe(1);
    await page.screenshot({ path: test.info().outputPath("dashboard-mobile.png"), fullPage: true });

    await page.getByText(t("worktreeLayout.projectSettings"), { exact: true }).click();
    await page.getByRole("button", { name: t("project.remove"), exact: true }).click();
    dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: translate(locale, "project.removeTitle", { name: "Fixture Web" }) })).toBeVisible();
    await dialog.getByRole("button", { name: t("project.confirmRemove"), exact: true }).click();
    await expect(page.locator('[data-project-id="web"]')).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web", method: "DELETE", body: {} });
    expect(errors).toEqual([]);
  });
}

test("the global project switcher filters projects and persists the selection", async ({ page }) => {
  const data = dashboardFixture();
  const second = structuredClone(data.projects[0]);
  second.project.id = "api";
  second.project.name = "Fixture API";
  second.project.repositoryPath = "/fixture/api";
  data.projects.push(second);
  await mountDashboard(page, data);

  const switcher = page.getByRole("combobox", { name: translate("en", "projectSwitcher.label") });
  await expect(switcher).toContainText("Fixture Web");
  await expect(page.locator('[data-project-id="web"]')).toBeVisible();
  await expect(page.locator('[data-project-id="api"]')).toBeHidden();

  await switcher.click();
  const search = page.getByRole("textbox", { name: translate("en", "projectSwitcher.search") });
  await search.fill("api");
  await expect(page.getByRole("option", { name: /Fixture Web/ })).toBeHidden();
  await search.press("ArrowDown");
  const apiOption = page.getByRole("option", { name: /Fixture API/ });
  await expect(apiOption).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("project-switcher-filtered.png") });
  await apiOption.press("Enter");
  await expect(switcher).toContainText("Fixture API");
  await expect(page.locator('[data-project-id="api"]')).toBeVisible();
  await expect(page.locator('[data-project-id="web"]')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("worktree-switcher-project-selection"))).toBe(
    JSON.stringify({ version: 1, projectId: "api" }),
  );

  await page.reload();
  await expect(switcher).toContainText("Fixture API");
  await expect(page.locator('[data-project-id="api"]')).toBeVisible();
});

test("a failed refresh after project removal does not leave the stale card disabled", async ({ page }) => {
  const { requests, errors } = await mountDashboard(page, dashboardFixture(), {
    failDashboardRefreshAfterProjectRemoval: true,
  });

  await page.getByText(translate("en", "worktreeLayout.projectSettings"), { exact: true }).click();
  await page.getByRole("button", { name: translate("en", "project.remove"), exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", {
    name: translate("en", "project.confirmRemove"),
    exact: true,
  }).click();

  await expect(page.getByRole("alert").getByText("Fixture dashboard refresh failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: translate("en", "project.remove"), exact: true })).toBeEnabled();
  expect(requests.at(-1)).toEqual({ path: "/api/projects/web", method: "DELETE", body: {} });
  expect(errors).toEqual([]);
});

test("a stale persisted project id falls back to an available project", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("worktree-switcher-project-selection", JSON.stringify({ version: 1, projectId: "removed-project" }));
  });
  await mountDashboard(page);

  await expect(page.locator('[data-project-id="web"]')).toBeVisible();
  await expect(page.getByRole("combobox", { name: /Choose project/ })).toContainText("Fixture Web");
});

test("rapid typed changes keep one live request in flight and one coalesced follow-up", async ({ page }) => {
  await mountDashboard(page);
  await expect(page.locator('[data-project-id="web"]').getByText("Fixture Web", { exact: true })).toBeVisible();
  const pending: Route[] = [];
  let active = 0;
  let maximumActive = 0;
  await page.route("**/api/dashboard/live?*", (route) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    pending.push(route);
  });
  const change = {
    epoch: "fixture", revision: 1, kinds: ["runtime"], projectIds: ["web"], allProjects: false,
    at: "2026-01-01T12:00:01.000Z",
  };
  await page.evaluate((event) => {
    const fixture = (window as unknown as { fixtureEvents: { emit(type: string, data: unknown): void } }).fixtureEvents;
    fixture.emit("changed", event);
    fixture.emit("changed", { ...event, revision: 2 });
  }, change);
  await expect.poll(() => pending.length).toBe(1);
  const runtime = dashboardFixture().projects[0].runtime;
  await pending[0].fulfill({ json: { projects: [{ projectId: "web", runtime }] } });
  active -= 1;
  await expect.poll(() => pending.length).toBe(2);
  await pending[1].fulfill({ json: { projects: [{ projectId: "web", runtime }] } });
  active -= 1;
  expect(maximumActive).toBe(1);
});

test("row actions target the clicked worktree and confirm switching the running server", async ({ page }) => {
  const data = dashboardFixture();
  const initial = data.projects[0].worktrees[0];
  data.projects[0].worktrees.push({ ...initial, path: "/fixture/alternate", branch: "feature/alternate" });
  const { requests, errors } = await mountDashboard(page, data);
  const alternate = page.locator("tbody tr").filter({ hasText: "feature/alternate" });
  const main = page.locator("[data-worktree-row]").filter({ has: page.getByRole("button", { name: "Actions for main in Fixture Web", exact: true }) });
  await expect(page.locator("[data-operation-target]")).toHaveCount(0);
  await expect(alternate.getByRole("button", { name: "Start", exact: true })).toHaveAccessibleDescription("Project Fixture Web, worktree feature/alternate");
  await alternate.getByRole("button", { name: "Start", exact: true }).click();
  expect(requests.at(-1)?.body).toEqual({ operation: "start", worktreePath: "/fixture/alternate" });
  await expect(alternate.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  await page.evaluate(() => { window.open = (...args) => { (window as unknown as { opened: unknown }).opened = args; return null; }; });
  await alternate.getByRole("button", { name: "Open", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { opened: unknown }).opened)).toEqual(["http://switcher.test:3000/", "_blank", "noopener,noreferrer"]);
  await main.getByRole("button", { name: "Switch here", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("feature/alternate");
  await expect(dialog).toContainText("main");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(main.getByRole("button", { name: "Switch here", exact: true })).toBeFocused();
  expect(requests).toHaveLength(1);
  await main.getByRole("button", { name: "Switch here", exact: true }).click();
  await dialog.getByRole("button", { name: "Switch here", exact: true }).click();
  expect(requests.at(-1)?.body).toEqual({ operation: "switch", worktreePath: "/fixture/web" });
  await expect(main.locator(":focus")).toHaveCount(1);
  await main.getByRole("button", { name: "Actions for main in Fixture Web", exact: true }).click();
  await page.getByRole("menuitem", { name: "Restart", exact: true }).click();
  expect(requests.at(-1)?.body).toEqual({ operation: "restart", worktreePath: "/fixture/web" });
  await main.getByRole("button", { name: "Actions for main in Fixture Web", exact: true }).click();
  await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
  expect(requests.at(-1)?.body).toEqual({ operation: "stop", worktreePath: "/fixture/web" });
  await expect(main.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
  const alternateMenu = alternate.getByRole("button", { name: "Actions for feature/alternate in Fixture Web", exact: true });
  await alternateMenu.click();
  await page.getByRole("menuitem", { name: "Details", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("/fixture/alternate");
  await page.keyboard.press("Escape");
  await expect(alternateMenu).toBeFocused();
  expect(errors).toEqual([]);
});

for (const state of ["reserved", "starting", "prunable"] as const) {
  test(`row actions respect ${state} state`, async ({ page }) => {
    const data = dashboardFixture();
    const snapshot = data.projects[0];
    if (state === "starting") { snapshot.runtime.phase = "starting"; snapshot.runtime.worktreePath = "/fixture/web"; }
    if (state === "prunable") snapshot.worktrees[0].prunable = true;
    if (state === "reserved") snapshot.reservation = { id: "lock", projectId: "web", worktreePath: "/fixture/web", kind: "agent", owner: "fixture-agent", reason: null, createdAt: "2026-01-01T00:00:00Z", expiresAt: null, maximumExpiresAt: null };
    const { requests, errors } = await mountDashboard(page, data);
    const row = page.locator("tbody tr");
    await expect(row.getByRole("button", { name: state === "starting" ? "In progress" : "Start", exact: true })).toBeDisabled();
    const rowMenu = row.getByRole("button", { name: "Actions for main in Fixture Web", exact: true });
    await rowMenu.click();
    await expect(page.getByRole("menuitem", { name: "Restart", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Details", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("/fixture/web");
    await page.keyboard.press("Escape");
    await expect(rowMenu).toBeFocused();
    if (state === "reserved") {
      await rowMenu.click();
      await page.getByRole("menuitem", { name: "Force release", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(rowMenu).toBeFocused();
    }
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("a failed runtime reports its location without claiming it is running", async ({ page }) => {
  const data = dashboardFixture();
  const snapshot = data.projects[0];
  snapshot.runtime.phase = "failed";
  snapshot.runtime.worktreePath = snapshot.worktrees[0].path;
  snapshot.runtime.error = "fixture failure";
  await mountDashboard(page, data);

  const card = page.locator('[data-project-id="web"]');
  await expect(card.getByText("Failed", { exact: true })).toHaveCount(1);
  await expect(card.getByText("Running", { exact: true })).toHaveCount(0);
  await expect(card.getByText("No server is running", { exact: true })).toBeVisible();
});

test("an SSE ready event after reconnect reconciles a quiet dashboard", async ({ page }) => {
  await mountDashboard(page);
  await expect(page.locator('[data-project-id="web"]').getByText("Fixture Web", { exact: true })).toBeVisible();
  let bootstraps = 0;
  await page.route("**/api/dashboard", async (route) => {
    bootstraps += 1;
    await route.fulfill({ json: dashboardFixture() });
  });
  await page.evaluate(() => {
    (window as unknown as { fixtureEvents: { disconnect(): void } }).fixtureEvents.disconnect();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureEvents: { active: number } }).fixtureEvents.active)).toBe(1);
  await expect.poll(() => bootstraps).toBe(1);
});

test("stale metadata waits for an explicit refresh", async ({ page }) => {
  const { requests } = await mountDashboard(page);
  await expect(page.locator('[data-project-id="web"]').getByText("Fixture Web", { exact: true })).toBeVisible();
  const stale = dashboardFixture();
  stale.projects[0].metadata = {
    status: "stale",
    lastSuccessfulAt: "2026-01-01T11:59:00.000Z",
    lastAttemptAt: "2026-01-01T11:59:00.000Z",
    retryAt: null,
    error: null,
  };
  let bootstraps = 0;
  await page.route("**/api/dashboard", async (route) => {
    bootstraps += 1;
    await route.fulfill({ json: stale });
  });
  await page.evaluate(() => {
    (window as unknown as { fixtureEvents: { emit(type: string, data: unknown): void } }).fixtureEvents.emit(
      "changed",
      { epoch: "fixture", revision: 3, kinds: ["metadata"], projectIds: ["web"], allProjects: false },
    );
  });
  await expect.poll(() => bootstraps).toBe(1);
  await expect(page.getByText(translate("en", "metadata.stale"), { exact: true })).toHaveCount(0);
  await page.locator("[data-worktree-overview] details summary").click();
  await expect(page.getByText(/^Last successful read:/)).toBeVisible();
  expect(requests.filter(({ path }) => path === "/api/projects/web/metadata/refresh")).toEqual([]);
});

for (const kind of ["bootstrap", "live"] as const) {
  test(`a ${kind} refresh preserves an operation error through connection recovery`, async ({ page }) => {
    const { errors } = await mountDashboard(page);
    await expect(page.locator('[data-project-id="web"]').getByText("Fixture Web", { exact: true })).toBeVisible();
    const operationPath = "**/api/projects/web/operation";
    const message = "Server limit of 2 reached.";
    await page.route(operationPath, route => route.fulfill({ status: 409, json: { error: message } }));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const operationError = page.getByRole("alert").filter({ hasText: message });
    await expect(operationError).toBeVisible();

    let limit = 3;
    let status = 200;
    await page.route(kind === "bootstrap" ? "**/api/dashboard" : "**/api/dashboard/live?*", route => {
      const data = dashboardFixture();
      const capacity = { ...data.capacity, enabled: true, limit, available: limit };
      return route.fulfill({ status, json: status === 200
        ? kind === "bootstrap" ? { ...data, capacity } : { projects: [], capacity }
        : { error: "refresh failed" } });
    });
    let revision = 0;
    const refresh = () => page.evaluate(({ kind, revision }) => {
      (window as unknown as { fixtureEvents: { emit(type: string, data: unknown): void } }).fixtureEvents.emit(
        "changed", { epoch: "fixture", revision, kinds: [kind === "bootstrap" ? "topology" : "controller"], projectIds: [], allProjects: true },
      );
    }, { kind, revision: ++revision });
    const capacity = page.getByRole("button", { name: "Open server capacity" });
    await refresh();
    // The capacity change confirms that React applied the refresh response.
    await expect(capacity).toContainText("0/3");
    await expect(operationError).toBeVisible();

    status = 503;
    await refresh();
    const refreshError = page.getByRole("alert").filter({ hasText: "refresh failed" });
    await expect(refreshError).toBeVisible();
    status = 200; limit = 4;
    await refresh();
    await expect(capacity).toContainText("0/4");
    await expect(refreshError).toBeHidden();
    await expect(operationError).toBeVisible();

    await page.unroute(operationPath);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(operationError).toBeHidden();
    expect(errors).toEqual([]);
  });
}

for (const status of ["stale", "unavailable"] as const) {
  test(`metadata ${status} with a read error remains a warning`, async ({ page }) => {
    const data = dashboardFixture();
    data.projects[0].metadata = {
      status, error: "Git read failed", retryAt: null,
      lastAttemptAt: "2026-01-01T12:00:00.000Z",
      lastSuccessfulAt: status === "unavailable" ? null : "2026-01-01T11:59:00.000Z",
    };
    await mountDashboard(page, data);
    await expect(page.getByRole("alert").filter({ hasText: translate("en", `metadata.${status}`) })).toBeVisible();
  });
}

for (const width of [390, 768, 1440]) {
  test(`long worktree names fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = dashboardFixture();
    data.projects[0].worktrees[0].branch = "feat-dual-region-production-stacks-with-a-very-long-branch-name";
    data.projects[0].worktrees[0].dirty = true;
    data.projects[0].project.repositoryPath = "/home/example/development/a-very-long-repository-directory-name";
    const { errors } = await mountDashboard(page, data);
    await expect(page.locator('[data-project-id="web"]').getByText("Fixture Web", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const menu = page.getByRole("button", { name: /Actions for/ });
    await menu.scrollIntoViewIfNeeded();
    await menu.click();
    await page.getByRole("menuitem", { name: "Details", exact: true }).click();
    await expect(page.getByRole("dialog").locator("dt").filter({ hasText: /^Preset$/ }).locator("+ dd")).toHaveText(translate("en", "preset.node"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(menu).toBeFocused();
    await page.getByText("Project settings", { exact: true }).click();
    const path = page.getByText("Project directory: /home/example/development/a-very-long-repository-directory-name", { exact: true });
    await expect(path).toBeVisible();
    const pathBox = await path.boundingBox();
    expect(pathBox!.x + pathBox!.width).toBeLessThanOrEqual(width - 16);
    await selectLanguage(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/dashboard-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const { width, count } of [{ width: 390, count: 12 }, { width: 1440, count: 12 }, { width: 390, count: 50 }, { width: 1440, count: 50 }]) {
  test(`worktree menu shows multiple rows and selects the last of ${count} worktrees at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = dashboardFixture();
    const initial = data.projects[0].worktrees[0];
    data.projects[0].worktrees = Array.from({ length: count }, (_, index) => ({
      ...initial, path: `${initial.path}-${index}`, branch: `feature-${index}-with-a-long-worktree-name`,
    }));
    data.projects[0].project.selectedWorktreePath = data.projects[0].worktrees[0].path;
    await mountDashboard(page, data);
    if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Tests", exact: true }).click();
    await page.getByRole("button", { name: "Run test", exact: true }).click();
    const trigger = page.getByRole("dialog").getByRole("combobox", { name: "Worktree", exact: true });
    await trigger.click();
    const options = page.getByRole("option");
    await expect(options).toHaveCount(count);
    const viewport = page.locator("[data-radix-select-viewport]");
    const firstBox = await options.first().boundingBox();
    const viewportBox = await viewport.boundingBox();
    expect(viewportBox!.height).toBeGreaterThanOrEqual(firstBox!.height * 3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(options.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(options.last()).toBeFocused();
    await expect(options.last()).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(trigger).toContainText(`feature-${count - 1}-with-a-long-worktree-name`);
    await expect(trigger).toBeFocused();
  });
}

for (const width of [390, 1440]) {
  test(`all projects aggregates metrics and routes row actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = dashboardFixture();
    const first = data.projects[0];
    first.storage = [{ worktreePath: "/fixture/web", status: "available", totalBytes: 1024, nextBytes: 0, nextCacheBytes: 0, nodeModulesBytes: 0, otherBytes: 0, measuredAt: "2026-01-01T00:00:00Z", topDirectories: [], history: [], error: null }];
    const second = structuredClone(first);
    second.project.id = "api";
    second.project.name = "Fixture API";
    second.project.port = 3002;
    second.storage[0].totalBytes = 2048;
    second.runtime.phase = "running";
    second.runtime.worktreePath = "/fixture/web";
    // Shared path and branch deliberately exercise project-qualified identity and actions.
    data.projects.push(second);
    const { requests, errors } = await mountDashboard(page, data);
    const apiRequests: unknown[] = [];
    await page.route("**/api/projects/api/operation", async (route) => {
      apiRequests.push(route.request().postDataJSON());
      await route.fulfill({ json: {} });
    });
    const picker = page.locator('header [role="combobox"]');
    await picker.click();
    await page.getByRole("textbox", { name: "Filter projects" }).press("ArrowDown");
    await expect(page.getByRole("option", { name: /All projects/ })).toBeFocused();
    await page.keyboard.press("Enter");
    const overview = page.locator("[data-all-projects]");
    await expect(picker).toContainText("All projects");
    await expect(overview.getByRole("button", { name: /Disk usage/ })).toContainText("3.0 KiB");
    await expect(overview.getByRole("button", { name: /^Worktrees/ })).toContainText("2");
    await expect(overview.getByRole("button", { name: /^Servers/ })).toContainText("1");
    await expect(overview.locator("tbody tr")).toHaveCount(2);
    const apiRow = overview.locator("tbody tr").filter({ hasText: "Fixture API" });
    await apiRow.getByRole("button", { name: "Actions for main in Fixture API", exact: true }).click();
    await page.getByRole("menuitem", { name: "Restart", exact: true }).click();
    expect(apiRequests).toEqual([{ operation: "restart", worktreePath: "/fixture/web" }]);
    expect(requests).toEqual([]);
    const search = page.getByRole("searchbox", { name: "Search worktrees" });
    await search.fill("Fixture API");
    await expect(overview.locator("tbody tr")).toHaveCount(1);
    await expect(overview.locator("tbody tr")).toContainText("Fixture API");
    await search.fill("");
    await overview.getByRole("button", { name: /^Disk usage/ }).click();
    await expect(overview.locator("tbody tr").first()).toContainText("Fixture API");
    await page.reload();
    await expect(picker).toContainText("All projects");
    await expect(overview.locator("tbody tr")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath("all-projects.png"), fullPage: true });
    if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Tests", exact: true }).click();
    await expect(page.locator("[data-tests-dashboard]")).toBeVisible();
    if (width < 768) await page.locator("[data-tests-dashboard]").getByRole("button", { name: "Filters", exact: true }).click();
    await expect(page.locator("[data-tests-dashboard]").getByRole("combobox", { name: "Project", exact: true })).toBeVisible();
    await picker.click();
    await page.getByRole("option", { name: /Fixture API/ }).click();
    await expect(page.locator("[data-tests-dashboard]")).toBeVisible();
    await expect(page.locator("[data-tests-dashboard]").getByRole("combobox", { name: "Project", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`tests dashboard separates outcomes, filters history and opens details at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = dashboardFixture();
    data.projects[0].testHistoryComplete = true;
    data.projects[0].testRuns = Array.from({ length: 24 }, (_, i) => testRunFixture({ id: `result-${i}`, presetId: `node:test-${i}`, presetName: `test-${i}`, phase: "failed", queuedAt: new Date(Date.now() - i * 60000).toISOString(), error: "Source verification incomplete" }));
    const active = testRunFixture({ id: "active", presetId: "node:hold", presetName: "hold", phase: "running", finishedAt: null });
    data.projects[0].testRuns.push(active);
    const { requests, errors } = await mountDashboard(page, data);
    if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Tests", exact: true }).click();
    const screen = page.locator("[data-tests-dashboard]");
    await expect(screen).toContainText("Full retained history: up to 50 completed attempts per project plus the active queue.");
    await expect(screen.getByRole("button", { name: /^Failed results/ })).toContainText("0");
    await expect(screen.getByRole("button", { name: /^Running\s/ })).toContainText("1");
    await expect(screen.locator('[data-slot="badge"]').filter({ hasText: /^Failed$/ })).toHaveCount(0);
    await expect(screen.locator("[data-operation-target]")).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await screen.getByRole("tab", { name: "History", exact: true }).click();
    const panel = screen.getByRole("tabpanel");
    await expect(panel.locator("tbody tr")).toHaveCount(10);
    const pages = screen.getByRole("navigation", { name: "Test result pages" });
    await pages.getByRole("button", { name: "Next", exact: true }).click();
    await expect(pages).toContainText("2 / 3");
    await screen.getByRole("searchbox", { name: "Search runs", exact: true }).fill("test-11");
    await expect(panel.locator("tbody tr")).toHaveCount(1);
    await expect(pages).toContainText("1 / 1");
    const details = panel.getByRole("button", { name: "Result: test-11 · main", exact: true });
    await details.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toContainText("Passed");
    await expect(drawer).toContainText("Source unverified");
    await expect(drawer).toContainText("At execution:");
    await expect(drawer).toContainText("Now: Unknown");
    await expect(drawer).toContainText("fixture result output");
    await page.screenshot({ path: test.info().outputPath("test-details.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();
    await screen.getByRole("searchbox", { name: "Search runs", exact: true }).fill("");
    if (width < 768) await screen.getByRole("button", { name: /^Filters/ }).click();
    await screen.getByRole("combobox", { name: "Command result", exact: true }).click();
    await page.getByRole("option", { name: "Failed", exact: true }).click();
    await expect(panel).toContainText("No runs match these filters.");
    await screen.getByRole("combobox", { name: "Command result", exact: true }).click();
    await page.getByRole("option", { name: "All", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath("tests-dashboard.png"), fullPage: true, animations: "disabled" });
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("test launch dialog follows the chosen worktree and resets its preset", async ({ page }) => {
  const data = dashboardFixture();
  const snapshot = data.projects[0];
  snapshot.worktrees.push({ ...snapshot.worktrees[0], path: "/fixture/alt", branch: "feature/alt" });
  snapshot.testPresets.push({ worktreePath: "/fixture/alt", presets: [{ ...snapshot.testPresets[0].presets[0], id: "node:check", name: "check" }], error: null });
  const { requests, errors } = await mountDashboard(page, data);
  await page.getByRole("navigation").getByRole("button", { name: "Tests", exact: true }).click();
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Worktree", exact: true }).click();
  await page.getByRole("option", { name: /feature\/alt/ }).click();
  await expect(dialog.getByRole("combobox", { name: "Test preset", exact: true })).toContainText("check");
  await dialog.getByRole("button", { name: "Run test", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests.at(-1)).toEqual({ path: "/api/projects/web/tests", method: "POST", body: { worktreePath: "/fixture/alt", presetId: "node:check" } });
  expect(errors).toEqual([]);
});


test("dashboard history restores each section without duplicate entries", async ({ page }) => {
  await mountDashboard(page);
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  await nav("Tests").click();
  await expect(page).toHaveURL(/view=tests/);
  await nav("Resources").click();
  await nav("Logs").click();
  const historyLength = await page.evaluate(() => window.history.length);
  await nav("Logs").click();
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  await page.goBack(); await expect(nav("Resources")).toHaveAttribute("aria-current", "page");
  await page.goBack(); await expect(nav("Tests")).toHaveAttribute("aria-current", "page");
  await page.goForward(); await expect(nav("Resources")).toHaveAttribute("aria-current", "page");
  await nav("Knowledge").click();
  await page.goBack(); await expect(nav("Resources")).toHaveAttribute("aria-current", "page");
  await page.reload(); await expect(nav("Resources")).toHaveAttribute("aria-current", "page");
});
