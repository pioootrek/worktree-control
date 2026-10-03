import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashFile } from "@/server/infrastructure/sqlite";
import { backupIdSchema } from "@/shared/contracts/backups";
import type { BackupCatalog } from "./catalog";
import { BackupError } from "./policy";
import { readRecord, recordHash, writeRecord } from "./records";
import type { RemoteBackupTransport } from "./remote-policy";

const receiptSchema = z.object({
  backupId: backupIdSchema, manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), dataAt: z.iso.datetime(), sizeBytes: z.number().int().nonnegative(),
  state: z.enum(["pending", "running", "confirmed", "failed"]), attempts: z.number().int().min(0).max(10),
  nextAt: z.number().nullable(), confirmedAt: z.iso.datetime().nullable(), snapshotId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  error: z.enum(["remote_failed", "remote_interrupted"]).nullable(),
  retryGeneration: z.number().int().nonnegative().default(0),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
const confirmationSchema = z.object({ backupId: backupIdSchema, dataAt: z.iso.datetime(), confirmedAt: z.iso.datetime(), snapshotId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const RECEIPT_LIMIT = 2176;
const ledgerSchema = z.object({ format: z.literal(1), installationId: z.uuid(), destinationId: z.string().regex(/^[a-f0-9]{64}$/), receipts: z.array(receiptSchema).max(RECEIPT_LIMIT), lastConfirmed: confirmationSchema.nullable().default(null) }).strict();
type Ledger = z.infer<typeof ledgerSchema>;
export interface RemoteBackupStatus {
  enabled: boolean; pending: number; error: "remote_failed" | "remote_limit" | null;
  lastConfirmed: { backupId: string; dataAt: string; confirmedAt: string; snapshotId: string } | null;
  // A remote receipt proves an authenticated snapshot, not a recovery drill.
  recovery: "not-measured";
  transfers: Array<Omit<Receipt, "manifestHash" | "manifestSha256">>;
}
interface RemoteDependencies {
  directory: string | undefined; recordDirectory: string; catalog: BackupCatalog; now: () => number;
  enqueue: (execute: () => Promise<void>, interrupt: () => void, settled: () => void) => void;
  maintenance: () => boolean;
  retired: (backupId: string) => boolean;
  unrecorded: () => number;
}
/** External ledger survives database restore; execution belongs to BackupOperations. */
export class RemoteBackups {
  private readonly path: string;
  private ledger: Ledger | null;
  private queued = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistenceFailed = false;
  constructor(private readonly transport: RemoteBackupTransport | undefined, private readonly deps: RemoteDependencies) {
    this.path = join(deps.recordDirectory, "remote.json");
    this.ledger = readRecord(this.path, ledgerSchema);
    if (transport && !deps.directory) throw new BackupError("backup_invalid");
    if (transport && this.ledger && this.ledger.destinationId !== transport.destinationId) throw new BackupError("backup_invalid");
    if (transport && !this.ledger) { this.ledger = { format: 1, installationId: randomUUID(), destinationId: transport.destinationId, receipts: [], lastConfirmed: null }; this.save(); }
    if (transport && this.ledger) {
      for (const receipt of this.ledger.receipts) if (receipt.state === "running") {
        // The remote outcome is unknown. A retry must discover the stable identity first.
        receipt.state = "pending"; receipt.nextAt = deps.now(); receipt.error = "remote_interrupted";
      }
      this.save();
    }
  }
  get enabled(): boolean { return Boolean(this.transport); }
  hasReceipt(backupId: string): boolean { return Boolean(this.ledger?.receipts.some(receipt => receipt.backupId === backupId)); }
  assertCapacity(reserved = 0): void {
    if (!this.transport) return;
    if (this.persistenceFailed || this.closed) throw new BackupError("backup_busy", 503);
    if (this.pending() + reserved >= this.transport.policy.pendingLimit || (this.ledger?.receipts.length ?? 0) + reserved >= RECEIPT_LIMIT) throw new BackupError("backup_limit", 409);
  }
  protectedIds(): Set<string> {
    // Disabled transport preserves sources for explicit future retries as well.
    return new Set(this.ledger?.receipts.filter(receipt => receipt.state !== "confirmed").map(receipt => receipt.backupId));
  }
  status(): RemoteBackupStatus {
    return {
      enabled: this.enabled, pending: this.pending() + this.deps.unrecorded(),
      error: !this.enabled ? null : this.persistenceFailed || this.deps.unrecorded() || this.ledger?.receipts.some(receipt => receipt.error) ? "remote_failed" : this.pending() >= this.transport!.policy.pendingLimit ? "remote_limit" : null,
      lastConfirmed: this.ledger?.lastConfirmed ?? null,
      recovery: "not-measured",
      transfers: (this.ledger?.receipts ?? []).slice(-50).reverse().map(({ manifestHash, manifestSha256, ...receipt }) => { void manifestHash; void manifestSha256; return receipt; }),
    };
  }
  /** Only server-recorded, successful copies in the configured catalog are eligible. */
  record(backupId: string, manifestHash: string, dataAt: string): void {
    if (!this.transport || this.ledger!.receipts.some(receipt => receipt.backupId === backupId)) return;
    this.compact();
    this.assertCapacity();
    const manifest = this.deps.catalog.manifest(backupId);
    if (recordHash(manifest) !== manifestHash) throw new BackupError("backup_invalid");
    this.ledger!.receipts.push({ backupId, manifestHash, manifestSha256: hashFile(join(this.deps.catalog.path(backupId), "manifest.json")).sha256, dataAt, sizeBytes: manifest.database.size + manifest.attachments.reduce((sum, file) => sum + file.size, 0), state: "pending", attempts: 0, nextAt: this.deps.now(), confirmedAt: null, snapshotId: null, error: null, retryGeneration: 0 });
    this.save();
  }
  retry(backupId: string, generation: number): RemoteBackupStatus {
    backupIdSchema.parse(backupId);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new BackupError("backup_invalid");
    if (!this.transport || this.closed || this.persistenceFailed) throw new BackupError("backup_busy", 503);
    const receipt = this.ledger!.receipts.find(value => value.backupId === backupId);
    if (!receipt) throw new BackupError("backup_invalid", 404);
    // A monotonic generation fences all older retries without an unbounded key history.
    if (generation <= receipt.retryGeneration || receipt.state === "confirmed") return this.status();
    if (generation !== receipt.retryGeneration + 1) throw new BackupError("backup_invalid", 409);
    if (receipt.state === "running" || this.queued) throw new BackupError("backup_busy", 409);
    receipt.retryGeneration = generation; receipt.attempts = 0;
    receipt.state = "pending"; receipt.nextAt = this.deps.now(); this.save(); this.tick();
    return this.status();
  }
  start(): void { if (this.transport && !this.closed) { this.tick(); this.arm(); } }
  tick(): void {
    if (!this.transport || this.closed || this.persistenceFailed || this.queued || this.deps.maintenance()) return;
    const receipt = this.ledger!.receipts.find(value => value.state === "pending" && value.nextAt !== null && value.nextAt <= this.deps.now());
    if (!receipt) return;
    this.queued = true;
    try {
      this.deps.enqueue(() => this.execute(receipt), () => { this.queued = false; }, () => { this.queued = false; this.tick(); });
    } catch (error) { this.queued = false; if (!(error instanceof BackupError)) throw error; }
  }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; await this.transport?.close(); }
  private pending(): number { return this.ledger?.receipts.filter(receipt => receipt.state !== "confirmed").length ?? 0; }
  private async execute(receipt: Receipt): Promise<void> {
    if (this.closed || this.deps.maintenance()) return;
    try {
      const reconcileOnly = receipt.attempts >= this.transport!.policy.attemptLimit;
      receipt.state = "running"; if (!reconcileOnly) receipt.attempts++; receipt.nextAt = null; this.save();
      const manifest = await this.deps.catalog.verifyAsync(receipt.backupId);
      const source = this.deps.catalog.path(receipt.backupId);
      if (this.closed || recordHash(manifest) !== receipt.manifestHash || hashFile(join(source, "manifest.json")).sha256 !== receipt.manifestSha256) throw new BackupError("backup_invalid");
      const files = [{ path: "/manifest.json", size: lstatSync(join(source, "manifest.json")).size }, { path: "/state.sqlite3", size: manifest.database.size }, ...manifest.attachments.map(file => ({ path: `/attachments/${file.file}`, size: file.size }))];
      const result = await this.transport!.upload({ installationId: this.ledger!.installationId, backupId: receipt.backupId, source, manifestSha256: receipt.manifestSha256, files }, { reconcileOnly });
      if (this.closed || !/^[a-f0-9]{64}$/.test(result.snapshotId)) throw new BackupError("backup_failed");
      receipt.state = "confirmed"; receipt.snapshotId = result.snapshotId; receipt.confirmedAt = new Date(this.deps.now()).toISOString(); receipt.error = null;
      if (!this.ledger!.lastConfirmed || this.ledger!.lastConfirmed.dataAt <= receipt.dataAt) this.ledger!.lastConfirmed = { backupId: receipt.backupId, dataAt: receipt.dataAt, confirmedAt: receipt.confirmedAt, snapshotId: receipt.snapshotId };
    } catch {
      receipt.error = "remote_failed";
      receipt.state = receipt.attempts < this.transport!.policy.attemptLimit ? "pending" : "failed";
      receipt.nextAt = receipt.state === "pending" ? this.deps.now() + this.transport!.policy.retrySeconds * 1000 : null;
    }
    this.save();
  }
  private save(): void { if (!this.ledger) return; try { writeRecord(this.path, this.ledger); } catch { this.persistenceFailed = true; throw new BackupError("backup_failed", 503); } }
  private compact(): void {
    if (!this.transport || !this.ledger || !this.deps.directory) return;
    const retained = this.ledger.receipts.filter(receipt => receipt.state !== "confirmed" || !this.deps.retired(receipt.backupId) || existsSync(join(this.deps.directory!, receipt.backupId)));
    if (retained.length !== this.ledger.receipts.length) { this.ledger.receipts = retained; this.save(); }
  }
  private arm(): void {
    if (this.closed || !this.transport) return;
    this.timer = setTimeout(() => { try { this.tick(); } catch { this.persistenceFailed = true; } this.arm(); }, 60_000); this.timer.unref();
  }
}
