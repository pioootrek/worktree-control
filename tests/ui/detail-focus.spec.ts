import { expect, test, type Page } from "@playwright/test";
import { dashboardFixture, mountDashboard, testRunFixture } from "./dashboard-fixture";

async function openSection(page: Page, name: "Tests" | "Resources", width: number) {
  if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
}

for (const width of [390, 1440]) {
  test(`test details return focus after Escape and a breakpoint change from ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const data = dashboardFixture();
    data.projects[0].testRuns = [testRunFixture()];
    await mountDashboard(page, data);
    await openSection(page, "Tests", width);
    const screen = page.locator("[data-tests-dashboard]");
    const details = screen.getByRole("button", { name: "Result: test · main", exact: true });
    if (width === 390) {
      await details.focus();
      await page.keyboard.press("Enter");
    } else {
      await details.click();
    }
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    if (width === 390) await expect(drawer.getByRole("button", { name: "Jump to log" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();

    await details.click();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: 900 });
    const survivingDetails = screen.getByRole("button", { name: "Result: test · main", exact: true });
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(survivingDetails).toBeFocused();
  });

  test(`resource details return focus after Escape and a breakpoint change from ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const data = dashboardFixture();
    data.projects[0].storage = [{ worktreePath: "/fixture/web", status: "available", totalBytes: 1024, nextBytes: 0, nextCacheBytes: 0, nodeModulesBytes: 0, otherBytes: 1024, measuredAt: "2026-01-01T12:00:00.000Z", topDirectories: [], history: [], error: null }];
    await mountDashboard(page, data);
    await openSection(page, "Resources", width);
    const screen = page.locator("[data-resources-dashboard]");
    const details = screen.getByRole("button", { name: "Resources: Fixture Web · main", exact: true });
    await details.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();

    await details.click();
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: width === 390 ? 1440 : 390, height: 900 });
    const survivingDetails = screen.getByRole("button", { name: "Resources: Fixture Web · main", exact: true });
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(survivingDetails).toBeFocused();
  });
}

test("test detail falls back to search when a refresh removes its result", async ({ page }) => {
  const data = dashboardFixture();
  data.projects[0].testRuns = [testRunFixture()];
  await mountDashboard(page, data);
  await openSection(page, "Tests", 1440);
  const screen = page.locator("[data-tests-dashboard]");
  await screen.getByRole("button", { name: "Result: test · main", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  data.projects[0].testRuns = [];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(screen.getByRole("searchbox", { name: "Search runs" })).toBeFocused();
});

test("resource detail falls back to search when a refresh removes its worktree", async ({ page }) => {
  const data = dashboardFixture();
  data.projects[0].storage = [{ worktreePath: "/fixture/web", status: "available", totalBytes: 1024, nextBytes: 0, nextCacheBytes: 0, nodeModulesBytes: 0, otherBytes: 1024, measuredAt: "2026-01-01T12:00:00.000Z", topDirectories: [], history: [], error: null }];
  await mountDashboard(page, data);
  await openSection(page, "Resources", 1440);
  const screen = page.locator("[data-resources-dashboard]");
  await screen.getByRole("button", { name: "Resources: Fixture Web · main", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  data.projects[0].worktrees = [];
  data.projects[0].storage = [];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(screen.getByRole("searchbox", { name: "Search resources" })).toBeFocused();
});

test("test result actions remain visible with the expanded sidebar at 1366px", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 650 });
  const data = dashboardFixture();
  data.projects[0].project.name = "AUDYT: Portal klienta";
  data.projects[0].testRuns = [testRunFixture({ presetName: "test:hold" })];
  await mountDashboard(page, data);
  await page.getByRole("combobox", { name: /Choose project/ }).click();
  await page.getByRole("option", { name: /All projects/ }).click();
  await openSection(page, "Tests", 1366);
  const screen = page.locator("[data-tests-dashboard]");
  const details = screen.locator("[data-test-result]").getByRole("button", { name: "Result: test:hold · main" });
  await expect(details).toBeVisible();
  const bounds = await details.boundingBox();
  const panelBounds = await screen.boundingBox();
  expect(bounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width);
  await details.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("focus reveals the same test result when its desktop button moves offscreen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  const data = dashboardFixture();
  data.projects[0].testRuns = Array.from({ length: 8 }, (_, index) => testRunFixture({
    id: `result-${index}`, presetId: `node:test-${index}`, presetName: index === 7 ? "target" : `test-${index}`,
    queuedAt: new Date(Date.parse("2026-01-01T12:00:00.000Z") - index * 60_000).toISOString(),
  }));
  await mountDashboard(page, data);
  await openSection(page, "Tests", 390);
  const screen = page.locator("[data-tests-dashboard]");
  const mobileDetails = screen.getByRole("button", { name: "Result: target · main", exact: true });
  await mobileDetails.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Jump to log" })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 320 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const backgroundDetails = screen.locator("tbody tr").filter({ hasText: "target" }).locator("button[data-detail-identity]");
  const before = await backgroundDetails.boundingBox();
  expect(before).not.toBeNull();
  expect(before!.y).toBeGreaterThan(320);
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawer).toBeHidden();
  const desktopDetails = screen.getByRole("button", { name: "Result: target · main", exact: true });
  await expect(desktopDetails).toBeFocused();
  const after = await desktopDetails.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.y).toBeGreaterThanOrEqual(0);
  expect(after!.y + after!.height).toBeLessThanOrEqual(320);
});

test("active run opened from History returns focus to History after a breakpoint change", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const data = dashboardFixture();
  data.projects[0].testRuns = [testRunFixture({ phase: "running", presetName: "hold", finishedAt: null, queuePosition: 1 })];
  await mountDashboard(page, data);
  await openSection(page, "Tests", 390);
  const screen = page.locator("[data-tests-dashboard]");
  await screen.getByRole("tab", { name: "History", exact: true }).click();
  const sameRun = screen.getByRole("button", { name: "Result: hold · main", exact: true });
  const historyDetails = screen.getByRole("tabpanel").getByRole("button", { name: "Result: hold · main", exact: true });
  await expect(sameRun).toHaveCount(2);
  await historyDetails.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Jump to log" })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(sameRun).toHaveCount(2);
  await expect(historyDetails).toBeFocused();
  await expect(sameRun.first()).not.toBeFocused();
});
