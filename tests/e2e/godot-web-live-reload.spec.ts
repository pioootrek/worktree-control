import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";

import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";

/**
 * Browser acceptance of the godot-web runtime through a real controller: the
 * bundled static server, the queued project-owned exporter, publication and the
 * injected live-reload client.
 *
 * Without extra setup the exporter publishes a small synthetic Web export. To
 * also start a real Godot engine, place a flat Godot Web export (index.html,
 * index.js, index.wasm, index.pck) in `.godot-web-acceptance/export/` at the
 * repository root or point WTC_GODOT_WEB_EXPORT at one. The directory is
 * Git-ignored and only read.
 *
 * The standard `preset` exporter needs a Godot binary with matching Web export
 * templates. Link it as `.godot-web-acceptance/godot` or set
 * WTC_GODOT_EXECUTABLE; otherwise that test is skipped.
 */
const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const realExport = resolve(process.env.WTC_GODOT_WEB_EXPORT ?? join(repositoryRoot, ".godot-web-acceptance/export"));
const usesRealEngine = ["index.html", "index.js", "index.wasm", "index.pck"].every((file) => existsSync(join(realExport, file)));
// A non-loopback name for the same listener: Chromium treats it as an ordinary
// plain-HTTP origin, like a LAN address or local hostname.
const LAN_LIKE_HOST = "wtc-godot-lan.test";
const godotExecutable = (() => {
  const candidate = resolve(process.env.WTC_GODOT_EXECUTABLE ?? join(repositoryRoot, ".godot-web-acceptance/godot"));
  try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { return null; }
})();

test.use({ launchOptions: { args: [`--host-resolver-rules=MAP ${LAN_LIKE_HOST} 127.0.0.1`, "--enable-unsafe-swiftshader"] } });

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a preview port."));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd });
}

/**
 * A Git game repository whose exporter copies a template export and stamps the source version into it.
 * A version starting with `hold` waits for a `release` file in the worktree root; one containing `fail` exits non-zero.
 */
