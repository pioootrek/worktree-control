import { openRemoteRecoveryInspection } from "./remote-connection-inspection";
import { unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { resolveAppPaths } from "../../paths";
import { maintainSecurityFence } from "../../bootstrap/security-maintenance";
import { SecurityFence, securityFenceRoot } from "./security-fence";
import * as validation from "./database-validation";
import { AuthenticationService } from "../../modules/authentication";
import { IdentityService } from "../../modules/identity";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { securityTriggers } from "./security-fence-migration";
import { inspectSchema } from "./schema-inspection";
import { applyRegistryMigration } from "./migration-registry";
import { maintainSqliteSecurityFence } from "./security-maintenance";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";

vi.mock("node:fs", async original=>({...await original<typeof import("node:fs")>()}));
vi.mock("./database-validation", async original=>({...await original<typeof import("./database-validation")>()}));
const roots:string[]=[];
afterEach(()=>{ vi.restoreAllMocks(); for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture() {
  const root=mkdtempSync(join(tmpdir(),"security-fence-")); roots.push(root);
  const paths=resolveAppPaths(join(root,"data"));
  const store=new SqliteStateStore(paths.databasePath), auth=new AuthenticationService(store);
  const token=auth.generateToken("local-cli").token;
  return {root,paths,store,token};
}
const witness=(path:string)=>join(securityFenceRoot(path),"witness.json");
const inspect=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSecurityFence(paths,{action:"inspect"});
const resume=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSecurityFence(paths,{action:"resume",expect:inspect(paths).preflight,mode:"token"});
const sql=async(store:SqliteStateStore,source:string)=>{const s=store.authenticationProviderStorage(); await s.borrow(async()=>{const c=s.createProviderConnection();try{c.prepare(source).run([]);}finally{c.close();}});};
const DEADLINE="2026-12-01T00:00:00.000Z";
/** Authority the quarantine acts on, valid from schema 40 on; issuance exists from 41. */
const authority=(issuance:boolean)=>`INSERT INTO remote_principals VALUES('owner','owner','active');
  INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at) VALUES('owner-credential','owner','owner_session','fixture','fixture','${"a".repeat(64)}','active','2026-11-01T00:00:00.000Z');
  INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES('subject','Owner','owner@fixture.invalid',0,'now','now',1);
  INSERT INTO authentication_ba_account(id,accountId,providerId,userId,password,accessToken,createdAt,updatedAt) VALUES('account','subject','credential','subject','hash','access','now','now');
  INSERT INTO authentication_provider_subjects(provider_id,subject,principal_id,status,linked_at,revoked_at) VALUES('better-auth','subject','owner','active','2026-11-01T00:00:00.000Z',NULL);
  INSERT INTO authentication_account_policies VALUES('better-auth','subject',1,1,1,1,'2026-11-01T00:00:00.000Z');
  INSERT INTO authentication_ba_two_factor(id,secret,backupCodes,userId,verified) VALUES('factor','ciphertext','codes','subject',1);
  INSERT INTO authentication_ba_passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES('passkey','key','subject','credential-id',0,'singleDevice',0);
  INSERT INTO authentication_passkey_trust(credential_id,native_id,provider_id,subject,handle,fingerprint,verified_uv,trusted_at) VALUES('credential-id','passkey','better-auth','subject','handle','fingerprint',1,'2026-11-01T00:00:00.000Z');
  INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session','${DEADLINE}','token-session','now','now','subject');
  INSERT INTO authentication_session_evidence(session_id,provider_id,subject,method,authenticated_at,original_deadline,generation,policy_revision,credential,credential_binding,attempt_id) VALUES('session','better-auth','subject','password','2026-11-01T00:00:00.000Z','${DEADLINE}',1,1,NULL,NULL,'attempt-session');
  ${issuance?`INSERT INTO authentication_session_issuance(session_id,state,original_deadline) VALUES('session','may_publish','${DEADLINE}');`:""}
  INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES('project','Project','/code/project',3214,'pnpm','["run","dev"]','/',45000,'now','now');
  INSERT INTO reservations(id,project_id,worktree_path,kind,owner,created_at) VALUES('lease','project','/code/project','human','fixture','2026-11-01T00:00:00.000Z');`;
/** A genuine schema40 installation with authority and no external marker. */
function genuine40() {
  const root=mkdtempSync(join(tmpdir(),"security-resume-40-"));roots.push(root);
  const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
  const db=unmanagedFixtureDatabase(paths.databasePath);
  try{db.exec(readFileSync(new URL("./fixtures/schema-v40.sql",import.meta.url),"utf8"));db.exec(authority(false));}finally{db.close();}
  chmodSync(paths.databasePath,0o600);return paths;
}
/** A current-schema store whose authority was written outside its owner, so it needs resume. */
function current49() {
  const f=fixture();f.store.close();
  const db=unmanagedFixtureDatabase(f.paths.databasePath);try{db.exec(authority(true));}finally{db.close();}
  return f.paths;
}
const read=<T,>(paths:ReturnType<typeof resolveAppPaths>,operation:(db:Database.Database)=>T)=>{const db=unmanagedFixtureDatabase(paths.databasePath,{readonly:true});try{return operation(db);}finally{db.close();}};
const all=(db:Database.Database)=>({catalogue:db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
  rows:Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{name:string}>).map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))});
