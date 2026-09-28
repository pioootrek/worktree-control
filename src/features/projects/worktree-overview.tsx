"use client";

import { useState, useSyncExternalStore } from "react";
import { Clock3, GitBranch, GitMerge, HardDrive, RefreshCw, Server, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorktreeRowActions, type WorktreeRowActionsProps } from "./worktree-row-actions";
import { RuntimeBadge } from "@/features/runtime/runtime-badge";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot, RuntimePhase } from "@/shared/contracts";
import { filterWorktrees, worktreeInsights, worktreeSorts, type WorktreeFilter, type WorktreeSort } from "./worktree-insights";

const SORT_KEY = "worktree-list-sort-v1";
function subscribe(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener(SORT_KEY, notify);
  return () => { window.removeEventListener("storage", notify); window.removeEventListener(SORT_KEY, notify); };
}
function readSort(): WorktreeSort {
  try { const value = window.localStorage.getItem(SORT_KEY) as WorktreeSort; return worktreeSorts.includes(value) ? value : "launched-desc"; } catch { return "launched-desc"; }
}
function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function WorktreeOverview({ snapshots, aggregate = false, rowActions, busy, refreshing, onRefresh }: {
  snapshots: ProjectSnapshot[]; aggregate?: boolean;
  rowActions: (snapshot: ProjectSnapshot) => Pick<WorktreeRowActionsProps, "busy" | "pendingPath" | "onOperate" | "onReserve">;
  busy: boolean; refreshing: boolean; onRefresh: () => void;
}) {
  const snapshot = snapshots[0];
  const scopeId = aggregate ? "all-projects" : snapshot.project.id;
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorktreeFilter>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  // Only advances when a dashboard snapshot changes, without an additional polling timer.
  const now = new Date().getTime();
  const rows = snapshots.flatMap((entry) => worktreeInsights(entry, now));
  const sort = useSyncExternalStore(subscribe, readSort, () => "launched-desc" as WorktreeSort);
  const changeSort = (value: WorktreeSort) => {
    try { window.localStorage.setItem(SORT_KEY, value); window.dispatchEvent(new Event(SORT_KEY)); } catch { /* Storage unavailable. */ }
    setPage(0);
  };
  const changeFilter = (value: WorktreeFilter) => { setFilter(value); setPage(0); };
  const results = filterWorktrees(rows, query, filter, sort);
  const pages = Math.max(1, Math.ceil(results.length / 10));
  const currentPage = Math.min(page, pages - 1);
  const visible = results.slice(currentPage * 10, (currentPage + 1) * 10);
  const measured = rows.filter((r) => r.bytes !== null);
  const totalBytes = measured.reduce((sum, row) => sum + row.bytes!, 0);
  const inactive = rows.filter((r) => r.inactive === true).length;
  const merged = rows.filter((r) => r.worktree.merged === true).length;
  const review = rows.filter((r) => r.inactive === true || r.worktree.merged === true).length;
  const unknown = rows.filter((r) => r.inactive === null || r.worktree.merged == null).length;
  const activeSnapshots = snapshots.filter((entry) => ["running", "starting", "stopping"].includes(entry.runtime.phase));
  const hasRuntime = activeSnapshots.length > 0;
  const runtimeBranch = snapshot.worktrees.find((w) => w.path === snapshot.runtime.worktreePath)?.branch ?? snapshot.runtime.worktreePath;
  const date = (value: string | null) => value ? new Date(value).toLocaleDateString(locale === "pl" ? "pl-PL" : "en-GB") : t("overview.unknown");
  const metrics = [
    { label: t(aggregate ? "aggregate.servers" : "overview.server"), value: aggregate && hasRuntime ? String(activeSnapshots.length) : hasRuntime ? runtimeBranch ?? "—" : t("overview.noServer"), icon: Server, hint: aggregate ? t("aggregate.projectCount", { count: snapshots.length }) : t("overview.oneServer"), active: filter === "running", action: () => { setQuery(""); changeFilter(hasRuntime ? "running" : "all"); } },
    { label: t("overview.worktrees"), value: String(rows.length), icon: GitBranch, hint: t(aggregate ? "projectSwitcher.all" : "overview.allWorktrees"), active: filter === "all", action: () => { setQuery(""); changeFilter("all"); } },
    { label: t("overview.disk"), value: measured.length ? `${measured.length < rows.length ? "≥ " : ""}${bytes(totalBytes)}` : t("overview.unknown"), icon: HardDrive, hint: t("overview.measured", { count: measured.length, total: rows.length }), active: sort === "size-desc", action: () => { setQuery(""); changeFilter("all"); changeSort("size-desc"); } },
    { label: t("overview.review"), value: unknown ? `${review}+` : String(review), icon: Clock3, hint: t("overview.reviewCounts", { inactive, merged }), active: filter === "review", action: () => { setQuery(""); changeFilter("review"); } },
  ];

  return <div data-worktree-overview className="min-w-0 space-y-4">
    <div className="flex min-w-0 flex-wrap gap-2" role="group" aria-label={t("worktreeLayout.summary")}>
      {metrics.map(({ label, value, icon: Icon, hint, active, action }) => <Button key={label} variant={active ? "secondary" : "outline"} size="sm" aria-pressed={active}
        title={hint} className="h-auto max-w-full min-w-0 justify-start gap-1.5 whitespace-normal py-1.5 text-left" onClick={action}>
        <Icon className="size-3.5 shrink-0" aria-hidden /><span className="text-muted-foreground">{label}</span><span className="min-w-0 break-all font-semibold">{value}</span>
      </Button>)}
    </div>
    {aggregate && activeSnapshots.length > 0 ? <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t("worktreeLayout.runningProjects", { count: activeSnapshots.length })}</summary>
      <div className="mt-2 flex flex-wrap gap-2">{activeSnapshots.map((entry) => <Button key={entry.project.id} variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-2 text-left" onClick={() => { setQuery(entry.project.name); changeFilter("running"); }}>
        <Server aria-hidden /><span className="min-w-0 break-all">{entry.project.name} · {entry.worktrees.find((w) => w.path === entry.runtime.worktreePath)?.branch ?? entry.runtime.worktreePath}</span><RuntimeBadge phase={entry.runtime.phase} />
      </Button>)}</div>
    </details> : null}
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <Label htmlFor={`worktree-search-${scopeId}`}>{t("project.searchWorktrees")}</Label>
        <Input id={`worktree-search-${scopeId}`} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder={t("project.searchWorktreesHint")} />
      </div>
      <Button variant="outline" className="md:hidden" aria-expanded={showFilters} aria-controls={`worktree-filters-${scopeId}`} onClick={() => setShowFilters(!showFilters)}>
        <SlidersHorizontal aria-hidden />{t("worktreeLayout.filters")}{filter !== "all" ? <Badge variant="secondary">1</Badge> : null}
      </Button>
      <div id={`worktree-filters-${scopeId}`} className={`${showFilters ? "flex" : "hidden"} w-full flex-wrap items-end gap-2 md:flex md:w-auto`}>
        <div className="min-w-36 flex-1 space-y-1 md:w-40 md:flex-none">
          <Label htmlFor={`filter-${scopeId}`}>{t("overview.filter")}</Label>
          <Select value={filter} onValueChange={(v) => changeFilter(v as WorktreeFilter)}>
            <SelectTrigger id={`filter-${scopeId}`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(["all", "running", "review", "inactive", "merged", "unmerged", "both"] as const).map((f) => <SelectItem key={f} value={f}>{t(`overview.filter.${f}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="min-w-44 flex-1 space-y-1 md:w-48 md:flex-none">
          <Label htmlFor={`sort-${scopeId}`}>{t("overview.sort")}</Label>
          <Select value={sort} onValueChange={(v) => changeSort(v as WorktreeSort)}>
            <SelectTrigger id={`sort-${scopeId}`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{worktreeSorts.map((s) => <SelectItem key={s} value={s}>{t(`overview.sort.${s}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <Button variant="outline" size="icon" onClick={onRefresh} disabled={busy || refreshing} aria-label={t("metadata.refresh")}><RefreshCw className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden /></Button>
    </div>
    {filter !== "all" ? <p className="text-xs text-muted-foreground">{t("worktreeLayout.activeFilter", { filter: t(`overview.filter.${filter}`) })} <Button variant="link" size="sm" className="h-auto px-1 py-0 text-xs" onClick={() => changeFilter("all")}>{t("worktreeLayout.clearFilter")}</Button></p> : null}
    <div className="min-w-0 rounded-md border border-border" role="region" aria-label={t("project.worktreeTable")}>
      <Table className="w-full table-fixed text-left max-md:block max-md:border-0">
        <TableHeader className="max-md:hidden"><TableRow>
          <TableHead className="w-[42%]">{t("project.branch")}</TableHead>
          <TableHead className="w-[33%]">{t("overview.condition")}</TableHead>
          <TableHead className="w-[25%] text-right">{t("row.actions")}</TableHead>
        </TableRow></TableHeader>
        <TableBody className="max-md:block max-md:space-y-2 max-md:p-2">{visible.map(({ snapshot: rowSnapshot, worktree: w, running, bytes: size, lastLaunch, lastCommit, inactive: idle, measuredAt, measurementStatus }) => {
          // A failed start belongs only to the worktree path recorded by the runtime.
          const phase: RuntimePhase = rowSnapshot.runtime.worktreePath === w.path ? rowSnapshot.runtime.phase : "stopped";
          return <TableRow key={JSON.stringify([rowSnapshot.project.id, w.path])} data-worktree-row className={`${running ? "bg-primary/[0.04]" : ""} max-md:block max-md:w-full max-md:rounded-md max-md:border max-md:bg-card/40`}>
            <TableCell className="min-w-0 whitespace-normal py-3 align-top max-md:block max-md:px-3 max-md:pb-1">
              {aggregate ? <p className="break-words text-xs text-muted-foreground">{rowSnapshot.project.name}</p> : null}
              <p className="break-all font-mono text-sm font-medium leading-snug">{w.branch ?? "detached HEAD"}</p>
            </TableCell>
            <TableCell className="min-w-0 whitespace-normal align-top max-md:block max-md:px-3 max-md:py-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <RuntimeBadge phase={phase} />
                <Badge variant="outline" className={w.dirty ? "text-warning-foreground" : "text-muted-foreground"}>{w.dirty ? t("project.dirty") : t("project.clean")}</Badge>
                {w.isDefaultBranch ? <Badge variant="secondary">{t("overview.defaultBranch")}</Badge> : w.merged === true ? <Badge variant="secondary" title={t("overview.mergedInto", { branch: w.mergedInto ?? "?" })}><GitMerge aria-hidden />{t("overview.filter.merged")}</Badge> : null}
                {idle ? <Badge variant="outline"><Clock3 aria-hidden />{t("overview.filter.inactive")}</Badge> : null}
                {w.locked || rowSnapshot.reservation?.worktreePath === w.path ? <Badge variant="outline"><ShieldCheck aria-hidden />{t("overview.reserved")}</Badge> : null}
              </div>
            </TableCell>
            <TableCell className="whitespace-normal align-top max-md:block max-md:px-3 max-md:pb-3 max-md:pt-2"><WorktreeRowActions snapshot={rowSnapshot} worktree={w} details={{ size: size === null ? t("overview.unknown") : bytes(size), measuredAt: measuredAt ? `${date(measuredAt)} · ${measurementStatus}` : null, lastLaunch: date(lastLaunch), lastCommit: date(lastCommit), mergeUnknown: w.merged == null }} {...rowActions(rowSnapshot)} /></TableCell>
          </TableRow>;
        })}
        {!visible.length ? <TableRow className="max-md:block"><TableCell colSpan={3} className="h-24 text-center text-muted-foreground max-md:block">{t("project.noMatchingWorktrees")}</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground" aria-live="polite" aria-atomic="true">{t("project.worktreeResults", { from: results.length ? currentPage * 10 + 1 : 0, to: Math.min((currentPage + 1) * 10, results.length), count: results.length, total: rows.length })}</p>
      <nav aria-label={t("project.worktreePagination")} className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{t("project.previousPage")}</Button><span className="text-xs tabular-nums">{t("project.worktreePage", { page: currentPage + 1, pages })}</span><Button variant="outline" size="sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{t("project.nextPage")}</Button></nav>
    </div>
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t("overview.definitions")}{unknown ? ` · ${t("overview.unknownCount", { count: unknown })}` : ""}</summary>
      <p className="mt-2 max-w-4xl leading-relaxed">{t("overview.method")}</p>
      <p className="mt-1">{t("overview.storageMethod")}</p>
      <p className="mt-1">{t("overview.measured", { count: measured.length, total: rows.length })}</p>
      {!aggregate && snapshot.metadata?.lastSuccessfulAt ? <p className="mt-1">{t("metadata.lastSuccess", { time: new Date(snapshot.metadata.lastSuccessfulAt).toLocaleString(locale === "pl" ? "pl-PL" : "en-US") })}</p> : null}
    </details>
  </div>;
}
