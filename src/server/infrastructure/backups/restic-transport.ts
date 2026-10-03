import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RemoteBackupSource, RemoteBackupTransport, RemoteBackupPolicy, RemoteBackupOutcome, RemoteProgress } from "@/server/modules/backups";
import { REMOTE_LIMITS, RemoteBackupReconciliationError } from "@/server/modules/backups";
import { BACKUP_LIMITS } from "@/server/infrastructure/sqlite";
import type { LoadedResticConfiguration } from "./restic-configuration";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const id = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.object({ id, tree: id, hostname: z.string(), paths: z.array(z.string()).max(4), tags: z.array(z.string()).max(32) });
const failure = () => new Error("remote_failed");
class IncompleteSnapshot extends Error {}

/** Restic owns authenticated encryption. No shell, ambient credentials, init or prune. */
export class ResticBackupTransport implements RemoteBackupTransport {
  readonly destinationId: string;
  readonly policy: RemoteBackupPolicy;
  private readonly environment: NodeJS.ProcessEnv;
  private child: ChildProcess | null = null;
  private active: Promise<unknown> | null = null;
  private closed = false;
  private readRemaining = REMOTE_LIMITS.readBytes;
  constructor(private readonly loaded: LoadedResticConfiguration) {
    const { configuration, credentials } = loaded;
    // The authenticated repository is the identity; its HTTPS address is only a locator.
    this.destinationId = digest(configuration.repositoryId);
    this.policy = Object.freeze({ ...configuration.policy });
    // Intentionally exclude proxies, password commands, repository overrides, Go/Node hooks and inherited secrets.
    this.environment = {
      RESTIC_REPOSITORY: configuration.repository, RESTIC_PASSWORD_FILE: configuration.passwordFile,
      RESTIC_REST_USERNAME: credentials.username, RESTIC_REST_PASSWORD: credentials.password,
      GOMAXPROCS: "2", NODE_ENV: "production", RESTIC_PROGRESS_FPS: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
  }
  upload(source: RemoteBackupSource, options?: { reconcileOnly: boolean }): Promise<RemoteBackupOutcome> {
    if (this.active || this.closed) return Promise.reject(failure());
    const operation = this.performUpload(source, options?.reconcileOnly ?? false).catch(error => { throw error instanceof RemoteBackupReconciliationError ? error : failure(); });
    this.active = operation;
    return operation.finally(() => { this.active = null; });
  }
  async close(): Promise<void> { this.closed = true; this.child?.kill("SIGKILL"); await this.active?.catch(() => undefined); }
  private tags(source: RemoteBackupSource): string[] { return [`wts-installation:${source.installationId}`, `wts-backup:${source.backupId}`, `wts-manifest:${source.manifestSha256}`]; }
  /** Read-only authentication for offline rebind; never inventories or uploads sources. */
  verifyRepository(directory: string): Promise<void> {
    if (this.active || this.closed) return Promise.reject(failure());
    this.readRemaining = REMOTE_LIMITS.readBytes;
    const operation = this.authenticate(directory, Date.now() + this.policy.timeoutSeconds * 1000).catch(() => { throw failure(); });
    this.active = operation;
    return operation.finally(() => { this.active = null; });
  }
  private async authenticate(directory: string, deadline: number): Promise<void> {
    const repository = z.object({ id }).parse(JSON.parse((await this.run(["cat", "config"], directory, deadline, 64 * 1024)).toString("utf8")));
    if (repository.id !== this.loaded.configuration.repositoryId) throw failure();
  }
  private async inventory(source: RemoteBackupSource, deadline: number): Promise<Array<z.infer<typeof snapshotSchema>>> {
    const tags = this.tags(source), host = `wts-${source.installationId}`;
    const snapshots = z.array(snapshotSchema).max(REMOTE_LIMITS.candidates).parse(JSON.parse((await this.run(["--json", "snapshots", "--host", host, "--tag", tags.join(",")], source.source, deadline, 512 * 1024)).toString("utf8")));
    if (new Set(snapshots.map(snapshot => snapshot.id)).size !== snapshots.length) throw failure();
    for (const snapshot of snapshots) if (snapshot.hostname !== host || snapshot.paths.length !== 1 || snapshot.paths[0] !== source.source || snapshot.tags.length !== tags.length || !tags.every(tag => snapshot.tags.includes(tag))) throw failure();
    return snapshots.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async performUpload(source: RemoteBackupSource, reconcileOnly: boolean): Promise<RemoteBackupOutcome> {
    const deadline = Date.now() + this.policy.timeoutSeconds * 1000;
    this.readRemaining = REMOTE_LIMITS.readBytes;
    await this.authenticate(source.source, deadline);
    const snapshots = await this.inventory(source, deadline);
    const inventoryDigest = (values: typeof snapshots) => digest(JSON.stringify(values.map(snapshot => [snapshot.id, snapshot.tree])));
    const inventoryHash = inventoryDigest(snapshots);
    if (source.reconciliation?.inventoryHash && source.reconciliation.inventoryHash !== inventoryHash) throw new RemoteBackupReconciliationError();
    const proofLimit = source.proofLimit ?? REMOTE_LIMITS.candidates;
    if (snapshots.length > proofLimit) throw failure();
    const previous = source.reconciliation?.proofs ?? [];
    // Preserve all still-present proofs, including those beyond this pass's
    // cutoff. Restic inventory order alone must never undo durable progress.
    const proofs: RemoteProgress["proofs"] = previous.filter(proof => snapshots.some(snapshot => snapshot.id === proof.snapshotId && snapshot.tree === proof.tree));
    let validated = 0;
    for (const snapshot of snapshots) {
      const known = previous.find(proof => proof.snapshotId === snapshot.id && proof.tree === snapshot.tree);
      if (known) continue;
      // Reserve enough space for the largest supported manifest and tree before
      // starting another candidate. Small candidates can still reach 32 per pass.
      if (validated >= 32 || this.readRemaining < BACKUP_LIMITS.manifestBytes + 64 * 1024 * 1024) return { progress: true, proofs, inventoryHash, uploadAttempted: false };
      const state = await this.classify(snapshot.id, source, deadline);
      validated++; proofs.push({ snapshotId: snapshot.id, tree: snapshot.tree, state });
    }
    const complete = proofs.filter(proof => proof.state === "complete");
    if (complete.length > 1) throw failure();
    if (complete.length === 1) return { snapshotId: complete[0].snapshotId, proofs, inventoryHash };
    if (reconcileOnly || snapshots.length >= Math.min(REMOTE_LIMITS.candidates, proofLimit)) throw failure();
    if (validated >= 32 || this.readRemaining < BACKUP_LIMITS.manifestBytes + 64 * 1024 * 1024 + 1024 * 1024) return { progress: true, proofs, inventoryHash, uploadAttempted: false };
    if (inventoryDigest(await this.inventory(source, deadline)) !== inventoryHash) throw new RemoteBackupReconciliationError();
    const summaries: Array<Record<string, unknown>> = [];
    // Upload progress has its existing independent 64 MiB bound.
    await this.run(["--json", "backup", ".", "--host", `wts-${source.installationId}`, "--tag", this.tags(source).join(","), "--read-concurrency", "1"], source.source, deadline, 64 * 1024 * 1024, line => {
      const item = JSON.parse(line) as Record<string, unknown>;
      if (item.message_type === "summary") { if (summaries.length) throw failure(); summaries.push(item); }
    }, false);
    if (summaries.length !== 1 || summaries[0].dry_run === true || !id.safeParse(summaries[0].snapshot_id).success) throw failure();
    const createdId = summaries[0].snapshot_id as string;
    const after = await this.inventory(source, deadline);
    const created = after.find(snapshot => snapshot.id === createdId);
    // Our one new immutable snapshot is expected; any other inventory change
    // remains unknown and cannot authorize confirmation or another write.
    if (!created || snapshots.some(snapshot => snapshot.id === createdId) || after.length !== snapshots.length + 1
      || snapshots.some(snapshot => !after.some(value => value.id === snapshot.id && value.tree === snapshot.tree))) throw new RemoteBackupReconciliationError();
    if (await this.classify(createdId, source, deadline) !== "complete") throw failure();
    return { snapshotId: createdId, proofs: [...proofs, { snapshotId: createdId, tree: created.tree, state: "complete" }], inventoryHash: inventoryDigest(after) };
  }
  private async classify(snapshotId: string, source: RemoteBackupSource, deadline: number): Promise<"partial" | "complete"> {
    try { await this.confirm(snapshotId, source, deadline); return "complete"; }
    catch (error) { if (error instanceof IncompleteSnapshot) return "partial"; throw error; }
  }
  private async confirm(snapshotId: string, source: RemoteBackupSource, deadline: number): Promise<void> {
    const files = new Map(source.files.map(file => [file.path, file.size])), directories = new Set(["/attachments"]), seen = new Set<string>();
    for (const path of files.keys()) if (path.startsWith("/attachments/")) directories.add(path.slice(0, path.lastIndexOf("/")));
    let header = false, mismatch = false;
    await this.run(["--json", "ls", snapshotId], source.source, deadline, 64 * 1024 * 1024, line => {
      const node = JSON.parse(line) as { struct_type?: string; message_type?: string; id?: string; path?: string; type?: string; size?: number };
      if (node.struct_type === "snapshot" || node.message_type === "snapshot") { if (header || node.id !== snapshotId) throw failure(); header = true; return; }
      if (!header || typeof node.path !== "string" || !node.path.startsWith("/") || seen.has(node.path)
        || !["dir", "file", "symlink", "socket", "chardev", "dev", "fifo"].includes(node.type ?? "")
        || (node.type === "file" && (!Number.isSafeInteger(node.size ?? 0) || (node.size ?? 0) < 0))) throw failure();
      seen.add(node.path);
      if (node.type === "dir") { if (!directories.delete(node.path)) mismatch = true; }
      else if (node.type === "file" && files.has(node.path) && files.get(node.path) === (node.size ?? 0)) files.delete(node.path);
      else mismatch = true;
    });
    if (!header) throw failure();
    // Only a successfully exhausted authenticated listing proves missing/extra
    // contents. Failed/truncated reads never produce reusable partial evidence.
    if (mismatch || files.size || directories.size) throw new IncompleteSnapshot();
    const manifest = await this.run(["dump", snapshotId, "/manifest.json"], source.source, deadline, BACKUP_LIMITS.manifestBytes);
    if (digest(manifest) !== source.manifestSha256) throw new IncompleteSnapshot();
  }
  private run(args: string[], cwd: string, deadline: number, maxBytes = 1024 * 1024, line?: (value: string) => void, read = true): Promise<Buffer> {
    if (this.closed || Date.now() >= deadline) return Promise.reject(failure());
    const configuration = this.loaded.configuration;
    return new Promise((accept, reject) => {
      const child = spawn(configuration.executable, ["--no-cache", "--retry-lock", "0s", "--limit-upload", String(configuration.uploadKiBPerSecond), ...(configuration.caFile ? ["--cacert", configuration.caFile] : []), ...args], { cwd, env: this.environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      const chunks: Buffer[] = []; let bytes = 0, errors = 0, failed = false, carry = "";
      const stop = () => { failed = true; child.kill("SIGKILL"); };
      const timeout = setTimeout(stop, Math.max(1, deadline - Date.now()));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length; if (read) this.readRemaining -= chunk.length;
        if (bytes > maxBytes || (read && this.readRemaining < 0)) return stop(); if (failed) return;
        if (!line) { chunks.push(chunk); return; }
        carry += chunk.toString("utf8");
        try {
          for (;;) { const end = carry.indexOf("\n"); if (end < 0) break; if (end > 16 * 1024) throw failure(); const value = carry.slice(0, end); carry = carry.slice(end + 1); if (value) line(value); }
          if (carry.length > 16 * 1024) throw failure();
        } catch { stop(); }
      });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 64 * 1024) stop(); });
      child.once("error", () => { failed = true; });
      child.once("close", code => {
        clearTimeout(timeout); this.child = null;
        try { if (carry && line && !failed) line(carry); } catch { failed = true; }
        if (failed || this.closed || code !== 0 || Date.now() > deadline) reject(failure());
        else accept(Buffer.concat(chunks));
      });
    });
  }
}
