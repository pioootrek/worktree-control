"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Mutate } from "@/features/control-client";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import type { WebExportStatus } from "@/shared/contracts/godot-web";
import { AlertTriangle, CheckCircle2, CircleDashed, ExternalLink, Eye, EyeOff, LoaderCircle, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";

function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB"];
  const unit = value > 0 ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

const STATE_ICON: Record<WebExportStatus["state"], typeof CheckCircle2> = {
  stopped: CircleDashed, idle: CircleDashed, queued: LoaderCircle, building: LoaderCircle, ready: CheckCircle2, failed: XCircle,
};

/** Status and actions of the managed Godot Web export for one project. */
export function WebExportPanel({ snapshot, mutate, setError }: { snapshot: ProjectSnapshot; mutate: Mutate; setError: (message: string | null) => void }) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState(false);
  const { project, runtime } = snapshot;
  const status = snapshot.webExport ?? null;
  const running = runtime.phase === "running";
  const state = running ? status?.state ?? "idle" : "stopped";
  const Icon = STATE_ICON[state];
  const time = (value: string) => new Date(value).toLocaleString(locale === "pl" ? "pl-PL" : "en-US");
  const previewUrl = typeof window === "undefined" ? null : `${window.location.protocol === "https:" ? "http:" : window.location.protocol}//${window.location.hostname}:${project.port}/`;

  const rebuild = async () => {
    setPending(true);
    try { await mutate(`/api/projects/${project.id}/godot-web/rebuild`, {}, t("webExport.rebuildRequested", { name: project.name })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };

  return <section data-web-export className="mb-4 space-y-3 rounded-md border border-border bg-background/35 px-4 py-3" aria-labelledby={`web-export-${project.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id={`web-export-${project.id}`} className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{t("webExport.title")}</h3>
        <Badge variant={state === "failed" ? "destructive" : state === "ready" ? "secondary" : "outline"} role="status" aria-live="polite">
          <Icon className={state === "queued" || state === "building" ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden />
          {t(`webExport.state.${state}`)}
        </Badge>
        {running && status ? <Badge variant="outline" className="text-muted-foreground">
          {status.watcher === "watching" ? <Eye aria-hidden /> : <EyeOff aria-hidden />}{t(`webExport.watcher.${status.watcher}`)}
        </Badge> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {running && previewUrl ? <Button asChild variant="outline" size="sm">
          <a href={previewUrl} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden />{t("webExport.open")}</a>
        </Button> : null}
        <Button size="sm" variant="secondary" onClick={() => void rebuild()} disabled={!running || pending} aria-describedby={!running ? `web-export-reason-${project.id}` : undefined}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}{t("webExport.rebuild")}
        </Button>
      </div>
    </div>
    <div className="space-y-1 text-sm">
      {status?.current
        ? <p>{t("webExport.generation", { time: time(status.current.publishedAt), files: status.current.files, size: bytes(status.current.bytes) })}</p>
        : <p className="text-muted-foreground">{t("webExport.noGeneration")}</p>}
      {status?.current?.dirty ? <p className="text-xs text-warning-foreground">{t("webExport.dirtyGeneration")}</p> : null}
      {running && status?.currentStale ? <p className="text-xs text-muted-foreground">{t("webExport.stale")}</p> : null}
      {running && status?.pendingRebuild ? <p className="text-xs text-muted-foreground">{t("webExport.pending")}</p> : null}
      {!running ? <p id={`web-export-reason-${project.id}`} className="text-xs text-muted-foreground">{t("project.noActiveServer")}</p> : null}
      <p className="text-xs text-muted-foreground">{t("webExport.notHmr")}</p>
    </div>
    {status?.lastFailure ? <Alert variant="destructive" className="py-2">
      <AlertTriangle aria-hidden />
      <AlertTitle>{t(`webExport.failure.${status.lastFailure.code}`)}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p className="break-words">{status.lastFailure.message}</p>
        {status.current ? <p>{t("webExport.keptPrevious")}</p> : null}
        {status.lastFailure.runId ? <p className="font-mono text-xs">{t("webExport.run", { id: status.lastFailure.runId })}</p> : null}
      </AlertDescription>
    </Alert> : null}
  </section>;
}
