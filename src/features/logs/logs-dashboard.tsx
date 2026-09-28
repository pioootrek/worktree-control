"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronDown, ChevronUp, Copy, Download, Pause, Play, Search, WrapText } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RuntimeBadge } from "@/features/runtime/runtime-badge";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { cleanLogText, logMatches } from "./log-text";

export function LogsDashboard({ snapshots, aggregate }: { snapshots: ProjectSnapshot[]; aggregate: boolean }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  return <section data-logs-dashboard className="min-w-0 space-y-4" aria-label={t("project.logs")}>
    <p className="text-sm text-muted-foreground">{t("logsView.lead")}</p>
    <div className="space-y-1"><Label htmlFor="log-search">{t(aggregate ? "logsView.searchAll" : "logsView.search")}</Label><div className="relative"><Search className="absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden /><Input id="log-search" type="search" className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} /></div></div>
    {snapshots.map((snapshot) => <LogConsole key={JSON.stringify([snapshot.project.id, snapshot.runtime.startedAt, snapshot.runtime.worktreePath])} snapshot={snapshot} aggregate={aggregate} query={query} clearQuery={() => setQuery("")} />)}
  </section>;
}

function LogConsole({ snapshot, aggregate, query, clearQuery }: { snapshot: ProjectSnapshot; aggregate: boolean; query: string; clearQuery: () => void }) {
  const { t, locale } = useI18n();
  const raw = snapshot.runtime.logs;
  const [paused, setPaused] = useState<{ lines: string[]; reason: "reading" | "search" } | null>(() =>
    query && logMatches(raw.map(cleanLogText), query).matches.length ? { lines: [...raw], reason: "search" } : null);
  const [previousQuery, setPreviousQuery] = useState(query);
  const [expanded, setExpanded] = useState(() => query ? Boolean(logMatches(raw.map(cleanLogText), query).matches.length) : snapshot.runtime.phase !== "stopped");
  const [hit, setHit] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => (paused?.lines ?? raw).map(cleanLogText), [paused, raw]);
  const content = lines.join("\n");
  const { matches, truncated } = useMemo(() => logMatches(lines, query), [lines, query]);
  if (previousQuery !== query) {
    setPreviousQuery(query);
    setHit(0);
    if (!query) {
      if (paused?.reason === "search") setPaused(null);
      if (snapshot.runtime.phase !== "stopped") setExpanded(true);
    } else if (paused?.reason === "reading") {
      setExpanded(true);
    } else if (matches.length) {
      setExpanded(true);
      if (paused === null) setPaused({ lines: [...raw], reason: "search" });
    } else {
      setPaused(null);
      setExpanded(false);
    }
  } else if (query && paused === null && matches.length) {
    // A zero-hit search follows live output until its first match arrives.
    setPaused({ lines: [...raw], reason: "search" });
    setExpanded(true);
  }
  const currentHit = matches.length ? hit % matches.length : 0;
  const byLine = new Map<number, Array<{ start: number; end: number; index: number }>>();
  matches.forEach((match, index) => byLine.set(match.line, [...(byLine.get(match.line) ?? []), { ...match, index }]));
  const hasNew = paused !== null && (paused.lines.length !== raw.length || raw.some((line, index) => paused.lines[index] !== line));
  const active = ["running", "starting", "stopping"].includes(snapshot.runtime.phase);
  const worktree = snapshot.worktrees.find((w) => w.path === snapshot.runtime.worktreePath);

  useEffect(() => {
    if (paused === null && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [content, paused, wrap, expanded]);

  useEffect(() => {
    if (!query || !matches.length || !viewport.current) return;
    const mark = viewport.current.querySelector<HTMLElement>('[data-current-hit="true"]');
    if (mark) {
      viewport.current.scrollTop += mark.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top - viewport.current.clientHeight / 2;
      if (!wrap) viewport.current.scrollLeft += mark.getBoundingClientRect().left - viewport.current.getBoundingClientRect().left - viewport.current.clientWidth / 2;
    }
  }, [query, currentHit, matches.length, wrap, expanded]);

  const resume = () => { clearQuery(); setHit(0); setPaused(null); };
  const move = (delta: number) => setHit((currentHit + delta + matches.length) % Math.max(matches.length, 1));
  const copy = async () => {
    setError(null); setNotice(null);
    try { await navigator.clipboard.writeText(content); setNotice(t("logsView.copied")); }
    catch { setError(t("logsView.copyFailed")); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${snapshot.project.name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "server"}-logs.txt`;
    document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  };

  return <Collapsible open={!aggregate || expanded} onOpenChange={setExpanded} asChild><Card className="min-w-0 gap-0 overflow-hidden py-0 shadow-none" data-log-console data-project-id={snapshot.project.id}>
    <div className="space-y-2 border-b px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">{aggregate ? <CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t(expanded ? "logsView.collapse" : "logsView.expand", { project: snapshot.project.name })}>{expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}</Button></CollapsibleTrigger> : null}<h3 tabIndex={-1} className="scroll-mt-20 rounded-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary">{snapshot.project.name}</h3><RuntimeBadge phase={snapshot.runtime.phase} /><Badge variant="secondary">{t(active ? "logsView.currentRun" : snapshot.runtime.phase === "failed" ? "logsView.failedAttempt" : snapshot.runtime.startedAt ? "logsView.lastRun" : "logsView.noRun")}</Badge>{query && <Badge variant={matches.length ? "default" : "outline"} className="ml-auto">{t("logsView.matches", { count: matches.length })}{truncated ? "+" : ""}</Badge>}</div>
      {(!aggregate || expanded) && <><p className="break-all font-mono text-xs text-muted-foreground">{worktree?.branch ?? snapshot.runtime.worktreePath ?? t("logsView.noRun")} · {t("project.port")} {snapshot.project.port}</p>
      {snapshot.runtime.startedAt ? <p className="text-xs text-muted-foreground">{t("logsView.started", { time: new Date(snapshot.runtime.startedAt).toLocaleString(locale) })}</p> : null}</>}
    </div>
    <CollapsibleContent>
    <div className="flex flex-wrap items-end gap-2 border-b p-3">
      <span className="min-w-12 pb-2 text-center text-xs text-muted-foreground" role="status">{query ? `${matches.length ? currentHit + 1 : 0}/${matches.length}${truncated ? "+" : ""}` : ""}</span>
      <Button variant="outline" size="icon-sm" disabled={!matches.length} aria-label={t("logsView.previous")} title={t("logsView.previous")} onClick={() => move(-1)}><ChevronUp aria-hidden /></Button>
      <Button variant="outline" size="icon-sm" disabled={!matches.length} aria-label={t("logsView.next")} title={t("logsView.next")} onClick={() => move(1)}><ChevronDown aria-hidden /></Button>
      <Button variant="outline" size="sm" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText aria-hidden />{t("logsView.wrap")}</Button>
      <Button variant="outline" size="sm" aria-pressed={paused === null} onClick={() => paused === null ? setPaused({ lines: [...raw], reason: "reading" }) : resume()}>{paused === null ? <Pause aria-hidden /> : <Play aria-hidden />}{t(paused === null ? "logsView.pause" : "logsView.follow")}</Button>
      <Button variant="outline" size="icon-sm" disabled={!content} aria-label={t("logsView.copy")} title={t("logsView.copy")} onClick={() => void copy()}><Copy aria-hidden /></Button>
      <Button variant="outline" size="icon-sm" disabled={!content} aria-label={t("logsView.download")} title={t("logsView.download")} onClick={download}><Download aria-hidden /></Button>
    </div>
    {error ? <Alert variant="destructive" className="rounded-none"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {notice ? <p role="status" className="px-4 py-2 text-xs text-muted-foreground">{notice}</p> : null}
    <ScrollArea className={`${aggregate ? "h-72" : "h-[max(22rem,calc(100dvh-25rem))]"} min-w-0 bg-muted/30`} horizontal={!wrap} viewportRef={viewport} viewportProps={{ tabIndex: 0, role: "region", "aria-label": t("logsView.console"), onKeyDown: (event) => { if (query && event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }, onScroll: () => {
      const element = viewport.current;
      if (!element) return;
      const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
      if (paused === null && !atBottom) setPaused({ lines: [...raw], reason: "reading" });
      else if (paused !== null && atBottom && !query) setPaused(null);
    } }}>
      <pre className={`min-w-0 p-4 font-mono text-xs leading-5 ${wrap ? "whitespace-pre-wrap break-all" : "w-max min-w-full whitespace-pre"}`} data-log-lines>{lines.length ? lines.map((line, index) => {
        const parts = []; let cursor = 0;
        for (const match of byLine.get(index) ?? []) {
          parts.push(line.slice(cursor, match.start));
          parts.push(<mark key={match.start} data-current-hit={match.index === currentHit} className={match.index === currentHit ? "bg-primary text-primary-foreground outline-1 outline-primary" : "bg-warning text-warning-foreground"}>{line.slice(match.start, match.end)}</mark>);
          cursor = match.end;
        }
        parts.push(line.slice(cursor));
        return <span key={index} data-log-line>{parts}{index < lines.length - 1 ? "\n" : ""}</span>;
      }) : <span className="text-muted-foreground">{t("logsView.empty")}</span>}</pre>
    </ScrollArea>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
      <p className="text-xs text-muted-foreground">{t("logsView.retained", { count: lines.length })}{paused !== null ? ` · ${t("logsView.paused")}` : ""}{truncated ? ` · ${t("logsView.matchLimit")}` : ""}</p>
      {paused !== null ? <Button size="sm" variant={hasNew ? "default" : "outline"} onClick={resume}><ArrowDown aria-hidden />{t(hasNew ? "logsView.newEntries" : "logsView.bottom")}</Button> : null}
    </div>
    </CollapsibleContent>
  </Card></Collapsible>;
}
