import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedSqliteDatabase, SqliteStateStore } from "./infrastructure/sqlite";
import { IdentityService } from "./modules/identity";
import { KnowledgeAttachmentService, KnowledgeService, calculateHubImportPlanHash, executeHubImport, exportKnowledgeProject, importKnowledgeProject, type HubImportPlan } from "./modules/knowledge";
import { createControllerBackup } from "./controller-backup";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
function fixture(executeOnlyAncestor = false) {
  const outer = fs.mkdtempSync(join(tmpdir(), "attachment-backup-")), root = executeOnlyAncestor ? join(outer, "data") : outer;
  if (executeOnlyAncestor) fs.mkdirSync(root, { mode: 0o700 });
  cleanups.push(() => { fs.chmodSync(outer, 0o700); fs.rmSync(outer, { recursive: true, force: true }); });
  const owned = new OwnedSqliteDatabase(join(root, "state.sqlite3"), true), store = new SqliteStateStore(join(root, "state.sqlite3"), owned); cleanups.push(() => store.close());
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const identity = new IdentityService(store, undefined, () => ids.shift() ?? randomUUID());
  const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token), project = identity.createKnowledgeProject({ name: "Original" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "knowledge:export", "attachments:read", "attachments:write"] }, owner);
  const task = new KnowledgeService(store, identity).createTask(project.id, { title: "Target", description: "Test" }, { idempotencyKey: "task" }, owner).value;
  const attachments = join(root, "attachments"), service = new KnowledgeAttachmentService(store, identity, attachments);
  const upload = (data: Buffer, key: string) => service.upload(project.id, "task", task.id, { filename: "proof.txt", mediaType: "text/plain", data, idempotencyKey: key }, owner);
  upload(Buffer.from("original"), "original");
  if (executeOnlyAncestor) fs.chmodSync(outer, 0o111);
  return { root, owned, store, identity, owner, project, attachments, upload, service };
}
function hub(f: ReturnType<typeof fixture>, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
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
  return executeHubImport(f.store, f.identity, f.owner, { plan, targetProjectId: "hub", targetProjectName: "Hub", attachmentDirectory: f.attachments, batchId: "hub-batch" }, undefined, plan => plan, () => bytes);
}

