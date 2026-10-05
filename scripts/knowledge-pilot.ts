import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireControllerLock } from "../src/server/controller-lock";
import { createControllerBackup, restoreControllerBackup } from "../src/server/controller-backup";
import { SqliteStateStore } from "../src/server/infrastructure/sqlite/sqlite-state-store";
import { AuthenticationService, resolveControllerAuthentication } from "../src/server/modules/authentication";
import { IdentityService } from "../src/server/modules/identity";
import { executeHubImport, exportKnowledgeProject, importKnowledgeProject, planHubImport } from "../src/server/modules/knowledge";

// Explicit inputs keep host paths and the live controller out of this exercise.
const [repository, commit, validatorRepository, destination] = process.argv.slice(2);
if (!repository || !commit || !validatorRepository || !destination || process.argv.length !== 6) {
  throw new Error("Usage: tsx scripts/knowledge-pilot.ts <repository> <commit SHA> <validator repository> <new destination>");
}
const root = resolve(destination);
process.umask(0o077); // Databases, exports and backups stay private to the operator.
mkdirSync(root, { mode: 0o700 }); // Never reuse or overwrite a previous pilot.
const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const projectId = "k7a-worktree-switcher";
const database = join(root, "data/state.sqlite3");
const attachments = join(root, "data/knowledge-attachments");
const implementation = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
const plan = planHubImport({ repository, commit, sourceId: "worktree-switcher", validatorRepository });
save("plan.json", plan);
save("pilot.json", { implementation, sourceDirty, repository: resolve(repository), commit, projectId, mappingVersion: plan.mappingVersion, liveWrites: false });
// The public CLI initializes token mode offline, exactly as an operator would. Credentials travel
// through pipes and environment variables only; they are never printed or passed as arguments.
const pathArgs = ["--data-dir", join(root, "data"), "--state-dir", join(root, "state")];
const cli = (args: string[], token?: string) => {
  const environment = { ...process.env };
  for (const name of ["TOKEN", "OWNER_TOKEN", "KNOWLEDGE_TOKEN", "DATA_DIR", "STATE_DIR"].flatMap((suffix) => [`WORKTREE_CONTROL_${suffix}`, `WORKTREE_SWITCHER_${suffix}`])) delete environment[name];
  if (token) environment.WORKTREE_CONTROL_TOKEN = token;
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args, ...pathArgs], { encoding: "utf8", env: environment, timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const generated = cli(["auth", "token", "generate"]);
assert.equal(generated.status, 0, "auth token generate failed");
const issued = JSON.parse(generated.stdout) as { token: string; status: { mode: string; token: { prefix: string } | null } };
assert.equal(issued.status.mode, "token");
assert.match(issued.token, /^wsi_[0-9a-f-]{36}_[0-9a-f]{64}$/);
const installationToken = issued.token;
writeFileSync(join(root, "installation-token"), installationToken, { mode: 0o600 });
const refused = cli(["identity", "list-agents"]);
assert.equal(refused.status, 1);
assert.match(refused.stderr, /requires a credential/);
const wrongCredential = cli(["identity", "list-agents"], `wsi_${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}_${"0".repeat(64)}`);
assert.equal(wrongCredential.status, 1);
assert.match(wrongCredential.stderr, /Nieprawidłowe lub nieaktywne poświadczenie/); // IdentityError invalid_credential
assert.equal(cli(["identity", "list-agents"], installationToken).status, 0);
const checks: string[] = ["CLI initializes token mode; offline identity CLI rejects missing and wrong credentials and accepts the installation token"];
const lock = acquireControllerLock(join(root, "state/controller.lock"));
let store = new SqliteStateStore(database);
/** Resolves the installation token under the persisted mode, as every transport does. */
function installationActor(current: SqliteStateStore) {
  const authentication = new AuthenticationService(current);
  const identity = new IdentityService(current, undefined, undefined, undefined, authentication);
  const result = resolveControllerAuthentication({ authentication, identity }, { bearer: installationToken, legacySecretValid: () => false });
  if (result?.kind !== "installation") throw new Error("The installation token was not accepted.");
  return { identity, actor: result.actor };
}
try {
  assert.equal(new AuthenticationService(store).status().mode, "token");
  await store.backup(join(root, "identity-baseline.sqlite3"));
  const input = { plan, targetProjectId: projectId, targetProjectName: "Worktree Switcher — PILOT COPY", chunkSize: 32, attachmentDirectory: attachments };
  let batch;
  do {
    const { identity, actor } = installationActor(store);
    batch = executeHubImport(store, identity, actor, input);
    if (batch.status === "staging") assert.equal(store.getKnowledgeProject(projectId), null);
    console.log(JSON.stringify({ stage: "import", cursor: batch.cursor, total: batch.totalItems, status: batch.status }));
    store.close();
    store = new SqliteStateStore(database);
  } while (batch.status === "staging");
  checks.push("staging invisible; cursor survives connection reopen; complete publication");
  const snapshot = store.exportKnowledgeProject(projectId)!;
  const activeTaskIds=new Set(plan.mappings.filter(mapping=>mapping.targetKind==="task"&&mapping.legacyId).map(mapping=>mapping.legacyId!));
  const orphanCompletionIds=new Set(plan.mappings.filter(mapping=>mapping.targetKind==="task_completion").map(mapping=>{const payload=mapping.originalPayload as Record<string,unknown>;const itemId=typeof payload?.item_id==="string"&&payload.item_id?payload.item_id:null;return itemId&&activeTaskIds.has(itemId)?null:itemId??mapping.legacyId??mapping.sourcePath;}).filter((value):value is string=>Boolean(value)));
  assert.equal(snapshot.tasks.length, activeTaskIds.size + orphanCompletionIds.size);
  assert.equal(snapshot.memories.length, plan.counts.notes);
  assert.equal(snapshot.replies.length, plan.counts.embeddedNotes);
  assert.equal(snapshot.attachments.length, plan.counts.attachments);
  assert.equal(snapshot.importSources.length, plan.mappings.length);
  for (const mapping of plan.mappings) {
    const source = snapshot.importSources.find(row => row.source_path === mapping.sourcePath)!;
    assert.equal(source.source_sha256, mapping.sourceSha256);
    if (mapping.originalPayload !== undefined) assert.deepEqual(JSON.parse(String(source.original_payload_json)), mapping.originalPayload);
  }
  for (const attachment of snapshot.attachments) {
    const hash = String(attachment.sha256);
    const bytes = readFileSync(join(attachments, hash.slice(0, 2), hash));
    assert.equal(bytes.length, attachment.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
  checks.push("counts, original payloads, source hashes and attachment bytes match the plan");
  for(const mapping of plan.mappings.filter(mapping=>mapping.targetKind==="task_completion")){
    const source=snapshot.importSources.find(row=>row.source_path===mapping.sourcePath)!;
    const task=snapshot.tasks.find(row=>row.id===source.target_id)!;
    const summary=(mapping.originalPayload as Record<string,unknown>).summary;
    if(Array.isArray(summary)) for(const item of summary) if(typeof item==="string"&&item.trim()) assert.match(String(task.description),new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  }
  const importedReplies=new Map(snapshot.importSources.filter(row=>row.target_kind==="historical_comment").map(row=>[row.target_id,row]));
  for(const reply of snapshot.replies){const source=importedReplies.get(reply.id);if(!source) continue;const payload=JSON.parse(String(source.original_payload_json)) as Record<string,unknown>;assert.equal(typeof payload.author==="string"&&payload.author.length>0,true);assert.equal(typeof payload.date==="string"&&payload.date.length>0,true);}
  checks.push("completion summaries and historical comment attribution remain readable from provenance");
  // Every item keeps its title; open-item status/priority survive unless a completion closed it.
  const payloadOf = (row: Record<string, unknown>) => JSON.parse(String(row.original_payload_json)) as Record<string, unknown>;
  const taskTargets = new Map<string, string>(), completedTargets = new Set<string>();
  for (const row of snapshot.importSources) {
    if (row.target_kind !== "task" && row.target_kind !== "task_completion") continue;
    if (typeof row.legacy_id === "string") taskTargets.set(row.legacy_id, String(row.target_id));
    const itemId = payloadOf(row).item_id;
    if (row.target_kind === "task_completion") { completedTargets.add(String(row.target_id)); if (typeof itemId === "string" && itemId) taskTargets.set(itemId, String(row.target_id)); }
  }
  for (const row of snapshot.importSources.filter(row => row.target_kind === "task")) {
    const payload = payloadOf(row), task = snapshot.tasks.find(candidate => candidate.id === row.target_id)!;
    assert.equal(task.title, payload.title);
    if (completedTargets.has(String(task.id))) continue;
    assert.equal(task.status, payload.status === "in-progress" ? "in_progress" : payload.status);
    assert.equal(task.priority, payload.priority);
  }
  const expectedRelations = new Set<string>();
  for (const row of snapshot.importSources) {
    const payload = payloadOf(row), source = taskTargets.get(String(row.legacy_id));
    const links = row.target_kind === "task" && payload.links && typeof payload.links === "object" ? payload.links as Record<string, unknown> : {};
    for (const legacy of Array.isArray(links.related_ids) ? links.related_ids : []) {
      const target = taskTargets.get(String(legacy));
      if (source && target && source !== target) expectedRelations.add(`relates_to:${[source, target].sort().join(":")}`);
    }
    const followups = row.target_kind === "task_completion" && Array.isArray(payload.followup_ids) ? payload.followup_ids : [];
    for (const legacy of followups) {
      const followup = taskTargets.get(String(legacy));
      if (source && followup && source !== followup) expectedRelations.add(`derived_from:${followup}:${source}`);
    }
  }
  const taskRelations = new Set(snapshot.relations.filter(row => row.source_kind === "task" && row.target_kind === "task").map(row => row.type === "relates_to"
    ? `relates_to:${[String(row.source_id), String(row.target_id)].sort().join(":")}` : `${String(row.type)}:${String(row.source_id)}:${String(row.target_id)}`));
  assert.deepEqual([...taskRelations].sort(), [...expectedRelations].sort());
  assert.ok(expectedRelations.size > 0);
  const attachmentHashes = plan.mappings.filter(mapping => mapping.targetKind === "attachment").map(mapping => mapping.sourceSha256).sort();
  assert.deepEqual(snapshot.attachments.map(row => String(row.sha256)).sort(), attachmentHashes);
  checks.push("every imported item keeps title/status/priority; resolved related_ids and followup_ids become exactly the imported task relations; attachment hashes equal the committed note files");
  const publishedBatch = store.getHubImport(batch.id)!;
  assert.equal(publishedBatch.actorPrincipalId, "installation");
  assert.equal(publishedBatch.authenticationMethod, "installation_token");
  const importedRecords = [...snapshot.tasks, ...snapshot.memories, ...snapshot.replies, ...snapshot.threads];
  assert.ok(importedRecords.every(row => row.created_by === "installation"));
  const importAttribution = { batchActorPrincipalId: publishedBatch.actorPrincipalId, batchAuthenticationMethod: publishedBatch.authenticationMethod, importedRecordCreator: "installation", importedHistoryRows: snapshot.history.length };
  checks.push("import batch records the installation principal and token method; imported records name the installation principal");
  const { identity, actor } = installationActor(store);
  executeHubImport(store, identity, actor, input);
  assert.deepEqual(store.exportKnowledgeProject(projectId), snapshot);
  checks.push("identical import is a no-op");
  exportKnowledgeProject(store, identity, projectId, join(root, "project-export"), attachments, actor, { applicationVersion: implementation });
  // Logical exports intentionally exclude credentials: provide the same identity baseline separately.
  copyFileSync(join(root, "identity-baseline.sqlite3"), join(root, "logical-restore.sqlite3"));
  const restored = new SqliteStateStore(join(root, "logical-restore.sqlite3"));
  try {
    const restoredActor = installationActor(restored);
    importKnowledgeProject(restored, restoredActor.identity, join(root, "project-export"), join(root, "logical-attachments"), restoredActor.actor);
    assert.deepEqual(restored.exportKnowledgeProject(projectId), snapshot);
  } finally { restored.close(); }
  checks.push("logical export/restore matches the full snapshot with a separate identity baseline");
  await createControllerBackup(store, join(root, "controller-backup"), { applicationVersion: implementation, attachmentDirectory: attachments });
  restoreControllerBackup(join(root, "controller-backup"), join(root, "physical-restore.sqlite3"), join(root, "physical-attachments"));
  const physical = new SqliteStateStore(join(root, "physical-restore.sqlite3"));
  try {
    assert.deepEqual(physical.exportKnowledgeProject(projectId), snapshot);
    assert.deepEqual(physical.getHubImport(batch.id), publishedBatch);
  } finally { physical.close(); }
  checks.push("controller backup/restore matches the full knowledge snapshot and import batch attribution");
  const knownArchived = new Set(plan.mappings.filter(m => m.sourceKind === "done").map(m => (m.originalPayload as Record<string, unknown>)?.item_id));
  const report = { implementation, sourceDirty, sourceCommit: commit, planId: plan.planId, mappingVersion:plan.mappingVersion, schemaVersion:store.schemaVersion(), checks, authenticationMode: new AuthenticationService(store).status().mode, importAttribution, taskRelations: expectedRelations.size, counts: Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length])), unresolvedRelations: plan.unresolvedRelations, unresolvedWithArchivedTarget: plan.unresolvedRelations.filter(r => knownArchived.has(r.targetLegacyId)).length, cutoverApproved: false };
  save("report.json", report);
  console.log(JSON.stringify({ stage: "complete", checks, counts: report.counts, unresolved: report.unresolvedRelations.length }));
} catch (error) {
  save("failure.json", { checks, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally { store.close(); lock.release(); }
