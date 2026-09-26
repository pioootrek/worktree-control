"use client";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { EmptyState } from "@/features/dashboard/empty-state";
import { ThemeToggle } from "@/features/dashboard/theme-toggle";
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
import { AlertTriangle, CheckCircle2, Languages, LoaderCircle, LogOut, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ProjectNavigation, projectSections, type ProjectSection } from "./project-navigation";
import { ProjectSwitcher } from "./project-switcher";
import { AllProjectsWorktrees } from "@/features/projects/all-projects-worktrees";
import { ALL_PROJECTS, useProjectSelection } from "./project-selection";
import { KnowledgeDashboard } from "@/features/knowledge/knowledge-dashboard";
import { AccessTokenForm } from "./access-token-form";
import { useDashboard } from "./use-dashboard";

export function Dashboard() {
  const { locale, setLocale, t } = useI18n();
  const { data, observedAt, token, accessRequired, signIn, signOut, loading, error, notice, dismissNotice, mutate, setError, runningCount, knowledgeToken, knowledgeSessionVersion, changeKnowledgeToken, knowledgeChange } = useDashboard();
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

  return (
    <SidebarProvider>
      <ProjectNavigation section={section} projectName={allProjects ? t("projectSwitcher.all") : selectedSnapshot?.project.name} onSelect={selectSection} />
      <main className="min-w-0 flex-1">
        <header className="z-30 flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-border bg-background/92 px-4 py-3 backdrop-blur-xl sm:px-7 sticky top-0 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger aria-label={t("dashboard.toggleNavigation")} />
            {data.projects.length > 0 ? (
              <ProjectSwitcher projects={data.projects.map(({ project }) => project)} selectedProjectId={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id ?? null} onSelect={(id) => { selectProject(id); window.scrollTo({ top: 0, behavior: "instant" }); }} />
            ) : <h1 className="truncate text-sm font-medium">Worktree Switcher</h1>}
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <Badge variant="outline" className="h-9 gap-2 px-3 font-normal">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              {dashboardSummary(locale, runningCount, data.projects.length)}
            </Badge>
            <CapacityDialog status={data.capacity} mutate={mutate} setError={setError} />
            <TestQueueDialog status={data.testQueue} mutate={mutate} setError={setError} />
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
            {token && <Button variant="outline" size="sm" onClick={signOut}><LogOut aria-hidden />{t("access.signOut")}</Button>}
            <AddProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} mutate={mutate} token={token} />
          </div>
        </header>

        <div className="mx-auto max-w-[1460px] px-4 py-7 sm:px-7 lg:px-8 lg:py-9">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>

              <h2 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">{t(projectSections.find((item) => item.id === section)!.label)}</h2>
            </div>

          </div>

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
          <KnowledgeDashboard key={knowledgeSessionVersion} token={knowledgeToken} setToken={changeKnowledgeToken} change={knowledgeChange} />
        ) : data.projects.length === 0 ? (
          <EmptyState onAdd={() => setDialogOpen(true)} />
        ) : (
          <section id="projects" className="grid gap-7" aria-label={t("dashboard.projects")}>
            {section === "logs" ? <LogsDashboard key={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id} snapshots={allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []} aggregate={allProjects} /> : section === "resources" ? <ResourcesDashboard key={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id} snapshots={allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []} aggregate={allProjects} mutate={mutate} setError={setError} /> : section === "tests" ? <TestsDashboard now={observedAt} key={allProjects ? ALL_PROJECTS : selectedSnapshot?.project.id} snapshots={allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []} aggregate={allProjects} mutate={mutate} setError={setError} /> : allProjects && section === "worktrees" ? <AllProjectsWorktrees snapshots={data.projects} mutate={mutate} setError={setError} /> : (allProjects ? data.projects : selectedSnapshot ? [selectedSnapshot] : []).map((snapshot) => <ProjectCard key={snapshot.project.id} snapshot={snapshot} section={section} mutate={mutate} setError={setError} token={token} />)}
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
