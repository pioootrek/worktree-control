"use client";

import { RecordAttachments } from "./record-attachments";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Expand, Search, Shrink, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { knowledgeSourceHref as sourceHref } from "@/shared/contracts/knowledge-links";
import type { KnowledgeMemory, KnowledgeSearchHit } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeHistoryEntry, KnowledgePage, KnowledgeInput, KnowledgeOperation } from "@/shared/contracts/knowledge";
import { knowledgeRequest, KnowledgeClientError } from "./knowledge-client";
import { MemoryEditor, knowledgeRetryKey } from "./memory-editor";
import { fieldClass } from "./knowledge-editor";
import type { KnowledgeTab } from "./use-knowledge";

export { knowledgeSourceHref as sourceHref } from "@/shared/contracts/knowledge-links";

type MemoryPanelProps = {
  token: string; principalId: string; projectId: string; recordId: string; writable: boolean; approvable: boolean; changeVersion: number;
  onSelect: (tab: KnowledgeTab, id: string) => void;
};
type MemorySearchState = {
  query: string; tag: string; legacyId: string; kind: KnowledgeSearchHit["kind"] | "";
  status: "active" | "archived" | "superseded" | "open" | "in_progress" | "blocked" | "done" | "";
  inactive: boolean; offset: number;
};

export function MemoryPanel(props: MemoryPanelProps) {
  const [search, setSearch] = useState<MemorySearchState>({ query: "", tag: "", legacyId: "", kind: "memory", status: "", inactive: false, offset: 0 });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [readerExpanded, setReaderExpanded] = useState(false);
  const listScrollRef = useRef(0);
  const returnFocusIdRef = useRef("");
  const previousRecordIdRef = useRef(props.recordId);
  useEffect(() => {
    if (previousRecordIdRef.current && !props.recordId) returnFocusIdRef.current = previousRecordIdRef.current;
    previousRecordIdRef.current = props.recordId;
  }, [props.recordId]);
  // Search survives selection; pending writes and drafts belong to one record.
  return <MemoryPanelContent key={props.recordId} {...props} onSelect={(tab, id) => { setReaderExpanded(false); props.onSelect(tab, id); }} search={search} setSearch={setSearch} filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen} readerExpanded={readerExpanded} setReaderExpanded={setReaderExpanded} listScrollRef={listScrollRef} returnFocusIdRef={returnFocusIdRef} />;
}

