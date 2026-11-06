"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Mutate } from "@/features/control-client";
import { useI18n } from "@/i18n/provider";
import type { ProjectView, RuntimePhase } from "@/shared/contracts";
import { DEFAULT_GODOT_WEB_CONFIG, type GodotWebConfig } from "@/shared/contracts/godot-web";
import { Gamepad2, LoaderCircle } from "lucide-react";
import { type FormEvent, useState } from "react";

const TEXTAREA = "min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

interface Draft {
  kind: GodotWebConfig["exporter"]["kind"];
  preset: string;
  godotExecutable: string;
  command: string;
  outputDirectory: string;
  paths: string;
  ignore: string;
  debounceMs: string;
  liveReload: boolean;
  crossOriginIsolation: boolean;
}

function draftFrom(config: GodotWebConfig | null): Draft {
  const value = config ?? DEFAULT_GODOT_WEB_CONFIG;
  return {
    kind: value.exporter.kind,
    preset: value.exporter.kind === "preset" ? value.exporter.preset : "Web",
    godotExecutable: value.exporter.kind === "preset" ? value.exporter.godotExecutable : "godot",
    command: value.exporter.kind === "command" ? value.exporter.command.join("\n") : "",
    outputDirectory: value.exporter.kind === "command" ? value.exporter.outputDirectory : "",
    paths: value.watch.paths.join("\n"),
    ignore: value.watch.ignore.join("\n"),
    debounceMs: String(value.watch.debounceMs),
    liveReload: value.liveReload,
    crossOriginIsolation: value.crossOriginIsolation,
  };
}

/** Explicit Godot Web opt-in for stopped Godot projects; the server validates every field. */
export function GodotWebSettingsDialog({ project, phase, mutate, setError }: {
  project: ProjectView;
  phase: RuntimePhase;
  mutate: Mutate;
  setError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(project.godotWeb));
  const [pending, setPending] = useState<"save" | "disable" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const active = phase === "running" || phase === "starting" || phase === "stopping";
  const id = (name: string) => `godot-web-${name}-${project.id}`;
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const changeOpen = (next: boolean) => {
    // Each opening starts from the current saved configuration.
    if (next) { setDraft(draftFrom(project.godotWeb)); setFormError(null); }
    setOpen(next);
  };

  const submit = async (config: unknown, kind: "save" | "disable", message: string) => {
    setPending(kind);
    setFormError(null);
    try {
      await mutate(`/api/projects/${project.id}/godot-web`, { config }, message);
      setOpen(false);
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setFormError(text);
      setError(text);
    } finally {
      setPending(null);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const debounceMs = Number(draft.debounceMs);
    if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 10_000) { setFormError(t("godotWeb.invalidNumber")); return; }
    const exporter = draft.kind === "preset"
      ? { kind: "preset", preset: draft.preset.trim(), godotExecutable: draft.godotExecutable.trim() || "godot" }
      : { kind: "command", command: lines(draft.command), outputDirectory: draft.outputDirectory.trim() };
    void submit({
      exporter,
      watch: { paths: lines(draft.paths).length ? lines(draft.paths) : ["."], ignore: lines(draft.ignore), debounceMs },
      liveReload: draft.liveReload,
      crossOriginIsolation: draft.crossOriginIsolation,
    }, "save", t("godotWeb.saved", { name: project.name }));
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t("godotWeb.settings")} title={t("godotWeb.settings")}>
          <Gamepad2 aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("godotWeb.title")}</DialogTitle>
          <DialogDescription>{t("godotWeb.description")}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-4" onSubmit={save}>
          <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-1">
            <div className="space-y-2">
              <Label htmlFor={id("exporter")}>{t("godotWeb.exporter")}</Label>
              <Select value={draft.kind} onValueChange={(value) => update("kind", value as Draft["kind"])}>
                <SelectTrigger id={id("exporter")} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="preset">{t("godotWeb.exporterPreset")}</SelectItem>
                  <SelectItem value="command">{t("godotWeb.exporterCommand")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.kind === "preset" ? <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor={id("preset")}>{t("godotWeb.presetName")}</Label>
                <Input id={id("preset")} value={draft.preset} onChange={(event) => update("preset", event.target.value)} required maxLength={80} /></div>
              <div className="space-y-2"><Label htmlFor={id("godot")}>{t("godotWeb.godotExecutable")}</Label>
                <Input id={id("godot")} className="font-mono" value={draft.godotExecutable} onChange={(event) => update("godotExecutable", event.target.value)} maxLength={255} /></div>
            </div> : <>
              <div className="space-y-2"><Label htmlFor={id("command")}>{t("godotWeb.command")}</Label>
                <textarea id={id("command")} className={TEXTAREA} value={draft.command} onChange={(event) => update("command", event.target.value)} required aria-describedby={id("command-hint")} />
                <p id={id("command-hint")} className="text-xs text-muted-foreground">{t("godotWeb.commandHint")}</p></div>
              <div className="space-y-2"><Label htmlFor={id("output")}>{t("godotWeb.outputDirectory")}</Label>
                <Input id={id("output")} className="font-mono" value={draft.outputDirectory} onChange={(event) => update("outputDirectory", event.target.value)} required maxLength={240} placeholder="exports/web" /></div>
            </>}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor={id("paths")}>{t("godotWeb.watchPaths")}</Label>
                <textarea id={id("paths")} className={TEXTAREA} value={draft.paths} onChange={(event) => update("paths", event.target.value)} aria-describedby={id("watch-hint")} /></div>
              <div className="space-y-2"><Label htmlFor={id("ignore")}>{t("godotWeb.watchIgnore")}</Label>
                <textarea id={id("ignore")} className={TEXTAREA} value={draft.ignore} onChange={(event) => update("ignore", event.target.value)} aria-describedby={id("watch-hint")} /></div>
            </div>
            <p id={id("watch-hint")} className="text-xs text-muted-foreground">{t("godotWeb.watchHint")}</p>
            <div className="space-y-2 sm:w-48"><Label htmlFor={id("debounce")}>{t("godotWeb.debounce")}</Label>
              <Input id={id("debounce")} type="number" min={100} max={10000} value={draft.debounceMs} onChange={(event) => update("debounceMs", event.target.value)} /></div>
            <div className="flex items-center gap-3">
              <Switch id={id("reload")} checked={draft.liveReload} onCheckedChange={(value) => update("liveReload", value)} />
              <Label htmlFor={id("reload")}>{t("godotWeb.liveReload")}</Label>
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <Switch id={id("isolation")} checked={draft.crossOriginIsolation} onCheckedChange={(value) => update("crossOriginIsolation", value)} aria-describedby={id("isolation-hint")} />
                <Label htmlFor={id("isolation")}>{t("godotWeb.isolation")}</Label>
              </div>
              <p id={id("isolation-hint")} className="text-xs text-muted-foreground">{t("godotWeb.isolationHint")}</p>
            </div>
            {active && <p className="text-sm text-warning-foreground" role="status">{t("godotWeb.stopFirst")}</p>}
            {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {project.launchPreset === "godot-web" && <Button type="button" variant="outline" disabled={active || pending !== null}
              onClick={() => void submit(null, "disable", t("godotWeb.disabled", { name: project.name }))}>
              {pending === "disable" && <LoaderCircle className="animate-spin" aria-hidden />}{t("godotWeb.disable")}
            </Button>}
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={active || pending !== null}>{pending === "save" && <LoaderCircle className="animate-spin" aria-hidden />}{t("godotWeb.save")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
