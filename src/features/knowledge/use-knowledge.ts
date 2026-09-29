"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeTaskCounts, KnowledgeTaskPage, KnowledgeFilters, KnowledgeRelationView, KnowledgePage, KnowledgeProjectSummary, KnowledgeReplyPage, KnowledgeTask, KnowledgeTaskSummary, KnowledgeThread, KnowledgeThreadSummary } from "@/shared/contracts/knowledge";
import { isKnowledgeAccessError, knowledgeIdentity, knowledgeRequest, type KnowledgeIdentity } from "./knowledge-client";

export type KnowledgeTab = "backlog" | "discussions" | "memory";
export interface KnowledgeSelection { projectId: string; tab: KnowledgeTab; recordId: string; replyId?: string }
const emptyPage = <T,>(): KnowledgePage<T> => ({ items: [], nextOffset: null });

export function useKnowledge(token: string, change: { version: number; projectIds: string[] }) {
  const [identity, setIdentity] = useState<KnowledgeIdentity | null>(null);
  const [project, setProject] = useState<KnowledgeProjectSummary | null>(null);
  const [projects, setProjects] = useState(emptyPage<KnowledgeProjectSummary>);
  const [projectOffset, setProjectOffset] = useState(0);
  const [selection, setSelection] = useState<KnowledgeSelection>({ projectId: "", tab: "backlog", recordId: "" });
  const [ready, setReady] = useState(false);
  const [filters, setFilters] = useState<KnowledgeFilters>({ activeOnly: true });
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState(emptyPage<KnowledgeTaskSummary | KnowledgeThreadSummary>);
  const [counts, setCounts] = useState<KnowledgeTaskCounts | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [detail, setDetail] = useState<KnowledgeTask | KnowledgeThread | null>(null);
  const [replies, setReplies] = useState<KnowledgeReplyPage>({ ...emptyPage(), offset: 0 });
  const [relations, setRelations] = useState(emptyPage<KnowledgeRelationView>);
  const [relationOffset, setRelationOffset] = useState(0);
  const [replyOffset, setReplyOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const [revision, setRevision] = useState(0);
  const selectionRef = useRef(selection);
  const reload = useCallback(() => setRevision(value => value + 1), []);

  const changeSelection = useCallback((next: KnowledgeSelection) => {
    const previous = selectionRef.current;
    if (next.projectId === previous.projectId && next.tab === previous.tab && next.recordId === previous.recordId && (next.replyId ?? "") === (previous.replyId ?? "")) return;
    selectionRef.current = next;
    setSelection(next); setReplyOffset(0); setRelationOffset(0);
    setRelations(emptyPage()); setDetail(null); setReplies({ ...emptyPage(), offset: 0 }); setError(false);
    if (next.projectId !== previous.projectId || next.tab !== previous.tab) { setFilters({ activeOnly: true }); setOffset(0); setRows(emptyPage()); setCounts(null); setTotal(null); }
    if (next.projectId !== previous.projectId) setProject(null);
  }, []);

  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get("knowledgeTab");
      const recordId = params.get("record") ?? "";
      changeSelection({ projectId: params.get("knowledgeProject") ?? "", tab: tab === "discussions" || tab === "memory" ? tab : "backlog", recordId,
        replyId: tab === "discussions" && recordId ? params.get("reply") ?? "" : "" });
      setReady(true);
    };
    const timer = setTimeout(sync, 0);
    window.addEventListener("popstate", sync);
    return () => { clearTimeout(timer); window.removeEventListener("popstate", sync); };
  }, [changeSelection]);
  useEffect(() => {
    if (!change.projectIds.length || change.projectIds.includes(selectionRef.current.projectId)) {
      const timer = setTimeout(reload, 0);
      return () => clearTimeout(timer);
    }
  }, [change, reload]);

  const select = (next: KnowledgeSelection) => {
    const previous = selectionRef.current;
    changeSelection(next);
    const url = new URL(window.location.href);
    if (next.projectId !== previous.projectId || next.tab !== previous.tab || next.recordId !== previous.recordId || next.replyId !== previous.replyId) {
      url.searchParams.delete("document");
      url.hash = "";
    }
    url.searchParams.set("view", "knowledge");
    url.searchParams.set("knowledgeProject", next.projectId);
    url.searchParams.set("knowledgeTab", next.tab);
    if (next.recordId) url.searchParams.set("record", next.recordId); else url.searchParams.delete("record");
    if (next.tab === "discussions" && next.recordId && next.replyId) url.searchParams.set("reply", next.replyId); else url.searchParams.delete("reply");
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
  };

  useEffect(() => {
    if (!token || !ready) return;
    const abort = new AbortController();
    void Promise.all([
      knowledgeIdentity(token, abort.signal),
      knowledgeRequest<KnowledgePage<KnowledgeProjectSummary>>(token, "projects", { offset: projectOffset }, abort.signal),
    ]).then(([who, page]) => {
      if (abort.signal.aborted) return;
      setIdentity(current => current?.principal.id === who.principal.id ? current : who); setProjects(page); setSessionError(false); setDiscoveryError(false);
      if (!selectionRef.current.projectId && page.items[0]) {
        const projectId = page.items[0].id;
        changeSelection({ ...selectionRef.current, projectId });
        const url = new URL(window.location.href); url.searchParams.set("knowledgeProject", projectId); window.history.replaceState(null, "", url);
      }
    }).catch(error => {
      if (abort.signal.aborted) return;
      if (isKnowledgeAccessError(error)) {
        setIdentity(null); setProjects(emptyPage()); setProject(null); setDetail(null); setRows(emptyPage()); setReplies({ ...emptyPage(), offset: 0 }); setRelations(emptyPage()); setSessionError(true);
      } else setDiscoveryError(true);
    });
    return () => abort.abort();
  }, [token, ready, projectOffset, revision, changeSelection]);

  useEffect(() => {
    if (!token || !identity || !selection.projectId) return;
    const abort = new AbortController();
    const timer = setTimeout(() => setLoading(true), 0);
    void (async () => {
      try {
        const projectId = selection.projectId;
        const [page, record, responsePage, selectedProject, relationPage] = await Promise.all([
          selection.tab === "memory" ? Promise.resolve(emptyPage<KnowledgeTaskSummary | KnowledgeThreadSummary>()) : knowledgeRequest<KnowledgePage<KnowledgeTaskSummary | KnowledgeThreadSummary>>(token, selection.tab === "backlog" ? "tasks" : "threads", { projectId, offset, ...(selection.tab === "backlog" ? filters : { query: filters.query }) }, abort.signal),
          selection.recordId && selection.tab !== "memory" ? knowledgeRequest<KnowledgeTask | KnowledgeThread>(token, selection.tab === "backlog" ? "task" : "thread", { projectId, ...(selection.tab === "backlog" ? { taskId: selection.recordId } : { threadId: selection.recordId }) }, abort.signal) : Promise.resolve(null),
          selection.recordId && selection.tab === "discussions" ? knowledgeRequest<KnowledgeReplyPage>(token, "replies", { projectId, threadId: selection.recordId, offset: replyOffset, ...(selection.replyId ? { targetReplyId: selection.replyId } : {}) }, abort.signal) : Promise.resolve<KnowledgeReplyPage>({ items: [], nextOffset: null, offset: 0 }),
          knowledgeRequest<KnowledgeProjectSummary>(token, "project", { projectId }, abort.signal),
          selection.recordId && selection.tab !== "memory" ? knowledgeRequest<KnowledgePage<KnowledgeRelationView>>(token, "relations", { projectId, recordKind: selection.tab === "backlog" ? "task" : "thread", recordId: selection.recordId, offset: relationOffset }, abort.signal) : Promise.resolve(emptyPage<KnowledgeRelationView>()),
        ]);
        if (abort.signal.aborted || selectionRef.current !== selection) return;
        setRelations(relationPage); setProject(selectedProject); setRows(page); setDetail(record); setReplies(responsePage); setError(false);
        setCounts("counts" in page ? (page as KnowledgeTaskPage).counts : null);
        setTotal("total" in page ? (page as KnowledgeTaskPage).total : null);
      } catch {
        if (!abort.signal.aborted && selectionRef.current === selection) { setRelations(emptyPage()); setProject(null); setRows(emptyPage()); setDetail(null); setReplies({ ...emptyPage(), offset: 0 }); setCounts(null); setTotal(null); setError(true); }
      } finally { if (!abort.signal.aborted && selectionRef.current === selection) { clearTimeout(timer); setLoading(false); } }
    })();
    return () => { clearTimeout(timer); abort.abort(); };
  }, [token, identity, selection, filters, offset, replyOffset, relationOffset, revision]);

  const changeReplyPage = (nextOffset: number) => {
    if (selectionRef.current.replyId) {
      changeSelection({ ...selectionRef.current, replyId: "" });
      const url = new URL(window.location.href); url.searchParams.delete("reply"); window.history.replaceState(null, "", url);
    }
    setReplyOffset(nextOffset);
  };
  return { counts, total, refreshVersion: revision, relations, relationOffset, setRelationOffset, identity, project, projects, projectOffset, setProjectOffset, selection, select, filters, setFilters: (value: KnowledgeFilters) => { setFilters(value); setOffset(0); setRows(emptyPage()); setCounts(null); setTotal(null); }, offset, setOffset, detail, rows, replies, replyOffset: selection.replyId ? replies.offset : replyOffset, setReplyOffset: changeReplyPage, loading, error: error || discoveryError, sessionError, reload };
}
