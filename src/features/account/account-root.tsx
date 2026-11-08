"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { Dashboard } from "@/features/dashboard/dashboard";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { authStatus } from "./account-client";
import { AccountDashboard, type SessionLostNotice } from "./account-dashboard";
import { LoginForm } from "./login-form";
import { useAccountSession } from "./use-account-session";

/**
 * Mode switch for the static export. The public `GET /api/auth/status`
 * decides which surface the controller offers: closed account mode renders
 * the account flow, open/token modes render the legacy dashboard untouched.
 * Only a definitive 200 answer selects a surface; a probe error renders a
 * retriable failure state instead of a misleading legacy dashboard.
 */
export function AccountRoot() {
  const { t } = useI18n();
  const [mode, setMode] = useState<"loading" | "legacy" | "account" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    authStatus(abort.signal)
      .then(status => { if (!abort.signal.aborted) setMode(status.loginAvailable ? "account" : "legacy"); })
      .catch(() => { if (!abort.signal.aborted) setMode("error"); });
    return () => abort.abort();
  }, [attempt]);

  if (mode === "loading") {
    return <p role="status" className="grid min-h-dvh place-items-center text-muted-foreground">
      <span><LoaderCircle className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("dashboard.connecting")}</span>
    </p>;
  }
  if (mode === "error") {
    return (
      <main className="grid min-h-dvh place-items-center px-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertTriangle aria-hidden />
          <AlertTitle>{t("account.modeProbeFailed")}</AlertTitle>
          <AlertDescription>{t("account.modeProbeFailedHelp")}</AlertDescription>
          <Button variant="outline" className="mt-3" onClick={() => { setMode("loading"); setAttempt(current => current + 1); }}>
            {t("account.retry")}
          </Button>
        </Alert>
      </main>
    );
  }
  if (mode === "legacy") return <Dashboard />;
  return <AccountApp />;
}

function AccountApp() {
  const { state, established, lost, end, returnToAccount } = useAccountSession();
  const { t } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);

  // A session lost without an explicit reason defaults to an honest session-lost notice.
  const sessionLost = (noticeKey?: SessionLostNotice) => {
    setNotice(noticeKey ?? "account.sessionLost");
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

  if (state.phase === "loading" || state.phase === "signingOut") {
    return <p role="status" className="grid min-h-dvh place-items-center text-muted-foreground">
      <span><LoaderCircle className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t(state.phase === "signingOut" ? "account.signingOut" : "dashboard.connecting")}</span>
    </p>;
  }
  if (state.phase === "signOutUnconfirmed") {
    return (
      <main className="grid min-h-dvh place-items-center px-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertTriangle aria-hidden />
          <AlertTitle>{t("account.signOutUnconfirmed")}</AlertTitle>
          <AlertDescription>{t("account.signOutUnconfirmedHelp")}</AlertDescription>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void end()}>{t("account.retrySignOut")}</Button>
            <Button variant="ghost" onClick={returnToAccount}>{t("account.returnToAccount")}</Button>
          </div>
        </Alert>
      </main>
    );
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
