import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { IdentityService } from "@/server/modules/identity";
import { DEFAULT_ATTACHMENT_LIMITS, KnowledgeAttachmentService, KnowledgeService, exportKnowledgeProject, importKnowledgeProject, loadAttachmentLimits, knowledgeFailure, publishKnowledgeAttachment } from "@/server/modules/knowledge";
import type { KnowledgeAttachmentLimits } from "@/shared/contracts/knowledge-attachments";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function fixture(limits: KnowledgeAttachmentLimits = { fileBytes: 10, projectBytes: 20, projectFiles: 2 }) {
  const root = mkdtempSync(join(tmpdir(), "knowledge-capacity-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(root, "state.sqlite3")); cleanups.push(() => store.close());
  let identityId = 0;
  const identity = new IdentityService(store, undefined, () => identityId++ < 2 ? `00000000-0000-4000-8000-00000000000${identityId}` : randomUUID()), owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = identity.createKnowledgeProject({ name: "Evidence" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read", "knowledge:write", "attachments:read", "attachments:write", "knowledge:export"] }, owner);
  const directory = join(root, "attachments"), attachments = new KnowledgeAttachmentService(store, identity, directory, limits);
  const api = new KnowledgeService(store, identity, undefined, undefined, undefined, attachments);
  const task = api.createTask(project.id, { title: "Proof", description: "Proof" }, { idempotencyKey: "task" }, owner).value;
  const upload = (key: string, size: number) => attachments.upload(project.id, "task", task.id, { filename: `${key}.bin`, mediaType: "application/octet-stream", data: Buffer.alloc(size, 1), idempotencyKey: key }, owner);
  const entry = (key: string, size: number) => ({ filename: `${key}.bin`, size, sha256: sha(Buffer.alloc(size, 1)), mediaType: "application/octet-stream", idempotencyKey: key });
  return { root, store, identity, owner, project, task, directory, attachments, api, upload, entry };
}

describe("Knowledge logical capacity and evidence preflight", () => {
  it.each([
    [{ fileBytes: 10, projectBytes: 12, projectFiles: 3 }, 7, 6, ["projectBytes"]],
    [{ fileBytes: 10, projectBytes: 30, projectFiles: 1 }, 7, 1, ["projectFiles"]],
    [{ fileBytes: 10, projectBytes: 10, projectFiles: 1 }, 10, 1, ["projectBytes", "projectFiles"]],
    [{ fileBytes: 10, projectBytes: 10, projectFiles: 1 }, 10, 11, ["fileBytes", "projectBytes", "projectFiles"]],
  ] as const)("reports every independently exceeded constraint for %j", (limits, first, next, constraints) => {
    const f = fixture(limits); f.upload("first", first);
    try { f.upload("next", next); throw new Error("Accepted over quota"); } catch (error) {
      const failure = knowledgeFailure(error);
      expect(failure.status).toBe(413); expect(failure.body.code).toBe("limit_exceeded");
      expect(failure.body.details?.violations.map(item => item.constraint)).toEqual(constraints);
      for (const violation of failure.body.details!.violations) {
        expect(violation).toMatchObject({ used: expect.any(Number), limit: expect.any(Number), incoming: expect.any(Number), remaining: expect.any(Number), unit: expect.stringMatching(/bytes|records/) });
      }
      expect(failure.body.details?.recovery).toContain("knowledge-policy.json");
    }
    expect(f.attachments.policy(f.project.id, f.owner).used).toEqual({ bytes: first, files: 1 });
  });

  it("accepts exact boundaries, rejects empty/malformed data, and replays without charging twice", () => {
    const f = fixture(); f.upload("first", 10); f.upload("second", 10);
    expect(f.attachments.policy(f.project.id, f.owner)).toMatchObject({ used: { bytes: 20, files: 2 }, remaining: { bytes: 0, files: 0 }, exceeded: [], largestFileBytes: 10, physicalDiskUsage: null });
    expect(f.upload("first", 10).replayed).toBe(true);
    expect(() => f.upload("first", 9)).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(() => f.upload("empty", 0)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    for (const dataBase64 of ["!!!", "YQ", "YR==", "data:text/plain;base64,YQ=="]) {
      expect(() => f.api.execute({ operation: "create_attachment", input: { projectId: f.project.id, recordKind: "task", recordId: f.task.id, filename: "bad", mediaType: "text/plain", dataBase64, idempotencyKey: "invalid" } }, f.owner)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
  });

  it("checks the entire set, excludes verified retries, and does not reserve capacity", () => {
    const f = fixture(), check = (files: ReturnType<typeof f.entry>[]) => f.attachments.checkBatch(f.project.id, "task", f.task.id, files, f.owner);
    expect(check([f.entry("a", 10), f.entry("b", 10)])).toMatchObject({ accepted: true, incoming: { bytes: 20, files: 2 }, reservesCapacity: false, atomicUpload: false });
    expect(check([f.entry("a", 10), f.entry("b", 10), f.entry("c", 1)]).violations.map(item => item.constraint)).toEqual(["projectBytes", "projectFiles"]);
    expect(check([f.entry("large", 11)]).violations).toMatchObject([{ constraint: "fileBytes", filename: "large.bin" }]);
    f.upload("a", 10);
    expect(check([f.entry("a", 10), f.entry("b", 10)])).toMatchObject({ incoming: { bytes: 10, files: 1 }, replayedFiles: ["a.bin"] });
    expect(() => check([{ ...f.entry("a", 10), size: 9 }])).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    expect(() => check([f.entry("a", 9)])).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    f.upload("intervening", 10);
    expect(() => f.upload("b", 10)).toThrowError(expect.objectContaining({ code: "limit_exceeded" }));
    expect(() => check([f.entry("x", 1), f.entry("x", 1)])).toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });

  it("serializes competing services and retries, and checks admission inside the metadata transaction", async () => {
    const f = fixture({ fileBytes: 10, projectBytes: 10, projectFiles: 1 });
    const other = new KnowledgeAttachmentService(f.store, f.identity, f.directory, { fileBytes: 10, projectBytes: 10, projectFiles: 1 });
    const second = () => other.upload(f.project.id, "task", f.task.id, { filename: "b.bin", mediaType: "application/octet-stream", data: Buffer.alloc(10), idempotencyKey: "b" }, f.owner);
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => f.upload("a", 10)), Promise.resolve().then(second), Promise.resolve().then(() => f.upload("a", 10))]);
    expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(f.store.attachmentCountForProject(f.project.id)).toBe(1);
    // Simulate another admitted write between the optimistic check and save.
    const g = fixture({ fileBytes: 10, projectBytes: 10, projectFiles: 1 }), original = g.store.saveAttachment.bind(g.store);
    const spy = vi.spyOn(g.store, "saveAttachment").mockImplementationOnce((value, context, admit) => {
      original({ ...value, id: "competitor" }, { ...context, idempotencyKey: "competitor", requestHash: "c".repeat(64) });
      return original(value, context, admit);
    });
    expect(() => g.upload("a", 10)).toThrowError(expect.objectContaining({ code: "limit_exceeded" })); spy.mockRestore();
    expect(g.store.attachmentCountForProject(g.project.id)).toBe(1);
  });

  it("isolates projects, requires read/write permissions and keeps archived usage", () => {
    const f = fixture(), g = f.identity.createKnowledgeProject({ name: "Other" }, f.owner);
    const agent = f.identity.createAgent(f.owner);
    f.identity.setKnowledgeGrant({ principalId: agent.id, projectId: f.project.id, permissions: ["attachments:read"] }, f.owner);
    const actor = f.identity.authenticateBearer(f.identity.issueAgentToken({ principalId: agent.id, label: "read" }, f.owner).token);
    f.upload("proof", 10);
    expect(f.attachments.policy(f.project.id, actor).used.files).toBe(1);
    expect(() => f.attachments.policy(g.id, actor)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(() => f.attachments.checkBatch(f.project.id, "task", f.task.id, [f.entry("a", 1)], actor)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    f.api.archiveProject(f.project.id, 1, { idempotencyKey: "archive" }, f.owner);
    expect(f.attachments.policy(f.project.id, actor).used).toEqual({ bytes: 10, files: 1 });
    expect(() => f.attachments.checkBatch(f.project.id, "task", f.task.id, [f.entry("a", 1)], f.owner)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    f.identity.revokeKnowledgeGrant(agent.id, f.project.id, f.owner);
    expect(() => f.attachments.policy(f.project.id, actor)).toThrow();
  });

  it("validates declared evidence fields and binds the bundle to its task", () => {
    const f = fixture(), input = { projectId: f.project.id, recordKind: "task", recordId: f.task.id, files: [f.entry("proof", 1)], evidence: { setId: "set-1", taskId: f.task.id, commit: "a".repeat(40), command: "pnpm check", result: "passed", executedAt: "2026-10-04T21:00:00Z", scope: "Unit tests only; no browser or production verification." } };
    expect(f.api.execute({ operation: "check_attachment_batch", input }, f.owner)).toMatchObject({ evidence: input.evidence, accepted: true });
    expect(() => f.api.execute({ operation: "check_attachment_batch", input: { ...input, evidence: { ...input.evidence, taskId: "other" } } }, f.owner)).toThrow();
    expect(() => f.api.execute({ operation: "check_attachment_batch", input: { ...input, evidence: { ...input.evidence, scope: undefined } } }, f.owner)).toThrow();
  });

  it("reads bounded configuration, detects existing over-quota records and preserves downloads", () => {
    const f = fixture(); expect(loadAttachmentLimits(f.root)).toEqual(DEFAULT_ATTACHMENT_LIMITS);
    writeFileSync(join(f.root, "knowledge-policy.json"), JSON.stringify({ projectBytes: 12, projectFiles: 1, fileBytes: 5 }));
    const limits = loadAttachmentLimits(f.root); f.upload("first", 10); f.upload("second", 10);
    const lower = new KnowledgeAttachmentService(f.store, f.identity, f.directory, limits);
    expect(lower.policy(f.project.id, f.owner).exceeded.map(item => item.constraint)).toEqual(["projectBytes", "projectFiles", "fileBytes"]);
    const saved = f.upload("first", 10).value;
    expect(lower.download(f.project.id, saved.id, f.owner).data.byteLength).toBe(10);
    for (const invalid of [{ projectBytes: 0 }, { projectFiles: 10001 }, { fileBytes: 10485761 }, { projectBytes: 1073741825 }, { extra: true }, { projectFiles: null }]) {
      writeFileSync(join(f.root, "knowledge-policy.json"), JSON.stringify(invalid));
      expect(() => loadAttachmentLimits(f.root)).toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
  });

  it("imports → uploads → exports WinPath-sized logical records without dropping references or history", () => {
    const f = fixture(DEFAULT_ATTACHMENT_LIMITS), original = f.store.exportKnowledgeProject(f.project.id)!;
    const firstSize = Math.floor(183705590 / 1300), lastSize = 183705590 - firstSize * 1299;
    const objects = [Buffer.alloc(firstSize, 1), Buffer.alloc(lastSize, 2)];
    for (const bytes of objects) publishKnowledgeAttachment(f.directory, { sha256: sha(bytes), size: bytes.byteLength }, bytes);
    const snapshot = { ...original, attachments: Array.from({ length: 1300 }, (_, index) => {
      const bytes = objects[index === 1299 ? 1 : 0];
      return { id: `imported-${index}`, project_id: f.project.id, record_kind: "task", record_id: f.task.id, filename: `proof-${index}.bin`, media_type: "application/octet-stream", size: bytes.byteLength, sha256: sha(bytes), created_by: f.owner.principalId, created_at: "2026-10-04T21:00:00.000Z" };
    }) };
    const source = join(f.root, "source");
    exportKnowledgeProject({ ...f.store, schemaVersion: () => f.store.schemaVersion(), exportKnowledgeProject: () => snapshot, importKnowledgeProject: () => {} }, f.identity, f.project.id, source, f.directory, f.owner, { applicationVersion: "test" });
    const target = fixture(DEFAULT_ATTACHMENT_LIMITS);
    importKnowledgeProject(target.store, target.identity, source, target.directory, target.owner);
    target.identity.setKnowledgeGrant({ principalId: target.owner.principalId, projectId: f.project.id, permissions: ["attachments:read", "attachments:write", "knowledge:export"] }, target.owner);
    const service = new KnowledgeAttachmentService(target.store, target.identity, target.directory);
    expect(service.policy(f.project.id, target.owner).used).toEqual({ bytes: 183705590, files: 1300 });
    service.upload(f.project.id, "task", f.task.id, { filename: "new-proof.txt", mediaType: "text/plain", data: Buffer.from("new evidence"), idempotencyKey: "new-proof" }, target.owner);
    const destination = join(target.root, "export");
    const manifest = exportKnowledgeProject(target.store, target.identity, f.project.id, destination, target.directory, target.owner, { applicationVersion: "test" });
    expect(manifest.counts.attachments).toBe(1301);
    const roundtrip = JSON.parse(readFileSync(join(destination, "project.json"), "utf8"));
    expect(roundtrip.attachments.filter((row: { id: string }) => row.id.startsWith("imported-"))).toEqual(snapshot.attachments.sort((a, b) => a.id.localeCompare(b.id)));
    expect(roundtrip.history).toEqual(snapshot.history);
    expect(manifest.attachments).toHaveLength(3); // physical objects are deduplicated; quota is not.
    expect(() => exportKnowledgeProject(target.store, target.identity, f.project.id, join(target.root, "low-export"), target.directory, target.owner, { applicationVersion: "test", limits: { fileBytes: 10485760, projectBytes: 104857600, projectFiles: 1000 } })).toThrowError(expect.objectContaining({ details: expect.objectContaining({ violations: expect.arrayContaining([expect.objectContaining({ constraint: "projectBytes" }), expect.objectContaining({ constraint: "projectFiles" })]) }) }));
  });
});
