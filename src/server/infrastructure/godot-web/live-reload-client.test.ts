import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { LIVE_RELOAD_SCRIPT } from "./live-reload-client";

class FakeElement {
  style = { cssText: "", display: "" };
  hidden = false;
  textContent = "";
  checked = false;
  type = "";
  private readonly attributes = new Map<string, string>();
  readonly children: unknown[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  append(...nodes: unknown[]) { this.children.push(...nodes); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
}

class FakeEventSource {
  static OPEN = 1;
  readyState = 1;
  closed = false;
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(readonly url: string) { sources.push(this); }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) }); }
  /** One (re)connection: the optional page verdict, then the current state. */
  connect(page: string | null, state: Partial<{ generation: string | null; build: string }>) {
    if (page) this.emit("page", { status: page });
    this.emit("state", { generation: null, publishedAt: null, build: "idle", failureCode: null, ...state });
  }
}
const sources: FakeEventSource[] = [];

/** Runs the injected script in a sandbox with a minimal DOM, location and EventSource. */
function load(pathname: string, autoReload: "on" | "off" = "on") {
  sources.length = 0;
  const elements: FakeElement[] = [];
  const navigations: string[] = [];
  const storage = new Map<string, string>([["wtc-live-reload-auto", autoReload]]);
  const document = {
    body: new FakeElement(),
    createElement: () => { const element = new FakeElement(); elements.push(element); return element; },
    createTextNode: (text: string) => ({ text }),
    addEventListener: () => undefined,
  };
  const sandbox: Record<string, unknown> = {
    document, EventSource: FakeEventSource, URLSearchParams,
    navigator: { language: "en-US" },
    location: { pathname, search: "", replace: (url: string) => { navigations.push(url); } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
  };
  sandbox.window = sandbox;
  runInNewContext(LIVE_RELOAD_SCRIPT, sandbox);
  const [, status, reload, , toggle] = elements;
  return {
    source: sources[0]!, navigations,
    status: () => status!.textContent, reloadVisible: () => !reload!.hidden,
    enableAuto: () => { toggle!.checked = true; for (const listener of toggle!.listeners.get("change") ?? []) listener(); },
  };
}

const OWN = "m1abcdef-0a0b0c0d";
const NEWER = "m1abcdef-0a0b0c0e";

describe("Godot Web live-reload client", () => {
  it("names its generation on the stream and keeps same-worktree gameplay with auto-reload off, across reconnects", () => {
    const page = load(`/g/${OWN}/`, "off");
    expect(page.source.url).toBe(`/__wtc/events?generation=${OWN}`);
    page.source.connect("served", { generation: OWN });
    expect(page.status()).toBe("Live preview");
    page.source.connect(null, { generation: NEWER });
    expect(page.status()).toBe("A new build is ready");
    expect(page.reloadVisible()).toBe(true);
    // A restart of the same worktree's server reconnects; the page is still its build.
    page.source.connect("served", { generation: NEWER, build: "building" });
    page.source.connect("served", { generation: null });
    expect(page.navigations).toEqual([]);
    expect(page.status()).toBe("Live preview");
  });

  it("leaves another worktree's build immediately, even with auto-reload off and before the new worktree has published", () => {
    const page = load(`/g/${OWN}/`, "off");
    page.source.connect("foreign", { generation: null, build: "building" });
    expect(page.navigations).toEqual(["/"]);
    expect(page.source.closed).toBe(true);
    // Later events cannot announce the old build as the live preview.
    page.source.connect(null, { generation: null, build: "failed" });
    expect(page.navigations).toEqual(["/"]);
  });

  it("leaves another worktree's build when the reconnect already sees that worktree's published generation", () => {
    const page = load(`/g/${OWN}/`, "off");
    page.source.connect("foreign", { generation: NEWER });
    expect(page.navigations).toEqual(["/"]);
    expect(page.status()).not.toBe("A new build is ready");
  });

  it("labels a pruned build instead of presenting it as live, and reloads once auto-reload is enabled", () => {
    const page = load(`/g/${OWN}/`, "off");
    page.source.connect("missing", { generation: null });
    expect(page.navigations).toEqual([]);
    expect(page.status()).toBe("This build is no longer served");
    expect(page.reloadVisible()).toBe(true);
    page.enableAuto();
    expect(page.navigations).toEqual(["/"]);
  });

  it("waits on the placeholder without reloading and distinguishes a failed first export", () => {
    const page = load("/");
    expect(page.source.url).toBe("/__wtc/events");
    page.source.connect(null, { build: "building" });
    expect(page.status()).toBe("Web export in progress…");
    page.source.connect(null, { build: "failed" });
    expect(page.status()).toBe("Export failed — waiting for a successful export");
    page.source.connect(null, { build: "idle" });
    expect(page.navigations).toEqual([]);
    page.source.connect(null, { generation: OWN });
    expect(page.navigations).toEqual(["/"]);
  });
});
