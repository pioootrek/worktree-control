import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BackupOperations, backupPolicySchema, UserSchedules, userBackupPolicySchema } from "./index";

for (const boundary of ["staged", "published", "unlinked"]) it(`SIGKILL during user export at ${boundary} never publishes an incomplete success`, async () => {
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
    schedules = new UserSchedules(userBackupPolicySchema.parse({ enabled: true, scopes: ["knowledge-discussions"], projects: ["project"], targets: [{ id: "local", directory: join(root, "exports") }], minIntervalSeconds: 60 }), backups, { authorize: () => {}, projectName: () => "Fixture", exportDiscussions: () => { throw new Error("Restart must not recreate queued work."); }, clock: () => Date.now() + 60_000 });
    const actor = { principalId: "owner", principalKind: "owner" as const, credentialId: "fixture", authenticationMethod: "owner_session" as const };
    const result = schedules.overview(actor).artifacts[0];
    expect(result.state).toBe(boundary === "unlinked" ? "succeeded" : "interrupted");
    expect(result.artifactAvailable).toBe(boundary === "unlinked");
    if (result.artifactAvailable) expect(schedules.command(actor, { action: "artifact", executionId: result.executionId })).toMatchObject({ source: "user-schedule", data: { threads: [], replies: [] } });
    schedules.tick(); await backups.drain(); expect(schedules.overview(actor).artifacts).toHaveLength(1);
  } finally { schedules?.close(); await backups?.close(); rmSync(root, { recursive: true, force: true }); }
});
