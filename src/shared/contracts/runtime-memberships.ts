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
export const humanRuntimeActions = ["projects:read", "claims:manage", "runtime:control", "tests:run", "profiles:select", "config:write"] as const;
export const humanRuntimePermissionsSchema = z.array(z.enum(humanRuntimeActions)).min(1).max(6)
  .refine(values => new Set(values).size === values.length);
export const runtimeMembershipSetSchema = z.discriminatedUnion("role", [
  z.object({ ...target, role: z.literal("reader"), permissions: z.tuple([z.literal("projects:read")]) }).strict(),
  z.object({ ...target, role: z.literal("operator"), permissions: humanRuntimePermissionsSchema }).strict(),
]);
export const runtimeMembershipRevokeSchema = z.object(target).strict();
export type RuntimeMembershipPage = z.infer<typeof runtimeMembershipPageSchema>;
export type RuntimeMembershipSet = z.infer<typeof runtimeMembershipSetSchema>;
export type RuntimeMembershipRevoke = z.infer<typeof runtimeMembershipRevokeSchema>;
/** One CAS aggregate owns both role and explicit permissions, including its tombstone. */
export interface RuntimeMembership {
  principalId: string;
  scope: { kind: "runtime-project"; id: string };
  role: "reader" | "operator";
  permissions: Array<typeof humanRuntimeActions[number]>;
  revision: number;
  updatedAt: string;
  revokedAt: string | null;
}
