import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GodotWebStaticServer } from "./static-server";

const KEY = "0123456789abcdef";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function store() {
  const root = mkdtempSync(join(tmpdir(), "wtc-static-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "generations"));
  const publish = (generation: string, files: Record<string, string>, worktreeKey = KEY, build = "idle") => {
    const directory = join(root, "generations", generation);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".worktree-key"), worktreeKey);
    for (const [name, content] of Object.entries(files)) { mkdirSync(join(directory, name, ".."), { recursive: true }); writeFileSync(join(directory, name), content); }
    writeFileSync(join(root, "state.json"), JSON.stringify({ version: 1, generation, worktreeKey, publishedAt: "2026-11-06T00:00:00.000Z", build, failureCode: null, updatedAt: "x" }));
  };
  return { root, publish };
}
async function serve(root: string, options: Partial<ConstructorParameters<typeof GodotWebStaticServer>[0]> = {}) {
  const server = new GodotWebStaticServer({ root, worktreeKey: KEY, liveReload: true, isolation: true, pollMs: 50, heartbeatMs: 1_000, ...options });
  await server.listen(0, "127.0.0.1");
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  return { server, base };
}
/** Sends a raw request path so encoded traversal reaches the server unchanged. */
function raw(base: string, path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(base);
    const request = httpRequest({ host: target.hostname, port: target.port, path, method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("Godot Web static server", () => {
  it("serves a placeholder until a generation for its own worktree is published", async () => {
    const fixture = store();
    fixture.publish("m1abcdef-0a0b0c0d", { "index.html": "<html><head></head><body>foreign</body></html>" }, "ffffffffffffffff");
    const { base, server } = await serve(fixture.root);
    const placeholder = await raw(base, "/");
    expect(placeholder.status).toBe(200);
    expect(placeholder.body).toContain("Waiting for the first complete Web export");
    expect(placeholder.headers["cache-control"]).toBe("no-store");
    expect(server.currentState.generation).toBeNull();
    expect((await raw(base, "/g/m1abcdef-0a0b0c0d/index.html")).status).toBe(410);
    fixture.publish("m1abcdef-0a0b0c0e", { "index.html": "<html><head></head><body>game</body></html>", "index.wasm": "\0asm", "index.pck": "pck" });
    await vi.waitFor(() => expect(server.currentState.generation).toBe("m1abcdef-0a0b0c0e"), { timeout: 2_000 });
    const entry = await raw(base, "/?debug=1");
    expect(entry.status).toBe(302);
    expect(entry.headers.location).toBe("/g/m1abcdef-0a0b0c0e/?debug=1");
    const page = await raw(base, "/g/m1abcdef-0a0b0c0e/");
    expect(page.body).toBe('<html><head><script src="/__wtc/live-reload.js" defer></script></head><body>game</body></html>');
    expect(page.headers).toMatchObject({ "cache-control": "no-cache", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "x-content-type-options": "nosniff" });
    const wasm = await raw(base, "/g/m1abcdef-0a0b0c0e/index.wasm");
    expect(wasm.headers).toMatchObject({ "content-type": "application/wasm", "cache-control": "public, max-age=31536000, immutable", "content-length": "4" });
    expect((await raw(base, "/g/m1abcdef-0a0b0c0e/index.pck", "HEAD")).headers["content-type"]).toBe("application/octet-stream");
    expect((await raw(base, "/g/m1abcdef-0a0b0c0e/index.pck", "HEAD")).body).toBe("");
    expect((await raw(base, "/g/m1abcdef-0a0b0c0d/")).status).toBe(410);
    expect((await raw(base, "/g/m1abcdef-0a0b0c0e/.worktree-key")).status).toBe(404);
  });

  it("rejects traversal, malformed escapes, dotfiles, unknown types, symlinks and other methods", async () => {
    const fixture = store();
    const outside = mkdtempSync(join(tmpdir(), "wtc-static-outside-")); cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "secret.js"), "secret");
    fixture.publish("m1abcdef-0a0b0c0d", { "index.html": "<html></html>", ".env": "SECRET", "game.gd": "source", "ok.js": "ok" });
    symlinkSync(join(outside, "secret.js"), join(fixture.root, "generations", "m1abcdef-0a0b0c0d", "linked.js"));
    symlinkSync(outside, join(fixture.root, "generations", "m1abcdef-0a0b0c0d", "dir"));
    const { base } = await serve(fixture.root);
    const g = "/g/m1abcdef-0a0b0c0d";
    expect((await raw(base, `${g}/ok.js`)).status).toBe(200);
    for (const path of [`${g}/../../state.json`, `${g}/%2e%2e/%2e%2e/state.json`, `${g}/..%2F..%2Fstate.json`, `${g}/.env`, `${g}/game.gd`, `${g}/linked.js`, `${g}/dir/secret.js`, "/g/../state.json", "/state.json", "/generations/m1abcdef-0a0b0c0d/ok.js", `${g}/%00.js`]) {
      const response = await raw(base, path);
      expect([400, 404], path).toContain(response.status);
      expect(response.body).not.toContain("secret");
    }
    expect((await raw(base, `${g}/%E0%A4%A.js`)).status).toBe(400);
    expect((await raw(base, `/g/m1abcdef-0a0b0c0f/index.html`)).status).toBe(410);
    const post = await raw(base, `${g}/ok.js`, "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect((await raw(base, `/${"a".repeat(3000)}`)).status).toBe(414);
  });

  it("pushes state over a bounded SSE stream and disposes clients on close", async () => {
    const fixture = store();
    const { base, server } = await serve(fixture.root, { maxEventClients: 1 });
    const controller = new AbortController();
    const response = await fetch(`${base}/__wtc/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (pattern: RegExp) => { while (!pattern.test(text)) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); } };
    await readUntil(/"generation":null/);
    expect((await raw(base, "/__wtc/events")).status).toBe(503);
    fixture.publish("m1abcdef-0a0b0c0d", { "index.html": "x" }, KEY, "building");
    await readUntil(/m1abcdef-0a0b0c0d/);
    expect(text).toMatch(/event: state\ndata: \{"generation":"m1abcdef-0a0b0c0d"/);
    expect(text).not.toMatch(/worktree|\/tmp/);
    expect(server.eventClients).toBe(1);
    controller.abort();
    await vi.waitFor(() => expect(server.eventClients).toBe(0), { timeout: 2_000 });
  });

  it("tells each event stream connection whether the page's own generation belongs to this worktree", async () => {
    const fixture = store();
    fixture.publish("m1abcdef-0a0b0c0a", { "index.html": "a" }, "ffffffffffffffff");
    fixture.publish("m1abcdef-0a0b0c0b", { "index.html": "b" });
    const { base } = await serve(fixture.root);
    const firstEvents = async (query: string) => {
      const controller = new AbortController();
      const response = await fetch(`${base}/__wtc/events${query}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!/event: state\ndata: .*\n\n/.test(text)) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
      controller.abort();
      return text;
    };
    // The verdict precedes the first state, so the page decides before applying it.
    expect(await firstEvents("?generation=m1abcdef-0a0b0c0b")).toMatch(/^retry: 3000\nevent: page\ndata: \{"status":"served"\}\n\nevent: state\ndata: \{"generation":"m1abcdef-0a0b0c0b"/);
    const foreign = await firstEvents("?generation=m1abcdef-0a0b0c0a");
    expect(foreign).toContain('event: page\ndata: {"status":"foreign"}');
    expect(foreign).not.toContain("ffffffffffffffff");
    expect(foreign).not.toContain(KEY);
    expect(await firstEvents("?generation=m1abcdef-0a0b0c0c")).toContain('event: page\ndata: {"status":"missing"}');
    for (const query of ["", "?generation=..%2Fstate", "?generation="]) expect(await firstEvents(query)).not.toContain("event: page");
  });

  it("redirects only to a generation whose own worktree key matches, so the entry cannot send a page to a foreign build", async () => {
    const fixture = store();
    fixture.publish("m1abcdef-0a0b0c0d", { "index.html": "x" });
    writeFileSync(join(fixture.root, "generations", "m1abcdef-0a0b0c0d", ".worktree-key"), "ffffffffffffffff");
    const { base, server } = await serve(fixture.root);
    expect(server.currentState.generation).toBeNull();
    expect((await raw(base, "/")).status).toBe(200);
  });

  it("omits live reload and isolation when disabled", async () => {
    const fixture = store();
    fixture.publish("m1abcdef-0a0b0c0d", { "index.html": "<html><head></head></html>" });
    const { base } = await serve(fixture.root, { liveReload: false, isolation: false });
    const page = await raw(base, "/g/m1abcdef-0a0b0c0d/index.html");
    expect(page.body).toBe("<html><head></head></html>");
    expect(page.headers["cross-origin-embedder-policy"]).toBeUndefined();
    expect((await raw(base, "/__wtc/events")).status).toBe(404);
    expect((await raw(base, "/__wtc/state")).body).toContain('"generation":"m1abcdef-0a0b0c0d"');
  });
});
