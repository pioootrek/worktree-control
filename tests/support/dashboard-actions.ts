import type { Page } from "@playwright/test";

export async function selectDashboardProject(page: Page, projectName: string) {
  const switcher = page.getByRole("combobox", { name: /Choose project/ });
  await switcher.click();
  await page.getByRole("textbox", { name: "Filter projects…" }).fill(projectName);
  await page.getByRole("option").filter({ hasText: projectName }).click();
  return page.locator(`[data-project-id]`).filter({ hasText: projectName });
}

export function dashboardWorktreeRow(page: Page, projectName: string, branch: string) {
  return page.locator("[data-worktree-row]").filter({
    has: page.getByRole("button", { name: `Actions for ${branch} in ${projectName}`, exact: true }),
  });
}

export async function openDashboardSystemDialog(page: Page, label: "Open server capacity" | "Open test queue settings") {
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: label }).click();
}
