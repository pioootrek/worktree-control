"use client";

import {
  Activity,
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  Gauge,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Languages,
  MemoryStick,
  Moon,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldCheck,
  Square,
  Sun,
  UnlockKeyhole,
  Variable,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { DirectoryPicker } from "@/components/directory-picker";
import { CertificateFilePicker } from "@/components/certificate-file-picker";
import { WorktreeStoragePanel } from "@/components/worktree-storage-panel";
import { useI18n } from "@/i18n/provider";
import { dashboardSummary, type Translate } from "@/i18n/messages";
import type { ControllerDashboardResponse, DevServerTlsMode, McpStatus, Project, ProjectSnapshot, RuntimeFailure, RuntimeMetricsResponse, RuntimePhase, RuntimeResourceMetrics, ServerCapacityStatus } from "@/shared/contracts";

const EMPTY_CAPACITY: ServerCapacityStatus = { enabled: false, limit: 2, used: 0, available: null, holders: [] };
const EMPTY_RESOURCES: RuntimeResourceMetrics = { status: "idle", currentRssBytes: null, peakRssBytes: null, cpuPercent: null, processCount: null, sampledAt: null, sampleAgeSeconds: null, warningThresholdBytes: null, history: [] };

const EMPTY_MCP_STATUS: McpStatus = {
  phase: "unknown",
  endpoint: null,
  transport: "streamable-http",
  network: "loopback",
  authentication: "bearer",
  activeSessions: 0,
};

type Mutate = (path: string, body: unknown, success: string, method?: "POST" | "DELETE") => Promise<void>;

async function parseResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? fallback);
  return body;
}

