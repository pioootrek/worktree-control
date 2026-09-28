import { expect, test } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";

async function selectAllProjects(page: import("@playwright/test").Page) {
  const picker = page.locator('header [role="combobox"]');
  await picker.click();
  await page.getByRole("textbox", { name: "Filter projects" }).press("ArrowDown");
  await page.keyboard.press("Enter");
}

test("aggregate worktree actions fit the desktop work area", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const data = dashboardFixture();
  const second = structuredClone(data.projects[0]);
  second.project.id = "api";
  second.project.name = "API integration project with a long but readable name";
  second.worktrees[0].branch = "feature/integration-with-a-very-long-branch-name";
  data.projects.push(second);
  await mountDashboard(page, data);
  await selectAllProjects(page);

  const overview = page.locator("[data-all-projects]");
  const row = overview.locator("[data-worktree-row]").filter({ hasText: second.project.name });
  const action = row.getByRole("button", { name: "Start", exact: true });
  await expect(row).toContainText(second.worktrees[0].branch);
  await expect(action).toBeVisible();
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  expect(await page.evaluate(() => document.querySelector('[data-all-projects] [data-slot="table-container"]')!.scrollWidth > document.querySelector('[data-all-projects] [data-slot="table-container"]')!.clientWidth)).toBe(false);
});

for (const width of [320, 390]) {
  test(`mobile worktree shows full identity, state and action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const data = dashboardFixture();
    const first = data.projects[0];
    first.project.name = "Long project identity for integration checks";
    first.worktrees[0].branch = "feature/long-branch-name-that-must-stay-readable-on-a-phone";
    first.worktrees[0].dirty = true;
    await mountDashboard(page, data);
    await selectAllProjects(page);

    const row = page.locator("[data-all-projects] [data-worktree-row]");
    await expect(page.locator("[data-all-projects]").getByRole("columnheader", { name: "Project and branch" })).toHaveCount(1);
    const action = row.getByRole("button", { name: "Start", exact: true });
    await expect(row).toContainText(first.project.name);
    await expect(row).toContainText(first.worktrees[0].branch);
    await expect(row).toContainText("Stopped");
    await expect(row).toContainText("Dirty");
    await expect(action).toBeVisible();
    const bounds = await action.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Details" }).click();
    await expect(page.getByRole("dialog")).toContainText(first.worktrees[0].head);
    await expect(page.getByRole("dialog")).toContainText(first.worktrees[0].path);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("combobox", { name: "Show", exact: true }).click();
    await page.getByRole("option", { name: "Active server", exact: true }).click();
    await expect(page.getByText("Active filter: Active server")).toBeVisible();
    await expect(page.getByText("No matching worktrees.")).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(row).toBeVisible();
  });
}

test("aggregate server disclosure includes transitions without calling them running", async ({ page }) => {
  const data = dashboardFixture();
  data.projects[0].runtime.phase = "starting";
  data.projects[0].runtime.worktreePath = data.projects[0].worktrees[0].path;
  await mountDashboard(page, data);
  await selectAllProjects(page);
  const overview = page.locator("[data-all-projects]");
  await expect(overview.getByText("Servers running or changing state: 1")).toBeVisible();
  await expect(overview.locator("[data-worktree-row]")).toContainText("Starting");
});

test("a failed startup belongs to its attempted worktree and a foreign claim blocks actions", async ({ page }) => {
  const data = dashboardFixture();
  const snapshot = data.projects[0];
  snapshot.worktrees.push({ ...snapshot.worktrees[0], path: "/fixture/alternate", branch: "feature/alternate" });
  snapshot.runtime.phase = "failed";
  snapshot.runtime.worktreePath = "/fixture/alternate";
  snapshot.runtime.error = "fixture startup failed";
  snapshot.reservation = { id: "claim", projectId: "web", worktreePath: "/fixture/alternate", kind: "agent", owner: "automation-owner-with-long-id", reason: "integration work", createdAt: "2026-01-01T00:00:00Z", expiresAt: null, maximumExpiresAt: null };
  const { requests } = await mountDashboard(page, data);
  const rows = page.locator("[data-worktree-overview] [data-worktree-row]");
  await expect(rows.filter({ hasText: "main" })).toContainText("Stopped");
  await expect(rows.filter({ hasText: "main" })).not.toContainText("Failed");
  const failed = rows.filter({ hasText: "feature/alternate" });
  await expect(failed).toContainText("Failed");
  await expect(failed.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expect(page.getByText("Project reserved · server operations are blocked")).toBeVisible();
  await expect(page.getByText("Locked by automation-owner-with-long-id")).toBeHidden();
  await page.getByText("Owner and reservation details").click();
  await expect(page.getByText("Locked by automation-owner-with-long-id")).toBeVisible();
  expect(requests).toEqual([]);
});
