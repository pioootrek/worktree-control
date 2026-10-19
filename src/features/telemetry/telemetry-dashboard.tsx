"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, GitCompareArrows, ListFilter, LoaderCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { restoreDetailFocus, type DetailReturnTarget } from "@/features/detail-return-focus";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { ProjectSnapshot } from "@/shared/contracts";
import type { TestHistoryCoverage, TestSummaryEntry } from "@/shared/contracts/verification-history";
import { RunComparison } from "./run-comparison";
import { RunDetail } from "./run-detail";
import type { TelemetryRequestError } from "./telemetry-client";
import {
  activeFilterCount, ATTRIBUTIONS, formatBytes, formatCpu, formatDuration, PERIODS, PROCESS_OUTCOMES, runFacts, worktreeLabel, type Period, type TelemetryFilters,
} from "./telemetry-model";
import { CommandBadge, SourceBadge, Value } from "./telemetry-parts";
import { TelemetrySummary } from "./telemetry-summary";
import { useTelemetry } from "./use-telemetry";

const ALL = "__all__";

/** Run analysis for one project. Aggregate scope has no project-wide history API. */
export function TelemetryDashboard({ snapshot, aggregate, token }: { snapshot: ProjectSnapshot | undefined; aggregate: boolean; token: string }) {
  const { t } = useI18n();
  if (aggregate || !snapshot) {
    return <section data-analysis-dashboard aria-label={t("analysis.title")} className="space-y-2 rounded-lg border p-4">
      <h2 className="font-semibold">{t("analysis.chooseProject")}</h2>
      <p className="text-sm text-muted-foreground">{t("analysis.chooseProjectHint")}</p>
    </section>;
  }
  return <TelemetryView key={snapshot.project.id} snapshot={snapshot} token={token} />;
}

