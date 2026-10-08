"use client";

import { Sidebar, SidebarContent, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useI18n } from "@/i18n/provider";
import { BookOpen, FlaskConical, GitBranch, HardDrive, ScrollText } from "lucide-react";

export type ProjectSection = "worktrees" | "tests" | "resources" | "logs" | "knowledge";

export const projectSections = [
  { id: "worktrees", label: "dashboard.navWorktrees", icon: GitBranch },
  { id: "tests", label: "dashboard.navTests", icon: FlaskConical },
  { id: "resources", label: "dashboard.navResources", icon: HardDrive },
  { id: "logs", label: "project.logs", icon: ScrollText },
  { id: "knowledge", label: "knowledge.title", icon: BookOpen },
] as const;

export function ProjectNavigation({ section, onSelect, projectName }: {
  section: ProjectSection;
  onSelect: (section: ProjectSection) => void;
  projectName?: string;
}) {
  const { t } = useI18n();
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon" mobileTitle={t("dashboard.navigation")} mobileDescription={section === "knowledge" ? t("knowledge.project") : projectName ?? t("projectSwitcher.none")} closeLabel={t("common.close")}>
      <SidebarHeader className="h-14 justify-center border-b border-sidebar-border px-3 group-data-[collapsible=icon]:px-2">
        <div className="flex items-center gap-2 pr-3 text-foreground">
          <GitBranch className="size-5 shrink-0" aria-hidden />
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">Worktree Control</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <nav aria-label={t("dashboard.navigation")}>
            <SidebarMenu>
              {projectSections.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    type="button"
                    isActive={section === id && (!!projectName || id === "knowledge" || id === "resources" || id === "worktrees")}
                    aria-current={section === id && (projectName || id === "knowledge" || id === "resources" || id === "worktrees") ? "page" : undefined}
                    aria-label={t(label)}
                    tooltip={t(label)}
                    disabled={!projectName && id !== "knowledge" && id !== "resources" && id !== "worktrees"}
                    className="h-10 data-active:border-l-2 data-active:border-primary data-active:bg-sidebar-accent data-active:text-foreground"
                    onClick={() => { onSelect(id); setOpenMobile(false); }}
                  >
                    <Icon aria-hidden /><span>{t(label)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
