import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Page } from "@playwright/test";
import type { ControllerDashboardResponse, TestRun } from "../../src/shared/contracts";

const worktreePath = "/fixture/web";
const now = "2026-01-01T12:00:00.000Z";

export function dashboardFixture(): ControllerDashboardResponse {
  return {
    capacity: { enabled: false, limit: 2, used: 0, available: null, holders: [] },
    testQueue: { limit: 1, running: 0, queued: 0 },
    mcp: { phase: "disabled", endpoint: null, transport: "streamable-http", network: "loopback", authentication: "bearer", activeSessions: 0 },
    projects: [{
      project: {
        id: "web", name: "Fixture Web", repositoryPath: worktreePath, port: 3000,
        launchPreset: "node", tlsMode: "off", tlsKeyPath: null, tlsCertPath: null, tlsCaPath: null,
        executable: "pnpm", args: ["run", "dev"], environment: {},
        environmentProfiles: [{ name: "default", environment: {} }], selectedEnvironmentProfile: "default",
        testEnvironmentProfiles: [{ name: "unit", policy: { mode: "clean", serverProfile: null }, variableNames: [], nodeEnv: "test", requiredVariables: [] }],
        testPresetProfiles: {}, healthcheckPath: "/", startupTimeoutMs: 30_000,
        selectedWorktreePath: worktreePath, createdAt: now, updatedAt: now,
      },
      runtime: {
        phase: "stopped", pid: null, worktreePath: null, startedAt: null, error: null, failure: null, logs: ["fixture ready"],
        resources: { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] },
      },
      reservation: null,
      worktrees: [{ path: worktreePath, head: "abcdef123456", shortHead: "abcdef1", branch: "main", detached: false, locked: false, prunable: false, dirty: false }],
      storage: [],
      testPresets: [{ worktreePath, presets: [{ id: "node:test", name: "test", adapter: "node", profile: "unit", timeoutMs: 30_000 }], error: null }],
      testRuns: [],
      metadata: { status: "fresh", lastSuccessfulAt: now, lastAttemptAt: now, retryAt: null, error: null },
    }],
  };
}

