import { expect, test } from "@playwright/test";
import { mountDashboard } from "./dashboard-fixture";

const INSTALLATION_TOKEN = `wsi_11111111-1111-4111-8111-111111111111_${"a".repeat(64)}`;

test("signs in with the installation token once for the dashboard and knowledge", async ({ page }) => {
  // Routes registered after the fixture take precedence over its catch-all API handler.
  const f = await mountDashboard(page, undefined, { accessToken: INSTALLATION_TOKEN, openWithToken: false });
  const identityHeaders: string[] = [];
  await page.route("**/api/identity", route => {
    identityHeaders.push(route.request().headers().authorization ?? "");
    return route.fulfill({ json: { principal: { id: "installation", kind: "installation", status: "active" }, credential: null, knowledgeGrants: [], installationAuthority: true } });
  });
  await page.route("**/api/knowledge", route => {
    const { operation } = route.request().postDataJSON();
    const project = { id: "shared", name: "Shared knowledge", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    if (operation === "projects") return route.fulfill({ json: { items: [project], nextOffset: null } });
    if (operation === "project") return route.fulfill({ json: project });
    return route.fulfill({ json: { items: [], nextOffset: null, total: 0, counts: { active: 0, now: 0, next: 0, blocked: 0, done: 0, all: 0 } } });
  });

  await expect(page.getByRole("heading", { name: "Sign in to Worktree Switcher" })).toBeVisible();
  await page.getByLabel("Access token", { exact: true }).fill(`${INSTALLATION_TOKEN.slice(0, -1)}b`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("The token is invalid or has been rotated.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("worktree-switcher-token"))).toBeNull();

  await page.getByLabel("Access token", { exact: true }).fill(INSTALLATION_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Fixture Web").first()).toBeVisible();

  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  await expect(page.getByRole("button", { name: "Sign in to knowledge", exact: true })).toHaveCount(0);
  expect(identityHeaders.every(header => header === `Bearer ${INSTALLATION_TOKEN}`)).toBe(true);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Switcher" })).toBeVisible();
  expect(await page.evaluate(() => [sessionStorage.getItem("worktree-switcher-token"), sessionStorage.getItem("worktree-switcher-knowledge-token")])).toEqual([null, null]);
  expect(f.errors).toEqual([]);
});
