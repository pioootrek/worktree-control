import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeAttachmentService, KnowledgeService } from "@/server/modules/knowledge";

const cleanups: Array<() => void> = []; afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-attachment-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStateStore(join(root, "state.sqlite3")); cleanups.push(() => store.close());
  const identity = new IdentityService(store); const owner = identity.authenticateBearer(identity.bootstrapOwnerSession().token);
  const project = identity.createKnowledgeProject({ name: "Files" }, owner);
  identity.setKnowledgeGrant({ principalId: owner.principalId, projectId: project.id, permissions: ["knowledge:read","knowledge:write","attachments:read", "attachments:write"] }, owner);
  store.createTask({id:"task-1",projectId:project.id,title:"Task",description:"Target",status:"open",priority:"later",revision:1,createdBy:owner.principalId,createdAt:"2026-09-14T00:00:00.000Z",updatedAt:"2026-09-14T00:00:00.000Z"},{actor:owner,projectId:project.id,idempotencyKey:"task",requestHash:"0".repeat(64)});
  const attachmentDirectory=join(root,"attachments"); return { store, identity, owner, project, attachmentDirectory, service: new KnowledgeAttachmentService(store, identity, attachmentDirectory, { fileBytes: 12, projectBytes: 20 }, () => "2026-09-14T00:00:00.000Z", (() => { let id=0; return () => `id-${++id}`; })()) };
}
describe("knowledge attachments", () => {
  it("uploads, lists and downloads an immutable attachment through the authorized service", () => {
    const f=setup(); const data=Buffer.from("evidence"); const saved=f.service.upload(f.project.id,"task","task-1",{filename:"proof.txt",mediaType:"text/plain",data,idempotencyKey:"upload"},f.owner).value;
    expect(f.service.list(f.project.id,"task","task-1",f.owner).items).toEqual([saved]);
    expect(f.service.download(f.project.id,saved.id,f.owner)).toEqual({attachment:saved,data,disposition:"attachment"});
    expect(f.service.upload(f.project.id,"task","task-1",{filename:"proof.txt",mediaType:"text/plain",data,idempotencyKey:"upload"},f.owner)).toEqual({value:saved,replayed:true});
  });
  it("reads archived attachments while denying writes and callers without the read grant", () => {
    const f = setup(), data = Buffer.from("evidence");
    const input = { filename: "proof.txt", mediaType: "text/plain", data, idempotencyKey: "upload" };
    const saved = f.service.upload(f.project.id, "task", "task-1", input, f.owner).value;
    const api = new KnowledgeService(f.store, f.identity, undefined, undefined, undefined, f.service);
    api.archiveProject(f.project.id, f.project.revision, { idempotencyKey: "archive" }, f.owner);
    expect(f.service.list(f.project.id, "task", "task-1", f.owner).items).toEqual([saved]);
    expect(f.service.download(f.project.id, saved.id, f.owner).data).toEqual(data);
    expect(() => f.service.upload(f.project.id, "task", "task-1", input, f.owner)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(() => f.service.upload(f.project.id, "task", "task-1", { ...input, idempotencyKey: "new-upload" }, f.owner)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    f.identity.revokeKnowledgeGrant(f.owner.principalId, f.project.id, f.owner);
    expect(() => f.service.list(f.project.id, "task", "task-1", f.owner)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
    expect(() => f.service.download(f.project.id, saved.id, f.owner)).toThrowError(expect.objectContaining({ code: "knowledge_forbidden" }));
  });

  it("rejects unsafe names, mismatched hashes and bounded storage", () => {
    const f=setup(); const input={mediaType:"text/plain",data:Buffer.from("evidence")};
    expect(()=>f.service.upload(f.project.id,"task","task-1",{...input,filename:"../proof",idempotencyKey:"a"},f.owner)).toThrowError(expect.objectContaining({code:"invalid_request"}));
    expect(()=>f.service.upload(f.project.id,"task","task-1",{...input,filename:"proof",sha256:"0".repeat(64),idempotencyKey:"b"},f.owner)).toThrowError(expect.objectContaining({code:"invalid_request"}));
    expect(()=>f.service.upload(f.project.id,"task","task-1",{...input,filename:"large",data:Buffer.alloc(13),idempotencyKey:"c"},f.owner)).toThrowError(expect.objectContaining({code:"limit_exceeded"}));
    expect(()=>f.service.upload(f.project.id,"task","missing",{...input,filename:"proof",idempotencyKey:"d"},f.owner)).toThrowError(expect.objectContaining({code:"not_found"}));
  });
  it("exposes files through the shared transport contract", () => {
    const f=setup(); const api=new KnowledgeService(f.store,f.identity,undefined,undefined,undefined,f.service);
    const saved=api.execute({operation:"create_attachment",input:{projectId:f.project.id,recordKind:"task",recordId:"task-1",filename:"proof.txt",mediaType:"text/plain",dataBase64:"ZXZpZGVuY2U=",idempotencyKey:"api-upload"}},f.owner) as {value:{id:string}};
    expect(api.execute({operation:"attachment",input:{projectId:f.project.id,attachmentId:saved.value.id}},f.owner)).toMatchObject({dataBase64:"ZXZpZGVuY2U=",disposition:"attachment"});
  });
  it("rejects a symlinked content shard",()=>{
    const f=setup(), data=Buffer.from("evidence"), hash=createHash("sha256").update(data).digest("hex"); const root=f.attachmentDirectory;
    mkdirSync(root,{recursive:true}); const outside=mkdtempSync(join(tmpdir(),"attachment-outside-")); cleanups.push(()=>rmSync(outside,{recursive:true,force:true})); symlinkSync(outside,join(root,hash.slice(0,2)));
    expect(()=>f.service.upload(f.project.id,"task","task-1",{filename:"proof",mediaType:"text/plain",data,idempotencyKey:"link"},f.owner)).toThrowError(expect.objectContaining({code:"invalid_request"}));
  });
  it("retains a durable orphan when metadata persistence fails",()=>{
    const f=setup(), first=Buffer.from("first"); f.service.upload(f.project.id,"task","task-1",{filename:"one",mediaType:"text/plain",data:first,idempotencyKey:"one"},f.owner);
    const data=Buffer.from("second"), hash=createHash("sha256").update(data).digest("hex"), root=f.attachmentDirectory;
    const ids=()=>"id-1"; const failing=new KnowledgeAttachmentService(f.store,f.identity,root,undefined,undefined,ids);
    expect(()=>failing.upload(f.project.id,"task","task-1",{filename:"two",mediaType:"text/plain",data,idempotencyKey:"two"},f.owner)).toThrow();
    expect(existsSync(join(root,hash.slice(0,2),hash))).toBe(true);
  });
  it("keeps another committed reference when a shared-hash upload rolls back, then retries", () => {
    const f = setup(), data = Buffer.from("evidence");
    const input = { filename: "proof", mediaType: "text/plain", data, idempotencyKey: "one" };
    const saved = f.service.upload(f.project.id, "task", "task-1", input, f.owner).value;
    const failing = new KnowledgeAttachmentService(f.store, f.identity, f.attachmentDirectory, undefined, undefined, () => saved.id);
    expect(() => failing.upload(f.project.id, "task", "task-1", { ...input, idempotencyKey: "two" }, f.owner)).toThrow();
    expect(f.service.download(f.project.id, saved.id, f.owner).data).toEqual(data);
    expect(f.store.listAttachments(f.project.id, "task", "task-1", 25, 0).items).toHaveLength(1);
    expect(f.service.upload(f.project.id, "task", "task-1", { ...input, idempotencyKey: "two" }, f.owner).replayed).toBe(false);
    expect(f.service.download(f.project.id, saved.id, f.owner).data).toEqual(data);
  });
  it("reuses an object after a transaction error without committing a premature reference", () => {
    const f = setup(), input = { filename: "proof", mediaType: "text/plain", data: Buffer.from("evidence"), idempotencyKey: "retry" };
    const save = vi.spyOn(f.store, "saveAttachment").mockImplementationOnce(() => { throw new Error("SQL failed"); });
    expect(() => f.service.upload(f.project.id, "task", "task-1", input, f.owner)).toThrow("SQL failed");
    expect(f.store.listAttachments(f.project.id, "task", "task-1", 25, 0).items).toHaveLength(0);
    save.mockRestore();
    const saved = f.service.upload(f.project.id, "task", "task-1", input, f.owner).value;
    expect(f.service.download(f.project.id, saved.id, f.owner).data).toEqual(input.data);
  });

});
