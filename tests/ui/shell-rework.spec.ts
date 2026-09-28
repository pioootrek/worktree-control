import { expect, test } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { openPreferences, openSystemDialog, selectLanguage } from "./shell-actions";

test("system settings and project creation return focus to their visible menu triggers", async ({ page }) => {
  const { errors } = await mountDashboard(page);
  const system = page.getByRole("button", { name: "System", exact: true });
  await openSystemDialog(page, "capacity.openSettings");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Server capacity" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(system).toBeFocused();

  await openSystemDialog(page, "tests.openSettings");
  await expect(dialog.getByRole("heading", { name: "Test queue" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(system).toBeFocused();

  await openSystemDialog(page, "mcp.openStatus");
  await expect(dialog.getByRole("heading", { name: "MCP status" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(system).toBeFocused();

  const project = page.getByRole("combobox", { name: "Choose project" });
  await project.click();
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Add repository" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(project).toBeFocused();
  expect(errors).toEqual([]);
});

test("preferences change locale and theme without changing runtime or knowledge scope", async ({ page }) => {
  const { errors } = await mountDashboard(page);
  await openPreferences(page);
  await page.getByRole("menuitem", { name: "Use light theme" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await selectLanguage(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  await expect(page.getByRole("combobox", { name: "Wybierz projekt" })).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Wiedza" }).click();
  await expect(page.getByRole("combobox", { name: "Wybierz projekt" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Wiedza" })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const width of [320, 390]) {
  test(`mobile shell keeps navigation, runtime scope and section visible at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    const data = dashboardFixture();
    data.authentication = { mode: "open", listen: "127.0.0.1:47831" };
    const { errors } = await mountDashboard(page, data, { openMode: true, openWithToken: false });
    const header = page.locator("main > header");
    await expect(header.getByRole("button", { name: "Toggle navigation" })).toBeVisible();
    await expect(header.getByRole("combobox", { name: "Choose project" })).toBeVisible();
    await expect(header.locator("p").getByText("Worktrees", { exact: true })).toBeVisible();
    await expect(page.getByText(/Open mode — no authentication/)).toBeVisible();
    expect((await header.boundingBox())!.height).toBeLessThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}
