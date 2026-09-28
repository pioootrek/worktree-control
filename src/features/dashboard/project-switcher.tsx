"use client";

import { ALL_PROJECTS } from "./project-selection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n/provider";
import type { ProjectView } from "@/shared/contracts";
import { Check, ChevronsUpDown, FolderGit2, Layers, Plus, Search } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { type Ref, useId, useRef, useState } from "react";

const PROJECT_LIST_ID = "global-project-switcher-list";

interface ProjectSwitcherProps {
  projects: ProjectView[];
  selectedProjectId: string | null;
  onSelect: (projectId: string) => void;
  onAddProject?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
}

export function ProjectSwitcher({ projects, selectedProjectId, onSelect, onAddProject, triggerRef }: ProjectSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const openingProjectDialog = useRef(false);
  const labelId = useId();
  const valueId = useId();
  const options = [{ id: ALL_PROJECTS, name: t("projectSwitcher.all"), repositoryPath: t("aggregate.projectCount", { count: projects.length }) }, ...projects];
  const selected = options.find((project) => project.id === selectedProjectId) ?? projects[0];
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = options.filter((project) => `${project.name} ${project.repositoryPath}`.toLocaleLowerCase().includes(normalized));

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <PopoverPrimitive.Trigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          aria-controls={PROJECT_LIST_ID}
          aria-labelledby={`${labelId} ${valueId}`}
          className="h-10 min-w-0 max-w-[min(24rem,calc(100vw-9rem))] justify-start gap-2 rounded-md px-2 text-left hover:bg-accent/70 sm:px-3"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/10 text-foreground">
            {selected?.id === ALL_PROJECTS ? <Layers className="size-4" aria-hidden /> : <FolderGit2 className="size-4" aria-hidden />}
          </span>
          <span className="min-w-0 flex-1">
            <span id={labelId} className="block truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{t("projectSwitcher.label")}</span>
            <span id={valueId} className="block truncate text-sm font-semibold">{selected?.name ?? t("projectSwitcher.none")}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={8}
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl outline-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => { if (openingProjectDialog.current) { event.preventDefault(); openingProjectDialog.current = false; } }}
        >
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("projectSwitcher.search")}
              aria-label={t("projectSwitcher.search")}
              aria-controls={PROJECT_LIST_ID}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                event.preventDefault();
                document.querySelector<HTMLButtonElement>(`#${PROJECT_LIST_ID} [role="option"]`)?.focus();
              }}
              className="h-10 pl-9"
            />
          </div>
          <div id={PROJECT_LIST_ID} role="listbox" aria-label={t("projectSwitcher.projects")} className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("projectSwitcher.noResults")}</p>
            ) : filtered.map((project) => {
              const active = project.id === selected?.id;
              return (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => { onSelect(project.id); setOpen(false); setQuery(""); }}
                  onKeyDown={(event) => {
                    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const options = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
                    const current = options.indexOf(event.currentTarget);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowDown"
                      ? Math.min(current + 1, options.length - 1)
                      : Math.max(current - 1, 0);
                    options[next]?.focus();
                  }}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-muted/60 text-muted-foreground">
                    {project.id === ALL_PROJECTS ? <Layers className="size-4" aria-hidden /> : <FolderGit2 className="size-4" aria-hidden />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">{project.name}</span>
                    <span className="block break-all font-mono text-[11px] text-muted-foreground">{project.repositoryPath}</span>
                  </span>
                  <Check className={active ? "size-4 text-primary" : "size-4 opacity-0"} aria-hidden />
                </button>
              );
            })}
          </div>
          {onAddProject && <button type="button" onClick={() => { openingProjectDialog.current = true; setOpen(false); onAddProject(); }} className="mt-2 flex h-10 w-full items-center gap-2 rounded-md border-t px-3 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><Plus className="size-4" aria-hidden />{t("add.trigger")}</button>}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
