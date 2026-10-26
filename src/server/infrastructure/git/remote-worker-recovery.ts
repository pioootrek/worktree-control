import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import type { RecoveryAssessment, RecoveryPathIdentity, WorkerReceipt, WorkerReceiptSummary, WorkerRecoveryAudit, WorkerRecoveryHost, WorkerRecoveryProvenance } from "@/server/modules/remote-verification";
import { remoteAssignmentSchema } from "@/shared/contracts/remote-verification";
import { syncDirectory } from "@/server/private-storage";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const pathIdentity = z.object({ path: z.string().max(4096), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), uid: z.number().int().nonnegative() }).strict();
const provenanceSchema = z.object({ version: z.literal(1), attemptId: id, localRunId: id, assignmentDigest: digest, installation: digest,
  host: digest, boot: uuid, root: pathIdentity, cache: pathIdentity, retainedPaths: z.array(z.string().max(4096)).length(4), signature: digest }).strict();
const auditSchema = z.object({ version: z.literal(1), operationId: id, attemptId: id, principalId: id, credentialId: id,
  reconciledAt: z.string().datetime(), boot: uuid, provenanceSignature: digest,
  processExit: z.literal("same-host-different-boot"), artifacts: z.literal("retained-excluded"), signature: digest }).strict();
const journalSchema = z.object({ provenance: provenanceSchema, audit: auditSchema.optional() }).strict();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: string): never => { throw new Error(code); };

