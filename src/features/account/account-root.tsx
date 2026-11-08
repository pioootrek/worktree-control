"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/provider";
import { Dashboard } from "@/features/dashboard/dashboard";
import { LoaderCircle } from "lucide-react";
import { authStatus } from "./account-client";
import { AccountDashboard } from "./account-dashboard";
import { LoginForm } from "./login-form";
import { useAccountSession } from "./use-account-session";

/**
 * Mode switch for the static export. The public `GET /api/auth/status`
 * decides which surface the controller offers: closed account mode renders
 * the account flow, open/token modes render the legacy dashboard untouched.
 * A failed probe keeps the legacy surface, which reports its own connection
 * state honestly.
 */
export function AccountRoot() {
  const { t } = useI18n();
  const [mode, setMode] = useState<"loading" | "legacy" | "account">("loading");

  useEffect(() => {
    const abort = new AbortController();
    authStatus(abort.signal)
      .then(status => { if (!abort.signal.aborted) setMode(status.loginAvailable ? "account" : "legacy"); })
      .catch(() => { if (!abort.signal.aborted) setMode("legacy"); });
    return () => abort.abort();
  }, []);

  if (mode === "loading") {
    return <p role="status" className="grid min-h-dvh place-items-center text-muted-foreground">
      <span><LoaderCircle className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("dashboard.connecting")}</span>
    </p>;
  }
  if (mode === "legacy") return <Dashboard />;
  return <AccountApp />;
}

function AccountApp() {
  const { state, established, lost, end } = useAccountSession();
  const { t } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);

  const sessionLost = (noticeKey?: "account.totpEnrolled" | "account.passkeyEnrolled") => {
    setNotice(noticeKey ?? null);
    lost();
  };
  const authenticated = async () => {
    setNotice(null);
    await established();
  };
  const signOut = () => {
    setNotice(null);
    void end();
  };

  if (state.phase === "loading") {
    return <p role="status" className="grid min-h-dvh place-items-center text-muted-foreground">
      <span><LoaderCircle className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("dashboard.connecting")}</span>
    </p>;
  }
  if (state.phase === "anonymous") return <LoginForm notice={notice} onAuthenticated={authenticated} />;
  return (
    <AccountDashboard
      key={state.generation}
      session={state.session}
      onSignOut={signOut}
      onSessionLost={sessionLost}
      notice={null}
      dismissNotice={() => setNotice(null)}
    />
  );
}
