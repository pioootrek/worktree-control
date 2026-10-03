import { z } from "zod";
import { backupIdSchema } from "@/shared/contracts/backups";
import { BackupError } from "./policy";
import { readRecord, recordHash, writeRecord } from "./records";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const REMOTE_LIMITS = Object.freeze({ receipts: 2176, archives: 4, candidates: 256, proofs: 1024, passes: 8, readBytes: 256 * 1024 * 1024 });
export const proofSchema = z.object({ snapshotId: digest, tree: digest, state: z.enum(["partial", "complete"]) }).strict();
export const progressSchema = z.object({ passes: z.number().int().min(0).max(REMOTE_LIMITS.passes), readReservedBytes: z.number().int().min(0).max(REMOTE_LIMITS.passes * REMOTE_LIMITS.readBytes), proofs: z.array(proofSchema).max(REMOTE_LIMITS.candidates), inventoryHash: digest.optional() }).strict();
export type RemoteProgress = z.infer<typeof progressSchema>;
export const receiptSchema = z.object({
  backupId: backupIdSchema, manifestHash: digest, manifestSha256: digest, dataAt: z.iso.datetime(), sizeBytes: z.number().int().nonnegative(),
  state: z.enum(["pending", "running", "confirmed", "failed"]), attempts: z.number().int().min(0).max(10),
  nextAt: z.number().nullable(), confirmedAt: z.iso.datetime().nullable(), snapshotId: digest.nullable(),
  error: z.enum(["remote_failed", "remote_interrupted", "remote_inventory_changed"]).nullable(), retryGeneration: z.number().int().nonnegative().default(0),
  reconciliation: progressSchema.optional(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
const confirmationSchema = z.object({ backupId: backupIdSchema, dataAt: z.iso.datetime(), confirmedAt: z.iso.datetime(), snapshotId: digest }).strict();
const fields = { installationId: z.uuid(), destinationId: digest, receipts: z.array(receiptSchema).max(REMOTE_LIMITS.receipts), lastConfirmed: confirmationSchema.nullable().default(null) };
const legacySchema = z.object({ format: z.literal(1), ...fields }).strict();
const archiveSchema = z.object({ ...fields }).strict();
export const remoteLedgerSchema = z.object({ format: z.literal(2), ...fields, archives: z.array(archiveSchema).max(REMOTE_LIMITS.archives), rebindGeneration: z.number().int().nonnegative(), lastRebind: digest.nullable() }).strict().superRefine((record, ctx) => {
  const ledgers = [record, ...record.archives];
  if (ledgers.some(value => value.installationId !== record.installationId || new Set(value.receipts.map(receipt => receipt.backupId)).size !== value.receipts.length)
    || ledgers.some(value => value.receipts.some(receipt => receipt.reconciliation && new Set(receipt.reconciliation.proofs.map(proof => proof.snapshotId)).size !== receipt.reconciliation.proofs.length))
    || ledgers.reduce((sum, value) => sum + value.receipts.reduce((n, receipt) => n + (receipt.reconciliation?.proofs.length ?? 0), 0), 0) > REMOTE_LIMITS.proofs) ctx.addIssue({ code: "custom", message: "Invalid remote evidence bounds" });
});
export type RemoteLedger = z.infer<typeof remoteLedgerSchema>;
/** Immutable archived/confirmed receipts retain counters, not disposable reconciliation cache. */
export function releaseRemoteProofCache(receipts: Receipt[]): Receipt[] {
  return receipts.map(receipt => receipt.reconciliation ? { ...receipt, reconciliation: { passes: receipt.reconciliation.passes, readReservedBytes: receipt.reconciliation.readReservedBytes, proofs: [] } } : receipt);
}
export function assertRemoteLedgerCapacity(ledger: RemoteLedger, reservedBytes = 0): void {
  if (Buffer.byteLength(JSON.stringify({ payload: ledger, sha256: recordHash(ledger) })) + reservedBytes > 4 * 1024 * 1024) throw new BackupError("backup_limit", 409);
}
export function readRemoteLedger(path: string): RemoteLedger | null {
  // Verify the original format/checksum before adding migration fields.
  const record = readRecord(path, z.union([legacySchema, remoteLedgerSchema]));
  return !record ? null : record.format === 2 ? record : { ...record, format: 2, archives: [], rebindGeneration: 0, lastRebind: null };
}
export function writeRemoteLedger(path: string, ledger: RemoteLedger): void { const checked = remoteLedgerSchema.parse(ledger); assertRemoteLedgerCapacity(checked); writeRecord(path, checked); }
/** Caller owns both existing singleton locks. One publication includes all old pins. */
export function rebindRemoteLedger(path: string, from: string, destinationId: string, generation: number): RemoteLedger {
  digest.parse(from); digest.parse(destinationId);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BackupError("backup_invalid");
  const ledger = readRemoteLedger(path);
  if (!ledger) throw new BackupError("backup_invalid", 404);
  const request = recordHash({ from, destinationId, generation });
  if (generation === ledger.rebindGeneration && request === ledger.lastRebind) return ledger;
  if (generation !== ledger.rebindGeneration + 1 || from !== ledger.destinationId || from === destinationId) throw new BackupError("backup_invalid", 409);
  if (ledger.archives.length >= REMOTE_LIMITS.archives) throw new BackupError("backup_limit", 409);
  const { installationId, receipts, lastConfirmed } = ledger;
  const next: RemoteLedger = { ...ledger, destinationId, receipts: [], lastConfirmed: null, archives: [...ledger.archives.map(archive => ({ ...archive, receipts: releaseRemoteProofCache(archive.receipts) })), { installationId, destinationId: from, receipts: releaseRemoteProofCache(receipts), lastConfirmed }], rebindGeneration: generation, lastRebind: request };
  writeRemoteLedger(path, next);
  return next;
}