/** Bounded no-follow read, including procfs files whose reported size is zero. */
function readSmall(path: string, limit: number, privateFile = false, durable = false, systemFile = false): { bytes: Buffer; device: string; inode: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || privateFile && (stat.nlink !== 1n || Number(stat.uid) !== process.getuid?.() || Number(stat.mode) & 0o077)) fail("recovery_anchor_invalid");
    if (systemFile && (stat.uid !== 0n || Number(stat.mode) & 0o022)) fail("recovery_identity_unavailable");
    const bytes = Buffer.alloc(limit + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > limit) fail("recovery_evidence_invalid");
    if (durable) fsyncSync(fd);
    return { bytes: bytes.subarray(0, count), device: String(stat.dev), inode: String(stat.ino) };
  } finally { closeSync(fd); }
}
export interface LinuxRecoveryIdentity { host: string; boot: string }
/** Injectable only in construction for tests, never through configuration or CLI arguments. */
export function linuxRecoveryIdentity(): LinuxRecoveryIdentity {
  if (process.platform !== "linux" || !process.getuid) fail("recovery_linux_required");
  const machine = readSmall("/etc/machine-id", 128, false, false, true).bytes.toString("utf8").trim();
  const boot = readSmall("/proc/sys/kernel/random/boot_id", 128, false, false, true).bytes.toString("utf8").trim();
  if (!/^[0-9a-f]{32}$/.test(machine) || !uuid.safeParse(boot).success) fail("recovery_identity_unavailable");
  return { host: hash(machine), boot };
}
function slots(root: string, cache: string, attemptId: string): string[] {
  return [join(root, attemptId), join(root, `.home-${attemptId}`), join(root, `.tmp-${attemptId}`), cache];
}
function overlap(a: string, b: string): boolean {
  const within = (parent: string, child: string) => { const p = relative(parent, child); return !p || !isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`); };
  return within(a, b) || within(b, a);
}
/** Check every existing component without traversing symlink targets. Never creates or repairs paths. */
function safePath(input: string, optional = false): void {
  if (!isAbsolute(input) || resolve(input) !== input) fail("recovery_path_invalid");
  for (let current = input; ; current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") { if (current === dirname(current)) throw error; continue; } throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) && !(stat.mode & 0o1000)) fail("recovery_path_invalid");
    if (current === input && stat.uid !== process.getuid?.()) fail("recovery_path_invalid");
    if (current === dirname(current)) break;
  }
}
function directoryIdentity(path: string): RecoveryPathIdentity {
  safePath(path);
  const stat = lstatSync(path, { bigint: true });
  return { path, device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid) };
}
function sameDirectory(expected: RecoveryPathIdentity): void {
  if (JSON.stringify(directoryIdentity(expected.path)) !== JSON.stringify(expected)) fail("recovery_path_changed");
}

/** Linux reboot proof only. Never signals a saved PID or recursively deletes artifacts. */
export class LinuxWorkerRecoveryHost implements WorkerRecoveryHost {
  constructor(private readonly databasePath: string, private readonly probe: () => LinuxRecoveryIdentity = linuxRecoveryIdentity) {}

  capture(receipt: WorkerReceipt, root: string, cache: string): WorkerRecoveryProvenance {
    const identity = this.identity();
    const binding = this.binding(true);
    const assignment = remoteAssignmentSchema.parse(receipt.assignment);
    const rootIdentity = directoryIdentity(root), cacheIdentity = directoryIdentity(cache);
    if (overlap(root, cache)) fail("recovery_path_invalid");
    const retainedPaths = slots(root, cache, assignment.attemptId);
    for (const path of retainedPaths.slice(0, 3)) {
      try { lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      fail("recovery_artifact_conflict");
    }
    const body: Omit<WorkerRecoveryProvenance, "signature"> = { version: 1, attemptId: assignment.attemptId,
      localRunId: receipt.localRunId, assignmentDigest: hash(assignment), installation: binding.installation,
      host: identity.host, boot: identity.boot, root: rootIdentity, cache: cacheIdentity, retainedPaths };
    return { ...body, signature: this.sign("provenance", body, binding.key) };
  }
  assess(receipt: WorkerReceiptSummary): RecoveryAssessment {
    const refused = (code: string): RecoveryAssessment => ({ code, provenance: null, audit: null, recoverable: false, reconciled: false });
    if (!receipt.recovery) return refused("recovery_provenance_missing");
    try {
      const journal = journalSchema.parse(receipt.recovery);
      const { provenance, audit } = journal;
      const binding = this.binding(false);
      const identity = this.identity();
      const { signature, ...body } = provenance;
      if (!this.valid("provenance", body, signature, binding.key) || provenance.installation !== binding.installation
        || provenance.attemptId !== receipt.assignment.attemptId || provenance.localRunId !== receipt.localRunId
        || provenance.assignmentDigest !== hash(remoteAssignmentSchema.parse(receipt.assignment))) return refused("recovery_provenance_invalid");
      if (provenance.host !== identity.host) return refused("recovery_host_changed");
      if (JSON.stringify(provenance.retainedPaths) !== JSON.stringify(slots(provenance.root.path, provenance.cache.path, provenance.attemptId))
        || overlap(provenance.root.path, provenance.cache.path)) return refused("recovery_path_invalid");
      sameDirectory(provenance.root); sameDirectory(provenance.cache);
      for (const path of provenance.retainedPaths.slice(0, 3)) safePath(path, true);
      if (audit) {
        const { signature: auditSignature, ...auditBody } = audit;
        if (!this.valid("audit", auditBody, auditSignature, binding.key) || audit.attemptId !== provenance.attemptId
          || audit.provenanceSignature !== provenance.signature || audit.boot === provenance.boot) return refused("recovery_audit_invalid");
        return { code: "reconciled_artifacts_retained", provenance, audit, recoverable: false, reconciled: true };
      }
      const rebooted = provenance.boot !== identity.boot;
      return { code: rebooted ? "recovery_ready_after_reboot" : "recovery_same_boot_unconfirmed", provenance, audit: null, recoverable: rebooted, reconciled: false };
    } catch { return refused("recovery_evidence_unavailable_or_invalid"); }
  }
  audit(provenance: WorkerRecoveryProvenance, operationId: string, actor: AuthenticatedPrincipal): WorkerRecoveryAudit {
    const identity = this.identity(), binding = this.binding(false);
    // Re-read immediately before sealing. A failing probe never authorizes recovery.
    if (identity.host !== provenance.host || identity.boot === provenance.boot || binding.installation !== provenance.installation) fail("recovery_identity_changed");
    const body: Omit<WorkerRecoveryAudit, "signature"> = { version: 1, operationId, attemptId: provenance.attemptId,
      principalId: actor.principalId, credentialId: actor.credentialId, reconciledAt: new Date().toISOString(), boot: identity.boot,
      provenanceSignature: provenance.signature, processExit: "same-host-different-boot", artifacts: "retained-excluded" };
    return { ...body, signature: this.sign("audit", body, binding.key) };
  }
  assertPathsAvailable(paths: string[], receipts: WorkerReceiptSummary[]): void {
    for (const receipt of receipts) {
      if (!receipt.recovery?.audit) continue;
      const assessment = this.assess(receipt);
      if (!assessment.reconciled || !assessment.provenance) throw new Error("recovery_exclusion_unavailable");
      for (const input of paths) {
        const path = resolve(input);
        safePath(path, true);
        if (assessment.provenance.retainedPaths.some(retained => overlap(retained, path))) fail("recovery_artifacts_excluded");
      }
    }
  }
  private identity(): LinuxRecoveryIdentity {
    const identity = this.probe();
    if (!digest.safeParse(identity.host).success || !uuid.safeParse(identity.boot).success) fail("recovery_identity_unavailable");
    return identity;
  }
  private binding(create: boolean): { key: Buffer; installation: string } {
    const database = realpathSync(this.databasePath);
    safePath(dirname(database));
    const stat = lstatSync(database, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || Number(stat.uid) !== process.getuid?.()) fail("recovery_installation_invalid");
    const anchorPath = `${database}.worker-recovery-key`;
    if (create) {
      let fd: number | undefined;
      try {
        fd = openSync(anchorPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, randomBytes(32)); fsyncSync(fd);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { if (fd !== undefined) closeSync(fd); }
      syncDirectory(dirname(anchorPath));
    }
    const anchor = readSmall(anchorPath, 32, true, create);
    if (anchor.bytes.length !== 32) fail("recovery_anchor_invalid");
    return { key: anchor.bytes, installation: hash({ database, device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid), anchorDevice: anchor.device, anchorInode: anchor.inode }) };
  }
  private sign(kind: string, body: unknown, key: Buffer): string { return createHmac("sha256", key).update(`${kind}\0${JSON.stringify(body)}`).digest("hex"); }
  private valid(kind: string, body: unknown, signature: string, key: Buffer): boolean {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(this.sign(kind, body, key), "hex"));
  }
}
