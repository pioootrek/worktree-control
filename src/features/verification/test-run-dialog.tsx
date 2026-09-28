"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play } from "lucide-react";
import type { Mutate } from "@/features/control-client";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { TestPanel } from "./test-panel";

export function TestRunDialog({ snapshots, mutate, setError }: {
  snapshots: ProjectSnapshot[]; mutate: Mutate; setError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button disabled={!snapshots.length}><Play aria-hidden />{t("tests.run")}</Button></DialogTrigger>
    <DialogContent closeLabel={t("common.close")} className="sm:max-w-lg">
      <DialogHeader><DialogTitle>{t("tests.run")}</DialogTitle><DialogDescription>{t("testView.runDescription")}</DialogDescription></DialogHeader>
      {open ? <RunForm snapshots={snapshots} mutate={mutate} setError={setError} onQueued={() => setOpen(false)} /> : null}
    </DialogContent>
  </Dialog>;
}

function RunForm({ snapshots, mutate, setError, onQueued }: {
  snapshots: ProjectSnapshot[]; mutate: Mutate; setError: (message: string | null) => void; onQueued: () => void;
}) {
  const { t } = useI18n();
  const [projectId, setProjectId] = useState(snapshots[0]?.project.id ?? "");
  const snapshot = snapshots.find((s) => s.project.id === projectId) ?? snapshots[0];
  const [path, setPath] = useState("");
  const candidates = snapshot.worktrees.filter((w) => !w.prunable);
  const selected = candidates.find((w) => w.path === path) ?? candidates.find((w) => w.path === snapshot.project.selectedWorktreePath) ?? candidates[0];
  const presets = snapshot.testPresets.find((entry) => entry.worktreePath === selected?.path);
  return <div className="min-w-0 space-y-4">
    <div className="space-y-2"><Label htmlFor="run-project">{t("aggregate.project")}</Label>
      <Select value={snapshot.project.id} onValueChange={(id) => { setProjectId(id); setPath(""); }}>
        <SelectTrigger id="run-project" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{snapshots.map((s) => <SelectItem key={s.project.id} value={s.project.id}>{s.project.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="space-y-2"><Label htmlFor="run-worktree">{t("testView.worktree")}</Label>
      <Select value={selected?.path ?? ""} onValueChange={setPath} disabled={!candidates.length}>
        <SelectTrigger id="run-worktree" className="w-full min-w-0 *:data-[slot=select-value]:min-w-0"><SelectValue placeholder={t("project.noWorktree")} /></SelectTrigger>
        <SelectContent position="popper" className="max-w-[calc(100vw-2rem)]">{candidates.map((w) => <SelectItem key={w.path} value={w.path}><span className="truncate" title={w.path}>{w.branch ?? "detached HEAD"} · {w.shortHead}</span></SelectItem>)}</SelectContent>
      </Select>
    </div>
    <TestPanel key={JSON.stringify([snapshot.project.id, selected?.path])} projectId={snapshot.project.id} worktreePath={selected?.path ?? ""} profiles={snapshot.project.testEnvironmentProfiles} presets={presets?.presets ?? []} discoveryError={presets?.error ?? snapshot.discoveryError ?? null} mutate={mutate} setError={setError} onQueued={onQueued} />
  </div>;
}
