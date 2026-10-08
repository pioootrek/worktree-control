import { expect, test } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { mcpDiagnosticsFixture } from "./mcp-sessions-fixture";
import { openPreferences, selectLanguage } from "./shell-actions";
import { translate } from "../../src/i18n/messages";

for (const width of [320, 390, 1366, 1440]) {
  test(`MCP sessions observations and accessible sorting at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const { requests, errors } = await mountDashboard(page);
    let reads = 0;
    await page.route("**/api/mcp/diagnostics", route => { reads++; return route.fulfill({ json: mcpDiagnosticsFixture() }); });
    if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
    await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    const panel = page.locator("[data-mcp-sessions]");
    await expect(panel).toContainText("5 / 128");
    await expect(panel).toContainText("Details are incomplete");
    await expect(panel).toContainText("CPU Unknown");
    await expect(panel).toContainText("History has no session labels.");
    await expect(panel).toContainText("No qualifying activity");
    await expect(panel).toContainText("Stopped: idle");
    const visibleRows = width < 768 ? panel.locator("article[data-session-label]") : panel.locator("tbody tr");
    await expect(visibleRows.first()).toHaveAttribute("data-session-label", "1");
    const sort = panel.getByRole("button", { name: "Sort by idle time", exact: true }).filter({ visible: true });
    await sort.focus();
    await page.keyboard.press("Enter");
    await expect(visibleRows.first()).toHaveAttribute("data-session-label", "4");
    if (width >= 768) await expect(panel.locator('th[aria-sort="descending"]')).toContainText("Idle time");
    await page.keyboard.press("Enter");
    await expect(visibleRows.first()).toHaveAttribute("data-session-label", "1");
    if (width < 768) await visibleRows.first().getByText("Details", { exact: true }).click();
    await expect(panel).toContainText(/25\d{3} s/);
    await panel.getByText("Effective policy", { exact: true }).click();
    await expect(panel).toContainText("28800 s");
    const before = reads;
    await panel.getByRole("button", { name: "Refresh sessions" }).click();
    await expect.poll(() => reads).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: test.info().outputPath("mcp-sessions.png"), fullPage: true, animations: "disabled" });
    await selectLanguage(page);
    await expect(page.getByRole("tab", { name: "Sesje", exact: true })).toBeVisible();
    await expect(panel).toContainText("Zasoby kontrolera");
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("MCP polling is active-only, non-overlapping, stale on error and clears denied observations", async ({ page }) => {
  await page.clock.install();
  const data = dashboardFixture();
  const { errors } = await mountDashboard(page, data);
  let reads = 0;
  let outcome: "ok" | "error" | "denied" = "ok";
  await page.route("**/api/mcp/diagnostics", route => { reads++; return route.fulfill(outcome === "ok" ? { json: mcpDiagnosticsFixture() } : { status: outcome === "denied" ? 403 : 503, json: { error: "Fixture unavailable" } }); });
  await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
  expect(reads).toBe(0);
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  const panel = page.locator("[data-mcp-sessions]");
  await expect(panel).toContainText("5 / 128");
  const visibleReads = reads;
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, value: true }));
  await page.clock.runFor(5000);
  expect(reads).toBe(visibleReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => reads).toBeGreaterThan(visibleReads);
  outcome = "error";
  await page.clock.runFor(5000);
  await expect(panel).toContainText("Could not refresh sessions");
  await expect(panel).toContainText("Stale data");
  await expect(panel).toContainText("5 / 128");
  outcome = "denied";
  await panel.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(panel).toContainText("This view requires owner or installation authority");
  await expect(panel).not.toContainText("5 / 128");
  const deniedReads = reads;
  await page.clock.runFor(10_000);
  expect(reads).toBe(deniedReads);
  await page.getByRole("tab", { name: /^Storage/ }).click();
  await page.clock.runFor(10_000);
  expect(reads).toBe(deniedReads);
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(panel).toContainText("This view requires owner or installation authority");
  await page.clock.runFor(10_000);
  expect(reads).toBe(deniedReads);
  await selectLanguage(page);
  await expect(page.getByRole("tab", { name: "Sesje", exact: true })).toBeVisible();
  await page.clock.runFor(10_000);
  expect(reads).toBe(deniedReads);
  data.projects[0].runtime.phase = "running";
  await page.evaluate(() => {
    (window as unknown as { fixtureEvents: { emit(type: string, data: unknown): void } }).fixtureEvents.emit("changed", {
      epoch: "fixture", revision: 1, kinds: ["runtime"], projectIds: ["web"], allProjects: false,
    });
  });
  await expect(page.locator("[data-resources-dashboard]")).toContainText(translate("pl", "resourceView.activeServers", { count: 1 }));
  await page.clock.runFor(10_000);
  expect(reads).toBe(deniedReads);
  outcome = "ok";
  await panel.getByRole("button", { name: translate("pl", "mcpSessions.refresh") }).click();
  await expect(panel).toContainText("5 / 128");
  expect(reads).toBe(deniedReads + 1);
  expect(errors).toEqual([]);
});

test("MCP loading read is cancelled when leaving Sessions; empty and disabled remain distinct", async ({ page }) => {
  await page.clock.install();
  const data = dashboardFixture();
  data.projects = [];
  await mountDashboard(page, data);
  let release = () => {};
  let reads = 0;
  await page.route("**/api/mcp/diagnostics", async route => {
    reads++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: { status: "disabled", mcp: null, statusWaits: { waiters: 0, waiterTimers: 0 } } }).catch(() => {});
  });
  await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(page.locator("[data-mcp-sessions]")).toContainText("Loading sessions");
  await expect.poll(() => reads).toBe(1);
  await page.clock.runFor(5000);
  expect(reads).toBe(1);
  await page.getByRole("tab", { name: /^Storage/ }).click();
  release();
  await page.unroute("**/api/mcp/diagnostics");
  const fixture = mcpDiagnosticsFixture();
  fixture.mcp!.sessions = []; fixture.mcp!.truncated = 0; fixture.mcp!.omittedSessions = 0;
  await page.route("**/api/mcp/diagnostics", route => route.fulfill({ json: fixture }));
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(page.locator("[data-mcp-sessions]")).toContainText("No retained sessions.");
  await page.route("**/api/mcp/diagnostics", route => route.fulfill({ json: { ...fixture, mcp: null, status: "disabled" } }));
  await page.getByRole("button", { name: "Refresh sessions" }).click();
  await expect(page.locator("[data-mcp-sessions]")).toContainText("The MCP server is disabled.");
});


test("held and timed-out diagnostics leave runtime metrics updating independently", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    // Make the browser's native timeout signal follow Playwright's controlled clock.
    AbortSignal.timeout = milliseconds => {
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    };
  });
  const data = dashboardFixture();
  data.projects[0].runtime.phase = "running";
  const { errors } = await mountDashboard(page, data);
  let metricsReads = 0;
  let diagnosticsReads = 0;
  let release = () => {};
  await page.route("**/api/metrics", route => {
    metricsReads++;
    return route.fulfill({ json: { projects: [{ projectId: "web", resources: {
      ...data.projects[0].runtime.resources, status: "available", currentRssBytes: metricsReads * 1024 * 1024,
      cpuPercent: metricsReads, processCount: 1, sampledAt: new Date(Date.now() + metricsReads * 1000).toISOString(), sampleAgeSeconds: 0,
    } }] } });
  });
  await page.route("**/api/mcp/diagnostics", async route => {
    diagnosticsReads++;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: mcpDiagnosticsFixture() }).catch(() => {});
  });
  await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  const panel = page.locator("[data-mcp-sessions]");
  await expect(panel).toContainText("Loading sessions");
  await expect.poll(() => diagnosticsReads).toBe(1);
  await expect.poll(() => metricsReads).toBeGreaterThan(0);
  const readsBefore = metricsReads;
  await page.clock.runFor(5000);
  await expect.poll(() => metricsReads).toBeGreaterThan(readsBefore);
  expect(diagnosticsReads).toBe(1);
  const heldReads = metricsReads;
  await expect(page.locator("[data-resource-metrics]")).toContainText(`${heldReads.toFixed(1)} MiB`);
  await page.clock.runFor(5001);
  await expect(panel).toContainText("Could not refresh sessions");
  await expect.poll(() => metricsReads).toBeGreaterThan(heldReads);
  await expect(page.locator("[data-resource-metrics]")).toContainText(`${metricsReads.toFixed(1)} MiB`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureEvents: { active: number } }).fixtureEvents.active)).toBe(1);
  release();
  expect(errors).toEqual([]);
});

test("runtime metrics keep their request lifetime outside Sessions", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => {
    AbortSignal.timeout = milliseconds => {
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    };
  });
  const data = dashboardFixture();
  data.projects[0].runtime.phase = "running";
  let reads = 0;
  // Register before mounting so the first metrics read is also held.
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    Object.assign(window, { fixtureMetricsRelease: null });
    window.fetch = (async (input, init) => {
      if (input !== "/api/metrics") return nativeFetch(input, init);
      await new Promise<void>((resolve, reject) => {
        Object.assign(window, { fixtureMetricsRelease: resolve });
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return nativeFetch(input, init);
    }) as typeof fetch;
  });
  const { errors } = await mountDashboard(page, data);
  await page.route("**/api/metrics", route => {
    reads++;
    return route.fulfill({ json: { projects: [{ projectId: "web", resources: {
      ...data.projects[0].runtime.resources, status: "available", currentRssBytes: 42 * 1024 * 1024,
      cpuPercent: 12, sampledAt: new Date().toISOString(), sampleAgeSeconds: 0,
    } }] } });
  });
  await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { fixtureMetricsRelease: unknown }).fixtureMetricsRelease)).toBe("function");
  await page.clock.runFor(12_000);
  await page.evaluate(() => (window as unknown as { fixtureMetricsRelease(): void }).fixtureMetricsRelease());
  await expect(page.locator("[data-resource-metrics]")).toContainText("42.0 MiB");
  expect(reads).toBe(1);
  expect(errors).toEqual([]);
});

test("a new credential can read diagnostics after the previous credential was denied", async ({ page }) => {
  await page.clock.install();
  const { errors } = await mountDashboard(page, dashboardFixture(), { accessToken: "denied-owner", openMode: true });
  await page.route("**/api/mcp/diagnostics", route => route.fulfill(route.request().headers()["x-worktree-control-token"] === "denied-owner"
    ? { status: 403, json: { error: "Denied" } } : { json: mcpDiagnosticsFixture() }));
  await page.getByRole("navigation").getByRole("button", { name: "Resources", exact: true }).click();
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(page.locator("[data-mcp-sessions]")).toContainText("This view requires owner or installation authority");
  await openPreferences(page);
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Access token", { exact: true }).fill("allowed-owner");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("[data-mcp-sessions]")).toContainText("5 / 128");
  expect(errors).toEqual([]);
});

for (const width of [320, 1440]) {
  test(`zero-project Sessions can return to onboarding and open registration at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const data = dashboardFixture();
    data.projects = [];
    const { requests, errors } = await mountDashboard(page, data);
    await page.route("**/api/mcp/diagnostics", route => route.fulfill({ json: mcpDiagnosticsFixture() }));
    const navigate = async (name: string) => {
      if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
      await page.getByRole("navigation").getByRole("button", { name, exact: true }).click();
    };
    await expect(page.getByRole("button", { name: "Add repository", exact: true })).toBeVisible();
    await navigate("Resources");
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
    await expect(page.locator("[data-mcp-sessions]")).toContainText("5 / 128");
    await navigate("Worktrees");
    const add = page.getByRole("button", { name: "Add repository", exact: true });
    await add.click();
    const dialog = page.getByRole("dialog", { name: "Add repository", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Add", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(add).toBeFocused();
    await navigate("Resources");
    await expect(page.getByRole("tab", { name: "Sessions", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-mcp-sessions]")).toContainText("5 / 128");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });
}
