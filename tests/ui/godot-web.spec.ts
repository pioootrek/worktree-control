import { expect, test } from "@playwright/test";
import { translate, type Locale } from "../../src/i18n/messages";
import { DEFAULT_GODOT_WEB_CONFIG } from "../../src/shared/contracts/godot-web";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

for (const locale of ["en", "pl"] as Locale[]) for (const width of [390, 1440]) {
  test(`Godot Web preview status and settings ${locale} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const data = dashboardFixture(), snapshot = data.projects[0];
    snapshot.project.name = "Fixture Godot Web";
    snapshot.project.launchPreset = "godot-web";
    snapshot.project.godotWeb = DEFAULT_GODOT_WEB_CONFIG;
    snapshot.project.executable = "node"; snapshot.project.args = ["godot-web-server.js"];
    snapshot.runtime.phase = "running"; snapshot.runtime.worktreePath = snapshot.worktrees[0].path;
    snapshot.webExport = {
      state: "failed", watcher: "watching", worktreePath: snapshot.worktrees[0].path,
      current: { id: "m1abcdef-0a0b0c0d", publishedAt: "2026-01-01T11:00:00.000Z", runId: "export-1", head: "abcdef123456", dirty: true, files: 6, bytes: 42 * 1024 * 1024 },
      currentStale: true, activeRunId: null, pendingRebuild: false, lastRunId: "export-1", lastChangeAt: "2026-01-01T11:30:00.000Z",
      lastFailure: { code: "export_failed", message: "The export command exited with code 3.", runId: "export-1", at: "2026-01-01T11:31:00.000Z" },
    };
    const { requests, errors } = await mountDashboard(page, data);
    if (locale === "pl") await selectLanguage(page);
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate(locale, key, values);
    const panel = page.locator("[data-web-export]");
    await expect(panel.getByRole("heading", { name: t("webExport.title") })).toBeVisible();
    await expect(panel.getByRole("status").filter({ hasText: t("webExport.state.failed") })).toBeVisible();
    await expect(panel.getByText(t("webExport.failure.export_failed"))).toBeVisible();
    await expect(panel.getByText(t("webExport.keptPrevious"))).toBeVisible();
    await expect(panel.getByText(t("webExport.dirtyGeneration"))).toBeVisible();
    await expect(panel.getByText(t("webExport.notHmr"))).toBeVisible();
    await expect(panel.getByRole("link", { name: t("webExport.open") })).toHaveAttribute("href", /:3000\/$/);
    await expect(page.getByRole("button", { name: /HTTPS/ })).toHaveCount(0);
    await panel.getByRole("button", { name: t("webExport.rebuild") }).click();
    await expect.poll(() => requests.at(-1)).toEqual({ path: "/api/projects/web/godot-web/rebuild", method: "POST", body: {} });
    await page.screenshot({ path: test.info().outputPath(`godot-web-${locale}-${width}.png`), fullPage: true, animations: "disabled" });

    const settings = page.getByRole("button", { name: t("godotWeb.settings") });
    if (!(await settings.isVisible())) await page.getByText(t("worktreeLayout.projectSettings")).click();
    await settings.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(t("godotWeb.stopFirst"))).toBeVisible();
    await expect(dialog.getByRole("button", { name: t("godotWeb.save") })).toBeDisabled();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}

test("opts a stopped verification-only Godot project into a project-command exporter", async ({ page }) => {
  const data = dashboardFixture(), snapshot = data.projects[0];
  snapshot.project.launchPreset = "none"; snapshot.project.executable = ""; snapshot.project.args = [];
  const { requests, errors } = await mountDashboard(page, data);
  const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
  await expect(page.locator("[data-web-export]")).toHaveCount(0);
  const settings = page.getByRole("button", { name: t("godotWeb.settings") });
  if (!(await settings.isVisible())) await page.getByText(t("worktreeLayout.projectSettings")).click();
  await settings.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: t("godotWeb.exporter") }).click();
  await page.getByRole("option", { name: t("godotWeb.exporterCommand") }).click();
  await dialog.getByLabel(t("godotWeb.command")).fill("bash\nscripts/project.sh\nexport-playable-web");
  await dialog.getByLabel(t("godotWeb.outputDirectory")).fill("exports/playable-web");
  await dialog.getByLabel(t("godotWeb.watchPaths")).fill("game\nscenes\nproject.godot");
  await dialog.getByRole("switch", { name: t("godotWeb.liveReload") }).click();
  await dialog.getByRole("button", { name: t("godotWeb.save") }).click();
  await expect(dialog).toBeHidden();
  expect(requests.at(-1)).toEqual({
    path: "/api/projects/web/godot-web", method: "POST",
    body: { config: {
      exporter: { kind: "command", command: ["bash", "scripts/project.sh", "export-playable-web"], outputDirectory: "exports/playable-web" },
      watch: { paths: ["game", "scenes", "project.godot"], ignore: [], debounceMs: 750 },
      liveReload: false, crossOriginIsolation: true,
    } },
  });
  await expect(page.getByRole("button", { name: /HTTPS/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});
