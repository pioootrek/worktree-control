"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { KnowledgeHistoryEntry, KnowledgeMemoryHistorySnapshot, KnowledgePage } from "@/shared/contracts/knowledge";
import { knowledgeRequest } from "./knowledge-client";

type Props = { token: string; principalId: string; projectId: string; recordId: string; changeVersion: number };
type Field = keyof KnowledgeMemoryHistorySnapshot;
const fields: Field[] = ["title", "body", "category", "status", "tags", "legacyId", "sources", "approval", "supersededBy"];

export function MemoryHistory({ token, principalId, projectId, recordId, changeVersion }: Props) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<KnowledgePage<KnowledgeHistoryEntry>>({ items: [], nextOffset: null });
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const requestKey = JSON.stringify([token, principalId, projectId, recordId, offset, changeVersion, retry]);
  const [settledKey, setSettledKey] = useState("");
  const loading = open && settledKey !== requestKey;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const retryRef = useRef<HTMLDivElement>(null);
  const focusPageRef = useRef(false);
  const focusRetryRef = useRef(false);
  const focusPageErrorRef = useRef(false);
  useEffect(() => {
    if (!open || settledKey === requestKey) return;
    const abort = new AbortController();
    void knowledgeRequest<KnowledgePage<KnowledgeHistoryEntry>>(token, "history", { projectId, recordKind: "memory", recordId, offset }, abort.signal)
      .then(result => { if (!abort.signal.aborted) { setPage(result); setLoaded(true); setError(false); setSettledKey(requestKey); } })
      .catch(() => { if (!abort.signal.aborted) { focusPageErrorRef.current = focusPageRef.current; focusPageRef.current = false; setError(true); setSettledKey(requestKey); } });
    return () => abort.abort();
  }, [open, settledKey, requestKey, token, projectId, recordId, offset]);
  useEffect(() => {
    if (open && error && !loading && (focusPageErrorRef.current || focusRetryRef.current)) { focusPageErrorRef.current = false; focusRetryRef.current = false; retryRef.current?.querySelector<HTMLElement>("button")?.focus(); }
    if (!open || loading || !loaded || error) return;
    if (focusPageRef.current) { focusPageRef.current = false; (listRef.current?.querySelector<HTMLElement>("[data-history-entry]") ?? summaryRef.current)?.focus(); }
    else if (focusRetryRef.current) { focusRetryRef.current = false; summaryRef.current?.focus(); }
  }, [open, loading, loaded, error, page]);
  const move = (next: number) => { focusPageRef.current = true; setOffset(next); setLoaded(false); setPage({ items: [], nextOffset: null }); };
  return <details className="border-t border-border pt-4" open={open} onToggle={event => { if (!event.currentTarget.open) { focusPageRef.current = false; focusRetryRef.current = false; focusPageErrorRef.current = false; } setOpen(event.currentTarget.open); }}>
    <summary ref={summaryRef} className="cursor-pointer font-medium">{t("knowledge.history")}</summary>
    <div className="space-y-3 pt-3">
      {loading && <p role="status" className="text-sm text-muted-foreground">{t("knowledge.historyLoading")}</p>}
      {error && <div ref={retryRef} className="space-y-2"><p role="alert" className="text-sm text-destructive">{t("knowledge.historyFailed")}</p><Button variant="outline" disabled={loading} onClick={() => { focusRetryRef.current = true; setRetry(value => value + 1); }}>{t("knowledge.refresh")}</Button></div>}
      {!loading && !error && loaded && page.items.length === 0 && <p className="text-sm text-muted-foreground">{t("knowledge.historyEmpty")}</p>}
      {!error && <ol ref={listRef} className="space-y-3">{page.items.map(entry => <HistoryItem key={entry.id} entry={entry} locale={locale} t={t} />)}</ol>}
      {!error && (offset > 0 || page.nextOffset !== null) && <nav aria-label={t("knowledge.historyPages")} className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading || offset === 0} onClick={() => move(Math.max(0, offset - 25))}>{t("knowledge.previous")}</Button><Button variant="outline" disabled={loading || page.nextOffset === null} onClick={() => move(page.nextOffset!)}>{t("knowledge.nextPage")}</Button></nav>}
    </div>
  </details>;
}

