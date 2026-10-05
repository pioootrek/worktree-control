const MAX_EVENT_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_MS = 10_000;
const STABLE_CONNECTION_MS = 30_000;

type EventHandler = (type: string, data: string) => void;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function consumeDashboardEvents(body: ReadableStream<Uint8Array>, onEvent: EventHandler): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let eventBytes = 0;

  const acceptLine = (line: string) => {
    if (line === "") {
      if (dataLines.length) onEvent(eventType, dataLines.join("\n"));
      eventType = "message";
      dataLines = [];
      eventBytes = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventType = value;
    if (field === "data") dataLines.push(value);
    eventBytes += line.length;
    if (eventBytes > MAX_EVENT_BYTES) throw new Error("Dashboard event exceeded the size limit.");
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        acceptLine(line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_EVENT_BYTES) throw new Error("Dashboard event exceeded the size limit.");
      if (done) break;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function connectDashboardEvents(options: {
  token: string;
  knowledgeToken?: string;
  onEvent: EventHandler;
  onError: () => void;
  /** A rejected credential cannot recover by retrying; the stream stops and reports it once. */
  onUnauthorized?: () => void;
  fetcher?: Fetcher;
  retryDelayMs?: number;
}): { close(): void } {
  const controller = new AbortController();
  const fetcher = options.fetcher ?? fetch;
  const initialDelay = options.retryDelayMs ?? 500;
  let retryDelay = initialDelay;
  let closed = false;

  void (async () => {
    while (!closed) {
      let connectedAt: number | null = null;
      try {
        const response = await fetcher("/api/events", {
          cache: "no-store",
          headers: {
            Accept: "text/event-stream",
            ...(options.knowledgeToken ? { Authorization: `Bearer ${options.knowledgeToken}` } : {}),
            "X-Worktree-Control-Token": options.token,
          },
          signal: controller.signal,
        });
        if (response.status === 401 && options.onUnauthorized) {
          await response.body?.cancel();
          closed = true;
          options.onUnauthorized();
          return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Dashboard event stream returned HTTP ${response.status}.`);
        }
        if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
          await response.body?.cancel();
          throw new Error("Dashboard event stream returned an invalid content type.");
        }
        if (!response.body) throw new Error("Dashboard event stream returned no body.");
        connectedAt = Date.now();
        await consumeDashboardEvents(response.body, (type, data) => {
          options.onEvent(type, data);
        });
        if (!closed) options.onError();
      } catch {
        if (closed || controller.signal.aborted) return;
        options.onError();
      }
      if (closed) return;
      if (connectedAt !== null && Date.now() - connectedAt >= STABLE_CONNECTION_MS) retryDelay = initialDelay;
      try {
        await waitForRetry(retryDelay, controller.signal);
      } catch {
        return;
      }
      retryDelay = Math.min(Math.max(initialDelay, retryDelay * 2), MAX_RETRY_DELAY_MS);
    }
  })();

  return {
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}
