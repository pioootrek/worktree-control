"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import type { BackupCommand, BackupOperation, BackupOverview, RestoreOperation, RestorePreview } from "@/shared/contracts/backups";
import { backupCommandSchema } from "@/shared/contracts/backups";
import { BackupClientError, backupRequest } from "./backup-client";

const STORAGE_KEY = "worktree-switcher-backup-request";
// The local dashboard also supports HTTP, where randomUUID is unavailable.
const requestKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
/** Explicit refresh uses no additional polling or dashboard event subscription. */
export function BackupsDialog({ token, open, onOpenChange, returnFocus }: { token: string; open: boolean; onOpenChange: (open: boolean) => void; returnFocus: () => void }) {
  const { t, locale } = useI18n();
  const [overview, setOverview] = useState<BackupOverview | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [operation, setOperation] = useState<BackupOperation | RestoreOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const saved = useRef<BackupCommand | null>(null);
  const [retry, setRetry] = useState<BackupCommand | null>(null);
  const focusPreview = useCallback((node: HTMLElement | null) => { node?.focus(); }, []);
  const fail = useCallback((cause: unknown) => {
    const code = cause instanceof BackupClientError ? (cause.status === 403 ? "backup_forbidden" : cause.code) : "disconnected";
    if (code === "backup_forbidden") { setOverview(null); setPreview(null); setOperation(null); setRetry(null); }
    setError(t(code === "backup_forbidden" ? "backups.forbidden" : code === "backup_busy" ? "backups.busy" : code === "disconnected" ? "backups.disconnected" : "backups.failed"));
  }, [t]);
  const load = useCallback(async () => {
    const data = await backupRequest<BackupOverview>(token);
    const input = saved.current;
    let status: BackupOperation | RestoreOperation | null = null;
    let statusError: BackupClientError | null = null;
    if (input && (input.action === "create" || input.action === "restore")) {
      try {
        status = await backupRequest<BackupOperation | RestoreOperation>(token, { action: "status", idempotencyKey: input.idempotencyKey, ...(input.action === "restore" ? { backupId: input.backupId } : {}) });
      } catch (cause) {
        // A pre-admission failure has no receipt. Keep the authorized catalog
        // and original command available for an explicit retry, without success.
        if (!(cause instanceof BackupClientError) || cause.status !== 404 || cause.code !== "backup_invalid") throw cause;
        statusError = cause;
      }
    }
    return { data, status, input, statusError };
  }, [token]);
  const apply = useCallback((result: Awaited<ReturnType<typeof load>>) => {
    setOverview(result.data); setOperation(result.status); setRetry(result.input); setError(null);
    if (result.statusError) fail(result.statusError);
  }, [fail]);
  const refresh = useCallback(async () => {
    const current = generation.current;
    try { const result = await load(); if (generation.current === current) apply(result); }
    catch (cause) { if (generation.current === current) fail(cause); }
  }, [load, apply, fail]);
  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    try {
      const value = window.sessionStorage.getItem(STORAGE_KEY);
      const stored = value ? JSON.parse(value) : null;
      const parsed = stored?.credential === token.slice(0, 40) ? backupCommandSchema.safeParse(stored.input) : null;
      saved.current = parsed?.success ? parsed.data : null;
    } catch { saved.current = null; }
    let disposed = false;
    void load().then(result => { if (!disposed && generation.current === current) apply(result); }, cause => { if (!disposed && generation.current === current) fail(cause); });
    return () => { disposed = true; };
  }, [open, token, load, apply, fail]);
  const submit = async (input: BackupCommand, retain = false) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    const current = generation.current;
    try {
      if (retain) { saved.current = input; setRetry(input); window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ credential: token.slice(0, 40), input })); }
      if (input.action === "preview") {
        const data = await backupRequest<RestorePreview>(token, input);
        if (generation.current === current) { setPreview(data); setConfirmed(false); }
      } else {
        const data = await backupRequest<BackupOperation | RestoreOperation>(token, input);
        if (generation.current === current) { setOperation(data); setPreview(null); }
        if (input.action === "create") await refresh();
      }
    } catch (cause) { if (generation.current === current) fail(cause); }
    finally { busy.current = false; setPending(false); }
  };
  const date = (value: string | null) => value ? new Date(value).toLocaleString(locale) : t("backups.unknown");
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent closeLabel={t("common.close")} className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader><DialogTitle>{t("backups.title")}</DialogTitle><DialogDescription>{t("backups.description")}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      {operation && <p role="status" className="break-words text-sm">{t("backups.operation")} <span className="font-mono">{operation.operationId}</span>: {t(`backups.state.${operation.state}`)}</p>}
      {preview ? <section ref={focusPreview} tabIndex={-1} className="space-y-4 outline-none" aria-label={t("backups.preview")}>
        <p className="break-all font-mono text-sm">{preview.backup.id}</p>
        <p className="text-sm">{t("backups.dataDate")}: {date(preview.backup.createdAt)}</p>
        <p className="text-sm">{t("backups.restoreScope")}</p>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 size-4 shrink-0 accent-primary" />{t("backups.confirmLoss")}</label>
        <DialogFooter><Button variant="outline" onClick={() => setPreview(null)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={!confirmed || pending} onClick={() => void submit({ action: "restore", backupId: preview.backup.id, idempotencyKey: requestKey(), confirmation: "replace-entire-installation" }, true)}>{t("backups.confirmRestore")}</Button></DialogFooter>
      </section> : <>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void refresh()} disabled={pending}>{t("backups.refresh")}</Button>
          {overview?.policy.uiActions.includes("create") && <Button disabled={pending || overview.maintenance} onClick={() => void submit({ action: "create", idempotencyKey: requestKey() }, true)}>{t("backups.create")}</Button>}
          {retry && (retry.action === "create" || retry.action === "restore") && <Button variant="outline" disabled={pending} onClick={() => void submit(retry, true)}>{t("backups.retry")}</Button>}
        </div>
        {overview && <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt>{t("backups.schedule")}</dt><dd>{overview.policy.intervalSeconds === null ? t("backups.disabled") : t("backups.every", { seconds: overview.policy.intervalSeconds })}</dd>
            <dt>{t("backups.next")}</dt><dd>{date(overview.schedule.nextAt)}</dd>
            <dt>{t("backups.retention")}</dt><dd>{overview.policy.retainCount} / {overview.policy.retainDays} {t("backups.days")}</dd>
            <dt>{t("backups.budget")}</dt><dd>{overview.policy.maxBytes.toLocaleString(locale)} B</dd>
            <dt>{t("backups.limits")}</dt><dd>{overview.policy.timeoutSeconds}s / {overview.policy.queueLimit}</dd>
            <dt>{t("backups.last")}</dt><dd>{overview.schedule.lastOperation ? t(`backups.state.${overview.schedule.lastOperation.state}`) : t("backups.unknown")}</dd>
            {overview.schedule.error && <><dt>{t("backups.schedule")}</dt><dd role="alert">{t("backups.failed")}</dd></>}
            <dt>{t("backups.retentionState")}</dt><dd>{t(`backups.retention.${overview.schedule.retention}`)}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">{t("backups.policyReadOnly")}</p>
          {overview.copies.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{t("backups.empty")}</p> : <ul className="divide-y divide-border" aria-label={t("backups.copies")}>
            {overview.copies.map(copy => <li key={copy.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 space-y-1 text-sm"><p className="break-all font-mono">{copy.id}</p><p>{t("backups.dataDate")}: {date(copy.createdAt)}</p><p className="text-muted-foreground">{copy.sizeBytes === null ? t("backups.unknown") : `${copy.sizeBytes.toLocaleString(locale)} B`} · {t(`backups.compatibility.${copy.compatibility}`)} · {t(`backups.verification.${copy.verification}`)}{copy.protected ? ` · ${t("backups.protected")}` : ""}</p></div>
              {overview.policy.uiActions.includes("restore") && <Button variant="outline" disabled={pending || overview.maintenance || copy.compatibility !== "supported"} onClick={() => void submit({ action: "preview", backupId: copy.id })} aria-label={`${t("backups.restore")} ${copy.id}`}>{t("backups.restore")}</Button>}
            </li>)}
          </ul>}
        </>}
      </>}
    </DialogContent>
  </Dialog>;
}
