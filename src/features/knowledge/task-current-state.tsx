"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, CircleMinus, Clock, ExternalLink, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { TranslationKey } from "@/i18n/messages";
import { knowledgeSourceHref } from "@/shared/contracts/knowledge-links";
import type { KnowledgeTaskStateView, TaskCurrentState, TaskDeliveryStage, TaskStateSource } from "@/shared/contracts/knowledge-task-state";
import { knowledgeRequest } from "./knowledge-client";

type Tone = "ok" | "bad" | "warn" | "progress" | "partial" | "neutral" | "unknown";
const TONE: Record<string, Tone> = { merged: "ok", passed: "ok", findings_closed: "ok", verified: "ok", done: "ok", failed: "bad", closed_unmerged: "bad",
  findings_open: "warn", stored: "partial", pending: "progress", running: "progress", in_progress: "progress", pr_open: "progress" };
const toneClass: Record<Tone, string> = { ok: "text-emerald-700 dark:text-emerald-300", bad: "text-destructive", warn: "text-amber-700 dark:text-amber-300",
  progress: "", partial: "", neutral: "", unknown: "text-muted-foreground" };
const toneIcon: Record<Tone, typeof CheckCircle2> = { ok: CheckCircle2, bad: XCircle, warn: AlertTriangle, progress: Clock, partial: CircleDashed, neutral: CircleMinus, unknown: CircleHelp };
const STAGES: TaskDeliveryStage[] = ["merge", "ci", "review", "evidence", "deploy"];
const short = (commit: string) => commit.slice(0, 7);
/** Keys composed from contract enums; every combination is defined in both dictionaries. */
const key = (value: string) => value as TranslationKey;

