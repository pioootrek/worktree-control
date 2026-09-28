"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import type { Mutate } from "@/features/control-client";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { WorktreeOverview } from "./worktree-overview";

export function AllProjectsWorktrees({ snapshots, mutate, setError, onOpenLogs }: {
  snapshots: ProjectSnapshot[];
  mutate: Mutate;
  setError: (message: string | null) => void;
  onOpenLogs: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<{ projectId: string; path: string | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = async (snapshot: ProjectSnapshot, path: string, kind: "operation" | "reservation", action: string) => {
    setPending({ projectId: snapshot.project.id, path: kind === "operation" ? path : null });
    try {
      await mutate(`/api/projects/${snapshot.project.id}/${kind}`,
        { [kind === "operation" ? "operation" : "action"]: action, worktreePath: path }, t("aggregate.updated", { name: snapshot.project.name }));
    } catch (cause) {
      setError(`${snapshot.project.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setPending(null);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    const failures: string[] = [];
    try {
      // Bound metadata work: refresh one project at a time, retaining successes.
      for (const snapshot of snapshots) {
        try { await mutate(`/api/projects/${snapshot.project.id}/metadata/refresh`, {}, t("metadata.refreshed", { name: snapshot.project.name })); }
        catch { failures.push(snapshot.project.name); }
      }
      if (failures.length) setError(t("aggregate.refreshFailed", { projects: failures.join(", ") }));
    } finally {
      setRefreshing(false);
    }
  };
  return <Card data-all-projects className="min-w-0 shadow-none">
    <CardContent className="space-y-4">
      {snapshots.map((snapshot) => {
        const error = snapshot.discoveryError || snapshot.runtime.error || snapshot.metadata?.error;
        return error ? <Alert key={snapshot.project.id} variant="warning"><AlertTitle>{snapshot.project.name}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null;
      })}
      <WorktreeOverview snapshots={snapshots} aggregate busy={pending !== null} refreshing={refreshing || snapshots.some((s) => s.metadata?.status === "refreshing")} onRefresh={() => void refresh()} onOpenLogs={onOpenLogs}
        rowActions={(snapshot) => ({
          busy: pending !== null || refreshing || ["starting", "stopping"].includes(snapshot.runtime.phase),
          pendingPath: pending?.projectId === snapshot.project.id ? pending.path : null,
          onOperate: (operation, path) => void request(snapshot, path, "operation", operation),
          onReserve: (action, path) => void request(snapshot, path, "reservation", action),
        })} />
    </CardContent>
  </Card>;
}
