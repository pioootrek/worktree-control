import { z } from "zod";

const id = z.string().min(1).max(160);
export const humanPageSchema = z.object({ limit: z.number().int().min(1).max(20).default(20), after: id.optional() }).strict();
export const humanMembershipPageSchema = humanPageSchema.extend({ principalId: id }).strict();
const target = {
  principalId: id,
  scope: z.object({ kind: z.literal("knowledge-project"), id }).strict(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
};
export const humanKnowledgeSetSchema = z.object({
  ...target, role: z.enum(["reader", "operator"]),
  permissions: z.array(z.enum(["knowledge:read", "knowledge:write"])).min(1).max(2)
    .refine(values => new Set(values).size === values.length),
}).strict();
export const humanKnowledgeRevokeSchema = z.object(target).strict();
export type HumanKnowledgeSet = z.infer<typeof humanKnowledgeSetSchema>;
export type HumanKnowledgeRevoke = z.infer<typeof humanKnowledgeRevokeSchema>;
export type HumanPage = z.infer<typeof humanPageSchema>;
export type HumanMembershipPage = z.infer<typeof humanMembershipPageSchema>;
export interface HumanKnowledgeMembership {
  principalId: string;
  scope: { kind: "knowledge-project"; id: string };
  role: "reader" | "operator" | "manager";
  revision: number;
  updatedAt: string;
  revokedAt: string | null;
  grant: { permissions: string[]; revokedAt: string | null } | null;
  effectivePermissions: Array<"knowledge:read" | "knowledge:write">;
}
