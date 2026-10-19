import { expect, test, type Page } from "@playwright/test";
import type { TestRunSummary } from "../../src/shared/contracts";
import type { TestHistoryPage, TestMetricPopulation, TestMetrics, TestSummaryEntry } from "../../src/shared/contracts/verification-history";
import { pilotComparison, pilotEntry, pilotSummary } from "../../src/features/telemetry/telemetry-fixtures.test-support";
import { dashboardFixture, mountDashboard, type FixtureReadApi } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

// Two runs reproduce the 2026-10-19 WinPath typecheck pilot. Other entries are synthetic edge cases.
const pilotLeft = pilotEntry();
const pilotRight = pilotComparison().right;
const sourceFailed: TestSummaryEntry = { detailAvailable: false, summary: pilotSummary({
  runId: "5a1c0000-0000-4000-8000-000000000001", presetId: "node:test:integration", queuedAt: "2026-10-19T17:40:00.000Z",
  phase: "failed", processOutcome: "passed", attribution: "changed", sourceReasonCodes: ["source_changed_during_execution"],
}) };
const legacy: TestSummaryEntry = { detailAvailable: false, summary: pilotSummary({
  runId: "5a1c0000-0000-4000-8000-000000000002", presetId: "node:lint", queuedAt: "2026-10-18T15:08:51.782Z",
  telemetry: { ...pilotSummary().telemetry, resources: undefined, availability: "legacy_unknown", durations: { queueMs: null, prepareMs: null, processMs: null, cleanupMs: null, finalizationMs: null, totalMs: null, runnerWaitMs: null } },
}) };

const coverage = { records: 141, bytes: 198733, evicted: 0, lastPrunedAt: null, oldestQueuedAt: "2026-10-18T15:08:51.782Z", newestQueuedAt: "2026-10-19T17:47:49.952Z",
  policy: { maxAgeMs: 2592000000, perProjectRecords: 5000, perProjectBytes: 16777216, globalRecords: 50000, globalBytes: 134217728, maxRecordBytes: 8192, pruneBatch: 64 },
  maintenancePending: false, historicalCompleteness: "not_guaranteed" as const };

function stat(values: number[], denominator: number) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { medianMs: n ? sorted[Math.floor((n - 1) / 2)] / 2 + sorted[Math.floor(n / 2)] / 2 : null, p95Ms: n ? sorted[Math.ceil(0.95 * n) - 1] : null, valid: n, missing: denominator - n, denominator };
}
/** Metrics computed from the given summaries with the server's published method. */
function metricsFor(entries: TestSummaryEntry[], matchedOverride?: number): TestMetrics {
  const populations = {} as TestMetrics["populations"];
  const resourcePopulations = { cpu: {} as TestMetrics["resources"]["cpu"]["populations"], rss: {} as TestMetrics["resources"]["rss"]["populations"] };
  const names: TestMetricPopulation[] = ["completed_execution", "cancelled", "timed_out", "interrupted", "in_progress", "rejected", "other_incomplete"];
  const population = (s: TestRunSummary): TestMetricPopulation => s.telemetry.availability === "legacy_unknown" ? "other_incomplete" : s.phase === "passed" || s.phase === "failed" ? "completed_execution" : "other_incomplete";
  for (const name of names) {
    const group = entries.map((entry) => entry.summary).filter((s) => population(s) === name);
    const durations = {} as TestMetrics["populations"][TestMetricPopulation]["durations"];
    for (const key of ["queueMs", "prepareMs", "processMs", "cleanupMs", "finalizationMs", "totalMs"] as const) durations[key] = stat(group.flatMap((s) => s.telemetry.durations[key] ?? []), group.length);
    populations[name] = { count: group.length, durations };
    for (const [kind, field] of [["cpu", "peakSampledCpuPercent"], ["rss", "peakSampledRssBytes"]] as const) {
      const values = group.flatMap((s) => s.telemetry.resources?.[field] ?? []);
      const base = stat(values, group.length);
      const statuses = { pending: 0, sampled: 0, partial: 0, unavailable: 0, unsupported: 0, legacy_unknown: 0 };
      for (const s of group) statuses[s.telemetry.resources?.status ?? "legacy_unknown"]++;
      resourcePopulations[kind][name] = { median: base.medianMs, p95: base.p95Ms, valid: base.valid, missing: base.missing, denominator: base.denominator, statuses,
        sampleCount: group.reduce((sum, s) => sum + (s.telemetry.resources?.sampleCount ?? 0), 0), cpuIntervalCount: group.reduce((sum, s) => sum + (s.telemetry.resources?.cpuIntervalCount ?? 0), 0) };
    }
  }
  const processOutcomes = { passed: 0, failed: 0, cancelled: 0, timed_out: 0, interrupted: 0, unknown: 0 };
  const sourceAttributions = { pending: 0, observed_match: 0, changed: 0, uncertain: 0, legacy_unknown: 0 };
  for (const { summary } of entries) { processOutcomes[summary.processOutcome ?? "unknown"]++; sourceAttributions[summary.attribution]++; }
  return {
    selection: { filter: { projectId: "web", from: "", to: "" }, scanned: entries.length + 2, scanLimit: 5000, truncated: false, matched: matchedOverride ?? entries.length, order: "queuedAt_desc_runId_desc" },
    processOutcomes, sourceAttributions, populations,
    method: { median: "sorted_midpoint_mean", p95: "nearest_rank_ceil_0.95_n", missing: "excluded_not_zero", population: "per_run_not_daily_percentiles" },
    resources: { cpu: { metric: "peak_sampled_cpu_percent", unit: "percent_one_core", populations: resourcePopulations.cpu }, rss: { metric: "peak_sampled_summed_rss", unit: "bytes", populations: resourcePopulations.rss }, runnerWait: "unavailable" },
    coverage,
  };
}
function historyPage(items: TestSummaryEntry[], nextCursor: string | null = null, scanned = items.length): TestHistoryPage {
  return { items, nextCursor, order: "queuedAt_desc_runId_desc", coverage,
    selection: { filter: { projectId: "web", from: "", to: "" }, scanned, scanLimit: 1000, scanLimitReached: false, consistency: "live_keyset_not_snapshot" } };
}

