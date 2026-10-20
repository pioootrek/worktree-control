"use client";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/provider";
import type { RuntimePhase } from "@/shared/contracts";
import { Activity, LoaderCircle } from "lucide-react";

export function RuntimeBadge({ phase, noServer = false }: { phase: RuntimePhase; noServer?: boolean }) {
  const { t } = useI18n();
  const active = !noServer && phase === "running";
  const busy = !noServer && (phase === "starting" || phase === "stopping");
  return (
    <Badge variant="outline" className={active ? "border-success-foreground/25 bg-success text-success-foreground" : !noServer && phase === "failed" ? "border-destructive/25 text-destructive" : "text-muted-foreground"}>
      {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Activity aria-hidden />}
      {noServer ? t("project.noServer") : t(`phase.${phase}`)}
    </Badge>
  );
}