function MemoryPanelContent({ token, principalId, projectId, recordId, writable, approvable, changeVersion, onSelect, search, setSearch, filtersOpen, setFiltersOpen, readerExpanded, setReaderExpanded, listScrollRef, returnFocusIdRef }: MemoryPanelProps & {
  search: MemorySearchState; setSearch: (value: MemorySearchState) => void;
  filtersOpen: boolean; setFiltersOpen: (value: boolean) => void; readerExpanded: boolean; setReaderExpanded: (value: boolean) => void;
  listScrollRef: React.RefObject<number>; returnFocusIdRef: React.RefObject<string>;
}) {
  const { t } = useI18n();
  const { query, tag, legacyId, kind, status, inactive, offset } = search;
  const [page, setPage] = useState<KnowledgePage<KnowledgeSearchHit>>({ items: [], nextOffset: null });
  const [pageLoaded, setPageLoaded] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [record, setRecord] = useState<KnowledgeMemory | null>(null);
  const [history, setHistory] = useState<KnowledgePage<KnowledgeHistoryEntry>>({ items: [], nextOffset: null });
  const [historyError, setHistoryError] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replacement, setReplacement] = useState("");
  const [pending, setPending] = useState<{ operation: KnowledgeOperation; input: KnowledgeInput<KnowledgeOperation> } | null>(null);
  const focusReaderAfterSaveRef = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const readerRef = useRef<HTMLElement>(null);
  const focusedMobileRecordId = useRef("");
  const changeSearch = (next: MemorySearchState) => {
    listScrollRef.current = 0;
    listRef.current?.scrollTo({ top: 0 });
    setSearch(next);
  };
  useEffect(() => { if (pageLoaded && listRef.current) listRef.current.scrollTop = listScrollRef.current; }, [pageLoaded, listScrollRef]);
  useEffect(() => {
    if (recordId && record && focusedMobileRecordId.current !== recordId && window.matchMedia("(max-width: 1023px)").matches) {
      readerRef.current?.querySelector<HTMLElement>("h3")?.focus();
      focusedMobileRecordId.current = recordId;
    }
    if (!recordId && returnFocusIdRef.current && pageLoaded) {
      const link = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-record-id]") ?? []).find(node => node.dataset.recordId === returnFocusIdRef.current);
      (link ?? document.getElementById("memory-query"))?.focus({ preventScroll: true });
      returnFocusIdRef.current = "";
    }
  }, [recordId, record, page.items, pageLoaded, returnFocusIdRef]);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.allSettled([
      knowledgeRequest<KnowledgePage<KnowledgeSearchHit>>(token, "search", { projectId, query, offset, includeInactive: inactive, ...(tag ? { tag } : {}), ...(legacyId ? { legacyId } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) }, abort.signal),
      recordId ? knowledgeRequest<KnowledgeMemory>(token, "memory", { projectId, memoryId: recordId }, abort.signal) : Promise.resolve(null),
      recordId ? knowledgeRequest<KnowledgePage<KnowledgeHistoryEntry>>(token, "history", { projectId, recordKind: "memory", recordId, offset: historyOffset }, abort.signal) : Promise.resolve({ items: [], nextOffset: null }),
    ]).then(([rows, memory, entries]) => {
      if (abort.signal.aborted) return;
      setPage(rows.status === "fulfilled" ? rows.value : { items: [], nextOffset: null });
      setPageLoaded(true); setPageError(rows.status === "rejected");
      setRecord(memory.status === "fulfilled" ? memory.value : null);
      setError(current => memory.status === "rejected" ? "knowledge.loadFailed" : current === "knowledge.loadFailed" ? "" : current);
      setHistory(entries.status === "fulfilled" ? entries.value : { items: [], nextOffset: null });
      setHistoryError(entries.status === "rejected");
    });
    return () => abort.abort();
  }, [token, projectId, recordId, query, tag, legacyId, kind, status, inactive, offset, historyOffset, version, changeVersion]);

  const mutate = async (operation: "approve_memory" | "archive_memory" | "restore_memory" | "supersede_memory") => {
    if (!record) return;
    setBusy(true); setError("");
    try {
      let attempt = pending;
      if (!attempt) {
        const common = { projectId, memoryId: record.id, expectedRevision: record.revision, idempotencyKey: knowledgeRetryKey() };
        if (operation === "supersede_memory") {
          const target = await knowledgeRequest<KnowledgeMemory>(token, "memory", { projectId, memoryId: replacement });
          attempt = { operation, input: { ...common, replacementId: target.id, replacementRevision: target.revision } };
        } else attempt = { operation, input: common };
      }
      setPending(attempt);
      await knowledgeRequest(token, attempt.operation, attempt.input);
      setPending(null); setVersion(v => v + 1);
    } catch (error) {
      if (error instanceof KnowledgeClientError && error.status < 500) setPending(null);
      setError(error instanceof KnowledgeClientError && error.failure.code === "revision_conflict" ? "knowledge.conflict" : "knowledge.saveFailed");
      setVersion(v => v + 1);
    } finally { setBusy(false); }
  };
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeFilterCount = Number(Boolean(kind)) + Number(Boolean(tag)) + Number(Boolean(legacyId)) + Number(Boolean(status)) + Number(inactive);
  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    <form className={`space-y-3 ${recordId ? "hidden lg:block" : ""}`} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); changeSearch({ query: String(data.get("query") ?? ""), tag: String(data.get("tag") ?? ""), legacyId: String(data.get("legacy") ?? ""), kind: String(data.get("kind")) as typeof kind, status: String(data.get("status") ?? "") as typeof status, inactive: data.has("inactive"), offset: 0 }); setError(""); setVersion(v => v + 1); }}>
      <div className="flex flex-wrap items-end gap-3"><div className="min-w-[min(100%,16rem)] flex-1 space-y-1.5"><Label htmlFor="memory-query">{t("knowledge.searchContent")}</Label><div className="relative"><Search aria-hidden className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input className="h-9 pl-9" id="memory-query" name="query" defaultValue={query} maxLength={200} /></div></div>
      <Button className="h-9" type="button" variant="outline" aria-expanded={filtersOpen} aria-controls="memory-extra-filters" onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal aria-hidden className="size-4" />{t("knowledgeLayout.moreFilters")}{activeFilterCount > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums">{activeFilterCount}</span>}</Button>
      <Button className="h-9" type="submit" variant="outline">{t("knowledge.filter")}</Button>
      <Button className="h-9" disabled={!writable || busy || Boolean(pending)} onClick={event => { editorTriggerRef.current = event.currentTarget; setEditor("new"); }} type="button">{t("knowledge.addMemory")}</Button></div>
      <div id="memory-extra-filters" className={`flex flex-wrap items-end gap-3 rounded-lg bg-muted/40 p-3 ${filtersOpen ? "" : "hidden"}`}>
      <div className="min-w-36 flex-1 space-y-1.5"><Label htmlFor="memory-kind">{t("knowledge.sourceKind")}</Label><select id="memory-kind" name="kind" defaultValue={kind} className={`${fieldClass} h-9 !py-0`}><option value="">{t("knowledge.all")}</option>{(["memory", "task", "thread", "reply"] as const).map(value => <option key={value} value={value}>{t(`knowledge.source.${value}`)}</option>)}</select></div>
      <div className="min-w-36 flex-1 space-y-1.5"><Label htmlFor="memory-tag">{t("knowledge.tag")}</Label><Input className="h-9" id="memory-tag" name="tag" defaultValue={tag} maxLength={80} /></div>
      <div className="min-w-36 flex-1 space-y-1.5"><Label htmlFor="memory-legacy">{t("knowledge.legacyId")}</Label><Input className="h-9" id="memory-legacy" name="legacy" defaultValue={legacyId} maxLength={160} /></div>
      <div className="min-w-36 flex-1 space-y-1.5"><Label htmlFor="memory-status">{t("knowledge.status")}</Label><select id="memory-status" name="status" defaultValue={status} className={`${fieldClass} h-9 !py-0`}><option value="">{t("knowledge.all")}</option>{(["active", "archived", "superseded", "open", "in_progress", "blocked", "done"] as const).map(value => <option key={value} value={value}>{t(`knowledge.${value}`)}</option>)}</select></div>
      <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="inactive" defaultChecked={inactive} />{t("knowledge.includeInactive")}</label></div>
    </form>
    {error && !(recordId && !record && error === "knowledge.loadFailed") && <p role="alert">{t(error as "knowledge.saveFailed")}</p>}
    {pending && !busy && <Button variant="outline" onClick={() => void mutate(pending!.operation as "approve_memory")}>{t("knowledge.retryOperation")}</Button>}
    <Dialog open={Boolean(editor)} onOpenChange={open => { if (!open) setEditor(null); }}>
      {editor && (editor === "new" || record) && <DialogContent className="sm:max-w-2xl" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (focusReaderAfterSaveRef.current) { focusReaderAfterSaveRef.current = false; requestAnimationFrame(() => (document.querySelector<HTMLElement>("[data-memory-detail] h3") ?? document.querySelector<HTMLElement>("[data-memory-detail]"))?.focus()); return; } const trigger = editorTriggerRef.current; (trigger?.isConnected && trigger.getClientRects().length ? trigger : readerRef.current?.querySelector<HTMLElement>("h3") ?? document.getElementById("memory-query"))?.focus(); }}>
        <DialogTitle className="sr-only">{t(editor === "new" ? "knowledge.addMemory" : "knowledge.editMemory")}</DialogTitle>
        <MemoryEditor key={`${projectId}:${editor === "new" ? "new" : recordId}`} token={token} principalId={principalId} projectId={projectId} record={editor === "edit" ? record! : undefined} onClose={() => setEditor(null)} onConflict={() => setVersion(v => v + 1)} onSaved={id => { focusReaderAfterSaveRef.current = true; setEditor(null); setVersion(v => v + 1); onSelect("memory", id); }} />
      </DialogContent>}
    </Dialog>
    <div className={`grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden rounded-xl border border-border bg-card/30 ${recordId && !readerExpanded ? "lg:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]" : ""}`} data-memory-layout>
      <div className={`min-h-0 min-w-0 flex-col ${recordId ? readerExpanded ? "hidden" : "hidden lg:flex lg:border-r lg:border-border" : "flex"}`} data-memory-list><ul ref={listRef} onScroll={event => { listScrollRef.current = event.currentTarget.scrollTop; }} className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain" tabIndex={0} role="region" aria-label={t("knowledge.results")}>{page.items.map(row => <li className={`p-4 ${row.id === recordId ? "border-l-2 border-l-primary bg-primary/10" : "border-l-2 border-l-transparent"}`} key={`${row.kind}:${row.id}`}><a data-record-id={row.threadId ?? row.id} aria-current={row.id === recordId ? "true" : undefined} className={`block break-words text-base font-medium leading-snug hover:underline ${row.id === recordId ? "text-foreground" : ""}`} href={sourceHref(projectId, { kind: row.kind === "reply" ? "thread" : row.kind, id: row.threadId ?? row.id, revision: row.revision })} onClick={event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); setEditor(null); onSelect(row.kind === "memory" ? "memory" : row.kind === "task" ? "backlog" : "discussions", row.threadId ?? row.id);
      }}>{row.title || t("knowledge.source.reply")}</a><p className="mt-1 text-xs text-muted-foreground">{t(`knowledge.source.${row.kind}`)}</p><p className="mt-2 line-clamp-2 break-words text-sm text-muted-foreground">{row.excerpt}</p></li>)}</ul>
        {pageError && <div className="space-y-2 p-4"><p role="alert" className="text-sm text-destructive">{t("knowledge.loadFailed")}</p><Button variant="outline" onClick={() => setVersion(value => value + 1)}>{t("knowledge.refresh")}</Button></div>}
        {!pageError && pageLoaded && !page.items.length && <p className="p-4 text-sm text-muted-foreground">{t("knowledge.empty")}</p>}
        {(offset > 0 || page.nextOffset !== null) && <div className="flex justify-between gap-2 border-t border-border p-3"><Button variant="outline" disabled={!offset} onClick={() => changeSearch({ ...search, offset: Math.max(0, offset - 25) })}>{t("knowledge.previous")}</Button><Button variant="outline" disabled={page.nextOffset === null} onClick={() => changeSearch({ ...search, offset: page.nextOffset! })}>{t("knowledge.nextPage")}</Button></div>}
      </div>
      {recordId && <article ref={readerRef} tabIndex={-1} className="min-h-0 min-w-0 space-y-4 overflow-y-auto overscroll-contain p-5 sm:p-7" role="region" aria-label={t("knowledgeLayout.reader")} data-memory-detail>
        <div className="flex justify-between"><Button variant="ghost" className="lg:hidden" onClick={() => { returnFocusIdRef.current = recordId; onSelect("memory", ""); }}><ArrowLeft aria-hidden className="size-4" />{t("knowledge.backToList")}</Button><Button variant="ghost" className="ml-auto hidden lg:inline-flex" aria-pressed={readerExpanded} onClick={() => setReaderExpanded(!readerExpanded)}>{readerExpanded ? <Shrink aria-hidden className="size-4" /> : <Expand aria-hidden className="size-4" />}{t(readerExpanded ? "knowledgeLayout.showList" : "knowledgeLayout.expandReader")}</Button></div>
        {record ? <div className="mx-auto max-w-4xl space-y-5">
        <h3 tabIndex={-1} className="break-words text-2xl font-semibold leading-tight">{record.title}</h3>
        <p className="text-sm text-muted-foreground">{t("knowledge.attribution", { author: record.createdBy, revision: record.revision })}</p>
        <p>{t(`knowledge.${record.status}`)} · {t(record.approval?.revision === record.revision ? "knowledge.approved" : record.approval && record.status === "superseded" ? "knowledge.previouslyApproved" : "knowledge.proposed")}</p>
        {record.approval && <p className="break-all text-xs">{t("knowledge.approvedBy", { author: record.approval.principalId, revision: record.approval.revision })}</p>}
        <p className="max-w-[75ch] whitespace-pre-wrap break-words text-base leading-7">{record.body}</p>
        <RecordAttachments key={record.id} token={token} projectId={projectId} recordId={record.id} recordKind="memory" changeVersion={changeVersion} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!writable || record.status !== "active" || busy || Boolean(pending)} onClick={event => { editorTriggerRef.current = event.currentTarget; setEditor("edit"); }}>{t("knowledge.editMemory")}</Button>
          <Button disabled={!approvable || record.status !== "active" || Boolean(record.approval) || busy || Boolean(pending)} onClick={() => void mutate("approve_memory")}>{t("knowledge.approve")}</Button>
          <Button variant="outline" disabled={!writable || record.status === "superseded" || busy || Boolean(pending)} onClick={() => void mutate(record.status === "archived" ? "restore_memory" : "archive_memory")}>{t(record.status === "archived" ? "knowledge.restoreMemory" : "knowledge.archiveMemory")}</Button>
        </div>
        {record.status === "active" && <div className="space-y-2"><Label htmlFor="memory-replacement">{t("knowledge.replacementId")}</Label><Input id="memory-replacement" value={replacement} onChange={e => setReplacement(e.target.value)} /><Button variant="outline" disabled={!writable || !replacement.trim() || busy || Boolean(pending)} onClick={() => void mutate("supersede_memory")}>{t("knowledge.supersede")}</Button></div>}
        <details className="border-t border-border pt-4"><summary className="cursor-pointer font-medium">{t("knowledgeLayout.moreDetails")}</summary><div className="space-y-3 pt-3"><p className="break-all text-xs text-muted-foreground">{record.id}</p><p className="break-words text-sm">{record.tags.join(", ")}{record.legacyId ? ` · ${record.legacyId}` : ""}</p><h4 className="font-medium">{t("knowledge.sources")}</h4><ul className="space-y-2">{record.sources.map((source, index) => <li className="break-all text-sm" key={index}>{source.kind === "repository" ? `${source.sourceId} · ${source.repository} · ${source.commit}:${source.path}` : source.kind === "reply" ? `${source.id} · r${source.revision}` : <a className="underline" href={sourceHref(projectId, source)}>{source.kind === "external" ? source.label : `${source.id} · r${source.revision}`}</a>}</li>)}</ul>{record.supersededBy && <a className="block break-all underline" href={sourceHref(projectId, { kind: "memory", ...record.supersededBy })}>{t("knowledge.replacement")}: {record.supersededBy.id} · r{record.supersededBy.revision}</a>}</div></details>
        <details><summary>{t("knowledge.history")}{historyError && <span className="ml-2 text-sm text-destructive">{t("knowledge.loadFailed")}</span>}</summary>{historyError && <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{t("knowledge.loadFailed")}</p><Button variant="outline" onClick={() => setVersion(value => value + 1)}>{t("knowledge.refresh")}</Button></div>}<ul className="space-y-2">{history.items.map(entry => <li className="break-all text-xs" key={entry.id}>{entry.operation} · r{entry.revision} · {entry.principalId}<pre className="max-h-40 overflow-auto whitespace-pre-wrap">{entry.previousJson}</pre></li>)}</ul>{(historyOffset > 0 || history.nextOffset !== null) && <div className="flex gap-2"><Button variant="outline" disabled={!historyOffset} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 25))}>{t("knowledge.previous")}</Button><Button variant="outline" disabled={history.nextOffset === null} onClick={() => setHistoryOffset(history.nextOffset!)}>{t("knowledge.nextPage")}</Button></div>}</details>
        </div> : error === "knowledge.loadFailed" ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{t("knowledge.loadFailed")}</p><Button variant="outline" onClick={() => setVersion(value => value + 1)}>{t("knowledge.refresh")}</Button></div> : <p role="status" className="text-sm text-muted-foreground">{t("knowledge.loading")}</p>}
      </article>}
    </div>
  </div>;
}
