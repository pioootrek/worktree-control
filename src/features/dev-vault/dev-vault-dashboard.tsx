"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { ProjectSnapshot } from "@/shared/contracts";
import { DEV_VAULT_DISCLAIMER } from "@/shared/contracts/dev-vault";
import { KeyRound, Lock, ShieldAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import { OwnerConnectForm } from "./owner-connect-form";
import { ownerSigningAvailable } from "./owner-signer";
import { ProjectVault } from "./project-vault";
import { useOwnerSession } from "./use-owner-session";

const noSubscription = () => () => undefined;

/** Owner-only DEV vault screen. Mounted per dashboard session, so a sign-out forgets the owner key. */
export function DevVaultDashboard({ snapshot, aggregate }: { snapshot: ProjectSnapshot | undefined; aggregate: boolean }) {
  const { t } = useI18n();
  const owner = useOwnerSession();
  const available = useSyncExternalStore(noSubscription, () => ownerSigningAvailable(), () => true);
  const connected = owner.connection.status === "connected" ? owner.connection.identity : null;

  return (
    <section className="grid gap-5" aria-labelledby="dev-vault-heading" data-dev-vault>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="dev-vault-heading" tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold outline-none"><KeyRound className="size-5" aria-hidden />{t("vault.title")}</h2>
          {snapshot && !aggregate && <p className="text-sm text-muted-foreground">{t("vault.projectScope", { project: snapshot.project.name })}</p>}
        </div>
        {connected && <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("vault.connectedAs", { label: connected.label || connected.credentialId })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => owner.lock("manual")}><Lock aria-hidden />{t("vault.lock")}</Button>
        </div>}
      </div>

      <Alert variant="warning" role="note" aria-labelledby="dev-vault-disclaimer">
        <ShieldAlert aria-hidden />
        <AlertTitle id="dev-vault-disclaimer">{t("vault.disclaimerTitle")}</AlertTitle>
        <AlertDescription className="max-w-prose">
          <p>{t("vault.disclaimer")}</p>
          <p>{t("vault.useUnavailable")}</p>
        </AlertDescription>
      </Alert>

      {aggregate || !snapshot ? (
        <p className="text-sm text-muted-foreground">{t("vault.selectProject")}</p>
      ) : !available ? (
        <Alert variant="destructive"><AlertTitle>{t("vault.signingUnavailableTitle")}</AlertTitle><AlertDescription className="max-w-prose">{t("vault.signingUnavailable")}</AlertDescription></Alert>
      ) : connected ? (
        <ProjectVault key={snapshot.project.id} projectId={snapshot.project.id} owner={owner} />
      ) : (
        <OwnerConnectForm connect={owner.connect} lockReason={owner.connection.status === "locked" ? owner.connection.reason : null} />
      )}

      <details className="max-w-prose text-sm">
        <summary className="cursor-pointer font-medium">{t("vault.agentContractTitle")}</summary>
        <div className="mt-2 grid gap-2 text-muted-foreground">
          <p>{t("vault.agentContract")}</p>
          <p>{t("vault.legacyProfiles")}</p>
          <p lang="en"><span className="font-medium text-foreground">{t("vault.controllerNotice")}</span> {DEV_VAULT_DISCLAIMER}</p>
        </div>
      </details>
    </section>
  );
}
