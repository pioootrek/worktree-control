import { expect, test } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { openPreferences } from "./shell-actions";

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

  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toBeVisible();
  await page.getByLabel("Access token", { exact: true }).fill(`${INSTALLATION_TOKEN.slice(0, -1)}b`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("The token is invalid or has been rotated.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("worktree-control-token"))).toBeNull();

  await page.getByLabel("Access token", { exact: true }).fill(INSTALLATION_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Fixture Web").first()).toBeVisible();

  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  await expect(page.getByRole("button", { name: "Sign in to knowledge", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out of knowledge" })).toHaveCount(0);
  expect(identityHeaders.every(header => header === `Bearer ${INSTALLATION_TOKEN}`)).toBe(true);

  await openPreferences(page);
  await expect(page.getByRole("menuitem", { name: "Disconnect Knowledge access" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toBeVisible();
  expect(await page.evaluate(() => [sessionStorage.getItem("worktree-control-token"), sessionStorage.getItem("worktree-control-knowledge-token")])).toEqual([null, null]);
  expect(f.errors).toEqual([]);
});

test("open mode needs no sign-in and shows that authentication is off", async ({ page }) => {
  const data = dashboardFixture();
  data.authentication = { mode: "open", listen: "0.0.0.0:47831" };
  const f = await mountDashboard(page, data, { openMode: true, openWithToken: false });
  let denied = false;
  await page.route("**/api/identity", route => denied
    ? route.fulfill({ status: 401, json: { code: "invalid_credential", error: "Denied" } })
    : route.fulfill({ json: { principal: { id: "installation", kind: "installation", status: "active" }, credential: null, knowledgeGrants: [], installationAuthority: true } }));
  await page.route("**/api/knowledge", route => {
    const project = { id: "shared", name: "Shared knowledge", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const { operation } = route.request().postDataJSON();
    if (operation === "projects") return route.fulfill({ json: { items: [project], nextOffset: null } });
    if (operation === "project") return route.fulfill({ json: project });
    return route.fulfill({ json: { items: [], nextOffset: null, total: 0, counts: { active: 0, now: 0, next: 0, blocked: 0, done: 0, all: 0 } } });
  });

  await expect(page.getByText("Open mode — no authentication (0.0.0.0:47831)")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Worktree Control" })).toHaveCount(0);
  await openPreferences(page);
  await expect(page.getByRole("menuitem", { name: "Sign out", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Disconnect Knowledge access" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  denied = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Could not access Knowledge in the current open session.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Knowledge credential", { exact: true })).toHaveCount(0);
  denied = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  expect(await page.evaluate(() => sessionStorage.getItem("worktree-control-token"))).toBeNull();
  expect(f.errors).toEqual([]);
});

test("rejected shared Knowledge access keeps the Worktree Control session and offers retry", async ({ page }) => {
  const f = await mountDashboard(page, undefined, { accessToken: INSTALLATION_TOKEN, openWithToken: false });
  let denied = true;
  await page.route("**/api/identity", route => denied
    ? route.fulfill({ status: 403, json: { code: "forbidden", error: "Denied" } })
    : route.fulfill({ json: { principal: { id: "installation", kind: "installation", status: "active" }, credential: null, knowledgeGrants: [], installationAuthority: true } }));
  await page.route("**/api/knowledge", route => {
    const project = { id: "shared", name: "Shared knowledge", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    const { operation } = route.request().postDataJSON();
    if (operation === "projects") return route.fulfill({ json: { items: [project], nextOffset: null } });
    if (operation === "project") return route.fulfill({ json: project });
    return route.fulfill({ json: { items: [], nextOffset: null, total: 0, counts: { active: 0, now: 0, next: 0, blocked: 0, done: 0, all: 0 } } });
  });
  await page.getByLabel("Access token", { exact: true }).fill(INSTALLATION_TOKEN);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await expect(page.getByText("Knowledge rejected the current Worktree Control session.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Knowledge credential", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("worktree-control-token"))).toBe(INSTALLATION_TOKEN);
  await openPreferences(page);
  await expect(page.getByRole("menuitem", { name: "Sign out", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Disconnect Knowledge access" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  denied = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue("shared");
  expect(f.errors).toEqual([]);
});
