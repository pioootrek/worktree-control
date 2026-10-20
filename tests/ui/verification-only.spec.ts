import { expect, test } from "@playwright/test";
import { translate, type Locale } from "../../src/i18n/messages";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

for (const locale of ["en", "pl"] as Locale[]) for (const width of [390, 1440]) {
  test(`verification-only Godot flow ${locale} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const data = dashboardFixture(), snapshot = data.projects[0];
    snapshot.project.name = "Fixture Godot"; snapshot.project.launchPreset = "none";
    snapshot.project.executable = ""; snapshot.project.args = [];
    snapshot.project.testEnvironmentProfiles = [{ name: "tooling", policy: { mode: "clean", serverProfile: null }, variableNames: [], nodeEnv: null, requiredVariables: [] }];
    snapshot.testPresets[0].presets = ["check", "export-macos"].map(name => ({ id: `godot:${name}`, name, adapter: "godot", profile: "tooling", timeoutMs: 900_000 }));
    const { requests, errors } = await mountDashboard(page, data);
    if (locale === "pl") await selectLanguage(page);
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const row = page.locator("[data-worktree-row]").first();
    await expect(row.getByText(t("project.noServer"), { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: t("row.start"), exact: true })).toHaveCount(0);
    await expect(row.getByText(t("phase.stopped"), { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /HTTPS/ })).toHaveCount(0);
    await row.getByRole("button").click();
    await page.getByRole("menuitem", { name: t("row.details"), exact: true }).click();
    const details = page.getByRole("dialog");
    await expect(details.getByText(t("project.noServer"), { exact: true })).toBeVisible();
    await expect(details.getByText(t("project.unusedPort"), { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(row.getByRole("button")).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`godot-no-server-${locale}-${width}.png`), fullPage: true, animations: "disabled" });
    if (width < 768) await page.getByRole("button", { name: t("dashboard.toggleNavigation"), exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: t("dashboard.navTests"), exact: true }).click();
    await page.getByRole("button", { name: t("tests.run"), exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: t("tests.preset"), exact: true }).click();
    await page.getByRole("option", { name: /export-macos/ }).click();
    await dialog.getByRole("button", { name: t("tests.run"), exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(requests.at(-1)).toEqual({ path: "/api/projects/web/tests", method: "POST", body: { worktreePath: snapshot.worktrees[0].path, presetId: "godot:export-macos" } });
    expect(requests.some(r => /operation|tls|reservation/.test(r.path))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath(`godot-${locale}-${width}.png`), fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
  });
}
