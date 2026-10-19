"use client";

import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { TestRunComparison, TestSummaryEntry } from "@/shared/contracts/verification-history";
import type { TelemetryRequestError } from "./telemetry-client";
import {
  caveatKey, DURATION_KEYS, formatBytes, formatCpu, formatDuration, formatSignedBytes, formatSignedCpu, formatSignedDuration, relativeChange,
  resourceComparability, runFacts, timingComparability, worktreeLabel,
} from "./telemetry-model";
import { CommandBadge, SourceBadge, Value } from "./telemetry-parts";

const identityKeys = ["source", "command", "profile", "preset", "worktree"] as const;

export function RunComparison({ state, onClose, errorMessage }: {
  state: { pair: [string, string]; data: TestRunComparison | null; error: TelemetryRequestError | null };
  onClose: () => void;
  errorMessage: (error: TelemetryRequestError) => string;
}) {
  const { t, locale } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  const pairKey = state.pair.join(":");
  useEffect(() => { heading.current?.focus({ preventScroll: false }); }, [pairKey]);
  const data = state.data;
  const censored = data ? data.populations.left !== "completed_execution" || data.populations.right !== "completed_execution" : false;
  const percent = (value: number | null) => value === null ? null : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value * 100).toLocaleString(locale, { maximumFractionDigits: 0 })}%`;

  return <section aria-labelledby="analysis-comparison" className="space-y-4 rounded-lg border border-primary/40 p-3 sm:p-4" data-analysis-comparison>
    <div className="flex items-start justify-between gap-3">
      <div><h3 id="analysis-comparison" ref={heading} tabIndex={-1} className="font-semibold focus-visible:outline-2 focus-visible:outline-ring">{t("analysis.compare.title")}</h3><p className="text-xs text-muted-foreground">{t("analysis.compare.lead")}</p></div>
      <Button variant="ghost" size="icon-sm" aria-label={t("analysis.compare.close")} onClick={onClose}><X aria-hidden /></Button>
    </div>
    {!data && !state.error ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("analysis.compare.loading")}</p> : null}
    {state.error ? <p role="alert" className="text-sm text-destructive">{errorMessage(state.error)}</p> : null}
    {data ? <>
      <div className="grid gap-3 sm:grid-cols-2">
        <RunCard label={t("analysis.compare.a")} entry={data.left} population={data.populations.left} />
        <RunCard label={t("analysis.compare.b")} entry={data.right} population={data.populations.right} />
      </div>

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t("analysis.compare.identity")}</h4>
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {identityKeys.map((key) => <li key={key} className={cn("rounded-md border px-2 py-0.5", data.differences[key] ? "border-warning-foreground/40 text-warning-foreground" : "text-muted-foreground")}>
            {t(`analysis.compare.identity.${key}`)}: {data.differences[key] ? t("analysis.compare.different") : t("analysis.compare.same")}
          </li>)}
        </ul>
      </div>

      {censored ? <p className="flex items-start gap-2 rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{t("analysis.compare.censored")}</p> : null}

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[30rem]">
          <TableHeader><TableRow><TableHead>{t("analysis.phase")}</TableHead><TableHead className="text-right">A</TableHead><TableHead className="text-right">B</TableHead><TableHead className="text-right">{t("analysis.compare.delta")}</TableHead></TableRow></TableHeader>
          <TableBody>
            {DURATION_KEYS.map((key) => {
              const row = data.timings[key];
              const comparability = timingComparability(row);
              const change = percent(relativeChange(row.leftMs, row.deltaMs));
              return <TableRow key={key} className={key === "totalMs" ? "border-t-2 font-medium" : undefined}>
                <TableCell className="whitespace-normal">{t(`analysis.duration.${key}`)}</TableCell>
                <TableCell className="text-right"><Value text={formatDuration(row.leftMs, locale)} /></TableCell>
                <TableCell className="text-right"><Value text={formatDuration(row.rightMs, locale)} /></TableCell>
                <TableCell className="text-right">{comparability === "comparable" && row.deltaMs !== null
                  ? <span className="tabular-nums">{formatSignedDuration(row.deltaMs, locale)}{change ? <span className="ml-1 text-xs text-muted-foreground">({change})</span> : null}</span>
                  : <span className="text-xs text-muted-foreground">{t(`analysis.compare.timing.${comparability}`)}</span>}</TableCell>
              </TableRow>;
            })}
            <TableRow>
              <TableCell className="whitespace-normal">{t("analysis.peakMemory")}</TableCell>
              <TableCell className="text-right"><Value text={formatBytes(data.resources.rss.left)} /></TableCell>
              <TableCell className="text-right"><Value text={formatBytes(data.resources.rss.right)} /></TableCell>
              <TableCell className="text-right"><ResourceDelta comparability={resourceComparability(data.resources.rss)} text={formatSignedBytes(data.resources.rss.delta)} /></TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="whitespace-normal">{t("analysis.peakCpu")}</TableCell>
              <TableCell className="text-right"><Value text={formatCpu(data.resources.cpu.left, locale)} /></TableCell>
              <TableCell className="text-right"><Value text={formatCpu(data.resources.cpu.right, locale)} /></TableCell>
              <TableCell className="text-right"><ResourceDelta comparability={resourceComparability(data.resources.cpu)} text={formatSignedCpu(data.resources.cpu.delta, locale)} /></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">{t("analysis.compare.deltaNote")}</p>

      <div className="space-y-1">
        <h4 className="text-xs font-medium text-muted-foreground">{t("analysis.compare.caveats")}</h4>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {data.caveats.map((caveat) => { const key = caveatKey(caveat); return <li key={caveat}>{key ? t(`analysis.caveat.${key}`) : caveat}</li>; })}
          <li>{t("analysis.caveat.singlePair")}</li>
        </ul>
      </div>
    </> : null}
  </section>;
}

function ResourceDelta({ comparability, text }: { comparability: ReturnType<typeof resourceComparability>; text: string | null }) {
  const { t } = useI18n();
  return comparability === "comparable" && text !== null ? <span className="tabular-nums">{text}</span>
    : <span className="text-xs text-muted-foreground">{t(`analysis.compare.resource.${comparability}`)}</span>;
}

function RunCard({ label, entry, population }: { label: string; entry: TestSummaryEntry; population: TestRunComparison["populations"]["left"] }) {
  const { t, locale } = useI18n();
  const facts = runFacts(entry.summary);
  return <div className="min-w-0 space-y-1.5 rounded-md bg-muted/40 p-3 text-sm">
    <p className="text-xs font-medium text-muted-foreground">{label}</p>
    <p className="break-all font-medium">{entry.summary.presetId}</p>
    <p className="break-all text-xs text-muted-foreground">{new Date(entry.summary.queuedAt).toLocaleString(locale)} · {worktreeLabel(entry.summary.worktreePath)} · {entry.summary.sourceIdentity.head?.slice(0, 8) ?? t("analysis.noHead")}</p>
    <div className="flex flex-wrap gap-1.5"><CommandBadge result={facts.command} /><SourceBadge source={facts.source} /></div>
    <p className="text-xs text-muted-foreground">{t(`analysis.population.${population}`)}</p>
  </div>;
}
