import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BackupOperation } from "../../src/shared/contracts/backups";
import type { RemoteBackupStatus } from "../../src/server/modules/backups";
import { startControllerFixture, waitFor, type ControllerFixture } from "../support/controller-fixture";
import { realResticAvailable, resticFixture } from "../support/restic-fixture";
const exec = promisify(execFile), cli = resolve("dist/cli/index.js");

describe.skipIf(!realResticAvailable)("real restic HTTPS REST transfer and source-independent recovery", () => {
  let controller: ControllerFixture | undefined, remote: Awaited<ReturnType<typeof resticFixture>> | undefined;
  afterEach(async () => { try { await controller?.close(); } finally { controller = undefined; await remote?.close(); remote = undefined; } });
  it("transfers only verified installation data, authenticates HTTPS, and recovers records/credentials/attachments after source deletion", async () => {
    remote = await resticFixture(); controller = await startControllerFixture(0, [], { backups: true, startupArguments: remote.startupArguments });
    const f = controller, r = remote, token = f.installationToken;
    const { project } = await f.request<{ project: { id: string } }>("/api/identity/admin", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "create-knowledge-project", name: "Remote recovery" }) });
    const task = JSON.parse(await f.cli(["knowledge", "create_task", "--json", JSON.stringify({ projectId: project.id, title: "Recovered task", description: "Remote source-independent data", idempotencyKey: "task" })], { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: token })) as { value: { id: string } };
    const bytes = Buffer.from("remote fixture attachment bytes"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const attachment = JSON.parse(await f.cli(["knowledge", "create_attachment", "--json", JSON.stringify({ projectId: project.id, recordKind: "task", recordId: task.value.id, filename: "proof.txt", mediaType: "text/plain", dataBase64: bytes.toString("base64"), sha256, idempotencyKey: "attachment" })], { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: token })) as { value: { id: string } };
    const copy = JSON.parse(await f.cli(["backup", "now", "--idempotency-key", "off-host-fixture"])) as BackupOperation;
    const confirmed = await waitFor(async () => { const status = JSON.parse(await f.cli(["backup", "remote", "status"])) as RemoteBackupStatus; return status.lastConfirmed?.backupId === copy.backupId ? status : null; }, 30000, () => "Real HTTPS transfer did not confirm.");
    expect(confirmed.recovery).toBe("not-measured"); expect(confirmed.pending).toBe(0);
    expect(confirmed.lastConfirmed!.dataAt).toBe(copy.createdAt);
    const remoteTree = (await r.run(["ls", "--json", confirmed.lastConfirmed!.snapshotId])).stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as { path?: string; type?: string });
    const remoteFiles = remoteTree.filter(node => node.type === "file").map(node => node.path!).sort();
    expect(remoteFiles).toContain("/manifest.json"); expect(remoteFiles).toContain("/state.sqlite3");
    await f.cli(["backup", "remote", "retry", copy.backupId, "--generation", "1"]);
    expect(JSON.parse((await r.run(["snapshots", "--json"])).stdout)).toHaveLength(1);
    await expect(r.run(["snapshots", "--json"], { ...r.environment, RESTIC_REST_PASSWORD: "incorrect" })).rejects.toThrow();
    await expect(r.run(["snapshots", "--json"], { ...r.environment, RESTIC_PASSWORD_FILE: join(r.root, "missing-key") })).rejects.toThrow();
    await expect(r.runWithoutCa(["snapshots", "--json"])).rejects.toThrow();
    // API/MCP never accepts remote policy or remote status operations, even for an installation authority.
    expect((await f.requestResult("/api/backups", { method: "POST", body: JSON.stringify({ action: "backup-remote" }) })).status).toBe(400);
    const sourceDatabase = (await f.cli(["config", "path"])).trim();
    await f.close(); controller = undefined; expect(existsSync(sourceDatabase)).toBe(false);
    const recoveryStart = Date.now(), recovered = join(r.root, "recovered-copy"); await mkdir(recovered, { mode: 0o700 });
    await r.run(["restore", confirmed.lastConfirmed!.snapshotId, "--target", recovered, "--verify"]);
    const manifest = JSON.parse(await readFile(join(recovered, "manifest.json"), "utf8")) as { attachments: Array<{ file: string }> };
    expect(manifest.attachments).toHaveLength(1); expect((await readFile(join(recovered, "attachments", manifest.attachments[0].file))).equals(bytes)).toBe(true);
    const data = join(r.root, "fresh-data"), state = join(r.root, "fresh-state");
    const common = ["--data-dir", data, "--state-dir", state], environment = { ...process.env, WORKTREE_SWITCHER_TOKEN: token, WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: token };
    await exec(process.execPath, [cli, "backup", "restore", recovered, "--idempotency-key", "remote-recovery", ...common], { env: environment, timeout: 30000 });
    // Existing restore validates schema/integrity/FK/domain/attachments; fresh CLI validates restored access and records.
    controller = await startControllerFixture(0, [], { restoredInstallation: { data, state, token } });
    const tasks = JSON.parse(await controller.cli(["knowledge", "tasks", "--json", JSON.stringify({ projectId: project.id })], { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: token })) as { items: Array<{ id: string }> };
    expect(tasks.items.map(item => item.id)).toContain(task.value.id);
    const downloaded = JSON.parse(await controller.cli(["knowledge", "attachment", "--json", JSON.stringify({ projectId: project.id, attachmentId: attachment.value.id })], { WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: token })) as { dataBase64: string };
    expect(Buffer.from(downloaded.dataBase64, "base64").equals(bytes)).toBe(true);
    console.log(JSON.stringify({ evidence: "isolated-https-rest-recovery", sourceInstallationDeleted: true, confirmedSnapshots: 1, remoteFiles, recoveredTasks: 1, recoveredAttachments: 1, recoveryMs: Date.now() - recoveryStart, ...r.provenance }));
  });
  it("keeps local success through credential failure and retries one stable backup after restart", async () => {
    remote = await resticFixture(); const r = remote;
    await writeFile(r.credentials, JSON.stringify({ username: "fixture", password: "incorrect" }), { mode: 0o600 });
    controller = await startControllerFixture(0, [], { backups: true, startupArguments: r.startupArguments }); const f = controller;
    const copy = JSON.parse(await f.cli(["backup", "now", "--idempotency-key", "bad-destination"])) as BackupOperation;
    await waitFor(async () => { const status = JSON.parse(await f.cli(["backup", "remote", "status"])) as RemoteBackupStatus; return status.transfers[0]?.state === "failed" ? status : null; }, 15000, () => "Credential failure was not terminal.");
    expect((JSON.parse(await f.cli(["backup", "status", "--idempotency-key", "bad-destination"])) as BackupOperation).state).toBe("succeeded");
    await writeFile(r.credentials, JSON.stringify({ username: "fixture", password: "fixture-backend-password" }), { mode: 0o600 }); await f.restart();
    await f.cli(["backup", "remote", "retry", copy.backupId, "--generation", "1"]);
    const status = await waitFor(async () => { const value = JSON.parse(await f.cli(["backup", "remote", "status"])) as RemoteBackupStatus; return value.lastConfirmed ? value : null; }, 30000, () => "Repaired destination did not confirm a fenced retry.");
    expect(status.transfers[0]).toMatchObject({ state: "confirmed", retryGeneration: 1 }); expect(JSON.parse((await r.run(["snapshots", "--json"])).stdout)).toHaveLength(1);
  });
});