function TelemetryView({ snapshot, token }: { snapshot: ProjectSnapshot; token: string }) {
  const { t, locale } = useI18n();
  const state = useTelemetry({ projectId: snapshot.project.id, token, locale });
  const { filters, metrics, history } = state;
  const [detail, setDetail] = useState<TestSummaryEntry | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const runsHeading = useRef<HTMLHeadingElement>(null);
  const compareButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<DetailReturnTarget | null>(null);
  const pendingPageFocus = useRef(false);

  useEffect(() => {
    if (history.loading || !pendingPageFocus.current) return;
    pendingPageFocus.current = false;
    runsHeading.current?.focus({ preventScroll: true });
    runsHeading.current?.scrollIntoView({ block: "start" });
  }, [history.loading, history.key]);

  const changeFilters = (next: Partial<TelemetryFilters>) => { setDetail(null); state.setFilters(next); };
  const page = (move: () => void) => { pendingPageFocus.current = true; move(); };
  const errorMessage = (error: TelemetryRequestError) => error.kind === "unauthorized" ? t("analysis.error.unauthorized")
    : error.kind === "forbidden" ? t("analysis.error.forbidden")
      : error.kind === "not_found" ? t("analysis.error.notFound")
        : error.kind === "invalid" ? t("analysis.error.invalid", { message: error.message })
          : t("analysis.error.failed", { message: error.message });

  const items = history.data?.items ?? [];
  const presetNames = new Map(snapshot.testPresets.flatMap((group) => group.presets.map((preset) => [preset.id, preset.name] as const)));
  const presetOptions = new Map<string, string>(presetNames);
  for (const entry of [...items, ...state.selected]) if (!presetOptions.has(entry.summary.presetId)) presetOptions.set(entry.summary.presetId, entry.summary.presetId);
  if (filters.presetId && !presetOptions.has(filters.presetId)) presetOptions.set(filters.presetId, filters.presetId);
  const worktreeOptions = new Map<string, string>(snapshot.worktrees.map((worktree) => [worktree.path, worktree.branch ?? worktreeLabel(worktree.path)]));
  for (const entry of [...items, ...state.selected]) if (!worktreeOptions.has(entry.summary.worktreePath)) worktreeOptions.set(entry.summary.worktreePath, worktreeLabel(entry.summary.worktreePath));
  if (filters.worktreePath && !worktreeOptions.has(filters.worktreePath)) worktreeOptions.set(filters.worktreePath, worktreeLabel(filters.worktreePath));
  const worktreeName = (path: string) => worktreeOptions.get(path) ?? worktreeLabel(path);
  const activeFilters = activeFilterCount(filters);
  const dateTime = (value: string) => new Date(value).toLocaleString(locale === "pl" ? "pl-PL" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const selectedIds = new Set(state.selected.map((entry) => entry.summary.runId));
  const selectionFull = state.selected.length >= 2;

  const openDetail = (entry: TestSummaryEntry, button: HTMLButtonElement) => {
    returnFocus.current = { button, identity: button.dataset.detailIdentity! };
    setDetail(entry);
  };
  const closeComparison = () => { state.closeComparison(); requestAnimationFrame(() => compareButton.current?.focus()); };

  return <section ref={sectionRef} data-analysis-dashboard aria-label={t("analysis.title")} className="min-w-0 space-y-5">
    <p className="text-sm text-muted-foreground">{t("analysis.lead")}</p>

    <div className="flex flex-wrap items-end gap-3" data-analysis-toolbar>
      <FilterSelect label={t("analysis.period")} value={filters.period} includeAll={false} onChange={(value) => changeFilters({ period: value as Period })} options={PERIODS.map((period) => [period, t(`testView.${period}`)])} />
      <Button variant="outline" className="md:hidden" aria-expanded={filtersOpen} aria-controls="analysis-filters" onClick={() => setFiltersOpen(!filtersOpen)}><ListFilter aria-hidden />{t("layout.filters")}{activeFilters ? ` (${activeFilters})` : ""}</Button>
      <div id="analysis-filters" className={cn(filtersOpen ? "flex" : "hidden", "w-full flex-wrap items-end gap-3 md:flex md:w-auto")}>
        <FilterSelect label={t("tests.preset")} value={filters.presetId ?? ALL} onChange={(value) => changeFilters({ presetId: value === ALL ? null : value })} options={[...presetOptions.entries()]} />
        <FilterSelect label={t("testView.worktree")} value={filters.worktreePath ?? ALL} onChange={(value) => changeFilters({ worktreePath: value === ALL ? null : value })} options={[...worktreeOptions.entries()]} />
        <FilterSelect label={t("analysis.commandResult")} value={filters.processOutcome ?? ALL} onChange={(value) => changeFilters({ processOutcome: value === ALL ? null : value as TelemetryFilters["processOutcome"] })} options={PROCESS_OUTCOMES.map((outcome) => [outcome, outcome === "unknown" ? t("analysis.command.unknown") : t(`testPhase.${outcome}`)])} />
        <FilterSelect label={t("analysis.sourceCheck")} value={filters.attribution ?? ALL} onChange={(value) => changeFilters({ attribution: value === ALL ? null : value as TelemetryFilters["attribution"] })} options={ATTRIBUTIONS.map((source) => [source, t(`analysis.source.${source}`)])} />
        {activeFilters ? <Button variant="ghost" onClick={() => changeFilters({ presetId: null, worktreePath: null, processOutcome: null, attribution: null })}><X aria-hidden />{t("analysis.clearFilters")}</Button> : null}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">{metrics.loading ? t("analysis.loading") : t("analysis.asOf", { time: new Date(state.anchor).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</p>
        <Button variant="outline" size="sm" onClick={state.refresh} disabled={metrics.loading && !metrics.stale}><RefreshCw aria-hidden className={metrics.loading ? "animate-spin motion-reduce:animate-none" : undefined} />{t("analysis.refresh")}</Button>
      </div>
    </div>

    <p className="text-xs text-muted-foreground">{t("analysis.window", { from: dateTime(state.filter.from), to: dateTime(state.filter.to) })}</p>

    {metrics.error ? <ErrorPanel message={errorMessage(metrics.error)} retry={metrics.error.kind === "unauthorized" || metrics.error.kind === "forbidden" ? null : state.refresh} />
      : metrics.data ? <div aria-busy={metrics.loading} className={cn("space-y-3 transition-opacity", metrics.stale && "opacity-60")}>
        <CoverageLine coverage={metrics.data.coverage} />
        {metrics.data.selection.truncated ? <Warning text={t("analysis.truncated", { limit: metrics.data.selection.scanLimit.toLocaleString(locale) })} /> : null}
        {metrics.data.selection.matched === 0 ? <p className="rounded-lg border p-4 text-sm text-muted-foreground">{activeFilters ? t("analysis.emptyFiltered") : t("analysis.empty")}</p>
          : <TelemetrySummary metrics={metrics.data} filters={filters} setFilters={changeFilters} />}
      </div> : <SummarySkeleton />}

    <section aria-labelledby="analysis-runs" className="space-y-3" data-analysis-runs>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="analysis-runs" ref={runsHeading} tabIndex={-1} className="scroll-mt-20 font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t("analysis.runs")}</h3>
        <p className="text-xs text-muted-foreground">{t("analysis.runsOrder")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm" data-analysis-compare-bar>
        {state.selected.length ? state.selected.map((entry) => <span key={entry.summary.runId} className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs">
          <span className="truncate">{entry.summary.presetId} · {dateTime(entry.summary.queuedAt)}</span>
          <button type="button" className="rounded-sm p-0.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("analysis.removeSelection", { name: `${entry.summary.presetId} ${dateTime(entry.summary.queuedAt)}` })} onClick={() => state.toggle(entry)}><X className="size-3" aria-hidden /></button>
        </span>) : <span className="text-xs text-muted-foreground">{t("analysis.selectHint")}</span>}
        <span className="text-xs text-muted-foreground" aria-live="polite">{t("analysis.selectedCount", { count: state.selected.length })}</span>
        <div className="ml-auto flex gap-2">
          {state.selected.length ? <Button variant="ghost" size="sm" onClick={state.clearSelection}>{t("analysis.clearSelection")}</Button> : null}
          <Button ref={compareButton} size="sm" disabled={state.selected.length !== 2} onClick={() => void state.compare()}><GitCompareArrows aria-hidden />{t("analysis.compare.action")}</Button>
        </div>
      </div>

      {state.comparison ? <RunComparison state={state.comparison} onClose={closeComparison} errorMessage={errorMessage} /> : null}

      {history.error ? <ErrorPanel message={errorMessage(history.error)} retry={history.error.kind === "invalid" ? state.restartListing : history.error.kind === "unauthorized" || history.error.kind === "forbidden" ? null : state.refresh} retryLabel={history.error.kind === "invalid" ? t("analysis.startOver") : undefined} />
        : history.loading ? <p role="status" className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("analysis.loadingRuns")}</p>
          : !items.length ? <EmptyPage scanned={history.data?.selection.scanned ?? 0} more={!!history.data?.nextCursor} first={history.pageIndex === 0} filtered={activeFilters > 0} onMore={() => page(state.goNext)} />
            : <>
              <div className="space-y-2 lg:hidden">
                {items.map((entry) => <RunCard key={entry.summary.runId} entry={entry} worktree={worktreeName(entry.summary.worktreePath)} when={dateTime(entry.summary.queuedAt)} selected={selectedIds.has(entry.summary.runId)} selectionFull={selectionFull} onToggle={() => state.toggle(entry)} onOpen={openDetail} />)}
              </div>
              <div className="hidden overflow-x-auto rounded-lg border lg:block">
                <Table className="min-w-[60rem]">
                  <TableHeader><TableRow>
                    <TableHead className="w-10"><span className="sr-only">{t("analysis.compareColumn")}</span></TableHead>
                    <TableHead>{t("analysis.queued")}</TableHead><TableHead>{t("tests.preset")}</TableHead>
                    <TableHead>{t("analysis.commandResult")}</TableHead><TableHead>{t("analysis.sourceCheck")}</TableHead>
                    <TableHead className="text-right">{t("analysis.duration.totalMs")}</TableHead><TableHead className="text-right">{t("analysis.duration.processMs")}</TableHead>
                    <TableHead className="text-right">{t("analysis.peakMemoryShort")}</TableHead><TableHead className="text-right">{t("analysis.peakCpuShort")}</TableHead>
                    <TableHead className="text-right">{t("row.actions")}</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{items.map((entry) => {
                    const { summary } = entry;
                    const facts = runFacts(summary);
                    const resources = summary.telemetry.resources;
                    return <TableRow key={summary.runId} data-selected={selectedIds.has(summary.runId) || undefined} className="data-[selected]:bg-primary/5">
                      <TableCell><SelectBox entry={entry} when={dateTime(summary.queuedAt)} selected={selectedIds.has(summary.runId)} selectionFull={selectionFull} onToggle={() => state.toggle(entry)} /></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{dateTime(summary.queuedAt)}</TableCell>
                      <TableCell className="max-w-64"><p className="truncate font-medium" title={summary.presetId}>{summary.presetId}</p><p className="truncate text-xs text-muted-foreground" title={summary.worktreePath}>{worktreeName(summary.worktreePath)}</p></TableCell>
                      <TableCell><CommandBadge result={facts.command} />{summary.exitCode !== null ? <p className="mt-1 text-xs text-muted-foreground">{t("analysis.exitCode", { code: summary.exitCode })}</p> : null}</TableCell>
                      <TableCell><SourceBadge source={facts.source} />{facts.note === "source_overrode_command" ? <p className="mt-1 text-xs text-warning-foreground">{t("analysis.runFailedBySource")}</p> : null}</TableCell>
                      <TableCell className="text-right"><Value text={formatDuration(summary.telemetry.durations.totalMs, locale)} /></TableCell>
                      <TableCell className="text-right"><Value text={formatDuration(summary.telemetry.durations.processMs, locale)} /></TableCell>
                      <TableCell className="text-right"><Value text={formatBytes(resources?.peakSampledRssBytes)} />{resources?.status === "partial" ? <p className="text-xs text-warning-foreground">{t("analysis.resourceStatus.partial")}</p> : null}</TableCell>
                      <TableCell className="text-right"><Value text={formatCpu(resources?.peakSampledCpuPercent, locale)} /></TableCell>
                      <TableCell className="text-right"><Button variant="ghost" size="sm" data-detail-identity={summary.runId} aria-label={t("analysis.detailsFor", { name: summary.presetId, time: dateTime(summary.queuedAt) })} onClick={(event) => openDetail(entry, event.currentTarget)}>{t("row.details")}</Button></TableCell>
                    </TableRow>;
                  })}</TableBody>
                </Table>
              </div>
            </>}

      {history.data && (history.pageIndex > 0 || history.data.nextCursor) ? <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t("analysis.pageScan", { page: history.pageIndex + 1, scanned: history.data.selection.scanned })}{history.data.selection.scanLimitReached ? ` · ${t("analysis.scanLimit")}` : ""}</p>
        <nav aria-label={t("analysis.pages")} className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={history.pageIndex === 0 || history.loading} onClick={() => page(state.goPrevious)}>{t("project.previousPage")}</Button>
          <span className="text-xs tabular-nums">{history.pageIndex + 1}</span>
          <Button size="sm" variant="outline" disabled={!history.data.nextCursor || history.loading} onClick={() => page(state.goNext)}>{t("analysis.olderRuns")}</Button>
        </nav>
      </div> : null}
    </section>

    <Sheet open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
      <SheetContent closeLabel={t("common.close")} className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl" onCloseAutoFocus={(event) => { event.preventDefault(); restoreDetailFocus(sectionRef.current, returnFocus.current); returnFocus.current = null; }}>
        {detail ? <RunDetail entry={detail} selected={selectedIds.has(detail.summary.runId)} selectionFull={selectionFull} onToggleSelection={() => state.toggle(detail)} /> : null}
      </SheetContent>
    </Sheet>
  </section>;
}

