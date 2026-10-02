"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { userScheduleCommandSchema, type UserSchedule, type UserScheduleCommand, type UserScheduleInput, type UserScheduleOverview } from "@/shared/contracts/user-backups";

const storageKey = "worktree-switcher-user-schedule-request";
function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
class RequestError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
async function request<T>(token: string, input?: UserScheduleCommand): Promise<T> {
  const response = await fetch("/api/user-backups", { method: input ? "POST" : "GET", cache: "no-store", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const body = await response.json(); if (!response.ok) throw new RequestError(body.code, response.status); return body as T;
}
const configuration = (schedule: UserSchedule): UserScheduleInput => ({ projectId: schedule.projectId, scope: schedule.scope, targetId: schedule.targetId, enabled: schedule.enabled, intervalSeconds: schedule.intervalSeconds, retainCount: schedule.retainCount, retainDays: schedule.retainDays });

export function UserSchedulesDialog({ token, onOpenChange, returnFocus }: { token: string; onOpenChange: (open: boolean) => void; returnFocus: () => void }) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<UserScheduleOverview | null>(null);
  const [draft, setDraft] = useState<{ id: string; version: number; configuration: UserScheduleInput } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<Extract<UserScheduleCommand, { action: "save" }> | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const saved = useRef<Extract<UserScheduleCommand, { action: "save" }> | null>(null);
  const report = useCallback((cause: unknown) => {
    const code = cause instanceof RequestError ? cause.code : "disconnected";
    const keys = { forbidden: "userBackups.reason.forbidden", policy: "userBackups.reason.policy", limit: "userBackups.reason.limit", busy: "userBackups.reason.busy", changed: "userBackups.reason.changed", invalid: "userBackups.invalid" } as const;
    setError(t(keys[code as keyof typeof keys] ?? (code === "disconnected" ? "backups.disconnected" : "backups.failed")));
  }, [t]);
  const refresh = useCallback(async () => {
    try {
      const data = await request<UserScheduleOverview>(token);
      if (!alive.current) return;
      setOverview(data); setError(null);
      const input = saved.current;
      if (input) {
        // Missing or inaccessible one-request status cannot discard the available panel.
        try { await request(token, { action: "status", idempotencyKey: input.idempotencyKey }); }
        catch (cause) { if (alive.current) report(cause); }
      }
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof RequestError && cause.status === 403) { setOverview(null); setDraft(null); setRetry(null); }
      report(cause);
    }
  }, [token, report]);
  useEffect(() => {
    alive.current = true;
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      const parsed = stored?.credential === token.slice(0, 40) ? userScheduleCommandSchema.safeParse(stored.input) : null;
      saved.current = parsed?.success && parsed.data.action === "save" ? parsed.data : null;
      setRetry(saved.current);
    } catch { saved.current = null; }
    void refresh(); return () => { alive.current = false; };
  }, [token, refresh]);
  const save = async (input: Extract<UserScheduleCommand, { action: "save" }>) => {
    if (busy.current) return; busy.current = true; setPending(true); setError(null);
    try {
      const parsed = userScheduleCommandSchema.safeParse(input); if (!parsed.success) throw new RequestError("invalid", 400);
      saved.current = input; setRetry(input);
      sessionStorage.setItem(storageKey, JSON.stringify({ credential: token.slice(0, 40), input }));
      await request(token, input);
      if (alive.current) { setDraft(null); await refresh(); }
    } catch (cause) { if (alive.current) report(cause); }
    finally { busy.current = false; if (alive.current) setPending(false); }
  };
  const download = async (executionId: string) => {
    try {
      const data = await request(token, { action: "artifact", executionId });
      if (!alive.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `user-export-${executionId}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (cause) { if (alive.current) report(cause); }
  };
  const edit = (schedule: UserSchedule) => setDraft({ id: schedule.id, version: schedule.version, configuration: configuration(schedule) });
  const startDraft = () => {
    if (!overview?.projects[0] || !overview.targets[0]) return;
    setDraft({ id: uuid(), version: 0, configuration: { projectId: overview.projects[0].id, targetId: overview.targets[0], scope: "knowledge-discussions", enabled: true, intervalSeconds: overview.policy.minIntervalSeconds, retainCount: overview.policy.retainCount, retainDays: overview.policy.retainDays } });
  };
  const update = (patch: Partial<UserScheduleInput>) => setDraft(value => value ? { ...value, configuration: { ...value.configuration, ...patch } } : null);
  const date = (value: string | null) => value ? new Date(value).toLocaleString(locale) : t("backups.unknown");
  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent closeLabel={t("common.close")} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader><DialogTitle>{t("userBackups.title")}</DialogTitle><DialogDescription>{t("userBackups.description")}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending} onClick={() => void refresh()}>{t("backups.refresh")}</Button>
        {overview?.policy.enabled && <Button disabled={pending || overview.maintenance || !overview.projects.length || !overview.targets.length} onClick={startDraft}>{t("userBackups.create")}</Button>}
        {retry && <Button variant="outline" disabled={pending} onClick={() => void save(retry)}>{t("backups.retry")}</Button>}
      </div>
      {overview && <>
        <p className="text-xs text-muted-foreground">{t("userBackups.policy", { interval: overview.policy.minIntervalSeconds, count: overview.policy.maxSchedules, bytes: overview.policy.maxBytes, seconds: overview.policy.timeoutSeconds, queue: overview.policy.queueLimit })}</p>
        {!overview.policy.enabled && <p role="status">{t("userBackups.reason.disabled")}</p>}
        {overview.maintenance && <p role="status">{t("userBackups.reason.busy")}</p>}
        {overview.policy.enabled && !overview.projects.length && <p role="status">{t("userBackups.reason.forbidden")}</p>}
        {draft && <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void save({ action: "save", ...draft, idempotencyKey: uuid() }); }}>
          <label className="grid gap-1 text-sm">{t("userBackups.project")}<select className="min-w-0 rounded border bg-background p-2" value={draft.configuration.projectId} onChange={event => update({ projectId: event.target.value })}>{overview.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="grid gap-1 text-sm">{t("userBackups.target")}<select className="min-w-0 rounded border bg-background p-2" value={draft.configuration.targetId} onChange={event => update({ targetId: event.target.value })}>{overview.targets.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
          <label className="grid gap-1 text-sm">{t("userBackups.interval")}<input type="number" required min={overview.policy.minIntervalSeconds} max={30 * 86400} className="min-w-0 rounded border bg-background p-2" value={draft.configuration.intervalSeconds} onChange={event => update({ intervalSeconds: Number(event.target.value) })} /></label>
          <label className="grid gap-1 text-sm">{t("userBackups.count")}<input type="number" required min={1} max={overview.policy.retainCount} className="min-w-0 rounded border bg-background p-2" value={draft.configuration.retainCount} onChange={event => update({ retainCount: Number(event.target.value) })} /></label>
          <label className="grid gap-1 text-sm">{t("userBackups.days")}<input type="number" required min={1} max={overview.policy.retainDays} className="min-w-0 rounded border bg-background p-2" value={draft.configuration.retainDays} onChange={event => update({ retainDays: Number(event.target.value) })} /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.configuration.enabled} onChange={event => update({ enabled: event.target.checked })} />{t("userBackups.enabled")}</label>
          <div className="flex flex-wrap gap-2 sm:col-span-2"><Button type="submit" disabled={pending || overview.maintenance}>{t("userBackups.save")}</Button><Button type="button" variant="outline" onClick={() => setDraft(null)}>{t("common.cancel")}</Button></div>
        </form>}
        <ul className="divide-y divide-border" aria-label={t("userBackups.title")}>{overview.schedules.map(schedule => <li key={schedule.id} className="space-y-2 py-3 text-sm">
          <p className="break-words font-medium">{overview.projects.find(value => value.id === schedule.projectId)?.name ?? schedule.projectId} / {schedule.targetId}</p>
          <p>{t("backups.every", { seconds: schedule.intervalSeconds })} · {schedule.retainCount} / {schedule.retainDays} {t("backups.days")}</p>
          <p>{t("backups.next")}: {date(schedule.nextAt)}</p>
          <p>{t("backups.last")}: {schedule.lastResult ? t(schedule.lastResult.state === "denied" ? "userBackups.denied" : `backups.state.${schedule.lastResult.state}`) : t("backups.unknown")}</p>
          {schedule.reason && <p>{t(`userBackups.reason.${schedule.reason}`)}</p>}
          {schedule.lastResult?.reason && <p>{t(`userBackups.reason.${schedule.lastResult.reason}`)}</p>}
          <p>{t("backups.retentionState")}: {t(`backups.retention.${schedule.retention}`)}</p>
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={pending || overview.maintenance} onClick={() => edit(schedule)}>{t("userBackups.edit")}</Button><Button variant="outline" disabled={pending || overview.maintenance} onClick={() => void save({ action: "save", id: schedule.id, version: schedule.version, configuration: { ...configuration(schedule), enabled: !schedule.enabled }, idempotencyKey: uuid() })}>{t(schedule.enabled ? "userBackups.disable" : "userBackups.enable")}</Button></div>
        </li>)}</ul>
        {overview.artifacts.filter(value => value.artifactAvailable).map(value => <div key={value.executionId} className="flex flex-wrap items-center gap-2 text-sm"><span className="min-w-0 break-all">{date(value.dueAt)} · {value.executionId}</span><Button variant="outline" onClick={() => void download(value.executionId)}>{t("userBackups.download")}</Button></div>)}
      </>}
    </DialogContent>
  </Dialog>;
}