describe("immutable attachments during backup", () => {
  for (const operation of ["upload", "hub", "project"]) {
    it.each(["legacy", "execute-only"])(`backs up and runs ${operation} with %s directories`, async layout => {
      const f = fixture(layout === "execute-only"), external = fixture(), exported = join(external.root, "export");
      exportKnowledgeProject(external.store, external.identity, external.project.id, exported, external.attachments, external.owner, { applicationVersion: "test" });
      const original = f.store.exportKnowledgeProject(f.project.id)!.attachments[0];
      const shard = join(f.attachments, String(original.sha256).slice(0, 2));
      const legacy = () => { if (layout === "legacy") { fs.chmodSync(f.attachments, 0o775); fs.chmodSync(shard, 0o775); } };
      legacy();
      const before = await createControllerBackup(f.store, join(f.root, "before"), { applicationVersion: "test", attachmentDirectory: f.attachments });
      expect(before.attachments).toHaveLength(1);
      legacy();
      if (operation === "upload") f.upload(Buffer.from("original"), "legacy");
      if (operation === "hub") hub(f, Buffer.from("original"));
      if (operation === "project") importKnowledgeProject(f.store, f.identity, exported, f.attachments, f.owner);
      const destination = join(f.root, "after"), after = await createControllerBackup(f.store, destination, { applicationVersion: "test", attachmentDirectory: f.attachments });
      expect(after.attachments).toHaveLength(1);
      expect(fs.readFileSync(join(destination, "attachments", after.attachments[0].file), "utf8")).toBe("original");
      if (layout === "legacy") for (const path of [f.attachments, shard]) expect(fs.statSync(path).mode & 0o777).toBe(0o700);
      const project = operation === "hub" ? "hub" : operation === "project" ? external.project.id : f.project.id;
      expect(f.store.exportKnowledgeProject(project)!.attachments).toHaveLength(operation === "upload" ? 2 : 1);
    });
  }

  for (const operation of ["upload", "hub", "project"]) {
    it.each(["before", "after"])(`copies exactly the snapshot references with ${operation} committing %s the snapshot`, async boundary => {
      const f = fixture(), external = fixture(), exported = join(external.root, "export");
      external.upload(Buffer.from("external"), "external");
      exportKnowledgeProject(external.store, external.identity, external.project.id, exported, external.attachments, external.owner, { applicationVersion: "test" });
      const mutate = () => {
        if (operation === "upload") f.upload(Buffer.from("new upload"), "new");
        if (operation === "hub") hub(f, Buffer.from("imported hub"));
        if (operation === "project") importKnowledgeProject(f.store, f.identity, exported, f.attachments, f.owner);
      };
      const source = { backup: async (path: string) => {
        if (boundary === "before") mutate();
        await f.store.backup(path);
        if (boundary === "after") mutate();
        // Remove metadata after the snapshot, then roll back a shared-hash upload.
        const original = f.store.exportKnowledgeProject(f.project.id)!.attachments[0];
        const failing = new KnowledgeAttachmentService(f.store, f.identity, f.attachments, undefined, undefined, () => String(original.id));
        expect(() => failing.upload(f.project.id, "task", String(original.record_id), { filename: "other", mediaType: "text/plain", data: Buffer.from("original"), idempotencyKey: "failed" }, f.owner)).toThrow();
        f.owned.database.prepare("DELETE FROM knowledge_attachments WHERE id=?").run(original.id);
      } };
      const destination = join(f.root, "backup"), manifest = await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: f.attachments });
      const snapshot = new Database(join(destination, "state.sqlite3"), { readonly: true });
      try {
        const rows = snapshot.prepare("SELECT DISTINCT sha256,size FROM knowledge_attachments ORDER BY sha256").all() as Array<{ sha256: string; size: number }>;
        expect(manifest.attachments.map(({ sha256, size }) => ({ sha256, size }))).toEqual(rows);
        expect(rows).toHaveLength(boundary === "after" ? 1 : 2);
        for (const row of rows) {
          const bytes = fs.readFileSync(join(destination, "attachments", row.sha256.slice(0, 2), row.sha256));
          expect(bytes.length).toBe(row.size); expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.sha256);
        }
      } finally { snapshot.close(); }
    });
  }

  it.each(["upload", "hub", "project"])("preserves a committed shared hash after %s SQL rollback and retries", operation => {
    const f = fixture(), external = fixture(), exported = join(external.root, "export");
    exportKnowledgeProject(external.store, external.identity, external.project.id, exported, external.attachments, external.owner, { applicationVersion: "test" });
    const original = f.store.exportKnowledgeProject(f.project.id)!.attachments[0];
    const run = () => {
      if (operation === "upload") return f.upload(Buffer.from("original"), "retry");
      if (operation === "hub") return hub(f, Buffer.from("original"));
      return importKnowledgeProject(f.store, f.identity, exported, f.attachments, f.owner);
    };
    f.owned.database.exec("CREATE TEMP TRIGGER fail_attachment BEFORE INSERT ON knowledge_attachments BEGIN SELECT RAISE(ABORT, 'test transaction failure'); END;");
    expect(run).toThrow("test transaction failure");
    expect(f.service.download(f.project.id, String(original.id), f.owner).data.toString()).toBe("original");
    expect(f.store.getKnowledgeProject("hub")).toBeNull(); expect(f.store.getKnowledgeProject(external.project.id)).toBeNull();
    f.owned.database.exec("DROP TRIGGER fail_attachment;");
    run();
    expect(f.service.download(f.project.id, String(original.id), f.owner).data.toString()).toBe("original");
    const imported = operation === "hub" ? "hub" : operation === "project" ? external.project.id : f.project.id;
    expect(f.store.exportKnowledgeProject(imported)!.attachments).toHaveLength(operation === "upload" ? 2 : 1);
    expect(fs.readdirSync(f.attachments, { recursive: true }).filter(name => /^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(String(name)))).toHaveLength(1);
  });

  it.each(["upload", "hub", "project"])("refuses %s metadata after a file/directory synchronization failure", operation => {
    const f = fixture(), external = fixture(), exported = join(external.root, "export");
    external.upload(Buffer.from("external"), "external");
    exportKnowledgeProject(external.store, external.identity, external.project.id, exported, external.attachments, external.owner, { applicationVersion: "test" });
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("sync failed"), { code: "ENOSPC" }); sync(fd); });
    expect(() => {
      if (operation === "upload") f.upload(Buffer.from("failed"), "failed");
      if (operation === "hub") hub(f, Buffer.from("failed"));
      if (operation === "project") importKnowledgeProject(f.store, f.identity, exported, f.attachments, f.owner);
    }).toThrow("sync failed");
    expect(f.store.exportKnowledgeProject(f.project.id)!.attachments).toHaveLength(1);
    expect(f.store.getKnowledgeProject("hub")).toBeNull();
    expect(f.store.getKnowledgeProject(external.project.id)).toBeNull();
  });

  it("fails an incomplete backup copy without touching live objects", async () => {
    const f = fixture(), destination = join(f.root, "backup");
    vi.spyOn(fs, "writeSync").mockImplementation(() => { throw Object.assign(new Error("copy denied"), { code: "EACCES" }); });
    await expect(createControllerBackup(f.store, destination, { applicationVersion: "test", attachmentDirectory: f.attachments })).rejects.toThrow("copy denied");
    expect(fs.existsSync(destination)).toBe(false);
    expect(f.service.download(f.project.id, String(f.store.exportKnowledgeProject(f.project.id)!.attachments[0].id), f.owner).data.toString()).toBe("original");
  });
});
