import { z } from "zod";

/**
 * Scoped agent runtime actions delivered by A2. Each is granted only explicitly;
 * none implies another and no role bundle grants `profiles:select` or
 * `config:write`. Test admission, logs and ENV access are deliberately absent:
 * requests naming them are rejected rather than stored as inert grants.
 */
export const runtimeActions = ["projects:read", "claims:manage", "runtime:control", "profiles:select", "config:write"] as const;
export type RuntimeAction = typeof runtimeActions[number];

export function isRuntimeAction(value: unknown): value is RuntimeAction {
  return typeof value === "string" && (runtimeActions as readonly string[]).includes(value);
}

/** Owner-sponsored delegation of runtime actions on one registered project to one agent. */
export interface RuntimeDelegation {
  principalId: string;
  projectId: string;
  /** Derived from the authenticated owner session; never supplied by the request. */
  sponsorId: string;
  actions: RuntimeAction[];
  revision: number;
  expiresAt: string | null;
  updatedAt: string;
  revokedAt: string | null;
}

/** Immutable per-credential ceiling, fixed at issuance or rotation. */
export interface RuntimeCredentialScope {
  credentialId: string;
  projectId: string;
  actions: RuntimeAction[];
  createdAt: string;
}

/** Current effective authority: credential ceiling ∩ active delegation, bounded by both expiries. */
export interface RuntimeAccessEntry {
  projectId: string;
  actions: RuntimeAction[];
  expiresAt: string | null;
}

const identifier = z.string().min(1).max(160);
const timestamp = z.string().min(1).max(40);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const actions = z.array(z.enum(runtimeActions)).min(1).max(runtimeActions.length);
const scopes = z.array(z.object({ projectId: identifier, actions }).strict()).min(1).max(64);

export const setRuntimeDelegationSchema = z.object({
  principalId: identifier,
  projectId: identifier,
  actions,
  /** Omitted or null keeps the delegation until revoked; no default lifetime applies. */
  expiresAt: timestamp.nullable().optional(),
  expectedRevision: revision,
}).strict();
export const revokeRuntimeDelegationSchema = z.object({
  principalId: identifier, projectId: identifier, expectedRevision: revision,
}).strict();
export const listRuntimeAccessSchema = z.object({ principalId: identifier }).strict();
export const issueRuntimeCredentialSchema = z.object({
  principalId: identifier,
  label: z.string().min(1).max(120),
  expiresAt: timestamp.optional(),
  projects: scopes,
}).strict();
export const rotateRuntimeCredentialSchema = z.object({
  credentialId: identifier,
  label: z.string().min(1).max(120).optional(),
  /** Must not exceed the replaced credential's expiry; omitted keeps it. */
  expiresAt: timestamp.optional(),
  /** Subset of the replaced ceiling; omitted keeps it. */
  projects: scopes.optional(),
}).strict();

export type SetRuntimeDelegationInput = z.infer<typeof setRuntimeDelegationSchema>;
export type RevokeRuntimeDelegationInput = z.infer<typeof revokeRuntimeDelegationSchema>;
export type IssueRuntimeCredentialInput = z.infer<typeof issueRuntimeCredentialSchema>;
export type RotateRuntimeCredentialInput = z.infer<typeof rotateRuntimeCredentialSchema>;

/** Safe scoped-agent views. Fields are an explicit allowlist; never spread internal records into them. */
export type ScopedClaimRelation = "none" | "own" | "other";
export interface ScopedOwnClaim {
  reservationId: string;
  worktreePath: string;
  expiresAt: string | null;
  maximumExpiresAt: string | null;
}
export interface ScopedProjectSummary {
  id: string;
  name: string;
  port: number;
  actions: RuntimeAction[];
  phase: "stopped" | "starting" | "running" | "stopping" | "failed";
  worktreePath: string | null;
  claim: ScopedClaimRelation;
}
export interface ScopedProjectStatus extends ScopedProjectSummary {
  selectedWorktreePath: string | null;
  startedAt: string | null;
  managedServer: boolean;
  ownClaim: ScopedOwnClaim | null;
}
export interface ScopedWorktree {
  path: string;
  branch: string | null;
  head: string;
  shortHead: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  dirty: boolean;
}
export interface ScopedClaimResult {
  projectId: string;
  reservationId: string;
  worktreePath: string;
  expiresAt: string | null;
  maximumExpiresAt: string | null;
  startRequested: boolean;
  error: { code: string; message: string } | null;
  leaseHeld: true;
  /** Null unless the credential also holds projects:read. */
  status: ScopedProjectStatus | null;
}
export interface ScopedRuntimeReceipt {
  schemaVersion: 1;
  operationId: string;
  action: "start" | "restart" | "stop";
  projectId: string;
  reservationId: string;
  outcome: "completed" | "noop" | "failed";
  replayed: boolean;
  observedAt: string;
  port: number;
  claimedWorktreePath: string;
  runtime: { phase: ScopedProjectSummary["phase"]; worktreePath: string | null; startedAt: string | null };
  error: { code: string; message: string } | null;
  leaseHeld: boolean;
}
