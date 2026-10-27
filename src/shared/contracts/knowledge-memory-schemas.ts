import { z } from "zod";
const id = z.string().trim().min(1).max(160);
const revision = z.number().int().positive();
const project = { projectId: id };
const page = { limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(1000000).optional() };
export const knowledgeSourceSchema = z.union([
  z.strictObject({ kind: z.enum(["thread", "reply", "task", "memory"]), id, revision }),
  z.strictObject({ kind: z.literal("external"), label: z.string().trim().min(1).max(200), url: z.string().url().max(2048).refine(value => /^https?:\/\//i.test(value)) }),
  z.strictObject({ kind:z.literal("repository"), sourceId:id, repository:z.string().trim().min(1).max(4096), commit:z.string().regex(/^[a-f0-9]{40}$/), path:z.string().trim().min(1).max(4096) }),
]);
const memory = {
  title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(65536),
  category: z.enum(["decision", "question", "note"]),
  tags: z.array(z.string().trim().min(1).max(80)).max(20), legacyId: id.nullable(),
  sources: z.array(knowledgeSourceSchema).min(1).max(20),
};
const write = { ...project, idempotencyKey: z.string().trim().min(1).max(200) };
const change = { ...write, memoryId: id, expectedRevision: revision };
const context = { ...project, taskId: id, ...page, includeSuperseded: z.boolean().optional() };
export const memorySchemas = {
  memories: z.strictObject({ ...project, ...page, query: z.string().trim().max(200).optional(), includeInactive: z.boolean().optional() }),
  memory: z.strictObject({ ...project, memoryId: id }),
  create_memory: z.strictObject({ ...write, ...memory }),
  update_memory: z.strictObject({ ...change, ...memory }),
  approve_memory: z.strictObject(change),
  archive_memory: z.strictObject(change),
  restore_memory: z.strictObject(change),
  supersede_memory: z.strictObject({ ...change, replacementId: id, replacementRevision: revision }),
  search: z.strictObject({ ...project, ...page, query: z.string().trim().max(200).optional(), kind: z.enum(["thread", "reply", "task", "memory"]).optional(), status: z.enum(["active", "archived", "superseded", "open", "in_progress", "blocked", "done"]).optional(), tag: z.string().trim().min(1).max(80).optional(), legacyId: id.optional(), includeInactive: z.boolean().optional() }),
  task_context: z.strictObject(context),
  check_context_export: z.strictObject({ ...context, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  export_context: z.strictObject({ ...context, format: z.enum(["json", "markdown"]) }),
};
export type MemoryRequest = { [K in keyof typeof memorySchemas]: { operation: K; input: z.infer<(typeof memorySchemas)[K]> } }[keyof typeof memorySchemas];
