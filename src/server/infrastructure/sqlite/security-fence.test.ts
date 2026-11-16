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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "./sqlite-state-store";
import { resolveAppPaths } from "../../paths";
import { maintainSecurityFence } from "../../bootstrap/security-maintenance";
import { SecurityFence, SecurityFenceBackupError, securityFenceBinding, securityFenceRoot } from "./security-fence";
import * as validation from "./database-validation";
import { AuthenticationService } from "../../modules/authentication";
import { IdentityService } from "../../modules/identity";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { securityTriggers } from "./security-fence-migration";
import { inspectSchema } from "./schema-inspection";
import { applyRegistryMigration } from "./migration-registry";
import { establishSqliteSecurityFence, maintainSqliteSecurityFence, quarantineAuthority } from "./security-maintenance";
import { takeBoundBackup, type MaintenanceBackup } from "./backup-binding";
import { OwnedSqliteDatabase } from "./owned-database";
import { BACKUP_LIMITS, hashFile, parseManifest, readBoundedJson, validateBackup } from "./backup-validation";
import { initializeSchema } from "./migrations";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { UPGRADE_MARKER_VERSION } from "./upgrade-marker-migration";
import { enableProvisionalSchema, provisionalSchemaEnabled } from "./provisional-schema-gate";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { openStoreAt49, RELEASED_SCHEMA_VERSION } from "./fixtures/released-schema";

