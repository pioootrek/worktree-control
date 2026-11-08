"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import type { KnowledgeMemory, KnowledgeSource } from "@/shared/contracts/knowledge-memory";
import type { KnowledgeFailure } from "@/shared/contracts/knowledge";
import { knowledgeRequest, KnowledgeClientError, type KnowledgeCredential } from "./knowledge-client";
import { fieldClass } from "./knowledge-editor";

export const knowledgeRetryKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("");
type Draft = { title: string; body: string; category: KnowledgeMemory["category"]; tags: string; legacyId: string; sources: KnowledgeSource[]; revision: number; key: string; error: KnowledgeFailure | null };

export function MemoryEditor({ token, principalId, projectId, record, onSaved, onClose, onConflict }: {
  token: KnowledgeCredential; principalId: string; projectId: string; record?: KnowledgeMemory;
  onSaved: (id: string) => void; onClose: () => void; onConflict: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const storageKey = `knowledge:memory-draft:v1:${principalId}:${projectId}:${record?.id ?? "new"}`;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      const initial: Draft = { title: record?.title ?? "", body: record?.body ?? "", category: record?.category ?? "decision", tags: record?.tags.join(", ") ?? "", legacyId: record?.legacyId ?? "", sources: record?.sources ?? [{ kind: "task", id: "", revision: 1 }], revision: record?.revision ?? 1, key: knowledgeRetryKey(), error: null };
      try {
        const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
        setDraft(stored && typeof stored.title === "string" && typeof stored.body === "string" && typeof stored.key === "string" && Array.isArray(stored.sources) ? stored : initial);
      } catch { setDraft(initial); }
    }, 0);
    return () => clearTimeout(timer);
    // Live revisions must not replace a user's pending draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const persist = (value: Draft) => { setDraft(value); try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* Keep the in-memory draft. */ } };
  if (!draft) return <p role="status">{t("knowledge.loading")}</p>;
  const edit = (patch: Partial<Draft>) => persist({ ...draft, ...patch });
  const conflict = draft.error?.code === "revision_conflict";
  const submit = async () => {
    setBusy(true); persist(draft);
    try {
      const input = { projectId, idempotencyKey: draft.key, title: draft.title, body: draft.body, category: draft.category,
        tags: draft.tags.split(",").map(tag => tag.trim()).filter(Boolean), legacyId: draft.legacyId.trim() || null, sources: draft.sources };
      const result = record
        ? await knowledgeRequest<{ value: KnowledgeMemory }>(token, "update_memory", { ...input, memoryId: record.id, expectedRevision: draft.revision })
        : await knowledgeRequest<{ value: KnowledgeMemory }>(token, "create_memory", input);
      try { sessionStorage.removeItem(storageKey); } catch { /* Saving already succeeded. */ }
      onSaved(result.value.id);
    } catch (error) {
      persist({ ...draft, error: error instanceof KnowledgeClientError ? error.failure : { code: "network_error", error: "Network error" } });
      onConflict();
    } finally { setBusy(false); }
  };
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h3 className="font-semibold">{t(record ? "knowledge.editMemory" : "knowledge.addMemory")}</h3>
    <p className="text-sm text-muted-foreground">{t("knowledge.approvalHelp")}</p>
    {draft.error && <p role="alert">{t(conflict ? "knowledge.conflict" : draft.error.code === "idempotency_conflict" ? "knowledge.retryConflict" : "knowledge.saveFailed")}</p>}
    {draft.error?.code === "idempotency_conflict" && <div className="space-y-2">
      <p className="text-sm">{t("knowledge.discardDraftHelp")}</p>
      <Button type="button" variant="outline" disabled={busy} onClick={() => {
        try { sessionStorage.removeItem(storageKey); } catch { /* The in-memory draft can still be discarded. */ }
        setDraft(null); onClose();
      }}>{t("knowledge.discardDraft")}</Button>
    </div>}
    {conflict && <div className="space-y-2">
      {record && <><p>{t("knowledge.savedVersion", { revision: record.revision })}</p><p className="whitespace-pre-wrap break-words">{record.body}</p></>}
      <p className="text-sm">{t("knowledge.sourceConflict")}</p>
      <Button type="button" variant="outline" disabled={busy} onClick={() => edit({ revision: record?.revision ?? draft.revision, error: null })}>{t("knowledge.rebaseDraft")}</Button>
    </div>}
    <div className="space-y-2"><Label htmlFor={`${id}-title`}>{t("knowledge.recordTitle")}</Label><Input id={`${id}-title`} autoFocus required maxLength={200} disabled={busy} value={draft.title} onChange={e => edit({ title: e.target.value })} /></div>
    <div className="space-y-2"><Label htmlFor={`${id}-body`}>{t("knowledge.body")}</Label><textarea id={`${id}-body`} className={`${fieldClass} min-h-32`} required maxLength={65536} disabled={busy} value={draft.body} onChange={e => edit({ body: e.target.value })} /></div>
    <div className="space-y-2"><Label htmlFor={`${id}-category`}>{t("knowledge.category")}</Label><select id={`${id}-category`} className={fieldClass} disabled={busy} value={draft.category} onChange={e => edit({ category: e.target.value as Draft["category"] })}>{(["decision", "question", "note"] as const).map(value => <option key={value} value={value}>{t(`knowledge.${value}`)}</option>)}</select></div>
    <div className="space-y-2"><Label htmlFor={`${id}-tags`}>{t("knowledge.tags")}</Label><Input id={`${id}-tags`} disabled={busy} value={draft.tags} onChange={e => edit({ tags: e.target.value })} /></div>
    <div className="space-y-2"><Label htmlFor={`${id}-legacy`}>{t("knowledge.legacyId")}</Label><Input id={`${id}-legacy`} maxLength={160} disabled={busy} value={draft.legacyId} onChange={e => edit({ legacyId: e.target.value })} /></div>
    <fieldset className="space-y-3" disabled={busy}><legend className="font-medium">{t("knowledge.sources")}</legend>
      {draft.sources.map((source, index) => {
        const replace = (value: KnowledgeSource) => edit({ sources: draft.sources.map((item, at) => at === index ? value : item) });
        return <div key={index} className="space-y-2 rounded-lg border border-border p-3">
          <Label htmlFor={`${id}-kind-${index}`}>{t("knowledge.sourceKind")}</Label><select id={`${id}-kind-${index}`} className={fieldClass} value={source.kind} onChange={e => replace(e.target.value === "external" ? { kind: "external", url: "", label: "" } : { kind: e.target.value as "task", id: "", revision: 1 })}>
            {(["task", "thread", "reply", "memory", "external"] as const).map(kind => <option key={kind} value={kind}>{t(`knowledge.source.${kind}`)}</option>)}
            {source.kind === "repository" && <option value="repository">repository</option>}
          </select>
          {source.kind === "external" ? <>
            <Label htmlFor={`${id}-url-${index}`}>{t("knowledge.sourceUrl")}</Label><Input id={`${id}-url-${index}`} type="url" required value={source.url} onChange={e => replace({ ...source, url: e.target.value })} />
            <Label htmlFor={`${id}-label-${index}`}>{t("knowledge.sourceLabel")}</Label><Input id={`${id}-label-${index}`} required value={source.label} onChange={e => replace({ ...source, label: e.target.value })} />
          </> : source.kind === "repository" ? <p className="break-all text-sm">{source.sourceId} · {source.repository} · {source.commit}:{source.path}</p> : <>
            <Label htmlFor={`${id}-source-${index}`}>{t("knowledge.sourceId")}</Label><Input id={`${id}-source-${index}`} required value={source.id} onChange={e => replace({ ...source, id: e.target.value })} />
            <Label htmlFor={`${id}-revision-${index}`}>{t("knowledge.sourceRevision")}</Label><Input id={`${id}-revision-${index}`} type="number" min={1} required value={source.revision} onChange={e => replace({ ...source, revision: Number(e.target.value) })} />
          </>}
          <Button type="button" variant="ghost" disabled={draft.sources.length === 1} onClick={() => edit({ sources: draft.sources.filter((_, at) => at !== index) })}>{t("knowledge.removeSource")}</Button>
        </div>;
      })}
      <Button type="button" variant="outline" disabled={draft.sources.length >= 20} onClick={() => edit({ sources: [...draft.sources, { kind: "task", id: "", revision: 1 }] })}>{t("knowledge.addSource")}</Button>
    </fieldset>
    <div className="flex gap-2"><Button type="submit" disabled={busy || conflict}>{t(busy ? "knowledge.saving" : "knowledge.save")}</Button><Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("knowledge.closeDraft")}</Button></div>
  </form>;
}
