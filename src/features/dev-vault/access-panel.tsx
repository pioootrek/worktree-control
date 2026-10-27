"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { Ban, Check, LoaderCircle, Search, X } from "lucide-react";
import { useId, useState } from "react";
import type { RunVault } from "./owner-session";
import type { AgentCredentialSummary } from "./vault-client";
import { VaultActionDialog } from "./vault-action-dialog";
import { vaultErrorMessage } from "./vault-messages";
import {
  grantState, requestState, VAULT_LIFETIMES, VaultClientError, vaultGrantSchema, vaultInspectSchema, vaultRejectSchema, vaultRevokeSchema,
  type GrantState, type RequestState, type VaultGrant, type VaultSnapshot, type VaultLifetime, type VaultProfile, type VaultRequest,
} from "./vault-model";

type Agents = Record<string, AgentCredentialSummary[] | null>;
interface PanelProps { run: RunVault; changed: (message: string) => Promise<void>; focusFallback: () => void; now: number; agents: Agents }

function credentialOf(agents: Agents, request: VaultRequest) {
  return agents[request.agentId]?.find(credential => credential.id === request.credentialId) ?? null;
}

export function AccessPanel({ snapshot, ...props }: PanelProps & { snapshot: VaultSnapshot }) {
  const { t } = useI18n();
  const { requests, grants, profiles } = snapshot;
  const open = requests.filter(request => request.status !== "approved");
  const pendingCount = open.filter(request => requestState(request, profiles, props.now) === "pending").length;
  return (
    <>
      <section className="grid gap-3" aria-labelledby="vault-requests-heading">
        <h4 id="vault-requests-heading" className="text-sm font-semibold">{t("vault.requests", { count: pendingCount })}</h4>
        {open.length === 0 ? <p className="text-sm text-muted-foreground">{t("vault.noRequests")}</p> : (
          <ul className="grid gap-2">{open.map(request => <RequestItem key={request.id} request={request} profiles={profiles} {...props} />)}</ul>
        )}
      </section>
      <section className="grid gap-3" aria-labelledby="vault-grants-heading">
        <h4 id="vault-grants-heading" className="text-sm font-semibold">{t("vault.grants", { count: grants.length })}</h4>
        <p className="max-w-prose text-xs text-muted-foreground">{t("vault.grantsHelp")}</p>
        {grants.length === 0 ? <p className="text-sm text-muted-foreground">{t("vault.noGrants")}</p> : (
          <ul className="grid gap-2">{grants.map(grant => <GrantItem key={grant.id} grant={grant} request={requests.find(request => request.id === grant.requestId)} profiles={profiles} {...props} />)}</ul>
        )}
      </section>
    </>
  );
}

/** Exact identity, profile revision and timing for one request; shared by list rows and the approval dialog. */
function RequestFacts({ request, profiles, agents }: { request: VaultRequest; profiles: VaultProfile[]; agents: Agents }) {
  const { t, locale } = useI18n();
  const credential = credentialOf(agents, request);
  const current = profiles.find(profile => profile.profileId === request.profileId);
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">{t("vault.operation")}</dt><dd className="font-medium">{t(`vault.permission.${request.permission}`)}</dd>
      <dt className="text-muted-foreground">{t("vault.agent")}</dt><dd className="break-all font-mono text-xs">{request.agentId}</dd>
      <dt className="text-muted-foreground">{t("vault.credential")}</dt>
      <dd className="min-w-0"><span className="break-all font-mono text-xs">{request.credentialId}</span>
        {credential ? <span className="block text-xs">{t("vault.credentialLabel", { label: credential.label })}{credential.status === "revoked" ? ` · ${t("vault.credentialRevoked")}` : ""}</span>
          : <span className="block text-xs text-muted-foreground">{t("vault.credentialUnknown")}</span>}
      </dd>
      <dt className="text-muted-foreground">{t("vault.profileId")}</dt><dd className="break-all font-mono text-xs">{request.profileId}</dd>
      <dt className="text-muted-foreground">{t("vault.requestedRevision")}</dt>
      <dd>{t("vault.revisionComparison", { requested: request.revision, current: current ? String(current.revision) : t("vault.unknown") })}</dd>
      <dt className="text-muted-foreground">{t("vault.requestedAt")}</dt><dd>{date(request.createdAt)}</dd>
      {request.status === "pending" && <><dt className="text-muted-foreground">{t("vault.requestExpires")}</dt><dd>{date(request.expiresAt)}</dd></>}
      {request.binding && <>
        <dt className="text-muted-foreground">{t("vault.binding")}</dt>
        <dd className="grid gap-0.5 font-mono text-xs">
          <span className="break-all">{t("vault.bindingCommit", { value: request.binding.commit })}</span>
          <span className="break-all">{t("vault.bindingPreset", { value: request.binding.presetId })}</span>
          <span className="break-all">{t("vault.bindingDigest", { value: request.binding.commandDigest })}</span>
          <span className="break-all">{t("vault.bindingWorker", { value: request.binding.workerId })}</span>
        </dd>
      </>}
    </dl>
  );
}

