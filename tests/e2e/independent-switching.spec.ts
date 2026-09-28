import { expect, test } from "@playwright/test";

import { endpointIdentity, startControllerFixture } from "../support/controller-fixture";
import { dashboardWorktreeRow, selectDashboardProject } from "../support/dashboard-actions";

test("the real dashboard switches one project while two others remain live", async ({ page }) => {
  const fixture = await startControllerFixture(3);
  try {
    for (const project of fixture.projects) {
      await fixture.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "start", worktreePath: project.main }) });
    }
    const before = await Promise.all(fixture.projects.map((project) => endpointIdentity(project)));
    await page.goto(fixture.accessUrl);
    await expect(page.locator(`[data-project-id="${fixture.projects[0]!.id}"]`)).toBeVisible();

    await selectDashboardProject(page, "project-a");
    const alternate = dashboardWorktreeRow(page, "project-a", "alternate");
    await alternate.getByRole("button", { name: "Switch here", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Switch here", exact: true }).click();

    const switched = await endpointIdentity(fixture.projects[0]!, "project-a:alternate");
    expect(switched.identity).toBe("project-a:alternate");
    expect(switched.boot).not.toBe(before[0]!.boot);
    expect(await Promise.all(fixture.projects.slice(1).map((project) => endpointIdentity(project)))).toEqual(before.slice(1));
    await expect(alternate.getByRole("button", { name: "Open", exact: true })).toBeVisible();
  } finally {
    await page.close();
    await fixture.close();
  }
});
