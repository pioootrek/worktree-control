import { expect, test } from "@playwright/test";

import { startControllerFixture } from "../support/controller-fixture";
import { openDashboardSystemDialog, selectDashboardProject } from "../support/dashboard-actions";

test("the real dashboard configures, queues, cancels, and retains managed test results", async ({ page }) => {
  const fixture = await startControllerFixture(2);
  try {
    const [a] = fixture.projects;
    await page.goto(fixture.accessUrl);
    await openDashboardSystemDialog(page, "Open test queue settings");
    const settings = page.getByRole("dialog");
    await settings.getByLabel("Maximum parallel tests").fill("1");
    await settings.getByRole("button", { name: "Save", exact: true }).click();

    const screen = page.locator("[data-tests-dashboard]");
    const launch = async (preset: string) => {
      await screen.getByRole("button", { name: "Run test", exact: true }).click();
      const form = page.getByRole("dialog");
      await form.getByRole("combobox", { name: "Worktree", exact: true }).click();
      await page.getByRole("option", { name: /^main ·/ }).click();
      await form.getByLabel("Test preset", { exact: true }).click();
      await page.getByRole("option", { name: `${preset} · node`, exact: true }).click();
      await form.getByRole("button", { name: "Run test", exact: true }).click();
      await expect(form).toBeHidden();
    };
    await selectDashboardProject(page, "project-a");
    await page.getByRole("navigation").getByRole("button", { name: "Tests", exact: true }).click();
    await launch("test:hold");
    await expect(screen.locator("tbody tr").filter({ hasText: "test:hold" }).first()).toContainText("Running");
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Open test queue settings" })).toContainText("1/1");
    await page.keyboard.press("Escape");

    await selectDashboardProject(page, "project-b");
    await launch("test:hold");
    await expect(screen.getByText("Queue position: 1", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Open test queue settings" })).toContainText("+1");
    await page.keyboard.press("Escape");
    await screen.getByRole("button", { name: "Cancel test", exact: true }).click();
    await expect(screen.getByRole("button", { name: "Cancel test", exact: true })).toHaveCount(0);
    await screen.getByRole("tab", { name: "History", exact: true }).click();
    await expect(screen.getByRole("tabpanel").locator("tbody tr").filter({ hasText: "test:hold" })).toContainText("Cancelled");

    await fixture.releaseTestGate(a!);
    await selectDashboardProject(page, "project-a");
    const hold = screen.getByRole("tabpanel").locator("tbody tr").filter({ hasText: "test:hold" });
    await expect(hold).toContainText("Passed", { timeout: 15_000 });
    await hold.getByRole("button", { name: "Result: test:hold · main", exact: true }).click();
    const details = page.getByRole("dialog");
    await expect(details.locator("pre").first()).toContainText("verification project-a:main hold");
    await expect(details).toContainText("Source matched at observation points");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Open test queue settings" })).toContainText("0/1");
    await page.keyboard.press("Escape");

    await launch("test:fail");
    const failed = screen.getByRole("tabpanel").locator("tbody tr").filter({ hasText: "test:fail" });
    await expect(failed).toContainText("Failed");
    await failed.getByRole("button", { name: "Result: test:fail · main", exact: true }).click();
    await expect(details).toContainText("The test process exited with code 9.");
  } finally {
    await page.close();
    await fixture.close();
  }
});
