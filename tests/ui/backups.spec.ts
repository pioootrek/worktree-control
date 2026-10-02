import { expect, test, type Page } from "@playwright/test";
import { mountDashboard } from "./dashboard-fixture";
import { openSystemDialog, selectLanguage } from "./shell-actions";
import type { BackupOverview } from "../../src/shared/contracts/backups";
const token = `wsi_00000000-0000-4000-8000-000000000001_${"a".repeat(64)}`;
const id = "backup-00000000-0000-4000-8000-000000000002";
function overview(): BackupOverview { return {
  policy: { destinationConfigured: true, intervalSeconds: null, retainCount: 30, retainDays: 30, maxBytes: 1024 ** 3, timeoutSeconds: 300, queueLimit: 4, uiActions: ["create", "restore"] },
  schedule: { nextAt: null, lastOperation: null, error: null, retention: "idle" }, maintenance: false, operations: [],
  copies: [{ id, createdAt: "2026-10-01T00:00:00Z", sizeBytes: 100000, compatibility: "supported", verification: "verified", protected: true }],
}; }
async function mount(page: Page, copies = overview().copies) {
  const fixture = await mountDashboard(page, undefined, { accessToken: token });
  let denied = false, loseConnection = false, rejectCreate = false, missingReceipt = false, statusDenial = false;
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/backups", route => {
    if (denied) return route.fulfill({ status: 403, json: { code: "backup_forbidden" } });
    if (route.request().method() === "GET") return route.fulfill({ json: { ...overview(), copies } });
    const input = route.request().postDataJSON(); requests.push(input);
    if (input.action === "status" && statusDenial) return route.fulfill({ status: 403, json: { code: "backup_invalid" } });
    if (input.action === "status" && missingReceipt) return route.fulfill({ status: 404, json: { code: "backup_invalid" } });
    if (input.action === "create" && rejectCreate) { rejectCreate = false; missingReceipt = true; return route.fulfill({ status: 409, json: { code: "backup_limit" } }); }
    if (input.action === "preview") return route.fulfill({ json: { backup: overview().copies[0], scope: "entire-installation", invalidatesScopedCredentials: true, stopsManagedProcessesAndTests: true } });
    if (loseConnection && input.action !== "status") { loseConnection = false; missingReceipt = true; return route.abort("connectionreset"); }
    if (input.action === "create") missingReceipt = false;
    return route.fulfill({ status: 202, json: { operationId: "request-one", backupId: id, state: input.action === "status" ? "verified" : "requested", createdAt: "2026-10-01T00:00:00Z" } });
  });
  return { ...fixture, requests, deny: () => { denied = true; }, denyStatus: () => { statusDenial = true; }, disconnect: () => { loseConnection = true; }, rejectCreate: () => { rejectCreate = true; } };
}
for (const locale of ["en", "pl"] as const) for (const failure of ["limit", "disconnect"] as const) test(`pre-admission ${failure} retains catalog and explicit retry after reopen and reload in ${locale}`, async ({ page }) => {
  const f = await mount(page);
  if (locale === "pl") await selectLanguage(page);
  await openSystemDialog(page, "backups.title", locale);
  const createName = locale === "pl" ? "Utwórz teraz" : "Create now";
  const retryName = locale === "pl" ? "Ponów to samo zlecenie" : "Retry the same request";
  if (failure === "limit") f.rejectCreate(); else f.disconnect();
  await page.getByRole("button", { name: createName, exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const original = f.requests.find(input => input.action === "create")!;
  for (const reload of [false, true]) {
    await page.keyboard.press("Escape");
    if (reload) await page.reload();
    await openSystemDialog(page, "backups.title", locale);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(id, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: createName, exact: true })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: retryName, exact: true })).toBeEnabled();
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button", { name: locale === "pl" ? "Odśwież status" : "Refresh status", exact: true }).click();
    await expect(dialog.getByText(id, { exact: true })).toBeVisible();
    expect(f.requests.filter(input => input.action === "create")).toHaveLength(1);
  }
  await page.getByRole("button", { name: retryName, exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toBeVisible();
  expect(f.requests.filter(input => input.action === "create").map(input => input.idempotencyKey)).toEqual([original.idempotencyKey, original.idempotencyKey]);
});
test("status authorization loss clears catalog even when its error code matches a missing receipt", async ({ page }) => {
  const f = await mount(page); await openSystemDialog(page, "backups.title");
  f.rejectCreate(); await page.getByRole("button", { name: "Create now", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  f.denyStatus(); await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("operator authority");
  await expect(dialog.getByText(id, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create now", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Retry the same request", exact: true })).toHaveCount(0);
});
for (const locale of ["en", "pl"] as const) {
  test(`migration backup verification states are distinct in ${locale}`, async ({ page }) => {
    const migration = { ...overview().copies[0], id: "pre-migration-v1-00000000-0000-4000-8000-000000000003", verification: "unverified" as const };
    const failed = { ...overview().copies[0], id: "backup-00000000-0000-4000-8000-000000000004", verification: "failed" as const };
    await mount(page, [migration, failed]);
    if (locale === "pl") await selectLanguage(page);
    await openSystemDialog(page, "backups.title", locale);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(locale === "pl" ? /Brak zapisanego wyniku weryfikacji/ : /No stored verification result/)).toBeVisible();
    await expect(dialog.getByText(locale === "pl" ? /Weryfikacja nieudana/ : /Verification failed/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: `${locale === "pl" ? "Odtwórz" : "Restore"} ${migration.id}`, exact: true })).toBeEnabled();
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  });
  test(`operator backup policy, loss confirmation and keyboard in ${locale}`, async ({ page }) => {
    const f = await mount(page);
    if (locale === "pl") await selectLanguage(page);
    await openSystemDialog(page, "backups.title", locale);
    const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
    await expect(dialog.getByText(locale === "pl" ? "Wyłączony" : "Disabled", { exact: true })).toBeVisible();
    expect(await dialog.locator("input:not([type=checkbox])").count()).toBe(0);
    await dialog.getByRole("button", { name: `${locale === "pl" ? "Odtwórz" : "Restore"} ${id}`, exact: true }).click();
    const confirm = dialog.getByRole("button", { name: locale === "pl" ? "Potwierdzam odtworzenie instalacji" : "Confirm installation restore" });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("checkbox").focus(); await page.keyboard.press("Space");
    await expect(confirm).toBeEnabled(); await confirm.focus(); await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toContainText(locale === "pl" ? "Przyjęta" : "Accepted");
    const restore = f.requests.find(input => input.action === "restore")!;
    expect(Object.keys(restore).sort()).toEqual(["action", "backupId", "confirmation", "idempotencyKey"]);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: locale === "pl" ? "System" : "System", exact: true })).toBeFocused();
    expect(f.errors).toEqual([]);
  });
}
test("lost response and reload retain the same request key, refresh reauthorizes and clears forbidden data", async ({ page }) => {
  const f = await mount(page); await openSystemDialog(page, "backups.title");
  f.disconnect(); await page.getByRole("button", { name: "Create now", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Connection lost");
  await page.getByRole("button", { name: "Retry the same request", exact: true }).click();
  const keys = f.requests.filter(request => request.action === "create").map(request => request.idempotencyKey);
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  await page.keyboard.press("Escape"); await openSystemDialog(page, "backups.title");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Restored and verified");
  expect(f.requests.find(request => request.action === "status")?.idempotencyKey).toBe(keys[0]);
  f.deny(); await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("operator authority");
  await expect(page.getByText(id, { exact: true })).toHaveCount(0);
});
test("operator backup list fits mobile", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 }); await mount(page);
  await openSystemDialog(page, "backups.title");
  await expect(page.getByText(id, { exact: true })).toBeVisible();
  const overflow = await page.getByRole("dialog").evaluate(element => element.scrollWidth > element.clientWidth); expect(overflow).toBe(false);
  await page.keyboard.press("Escape");
});
for (const openMode of [false, true]) test(`${openMode ? "open" : "legacy"} session has no installation-backup menu`, async ({ page }) => {
  await mountDashboard(page, undefined, { openMode });
  await page.getByRole("button", { name: "System", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Installation backups" })).toHaveCount(0);
});
test("backup dialogs remain usable across widths, short screens and both themes", async ({ page }) => {
  await mount(page);
  for (const [width, height, theme] of [[1440, 1000, "dark"], [1366, 650, "light"], [390, 844, "dark"], [320, 320, "light"]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    await openSystemDialog(page, "backups.title");
    const dialog = page.getByRole("dialog");
    expect(await dialog.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
    await dialog.getByRole("button", { name: `Restore ${id}`, exact: true }).click();
    await expect(dialog.getByRole("region")).toBeFocused();
    await page.keyboard.press("Tab"); await expect(dialog.getByRole("checkbox")).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`backups-${width}-${height}-${theme}.png`), animations: "disabled" });
    await page.keyboard.press("Escape");
  }
});
