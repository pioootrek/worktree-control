import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackupOperation } from "../../src/shared/contracts/backups";
import type { RemoteBackupStatus } from "../../src/server/modules/backups";
import { startControllerFixture, waitFor } from "./controller-fixture";
import { realResticAvailable, resticFixture } from "./restic-fixture";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Shared acceptance driver; runtime CLI/HTTP/assets can come from an installed artifact. */
export async function remoteRebindAcceptance(artifact?: { cli: string; webRoot: string }) {
  assert(realResticAvailable, "Explicit disposable restic fixture binaries are required.");
  const old = await resticFixture();
  let next: Awaited<ReturnType<typeof resticFixture>> | undefined;
  let controller: Awaited<ReturnType<typeof startControllerFixture>> | undefined;
  try {
    next = await resticFixture();
    const startupArguments = [...old.startupArguments, "--backup-remote-retry-seconds", "60"];
    controller = await startControllerFixture(0, [], { backups: true, startupArguments, artifact });
    const f = controller;
    const status = async () => JSON.parse(await f.cli(["backup", "remote", "status"])) as RemoteBackupStatus;
    const settled = (id: string, state: string) => waitFor(async () => { const value = await status(); return value.transfers.find(receipt => receipt.backupId === id)?.state === state ? value : null; }, 45000, () => "Remote fixture transfer did not settle.");
    assert.equal((await fetch(f.endpoint)).status, 200);
    const confirmed = JSON.parse(await f.cli(["backup", "now", "--idempotency-key", "old-confirmed"])) as BackupOperation;
    await settled(confirmed.backupId, "confirmed");
    await writeFile(old.credentials, JSON.stringify({ username: "fixture", password: "incorrect" }), { mode: 0o600 }); await f.restart();
    const uncertain = JSON.parse(await f.cli(["backup", "now", "--idempotency-key", "old-uncertain"])) as BackupOperation;
    const previous = await settled(uncertain.backupId, "failed");
    const database = (await f.cli(["config", "path"])).trim(), recordPath = `${database}.backup-operations/remote.json`;
    const configPath = join(next.root, "target.json"); await writeFile(configPath, JSON.stringify(next.configuration), { mode: 0o600 });
    const rebind = ["backup", "remote", "rebind", "--from", previous.destinationId!, "--target-config", configPath, "--generation", "1"];
    await assert.rejects(f.cli(rebind)); // Active singleton owner cannot migrate.
    await f.stop(); const before = JSON.parse(await readFile(recordPath, "utf8"));
    const result = JSON.parse(await f.cli(rebind)) as { generation: number; archivedRepositories: number };
    assert.equal(result.generation, 1); assert.equal(result.archivedRepositories, 1);
    const rebound = await readFile(recordPath); await f.cli(rebind); assert.deepEqual(await readFile(recordPath), rebound);
    await assert.rejects(f.cli([...rebind.slice(0, -1), "0"]));
    const ledger = JSON.parse(rebound.toString()).payload;
    assert.deepEqual(ledger.archives[0].receipts, before.payload.receipts);
    assert.equal(ledger.lastConfirmed, null); assert.equal(ledger.receipts.length, 0);
    startupArguments.splice(0, startupArguments.length, ...next.startupArguments, "--backup-remote-retry-seconds", "60"); await f.restart();
    assert.equal((await status()).lastConfirmed, null);
    assert.equal(JSON.parse((await next.run(["snapshots", "--json"])).stdout).length, 0);
    // Explicit one-ID migration preserves old uncertainty and original data age.
    await f.cli(["backup", "remote", "reupload", uncertain.backupId]);
    await f.cli(["backup", "remote", "reupload", uncertain.backupId]);
    const newConfirmed = await settled(uncertain.backupId, "confirmed");
    assert.equal(newConfirmed.lastConfirmed?.dataAt, uncertain.createdAt);
    assert.equal(newConfirmed.archives[0].pinned, 1);
    assert.equal(JSON.parse((await next.run(["snapshots", "--json"])).stdout).length, 1);
    await assert.rejects(f.cli(["backup", "remote", "reupload", `backup-${crypto.randomUUID()}`]));
    // Create authenticated history under the exact original source identity.
    // This is fixture administration, not an application cleanup or production transfer.
    await f.stop();
    const source = join(dirname(dirname(database)), "backups", confirmed.backupId);
    const sha = createHash("sha256").update(await readFile(join(source, "manifest.json"))).digest("hex");
    const common = ["backup", ".", "--host", `wts-${ledger.installationId}`, "--tag", [`wts-installation:${ledger.installationId}`, `wts-backup:${confirmed.backupId}`, `wts-manifest:${sha}`].join(","), "--json", "--read-concurrency", "1"];
    const complete = JSON.parse((await next.run(common, next.environment, source)).stdout.trim().split("\n").at(-1)!) as { snapshot_id: string };
    for (let i = 0; i < 33; i++) await next.run([...common, "--exclude", "state.sqlite3"], next.environment, source);
    const inventory = JSON.parse((await next.run(["snapshots", "--json"])).stdout) as Array<{ id: string }>;
    assert.equal(inventory.length, 35);
    await f.restart(); await f.cli(["backup", "remote", "reupload", confirmed.backupId]);
    const progress = await waitFor(async () => { const value = await status(), receipt = value.transfers.find(item => item.backupId === confirmed.backupId); return receipt?.state === "pending" && receipt.reconciliation?.classified === 32 ? value : null; }, 45000, () => "Real >32 history did not persist continuation.");
    assert.equal(progress.transfers.find(item => item.backupId === confirmed.backupId)?.attempts, 0);
    await f.stop();
    const persisted = JSON.parse(await readFile(recordPath, "utf8")), receipt = persisted.payload.receipts.find((item: { backupId: string }) => item.backupId === confirmed.backupId);
    assert.equal(receipt.reconciliation.passes, 1);
    // Advance only this stopped fixture's admission timestamp; production code
    // retains retrySeconds spacing. This avoids a real-minute wait in acceptance.
    receipt.nextAt = 0;
    persisted.sha256 = createHash("sha256").update(JSON.stringify(canonical(persisted.payload))).digest("hex");
    await writeFile(recordPath, JSON.stringify(persisted), { mode: 0o600 });
    await f.restart(); const recovered = await settled(confirmed.backupId, "confirmed");
    assert.equal(recovered.transfers.find(item => item.backupId === confirmed.backupId)?.snapshotId, complete.snapshot_id);
    assert.equal(recovered.transfers.find(item => item.backupId === confirmed.backupId)?.reconciliation?.passes, 2);
    assert.equal(recovered.archives[0].pinned, 1);
    assert.equal(JSON.parse((await next.run(["snapshots", "--json"])).stdout).length, inventory.length);
    return { evidence: "isolated-https-rebind-and-history", runtime: artifact ? "installed-artifact" : "built-cli", archivedReceipts: 2, archivedPins: 1, explicitReuploads: 2, candidates: 34, continuationPasses: 2, duplicateAdmission: "idempotent", snapshotCountUnchangedAfterReconciliation: true, recovery: "not-measured", fixtureDueTimestampAdvanced: true, ...next.provenance };
  } finally { try { await controller?.close(); } finally { try { await next?.close(); } finally { await old.close(); } } }
}
