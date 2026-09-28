"use client";

import { Metric } from "@/components/metric";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectSection } from "@/features/dashboard/project-navigation";
import type { Mutate } from "@/features/control-client";
import { EnvironmentSettingsDialog } from "@/features/environments/environment-settings-dialog";
import { localizedFailure } from "@/features/runtime/localized-failure";
import { RuntimeBadge } from "@/features/runtime/runtime-badge";
import { TlsSettingsDialog } from "@/features/runtime/tls-settings-dialog";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { AlertTriangle, GitBranch, LockKeyhole, Play, RefreshCw, RotateCcw, Server, Square, Trash2, UnlockKeyhole } from "lucide-react";
import { useState } from "react";
import { WorktreeOverview } from "./worktree-overview";

export function ProjectCard({
  snapshot,
  section,
  mutate,
  setError,
  token,
}: {
  snapshot: ProjectSnapshot;
  section: ProjectSection;
  mutate: Mutate;
  setError: (message: string | null) => void;
  token: string;
}) {
  const { locale, t } = useI18n();
  const { project, runtime, reservation, worktrees } = snapshot;
  const initial = project.selectedWorktreePath ?? worktrees[0]?.path ?? "";
  const [selected, setSelected] = useState(initial);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const selectedWorktree = worktrees.find((worktree) => worktree.path === selected);
  const isBusy = runtime.phase === "starting" || runtime.phase === "stopping" || pending !== null;
  const failureCopy = runtime.failure ? localizedFailure(project, runtime.failure, t) : null;
  const metadata = snapshot.metadata;
  const hasActiveRuntime = runtime.phase === "running" || runtime.phase === "starting" || runtime.phase === "stopping";

  const refreshMetadata = async () => {
    setPending("metadata");
    try {
      await mutate(
        `/api/projects/${project.id}/metadata/refresh`,
        {},
        t("metadata.refreshed", { name: project.name }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const act = async (operation: "start" | "stop" | "restart" | "switch", worktreePath = selected) => {
    setPendingPath(worktreePath);
    setPending(operation);
    try {
      await mutate(
        `/api/projects/${project.id}/operation`,
        { operation, worktreePath: worktreePath || undefined },
        t("project.operationDone", { name: project.name, operation: t(`operation.${operation}`) }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
      setPendingPath(null);
    }
  };

  const reserve = async (action: "acquire" | "release" | "force-release", worktreePath = selected) => {
    setPending(action);
    try {
      await mutate(
        `/api/projects/${project.id}/reservation`,
        { action, worktreePath: worktreePath || undefined },
        action === "acquire"
          ? t("project.reserved", { name: project.name })
          : t("project.released", { name: project.name }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const removeProject = async () => {
    setPending("remove");
    try {
      await mutate(
        `/api/projects/${project.id}`,
        {},
        t("project.removed", { name: project.name }),
        "DELETE",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const projectHeaderActions = <>
    <EnvironmentSettingsDialog project={project} phase={runtime.phase} mutate={mutate} setError={setError} />
    {project.launchPreset !== "django" && <TlsSettingsDialog project={project} phase={runtime.phase} token={token} mutate={mutate} setError={setError} />}
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" disabled={isBusy} aria-label={t("project.remove")}><Trash2 aria-hidden /></Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("project.removeTitle", { name: project.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("project.removeDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => void removeProject()}>{t("project.confirmRemove")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;

  return (
    <Card data-project-id={project.id} className="min-w-0 overflow-hidden rounded-lg border-border bg-card/70 py-0 shadow-none backdrop-blur-sm">
      <CardHeader className={`border-b border-border px-5 sm:px-6 ${section === "worktrees" ? "py-3" : "py-5"}`}>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-full">
            <CardTitle className={`flex items-center gap-2 break-all font-semibold tracking-tight ${section === "worktrees" ? "text-lg" : "text-xl sm:text-2xl"}`}>
              <Server className="size-5 shrink-0 text-primary" aria-hidden />
              {project.name}
            </CardTitle>
            {section !== "worktrees" ? <CardDescription className="mt-1 truncate font-mono text-xs" title={project.repositoryPath}>
              {project.repositoryPath}
            </CardDescription> : null}
          </div>
          {section === "worktrees" ? <details className="w-full text-xs text-muted-foreground sm:w-auto sm:shrink-0">
            <summary className="w-fit cursor-pointer">{t("worktreeLayout.projectSettings")}</summary>
            <p className="mt-2 break-all font-mono">{t("worktreeLayout.projectPath")}: {project.repositoryPath}</p>
            <div className="mt-2 flex items-center gap-2">{projectHeaderActions}</div>
          </details> : <div className="flex shrink-0 items-center gap-2">{projectHeaderActions}</div>}
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {metadata?.status === "stale" && !metadata.error && !snapshot.discoveryError && metadata.lastSuccessfulAt ? (
          null
        ) : metadata && metadata.status !== "fresh" && (
          <Alert variant="warning" className="mx-5 mt-5 sm:mx-6">
            <AlertTriangle aria-hidden />
            <AlertTitle>{t(`metadata.${metadata.status}`)}</AlertTitle>
            <AlertDescription>
              {metadata.lastSuccessfulAt
                ? t("metadata.lastSuccess", { time: new Date(metadata.lastSuccessfulAt).toLocaleString(locale === "pl" ? "pl-PL" : "en-US") })
                : t("metadata.noSuccess")}
            </AlertDescription>
          </Alert>
        )}
        {snapshot.discoveryError && (
          <Alert variant="destructive" className="mx-5 mt-5 sm:mx-6"><AlertTriangle aria-hidden /><AlertDescription>{snapshot.discoveryError}</AlertDescription></Alert>
        )}
        {section !== "worktrees" && <div className="mx-5 mt-5 grid gap-4 rounded-md border border-border bg-background/35 px-5 py-4 sm:mx-6 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(120px,.6fr))] lg:items-center">
          <div>
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{t("project.runningServer")}</p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <RuntimeBadge phase={runtime.phase} />
              <span className="flex min-w-0 items-center gap-2 font-mono text-sm font-medium">
                <GitBranch className="size-4 text-muted-foreground" aria-hidden />
                <span className="truncate">{worktrees.find((worktree) => worktree.path === runtime.worktreePath)?.branch ?? t("project.noRuntime")}</span>
              </span>
            </div>
          </div>
          <Metric label={t("project.port")} value={String(project.port)} />
          <Metric label={t("project.protocol")} value={project.tlsMode === "off" ? "HTTP" : "HTTPS"} />
        </div>}

        <div className={`px-5 sm:px-6 ${section === "worktrees" ? "py-3" : "py-5"}`}>
        {reservation && (
          <Alert variant="warning" className="mb-4 py-2">
            <LockKeyhole aria-hidden />
            <AlertTitle>{t("worktreeLayout.reservationBlocked")}</AlertTitle>
            <AlertDescription>
              <p className="break-words">{t("worktreeLayout.reservedBranch", { branch: worktrees.find((w) => w.path === reservation.worktreePath)?.branch ?? t("overview.unknown") })}</p>
              <details className="mt-1">
                <summary className="cursor-pointer">{t("worktreeLayout.reservationDetails")}</summary>
                <div className="mt-1 space-y-1 break-all text-xs">
                  <p>{t("project.lockedBy", { owner: reservation.owner })}</p>
                  <p>{t("project.pinnedTo", { path: reservation.worktreePath })}</p>
                  <p>{reservation.kind === "agent" ? t("project.agentLease") : t("project.humanLock")}
                    {reservation.expiresAt ? ` · ${t("project.expires", { time: new Date(reservation.expiresAt).toLocaleTimeString(locale === "pl" ? "pl-PL" : "en-US") })}` : ""}</p>
                  {reservation.reason && <p>{t("project.reason", { reason: reservation.reason })}</p>}
                </div>
              </details>
            </AlertDescription>
          </Alert>
        )}
        {section !== "worktrees" && selectedWorktree?.dirty && (
          <Alert variant="warning" className="mb-4">
            <AlertTriangle aria-hidden />
            <AlertDescription>{t("project.dirtyWarning")}</AlertDescription>
          </Alert>
        )}

            {failureCopy && runtime.failure ? (
              <Alert variant="destructive" className="mt-4">
                <AlertTriangle aria-hidden />
                <AlertTitle>{failureCopy.title}</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{failureCopy.message}</p>
                  <p><span className="font-medium">{t("project.actionHint")}</span> {failureCopy.suggestion}</p>
                  <details>
                    <summary className="cursor-pointer select-none text-xs">{t("project.technicalDetails")}</summary>
                    <p className="mt-1 font-mono text-xs">{runtime.failure.technicalDetails}</p>
                  </details>
                </AlertDescription>
              </Alert>
            ) : runtime.error ? (
              <p className="mt-4 text-sm text-destructive">{runtime.error}</p>
            ) : null}

        {section === "worktrees" && <WorktreeOverview snapshots={[snapshot]} rowActions={() => ({ pendingPath, busy: isBusy, onOperate: (operation, path) => void act(operation, path), onReserve: (action, path) => void reserve(action, path) })} busy={isBusy} refreshing={metadata?.status === "refreshing"} onRefresh={() => void refreshMetadata()} />}

        {section !== "worktrees" && <><div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`worktree-${project.id}`}>{t("project.selectedWorktree")}</Label>
            <Select value={selected} onValueChange={setSelected} disabled={isBusy || worktrees.length === 0}>
              <SelectTrigger id={`worktree-${project.id}`} className="w-full min-w-0 *:data-[slot=select-value]:min-w-0">
                <SelectValue placeholder={t("project.noWorktree")} />
              </SelectTrigger>
              <SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">
                {worktrees.map((worktree) => (
                  <SelectItem className="min-w-0 *:[span]:last:min-w-0" key={worktree.path} value={worktree.path} disabled={worktree.prunable}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate" title={worktree.branch ?? "detached HEAD"}>{worktree.branch ?? "detached HEAD"}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{worktree.shortHead}</span>
                      {worktree.dirty && <span className="shrink-0 text-warning-foreground">● dirty</span>}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            {runtime.phase === "running" ? (
              <Button variant="outline" onClick={() => void act("stop")} disabled={isBusy}><Square aria-hidden />Stop</Button>
            ) : (
              <Button onClick={() => void act("start")} disabled={isBusy || !selected}><Play aria-hidden />Start</Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("project.restart")} onClick={() => void act("restart")} disabled={isBusy || !selected}>
                  <RotateCcw aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("project.restart")}</TooltipContent>
            </Tooltip>
            <Button variant="secondary" onClick={() => void act("switch")} disabled={isBusy || !selected || runtime.worktreePath === selected}>
              <RefreshCw aria-hidden />{t("project.switch")}
            </Button>
          </div>
        </div>

        <div data-operation-target className="-mx-5 mt-6 flex flex-wrap items-center justify-between gap-4 border-y border-border bg-background/30 px-5 py-4 sm:-mx-6 sm:px-6">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{t("project.operationTarget")}</p>
            <p className="mt-1 truncate font-mono text-sm font-medium" title={selectedWorktree?.path}>{selectedWorktree?.branch ?? t("project.noSelection")} <span className="text-muted-foreground">· {selectedWorktree?.shortHead ?? "—"}</span></p>
          </div>
          <p className="text-sm text-muted-foreground">
            {!hasActiveRuntime
              ? t("project.noActiveServer")
              : runtime.worktreePath && runtime.worktreePath !== selected
              ? t("project.transition", { from: worktrees.find((worktree) => worktree.path === runtime.worktreePath)?.branch ?? "—", to: selectedWorktree?.branch ?? "—" })
              : t("project.noTransition")}
          </p>
        </div>

        </>}
        {section !== "worktrees" && <Separator className="my-5" />}

        {section !== "worktrees" && <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="truncate text-xs text-muted-foreground" title={selectedWorktree?.path}>{selectedWorktree?.path ?? t("project.noSelection")}</p>
          {reservation ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (reservation.kind === "agent" && !window.confirm(t("project.forceReleaseConfirm"))) return;
                void reserve(reservation.kind === "agent" ? "force-release" : "release");
              }}
              disabled={isBusy}
            >
              <UnlockKeyhole aria-hidden />
              {reservation.kind === "agent" ? t("project.forceRelease") : t("project.release")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void reserve("acquire")} disabled={isBusy || !selected}>
              <LockKeyhole aria-hidden />{t("project.reserve")}
            </Button>
          )}
        </div>}
        </div>
      </CardContent>
    </Card>
  );
}
