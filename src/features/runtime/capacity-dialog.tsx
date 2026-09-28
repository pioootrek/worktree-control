"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";
import type { ServerCapacityStatus } from "@/shared/contracts";
import { Gauge, LoaderCircle } from "lucide-react";
import { FormEvent, useState } from "react";

import type { Mutate } from "@/features/control-client";

export function CapacityDialog({
  status,
  mutate,
  setError,
  open: controlledOpen,
  onOpenChange,
  returnFocus,
}: {
  status: ServerCapacityStatus;
  mutate: Mutate;
  setError: (message: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isOpen = controlledOpen ?? open;
  const [enabled, setEnabled] = useState(status.enabled);
  const [limit, setLimit] = useState(String(status.limit));
  const [pending, setPending] = useState(false);

  const changeOpen = (next: boolean) => {
    if (next) {
      setEnabled(status.enabled);
      setLimit(String(status.limit));
    }
    if (onOpenChange) onOpenChange(next);
    else setOpen(next);
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
      changeOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={changeOpen}>
      {controlledOpen === undefined && <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label={t("capacity.openSettings")}>
          <Gauge aria-hidden />
          {status.enabled ? `${status.used}/${status.limit}` : status.used}
        </Button>
      </DialogTrigger>}
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={returnFocus ? (event) => { event.preventDefault(); returnFocus(); } : undefined}>
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
          <div className="rounded-lg border bg-muted/50 p-3 text-sm">
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
