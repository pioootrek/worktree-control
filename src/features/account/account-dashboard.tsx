"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/provider";
import { useTheme } from "@/features/dashboard/theme-toggle";
import { KnowledgeDashboard } from "@/features/knowledge/knowledge-dashboard";
import { ACCOUNT_SESSION } from "@/features/knowledge/knowledge-client";
import type { ScopedProjectStatus, ScopedProjectSummary, ScopedWorktree } from "@/shared/contracts/runtime-access";
import type { ScopedEnvironmentProfiles, ScopedProjectConfiguration } from "@/shared/contracts/scoped-configuration";
import { AlertTriangle, Languages, LoaderCircle, LogOut, Moon, RefreshCw, Sun } from "lucide-react";
import { AccountSecurity } from "./account-security";
import {
  cancelTestRun, enqueueTest, idempotencyKey, isRuntimeSessionLoss, runtimeConfiguration, runtimeMutate, runtimeRead,
  RuntimeApiError, testPresets, testRunStatus, type ScopedTestPresets, type ScopedTestRunEnvelope,
} from "./runtime-client";
import type { AccountSession } from "./use-account-session";

type AccountTab = "projects" | "knowledge" | "security";

/**
 * The account-mode work area. Every right comes from the backend: project
 * `actions` decide which panels render, and every denial is shown as a
 * current-authority answer, never inferred from the principal kind. There is
 * no SSE in account mode; panels poll with bounded intervals and mutations
 * refresh their own target.
 */
export function AccountDashboard({ session, onSignOut, onSessionLost, notice, dismissNotice }: {
  session: AccountSession;
  onSignOut: () => void;
  /** Session is gone; the optional key is a notice shown on the sign-in screen (e.g. a finished enrollment). */
  onSessionLost: (noticeKey?: "account.totpEnrolled" | "account.passkeyEnrolled") => void;
  notice: string | null;
  dismissNotice: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const { dark, toggle: toggleTheme } = useTheme();
  const [tab, setTab] = useState<AccountTab>("projects");

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background/95 px-3 py-1 backdrop-blur-xl sm:px-5">
        <h1 className="text-base font-semibold">Worktree Control</h1>
        <Tabs value={tab} onValueChange={value => setTab(value as AccountTab)}>
          <TabsList aria-label={t("account.navigation")} className="h-auto min-h-10 flex-wrap">
            <TabsTrigger className="min-h-9" value="projects">{t("account.tab.projects")}</TabsTrigger>
            <TabsTrigger className="min-h-9" value="knowledge">{t("knowledge.title")}</TabsTrigger>
            <TabsTrigger className="min-h-9" value="security">{t("account.tab.security")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <span className="hidden text-xs text-muted-foreground md:inline">
            {t("account.sessionInfo", {
              kind: t(session.principal.kind === "owner" ? "account.role.owner" : "account.role.human"),
              method: t(`account.method.${session.authentication.method}`),
              expires: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(session.expiresAt)),
            })}
          </span>
          <Button variant="ghost" size="sm" aria-label={t("language.label")} onClick={() => setLocale(locale === "pl" ? "en" : "pl")}><Languages aria-hidden /></Button>
          <Button variant="ghost" size="sm" aria-label={dark ? t("theme.light") : t("theme.dark")} onClick={toggleTheme}>{dark ? <Sun aria-hidden /> : <Moon aria-hidden />}</Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}><LogOut aria-hidden className="size-4" />{t("access.signOut")}</Button>
        </div>
      </header>
      {notice && (
        <Alert variant="success" className="mx-auto mt-4 max-w-3xl">
          <AlertDescription>{t(notice as Parameters<typeof t>[0])}</AlertDescription>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={dismissNotice}>{t("common.close")}</Button>
        </Alert>
      )}
      <main className="mx-auto max-w-5xl px-3 py-5 sm:px-5">
        {tab === "projects" && <ProjectsPanel onSessionLost={onSessionLost} />}
        {tab === "knowledge" && (
          <KnowledgeDashboard
            key={`${session.principal.id}:${session.expiresAt}`}
            token={ACCOUNT_SESSION}
            setToken={() => undefined}
            access="account"
            change={{ version: 0, projectIds: [] }}
          />
        )}
        {tab === "security" && <AccountSecurity onEnrollmentComplete={message => onSignOutAfterEnrollment(message)} onSessionLost={onSessionLost} />}
      </main>
    </div>
  );

  function onSignOutAfterEnrollment(message: "account.totpEnrolled" | "account.passkeyEnrolled") {
    // Selection ended every session of the account; sign-in is the only honest next step.
    onSessionLost(message);
  }
}

