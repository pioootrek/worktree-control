"use client";

import { EMPTY_RESOURCES } from "@/features/runtime/defaults";

import { parseResponse } from "@/features/control-client";
import { useI18n } from "@/i18n/provider";
import type {
  ControllerDashboardResponse,
  DashboardChangeEvent,
  DashboardLiveResponse,
  DashboardSection,
  RuntimeMetricsResponse,
  RuntimeResourceMetrics,
} from "@/shared/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectDashboardEvents } from "./dashboard-events";
import { EMPTY_CAPACITY, EMPTY_MCP_STATUS, EMPTY_TEST_QUEUE } from "./defaults";

interface PendingRefresh {
  bootstrap: boolean;
  projectIds: Set<string>;
  sections: Set<DashboardSection>;
}

const emptyPending = (): PendingRefresh => ({ bootstrap: false, projectIds: new Set(), sections: new Set() });
const ACCESS_TOKEN_KEY = "worktree-switcher-token";
const KNOWLEDGE_TOKEN_KEY = "worktree-switcher-knowledge-token";

/** Placeholder credential in open mode, where the controller ignores credentials entirely. */
export const OPEN_ACCESS = "open-mode";

/** The installation token (or open mode) authorizes runtime and knowledge alike: no second sign-in. */
export function isInstallationToken(token: string): boolean {
  return token.startsWith("wsi_") || token === OPEN_ACCESS;
}

function newestResources(current: RuntimeResourceMetrics, incoming: RuntimeResourceMetrics): RuntimeResourceMetrics {
  if (!current.sampledAt) return incoming;
  if (!incoming.sampledAt) return current;
  return incoming.sampledAt >= current.sampledAt ? incoming : current;
}

