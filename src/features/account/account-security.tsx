"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import { AccountApiError, changePassword, passkeyOptions, passkeyVerify, totpEnable, totpVerify } from "./account-client";
import { serializeRegistration, serializeAssertion, toCredentialCreationOptions, toCredentialRequestOptions, webAuthnAvailable } from "./webauthn";

/**
 * Self-service account security on the closed factor routes. Both enrollment
 * ceremonies end every session of the account (selection semantics), so a
 * finished enrollment hands back to sign-in instead of keeping this panel.
 * Recovery, removal, replacement and additional passkeys stay with the
 * protected CLI and are not offered here.
 */
export function AccountSecurity({ onEnrollmentComplete, onSessionLost }: {
  onEnrollmentComplete: (message: "account.totpEnrolled" | "account.passkeyEnrolled") => void;
  onSessionLost: () => void;
}) {
  return (
    <div className="mx-auto grid max-w-2xl gap-8 px-4 py-8">
      <ChangePasswordForm onSessionLost={onSessionLost} />
      <TotpEnrollment onComplete={() => onEnrollmentComplete("account.totpEnrolled")} onSessionLost={onSessionLost} />
      <PasskeyEnrollment onComplete={() => onEnrollmentComplete("account.passkeyEnrolled")} onSessionLost={onSessionLost} />
    </div>
  );
}

function errorKey(cause: unknown, fallback: "account.passwordFailed" | "account.enrollFailed"): "account.passwordFailed" | "account.enrollFailed" | "account.rateLimited" | "account.unavailable" {
  if (cause instanceof AccountApiError) {
    if (cause.status === 429) return "account.rateLimited";
    if (cause.status >= 500) return "account.unavailable";
  }
  return fallback;
}

function ChangePasswordForm({ onSessionLost }: { onSessionLost: () => void }) {
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null); setDone(false);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setDone(true);
    } catch (cause) {
      if (cause instanceof AccountApiError && cause.status === 401) onSessionLost();
      setError(t(errorKey(cause, "account.passwordFailed")));
    } finally { setBusy(false); }
  };

  return (
    <form className="space-y-4 rounded-xl border border-border bg-card/30 p-5" onSubmit={submit}>
      <h2 className="text-lg font-semibold">{t("account.changePassword")}</h2>
      {error && <Alert variant="destructive"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
      {done && <Alert variant="success"><CheckCircle2 aria-hidden /><AlertDescription>{t("account.passwordChanged")}</AlertDescription></Alert>}
      <div className="space-y-1.5">
        <Label htmlFor="account-current-password">{t("account.currentPassword")}</Label>
        <Input id="account-current-password" type="password" autoComplete="current-password" required maxLength={256} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="account-new-password">{t("account.newPassword")}</Label>
        <Input id="account-new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={newPassword} onChange={event => setNewPassword(event.target.value)} />
      </div>
      <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}{t("account.changePassword")}</Button>
    </form>
  );
}

function TotpEnrollment({ onComplete, onSessionLost }: { onComplete: () => void; onSessionLost: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await totpEnable(password);
      setPassword("");
      if ("outcome" in result && result.outcome === "enrollment") setUri(result.totpURI);
      else setError(t("account.enrollFailed"));
    } catch (cause) {
      if (cause instanceof AccountApiError && cause.status === 401) onSessionLost();
      setError(t(errorKey(cause, "account.enrollFailed")));
    } finally { setBusy(false); }
  };

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await totpVerify(code);
      // Enrollment ends every session of the account; the parent returns to sign-in.
      if ("outcome" in result && result.outcome === "enrolled") onComplete();
      else setError(t("account.enrollFailed"));
    } catch (cause) {
      if (cause instanceof AccountApiError && cause.status === 401) onSessionLost();
      setError(t(errorKey(cause, "account.enrollFailed")));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/30 p-5">
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold">{t("account.totpEnable")}</h2>
        <p className="text-sm text-muted-foreground">{t("account.totpEnableHelp")}</p>
      </div>
      {error && <Alert variant="destructive"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
      {!uri ? (
        <form className="space-y-4" onSubmit={start}>
          <div className="space-y-1.5">
            <Label htmlFor="account-totp-password">{t("account.totpPasswordPrompt")}</Label>
            <Input id="account-totp-password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={event => setPassword(event.target.value)} />
          </div>
          <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}{t("account.totpEnable")}</Button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={confirm}>
          <div className="space-y-1.5">
            <Label htmlFor="account-totp-uri">{t("account.totpUri")}</Label>
            <Input id="account-totp-uri" readOnly value={uri} className="font-mono text-xs" onFocus={event => event.currentTarget.select()} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="account-totp-confirm">{t("account.totpCode")}</Label>
            <Input id="account-totp-confirm" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={event => setCode(event.target.value)} />
          </div>
          <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}{t("account.verify")}</Button>
        </form>
      )}
    </div>
  );
}

function PasskeyEnrollment({ onComplete, onSessionLost }: { onComplete: () => void; onSessionLost: () => void }) {
  const { t } = useI18n();
  const [staged, setStaged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enroll = async () => {
    setBusy(true); setError(null);
    try {
      if (!staged) {
        const options = await passkeyOptions("register");
        if (!("outcome" in options) || options.outcome !== "options" || !("rp" in options.options)) {
          setError(t("account.passkeyUnavailable"));
          return;
        }
        const credential = await navigator.credentials.create({
          publicKey: toCredentialCreationOptions(options.options),
        }) as PublicKeyCredential | null;
        if (!credential) { setError(t("account.enrollFailed")); return; }
        const result = await passkeyVerify("registration", serializeRegistration(credential));
        if ("outcome" in result && result.outcome === "staged") setStaged(true);
        else setError(t("account.enrollFailed"));
      } else {
        const options = await passkeyOptions("confirm");
        if (!("outcome" in options) || options.outcome !== "options" || !("rpId" in options.options)) {
          setError(t("account.passkeyUnavailable"));
          return;
        }
        const credential = await navigator.credentials.get({
          publicKey: toCredentialRequestOptions(options.options),
        }) as PublicKeyCredential | null;
        if (!credential) { setError(t("account.enrollFailed")); return; }
        const result = await passkeyVerify("confirmation", serializeAssertion(credential));
        // Confirmation selects the method and ends every session of the account.
        if ("outcome" in result && result.outcome === "enrolled") onComplete();
        else setError(t("account.enrollFailed"));
      }
    } catch (cause) {
      if (cause instanceof AccountApiError && cause.status === 401) onSessionLost();
      setError(t(errorKey(cause, "account.enrollFailed")));
    } finally { setBusy(false); }
  };

  if (!webAuthnAvailable()) return null;
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/30 p-5">
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold">{t("account.passkeyEnroll")}</h2>
        <p className="text-sm text-muted-foreground">{t("account.passkeyEnrollHelp")}</p>
      </div>
      {error && <Alert variant="destructive"><AlertTriangle aria-hidden /><AlertDescription>{error}</AlertDescription></Alert>}
      {staged && <Alert variant="success"><CheckCircle2 aria-hidden /><AlertDescription>{t("account.passkeyStaged")}</AlertDescription></Alert>}
      <Button type="button" disabled={busy} onClick={() => void enroll()}>
        {busy && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
        {t(staged ? "account.passkeyConfirm" : "account.passkeyEnroll")}
      </Button>
    </div>
  );
}