function describeError(t: (key: never, values?: Record<string, string | number>) => string, cause: unknown): string {
  if (cause instanceof RuntimeApiError) {
    if (cause.status === 401) return t("account.sessionLost" as never);
    if (cause.status === 403) return t("account.denied" as never);
    if (cause.status === 429) return t("account.rateLimited" as never);
    if (cause.code === "claim_conflict" || cause.code === "claim_stale" || cause.code === "claim_worktree_mismatch") return t("account.claimConflict" as never);
    if (cause.code === "revision_conflict") return t("account.revisionConflict" as never);
    if (cause.status >= 500) return t("account.unavailable" as never);
    return t("account.actionFailed" as never, { code: cause.code });
  }
  return t("account.unavailable" as never);
}

function ProjectsPanel({ onSessionLost }: { onSessionLost: (noticeKey?: "account.totpEnrolled" | "account.passkeyEnrolled") => void }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<ScopedProjectSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback((signal?: AbortSignal) => {
    return runtimeRead({ operation: "list-projects" }, signal)
      .then(result => {
        if (signal?.aborted) return;
        setProjects(result.projects);
        setSelectedId(current => current && result.projects.some(project => project.id === current) ? current : result.projects[0]?.id ?? null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (signal?.aborted) return;
        if (isRuntimeSessionLoss(cause)) { onSessionLost(); return; }
        setError(describeError(t, cause));
      });
  }, [onSessionLost, t]);

  useEffect(() => {
    const abort = new AbortController();
    generation.current += 1;
    void load(abort.signal);
    const interval = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => { abort.abort(); window.clearInterval(interval); };
  }, [load]);

  if (error && !projects) {
    return <div className="space-y-3">
      <Alert variant="destructive"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>
      <Button variant="outline" onClick={() => void load()}><RefreshCw aria-hidden className="size-4" />{t("account.retry")}</Button>
    </div>;
  }
  if (!projects) return <p role="status" className="py-16 text-muted-foreground"><LoaderCircle className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("dashboard.connecting")}</p>;
  if (!projects.length) return <p className="py-16 text-muted-foreground">{t("account.noProjects")}</p>;

  const selected = projects.find(project => project.id === selectedId) ?? projects[0]!;
  return (
    <div className="grid gap-5">
      {error && <Alert variant="destructive"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 space-y-1.5">
          <Label htmlFor="account-project">{t("account.projects")}</Label>
          <select id="account-project" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={selected.id} onChange={event => setSelectedId(event.target.value)}>
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <Button variant="outline" className="h-9" onClick={() => void load()}><RefreshCw aria-hidden className="size-4" />{t("knowledge.refresh")}</Button>
      </div>
      <ProjectDetail key={selected.id} summary={selected} onSessionLost={onSessionLost} />
    </div>
  );
}

function ProjectDetail({ summary, onSessionLost }: { summary: ScopedProjectSummary; onSessionLost: (noticeKey?: "account.totpEnrolled" | "account.passkeyEnrolled") => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<ScopedProjectStatus | null>(null);
  const [worktrees, setWorktrees] = useState<ScopedWorktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canClaim = summary.actions.includes("claims:manage");
  const canControl = summary.actions.includes("runtime:control");
  const canTest = summary.actions.includes("tests:run");
  const canProfiles = summary.actions.includes("profiles:select");
  const canConfig = summary.actions.includes("config:write");

  const fail = useCallback((cause: unknown) => {
    if (isRuntimeSessionLoss(cause)) { onSessionLost(); return true; }
    setError(describeError(t, cause));
    return false;
  }, [onSessionLost, t]);

  const refresh = useCallback((signal?: AbortSignal) => {
    return runtimeRead({ operation: "project-status", projectId: summary.id }, signal)
      .then(result => {
        if (signal?.aborted) return;
        setStatus(result.status);
        setError(null);
      })
      .catch((cause: unknown) => { if (!signal?.aborted) fail(cause); });
  }, [fail, summary.id]);

  useEffect(() => {
    const abort = new AbortController();
    void refresh(abort.signal);
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
    return () => { abort.abort(); window.clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    if (!canClaim && !canConfig) return;
    const abort = new AbortController();
    runtimeRead({ operation: "list-worktrees", projectId: summary.id }, abort.signal)
      .then(result => { if (!abort.signal.aborted) setWorktrees(result.worktrees); })
      .catch(cause => { if (!abort.signal.aborted) fail(cause); });
    return () => abort.abort();
  }, [canClaim, canConfig, fail, summary.id]);

  const act = async (body: Parameters<typeof runtimeMutate>[0]) => {
    setError(null); setNotice(null);
    try {
      const result = await runtimeMutate(body);
      if (result.operation === "claim" && result.error) setError(t("account.actionFailed", { code: result.error.code }));
      else if ((result.operation === "start" || result.operation === "restart" || result.operation === "stop") && result.receipt.outcome === "failed") {
        setError(t("account.actionFailed", { code: result.receipt.error?.code ?? "failed" }));
      } else setNotice(t("account.actionDone"));
      await refresh();
    } catch (cause) { fail(cause); }
  };

  const claim = (worktreePath: string, reason: string, start: boolean) =>
    void act({ operation: "claim", projectId: summary.id, worktreePath, reason, start, ttlSeconds: 1800, idempotencyKey: idempotencyKey() });
  const own = status?.ownClaim ?? null;

  return (
    <div className="grid gap-5">
      <section className="rounded-xl border border-border bg-card/30 p-5" aria-label={summary.name}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold">{summary.name}</h2>
          <span className="text-sm text-muted-foreground">{t(`phase.${summary.phase}`)}</span>
          <span className="text-sm text-muted-foreground">{t("account.claimRelation", { relation: t(`account.claim.${status?.claim ?? summary.claim}`) })}</span>
          {status?.worktreePath && <span className="break-all text-sm text-muted-foreground">{status.worktreePath}</span>}
        </div>
        {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
        {error && <Alert variant="destructive" className="mt-3"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
        {canClaim && (
          <ClaimControls
            worktrees={worktrees}
            own={own}
            busyLabel={t("account.claim")}
            onClaim={claim}
            onRenew={() => own && void act({ operation: "renew", projectId: summary.id, reservationId: own.reservationId, ttlSeconds: 1800, idempotencyKey: idempotencyKey() })}
            onRelease={() => own && void act({ operation: "release", projectId: summary.id, reservationId: own.reservationId, idempotencyKey: idempotencyKey() })}
          />
        )}
        {canControl && (
          <div className="mt-4 flex flex-wrap gap-2">
            {(["start", "restart", "stop"] as const).map(action => (
              <Button key={action} variant="outline" disabled={!own}
                title={own ? undefined : t("account.needsOwnClaim")}
                onClick={() => own && void act({ operation: action, projectId: summary.id, reservationId: own.reservationId, idempotencyKey: idempotencyKey() })}>
                {t(`account.${action}`)}
              </Button>
            ))}
            {!own && <p className="w-full text-sm text-muted-foreground">{t("account.needsOwnClaim")}</p>}
          </div>
        )}
      </section>
      {canTest && <TestsPanel projectId={summary.id} reservationId={own?.reservationId} onFailure={fail} />}
      {(canProfiles || canConfig) && (
        <ConfigurationPanel
          projectId={summary.id}
          worktreePath={own?.worktreePath ?? status?.worktreePath ?? status?.selectedWorktreePath ?? worktrees[0]?.path ?? null}
          reservationId={own?.reservationId}
          canProfiles={canProfiles}
          canConfig={canConfig}
          onFailure={fail}
        />
      )}
      {!canClaim && !canControl && !canTest && !canProfiles && !canConfig && <p className="text-sm text-muted-foreground">{t("account.readOnlyProject")}</p>}
    </div>
  );
}

function ClaimControls({ worktrees, own, busyLabel, onClaim, onRenew, onRelease }: {
  worktrees: ScopedWorktree[];
  own: ScopedProjectStatus["ownClaim"];
  busyLabel: string;
  onClaim: (worktreePath: string, reason: string, start: boolean) => void;
  onRenew: () => void;
  onRelease: () => void;
}) {
  const { t } = useI18n();
  const [worktreePath, setWorktreePath] = useState("");
  const [reason, setReason] = useState("");
  const [start, setStart] = useState(false);
  const available = worktrees.filter(tree => !tree.prunable && !tree.locked);
  const target = worktreePath || available[0]?.path || "";

  if (own) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="break-all text-sm text-muted-foreground">
          {t("account.ownClaim", { worktree: own.worktreePath, expires: own.expiresAt ? new Date(own.expiresAt).toLocaleString() : t("account.noExpiry") })}
        </span>
        <Button variant="outline" onClick={onRenew}>{t("account.renew")}</Button>
        <Button variant="outline" onClick={onRelease}>{t("account.release")}</Button>
      </div>
    );
  }
  return (
    <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (target && reason.trim()) onClaim(target, reason.trim(), start); }}>
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="account-claim-worktree">{t("account.worktree")}</Label>
        <select id="account-claim-worktree" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={target} onChange={event => setWorktreePath(event.target.value)}>
          {available.map(tree => <option key={tree.path} value={tree.path}>{tree.branch ?? tree.shortHead} · {tree.path}</option>)}
        </select>
      </div>
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="account-claim-reason">{t("account.claimReason")}</Label>
        <Input id="account-claim-reason" required maxLength={240} value={reason} onChange={event => setReason(event.target.value)} />
      </div>
      <label className="flex min-h-9 items-center gap-2 text-sm">
        <input type="checkbox" checked={start} onChange={event => setStart(event.target.checked)} />
        {t("account.claimStart")}
      </label>
      <Button type="submit" className="h-9" disabled={!target || !reason.trim()}>{busyLabel}</Button>
    </form>
  );
}

function TestsPanel({ projectId, reservationId, onFailure }: {
  projectId: string;
  reservationId: string | undefined;
  onFailure: (cause: unknown) => boolean;
}) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<ScopedTestPresets | null>(null);
  const [runs, setRuns] = useState<Map<string, ScopedTestRunEnvelope>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    testPresets(projectId, abort.signal)
      .then(result => { if (!abort.signal.aborted) setPresets(result); })
      .catch(cause => { if (!abort.signal.aborted && !onFailure(cause)) setError(describeError(t, cause)); });
    return () => abort.abort();
  }, [projectId, onFailure, t]);

  // Poll the runs this session enqueued; there is no list operation by design.
  useEffect(() => {
    const active = [...runs.values()].filter(run => run.status.phase === "queued" || run.status.phase === "running");
    if (!active.length) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      for (const run of active) {
        void testRunStatus(run.status.runId, projectId)
          .then(next => setRuns(current => new Map(current).set(next.status.runId, next)))
          .catch(() => undefined);
      }
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [projectId, runs]);

  const run = async (worktreePath: string, presetId: string) => {
    setError(null);
    try {
      const result = await enqueueTest({ projectId, worktreePath, presetId, idempotencyKey: idempotencyKey(), ...(reservationId ? { reservationId } : {}) });
      setRuns(current => new Map(current).set(result.status.runId, result));
    } catch (cause) { if (!onFailure(cause)) setError(describeError(t, cause)); }
  };
  const cancel = async (runId: string) => {
    setError(null);
    try {
      const result = await cancelTestRun(runId, projectId);
      setRuns(current => new Map(current).set(result.status.runId, result));
    } catch (cause) { if (!onFailure(cause)) setError(describeError(t, cause)); }
  };

  const entries = useMemo(() => [...runs.values()].sort((a, b) => a.status.queuedAt < b.status.queuedAt ? 1 : -1), [runs]);
  return (
    <section className="rounded-xl border border-border bg-card/30 p-5" aria-label={t("account.tests")}>
      <h2 className="text-lg font-semibold">{t("account.tests")}</h2>
      {error && <Alert variant="destructive" className="mt-3"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
      {!presets ? <p role="status" className="mt-3 text-sm text-muted-foreground">{t("knowledge.loading")}</p> : (
        <ul className="mt-3 grid gap-2">
          {presets.flatMap(group => group.presets.map(preset => ({ worktreePath: group.worktreePath, preset }))).map(({ worktreePath, preset }) => (
            <li key={`${worktreePath}:${preset.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <span className="min-w-0 flex-1 break-all"><span className="font-medium">{preset.id}</span><span className="block break-all text-xs text-muted-foreground">{worktreePath}</span></span>
              <span className="tabular-nums text-xs text-muted-foreground">{Math.round(preset.timeoutMs / 1000)} s</span>
              <Button variant="outline" size="sm" onClick={() => void run(worktreePath, preset.id)}>{t("account.runTest")}</Button>
            </li>
          ))}
          {!presets.some(group => group.presets.length) && <li className="text-sm text-muted-foreground">{t("account.noPresets")}</li>}
        </ul>
      )}
      {entries.length > 0 && (
        <ul className="mt-4 grid gap-2" aria-label={t("account.runs")}>
          {entries.map(run => (
            <li key={run.status.runId} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{run.status.presetId}</span> · {t(`testPhase.${run.status.phase}`)}
                {run.status.exitCode !== null && <span className="text-muted-foreground"> · exit {run.status.exitCode}</span>}
                <span className="block text-xs text-muted-foreground">{t(`account.attribution.${run.status.source.attribution}`)}</span>
              </span>
              {(run.status.phase === "queued" || run.status.phase === "running") && <Button variant="ghost" size="sm" onClick={() => void cancel(run.status.runId)}>{t("account.cancelRun")}</Button>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("account.runsHint")}</p>
    </section>
  );
}

function ConfigurationPanel({ projectId, worktreePath, reservationId, canProfiles, canConfig, onFailure }: {
  projectId: string;
  worktreePath: string | null;
  reservationId: string | undefined;
  canProfiles: boolean;
  canConfig: boolean;
  onFailure: (cause: unknown) => boolean;
}) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<ScopedEnvironmentProfiles | null>(null);
  const [profileName, setProfileName] = useState("");
  const [configuration, setConfiguration] = useState<ScopedProjectConfiguration | null>(null);
  const [timeouts, setTimeouts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canProfiles) return;
    const abort = new AbortController();
    runtimeConfiguration({ operation: "profiles", projectId }, abort.signal)
      .then(result => {
        if (abort.signal.aborted) return;
        const value = result as ScopedEnvironmentProfiles;
        setProfiles(value); setProfileName(value.selectedProfile);
      })
      .catch(cause => { if (!abort.signal.aborted && !onFailure(cause)) setError(describeError(t, cause)); });
    return () => abort.abort();
  }, [canProfiles, onFailure, projectId, t]);

  useEffect(() => {
    if (!canConfig || !worktreePath) return;
    const abort = new AbortController();
    runtimeConfiguration({ operation: "configuration", projectId, worktreePath }, abort.signal)
      .then(result => {
        if (abort.signal.aborted) return;
        const value = result as ScopedProjectConfiguration;
        setConfiguration(value);
        setTimeouts(Object.fromEntries(value.presets.map(preset => [preset.id, preset.overrideTimeoutMs === null ? "" : String(preset.overrideTimeoutMs)])));
      })
      .catch(cause => { if (!abort.signal.aborted && !onFailure(cause)) setError(describeError(t, cause)); });
    return () => abort.abort();
  }, [canConfig, onFailure, projectId, t, worktreePath]);

  const saveProfile = async () => {
    if (!profiles || !profileName) return;
    setError(null); setNotice(null);
    try {
      await runtimeConfiguration({
        operation: "select_environment_profile", projectId, name: profileName, expectedRevision: profiles.configurationRevision,
        idempotencyKey: idempotencyKey(), ...(reservationId ? { reservationId } : {}),
      });
      setNotice(t("account.profileSaved"));
      const fresh = await runtimeConfiguration({ operation: "profiles", projectId }) as ScopedEnvironmentProfiles;
      setProfiles(fresh); setProfileName(fresh.selectedProfile);
    } catch (cause) { if (!onFailure(cause)) setError(describeError(t, cause)); }
  };

  const saveTimeout = async (presetId: string) => {
    if (!configuration || !worktreePath) return;
    setError(null); setNotice(null);
    const raw = timeouts[presetId]?.trim() ?? "";
    const timeoutMs = raw === "" ? null : Number(raw);
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) { setError(t("account.invalidTimeout")); return; }
    try {
      await runtimeConfiguration({
        operation: "set_test_preset_timeout", projectId, worktreePath, presetId, timeoutMs, expectedRevision: configuration.configurationRevision,
        idempotencyKey: idempotencyKey(), ...(reservationId ? { reservationId } : {}),
      });
      setNotice(t("account.timeoutSaved"));
      const fresh = await runtimeConfiguration({ operation: "configuration", projectId, worktreePath }) as ScopedProjectConfiguration;
      setConfiguration(fresh);
      setTimeouts(Object.fromEntries(fresh.presets.map(preset => [preset.id, preset.overrideTimeoutMs === null ? "" : String(preset.overrideTimeoutMs)])));
    } catch (cause) { if (!onFailure(cause)) setError(describeError(t, cause)); }
  };

  return (
    <section className="rounded-xl border border-border bg-card/30 p-5" aria-label={t("account.configuration")}>
      <h2 className="text-lg font-semibold">{t("account.configuration")}</h2>
      {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
      {error && <Alert variant="destructive" className="mt-3"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
      {canProfiles && profiles && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-56 space-y-1.5">
            <Label htmlFor="account-profile">{t("account.profile")}</Label>
            <select id="account-profile" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={profileName} onChange={event => setProfileName(event.target.value)}>
              {profiles.profiles.map(profile => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
            </select>
          </div>
          <Button variant="outline" className="h-9" disabled={!profileName || profileName === profiles.selectedProfile} onClick={() => void saveProfile()}>{t("account.selectProfile")}</Button>
        </div>
      )}
      {canConfig && !worktreePath && <p className="mt-3 text-sm text-muted-foreground">{t("account.noWorktree")}</p>}
      {canConfig && configuration && (
        <ul className="mt-4 grid gap-2">
          {configuration.presets.map(preset => (
            <li key={preset.id} className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3 text-sm">
              <span className="min-w-0 flex-1 break-all">
                <span className="font-medium">{preset.id}</span>
                <span className="block text-xs text-muted-foreground">{t("account.timeoutDefault", { seconds: Math.round(preset.timeoutMs / 1000) })}</span>
              </span>
              <div className="w-40 space-y-1.5">
                <Label htmlFor={`account-timeout-${preset.id}`}>{t("account.timeoutMs")}</Label>
                <Input id={`account-timeout-${preset.id}`} inputMode="numeric" value={timeouts[preset.id] ?? ""} placeholder={String(preset.timeoutMs)} onChange={event => setTimeouts(current => ({ ...current, [preset.id]: event.target.value }))} />
              </div>
              <Button variant="outline" size="sm" onClick={() => void saveTimeout(preset.id)}>{t("common.save")}</Button>
            </li>
          ))}
          {!configuration.presets.length && <li className="text-sm text-muted-foreground">{t("account.noPresets")}</li>}
        </ul>
      )}
    </section>
  );
}
