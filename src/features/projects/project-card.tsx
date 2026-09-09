"use client";

import { Metric } from "@/components/metric";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Mutate } from "@/features/control-client";
import { EnvironmentSettingsDialog } from "@/features/environments/environment-settings-dialog";
import { EMPTY_RESOURCES } from "@/features/runtime/defaults";
import { localizedFailure } from "@/features/runtime/localized-failure";
import { ResourceMonitor } from "@/features/runtime/resource-monitor";
import { RuntimeBadge } from "@/features/runtime/runtime-badge";
import { TlsSettingsDialog } from "@/features/runtime/tls-settings-dialog";
import { WorktreeStoragePanel } from "@/features/storage/worktree-storage-panel";
import { TestPanel } from "@/features/verification/test-panel";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { AlertTriangle, HardDrive, LockKeyhole, Play, RefreshCw, RotateCcw, Server, Square, TestTube2, UnlockKeyhole } from "lucide-react";
import { useState } from "react";

export function ProjectCard({
  snapshot,
  mutate,
  setError,
  token,
}: {
  snapshot: ProjectSnapshot;
  mutate: Mutate;
  setError: (message: string | null) => void;
  token: string;
}) {
  const { locale, t } = useI18n();
  const { project, runtime, reservation, worktrees, testPresets, testRuns } = snapshot;
  const resources = runtime.resources ?? EMPTY_RESOURCES;
  const initial = project.selectedWorktreePath ?? worktrees[0]?.path ?? "";
  const [selected, setSelected] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const selectedWorktree = worktrees.find((worktree) => worktree.path === selected);
  const isBusy = runtime.phase === "starting" || runtime.phase === "stopping" || pending !== null;
  const failureCopy = runtime.failure ? localizedFailure(project, runtime.failure, t) : null;
  const metadata = snapshot.metadata;

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

  const act = async (operation: "start" | "stop" | "restart" | "switch") => {
    setPending(operation);
    try {
      await mutate(
        `/api/projects/${project.id}/operation`,
        { operation, worktreePath: selected || undefined },
        t("project.operationDone", { name: project.name, operation: t(`operation.${operation}`) }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  };

  const reserve = async (action: "acquire" | "release" | "force-release") => {
    setPending(action);
    try {
      await mutate(
        `/api/projects/${project.id}/reservation`,
        { action, worktreePath: selected || undefined },
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

  return (
    <Card data-project-id={project.id} className="overflow-hidden border-white/8 bg-card/75 shadow-xl shadow-black/10 backdrop-blur-sm">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Server className="size-4 text-indigo-300" aria-hidden />
              {project.name}
            </CardTitle>
            <CardDescription className="mt-1 truncate font-mono text-xs" title={project.repositoryPath}>
              {project.repositoryPath}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void refreshMetadata()}
                  disabled={pending !== null || metadata?.status === "refreshing"}
                  aria-label={t("metadata.refresh")}
                >
                  <RefreshCw className={metadata?.status === "refreshing" ? "animate-spin motion-reduce:animate-none" : undefined} aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("metadata.refresh")}</TooltipContent>
            </Tooltip>
            <EnvironmentSettingsDialog
              project={project}
              phase={runtime.phase}
              mutate={mutate}
              setError={setError}
            />
            {project.launchPreset !== "django" && (
              <TlsSettingsDialog
                project={project}
                phase={runtime.phase}
                token={token}
                mutate={mutate}
                setError={setError}
              />
            )}
            <RuntimeBadge phase={runtime.phase} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {metadata && metadata.status !== "fresh" && (
          <Alert className="mb-4 border-amber-400/20 bg-amber-400/5 text-amber-100">
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
          <Alert variant="destructive" className="mb-4"><AlertTriangle aria-hidden /><AlertDescription>{snapshot.discoveryError}</AlertDescription></Alert>
        )}
        {reservation && (
          <Alert className="mb-4 border-amber-400/25 bg-amber-400/7 text-amber-100">
            <LockKeyhole aria-hidden />
            <AlertTitle>{t("project.lockedBy", { owner: reservation.owner })}</AlertTitle>
            <AlertDescription className="space-y-1">
              <p className="truncate">{t("project.pinnedTo", { path: reservation.worktreePath })}</p>
              <p>
                {reservation.kind === "agent" ? t("project.agentLease") : t("project.humanLock")}
                {reservation.expiresAt
                  ? ` · ${t("project.expires", { time: new Date(reservation.expiresAt).toLocaleTimeString(locale === "pl" ? "pl-PL" : "en-US") })}`
                  : ""}
              </p>
              {reservation.reason && <p>{t("project.reason", { reason: reservation.reason })}</p>}
            </AlertDescription>
          </Alert>
        )}
        {selectedWorktree?.dirty && (
          <Alert className="mb-4 border-amber-400/20 bg-amber-400/5 text-amber-100">
            <AlertTriangle aria-hidden />
            <AlertDescription>{t("project.dirtyWarning")}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor={`worktree-${project.id}`}>{t("project.activeWorktree")}</Label>
            <Select value={selected} onValueChange={setSelected} disabled={isBusy || worktrees.length === 0}>
              <SelectTrigger id={`worktree-${project.id}`} className="w-full">
                <SelectValue placeholder={t("project.noWorktree")} />
              </SelectTrigger>
              <SelectContent>
                {worktrees.map((worktree) => (
                  <SelectItem key={worktree.path} value={worktree.path} disabled={worktree.prunable}>
                    <span className="flex items-center gap-2">
                      {worktree.branch ?? "detached HEAD"}
                      <span className="font-mono text-xs text-muted-foreground">{worktree.shortHead}</span>
                      {worktree.dirty && <span className="text-amber-400">● dirty</span>}
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
                <Button variant="outline" size="icon" onClick={() => void act("restart")} disabled={isBusy || !selected}>
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

        <Separator className="my-5" />
        <Tabs defaultValue="status">
          <TabsList>
            <TabsTrigger value="status">{t("project.status")}</TabsTrigger>
            <TabsTrigger value="logs">{t("project.logs")} <span className="text-muted-foreground">{runtime.logs.length}</span></TabsTrigger>
            <TabsTrigger value="tests"><TestTube2 aria-hidden />{t("tests.tab")}</TabsTrigger>
            <TabsTrigger value="storage"><HardDrive aria-hidden />{t("storage.tab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="status" className="mt-4">
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
              <Metric label={t("project.port")} value={String(project.port)} />
              <Metric label={t("project.preset")} value={t(`preset.${project.launchPreset}`)} />
              <Metric label={t("project.protocol")} value={project.tlsMode === "off" ? "HTTP" : "HTTPS"} />
              <Metric label="PID" value={runtime.pid ? String(runtime.pid) : "—"} />
              <Metric label={t("project.process")} value={`${project.executable} ${project.args.join(" ")}`} mono />
              <Metric label={t("project.commit")} value={selectedWorktree?.shortHead ?? "—"} mono />
              <Metric label={t("project.branch")} value={selectedWorktree?.branch ?? "detached"} />
              <Metric label={t("project.started")} value={runtime.startedAt ? new Date(runtime.startedAt).toLocaleTimeString(locale === "pl" ? "pl-PL" : "en-US") : "—"} />
            </dl>
            <ResourceMonitor resources={resources} />
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
          </TabsContent>
          <TabsContent value="logs" className="mt-4">
            <ScrollArea className="h-40 rounded-md border bg-black/35 p-3">
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-zinc-300">
                {runtime.logs.length ? runtime.logs.join("\n") : t("project.noLogs")}
              </pre>
            </ScrollArea>
          </TabsContent>
          <TabsContent value="tests" className="mt-4">
            <TestPanel
              key={selected}
              projectId={project.id}
              worktreePath={selected}
              profiles={project.testEnvironmentProfiles}
              presets={testPresets.find((entry) => entry.worktreePath === selected)?.presets ?? []}
              discoveryError={testPresets.find((entry) => entry.worktreePath === selected)?.error ?? null}
              runs={testRuns}
              mutate={mutate}
              setError={setError}
            />
          </TabsContent>
          <TabsContent value="storage" className="mt-4">
            <WorktreeStoragePanel
              key={runtime.worktreePath ?? selected}
              storage={snapshot.storage ?? []}
              defaultPath={runtime.worktreePath ?? selected}
              refresh={(worktreePath) => mutate(
                `/api/projects/${project.id}/storage/refresh`,
                { worktreePath },
                t("storage.refreshQueued"),
              )}
              deleteCache={async (worktreePath) => {
                try {
                  await mutate(
                    `/api/projects/${project.id}/storage/cache`,
                    { worktreePath, cache: "next" },
                    t("storage.deleted"),
                    "DELETE",
                  );
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                  throw cause;
                }
              }}
              activeWorktreePath={runtime.phase === "running" || runtime.phase === "starting" || runtime.phase === "stopping" ? runtime.worktreePath : null}
              reservedWorktreePath={reservation?.worktreePath ?? null}
            />
          </TabsContent>
        </Tabs>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/7 pt-4">
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
        </div>
      </CardContent>
    </Card>
  );
}
