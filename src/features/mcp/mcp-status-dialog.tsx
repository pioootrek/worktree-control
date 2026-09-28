"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { McpStatus } from "@/shared/contracts";
import { AlertTriangle, Radio, ShieldCheck } from "lucide-react";

import { Metric } from "@/components/metric";

export function McpStatusDialog({ status, open, onOpenChange, returnFocus }: { status: McpStatus; open?: boolean; onOpenChange?: (open: boolean) => void; returnFocus?: () => void }) {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open === undefined && <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label={t("mcp.openStatus")}>
          <Radio aria-hidden />
          MCP
          <span
            className={`size-2 rounded-full ${running ? "bg-emerald-400" : "bg-muted-foreground"}`}
            aria-hidden
          />
        </Button>
      </DialogTrigger>}
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={returnFocus ? (event) => { event.preventDefault(); returnFocus(); } : undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="size-5 text-indigo-300" aria-hidden />
            {t("mcp.title")}
          </DialogTitle>
          <DialogDescription>{t("mcp.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant={running ? "success" : "default"}>
            {running ? <ShieldCheck aria-hidden /> : <AlertTriangle aria-hidden />}
            <AlertTitle>{t(`mcp.phase.${status.phase}`)}</AlertTitle>
            <AlertDescription>{description}</AlertDescription>
          </Alert>

          <dl className="grid grid-cols-2 gap-x-5 gap-y-4 text-sm">
            <Metric label={t("mcp.sessions")} value={String(status.activeSessions)} />
            <Metric label={t("mcp.transport")} value={t("mcp.streamableHttp")} />
            <Metric label={t("mcp.network")} value={t("mcp.loopback")} />
            <Metric label={t("mcp.authentication")} value={t(status.authentication === "none" ? "mcp.noAuthentication" : "mcp.bearerToken")} />
          </dl>

          <div className="space-y-2">
            <Label>{t("mcp.endpoint")}</Label>
            <div className="overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
              {status.endpoint ?? "—"}
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("mcp.clientConfig")}</Label>
            <div className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground">
              worktree-switcher config mcp
            </div>
            <p className="text-xs text-muted-foreground">{t("mcp.securityHint")}</p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
