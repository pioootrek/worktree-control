import type { Reservation } from "@/shared/contracts";
import { timingSafeEqual } from "node:crypto";

export type ReservationRow = {
  id: string;
  project_id: string;
  worktree_path: string;
  kind: "human" | "agent";
  owner: string;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
  maximum_expires_at: string | null;
  token_hash: string | null;
  idempotency_key: string | null;
  released_at?: string | null;
  principal_id?: string | null;
  credential_id?: string | null;
  request_fingerprint?: string | null;
};

export function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    projectId: row.project_id,
    worktreePath: row.worktree_path,
    kind: row.kind,
    owner: row.owner,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    maximumExpiresAt: row.maximum_expires_at,
  };
}

export function equalHash(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Scoped leases match only their exact principal and credential; unbound leases match only unbound callers. */
export function equalBinding(row: Pick<ReservationRow, "principal_id" | "credential_id">, binding?: { principalId: string; credentialId: string } | null): boolean {
  return (row.principal_id ?? null) === (binding?.principalId ?? null) && (row.credential_id ?? null) === (binding?.credentialId ?? null);
}
