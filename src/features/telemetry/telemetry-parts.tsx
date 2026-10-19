"use client";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { TestRunPhase, TestSourceAttribution } from "@/shared/contracts";
import type { CommandResult, ResourceStatus } from "./telemetry-model";

/** A missing measurement: visibly absent and announced, never rendered as zero. */
export function Missing({ className }: { className?: string }) {
  const { t } = useI18n();
  return <span className={cn("text-muted-foreground", className)}><span aria-hidden>—</span><span className="sr-only">{t("analysis.notMeasured")}</span></span>;
}

export function Value({ text, className }: { text: string | null; className?: string }) {
  return text === null ? <Missing className={className} /> : <span className={cn("tabular-nums", className)}>{text}</span>;
}

const commandTone: Record<CommandResult, string> = {
  passed: "text-success-foreground", failed: "text-destructive", timed_out: "text-destructive", interrupted: "text-warning-foreground",
  cancelled: "text-muted-foreground", unknown: "text-muted-foreground",
};
export function CommandBadge({ result, className }: { result: CommandResult; className?: string }) {
  const { t } = useI18n();
  return <Badge variant="outline" className={cn(commandTone[result], className)}>{result === "unknown" ? t("analysis.command.unknown") : t(`testPhase.${result}`)}</Badge>;
}

const sourceTone: Record<TestSourceAttribution, string> = {
  observed_match: "text-success-foreground", changed: "text-destructive", uncertain: "text-warning-foreground",
  pending: "text-muted-foreground", legacy_unknown: "text-muted-foreground",
};
export function SourceBadge({ source, className }: { source: TestSourceAttribution; className?: string }) {
  const { t } = useI18n();
  return <Badge variant="secondary" className={cn(sourceTone[source], className)}>{t(`analysis.source.${source}`)}</Badge>;
}

export function PhaseBadge({ phase }: { phase: TestRunPhase }) {
  const { t } = useI18n();
  const tone = phase === "passed" ? "text-success-foreground" : ["failed", "timed_out", "interrupted"].includes(phase) ? "text-destructive" : "text-muted-foreground";
  return <Badge variant="outline" className={tone}>{t(`testPhase.${phase}`)}</Badge>;
}

const resourceTone: Record<ResourceStatus, string> = {
  sampled: "text-success-foreground", partial: "text-warning-foreground", pending: "text-muted-foreground",
  unavailable: "text-muted-foreground", unsupported: "text-muted-foreground", legacy_unknown: "text-muted-foreground",
};
export function ResourceBadge({ status }: { status: ResourceStatus }) {
  const { t } = useI18n();
  return <Badge variant="outline" className={resourceTone[status]}>{t(`analysis.resourceStatus.${status}`)}</Badge>;
}

export type Tone = "success" | "destructive" | "warning" | "muted";
const toneDot: Record<Tone, string> = { success: "bg-success-foreground", destructive: "bg-destructive", warning: "bg-warning-foreground", muted: "bg-muted-foreground/60" };
export const commandToneKey: Record<CommandResult, Tone> = { passed: "success", failed: "destructive", timed_out: "destructive", interrupted: "warning", cancelled: "muted", unknown: "muted" };
export const sourceToneKey: Record<TestSourceAttribution, Tone> = { observed_match: "success", changed: "destructive", uncertain: "warning", pending: "muted", legacy_unknown: "muted" };

export interface DistributionItem { key: string; label: string; count: number; tone: Tone; selected?: boolean; onSelect?: () => void }

/** Counts as one proportional bar plus a labelled legend; the legend carries every value. */
export function Distribution({ title, items, total, actionLabel }: { title: string; items: DistributionItem[]; total: number; actionLabel?: (label: string) => string }) {
  const visible = items.filter((item) => item.count > 0);
  return <div className="min-w-0 space-y-2">
    <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
    <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
      {total > 0 ? visible.map((item) => <span key={item.key} className={cn("h-full", toneDot[item.tone])} style={{ width: `${(item.count / total) * 100}%` }} />) : null}
    </div>
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {items.map((item) => {
        const content = <><span className={cn("size-2 shrink-0 rounded-full", toneDot[item.tone])} aria-hidden /><span className="text-muted-foreground">{item.label}</span><span className="font-medium tabular-nums">{item.count}</span></>;
        return <li key={item.key}>{item.onSelect && item.count > 0
          ? <button type="button" aria-pressed={item.selected ?? false} aria-label={actionLabel?.(`${item.label}: ${item.count}`)} onClick={item.onSelect} className={cn("inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", item.selected && "bg-primary/15 ring-1 ring-primary/50")}>{content}</button>
          : <span className="inline-flex items-center gap-1.5 px-1 py-0.5">{content}</span>}</li>;
      })}
    </ul>
  </div>;
}