function api(routes: (url: URL) => { status?: number; json: unknown } | null | Promise<{ status?: number; json: unknown } | null>) {
  const reads: URL[] = [];
  const handler: FixtureReadApi = (url) => {
    if (!url.pathname.startsWith("/api/projects/web/test-")) return null;
    reads.push(url);
    return routes(url);
  };
  return { reads, handler };
}

async function openAnalysis(page: Page, width: number) {
  if (width < 768) await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.getByRole("navigation").getByRole("button", { name: "Test analysis", exact: true }).click();
  return page.locator("[data-analysis-dashboard]");
}

const standardRoutes = (url: URL) => {
  if (url.pathname.endsWith("/test-metrics")) return { json: metricsFor(url.searchParams.get("processOutcome") === "failed" ? [] : [pilotRight, pilotLeft]) };
  if (url.pathname.endsWith("/test-runs")) return { json: historyPage(url.searchParams.get("processOutcome") === "failed" ? [] : [pilotRight, pilotLeft, sourceFailed, legacy]) };
  if (url.pathname.endsWith("/test-run-comparison")) return { json: pilotComparison() };
  return null;
};

test("summary, run detail and two-run comparison use the history API with honest sampled values", async ({ page }) => {
  const { reads, handler } = api(standardRoutes);
  const { errors } = await mountDashboard(page, dashboardFixture(), { readApi: handler });
  const screen = await openAnalysis(page, 1440);
  await expect(page).toHaveURL(/view=analysis/);

  const kpis = screen.locator("[data-analysis-kpis]");
  await expect(kpis).toContainText("Finished normally2");
  await expect(kpis).toContainText("Typical peak memory2.2 GiB");
  await expect(kpis).toContainText("2 of 2 measured");
  await expect(screen.locator("[data-analysis-phases]")).toContainText("small sample");
  await expect(screen.locator("[data-analysis-resources]")).toContainText("Partly sampled 2");
  await expect(screen.locator("[data-analysis-resources]")).toContainText("43 samples, 41 CPU intervals");
  await expect(screen.locator("[data-analysis-coverage]")).toContainText("141 runs kept");

  const metricsRead = reads.find((url) => url.pathname.endsWith("/test-metrics"))!;
  expect(Date.parse(metricsRead.searchParams.get("to")!) - Date.parse(metricsRead.searchParams.get("from")!)).toBe(7 * 86_400_000);
  const historyRead = reads.find((url) => url.pathname.endsWith("/test-runs"))!;
  expect(historyRead.searchParams.get("limit")).toBe("25");

  const table = screen.locator("[data-analysis-runs] table");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const failedRow = table.locator("tbody tr").filter({ hasText: "node:test:integration" });
  await expect(failedRow).toContainText("Passed");
  await expect(failedRow).toContainText("Changed");
  await expect(failedRow).toContainText("Run failed on the source check");
  const legacyRow = table.locator("tbody tr").filter({ hasText: "node:lint" });
  await expect(legacyRow).toContainText("Not measured");
  await expect(legacyRow).not.toContainText("0 B");

  const details = failedRow.getByRole("button", { name: /^Details: node:test:integration/ });
  await details.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("The command itself succeeded. The run is marked failed because the source check did not confirm the tested code.")).toBeVisible();
  await expect(sheet.getByText("The code changed while the command ran.")).toBeVisible();
  await expect(sheet.getByText("Processes started or ended between samples.")).toBeVisible();
  await expect(sheet.getByText("Only this summary is kept; retention removed the output.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toBeFocused();

  await legacyRow.getByRole("button", { name: /^Details:/ }).click();
  await expect(page.getByRole("dialog").getByText("This run was recorded before memory and CPU sampling. There are no values; this does not mean zero.")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Some phases were not measured, so proportions are not shown.")).toBeVisible();
  await page.keyboard.press("Escape");

  await table.getByRole("checkbox", { name: /^Select node:typecheck/ }).first().check();
  await table.getByRole("checkbox", { name: /^Select node:typecheck/ }).last().check();
  await expect(table.getByRole("checkbox", { name: /^Select node:lint/ })).toBeDisabled();
  await screen.getByRole("button", { name: "Compare", exact: true }).click();
  const comparison = screen.locator("[data-analysis-comparison]");
  await expect(comparison.getByRole("heading", { name: "Comparison", exact: true })).toBeFocused();
  const comparisonRead = reads.find((url) => url.pathname.endsWith("/test-run-comparison"))!;
  expect(comparisonRead.searchParams.get("leftRunId")).toBe(pilotLeft.summary.runId);
  expect(comparisonRead.searchParams.get("rightRunId")).toBe(pilotRight.summary.runId);
  await expect(comparison).toContainText("−1.1 GiB");
  await expect(comparison).toContainText("+27.8 pp");
  await expect(comparison).toContainText("−26.2 s");
  await expect(comparison).toContainText("Memory and CPU are sampled peaks, not exact totals.");
  await expect(comparison).toContainText("One pair of runs cannot show a lasting speed-up or slow-down.");
  await expect(comparison).not.toContainText("Not comparable");
  await comparison.getByRole("button", { name: "Close comparison" }).click();
  await expect(screen.getByRole("button", { name: "Compare", exact: true })).toBeFocused();

  // A filter change starts a new result set and clears the selection.
  await screen.getByRole("button", { name: "Show only Passed: 2" }).click();
  await expect.poll(() => reads.filter((url) => url.searchParams.get("processOutcome") === "passed").length).toBeGreaterThanOrEqual(2);
  await expect(screen.getByText("0 of 2 selected")).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("analysis-1440.png"), fullPage: true, animations: "disabled" });
});

