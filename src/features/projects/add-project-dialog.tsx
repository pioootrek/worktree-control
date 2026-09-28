"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DirectoryPicker } from "@/features/projects/directory-picker";
import { useI18n } from "@/i18n/provider";
import type { LaunchPreset } from "@/shared/contracts";
import { LoaderCircle, Plus } from "lucide-react";
import { FormEvent, useState } from "react";

import type { Mutate } from "@/features/control-client";

export function AddProjectDialog({ open, onOpenChange, mutate, token, showTrigger = true, returnFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mutate: Mutate;
  token: string;
  showTrigger?: boolean;
  returnFocus?: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [launchPreset, setLaunchPreset] = useState<LaunchPreset>("auto");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);
    try {
      await mutate("/api/projects", {
        name: String(form.get("name") ?? ""),
        repositoryPath: String(form.get("repositoryPath") ?? ""),
        port: Number(form.get("port")),
        launchPreset,
      }, t("add.success"));
      setRepositoryPath("");
      setLaunchPreset("auto");
      onOpenChange(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {showTrigger && <DialogTrigger asChild><Button><Plus aria-hidden />{t("add.trigger")}</Button></DialogTrigger>}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-xl" onCloseAutoFocus={returnFocus ? (event) => { event.preventDefault(); returnFocus(); } : undefined}>
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>
          <DialogDescription>{t("add.description")}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-1">
          <div className="space-y-2"><Label htmlFor="name">{t("add.name")}</Label><Input id="name" name="name" placeholder="Frontend" required maxLength={80} /></div>
          <div className="space-y-2">
            <Label htmlFor="repositoryPath">{t("add.repositoryPath")}</Label>
            <DirectoryPicker token={token} value={repositoryPath} onChange={setRepositoryPath} />
          </div>
          <div className="space-y-2"><Label htmlFor="port">{t("add.port")}</Label><Input id="port" name="port" type="number" defaultValue="3000" min="1024" max="65535" required /></div>
          <div className="space-y-2">
            <Label htmlFor="launch-preset">{t("add.preset")}</Label>
            <Select value={launchPreset} onValueChange={(value) => setLaunchPreset(value as LaunchPreset)}>
              <SelectTrigger id="launch-preset" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("preset.auto")}</SelectItem>
                <SelectItem value="node">{t("preset.node")}</SelectItem>
                <SelectItem value="django">{t("preset.django")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">{t("add.commandHint")}</p>
          {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
          </div>
          <div className="flex shrink-0 justify-end gap-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin" aria-hidden />}{t("add.submit")}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
