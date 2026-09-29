"use client";

import { useId, useRef, useState } from "react";
import { Cpu, HardDrive, MemoryStick, FolderArchive, ListFilter } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Mutate } from "@/features/control-client";
import { EMPTY_RESOURCES } from "@/features/runtime/defaults";
import { ResourceMonitor } from "@/features/runtime/resource-monitor";
import { RuntimeBadge } from "@/features/runtime/runtime-badge";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { restoreDetailFocus, type DetailReturnTarget } from "@/features/detail-return-focus";
import { bytes, cacheBlock, currentMetrics, runtimeActive, storageRows, sumKnown, type StorageRow } from "./resource-summary";
import { WorktreeStoragePanel } from "./worktree-storage-panel";

const ALL = "__all__";
const descending = (a: number | null, b: number | null) => a === null ? b === null ? 0 : 1 : b === null ? -1 : b - a;

export function ResourcesDashboard({ snapshots, aggregate, mutate, setError }: {
  snapshots: ProjectSnapshot[]; aggregate: boolean; mutate: Mutate; setError: (error: string | null) => void;
}) {
  const { t, locale } = useI18n();
  const [view, setView] = useState("storage");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [sort, setSort] = useState("total");
  const [page, setPage] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selection, setSelection] = useState<{ kind: string; key: string } | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const focusReturn = useRef<DetailReturnTarget | null>(null);
  const rows = storageRows(snapshots);
  const active = snapshots.filter(runtimeActive);
  const measured = snapshots.filter(currentMetrics);
  const available = rows.filter((row) => row.storage.totalBytes !== null);
  const percent = (value: number | null) => value === null ? "—" : `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
  const textMatches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const diskRows = rows.filter((row) => (project === ALL || row.snapshot.project.id === project)
    && textMatches(`${row.snapshot.project.name} ${row.worktree.branch} ${row.worktree.path}`)
    && (status === ALL || status === "next" && (row.storage.nextBytes ?? 0) > 0 || status === "missing" && row.storage.totalBytes === null || status === "scanning" && ["pending", "scanning"].includes(row.storage.status)))
    .sort((a, b) => (sort === "name" ? (a.worktree.branch ?? a.worktree.path).localeCompare(b.worktree.branch ?? b.worktree.path) : descending(sort === "next" ? a.storage.nextBytes : sort === "modules" ? a.storage.nodeModulesBytes : a.storage.totalBytes, sort === "next" ? b.storage.nextBytes : sort === "modules" ? b.storage.nodeModulesBytes : b.storage.totalBytes)) || a.key.localeCompare(b.key));
  const serverRows = snapshots.filter((snapshot) => (project === ALL || snapshot.project.id === project)
    && textMatches(`${snapshot.project.name} ${snapshot.runtime.worktreePath ?? ""} ${snapshot.worktrees.find((w) => w.path === snapshot.runtime.worktreePath)?.branch ?? ""}`)
    && (status === ALL || status === "active" && runtimeActive(snapshot) || status === "stopped" && !runtimeActive(snapshot)))
    .sort((a, b) => (sort === "name" ? 0 : descending(currentMetrics(a) ? sort === "cpu" ? a.runtime.resources.cpuPercent : a.runtime.resources.currentRssBytes : null, currentMetrics(b) ? sort === "cpu" ? b.runtime.resources.cpuPercent : b.runtime.resources.currentRssBytes : null)) || a.project.name.localeCompare(b.project.name));
  const count = view === "storage" ? diskRows.length : serverRows.length;
  const pages = Math.max(1, Math.ceil(count / 10));
  const currentPage = Math.min(page, pages - 1);
  const activeFilters = Number(project !== ALL) + Number(status !== ALL) + Number(sort !== (view === "storage" ? "total" : "ram"));
  const selectedRow = selection?.kind === "storage" ? rows.find((row) => row.key === selection.key) : undefined;
  const selectedServer = selection?.kind === "servers" ? snapshots.find((s) => s.project.id === selection.key) : undefined;
  const selectedSnapshot = selectedRow?.snapshot ?? selectedServer;
  const changeView = (value: string) => { setView(value); setPage(0); setStatus(ALL); setSort(value === "storage" ? "total" : "ram"); };
  const metricAction = (value: string, order: string) => { changeView(value); setSort(order); setQuery(""); setProject(ALL); };
  const metrics = [
    { label: t("resources.memoryNow"), icon: MemoryStick, value: active.length ? bytes(sumKnown(measured.map((s) => s.runtime.resources.currentRssBytes))) : bytes(0), hint: t("resourceView.serverCoverage", { measured: measured.filter((s) => s.runtime.resources.currentRssBytes !== null).length, total: active.length }), selected: view === "servers" && sort === "ram", action: () => metricAction("servers", "ram") },
    { label: t("resources.cpu"), icon: Cpu, value: active.length ? percent(sumKnown(measured.map((s) => s.runtime.resources.cpuPercent))) : percent(0), hint: `${t("resourceView.serverCoverage", { measured: measured.filter((s) => s.runtime.resources.cpuPercent !== null).length, total: active.length })} · ${t("resourceView.cpuHint")}`, selected: view === "servers" && sort === "cpu", action: () => metricAction("servers", "cpu") },
    { label: t("overview.disk"), icon: HardDrive, value: bytes(sumKnown(rows.map((r) => r.storage.totalBytes))), hint: t("resourceView.diskCoverage", { measured: available.length, total: rows.length }), selected: view === "storage" && sort === "total", action: () => metricAction("storage", "total") },
    { label: ".next", icon: FolderArchive, value: bytes(sumKnown(rows.map((r) => r.storage.nextBytes))), hint: t("resourceView.nextHint"), selected: view === "storage" && sort === "next", action: () => metricAction("storage", "next") },
  ];
  const request = async (row: StorageRow, path: string, remove = false) => {
    try { await mutate(`/api/projects/${row.snapshot.project.id}/storage/${remove ? "cache" : "refresh"}`, remove ? { worktreePath: path, cache: "next" } : { worktreePath: path }, t(remove ? "storage.deleted" : "storage.refreshQueued"), remove ? "DELETE" : "POST"); }
    catch (cause) { setError(`${row.snapshot.project.name}: ${cause instanceof Error ? cause.message : String(cause)}`); throw cause; }
  };
  const block = selectedRow ? cacheBlock(selectedRow) : null;
  const blockText = block === "active" ? t("storage.stopBeforeDelete") : block === "reserved" ? t("storage.releaseBeforeDelete") : block === "scanning" ? t("storage.waitBeforeDelete") : block === "tests" ? t("resourceView.testsBlock") : block === "missing" ? t("resourceView.missingBlock") : null;
  const details = (kind: string, key: string, name: string) => <Button size="sm" variant="ghost" data-detail-identity={JSON.stringify([kind, key])} aria-label={t("resourceView.detailsFor", { name })} onClick={(event) => { focusReturn.current = { button: event.currentTarget, identity: event.currentTarget.dataset.detailIdentity! }; setSelection({ kind, key }); }}>{t("row.details")}</Button>;
  const range = (items: typeof diskRows) => items.slice(currentPage * 10, currentPage * 10 + 10);

  return <section ref={sectionRef} data-resources-dashboard className="min-w-0 space-y-5" aria-label={t("dashboard.navResources")}>
    <p className="text-sm text-muted-foreground">{t("resourceView.lead")}</p>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-resource-metrics>{metrics.map(({ label, icon: Icon, value, hint, action, selected }) => <Button key={label} variant="outline" aria-pressed={selected} className={`h-auto min-h-20 w-full flex-col items-start justify-start gap-1 whitespace-normal px-3 py-2 text-left ${selected ? "border-primary/60 bg-primary/10" : ""}`} onClick={action}><span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="size-4 shrink-0" aria-hidden />{label}</span><span className="text-base font-semibold tabular-nums sm:text-lg">{value}</span><span className="text-xs font-normal leading-snug text-muted-foreground">{hint}</span></Button>)}</div>
    <p className="text-sm text-muted-foreground">{active.length ? t("resourceView.activeServers", { count: active.length }) : t("resourceView.noServers")}</p>
    <Tabs value={view} onValueChange={changeView}>
      <TabsList><TabsTrigger value="storage">{t("storage.tab")} ({rows.length})</TabsTrigger><TabsTrigger value="servers">{t("resourceView.servers")} ({snapshots.length})</TabsTrigger></TabsList>
      <div className="my-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60 space-y-2"><Label htmlFor="resources-search">{t("resourceView.search")}</Label><Input id="resources-search" type="search" placeholder={t("resourceView.searchHint")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></div>
        <Button variant="outline" className="md:hidden" aria-expanded={filtersOpen} aria-controls="resource-extra-filters" onClick={() => setFiltersOpen(!filtersOpen)}><ListFilter aria-hidden />{t("layout.filters")}{activeFilters ? ` (${activeFilters})` : ""}</Button>
        <div id="resource-extra-filters" className={`${filtersOpen ? "flex" : "hidden"} w-full flex-wrap items-end gap-3 md:flex`}>
        {aggregate ? <Filter label={t("aggregate.project")} value={project} onChange={(value) => { setProject(value); setPage(0); }} options={[[ALL, t("testView.all")], ...snapshots.map((s) => [s.project.id, s.project.name])]} /> : null}
        <Filter label={t("overview.filter")} value={status} onChange={(value) => { setStatus(value); setPage(0); }} options={[[ALL, t("testView.all")], ...(view === "storage" ? [["next", t("resourceView.withNext")], ["missing", t("resourceView.unmeasured")], ["scanning", t("resourceView.scanning")]] : [["active", t("resourceView.active")], ["stopped", t("resourceView.stopped")]])]} />
        <Filter label={t("overview.sort")} value={sort} onChange={(value) => { setSort(value); setPage(0); }} options={view === "storage" ? [["total", t("resourceView.largest")], ["next", t("resourceView.largestNext")], ["modules", "node_modules ↓"], ["name", t("resourceView.name")]] : [["ram", t("resourceView.mostRam")], ["cpu", t("resourceView.mostCpu")], ["name", t("resourceView.name")]]} />
        </div>
      </div>
      <TabsContent value="storage">
        <p className="mb-3 text-xs text-muted-foreground">{t("resourceView.storageHint")}</p>
        <div className="space-y-2 xl:hidden">{range(diskRows).map((row) => <article key={row.key} data-resource-row className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="break-all font-medium">{row.worktree.branch ?? row.worktree.path}</p>{aggregate && <p className="text-xs text-muted-foreground">{row.snapshot.project.name}</p>}</div><strong className="shrink-0 font-mono text-sm">{bytes(row.storage.totalBytes)}</strong></div><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>.next {bytes(row.storage.nextBytes)}</span>{row.storage.status !== "available" && <Badge variant="outline">{t(`resourceView.status.${row.storage.status}`)}</Badge>}{row.storage.measuredAt && <span>{new Date(row.storage.measuredAt).toLocaleString(locale)}</span>}</div><div className="mt-2 flex justify-end">{details("storage", row.key, `${row.snapshot.project.name} · ${row.worktree.branch ?? row.worktree.path}`)}</div></article>)}{!count && <p className="rounded-lg border p-4 text-sm text-muted-foreground">{t("resourceView.empty")}</p>}</div>
        <div className="hidden overflow-hidden rounded-lg border xl:block"><Table className="min-w-[850px]"><TableHeader><TableRow>{aggregate ? <TableHead>{t("aggregate.project")}</TableHead> : null}<TableHead>{t("storage.worktree")}</TableHead><TableHead>{t("storage.total")}</TableHead><TableHead>.next</TableHead><TableHead>node_modules</TableHead><TableHead>{t("resourceView.measured")}</TableHead><TableHead className="text-right">{t("row.actions")}</TableHead></TableRow></TableHeader><TableBody>
          {range(diskRows).map((row) => <TableRow key={row.key}>{aggregate ? <TableCell className="max-w-36 truncate" title={row.snapshot.project.name}>{row.snapshot.project.name}</TableCell> : null}<TableCell className="max-w-72"><p className="truncate font-mono text-xs font-semibold" title={row.worktree.branch ?? row.worktree.path}>{row.worktree.branch ?? "detached"}</p><p className="truncate text-xs text-muted-foreground" title={row.worktree.path}>{row.worktree.path}</p></TableCell><TableCell className="whitespace-nowrap font-mono text-xs">{bytes(row.storage.totalBytes)}</TableCell><TableCell className="whitespace-nowrap font-mono text-xs">{bytes(row.storage.nextBytes)}</TableCell><TableCell className="whitespace-nowrap font-mono text-xs">{bytes(row.storage.nodeModulesBytes)}</TableCell><TableCell className="text-xs text-muted-foreground">{row.storage.measuredAt ? <p className="whitespace-nowrap">{new Date(row.storage.measuredAt).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p> : null}{row.storage.status !== "available" ? <Badge variant="outline">{t(`resourceView.status.${row.storage.status}`)}</Badge> : null}</TableCell><TableCell className="text-right">{details("storage", row.key, `${row.snapshot.project.name} · ${row.worktree.branch ?? row.worktree.path}`)}</TableCell></TableRow>)}
          {!count ? <TableRow><TableCell colSpan={aggregate ? 7 : 6} className="h-24 text-center text-muted-foreground">{t("resourceView.empty")}</TableCell></TableRow> : null}
        </TableBody></Table></div>
      </TabsContent>
      <TabsContent value="servers">
        <p className="mb-3 text-xs text-muted-foreground">{t("resourceView.serverHint")}</p>
        <div className="space-y-2 xl:hidden">{serverRows.slice(currentPage * 10, currentPage * 10 + 10).map((snapshot) => <article key={snapshot.project.id} data-resource-row className="rounded-lg border p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{snapshot.project.name}</p>{runtimeActive(snapshot) && <p className="break-all text-xs text-muted-foreground">{snapshot.worktrees.find((w) => w.path === snapshot.runtime.worktreePath)?.branch ?? snapshot.runtime.worktreePath}</p>}</div><RuntimeBadge phase={snapshot.runtime.phase} /></div><p className="mt-2 text-sm">{t("resources.memoryNow")}: {bytes(currentMetrics(snapshot) ? snapshot.runtime.resources.currentRssBytes : null)} · {t("resources.cpu")}: {percent(currentMetrics(snapshot) ? snapshot.runtime.resources.cpuPercent : null)}</p><div className="mt-2 flex justify-end">{details("servers", snapshot.project.id, snapshot.project.name)}</div></article>)}{!count && <p className="rounded-lg border p-4 text-sm text-muted-foreground">{t("resourceView.empty")}</p>}</div>
        <div className="hidden overflow-hidden rounded-lg border xl:block"><Table className="min-w-[850px]"><TableHeader><TableRow><TableHead>{t("aggregate.project")}</TableHead><TableHead>{t("storage.worktree")}</TableHead><TableHead>{t("resourceView.state")}</TableHead><TableHead>{t("resources.memoryNow")}</TableHead><TableHead>{t("resources.cpu")}</TableHead><TableHead>{t("resources.processes")}</TableHead><TableHead>{t("resourceView.measured")}</TableHead><TableHead className="text-right">{t("row.actions")}</TableHead></TableRow></TableHeader><TableBody>
          {serverRows.slice(currentPage * 10, currentPage * 10 + 10).map((snapshot) => <TableRow key={snapshot.project.id}><TableCell>{snapshot.project.name}</TableCell><TableCell className="max-w-64 truncate font-mono text-xs" title={snapshot.runtime.worktreePath ?? undefined}>{runtimeActive(snapshot) ? snapshot.worktrees.find((w) => w.path === snapshot.runtime.worktreePath)?.branch ?? snapshot.runtime.worktreePath ?? "—" : "—"}</TableCell><TableCell><RuntimeBadge phase={snapshot.runtime.phase} /></TableCell><TableCell className="whitespace-nowrap">{bytes(currentMetrics(snapshot) ? snapshot.runtime.resources.currentRssBytes : null)}</TableCell><TableCell>{percent(currentMetrics(snapshot) ? snapshot.runtime.resources.cpuPercent : null)}</TableCell><TableCell>{currentMetrics(snapshot) ? snapshot.runtime.resources.processCount ?? "—" : "—"}</TableCell><TableCell className="text-xs text-muted-foreground">{currentMetrics(snapshot) && snapshot.runtime.resources.sampleAgeSeconds !== null ? t("resources.sampleAge", { seconds: snapshot.runtime.resources.sampleAgeSeconds }) : t(`resources.status.${snapshot.runtime.resources?.status ?? "idle"}`)}</TableCell><TableCell className="text-right">{details("servers", snapshot.project.id, snapshot.project.name)}</TableCell></TableRow>)}
          {!count ? <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">{t("resourceView.empty")}</TableCell></TableRow> : null}
        </TableBody></Table></div>
      </TabsContent>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground" aria-live="polite">{t("testView.results", { from: count ? currentPage * 10 + 1 : 0, to: Math.min(count, currentPage * 10 + 10), count })}</p><nav aria-label={t("resourceView.pages")} className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{t("project.previousPage")}</Button><span className="text-xs">{currentPage + 1} / {pages}</span><Button size="sm" variant="outline" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{t("project.nextPage")}</Button></nav></div>
    </Tabs>
    <Sheet open={!!selectedSnapshot} onOpenChange={(open) => { if (!open) setSelection(null); }}><SheetContent closeLabel={t("common.close")} className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl" onCloseAutoFocus={(event) => { event.preventDefault(); restoreDetailFocus(sectionRef.current, focusReturn.current); focusReturn.current = null; }}>
      {selectedSnapshot ? <><SheetHeader className="pr-12"><SheetTitle className="break-all">{selectedSnapshot.project.name}{selectedRow ? ` · ${selectedRow.worktree.branch ?? "detached"}` : ""}</SheetTitle><SheetDescription className="break-all">{selectedRow?.worktree.path ?? selectedServer?.runtime.worktreePath ?? t("resourceView.noServers")}</SheetDescription></SheetHeader><div className="space-y-4 px-4 pb-6">
        {selectedRow ? <WorktreeStoragePanel key={selectedRow.key} selected={selectedRow.storage} blockedReason={blockText} readOnly={selectedRow.worktree.prunable} refresh={(path) => request(selectedRow, path)} deleteCache={(path) => request(selectedRow, path, true)} /> : <ResourceMonitor resources={selectedServer?.runtime.resources ?? EMPTY_RESOURCES} />}
      </div></> : null}
    </SheetContent></Sheet>
  </section>;
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  const id = useId();
  return <div className="w-44 max-w-full space-y-2"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{options.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></div>;
}