test("comparison explains a null resource delta without disabling other measures", async ({ page }) => {
  const comparison = pilotComparison();
  comparison.resources.cpu = { ...comparison.resources.cpu, delta: null };
  comparison.populations.right = "cancelled";
  const { handler } = api((url) => url.pathname.endsWith("/test-run-comparison") ? { json: comparison } : standardRoutes(url));
  await mountDashboard(page, dashboardFixture(), { readApi: handler });
  const screen = await openAnalysis(page, 1440);
  const table = screen.locator("[data-analysis-runs] table");
  await table.getByRole("checkbox", { name: /^Select node:typecheck/ }).first().check();
  await table.getByRole("checkbox", { name: /^Select node:typecheck/ }).last().check();
  await screen.getByRole("button", { name: "Compare", exact: true }).click();
  const panel = screen.locator("[data-analysis-comparison]");
  await expect(panel).toContainText("Not comparable: sampling quality or run state");
  await expect(panel).toContainText("−1.1 GiB");
  await expect(panel).toContainText("At least one run did not finish normally.");
});

test("an empty filtered page with a next cursor continues to older runs and pages back", async ({ page }) => {
  const { reads, handler } = api((url) => {
    if (url.pathname.endsWith("/test-metrics")) return { json: metricsFor([pilotLeft]) };
    const cursor = url.searchParams.get("cursor");
    if (!cursor) return { json: historyPage([], "page-2", 1000) };
    if (cursor === "page-2") return { json: historyPage([pilotLeft], "page-3") };
    return { status: 400, json: { error: "Invalid verification history cursor." } };
  });
  await mountDashboard(page, dashboardFixture(), { readApi: handler });
  const screen = await openAnalysis(page, 1440);
  await expect(screen.locator("[data-analysis-empty]")).toContainText("None of the 1000 kept runs checked so far match.");
  await screen.getByRole("button", { name: "Check older runs" }).click();
  await expect(screen.locator("[data-analysis-runs] tbody tr")).toHaveCount(1);
  await expect(screen.getByRole("heading", { name: "Runs" })).toBeFocused();
  expect(reads.filter((url) => url.searchParams.get("cursor") === "page-2")).toHaveLength(1);
  await screen.getByRole("navigation", { name: "Run pages" }).getByRole("button", { name: "Older" }).click();
  await expect(screen.getByRole("alert")).toContainText("Invalid verification history cursor.");
  await screen.getByRole("button", { name: "Start over" }).click();
  await expect(screen.locator("[data-analysis-empty]")).toBeVisible();
});

