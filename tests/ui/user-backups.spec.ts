import { expect, test, type Page } from "@playwright/test";
import { mountDashboard } from "./dashboard-fixture";
import { openSystemDialog, selectLanguage } from "./shell-actions";
import type { UserSchedule, UserScheduleOverview } from "../../src/shared/contracts/user-backups";
const token = `wts_00000000-0000-4000-8000-000000000001_${"a".repeat(64)}`;
async function mount(page: Page) {
  await page.addInitScript(token => sessionStorage.setItem("worktree-switcher-knowledge-token", token), token);
  const f = await mountDashboard(page);
  const schedules: UserSchedule[] = [], requests: Array<Record<string, unknown>> = [];
  let missing = false, disconnected = false, forbidden = false, limit = false;
  const overview = (): UserScheduleOverview => ({ policy: { enabled: true, minIntervalSeconds: 60, maxSchedules: 4, maxBytes: 1024 ** 2, timeoutSeconds: 30, queueLimit: 2, retainCount: 10, retainDays: 30 }, projects: [{ id: "project", name: "Discussion project" }], targets: ["local"], schedules, artifacts: [], maintenance: false });
  await page.route("**/api/user-backups", route => {
    if (forbidden) return route.fulfill({ status: 403, json: { code: "forbidden" } });
    if (route.request().method() === "GET") return route.fulfill({ json: overview() });
    const input = route.request().postDataJSON(); requests.push(input);
    if (input.action === "status") return route.fulfill({ status: missing ? 404 : 200, json: missing ? { code: "invalid" } : schedules[0] });
    if (disconnected) { disconnected = false; missing = true; return route.abort("connectionreset"); }
    if (limit) { limit = false; missing = true; return route.fulfill({ status: 409, json: { code: "limit" } }); }
    const schedule: UserSchedule = { ...input.configuration, id: input.id, ownerId: "owner", version: input.version + 1, nextAt: input.configuration.enabled ? "2026-10-02T20:00:00Z" : null, reason: input.configuration.enabled ? null : "disabled", lastResult: { executionId: "00000000-0000-4000-8000-000000000002", scheduleId: input.id, version: 1, dueAt: "2026-10-02T19:00:00Z", state: "interrupted", reason: "interrupted", finishedAt: "2026-10-02T19:01:00Z", artifactAvailable: false }, retention: "idle" };
    const index = schedules.findIndex(value => value.id === input.id); if (index < 0) schedules.push(schedule); else schedules[index] = schedule;
    missing = false; return route.fulfill({ json: schedule });
  });
  return { ...f, requests, disconnect: () => { disconnected = true; }, limit: () => { limit = true; }, deny: () => { forbidden = true; } };
}
for (const locale of ["en", "pl"] as const) {
  const add = locale === "pl" ? "Dodaj harmonogram" : "Add schedule", save = locale === "pl" ? "Zapisz harmonogram" : "Save schedule";
  test(`create/edit/toggle, validation and keyboard in ${locale}`, async ({ page }) => {
    const f = await mount(page); if (locale === "pl") await selectLanguage(page);
    await openSystemDialog(page, "userBackups.title", locale);
    const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: add }).click();
    const interval = dialog.getByRole("spinbutton", { name: locale === "pl" ? "Interwał (sekundy)" : "Interval (seconds)" });
    await interval.fill("59"); await dialog.getByRole("button", { name: save }).click(); expect(f.requests.filter(value => value.action === "save")).toHaveLength(0);
    await interval.fill("60"); await dialog.getByRole("checkbox").focus(); await page.keyboard.press("Space");
    await dialog.getByRole("button", { name: save }).focus(); await page.keyboard.press("Enter");
    await expect(dialog.getByText("Discussion project / local")).toBeVisible();
    const enable = dialog.getByRole("button", { name: locale === "pl" ? "Włącz" : "Enable", exact: true }); await enable.focus(); await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: locale === "pl" ? "Wyłącz" : "Disable", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: locale === "pl" ? "Edytuj harmonogram" : "Edit schedule" }).click();
    await interval.fill("120"); await dialog.getByRole("button", { name: save }).click();
    await expect(dialog.getByText(locale === "pl" ? "Co 120 s" : "Every 120 s", { exact: false })).toBeVisible();
    const writes = f.requests.filter(value => value.action === "save"); expect(writes.map(value => value.version)).toEqual([0, 1, 2]);
    expect(writes.every(value => !Object.hasOwn(value, "ownerId") && !Object.hasOwn(value, "directory"))).toBe(true);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "System", exact: true })).toBeFocused(); expect(f.errors).toEqual([]);
  });
  for (const failure of ["disconnect", "limit"] as const) test(`same-key retry after ${failure}, missing receipt and reload in ${locale}`, async ({ page }) => {
    const f = await mount(page); if (locale === "pl") await selectLanguage(page); await openSystemDialog(page, "userBackups.title", locale);
    await page.getByRole("button", { name: add }).click(); f[failure](); await page.getByRole("button", { name: save }).click();
    await expect(page.getByRole("alert")).toBeVisible(); const original = f.requests.find(value => value.action === "save")!;
    await page.keyboard.press("Escape"); await page.reload(); await openSystemDialog(page, "userBackups.title", locale);
    const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("button", { name: add })).toBeEnabled(); await expect(dialog.getByRole("alert")).toBeVisible();
    const retry = dialog.getByRole("button", { name: locale === "pl" ? "Ponów to samo zlecenie" : "Retry the same request" }); await retry.click();
    await expect(dialog.getByText("Discussion project / local")).toBeVisible();
    expect(f.requests.filter(value => value.action === "save").map(value => value.idempotencyKey)).toEqual([original.idempotencyKey, original.idempotencyKey]);
    f.deny(); await dialog.getByRole("button", { name: locale === "pl" ? "Odśwież status" : "Refresh status" }).click();
    await expect(dialog.getByText("Discussion project / local")).toHaveCount(0); await expect(dialog.getByRole("button", { name: add })).toHaveCount(0);
    expect(f.errors).toEqual([]);
  });
  for (const width of [1440, 1366, 390, 320]) test(`layout ${width}px in ${locale}`, async ({ page }, testInfo) => {
    await page.addInitScript(theme => localStorage.setItem("worktree-switcher-theme", theme), width === 320 || width === 1366 ? "light" : "dark");
    await page.setViewportSize({ width, height: 650 }); await mount(page); if (locale === "pl") await selectLanguage(page);
    await openSystemDialog(page, "userBackups.title", locale); await page.getByRole("button", { name: add }).click();
    const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("button", { name: save })).toBeVisible();
    expect(await page.locator("html").evaluate(element => element.classList.contains("dark"))).toBe(width !== 320 && width !== 1366);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`s4u-${locale}-${width}.png`) });
  });
}
test("installation session remains separate from a connected schedule credential", async ({ page }) => {
  const installation = `wsi_00000000-0000-4000-8000-000000000003_${"b".repeat(64)}`;
  const f = await mountDashboard(page, undefined, { accessToken: installation });
  const authorization: string[] = [];
  await page.route("**/api/user-backups", route => {
    authorization.push(route.request().headers().authorization);
    return route.fulfill({ json: { policy: { enabled: false, minIntervalSeconds: 60, maxSchedules: 4, maxBytes: 1024 ** 2, timeoutSeconds: 30, queueLimit: 2, retainCount: 10, retainDays: 30 }, projects: [], targets: [], schedules: [], artifacts: [], maintenance: false } });
  });
  await openSystemDialog(page, "userBackups.title");
  await page.getByLabel("Scoped credential", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect schedules" }).click();
  await expect(page.getByRole("dialog").getByText("Schedules are unavailable or this schedule is disabled. Copies remain.")).toBeVisible();
  expect(authorization).toEqual([`Bearer ${token}`]);
  await page.keyboard.press("Escape"); await openSystemDialog(page, "userBackups.title");
  await expect(page.getByRole("button", { name: "Change schedule credential" })).toBeVisible();
  await page.getByRole("button", { name: "Change schedule credential" }).click();
  await expect(page.getByLabel("Scoped credential", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.getByRole("menuitem").filter({ hasText: "Installation backups" })).toBeVisible(); expect(f.errors).toEqual([]);
});
