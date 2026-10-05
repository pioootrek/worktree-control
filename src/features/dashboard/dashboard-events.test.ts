import { describe, expect, it, vi } from "vitest";

import { connectDashboardEvents, consumeDashboardEvents } from "./dashboard-events";

function eventResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

describe("dashboard event stream", () => {
  it("parses partial CRLF frames and multiline data", async () => {
    const events: Array<{ type: string; data: string }> = [];
    await consumeDashboardEvents(eventResponse([
      "event: rea",
      "dy\r\ndata: {\"revision\":0}\r\n\r\nevent: changed\r\ndata: first\r\n",
      "data: second\r\n\r\n",
    ]).body!, (type, data) => events.push({ type, data }));
    expect(events).toEqual([
      { type: "ready", data: "{\"revision\":0}" },
      { type: "changed", data: "first\nsecond" },
    ]);
  });

  it("authenticates with a header, reconnects, and never puts the token in the URL", async () => {
    let secondController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const requests: Array<{ url: string; token: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        token: new Headers(init?.headers).get("X-Worktree-Control-Token"),
      });
      if (requests.length === 1) return eventResponse(["event: ready\ndata: {}\n\n"]);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { secondController = controller; } }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const ready = vi.fn();
    const connection = connectDashboardEvents({
      token: "synthetic-event-secret",
      fetcher,
      retryDelayMs: 0,
      onEvent: (type) => { if (type === "ready") ready(); },
      onError: vi.fn(),
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      { url: "/api/events", token: "synthetic-event-secret" },
      { url: "/api/events", token: "synthetic-event-secret" },
    ]);
    expect(ready).toHaveBeenCalledOnce();
    connection.close();
    const controllerToClose = secondController as ReadableStreamDefaultController<Uint8Array> | null;
    controllerToClose?.close();
  });

  it("aborts an active stream and does not reconnect after close", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
      });
    });
    const connection = connectDashboardEvents({
      token: "synthetic-event-secret",
      fetcher,
      retryDelayMs: 0,
      onEvent: vi.fn(),
      onError: vi.fn(),
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    connection.close();
    expect(observedSignal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels a rejected response body before reconnecting", async () => {
    const cancel = vi.fn();
    let activeController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        return new Response(new ReadableStream({ cancel }), { status: 401 });
      }
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { activeController = controller; } }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const connection = connectDashboardEvents({
      token: "stale-synthetic-secret",
      fetcher,
      retryDelayMs: 0,
      onEvent: vi.fn(),
      onError: vi.fn(),
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledOnce();
    connection.close();
    const controllerToClose = activeController as ReadableStreamDefaultController<Uint8Array> | null;
    controllerToClose?.close();
  });

  it("backs off when streams flap immediately after the ready event", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => eventResponse(["event: ready\ndata: {}\n\n"]));
      const connection = connectDashboardEvents({
        token: "synthetic-event-secret",
        fetcher,
        retryDelayMs: 500,
        onEvent: vi.fn(),
        onError: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(3);
      connection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying and reports a rejected credential once", async () => {
    const fetcher = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const onUnauthorized = vi.fn();
    const onError = vi.fn();
    const events = connectDashboardEvents({ token: "rotated", onEvent: () => undefined, onError, onUnauthorized, fetcher, retryDelayMs: 1 });
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    events.close();
  });
});