test("a slow response for an old filter cannot replace the current result", async ({ page }) => {
  const { handler } = api(async (url) => {
    const failedOnly = url.searchParams.get("processOutcome") === "failed";
    if (!failedOnly) await new Promise((resolve) => setTimeout(resolve, 1200));
    if (url.pathname.endsWith("/test-metrics")) return { json: failedOnly ? metricsFor([]) : metricsFor([pilotLeft], 99) };
    return { json: historyPage(failedOnly ? [] : [pilotLeft]) };
  });
  await mountDashboard(page, dashboardFixture(), { readApi: handler });
  const screen = await openAnalysis(page, 1440);
  await screen.getByRole("combobox", { name: "Command result" }).click();
  await page.getByRole("option", { name: "Failed", exact: true }).click();
  await expect(screen.getByText("No runs in this period match these filters.").first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(screen.locator("[data-analysis-kpis]")).toHaveCount(0);
  await expect(screen).not.toContainText("99");
});

test("permission failures and aggregate scope have explicit states", async ({ page }) => {
  const data = dashboardFixture();
  const second = structuredClone(data.projects[0]);
  second.project.id = "api"; second.project.name = "Fixture API";
  data.projects.push(second);
  const { handler } = api(() => ({ status: 403, json: { error: "forbidden" } }));
  await mountDashboard(page, data, { readApi: handler });
  const screen = await openAnalysis(page, 1440);
  await expect(screen.getByRole("alert").first()).toContainText("This access cannot read run history.");
  await expect(screen.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.getByRole("combobox", { name: /Choose project/ }).click();
  await page.getByRole("option", { name: /All projects/ }).click();
  await expect(page.getByRole("heading", { name: "Choose one project" })).toBeVisible();
});

test("mobile layout shows run cards without horizontal scrolling, in Polish", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { handler } = api(standardRoutes);
  await mountDashboard(page, dashboardFixture(), { readApi: handler });
  const screen = await openAnalysis(page, 390);
  await expect(screen.locator("[data-analysis-run]")).toHaveCount(4);
  await expect(screen.locator("[data-analysis-runs] table")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await selectLanguage(page);
  await expect(screen.getByRole("heading", { name: "Gdzie idzie czas" })).toBeVisible();
  await expect(screen.locator("[data-analysis-run]").filter({ hasText: "node:test:integration" })).toContainText("Uruchomienie nieudane przez kontrolę źródła");
  await screen.locator("[data-analysis-run]").first().getByRole("button", { name: /^Szczegóły:/ }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Pamięć i CPU" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath("analysis-390-pl.png"), fullPage: true, animations: "disabled" });
});
