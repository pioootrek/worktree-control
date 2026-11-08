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
import { securityFenceRoot } from "./security-fence";
import { AuthenticationService } from "../../modules/authentication";
import { IdentityService } from "../../modules/identity";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { securityTriggers } from "./security-fence-migration";
import { inspectSchema } from "./schema-inspection";

vi.mock("node:fs", async original=>({...await original<typeof import("node:fs")>()}));
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

describe("external security checkpoint",()=>{
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
