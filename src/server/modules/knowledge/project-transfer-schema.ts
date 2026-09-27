import { z } from "zod";
import { knowledgeSourceSchema } from "@/shared/contracts/knowledge-memory-schemas";
import type { KnowledgeProjectExportManifest, KnowledgeProjectSnapshot } from "./contracts";

const id = z.string().min(1).max(160);
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().positive();
const json = (schema: z.ZodType) => z.string().superRefine((value, context) => {
  try { schema.parse(JSON.parse(value)); } catch { context.addIssue({ code: "custom", message: "Invalid nested JSON." }); }
});
const nullableJson = (schema: z.ZodType) => z.string().nullable().superRefine((value, context) => {
  if (value === null) return;
  try { schema.parse(JSON.parse(value)); } catch { context.addIssue({ code: "custom", message: "Invalid nested JSON." }); }
});
const projectId = { project_id: id };
const authored = { created_by: id, created_at: timestamp };
const record = { id, ...projectId };
const recordKind = z.enum(["thread", "reply", "task", "memory"]);

const project = z.strictObject({ id, name: z.string().min(1).max(120), status: z.enum(["active", "archived"]), revision, created_at: timestamp, updated_at: timestamp });
const thread = z.strictObject({ ...record, title: z.string().min(1).max(200), body: z.string().min(1).max(65536), revision, ...authored, updated_at: timestamp });
const reply = z.strictObject({ ...record, thread_id: id, body: z.string().min(1).max(65536), revision, ...authored, updated_at: timestamp });
const task = z.strictObject({ ...record, title: z.string().min(1).max(200), description: z.string().min(1).max(65536), status: z.enum(["open", "in_progress", "blocked", "done", "archived"]), priority: z.enum(["now", "next", "later"]), revision, ...authored, updated_at: timestamp });
const memory = z.strictObject({ ...record, title: z.string().min(1).max(200), body: z.string().min(1).max(65536), category: z.enum(["decision", "question", "note"]),
  tags_json: json(z.array(z.string().max(100)).max(100)), legacy_id: z.string().max(160).nullable(), sources_json: json(z.array(knowledgeSourceSchema).max(100)),
  status: z.enum(["active", "archived", "superseded"]), superseded_by_json: nullableJson(z.strictObject({ id, revision })),
  approval_json: nullableJson(z.strictObject({ revision, principalId: id, approvedAt: timestamp })), revision, ...authored, updated_at: timestamp });
const relation = z.strictObject({ ...record, type: z.enum(["derived_from", "blocks", "relates_to", "supersedes"]), source_kind: recordKind, source_id: id, target_kind: recordKind, target_id: id, revision, ...authored });
const history = z.strictObject({ ordinal: z.number().int().positive(), ...projectId, record_kind: z.enum(["project", "thread", "reply", "task", "memory", "relation"]), record_id: id,
  operation: z.enum(["created", "updated", "archived", "linked", "unlinked", "approved", "superseded"]), previous_json: nullableJson(z.unknown()), principal_id: id,
  authentication_method: z.enum(["owner_session", "agent_token", "worker_token", "installation_token", "none"]), revision, created_at: timestamp });
const attachment = z.strictObject({ ...record, record_kind: recordKind, record_id: id, filename: z.string().min(1).max(255), media_type: z.string().min(1).max(255),
  size: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), ...authored });
const importSource = z.strictObject({ ...record, source_id:id, source_repository:z.string().min(1).max(4096), source_commit:z.string().regex(/^[a-f0-9]{40}$/), source_path:z.string().min(1).max(4096), legacy_id:z.string().max(160).nullable(),
  source_sha256:z.string().regex(/^[a-f0-9]{64}$/), mapping_version:z.number().int().positive(), target_kind:z.string().max(100).nullable(), target_id:id.nullable(), target_revision:revision.nullable().optional().default(null), original_payload_json:nullableJson(z.unknown()), created_at:timestamp });

const snapshotSchema = z.strictObject({ project, threads:z.array(thread), replies:z.array(reply), tasks:z.array(task), memories:z.array(memory), relations:z.array(relation), history:z.array(history), attachments:z.array(attachment), importSources:z.array(importSource).default([]), requiredPrincipals:z.array(id) });
const count=z.number().int().nonnegative();
const manifestSchema=z.strictObject({formatVersion:z.literal(1),applicationVersion:z.string().min(1).max(100),schemaVersion:z.number().int().positive(),createdAt:timestamp,projectId:id,
  data:z.strictObject({file:z.literal("project.json"),size:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}),
  attachments:z.array(z.strictObject({file:z.string().min(1),size:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)})),
  counts:z.strictObject({threads:count,replies:count,tasks:count,memories:count,relations:count,history:count,attachments:count,importSources:count.optional().default(0)})});

export function parseKnowledgeProjectSnapshot(value: unknown): KnowledgeProjectSnapshot {
  return snapshotSchema.parse(value) as KnowledgeProjectSnapshot;
}
export function parseKnowledgeProjectExportManifest(value:unknown):KnowledgeProjectExportManifest{return manifestSchema.parse(value) as KnowledgeProjectExportManifest;}