export function Dashboard() {
  const { locale, setLocale, t } = useI18n();
  const [data, setData] = useState<ControllerDashboardResponse>({ projects: [], capacity: EMPTY_CAPACITY, mcp: EMPTY_MCP_STATUS });
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const refresh = useCallback(async (accessToken: string) => {
    try {
      const response = await fetch("/api/dashboard", {
        cache: "no-store",
        headers: { "Accept-Language": locale, "X-Worktree-Switcher-Token": accessToken },
      });
      const dashboard = await parseResponse<ControllerDashboardResponse>(response, t("http.error", { status: response.status }));
      setData({ ...dashboard, capacity: dashboard.capacity ?? EMPTY_CAPACITY, mcp: dashboard.mcp ?? EMPTY_MCP_STATUS });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [locale, t]);

  useEffect(() => {
    let events: EventSource | null = null;
    const initialRefresh = window.setTimeout(() => {
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = fragment.get("token") ?? window.sessionStorage.getItem("worktree-switcher-token");
      if (!accessToken) {
        setLoading(false);
        setError(t("dashboard.missingToken"));
        return;
      }
      window.sessionStorage.setItem("worktree-switcher-token", accessToken);
      if (window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setToken(accessToken);
      void refresh(accessToken);
      events = new EventSource(`/api/events?token=${encodeURIComponent(accessToken)}`);
      events.addEventListener("changed", () => void refresh(accessToken));
      events.onerror = () => setError(t("dashboard.connectionLost"));
    }, 0);
    return () => {
      window.clearTimeout(initialRefresh);
      events?.close();
    };
  }, [refresh, t]);

  const mutate = useCallback(async (path: string, body: unknown, success: string, method: "POST" | "DELETE" = "POST") => {
    if (!token) throw new Error(t("dashboard.sessionPending"));
    const response = await fetch(path, {
      method,
      headers: { "Accept-Language": locale, "Content-Type": "application/json", "X-Worktree-Switcher-Token": token },
      body: JSON.stringify(body),
    });
    await parseResponse(response, t("http.error", { status: response.status }));
    setNotice(success);
    setError(null);
    await refresh(token);
  }, [locale, refresh, t, token]);

  const runningCount = useMemo(
    () => data.projects.filter(({ runtime }) => runtime.phase === "running").length,
    [data.projects],
  );
  const monitoredProjectIds = useMemo(
    () => data.projects.filter(({ runtime }) => runtime.phase === "running" || runtime.phase === "starting").map(({ project }) => project.id).join(","),
    [data.projects],
  );

  useEffect(() => {
    if (!token || !monitoredProjectIds) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/metrics", {
          cache: "no-store",
          headers: { "X-Worktree-Switcher-Token": token },
        });
        const body = await parseResponse<RuntimeMetricsResponse>(response, t("http.error", { status: response.status }));
        if (cancelled) return;
        const metrics = new Map(body.projects.map(({ projectId, resources }) => [projectId, resources]));
        setData((current) => ({
          ...current,
          projects: current.projects.map((snapshot) => ({
            ...snapshot,
            runtime: { ...snapshot.runtime, resources: metrics.get(snapshot.project.id) ?? snapshot.runtime.resources ?? EMPTY_RESOURCES },
          })),
        }));
      } catch {
        // The dashboard/SSE connection owns the visible connection error state.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [monitoredProjectIds, t, token]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,oklch(0.26_0.06_260/.32),transparent_34rem)]">
      <div className="mx-auto max-w-[1500px] px-4 py-6 sm:px-7 lg:px-10">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-5">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-xl border border-indigo-400/25 bg-indigo-400/10 shadow-[0_0_30px_oklch(0.65_0.15_270/.12)]">
              <GitBranch className="size-5 text-indigo-300" aria-hidden />
            </div>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{t("dashboard.tagline")}</p>
              <h1 className="text-2xl font-semibold tracking-tight">Worktree Switcher</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-9 gap-2 px-3 font-normal">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              {dashboardSummary(locale, runningCount, data.projects.length)}
            </Badge>
            <CapacityDialog status={data.capacity} mutate={mutate} setError={setError} />
            <McpStatusDialog status={data.mcp} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocale(locale === "pl" ? "en" : "pl")}
              aria-label={t("language.label")}
              title={t("language.label")}
            >
              <Languages aria-hidden />{locale === "pl" ? "EN" : "PL"}
            </Button>
            <ThemeToggle />
            <AddProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} mutate={mutate} token={token} />
          </div>
        </header>

        <div className="sr-only" aria-live="polite">{error ?? notice}</div>
        {error && (
          <Alert variant="destructive" className="mb-5">
            <AlertTriangle aria-hidden />
            <AlertTitle>{t("dashboard.operationError")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="grid place-items-center py-28 text-muted-foreground">
            <LoaderCircle className="mb-3 size-6 animate-spin motion-reduce:animate-none" aria-hidden />
            {t("dashboard.connecting")}
          </div>
        ) : data.projects.length === 0 ? (
          <EmptyState onAdd={() => setDialogOpen(true)} />
        ) : (
          <section className="grid gap-5 xl:grid-cols-2" aria-label={t("dashboard.projects")}>
            {data.projects.map((snapshot) => (
              <ProjectCard key={snapshot.project.id} snapshot={snapshot} mutate={mutate} setError={setError} token={token} />
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function CapacityDialog({
  status,
  mutate,
  setError,
}: {
  status: ServerCapacityStatus;
  mutate: Mutate;
  setError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(status.enabled);
  const [limit, setLimit] = useState(String(status.limit));
  const [pending, setPending] = useState(false);

  const changeOpen = (next: boolean) => {
    if (next) {
      setEnabled(status.enabled);
      setLimit(String(status.limit));
    }
    setOpen(next);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      await mutate(
        "/api/settings/capacity",
        { enabled, limit: Number(limit) },
        t("capacity.saved"),
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label={t("capacity.openSettings")}>
          <Gauge aria-hidden />
          {status.enabled ? `${status.used}/${status.limit}` : status.used}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("capacity.title")}</DialogTitle>
          <DialogDescription>{t("capacity.description")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={(event) => void save(event)}>
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="capacity-enabled">{t("capacity.enabled")}</Label>
              <p className="text-xs text-muted-foreground">{t("capacity.enabledHint")}</p>
            </div>
            <Switch id="capacity-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="capacity-limit">{t("capacity.limit")}</Label>
            <Input id="capacity-limit" type="number" min="1" max="64" value={limit} onChange={(event) => setLimit(event.target.value)} required />
          </div>
          <div className="rounded-lg border bg-black/15 p-3 text-sm">
            <p>{t("capacity.usage", { used: status.used, limit: status.enabled ? status.limit : "∞" })}</p>
            {status.holders.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {status.holders.map((holder) => <li key={holder.projectId}>{holder.projectName} · {t(`phase.${holder.phase}`)}</li>)}
              </ul>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("capacity.loweringHint")}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => changeOpen(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("common.save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function McpStatusDialog({ status }: { status: McpStatus }) {
  const { t } = useI18n();
  const running = status.phase === "running";
  const description = status.phase === "running"
    ? t("mcp.readyDescription")
    : status.phase === "disabled"
      ? t("mcp.disabledDescription")
      : status.phase === "unknown"
        ? t("mcp.unknownDescription")
        : t("mcp.stoppedDescription");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label={t("mcp.openStatus")}>
          <Radio aria-hidden />
          MCP
          <span
            className={`size-2 rounded-full ${running ? "bg-emerald-400" : "bg-muted-foreground"}`}
            aria-hidden
          />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="size-5 text-indigo-300" aria-hidden />
            {t("mcp.title")}
          </DialogTitle>
          <DialogDescription>{t("mcp.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Alert className={running ? "border-emerald-400/25 bg-emerald-400/7 text-emerald-100" : undefined}>
            {running ? <ShieldCheck aria-hidden /> : <AlertTriangle aria-hidden />}
            <AlertTitle>{t(`mcp.phase.${status.phase}`)}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </Alert>

          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
            <Metric label={t("mcp.sessions")} value={String(status.activeSessions)} />
            <Metric label={t("mcp.transport")} value={t("mcp.streamableHttp")} />
            <Metric label={t("mcp.network")} value={t("mcp.loopback")} />
            <Metric label={t("mcp.authentication")} value={t("mcp.bearerToken")} />
          </dl>

          <div className="space-y-2">
            <Label>{t("mcp.endpoint")}</Label>
            <div className="overflow-x-auto rounded-md border bg-black/20 px-3 py-2 font-mono text-xs text-muted-foreground">
              {status.endpoint ?? "—"}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("mcp.clientConfig")}</Label>
            <div className="rounded-md border bg-black/20 px-3 py-2 font-mono text-xs text-muted-foreground">
              worktree-switcher config mcp
            </div>
            <p className="text-xs text-muted-foreground">{t("mcp.securityHint")}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function localizedFailure(project: Project, failure: RuntimeFailure, t: Translate) {
  const values = { port: project.port, executable: project.executable };
  switch (failure.code) {
    case "port_in_use":
      return {
        title: t("failure.port_in_use.title", values),
        message: t("failure.port_in_use.message"),
        suggestion: t("failure.port_in_use.suggestion"),
      };
    case "missing_dev_script":
      return {
        title: t("failure.missing_dev_script.title"),
        message: t("failure.missing_dev_script.message"),
        suggestion: t("failure.missing_dev_script.suggestion"),
      };
    case "invalid_arguments":
      return {
        title: t("failure.invalid_arguments.title"),
        message: t("failure.invalid_arguments.message"),
        suggestion: t("failure.invalid_arguments.suggestion"),
      };
    case "missing_executable":
      return {
        title: t("failure.missing_executable.title", values),
        message: t("failure.missing_executable.message"),
        suggestion: t("failure.missing_executable.suggestion"),
      };
    case "resource_limit":
      return {
        title: t("failure.resource_limit.title"),
        message: t("failure.resource_limit.message"),
        suggestion: t("failure.resource_limit.suggestion"),
      };
    case "startup_timeout":
      return {
        title: t("failure.startup_timeout.title", values),
        message: t("failure.startup_timeout.message", values),
        suggestion: t("failure.startup_timeout.suggestion"),
      };
    case "process_exit":
      return {
        title: t("failure.process_exit.title"),
        message: t("failure.process_exit.message"),
        suggestion: t("failure.process_exit.suggestion"),
      };
  }
}

function ProjectCard({
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
  const { project, runtime, reservation, worktrees } = snapshot;
  const resources = runtime.resources ?? EMPTY_RESOURCES;
  const initial = project.selectedWorktreePath ?? worktrees[0]?.path ?? "";
  const [selected, setSelected] = useState(initial);
  const [pending, setPending] = useState<string | null>(null);
  const selectedWorktree = worktrees.find((worktree) => worktree.path === selected);
  const isBusy = runtime.phase === "starting" || runtime.phase === "stopping" || pending !== null;
  const failureCopy = runtime.failure ? localizedFailure(project, runtime.failure, t) : null;

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
    <Card className="overflow-hidden border-white/8 bg-card/75 shadow-xl shadow-black/10 backdrop-blur-sm">
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
            <EnvironmentSettingsDialog
              project={project}
              phase={runtime.phase}
              mutate={mutate}
              setError={setError}
            />
            <TlsSettingsDialog
              project={project}
              phase={runtime.phase}
              token={token}
              mutate={mutate}
              setError={setError}
            />
            <RuntimeBadge phase={runtime.phase} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
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
            <TabsTrigger value="storage"><HardDrive aria-hidden />{t("storage.tab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="status" className="mt-4">
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3">
              <Metric label={t("project.port")} value={String(project.port)} />
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

function EnvironmentSettingsDialog({
  project,
  phase,
  mutate,
  setError,
}: {
  project: Project;
  phase: RuntimePhase;
  mutate: Mutate;
  setError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [profileName, setProfileName] = useState(project.selectedEnvironmentProfile);
  const [text, setText] = useState(() => Object.entries(project.environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n"));
  const [pending, setPending] = useState(false);
  const active = phase === "running" || phase === "starting" || phase === "stopping";

  const parseVariables = () => {
    const environment: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) throw new Error(t("environment.invalidLine", { line: rawLine }));
      environment[line.slice(0, separator).trim()] = line.slice(separator + 1);
    }
    return environment;
  };

  const save = async (event: FormEvent<HTMLFormElement> | null, restart = false) => {
    event?.preventDefault();
    setPending(true);
    try {
      await mutate(
        `/api/projects/${project.id}/environment-profiles`,
        { name: profileName, environment: parseVariables(), restart },
        t("environment.saved", { name: project.name }),
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const selectProfile = (name: string) => {
    const profile = project.environmentProfiles.find((candidate) => candidate.name === name);
    if (!profile) return;
    setProfileName(profile.name);
    setText(Object.entries(profile.environment).map(([key, value]) => `${key}=${value}`).join("\n"));
  };

  const activate = async () => {
    setPending(true);
    try {
      await mutate(
        `/api/projects/${project.id}/environment-profile-selection`,
        { name: profileName, restart: active },
        t("environment.selected", { profile: profileName }),
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("environment.deleteConfirm", { profile: profileName }))) return;
    setPending(true);
    try {
      await mutate(
        `/api/projects/${project.id}/environment-profiles`,
        { name: profileName },
        t("environment.deleted", { profile: profileName }),
        "DELETE",
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) {
        setProfileName(project.selectedEnvironmentProfile);
        setText(Object.entries(project.environment).map(([name, value]) => `${name}=${value}`).join("\n"));
      }
      setOpen(nextOpen);
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t("environment.settings")} title={t("environment.settings")}>
          <Variable aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("environment.title")}</DialogTitle>
          <DialogDescription>{t("environment.description", { name: project.name })}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`environment-profile-list-${project.id}`}>{t("environment.profile")}</Label>
              <Select value={project.environmentProfiles.some(({ name }) => name === profileName) ? profileName : ""} onValueChange={selectProfile}>
                <SelectTrigger id={`environment-profile-list-${project.id}`} className="w-full"><SelectValue placeholder={t("environment.newProfile")} /></SelectTrigger>
                <SelectContent>{project.environmentProfiles.map((profile) => <SelectItem key={profile.name} value={profile.name}>{profile.name}{profile.name === project.selectedEnvironmentProfile ? ` · ${t("environment.active")}` : ""}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`environment-profile-name-${project.id}`}>{t("environment.profileName")}</Label>
              <Input id={`environment-profile-name-${project.id}`} value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={40} required />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`environment-${project.id}`}>{t("environment.variables")}</Label>
            <textarea
              id={`environment-${project.id}`}
              className="min-h-52 w-full resize-y rounded-md border bg-transparent px-3 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={"PLAYWRIGHT_E2E=1\nQA_SHOTS_FROZEN_CLOCK_ISO=2026-08-01T12:00:00.000Z"}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">{t("environment.hint")}</p>
          </div>
          {active && profileName === project.selectedEnvironmentProfile && <p className="text-sm text-amber-300">{t("environment.restartHint")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {profileName !== "default" && profileName !== project.selectedEnvironmentProfile && project.environmentProfiles.some(({ name }) => name === profileName) && (
              <Button type="button" variant="destructive" onClick={() => void remove()} disabled={pending}>{t("environment.delete")}</Button>
            )}
            {profileName !== project.selectedEnvironmentProfile && project.environmentProfiles.some(({ name }) => name === profileName) && (
              <Button type="button" variant="secondary" onClick={() => void activate()} disabled={pending}>{active ? t("environment.activateRestart") : t("environment.activate")}</Button>
            )}
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            {active && profileName === project.selectedEnvironmentProfile ? (
              <Button type="button" onClick={() => void save(null, true)} disabled={pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("environment.saveRestart")}</Button>
            ) : (
              <Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("common.save")}</Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TlsSettingsDialog({
  project,
  phase,
  token,
  mutate,
  setError,
}: {
  project: Project;
  phase: RuntimePhase;
  token: string;
  mutate: Mutate;
  setError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DevServerTlsMode>(project.tlsMode);
  const [keyPath, setKeyPath] = useState(project.tlsKeyPath ?? "");
  const [certPath, setCertPath] = useState(project.tlsCertPath ?? "");
  const [caPath, setCaPath] = useState(project.tlsCaPath ?? "");
  const [pending, setPending] = useState(false);
  const active = phase === "running" || phase === "starting" || phase === "stopping";

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      await mutate(
        `/api/projects/${project.id}/tls`,
        { mode, keyPath: keyPath || null, certPath: certPath || null, caPath: caPath || null },
        t("tls.saved", { name: project.name }),
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t("tls.settings")} title={t("tls.settings")}>
          <ShieldCheck aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("tls.title")}</DialogTitle>
          <DialogDescription>
            {t("tls.description", { name: project.name })}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <div className="space-y-2">
            <Label htmlFor={`tls-mode-${project.id}`}>{t("tls.mode")}</Label>
            <Select value={mode} onValueChange={(value) => setMode(value as DevServerTlsMode)}>
              <SelectTrigger id={`tls-mode-${project.id}`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t("tls.off")}</SelectItem>
                <SelectItem value="generated">{t("tls.generated")}</SelectItem>
                <SelectItem value="custom">{t("tls.custom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "generated" && (
            <Alert>
              <ShieldCheck aria-hidden />
              <AlertDescription>{t("tls.generatedHint")}</AlertDescription>
            </Alert>
          )}

          {mode === "custom" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor={`tls-key-${project.id}`}>{t("tls.privateKey")}</Label>
                <CertificateFilePicker id={`tls-key-${project.id}`} token={token} value={keyPath} onChange={setKeyPath} placeholder="/home/me/certs/dev-key.pem" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`tls-cert-${project.id}`}>{t("tls.certificate")}</Label>
                <CertificateFilePicker id={`tls-cert-${project.id}`} token={token} value={certPath} onChange={setCertPath} placeholder="/home/me/certs/dev-cert.pem" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`tls-ca-${project.id}`}>{t("tls.optionalCa")}</Label>
                <CertificateFilePicker id={`tls-ca-${project.id}`} token={token} value={caPath} onChange={setCaPath} placeholder="/home/me/certs/root-ca.pem" />
              </div>
              <p className="text-xs text-muted-foreground">{t("tls.filesHint")}</p>
            </div>
          )}

          {active && <p className="text-sm text-amber-300">{t("tls.stopBeforeSave")}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={active || pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("common.save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RuntimeBadge({ phase }: { phase: RuntimePhase }) {
  const { t } = useI18n();
  const active = phase === "running";
  const busy = phase === "starting" || phase === "stopping";
  return (
    <Badge variant="outline" className={active ? "border-emerald-400/25 text-emerald-300" : phase === "failed" ? "border-red-400/25 text-red-300" : "text-muted-foreground"}>
      {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Activity aria-hidden />}
      {t(`phase.${phase}`)}
    </Badge>
  );
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className={`truncate pt-0.5 ${mono ? "font-mono text-xs" : ""}`} title={value}>{value}</dd></div>;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function ResourceMonitor({ resources }: { resources: RuntimeResourceMetrics }) {
  const { locale, t } = useI18n();
  const history = resources.history ?? [];
  const values = history.map(({ rssBytes }) => rssBytes);
  const maximum = Math.max(...values, 1);
  const minimum = Math.min(...values, 0);
  const range = Math.max(1, maximum - minimum);
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 30 - ((value - minimum) / range) * 26;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const warning = resources.currentRssBytes !== null
    && resources.warningThresholdBytes !== null
    && resources.currentRssBytes >= resources.warningThresholdBytes;
  const sampleAge = resources.sampleAgeSeconds;

  return (
    <section className={`mt-4 rounded-lg border p-3 ${warning ? "border-amber-400/30 bg-amber-400/5" : "border-white/7 bg-black/10"}`} aria-label={t("resources.title")}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium"><MemoryStick className="size-4 text-indigo-300" aria-hidden />{t("resources.title")}</div>
        <span className="text-xs text-muted-foreground">
          {resources.status === "available" && sampleAge !== null
            ? t("resources.sampleAge", { seconds: sampleAge })
            : t(`resources.status.${resources.status}`)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label={t("resources.memoryNow")} value={formatBytes(resources.currentRssBytes)} mono />
        <Metric label={t("resources.memoryPeak")} value={formatBytes(resources.peakRssBytes)} mono />
        <Metric label={t("resources.cpu")} value={resources.cpuPercent === null ? "—" : `${resources.cpuPercent.toLocaleString(locale === "pl" ? "pl-PL" : "en-US", { maximumFractionDigits: 1 })}%`} mono />
        <Metric label={t("resources.processes")} value={resources.processCount === null ? "—" : String(resources.processCount)} mono />
      </div>
      {points && (
        <svg className="mt-3 h-9 w-full text-indigo-300" viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label={t("resources.memoryHistory")}>
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {warning && <p className="mt-2 text-xs text-amber-300">{t("resources.warning", { threshold: formatBytes(resources.warningThresholdBytes) })}</p>}
    </section>
  );
}

function AddProjectDialog({ open, onOpenChange, mutate, token }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutate: Mutate;
  token: string;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [repositoryPath, setRepositoryPath] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);
    try {
      await mutate("/api/projects", {
        name: String(form.get("name") ?? ""),
        repositoryPath: String(form.get("repositoryPath") ?? ""),
        port: Number(form.get("port")),
      }, t("add.success"));
      setRepositoryPath("");
      onOpenChange(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild><Button><Plus aria-hidden />{t("add.trigger")}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>
          <DialogDescription>{t("add.description")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2"><Label htmlFor="name">{t("add.name")}</Label><Input id="name" name="name" placeholder="Frontend" required maxLength={80} /></div>
          <div className="space-y-2">
            <Label htmlFor="repositoryPath">{t("add.repositoryPath")}</Label>
            <DirectoryPicker token={token} value={repositoryPath} onChange={setRepositoryPath} />
          </div>
          <div className="space-y-2"><Label htmlFor="port">{t("add.port")}</Label><Input id="port" name="port" type="number" defaultValue="3000" min="1024" max="65535" required /></div>
          <p className="text-xs text-muted-foreground">{t("add.commandHint")}</p>
          {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("add.submit")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <Card className="mx-auto max-w-2xl border-dashed bg-card/45 py-10 text-center">
      <CardContent className="grid justify-items-center">
        <div className="mb-5 grid size-14 place-items-center rounded-2xl bg-muted"><GitCommitHorizontal className="size-6 text-muted-foreground" aria-hidden /></div>
        <h2 className="text-xl font-semibold">{t("empty.title")}</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("empty.description")}</p>
        <Button className="mt-6" onClick={onAdd}><Plus aria-hidden />{t("empty.action")}</Button>
      </CardContent>
    </Card>
  );
}

function ThemeToggle() {
  const { t } = useI18n();
  const [dark, setDark] = useState(true);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("worktree-switcher-theme", next ? "dark" : "light");
  };
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = localStorage.getItem("worktree-switcher-theme");
      const next = saved !== "light";
      document.documentElement.classList.toggle("dark", next);
      setDark(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return <Button variant="outline" size="icon" onClick={toggle} aria-label={dark ? t("theme.light") : t("theme.dark")}>{dark ? <Sun aria-hidden /> : <Moon aria-hidden />}</Button>;
}
