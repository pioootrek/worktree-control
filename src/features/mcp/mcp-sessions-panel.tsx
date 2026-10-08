"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/i18n/provider";
import type { Translate } from "@/i18n/messages";
import type { McpSessionDiagnostics } from "@/shared/contracts/mcp-diagnostics";
import { bytes } from "@/features/storage/resource-summary";
import { qualifyingIdleMs, remainingLifetimeMs, sortSessions, type McpDiagnosticsRead, type SessionSort } from "./session-summary";

function stateLabel(session: McpSessionDiagnostics, t: Translate) {
  const state = !session.initialized && !session.closed ? t("mcpSessions.initializing") : session.state === "open" ? t("mcpSessions.state.open") : session.state === "draining" ? t("mcpSessions.state.draining") : t("mcpSessions.state.closed");
  const transport = session.transportPhase === "open" ? t("mcpSessions.transport.open") : session.transportPhase === "interrupted" ? t("mcpSessions.transport.interrupted") : session.transportPhase === "request-only" ? t("mcpSessions.transport.request-only") : t("mcpSessions.transport.closed");
  return `${state} · ${transport}`;
}
function renewalLabel(value: string, t: Translate) {
  return value === "renewing" ? t("mcpSessions.renewing") : value === "stopped-idle" ? t("mcpSessions.stopped-idle") : t("mcpSessions.none");
}
export function McpSessionsPanel({ read, refresh }: { read: McpDiagnosticsRead; refresh: () => void }) {
  const { t, locale } = useI18n();
  const [tick, setTick] = useState(() => Date.now());
  const [sort, setSort] = useState<SessionSort>({ field: "claims", descending: true });
  useEffect(() => {
    const interval = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const elapsed = read.receivedAt ? Math.max(0, tick - read.receivedAt) : 0;
  const snapshot = read.body?.mcp;
  const now = snapshot ? Date.parse(snapshot.observedAt) + elapsed : tick;
  const seconds = (ms: number) => t("mcpSessions.seconds", { seconds: Math.floor(Math.max(0, ms) / 1000) });
  const date = (at: string) => new Date(at).toLocaleString(locale);
  const stale = !!snapshot && (elapsed >= 15_000 || !!read.error);
  const rows = snapshot ? sortSessions(snapshot.sessions, sort, now) : [];
  const changeSort = (field: SessionSort["field"]) => setSort(current => ({ field, descending: current.field === field ? !current.descending : true }));
  const sortButton = (field: SessionSort["field"]) => <Button variant="ghost" size="sm" aria-label={t(field === "claims" ? "mcpSessions.sortClaims" : "mcpSessions.sortIdle")} onClick={() => changeSort(field)}>{t(field === "claims" ? "mcpSessions.claims" : "mcpSessions.idle")}{sort.field === field ? sort.descending ? " ↓" : " ↑" : ""}</Button>;
  const idle = (session: McpSessionDiagnostics) => { const age = qualifyingIdleMs(session, now); return age === null ? t("mcpSessions.never") : seconds(age); };
  const closeDue = (session: McpSessionDiagnostics) => session.closeDueAt ? <>{seconds(Date.parse(session.closeDueAt) - now)}{session.closeDueReason ? <p className="text-xs text-muted-foreground">{t(`mcpSessions.reason.${session.closeDueReason}`)}</p> : null}</> : t("mcpSessions.none");
  return <section data-mcp-sessions className="min-w-0 space-y-4" aria-label={t("mcpSessions.title")}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-3xl"><h2 className="font-semibold">{t("mcpSessions.title")}</h2><p className="text-sm text-muted-foreground">{t("mcpSessions.scope")}</p></div><Button variant="outline" disabled={read.loading} onClick={refresh}>{t("mcpSessions.refresh")}</Button></div>
    {read.error ? <Alert variant="destructive"><AlertDescription>{t(`mcpSessions.${read.error}`)}</AlertDescription></Alert> : null}
    {stale ? <p role="status" className="text-sm font-medium">{t("mcpSessions.stale")}</p> : null}
    {!read.body && !read.error ? <p role="status">{t("mcpSessions.loading")}</p> : null}
    {read.body?.status === "disabled" ? <p>{t("mcpSessions.disabled")}</p> : null}
    {snapshot ? <>
      <p className="text-xs text-muted-foreground">{t("mcpSessions.observed", { at: date(snapshot.observedAt), seconds: Math.floor(elapsed / 1000) })}</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">{([
        ["admission", `${snapshot.admission.admittedSessions} / ${snapshot.admission.limit}`], ["logical", snapshot.logicalSessions],
        ["initializing", snapshot.initializingSessions], ["draining", snapshot.drainingSessions], ["connections", snapshot.connections],
        ["claims", snapshot.claims], ["renewalTimers", snapshot.renewalTimers], ["refusals", snapshot.closeReasons["admission-refused"]],
      ] as const).map(([key, value]) => <div key={key}><dt className="text-xs text-muted-foreground">{t(`mcpSessions.${key}`)}</dt><dd className="font-mono text-lg">{value}</dd></div>)}</dl>
      <p className="text-xs text-muted-foreground">{t("mcpSessions.claimScope")}</p>
      <div className="space-y-2"><h3 className="text-sm font-semibold">{t("mcpSessions.controller")}</h3><p className="font-mono text-sm">RSS {bytes(snapshot.controllerProcess.rssBytes)} · CPU {snapshot.controllerProcess.cpuPercent === null ? t("mcpSessions.unknown") : `${snapshot.controllerProcess.cpuPercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`}</p><p className="text-xs text-muted-foreground">{t("mcpSessions.sample", { at: date(snapshot.controllerProcess.sampledAt), seconds: Math.floor((snapshot.processSampleAgeMs + elapsed) / 1000), interval: snapshot.processSampleIntervalMs / 1000 })}</p><p className="text-xs text-muted-foreground">{t("mcpSessions.processScope")}</p></div>
      <details><summary className="cursor-pointer text-sm font-medium">{t("mcpSessions.policy")}</summary><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2"><div><dt>{t("mcpSessions.perCredential")}</dt><dd className="font-mono">{snapshot.admission.perCredentialLimit}</dd></div>{Object.entries(snapshot.policy).map(([key, value]) => <div key={key}><dt>{t(`mcpSessions.${key as keyof typeof snapshot.policy}`)}</dt><dd className="font-mono">{seconds(value * 1000)}</dd></div>)}</dl></details>
      <p className="text-sm">{t("mcpSessions.coverage", { shown: rows.length, omitted: snapshot.omittedSessions })}</p>
      {snapshot.truncated > 0 ? <p role="status" className="text-sm font-medium">{t("mcpSessions.incomplete")}</p> : null}
      <div className="flex flex-wrap gap-2 md:hidden">{sortButton("claims")}{sortButton("idle")}</div>
      <div className="space-y-3 md:hidden">{rows.map(session => <article key={session.label} data-session-label={session.label} className="space-y-2 rounded-lg border p-3"><p className="font-medium">{t("mcpSessions.label")} #{session.label} · {stateLabel(session, t)}</p><dl className="grid grid-cols-2 gap-2 text-sm"><div><dt>{t("mcpSessions.claims")}</dt><dd>{session.claims}</dd></div><div><dt>{t("mcpSessions.idle")}</dt><dd>{idle(session)}</dd></div><div><dt>{t("mcpSessions.responses")}</dt><dd>{session.openResponses} / {session.sseResponses}</dd></div><div><dt>{t("mcpSessions.operations")}</dt><dd>{session.operations}</dd></div></dl><details><summary className="cursor-pointer text-sm">{t("row.details")}</summary><dl className="mt-2 space-y-2 text-sm"><div><dt>{t("mcpSessions.created")}</dt><dd>{date(session.createdAt)}</dd></div><div><dt>{t("mcpSessions.activity")}</dt><dd>{session.lastQualifyingActivityAt ? date(session.lastQualifyingActivityAt) : t("mcpSessions.never")}</dd></div><div><dt>{t("mcpSessions.renewal")}</dt><dd>{renewalLabel(session.renewalPolicyState, t)} · {session.renewalTimers}<p>{t("mcpSessions.skipped", { count: session.renewalsSkippedByPolicy })}</p></dd></div><div><dt>{t("mcpSessions.closeDue")}</dt><dd>{closeDue(session)}</dd></div><div><dt>{t("mcpSessions.lifetime")}</dt><dd>{seconds(remainingLifetimeMs(session, snapshot.policy.absoluteLifetimeSeconds, now))}</dd></div><div><dt>{t("mcpSessions.waiters")}</dt><dd>{session.statusWaits?.waiters ?? t("mcpSessions.unknown")}</dd></div></dl></details></article>)}</div>
      <div className="hidden max-w-full overflow-hidden rounded-lg border md:block"><Table className="min-w-[1200px]"><caption className="sr-only">{t("mcpSessions.title")}</caption><TableHeader><TableRow><TableHead scope="col">{t("mcpSessions.label")}</TableHead><TableHead scope="col" aria-sort={sort.field === "claims" ? sort.descending ? "descending" : "ascending" : "none"}>{sortButton("claims")}</TableHead><TableHead scope="col" aria-sort={sort.field === "idle" ? sort.descending ? "descending" : "ascending" : "none"}>{sortButton("idle")}</TableHead>{(["created", "activity", "transport", "responses", "operations", "renewal", "closeDue", "lifetime", "waiters"] as const).map(key => <TableHead key={key} scope="col">{t(`mcpSessions.${key}`)}</TableHead>)}</TableRow></TableHeader><TableBody>{rows.map(session => <TableRow key={session.label} data-session-label={session.label}><TableCell className="font-mono">#{session.label}</TableCell><TableCell>{session.claims}</TableCell><TableCell className="whitespace-nowrap">{idle(session)}</TableCell><TableCell className="text-xs">{date(session.createdAt)}</TableCell><TableCell className="text-xs">{session.lastQualifyingActivityAt ? date(session.lastQualifyingActivityAt) : t("mcpSessions.never")}</TableCell><TableCell>{stateLabel(session, t)}</TableCell><TableCell>{session.openResponses} / {session.sseResponses}</TableCell><TableCell>{session.operations}</TableCell><TableCell>{renewalLabel(session.renewalPolicyState, t)} · {session.renewalTimers}<p className="text-xs text-muted-foreground">{t("mcpSessions.skipped", { count: session.renewalsSkippedByPolicy })}</p></TableCell><TableCell>{closeDue(session)}</TableCell><TableCell className="whitespace-nowrap">{seconds(remainingLifetimeMs(session, snapshot.policy.absoluteLifetimeSeconds, now))}</TableCell><TableCell>{session.statusWaits?.waiters ?? t("mcpSessions.unknown")}</TableCell></TableRow>)}</TableBody></Table></div>
      {!rows.length ? <p className="text-sm text-muted-foreground">{t("mcpSessions.empty")}</p> : null}
      <div className="space-y-2"><h3 className="text-sm font-semibold">{t("mcpSessions.history")}</h3><p className="text-xs text-muted-foreground">{t("mcpSessions.historyHint")}</p><ul className="space-y-2 text-sm">{[...snapshot.recentClosures].reverse().map((closure, index) => <li key={`${closure.at}-${index}`} className="flex flex-wrap gap-x-3"><time dateTime={closure.at}>{date(closure.at)}</time><span>{t(`mcpSessions.reason.${closure.reason}`)}</span><span>{t("mcpSessions.operations")}: {closure.operationsAtClose}</span></li>)}</ul>{!snapshot.recentClosures.length ? <p className="text-sm text-muted-foreground">{t("mcpSessions.historyEmpty")}</p> : null}<details><summary className="cursor-pointer text-sm">{t("mcpSessions.totals")}</summary><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">{Object.entries(snapshot.closeReasons).map(([reason, count]) => <div key={reason}><dt>{t(`mcpSessions.reason.${reason as keyof typeof snapshot.closeReasons}`)}</dt><dd>{count}</dd></div>)}</dl></details></div>
    </> : null}
  </section>;
}
