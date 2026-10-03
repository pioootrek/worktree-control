import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BackupOperations, backupPolicySchema, UserSchedules, userBackupPolicySchema } from "./index";

for (const expired of [false, true]) for (const boundary of ["staged", "published", "unlinked"]) it(`SIGKILL during user export at ${boundary}, expired=${expired}, never publishes an incomplete success`, async () => {
  const root = mkdtempSync(join(tmpdir(), "user-export-crash-"));
  let backups: BackupOperations | undefined, schedules: UserSchedules | undefined;
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", new URL("./fixtures/user-export-crash-worker.ts", import.meta.url).pathname, root, boundary], { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, output }));
    });
    expect(outcome, outcome.output).toMatchObject({ code: null, signal: "SIGKILL" });
    backups = new BackupOperations(backupPolicySchema.parse({}), { databasePath: join(root, "state.sqlite3"), attachmentDirectory: join(root, "attachments"), applicationVersion: "test", source: { backup: async () => {} }, estimateBytes: () => 1, authorize: () => true, maintenance: () => false });
    const restartTime = Date.now() + (expired ? 600_000 : 60_000);
    schedules = new UserSchedules(userBackupPolicySchema.parse({ enabled: true, scopes: ["knowledge-discussions"], projects: ["project"], targets: [{ id: "local", directory: join(root, "exports") }], minIntervalSeconds: 60 }), backups, { authorize: () => {}, projectName: () => "Fixture", exportDiscussions: () => { throw new Error("Restart must not recreate queued work."); }, clock: () => restartTime });
    const actor = { principalId: "owner", principalKind: "owner" as const, credentialId: "fixture", authenticationMethod: "owner_session" as const };
    const result = schedules.overview(actor).artifacts[0];
    expect(result.state).toBe(boundary === "unlinked" && !expired ? "succeeded" : "interrupted");
    expect(result.artifactAvailable).toBe(boundary === "unlinked" && !expired);
    expect(existsSync(join(root, "exports", `user-export-${result.executionId}.json`))).toBe(boundary !== "staged");
    if (result.artifactAvailable) expect(schedules.command(actor, { action: "artifact", executionId: result.executionId })).toMatchObject({ source: "user-schedule", data: { threads: [], replies: [] } });
    if (!expired) { schedules.tick(); await backups.drain(); expect(schedules.overview(actor).artifacts).toHaveLength(1); }
    if (boundary === "staged") {
      const view = await schedules.recover("local-admin", { action: "preview", executionId: result.executionId }) as { confirmation: string };
      await schedules.recover("local-admin", { action: "cleanup", executionId: result.executionId, confirmation: view.confirmation });
      expect(existsSync(join(root, "exports", `.user-export-${result.executionId}.partial`))).toBe(false);
      expect(schedules.overview(actor).artifacts[0].state).toBe("interrupted");
    }
  } finally { schedules?.close(); await backups?.close(); rmSync(root, { recursive: true, force: true }); }
});
