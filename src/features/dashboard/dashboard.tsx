"use client";
import { UserSchedulesDialog } from "@/features/backups/user-schedules-dialog";
import { BackupsDialog } from "@/features/backups/backups-dialog";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { EmptyState } from "@/features/dashboard/empty-state";
import { useTheme } from "@/features/dashboard/theme-toggle";
import { McpStatusDialog } from "@/features/mcp/mcp-status-dialog";
import { AddProjectDialog } from "@/features/projects/add-project-dialog";
import { ProjectCard } from "@/features/projects/project-card";
import { CapacityDialog } from "@/features/runtime/capacity-dialog";
import { LogsDashboard } from "@/features/logs/logs-dashboard";
import { ResourcesDashboard } from "@/features/storage/resources-dashboard";
import { TestsDashboard } from "@/features/verification/tests-dashboard";
import { TestQueueDialog } from "@/features/verification/test-queue-dialog";
import { dashboardSummary } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { AlertTriangle, CheckCircle2, Gauge, Languages, LoaderCircle, LogOut, Moon, Radio, Settings2, Sun, TestTube2, X } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { ProjectNavigation, projectSections, type ProjectSection } from "./project-navigation";
import { ProjectSwitcher } from "./project-switcher";
import { AllProjectsWorktrees } from "@/features/projects/all-projects-worktrees";
import { ALL_PROJECTS, useProjectSelection } from "./project-selection";
import { KnowledgeDashboard } from "@/features/knowledge/knowledge-dashboard";
import { AccessTokenForm } from "./access-token-form";
import { OPEN_ACCESS, useDashboard } from "./use-dashboard";

