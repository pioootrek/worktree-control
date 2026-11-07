import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { resumeFixtureSecurity } from "./fixtures/protected-security";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { TestRun } from "@/shared/contracts";
import type { HumanTestRunRequester } from "@/server/state-store";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { IdentityService } from "@/server/modules/identity";
import { applyHumanPrincipalMigration } from "./human-principal-migration";
import { applyGodotWebMigration } from "./godot-web-migration";
import { applyTestRunRequesterMigration } from "./test-run-requester-migration";
import { applyRuntimeMembershipMigration } from "./runtime-membership-migration";
import { applyHumanRuntimeMigration } from "./human-runtime-migration";
import { humanTestRunChecksum, humanTestRunMigration } from "./human-test-run-migration";
import { initializeSchema } from "./migrations";
import { inspectSchema } from "./schema-inspection";
import { SqliteStateStore } from "./sqlite-state-store";

function genuine46(db:Database.Database) {
  db.exec(readFileSync(new URL("./fixtures/schema-v41.sql",import.meta.url),"utf8"));db.pragma("foreign_keys=OFF");
  db.transaction(()=>{applyHumanPrincipalMigration(db);applyGodotWebMigration(db);applyTestRunRequesterMigration(db);applyRuntimeMembershipMigration(db);applyHumanRuntimeMigration(db);}).immediate();
  db.exec(`INSERT INTO remote_principals VALUES('human','human','active');
    INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
    VALUES('p','Runtime','/code/runtime',3601,'node','[]','/',45000,'now','now');
    INSERT INTO runtime_human_memberships VALUES('human','p','runtime-project','operator','["claims:manage"]',1,'now',NULL);`);
}
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"human-job-store-")),path=join(root,"state.sqlite3");const store=new SqliteStateStore(path);
  store.humanAccounts().createHumanPrincipal({id:"human",kind:"human",status:"active"},"local-cli");
  const p=store.addProject({name:"P",repositoryPath:root,port:3700,executable:"node",args:[]});
  const run:TestRun={id:randomUUID(),projectId:p.id,worktreePath:root,worktreeHead:"a",worktreeBranch:"main",worktreeDirty:false,presetId:"node:test",presetName:"test",adapter:"node",actor:"human:test:human",phase:"queued",queuePosition:null,
    executable:"node",args:[],cwd:root,queuedAt:new Date().toISOString(),startedAt:null,finishedAt:null,exitCode:null,signal:null,error:null,logs:[],environmentMode:"clean",environmentProfile:"unit",inheritedServerProfile:null,environmentVariableNames:[],source:legacySourceEvidence()};
  const authority={principalId:"human",sessionKey:"a".repeat(64),evidenceKey:"b".repeat(64),generation:1,deadline:new Date(Date.now()+3600000).toISOString(),membershipRevision:1,permissions:["tests:run" as const]};
  const requester:HumanTestRunRequester={kind:"human",projectId:p.id,sessionOwner:run.actor,authority,reference:{principalId:authority.principalId,sessionKey:authority.sessionKey,evidenceKey:authority.evidenceKey,generation:authority.generation,deadline:authority.deadline,nativeSessionId:"native-nonsecret-reference"},reservationId:null,fingerprint:"c".repeat(64)};
  return {root,path,store,run,requester,remove:()=>rmSync(root,{recursive:true,force:true})};
}
describe("human test attribution schema47",()=>{
  it("upgrades genuine46 atomically without changing SQL/checksums1..46 or backfilling jobs/rights",()=>{
    const db=unmanagedFixtureDatabase(":memory:");try{
      genuine46(db);expect(inspectSchema(db).version).toBe(46);
      const tables=["schema_migrations","remote_principals","principal_credentials","runtime_human_memberships","reservations","knowledge_history","runtime_credential_scopes","test_run_requesters"];
      const before=tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all());
      expect(()=>initializeSchema(db,false,()=>{throw new Error("rollback47");})).toThrow("rollback47");expect(inspectSchema(db).version).toBe(46);expect(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
      initializeSchema(db,false,inspectSchema);expect(inspectSchema(db).version).toBe(49);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version<=46").all()).toEqual(before[0]);
      expect(tables.slice(1).map(t=>db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before.slice(1));
      expect(db.prepare("SELECT * FROM human_test_run_requesters").all()).toEqual([]);
      expect(db.prepare("SELECT name,checksum FROM schema_migrations WHERE version=47").get()).toEqual({name:humanTestRunMigration.name,checksum:humanTestRunChecksum});
      db.prepare("UPDATE runtime_human_memberships SET permissions_json=?").run('["tests:run","claims:manage","runtime:control","projects:read"]');
      expect(db.prepare("SELECT revision FROM runtime_human_memberships").get()).toEqual({revision:1});
    }finally{db.close();}
  });
  it("writes marker/run/requester/summary atomically and refuses requester replacement while ordinary checkpoints preserve attribution",()=>{
    const f=fixture();try{
      const bad={...f.requester,sessionOwner:"human:test:missing",authority:{...f.requester.authority,principalId:"missing"},reference:{...f.requester.reference,principalId:"missing"}};
      expect(()=>f.store.saveTestRun({...f.run,actor:bad.sessionOwner},"key",bad)).toThrow();expect(f.store.getTestRun(f.run.id)).toBeNull();expect(f.store.getTestSummary(f.run.projectId,f.run.id)).toBeNull();
      f.store.saveTestRun(f.run,"key",f.requester);
      expect(()=>f.store.saveTestRun({...f.run,exitCode:42},"key",{...f.requester,reservationId:randomUUID()})).toThrow(/immutable/);
      expect(f.store.getTestRun(f.run.id)?.exitCode).toBeNull();
      f.store.saveTestRun({...f.run,phase:"passed",exitCode:0});expect(f.store.getHumanTestRunRequester(f.run.id)).toEqual(f.requester);expect(f.store.getTestRunRequester(f.run.id)).toBeNull();
      expect(f.store.findTestRunByIdempotency(f.run.actor,"key")?.id).toBe(f.run.id);
    }finally{f.store.close();f.remove();}
  });
  it("retains typed nonsecret attribution through backup/restore/reopen, without granting provider authority",async()=>{
    const f=fixture();try{
      f.store.saveTestRun(f.run,"key",f.requester);const backup=join(f.root,"backup");await createControllerBackup(f.store,backup,{applicationVersion:"test",attachmentDirectory:join(f.root,"attachments")});f.store.close();
      const path=join(f.root,"restored.sqlite3");restoreControllerBackup(backup,path);resumeFixtureSecurity(path);const store=new SqliteStateStore(path);try{
        expect(store.getHumanTestRunRequester(f.run.id)).toEqual(f.requester);expect(store.schemaVersion()).toBe(49);
        const identity=new IdentityService(store,undefined,undefined,undefined,undefined,store,undefined,store.runtimeMemberships());
        expect(()=>identity.validateHumanVerificationAuthority(f.requester.authority,f.requester.reference,f.run.projectId)).toThrow();
      }finally{store.close();}
    }finally{f.store.close();f.remove();}
  });
  it.each(["missing","corrupt","marker","checksum","premature"])("refuses %s attribution on current lookup and/or reopen without rewriting data",mode=>{
    const f=fixture();try{
      f.store.saveTestRun(f.run,"key",f.requester);f.store.close();const db=unmanagedFixtureDatabase(f.path);
      if(mode==="missing")db.exec("DELETE FROM human_test_run_requesters");
      if(mode==="corrupt")db.exec("UPDATE human_test_run_requesters SET reference_json='{}'");
      if(mode==="marker")db.exec("UPDATE test_runs SET provider_bound=0");
      if(mode==="checksum")db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=47");
      if(mode==="premature")db.exec("DELETE FROM schema_migrations WHERE version=47");db.close();
      const before=readFileSync(f.path);expect(()=>new SqliteStateStore(f.path)).toThrow(/schema|human test attribution/);expect(readFileSync(f.path)).toEqual(before);
    }finally{f.store.close();f.remove();}
  });
});
