import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dashboardFixture, mountDashboard } from "./dashboard-fixture";
import { openPreferences } from "./shell-actions";

const project = { id: "knowledge-only", name: "Knowledge", status: "active", writable: true, revision: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const note = { id: "memory-1", projectId: project.id, title: "Storage decision", body: "Read the plan attached to this note.", category: "decision", tags: [], legacyId: null, sources: [], status: "active", supersededBy: null, approval: null, revision: 1, createdBy: "owner", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const markdown = "# Storage plan\n\n| Stage | Result |\n| --- | --- |\n| One | SQLite |\n\n```ts\nconst owner = true;\n```\n\n[Portability](./database-portability.md)\n\n[Jump](#storage-plan)\n\n![Diagram](../assets/diagram.png)\n\n[Unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n![Remote](https://tracker.example/remote.png)"
  + Array.from({ length: 80 }, (_, index) => `\n\nParagraph ${index + 1}: a document remains readable during routine refreshes.`).join("");
const bytesById: Record<string, Buffer> = {
  plan: Buffer.from(markdown),
  portability: Buffer.from("# Portability\n\nOne controller owns SQLite."),
  diagram: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9/78cAAAAASUVORK5CYII=", "base64"),
  invalid: Buffer.from([0xc3, 0x28]),
};
const files = [
  { id: "plan", projectId: project.id, recordKind: "memory", recordId: note.id, filename: "implementation-plan.md", relativePath: "notes/implementation-plan.md", mediaType: "application/octet-stream", size: bytesById.plan.length, sha256: "p", createdBy: "owner", createdAt: "2026-01-01" },
  { id: "portability", projectId: project.id, recordKind: "memory", recordId: note.id, filename: "database-portability.md", relativePath: "notes/database-portability.md", mediaType: "application/octet-stream", size: bytesById.portability.length, sha256: "q", createdBy: "owner", createdAt: "2026-01-01" },
  { id: "diagram", projectId: project.id, recordKind: "memory", recordId: note.id, filename: "diagram.png", relativePath: "assets/diagram.png", mediaType: "application/octet-stream", size: bytesById.diagram.length, sha256: "r", createdBy: "owner", createdAt: "2026-01-01" },
  { id: "invalid", projectId: project.id, recordKind: "memory", recordId: note.id, filename: "invalid.txt", relativePath: "notes/invalid.txt", mediaType: "text/plain", size: bytesById.invalid.length, sha256: "s", createdBy: "owner", createdAt: "2026-01-01" },
  { id: "huge", projectId: project.id, recordKind: "memory", recordId: note.id, filename: "huge.md", relativePath: "notes/huge.md", mediaType: "text/markdown", size: 256 * 1024 + 1, sha256: "t", createdBy: "owner", createdAt: "2026-01-01" },
];

async function mountDocuments(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem("worktree-switcher-knowledge-token", "knowledge-fixture"));
  const data = dashboardFixture(); data.projects = [];
  const fixture = await mountDashboard(page, data);
  const requests: Array<{ operation: string; input: Record<string, unknown>; token: string }> = [];
  let denied = false;
  let denyListing = false;
  let listedFiles = files;
  let listingGate: Promise<void> | null = null;
  let completedListings = 0;
  let pendingListings = 0;
  await page.route("**/api/identity", route => route.fulfill({ json: { principal: { id: "owner", kind: "owner" }, credential: { kind: "owner_session" } } }));
  await page.route("**/api/knowledge", async route => {
    const { operation, input } = route.request().postDataJSON();
    requests.push({ operation, input, token: route.request().headers().authorization ?? "" });
    const result = (items: unknown[]) => ({ items, nextOffset: null });
    if (operation === "projects") return route.fulfill({ json: result([project]) });
    if (operation === "project") return route.fulfill({ json: project });
    if (operation === "search") return route.fulfill({ json: result([{ ...note, kind: "memory", excerpt: note.body, threadId: null }]) });
    if (operation === "memory") return route.fulfill({ json: note });
    if (operation === "history") return route.fulfill({ json: result([]) });
    if (operation === "attachments") {
      pendingListings += 1;
      try {
        if (listingGate) await listingGate;
        if (denyListing) await route.fulfill({ status: 403, json: { code: "forbidden", error: "Denied" } });
        else await route.fulfill({ json: result(listedFiles) });
        completedListings += 1;
      } catch { /* A newer refresh may abort an earlier listing request. */ }
      finally { pendingListings -= 1; }
      return;
    }
    if (operation === "attachment") {
      if (denied) return route.fulfill({ status: 403, json: { code: "forbidden", error: "Denied" } });
      const file = listedFiles.find(item => item.id === input.attachmentId);
      if (!file) return route.fulfill({ status: 404, json: { code: "not_found", error: "Not found" } });
      return route.fulfill({ json: { attachment: file, dataBase64: bytesById[file.id]?.toString("base64") ?? "" } });
    }
    return route.fulfill({ status: 404, json: { code: "not_found", error: "Not found" } });
  });
  const navigation = page.getByRole("button", { name: "Knowledge", exact: true });
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await navigation.click();
  await expect(page.getByLabel("Knowledge project", { exact: true })).toHaveValue(project.id);
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await page.getByRole("link", { name: note.title, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  return { ...fixture, requests, deny: (value: boolean) => { denied = value; }, denyListing: (value: boolean) => { denyListing = value; },
    setListing: (value: typeof files) => { listedFiles = value; }, completedListings: () => completedListings, pendingListings: () => pendingListings,
    holdListings: () => { let release!: () => void; listingGate = new Promise<void>(resolve => { release = resolve; }); return () => { listingGate = null; release(); }; } };
}

async function refreshKnowledge(page: Page, projectIds = ["knowledge-only"]) {
  await page.evaluate(ids => (window as unknown as { fixtureEvents: { emit: (event: string, value: unknown) => void } }).fixtureEvents.emit("knowledge-changed", { projectIds: ids }), projectIds);
}

test("Markdown document opens by URL, links only to an authorized sibling, and Back restores the note", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mountDocuments(page);
  await page.getByRole("link", { name: "Open: implementation-plan.md" }).click();
  await expect(page).toHaveURL(/document=plan/);
  await expect(page.getByRole("heading", { name: "Storage plan" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Document table" })).toContainText("SQLite");
  await expect(page.getByRole("region", { name: "Document code" })).toContainText("const owner = true");
  await expect(page.getByRole("img", { name: "Diagram" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Jump" })).toHaveAttribute("href", "#storage-plan");
  await page.getByRole("link", { name: "Jump" }).click();
  await expect(page).toHaveURL(/#storage-plan$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Storage plan" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Portability" })).toHaveAttribute("href", /document=portability/);
  await expect(page.locator("a[href^='javascript:']")).toHaveCount(0);
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("[data-memory-detail]").getByText(note.body)).toBeHidden();
  await expect(page.getByText("Remote — Linked document is unavailable in this note.")).toBeVisible();
  await expect(page.locator("img[src^='https://tracker.example']")).toHaveCount(0);
  expect([...new Set(fixture.requests.filter(call => call.operation === "attachment").map(call => call.input.attachmentId))].sort()).toEqual(["diagram", "plan"]);
  expect((await page.getByRole("region", { name: "Document table" }).boundingBox())!.width).toBeLessThan(390);
  await page.getByRole("link", { name: "Portability" }).click();
  await expect(page).toHaveURL(/document=portability/);
  await expect(page.getByText("One controller owns SQLite.")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Storage plan" })).toBeVisible();
  await page.getByRole("button", { name: "Back to note" }).click();
  await expect(page).not.toHaveURL(/document=/);
  await expect(page.locator("[data-memory-detail]").getByText(note.body)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open: implementation-plan.md" })).toBeFocused();
  expect(fixture.errors).toEqual([]);
});

test("deep links require the parent listing and denied or unknown documents show no body", async ({ page }) => {
  const fixture = await mountDocuments(page);
  await page.goto(`http://switcher.test/?view=knowledge&knowledgeProject=${project.id}&knowledgeTab=memory&record=${note.id}&document=foreign`);
  await expect(page.getByText("Document is unavailable in this note.", { exact: true }).last()).toBeVisible();
  expect(fixture.requests.filter(call => call.operation === "attachment" && call.input.attachmentId === "foreign")).toHaveLength(0);
  fixture.deny(true);
  await page.goto(`http://switcher.test/?view=knowledge&knowledgeProject=${project.id}&knowledgeTab=memory&record=${note.id}&document=plan`);
  await expect(page.getByText("Could not read document.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Storage plan" })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test("download retains the original bytes even when a document has a preview", async ({ page }) => {
  const fixture = await mountDocuments(page);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download: implementation-plan.md" }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe("implementation-plan.md");
  expect(await readFile((await downloaded.path())!, "utf8")).toBe(markdown);
  expect(fixture.requests.filter(call => call.operation === "attachment").map(call => call.input.attachmentId)).toEqual(["plan"]);
  expect(fixture.errors).toEqual([]);
});

test("invalid text and oversized documents offer download without fetching oversized preview bytes", async ({ page }) => {
  const fixture = await mountDocuments(page);
  await page.getByRole("link", { name: "Open: invalid.txt" }).click();
  await expect(page.getByText("Document is damaged or is not valid UTF-8 text.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download: invalid.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Back to note" }).click();
  await page.getByRole("link", { name: "Open: huge.md" }).click();
  await expect(page.getByText("Document is too large to preview.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download: huge.md" })).toBeVisible();
  expect(fixture.requests.filter(call => call.operation === "attachment" && call.input.attachmentId === "huge")).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test("signing out clears an open document before a different credential can read it", async ({ page }) => {
  const fixture = await mountDocuments(page);
  await page.getByRole("link", { name: "Open: implementation-plan.md" }).click();
  await expect(page.getByRole("heading", { name: "Storage plan" })).toBeVisible();
  await openPreferences(page);
  await page.getByRole("menuitem", { name: "Disconnect Knowledge access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage plan" })).toHaveCount(0);
  fixture.deny(true);
  await page.getByLabel("Knowledge credential", { exact: true }).fill("second-credential");
  await page.getByRole("button", { name: "Sign in to knowledge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage plan" })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test("routine refresh preserves an open document, while changed or denied listings invalidate it", async ({ page }) => {
  const fixture = await mountDocuments(page);
  await page.getByRole("link", { name: "Open: implementation-plan.md" }).click();
  const code = page.getByRole("region", { name: "Document code" });
  await expect(code).toContainText("const owner = true");
  await expect(page.getByRole("img", { name: "Diagram" })).toBeVisible();
  await code.focus();
  const reader = page.locator("[data-memory-detail]");
  await reader.evaluate(element => { element.scrollTop = 400; });
  const previousScroll = await reader.evaluate(element => element.scrollTop);
  expect(previousScroll).toBeGreaterThan(0);
  const previewReads = fixture.requests.filter(call => call.operation === "attachment").length;
  const initialListings = fixture.requests.filter(call => call.operation === "attachments").length;
  await refreshKnowledge(page, ["unrelated-project"]);
  await expect.poll(() => fixture.requests.filter(call => call.operation === "attachments").length).toBeGreaterThan(initialListings);
  await expect.poll(() => fixture.pendingListings()).toBe(0);
  expect(fixture.requests.filter(call => call.operation === "attachment")).toHaveLength(previewReads);
  await expect(code).toBeFocused();
  expect(await reader.evaluate(element => element.scrollTop)).toBe(previousScroll);
  const listingBaseline = fixture.requests.filter(call => call.operation === "attachments").length;
  const release = fixture.holdListings();
  await refreshKnowledge(page);
  await expect.poll(() => fixture.requests.filter(call => call.operation === "attachments").length).toBeGreaterThan(listingBaseline);
  await expect.poll(() => fixture.pendingListings()).toBeGreaterThan(0);
  await expect(code).toBeVisible();
  await expect(code).toBeFocused();
  expect(await reader.evaluate(element => element.scrollTop)).toBe(previousScroll);
  expect(fixture.requests.filter(call => call.operation === "attachment")).toHaveLength(previewReads);
  release();
  await expect.poll(() => fixture.pendingListings()).toBe(0);
  await expect(code).toBeVisible();
  await expect(code).toBeFocused();
  expect(await reader.evaluate(element => element.scrollTop)).toBe(previousScroll);
  expect(fixture.requests.filter(call => call.operation === "attachment")).toHaveLength(previewReads);

  fixture.setListing(files.map(file => file.id === "plan" ? { ...file, sha256: "changed" } : file));
  await refreshKnowledge(page);
  await expect.poll(() => fixture.requests.filter(call => call.operation === "attachment" && call.input.attachmentId === "plan").length).toBe(2);
  await expect(code).toBeVisible();

  fixture.setListing(files.filter(file => file.id !== "plan"));
  await refreshKnowledge(page);
  await expect(page.getByText("Document is unavailable in this note.", { exact: true }).last()).toBeVisible();
  await expect(code).toHaveCount(0);

  fixture.setListing(files);
  await refreshKnowledge(page);
  await expect(code).toBeVisible();
  fixture.denyListing(true);
  await refreshKnowledge(page);
  await expect(page.getByText("Could not read attachments.", { exact: false })).toBeVisible();
  await expect(code).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});
