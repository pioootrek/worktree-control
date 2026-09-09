import { expect, test } from "@playwright/test";
import { startControllerFixture, type ControllerFixture } from "../support/controller-fixture";

let fixture: ControllerFixture;

test.beforeEach(async ({ page }) => {
  fixture = await startControllerFixture();
  await page.goto(fixture.pairedUrl);
  await expect(page.getByText("alpha", { exact: true })).toBeVisible();
});

test.afterEach(async () => { await fixture.close(); });

test("capacity and switching remain isolated through the real dashboard", async ({ page }) => {
  const [alpha, beta, gamma] = fixture.projects;
  const card = (id: string) => page.locator(`[data-project-id="${id}"]`);

  await page.getByRole("button", { name: "Open server capacity" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: "Enable limit" }).click();
  await dialog.getByLabel("Maximum servers").fill("2");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await card(alpha.id).getByRole("button", { name: "Start", exact: true }).click();
  await expect(card(alpha.id).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await card(beta.id).getByRole("button", { name: "Start", exact: true }).click();
  await expect(card(beta.id).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const betaBefore = await fixture.identity(beta);

  await card(gamma.id).getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /limit of 2|maximum of 2/i })).toBeVisible();
  await expect(card(gamma.id).getByRole("button", { name: "Start", exact: true })).toBeVisible();

  await card(alpha.id).getByRole("combobox", { name: "Active worktree" }).click();
  await page.getByRole("option", { name: /feature/ }).click();
  await card(alpha.id).getByRole("button", { name: "Switch", exact: true }).click();
  await expect.poll(async () => (await fixture.identity(alpha)).marker).toBe("alpha:feature");
  expect(await fixture.identity(beta)).toEqual(betaBefore);

  await card(alpha.id).getByRole("button", { name: "Stop", exact: true }).click();
  await expect(card(alpha.id).getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await card(gamma.id).getByRole("button", { name: "Start", exact: true }).click();
  await expect(card(gamma.id).getByRole("button", { name: "Stop", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open server capacity" }).click();
  await dialog.getByLabel("Maximum servers").fill("1");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card(beta.id).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(card(gamma.id).getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  expect(await fixture.identity(beta)).toEqual(betaBefore);
});
