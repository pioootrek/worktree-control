import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKUP_LIMITS, parseManifest, type ControllerBackupManifest } from "@/server/infrastructure/sqlite";
import { inheritedRuntimeEnvironment } from "@/server/runtime-environment";
import { BackupError } from "./policy";

/** One bounded child, no queue. Cancellation waits for exit and scratch cleanup. */
export class SnapshotVerifier {
  private child: ChildProcess | null = null;
  private active: Promise<ControllerBackupManifest> | null = null;
  private closed = false;
  constructor(private readonly scratch: string, private readonly timeoutSeconds: number, private readonly maxBytes: number = BACKUP_LIMITS.totalBytes) {}
  verify(source: string): Promise<ControllerBackupManifest> {
    if (this.closed || this.active) return Promise.reject(new BackupError("backup_busy", 503));
    this.active = this.execute(source).finally(() => { this.active = null; });
    return this.active;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.child?.kill("SIGKILL"); // The exact child handle created here, never a discovered PID.
    await this.active?.catch(() => undefined);
  }
  private async execute(source: string): Promise<ControllerBackupManifest> {
    const temporary = await mkdtemp(join(this.scratch, ".verify-"));
    try {
      if (this.closed) throw new BackupError("backup_busy", 503);
      const sourceMode = import.meta.url.endsWith(".ts");
      const entry = fileURLToPath(new URL(sourceMode ? "../../../cli/backup-verifier.ts" : "./backup-verifier.js", import.meta.url));
      const manifest = await new Promise<ControllerBackupManifest>((accept, reject) => {
        const child = fork(entry, [], { execArgv: sourceMode ? ["--import", "tsx"] : [], cwd: sourceMode ? resolve(dirname(entry), "../..") : undefined, env: inheritedRuntimeEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
        this.child = child;
        let result: ControllerBackupManifest | null = null, failed = false;
        const timeout = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, this.timeoutSeconds * 1000);
        child.once("message", value => {
          try { result = parseManifest((value as { manifest?: unknown })?.manifest); }
          catch { failed = true; child.kill("SIGKILL"); }
        });
        child.once("error", () => { failed = true; });
        child.once("close", code => {
          clearTimeout(timeout); this.child = null;
          if (code !== 0 || failed || this.closed || !result) reject(new BackupError("backup_failed"));
          else accept(result);
        });
        child.send({ source, scratch: this.scratch, temporary, maxBytes: this.maxBytes }, error => { if (error) { failed = true; child.kill("SIGKILL"); } });
      });
      return manifest;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
