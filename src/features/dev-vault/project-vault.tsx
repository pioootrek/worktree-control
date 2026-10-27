"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessPanel } from "./access-panel";
import { AuditPanel } from "./audit-panel";
import { ProfilesPanel } from "./profiles-panel";
import type { useOwnerSession } from "./use-owner-session";
import { listAgentCredentials, type AgentCredentialSummary } from "./vault-client";
import { vaultErrorMessage } from "./vault-messages";
import type { RunVault } from "./owner-session";
import { VaultClientError, vaultListSchema, vaultRequestsSchema, type VaultErrorCode, type VaultSnapshot } from "./vault-model";

type OwnerSession = ReturnType<typeof useOwnerSession>;

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new VaultClientError("invalid_response");
  return parsed.data;
}

/** One project's vault state. Keyed by project so a switch drops revealed values and drafts. */
export function ProjectVault({ projectId, owner }: { projectId: string; owner: OwnerSession }) {
  const { t, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<VaultErrorCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentCredentialSummary[] | null>>({});
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  const { run: runOwner, ownerToken, lock } = owner;

  const run = useCallback<RunVault>((intent, operation) => runOwner(projectId, intent, operation), [projectId, runOwner]);
  const refresh = useCallback(async () => {
    const started = ++generation.current;
    setLoading(true);
    try {
      const [list, access] = await Promise.all([run("list", { operation: "list" }), run("requests", { operation: "requests" })]);
      const { profiles } = parse(vaultListSchema, list);
      const { requests, grants } = parse(vaultRequestsSchema, access);
      if (generation.current !== started) return;
      setSnapshot({ profiles, requests, grants, loadedAt: Date.now() });
      setNow(Date.now());
      setError(null);
      const token = ownerToken();
      const missing = [...new Set(requests.map(request => request.agentId))];
      if (token && missing.length) {
        // Labels are owner-assigned identity metadata; vault authority never depends on them.
        const entries = await Promise.all(missing.slice(0, 64).map(async agentId => [agentId, await listAgentCredentials(token, agentId)] as const));
        if (generation.current === started) setAgents(Object.fromEntries(entries));
      }
    } catch (cause) {
      if (generation.current !== started) return;
      const code = cause instanceof VaultClientError ? cause.code : "vault_unavailable";
      if (code !== "locked") setError(code);
    } finally {
      if (generation.current === started) setLoading(false);
    }
  }, [ownerToken, run]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [refresh]);
  // A display clock for expiry badges only; it never reads from the controller.
  const ticking = !!snapshot && (snapshot.requests.some(request => request.status === "pending") || snapshot.grants.some(grant => grant.expiresAt !== null));
  useEffect(() => {
    if (!ticking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, [ticking]);

  const changed = useCallback(async (message: string) => {
    setNotice(message);
    await refresh();
  }, [refresh]);
  const focusFallback = useCallback(() => heading.current?.focus(), []);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">{t("vault.projectHeading")}</h3>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw aria-hidden />}{t("vault.refresh")}
        </Button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" className="empty:hidden">
        {notice && <Alert variant="success" role="presentation"><AlertDescription className="break-words">{notice}</AlertDescription></Alert>}
      </div>
      {error && <Alert variant="destructive" role="alert"><AlertDescription className="grid gap-2">
        <span>{vaultErrorMessage(t, error)}</span>
        {snapshot && <span>{t("vault.staleData", { time: new Date(snapshot.loadedAt).toLocaleTimeString(locale) })}</span>}
        {(error === "vault_denied" || error === "session_invalid") && <span><Button type="button" variant="outline" size="sm" onClick={() => lock("manual")}>{t("vault.reconnect")}</Button></span>}
      </AlertDescription></Alert>}
      {!snapshot ? (
        loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{t("vault.loading")}</p> : null
      ) : (
        <>
          <ProfilesPanel profiles={snapshot.profiles} run={run} changed={changed} focusFallback={focusFallback} />
          <AccessPanel snapshot={snapshot} agents={agents} now={now} run={run} changed={changed} focusFallback={focusFallback} />
          <AuditPanel run={run} />
        </>
      )}
    </div>
  );
}