function StateBadge({ state, kind }: { state: RequestState | GrantState; kind: "request" | "grant" }) {
  const { t } = useI18n();
  const good = state === "pending" || state === "active";
  return <Badge variant={good ? "secondary" : "outline"}>{kind === "request" ? t(`vault.requestState.${state as RequestState}`) : t(`vault.grantState.${state as GrantState}`)}</Badge>;
}

function RequestItem({ request, profiles, agents, now, run, changed, focusFallback }: PanelProps & { request: VaultRequest; profiles: VaultProfile[] }) {
  const { t } = useI18n();
  const state = requestState(request, profiles, now);
  const reasonId = useId();
  const credential = credentialOf(agents, request);
  const actionable = state === "pending" && credential?.status !== "revoked";
  return (
    <li className="grid gap-3 rounded-lg border border-border p-3" data-vault-request={request.id}>
      <div className="flex flex-wrap items-center gap-2"><StateBadge state={state} kind="request" /><span className="break-all font-mono text-xs text-muted-foreground">{request.id}</span></div>
      <RequestFacts request={request} profiles={profiles} agents={agents} />
      {request.permission === "use" && <p className="max-w-prose text-xs text-muted-foreground">{t("vault.useUnavailable")}</p>}
      {state !== "pending" && <p id={reasonId} className="max-w-prose text-sm">{t(`vault.requestReason.${state}`)}</p>}
      {state === "pending" && credential?.status === "revoked" && <p id={reasonId} className="max-w-prose text-sm">{t("vault.credentialRevokedReason")}</p>}
      {request.status === "pending" && <div className="flex flex-wrap gap-2">
        <ApproveDialog request={request} profiles={profiles} agents={agents} disabled={!actionable} reasonId={actionable ? undefined : reasonId}
          reason={actionable ? null : state === "pending" ? t("vault.credentialRevokedReason") : t(`vault.requestReason.${state}`)} run={run} changed={changed} focusFallback={focusFallback} />
        <VaultActionDialog
          trigger={{ label: t("vault.reject"), icon: <X aria-hidden />, disabled: state === "expired" }}
          title={t("vault.rejectTitle")}
          description={<p>{t("vault.rejectDescription")}</p>}
          confirmLabel={t("vault.rejectConfirm")}
          confirmVariant="destructive"
          action={async () => {
            if (!vaultRejectSchema.safeParse(await run(`reject:${request.id}`, { operation: "reject", requestId: request.id })).success) throw new VaultClientError("invalid_response");
            return t("vault.rejected", { request: request.id });
          }}
          changed={changed} focusFallback={focusFallback}
        ><RequestFacts request={request} profiles={profiles} agents={agents} /></VaultActionDialog>
      </div>}
    </li>
  );
}

