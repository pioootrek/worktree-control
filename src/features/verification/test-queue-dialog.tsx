"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { TestQueueStatus } from "@/shared/contracts";
import { LoaderCircle, TestTube2 } from "lucide-react";
import { FormEvent, useState } from "react";

import type { Mutate } from "@/features/control-client";

interface TestQueueDialogProps {
  status: TestQueueStatus;
  mutate: Mutate;
  setError: (message: string | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: () => void;
}

export function TestQueueDialog({ status, mutate, setError, open: controlledOpen, onOpenChange, returnFocus }: TestQueueDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isOpen = controlledOpen ?? open;
  const changeOpen = (next: boolean) => {
    if (onOpenChange) onOpenChange(next);
    else setOpen(next);
  };

  return <Dialog open={isOpen} onOpenChange={changeOpen}>
    {controlledOpen === undefined && <DialogTrigger asChild>
      <Button variant="outline" size="sm" className="gap-2" aria-label={t("tests.openSettings")}><TestTube2 aria-hidden />{status.running}/{status.limit}{status.queued > 0 && <Badge variant="secondary">+{status.queued}</Badge>}</Button>
    </DialogTrigger>}
    <DialogContent className="sm:max-w-lg" onCloseAutoFocus={returnFocus ? (event) => { event.preventDefault(); returnFocus(); } : undefined}>
      <DialogHeader><DialogTitle>{t("tests.queueTitle")}</DialogTitle><DialogDescription>{t("tests.queueDescription")}</DialogDescription></DialogHeader>
      <TestQueueForm key={isOpen ? "open" : "closed"} status={status} mutate={mutate} setError={setError} close={() => changeOpen(false)} />
    </DialogContent>
  </Dialog>;
}

function TestQueueForm({ status, mutate, setError, close }: Pick<TestQueueDialogProps, "status" | "mutate" | "setError"> & { close: () => void }) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(String(status.limit));
  const [pending, setPending] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      await mutate("/api/settings/test-queue", { limit: Number(limit) }, t("tests.queueSaved"));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return <form className="space-y-5" onSubmit={(event) => void save(event)}>
    <div className="space-y-2"><Label htmlFor="test-queue-limit">{t("tests.limit")}</Label><Input id="test-queue-limit" type="number" min="1" max="16" value={limit} onChange={(event) => setLimit(event.target.value)} required /></div>
    <p className="rounded-lg border bg-muted/50 p-3 text-sm">{t("tests.queueUsage", { running: status.running, queued: status.queued })}</p>
    <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={close}>{t("common.cancel")}</Button><Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("common.save")}</Button></div>
  </form>;
}
