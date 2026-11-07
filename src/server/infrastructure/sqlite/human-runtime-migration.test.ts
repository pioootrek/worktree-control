import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { humanRuntimePermissionsSchema } from "@/shared/contracts/runtime-memberships";
import { applyHumanPrincipalMigration } from "./human-principal-migration";
import { applyGodotWebMigration } from "./godot-web-migration";
import { applyTestRunRequesterMigration } from "./test-run-requester-migration";
import { applyRuntimeMembershipMigration } from "./runtime-membership-migration";
import { humanRuntimeChecksum, humanRuntimeMigration } from "./human-runtime-migration";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { HumanRuntimeQueries } from "./human-runtime-queries";
import { SqliteStateStore } from "./sqlite-state-store";

/** Genuine45 independent of current initialization/rewind, with all original 1..45 checksums. */
function genuine45(db:Database.Database) {
  db.exec(readFileSync(new URL("./fixtures/schema-v41.sql",import.meta.url),"utf8"));db.pragma("foreign_keys=OFF");
  db.transaction(()=>{applyHumanPrincipalMigration(db);applyGodotWebMigration(db);applyTestRunRequesterMigration(db);applyRuntimeMembershipMigration(db);}).immediate();
  db.exec(`INSERT INTO remote_principals VALUES('owner','owner','active'),('human','human','active');
    INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
    VALUES('p','Runtime','/code/runtime',3601,'node','[]','/',45000,'now','now');
    INSERT INTO runtime_human_memberships VALUES('human','p','runtime-project','reader','["projects:read"]',1,'now',NULL);
    INSERT INTO reservations(id,project_id,worktree_path,kind,owner,reason,created_at) VALUES('legacy','p','/code/runtime','human','local-user','old','now');
    UPDATE reservations SET released_at='later' WHERE id='legacy';`);
}
const authority=()=>({principalId:"human",sessionKey:"a".repeat(64),evidenceKey:"b".repeat(64),generation:1,membershipRevision:1,
  permissions:humanRuntimePermissionsSchema.parse(["claims:manage","runtime:control"]),deadline:new Date(Date.now()+3600_000).toISOString()});
