import { expect, test, type Page } from "@playwright/test";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { selectLanguage } from "./shell-actions";

const importedBody = '{"documents":["implementation-plan.md"],"internalId":"manifest-only"}';
const nativeBody = '{"this":"is an ordinary native note"}';
const project = { id: "reading-project", name: "Reading project", status: "active", writable: true, revision: 1, createdAt: "2026-09-01", updatedAt: "2026-09-28" };
const memories = [
  { id: "imported", projectId: project.id, title: "Architecture note", body: importedBody, category: "note", tags: [], legacyId: null, sources: [], status: "active", supersededBy: null, approval: null, revision: 2, createdBy: "importer", createdAt: "2026-09-01", updatedAt: "2026-09-28", reading: { kind: "imported-note", bodyFormat: "manifest", summary: "Plan and source material for the architecture." } },
  { id: "native", projectId: project.id, title: "Native JSON note", body: nativeBody, category: "decision", tags: [], legacyId: null, sources: [], status: "active", supersededBy: null, approval: null, revision: 1, createdBy: "owner", createdAt: "2026-09-01", updatedAt: "2026-09-28" },
  { id: "text-import", projectId: project.id, title: "Text import", body: "Plain imported context", category: "note", tags: [], legacyId: null, sources: [], status: "active", supersededBy: null, approval: null, revision: 1, createdBy: "importer", createdAt: "2026-09-01", updatedAt: "2026-09-28", reading: { kind: "imported-note", bodyFormat: "text", summary: "Plain imported context" } },
  { id: "empty-import", projectId: project.id, title: "Empty imported note", body: '{"source":"archive"}', category: "note", tags: [], legacyId: null, sources: [], status: "active", supersededBy: null, approval: null, revision: 1, createdBy: "importer", createdAt: "2026-09-01", updatedAt: "2026-09-28", reading: { kind: "imported-note", bodyFormat: "metadata", summary: null } },
];

async function mountReading(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("worktree-control-knowledge-token", "reading-fixture"));
  const data = dashboardFixture(); data.projects = [];
  const fixture = await mountDashboard(page, data);
  await page.route("**/api/identity", route => route.fulfill({ json: { principal: { id: "owner", kind: "owner" }, credential: { kind: "owner_session" } } }));
  await page.route("**/api/knowledge", route => {
    const { operation, input } = route.request().postDataJSON();
    const empty = { items: [], nextOffset: null };
    if (operation === "projects") return route.fulfill({ json: { items: [project], nextOffset: null } });
    if (operation === "project") return route.fulfill({ json: project });
    if (operation === "search") {
      const items = memories.filter(memory => !input.query || `${memory.title} ${memory.body}`.toLowerCase().includes(input.query.toLowerCase())).map(memory => ({ ...memory, kind: "memory", excerpt: memory.body, threadId: null }));
      return route.fulfill({ json: { items, nextOffset: null } });
    }
    if (operation === "memory") return route.fulfill({ json: memories.find(memory => memory.id === input.memoryId) });
    if (operation === "attachments" || operation === "history") return route.fulfill({ json: empty });
    return route.fulfill({ status: 400, json: { code: "invalid_input", error: `Unexpected ${operation}` } });
  });
  const navigation = page.getByRole("button", { name: "Knowledge", exact: true });
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await navigation.click();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue(project.id);
  return fixture;
}

test("imported manifests show a summary and documents while preserving the original payload", async ({ page }) => {
  const fixture = await mountReading(page);
  const list = page.locator("[data-memory-list]");
  await expect(list.getByText("Plan and source material for the architecture.")).toBeVisible();
  await expect(list.getByText("manifest-only")).toHaveCount(0);
  await page.getByRole("link", { name: "Architecture note", exact: true }).click();
  const reader = page.locator("[data-memory-detail]");
  await expect(reader.getByRole("heading", { name: "Architecture note" })).toBeVisible();
  await expect(reader.getByText("Plan and source material for the architecture.", { exact: true })).toBeVisible();
  await expect(reader.getByText("Active · Proposed", { exact: false })).toBeVisible();
  await expect(reader.getByText("Note", { exact: true })).toBeVisible();
  await expect(reader.getByText("Updated Sep 28, 2026")).toBeVisible();
  await expect(reader.getByRole("heading", { name: "Documents", exact: true })).toBeVisible();
  await expect(reader.getByText(importedBody, { exact: true })).toBeHidden();
  await reader.getByText("Original imported payload", { exact: true }).click();
  await expect(reader.getByText(importedBody, { exact: true })).toBeVisible();

  await page.getByLabel("Search titles, content and memory").fill("manifest-only");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(list.getByText(importedBody, { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.set("document", "plan-file");
    url.searchParams.set("keep", "value");
    url.hash = "#overview";
    history.replaceState(null, "", url);
  });
  await page.getByLabel("Search titles, content and memory").fill("");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await list.getByRole("link", { name: "Native JSON note", exact: true }).click();
  await expect(page).toHaveURL(/record=native/);
  expect(new URL(page.url()).searchParams.get("document")).toBeNull();
  expect(new URL(page.url()).searchParams.get("keep")).toBe("value");
  expect(new URL(page.url()).hash).toBe("");
  expect(fixture.errors).toEqual([]);
});

test("native JSON stays plain text, imported fallback is translated, and mobile reader focus stays in context", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mountReading(page);
  await page.getByRole("link", { name: "Native JSON note", exact: true }).click();
  const reader = page.locator("[data-memory-detail]");
  await expect(reader.getByRole("heading", { name: "Native JSON note" })).toBeFocused();
  await expect(reader.getByText(nativeBody, { exact: true })).toBeVisible();
  await expect(reader.getByText("Original imported payload")).toHaveCount(0);
  await reader.getByRole("button", { name: "Edit memory" }).click();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(nativeBody);
  await page.getByRole("dialog").getByRole("button", { name: "Close and keep draft", exact: true }).click();
  await reader.getByRole("button", { name: "Back to list" }).click();
  await expect(page.getByRole("link", { name: "Native JSON note", exact: true })).toBeFocused();
  await page.getByRole("link", { name: "Text import", exact: true }).click();
  await expect(reader.getByText("Plain imported context", { exact: true })).toBeVisible();
  await expect(reader.getByText("Original imported payload")).toHaveCount(0);
  await reader.getByRole("button", { name: "Back to list" }).click();
  await page.getByRole("link", { name: "Empty imported note", exact: true }).click();
  await expect(reader.getByText("This imported note contains documents and source details.", { exact: true })).toBeVisible();
  await selectLanguage(page);
  await expect(reader.getByText("Ta importowana notatka zawiera dokumenty i szczegóły źródłowe.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.errors).toEqual([]);
});
