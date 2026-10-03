import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "@/server/infrastructure/sqlite";
import { backupIdSchema } from "@/shared/contracts/backups";
import type { BackupCatalog } from "./catalog";
import { BackupError } from "./policy";
import { recordHash } from "./records";
import { assertRemoteLedgerCapacity, readRemoteLedger, writeRemoteLedger, REMOTE_LIMITS, type RemoteLedger, type Receipt } from "./remote-records";
import { RemoteBackupReconciliationError, type RemoteBackupTransport } from "./remote-policy";

export interface RemoteBackupStatus {
  enabled: boolean; pending: number; error: "remote_failed" | "remote_limit" | null;
  lastConfirmed: { backupId: string; dataAt: string; confirmedAt: string; snapshotId: string } | null;
  // A remote receipt proves an authenticated snapshot, not a recovery drill.
  recovery: "not-measured";
  destinationId: string | null; rebindGeneration: number;
  archives: Array<{ destinationId: string; receipts: number; pinned: number; lastConfirmed: RemoteBackupStatus["lastConfirmed"] }>;
  transfers: Array<Omit<Receipt, "manifestHash" | "manifestSha256" | "reconciliation"> & { reconciliation: { passes: number; classified: number; readReservedBytes: number } | null }>;
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
  private ledger: RemoteLedger | null;
  private queued = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persistenceFailed = false;
  constructor(private readonly transport: RemoteBackupTransport | undefined, private readonly deps: RemoteDependencies) {
    this.path = join(deps.recordDirectory, "remote.json");
    this.ledger = readRemoteLedger(this.path);
    if (transport && !deps.directory) throw new BackupError("backup_invalid");
    if (transport && this.ledger && this.ledger.destinationId !== transport.destinationId) throw new BackupError("backup_invalid");
    if (transport && !this.ledger) { this.ledger = { format: 2, installationId: randomUUID(), destinationId: transport.destinationId, receipts: [], lastConfirmed: null, archives: [], rebindGeneration: 0, lastRebind: null }; this.save(); }
    if (transport && this.ledger) {
      for (const receipt of this.ledger.receipts) if (receipt.state === "running") {
        // The remote outcome is unknown. A retry must discover the stable identity first.
        receipt.state = "pending"; receipt.nextAt = deps.now(); receipt.error = "remote_interrupted";
      }
      this.save();
    }
  }
  get enabled(): boolean { return Boolean(this.transport); }
  hasReceipt(backupId: string): boolean { return Boolean(this.ledger && [this.ledger, ...this.ledger.archives].some(ledger => ledger.receipts.some(receipt => receipt.backupId === backupId))); }
  assertCapacity(reserved = 0): void {
    if (!this.transport) return;
    if (this.persistenceFailed || this.closed) throw new BackupError("backup_busy", 503);
    if (this.pending() + reserved >= this.transport.policy.pendingLimit || (this.ledger?.receipts.length ?? 0) + reserved >= REMOTE_LIMITS.receipts) throw new BackupError("backup_limit", 409);
    if (this.ledger) assertRemoteLedgerCapacity(this.ledger, (reserved + 1) * 1024);
  }
  protectedIds(): Set<string> {
    // Disabled transport preserves sources for explicit future retries as well.
    return new Set(this.ledger ? [this.ledger, ...this.ledger.archives].flatMap(ledger => ledger.receipts.filter(receipt => receipt.state !== "confirmed").map(receipt => receipt.backupId)) : []);
  }
  status(): RemoteBackupStatus {
    return {
      enabled: this.enabled, pending: this.pending() + this.deps.unrecorded(),
      error: !this.enabled ? null : this.persistenceFailed || this.deps.unrecorded() || this.ledger?.receipts.some(receipt => receipt.error) ? "remote_failed" : this.pending() >= this.transport!.policy.pendingLimit ? "remote_limit" : null,
      lastConfirmed: this.ledger?.lastConfirmed ?? null,
      recovery: "not-measured",
      destinationId: this.ledger?.destinationId ?? null, rebindGeneration: this.ledger?.rebindGeneration ?? 0,
      archives: (this.ledger?.archives ?? []).map(archive => ({ destinationId: archive.destinationId, receipts: archive.receipts.length, pinned: archive.receipts.filter(receipt => receipt.state !== "confirmed").length, lastConfirmed: archive.lastConfirmed })),
      transfers: (this.ledger?.receipts ?? []).slice(-50).reverse().map(({ manifestHash, manifestSha256, reconciliation, ...receipt }) => { void manifestHash; void manifestSha256; return { ...receipt, reconciliation: reconciliation ? { passes: reconciliation.passes, classified: reconciliation.proofs.length, readReservedBytes: reconciliation.readReservedBytes } : null }; }),
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
  /** Explicit singular admission; archived intent alone never schedules a new upload. */
  reupload(backupId: string): RemoteBackupStatus {
    backupIdSchema.parse(backupId);
    if (!this.transport || this.closed || this.persistenceFailed || this.deps.maintenance()) throw new BackupError("backup_busy", 503);
    if (this.ledger!.receipts.some(receipt => receipt.backupId === backupId)) return this.status();
    // Keep the running pass's proof/envelope reservation stable while it awaits
    // external effects. Existing identity reads remain idempotent above.
    if (this.queued) throw new BackupError("backup_busy", 409);
    const archived = this.ledger!.archives.flatMap(archive => archive.receipts).filter(receipt => receipt.backupId === backupId);
    const original = archived[0];
    if (!original || archived.some(receipt => receipt.manifestHash !== original.manifestHash || receipt.manifestSha256 !== original.manifestSha256 || receipt.dataAt !== original.dataAt)) throw new BackupError("backup_invalid");
    const manifest = this.deps.catalog.manifest(backupId);
    if (recordHash(manifest) !== original.manifestHash || hashFile(join(this.deps.catalog.path(backupId), "manifest.json")).sha256 !== original.manifestSha256) throw new BackupError("backup_invalid");
    this.compact(); this.assertCapacity();
    this.ledger!.receipts.push({ ...original, state: "pending", attempts: 0, nextAt: this.deps.now(), confirmedAt: null, snapshotId: null, error: null, retryGeneration: 0, reconciliation: { passes: 0, readReservedBytes: 0, proofs: [] } });
    this.save(); this.tick(); return this.status();
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
    if (receipt.reconciliation) { receipt.reconciliation.passes = 0; receipt.reconciliation.readReservedBytes = 0; delete receipt.reconciliation.inventoryHash; }
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
      const progress = receipt.reconciliation ??= { passes: 0, readReservedBytes: 0, proofs: [] };
      if (progress.passes >= REMOTE_LIMITS.passes) throw new BackupError("backup_limit", 409);
      // Reserve the entire pass before spawning: a crash cannot reset read/candidate budgets.
      progress.passes++; progress.readReservedBytes += REMOTE_LIMITS.readBytes;
      receipt.state = "running"; if (!reconcileOnly) receipt.attempts++; receipt.nextAt = null; this.save();
      const manifest = await this.deps.catalog.verifyAsync(receipt.backupId);
      const source = this.deps.catalog.path(receipt.backupId);
      if (this.closed || recordHash(manifest) !== receipt.manifestHash || hashFile(join(source, "manifest.json")).sha256 !== receipt.manifestSha256) throw new BackupError("backup_invalid");
      const files = [{ path: "/manifest.json", size: lstatSync(join(source, "manifest.json")).size }, { path: "/state.sqlite3", size: manifest.database.size }, ...manifest.attachments.map(file => ({ path: `/attachments/${file.file}`, size: file.size }))];
      const otherProofs = [this.ledger!, ...this.ledger!.archives].reduce((sum, ledger) => sum + ledger.receipts.filter(value => value !== receipt).reduce((n, value) => n + (value.reconciliation?.proofs.length ?? 0), 0), 0);
      const proofLimit = Math.min(REMOTE_LIMITS.candidates, REMOTE_LIMITS.proofs - otherProofs);
      // Reserve bounded proof/confirmation space before any possible remote write.
      assertRemoteLedgerCapacity(this.ledger!, Math.max(0, proofLimit - progress.proofs.length) * 200 + 1024);
      const result = await this.transport!.upload({ installationId: this.ledger!.installationId, backupId: receipt.backupId, source, manifestSha256: receipt.manifestSha256, files, reconciliation: progress, proofLimit }, { reconcileOnly });
      if (result.inventoryHash) progress.inventoryHash = result.inventoryHash;
      if ("proofs" in result && result.proofs) {
        if (result.proofs.length > REMOTE_LIMITS.candidates || result.proofs.length + otherProofs > REMOTE_LIMITS.proofs) throw new BackupError("backup_limit", 409);
        progress.proofs = result.proofs;
      }
      if ("progress" in result) {
        if (!reconcileOnly && !result.uploadAttempted) receipt.attempts--;
        receipt.state = progress.passes < REMOTE_LIMITS.passes ? "pending" : "failed";
        receipt.error = receipt.state === "failed" ? "remote_failed" : null;
        receipt.nextAt = receipt.state === "pending" ? this.deps.now() + this.transport!.policy.retrySeconds * 1000 : null;
        this.save(); return;
      }
      if (this.closed || !/^[a-f0-9]{64}$/.test(result.snapshotId)) throw new BackupError("backup_failed");
      receipt.state = "confirmed"; receipt.snapshotId = result.snapshotId; receipt.confirmedAt = new Date(this.deps.now()).toISOString(); receipt.error = null;
      if (!this.ledger!.lastConfirmed || this.ledger!.lastConfirmed.dataAt <= receipt.dataAt) this.ledger!.lastConfirmed = { backupId: receipt.backupId, dataAt: receipt.dataAt, confirmedAt: receipt.confirmedAt, snapshotId: receipt.snapshotId };
    } catch (error) {
      receipt.error = error instanceof RemoteBackupReconciliationError ? "remote_inventory_changed" : "remote_failed";
      receipt.state = receipt.error !== "remote_inventory_changed" && receipt.attempts < this.transport!.policy.attemptLimit && (receipt.reconciliation?.passes ?? 0) < REMOTE_LIMITS.passes ? "pending" : "failed";
      receipt.nextAt = receipt.state === "pending" ? this.deps.now() + this.transport!.policy.retrySeconds * 1000 : null;
    }
    this.save();
  }
  private save(): void { if (!this.ledger) return; try { writeRemoteLedger(this.path, this.ledger); } catch { this.persistenceFailed = true; throw new BackupError("backup_failed", 503); } }
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
