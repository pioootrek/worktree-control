import type Database from "better-sqlite3";
import type { CredentialAuthenticationRecord, Principal } from "@/server/modules/identity";

/** Only the stored facts used to verify and fingerprint a machine credential. */
export interface StoredMachineCredential extends Pick<CredentialAuthenticationRecord,
  "id" | "principalId" | "kind" | "verifierHash" | "status" | "expiresAt" | "createdAt" | "revokedAt"> {
  readonly principal: Pick<Principal, "id" | "kind" | "status">;
}

type Row = Omit<StoredMachineCredential, "principal"> & {
  principalKind: Principal["kind"];
  principalStatus: Principal["status"];
};

/**
 * Borrows the store's guarded core connection. Callers must be inside an
 * admitted core phase when strict admission is enabled. No transaction, cache,
 * eligibility decision or usage write: one statement reads both stored rows.
 */
export class MachineCredentialQueries {
  constructor(private readonly database: Database.Database) {}

  /**
   * The credential and its principal, including inactive facts, or null.
   * Malformed IDs name no credential; syntax matches the existing bearer
   * parser's ID component. The verifier hash is server-only, never a DTO.
   */
  credential(id: string): StoredMachineCredential | null {
    // Prepare on the guarded handle first: malformed IDs must not bypass the
    // same admission requirement as every other read on this port.
    const statement = this.database.prepare(`SELECT c.id,c.principal_id AS principalId,c.kind,c.verifier_hash AS verifierHash,
      c.status,c.expires_at AS expiresAt,c.created_at AS createdAt,c.revoked_at AS revokedAt,
      p.kind AS principalKind,p.status AS principalStatus
      FROM principal_credentials c JOIN remote_principals p ON p.id=c.principal_id WHERE c.id=?`);
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = statement.get(id) as Row | undefined;
    if (!row) return null;
    const { principalKind, principalStatus, ...credential } = row;
    return { ...credential, principal: { id: row.principalId, kind: principalKind, status: principalStatus } };
  }
}
