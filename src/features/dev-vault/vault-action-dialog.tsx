"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import { LoaderCircle } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { vaultErrorMessage } from "./vault-messages";
import { VaultClientError } from "./vault-model";

/**
 * A focused confirmation for one signed owner operation. It stays open while signing and shows
 * fixed failure text in place; on success the panel refreshes and focus falls back if the row left.
 */
export function VaultActionDialog({
  trigger, title, description, children, confirmLabel, confirmVariant = "default", confirmDisabled = false,
  action, changed, focusFallback, onOpenChange, wide = false,
}: {
  trigger: { label: string; icon?: ReactNode; variant?: ComponentProps<typeof Button>["variant"]; disabled?: boolean; describedBy?: string };
  title: string;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ComponentProps<typeof Button>["variant"];
  confirmDisabled?: boolean;
  action: () => Promise<string>;
  changed: (message: string) => Promise<void>;
  focusFallback: () => void;
  onOpenChange?: (open: boolean) => void;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    setError(null);
    onOpenChange?.(next);
  };
  const confirm = async () => {
    setPending(true);
    setError(null);
    let message: string;
    try {
      message = await action();
    } catch (cause) {
      const code = cause instanceof VaultClientError ? cause.code : "vault_unavailable";
      setError(vaultErrorMessage(t, code));
      setPending(false);
      return;
    }
    setPending(false);
    setOpen(false);
    onOpenChange?.(false);
    await changed(message);
    // The refreshed list may no longer contain this row; never leave focus on a detached trigger.
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) focusFallback();
    });
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button type="button" variant={trigger.variant ?? "outline"} size="sm" disabled={trigger.disabled} aria-describedby={trigger.describedBy}>{trigger.icon}{trigger.label}</Button>
      </DialogTrigger>
      <DialogContent className={wide ? "sm:max-w-2xl" : "sm:max-w-lg"} closeLabel={t("common.close")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild><div className="grid gap-2">{description}</div></DialogDescription>
        </DialogHeader>
        {children}
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => change(false)} disabled={pending}>{t("common.cancel")}</Button>
          <Button type="button" variant={confirmVariant} onClick={() => void confirm()} disabled={pending || confirmDisabled}>
            {pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}{confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
