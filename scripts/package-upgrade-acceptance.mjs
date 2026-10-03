import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyHistoricalArtifact } from "./package-artifact.mjs";
import { productionInstallEnvironment, installProductionPrefix, installedSqlite } from "./package-install.mjs";
import { closeFixtureChild, waitFor } from "../tests/support/controller-fixture.ts";
import { resticFixture } from "../tests/support/restic-fixture.ts";

const exec = promisify(execFile), [currentRoot, oldArtifact, oldProvenance] = process.argv.slice(2);
const environment = { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "production" };
const installations = [], steps = [], faults = [], derivativeCopies = [];
let root, remote, stage = "historical-input", ownerToken, seed, currentNative, historicalNative;
const startedAt = Date.now(), previousUmask = process.umask(0o077);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function step(name, fn) { stage = name; const start = Date.now(); const value = await fn(); steps.push({ name, durationMs: Date.now() - start, ok: true }); return value; }
async function command(file, args, options = {}) { return exec(file, args, { env: environment, timeout: 30000, maxBuffer: 1024 * 1024, ...options }); }
async function port() { const server = createServer(); return new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { const number = server.address().port; server.close(error => error ? reject(error) : accept(number)); }); }); }
function installation(packageRoot, base) {
  const item = { packageRoot, base, data: join(base, "data"), state: join(base, "state"), child: null, endpoint: null };
  item.database = join(item.data, "state.sqlite3"); item.cliPath = join(packageRoot, "dist/cli/index.js");
  item.cli = async (args, token = ownerToken) => (await command(process.execPath, [item.cliPath, ...args], { env: { ...environment, WORKTREE_SWITCHER_DATA_DIR: item.data, WORKTREE_SWITCHER_STATE_DIR: item.state, ...(token ? { WORKTREE_SWITCHER_OWNER_TOKEN: token, WORKTREE_SWITCHER_KNOWLEDGE_TOKEN: token } : {}) } })).stdout;
  item.json = async (args, token) => JSON.parse(await item.cli(args, token));
  item.knowledge = (operation, input, token) => item.json(["knowledge", operation, "--json", JSON.stringify(input)], token);
  item.stop = async () => { const child = item.child; item.child = null; if (child) await closeFixtureChild(child); };
  item.startArgs = async extra => ["start", "--service-mode", "--no-open", "--host", "127.0.0.1", "--port", String(await port()), "--mcp-port", String(await port()), "--web-root", join(packageRoot, "out"), ...extra, "--data-dir", item.data, "--state-dir", item.state];
  item.start = async (extra = []) => {
    assert.equal(item.child, null); const args = await item.startArgs(extra); item.endpoint = `http://127.0.0.1:${args[args.indexOf("--port") + 1]}`;
    item.child = spawn(process.execPath, [item.cliPath, ...args], { env: environment, stdio: "ignore" });
    await waitFor(async () => { assert.equal(item.child.exitCode, null, "Installed controller exited before readiness."); try { const response = await fetch(item.endpoint, { signal: AbortSignal.timeout(1000) }); return response.ok ? true : null; } catch { return null; } }, 15000, () => "Installed controller not ready.");
    const html = await (await fetch(item.endpoint)).text(); assert(html.length > 100);
    const asset = html.match(/(?:src|href)="([^"]+\.(?:js|css))"/)?.[1]; assert(asset); assert.equal((await fetch(new URL(asset, item.endpoint))).status, 200);
  };
  installations.push(item); return item;
}
function databaseState(item, native) {
  assert.equal(item.child, null, "Read-only inspection requires a stopped fixture owner.");
  const db = new native.Database(item.database, { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare("SELECT max(version) version FROM schema_migrations").get().version;
    const tables = ["knowledge_projects", "knowledge_threads", "knowledge_replies", "knowledge_tasks", "knowledge_relations", "knowledge_memories", "knowledge_attachments", "knowledge_history", "remote_principals", "principal_credentials", "knowledge_project_grants", "audit_events", "controller_audit_events"];
    const counts = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT count(*) count FROM ${name}`).get().count]));
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok"); assert.deepEqual(db.pragma("foreign_key_check"), []);
    const audit = Object.fromEntries(["audit_events", "controller_audit_events"].map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY id`).all()]));
    return { schema, counts, audit };
  } finally { db.close(); }
}
function preservedAudit(expected, actual) {
  for (const [table, rows] of Object.entries(expected.audit)) {
    const found = new Map(actual.audit[table].map(row => [row.id, row]));
    for (const row of rows) assert.deepEqual(found.get(row.id), row);
  }
}
function knowledgeFailure(code) {
  return error => {
    if (error.code !== 1 || error.killed) return false;
    try { return JSON.parse(error.stderr.trim()).code === code; } catch { return false; }
  };
}
async function seedHistorical(item) {
  stage = "seed-owner";
  const owner = await item.json(["identity", "bootstrap-owner", "--label", "Installed acceptance"]); ownerToken = owner.token;
  stage = "seed-projects-and-agent-grants"; const records = [];
  for (let i = 0; i < 2; i++) {
    stage = "seed-project"; const project = (await item.json(["identity", "create-knowledge-project", "--name", `Historical tenant ${i}`])).project;
    stage = "seed-agent"; const agent = (await item.json(["identity", "create-agent"])).principal;
    stage = "seed-agent-token"; const issued = await item.json(["identity", "issue-agent-token", "--principal-id", agent.id, "--label", `Scoped tenant ${i}`]);
    stage = "seed-agent-grant"; await item.json(["identity", "grant-knowledge", "--principal-id", agent.id, "--project-id", project.id, "--permissions", "knowledge:read,knowledge:write,attachments:read,attachments:write"]);
    records.push({ project, agent, token: issued.token });
  }
  stage = "seed-controller-start"; await item.start();
  for (const [i, record] of records.entries()) {
    const input = { projectId: record.project.id }, k = (op, value) => item.knowledge(op, { ...input, ...value }, record.token);
    stage = "seed-thread"; record.thread = (await k("create_thread", { title: `Thread ${i}`, body: `Historical discussion ${i}`, idempotencyKey: "thread" })).value;
    stage = "seed-reply"; record.reply = (await k("create_reply", { threadId: record.thread.id, body: `Reply ${i}`, idempotencyKey: "reply" })).value;
    stage = "seed-derived-task"; const derived = (await k("task_from_thread", { threadId: record.thread.id, title: `Task ${i}`, description: "Historical work", priority: "next", idempotencyKey: "derive" })).value;
    record.relation = derived.relation;
    stage = "seed-task-update"; record.task = (await k("update_task", { taskId: derived.task.id, expectedRevision: derived.task.revision, title: `Updated task ${i}`, description: "Historical mutation retained", priority: "now", status: "in_progress", idempotencyKey: "update" })).value;
    const bytes = Buffer.from(`Historical attachment tenant ${i}\n`); record.attachmentBytes = bytes;
    stage = "seed-attachment"; record.attachment = (await k("create_attachment", { recordKind: "reply", recordId: record.reply.id, filename: `tenant-${i}.txt`, mediaType: "text/plain", dataBase64: bytes.toString("base64"), sha256: digest(bytes), idempotencyKey: "attachment" })).value;
    stage = "seed-memory"; record.memory = (await k("create_memory", { title: `Decision ${i}`, body: "Historical memory", category: "decision", tags: ["acceptance"], legacyId: null, sources: [{ kind: "task", id: record.task.id, revision: record.task.revision }], idempotencyKey: "memory" })).value;
    stage = "seed-history"; record.history = (await k("history", { recordKind: "task", recordId: record.task.id })).items;
  }
  seed = { ownerId: owner.principalId, records };
  await verifySeed(item); await item.stop();
}
async function verifySeed(item) {
  for (const record of seed.records) {
    const projectId = record.project.id, k = (operation, value) => item.knowledge(operation, { projectId, ...value }, record.token);
    for (const [operation, key] of [["thread", "thread"], ["task", "task"], ["reply", "reply"], ["memory", "memory"]]) {
      stage = `verify-${operation}`; const value = await k(operation, { [`${operation}Id`]: record[key].id });
      for (const field of ["id", "projectId", "title", "body", "description", "status", "priority", "revision", "createdBy"]) if (field in record[key]) assert.deepEqual(value[field], record[key][field]);
    }
    stage = "verify-derived-relation"; const relations = (await k("relations", { recordKind: "task", recordId: record.task.id })).items;
    assert(relations.some(value => value.id === record.relation.id && value.type === "derived_from" && value.targetId === record.thread.id));
    stage = "verify-history"; const history = (await k("history", { recordKind: "task", recordId: record.task.id })).items;
    for (const entry of record.history) assert.deepEqual(Object.fromEntries(Object.keys(entry).map(key => [key, history.find(value => value.id === entry.id)?.[key]])), entry);
    stage = "verify-attachment"; const attachment = await k("attachment", { attachmentId: record.attachment.id }); assert.equal(attachment.attachment.sha256, record.attachment.sha256); assert.deepEqual(Buffer.from(attachment.dataBase64, "base64"), record.attachmentBytes);
    stage = "verify-tenant-denial"; const foreign = seed.records.find(value => value !== record);
    await assert.rejects(item.knowledge("task", { projectId: foreign.project.id, taskId: foreign.task.id }, record.token), knowledgeFailure("knowledge_forbidden"));
    await assert.rejects(item.knowledge("attachment", { projectId: foreign.project.id, attachmentId: foreign.attachment.id }, record.token), knowledgeFailure("knowledge_forbidden"));
  }
  stage = "verify-agent-identity"; const agents = (await item.json(["identity", "list-agents"])).principals;
  for (const record of seed.records) assert(agents.some(agent => agent.id === record.agent.id && agent.status === "active"));
}
async function killBoundary(item, point, args, backups) {
  assert.equal(item.child, null);
  const input = { packageRoot: item.packageRoot, database: item.database, point, args, backups };
  const child = fork(fileURLToPath(new URL("./package-installed-fault.mjs", import.meta.url)), [JSON.stringify(input)], { execArgv: [], env: environment, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
  try {
    const [message] = await Promise.race([once(child, "message", { signal: abort.signal }), once(child, "exit").then(() => { throw new Error("Installed fault boundary was not reached."); })]);
    assert.equal(message.point, point);
    const exited = once(child, "exit"); child.kill("SIGKILL"); assert.equal((await exited)[1], "SIGKILL"); faults.push({ point, mechanism: "trusted-local-wrapper/syscall-interception/SIGKILL", reached: true });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
}

try {
  const historicalProvenance = await verifyHistoricalArtifact(oldArtifact, oldProvenance);
  root = await mkdtemp(join(tmpdir(), "wts-installed-upgrade-"));
  const prefix = join(root, "old prefix"); await mkdir(prefix);
  const oldRoot = await step("historical-production-install", async () => installProductionPrefix(oldArtifact, prefix, root, await productionInstallEnvironment(root), command));
  historicalNative = await step("historical-native-load", () => installedSqlite(oldRoot)); currentNative = await step("current-native-load", () => installedSqlite(currentRoot));
  const source = join(root, "source"), historical = installation(oldRoot, join(source, "historical"));
  await step("historical-seed-and-tenant-denial", () => seedHistorical(historical));
  const initial = databaseState(historical, historicalNative); assert.equal(initial.schema, 24);
  const oldModes = { umask: "0077", data: (await lstat(historical.data)).mode & 0o777, database: (await lstat(historical.database)).mode & 0o777 };
  assert.equal(oldModes.data, 0o700); assert.equal(oldModes.database, 0o600);
  const oldBackup = join(source, "historical-full");
  await step("historical-full-backup", () => historical.json(["backup", "create", oldBackup]));
  assert.equal(JSON.parse(await readFile(join(oldBackup, "manifest.json"), "utf8")).database.schemaVersion, 24);

  await step("foreground-0022-refusal-preserves-data", async () => {
    const mask = process.umask(0o022);
    const unsafeOld = installation(oldRoot, join(root, "foreground-0022"));
    try { await unsafeOld.json(["identity", "bootstrap-owner"]); } finally { process.umask(mask); }
    const before = await readFile(unsafeOld.database), modes = [(await lstat(unsafeOld.data)).mode, (await lstat(unsafeOld.database)).mode];
    const unsafeNew = installation(currentRoot, unsafeOld.base);
    await assert.rejects(unsafeNew.cli(await unsafeNew.startArgs([])), error => error.code === 1 && !error.killed && /Unsafe data path or permissions/.test(error.stderr));
    assert.deepEqual(await readFile(unsafeOld.database), before); assert.deepEqual([(await lstat(unsafeOld.data)).mode, (await lstat(unsafeOld.database)).mode], modes); assert.equal(databaseState(unsafeOld, historicalNative).schema, 24);
  });
  const offOld = installation(oldRoot, join(source, "upgrade-off"));
  await offOld.cli(["backup", "restore", oldBackup]); const off = installation(currentRoot, offOld.base);
  await step("default-off-upgrade-before-migration-crash", async () => {
    const before = await readFile(off.database);
    await killBoundary(off, "migration-before", await off.startArgs([]));
    assert.equal(databaseState(off, currentNative).schema, 24); assert.deepEqual(await readFile(off.database), before);
    await off.start(); await verifySeed(off);
    const remoteStatus = await off.json(["backup", "remote", "status"]); assert.equal(remoteStatus.enabled, false); assert.equal(remoteStatus.pending, 0);
    await off.stop(); const upgraded = databaseState(off, currentNative); assert.equal(upgraded.schema, 28); preservedAudit(initial, upgraded);
    await assert.rejects(lstat(join(off.base, "backups")), error => error.code === "ENOENT");
  });
  const main = installation(currentRoot, historical.base), backups = join(source, "local-copies"); await mkdir(backups, { mode: 0o700 });
  await step("enabled-pre-migration-gate-and-crash", async () => {
    const gate = ["--backup-before-migration", "--backup-dir", backups], before = await readFile(main.database);
    const blocked = join(root, "blocked-destination"); await writeFile(blocked, "occupied");
    await assert.rejects(main.cli(await main.startArgs(["--backup-before-migration", "--backup-dir", blocked])), error => error.code === 1 && !error.killed);
    assert.deepEqual(await readFile(main.database), before); assert.equal(databaseState(main, currentNative).schema, 24);
    await killBoundary(main, "migration-after-copy", await main.startArgs(gate), backups);
    assert.equal(databaseState(main, currentNative).schema, 24); assert.deepEqual(await readFile(main.database), before);
    const copies = await readdir(backups); assert.equal(copies.length, 1);
    const pre = JSON.parse(await readFile(join(backups, copies[0], "manifest.json"), "utf8")); assert.equal(pre.database.schemaVersion, 24); assert.equal(pre.attachments.length, 2);
    await main.start(gate); await verifySeed(main); await main.stop();
    const upgraded = databaseState(main, currentNative); assert.equal(upgraded.schema, 28); preservedAudit(initial, upgraded);
    for (const [table, count] of Object.entries(initial.counts)) assert(upgraded.counts[table] >= count);
  });
  remote = await resticFixture();
  let postWrite, confirmed, currentCopy;
  await step("preserve-post-upgrade-writes-in-remote-copy", async () => {
    await main.start(["--backup-dir", backups, ...remote.startupArguments]);
    const projectId = seed.records[0].project.id;
    postWrite = (await main.knowledge("create_task", { projectId, title: "Post-upgrade write preserved", description: "Must be accounted for before old recovery", idempotencyKey: "new-write" }, seed.records[0].token)).value;
    const copy = await main.json(["backup", "now", "--idempotency-key", "source-deleted-recovery"]);
    confirmed = await waitFor(async () => { const value = await main.json(["backup", "remote", "status"]); return value.lastConfirmed?.backupId === copy.backupId ? value.lastConfirmed : null; }, 45000, () => "Installed remote copy not confirmed.");
    currentCopy = join(backups, copy.backupId); await main.stop();
  });
  await step("separate-directory-old-recovery-accounting-new-writes", async () => {
    const rollback = installation(oldRoot, join(root, "old-recovered"));
    await rollback.cli(["backup", "restore", oldBackup]); assert.equal(databaseState(rollback, historicalNative).schema, 24);
    await rollback.start(); await verifySeed(rollback);
    await assert.rejects(rollback.knowledge("task", { projectId: postWrite.projectId, taskId: postWrite.id }, seed.records[0].token), knowledgeFailure("not_found")); await rollback.stop();
    await main.start(); assert.equal((await main.knowledge("task", { projectId: postWrite.projectId, taskId: postWrite.id }, seed.records[0].token)).title, postWrite.title); await main.stop();
  });
  await step("corrupt-manifest-and-canonical-owner-refusals", async () => {
    const corrupt = join(root, "corrupt-copy"); derivativeCopies.push(corrupt); await cp(currentCopy, corrupt, { recursive: true });
    const manifest = JSON.parse(await readFile(join(corrupt, "manifest.json"), "utf8")); manifest.formatVersion = 999; await writeFile(join(corrupt, "manifest.json"), JSON.stringify(manifest));
    const before = await readFile(main.database);
    await assert.rejects(main.cli(["backup", "restore", corrupt])); assert.deepEqual(await readFile(main.database), before);
    await main.start();
    // A separate state directory still cannot replace the active canonical DB.
    const other = installation(currentRoot, join(root, "other-state")); other.data = main.data;
    await assert.rejects(other.cli(["backup", "restore", currentCopy]), error => error.code === 1 && !error.killed); await main.stop();
    assert.deepEqual(await readFile(main.database), before);
  });
  await step("corrupt-database-and-future-schema-refusals", async () => {
    for (const kind of ["corrupt-database", "future-schema"]) {
      stage = `refuse-${kind}`;
      const copy = join(root, kind); derivativeCopies.push(copy); await cp(currentCopy, copy, { recursive: true });
      const path = join(copy, "state.sqlite3"), manifestPath = join(copy, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (kind === "corrupt-database") { const bytes = await readFile(path); bytes.fill(0, 0, 100); await writeFile(path, bytes); }
      else { const db = new currentNative.Database(path, { fileMustExist: true }); try { db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(999, "2026-10-03T00:00:00Z"); db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); } }
      const bytes = await readFile(path); manifest.database.size = bytes.length; manifest.database.sha256 = digest(bytes);
      // Keep the declared supported schema to exercise DB inspection, not JSON validation alone.
      await writeFile(manifestPath, JSON.stringify(manifest));
      const before = await readFile(main.database), sourceHash = digest(bytes);
      await assert.rejects(main.cli(["backup", "restore", copy]), error => error.code === 1 && !error.killed);
      assert.deepEqual(await readFile(main.database), before); assert.equal(digest(await readFile(path)), sourceHash);
    }
  });
  await step("installed-restore-before-and-after-replacement", async () => {
    for (const point of ["restore-before", "restore-after"]) {
      const oldTarget = installation(oldRoot, join(root, point));
      await oldTarget.cli(["backup", "restore", oldBackup]); await oldTarget.start();
      const sentinel = (await oldTarget.knowledge("create_task", { projectId: seed.records[0].project.id, title: "Old target generation sentinel", description: point, idempotencyKey: "old-sentinel" }, seed.records[0].token)).value;
      await oldTarget.stop(); assert.equal(databaseState(oldTarget, historicalNative).schema, 24);
      const restored = installation(currentRoot, oldTarget.base);
      await killBoundary(restored, point, ["backup", "restore", currentCopy, "--data-dir", restored.data, "--state-dir", restored.state]);
      await restored.start(); await verifySeed(restored);
      await assert.rejects(restored.knowledge("task", { projectId: sentinel.projectId, taskId: sentinel.id }, seed.records[0].token), knowledgeFailure("not_found"));
      assert.equal((await restored.knowledge("task", { projectId: postWrite.projectId, taskId: postWrite.id }, seed.records[0].token)).title, postWrite.title);
      const newTask = (await restored.knowledge("create_task", { projectId: postWrite.projectId, title: `After ${point}`, description: "Repeated recovery must retain this", idempotencyKey: "after-recovery" }, seed.records[0].token)).value;
      await restored.stop(); await restored.start(); assert.equal((await restored.knowledge("task", { projectId: newTask.projectId, taskId: newTask.id }, seed.records[0].token)).title, newTask.title); await restored.stop();
      assert.equal(JSON.parse(await readFile(`${restored.database}.restore/journal.json`, "utf8")).payload.state, "verified");
    }
  });
  const remoteManifestHash = digest(await readFile(join(currentCopy, "manifest.json")));
  // Delete every original installation and local backup before asking restic to restore.
  let removedLocalCopies;
  await step("delete-original-installations-and-local-copies", async () => {
    const copies = [...new Set([source, ...installations.map(item => item.base), ...derivativeCopies])];
    for (const path of copies) { await rm(path, { recursive: true, force: true }); await assert.rejects(lstat(path), error => error.code === "ENOENT"); }
    removedLocalCopies = copies.length;
  });
  const recovered = installation(currentRoot, join(root, "source-deleted-recovery")), download = join(root, "remote-download"), recoveryStartedAt = Date.now();
  await step("source-deleted-HTTPS-restore-with-installed-runtime", async () => {
    await remote.run(["restore", confirmed.snapshotId, "--target", download, "--verify"]);
    assert.equal(digest(await readFile(join(download, "manifest.json"))), remoteManifestHash);
    await recovered.cli(["backup", "restore", download]); await recovered.start(); await verifySeed(recovered);
    assert.equal((await recovered.knowledge("task", { projectId: postWrite.projectId, taskId: postWrite.id }, seed.records[0].token)).title, postWrite.title); await recovered.stop();
  });
  const final = databaseState(recovered, currentNative); preservedAudit(initial, final);
  console.log(JSON.stringify({ evidence: "installed-old-new-upgrade-and-source-deleted-recovery", runtime: "installed-artifacts", driver: "explicit-local-repository-script", historicalProvenance,
    native: { old: { load: "success", binary: historicalNative.binary, provisioning: historicalNative.provisioning }, current: { load: "success", binary: currentNative.binary, provisioning: currentNative.provisioning } },
    historicalModes: oldModes, foreground0022: "refused-before-migration-modes-hash-schema-preserved", schemas: { historical: initial.schema, recovered: final.schema }, counts: { historical: initial.counts, recovered: final.counts },
    capabilities: { seeded: ["owner", "agents", "distinct-project-grants", "threads", "replies", "task_from_thread/derived_from", "updated-tasks", "task-history", "memories", "attachment-bytes"], unsupported: ["arbitrary-create_relation"] },
    defaultOff: "upgrade-no-backup-destination-or-jobs", enabledGate: "failure-blocks-migration-verified-schema24-copy-before-upgrade", tenantDenial: "both-projects-before-and-after-upgrade-and-recovery", attachmentHashes: seed.records.map(record => record.attachment.sha256),
    auditPreservation: { exactHistoricalRows: true, counts: Object.fromEntries(Object.entries(initial.audit).map(([table, rows]) => [table, rows.length])) }, refusals: ["format", "corrupt-source-DB", "future-source-schema", "active-canonical-owner"], restoreReplacesExistingGeneration: true, faults, removedLocalCopies, sourceDeletedBeforeRemoteRestore: true, postUpgradeWrite: "preserved-in-current-copy-and-remote-recovery-absent-from-isolated-old-snapshot", oldRecovery: "separate-directory-schema24-never-opened-migrated-DB-with-old-runtime",
    credentials: { offlineRecovery: "historical-owner-session-and-both-scoped-agent-tokens-preserved", tenantGrants: "preserved-and-denial-rechecked", onlineRestoreSecurityFence: "covered-by-existing-S4a-matrix-not-this-offline-driver" },
    isolatedRecoveryDurationMs: Date.now() - recoveryStartedAt, physicalPowerLoss: "not-tested", operationalRpoRto: "not-measured", restic: remote.provenance, steps, durationMs: Date.now() - startedAt }));
} catch { console.log(JSON.stringify({ ok: false, errorCode: "fixture_failed", failureStep: stage, steps })); process.exitCode = 1; }
finally {
  process.umask(previousUmask);
  try { for (const item of installations.reverse()) await item.stop(); }
  finally { try { await remote?.close(); } finally { if (root) await rm(root, { recursive: true, force: true }); } }
}
