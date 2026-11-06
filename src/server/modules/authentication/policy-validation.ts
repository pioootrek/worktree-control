import { z } from "zod";
import type { AuthenticationPolicy } from "./contracts";

const policySchema = z.object({
  mode: z.enum(["legacy", "open", "token", "better-auth"]),
  generation: z.number().int().nonnegative(),
  token: z.object({
    id: z.uuid(),
    prefix: z.string(),
    verifierHash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.iso.datetime(),
  }).strict().refine(token => token.prefix === `wsi_${token.id}`).nullable(),
}).strict();

/** A malformed stored policy is never repaired or downgraded during authentication. */
export function validateAuthenticationPolicy(value: unknown): AuthenticationPolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored authentication policy is invalid.");
  return parsed.data;
}
