"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TestHistoryPage, TestMetrics, TestRunComparison, TestSummaryEntry } from "@/shared/contracts/verification-history";
import { fetchTestComparison, fetchTestHistory, fetchTestMetrics, isAbort, latestRequestSlot, TelemetryRequestError } from "./telemetry-client";
import {
  chronologicalPair, currentCursor, DEFAULT_FILTERS, firstPage, historyFilter, nextPage, previousPage, toggleSelection,
  type PageTrail, type TelemetryFilters,
} from "./telemetry-model";

interface Loaded<T> { key: string; scope: string; data: T | null; error: TelemetryRequestError | null }
const failure = (cause: unknown) => cause instanceof TelemetryRequestError ? cause
  : new TelemetryRequestError("failed", cause instanceof Error ? cause.message : String(cause), null);

/**
 * Explicit, bounded reads for one project. Filters and the anchored window change
 * only through user actions; there is no timer and no automatic fetch-all.
 */
export function useTelemetry({ projectId, token, locale }: { projectId: string; token: string; locale: string }) {
  const access = useMemo(() => ({ token, locale }), [token, locale]);
  const [filters, setFiltersState] = useState<TelemetryFilters>(DEFAULT_FILTERS);
  const [anchor, setAnchor] = useState(() => Date.now());
  const [trail, setTrail] = useState<PageTrail>(firstPage);
  const [metrics, setMetrics] = useState<Loaded<TestMetrics> | null>(null);
  const [history, setHistory] = useState<Loaded<TestHistoryPage> | null>(null);
  const [selected, setSelected] = useState<TestSummaryEntry[]>([]);
  const [comparison, setComparison] = useState<{ pair: [string, string]; data: TestRunComparison | null; error: TelemetryRequestError | null } | null>(null);
  const [metricsSlot] = useState(latestRequestSlot);
  const [historySlot] = useState(latestRequestSlot);
  const [comparisonSlot] = useState(latestRequestSlot);

  const filter = useMemo(() => historyFilter(projectId, filters, anchor), [projectId, filters, anchor]);
  const cursor = currentCursor(trail);
  const scopeKey = JSON.stringify([projectId, filters]);
  const metricsKey = JSON.stringify([scopeKey, anchor]);
  const historyKey = JSON.stringify([metricsKey, cursor]);

  useEffect(() => {
    const request = metricsSlot.begin();
    fetchTestMetrics(access, filter, request.signal).then(
      (data) => { if (request.current()) setMetrics({ key: metricsKey, scope: scopeKey, data, error: null }); },
      (cause) => { if (!isAbort(cause) && request.current()) setMetrics({ key: metricsKey, scope: scopeKey, data: null, error: failure(cause) }); },
    );
    return () => metricsSlot.cancel();
  }, [access, filter, metricsKey, metricsSlot, scopeKey]);

  useEffect(() => {
    const request = historySlot.begin();
    fetchTestHistory(access, filter, cursor, request.signal).then(
      (data) => { if (request.current()) setHistory({ key: historyKey, scope: scopeKey, data, error: null }); },
      (cause) => { if (!isAbort(cause) && request.current()) setHistory({ key: historyKey, scope: scopeKey, data: null, error: failure(cause) }); },
    );
    return () => historySlot.cancel();
  }, [access, filter, cursor, historyKey, historySlot, scopeKey]);

  useEffect(() => () => comparisonSlot.cancel(), [comparisonSlot]);

  const closeComparison = useCallback(() => { comparisonSlot.cancel(); setComparison(null); }, [comparisonSlot]);

  /** A filter change starts a new result set: page, selection and comparison are cleared. */
  const setFilters = useCallback((next: Partial<TelemetryFilters>) => {
    setFiltersState((current) => ({ ...current, ...next }));
    setAnchor(Date.now());
    setTrail(firstPage());
    setSelected([]);
    closeComparison();
  }, [closeComparison]);

  const clearFilters = useCallback(() => setFilters({ presetId: null, worktreePath: null, processOutcome: null, attribution: null }), [setFilters]);

  /** Re-anchors the window at now. Cursors are window-bound, so listing restarts at its first page. */
  const refresh = useCallback(() => { setAnchor(Date.now()); setTrail(firstPage()); }, []);

  const historyPage = history?.key === historyKey ? history : null;
  const goNext = useCallback(() => {
    const next = historyPage?.data?.nextCursor ?? null;
    if (next) setTrail((current) => nextPage(current, next));
  }, [historyPage]);
  const goPrevious = useCallback(() => setTrail(previousPage), []);
  const restartListing = useCallback(() => { setAnchor(Date.now()); setTrail(firstPage()); }, []);

  const toggle = useCallback((entry: TestSummaryEntry) => {
    setSelected((current) => {
      const ids = toggleSelection(current.map((item) => item.summary.runId), entry.summary.runId);
      const known = new Map([...current, entry].map((item) => [item.summary.runId, item]));
      return ids.map((id) => known.get(id)!).filter(Boolean);
    });
  }, []);
  const clearSelection = useCallback(() => setSelected([]), []);

  const compare = useCallback(async () => {
    const pair = chronologicalPair(selected.map((entry) => ({ runId: entry.summary.runId, queuedAt: entry.summary.queuedAt })));
    if (!pair) return;
    const request = comparisonSlot.begin();
    setComparison({ pair, data: null, error: null });
    try {
      const data = await fetchTestComparison(access, projectId, pair[0], pair[1], request.signal);
      if (request.current()) setComparison({ pair, data, error: null });
    } catch (cause) {
      if (!isAbort(cause) && request.current()) setComparison({ pair, data: null, error: failure(cause) });
    }
  }, [access, comparisonSlot, projectId, selected]);

  const currentMetrics = metrics?.key === metricsKey ? metrics : null;
  // A refresh of the same scope keeps the previous summary visible while it revalidates.
  const shownMetrics = currentMetrics ?? (metrics?.data && metrics.scope === scopeKey ? metrics : null);

  return {
    filters, setFilters, clearFilters, refresh, anchor, filter,
    metrics: { data: shownMetrics?.data ?? null, error: currentMetrics?.error ?? null, loading: !currentMetrics, stale: !currentMetrics && !!shownMetrics },
    history: { data: historyPage?.data ?? null, error: historyPage?.error ?? null, loading: !historyPage, pageIndex: trail.index, key: historyKey },
    goNext, goPrevious, restartListing,
    selected, toggle, clearSelection,
    comparison, compare, closeComparison,
  };
}
export type TelemetryState = ReturnType<typeof useTelemetry>;
