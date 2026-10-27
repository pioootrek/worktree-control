"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { DEV_DOTENV_BYTES } from "@/shared/contracts/dev-vault";
import { Eye, EyeOff, FileUp, LoaderCircle } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import type { RunVault } from "./owner-session";
import { VaultActionDialog } from "./vault-action-dialog";
import { vaultErrorMessage } from "./vault-messages";
import { VaultClientError, vaultProfileSchema, vaultReadSchema, type VaultProfile } from "./vault-model";

interface Revealed { profileId: string; revision: number; entries: Array<[string, string]> }

export function ProfilesPanel({ profiles, run, changed, focusFallback }: {
  profiles: VaultProfile[];
  run: RunVault;
  changed: (message: string) => Promise<void>;
  focusFallback: () => void;
}) {
  const { t, locale } = useI18n();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const date = (value: string) => new Date(value).toLocaleString(locale);
  // Values from an older revision or a removed profile are never kept beside current metadata.
  const visible = revealed && profiles.some(profile => profile.profileId === revealed.profileId && profile.revision === revealed.revision) ? revealed : null;

  return (
    <section className="grid gap-3" aria-labelledby="vault-profiles-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="vault-profiles-heading" className="text-sm font-semibold">{t("vault.profiles", { count: profiles.length })}</h4>
        <ImportProfileDialog run={run} changed={changed} />
      </div>
      {profiles.length === 0 ? <p className="text-sm text-muted-foreground">{t("vault.noProfiles")}</p> : (
        <ul className="grid gap-2">
          {profiles.map(profile => {
            const shown = visible?.profileId === profile.profileId ? visible : null;
            return (
              <li key={profile.profileId} className="grid gap-3 rounded-lg border border-border p-3" data-vault-profile={profile.profileId}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <dl className="grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-muted-foreground">{t("vault.profileId")}</dt><dd className="break-all font-mono text-xs">{profile.profileId}</dd>
                    <dt className="text-muted-foreground">{t("vault.revision")}</dt><dd>{profile.revision}</dd>
                    <dt className="text-muted-foreground">{t("vault.updated")}</dt><dd>{date(profile.updatedAt)}</dd>
                    <dt className="text-muted-foreground">{t("vault.environment")}</dt><dd>{t("vault.devOnly")}</dd>
                  </dl>
                  {shown ? (
                    <Button type="button" variant="outline" size="sm" data-vault-hide onClick={() => setRevealed(null)}><EyeOff aria-hidden />{t("vault.hideValues")}</Button>
                  ) : (
                    <VaultActionDialog
                      trigger={{ label: t("vault.revealValues"), icon: <Eye aria-hidden /> }}
                      title={t("vault.revealTitle")}
                      description={<><p>{t("vault.revealDescription", { profile: profile.profileId, revision: profile.revision })}</p><p>{t("vault.revealWarning")}</p></>}
                      confirmLabel={t("vault.revealConfirm")}
                      action={async () => {
                        const parsed = vaultReadSchema.safeParse(await run(`read:${profile.profileId}:${profile.revision}`, { operation: "read", profileId: profile.profileId, revision: profile.revision }));
                        if (!parsed.success) throw new VaultClientError("invalid_response");
                        setRevealed({ profileId: parsed.data.profileId, revision: parsed.data.revision, entries: Object.entries(parsed.data.environment) });
                        return "";
                      }}
                      changed={async () => undefined}
                      focusFallback={() => {
                        const hide = document.querySelector<HTMLElement>(`[data-vault-profile="${profile.profileId}"] [data-vault-hide]`);
                        if (hide) hide.focus(); else focusFallback();
                      }}
                    />
                  )}
                </div>
                {shown && (
                  <div className="grid gap-2 rounded-md bg-muted/50 p-3" role="region" aria-label={t("vault.valuesRegion", { revision: shown.revision })} data-vault-values>
                    <p className="text-xs text-muted-foreground">{t("vault.valuesShown", { revision: shown.revision })}</p>
                    {shown.entries.length === 0 ? <p className="text-sm">{t("vault.noVariables")}</p> : (
                      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
                        {shown.entries.map(([name, value]) => <div key={name} className="contents">
                          <dt className="break-all font-mono text-xs font-medium">{name}</dt>
                          <dd className="break-all font-mono text-xs">{value === "" ? <span className="text-muted-foreground">{t("vault.emptyValue")}</span> : value}</dd>
                        </div>)}
                      </dl>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Imports one DEV .env. The draft lives only in this dialog and is cleared when it closes. */
function ImportProfileDialog({ run, changed }: { run: RunVault; changed: (message: string) => Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [fileText, setFileText] = useState<{ name: string; bytes: number; text: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reset = () => {
    setText(""); setFileText(null); setConfirmed(false); setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };
  const change = (next: boolean) => {
    if (pending) return;
    reset();
    setOpen(next);
  };
  const chooseFile = async (file: File | undefined) => {
    setError(null);
    if (!file) { setFileText(null); return; }
    if (file.size > DEV_DOTENV_BYTES) {
      if (fileInput.current) fileInput.current.value = "";
      setFileText(null);
      setError(t("vault.importTooLarge"));
      return;
    }
    // The selected file is sent as-is and never echoed into an editable field.
    const content = await file.text();
    setFileText({ name: file.name, bytes: new TextEncoder().encode(content).length, text: content });
    setText("");
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const dotenv = fileText?.text ?? text;
    setError(null);
    if (!dotenv.trim()) { setError(t("vault.importEmpty")); return; }
    if (new TextEncoder().encode(dotenv).length > DEV_DOTENV_BYTES) { setError(t("vault.importTooLarge")); return; }
    if (!confirmed) { setError(t("vault.importConfirmRequired")); return; }
    setPending(true);
    try {
      const parsed = vaultProfileSchema.safeParse(await run("import", { operation: "import", dotenv }));
      if (!parsed.success) throw new VaultClientError("invalid_response");
      setPending(false);
      reset();
      setOpen(false);
      await changed(t("vault.imported", { profile: parsed.data.profileId, revision: parsed.data.revision }));
    } catch (cause) {
      setPending(false);
      setError(vaultErrorMessage(t, cause instanceof VaultClientError ? cause.code : "vault_unavailable"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild><Button type="button" size="sm"><FileUp aria-hidden />{t("vault.import")}</Button></DialogTrigger>
      <DialogContent className="sm:max-w-2xl" closeLabel={t("common.close")}>
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("vault.importTitle")}</DialogTitle>
            <DialogDescription>{t("vault.importDescription")}</DialogDescription>
          </DialogHeader>
          <Alert variant="warning" role="note"><AlertDescription>{t("vault.disclaimer")}</AlertDescription></Alert>
          <div className="grid gap-1.5">
            <Label htmlFor="vault-import-file">{t("vault.importFile")}</Label>
            <Input ref={fileInput} id="vault-import-file" type="file" accept=".env,text/plain" disabled={pending}
              onChange={event => void chooseFile(event.target.files?.[0])} aria-describedby="vault-import-file-state" />
            <p id="vault-import-file-state" className="text-xs text-muted-foreground">
              {fileText ? t("vault.importFileSelected", { name: fileText.name, bytes: fileText.bytes }) : t("vault.importFileHelp")}
            </p>
            {fileText && <span><Button type="button" variant="ghost" size="sm" onClick={() => { setFileText(null); if (fileInput.current) fileInput.current.value = ""; }}>{t("vault.importClearFile")}</Button></span>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="vault-import-text">{t("vault.importText")}</Label>
            <textarea id="vault-import-text" value={text} onChange={event => setText(event.target.value)} disabled={pending || !!fileText}
              rows={8} spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" aria-describedby="vault-import-rules"
              className="min-h-32 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30" />
            <p id="vault-import-rules" className="text-xs text-muted-foreground">{t("vault.importRules")}</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={pending} />
            <span>{t("vault.importConfirm")}</span>
          </label>
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => change(false)} disabled={pending}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}{t("vault.importSubmit")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
