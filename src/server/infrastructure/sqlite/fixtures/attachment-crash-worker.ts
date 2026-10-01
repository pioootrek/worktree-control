import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { OwnedSqliteDatabase, SqliteStateStore } from "../index";
import { IdentityService } from "../../../modules/identity";
import { KnowledgeAttachmentService, KnowledgeService, executeHubImport, calculateHubImportPlanHash, exportKnowledgeProject, importKnowledgeProject, type HubImportPlan } from "../../../modules/knowledge";

const [root, operation, point] = process.argv.slice(2), database = join(root, "state.sqlite3"), attachments = join(root, "attachments");
const owned = new OwnedSqliteDatabase(database, true), store = new SqliteStateStore(database, owned);
const identity = new IdentityService(store), token = identity.bootstrapOwnerSession().token, owner = identity.authenticateBearer(token);
const project = identity.createKnowledgeProject({ name: "Original" }, owner);
identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:export", "attachments:read", "attachments:write"] }, owner);
const knowledge = new KnowledgeService(store, identity);
const task = knowledge.createTask(project.id, { title: "Target", description: "Test", priority: "later" }, { idempotencyKey: "task" }, owner).value;
const bytes = Buffer.from("process interruption attachment"), sha256 = createHash("sha256").update(bytes).digest("hex");
const upload = () => new KnowledgeAttachmentService(store, identity, attachments).upload(project.id, "task", task.id, { filename: "proof.txt", mediaType: "text/plain", data: bytes, idempotencyKey: "upload" }, owner);
let run: () => unknown = upload;
if (operation === "hub") {
  const plan: HubImportPlan = {
    formatVersion: 1, mappingVersion: 2, planId: "", planHash: "",
    source: { sourceId: "fixture", repository: "/isolated", commit: "d".repeat(40), backlogPath: "docs/backlog" },
    validator: { repository: "/validator", commit: "e".repeat(40), command: ["validate"], valid: true, diagnostics: [] },
    counts: { files: 2, bytes: bytes.length, tasks: 0, embeddedNotes: 0, done: 0, notes: 1, attachments: 1, documents: 0, configurations: 0, schemas: 0, derived: 0, unclassified: 0, mapped: 2, sourceOnly: 0, skipped: 0, missing: 0, conflicts: 0, unresolvedRelations: 0 },
    mappings: [
      { sourcePath: "docs/backlog/notes/NOTE-one/note.json", sourceKind: "note", targetKind: "memory", legacyId: "NOTE-one", disposition: "mapped", sourceSha256: "a".repeat(64), size: 1, mappedFields: [], sourceOnlyFields: [], originalPayload: { id: "NOTE-one", title: "Imported", body: "Body" } },
      { sourcePath: "docs/backlog/notes/NOTE-one/proof.txt", sourceKind: "attachment", targetKind: "attachment", legacyId: null, disposition: "mapped", sourceSha256: sha256, size: bytes.length, mappedFields: [], sourceOnlyFields: [] },
    ], missing: [], conflicts: [], unresolvedRelations: [], guarantees: { dataWritten: false, sourceReadFromCommit: true, importedRepositoryScriptsExecuted: false },
  };
  plan.planHash = calculateHubImportPlanHash(plan); plan.planId = `hub:fixture:${plan.source.commit}:${plan.planHash.slice(0, 16)}`;
  fs.writeFileSync(join(root, "plan.json"), JSON.stringify(plan), { mode: 0o600 });
  run = () => executeHubImport(store, identity, owner, { plan, targetProjectId: "imported", targetProjectName: "Imported", attachmentDirectory: attachments, batchId: "crash-batch" }, undefined, plan => plan, () => bytes);
} else if (operation === "project") {
  upload();
  exportKnowledgeProject(store, identity, project.id, join(root, "export"), attachments, owner, { applicationVersion: "test" });
  // Use a separate isolated target with the same principals, without the project.
  owned.database.exec("DELETE FROM knowledge_idempotency; DELETE FROM knowledge_attachments; DELETE FROM knowledge_history; DELETE FROM knowledge_tasks; DELETE FROM knowledge_project_grants; DELETE FROM knowledge_projects; DELETE FROM knowledge_idempotency;");
  fs.rmSync(attachments, { recursive: true });
  run = () => importKnowledgeProject(store, identity, join(root, "export"), attachments, owner);
}
fs.writeFileSync(join(root, "fixture.json"), JSON.stringify({ token, projectId: project.id, taskId: task.id, sha256, size: bytes.length }), { mode: 0o600 });
function hold() {
  process.send?.({ point, operation });
  // Flush IPC before pausing synchronously inside the filesystem/SQL boundary.
  const deadline = Date.now() + 100;
  while (Date.now() < deadline) { /* bounded IPC handoff */ }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (point === "before-commit") {
  owned.database.function("hold_publication", hold);
  owned.database.exec("CREATE TEMP TRIGGER hold_attachment AFTER INSERT ON knowledge_attachments BEGIN SELECT hold_publication(); END;");
} else {
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    if (point === "before-file") hold();
    link(from, to);
    if (point === "after-file") hold();
  };
  syncBuiltinESMExports();
}
run();
throw new Error("Crash fixture missed the requested boundary.");