function formatTime(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Current state shown before the description; refreshed by the existing Knowledge change signal only. */
export function TaskCurrentState({ token, projectId, taskId, changeVersion, onShowHistory }: { token: string; projectId: string; taskId: string; changeVersion: number; onShowHistory: () => void }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<KnowledgeTaskStateView | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void knowledgeRequest<KnowledgeTaskStateView>(token, "task_state", { projectId, taskId }, abort.signal)
      .then(value => { if (abort.signal.aborted) return; if (value && typeof value === "object" && "assessment" in value) { setView(value); setFailed(false); } else { setView(null); setFailed(true); } })
      .catch(() => { if (!abort.signal.aborted) { setView(null); setFailed(true); } });
    return () => abort.abort();
  }, [token, projectId, taskId, changeVersion, retry]);

  const heading = <h4 id={`task-state-${taskId}`} className="text-xs font-semibold uppercase tracking-[0.09em] text-muted-foreground">{t("taskState.panel")}</h4>;
  const frame = (children: ReactNode) => <section aria-labelledby={`task-state-${taskId}`} className="space-y-4 rounded-md border border-border bg-card p-4 sm:p-5">{children}</section>;
  if (!view) return frame(<>{heading}{failed
    ? <div className="flex flex-wrap items-center gap-3 text-sm"><p role="status">{t("taskState.unavailable")}</p><Button size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}><RefreshCw aria-hidden className="size-4" />{t("knowledge.refresh")}</Button></div>
    : <p role="status" className="text-sm text-muted-foreground">{t("knowledge.loading")}</p>}</>);

  const { state, assessment } = view;
  const historyButton = <Button variant="outline" size="sm" onClick={onShowHistory}>{t("taskState.goToHistory")}</Button>;
  if (!state) return frame(<>
    <div className="flex flex-wrap items-center justify-between gap-2">{heading}<Chip tone={view.stateUnreadable ? "warn" : "unknown"}>{t(view.stateUnreadable ? "taskState.unreadable" : "taskState.missing")}</Chip></div>
    <p className="max-w-[75ch] text-sm text-muted-foreground">{t("taskState.missingHelp")}</p>
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {([["taskState.factDecisions", view.systemFacts.approvedDecisions], ["taskState.factProposals", view.systemFacts.proposals], ["taskState.factQuestions", view.systemFacts.openQuestions], ["taskState.factAttachments", view.systemFacts.attachments]] as const).map(([label, value]) =>
        <div key={label} className="rounded-md border border-border px-3 py-2"><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="text-lg font-semibold tabular-nums">{value}</dd></div>)}
    </dl>
    <div>{historyButton}</div>
  </>);

  const source = (item: TaskStateSource, index: number) => <SourceLink key={index} projectId={projectId} source={item} />;
  const sources = (items: TaskStateSource[]) => items.length ? <span className="ml-1 inline-flex flex-wrap gap-x-2">{items.map(source)}</span> : null;
  const open = (Array.isArray(state.blockers) ? state.blockers : []).filter(blocker => blocker.state === "open");
  const resolved = (Array.isArray(state.blockers) ? state.blockers : []).filter(blocker => blocker.state === "resolved");
  const consentTone: Tone = assessment.ownerConsent === "approved" ? "ok" : assessment.ownerConsent === "not_needed" ? "neutral" : assessment.ownerConsent === "unknown" ? "unknown" : "warn";
  const method = assessment.approvalMethod ? t(key(`taskState.method.${assessment.approvalMethod}`)) : "";
  const decisionRef = state.ownerDecision.state === "recorded" ? state.ownerDecision.decisionRef : state.ownerDecision.state === "needed" ? state.ownerDecision.proposalRef : undefined;
  const evidence = state.delivery.evidence;

  return frame(<>
    <div className="flex flex-wrap items-center justify-between gap-2">
      {heading}
      <Chip tone={assessment.freshness === "current" ? "ok" : "warn"}>{assessment.freshness === "current" ? t("taskState.current") : t("taskState.changedSince", { count: assessment.changeCount })}</Chip>
      <p className="basis-full text-xs text-muted-foreground">{t("taskState.meta", { revision: state.taskRevision, time: formatTime(state.writtenAt, locale), method: t(key(`taskState.method.${state.writtenBy.authenticationMethod}`)), who: state.declaredBy ?? state.writtenBy.principalId })}</p>
    </div>
    {assessment.freshness === "changed_since" && <div role="note" className="rounded-md border border-amber-500/40 p-3 text-sm">
      <p className="font-medium">{t("taskState.staleTitle", { count: assessment.changeCount })}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {assessment.changes.taskRevisions > 0 && <li>{t("taskState.changeTaskRevisions", { count: assessment.changes.taskRevisions })}{assessment.changes.statusChanged ? ` — ${t("taskState.changeStatus")}` : ""}{assessment.changes.descriptionChanged ? ` — ${t("taskState.changeDescription")}` : ""}</li>}
        {(["memoriesChanged", "attachmentsAdded", "repliesAdded", "staleSources", "inactiveSources"] as const).filter(name => assessment.changes[name] > 0).map(name => <li key={name}>{t(key(`taskState.change.${name}`), { count: assessment.changes[name] })}</li>)}
      </ul>
    </div>}
    <dl>
      <dt className="text-xs text-muted-foreground">{t("taskState.result")}</dt>
      <dd className="mt-1 max-w-[70ch] break-words text-lg leading-7">{state.outcome.known ? <><span>{state.outcome.text}</span>{sources(state.outcome.sources)}</> : <Unknown />}</dd>
    </dl>
    <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <Cell label={t("taskState.blocker")} tone={!Array.isArray(state.blockers) ? "unknown" : open.length ? "warn" : "ok"}>
        {!Array.isArray(state.blockers) ? <><Unknown />{state.blockers.reason && <span className="block text-xs text-muted-foreground">{state.blockers.reason}</span>}</>
          : open.length ? <ul className="space-y-2">{open.map(blocker => <li key={blocker.key}>
            <span className={toneClass.warn}>{blocker.text}</span>{sources(blocker.sources)}
            <span className="block text-xs text-muted-foreground">{t("taskState.unblockedBy", { actor: t(key(`taskState.actor.${blocker.unblockedBy}`)), condition: blocker.condition })}</span>
          </li>)}</ul>
          : <>{t("taskState.noBlocker")}{resolved.length > 0 && <span className="block text-xs text-muted-foreground">{t("taskState.resolvedCount", { count: resolved.length })}</span>}</>}
      </Cell>
      <Cell label={t("taskState.nextStep")} tone={!state.nextStep.known ? "unknown" : "action" in state.nextStep ? "progress" : "neutral"}>
        {!state.nextStep.known ? <Unknown /> : "action" in state.nextStep ? <><strong>{t(key(`taskState.actor.${state.nextStep.actor}`))}</strong> — {state.nextStep.action}{sources(state.nextStep.sources)}</> : t("taskState.none")}
      </Cell>
      <Cell label={t("taskState.ownerDecision")} tone={consentTone}>
        <span className={toneClass[consentTone]}>{t(key(`taskState.consent.${assessment.ownerConsent}`), { method })}</span>
        {state.ownerDecision.state === "needed" && <span className="block text-sm">{state.ownerDecision.question}</span>}
        {decisionRef && <span className="block">{source({ kind: "memory", ...decisionRef }, 0)}</span>}
      </Cell>
      <Cell label={t("taskState.evidence")} tone={assessment.evidence?.missing.length ? "bad" : "applies" in evidence && evidence.applies ? TONE[evidence.state] ?? "neutral" : "unknown"}>
        <DeliveryValue state={state} stage="evidence" />
        {assessment.evidence && <span className="block text-xs text-muted-foreground">{t("taskState.evidenceCount", { present: assessment.evidence.present, listed: assessment.evidence.listed })}{assessment.evidence.missing.length ? ` · ${t("taskState.evidenceMissing", { ids: assessment.evidence.missing.join(", ") })}` : ""}</span>}
      </Cell>
    </dl>
    <div>
      <h5 className="text-sm font-medium">{t("taskState.delivery")}</h5>
      <dl className="mt-1 divide-y divide-border text-sm">
        {STAGES.map(stage => {
          const fact = state.delivery[stage];
          const applied = "applies" in fact && fact.applies ? fact : null;
          return <div key={stage} className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t(key(`taskState.stage.${stage}`))}</dt>
            <dd><DeliveryValue state={state} stage={stage} /></dd>
            <dd className="break-words text-xs text-muted-foreground sm:text-sm">{applied && <>
              {applied.commit && <span className="font-mono">{short(applied.commit)}</span>}{applied.resultCommit && <> → <span className="font-mono">{short(applied.resultCommit)}</span></>}
              {applied.target && <> · {applied.target}</>} {t("taskState.checked", { time: formatTime(applied.observedAt, locale) })}{sources(applied.sources)}</>}</dd>
          </div>;
        })}
      </dl>
    </div>
    {assessment.findings.length > 0 && <div className="border-t border-border pt-3">
      <h5 className="flex items-center gap-2 text-sm font-medium"><AlertTriangle aria-hidden className="size-4 text-amber-600 dark:text-amber-300" />{t("taskState.attention", { count: assessment.findings.length })}</h5>
      <ul className="mt-2 space-y-1.5 text-sm">{assessment.findings.map((finding, index) => <li key={`${finding.code}-${index}`} className="flex gap-2">
        {finding.severity === "conflict" ? <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-300" />}
        <span><span className="font-medium">{t(finding.severity === "conflict" ? "taskState.conflict" : "taskState.attentionItem")}:</span> <span>{t(key(`taskState.finding.${finding.code}`), finding.values.method ? { ...finding.values, method: t(key(`taskState.method.${finding.values.method}`)) } : finding.values)}</span></span>
      </li>)}</ul>
    </div>}
    <div className="flex flex-wrap gap-2">{historyButton}</div>
  </>);
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = toneIcon[tone];
  return <span className={`inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs ${toneClass[tone]}`}><Icon aria-hidden className="size-3.5" />{children}</span>;
}

