"use client";

import { useId, useRef, useState } from "react";
import { ExternalLink, Info, LoaderCircle, LockKeyhole, MoreHorizontal, Play, RefreshCw, RotateCcw, ScrollText, Square, UnlockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Metric } from "@/components/metric";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot, Worktree } from "@/shared/contracts";

export interface WorktreeRowActionsProps {
  snapshot: ProjectSnapshot;
  worktree: Worktree;
  busy: boolean;
  pendingPath: string | null;
  onOperate: (operation: "start" | "stop" | "restart" | "switch", path: string) => void;
  onReserve: (action: "acquire" | "release" | "force-release", path: string) => void;
  onOpenLogs: () => void;
  details?: { size: string; measuredAt: string | null; lastLaunch: string; lastCommit: string; mergeUnknown: boolean };
}

export function WorktreeRowActions({ snapshot, worktree, busy, pendingPath, onOperate, onReserve, onOpenLogs, details }: WorktreeRowActionsProps) {
  const { t, locale } = useI18n();
  const [dialog, setDialog] = useState<"switch" | "details" | "release" | null>(null);
  const targetDescriptionId = useId();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const dialogOrigin = useRef<HTMLButtonElement | null>(null);
  const { project, runtime, reservation } = snapshot;
  const branch = worktree.branch ?? "detached HEAD";
  const located = runtime.worktreePath === worktree.path;
  const running = runtime.phase === "running";
  const transitioning = runtime.phase === "starting" || runtime.phase === "stopping";
  const progress = transitioning ? located : busy && pendingPath === worktree.path;
  const blocked = busy || !!reservation || worktree.prunable;
  const pinned = reservation?.worktreePath === worktree.path;
  const from = snapshot.worktrees.find((w) => w.path === runtime.worktreePath)?.branch ?? runtime.worktreePath ?? "—";
  const openServer = () => {
    // Build a fresh origin: dashboard pairing query parameters must never be forwarded.
    const url = new URL(window.location.origin);
    url.protocol = project.tlsMode === "off" ? "http:" : "https:";
    url.port = String(project.port);
    window.open(url.href, "_blank", "noopener,noreferrer");
  };
  const restoreDialogFocus = (event: Event) => {
    event.preventDefault();
    const origin = dialogOrigin.current;
    const fallback = menuTrigger.current;
    const target = origin?.isConnected && !origin.disabled ? origin
      : fallback?.isConnected && !fallback.disabled ? fallback
        : document.querySelector<HTMLInputElement>('[data-worktree-overview] input[type="search"]');
    target?.focus();
  };

  return <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-start">
    <Button size="sm" variant="outline" aria-describedby={targetDescriptionId} disabled={progress || (running && located ? busy : blocked)} title={reservation ? t("row.reserved") : undefined}
      onClick={(event) => {
        if (running && located) openServer();
        else if (running) { dialogOrigin.current = event.currentTarget; setDialog("switch"); }
        else onOperate("start", worktree.path);
      }}>
      {progress ? <><LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />{t("row.progress")}</>
        : running && located ? <><ExternalLink aria-hidden />{t("row.open")}</>
          : running ? <><RefreshCw aria-hidden />{t("row.switch")}</>
            : <><Play aria-hidden />{t("row.start")}</>}
    </Button>
    <span id={targetDescriptionId} className="sr-only">{t("worktreeLayout.actionTarget", { project: project.name, branch })}</span>
    {located && runtime.phase === "failed" ? <Button size="sm" variant="outline" aria-label={t("worktreeLayout.failedLogsFor", { project: project.name, branch })} onClick={onOpenLogs}><ScrollText aria-hidden />{t("worktreeLayout.failedLogs")}</Button> : null}
    {reservation && !(running && located) ? <span className="text-xs text-muted-foreground">{t("row.reserved")}</span> : null}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button ref={menuTrigger} variant="ghost" size="icon-sm" aria-label={t("worktreeLayout.moreForProject", { branch, project: project.name })}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => { dialogOrigin.current = menuTrigger.current; setDialog("details"); }}><Info aria-hidden />{t("row.details")}</DropdownMenuItem>
        {running && located ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={blocked} onSelect={() => onOperate("restart", worktree.path)}><RotateCcw aria-hidden />{t("row.restart")}</DropdownMenuItem>
          <DropdownMenuItem disabled={blocked} onSelect={() => onOperate("stop", worktree.path)}><Square aria-hidden />{t("row.stop")}</DropdownMenuItem>
        </> : null}
        <DropdownMenuSeparator />
        {pinned ? <DropdownMenuItem disabled={busy} onSelect={() => { if (reservation.kind === "agent") { dialogOrigin.current = menuTrigger.current; setDialog("release"); } else onReserve("release", worktree.path); }}><UnlockKeyhole aria-hidden />{t(reservation.kind === "agent" ? "project.forceRelease" : "project.release")}</DropdownMenuItem>
          : <DropdownMenuItem disabled={blocked} onSelect={() => onReserve("acquire", worktree.path)}><LockKeyhole aria-hidden />{t("project.reserve")}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={dialog === "switch" || dialog === "release"} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <AlertDialogContent onCloseAutoFocus={restoreDialogFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{dialog === "release" ? t("project.forceRelease") : t("row.switchTitle", { branch })}</AlertDialogTitle>
          <AlertDialogDescription className="break-all">{dialog === "release" ? t("project.forceReleaseConfirm") : t("row.switchDescription", { from, to: branch, port: project.port })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction disabled={dialog === "release" ? busy || !pinned : blocked || !running || located}
            onClick={() => dialog === "release" ? onReserve("force-release", worktree.path) : onOperate("switch", worktree.path)}>{t(dialog === "release" ? "project.forceRelease" : "row.switch")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={dialog === "details"} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onCloseAutoFocus={restoreDialogFocus}>
        <DialogHeader><DialogTitle className="break-all">{branch}</DialogTitle><DialogDescription>{t("row.detailsDescription")}</DialogDescription></DialogHeader>
        <p className="break-all text-xs text-muted-foreground">{t("worktreeLayout.path")}: <span className="font-mono">{worktree.path}</span></p>
        <p className="break-all text-xs text-muted-foreground">{t("worktreeLayout.fullCommit")}: <span className="font-mono">{worktree.head}</span></p>
        <dl className="grid min-w-0 grid-cols-2 gap-4 text-sm">
          <Metric label={t("project.commit")} value={worktree.shortHead} mono />
          <Metric label={t("project.runtimeState")} value={located ? t(`phase.${runtime.phase}`) : t("phase.stopped")} />
          <Metric label={t("project.port")} value={String(project.port)} />
          <Metric label={t("project.protocol")} value={project.tlsMode === "off" ? "HTTP" : "HTTPS"} />
          <Metric label={t("project.preset")} value={t(`preset.${project.launchPreset}`)} />
          <Metric label="PID" value={located && runtime.pid ? String(runtime.pid) : "—"} />
          <Metric label={t("project.started")} value={located && runtime.startedAt ? new Date(runtime.startedAt).toLocaleString(locale) : "—"} />
          {details ? <>
            <Metric label={t("overview.disk")} value={details.size} />
            <Metric label={t("overview.lastLaunch")} value={details.lastLaunch} />
            <Metric label={t("overview.lastCommit")} value={details.lastCommit} />
          </> : null}
        </dl>
        {details?.measuredAt ? <p className="text-xs text-muted-foreground">{t("worktreeLayout.measuredAt", { time: details.measuredAt })}</p> : null}
        {details?.mergeUnknown ? <p className="text-xs text-muted-foreground">{t("overview.mergeUnknown")}</p> : null}
        <p className="break-all font-mono text-xs">{project.executable} {project.args.join(" ")}</p>
      </DialogContent>
    </Dialog>
  </div>;
}