const has=(db:Database.Database,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
/** Every observable quarantine effect, without timestamps, receipts and counters. */
const quarantine=(db:Database.Database)=>({
  version:db.prepare("SELECT max(version) FROM schema_migrations").pluck().get(),
  credentials:db.prepare("SELECT id,status,revoked_at IS NOT NULL AS revoked FROM principal_credentials ORDER BY id").all(),
  principals:db.prepare("SELECT * FROM remote_principals ORDER BY id").all(),
  accounts:db.prepare("SELECT password,accessToken,refreshToken,idToken FROM authentication_ba_account").all(),
  users:db.prepare("SELECT id,twoFactorEnabled FROM authentication_ba_user").all(),
  removed:["authentication_ba_session","authentication_session_evidence","authentication_session_issuance","authentication_ba_two_factor","authentication_ba_passkey","authentication_passkey_trust","authentication_ba_verification"]
    .map(name=>has(db,name)?db.prepare(`SELECT count(*) FROM "${name}"`).pluck().get():"absent"),
  policies:db.prepare("SELECT subject,totp_selected,passkey_selected FROM authentication_account_policies").all(),
  leases:db.prepare("SELECT id,released_at IS NOT NULL AS released FROM reservations").all(),
  authentication:(({mode,token}:{mode:string;token:unknown})=>({mode,token}))(JSON.parse(db.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").pluck().get() as string)),
});
const counters=(db:Database.Database)=>({
  generation:JSON.parse(db.prepare("SELECT value_json FROM controller_settings WHERE key='authentication'").pluck().get() as string).generation as number,
  policy:db.prepare("SELECT generation FROM authentication_account_policies").pluck().get() as number,
  events:db.prepare("SELECT count(*) FROM controller_audit_events WHERE event_type='authentication.security_quarantined'").pluck().get() as number,
});
const witnessState=(paths:ReturnType<typeof resolveAppPaths>)=>JSON.parse(readFileSync(witness(paths.databasePath),"utf8")).payload.state;
/** Faults inside (before commit) and after the one schema+quarantine transaction. */
function injectResumeFault(stage:string,paths:ReturnType<typeof resolveAppPaths>) {
  const status=maintainSecurityFence(paths,{action:"inspect"});
  let injected=false;const fault=()=>{injected=true;return new Error(`fixture ${stage} fault`);};
  if(stage==="quarantine"){const prepare=Database.prototype.prepare;vi.spyOn(Database.prototype,"prepare").mockImplementation(function(this:Database.Database,source:string){
    if(source.startsWith("INSERT INTO controller_audit_events") && source.includes("'authentication.security_quarantined'"))throw fault();return prepare.call(this,source);} as typeof prepare);}
  if(stage==="validation"){const validate=validation.validateDatabase;vi.spyOn(validation,"validateDatabase").mockImplementation((database,version)=>{
    validate(database,version);if(version===49 && database.inTransaction)throw fault();});}
  if(stage==="post-commit"){const pragma=Database.prototype.pragma;vi.spyOn(Database.prototype,"pragma").mockImplementation(function(this:Database.Database,source,options){
    const result=pragma.call(this,source,options);
    // initializeSchema's finally fails AFTER the one transaction committed the quarantine.
    if(source==="foreign_keys = ON" && !this.inTransaction && this.prepare("SELECT 1 FROM controller_audit_events WHERE event_type='authentication.security_quarantined'").get())throw fault();
    return result;});}
  if(stage==="confirmed-receipt"){const receipt=SecurityFence.maintenanceReceipt;vi.spyOn(SecurityFence,"maintenanceReceipt").mockImplementation((...args)=>{if(args[3]==="confirmed")throw fault();receipt(...args);});}
  const run=()=>maintainSqliteSecurityFence(paths,{action:"resume",expect:status.preflight,mode:"token"},{
    preflight:database=>{preflightSecurityRecoveryHandoff(database);},
    acknowledge:database=>{if(stage==="handoff")throw fault();acknowledgeRecoveredBackupHandoff(database);},
  });
  return {run,injected:()=>injected};
}

describe("external security checkpoint",()=>{
  it.each(["migration-rollback", "migration-return", "durability", "validation", "receipt"] as const)("reports durable establishment changes at %s and keeps recovery fenced",stage=>{
    const root=mkdtempSync(join(tmpdir(),"security-establish-fault-"));roots.push(root);
    const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
    const db=unmanagedFixtureDatabase(paths.databasePath);
    // Frozen schema26 plus the unchanged index (27) and provenance registry (28).
    db.exec(readFileSync(new URL("./fixtures/schema-v26.sql",import.meta.url),"utf8"));
    db.exec(`CREATE INDEX IF NOT EXISTS knowledge_import_sources_target ON knowledge_import_sources(project_id,target_kind,target_id);
      INSERT INTO schema_migrations(version,applied_at) VALUES(27,'2026-11-01T00:00:00.000Z')`);
    applyRegistryMigration(db);
    // Seed historical authority directly, without opening/migrating the old database.
    db.exec("INSERT INTO remote_principals VALUES('historical-owner','owner','active')");
    db.prepare(`INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at)
      VALUES('historical-credential','historical-owner','owner_session','fixture','fixture',?,'active','2026-11-01T00:00:00.000Z')`).run("a".repeat(64));
    const before=db.prepare("SELECT * FROM schema_migrations").all();db.close();chmodSync(paths.databasePath,0o600);
    const status=inspect(paths);let injected=false;
    const validate=validation.validateDatabase;
    vi.spyOn(validation,"validateDatabase").mockImplementation((database,version)=>{
      validate(database,version);
      if(version===49 && ((stage==="migration-rollback" && database.inTransaction) || (stage==="validation" && !database.inTransaction))){injected=true;throw new Error("fixture validation fault");}
    });
    const durability=validation.assertDurability;
    vi.spyOn(validation,"assertDurability").mockImplementation(database=>{
      durability(database);
      if(stage==="durability" && (database.prepare("SELECT max(version) version FROM schema_migrations").get() as {version:number}).version===49){injected=true;throw new Error("fixture durability fault");}
    });
    const pragma=Database.prototype.pragma;
    vi.spyOn(Database.prototype,"pragma").mockImplementation(function(this:Database.Database,source,options){
      const result=pragma.call(this,source,options);
      // initializeSchema's finally can fail AFTER the outer transaction committed.
      if(stage==="migration-return" && source==="foreign_keys = ON" && !this.inTransaction
        && (this.prepare("SELECT max(version) version FROM schema_migrations").get() as {version:number}).version===49){injected=true;throw new Error("fixture post-commit pragma fault");}
      return result;
    });
    if(stage==="receipt")vi.spyOn(SecurityFence,"maintenanceReceipt").mockImplementation(()=>{injected=true;throw new Error("fixture receipt fault");});
    expect(()=>maintainSecurityFence(paths,{action:"establish",expect:status.preflight})).toThrowError(expect.objectContaining({code:"security_fence_pending",committed:stage!=="migration-rollback"}));
    expect(injected).toBe(true);vi.restoreAllMocks();
    const after=unmanagedFixtureDatabase(paths.databasePath,{readonly:true});
    try{
      expect(inspectSchema(after).version).toBe(stage==="migration-rollback"?28:49);
      expect(after.prepare("SELECT * FROM schema_migrations WHERE version<=28").all()).toEqual(before);
      expect(after.prepare("SELECT status FROM principal_credentials WHERE id='historical-credential'").get()).toEqual({status:"active"});
    }finally{after.close();}
    expect(JSON.parse(readFileSync(witness(paths.databasePath),"utf8")).payload.state).toBe("pending");
    expect(inspect(paths)).toMatchObject({trusted:false,establishmentAllowed:false});
    expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/security_fence_recovery_required/);
    expect(()=>maintainSecurityFence(paths,{action:"establish",expect:inspect(paths).preflight})).toThrow(/security_fence_recovery_required/);
    expect(resume(paths)).toMatchObject({trusted:true,quarantined:true});
    const recovered=new SqliteStateStore(paths.databasePath);
    try{
      expect(recovered.getPrincipal("historical-owner")).toEqual({id:"historical-owner",kind:"owner",status:"active"});
      const raw=unmanagedFixtureDatabase(paths.databasePath,{readonly:true});
      try{expect(raw.prepare("SELECT status FROM principal_credentials WHERE id='historical-credential'").get()).toEqual({status:"revoked"});}finally{raw.close();}
    }finally{recovered.close();}
  });

  it("makes bounded recovery progress through more than one batch of abandoned publications",()=>{
    const f=fixture();f.store.close();
    const abandoned=Array.from({length:40},()=>join(securityFenceRoot(f.paths.databasePath),`.journal-${randomUUID()}`));
    for(const path of abandoned)writeFileSync(path,"",{mode:0o600});
    rmSync(witness(f.paths.databasePath));
    expect(()=>resume(f.paths)).toThrow(/security_fence/);
    expect(abandoned.filter(path=>fs.existsSync(path)).length).toBeLessThan(40);
    expect(resume(f.paths).trusted).toBe(true);
    expect(abandoned.some(path=>fs.existsSync(path))).toBe(false);
    const reopened=new SqliteStateStore(f.paths.databasePath);
    try{expect(new AuthenticationService(reopened).verifyInstallationToken(f.token)).toBe(false);}finally{reopened.close();}
  });
  it("refuses an aliased publication remnant without removing its target",()=>{
    const f=fixture();f.store.close();
    const target=join(f.root,"preserve");writeFileSync(target,"preserve",{mode:0o600});
    const alias=join(securityFenceRoot(f.paths.databasePath),`.journal-${randomUUID()}`);symlinkSync(target,alias);
    rmSync(witness(f.paths.databasePath));
    expect(()=>resume(f.paths)).toThrow(/security_fence/);
    expect(readFileSync(target,"utf8")).toBe("preserve");expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
  });
  it.each(["pending-file","pending-directory","confirmed-file","confirmed-directory"])("fails truthfully at %s fsync and never silently resumes uncertainty",stage=>{
    const f=fixture(), before=readFileSync(witness(f.paths.databasePath));
    const sync=fs.fsyncSync, rename=fs.renameSync;let published:string|undefined, failed=false;
    vi.spyOn(fs,"renameSync").mockImplementation((from,to)=>{
      const state=String(to)===witness(f.paths.databasePath)?JSON.parse(readFileSync(String(from),"utf8")).payload.state:undefined;
      rename(from,to);if(state)published=state;
    });
    vi.spyOn(fs,"fsyncSync").mockImplementation(fd=>{
      const target=fs.realpathSync(`/proc/self/fd/${fd}`);
      const [phase,edge]=stage.split("-");
      const matches=edge==="directory" ? target===securityFenceRoot(f.paths.databasePath)&&published===phase
        : target.includes("/.journal-")&&JSON.parse(readFileSync(target,"utf8")).payload.state===phase;
      if(!failed&&matches){failed=true;throw Object.assign(new Error("fixture fsync fault"),{code:"EIO"});}
      sync(fd);
    });
    try{expect(()=>new AuthenticationService(f.store).rotateToken("local-cli")).toThrowError(expect.objectContaining({code:"security_fence_pending",committed:stage.startsWith("confirmed")}));expect(failed).toBe(true);}
    finally{vi.restoreAllMocks();f.store.close();}
    if(stage==="pending-file") {expect(readFileSync(witness(f.paths.databasePath))).toEqual(before);const s=new SqliteStateStore(f.paths.databasePath);try{expect(new AuthenticationService(s).verifyInstallationToken(f.token)).toBe(true);}finally{s.close();}}
    else{expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence/);expect(resume(f.paths).trusted).toBe(true);}
  });
  it("rolls back the entire quarantine on SQL failure and reports no committed authority change",()=>{
    const f=fixture();new IdentityService(f.store).bootstrapOwnerSession();f.store.close();rmSync(witness(f.paths.databasePath));
    const db=unmanagedFixtureDatabase(f.paths.databasePath,{readonly:true});const before=db.prepare("SELECT * FROM principal_credentials").all();db.close();
    const exec=Database.prototype.exec;
    vi.spyOn(Database.prototype,"exec").mockImplementation(function(this:Database.Database,source){
      const result=exec.call(this,source);
      if(source.includes("UPDATE principal_credentials SET status='revoked'"))throw new Error("fixture rollback quarantine");
      return result;
    });
    expect(()=>resume(f.paths)).toThrowError(expect.objectContaining({code:"security_fence_pending",committed:false}));vi.restoreAllMocks();
    const after=unmanagedFixtureDatabase(f.paths.databasePath,{readonly:true});try{expect(after.prepare("SELECT * FROM principal_credentials").all()).toEqual(before);}finally{after.close();}
    expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence/);expect(resume(f.paths).trusted).toBe(true);
  });
  it("resumes a schema40 database with every step and the whole quarantine in one transaction",()=>{
    const paths=genuine40(),twin=genuine40();
    expect(resume(twin)).toMatchObject({trusted:true,quarantined:true});
    const expected=read(twin,quarantine);
    expect(expected).toMatchObject({version:49,credentials:[{id:"owner-credential",status:"revoked",revoked:1}],principals:expect.arrayContaining([{id:"owner",kind:"owner",status:"active"}]),
      accounts:[{password:null,accessToken:null,refreshToken:null,idToken:null}],users:[{id:"subject",twoFactorEnabled:0}],removed:[0,0,0,0,0,0,0],
      policies:[{subject:"subject",totp_selected:0,passkey_selected:0}],leases:[{id:"lease",released:1}],authentication:{mode:"token",token:null}});
    const expectedCounters=read(twin,counters);expect(expectedCounters).toMatchObject({policy:2,events:1});
    const before=read(paths,all),fault=injectResumeFault("quarantine",paths);
    expect(fault.run).toThrowError(expect.objectContaining({code:"security_fence_pending",committed:false}));
    expect(fault.injected()).toBe(true);vi.restoreAllMocks();
    // Neither a schema step nor any quarantine effect committed.
    expect(read(paths,all)).toEqual(before);
    read(paths,db=>{expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(40);
      expect(has(db,"authentication_session_issuance")).toBe(false);expect(has(db,"security_checkpoint")).toBe(false);});
    expect(witnessState(paths)).toBe("pending");
    expect(inspect(paths)).toMatchObject({trusted:false,establishmentAllowed:false});
    expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/security_fence_recovery_required/);
    expect(resume(paths)).toMatchObject({trusted:true,quarantined:true});
    expect(read(paths,quarantine)).toEqual(expected);expect(read(paths,counters)).toEqual(expectedCounters);
    new SqliteStateStore(paths.databasePath).close();
  });
  it.each([["quarantine",false],["validation",false],["post-commit",true],["handoff",true],["confirmed-receipt",true]] as const)
  ("reports a resume fault at %s on a current-schema database as committed=%s and recovers to the same quarantine",(stage,committed)=>{
    const paths=current49(),twin=current49();resume(twin);
    const expected=read(twin,quarantine),initial=read(paths,counters),before=read(paths,quarantine);
    expect(initial.events).toBe(0);expect(before.credentials).toEqual([{id:"owner-credential",status:"active",revoked:0}]);
    const fault=injectResumeFault(stage,paths);
    expect(fault.run).toThrowError(expect.objectContaining({code:"security_fence_pending",committed}));
    expect(fault.injected()).toBe(true);vi.restoreAllMocks();
    // At the current version only the quarantine itself can prove the commit.
    expect(read(paths,quarantine)).toEqual(committed?expected:before);
    expect(read(paths,counters)).toEqual(committed?{generation:initial.generation+1,policy:initial.policy+1,events:1}:initial);
    expect(witnessState(paths)).toBe("pending");
    expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/security_fence/);
    expect(resume(paths)).toMatchObject({trusted:true,quarantined:true});
    expect(read(paths,quarantine)).toEqual(expected);
    const runs=committed?2:1;
    expect(read(paths,counters)).toEqual({generation:initial.generation+runs,policy:initial.policy+runs,events:runs});
    const reopened=new SqliteStateStore(paths.databasePath);try{expect(reopened.getAuthenticationPolicy().mode).toBe("token");}finally{reopened.close();}
  });
  it("denies original authority after an idle wait before any external effect",async()=>{
    const f=fixture();let release!:()=>void,waiting!:()=>void,effects=0;
    const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{waiting=resolve;});
    const pending=f.store.admission.run(async()=>{expect(new AuthenticationService(f.store).verifyInstallationToken(f.token)).toBe(true);await f.store.admission.idle(async()=>{waiting();await gate;});new AuthenticationService(f.store).verifyInstallationToken(f.token);effects++;});
    await entered;rmSync(witness(f.paths.databasePath));release();
    try{await expect(pending).rejects.toMatchObject({code:"security_fence_recovery_required"});expect(effects).toBe(0);}finally{f.store.close();}
  });
  it("preserves current token, mode and identity on clean restarts without rotating authority",()=>{
    const f=fixture(), id=new IdentityService(f.store,undefined,()=>"69849424-2aba-4fdd-b4fa-a394a77a193c").bootstrapOwnerSession().principalId;
    expect(id).toBe("69849424-2aba-4fdd-b4fa-a394a77a193c");
    const before=readFileSync(witness(f.paths.databasePath),"utf8");f.store.close();
    const reopened=new SqliteStateStore(f.paths.databasePath);
    try { expect(new AuthenticationService(reopened).verifyInstallationToken(f.token)).toBe(true);expect(reopened.getPrincipal(id)?.kind).toBe("owner"); }
    finally { reopened.close(); }
    expect(readFileSync(witness(f.paths.databasePath),"utf8")).toBe(before);
  });
  it("fences credential-based remote recovery inspection before authentication and on retained reads",async()=>{
    const f=fixture(),issued=new IdentityService(f.store).bootstrapOwnerSession(),snapshot=join(f.root,"old.sqlite3");
    await f.store.backup(snapshot);f.store.close();
    const inspection=openRemoteRecoveryInspection(f.paths.databasePath);
    const actor=inspection.identity.authenticateBearer(issued.token);
    rmSync(witness(f.paths.databasePath));
    try{expect(()=>inspection.identity.describeIdentity(actor)).toThrow(/security_fence/);}finally{inspection.close();}
    expect(()=>openRemoteRecoveryInspection(f.paths.databasePath)).toThrow(/security_fence/);
    resume(f.paths);copyFileSync(snapshot,f.paths.databasePath);
    expect(()=>openRemoteRecoveryInspection(f.paths.databasePath)).toThrow(/security_fence/);
  });
  it("accounts for SQLite cache spills and preparation inside owned transactions",()=>{
    const f=fixture(),database=(f.store as unknown as {database:Database.Database}).database;
    try{
      database.pragma("cache_size=2");
      database.transaction(()=>{for(let n=0;n<80;n++){
        database.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('spill','fixture',?,?)").run(JSON.stringify({value:"x".repeat(8192)}),new Date().toISOString());
        expect(new AuthenticationService(f.store).verifyInstallationToken(f.token)).toBe(true);
        const cursor=database.prepare("SELECT id FROM controller_audit_events LIMIT 2").iterate();
        expect(cursor.next().done).toBe(false);cursor.return?.();
      }})();
      expect(new AuthenticationService(f.store).verifyInstallationToken(f.token)).toBe(true);
    }finally{f.store.close();}
  });
  it.each(["database","wal"])("refuses live in-place %s rollback before an admitted effect",async kind=>{
    const f=fixture(),snapshot=join(f.root,"live-snapshot.sqlite3");await f.store.backup(snapshot);
    const oldWal=readFileSync(`${f.paths.databasePath}-wal`);
    new AuthenticationService(f.store).rotateToken("local-cli");
    const database=(f.store as unknown as {database:Database.Database}).database;
    if(kind==="database")database.pragma("wal_checkpoint(TRUNCATE)");
    f.store.getAuthenticationPolicy(); // Prime SQLite's checkpoint cache.
    const path=kind==="database"?f.paths.databasePath:`${f.paths.databasePath}-wal`,current=readFileSync(path);
    let effects=0;
    try{
      writeFileSync(path,kind==="database"?readFileSync(snapshot):oldWal);
      await expect(f.store.admission.run(async()=>{effects++;})).rejects.toMatchObject({code:"security_fence_recovery_required"});
      expect(effects).toBe(0);
    }finally{writeFileSync(path,current);f.store.close();}
  });
  it("preserves active open mode through an ordinary confirmed restart",()=>{
    const f=fixture();new AuthenticationService(f.store).setMode("open","local-cli");f.store.close();
    const current=new SqliteStateStore(f.paths.databasePath);
    try{expect(new AuthenticationService(current).anonymousInstallation()).not.toBeNull();expect(current.getAuthenticationPolicy().mode).toBe("open");}finally{current.close();}
  });
  it("confirms a proved forced provider rollback without revoking current rights",async()=>{
    const f=fixture(),storage=f.store.authenticationProviderStorage();
    await expect(storage.borrow(async()=>{
      const connection=storage.createProviderConnection();connection.prepare("BEGIN IMMEDIATE").run([]);
      connection.prepare("INSERT INTO remote_principals VALUES('rolled-back','agent','active')").run([]);
      throw new Error("leave transaction");
    })).rejects.toBeDefined();
    f.store.close();const current=new SqliteStateStore(f.paths.databasePath);
    try{expect(current.getPrincipal("rolled-back")).toBeNull();expect(new AuthenticationService(current).verifyInstallationToken(f.token)).toBe(true);}finally{current.close();}
  });
  it("refuses raw inode replacement even when the checkpoint still matches",async()=>{
    const f=fixture(),snapshot=join(f.root,"identical.sqlite3");await f.store.backup(snapshot);f.store.close();
    const prior=fs.statSync(f.paths.databasePath).ino;
    fs.renameSync(f.paths.databasePath,join(f.root,"previous.sqlite3"));copyFileSync(snapshot,f.paths.databasePath);chmodSync(f.paths.databasePath,0o600);
    expect(fs.statSync(f.paths.databasePath).ino).not.toBe(prior);
    expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence_recovery_required/);
    expect(resume(f.paths)).toMatchObject({trusted:true,quarantined:true});
  });
  it.each(["mode","credential","account","grant","native-password","native-session","native-factor"])("detects raw snapshot rollback after %s mutation and quarantines before resuming",async kind=>{
    const f=fixture(), identity=new IdentityService(f.store), owner=identity.bootstrapOwnerSession();
    const s=f.store.authenticationProviderStorage();
    await sql(f.store,`INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('subject','Owner','a@fixture.invalid',0,0,0)`);
    await sql(f.store,`INSERT INTO authentication_provider_subjects VALUES('better-auth','subject','${owner.principalId}','active','2026-11-07T00:00:00.000Z',NULL)`);
    await sql(f.store,`INSERT INTO authentication_ba_account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('a','subject','credential','subject','old',0,0)`);
    await sql(f.store,`INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('s',9999999999999,'old',0,0,'subject')`);
    await sql(f.store,`INSERT INTO authentication_ba_two_factor(id,secret,backupCodes,userId) VALUES('f','old','old','subject')`);
    const snapshot=join(f.root,"snapshot.sqlite3");await f.store.backup(snapshot);
    if(kind==="mode")new AuthenticationService(f.store).setMode("open","local-cli");
    if(kind==="credential")f.store.revokeCredential(owner.credential.id,new Date().toISOString(),"local-cli");
    if(kind==="account")await sql(f.store,`UPDATE remote_principals SET status='revoked' WHERE id='${owner.principalId}'`);
    if(kind==="grant")await sql(f.store,`UPDATE authentication_provider_subjects SET status='revoked',revoked_at='2026-11-07T01:00:00.000Z'`);
    if(kind==="native-password")await sql(f.store,`UPDATE authentication_ba_account SET password='new'`);
    if(kind==="native-session")await sql(f.store,`DELETE FROM authentication_ba_session`);
    if(kind==="native-factor")await sql(f.store,`DELETE FROM authentication_ba_two_factor`);
    expect(s.available()).toBe(true);f.store.close();copyFileSync(snapshot,f.paths.databasePath);
    expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence_recovery_required/);
    expect(resume(f.paths)).toMatchObject({trusted:true,quarantined:true});
    const restored=new SqliteStateStore(f.paths.databasePath);
    try {
      expect(new AuthenticationService(restored).verifyInstallationToken(f.token)).toBe(false);
      expect(()=>new IdentityService(restored).authenticateBearer(owner.token)).toThrow();
      expect(restored.getPrincipal(owner.principalId)).toEqual({id:owner.principalId,kind:"owner",status:"active"});
      const db=unmanagedFixtureDatabase(f.paths.databasePath,{readonly:true});try {
        expect(db.prepare("SELECT password FROM authentication_ba_account").get()).toEqual({password:null});
        expect(db.prepare("SELECT count(*) n FROM authentication_ba_session").get()).toEqual({n:0});
        expect(db.prepare("SELECT count(*) n FROM authentication_ba_two_factor").get()).toEqual({n:0});
      }finally{db.close();}
    }finally{restored.close();}
    expect(resume(f.paths)).toMatchObject({trusted:true,changed:false});
    // The same snapshot cannot replay even after a successful resume receipt.
    copyFileSync(snapshot,f.paths.databasePath);expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence/);
  });
  it.each(["missing","corrupt","empty","stale","wrong-installation","pending","symlink","hardlink","permissions"])("refuses %s witness without auto-adoption",kind=>{
    const f=fixture(), old=readFileSync(witness(f.paths.databasePath));
    new AuthenticationService(f.store).rotateToken("local-cli");f.store.close();
    const path=witness(f.paths.databasePath);
    if(kind==="missing")rmSync(path);
    if(kind==="corrupt")writeFileSync(path,"{bad");
    if(kind==="empty")writeFileSync(path,"");
    if(kind==="stale")writeFileSync(path,old);
    if(kind==="wrong-installation"){const other=fixture();other.store.close();copyFileSync(witness(other.paths.databasePath),path);}
    if(kind==="pending"){const r=JSON.parse(readFileSync(path,"utf8"));r.payload.state="pending";r.sha256=createHash("sha256").update(JSON.stringify(r.payload)).digest("hex");writeFileSync(path,JSON.stringify(r));}
    if(kind==="permissions")chmodSync(path,0o644);
    if(kind==="symlink"||kind==="hardlink"){const target=join(f.root,"alias");copyFileSync(path,target);rmSync(path);if(kind==="symlink")symlinkSync(target,path);else linkSync(target,path);}
    expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence/);
    expect(inspect(f.paths).trusted).toBe(false);
    expect(()=>maintainSecurityFence(f.paths,{action:"establish",expect:inspect(f.paths).preflight})).toThrow(/security_fence/);
    if(["missing","corrupt","empty","stale","wrong-installation","pending"].includes(kind))expect(resume(f.paths).trusted).toBe(true);
  });
  it("checks active open authority and live queries after external loss",()=>{
    const f=fixture();new AuthenticationService(f.store).setMode("open","local-cli");const a=new AuthenticationService(f.store);
    rmSync(witness(f.paths.databasePath));
    try{expect(()=>a.anonymousInstallation()).toThrow(/security_fence/);expect(()=>f.store.listProjects()).toThrow(/security_fence/);}finally{f.store.close();}
  });
  it("requires explicit preflight for a genuine older schema and preserves migration1..48",()=>{
    const root=mkdtempSync(join(tmpdir(),"security-older-"));roots.push(root);const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
    const db=unmanagedFixtureDatabase(paths.databasePath);db.exec(readFileSync(new URL("./fixtures/schema-v40.sql",import.meta.url),"utf8"));const before=db.prepare("SELECT * FROM schema_migrations").all();db.close();chmodSync(paths.databasePath,0o600);
    const bytes=readFileSync(paths.databasePath);expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/security_fence_establishment_required/);expect(readFileSync(paths.databasePath)).toEqual(bytes);
    const status=inspect(paths);expect(status.establishmentAllowed).toBe(true);
    expect(()=>maintainSecurityFence(paths,{action:"establish",expect:"0".repeat(64)})).toThrow(/preflight_changed/);
    expect(maintainSecurityFence(paths,{action:"establish",expect:status.preflight})).toMatchObject({trusted:true,quarantined:false});
    const upgraded=unmanagedFixtureDatabase(paths.databasePath,{readonly:true});try{expect(inspectSchema(upgraded).version).toBe(49);expect(upgraded.prepare("SELECT * FROM schema_migrations WHERE version<=40").all()).toEqual(before);}finally{upgraded.close();}
    // A schema40 raw copy cannot bypass the established external marker.
    writeFileSync(paths.databasePath,bytes);expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/security_fence_recovery_required/);
  });
  it("retains supported restore provenance and needs a new receipt after each restore",async()=>{
    const f=fixture(), backup=join(f.root,"backup");await createControllerBackup(f.store,backup,{applicationVersion:"test",attachmentDirectory:join(f.paths.dataDirectory,"knowledge-attachments")});
    new AuthenticationService(f.store).rotateToken("local-cli");f.store.close();
    for(let i=0;i<2;i++){
      restoreControllerBackup(backup,f.paths.databasePath);
      expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence/);
      expect(resume(f.paths).trusted).toBe(true);
      const reopened=new SqliteStateStore(f.paths.databasePath);try{expect(reopened.databaseProvenance).toBe("restored");await expect(reopened.recoverIssuedSessions({sessionRows:64,sessionReconcileBatch:8})).resolves.toBeUndefined();expect(new AuthenticationService(reopened).verifyInstallationToken(f.token)).toBe(false);}finally{reopened.close();}
    }
  });
  it("has exact bounded trigger coverage validated as schema, including malformed/premature markers",()=>{
    const f=fixture();f.store.close();const db=unmanagedFixtureDatabase(f.paths.databasePath);
    expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger'").get()).toEqual({n:securityTriggers.length});
    db.exec(`DROP TRIGGER ${securityTriggers[0].name}`);db.close();expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/schema/);
  });
  it.each(["transaction","committed","confirmed","resume-pending","resume-transaction","resume-committed","resume-confirmed"])("survives a real SIGKILL at %s with correct trust outcome",async edge=>{
    const f=fixture();f.store.close();
    if(edge.startsWith("resume-"))rmSync(witness(f.paths.databasePath));
    const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("./fixtures/security-fence-child.ts",import.meta.url)),f.paths.databasePath,edge],{stdio:["ignore","pipe","pipe"]});
    let output="";child.stdout.on("data",b=>{output+=b;});let err="";child.stderr.on("data",b=>{err+=b;});
    const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on("error",reject);child.on("exit",(code,signal)=>resolve({code,signal}));});
    expect(err).toBe("");expect(output).toContain("crash-boundary");expect(result.signal).toBe("SIGKILL");
    if(edge==="resume-confirmed") {const current=new SqliteStateStore(f.paths.databasePath);try{expect(new AuthenticationService(current).verifyInstallationToken(f.token)).toBe(false);}finally{current.close();}expect(resume(f.paths)).toMatchObject({trusted:true,changed:false});}
    else if(edge==="confirmed") {const current=new SqliteStateStore(f.paths.databasePath);try{expect(current.getPrincipal("child-revoked")).toEqual({id:"child-revoked",kind:"agent",status:"revoked"});expect(new AuthenticationService(current).verifyInstallationToken(f.token)).toBe(true);}finally{current.close();}}
    else {expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/security_fence/);expect(resume(f.paths).trusted).toBe(true);}
  },30_000);
});