export function Dashboard() {
  const { locale, setLocale, t } = useI18n();
  const { data, observedAt, token, accessRequired, signIn, signOut, loading, error, notice, dismissNotice, mutate, setError, runningCount, knowledgeToken, knowledgeAccess, knowledgeSessionVersion, changeKnowledgeToken, knowledgeChange } = useDashboard();
  const [section, setSection] = useState<ProjectSection>("worktrees");
  useEffect(() => {
    const sync = () => {
      const view = new URLSearchParams(window.location.search).get("view");
      setSection(projectSections.find(item => item.id === view)?.id ?? "worktrees");
    };
    const timer = setTimeout(sync, 0);
    window.addEventListener("popstate", sync);
    return () => { clearTimeout(timer); window.removeEventListener("popstate", sync); };
  }, []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [systemDialog, setSystemDialog] = useState<"capacity" | "queue" | "mcp" | "backups" | "user-backups" | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const systemTrigger = useRef<HTMLButtonElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const emptyAddTrigger = useRef<HTMLButtonElement>(null);
  const pendingLogFocus = useRef<string | null>(null);
  const { dark, toggle: toggleTheme } = useTheme();
  const { selectedProjectId, selectProject } = useProjectSelection();
  const allProjects = selectedProjectId === ALL_PROJECTS;
  const selectedSnapshot = data.projects.find(({ project }) => project.id === selectedProjectId) ?? data.projects[0];

  const selectSection = (next: ProjectSection) => {
    setSection(next);
    const url = new URL(window.location.href);
    if (next === "worktrees") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    if (next !== "knowledge") {
      for (const key of ["knowledgeProject", "knowledgeTab", "record", "knowledgeEditor"]) url.searchParams.delete(key);
    }
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const openFailedLogs = (projectId: string) => {
    pendingLogFocus.current = projectId;
    selectProject(projectId);
    selectSection("logs");
  };
  useEffect(() => {
    if (section !== "logs" || pendingLogFocus.current !== selectedProjectId) return;
    const frame = requestAnimationFrame(() => {
      const heading = document.querySelector<HTMLElement>("[data-logs-dashboard] [data-log-console] h3");
      if (heading) { heading.focus(); pendingLogFocus.current = null; }
    });
    return () => cancelAnimationFrame(frame);
  }, [section, selectedProjectId, loading, data.projects]);

  const sectionLabel = t(projectSections.find((item) => item.id === section)!.label);

  return (
    <SidebarProvider style={{ "--sidebar-width": "13.5rem" } as CSSProperties}>
      <ProjectNavigation section={section} projectName={allProjects ? t("projectSwitcher.all") : selectedSnapshot?.project.name} onSelect={selectSection} />
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex min-h-14 min-w-0 flex-wrap items-center justify-between gap-x-1.5 border-b border-border bg-background/95 px-2 py-1 backdrop-blur-xl sm:gap-x-3 sm:px-5 lg:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3">
            <SidebarTrigger aria-label={t("dashboard.toggleNavigation")} />
            {section !== "knowledge" && data.projects.length > 0 ? (
              <ProjectSwitcher triggerRef={projectTrigger} projects={data.projects.map(({ project }) => project)} selectedProjectId={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id ?? null} onSelect={(id) => { selectProject(id); window.scrollTo({ top: 0, behavior: "instant" }); }} onAddProject={() => setDialogOpen(true)} />
            ) : null}
            <h1 className={section !== "knowledge" && data.projects.length > 0 ? "sr-only sm:not-sr-only sm:min-w-0 sm:truncate sm:border-l sm:border-border sm:pl-3 sm:text-lg sm:font-semibold" : "min-w-0 truncate text-base font-semibold sm:text-lg"}>{sectionLabel}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <DropdownMenu open={systemOpen} onOpenChange={setSystemOpen}>
              <DropdownMenuTrigger asChild><Button ref={systemTrigger} variant="ghost" size="sm" aria-label={t("layout.system")} className="px-2 sm:px-3"><Gauge aria-hidden /><span className="hidden sm:inline">{t("layout.system")}</span>{(error || (!loading && !accessRequired && (data.mcp.phase === "stopped" || data.mcp.phase === "unknown"))) && <span className="size-2 rounded-full bg-destructive" aria-hidden />}</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(event) => { if (systemDialog) event.preventDefault(); }}>
                {!loading && !accessRequired && <DropdownMenuLabel>{dashboardSummary(locale, runningCount, data.projects.length)}</DropdownMenuLabel>}
                <DropdownMenuItem onSelect={() => setSystemDialog("capacity")}><Gauge aria-hidden />{t("capacity.openSettings")}<span className="ml-auto tabular-nums text-muted-foreground">{data.capacity.enabled ? `${data.capacity.used}/${data.capacity.limit}` : data.capacity.used}</span></DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSystemDialog("queue")}><TestTube2 aria-hidden />{t("tests.openSettings")}<span className="ml-auto tabular-nums text-muted-foreground">{data.testQueue.running}/{data.testQueue.limit}{data.testQueue.queued ? ` +${data.testQueue.queued}` : ""}</span></DropdownMenuItem>
                {knowledgeToken.startsWith("wts_") && <DropdownMenuItem onSelect={() => setSystemDialog("user-backups")}><Gauge aria-hidden />{t("userBackups.title")}</DropdownMenuItem>}
                {token.startsWith("wsi_") && <DropdownMenuItem onSelect={() => setSystemDialog("backups")}><Gauge aria-hidden />{t("backups.title")}</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => setSystemDialog("mcp")}><Radio aria-hidden />{t("mcp.openStatus")}<span className="ml-auto text-muted-foreground">{t(`mcp.phase.${data.mcp.phase}`)}</span></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu open={preferencesOpen} onOpenChange={setPreferencesOpen}>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t("layout.preferences")} className="px-2 sm:px-3"><Settings2 aria-hidden /><span className="hidden sm:inline">{t("layout.preferences")}</span></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => setLocale(locale === "pl" ? "en" : "pl")}><Languages aria-hidden />{t("language.label")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={toggleTheme}>{dark ? <Sun aria-hidden /> : <Moon aria-hidden />}{dark ? t("theme.light") : t("theme.dark")}</DropdownMenuItem>
                {knowledgeAccess === "scoped" && knowledgeToken && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => changeKnowledgeToken("")}><LogOut aria-hidden />{t("knowledge.disconnect")}</DropdownMenuItem></>}
                {token && token !== OPEN_ACCESS && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={signOut}><LogOut aria-hidden />{t("access.signOut")}</DropdownMenuItem></>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {section !== "knowledge" && data.projects.length > 0 && <p className="w-full truncate px-2 pb-0.5 text-xs font-medium text-muted-foreground sm:hidden">{sectionLabel}</p>}
        </header>
        {systemDialog === "user-backups" && <UserSchedulesDialog key={knowledgeToken} token={knowledgeToken} onOpenChange={next => setSystemDialog(next ? "user-backups" : null)} returnFocus={() => systemTrigger.current?.focus()} />}
        {systemDialog === "backups" && <BackupsDialog key={token} token={token} open onOpenChange={next => setSystemDialog(next ? "backups" : null)} returnFocus={() => systemTrigger.current?.focus()} />}
        <CapacityDialog status={data.capacity} mutate={mutate} setError={setError} open={systemDialog === "capacity"} onOpenChange={(next) => setSystemDialog(next ? "capacity" : null)} returnFocus={() => systemTrigger.current?.focus()} />
        <TestQueueDialog status={data.testQueue} mutate={mutate} setError={setError} open={systemDialog === "queue"} onOpenChange={(next) => setSystemDialog(next ? "queue" : null)} returnFocus={() => systemTrigger.current?.focus()} />
        <McpStatusDialog status={data.mcp} open={systemDialog === "mcp"} onOpenChange={(next) => setSystemDialog(next ? "mcp" : null)} returnFocus={() => systemTrigger.current?.focus()} />
        <AddProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} mutate={mutate} token={token} showTrigger={false} returnFocus={() => (projectTrigger.current ?? emptyAddTrigger.current ?? systemTrigger.current)?.focus()} />
        {data.authentication?.mode === "open" && <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs font-medium text-destructive sm:px-5">{t("access.openMode", { listen: data.authentication.listen })}</p>}
        {!loading && !accessRequired && (data.mcp.phase === "stopped" || data.mcp.phase === "unknown") && <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs font-medium text-destructive sm:px-5">{t("layout.mcpUnavailable", { state: t(`mcp.phase.${data.mcp.phase}`) })}</p>}

        <div className="mx-auto max-w-[1460px] px-3 py-4 sm:px-5 sm:py-5 lg:px-6">

        <div role="status" aria-live="polite" aria-atomic="true" className="fixed right-4 bottom-4 z-40 w-[calc(100%-2rem)] max-w-sm">
          {!error && notice && (
            <Alert variant="success" role="presentation" className="shadow-lg">
              <CheckCircle2 aria-hidden />
              <AlertDescription className="break-words">{notice}</AlertDescription>
              <AlertAction>
                <Button type="button" variant="ghost" size="icon-sm" onClick={dismissNotice} aria-label={t("common.close")}>
                  <X aria-hidden />
                </Button>
              </AlertAction>
            </Alert>
          )}
        </div>
        {error && (
          <Alert variant="destructive" className="mb-5">
            <AlertTriangle aria-hidden />
            <AlertTitle>{t("dashboard.operationError")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {accessRequired ? (
          <AccessTokenForm invalid={accessRequired === "invalid"} onSubmit={signIn} />
        ) : loading ? (
          <div className="grid place-items-center py-28 text-muted-foreground">
            <LoaderCircle className="mb-3 size-6 animate-spin motion-reduce:animate-none" aria-hidden />
            {t("dashboard.connecting")}
          </div>
        ) : section === "knowledge" ? (
          <KnowledgeDashboard key={knowledgeSessionVersion} token={knowledgeToken} setToken={changeKnowledgeToken} access={knowledgeAccess} change={knowledgeChange} />
        ) : data.projects.length === 0 ? (
          <EmptyState buttonRef={emptyAddTrigger} onAdd={() => setDialogOpen(true)} />
        ) : (
          <section id="projects" className="grid gap-7" aria-label={t("dashboard.projects")}>
            {section === "logs" ? <LogsDashboard key={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id} snapshots={allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []} aggregate={allProjects} /> : section === "resources" ? <ResourcesDashboard key={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id} snapshots={allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []} aggregate={allProjects} mutate={mutate} setError={setError} /> : section === "tests" ? <TestsDashboard now={observedAt} key={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id} snapshots={allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []} aggregate={allProjects} mutate={mutate} setError={setError} /> : allProjects && section === "worktrees" ? <AllProjectsWorktrees snapshots={data.projects} mutate={mutate} setError={setError} onOpenLogs={openFailedLogs} /> : (allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []).map((snapshot) => <ProjectCard key={snapshot.project.id} snapshot={snapshot} section={section} mutate={mutate} setError={setError} token={token} onOpenLogs={openFailedLogs} />)}
          </section>
        )}
        </div>
        <footer className="flex min-h-14 items-center justify-end border-t border-border px-4 text-xs text-muted-foreground sm:px-7 lg:px-8">
          Worktree Switcher
        </footer>
      </main>
    </SidebarProvider>
  );
}
