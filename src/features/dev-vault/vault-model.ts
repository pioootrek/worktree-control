import { z } from "zod";
import { devUseBindingSchema } from "@/shared/contracts/dev-vault";

/** Browser-side shapes of DEV vault results. Unknown members are dropped, never rendered. */
const id = z.string().min(1).max(160);
const timestamp = z.string().min(1).max(64);
export const vaultProfileSchema = z.object({
  profileId: id, revision: z.number().int().positive(), createdAt: timestamp, updatedAt: timestamp,
});
export type VaultProfile = z.infer<typeof vaultProfileSchema>;
export const vaultPermissionSchema = z.enum(["read", "write", "use"]);
export type VaultPermission = z.infer<typeof vaultPermissionSchema>;
export const vaultLifetimeSchema = z.enum(["once", "15-minutes", "until-revoked"]);
export type VaultLifetime = z.infer<typeof vaultLifetimeSchema>;
export const vaultRequestSchema = z.object({
  id, agentId: id, credentialId: id, profileId: id, revision: z.number().int().positive(),
  permission: vaultPermissionSchema, status: z.enum(["pending", "approved", "rejected"]),
  createdAt: timestamp, expiresAt: timestamp, binding: devUseBindingSchema.optional(),
});
export type VaultRequest = z.infer<typeof vaultRequestSchema>;
export const vaultGrantSchema = z.object({
  id, requestId: id, lifetime: vaultLifetimeSchema, createdAt: timestamp,
  expiresAt: timestamp.nullable(), revokedAt: timestamp.nullable(), consumedBy: id.nullable(),
});
export type VaultGrant = z.infer<typeof vaultGrantSchema>;
export const vaultListSchema = z.object({ profiles: z.array(vaultProfileSchema).max(64) });
export const vaultRequestsSchema = z.object({ requests: z.array(vaultRequestSchema).max(256), grants: z.array(vaultGrantSchema).max(256) });
export const vaultReadSchema = vaultProfileSchema.extend({ environment: z.record(z.string(), z.string()) });
export const vaultInspectSchema = vaultRequestSchema.extend({ proposal: z.record(z.string(), z.string()).optional() });
export const vaultAuditSchema = z.object({ events: z.array(z.object({
  operation: z.string().max(40), actorId: id, at: timestamp,
  profileId: id.optional(), requestId: id.optional(), grantId: id.optional(),
})).max(256) });
export const vaultRevokeSchema = z.object({ grantId: id, revokedAt: timestamp });
export const vaultRejectSchema = z.object({ requestId: id, status: z.literal("rejected") });

/** Fixed server codes plus client-side failures; no message text from a response is ever shown. */
export type VaultErrorCode = "vault_denied" | "vault_unavailable" | "vault_invalid_request" | "vault_conflict" | "vault_limit"
  | "vault_use_unavailable" | "transport" | "invalid_response" | "locked" | "session_invalid" | "not_owner_session";
const serverCodes = new Set<string>(["vault_denied", "vault_unavailable", "vault_invalid_request", "vault_conflict", "vault_limit", "vault_use_unavailable"]);
export function vaultErrorCode(value: unknown): VaultErrorCode {
  return typeof value === "string" && serverCodes.has(value) ? value as VaultErrorCode : "vault_unavailable";
}
export class VaultClientError extends Error {
  constructor(readonly code: VaultErrorCode) { super(code); }
  /** Transport uncertainty: the same operation ID may be retried to recover a committed result. */
  get retryable(): boolean { return this.code === "transport"; }
}

/** One signed read of a project's profile metadata, requests and grants. */
export interface VaultSnapshot { profiles: VaultProfile[]; requests: VaultRequest[]; grants: VaultGrant[]; loadedAt: number }

export type RequestState = "pending" | "expired" | "stale" | "missing_profile" | "approved" | "rejected";
/** Presentation only; the controller re-checks expiry, revision, credential and status on approval. */
export function requestState(request: VaultRequest, profiles: readonly VaultProfile[], now: number): RequestState {
  if (request.status !== "pending") return request.status;
  if (Date.parse(request.expiresAt) <= now) return "expired";
  const profile = profiles.find(candidate => candidate.profileId === request.profileId);
  if (!profile) return "missing_profile";
  return profile.revision === request.revision ? "pending" : "stale";
}

export type GrantState = "active" | "consumed" | "expired" | "stale" | "applied";
export function grantState(grant: VaultGrant, request: VaultRequest | undefined, profiles: readonly VaultProfile[], now: number): GrantState {
  if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now) return "expired";
  const profile = request && profiles.find(candidate => candidate.profileId === request.profileId);
  // A newer revision may come from an owner update, not this patch. Only once
  // grants expose consumption; timed write grants conservatively become stale.
  if (request?.permission === "write" && grant.lifetime === "once" && grant.consumedBy !== null && profile && profile.revision > request.revision) return "applied";
  if (request && profile && profile.revision !== request.revision) return "stale";
  if (grant.lifetime === "once" && grant.consumedBy !== null) return "consumed";
  return "active";
}

export const VAULT_LIFETIMES: readonly VaultLifetime[] = ["once", "15-minutes", "until-revoked"];
export const VAULT_IDLE_LOCK_MS = 10 * 60_000;

/** Estimates controller clock offset from a response Date header (whole seconds). */
export function clockSkew(dateHeader: string | null, receivedAt: number): number {
  const server = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (!Number.isFinite(server)) return 0;
  // Use the server second's lower bound at receipt, without guessing network
  // latency. Every offset is corrected; proof backdating adds a further margin.
  return Math.round(server - receivedAt);
}
/** Proofs must not be dated in the future and expire after 60 seconds at the controller. */
export function proofTimestamp(now: number, skewMs: number): string {
  return new Date(now + skewMs - 1_000).toISOString();
}
