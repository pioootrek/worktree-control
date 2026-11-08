"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { Dashboard } from "@/features/dashboard/dashboard";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import type { BrowserAuthenticationStatus } from "@/shared/contracts/authentication";
import { authStatus } from "./account-client";
import { AccountDashboard, type SessionLostNotice } from "./account-dashboard";
import { LoginForm } from "./login-form";
import { useAccountSession } from "./use-account-session";

/**
 * Mode switch for the static export. The public `GET /api/auth/status`
 * decides which surface the controller offers: closed account mode renders
 * the account flow, open/token modes render the legacy dashboard untouched.
 * Only a definitive, well-formed 200 answer selects a surface. Account mode
 * with an unavailable provider and every probe error or malformed answer
 * render a retriable state instead of a misleading legacy token dashboard.
 */
type ProbeOutcome = "legacy" | "account" | "unavailable" | "error";

/** Classify one probe answer without trusting partial shapes; browser tests cover every branch. */
function classifyAuthStatus(status: unknown): ProbeOutcome {
  if (typeof status !== "object" || status === null) return "error";
  const { mode, loginAvailable } = status as Partial<Record<keyof BrowserAuthenticationStatus, unknown>>;
  if (typeof loginAvailable !== "boolean") return "error";
  if (mode === "better-auth") return loginAvailable ? "account" : "unavailable";
  if ((mode === "legacy" || mode === "open" || mode === "token") && !loginAvailable) return "legacy";
  return "error";
}

export function AccountRoot() {
  const { t } = useI18n();
  const [mode, setMode] = useState<"loading" | ProbeOutcome>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    authStatus(abort.signal)
      .then(status => { if (!abort.signal.aborted) setMode(classifyAuthStatus(status)); })
      .catch(() => { if (!abort.signal.aborted) setMode("error"); });
    return () => abort.abort();
  }, [attempt]);

  if (mode === "loading") {
    return <p role="status" className="grid min-h-dvh place-items-center text-muted-foreground">
      <span><LoaderCircle className="mr-2 inline size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("dashboard.connecting")}</span>
    </p>;
  }
  if (mode === "error" || mode === "unavailable") {
    const unavailable = mode === "unavailable";
    return (
      <RetriableFailure
        title={t(unavailable ? "account.loginUnavailable" : "account.modeProbeFailed")}
        help={t(unavailable ? "account.loginUnavailableHelp" : "account.modeProbeFailedHelp")}
        retry={t("account.retry")}
        onRetry={() => { setMode("loading"); setAttempt(current => current + 1); }}
      />
    );
  }
  if (mode === "legacy") return <Dashboard />;
  return <AccountApp />;
}

function RetriableFailure({ title, help, retry, onRetry }: { title: string; help: string; retry: string; onRetry: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <Alert variant="destructive" className="max-w-md">
        <AlertTriangle aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{help}</AlertDescription>
        <Button variant="outline" className="mt-3" onClick={onRetry}>{retry}</Button>
      </Alert>
    </main>
  );
}

function AccountApp() {
  const { state, established, lost, end, returnToAccount, retry } = useAccountSession();
  const { t } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);

  // A session lost without an explicit reason defaults to an honest session-lost notice.
  // A late answer from an earlier session generation is ignored, so it can neither end nor relabel the current one.
  const activeGeneration = state.phase === "authenticated" ? state.generation : null;
  const sessionLost = useCallback((noticeKey?: SessionLostNotice) => {
    if (activeGeneration !== null && lost(activeGeneration)) setNotice(noticeKey ?? "account.sessionLost");
  }, [activeGeneration, lost]);
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
  if (state.phase === "unavailable") {
    return <RetriableFailure title={t("account.sessionCheckFailed")} help={t("account.sessionCheckFailedHelp")} retry={t("account.retry")} onRetry={retry} />;
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
    />
  );
}
