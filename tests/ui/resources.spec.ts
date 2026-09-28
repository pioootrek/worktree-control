import { expect, test } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

function fixture() {
  const data = dashboardFixture();
  const snapshot = data.projects[0];
  const initial = snapshot.worktrees[0];
  snapshot.worktrees = Array.from({ length: 12 }, (_, index) => ({ ...initial, path: `/fixture/worktree-${index}`, branch: `feature-${index}` }));
  snapshot.storage = snapshot.worktrees.slice(0, 11).map((w, index) => ({ worktreePath: w.path, status: "available", totalBytes: (index + 1) * 1024 ** 3, nextBytes: index * 1024 ** 2, nextCacheBytes: 0, nodeModulesBytes: 0, otherBytes: 0, measuredAt: "2026-09-13T12:00:00Z", topDirectories: [{ name: "node_modules", bytes: 1000 }], history: [], error: null }));
  const second = structuredClone(snapshot);
  second.project.id = "api"; second.project.name = "Fixture API";
  second.worktrees = [snapshot.worktrees[0]];
  second.storage = [{ ...snapshot.storage[0], totalBytes: 20 * 1024 ** 3 }];
  data.projects.push(second);
  return data;
}

for (const width of [390, 1440]) {
  test(`resources aggregate, sort, filter and paginate at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = fixture();
    const { requests, errors } = await mountDashboard(page, data);
    await page.getByRole("combobox", { name: /Choose project/ }).click();
    await page.getByRole("option", { name: /All projects/ }).click();
    if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
    const screen = page.locator("[data-resources-dashboard]");
    await expect(screen.getByText("No server is running.", { exact: true })).toBeVisible();
    await expect(screen.getByText("Measured 12 of 13 worktrees", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", { name: /^Disk usage/ })).toContainText("86.0 GiB");
    const panel = screen.getByRole("tabpanel");
    await expect(panel.locator("tbody tr")).toHaveCount(10);
    await expect(panel.locator("tbody tr").first()).toContainText("Fixture API");
    if (width === 390) {
      await expect(panel.locator("[data-resource-row]").first()).toContainText("Fixture API");
      await expect(panel.locator("[data-resource-row]").first().getByRole("button", { name: /Resources:/ })).toBeVisible();
      await expect(screen.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    }
    const pagination = screen.getByRole("navigation", { name: "Resource pages" });
    await pagination.getByRole("button", { name: "Next", exact: true }).click();
    await expect(panel.locator("tbody tr")).toHaveCount(3);
    await screen.getByRole("searchbox", { name: "Search resources" }).fill("worktree-11");
    await expect(panel.locator("tbody tr")).toHaveCount(1);
    await expect(panel).toContainText("Not measured");
    await expect(pagination).toContainText("1 / 1");
    await screen.getByRole("searchbox").fill("");
    await screen.getByRole("button", { name: /^RAM now/ }).click();
    await expect(panel.locator("tbody tr")).toHaveCount(2);
    await expect(panel).toContainText("Stopped");
    await screen.getByRole("button", { name: /^Disk usage/ }).click();
    await expect(screen.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await expect(screen.getByRole("combobox", { name: "Worktree", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath("resources.png"), fullPage: true, animations: "disabled" });
    if (width === 390) {
      await selectLanguage(page);
      await expect(screen.getByRole("tab", { name: /^Dysk/ })).toBeVisible();
      await expect(screen.getByRole("searchbox", { name: "Szukaj zasobów" })).toBeVisible();
    }
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("resource details keep cleanup on the chosen project and block active worktrees", async ({ page }) => {
  const data = fixture();
  data.projects[0].runtime.phase = "running";
  data.projects[0].runtime.worktreePath = "/fixture/worktree-0";
  const { errors } = await mountDashboard(page, data);
  const mutations: unknown[] = [];
  await page.route("**/api/projects/api/storage/cache", async (route) => {
    mutations.push({ method: route.request().method(), body: route.request().postDataJSON() });
    await route.fulfill({ json: {} });
  });
  await page.route("**/api/projects/api/storage/refresh", (route) => route.fulfill({ status: 503, json: { error: "Measurement fixture unavailable" } }));
  await page.getByRole("combobox", { name: /Choose project/ }).click();
  await page.getByRole("option", { name: /All projects/ }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
  const screen = page.locator("[data-resources-dashboard]");
  await screen.getByRole("searchbox").fill("worktree-0");
  await screen.getByRole("button", { name: "Resources: Fixture Web · feature-0", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("button", { name: "Delete .next", exact: true })).toBeDisabled();
  await expect(drawer).toContainText("Stop this worktree's server before deleting .next.");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  const target = screen.getByRole("button", { name: "Resources: Fixture API · feature-0", exact: true });
  await target.click();
  await drawer.getByRole("button", { name: "Refresh measurement", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Measurement fixture unavailable");
  await drawer.getByRole("button", { name: "Delete .next", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("/fixture/worktree-0");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(mutations).toEqual([]);
  await drawer.getByRole("button", { name: "Delete .next", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete .next", exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(mutations).toEqual([{ method: "DELETE", body: { worktreePath: "/fixture/worktree-0", cache: "next" } }]);
  await page.screenshot({ path: test.info().outputPath("resource-details.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(target).toBeFocused();
  expect(errors).toEqual([]);
});

test("a single storage sample shows its values and a visible chart point", async ({ page }) => {
  const data = fixture();
  data.projects[0].storage[0].history = [{ measuredAt: "2026-09-13T12:00:00Z", totalBytes: 1024 ** 3, nextBytes: 256 * 1024 ** 2, nextCacheBytes: 0, nodeModulesBytes: 0 }];
  await mountDashboard(page, data);
  await page.getByRole("navigation").getByRole("button", { name: "Resources" }).click();
  await page.getByRole("button", { name: "Resources: Fixture Web · feature-0" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText("First measurement; the trend will appear after another sample.");
  await expect(drawer.locator("svg[role=img] circle")).toHaveCount(2);
  await expect(drawer.locator(".sr-only li")).toContainText("Total 1.0 GiB, .next 256 MiB");
});