function Cell({ label, tone, children }: { label: string; tone: Tone; children: ReactNode }) {
  const Icon = toneIcon[tone];
  return <div className={`min-w-0 rounded-md border p-3 ${tone === "warn" ? "border-amber-500/50" : tone === "bad" ? "border-destructive/50" : "border-border"}`}>
    <dt className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon aria-hidden className={`size-3.5 ${toneClass[tone]}`} />{label}</dt>
    <dd className="mt-1 break-words text-sm">{children}</dd>
  </div>;
}

function Unknown() {
  const { t } = useI18n();
  return <span className="inline-flex items-center gap-1.5 text-muted-foreground"><CircleHelp aria-hidden className="size-4" />{t("taskState.unknown")}</span>;
}

function DeliveryValue({ state, stage }: { state: TaskCurrentState; stage: TaskDeliveryStage }) {
  const { t } = useI18n();
  const fact = state.delivery[stage];
  if (!("applies" in fact)) return <Unknown />;
  if (!fact.applies) return <span className="inline-flex items-center gap-1.5 text-muted-foreground"><CircleMinus aria-hidden className="size-4" />{t("taskState.notApplicable")}</span>;
  const tone = TONE[fact.state] ?? "neutral";
  const Icon = toneIcon[tone];
  return <span className={`inline-flex items-center gap-1.5 ${toneClass[tone]}`}><Icon aria-hidden className="size-4 shrink-0" />{t(key(`taskState.state.${stage}.${fact.state}`), { count: fact.openFindings ?? 0, who: state.declaredBy ?? state.writtenBy.principalId })}</span>;
}

function SourceLink({ projectId, source }: { projectId: string; source: TaskStateSource }) {
  const { t } = useI18n();
  const className = "text-xs text-muted-foreground underline underline-offset-2";
  if (source.kind === "external") return <a className={`${className} inline-flex items-center gap-1`} href={source.url} target="_blank" rel="noreferrer"><ExternalLink aria-hidden className="size-3" />{source.label}</a>;
  if (source.kind === "repository") return <span className="text-xs text-muted-foreground">{source.sourceId} · <span className="font-mono">{short(source.commit)}</span>:{source.path}</span>;
  if (source.kind === "attachment") return <span className="text-xs text-muted-foreground">{t("taskState.attachmentSource", { id: source.id })}</span>;
  const href = knowledgeSourceHref(projectId, source);
  const label = t("taskState.recordSource", { kind: t(key(`taskState.kind.${source.kind}`)), revision: source.revision });
  return href ? <a className={className} href={href}>{label}</a> : <span className="text-xs text-muted-foreground">{label}</span>;
}