/** Approval binds the exact request and its revision; a write patch must be inspected under owner proof first. */
function ApproveDialog({ request, profiles, agents, disabled, reasonId, reason, run, changed, focusFallback }: {
  request: VaultRequest; profiles: VaultProfile[]; agents: Agents; disabled: boolean; reasonId?: string; reason: string | null;
  run: RunVault; changed: (message: string) => Promise<void>; focusFallback: () => void;
}) {
  const { t } = useI18n();
  const [lifetime, setLifetime] = useState<VaultLifetime>("once");
  const [proposal, setProposal] = useState<Array<[string, string]> | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const group = useId();
  const write = request.permission === "write";
  const inspect = async () => {
    setInspecting(true);
    setInspectError(null);
    try {
      const parsed = vaultInspectSchema.safeParse(await run(`inspect:${request.id}`, { operation: "inspect-request", requestId: request.id }));
      // The inspected record must be the same immutable request at the same revision.
      if (!parsed.success || parsed.data.id !== request.id || parsed.data.revision !== request.revision || parsed.data.permission !== "write" || !parsed.data.proposal) throw new VaultClientError("invalid_response");
      setProposal(Object.entries(parsed.data.proposal));
    } catch (cause) {
      setInspectError(vaultErrorMessage(t, cause instanceof VaultClientError ? cause.code : "vault_unavailable"));
    } finally {
      setInspecting(false);
    }
  };
  return (
    <VaultActionDialog
      wide
      trigger={{ label: t("vault.review"), icon: <Check aria-hidden />, variant: "default", disabled, describedBy: reasonId }}
      title={t("vault.approveTitle", { permission: t(`vault.permission.${request.permission}`) })}
      description={<p>{t("vault.approveDescription")}</p>}
      confirmLabel={t("vault.approveConfirm", { permission: t(`vault.permission.${request.permission}`), lifetime: t(`vault.lifetime.${lifetime}`) })}
      confirmDisabled={disabled || (write && !proposal)}
      onOpenChange={next => { if (!next) { setProposal(null); setInspectError(null); setLifetime("once"); } }}
      action={async () => {
        const parsed = vaultGrantSchema.safeParse(await run(`approve:${request.id}:${request.revision}:${lifetime}`, { operation: "approve", requestId: request.id, revision: request.revision, lifetime }));
        if (!parsed.success || parsed.data.requestId !== request.id) throw new VaultClientError("invalid_response");
        return t("vault.approved", { grant: parsed.data.id, permission: t(`vault.permission.${request.permission}`), lifetime: t(`vault.lifetime.${parsed.data.lifetime}`) });
      }}
      changed={changed} focusFallback={focusFallback}
    >
      <div className="grid max-h-[55dvh] gap-4 overflow-y-auto pr-1">
        <RequestFacts request={request} profiles={profiles} agents={agents} />
        {reason && <p role="alert" className="max-w-prose text-sm font-medium text-destructive">{reason}</p>}
        {request.permission === "use" && <p className="max-w-prose text-sm">{t("vault.useUnavailable")}</p>}
        {write && <div className="grid gap-2">
          <p className="max-w-prose text-sm">{t("vault.writeSemantics", { revision: request.revision })}</p>
          {proposal ? (
            <div className="grid gap-1 rounded-md bg-muted/50 p-3" role="region" aria-label={t("vault.proposalRegion")} data-vault-proposal>
              <p className="text-xs text-muted-foreground">{t("vault.proposalShown", { count: proposal.length })}</p>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
                {proposal.map(([name, value]) => <div key={name} className="contents">
                  <dt className="break-all font-mono text-xs font-medium">{name}</dt>
                  <dd className="break-all font-mono text-xs">{value === "" ? <span className="text-muted-foreground">{t("vault.emptyValue")}</span> : value}</dd>
                </div>)}
              </dl>
            </div>
          ) : <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">{t("vault.inspectRequired")}</p>
            <span><Button type="button" variant="outline" size="sm" onClick={() => void inspect()} disabled={inspecting}>
              {inspecting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Search aria-hidden />}{t("vault.inspect")}
            </Button></span>
            {inspectError && <p role="alert" className="text-sm text-destructive">{inspectError}</p>}
          </div>}
        </div>}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t("vault.lifetimeLegend")}</legend>
          {VAULT_LIFETIMES.map(option => (
            <label key={option} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm has-checked:border-primary">
              <input type="radio" name={group} value={option} checked={lifetime === option} onChange={() => setLifetime(option)} className="mt-0.5 size-4 accent-primary" />
              <span className="grid gap-0.5"><span className="font-medium">{t(`vault.lifetime.${option}`)}</span>
                <span className="text-xs text-muted-foreground">{t(`vault.lifetimeEffect.${request.permission}.${option}`, { revision: request.revision })}</span></span>
            </label>
          ))}
        </fieldset>
      </div>
    </VaultActionDialog>
  );
}

function GrantItem({ grant, request, profiles, agents, now, run, changed, focusFallback }: PanelProps & { grant: VaultGrant; request: VaultRequest | undefined; profiles: VaultProfile[] }) {
  const { t, locale } = useI18n();
  const state = grantState(grant, request, profiles, now);
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <li className="grid gap-3 rounded-lg border border-border p-3" data-vault-grant={grant.id}>
      <div className="flex flex-wrap items-center gap-2"><StateBadge state={state} kind="grant" /><span className="break-all font-mono text-xs text-muted-foreground">{grant.id}</span></div>
      {request ? <RequestFacts request={request} profiles={profiles} agents={agents} /> : <p className="text-sm text-muted-foreground">{t("vault.grantRequestMissing")}</p>}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t("vault.lifetimeLegend")}</dt><dd>{t(`vault.lifetime.${grant.lifetime}`)}</dd>
        <dt className="text-muted-foreground">{t("vault.grantedAt")}</dt><dd>{date(grant.createdAt)}</dd>
        <dt className="text-muted-foreground">{t("vault.grantExpires")}</dt><dd>{grant.expiresAt ? date(grant.expiresAt) : t("vault.untilRevoked")}</dd>
      </dl>
      {state !== "active" && <p className="max-w-prose text-sm">{t(`vault.grantReason.${state}`)}</p>}
      {request?.permission === "use" && <p className="max-w-prose text-xs text-muted-foreground">{t("vault.useGrantNotDelivery")}</p>}
      <div>
        <VaultActionDialog
          trigger={{ label: t("vault.revoke"), icon: <Ban aria-hidden />, variant: "destructive" }}
          title={t("vault.revokeTitle")}
          description={<p>{t("vault.revokeDescription")}</p>}
          confirmLabel={t("vault.revokeConfirm")}
          confirmVariant="destructive"
          action={async () => {
            if (!vaultRevokeSchema.safeParse(await run(`revoke:${grant.id}`, { operation: "revoke", grantId: grant.id })).success) throw new VaultClientError("invalid_response");
            return t("vault.revoked", { grant: grant.id });
          }}
          changed={changed} focusFallback={focusFallback}
        />
      </div>
    </li>
  );
}
