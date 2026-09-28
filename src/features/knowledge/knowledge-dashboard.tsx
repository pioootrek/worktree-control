"use client";

import { RecordAttachments } from "./record-attachments";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Search, ArrowLeft, ArrowUpRight, MessageSquare, RefreshCw, Expand, Shrink, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TaskStatus } from "./task-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/provider";
import type { KnowledgeFilters } from "@/shared/contracts/knowledge";
import { isKnowledgeAccessError, knowledgeIdentity } from "./knowledge-client";
import { KnowledgeEditor, fieldClass, type EditorMode } from "./knowledge-editor";
import { MemoryPanel } from "./memory-panel";
import { TaskContext } from "./task-context";
import { useKnowledge, type KnowledgeTab } from "./use-knowledge";

export function KnowledgeDashboard({ token, setToken, change }: { token: string; setToken: (value: string) => void; change: { version: number; projectIds: string[] } }) {
  const { t } = useI18n();
  const [credential, setCredential] = useState("");
  const [loginError, setLoginError] = useState<"auth" | "load" | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, updateMode] = useState<EditorMode | null>(null);
  const setMode = (next: EditorMode | null) => {
    updateMode(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("knowledgeEditor", next); else url.searchParams.delete("knowledgeEditor");
    window.history.replaceState(null, "", url);
  };
  useEffect(() => {
    const sync = () => {
      const value = new URLSearchParams(window.location.search).get("knowledgeEditor");
      updateMode(value && ["thread", "task", "reply", "from_thread", "edit"].includes(value) ? value as EditorMode : null);
    };
    const timer = setTimeout(sync, 0); window.addEventListener("popstate", sync);
    return () => { clearTimeout(timer); window.removeEventListener("popstate", sync); };
  }, []);
  const [notice, setNotice] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [readerExpanded, setReaderExpanded] = useState(false);
  const returnFocusIdRef = useRef("");
  const focusedMobileRecordRef = useRef({ id: "", projectId: "", tab: "" });
  const focusReaderAfterSaveRef = useRef(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const model = useKnowledge(token, change);
  const { selection, identity, projects } = model;
  const detail = model.detail?.id === selection.recordId && model.detail.projectId === selection.projectId
    && ((selection.tab === "backlog" && "description" in model.detail) || (selection.tab === "discussions" && "body" in model.detail)) ? model.detail : null;
  useEffect(() => {
    const node = workspaceRef.current;
    if (!node) return;
    const measure = () => node.style.setProperty("--knowledge-top", `${node.getBoundingClientRect().top + window.scrollY}px`);
    measure(); window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [identity]);
  useEffect(() => { detailRef.current?.scrollTo({ top: 0 }); }, [selection.recordId]);
  useEffect(() => {
    if (selection.recordId && detail && focusedMobileRecordRef.current.id !== selection.recordId && window.matchMedia("(max-width: 1023px)").matches) {
      detailRef.current?.querySelector<HTMLElement>("h3")?.focus();
      focusedMobileRecordRef.current = { id: selection.recordId, projectId: selection.projectId, tab: selection.tab };
    } else if (!selection.recordId) {
      const previous = focusedMobileRecordRef.current;
      const targetId = returnFocusIdRef.current || (previous.projectId === selection.projectId && previous.tab === selection.tab ? previous.id : "");
      if (!targetId) return;
      const link = Array.from(workspaceRef.current?.querySelectorAll<HTMLAnchorElement>("[data-knowledge-list] a") ?? []).find(node => node.dataset.recordId === targetId);
      if (link || !model.loading) {
        (link ?? document.getElementById("knowledge-query"))?.focus({ preventScroll: true });
        returnFocusIdRef.current = "";
        focusedMobileRecordRef.current = { id: "", projectId: "", tab: "" };
      }
    }
  }, [selection.recordId, detail, model.rows.items, model.loading]);
  const project = model.project?.id === selection.projectId ? model.project : undefined;
  const writable = project?.writable && project.status === "active";
  const close = () => setMode(null);
  const navigate = (tab: KnowledgeTab, recordId = "", projectId = selection.projectId) => { close(); setNotice(false); setReaderExpanded(false); model.select({ tab, recordId, projectId }); };

  const editorReady = Boolean(mode && (mode === "task" || mode === "thread" || detail));
  const applyFilters = (filters: KnowledgeFilters) => { navigate(selection.tab); model.setFilters(filters); };
  const activeFilterCount = Number(Boolean(model.filters.status)) + Number(Boolean(model.filters.priority));

  if (!token || model.sessionError) return <form className="max-w-xl space-y-4 rounded-xl border border-border p-5" onSubmit={event => {
    event.preventDefault(); setBusy(true); setLoginError(null);
    void knowledgeIdentity(credential).then(() => { setToken(credential); setCredential(""); }).catch(error => setLoginError(isKnowledgeAccessError(error) ? "auth" : "load")).finally(() => setBusy(false));
  }}>
    <h3 className="text-lg font-semibold">{t("knowledge.signIn")}</h3>
    <p className="text-sm text-muted-foreground">{t("knowledge.signInHelp")}</p>
    {(loginError || model.sessionError) && <Alert variant="destructive"><AlertDescription>{t(loginError === "load" ? "knowledge.loadFailed" : "knowledge.sessionExpired")}</AlertDescription></Alert>}
    <Label htmlFor="knowledge-credential">{t("knowledge.credential")}</Label><Input id="knowledge-credential" type="password" value={credential} onChange={event => setCredential(event.target.value)} required autoComplete="off" />
    <Button type="submit" disabled={busy}>{t("knowledge.signIn")}</Button>
  </form>;

  if (!identity) return model.error ? <div className="space-y-3">
    <Alert variant="destructive"><AlertDescription>{t("knowledge.loadFailed")}</AlertDescription></Alert>
    <Button variant="outline" onClick={model.reload}><RefreshCw aria-hidden className="size-4" />{t("knowledge.refresh")}</Button>
    <Button variant="ghost" onClick={() => setToken("")}>{t("knowledge.signOut")}</Button>
  </div> : <p role="status">{t("knowledge.loading")}</p>;
  return <div ref={workspaceRef} className="flex min-w-0 flex-col gap-4 lg:h-[calc(100dvh-var(--knowledge-top,220px)-1.5rem)] lg:min-h-96" data-knowledge-workspace>
    <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-border pb-3">
      <div className="w-full min-w-0 space-y-1.5 sm:max-w-sm sm:flex-1"><Label htmlFor="knowledge-project">{t("knowledge.project")}</Label><select id="knowledge-project" className={`${fieldClass} h-9 !py-0`} value={selection.projectId} onChange={event => navigate(selection.tab, "", event.target.value)}>
        {!projects.items.length && <option value="">{t("knowledge.noProjects")}</option>}
        {selection.projectId && !projects.items.some(item => item.id === selection.projectId) && <option value={selection.projectId}>{project?.name ?? t("knowledge.linkedProject")}</option>}
        {projects.items.map(item => <option value={item.id} key={item.id}>{item.name}{item.status === "archived" ? ` · ${t("knowledge.archived")}` : ""}</option>)}
      </select></div>
      <div className="flex flex-wrap gap-2"><Button className="h-9" variant="outline" onClick={model.reload}><RefreshCw aria-hidden className="size-4" />{t("knowledge.refresh")}</Button>
      <Button className="h-9" variant="ghost" onClick={() => { close(); setToken(""); }}>{t("knowledge.signOut")}</Button></div>
    </div>
    {(model.projectOffset > 0 || projects.nextOffset !== null) && <div className="flex gap-2"><Button variant="outline" disabled={model.projectOffset === 0} onClick={() => model.setProjectOffset(Math.max(0, model.projectOffset - 25))}>{t("knowledge.previousProjects")}</Button><Button variant="outline" disabled={projects.nextOffset === null} onClick={() => model.setProjectOffset(projects.nextOffset!)}>{t("knowledge.nextProjects")}</Button></div>}
    {!projects.items.length && !selection.projectId && <p>{t("knowledge.noProjectsHelp")}</p>}
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3"><Tabs value={selection.tab} onValueChange={value => navigate(value as KnowledgeTab)}><TabsList aria-label={t("knowledge.title")} className="h-auto min-h-10 flex-wrap"><TabsTrigger className="min-h-9" value="backlog">{t("knowledge.backlog")}</TabsTrigger><TabsTrigger className="min-h-9" value="discussions">{t("knowledge.discussions")}</TabsTrigger><TabsTrigger className="min-h-9" value="memory">{t("knowledge.memory")}</TabsTrigger></TabsList></Tabs>{selection.tab !== "memory" && <Button ref={actionRef} disabled={!writable} onClick={event => { editorTriggerRef.current = event.currentTarget; setMode(selection.tab === "discussions" ? "thread" : "task"); setNotice(false); }}><Plus aria-hidden className="size-4" />{t(selection.tab === "backlog" ? "knowledge.addTask" : "knowledge.addDiscussion")}</Button>}</div>
    {notice && <p role="status" className="text-sm">{t("knowledge.saved")}</p>}
    {selection.tab === "memory" ? (selection.projectId ? <MemoryPanel key={`${identity.principal.id}:${selection.projectId}`} token={token} principalId={identity.principal.id} projectId={selection.projectId} recordId={selection.recordId} writable={Boolean(writable)} approvable={(identity.installationAuthority === true || (identity.principal.kind === "owner" && identity.credential?.kind === "owner_session")) && project?.status === "active"} changeVersion={change.version + model.refreshVersion} onSelect={navigate} /> : <p>{t("knowledge.noProjectsHelp")}</p>) : selection.projectId && <>
      <div className={`shrink-0 space-y-3 ${selection.recordId ? "hidden lg:block" : ""}`}>
        {!writable && <p className="text-sm text-muted-foreground">{t("knowledge.readOnly")}</p>}
        {selection.tab === "backlog" && <nav className="flex flex-wrap gap-1" aria-label={t("knowledge.taskViews")}>
          {(["active", "now", "next", "blocked", "done", "all"] as const).map(view => {
            const selected = view === "active" ? model.filters.activeOnly && !model.filters.priority && !model.filters.status
              : view === "all" ? !model.filters.activeOnly && !model.filters.priority && !model.filters.status
              : view === "now" || view === "next" ? model.filters.activeOnly && model.filters.priority === view && !model.filters.status
              : model.filters.status === view && !model.filters.priority;
            return <Button key={view} variant={selected ? "secondary" : "ghost"} size="sm" aria-pressed={Boolean(selected)} className={selected ? "border border-primary/40 bg-primary/10 text-foreground" : "text-muted-foreground"} onClick={() => applyFilters({ query: model.filters.query, activeOnly: view !== "done" && view !== "all", ...(view === "now" || view === "next" ? { priority: view } : view === "blocked" || view === "done" ? { status: view } : {}) })}>
              {t(`knowledge.${view}`)}<span className="ml-1 rounded bg-background/60 px-1.5 tabular-nums text-xs">{model.counts?.[view] ?? "…"}</span>
            </Button>;
          })}
        </nav>}
        <form className="space-y-3" key={`${selection.projectId}:${selection.tab}:${model.filters.status}:${model.filters.priority}`} onSubmit={event => {
          event.preventDefault(); const form = new FormData(event.currentTarget);
          const status = String(form.get("status") ?? "") as KnowledgeFilters["status"];
          applyFilters({ query: String(form.get("query") ?? ""), activeOnly: status === "done" || status === "archived" ? false : model.filters.activeOnly, ...(status ? { status } : {}), ...(form.get("priority") ? { priority: String(form.get("priority")) as KnowledgeFilters["priority"] } : {}) });
        }}>
          <div className="flex flex-wrap items-end gap-3"><div className="min-w-[min(100%,16rem)] flex-1 space-y-1.5"><Label htmlFor="knowledge-query">{t("knowledge.searchTitle")}</Label><div className="relative"><Search aria-hidden className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input className="h-9 pl-9" id="knowledge-query" name="query" placeholder={t("knowledge.searchPlaceholder")} maxLength={200} defaultValue={model.filters.query} /></div></div>
          {selection.tab === "backlog" && <Button className="h-9" type="button" variant="outline" aria-expanded={filtersOpen} aria-controls="knowledge-extra-filters" onClick={() => setFiltersOpen(value => !value)}><SlidersHorizontal aria-hidden className="size-4" />{t("knowledgeLayout.moreFilters")}{activeFilterCount > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums">{activeFilterCount}</span>}</Button>}
          <Button className="h-9" type="submit" variant="outline">{t("knowledge.filter")}</Button></div>
          {selection.tab === "backlog" && <div id="knowledge-extra-filters" className={`flex flex-wrap items-end gap-3 rounded-lg bg-muted/40 p-3 ${filtersOpen ? "" : "hidden"}`}>
            <div className="min-w-36 flex-1 space-y-1.5"><Label htmlFor="knowledge-status">{t("knowledge.status")}</Label><select id="knowledge-status" name="status" defaultValue={model.filters.status ?? ""} className={`${fieldClass} h-9 !py-0`}><option value="">{t("knowledge.all")}</option>{(["open", "in_progress", "blocked", "done", "archived"] as const).map(value => <option key={value} value={value}>{t(`knowledge.${value}`)}</option>)}</select></div>
            <div className="min-w-36 flex-1 space-y-1.5"><Label htmlFor="knowledge-priority">{t("knowledge.priority")}</Label><select id="knowledge-priority" name="priority" defaultValue={model.filters.priority ?? ""} className={`${fieldClass} h-9 !py-0`}><option value="">{t("knowledge.all")}</option>{(["now", "next", "later"] as const).map(value => <option key={value} value={value}>{t(`knowledge.${value}`)}</option>)}</select></div>
          </div>}
        </form>
      </div>
      {model.error && !editorReady && (!selection.recordId || detail) && <Alert variant="destructive"><AlertDescription>{t("knowledge.loadFailed")}</AlertDescription></Alert>}
      {model.loading && <p role="status">{t("knowledge.loading")}</p>}
      <Dialog open={editorReady} onOpenChange={open => { if (!open) close(); }}>
        {mode && editorReady && <DialogContent className="sm:max-w-2xl" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); if (focusReaderAfterSaveRef.current) { focusReaderAfterSaveRef.current = false; detailRef.current?.focus(); return; } const trigger = editorTriggerRef.current?.isConnected && editorTriggerRef.current.getClientRects().length ? editorTriggerRef.current : actionRef.current; trigger?.focus(); }}>
          <DialogTitle className="sr-only">{t(mode === "edit" ? "knowledge.edit" : mode === "reply" ? "knowledge.reply" : mode === "thread" ? "knowledge.addDiscussion" : "knowledge.addTask")}</DialogTitle>
          {model.error && <Alert variant="destructive"><AlertDescription>{t("knowledge.loadFailed")}</AlertDescription></Alert>}
          <Button variant="ghost" className="mr-8 w-fit" onClick={model.reload}><RefreshCw aria-hidden className="size-4" />{t("knowledge.refresh")}</Button>
          <KnowledgeEditor key={`${identity.principal.id}:${selection.projectId}:${mode}:${mode === "task" || mode === "thread" ? "new" : selection.recordId}`} token={token} principalId={identity.principal.id} projectId={selection.projectId} mode={mode} record={mode === "thread" || mode === "task" ? undefined : detail ?? undefined} onCancel={close} onConflict={model.reload} onSaved={(recordId, tab) => { focusReaderAfterSaveRef.current = true; close(); setNotice(true); model.select({ ...selection, tab: tab ?? selection.tab, recordId: recordId ?? selection.recordId }); model.reload(); }} />
        </DialogContent>}
      </Dialog>
      <div className={`grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden rounded-xl border border-border bg-card/30 ${selection.recordId && !readerExpanded ? "lg:grid-cols-[minmax(320px,360px)_minmax(0,1fr)]" : ""}`} data-knowledge-layout>
        <div className={`min-h-0 min-w-0 flex-col ${selection.recordId ? readerExpanded ? "hidden" : "hidden lg:flex lg:border-r lg:border-border" : "flex"}`} data-knowledge-list>
          <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm font-medium"><span>{t(selection.tab === "backlog" ? "knowledge.backlog" : "knowledge.discussions")}</span><span className="text-xs tabular-nums text-muted-foreground">{model.total !== null ? t("knowledge.resultCount", { count: model.total }) : model.rows.items.length}</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" tabIndex={0} role="region" aria-label={t("knowledge.results")} data-knowledge-list-scroll>
          <ul className="divide-y divide-border" aria-label={t(selection.tab === "backlog" ? "knowledge.backlog" : "knowledge.discussions")}>
            {model.rows.items.map(row => <li key={row.id}><a data-record-id={row.id} className={`block space-y-2 border-l-2 px-4 py-4 outline-offset-[-3px] transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring ${row.id === selection.recordId ? "border-l-primary bg-primary/10 text-foreground" : "border-l-transparent"}`} aria-label={row.title} aria-current={row.id === selection.recordId ? "true" : undefined} href={`?view=knowledge&knowledgeProject=${encodeURIComponent(selection.projectId)}&knowledgeTab=${selection.tab}&record=${encodeURIComponent(row.id)}`} onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(selection.tab, row.id); }}><span className="block break-words text-base font-medium leading-snug">{row.title}</span>{"status" in row && <TaskStatus status={row.status} priority={row.priority} />}</a></li>)}
          </ul>
          {!model.loading && !model.error && model.rows.items.length === 0 && <p className="px-4 py-8 text-sm text-muted-foreground">{t("knowledge.empty")}</p>}
          </div>
          {(model.offset > 0 || model.rows.nextOffset !== null) && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3"><Button size="sm" variant="ghost" disabled={model.offset === 0 || model.loading} onClick={() => model.setOffset(Math.max(0, model.offset - 25))}>{t("knowledge.previous")}</Button><span className="text-xs tabular-nums text-muted-foreground">{t("knowledge.pageNumber", { page: Math.floor(model.offset / 25) + 1 })}</span><Button size="sm" variant="ghost" disabled={model.rows.nextOffset === null || model.loading} onClick={() => model.setOffset(model.rows.nextOffset!)}>{t("knowledge.nextPage")}</Button></div>}
        </div>
        <div ref={detailRef} tabIndex={-1} role="region" aria-label={t("knowledgeLayout.reader")} className={`min-h-0 min-w-0 overflow-y-auto overscroll-contain ${selection.recordId ? "block" : "hidden"}`} data-knowledge-detail>
          {selection.recordId && <div className="flex justify-between border-b border-border px-3 py-2"><Button variant="ghost" className="lg:hidden" onClick={() => { returnFocusIdRef.current = selection.recordId; navigate(selection.tab); }}><ArrowLeft aria-hidden className="size-4" />{t("knowledge.backToList")}</Button><Button variant="ghost" className="ml-auto hidden lg:inline-flex" aria-pressed={readerExpanded} onClick={() => setReaderExpanded(value => !value)}>{readerExpanded ? <Shrink aria-hidden className="size-4" /> : <Expand aria-hidden className="size-4" />}{t(readerExpanded ? "knowledgeLayout.showList" : "knowledgeLayout.expandReader")}</Button></div>}
          {detail ? <article className="mx-auto max-w-4xl space-y-5 p-5 sm:p-7">
            <div className="space-y-3">{"description" in detail && <TaskStatus status={detail.status} priority={detail.priority} />}<h3 tabIndex={-1} className="break-words text-2xl font-semibold leading-tight tracking-tight">{detail.title}</h3></div>
            <p className="text-sm text-muted-foreground">{t("knowledge.attribution", { author: detail.createdBy, revision: detail.revision })}</p>
            <p className="max-w-[75ch] whitespace-pre-wrap break-words text-base leading-7">{"description" in detail ? detail.description : detail.body}</p>
            {"body" in detail && <section className="max-w-[75ch] space-y-3" aria-label={t("knowledge.replies")}><h4 className="font-medium">{t("knowledge.replies")}</h4>{model.replies.items.map(reply => <div className="border-t border-border pt-4" key={reply.id}><p className="break-words text-sm text-muted-foreground">{t("knowledge.attribution", { author: reply.createdBy, revision: reply.revision })}</p>{reply.historicalImport && <p className="mt-1 break-words text-xs text-muted-foreground" data-historical-import>{t("knowledge.historicalImport", { author: reply.historicalImport.sourceAuthor ?? t("knowledge.historicalAuthorMissing"), date: reply.historicalImport.sourceDateStatus === "missing" ? t("knowledge.historicalDateMissing") : reply.historicalImport.sourceDate ?? t("knowledge.historicalDateMissing") })}{reply.historicalImport.sourceDateStatus === "invalid" ? ` · ${t("knowledge.historicalDateInvalid")}` : ""}</p>}<p className="mt-2 whitespace-pre-wrap break-words text-base leading-7">{reply.body}</p></div>)}{(model.replyOffset > 0 || model.replies.nextOffset !== null) && <div className="flex gap-2"><Button variant="outline" disabled={model.replyOffset === 0} onClick={() => model.setReplyOffset(Math.max(0, model.replyOffset - 25))}>{t("knowledge.previousReplies")}</Button><Button variant="outline" disabled={model.replies.nextOffset === null} onClick={() => model.setReplyOffset(model.replies.nextOffset!)}>{t("knowledge.nextReplies")}</Button></div>}</section>}
            <div className="flex flex-wrap gap-2">{"description" in detail ? <Button variant="outline" disabled={!writable} onClick={event => { editorTriggerRef.current = event.currentTarget; setMode("edit"); }}>{t("knowledge.edit")}</Button> : <><Button variant="outline" disabled={!writable} onClick={event => { editorTriggerRef.current = event.currentTarget; setMode("reply"); }}>{t("knowledge.reply")}</Button><Button variant="outline" disabled={!writable} onClick={event => { editorTriggerRef.current = event.currentTarget; setMode("from_thread"); }}>{t("knowledge.fromThread")}</Button></>}</div>
            {"description" in detail && <TaskContext key={`${selection.projectId}:${detail.id}`} token={token} projectId={selection.projectId} taskId={detail.id} changeVersion={change.version + detail.revision + model.refreshVersion} />}
            {"description" in detail && <RecordAttachments key={`${selection.projectId}:${detail.id}`} token={token} projectId={selection.projectId} recordId={detail.id} recordKind="task" changeVersion={change.version + model.refreshVersion} />}
            <details className="border-t border-border pt-4 text-sm"><summary className="cursor-pointer font-medium">{t("knowledgeLayout.moreDetails")}</summary><div className="space-y-4 pt-3"><p className="break-all text-xs text-muted-foreground">{t("knowledge.recordMetadata", { revision: detail.revision })} · {detail.id}</p>{"body" in detail && <RecordAttachments key={`${selection.projectId}:${detail.id}`} token={token} projectId={selection.projectId} recordId={detail.id} recordKind="thread" changeVersion={change.version + model.refreshVersion} />}
            {model.relations.items.length > 0 && <section className="space-y-3 border-t border-border pt-5" aria-label={t("knowledge.relations")}><h4 className="font-medium">{t("knowledge.relations")}</h4><ul className="space-y-2">{model.relations.items.map(relation => {
              const source = relation.sourceId === detail.id;
              const targetId = source ? relation.targetId : relation.sourceId;
              const targetKind = source ? relation.targetKind : relation.sourceKind;
              if (targetKind === "reply") return <li className="break-all text-sm" key={relation.id}>{targetId}</li>;
              const tab = targetKind === "task" ? "backlog" : "discussions";
              return <li key={relation.id}><a className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm hover:bg-muted" href={`?view=knowledge&knowledgeProject=${encodeURIComponent(selection.projectId)}&knowledgeTab=${tab}&record=${encodeURIComponent(targetId)}`} onClick={event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(tab, targetId); }}><MessageSquare aria-hidden className="size-4 shrink-0" /><span className="min-w-0"><span className="block">{t(targetKind === "task" ? "knowledge.relatedTask" : "knowledge.relatedThread")}</span><span className="block truncate font-mono text-xs text-muted-foreground">{targetId}</span></span><ArrowUpRight aria-hidden className="ml-auto size-4 shrink-0" /></a></li>;
            })}</ul>{(model.relationOffset > 0 || model.relations.nextOffset !== null) && <div className="flex gap-2"><Button variant="outline" disabled={model.relationOffset === 0} onClick={() => model.setRelationOffset(Math.max(0, model.relationOffset - 25))}>{t("knowledge.previous")}</Button><Button variant="outline" disabled={model.relations.nextOffset === null} onClick={() => model.setRelationOffset(model.relations.nextOffset!)}>{t("knowledge.nextPage")}</Button></div>}</section>}</div></details>
          </article> : selection.recordId ? <div className="space-y-3 p-6">{model.error ? <><p role="alert" className="text-sm text-destructive">{t("knowledge.loadFailed")}</p><Button variant="outline" onClick={model.reload}><RefreshCw aria-hidden className="size-4" />{t("knowledge.refresh")}</Button></> : <p role="status" className="text-sm text-muted-foreground">{t("knowledge.loading")}</p>}</div> : null}
        </div>
      </div>
    </>}
  </div>;
}
