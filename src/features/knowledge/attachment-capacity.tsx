"use client";

import { useEffect, useState } from "react";
import type { KnowledgeAttachmentPolicy } from "@/shared/contracts/knowledge-attachments";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { knowledgeRequest, isKnowledgeAccessError } from "./knowledge-client";

export function AttachmentCapacity({ token, projectId, refreshVersion }: { token: string; projectId: string; refreshVersion: number }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ version: string; policy?: KnowledgeAttachmentPolicy; error?: "denied" | "failed" }>();
  const version = `${token}:${projectId}:${refreshVersion}:${retry}`;
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void knowledgeRequest<KnowledgeAttachmentPolicy>(token, "attachment_policy", { projectId }, abort.signal)
      .then(policy => { if (!abort.signal.aborted) setState({ version, policy }); })
      .catch(error => { if (!abort.signal.aborted) setState({ version, error: isKnowledgeAccessError(error) ? "denied" : "failed" }); });
    return () => abort.abort();
  }, [open, token, projectId, version]);
  const current = state?.version === version ? state : undefined;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return <details className="shrink-0 rounded-lg border border-border p-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">{t("attachmentCapacity.title")}</summary>
    {open && <div className="mt-3 space-y-3" aria-live="polite">
      {!current && <p role="status">{t("knowledge.loading")}</p>}
      {current?.error && <div role="alert"><p>{t(current.error === "denied" ? "attachmentCapacity.denied" : "knowledge.loadFailed")}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>{t("knowledge.refresh")}</Button></div>}
      {current?.policy && <>
        <dl className="grid gap-3 sm:grid-cols-3">
          <div><dt className="text-muted-foreground">{t("attachmentCapacity.file")}</dt><dd>{number(current.policy.limits.fileBytes)} B</dd></div>
          <div><dt className="text-muted-foreground">{t("attachmentCapacity.bytes")}</dt><dd>{t("attachmentCapacity.usage", { used: number(current.policy.used.bytes), limit: number(current.policy.limits.projectBytes) })} B</dd><dd>{t("attachmentCapacity.remaining", { value: number(current.policy.remaining.bytes) })} B</dd></div>
          <div><dt className="text-muted-foreground">{t("attachmentCapacity.records")}</dt><dd>{t("attachmentCapacity.usage", { used: number(current.policy.used.files), limit: number(current.policy.limits.projectFiles) })}</dd><dd>{t("attachmentCapacity.remaining", { value: number(current.policy.remaining.files) })}</dd></div>
        </dl>
        <p>{t("attachmentCapacity.accounting")}</p>
        <p role="status">{t(current.policy.exceeded.length ? "attachmentCapacity.exceeded" : "attachmentCapacity.within")}</p>
        {current.policy.exceeded.length > 0 && <ul className="list-disc pl-5">{current.policy.exceeded.map(item => <li key={item.constraint}>{t(item.constraint === "projectFiles" ? "attachmentCapacity.records" : item.constraint === "fileBytes" ? "attachmentCapacity.file" : "attachmentCapacity.bytes")}: {number(item.used)} / {number(item.limit)} {item.unit === "bytes" ? "B" : t("attachmentCapacity.recordsUnit")}</li>)}</ul>}
      </>}
    </div>}
  </details>;
}
