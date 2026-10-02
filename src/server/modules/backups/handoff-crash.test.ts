import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService } from "@/server/modules/authentication";
import { BackupOperations, backupPolicySchema, finishBackupHandoff, recoverBackupHandoff } from "./index";

it.each(["requested", "maintenance", "closed", "executing", "restore-intent", "restore-verified", "receipt"])("SIGKILL at %s keeps an old complete generation or resumes exactly one fenced restore", async point => {
  const root = mkdtempSync(join(dirname(process.cwd()), ".s4a-handoff-crash-")), database = join(root, "state.sqlite3"), attachments = join(root, "attachments");
  const policy = backupPolicySchema.parse({ directory: join(root, "copies"), uiActions: ["create", "restore"] });
  const source = new SqliteStateStore(database), auth = new AuthenticationService(source), oldToken = auth.generateToken("fixture").token;
  source.addProject({ name: "Before", repositoryPath: root, port: 4440, executable: "node", args: [] });
  const operations = new BackupOperations(policy, { databasePath: database, attachmentDirectory: attachments, applicationVersion: "fixture", source, estimateBytes: () => source.backupEstimateBytes(), authorize: actor => auth.isCurrentInstallationActor(actor), maintenance: () => false });
  const copy = operations.create(auth.authenticateInstallation(oldToken)!, "before"); await operations.drain(); await operations.close();
  const token = auth.rotateToken("fixture").token;
  source.addProject({ name: "After", repositoryPath: join(root, "later"), port: 4441, executable: "node", args: [] }); source.close();
  writeFileSync(join(root, "current-token"), token, { mode: 0o600 }); writeFileSync(join(root, "backup-id"), copy.backupId, { mode: 0o600 });
  const child = fork(fileURLToPath(new URL("./fixtures/handoff-crash-worker.ts", import.meta.url)), [root, point], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", data => { stderr += data.toString(); });
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
  try {
    await Promise.race([once(child, "message", { signal: abort.signal }), once(child, "exit").then(() => { throw new Error(`Crash fixture missed boundary: ${stderr}`); })]);
    const exit = once(child, "exit"); child.kill("SIGKILL"); expect((await exit)[1]).toBe("SIGKILL");
    const handoff = recoverBackupHandoff(database, attachments, policy);
    const restored = new SqliteStateStore(database);
    try {
      if (handoff) finishBackupHandoff(database, handoff, restored);
      expect(restored.listProjects().map(p => p.name)).toEqual(handoff ? ["Before"] : ["After", "Before"]);
      const authentication = new AuthenticationService(restored);
      expect(authentication.authenticateInstallation(token)).not.toBeNull();
      expect(authentication.authenticateInstallation(oldToken)).toBeNull();
      restored.addProject({ name: "After recovery", repositoryPath: join(root, "post"), port: 4442, executable: "node", args: [] });
    } finally { restored.close(); }
    expect(recoverBackupHandoff(database, attachments, policy)).toBeNull();
    const check = new SqliteStateStore(database); try { expect(check.listProjects()).toHaveLength(handoff ? 2 : 3); } finally { check.close(); }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
