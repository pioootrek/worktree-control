import { z } from "zod";

const id = z.string().min(1).max(160);
export const runtimeMembershipPageSchema = z.object({
  principalId: id, limit: z.number().int().min(1).max(20).default(20), after: id.optional(),
}).strict();
const target = {
  principalId: id,
  scope: z.object({ kind: z.literal("runtime-project"), id }).strict(),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
};
export const runtimeMembershipSetSchema = z.object({
  ...target, role: z.literal("reader"), permissions: z.tuple([z.literal("projects:read")]),
}).strict();
export const runtimeMembershipRevokeSchema = z.object(target).strict();
export type RuntimeMembershipPage = z.infer<typeof runtimeMembershipPageSchema>;
export type RuntimeMembershipSet = z.infer<typeof runtimeMembershipSetSchema>;
export type RuntimeMembershipRevoke = z.infer<typeof runtimeMembershipRevokeSchema>;
/** One CAS aggregate owns both role and explicit permissions, including its tombstone. */
export interface RuntimeMembership {
  principalId: string;
  scope: { kind: "runtime-project"; id: string };
  role: "reader";
  permissions: Array<"projects:read">;
  revision: number;
  updatedAt: string;
  revokedAt: string | null;
}
