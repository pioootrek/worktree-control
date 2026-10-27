"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { LoaderCircle } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { OWNER_KEY_FILE_BYTES, OwnerKeyImportError } from "./owner-signer";
import { VaultClientError } from "./vault-model";
import { vaultErrorMessage } from "./vault-messages";

/**
 * Explicit, per-visit owner proof setup: an owner session token and a private key file chosen by
 * the human. Neither value is stored; the file text is dropped as soon as it is imported.
 */
export function OwnerConnectForm({ connect, lockReason }: {
  connect: (token: string, keyText: string) => Promise<void>;
  lockReason: "idle" | "manual" | null;
}) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const clearFile = () => {
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!token.trim() || !file) { setError(t("vault.connectMissing")); return; }
    if (file.size > OWNER_KEY_FILE_BYTES) { clearFile(); setError(t("vault.keyError.too_large")); return; }
    setPending(true);
    const selected = file;
    // Clear the visible selection before signing starts; the File object is released below.
    clearFile();
    try {
      await connect(token, await selected.text());
      if (mounted.current) setToken("");
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof OwnerKeyImportError ? t(`vault.keyError.${cause.reason}`)
        : vaultErrorMessage(t, cause instanceof VaultClientError ? cause.code : "vault_unavailable"));
      tokenInput.current?.focus();
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  return (
    <form className="grid max-w-2xl gap-4 rounded-xl border border-border p-4 sm:p-5" onSubmit={submit} aria-labelledby="vault-connect-heading">
      <div className="grid gap-1">
        <h3 id="vault-connect-heading" className="text-base font-semibold">{t("vault.connectTitle")}</h3>
        <p className="max-w-prose text-sm text-muted-foreground">{t("vault.connectHelp")}</p>
      </div>
      {lockReason === "idle" && <Alert role="status"><AlertDescription>{t("vault.lockedIdle")}</AlertDescription></Alert>}
      {lockReason === "manual" && <Alert role="status"><AlertDescription>{t("vault.lockedManual")}</AlertDescription></Alert>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="grid gap-1.5">
        <Label htmlFor="vault-owner-token">{t("vault.ownerToken")}</Label>
        <Input ref={tokenInput} id="vault-owner-token" type="password" value={token} onChange={event => setToken(event.target.value)}
          autoComplete="off" spellCheck={false} aria-describedby="vault-owner-token-help" disabled={pending} />
        <p id="vault-owner-token-help" className="text-xs text-muted-foreground">{t("vault.ownerTokenHelp")}</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="vault-owner-key">{t("vault.ownerKey")}</Label>
        <Input ref={fileInput} id="vault-owner-key" type="file" accept=".pem,.key,application/x-pem-file,text/plain"
          onChange={event => setFile(event.target.files?.[0] ?? null)} aria-describedby="vault-owner-key-help" disabled={pending} />
        <p id="vault-owner-key-help" className="text-xs text-muted-foreground">{t("vault.ownerKeyHelp")}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />}{t("vault.connect")}</Button>
      </div>
    </form>
  );
}