export function useDashboard() {
  const { locale, t } = useI18n();
  const [data, setData] = useState<ControllerDashboardResponse>({ projects: [], capacity: EMPTY_CAPACITY, testQueue: EMPTY_TEST_QUEUE, mcp: EMPTY_MCP_STATUS });
  const [token, setToken] = useState("");
  const [accessRequired, setAccessRequired] = useState<"missing" | "invalid" | null>(null);
  const [scopedKnowledgeToken, setKnowledgeToken] = useState("");
  const knowledgeAccess: "open" | "installation" | "scoped" = token === OPEN_ACCESS ? "open" : isInstallationToken(token) ? "installation" : "scoped";
  const knowledgeToken = isInstallationToken(token) ? token : scopedKnowledgeToken;
  const [knowledgeSessionVersion, setKnowledgeSessionVersion] = useState(0);
  const [knowledgeChange, setKnowledgeChange] = useState({ version: 0, projectIds: [] as string[] });
  const changeKnowledgeToken = useCallback((value: string) => {
    if (value) window.sessionStorage.setItem(KNOWLEDGE_TOKEN_KEY, value);
    else window.sessionStorage.removeItem(KNOWLEDGE_TOKEN_KEY);
    setKnowledgeToken(value);
    setKnowledgeSessionVersion(current => current + 1);
  }, []);
  const [loading, setLoading] = useState(true);
  const [observedAt, setObservedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef<PendingRefresh>(emptyPending());
  const inFlight = useRef<Promise<void> | null>(null);
  const requestAbort = useRef<AbortController | null>(null);

  const reconcile = useCallback((accessToken: string, request: { bootstrap?: boolean; projectIds?: string[]; sections?: DashboardSection[] } = {}) => {
    if (request.bootstrap) pending.current.bootstrap = true;
    for (const id of request.projectIds ?? []) pending.current.projectIds.add(id);
    for (const section of request.sections ?? []) pending.current.sections.add(section);
    if (inFlight.current) return inFlight.current;
    const activeGeneration = generation.current;
    const operation = (async () => {
      while (pending.current.bootstrap || pending.current.sections.size > 0) {
        const next = pending.current;
        pending.current = emptyPending();
        const controller = new AbortController();
        requestAbort.current = controller;
        try {
          if (next.bootstrap) {
            const response = await fetch("/api/dashboard", {
              cache: "no-store",
              signal: controller.signal,
              headers: { "Accept-Language": locale, "X-Worktree-Switcher-Token": accessToken },
            });
            if (response.status === 401) {
              if (generation.current !== activeGeneration) return;
              // A rotated or mistyped token cannot recover by retrying; ask for the current one.
              generation.current += 1;
              window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
              setToken("");
              setAccessRequired("invalid");
              return;
            }
            const dashboard = await parseResponse<ControllerDashboardResponse>(response, t("http.error", { status: response.status }));
            if (generation.current !== activeGeneration) return;
            setData((current) => {
              const resources = new Map(current.projects.map((project) => [project.project.id, project.runtime.resources]));
              return {
                ...dashboard,
                capacity: dashboard.capacity ?? EMPTY_CAPACITY,
                testQueue: dashboard.testQueue ?? EMPTY_TEST_QUEUE,
                mcp: dashboard.mcp ?? EMPTY_MCP_STATUS,
                projects: dashboard.projects.map((project) => ({
                  ...project,
                  runtime: {
                    ...project.runtime,
                    resources: newestResources(resources.get(project.project.id) ?? EMPTY_RESOURCES, project.runtime.resources ?? EMPTY_RESOURCES),
                  },
                })),
              };
            });
          } else {
            const query = new URLSearchParams();
            for (const projectId of next.projectIds) query.append("project", projectId);
            for (const section of next.sections) query.append("section", section);
            const response = await fetch(`/api/dashboard/live?${query}`, {
              cache: "no-store",
              signal: controller.signal,
              headers: { "Accept-Language": locale, "X-Worktree-Switcher-Token": accessToken },
            });
            const live = await parseResponse<DashboardLiveResponse>(response, t("http.error", { status: response.status }));
            if (generation.current !== activeGeneration) return;
            const updates = new Map(live.projects.map((project) => [project.projectId, project]));
            setData((current) => ({
              ...current,
              capacity: live.capacity ?? current.capacity,
              testQueue: live.testQueue ?? current.testQueue,
              projects: current.projects.map((snapshot) => {
                const update = updates.get(snapshot.project.id);
                if (!update) return snapshot;
                return {
                  ...snapshot,
                  runtime: update.runtime ? {
                    ...update.runtime,
                    resources: newestResources(snapshot.runtime.resources ?? EMPTY_RESOURCES, update.runtime.resources ?? EMPTY_RESOURCES),
                  } : snapshot.runtime,
                  lastLaunchedAt: update.lastLaunchedAt ?? snapshot.lastLaunchedAt,
                  reservation: update.reservation !== undefined ? update.reservation : snapshot.reservation,
                  storage: update.storage ?? snapshot.storage,
                  testRuns: update.testRuns ?? snapshot.testRuns,
                  testHistoryComplete: update.testHistoryComplete ?? snapshot.testHistoryComplete,
                };
              }),
            }));
          }
          setObservedAt(Date.now());
          setConnectionError(null);
        } catch (cause) {
          if (generation.current === activeGeneration && !(cause instanceof DOMException && cause.name === "AbortError")) {
            setConnectionError(cause instanceof Error ? cause.message : String(cause));
          }
        } finally {
          if (generation.current === activeGeneration) setLoading(false);
          if (requestAbort.current === controller) requestAbort.current = null;
        }
      }
    })().finally(() => {
      if (inFlight.current === operation) inFlight.current = null;
    });
    inFlight.current = operation;
    return operation;
  }, [locale, t]);

  const resetRequests = useCallback(() => {
    generation.current += 1;
    requestAbort.current?.abort();
    requestAbort.current = null;
    pending.current = emptyPending();
    inFlight.current = null;
  }, []);

  const signIn = useCallback((value: string, persist = true) => {
    const accessToken = value.trim();
    if (!accessToken) return;
    resetRequests();
    if (persist) window.sessionStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    setAccessRequired(null);
    setLoading(true);
    setToken(accessToken);
    void reconcile(accessToken, { bootstrap: true });
  }, [reconcile, resetRequests]);

  const signOut = useCallback(() => {
    resetRequests();
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    window.sessionStorage.removeItem(KNOWLEDGE_TOKEN_KEY);
    setToken("");
    setKnowledgeToken("");
    setKnowledgeSessionVersion(current => current + 1);
    setAccessRequired("missing");
  }, [resetRequests]);

  useEffect(() => {
    const probe = new AbortController();
    const initialRefresh = window.setTimeout(() => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = fragment.get("token") ?? window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
      if (window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setKnowledgeToken(window.sessionStorage.getItem(KNOWLEDGE_TOKEN_KEY) ?? "");
      if (accessToken) {
        signIn(accessToken);
        return;
      }
      // Open mode accepts requests without credentials; anything else asks for a token.
      void fetch("/api/dashboard", { cache: "no-store", signal: probe.signal }).then((response) => {
        if (response.ok) signIn(OPEN_ACCESS, false);
        else throw new Error("Credentials required");
      }).catch(() => {
        if (probe.signal.aborted) return;
        setLoading(false);
        setAccessRequired("missing");
      });
    }, 0);
    return () => {
      window.clearTimeout(initialRefresh);
      probe.abort();
      resetRequests();
    };
  }, [resetRequests, signIn]);

  useEffect(() => {
    if (!token) return;
    const focusHandler = () => void reconcile(token, { bootstrap: true });
    window.addEventListener("focus", focusHandler);
    return () => window.removeEventListener("focus", focusHandler);
  }, [reconcile, token]);

  // A credential change must update the shared stream's HTTP headers, but does not
  // restart runtime bootstrap, abort runtime reads or install another subscription.
  const eventVersion = useRef<string | null>(null);
  const streamInterrupted = useRef(false);
  useEffect(() => {
    if (!token) return;
    let readyCount = 0;
    const events = connectDashboardEvents({
      token,
      knowledgeToken,
      onEvent(type, payload) {
        if (type === "knowledge-changed") {
          try {
            const value = JSON.parse(payload) as { projectIds: string[] };
            if (Array.isArray(value.projectIds) && value.projectIds.every(id => typeof id === "string")) setKnowledgeChange(current => ({ version: current.version + 1, projectIds: value.projectIds }));
          } catch { /* A reconnect reconciles knowledge separately. */ }
          return;
        }
        if (type === "ready") {
          setKnowledgeChange(current => ({ version: current.version + 1, projectIds: [] }));
          let version: string | null = null;
          try {
            const value = JSON.parse(payload) as Pick<DashboardChangeEvent, "epoch" | "revision">;
            if (typeof value.epoch === "string" && Number.isInteger(value.revision)) version = JSON.stringify([value.epoch, value.revision]);
          } catch { /* Unknown versions require reconciliation after a reconnect. */ }
          if (readyCount > 0 || streamInterrupted.current || (eventVersion.current !== null && eventVersion.current !== version)) {
            void reconcile(token, { bootstrap: true });
          }
          readyCount += 1;
          eventVersion.current = version;
          streamInterrupted.current = false;
          return;
        }
        if (type !== "changed") return;
        try {
          const change = JSON.parse(payload) as DashboardChangeEvent;
          eventVersion.current = JSON.stringify([change.epoch, change.revision]);
          if (change.kinds.includes("topology") || change.kinds.includes("metadata")) {
            void reconcile(token, { bootstrap: true });
            return;
          }
          const sections = change.kinds.filter((kind): kind is DashboardSection =>
            ["runtime", "reservation", "tests", "storage", "controller"].includes(kind),
          );
          void reconcile(token, { projectIds: change.allProjects ? [] : change.projectIds, sections });
        } catch {
          void reconcile(token, { bootstrap: true });
        }
      },
      onError: () => { streamInterrupted.current = true; setConnectionError(t("dashboard.connectionLost")); },
      // After a rotation or mode change the bootstrap read shows the sign-in form on 401.
      onUnauthorized: () => void reconcile(token, { bootstrap: true }),
    });
    return () => events.close();
  }, [token, knowledgeToken, reconcile, t]);

  const mutate = useCallback(async (path: string, body: unknown, success: string, method: "POST" | "DELETE" = "POST") => {
    if (!token) throw new Error(t("dashboard.sessionPending"));
    setNotice(null);
    const response = await fetch(path, {
      method,
      headers: { "Accept-Language": locale, "Content-Type": "application/json", "X-Worktree-Switcher-Token": token },
      body: JSON.stringify(body),
    });
    await parseResponse(response, t("http.error", { status: response.status }));
    setNotice(success);
    setError(null);
    await reconcile(token, { bootstrap: true });
  }, [locale, reconcile, t, token]);

  const runningCount = useMemo(
    () => data.projects.filter(({ runtime }) => runtime.phase === "running").length,
    [data.projects],
  );
  const monitoredProjectIds = useMemo(
    () => data.projects.filter(({ runtime }) => runtime.phase === "running" || runtime.phase === "starting").map(({ project }) => project.id).join(","),
    [data.projects],
  );

  useEffect(() => {
    if (!token || !monitoredProjectIds) return;
    let cancelled = false;
    let polling = false;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (polling) return;
      polling = true;
      controller = new AbortController();
      try {
        const response = await fetch("/api/metrics", {
          cache: "no-store",
          signal: controller.signal,
          headers: { "X-Worktree-Switcher-Token": token },
        });
        const body = await parseResponse<RuntimeMetricsResponse>(response, t("http.error", { status: response.status }));
        if (cancelled) return;
        setObservedAt(Date.now());
        const metrics = new Map(body.projects.map(({ projectId, resources }) => [projectId, resources]));
        setData((current) => ({
          ...current,
          projects: current.projects.map((snapshot) => ({
            ...snapshot,
            runtime: {
              ...snapshot.runtime,
              resources: newestResources(snapshot.runtime.resources ?? EMPTY_RESOURCES, metrics.get(snapshot.project.id) ?? snapshot.runtime.resources ?? EMPTY_RESOURCES),
            },
          })),
        }));
      } catch {
        // The dashboard/SSE connection owns the visible connection error state.
      } finally {
        polling = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [monitoredProjectIds, t, token]);

  return { data, observedAt, token, accessRequired, signIn, signOut, knowledgeToken, knowledgeAccess, knowledgeSessionVersion,
    changeKnowledgeToken, knowledgeChange, loading, error: connectionError ?? error, notice, dismissNotice: () => setNotice(null), mutate, setError, runningCount };
}
