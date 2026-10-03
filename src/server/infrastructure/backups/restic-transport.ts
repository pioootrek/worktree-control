import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RemoteBackupSource, RemoteBackupTransport, RemoteBackupPolicy } from "@/server/modules/backups";
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
  constructor(private readonly loaded: LoadedResticConfiguration) {
    const { configuration, credentials } = loaded;
    this.destinationId = digest(JSON.stringify([configuration.repository, configuration.repositoryId]));
    this.policy = Object.freeze({ ...configuration.policy });
    // Intentionally exclude proxies, password commands, repository overrides, Go/Node hooks and inherited secrets.
    this.environment = {
      RESTIC_REPOSITORY: configuration.repository, RESTIC_PASSWORD_FILE: configuration.passwordFile,
      RESTIC_REST_USERNAME: credentials.username, RESTIC_REST_PASSWORD: credentials.password,
      GOMAXPROCS: "2", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
  }
  upload(source: RemoteBackupSource, options?: { reconcileOnly: boolean }): Promise<{ snapshotId: string }> {
    if (this.active || this.closed) return Promise.reject(failure());
    const operation = this.performUpload(source, options?.reconcileOnly ?? false).catch(() => { throw failure(); });
    this.active = operation;
    return operation.finally(() => { this.active = null; });
  }
  async close(): Promise<void> { this.closed = true; this.child?.kill("SIGKILL"); await this.active?.catch(() => undefined); }
  private tags(source: RemoteBackupSource): string[] { return [`wts-installation:${source.installationId}`, `wts-backup:${source.backupId}`, `wts-manifest:${source.manifestSha256}`]; }
  private async performUpload(source: RemoteBackupSource, reconcileOnly: boolean): Promise<{ snapshotId: string }> {
    const deadline = Date.now() + this.policy.timeoutSeconds * 1000;
    const repository = z.object({ id }).parse(JSON.parse((await this.run(["cat", "config"], source.source, deadline, 64 * 1024)).toString("utf8")));
    if (repository.id !== this.loaded.configuration.repositoryId) throw failure();
    const previous = await this.find(source, deadline);
    if (previous) return { snapshotId: previous };
    if (reconcileOnly) throw failure();
    // Relative dot produces a portable snapshot root with no installation-path prefix.
    const output = await this.run(["--json", "backup", ".", "--host", `wts-${source.installationId}`, "--tag", this.tags(source).join(","), "--read-concurrency", "1"], source.source, deadline);
    const summaries = output.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).filter(item => item.message_type === "summary");
    if (summaries.length !== 1 || summaries[0].dry_run === true || !id.safeParse(summaries[0].snapshot_id).success) throw failure();
    const created = await this.find(source, deadline);
    if (!created || created !== summaries[0].snapshot_id) throw failure();
    return { snapshotId: created };
  }
  private async find(source: RemoteBackupSource, deadline: number): Promise<string | null> {
    const tags = this.tags(source), host = `wts-${source.installationId}`;
    const snapshots = z.array(snapshotSchema).max(32).parse(JSON.parse((await this.run(["--json", "snapshots", "--host", host, "--tag", tags.join(",")], source.source, deadline)).toString("utf8")));
    let confirmed: string | null = null;
    for (const snapshot of snapshots) {
      if (snapshot.hostname !== host || snapshot.paths.length !== 1 || snapshot.paths[0] !== source.source || !tags.every(tag => snapshot.tags.includes(tag))) throw failure();
      try { await this.confirm(snapshot.id, source, deadline); }
      catch (error) { if (error instanceof IncompleteSnapshot) continue; throw error; }
      if (confirmed) throw failure();
      confirmed = snapshot.id;
    }
    return confirmed;
  }
  private async confirm(snapshotId: string, source: RemoteBackupSource, deadline: number): Promise<void> {
    // Read and authenticate the stored manifest, rather than trusting exit status or tags alone.
    const manifest = await this.run(["dump", snapshotId, "/manifest.json"], source.source, deadline, BACKUP_LIMITS.manifestBytes);
    if (digest(manifest) !== source.manifestSha256) throw new IncompleteSnapshot();
    const files = new Map(source.files.map(file => [file.path, file.size])), directories = new Set(["/attachments"]);
    for (const path of files.keys()) if (path.startsWith("/attachments/")) directories.add(path.slice(0, path.lastIndexOf("/")));
    let header = false, invalid = false;
    await this.run(["--json", "ls", snapshotId], source.source, deadline, 64 * 1024 * 1024, line => {
      const node = JSON.parse(line) as { struct_type?: string; message_type?: string; id?: string; path?: string; type?: string; size?: number };
      if (node.struct_type === "snapshot" || node.message_type === "snapshot") { if (header || node.id !== snapshotId) invalid = true; header = true; return; }
      if (!header || typeof node.path !== "string") { invalid = true; return; }
      if (node.type === "dir") { if (!directories.delete(node.path)) invalid = true; }
      else if (node.type === "file" && files.has(node.path) && files.get(node.path) === node.size) files.delete(node.path);
      else invalid = true;
    });
    if (!header || invalid || files.size || directories.size) throw new IncompleteSnapshot();
  }
  private run(args: string[], cwd: string, deadline: number, maxBytes = 1024 * 1024, line?: (value: string) => void): Promise<Buffer> {
    if (this.closed || Date.now() >= deadline) return Promise.reject(failure());
    const configuration = this.loaded.configuration;
    return new Promise((accept, reject) => {
      const child = spawn(configuration.executable, ["--no-cache", "--retry-lock", "0s", "--limit-upload", String(configuration.uploadKiBPerSecond), ...(configuration.caFile ? ["--cacert", configuration.caFile] : []), ...args], { cwd, env: this.environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      const chunks: Buffer[] = []; let bytes = 0, errors = 0, failed = false, carry = "";
      const stop = () => { failed = true; child.kill("SIGKILL"); };
      const timeout = setTimeout(stop, Math.max(1, deadline - Date.now()));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > maxBytes) return stop(); if (failed) return;
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