const tables=(db:Database.Database,names:string[])=>names.map(t=>db.prepare(`SELECT * FROM ${t}`).all());
describe("human runtime schema46 and durable intents",()=>{
  it("upgrades genuine45, preserving old membership/reservation/identity and every old checksum, with atomic rollback",()=>{
    const db=new Database(":memory:");try{
      genuine45(db);expect(inspectSchema(db).version).toBe(45);
      const names=["remote_principals","principal_credentials","runtime_human_memberships","reservations","knowledge_history","runtime_credential_scopes","test_run_requesters"],before=tables(db,names),registry=tables(db,["schema_migrations"]);
      expect(()=>initializeSchema(db,false,()=>{throw new Error("rollback46");})).toThrow("rollback46");
      expect(inspectSchema(db).version).toBe(45);expect(tables(db,names)).toEqual(before);
      initializeSchema(db,false,inspectSchema);expect(inspectSchema(db).version).toBe(48);
      expect(tables(db,names.filter(t=>t!=="reservations"))).toEqual(before.filter((_,i)=>i!==3));
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=45").all()).toEqual(registry[0]);
      expect(db.prepare("SELECT role,permissions_json FROM runtime_human_memberships").all()).toEqual([{role:"reader",permissions_json:'["projects:read"]'}]);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=46").get()).toEqual({name:humanRuntimeMigration.name,checksum:humanRuntimeChecksum});
      expect(db.prepare("SELECT provider_bound FROM reservations").get()).toEqual({provider_bound:0});
      expect(tables(db,["human_runtime_leases","human_runtime_intents"])).toEqual([[],[]]);
    }finally{db.close();}
  });
  it("retains unknown and complete intents across physical reopen and backup/restore without minting authority",async()=>{
    const root=mkdtempSync(join(tmpdir(),"human-runtime-reboot-")),path=join(root,"state.sqlite3");
    let store:SqliteStateStore|undefined;
    try {
      const db=new Database(path);genuine45(db);db.close();store=new SqliteStateStore(path);
      const a=authority(),q=store.humanRuntime();
      expect(q.begin(a,"p","interrupted","c".repeat(64))).toBeNull();
      const lease=q.claim(a,{projectId:"p",worktreePath:"/code/runtime",reason:"finite",key:"interrupted",fingerprint:"c".repeat(64),ttlSeconds:60});
      expect(q.begin(a,"p","complete","d".repeat(64))).toBeNull();q.attach(a,"complete",lease.id);q.finish(a,"complete",{operation:"stop",safe:true});
      const expected=q.lease(lease.id);store.close();store=new SqliteStateStore(path);
      expect(store.humanRuntime().lease(lease.id)).toEqual(expected);
      expect(store.humanRuntime().begin(a,"p","interrupted","c".repeat(64))).toMatchObject({state:"pending",result:null,reservationId:lease.id});
      expect(store.humanRuntime().begin(a,"p","complete","d".repeat(64))).toMatchObject({state:"complete",result:{safe:true}});
      expect(()=>store!.humanRuntime().begin(a,"p","complete","e".repeat(64))).toThrowError(expect.objectContaining({code:"idempotency_conflict"}));
      await createControllerBackup(store,join(root,"backup"),{applicationVersion:"test",attachmentDirectory:join(root,"attachments")});
      const restoredPath=join(root,"restored.sqlite3");restoreControllerBackup(join(root,"backup"),restoredPath);
      const restored=new SqliteStateStore(restoredPath);try{
        expect(restored.humanRuntime().lease(lease.id)).toEqual(expected);
        expect(restored.listPrincipalCredentials("human")).toEqual([]);
        expect(restored.runtimeMemberships().getRuntimeMembership("human","p")!.permissions).toEqual(["projects:read"]);
        expect(restored.hasAuthenticationProviderData()).toBe(false);
        await expect(restored.recoverIssuedSessions({sessionRows:4096,sessionReconcileBatch:32})).rejects.toThrow();
      }finally{restored.close();}
    }finally{store?.close();rmSync(root,{recursive:true,force:true});}
  });
  it("bounds intent storage without evicting a live key, and cleans only after original session expiry",()=>{
    const db=new Database(":memory:");try{
      genuine45(db);initializeSchema(db);const q=new HumanRuntimeQueries(db),a=authority();
      for(let i=0;i<128;i++)expect(q.begin(a,"p",String(i),"c".repeat(64))).toBeNull();
      expect(()=>q.begin(a,"p","overflow","c".repeat(64))).toThrowError(expect.objectContaining({code:"capacity"}));
      expect(q.begin(a,"p","0","c".repeat(64))).toMatchObject({state:"pending"});
      expect(()=>q.begin(a,"p","0","d".repeat(64))).toThrowError(expect.objectContaining({code:"idempotency_conflict"}));
      db.exec("UPDATE human_runtime_intents SET retain_until='1970-01-01T00:00:00.000Z'");
      expect(q.begin({...a,sessionKey:"f".repeat(64)},"p","new-session","c".repeat(64))).toBeNull();
      expect(db.prepare("SELECT count(*) n FROM human_runtime_intents").get()).toEqual({n:1});
    }finally{db.close();}
  });
  it.each(["checksum","premature","permissions","marker"])("refuses %s corruption before changing the source",mode=>{
    const root=mkdtempSync(join(tmpdir(),"human-runtime-corrupt-")),path=join(root,"state.sqlite3");
    try{
      const db=new Database(path);genuine45(db);initializeSchema(db);
      if(mode==="checksum")db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=46");
      if(mode==="premature")db.exec("DELETE FROM schema_migrations WHERE version=46");
      if(mode==="permissions")db.exec(`UPDATE runtime_human_memberships SET role='operator',permissions_json='["env:use"]'`);
      if(mode==="marker")db.exec("UPDATE reservations SET provider_bound=1");
      db.close();const before=readFileSync(path);expect(()=>new SqliteStateStore(path)).toThrow(/schema|invariant/);expect(readFileSync(path)).toEqual(before);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
