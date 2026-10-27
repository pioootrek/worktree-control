import { z } from "zod";

export const DEV_VAULT_DISCLAIMER = "DEV credentials only. Never import staging or production credentials. Classification cannot be verified from a value. Read exposes values; executable code receiving values can copy them. Expiry and revocation only block future access, not copies or provider credentials.";
export const DEV_DOTENV_BYTES = 32 * 1024;
const id = z.uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const base = { projectId: id, operationId: id, environment: z.literal("DEV") };
export const devUseBindingSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  presetId: z.string().min(1).max(128),
  commandDigest: z.string().regex(/^[0-9a-f]{64}$/),
  workerId: id,
});
export type DevUseBinding = z.infer<typeof devUseBindingSchema>;
export const devVaultCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...base, operation: z.literal("import"), dotenv: z.string().max(DEV_DOTENV_BYTES) }),
  z.strictObject({ ...base, operation: z.literal("update"), profileId: id, revision, dotenv: z.string().max(DEV_DOTENV_BYTES) }),
  z.strictObject({ ...base, operation: z.literal("list") }),
  z.strictObject({ ...base, operation: z.literal("read"), profileId: id, revision, grantId: id.optional() }),
  z.strictObject({ ...base, operation: z.literal("request"), profileId: id, revision,
    permission: z.enum(["read", "write", "use"]), dotenv: z.string().max(DEV_DOTENV_BYTES).optional(),
    source: z.literal("inline-dotenv").optional(), binding: devUseBindingSchema.optional() }),
  z.strictObject({ ...base, operation: z.literal("requests") }),
  z.strictObject({ ...base, operation: z.literal("inspect-request"), requestId: id }),
  z.strictObject({ ...base, operation: z.literal("approve"), requestId: id, revision,
    lifetime: z.enum(["once", "15-minutes", "until-revoked"]) }),
  z.strictObject({ ...base, operation: z.literal("reject"), requestId: id }),
  z.strictObject({ ...base, operation: z.literal("revoke"), grantId: id }),
  z.strictObject({ ...base, operation: z.literal("write"), grantId: id }),
  z.strictObject({ ...base, operation: z.literal("use"), profileId: id, revision, grantId: id, binding: devUseBindingSchema }),
  z.strictObject({ ...base, operation: z.literal("audit") }),
]);
export type DevVaultCommand = z.infer<typeof devVaultCommandSchema>;
export const devOwnerProofSchema = z.strictObject({
  issuedAt: z.iso.datetime(), signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type DevOwnerProof = z.infer<typeof devOwnerProofSchema>;
export const devVaultRequestSchema = z.strictObject({ command: devVaultCommandSchema, proof: devOwnerProofSchema.optional() });
