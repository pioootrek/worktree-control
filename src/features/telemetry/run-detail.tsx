"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { TestSummaryEntry } from "@/shared/contracts/verification-history";
import {
  dominantPhase, formatBytes, formatCpu, formatDuration, knownResourceReason, knownSourceReason, phaseSegments, resourceStatus, runFacts, runResources, worktreeLabel,
} from "./telemetry-model";
import { CommandBadge, Missing, PhaseBadge, ResourceBadge, SourceBadge, Value } from "./telemetry-parts";

const segmentTone = { queueMs: "bg-chart-2", prepareMs: "bg-chart-3", processMs: "bg-primary", cleanupMs: "bg-chart-4", finalizationMs: "bg-chart-5" } as const;

export function RunDetail({ entry, selected, selectionFull, onToggleSelection }: {
  entry: TestSummaryEntry; selected: boolean; selectionFull: boolean; onToggleSelection: () => void;
}) {
  const { t, locale } = useI18n();
  const { summary } = entry;
  const facts = runFacts(summary);
  const resources = runResources(summary);
  const status = resourceStatus(summary);
  const { segments, complete } = phaseSegments(summary);
  const dominant = dominantPhase(summary);
  const time = (value: string | null) => value ? new Date(value).toLocaleString(locale) : null;
  const durations = summary.telemetry.durations;

  return <>
    <SheetHeader className="pr-12">
      <SheetTitle className="break-all">{summary.presetId}</SheetTitle>
      <SheetDescription className="break-all">{new Date(summary.queuedAt).toLocaleString(locale)} · {worktreeLabel(summary.worktreePath)}</SheetDescription>
    </SheetHeader>
    <div className="space-y-6 px-4 pb-6" data-analysis-detail>
      <section aria-labelledby="run-outcome" className="space-y-3">
        <h3 id="run-outcome" className="text-sm font-semibold">{t("analysis.detail.outcome")}</h3>
        <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("analysis.runStatus")}</dt><dd><PhaseBadge phase={facts.phase} /></dd>
          <dt className="text-muted-foreground">{t("analysis.commandResult")}</dt>
          <dd className="flex flex-wrap items-center gap-2"><CommandBadge result={facts.command} />{summary.exitCode !== null ? <span className="text-xs text-muted-foreground">{t("analysis.exitCode", { code: summary.exitCode })}</span> : null}{summary.signal ? <span className="text-xs text-muted-foreground">{t("analysis.signal", { signal: summary.signal })}</span> : null}</dd>
          <dt className="text-muted-foreground">{t("analysis.sourceCheck")}</dt>
          <dd className="space-y-1"><SourceBadge source={facts.source} /><p className="text-xs text-muted-foreground">{t(`testSource.${facts.source}`)}</p></dd>
          <dt className="text-muted-foreground">{t("analysis.ending")}</dt>
          <dd className="text-sm">{t(`analysis.termination.${summary.telemetry.termination}`)} · {t(`analysis.cleanup.${summary.telemetry.cleanup}`)}</dd>
        </dl>
        {facts.note ? <p className="rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground">{t(`analysis.note.${facts.note}`)}</p> : null}
        {summary.sourceReasonCodes.length ? <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {summary.sourceReasonCodes.map((code) => <li key={code}>{knownSourceReason(code) ? t(`analysis.sourceReason.${code}`) : <span className="font-mono">{code}</span>}</li>)}
        </ul> : null}
        {summary.signal || summary.exitCode === 137 ? <p className="text-xs text-muted-foreground">{t("analysis.signalNote")}</p> : null}
      </section>

      <section aria-labelledby="run-timing" className="space-y-3">
        <h3 id="run-timing" className="text-sm font-semibold">{t("analysis.detail.timing")}</h3>
        {complete ? <div className="flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden>
          {segments.map((segment) => <span key={segment.key} className={segmentTone[segment.key]} style={{ width: `${(segment.share ?? 0) * 100}%` }} />)}
        </div> : <p className="text-xs text-muted-foreground">{t("analysis.timelineIncomplete")}</p>}
        {dominant ? <p className="text-sm">{t("analysis.dominant", { phase: t(`analysis.duration.${dominant}`), share: Math.round((segments.find((segment) => segment.key === dominant)?.share ?? 0) * 100) })}</p> : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-sm">
          {segments.map((segment) => <Row key={segment.key} label={<span className="inline-flex items-center gap-2"><span className={cn("size-2 rounded-full", segmentTone[segment.key])} aria-hidden />{t(`analysis.duration.${segment.key}`)}</span>} value={<Value text={formatDuration(segment.ms, locale)} />} />)}
          <Row label={<span className="font-medium">{t("analysis.duration.totalMs")}</span>} value={<Value className="font-medium" text={formatDuration(durations.totalMs, locale)} />} />
          <Row label={t("analysis.runnerWait")} value={<span className="text-xs text-muted-foreground">{t("analysis.notObservable")}</span>} />
        </dl>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3 shrink-0" aria-hidden />{t("analysis.phaseNote")}</p>
      </section>

      <section aria-labelledby="run-resources" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><h3 id="run-resources" className="text-sm font-semibold">{t("analysis.resources")}</h3><ResourceBadge status={status} /></div>
        {resources ? <>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-sm">
            <Row label={t("analysis.peakMemory")} value={<Value text={formatBytes(resources.peakSampledRssBytes)} />} />
            <Row label={t("analysis.peakCpu")} value={<Value text={formatCpu(resources.peakSampledCpuPercent, locale)} />} />
            <Row label={t("analysis.peakProcesses")} value={<Value text={resources.peakSampledProcessCount === null ? null : String(resources.peakSampledProcessCount)} />} />
            <Row label={t("analysis.sampleCount")} value={<span className="tabular-nums">{t("analysis.samplesOfAttempts", { samples: resources.sampleCount, attempts: resources.attemptCount })}</span>} />
            <Row label={t("analysis.sampleGaps")} value={<span className="tabular-nums">{t("analysis.sampleGapsValue", { missing: resources.missingSampleCount, partial: resources.partialSampleCount })}</span>} />
            <Row label={t("analysis.cpuWindow")} value={<span className="tabular-nums">{t("analysis.cpuWindowValue", { intervals: resources.cpuIntervalCount, window: formatDuration(resources.observedCpuWindowMs, locale) ?? "—" })}</span>} />
            <Row label={t("analysis.sampleInterval")} value={<Value text={formatDuration(resources.intervalMs, locale)} />} />
          </dl>
          {resources.reasons.length ? <div className="space-y-1"><p className="text-xs font-medium">{t("analysis.qualityReasons")}</p><ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {resources.reasons.map((reason) => <li key={reason}>{knownResourceReason(reason) ? t(`analysis.resourceReason.${reason}`) : <span className="font-mono">{reason}</span>}</li>)}
          </ul></div> : null}
        </> : <p className="text-sm text-muted-foreground">{t("analysis.resourcesLegacy")}</p>}
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3 shrink-0" aria-hidden />{t("analysis.resourceNote")}</p>
      </section>

      <section aria-labelledby="run-record" className="space-y-2">
        <h3 id="run-record" className="text-sm font-semibold">{t("analysis.detail.record")}</h3>
        <p className="text-sm text-muted-foreground">{entry.detailAvailable ? t("analysis.detailRetained") : t("analysis.summaryOnly")}</p>
        <Button variant="outline" size="sm" aria-pressed={selected} disabled={!selected && selectionFull} onClick={onToggleSelection}>{selected ? t("analysis.unselect") : t("analysis.selectForComparison")}</Button>
        {!selected && selectionFull ? <p className="text-xs text-muted-foreground">{t("analysis.selectionFull")}</p> : null}
      </section>

      <details className="space-y-2 text-xs">
        <summary className="cursor-pointer text-sm">{t("project.technicalDetails")}</summary>
        <dl className="mt-2 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 break-all">
          <Row align="start" label={t("analysis.tech.runId")} value={<span className="font-mono">{summary.runId}</span>} />
          <Row align="start" label={t("testView.worktree")} value={<span className="font-mono">{summary.worktreePath}</span>} />
          <Row align="start" label="HEAD" value={summary.sourceIdentity.head ? <span className="font-mono">{summary.sourceIdentity.head}</span> : <Missing />} />
          <Row align="start" label={t("analysis.tech.status")} value={summary.sourceIdentity.statusDigest ? <span className="font-mono">{summary.sourceIdentity.statusDigest}</span> : <Missing />} />
          <Row align="start" label={t("analysis.tech.dirty")} value={summary.sourceIdentity.dirty === null ? <Missing /> : summary.sourceIdentity.dirty ? t("analysis.yes") : t("analysis.no")} />
          <Row align="start" label={t("analysis.tech.command")} value={<span className="font-mono">{summary.commandDigest}</span>} />
          <Row align="start" label={t("analysis.tech.profile")} value={<span className="font-mono">{summary.profileDigest}</span>} />
          <Row align="start" label={t("analysis.tech.availability")} value={summary.telemetry.availability} />
          {(["admittedAt", "prepareFinishedAt", "spawnedAt", "exitedAt", "stopRequestedAt", "cleanupStartedAt", "cleanupFinishedAt", "finalizationStartedAt", "finalizedAt", "recoveredAt"] as const).map((key) =>
            <Row align="start" key={key} label={<span className="font-mono">{key}</span>} value={<Value text={time(summary.telemetry[key])} />} />)}
        </dl>
      </details>
    </div>
  </>;
}

function Row({ label, value, align = "end" }: { label: ReactNode; value: ReactNode; align?: "start" | "end" }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className={align === "end" ? "text-right" : "min-w-0"}>{value}</dd></>;
}
