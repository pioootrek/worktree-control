"use client";

import { useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { TestDurationStatistic, TestMetricPopulation, TestMetrics, TestResourceStatistic } from "@/shared/contracts/verification-history";
import {
  ATTRIBUTIONS, formatBytes, formatCpu, formatDuration, PHASE_KEYS, POPULATIONS, PROCESS_OUTCOMES, resourceStatusCounts, sampleSize, type TelemetryFilters,
} from "./telemetry-model";
import { commandToneKey, Distribution, sourceToneKey, Value } from "./telemetry-parts";

export function TelemetrySummary({ metrics, filters, setFilters }: {
  metrics: TestMetrics; filters: TelemetryFilters; setFilters: (next: Partial<TelemetryFilters>) => void;
}) {
  const { t, locale } = useI18n();
  const [chosen, setChosen] = useState<TestMetricPopulation>("completed_execution");
  const population = metrics.populations[chosen].count > 0 || chosen === "completed_execution" ? chosen : "completed_execution";
  const completed = metrics.populations.completed_execution;
  const matched = metrics.selection.matched;
  const otherCount = matched - completed.count;
  const ms = (value: number | null) => formatDuration(value, locale);
  const total = completed.durations.totalMs;
  const rss = metrics.resources.rss.populations.completed_execution;

  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-analysis-kpis>
      <Kpi label={t("analysis.kpi.runs")} value={String(matched)} note={metrics.selection.truncated ? t("analysis.kpi.runsTruncated", { limit: metrics.selection.scanLimit.toLocaleString(locale) }) : t("analysis.kpi.runsScanned", { scanned: metrics.selection.scanned })} warn={metrics.selection.truncated} />
      <Kpi label={t("analysis.kpi.completed")} value={String(completed.count)} note={otherCount > 0 ? t("analysis.kpi.otherRuns", { count: otherCount }) : t("analysis.kpi.noOtherRuns")} />
      <Kpi label={t("analysis.kpi.medianTotal")} value={ms(total.medianMs)} note={statNote(t, total, ms(total.p95Ms))} warn={sampleSize(total.valid) === "small"} />
      <Kpi label={t("analysis.kpi.medianMemory")} value={formatBytes(rss.median)} note={resourceNote(t, rss, formatBytes(rss.p95))} warn={sampleSize(rss.valid) === "small"} />
    </div>

    <div className="grid gap-4 rounded-lg border p-3 md:grid-cols-2">
      <Distribution title={t("analysis.commandResult")} total={matched} actionLabel={(label) => t("analysis.filterBy", { label })}
        items={PROCESS_OUTCOMES.map((outcome) => ({ key: outcome, count: metrics.processOutcomes[outcome], tone: commandToneKey[outcome],
          label: outcome === "unknown" ? t("analysis.command.unknown") : t(`testPhase.${outcome}`), selected: filters.processOutcome === outcome,
          onSelect: () => setFilters({ processOutcome: filters.processOutcome === outcome ? null : outcome }) }))} />
      <Distribution title={t("analysis.sourceCheck")} total={matched} actionLabel={(label) => t("analysis.filterBy", { label })}
        items={ATTRIBUTIONS.map((source) => ({ key: source, count: metrics.sourceAttributions[source], tone: sourceToneKey[source],
          label: t(`analysis.source.${source}`), selected: filters.attribution === source,
          onSelect: () => setFilters({ attribution: filters.attribution === source ? null : source }) }))} />
      <p className="text-xs text-muted-foreground md:col-span-2">{t("analysis.axesNote")}</p>
    </div>

    <section aria-labelledby="analysis-phases" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="analysis-phases" className="font-semibold">{t("analysis.whereTime")}</h3>
        <p className="text-xs text-muted-foreground">{t("analysis.method")}</p>
      </div>
      <div role="group" aria-label={t("analysis.population.label")} className="flex flex-wrap gap-1.5">
        {POPULATIONS.filter((name) => name === "completed_execution" || metrics.populations[name].count > 0).map((name) => (
          <button key={name} type="button" aria-pressed={population === name} onClick={() => setChosen(name)}
            className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring", population === name ? "border-primary/60 bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted")}>
            {t(`analysis.population.${name}`)}<span className="font-medium tabular-nums text-foreground">{metrics.populations[name].count}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t(`analysis.populationHint.${population}`)}</p>
      <PhaseTable statistics={metrics.populations[population].durations} />
      <ResourceTable cpu={metrics.resources.cpu.populations[population]} rss={metrics.resources.rss.populations[population]} />
    </section>
  </div>;
}

function statNote(t: ReturnType<typeof useI18n>["t"], statistic: TestDurationStatistic, p95: string | null) {
  if (statistic.valid === 0) return statistic.denominator ? t("analysis.noValid", { count: statistic.denominator }) : t("analysis.noRuns");
  return `${p95 ? `p95 ${p95} · ` : ""}${t("analysis.measuredOf", { valid: statistic.valid, total: statistic.denominator })}`;
}
function resourceNote(t: ReturnType<typeof useI18n>["t"], statistic: TestResourceStatistic, p95: string | null) {
  if (statistic.valid === 0) return statistic.denominator ? t("analysis.noValid", { count: statistic.denominator }) : t("analysis.noRuns");
  return `${p95 ? `p95 ${p95} · ` : ""}${t("analysis.measuredOf", { valid: statistic.valid, total: statistic.denominator })}`;
}

function Kpi({ label, value, note, warn = false }: { label: string; value: string | null; note: string; warn?: boolean }) {
  return <div className="min-w-0 rounded-lg border px-3 py-2">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="mt-0.5 text-lg font-semibold"><Value text={value} /></p>
    <p className={cn("mt-0.5 flex items-start gap-1 text-xs", warn ? "text-warning-foreground" : "text-muted-foreground")}>{warn ? <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /> : null}<span>{note}</span></p>
  </div>;
}

function Coverage({ valid, denominator }: { valid: number; denominator: number }) {
  const { t } = useI18n();
  const size = sampleSize(valid);
  return <span className={cn("whitespace-nowrap text-xs tabular-nums", size === "small" ? "text-warning-foreground" : "text-muted-foreground")}>
    {t("analysis.measuredOf", { valid, total: denominator })}{size === "small" ? <> · {t("analysis.smallSample")}</> : null}
  </span>;
}

function PhaseTable({ statistics }: { statistics: TestMetrics["populations"][TestMetricPopulation]["durations"] }) {
  const { t, locale } = useI18n();
  const scale = Math.max(0, ...PHASE_KEYS.map((key) => statistics[key].p95Ms ?? statistics[key].medianMs ?? 0));
  const width = (value: number | null) => scale > 0 && value !== null ? `${Math.max(1, (value / scale) * 100)}%` : "0%";
  return <div className="overflow-hidden rounded-lg border" data-analysis-phases>
    <Table>
      <TableHeader><TableRow><TableHead>{t("analysis.phase")}</TableHead><TableHead className="text-right">{t("analysis.median")}</TableHead><TableHead className="text-right">p95</TableHead><TableHead className="hidden text-right sm:table-cell">{t("analysis.measured")}</TableHead></TableRow></TableHeader>
      <TableBody>
        {[...PHASE_KEYS, "totalMs" as const].map((key) => {
          const statistic = statistics[key];
          return <TableRow key={key} className={key === "totalMs" ? "border-t-2 font-medium" : undefined}>
            <TableCell className="min-w-36 whitespace-normal">
              <p>{t(`analysis.duration.${key}`)}</p>
              {key !== "totalMs" ? <div className="relative mt-1 h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-muted" aria-hidden>
                <span className="absolute inset-y-0 left-0 bg-primary/30" style={{ width: width(statistic.p95Ms) }} />
                <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: width(statistic.medianMs) }} />
              </div> : null}
              <span className="sm:hidden"><Coverage valid={statistic.valid} denominator={statistic.denominator} /></span>
            </TableCell>
            <TableCell className="text-right"><Value text={formatDuration(statistic.medianMs, locale)} /></TableCell>
            <TableCell className="text-right"><Value text={formatDuration(statistic.p95Ms, locale)} /></TableCell>
            <TableCell className="hidden text-right sm:table-cell"><Coverage valid={statistic.valid} denominator={statistic.denominator} /></TableCell>
          </TableRow>;
        })}
      </TableBody>
    </Table>
    <p className="flex items-start gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground"><Info className="mt-0.5 size-3 shrink-0" aria-hidden />{t("analysis.phaseNote")}</p>
  </div>;
}

function ResourceTable({ cpu, rss }: { cpu: TestResourceStatistic; rss: TestResourceStatistic }) {
  const { t, locale } = useI18n();
  const statuses = resourceStatusCounts(rss);
  return <div className="overflow-hidden rounded-lg border" data-analysis-resources>
    <Table>
      <TableHeader><TableRow><TableHead>{t("analysis.resources")}</TableHead><TableHead className="text-right">{t("analysis.median")}</TableHead><TableHead className="text-right">p95</TableHead><TableHead className="hidden text-right sm:table-cell">{t("analysis.measured")}</TableHead></TableRow></TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="whitespace-normal"><p>{t("analysis.peakMemory")}</p><span className="sm:hidden"><Coverage valid={rss.valid} denominator={rss.denominator} /></span></TableCell>
          <TableCell className="text-right"><Value text={formatBytes(rss.median)} /></TableCell>
          <TableCell className="text-right"><Value text={formatBytes(rss.p95)} /></TableCell>
          <TableCell className="hidden text-right sm:table-cell"><Coverage valid={rss.valid} denominator={rss.denominator} /></TableCell>
        </TableRow>
        <TableRow>
          <TableCell className="whitespace-normal"><p>{t("analysis.peakCpu")}</p><span className="sm:hidden"><Coverage valid={cpu.valid} denominator={cpu.denominator} /></span></TableCell>
          <TableCell className="text-right"><Value text={formatCpu(cpu.median, locale)} /></TableCell>
          <TableCell className="text-right"><Value text={formatCpu(cpu.p95, locale)} /></TableCell>
          <TableCell className="hidden text-right sm:table-cell"><Coverage valid={cpu.valid} denominator={cpu.denominator} /></TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <div className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
      <p>{t("analysis.samplingQuality")}: {statuses.length ? statuses.map(([status, count]) => `${t(`analysis.resourceStatus.${status}`)} ${count}`).join(" · ") : t("analysis.noRuns")} · {t("analysis.samples", { samples: rss.sampleCount, intervals: cpu.cpuIntervalCount })}</p>
      <p className="flex items-start gap-1.5"><Info className="mt-0.5 size-3 shrink-0" aria-hidden />{t("analysis.resourceNote")}</p>
    </div>
  </div>;
}
