import { assertDurability } from "./database-validation";
import { hashFile, BACKUP_LIMITS } from "./backup-validation";
import { AuthenticationProviderError, parseStrictProviderJson } from "../../modules/authentication";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, opendirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { durableJson, privateDirectory, privateBoundedFileReader, readPrivateBoundedFile, validateSensitivePath } from "../../private-storage";
import { getOwnedRestoreStatus } from "./restore-recovery";

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const policySchema = z.object({ mode: z.enum(["legacy", "token", "open", "better-auth"]), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const recordSchema = z.object({ format: z.literal(1), binding: hex, installation: hex, epoch: hex,
  state: z.enum(["pending", "confirmed"]), file:z.object({device:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),inode:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict(), policy: policySchema, owner: z.string().min(1).max(160).nullable(),
  restore: z.uuid().nullable(), receipt: z.uuid().nullable(), recoveredAt: z.iso.datetime().nullable(),
}).strict();
type Record = z.infer<typeof recordSchema>;
const envelope = z.object({ payload: recordSchema, sha256: hex }).strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type SecurityFenceCode = "security_fence_owner_running" | "security_fence_establishment_required" | "security_fence_recovery_required" | "security_fence_pending" | "security_fence_preflight_changed";
export class SecurityFenceError extends AuthenticationProviderError {
  constructor(code: SecurityFenceCode, committed?: true) {
    super(code, `${code}: Use protected offline auth fence inspect, then establish or resume with its current preflight. Preserve recovery evidence.`, committed);
    this.name = "SecurityFenceError";
  }
}
export const securityFenceRoot = (database: string) => `${database}.security`;
const witnessPath = (database: string) => join(securityFenceRoot(database), "witness.json");
const fileIdentity=(database:string)=>{const stat=lstatSync(database);return {device:stat.dev,inode:stat.ino};};
const binding = (database: string) => hash(["worktree-control/security-fence/v1", database, witnessPath(database)]);
const restore = (database: string) => getOwnedRestoreStatus(database)?.operationId ?? null;
function checkpoint(database: Database.Database): { installation: string; epoch: string } {
  return database.prepare("SELECT installation,epoch FROM security_checkpoint WHERE singleton=1").get() as {installation:string;epoch:string};
}
function ownerIdentity(database: Database.Database): string | null {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_principals'").get()) return null;
  const rows=database.prepare("SELECT id FROM remote_principals WHERE kind='owner' ORDER BY id LIMIT 65").all() as Array<{id:string}>;
  if(rows.length>64) throw new SecurityFenceError("security_fence_recovery_required");
  return rows.length>1 ? hash(rows.map(row=>row.id)) : rows[0]?.id ?? null;
}
function policy(database: Database.Database): Record["policy"] {
  const row = database.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").get() as {value_json:string};
  const { mode, generation } = JSON.parse(row.value_json);
  return policySchema.parse({ mode, generation });
}
function decode(database:string,bytes:Buffer):Record {
  const parsed = envelope.parse(parseStrictProviderJson(new TextDecoder("utf-8",{fatal:true}).decode(bytes),{maxDepth:8,maxFields:64}));
  if(hash(parsed.payload)!==parsed.sha256 || parsed.payload.binding!==binding(database)) throw new SecurityFenceError("security_fence_recovery_required");
  return parsed.payload;
}
function read(database: string): Record | null {
  if (!existsSync(securityFenceRoot(database))) return null;
  return decode(database,readPrivateBoundedFile(witnessPath(database),4096));
}

function publish(database: string, payload: Record): void {
  const root = securityFenceRoot(database);
  validateSensitivePath(witnessPath(database), [], true);
  privateDirectory(root);
  const directory=opendirSync(root);
  try {
    for(let count=0;;count++) {
      const entry=directory.readSync(); if(!entry)break;
      if(count>=32 || (entry.name!=="witness.json" && !/^\.journal-[0-9a-f-]{36}$/.test(entry.name))) throw new SecurityFenceError("security_fence_recovery_required");
    }
  } finally { directory.closeSync(); }
  // Existing material is validated, never chmod'ed into trust. Missing is allowed
  // here only after fresh creation or an explicit protected maintenance decision.
  if (existsSync(witnessPath(database))) readPrivateBoundedFile(witnessPath(database), 4096, [], true);
  durableJson(witnessPath(database), { payload, sha256: hash(payload) });
}

/** Synchronous boundary shared by every core statement, transaction and provider statement. */
export interface SqliteExecutionBoundary {
  assert(): void;
  execute<T>(operation: () => T, readonly: boolean): T;
}

export class SecurityFence implements SqliteExecutionBoundary {
  private pending = false;
  private failed = false;
  private readonly inode: { dev: number; ino: number };
  private readonly readCurrent:()=>Record;
  private constructor(private readonly path: string, private readonly database: Database.Database, private record: Record) {
    const {dev,ino} = lstatSync(path); this.inode = {dev,ino};
    const reader=privateBoundedFileReader(witnessPath(path),4096);
    this.readCurrent=()=>decode(path,reader());
    // Runs from fixed BEFORE triggers on this same connection. The callback
    // performs no SQL and publishes before SQLite changes an authority row.
    database.function("worktree_security_pending",()=>{if(!this.pending)this.beginWrite();return 0;});
  }
  /** Called on the READONLY inspected database before enabling writes or migrating. */
  static inspect(path: string, database: Database.Database, fresh: boolean): void {
    let record: Record | null;
    try { record = read(path); } catch { throw new SecurityFenceError("security_fence_recovery_required"); }
    if (fresh && !record && !existsSync(securityFenceRoot(path)) && !restore(path)) return;
    if (!record) {
      const marked=Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name='security_checkpoint'").get());
      throw new SecurityFenceError(marked || existsSync(securityFenceRoot(path)) || restore(path) ? "security_fence_recovery_required" : "security_fence_establishment_required");
    }
    try {
      const point = checkpoint(database);
      if (record.state !== "confirmed" || hash(record.file)!==hash(fileIdentity(path)) || record.installation !== point.installation || record.epoch !== point.epoch
        || record.restore !== restore(path) || hash(record.policy) !== hash(policy(database)) || record.owner !== ownerIdentity(database)) throw new Error();
    } catch { throw new SecurityFenceError("security_fence_recovery_required"); }
  }
  static attach(path: string, database: Database.Database, fresh: boolean): SecurityFence {
    if (fresh) {
      const record: Record = {format:1,binding:binding(path),...checkpoint(database),state:"confirmed",file:fileIdentity(path),policy:policy(database),owner:ownerIdentity(database),restore:restore(path),receipt:null,recoveredAt:null};
      try{publish(path, record);}catch{try{publish(path,{...record,state:"pending"});}catch{/* Preserve uncertainty. */}throw new SecurityFenceError("security_fence_pending");}
    }
    this.inspect(path, database, false);
    return new SecurityFence(path, database, read(path)!);
  }
  static preflight(path: string, database: Database.Database, version: number) {
    let trusted = false;
    try { this.inspect(path, database, false); trusted = true; } catch { /* Neutral status, never adoption. */ }
    // Streamed bounded hashes of the owned SQLite/WAL and witness bind the explicit operator decision.
    // This is finite protected maintenance, never a per-request whole-database hash.
    const files=[path,`${path}-wal`].map(file=>existsSync(file) ? hashFile(file,BACKUP_LIMITS.fileBytes) : null);
    let external="unreadable";
    try { external=existsSync(witnessPath(path)) ? createHash("sha256").update(readPrivateBoundedFile(witnessPath(path),4096)).digest("hex") : "missing"; } catch { /* Neutral unreadable state remains explicitly fenced. */ }
    const preflight=hash([binding(path),files,external]);
    const marker = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name='security_checkpoint'").get());
    return { code: trusted ? "security_fence_current" : marker || existsSync(securityFenceRoot(path)) || restore(path) ? "security_fence_recovery_required" : "security_fence_establishment_required",
      trusted, preflight, schemaVersion:version, establishmentAllowed: !marker && !existsSync(securityFenceRoot(path)) && !restore(path) };
  }
  static assertOwnerContinuity(path:string,database:Database.Database):string|null {
    let previous:Record|null;
    try {previous=read(path);} catch {return ownerIdentity(database);} // Explicit preflight is the OS operator's decision when the witness is lost.
    if(previous?.owner && previous.owner !== ownerIdentity(database)) throw new SecurityFenceError("security_fence_recovery_required");
    return ownerIdentity(database);
  }
  static beginMaintenance(path: string, receipt: string, recoveredAt: string | null, owner:string|null): void {
    publish(path,{format:1,binding:binding(path),installation:randomBytes(32).toString("hex"),epoch:randomBytes(32).toString("hex"),
      state:"pending",file:fileIdentity(path),policy:{mode:"token",generation:0},owner,restore:restore(path),receipt,recoveredAt});
  }
  static registerMaintenanceObserver(path:string,database:Database.Database,receipt:string):void {
    const record=read(path);
    if(!record || record.state!=="pending" || record.receipt!==receipt)throw new SecurityFenceError("security_fence_recovery_required");
    database.function("worktree_security_pending",()=>0);
  }
  /** Only the protected offline maintenance composition calls this after migration/quarantine. */
  static maintenanceReceipt(path: string, database: Database.Database, receipt: string, phase: "pending" | "confirmed"): void {
    // A corrupt witness may be replaced only here by the explicit operator action;
    // private path/alias checks still apply, with no repair of ownership or mode.
    const payload: Record = {format:1,binding:binding(path),...checkpoint(database),state:phase,file:fileIdentity(path),policy:policy(database),owner:ownerIdentity(database),restore:restore(path),receipt,recoveredAt:read(path)?.recoveredAt ?? null};
    try { publish(path,payload); }
    catch(error) {
      if(phase==="confirmed")try{publish(path,{...payload,state:"pending"});}catch{/* Preserve uncertainty. */}
      throw error;
    }
  }
  /** Map only an acknowledged restore with an external quarantine receipt. SQL
   * recovery still passes through admission and the current fence on every batch. */
  sessionRecoveryProvenance(provenance:"ordinary"|"restored"|"unconfirmed"):"ordinary"|"restored"|"unconfirmed" {
    return provenance==="restored" && this.record.state==="confirmed" && this.record.receipt && this.record.restore ? "ordinary" : provenance;
  }
  assert(): void {
    if (this.failed) throw new SecurityFenceError("security_fence_pending");
    try {
      const stat = lstatSync(this.path), current = this.readCurrent();
      if (stat.dev !== this.inode.dev || stat.ino !== this.inode.ino || !current || hash(current) !== hash(this.record)
        || current.restore !== restore(this.path)) throw new Error();
      if (!this.pending) { const point=checkpoint(this.database); if(current.epoch!==point.epoch || current.installation!==point.installation)throw new Error(); }
    } catch { this.failed = true; throw new SecurityFenceError("security_fence_recovery_required"); }
  }
  execute<T>(operation: () => T, readonly: boolean): T {
    this.assert();
    if(!readonly)assertDurability(this.database);
    let result: T;
    try { result = operation(); }
    catch (error) {
      if (this.failed) throw error;
      if (this.pending && !this.database.inTransaction) {
        const changed = checkpoint(this.database).epoch !== this.record.epoch;
        if (changed) { this.failed = true; throw new SecurityFenceError("security_fence_pending", true); }
        this.confirm(); // Proven rollback on the sole connection, before returning the original failure.
      }
      throw error;
    }
    if (this.pending && !this.database.inTransaction) this.confirm();
    return result;
  }
  private beginWrite():void {
    if(this.failed)throw new SecurityFenceError("security_fence_pending");
    // No SQLite re-entry from a scalar function. All ordinary execution was
    // admitted and checked before reaching the statement; verify external state
    // again at the actual security row boundary.
    const stat=lstatSync(this.path),current=this.readCurrent();
    if(stat.dev!==this.inode.dev || stat.ino!==this.inode.ino || hash(current)!==hash(this.record)) {
      this.failed=true;throw new SecurityFenceError("security_fence_recovery_required");
    }
    this.pending = true;
    this.record = { ...this.record, state:"pending" };
    try { publish(this.path,this.record); } catch { this.failed=true; throw new SecurityFenceError("security_fence_pending"); }
  }
  private confirm(): void {
    let changed=false;
    try {
      const point = checkpoint(this.database); changed=point.epoch!==this.record.epoch;
      assertDurability(this.database);
      const next: Record = {...this.record,...point,state:"confirmed",policy:policy(this.database),owner:ownerIdentity(this.database)};
      publish(this.path,next);
      this.record=next; this.pending=false;
    } catch {
      this.failed=true;
      // A visible confirmed rename followed by an fsync refusal must not let a
      // later clean process accept this attempt as a recovery receipt.
      try { publish(this.path,{...this.record,state:"pending"}); } catch { /* Keep original uncertainty; never announce success. */ }
      throw new SecurityFenceError("security_fence_pending",changed ? true : undefined);
    }
  }
}

/** Additional floor for restored encrypted vault grants and scheduled work.
 * Does not replace the independent signed proof or the restore-request journal. */
export function securityRecoveryBoundary(database: string): { receipt:string;createdAt:string;restore:string|null } | null {
  if(!existsSync(dirname(resolve(database))))return null;
  database=join(realpathSync(dirname(resolve(database))),basename(database));
  if (!existsSync(securityFenceRoot(database))) return null;
  let record: Record | null;
  try { record=read(database); } catch { throw new SecurityFenceError("security_fence_recovery_required"); }
  if (!record || record.state!=="confirmed") throw new SecurityFenceError("security_fence_recovery_required");
  return record.receipt && record.recoveredAt ? {receipt:record.receipt,createdAt:record.recoveredAt,restore:record.restore} : null;
}