/** Loads the real static export into Chromium; no HTTP listener or controller is started. */
export async function mountDashboard(
  page: Page,
  data = dashboardFixture(),
  options: { failDashboardRefreshAfterProjectRemoval?: boolean; metadataRefreshFailures?: number; accessToken?: string; openWithToken?: boolean; openMode?: boolean } = {},
) {
  const accessToken = options.accessToken ?? "ui-fixture-token";
  const openMode = options.openMode ?? false;
  const webRoot = resolve("out");
  if (!existsSync(resolve(webRoot, "index.html"))) throw new Error("Run pnpm build before pnpm test:ui.");
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  let metadataRefreshFailures = options.metadataRefreshFailures ?? 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ accessToken, openMode }) => {
    // The fixture owns event delivery; count subscriptions to catch accidental duplication.
    const nativeFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const streams = new Set<{ send(frame: string): void; disconnect(): void }>();
    const events = {
      active: 0,
      opened: 0,
      lastKnowledgeToken: "",
      version: { epoch: "fixture", revision: 0 },
      lastUrl: "",
      lastToken: "",
      emit(type: string, data: unknown = {}) {
        const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const stream of streams) stream.send(frame);
      },
      disconnect() { for (const stream of [...streams]) stream.disconnect(); },
    };
    Object.assign(window, { fixtureEvents: events });
    window.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      if (url.pathname !== "/api/events") return nativeFetch(input, init);
      events.lastUrl = `${url.pathname}${url.search}`;
      events.lastToken = new Headers(init?.headers).get("X-Worktree-Switcher-Token") ?? "";
      events.lastKnowledgeToken = new Headers(init?.headers).get("Authorization") ?? "";
      if (!openMode && events.lastToken !== accessToken) return new Response("Unauthorized", { status: 401 });
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let connected = true;
      const cleanup = () => {
        if (!connected) return;
        connected = false;
        streams.delete(connection);
        events.active -= 1;
      };
      const connection = {
        send(frame: string) { if (connected) streamController.enqueue(encoder.encode(frame)); },
        disconnect() {
          if (!connected) return;
          streamController.close();
          cleanup();
        },
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          streams.add(connection);
          events.active += 1;
          events.opened += 1;
          queueMicrotask(() => connection.send(`event: ready\ndata: ${JSON.stringify(events.version)}\n\n`));
        },
        cancel: cleanup,
      });
      init?.signal?.addEventListener("abort", () => {
        if (!connected) return;
        streamController.error(init.signal?.reason);
        cleanup();
      }, { once: true });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
  }, { accessToken, openMode });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://switcher.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      const request = route.request();
      if (!openMode && request.headers()["x-worktree-switcher-token"] !== accessToken) {
        return route.fulfill({ status: 401, json: { error: "Missing fixture session" } });
      }
      if (request.method() === "GET") {
        if (url.pathname === "/api/dashboard") {
          if (options.failDashboardRefreshAfterProjectRemoval && !data.projects.some(({ project }) => project.id === "web")) {
            return route.fulfill({ status: 503, json: { error: "Fixture dashboard refresh failed" } });
          }
          return route.fulfill({ json: data });
        }
        if (url.pathname === "/api/dashboard/live") {
          const sections = new Set(url.searchParams.getAll("section"));
          const snapshot = data.projects[0];
          return route.fulfill({ json: {
            projects: [{
              projectId: snapshot.project.id,
              ...(sections.has("runtime") ? { runtime: snapshot.runtime } : {}),
              ...(sections.has("reservation") ? { reservation: snapshot.reservation } : {}),
              ...(sections.has("tests") ? { testRuns: snapshot.testRuns } : {}),
              ...(sections.has("storage") ? { storage: snapshot.storage } : {}),
            }],
            ...(sections.has("controller") ? { capacity: data.capacity, testQueue: data.testQueue } : {}),
          } });
        }
        if (url.pathname === "/api/metrics") return route.fulfill({ json: { projects: [] } });
        return route.fulfill({ status: 404, json: { error: "Unconfigured fixture read" } });
      }
      const body = request.postDataJSON();
      requests.push({ path: url.pathname, method: request.method(), body });
      const snapshot = data.projects[0];
      switch (url.pathname) {
        case "/api/projects/web":
          if (request.method() !== "DELETE") return route.fulfill({ status: 405, json: { error: "Method not allowed" } });
          data.projects = data.projects.filter(({ project }) => project.id !== "web");
          break;
        case "/api/projects/web/metadata/refresh":
          if (metadataRefreshFailures > 0) {
            metadataRefreshFailures -= 1;
            return route.fulfill({ status: 503, json: { error: "Fixture Git refresh failed" } });
          }
          snapshot.metadata = { status: "fresh", lastSuccessfulAt: now, lastAttemptAt: now, retryAt: null, error: null };
          break;
        case "/api/settings/capacity": Object.assign(data.capacity, body); break;
        case "/api/settings/test-queue": Object.assign(data.testQueue, body); break;
        case "/api/projects/web/tls": snapshot.project.tlsMode = body.mode; break;
        case "/api/projects/web/environment-profiles":
          snapshot.project.environmentProfiles = [{ name: body.name, environment: body.environment }];
          snapshot.project.environment = body.environment;
          break;
        case "/api/projects/web/operation":
          snapshot.runtime.phase = body.operation === "stop" ? "stopped" : "running";
          snapshot.runtime.worktreePath = body.worktreePath;
          break;
        case "/api/projects/web/tests": {
          const run: TestRun = {
            id: "run-1", projectId: "web", worktreePath, worktreeHead: "abcdef123456", worktreeBranch: "main", worktreeDirty: false,
            presetId: "node:test", presetName: "test", adapter: "node", actor: "local-user", phase: "queued", queuePosition: 1,
            executable: "pnpm", args: ["run", "test"], cwd: worktreePath, queuedAt: now, startedAt: null, finishedAt: null,
            exitCode: null, signal: null, error: null, logs: ["fixture test output"], environmentMode: "clean", environmentProfile: "unit",
            inheritedServerProfile: null, environmentVariableNames: ["NODE_ENV"],
            source: { version: 1, scope: "git-observations", enqueue: null, preflight: null, finish: null, queueComparison: "unknown", executionComparison: "unknown", attribution: "legacy_unknown", reasonCodes: ["legacy_evidence_unavailable"], processOutcome: null },
          };
          snapshot.testRuns = [run];
          break;
        }
        case "/api/test-runs/run-1/cancel": snapshot.testRuns[0].phase = "cancelled"; break;
        default: return route.fulfill({ status: 400, json: { error: "Unconfigured fixture mutation" } });
      }
      return route.fulfill({ json: {} });
    }
    const file = resolve(webRoot, "." + (url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)));
    if (!file.startsWith(webRoot + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: "Missing static asset" });
    return route.fulfill({ path: file });
  });
  await page.goto(options.openWithToken === false ? "http://switcher.test/" : `http://switcher.test/#token=${accessToken}`);
  return { requests, errors };
}

export function testRunFixture(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: "result-1", projectId: "web", worktreePath, worktreeHead: "abcdef123456", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "local-user", phase: "passed", queuePosition: null,
    executable: "pnpm", args: ["run", "test"], cwd: worktreePath, queuedAt: now, startedAt: now, finishedAt: "2026-01-01T12:00:10.000Z",
    exitCode: 0, signal: null, error: null, logs: ["fixture result output"], environmentMode: "clean", environmentProfile: "unit",
    inheritedServerProfile: null, environmentVariableNames: ["NODE_ENV"],
    source: { version: 1, scope: "git-observations", enqueue: null, preflight: null, finish: null, queueComparison: "unknown", executionComparison: "unknown", attribution: "uncertain", reasonCodes: ["dirty_source"], processOutcome: "passed" },
    ...overrides,
  };
}