async function createGame(base: string, options: { synthetic?: boolean } = {}): Promise<{ repository: string; template: string }> {
  const repository = join(base, "game-repository");
  const synthetic = options.synthetic || !usesRealEngine;
  const template = synthetic ? join(base, "synthetic-export") : realExport;
  if (synthetic) {
    await mkdir(template, { recursive: true });
    await writeFile(join(template, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic export</title></head><body><canvas id="canvas"></canvas><script src="index.js"></script></body></html>');
    await writeFile(join(template, "index.js"), "window.syntheticEngineStarted = true;\n");
    await writeFile(join(template, "index.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    await writeFile(join(template, "index.pck"), "synthetic pack");
  }
  await mkdir(join(repository, "game"), { recursive: true });
  await git(base, "init", "--quiet", "-b", "main", repository);
  await writeFile(join(repository, "project.godot"), "config_version=5\n");
  await writeFile(join(repository, ".gitignore"), "/exports/\n/.godot/\n/release\n");
  await writeFile(join(repository, "game/version.txt"), "v1\n");
  await writeFile(join(repository, "export.mjs"), `import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const version = readFileSync("game/version.txt", "utf8").trim();
while (version.startsWith("hold") && !existsSync("release")) await new Promise((resolve) => setTimeout(resolve, 100));
if (version.includes("fail")) { console.error("fixture exporter failed for " + version); process.exit(3); }
rmSync("exports/web", { recursive: true, force: true });
cpSync(${JSON.stringify(template)}, "exports/web", { recursive: true });
const html = readFileSync("exports/web/index.html", "utf8");
writeFileSync("exports/web/index.html", html.replace(/<\\/head>/i, '<meta name="fixture-version" content="' + version + '"></head>'));
// Project wrappers may record machine-local provenance; the controller must not publish it.
writeFileSync("exports/web/build.json", JSON.stringify({ report_path: "/private/report/" + version }));
console.log("fixture exporter wrote " + version);
`);
  await git(repository, "add", ".");
  await git(repository, "commit", "--quiet", "-m", "fixture game");
  return { repository, template };
}

async function version(page: Page): Promise<string | null> {
  return page.locator('meta[name="fixture-version"]').getAttribute("content", { timeout: 1_000 }).catch(() => null);
}

function generationOf(url: string): string {
  const match = new URL(url).pathname.match(/^\/g\/([^/]+)\//);
  if (!match) throw new Error(`Not a generation URL: ${url}`);
  return match[1]!;
}

interface WebExport { state: string; current: { id: string } | null; lastRunId: string | null; lastFailure: { code: string } | null; activeRunId: string | null; pendingRebuild: boolean }

test("a real controller exports through the queue and the browser live-reloads complete generations", async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  const base = await mkdtemp(join(tmpdir(), "wtc-godot-web-e2e-"));
  let fixture: ControllerFixture | undefined;
  const consoleLines: string[] = [];
  let engineLines = 0;
  page.on("console", (message) => {
    if (/^Godot Engine v4\.\d+/.test(message.text())) engineLines += 1;
    if (consoleLines.length < 400) consoleLines.push(`[${message.type()}] ${message.text()}`);
  });
  const engineStarts = () => engineLines;
  try {
    fixture = await startControllerFixture(0);
    const { repository } = await createGame(base);
    const port = await freePort();
    const preview = `http://localhost:${port}`;
    const config = { exporter: { kind: "command", command: ["node", "export.mjs"], outputDirectory: "exports/web" }, watch: { paths: ["game"], debounceMs: 200 } };
    const { project } = await fixture.request<{ project: { id: string } }>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Godot game", repositoryPath: repository, port, launchPreset: "godot-web", godotWeb: config }) });
    // Keep the test listener on loopback; the LAN-like check uses a mapped hostname instead of a real interface.
    await fixture.request(`/api/projects/${project.id}/environment`, { method: "POST", body: JSON.stringify({ environment: { HOST: "127.0.0.1" } }) });
    const status = async () => (await fixture!.request<{ webExport: WebExport }>(`/api/projects/${project.id}/godot-web`)).webExport;
    const settled = (predicate: (value: WebExport) => boolean, message: string) => waitFor(async () => {
      const value = await status();
      return predicate(value) && !value.activeRunId && !value.pendingRebuild ? value : null;
    }, 60_000, () => `${message}\n${fixture!.diagnostics()}`);
    const edit = (value: string) => writeFile(join(repository, "game/version.txt"), `${value}\n`);

    await fixture.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "start", worktreePath: repository }) });
    const first = await settled((value) => value.state === "ready" && value.current !== null, "The first export was not published.");

    // Every export is a finite job in the shared queue; MCP sees the same state.
    const mcp = await fixture.mcp();
    try {
      const run = await mcp.call<{ presetId: string; phase: string; source: { attribution: string } }>("get_test_run", { runId: first.lastRunId });
      expect(run).toMatchObject({ presetId: "godot:web-export", phase: "passed", source: { attribution: "observed_match" } });
      expect((await mcp.call<{ webExport: WebExport }>("get_web_export_status", { projectId: project.id })).webExport.current?.id).toBe(first.current!.id);
    } finally { await mcp.close(); }

    // Headers and isolation on localhost, once the static server has observed the publication.
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).catch(() => null))?.status === 302 ? true : null, 10_000, () => "The static server did not serve the first generation.");
    const response = await page.goto(`${preview}/`);
    expect(response?.url()).toBe(`${preview}/g/${first.current!.id}/`);
    const html = response!.headers();
    expect(html).toMatchObject({ "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "x-content-type-options": "nosniff", "cache-control": "no-cache" });
    await expect.poll(() => version(page)).toBe("v1");
    const wasm = await page.request.get(`${preview}/g/${first.current!.id}/index.wasm`);
    expect(wasm.headers()).toMatchObject({ "content-type": "application/wasm", "cross-origin-resource-policy": "same-origin", "cache-control": "public, max-age=31536000, immutable" });
    expect((await page.request.get(`${preview}/g/${first.current!.id}/build.json`)).status()).toBe(404);
    const state = await (await page.request.get(`${preview}/__wtc/state`)).text();
    expect(state).not.toContain(base);
    expect(state).not.toContain("report");
    expect(await page.evaluate(() => ({ secure: window.isSecureContext, isolated: window.crossOriginIsolated, shared: typeof SharedArrayBuffer }))).toEqual({ secure: true, isolated: true, shared: "function" });

    const overlay = page.getByRole("region", { name: "Godot Web preview status" });
    await expect(overlay.getByRole("status")).toHaveText("Live preview");
    if (usesRealEngine) {
      await expect.poll(engineStarts, { timeout: 45_000, message: "The Godot engine did not start." }).toBeGreaterThan(0);
      // The shell removes its loading overlay only after the engine has started.
      await expect(page.locator("#status")).toHaveCount(0, { timeout: 45_000 });
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: testInfo.outputPath("godot-engine-localhost.png") });
    } else {
      expect(await page.evaluate(() => (window as unknown as { syntheticEngineStarted?: boolean }).syntheticEngineStarted)).toBe(true);
    }

    // A source save queues an export; the new generation's SSE event reloads the whole page.
    await page.evaluate(() => { (window as unknown as { pageMarker?: string }).pageMarker = "before-reload"; });
    const enginesBeforeReload = engineStarts();
    const reloaded = page.waitForURL((url) => url.pathname.startsWith("/g/") && generationOf(url.href) !== first.current!.id, { timeout: 60_000 });
    await edit("v2");
    await reloaded;
    await expect.poll(() => version(page)).toBe("v2");
    expect(await page.evaluate(() => (window as unknown as { pageMarker?: string }).pageMarker)).toBeUndefined();
    // Live reload restarts the game: the engine boots again in the new page.
    if (usesRealEngine) await expect.poll(engineStarts, { timeout: 45_000 }).toBeGreaterThan(enginesBeforeReload);
    const second = await settled((value) => value.state === "ready" && value.current?.id !== first.current!.id, "The second export was not published.");
    expect(generationOf(page.url())).toBe(second.current!.id);

    // Auto-reload off survives a manual reload and stops automatic navigation.
    const autoReload = overlay.getByRole("checkbox", { name: "Auto-reload" });
    await expect(autoReload).toBeChecked();
    await autoReload.uncheck();
    await page.reload();
    await expect(autoReload).not.toBeChecked();
    await page.evaluate(() => { (window as unknown as { pageMarker?: string }).pageMarker = "auto-off"; });
    await edit("v3");
    const third = await settled((value) => value.state === "ready" && value.current?.id !== second.current!.id, "The third export was not published.");
    await expect(overlay.getByRole("status")).toHaveText("A new build is ready", { timeout: 15_000 });
    expect(generationOf(page.url())).toBe(second.current!.id);
    expect(await page.evaluate(() => (window as unknown as { pageMarker?: string }).pageMarker)).toBe("auto-off");
    await overlay.getByRole("button", { name: "Reload", exact: true }).click();
    await page.waitForURL(`${preview}/g/${third.current!.id}/`);
    await expect.poll(() => version(page)).toBe("v3");
    await expect(autoReload).not.toBeChecked();

    // A failed export keeps serving the last complete generation.
    await page.evaluate(() => { (window as unknown as { pageMarker?: string }).pageMarker = "before-failure"; });
    await edit("fail-4");
    const failed = await settled((value) => value.state === "failed", "The failing export did not finish.");
    expect(failed).toMatchObject({ current: { id: third.current!.id }, lastFailure: { code: "export_failed" } });
    await expect(overlay.getByRole("status")).toHaveText("Export failed — previous build kept", { timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { pageMarker?: string }).pageMarker)).toBe("before-failure");
    const kept = await page.request.get(`${preview}/`, { maxRedirects: 0 });
    expect(kept.headers().location).toBe(`/g/${third.current!.id}/`);
    const keptPage = await browser.newPage();
    try {
      await keptPage.goto(`${preview}/`);
      await expect.poll(() => version(keptPage)).toBe("v3");
    } finally { await keptPage.close(); }

    // Turning auto-reload back on applies the latest state; the next good export reloads again.
    await autoReload.check();
    const enginesBeforeRecovery = engineStarts();
    const recovered = page.waitForURL((url) => url.pathname.startsWith("/g/") && generationOf(url.href) !== third.current!.id, { timeout: 60_000 });
    await edit("v5");
    await recovered;
    await expect.poll(() => version(page)).toBe("v5");
    if (usesRealEngine) await expect.poll(engineStarts, { timeout: 45_000 }).toBeGreaterThan(enginesBeforeRecovery);

    // Plain HTTP on a non-loopback name is not a secure context: COOP/COEP cannot isolate it,
    // while the static server and live-reload stream still work.
    const lan = await browser.newPage();
    const lanConsole: string[] = [];
    lan.on("console", (message) => { lanConsole.push(message.text()); });
    try {
      await lan.goto(`http://${LAN_LIKE_HOST}:${port}/`);
      await expect.poll(() => version(lan)).toBe("v5");
      expect(await lan.evaluate(() => ({ secure: window.isSecureContext, isolated: window.crossOriginIsolated, shared: typeof SharedArrayBuffer }))).toEqual({ secure: false, isolated: false, shared: "undefined" });
      await expect(lan.getByRole("region", { name: "Godot Web preview status" }).getByRole("status")).toHaveText("Live preview");
      if (usesRealEngine) {
        // Godot 4 Web shells require a secure context even for single-threaded exports.
        await expect(lan.locator("#status-notice")).toContainText("Secure Context", { timeout: 20_000 });
        expect(lanConsole.some((line) => /Godot Engine v4\.\d+/.test(line))).toBe(false);
        await lan.screenshot({ path: testInfo.outputPath("godot-engine-lan-like.png") });
      }
    } finally { await lan.close(); }

    await fixture.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "stop" }) });
    await settled((value) => value.state === "stopped", "The preview did not stop.");
    await expect(page.request.get(`${preview}/`, { timeout: 3_000 })).rejects.toThrow();
    testInfo.annotations.push({ type: "engine", description: usesRealEngine ? "real Godot Web export" : "synthetic export" });
  } finally {
    await testInfo.attach("browser-console.txt", { body: consoleLines.join("\n"), contentType: "text/plain" }).catch(() => undefined);
    await page.close();
    await fixture?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("the standard preset exporter runs a real Godot export through the queue and reloads the engine", async ({ page }, testInfo) => {
  test.skip(!godotExecutable, "No Godot executable: link .godot-web-acceptance/godot or set WTC_GODOT_EXECUTABLE.");
  test.setTimeout(150_000);
  const base = await mkdtemp(join(tmpdir(), "wtc-godot-web-preset-"));
  let fixture: ControllerFixture | undefined;
  const prints: string[] = [];
  page.on("console", (message) => { prints.push(message.text()); });
  try {
    fixture = await startControllerFixture(0);
    const repository = join(base, "tiny-game");
    await mkdir(repository, { recursive: true });
    await git(base, "init", "--quiet", "-b", "main", repository);
    await writeFile(join(repository, ".gitignore"), "/.godot/\n");
    await writeFile(join(repository, "project.godot"), [
      "config_version=5", "", "[application]", 'config/name="WTC Godot Web acceptance"', 'run/main_scene="res://main.tscn"',
      'config/features=PackedStringArray("4.7", "GL Compatibility")', "", "[rendering]",
      'renderer/rendering_method="gl_compatibility"', 'renderer/rendering_method.mobile="gl_compatibility"', "",
    ].join("\n"));
    await writeFile(join(repository, "main.tscn"), [
      "[gd_scene load_steps=2 format=3]", "", '[ext_resource type="Script" path="res://main.gd" id="1"]', "",
      '[node name="Main" type="Node2D"]', 'script = ExtResource("1")', "",
    ].join("\n"));
    const script = (value: string) => writeFile(join(repository, "main.gd"), `extends Node2D\n\nfunc _ready() -> void:\n\tprint("wtc-fixture ${value}")\n`);
    await script("v1");
    await writeFile(join(repository, "export_presets.cfg"), [
      "[preset.0]", "", 'name="Web"', 'platform="Web"', "runnable=true", 'export_filter="all_resources"', 'include_filter=""', 'exclude_filter=""', 'export_path=""', "",
      "[preset.0.options]", "", "variant/extensions_support=false", "variant/thread_support=false", "progressive_web_app/enabled=false", "",
    ].join("\n"));
    await git(repository, "add", ".");
    await git(repository, "commit", "--quiet", "-m", "tiny game");
    const port = await freePort();
    const config = { exporter: { kind: "preset", preset: "Web", godotExecutable }, watch: { paths: ["."], debounceMs: 200 } };
    const { project } = await fixture.request<{ project: { id: string } }>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Tiny game", repositoryPath: repository, port, launchPreset: "godot-web", godotWeb: config }) });
    await fixture.request(`/api/projects/${project.id}/environment`, { method: "POST", body: JSON.stringify({ environment: { HOST: "127.0.0.1" } }) });
    const status = async () => (await fixture!.request<{ webExport: WebExport }>(`/api/projects/${project.id}/godot-web`)).webExport;
    let last: WebExport | null = null;
    const settled = (predicate: (value: WebExport) => boolean, message: string) => waitFor(async () => {
      const value = last = await status();
      return predicate(value) && !value.activeRunId && !value.pendingRebuild ? value : null;
    }, 100_000, () => `${message}\n${JSON.stringify(last)}\n${fixture!.diagnostics()}`);

    await fixture.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "start", worktreePath: repository }) });
    const first = await settled((current) => current.state === "ready", "The first Godot export was not published.");
    const mcp = await fixture.mcp();
    try {
      const run = await mcp.call<{ presetId: string; processOutcome?: string; source: { processOutcome: string } }>("get_test_run", { runId: first.lastRunId });
      await testInfo.attach("first-export-run.json", { body: JSON.stringify(run, null, 2), contentType: "application/json" });
      expect(run).toMatchObject({ presetId: "godot:web-export", source: { processOutcome: "passed" } });
    } finally { await mcp.close(); }

    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).catch(() => null))?.status === 302 ? true : null, 10_000, () => "The static server did not serve the first generation.");
    await page.goto(`http://localhost:${port}/`);
    await expect.poll(() => prints.some((line) => line === "wtc-fixture v1"), { timeout: 45_000, message: "The exported script did not run." }).toBe(true);
    expect(prints.some((line) => /^Godot Engine v4\.\d+/.test(line))).toBe(true);
    await expect(page.locator("#status")).toHaveCount(0, { timeout: 45_000 });

    const reloaded = page.waitForURL((url) => url.pathname.startsWith("/g/") && generationOf(url.href) !== first.current!.id, { timeout: 100_000 });
    await script("v2");
    await reloaded;
    await expect.poll(() => prints.some((line) => line === "wtc-fixture v2"), { timeout: 45_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("godot-preset-export.png") });
    await settled((current) => current.state === "ready" && current.current?.id !== first.current!.id, "The second Godot export was not published.");

    await fixture.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify({ operation: "stop" }) });
    await settled((current) => current.state === "stopped", "The preview did not stop.");
  } finally {
    await testInfo.attach("browser-console.txt", { body: prints.slice(0, 400).join("\n"), contentType: "text/plain" }).catch(() => undefined);
    await page.close();
    await fixture?.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("an open tab leaves the previous worktree's build on a runtime switch while same-worktree restarts keep gameplay", async ({ page }) => {
  test.setTimeout(120_000);
  const base = await mkdtemp(join(tmpdir(), "wtc-godot-web-switch-"));
  let fixture: ControllerFixture | undefined;
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  try {
    fixture = await startControllerFixture(0);
    // Switch coverage needs no engine; the synthetic export keeps it fast and portable.
    const { repository } = await createGame(base, { synthetic: true });
    await writeFile(join(repository, "game/version.txt"), "a1\n");
    const alternate = join(base, "game-feature");
    await git(repository, "worktree", "add", "--quiet", "-b", "feature", alternate);
    // The feature worktree's first export is held until released, then fails.
    await writeFile(join(alternate, "game/version.txt"), "hold-fail\n");
    const port = await freePort();
    const preview = `http://localhost:${port}`;
    const config = { exporter: { kind: "command", command: ["node", "export.mjs"], outputDirectory: "exports/web" }, watch: { paths: ["game"], debounceMs: 200 } };
    const { project } = await fixture.request<{ project: { id: string } }>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Switched game", repositoryPath: repository, port, launchPreset: "godot-web", godotWeb: config }) });
    await fixture.request(`/api/projects/${project.id}/environment`, { method: "POST", body: JSON.stringify({ environment: { HOST: "127.0.0.1" } }) });
    const status = async () => (await fixture!.request<{ webExport: WebExport }>(`/api/projects/${project.id}/godot-web`)).webExport;
    const settled = (predicate: (value: WebExport) => boolean, message: string) => waitFor(async () => {
      const value = await status();
      return predicate(value) && !value.activeRunId && !value.pendingRebuild ? value : null;
    }, 60_000, () => `${message}\n${fixture!.diagnostics()}`);
    const operation = (body: Record<string, string>) => fixture!.request(`/api/projects/${project.id}/operation`, { method: "POST", body: JSON.stringify(body) });
    const served = (generation: string) => waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" }).catch(() => null))?.headers.get("location") === `/g/${generation}/` ? true : null, 15_000, () => `The static server did not serve ${generation}.`);
    const marker = () => page.evaluate(() => (window as unknown as { pageMarker?: string }).pageMarker);
    const mark = (value: string) => page.evaluate((text) => { (window as unknown as { pageMarker?: string }).pageMarker = text; }, value);
    const overlay = page.getByRole("region", { name: "Godot Web preview status" });
    const autoReload = overlay.getByRole("checkbox", { name: "Auto-reload" });

    await operation({ operation: "start", worktreePath: repository });
    const a1 = await settled((value) => value.state === "ready" && value.current !== null, "The main worktree's first export was not published.");
    await served(a1.current!.id);
    await page.goto(`${preview}/`);
    await page.waitForURL(`${preview}/g/${a1.current!.id}/`);
    await expect.poll(() => version(page)).toBe("a1");
    await expect(overlay.getByRole("status")).toHaveText("Live preview");
    await autoReload.uncheck();
    await mark("playing-a1");

    // A restart of the same worktree reconnects the stream; the page keeps playing and
    // only offers the new build. No restart-only reload.
    await operation({ operation: "restart" });
    const a2 = await settled((value) => value.state === "ready" && value.current !== null && value.current.id !== a1.current!.id, "The restarted preview did not publish.");
    await expect(overlay.getByRole("status")).toHaveText("A new build is ready", { timeout: 15_000 });
    expect(page.url()).toBe(`${preview}/g/${a1.current!.id}/`);
    expect(await marker()).toBe("playing-a1");

    // Switch while the feature worktree's first export is still running: the old tab leaves
    // the main worktree's game at once, although auto-reload is off and nothing new is published.
    const beforeSwitch = navigations.length;
    await operation({ operation: "switch", worktreePath: alternate });
    await page.waitForURL(`${preview}/`, { timeout: 20_000 });
    const held = await waitFor(async () => { const value = await status(); return value.activeRunId ? value : null; }, 15_000, () => "The feature export did not start.");
    expect(held.current).toBeNull();
    expect(navigations.slice(beforeSwitch)).toEqual([`${preview}/`]);
    expect(await marker()).toBeUndefined();
    await expect(overlay.getByRole("status")).toHaveText("Web export in progress…", { timeout: 10_000 });
    await expect(autoReload).not.toBeChecked();
    expect((await page.request.get(`${preview}/g/${a2.current!.id}/index.js`)).status()).toBe(410);

    // The first export of the new worktree fails: the placeholder says so and does not reload.
    await writeFile(join(alternate, "release"), "");
    await settled((value) => value.state === "failed", "The held feature export did not fail.");
    await expect(overlay.getByRole("status")).toHaveText("Export failed — waiting for a successful export", { timeout: 10_000 });
    const afterFailure = navigations.length;
    await page.waitForTimeout(4_000);
    expect(navigations.length).toBe(afterFailure);
    expect(page.url()).toBe(`${preview}/`);

    // A fixed export loads the new worktree's first build from the placeholder.
    await writeFile(join(alternate, "game/version.txt"), "b1\n");
    const b1 = await settled((value) => value.state === "ready" && value.current !== null, "The feature worktree did not publish.");
    await page.waitForURL(`${preview}/g/${b1.current!.id}/`, { timeout: 20_000 });
    await expect.poll(() => version(page)).toBe("b1");
    await expect(overlay.getByRole("status")).toHaveText("Live preview");
    await mark("playing-b1");

    // Switch back while the tab cannot reach the stream, so its first reconnect already sees
    // the main worktree's newly published generation. With auto-reload off it must still leave
    // the feature build rather than offer the other worktree's build as an update to it.
    await page.route("**/__wtc/events*", (route) => route.abort());
    await operation({ operation: "switch", worktreePath: repository });
    const a3 = await settled((value) => value.state === "ready" && value.current !== null && value.current.id !== b1.current!.id, "The main worktree did not publish after switching back.");
    await served(a3.current!.id);
    await expect(overlay.getByRole("status")).toHaveText("Preview server unreachable", { timeout: 10_000 });
    expect(page.url()).toBe(`${preview}/g/${b1.current!.id}/`);
    await page.unroute("**/__wtc/events*");
    await page.waitForURL(`${preview}/g/${a3.current!.id}/`, { timeout: 20_000 });
    await expect.poll(() => version(page)).toBe("a1");
    expect(await marker()).toBeUndefined();
    await expect(autoReload).not.toBeChecked();
    await expect(overlay.getByRole("status")).toHaveText("Live preview");

    await operation({ operation: "stop" });
    await settled((value) => value.state === "stopped", "The preview did not stop.");
  } finally {
    await page.close();
    await fixture?.close();
    await rm(base, { recursive: true, force: true });
  }
});