vi.mock("node:fs", async original=>({...await original<typeof import("node:fs")>()}));
vi.mock("./database-validation", async original=>({...await original<typeof import("./database-validation")>()}));
const roots:string[]=[];
afterEach(()=>{ vi.restoreAllMocks(); for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
/** `open` creates the store: by default this release's (`new SqliteStateStore`), or the released schema-49 one. */
function fixture(open:(path:string)=>SqliteStateStore=path=>new SqliteStateStore(path)) {
  const root=mkdtempSync(join(tmpdir(),"security-fence-")); roots.push(root);
  const paths=resolveAppPaths(join(root,"data"));
  const store=open(paths.databasePath), auth=new AuthenticationService(store);
  const token=auth.generateToken("local-cli").token;
  return {root,paths,store,token};
}
const witness=(path:string)=>join(securityFenceRoot(path),"witness.json");
const inspect=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSecurityFence(paths,{action:"inspect"});
const resume=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSecurityFence(paths,{action:"resume",expect:inspect(paths).preflight,mode:"token"});
const sql=async(store:SqliteStateStore,source:string)=>{const s=store.authenticationProviderStorage(); await s.borrow(async()=>{const c=s.createProviderConnection();try{c.prepare(source).run([]);}finally{c.close();}});};
const DEADLINE="2026-12-01T00:00:00.000Z";
/** Recent enough that summary age retention keeps the summaries recovery writes. */
const RECENT=new Date(Date.now()-60_000).toISOString();
const run=(id:string,phase:string,queuedAt:string,actor="local-cli",bound="")=>`INSERT INTO test_runs(id,project_id,worktree_path,worktree_head,worktree_branch,worktree_dirty,preset_id,preset_name,adapter,actor,phase,queue_position,executable,args_json,cwd,queued_at${bound?",provider_bound":""})
  VALUES('${id}','project','/code/project','head','main',0,'node:test','test','node','${actor}','${phase}',${phase==="queued"?1:"NULL"},'pnpm','["test"]','/code/project','${queuedAt}'${bound?`,${bound}`:""});`;
/** 51 finished runs; with the queued and running runs interrupted, recovery trims the oldest 3 (history-00..02). */
const history=Array.from({length:51},(_,index)=>`history-${String(index).padStart(2,"0")}`);
const HUMAN_AUTHORITY={principalId:"human",sessionKey:"a".repeat(64),evidenceKey:"b".repeat(64),generation:1,deadline:"2026-01-02T00:00:00.000Z"};
/** Machine requesters on a trimmed and a kept run; human requesters on a trimmed and the interrupted running run. */
const requesters=`INSERT INTO remote_principals VALUES('agent','agent','active'),('human','human','active');
  INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at) VALUES('agent-credential','agent','agent_token','fixture','agentfix','${"b".repeat(64)}','active','2026-11-01T00:00:00.000Z');
  INSERT INTO test_run_requesters(run_id,principal_id,credential_id,project_id,session_owner,reservation_id,lease_token_hash) VALUES
    ('history-00','agent','agent-credential','project','agent:mcp:fixture',NULL,NULL),('history-50','agent','agent-credential','project','agent:mcp:fixture',NULL,NULL);
  INSERT INTO human_test_run_requesters(run_id,project_id,principal_id,session_owner,authority_json,reference_json,reservation_id,fingerprint)
    SELECT id,'project','human','human:test:human','${JSON.stringify({...HUMAN_AUTHORITY,membershipRevision:1,permissions:["tests:run"]})}','${JSON.stringify({...HUMAN_AUTHORITY,nativeSessionId:"native"})}',NULL,'${"c".repeat(64)}'
    FROM test_runs WHERE id IN ('history-01','running-run');`;
/** Authority and pending work the quarantine acts on, valid from schema 40 on; issuance and requesters exist from 41 and 47. */
const authority=(current:boolean)=>`INSERT INTO remote_principals VALUES('owner','owner','active');
  INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at) VALUES('owner-credential','owner','owner_session','fixture','fixture','${"a".repeat(64)}','active','2026-11-01T00:00:00.000Z');
  INSERT INTO authentication_ba_user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES('subject','Owner','owner@fixture.invalid',0,'now','now',1);
  INSERT INTO authentication_ba_account(id,accountId,providerId,userId,password,accessToken,createdAt,updatedAt) VALUES('account','subject','credential','subject','hash','access','now','now');
  INSERT INTO authentication_provider_subjects(provider_id,subject,principal_id,status,linked_at,revoked_at) VALUES('better-auth','subject','owner','active','2026-11-01T00:00:00.000Z',NULL);
  INSERT INTO authentication_account_policies VALUES('better-auth','subject',1,1,1,1,'2026-11-01T00:00:00.000Z');
  INSERT INTO authentication_ba_two_factor(id,secret,backupCodes,userId,verified) VALUES('factor','ciphertext','codes','subject',1);
  INSERT INTO authentication_ba_passkey(id,publicKey,userId,credentialID,counter,deviceType,backedUp) VALUES('passkey','key','subject','credential-id',0,'singleDevice',0),('staged-passkey','key','subject','staged-credential-id',0,'singleDevice',0);
  INSERT INTO authentication_passkey_trust(credential_id,native_id,provider_id,subject,handle,fingerprint,verified_uv,trusted_at) VALUES('credential-id','passkey','better-auth','subject','handle','fingerprint',1,'2026-11-01T00:00:00.000Z');
  INSERT INTO authentication_ba_session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES('session','${DEADLINE}','token-session','now','now','subject');
  INSERT INTO authentication_session_evidence(session_id,provider_id,subject,method,authenticated_at,original_deadline,generation,policy_revision,credential,credential_binding,attempt_id) VALUES('session','better-auth','subject','password','2026-11-01T00:00:00.000Z','${DEADLINE}',1,1,NULL,NULL,'attempt-session');
  INSERT INTO authentication_passkey_staged(credential_id,native_id,capability,provider_id,subject,handle,fingerprint,generation,policy_revision,session_id,original_deadline,deadline) VALUES('staged-credential-id','staged-passkey','staged-capability','better-auth','subject','handle','fingerprint',1,1,'session','${DEADLINE}',1);
  ${current?`INSERT INTO authentication_session_issuance(session_id,state,original_deadline) VALUES('session','may_publish','${DEADLINE}');`:""}
  INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at) VALUES('project','Project','/code/project',3214,'pnpm','["run","dev"]','/',45000,'now','now');
  INSERT INTO reservations(id,project_id,worktree_path,kind,owner,created_at) VALUES('lease','project','/code/project','human','fixture','2026-11-01T00:00:00.000Z');
  ${history.map((id,index)=>run(id,"passed",`2026-01-01T00:00:${String(index).padStart(2,"0")}.000Z`,current&&(index===0||index===50)?"agent:mcp:fixture":current&&index===1?"human:test:human":"local-cli",current&&index===1?"1":"")).join("\n  ")}
  ${run("queued-run","queued",RECENT)}
  ${run("running-run","running",RECENT,current?"human:test:human":"local-cli",current?"1":"")}
  ${current?requesters:""}`;
/** A genuine schema40 installation with authority and no external marker. */
function genuine40() {
  const root=mkdtempSync(join(tmpdir(),"security-resume-40-"));roots.push(root);
  const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
  const db=unmanagedFixtureDatabase(paths.databasePath);
  try{db.exec(readFileSync(new URL("./fixtures/schema-v40.sql",import.meta.url),"utf8"));db.exec(authority(false));}finally{db.close();}
  chmodSync(paths.databasePath,0o600);return paths;
}
const HISTORICAL_EVENT_AT="2026-01-01T00:00:00.000Z";
/** Older quarantine events that are not this code's JSON text. details_json is TEXT NOT NULL
 * without a JSON constraint in a non-STRICT table: malformed text, a non-JSON BLOB, a BLOB of
 * JSON text bytes and a JSONB BLOB (another receipt each) stay as stored; the integer becomes
 * text by column affinity; NULL is refused by NOT NULL. */
const MALFORMED_DETAILS=["'{receipt:'","x'ff00133780'",`CAST('{"receipt":"historical-blob"}' AS BLOB)`,`jsonb('{"receipt":"historical-jsonb"}')`,"42"];
/** A current-schema store whose authority was written outside its owner, so it needs resume.
 * `malformed` adds the older quarantine events of MALFORMED_DETAILS. */
function current49(malformed=false) { return outsideWrites(fixture(),malformed); }
/** The same at the released schema 49 (not whatever this release creates): the source of the provisional steps. */
function released49(malformed=false) { return outsideWrites(fixture(openStoreAt49),malformed); }
function outsideWrites(f:ReturnType<typeof fixture>,malformed:boolean) {
  f.store.close();
  const db=unmanagedFixtureDatabase(f.paths.databasePath);try{db.exec(authority(true));
    if(malformed)for(const details of MALFORMED_DETAILS)db.exec(`INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('authentication.security_quarantined','local-cli',${details},'${HISTORICAL_EVENT_AT}')`);
  }finally{db.close();}
  return f.paths;
}
/** What the fixture's pending work becomes: the queued and running runs interrupted with terminal summaries, the three oldest finished runs trimmed. */
const RECOVERED_RUNS=[...history.slice(3).map(id=>({id,phase:"passed",queue_position:null,finished:0})),
  {id:"queued-run",phase:"interrupted",queue_position:null,finished:1},{id:"running-run",phase:"interrupted",queue_position:null,finished:1}];
const RECOVERED_SUMMARIES=[{run_id:"queued-run",terminal:1},{run_id:"running-run",terminal:1}];
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
  removed:["authentication_ba_session","authentication_session_evidence","authentication_session_issuance","authentication_ba_two_factor","authentication_ba_passkey","authentication_passkey_trust","authentication_passkey_staged","authentication_ba_verification"]
    .map(name=>has(db,name)?db.prepare(`SELECT count(*) FROM "${name}"`).pluck().get():"absent"),
  runs:db.prepare("SELECT id,phase,queue_position,finished_at IS NOT NULL AS finished FROM test_runs ORDER BY id").all(),
  summaries:db.prepare("SELECT run_id,terminal FROM test_run_summaries ORDER BY run_id").all(),
  requesters:has(db,"test_run_requesters")?db.prepare("SELECT run_id,principal_id,credential_id FROM test_run_requesters ORDER BY run_id").all():"absent",
  humanRequesters:has(db,"human_test_run_requesters")?db.prepare("SELECT run_id,principal_id,fingerprint FROM human_test_run_requesters ORDER BY run_id").all():"absent",
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
/** Faults inside (before commit) and after the one schema+quarantine transaction. `target` is the maintenance schema target. */
function injectResumeFault(stage:string,paths:ReturnType<typeof resolveAppPaths>,target?:number) {
  const status=target===undefined?maintainSecurityFence(paths,{action:"inspect"}):maintainSqliteSecurityFence(paths,{action:"inspect"},HANDOFF,target);
  let injected=false;const fault=()=>{injected=true;return new Error(`fixture ${stage} fault`);};
  if(stage==="quarantine"){const prepare=Database.prototype.prepare;vi.spyOn(Database.prototype,"prepare").mockImplementation(function(this:Database.Database,source:string){
    if(source.startsWith("INSERT INTO controller_audit_events") && source.includes("'authentication.security_quarantined'"))throw fault();return prepare.call(this,source);} as typeof prepare);}
  if(stage==="validation"){const validate=validation.validateDatabase;vi.spyOn(validation,"validateDatabase").mockImplementation((database,version)=>{
    validate(database,version);if(version===49 && database.inTransaction)throw fault();});}
  if(stage==="post-commit"){const pragma=Database.prototype.pragma;vi.spyOn(Database.prototype,"pragma").mockImplementation(function(this:Database.Database,source,options){
    const result=pragma.call(this,source,options);
    // initializeSchema's finally fails AFTER the one transaction committed the quarantine.
    if(source==="foreign_keys = ON" && !this.inTransaction && this.prepare("SELECT 1 FROM controller_audit_events WHERE event_type='authentication.security_quarantined' AND created_at<>?").get(HISTORICAL_EVENT_AT))throw fault();
    return result;});}
  if(stage==="confirmed-receipt"){const receipt=SecurityFence.maintenanceReceipt;vi.spyOn(SecurityFence,"maintenanceReceipt").mockImplementation((...args)=>{if(args[3]==="confirmed")throw fault();receipt(...args);});}
  const run=()=>maintainSqliteSecurityFence(paths,{action:"resume",expect:status.preflight,mode:"token"},{
    preflight:database=>{preflightSecurityRecoveryHandoff(database);},
    acknowledge:database=>{if(stage==="handoff")throw fault();acknowledgeRecoveredBackupHandoff(database);},
  },target);
  return {run,injected:()=>injected};
}
/** The handoff of bootstrap maintenance, for direct calls with a schema target. */
const HANDOFF={preflight:(database:string)=>{preflightSecurityRecoveryHandoff(database);},acknowledge:acknowledgeRecoveredBackupHandoff};
// Step 50 exactly: these tests assert the marker step's own states. Step 51 has its own tests.
const TARGET=UPGRADE_MARKER_VERSION;
const inspect50=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSqliteSecurityFence(paths,{action:"inspect"},HANDOFF,TARGET);
const resume50=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSqliteSecurityFence(paths,{action:"resume",expect:inspect50(paths).preflight,mode:"token"},HANDOFF,TARGET);
/** The resume of the released schema 49: what the default resume is while the supported version is 49. */
const resume49=(paths:ReturnType<typeof resolveAppPaths>)=>maintainSqliteSecurityFence(paths,{action:"resume",
  expect:maintainSqliteSecurityFence(paths,{action:"inspect"},HANDOFF,RELEASED_SCHEMA_VERSION).preflight,mode:"token"},HANDOFF,RELEASED_SCHEMA_VERSION);
const upgradeMarker=(db:Database.Database)=>has(db,"upgrade_marker")?db.prepare("SELECT state FROM upgrade_marker").pluck().all():"absent";
/** The quarantine effects without the schema version, which the target raises. */
const effects=(db:Database.Database)=>({...quarantine(db),version:"ignored"});

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
      accounts:[{password:null,accessToken:null,refreshToken:null,idToken:null}],users:[{id:"subject",twoFactorEnabled:0}],removed:[0,0,0,0,0,0,0,0],
      policies:[{subject:"subject",totp_selected:0,passkey_selected:0}],leases:[{id:"lease",released:1}],authentication:{mode:"token",token:null},
      runs:RECOVERED_RUNS,summaries:RECOVERED_SUMMARIES,requesters:[],humanRequesters:[]});
    const expectedCounters=read(twin,counters);expect(expectedCounters).toMatchObject({policy:2,events:1});
    // Every effect the fault must leave undone is present beforehand.
    expect(read(paths,quarantine)).toMatchObject({removed:[1,1,"absent",1,2,1,1,0],summaries:[],requesters:"absent",humanRequesters:"absent",
      runs:[...history.map(id=>({id,phase:"passed",queue_position:null,finished:0})),{id:"queued-run",phase:"queued",queue_position:1,finished:0},{id:"running-run",phase:"running",queue_position:null,finished:0}]});
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
  it.each([["quarantine",false,false],["quarantine",false,true],["validation",false,false],["validation",false,true],["post-commit",true,false],["post-commit",true,true],["handoff",true,false],["confirmed-receipt",true,false]] as const)
  ("reports a resume fault at %s on a current-schema database as committed=%s (malformed older event: %s) and recovers to the same quarantine",(stage,committed,malformed)=>{
    const paths=current49(malformed),twin=current49(malformed);resume(twin);
    const expected=read(twin,quarantine),initial=read(paths,counters),before=read(paths,quarantine);
    expect(expected).toMatchObject({removed:[0,0,0,0,0,0,0,0],runs:RECOVERED_RUNS,summaries:RECOVERED_SUMMARIES,
      // Requester rows of trimmed runs (history-00, history-01) go with them; those of kept runs stay.
      requesters:[{run_id:"history-50",principal_id:"agent",credential_id:"agent-credential"}],
      humanRequesters:[{run_id:"running-run",principal_id:"human",fingerprint:"c".repeat(64)}]});
    expect(initial.events).toBe(malformed?MALFORMED_DETAILS.length:0);
    // The commit-evidence lookup must not parse or match any of these historical values.
    expect(read(paths,db=>db.prepare("SELECT typeof(details_json) FROM controller_audit_events WHERE event_type='authentication.security_quarantined' ORDER BY id").pluck().all()))
      .toEqual(malformed?["text","blob","blob","blob","text"]:[]);
    expect(before).toMatchObject({credentials:[{id:"agent-credential",status:"active",revoked:0},{id:"owner-credential",status:"active",revoked:0}],
      removed:[1,1,1,1,2,1,1,0],summaries:[],
      runs:[...history.map(id=>({id,phase:"passed",queue_position:null,finished:0})),{id:"queued-run",phase:"queued",queue_position:1,finished:0},{id:"running-run",phase:"running",queue_position:null,finished:0}],
      requesters:[{run_id:"history-00",principal_id:"agent",credential_id:"agent-credential"},{run_id:"history-50",principal_id:"agent",credential_id:"agent-credential"}],
      humanRequesters:[{run_id:"history-01",principal_id:"human",fingerprint:"c".repeat(64)},{run_id:"running-run",principal_id:"human",fingerprint:"c".repeat(64)}]});
    const fault=injectResumeFault(stage,paths);
    expect(fault.run).toThrowError(expect.objectContaining({code:"security_fence_pending",committed}));
    expect(fault.injected()).toBe(true);vi.restoreAllMocks();
    // At the current version only the quarantine itself can prove the commit.
    expect(read(paths,quarantine)).toEqual(committed?expected:before);
    expect(read(paths,counters)).toEqual(committed?{generation:initial.generation+1,policy:initial.policy+1,events:initial.events+1}:initial);
    expect(witnessState(paths)).toBe("pending");
    expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/security_fence/);
    expect(resume(paths)).toMatchObject({trusted:true,quarantined:true});
    expect(read(paths,quarantine)).toEqual(expected);
    const runs=committed?2:1;
    expect(read(paths,counters)).toEqual({generation:initial.generation+runs,policy:initial.policy+runs,events:initial.events+runs});
    const reopened=new SqliteStateStore(paths.databasePath);try{expect(reopened.getAuthenticationPolicy().mode).toBe("token");}finally{reopened.close();}
  });
  it("quarantines in the schema transaction exactly as the same statements do under foreign-key enforcement",()=>{
    const paths=current49(),single=`${paths.databasePath}.single`,enforced=`${paths.databasePath}.enforced`;
    copyFileSync(paths.databasePath,single);copyFileSync(paths.databasePath,enforced);
    const a=unmanagedFixtureDatabase(single),b=unmanagedFixtureDatabase(enforced);
    // One clock for both, so timestamps written by the quarantine and recovery match.
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date());
    try{
      a.pragma("foreign_keys = ON");b.pragma("foreign_keys = ON");
      // (a) the resume path: acts of the schema transaction, enforcement off, checked before commit.
      initializeSchema(a,false,inspectSchema,{acts:database=>quarantineAuthority(database,"receipt","token")});
      // (b) the two-transaction behaviour: the same statements with every ON DELETE action enforced.
      expect(b.pragma("foreign_keys",{simple:true})).toBe(1);
      b.transaction(()=>quarantineAuthority(b,"receipt","token")).immediate();
      // The checkpoint epoch is random on every covered write; everything else is compared table by table.
      const tables=(db:Database.Database)=>{const {catalogue,rows}=all(db);delete rows.security_checkpoint;return {catalogue,rows};};
      const left=tables(a),right=tables(b);
      expect(Object.keys(left.rows)).toEqual(Object.keys(right.rows));
      for(const name of Object.keys(left.rows))expect({name,rows:left.rows[name]}).toEqual({name,rows:right.rows[name]});
      expect(left.catalogue).toEqual(right.catalogue);
      expect(quarantine(a)).toMatchObject({removed:[0,0,0,0,0,0,0,0],runs:RECOVERED_RUNS,summaries:RECOVERED_SUMMARIES,
        requesters:[{run_id:"history-50"}],humanRequesters:[{run_id:"running-run"}]});
    }finally{vi.useRealTimers();a.close();b.close();}
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

describe("provisional upgrade marker under the security fence (target 50)",()=>{
  let restoreGate:()=>void;
  beforeEach(()=>{restoreGate=enableProvisionalSchema();});
  afterEach(()=>{restoreGate();});
  it("publishes a pending witness for every marker write exactly as for a schema-49 authority table",()=>{
    const root=mkdtempSync(join(tmpdir(),"security-marker-"));roots.push(root);
    const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
    // An ordinary connection: the schema runs before the fence registers its function.
    const db=new Database(paths.databasePath);
    try{
      chmodSync(paths.databasePath,0o600);validation.configureDurability(db);
      initializeSchema(db,true,current=>{inspectSchema(current,TARGET);},{target:TARGET});
      expect(db.prepare("SELECT state FROM upgrade_marker").pluck().get()).toBe("complete");
      const fence=SecurityFence.attach(paths.databasePath,db,true);
      // Reads go through the fence too, so it accounts for every change of the files.
      const epoch=()=>fence.execute(()=>db.prepare("SELECT epoch FROM security_checkpoint").pluck().get(),true);
      const observe=(statement:string)=>{
        const before=epoch();let during:unknown;
        fence.execute(()=>{db.prepare(statement).run();during=witnessState(paths);},false);
        return {during,after:witnessState(paths),epochChanged:epoch()!==before};
      };
      const covered={during:"pending",after:"confirmed",epochChanged:true};
      expect(witnessState(paths)).toBe("confirmed");
      // The reference: a table of the frozen schema-49 coverage, and a table outside it.
      expect(observe("UPDATE controller_settings SET updated_at=updated_at WHERE key='authentication'")).toEqual(covered);
      expect(observe("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('fixture','fixture','{}','2026-11-15T00:00:00.000Z')"))
        .toEqual({during:"confirmed",after:"confirmed",epochChanged:false});
      expect(observe("UPDATE upgrade_marker SET state='pending',changed_at='2026-11-15T00:00:00.000Z'")).toEqual(covered);
      expect(observe("DELETE FROM upgrade_marker")).toEqual(covered);
      expect(observe("INSERT INTO upgrade_marker VALUES(1,'complete','2026-11-15T00:00:00.000Z',NULL)")).toEqual(covered);
      expect(fence.execute(()=>db.prepare("SELECT state FROM upgrade_marker").pluck().all(),true)).toEqual(["complete"]);
    }finally{db.close();}
  });

  it("resumes schema 49 to 50 with the marker pending in the one quarantine transaction",()=>{
    const paths=released49(),twin=released49(),reference=released49();
    resume49(reference);const expected=read(reference,effects);
    // Success: every quarantine effect of the default resume, at version 50 with a pending marker.
    expect(resume50(twin)).toMatchObject({trusted:true,quarantined:true,schemaVersion:50});
    read(twin,db=>{
      expect(inspectSchema(db,TARGET).version).toBe(50);expect(upgradeMarker(db)).toEqual(["pending"]);
      expect(effects(db)).toEqual(expected);
    });
    // A failure inside the quarantine rolls back step 50 with it.
    const before=read(paths,all),fault=injectResumeFault("quarantine",paths,TARGET);
    expect(fault.run).toThrowError(expect.objectContaining({code:"security_fence_pending",committed:false}));
    expect(fault.injected()).toBe(true);vi.restoreAllMocks();
    expect(read(paths,all)).toEqual(before);
    read(paths,db=>{expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(49);expect(upgradeMarker(db)).toBe("absent");});
    expect(resume50(paths)).toMatchObject({trusted:true,quarantined:true});
    read(paths,db=>{expect(upgradeMarker(db)).toEqual(["pending"]);expect(effects(db)).toEqual(expected);});
    // The default ceiling refuses the result, as any newer schema.
    expect(()=>new SqliteStateStore(paths.databasePath)).toThrow(/^Unsupported or unrecognized database schema/);
  });

  it.each([["from schema 49",false],["already at step 50",true]] as const)("reports a post-commit resume failure %s as committed with the marker pending",(_name,migrated)=>{
    const paths=released49();
    if(migrated){
      const db=unmanagedFixtureDatabase(paths.databasePath);
      try{initializeSchema(db,false,current=>{inspectSchema(current,TARGET);},{target:TARGET});db.exec("UPDATE upgrade_marker SET state='complete'");}finally{db.close();}
      expect(read(paths,upgradeMarker)).toEqual(["complete"]);
    }
    const fault=injectResumeFault("post-commit",paths,TARGET);
    expect(fault.run).toThrowError(expect.objectContaining({code:"security_fence_pending",committed:true}));
    expect(fault.injected()).toBe(true);vi.restoreAllMocks();
    read(paths,db=>{expect(inspectSchema(db,TARGET).version).toBe(50);expect(upgradeMarker(db)).toEqual(["pending"]);
      expect(db.prepare("SELECT status FROM principal_credentials ORDER BY id").pluck().all()).toEqual(["revoked","revoked"]);});
    expect(witnessState(paths)).toBe("pending");
    expect(resume50(paths)).toMatchObject({trusted:true,quarantined:true});
    expect(read(paths,upgradeMarker)).toEqual(["pending"]);
  });

  it("sets a complete marker of a step-50 database back to pending on resume",()=>{
    const paths=released49();
    const db=unmanagedFixtureDatabase(paths.databasePath);
    try{initializeSchema(db,false,current=>{inspectSchema(current,TARGET);},{target:TARGET});db.exec("UPDATE upgrade_marker SET state='complete'");}finally{db.close();}
    expect(read(paths,upgradeMarker)).toEqual(["complete"]);
    expect(inspect50(paths)).toMatchObject({trusted:false,schemaVersion:50});
    expect(resume50(paths)).toMatchObject({trusted:true,quarantined:true,schemaVersion:50});
    read(paths,db=>{expect(upgradeMarker(db)).toEqual(["pending"]);expect(quarantine(db)).toMatchObject({version:50,credentials:[{status:"revoked"},{status:"revoked"}],removed:[0,0,0,0,0,0,0,0]});});
    // A trusted second resume changes nothing.
    expect(resume50(paths)).toMatchObject({trusted:true,changed:false});
  });

  it("establishes a pre-fence database at step 50 with the marker pending",()=>{
    const root=mkdtempSync(join(tmpdir(),"security-establish-50-"));roots.push(root);const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
    const db=unmanagedFixtureDatabase(paths.databasePath);db.exec(readFileSync(new URL("./fixtures/schema-v40.sql",import.meta.url),"utf8"));db.close();chmodSync(paths.databasePath,0o600);
    const status=inspect50(paths);expect(status).toMatchObject({establishmentAllowed:true,schemaVersion:40});
    expect(maintainSqliteSecurityFence(paths,{action:"establish",expect:status.preflight},HANDOFF,TARGET)).toMatchObject({trusted:true,quarantined:false,schemaVersion:50});
    read(paths,db=>{expect(inspectSchema(db,TARGET).version).toBe(50);expect(upgradeMarker(db)).toEqual(["pending"]);});
  });
});

describe("default maintenance of a step-50 database (provisional switch off)",()=>{
  const UNKNOWN_NEWER="INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(50,'2026-11-15T00:00:00.000Z','unknown-newer','"+"0".repeat(64)+"')";
  let provisional:ReturnType<typeof resolveAppPaths>,unknown:ReturnType<typeof resolveAppPaths>;
  // Only building the step-50 fixture needs the switch; every test body runs with it off.
  beforeEach(()=>{
    provisional=released49();unknown=released49();
    const restore=enableProvisionalSchema();
    try{const db=unmanagedFixtureDatabase(provisional.databasePath);try{initializeSchema(db,false,current=>{inspectSchema(current,TARGET);},{target:TARGET});}finally{db.close();}}
    finally{restore();}
    const db=unmanagedFixtureDatabase(unknown.databasePath);try{db.exec(UNKNOWN_NEWER);}finally{db.close();}
  });
  /** The database rows and catalogue, the database file bytes and the fence witness. */
  const state=(paths:ReturnType<typeof resolveAppPaths>)=>({database:read(paths,all),file:createHash("sha256").update(readFileSync(paths.databasePath)).digest("hex"),witness:readFileSync(witness(paths.databasePath),"utf8")});
  const failure=(operation:()=>unknown)=>{try{operation();}catch(error){return {name:(error as Error).name,code:(error as {code?:unknown}).code,committed:(error as {committed?:unknown}).committed};}throw new Error("expected a refusal");};
  it.each([
    ["inspect",{action:"inspect"}],
    ["establish",{action:"establish",expect:"0".repeat(64)}],
    ["resume",{action:"resume",expect:"0".repeat(64),mode:"token"}],
  ] as const)("refuses %s without a target, changes nothing and reports what the base reports for an unknown newer schema",(_name,command)=>{
    expect(provisionalSchemaEnabled()).toBe(false);
    read(provisional,db=>{expect(db.prepare("SELECT max(version) FROM schema_migrations").pluck().get()).toBe(50);expect(db.prepare("SELECT state FROM upgrade_marker").pluck().all()).toEqual(["pending"]);});
    const before=state(provisional),beforeUnknown=state(unknown);
    const refused=failure(()=>maintainSqliteSecurityFence(provisional,command,HANDOFF));
    // committed defaults to false in AuthenticationProviderError: nothing was committed.
    expect(refused).toEqual({name:"SecurityFenceError",code:"security_fence_pending",committed:false});
    expect(failure(()=>maintainSqliteSecurityFence(unknown,command,HANDOFF))).toEqual(refused);
    // The production composition gives the same answer.
    expect(failure(()=>maintainSecurityFence(provisional,command))).toEqual(refused);
    expect(state(provisional)).toEqual(before);
    expect(state(unknown)).toEqual(beforeUnknown);
  });
});

describe("establishment with a pre-establishment backup (default target)",()=>{
  /** A pre-fence schema-28 installation, the schema of the public 0.1.1 release: frozen schema 26,
   * the unchanged index (27) and the provenance registry (28), with historical authority. */
  function baseline28() {
    const root=mkdtempSync(join(tmpdir(),"security-establish-28-"));roots.push(root);
    const paths=resolveAppPaths(join(root,"data"));mkdirSync(paths.dataDirectory,{mode:0o700});
    const db=unmanagedFixtureDatabase(paths.databasePath);
    try{
      db.exec(readFileSync(new URL("./fixtures/schema-v26.sql",import.meta.url),"utf8"));
      db.exec(`CREATE INDEX IF NOT EXISTS knowledge_import_sources_target ON knowledge_import_sources(project_id,target_kind,target_id);
        INSERT INTO schema_migrations(version,applied_at) VALUES(27,'2026-11-01T00:00:00.000Z')`);
      applyRegistryMigration(db);
      // Step 28 records the time it ran; a fixed past instant keeps every historical timestamp fixed.
      db.prepare("UPDATE schema_migrations SET applied_at=? WHERE version=28").run("2026-11-01T00:00:01.000Z");
      db.exec("INSERT INTO remote_principals VALUES('historical-owner','owner','active')");
      db.prepare(`INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at)
        VALUES('historical-credential','historical-owner','owner_session','fixture','fixture',?,'active','2026-11-01T00:00:00.000Z')`).run("a".repeat(64));
    }finally{db.close();}
    chmodSync(paths.databasePath,0o600);return paths;
  }
  /** The composition's backup: createControllerBackup into a new destination beside the data directory. */
  const controllerBackup=(paths:ReturnType<typeof resolveAppPaths>,calls:string[]=[]):MaintenanceBackup=>async source=>{
    const destination=join(paths.dataDirectory,"..",`pre-establish-${randomUUID()}`);calls.push(destination);
    return {root:destination,manifest:await createControllerBackup(source,destination,{applicationVersion:"test",attachmentDirectory:paths.knowledgeAttachmentDirectory})};
  };
  const establish=(paths:ReturnType<typeof resolveAppPaths>,backup:MaintenanceBackup)=>establishSqliteSecurityFence(paths,{action:"establish",expect:inspect(paths).preflight},HANDOFF,backup);
  const sha=(path:string)=>fs.existsSync(path)?createHash("sha256").update(readFileSync(path)).digest("hex"):"missing";
  /** What a refusal must leave as it was: the database, every sidecar, and no fence directory. */
  /** A missing and an empty WAL are the same state: a read-only open of a WAL database creates an empty one. */
  const untouched=(paths:ReturnType<typeof resolveAppPaths>)=>({...Object.fromEntries(["","-wal","-shm","-journal",".initializing"].map(suffix=>[`database${suffix}`,sha(paths.databasePath+suffix)])),
    "database-wal":fs.existsSync(`${paths.databasePath}-wal`)&&fs.lstatSync(`${paths.databasePath}-wal`).size>0?sha(`${paths.databasePath}-wal`):"empty",
    security:fs.existsSync(securityFenceRoot(paths.databasePath))?"present":"missing"});
  const refusal=async(operation:()=>Promise<unknown>)=>{
    try{await operation();}catch(error){const {name,code,committed,message}=error as {name:string;code:string;committed:boolean;message:string};
      return {name,code,committed,message,backupRefusal:error instanceof SecurityFenceBackupError};}
    throw new Error("expected a refusal");
  };
  const BACKUP_REFUSED={name:"SecurityFenceBackupError",code:"security_fence_backup_failed",committed:false,message:expect.stringMatching(/^security_fence_backup_failed: .*backup failed.*establish again/),backupRefusal:true};
  /** A valid backup tree of an installation, taken through ordinary ownership before establishment runs. */
  async function priorBackup(paths:ReturnType<typeof resolveAppPaths>) {
    const owner=new OwnedSqliteDatabase(paths.databasePath),destination=join(paths.dataDirectory,"..",`prior-${randomUUID()}`);
    try{return {root:destination,manifest:await createControllerBackup(owner,destination,{applicationVersion:"test",attachmentDirectory:paths.knowledgeAttachmentDirectory})};}finally{owner.close();}
  }
  /**
   * This run's own tree, with its snapshot written straight into the tree's
   * database file and a manifest made before the snapshot finished: the bytes it
   * will have are those of a reference copy taken first, through another
   * read-only connection to the same unchanged source, into a new empty file as
   * the snapshot is (two Backup API copies of an unchanged database are
   * byte-identical). The file keeps the bytes the Backup API writes (no
   * journal-mode switch, which needs the finished file). With `wait` false the
   * function returns while its snapshot is still running; `observed` records
   * the root and whether the snapshot had completed when the function returned.
   * Once the copy has finished, the tree passes every check that follows the
   * completion guard in `takeBoundBackup`.
   */
  const ownTree=(paths:ReturnType<typeof resolveAppPaths>,wait:boolean,observed:{root?:string;completedAtReturn?:boolean}={}):MaintenanceBackup=>async(source,context)=>{
    const root=join(paths.dataDirectory,"..",`own-${randomUUID()}`),file=join(root,"state.sqlite3");
    const scratch=mkdtempSync(join(tmpdir(),"security-establish-reference-"));roots.push(scratch);
    const reference=join(scratch,"reference.sqlite3");fs.closeSync(fs.openSync(reference,"wx",0o600));
    const live=unmanagedFixtureDatabase(context.database,{readonly:true,fileMustExist:true});
    try{await live.backup(reference);}finally{live.close();}
    mkdirSync(join(root,"attachments"),{recursive:true,mode:0o700});
    const manifest={formatVersion:1,applicationVersion:"test",createdAt:new Date().toISOString(),
      database:{file:"state.sqlite3",...hashFile(reference),schemaVersion:context.schemaVersion},attachments:[]};
    writeFileSync(join(root,"manifest.json"),JSON.stringify(manifest),{mode:0o600});
    fs.closeSync(fs.openSync(file,"wx",0o600));
    let completed=false;
    const snapshot=source.backup(file).then(()=>{completed=true;});
    if(wait)await snapshot;else snapshot.catch(()=>undefined);
    observed.root=root;observed.completedAtReturn=completed;
    return {root,manifest};
  };
  /** Takes this run's snapshot into a scratch file, then returns another tree. */
  const substitute=(tree:{root:string;manifest:unknown}):MaintenanceBackup=>async source=>{
    const scratch=mkdtempSync(join(tmpdir(),"security-establish-scratch-"));roots.push(scratch);
    await source.backup(join(scratch,"snapshot.sqlite3"));return tree;
  };
  const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
  /** The instants just before and just after a run. */
  type Window={from:string;to:string};
  const timed=async<T,>(operation:()=>Promise<T>|T)=>{const from=new Date().toISOString(),value=await operation();return {value,window:{from,to:new Date().toISOString()}};};
  type Generated=(value:unknown,row:Record<string,unknown>,run:{source:number;window:Window;name:(kind:string,value:unknown)=>unknown})=>unknown;
  /**
   * The only values establishment generates, by table and column: the
   * `applied_at` of each step the run applied (above the source version), which
   * must be an instant of that run, and the checkpoint's random installation
   * and epoch, named by first appearance so that the witness's copies of them
   * get the same names. Every other value of every table, the `applied_at` of
   * the historical steps and every other historical timestamp included,
   * compares exactly.
   */
  const GENERATED:Readonly<Record<string,Readonly<Record<string,Generated>>>>={
    schema_migrations:{applied_at:(value,row,{source,window})=>(row.version as number)<=source?value
      :typeof value==="string"&&ISO.test(value)&&value>=window.from&&value<=window.to?"<applied by this run>":value},
    security_checkpoint:{installation:(value,_row,{name})=>name("installation",value),epoch:(value,_row,{name})=>name("epoch",value)},
  };
  /** The established database (see GENERATED) and witness of a run from `source` within `window`. */
  const established=(paths:ReturnType<typeof resolveAppPaths>,source:number,window:Window)=>{
    const ids=new Map<string,string>();
    const name=(kind:string,value:unknown)=>{if(typeof value!=="string")return value;if(!ids.has(value))ids.set(value,`${kind}#${ids.size+1}`);return ids.get(value);};
    const database=read(paths,db=>{const {catalogue,rows}=all(db);return {catalogue,rows:Object.fromEntries(Object.entries(rows).map(([table,list])=>[table,
      (list as Array<Record<string,unknown>>).map(row=>Object.fromEntries(Object.entries(row).map(([column,value])=>[column,GENERATED[table]?.[column]?GENERATED[table][column](value,row,{source,window,name}):value])))]))};});
    const {payload}=JSON.parse(readFileSync(witness(paths.databasePath),"utf8")),stat=fs.lstatSync(paths.databasePath);
    return {database,witness:{...payload,installation:name("installation",payload.installation),epoch:name("epoch",payload.epoch),receipt:typeof payload.receipt==="string"?"<receipt>":payload.receipt,
      binding:payload.binding===securityFenceBinding(paths.databasePath)?"<this database>":payload.binding,
      file:payload.file.device===stat.dev&&payload.file.inode===stat.ino?"<this file>":payload.file}};
  };
  /** Historical timestamps the fixtures write as fixed past instants, in authority and settings tables. */
  const HISTORICAL=[["principal_credentials","created_at"],["authentication_provider_subjects","linked_at"],["authentication_passkey_trust","trusted_at"],
    ["reservations","created_at"],["controller_settings","updated_at"]] as const;
  /** The `applied_at` of the steps up to `source`, and each HISTORICAL column of `tables` (default: those the database has). */
  const historical=(paths:ReturnType<typeof resolveAppPaths>,source:number,tables?:readonly string[])=>read(paths,db=>({
    migrations:db.prepare("SELECT version,applied_at FROM schema_migrations WHERE version<=? ORDER BY version").all(source) as Array<{version:number;applied_at:string}>,
    columns:Object.fromEntries(HISTORICAL.filter(([table])=>tables?tables.includes(table):has(db,table))
      .map(([table,column])=>[`${table}.${column}`,db.prepare(`SELECT "${column}" FROM "${table}" ORDER BY rowid`).pluck().all() as string[]])),
  }));
  /** A maintenance result without this run's receipt, the preflight and the backup root. */
  const outcome=(value:object)=>Object.fromEntries(Object.entries(value).filter(([key])=>!["receipt","preflight","backup"].includes(key)));

  it.each([["schema 28 (the public 0.1.1 release)",()=>baseline28(),28],["schema 40 with authority",()=>genuine40(),40]] as const)
  ("establishes %s with this run's validated backup exactly as without one",async(_name,build,version)=>{
    const paths=build(),twin=build(),before=read(paths,all),past=historical(paths,version);
    // The fixture's historical timestamps are fixed past instants, distinct from any run's.
    expect(past.migrations.map(row=>row.version)).toEqual(Array.from({length:version},(_,index)=>index+1));
    expect(past.columns["principal_credentials.created_at"]).toContain("2026-11-01T00:00:00.000Z");
    const start=new Date().toISOString();
    for(const value of [...past.migrations.map(row=>row.applied_at),...Object.values(past.columns).flat()])expect(value<start&&ISO.test(value),value).toBe(true);
    const {value:result,window}=await timed(()=>establish(paths,controllerBackup(paths)));
    expect(result).toMatchObject({trusted:true,changed:true,quarantined:false,schemaVersion:49,backup:expect.any(String)});
    // The backup holds the pre-establishment schema and content, and validates against its own manifest.
    const manifest=parseManifest(readBoundedJson(join(result.backup!,"manifest.json"),BACKUP_LIMITS.manifestBytes,true));
    expect(manifest.database.schemaVersion).toBe(version);
    expect(()=>validateBackup(result.backup!,manifest,true)).not.toThrow();
    const copy=new Database(join(result.backup!,"state.sqlite3"),{readonly:true,fileMustExist:true});
    try{expect(inspectSchema(copy).version).toBe(version);expect(all(copy)).toEqual(before);expect(has(copy,"security_checkpoint")).toBe(false);}finally{copy.close();}
    // The fence is the one the synchronous establishment produces.
    const {value:plain,window:plainWindow}=await timed(()=>maintainSecurityFence(twin,{action:"establish",expect:inspect(twin).preflight}));
    expect(outcome(result)).toEqual(outcome(plain));
    const fenced=established(paths,version,window);
    expect(fenced).toEqual(established(twin,version,plainWindow));
    // Every step above the source was applied by this run, at an instant of it.
    expect((fenced.database.rows.schema_migrations as Array<Record<string,unknown>>).filter(row=>(row.version as number)>version).map(row=>row.applied_at))
      .toEqual(Array.from({length:SUPPORTED_SCHEMA_VERSION-version},()=>"<applied by this run>"));
    // The checkpoint the witness holds is the database's.
    expect(fenced.database.rows.security_checkpoint).toEqual([{singleton:1,installation:fenced.witness.installation,epoch:fenced.witness.epoch}]);
    // The historical timestamps are still there, unchanged.
    const now=historical(paths,version,Object.keys(past.columns).map(key=>key.split(".")[0]!));
    expect(now.migrations).toEqual(past.migrations);
    for(const [key,values] of Object.entries(past.columns))expect(now.columns[key],key).toEqual(expect.arrayContaining(values));
    expect(witnessState(paths)).toBe("confirmed");
    expect(inspect(paths)).toMatchObject({trusted:true,code:"security_fence_current"});
  });

  it("refuses a backup that fails or is not this run's bound copy, with everything unchanged, and establishes on the next run",async()=>{
    const paths=baseline28(),twin=baseline28();
    const foreign=await priorBackup(twin),older=await priorBackup(paths);
    // A further raw change makes `older` an older state of this database.
    const db=unmanagedFixtureDatabase(paths.databasePath);try{db.exec("INSERT INTO remote_principals VALUES('later-agent','agent','active')");}finally{db.close();}
    const current=await priorBackup(paths);
    expect(()=>validateBackup(current.root,parseManifest(current.manifest),true)).not.toThrow();
    const variants:Array<[string,MaintenanceBackup]>=[
      ["the backup function throws",async()=>{throw new Error("fixture backup fault");}],
      ["a tree without taking the snapshot",async()=>current],
      ["a tree after taking two snapshots",async(source,context)=>{const first=await controllerBackup(paths)(source,context);
        await expect(controllerBackup(paths)(source,context)).rejects.toThrow();return first;}],
      ["a backup of another database",substitute(foreign)],
      ["an older backup of this database",substitute(older)],
      ["a manifest the tree does not match",async(source,context)=>{const created=await controllerBackup(paths)(source,context);
        return {...created,manifest:{...(created.manifest as Record<string,unknown>),applicationVersion:"other"}};}],
      ["a tree that does not validate",async(source,context)=>{const created=await controllerBackup(paths)(source,context),file=join(created.root,"state.sqlite3");
        writeFileSync(file,Buffer.concat([readFileSync(file),Buffer.alloc(1)]));return created;}],
      ["a snapshot left running when the function returned",async source=>{void source.backup(join(paths.dataDirectory,"..",`running-${randomUUID()}.sqlite3`));return current;}],
    ];
    const before=untouched(paths),preflight=inspect(paths).preflight;
    expect(before.security).toBe("missing");
    for(const [name,backup] of variants){
      expect(await refusal(()=>establishSqliteSecurityFence(paths,{action:"establish",expect:preflight},HANDOFF,backup)),name).toEqual(BACKUP_REFUSED);
      expect(untouched(paths),name).toEqual(before);
      expect(inspect(paths),name).toMatchObject({trusted:false,establishmentAllowed:true,preflight});
    }
    expect(await establish(paths,controllerBackup(paths))).toMatchObject({trusted:true,changed:true,backup:expect.any(String)});
    expect(inspect(paths).trusted).toBe(true);
  });

  it("refuses this run's own tree whose snapshot was still running when the function returned, by the completion guard alone",async()=>{
    // The case above returns a tree unrelated to its snapshot, which the file
    // identity check refuses too. Here the tree is the one the snapshot is
    // written into, so only the completion guard tells.
    const paths=baseline28(),content=read(paths,all),before=untouched(paths),preflight=inspect(paths).preflight;
    const unfinished:{root?:string;completedAtReturn?:boolean}={};
    expect(await refusal(()=>establishSqliteSecurityFence(paths,{action:"establish",expect:preflight},HANDOFF,ownTree(paths,false,unfinished)))).toEqual(BACKUP_REFUSED);
    expect(unfinished.completedAtReturn).toBe(false);
    expect(untouched(paths)).toEqual(before);
    expect(inspect(paths)).toMatchObject({trusted:false,establishmentAllowed:true,preflight});
    // The refusal drained the copy before refusing: the refused tree is now
    // complete and passes every later check. Its file is the one the snapshot
    // was written into; its stored manifest is the returned one and validates;
    // the copy holds the source's schema version and content and, like the
    // source, no checkpoint.
    const root=unfinished.root!,manifest=parseManifest(readBoundedJson(join(root,"manifest.json"),BACKUP_LIMITS.manifestBytes,true));
    expect(manifest.database).toMatchObject({schemaVersion:28,...hashFile(join(root,"state.sqlite3"))});
    expect(()=>validateBackup(root,manifest,true)).not.toThrow();
    const copy=new Database(join(root,"state.sqlite3"),{readonly:true,fileMustExist:true});
    try{expect(inspectSchema(copy).version).toBe(28);expect(all(copy)).toEqual(content);expect(has(copy,"security_checkpoint")).toBe(false);}finally{copy.close();}
    // The helper itself refuses with the completion guard's message. The
    // function took exactly one snapshot and it completed, so of the guard's
    // three conditions only "still running when the function returned" holds.
    const owner=new OwnedSqliteDatabase(paths.databasePath);
    try{
      const direct:{root?:string;completedAtReturn?:boolean}={},waited:{root?:string;completedAtReturn?:boolean}={};
      await expect(takeBoundBackup(owner,owner.canonicalPath,owner.inspection.version,SUPPORTED_SCHEMA_VERSION,ownTree(paths,false,direct))).rejects.toThrow("The backup is not this run's single completed snapshot.");
      expect(direct.completedAtReturn).toBe(false);
      expect(()=>validateBackup(direct.root!,parseManifest(readBoundedJson(join(direct.root!,"manifest.json"),BACKUP_LIMITS.manifestBytes,true)),true)).not.toThrow();
      // The same function, waiting for its snapshot, is accepted.
      expect(await takeBoundBackup(owner,owner.canonicalPath,owner.inspection.version,SUPPORTED_SCHEMA_VERSION,ownTree(paths,true,waited))).toBe(waited.root);
      expect(waited.completedAtReturn).toBe(true);
    }finally{owner.close();}
    // And establishes.
    const waited:{root?:string;completedAtReturn?:boolean}={};
    expect(await establish(paths,ownTree(paths,true,waited))).toMatchObject({trusted:true,changed:true,backup:waited.root});
    expect(waited.completedAtReturn).toBe(true);
    expect(inspect(paths).trusted).toBe(true);
  });

  it("refuses as preflight changed a raw change to the database made inside the backup function, with nothing written",async()=>{
    const paths=baseline28(),calls:string[]=[];
    let changed:ReturnType<typeof untouched>|undefined;
    const backup=controllerBackup(paths,calls);
    expect(await refusal(()=>establish(paths,async(source,context)=>{
      const created=await backup(source,context);
      const bytes=readFileSync(paths.databasePath);bytes.writeUInt32BE((bytes.readUInt32BE(24)+7)>>>0,24);writeFileSync(paths.databasePath,bytes);
      changed=untouched(paths);return created;
    }))).toMatchObject({name:"SecurityFenceError",code:"security_fence_preflight_changed",committed:false});
    expect(untouched(paths)).toEqual(changed);
    expect(changed?.security).toBe("missing");
    // The backup was taken and stays valid; a new preflight establishes.
    expect(()=>validateBackup(calls[0]!,parseManifest(readBoundedJson(join(calls[0]!,"manifest.json"),BACKUP_LIMITS.manifestBytes,true)),true)).not.toThrow();
    expect(await establish(paths,controllerBackup(paths))).toMatchObject({trusted:true,changed:true});
  });

  it("fails the backup before any pending witness, and keeps the valid backup when the pending witness fails after it",async()=>{
    const paths=baseline28(),before=untouched(paths),content=read(paths,all);
    const begin=vi.spyOn(SecurityFence,"beginMaintenance");
    expect(await refusal(()=>establish(paths,async()=>{throw new Error("fixture backup fault");}))).toEqual(BACKUP_REFUSED);
    expect(begin).not.toHaveBeenCalled();
    expect(fs.existsSync(securityFenceRoot(paths.databasePath))).toBe(false);
    expect(untouched(paths)).toEqual(before);
    vi.restoreAllMocks();
    // A failure at the pending witness, after it was published: the backup taken before stays.
    const original=SecurityFence.beginMaintenance,calls:string[]=[];
    vi.spyOn(SecurityFence,"beginMaintenance").mockImplementation((...args)=>{original(...args);throw new Error("fixture pending witness fault");});
    expect(await refusal(()=>establish(paths,controllerBackup(paths,calls)))).toMatchObject({name:"SecurityFenceError",code:"security_fence_pending",committed:false});
    vi.restoreAllMocks();
    expect(calls).toHaveLength(1);
    const manifest=parseManifest(readBoundedJson(join(calls[0]!,"manifest.json"),BACKUP_LIMITS.manifestBytes,true));
    expect(()=>validateBackup(calls[0]!,manifest,true)).not.toThrow();
    const copy=new Database(join(calls[0]!,"state.sqlite3"),{readonly:true,fileMustExist:true});
    try{expect(all(copy)).toEqual(content);}finally{copy.close();}
    expect(read(paths,all)).toEqual(content);
    expect(witnessState(paths)).toBe("pending");
    expect(inspect(paths)).toMatchObject({trusted:false,establishmentAllowed:false});
    expect(resume(paths)).toMatchObject({trusted:true,quarantined:true});
  });

  it("takes no backup for the trusted no-op, and accepts no backup for inspect or resume",async()=>{
    const f=fixture();f.store.close();
    const backup=vi.fn<MaintenanceBackup>(async()=>{throw new Error("not called");});
    // The store's WAL database: its shared-memory index may change on a read-only open, so the database bytes and the witness compare.
    const status=inspect(f.paths),before=sha(f.paths.databasePath),witnessBytes=readFileSync(witness(f.paths.databasePath));
    expect(await establishSqliteSecurityFence(f.paths,{action:"establish",expect:status.preflight},HANDOFF,backup)).toMatchObject({trusted:true,changed:false,backup:null});
    expect(backup).not.toHaveBeenCalled();
    const invalid=[{action:"inspect"},{action:"resume",expect:status.preflight,mode:"token"},{action:"establish",expect:"NOT-A-HASH"}] as unknown as Array<{action:"establish";expect:string}>;
    for(const command of invalid)expect(()=>establishSqliteSecurityFence(f.paths,command,HANDOFF,backup)).toThrowError(expect.objectContaining({code:"invalid_input"}));
    expect(()=>establishSqliteSecurityFence(f.paths,{action:"establish",expect:status.preflight},HANDOFF,undefined as unknown as MaintenanceBackup)).toThrowError(expect.objectContaining({code:"invalid_input"}));
    expect(backup).not.toHaveBeenCalled();
    expect(sha(f.paths.databasePath)).toBe(before);
    expect(readFileSync(witness(f.paths.databasePath))).toEqual(witnessBytes);
  });
});
