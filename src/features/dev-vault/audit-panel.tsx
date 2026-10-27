"use client";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { History, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { RunVault } from "./owner-session";
import { vaultErrorMessage } from "./vault-messages";
import { VaultClientError, vaultAuditSchema } from "./vault-model";

type Events = ReturnType<typeof vaultAuditSchema.parse>["events"];

/** Bounded operation/reference events, loaded only on request; they never contain names or values. */
export function AuditPanel({ run }: { run: RunVault }) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<Events | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setPending(true);
    setError(null);
    try {
      const parsed = vaultAuditSchema.safeParse(await run("audit", { operation: "audit" }));
      if (!parsed.success) throw new VaultClientError("invalid_response");
      setEvents([...parsed.data.events].reverse());
    } catch (cause) {
      setError(vaultErrorMessage(t, cause instanceof VaultClientError ? cause.code : "vault_unavailable"));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="grid gap-3" aria-labelledby="vault-audit-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="vault-audit-heading" className="text-sm font-semibold">{t("vault.audit")}</h4>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <History aria-hidden />}{events ? t("vault.auditRefresh") : t("vault.auditLoad")}
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {events && (events.length === 0 ? <p className="text-sm text-muted-foreground">{t("vault.auditEmpty")}</p> : (
        <ol className="grid gap-1 text-xs">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="grid gap-x-3 border-b border-border py-1 last:border-0 sm:grid-cols-[11rem_7rem_1fr]">
              <span className="text-muted-foreground">{new Date(event.at).toLocaleString(locale)}</span>
              <span className="font-medium">{event.operation}</span>
              <span className="min-w-0 break-all font-mono">{[t("vault.auditActor", { id: event.actorId }), event.profileId && t("vault.auditProfile", { id: event.profileId }),
                event.requestId && t("vault.auditRequest", { id: event.requestId }), event.grantId && t("vault.auditGrant", { id: event.grantId })].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ol>
      ))}
    </section>
  );
}
