import { z } from "zod";
import { humanRuntimePermissionsSchema } from "@/shared/contracts/runtime-memberships";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const session = z.object({ principalId: z.string().min(1).max(160), sessionKey: digest, evidenceKey: digest,
  generation: z.number().int().nonnegative(), deadline: z.string().datetime() });
export const humanTestRequesterSchema = z.object({
  kind: z.literal("human"), projectId: z.string().min(1).max(160), sessionOwner: z.string().min(1).max(160),
  authority: session.extend({ membershipRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), permissions: humanRuntimePermissionsSchema }).strict(),
  reference: session.extend({ nativeSessionId: z.string().min(1).max(512) }).strict(),
  reservationId: z.string().uuid().nullable(), fingerprint: digest,
}).strict().refine(r => r.sessionOwner === `human:test:${r.authority.principalId}` && r.authority.permissions.includes("tests:run")
  && r.authority.principalId === r.reference.principalId && r.authority.sessionKey === r.reference.sessionKey
  && r.authority.evidenceKey === r.reference.evidenceKey && r.authority.generation === r.reference.generation && r.authority.deadline === r.reference.deadline);
