import { expect, test } from "@playwright/test";
import { endpointIdentity, endpointUnavailable, startControllerFixture } from "../support/controller-fixture";
import { dashboardWorktreeRow, openDashboardSystemDialog, selectDashboardProject } from "../support/dashboard-actions";

test("the real dashboard enforces, reuses, and lowers server capacity", async ({ page }) => {
  const fixture = await startControllerFixture(3);
  const mainRow = (name: string) => dashboardWorktreeRow(page, name, "main");
  const startProject = async (name: string) => {
    await selectDashboardProject(page, name);
    await mainRow(name).getByRole("button", { name: "Start", exact: true }).click();
  };
  try {
    const [a, b, c] = fixture.projects;
    await page.goto(fixture.accessUrl);

    await openDashboardSystemDialog(page, "Open server capacity");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("switch", { name: "Enable limit" }).click();
    await dialog.getByLabel("Maximum servers").fill("2");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await startProject("project-a");
    await startProject("project-b");
    const before = await Promise.all([endpointIdentity(a!), endpointIdentity(b!)]);
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Open server capacity" })).toContainText("2/2");
    await page.keyboard.press("Escape");
    await expect(page.getByText("project-b: start completed.", { exact: true })).toBeVisible();

    const rejected = page.waitForResponse((response) => response.url().includes(`/api/projects/${c!.id}/operation`));
    await startProject("project-c");
    expect((await rejected).status()).toBe(409);
    await expect(page.getByRole("alert").filter({ hasText: /limit of 2/i })).toBeVisible();
    await endpointUnavailable(c!);
    expect(await Promise.all([endpointIdentity(a!), endpointIdentity(b!)])).toEqual(before);

    await selectDashboardProject(page, "project-a");
    await mainRow("project-a").getByRole("button", { name: "Actions for main in project-a", exact: true }).click();
    await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
    await endpointUnavailable(a!);
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Open server capacity" })).toContainText("1/2");
    await page.keyboard.press("Escape");
    await startProject("project-c");
    await endpointIdentity(c!);

    await openDashboardSystemDialog(page, "Open server capacity");
    await dialog.getByLabel("Maximum servers").fill("1");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "System", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: "Open server capacity" })).toContainText("2/1");
    await page.keyboard.press("Escape");
    await selectDashboardProject(page, "project-b");
    await expect(mainRow("project-b").getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await selectDashboardProject(page, "project-c");
    await expect(mainRow("project-c").getByRole("button", { name: "Open", exact: true })).toBeVisible();
    expect(await endpointIdentity(b!)).toEqual(before[1]);
  } finally {
    await page.close();
    await fixture.close();
  }
});
