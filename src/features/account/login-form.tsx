"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { AlertTriangle, KeyRound, LoaderCircle } from "lucide-react";
import { AccountApiError, passkeyOptions, passkeyVerify, signIn, totpVerify } from "./account-client";
import { serializeAssertion, toCredentialRequestOptions, webAuthnAvailable } from "./webauthn";

type Step = { kind: "password" } | { kind: "totp" };

/**
 * The closed sign-in surface: email/password, the TOTP challenge that a
 * password sign-in can return, and passkey login when the browser API and the
 * provider both offer it. No signup, reset, redirect or social flow exists;
 * enrollment stays with the protected CLI and the account security panel.
 */
export function LoginForm({ onAuthenticated, notice }: { onAuthenticated: () => void | Promise<void>; notice?: string | null }) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failure = (cause: unknown, fallback: string) => {
    if (cause instanceof AccountApiError) {
      if (cause.status === 429) return setError(t("account.rateLimited"));
      if (cause.status >= 500) return setError(t("account.unavailable"));
    }
    setError(fallback);
  };

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await signIn(email.trim(), password);
      setPassword("");
      if ("authenticated" in result && result.authenticated) await onAuthenticated();
      else if ("outcome" in result && result.outcome === "challenge" && result.method === "totp") { setCode(""); setStep({ kind: "totp" }); }
      else setError(t("account.signInFailed"));
    } catch (cause) {
      failure(cause, t("account.signInFailed"));
    } finally { setBusy(false); }
  };

  const submitTotp = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await totpVerify(code);
      if ("authenticated" in result && result.authenticated) await onAuthenticated();
      else setError(t("account.signInFailed"));
    } catch (cause) {
      failure(cause, t("account.signInFailed"));
    } finally { setBusy(false); }
  };

  const submitPasskey = async () => {
    setBusy(true); setError(null);
    try {
      const options = await passkeyOptions("authenticate");
      if (!("outcome" in options) || options.outcome !== "options" || !("rpId" in options.options)) {
        setError(t("account.passkeyUnavailable"));
        return;
      }
      const credential = await navigator.credentials.get({
        publicKey: toCredentialRequestOptions(options.options),
      }) as PublicKeyCredential | null;
      if (!credential) { setError(t("account.passkeyFailed")); return; }
      const result = await passkeyVerify("authentication", serializeAssertion(credential));
      if ("authenticated" in result && result.authenticated) await onAuthenticated();
      else setError(t("account.passkeyFailed"));
    } catch (cause) {
      failure(cause, t("account.passkeyFailed"));
    } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto grid min-h-[60dvh] max-w-md place-items-center px-4 py-16">
      <div className="w-full space-y-5 rounded-xl border border-border bg-card/30 p-6 sm:p-8">
        <div className="space-y-1.5">
          <h1 className="text-xl font-semibold">{t(step.kind === "totp" ? "account.totpTitle" : "account.title")}</h1>
          <p className="text-sm text-muted-foreground">{t(step.kind === "totp" ? "account.totpHelp" : "account.signInHelp")}</p>
        </div>
        {notice && <Alert variant="success"><AlertDescription>{t(notice as Parameters<typeof t>[0])}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
        {step.kind === "password" ? (
          <form className="space-y-4" onSubmit={submitPassword}>
            <div className="space-y-1.5">
              <Label htmlFor="account-email">{t("account.email")}</Label>
              <Input id="account-email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-password">{t("account.password")}</Label>
              <Input id="account-password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {t("account.signIn")}
            </Button>
            {webAuthnAvailable() && (
              <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void submitPasskey()}>
                <KeyRound aria-hidden className="size-4" />
                {t("account.passkeySignIn")}
              </Button>
            )}
          </form>
        ) : (
          <form className="space-y-4" onSubmit={submitTotp}>
            <div className="space-y-1.5">
              <Label htmlFor="account-totp">{t("account.totpCode")}</Label>
              <Input id="account-totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={event => setCode(event.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
              {t("account.verify")}
            </Button>
            <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={() => { setStep({ kind: "password" }); setError(null); }}>
              {t("account.backToSignIn")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