function SelectBox({ entry, when, selected, selectionFull, onToggle }: { entry: TestSummaryEntry; when: string; selected: boolean; selectionFull: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" checked={selected} disabled={!selected && selectionFull} onChange={onToggle}
    aria-label={t("analysis.selectRun", { name: entry.summary.presetId, time: when })} />;
}

function RunCard({ entry, worktree, when, selected, selectionFull, onToggle, onOpen }: {
  entry: TestSummaryEntry; worktree: string; when: string; selected: boolean; selectionFull: boolean; onToggle: () => void; onOpen: (entry: TestSummaryEntry, button: HTMLButtonElement) => void;
}) {
  const { t, locale } = useI18n();
  const { summary } = entry;
  const facts = runFacts(summary);
  return <article data-analysis-run className={cn("rounded-lg border p-3", selected && "border-primary/50 bg-primary/5")}>
    <div className="flex items-start gap-3">
      <div className="pt-0.5"><SelectBox entry={entry} when={when} selected={selected} selectionFull={selectionFull} onToggle={onToggle} /></div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="min-w-0"><p className="break-all font-medium">{summary.presetId}</p><p className="break-all text-xs text-muted-foreground">{worktree} · {when}</p></div>
        <div className="flex flex-wrap gap-1.5"><CommandBadge result={facts.command} /><SourceBadge source={facts.source} /></div>
        {facts.note === "source_overrode_command" ? <p className="text-xs text-warning-foreground">{t("analysis.runFailedBySource")}</p> : null}
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div><dt className="text-muted-foreground">{t("analysis.duration.totalMs")}</dt><dd><Value text={formatDuration(summary.telemetry.durations.totalMs, locale)} /></dd></div>
          <div><dt className="text-muted-foreground">{t("analysis.duration.processMs")}</dt><dd><Value text={formatDuration(summary.telemetry.durations.processMs, locale)} /></dd></div>
          <div><dt className="text-muted-foreground">{t("analysis.peakMemoryShort")}</dt><dd><Value text={formatBytes(summary.telemetry.resources?.peakSampledRssBytes)} /></dd></div>
          <div><dt className="text-muted-foreground">{t("analysis.peakCpuShort")}</dt><dd><Value text={formatCpu(summary.telemetry.resources?.peakSampledCpuPercent, locale)} /></dd></div>
        </dl>
        <Button variant="outline" size="sm" data-detail-identity={summary.runId} aria-label={t("analysis.detailsFor", { name: summary.presetId, time: when })} onClick={(event) => onOpen(entry, event.currentTarget)}>{t("row.details")}</Button>
      </div>
    </div>
  </article>;
}

function EmptyPage({ scanned, more, first, filtered, onMore }: { scanned: number; more: boolean; first: boolean; filtered: boolean; onMore: () => void }) {
  const { t } = useI18n();
  return <div className="space-y-2 rounded-lg border p-4 text-sm text-muted-foreground" data-analysis-empty>
    <p>{more ? t("analysis.emptyPageMore", { scanned }) : first ? filtered ? t("analysis.emptyFiltered") : t("analysis.empty") : t("analysis.noMoreRuns")}</p>
    {more ? <Button variant="outline" size="sm" onClick={onMore}>{t("analysis.continueOlder")}</Button> : null}
  </div>;
}

function CoverageLine({ coverage }: { coverage: TestHistoryCoverage }) {
  const { t, locale } = useI18n();
  const days = Math.round(coverage.policy.maxAgeMs / 86_400_000);
  return <div className="space-y-1 text-xs text-muted-foreground" data-analysis-coverage>
    <p>{t("analysis.coverage", { records: coverage.records.toLocaleString(locale), oldest: coverage.oldestQueuedAt ? new Date(coverage.oldestQueuedAt).toLocaleDateString(locale) : "—", days, limit: coverage.policy.perProjectRecords.toLocaleString(locale) })}</p>
    {coverage.evicted > 0 ? <p className="text-warning-foreground">{t("analysis.evicted", { count: coverage.evicted.toLocaleString(locale) })}</p> : null}
    {coverage.maintenancePending ? <p>{t("analysis.maintenancePending")}</p> : null}
  </div>;
}

function Warning({ text }: { text: string }) {
  return <p className="flex items-start gap-2 rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{text}</p>;
}

function ErrorPanel({ message, retry, retryLabel }: { message: string; retry: (() => void) | null; retryLabel?: string }) {
  const { t } = useI18n();
  return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
    <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{message}</p>
    {retry ? <Button variant="outline" size="sm" onClick={retry}>{retryLabel ?? t("analysis.retry")}</Button> : null}
  </div>;
}

function SummarySkeleton() {
  const { t } = useI18n();
  return <div role="status" aria-label={t("analysis.loading")} className="space-y-3">
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-20" />)}</div>
    <Skeleton className="h-16" />
    <Skeleton className="h-48" />
  </div>;
}

function FilterSelect({ label, value, onChange, options, includeAll = true }: { label: string; value: string; onChange: (value: string) => void; options: Array<readonly [string, string]>; includeAll?: boolean }) {
  const id = useId();
  const { t } = useI18n();
  return <div className="w-44 max-w-full space-y-2"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{includeAll ? <SelectItem value={ALL}>{t("testView.all")}</SelectItem> : null}{options.map(([key, text]) => <SelectItem key={key} value={key}>{text}</SelectItem>)}</SelectContent></Select></div>;
}