function HistoryItem({ entry, locale, t }: { entry: KnowledgeHistoryEntry; locale: string; t: ReturnType<typeof useI18n>["t"] }) {
  const comparison = entry.comparison;
  const restored = entry.operation === "updated" && comparison?.before?.status === "archived" && comparison.after.status === "active";
  const operation = restored ? "restored" : entry.operation;
  const date = new Date(entry.createdAt);
  const when = Number.isNaN(date.getTime()) ? t("knowledge.historyUnknownDate") : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
  return <li data-history-entry tabIndex={-1} className="min-w-0 rounded-md border border-border p-3 text-sm focus-visible:outline-2 focus-visible:outline-primary">
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><strong>{t(`knowledge.historyOperation.${operation}` as "knowledge.historyOperation.updated")}</strong><time dateTime={Number.isNaN(date.getTime()) ? undefined : entry.createdAt} className="text-muted-foreground">{when}</time><span className="text-muted-foreground">{t("knowledge.recordMetadata", { revision: entry.revision })}</span></p>
    <p className="mt-1 break-words text-xs text-muted-foreground">{t("knowledge.historyRecordedBy", { principal: entry.principalId.length > 160 ? `${entry.principalId.slice(0, 160)}…` : entry.principalId })}</p>
    <details className="mt-3"><summary className="cursor-pointer font-medium">{t("knowledge.historyCompare")}</summary>
      {comparison ? <div className="mt-3 space-y-3">{fields.filter(field => comparison.before === null || !equalField(comparison.before[field], comparison.after[field])).length === 0 && <p className="text-sm text-muted-foreground">{t("knowledge.historyNoFieldChange")}</p>}{fields.filter(field => comparison.before === null || !equalField(comparison.before[field], comparison.after[field])).map(field => <section key={field} className="min-w-0 border-t border-border pt-2"><h5 className="font-medium">{t(`knowledge.historyField.${field}` as "knowledge.historyField.title")}</h5><div className="grid min-w-0 gap-2 sm:grid-cols-2"><Value label={t("knowledge.historyBefore")} value={comparison.before?.[field]} field={field} t={t} locale={locale} /><Value label={t("knowledge.historyAfter")} value={comparison.after[field]} field={field} t={t} locale={locale} /></div></section>)}</div>
        : <p className="mt-2 text-sm text-muted-foreground">{t("knowledge.historyUnavailable")}</p>}
    </details>
    <details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">{t("knowledge.historyOriginal")}</summary><pre className="mt-2 max-h-60 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 text-xs">{entry.previousJson === null ? t("knowledge.historyNoPrevious") : entry.previousJson.slice(0, 65536)}</pre>{entry.previousJson && entry.previousJson.length > 65536 && <p className="text-xs text-muted-foreground">{t("knowledge.historyOriginalTruncated")}</p>}</details>
  </li>;
}

function equalField(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function Value({ label, value, field, t, locale }: { label: string; value: unknown; field: Field; t: ReturnType<typeof useI18n>["t"]; locale: string }) {
  let content: React.ReactNode;
  if (value === undefined || value === null) content = t("knowledge.historyNone");
  else if (field === "category" || field === "status") content = t(`knowledge.${value}` as "knowledge.active");
  else if (field === "tags") content = (value as string[]).length ? (value as string[]).join(", ") : t("knowledge.historyNone");
  else if (field === "sources") content = <ul className="list-inside list-disc space-y-1">{(value as KnowledgeMemoryHistorySnapshot["sources"]).map((source, index) => <li key={index}>{source.kind === "external" ? `${source.label} · ${source.url}` : source.kind === "repository" ? `${source.repository} · ${source.path} · ${source.commit}` : `${t(`knowledge.source.${source.kind}`)} · ${source.id} · r${source.revision}`}</li>)}</ul>;
  else if (field === "approval") { const approval = value as NonNullable<KnowledgeMemoryHistorySnapshot["approval"]>; const date = new Date(approval.approvedAt); content = `${approval.principalId} · r${approval.revision} · ${Number.isNaN(date.getTime()) ? approval.approvedAt : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)}`; }
  else if (field === "supersededBy") { const replacement = value as NonNullable<KnowledgeMemoryHistorySnapshot["supersededBy"]>; content = `${replacement.id} · r${replacement.revision}`; }
  else content = value as string;
  return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><div className="max-w-[75ch] whitespace-pre-wrap break-words">{content}</div></div>;
}
