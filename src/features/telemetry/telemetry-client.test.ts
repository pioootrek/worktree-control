import { describe, expect, it, vi } from "vitest";
import { fetchTestComparison, fetchTestHistory, fetchTestMetrics, isAbort, latestRequestSlot, TelemetryRequestError } from "./telemetry-client";
import { DEFAULT_FILTERS, historyFilter } from "./telemetry-model";

const projectId = "17493a1a-8027-4c7d-81c4-b307541ac845";
const filter = historyFilter(projectId, { ...DEFAULT_FILTERS, worktreePath: "/home/x/win path" }, Date.parse("2026-10-19T20:00:00.000Z"));

function recorder(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, access: { token: "fixture-token", locale: "pl", fetcher } };
}

describe("telemetry client", () => {
  it("reads the existing project-scoped GET routes with bounded, encoded queries", async () => {
    const { calls, access } = recorder();
    const signal = new AbortController().signal;
    await fetchTestMetrics(access, filter, signal);
    await fetchTestHistory(access, filter, "cursor.sig", signal);
    await fetchTestComparison(access, projectId, "2e5497e3-3228-47d5-b2a6-8363d6294bd6", "320af0b4-bf21-4857-99f1-4b3a2ef57933", signal);
    const urls = calls.map((call) => new URL(call.url, "http://controller.test"));
    expect(urls.map((url) => url.pathname)).toEqual([
      `/api/projects/${projectId}/test-metrics`, `/api/projects/${projectId}/test-runs`, `/api/projects/${projectId}/test-run-comparison`,
    ]);
    expect(urls[0].searchParams.has("limit")).toBe(false);
    expect(urls[0].searchParams.get("worktreePath")).toBe("/home/x/win path");
    expect(urls[1].searchParams.get("limit")).toBe("25");
    expect(urls[1].searchParams.get("cursor")).toBe("cursor.sig");
    expect([...urls[2].searchParams.keys()]).toEqual(["leftRunId", "rightRunId"]);
    for (const call of calls) {
      expect(call.init.signal).toBe(signal);
      expect(new Headers(call.init.headers).get("X-Worktree-Control-Token")).toBe("fixture-token");
      expect(new Headers(call.init.headers).get("Accept-Language")).toBe("pl");
      expect(call.init.cache).toBe("no-store");
    }
  });

  it("encodes a project ID that is not URL-safe", async () => {
    const { calls, access } = recorder();
    await fetchTestMetrics(access, { ...filter, projectId: "a/b" }, new AbortController().signal);
    expect(calls[0].url.startsWith("/api/projects/a%2Fb/test-metrics?")).toBe(true);
  });

  it.each([
    [401, "unauthorized"], [403, "forbidden"], [400, "invalid"], [404, "not_found"], [503, "failed"],
  ] as const)("classifies HTTP %i as %s with the server's safe message", async (status, kind) => {
    const { access } = recorder(status, { error: "Invalid verification history cursor." });
    const error = await fetchTestMetrics(access, filter, new AbortController().signal).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TelemetryRequestError);
    expect(error).toMatchObject({ kind, status, message: "Invalid verification history cursor." });
  });

  it("tolerates a non-JSON error body", async () => {
    const fetcher = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    await expect(fetchTestMetrics({ token: "t", locale: "en", fetcher }, filter, new AbortController().signal)).rejects.toMatchObject({ kind: "failed", message: "HTTP 502" });
  });
});

describe("latest request slot", () => {
  it("aborts a superseded request and rejects its late response", async () => {
    const slot = latestRequestSlot();
    const first = slot.begin();
    const second = slot.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.current()).toBe(false);
    expect(second.current()).toBe(true);
    slot.cancel();
    expect(second.signal.aborted).toBe(true);
    expect(second.current()).toBe(false);
  });

  it("accepts only the newest of out-of-order responses", async () => {
    const slot = latestRequestSlot();
    const accepted: string[] = [];
    const run = (label: string, delay: number) => {
      const request = slot.begin();
      return new Promise<void>((resolve) => setTimeout(() => { if (request.current()) accepted.push(label); resolve(); }, delay));
    };
    const slow = run("old filter", 20);
    const fast = run("new filter", 1);
    await Promise.all([slow, fast]);
    expect(accepted).toEqual(["new filter"]);
  });

  it("recognizes aborts", () => {
    expect(isAbort(new DOMException("stop", "AbortError"))).toBe(true);
    expect(isAbort(new Error("stop"))).toBe(false);
  });
});
