import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../src/server/infrastructure/sqlite/migration-registry";

const exec=promisify(execFile);
const cli=resolve("dist/cli/index.js");
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(withDatabase=true) {
  const root=mkdtempSync(join(tmpdir(),"built-sqlite-safety-"));roots.push(root);
  const data=join(root,"data"),state=join(root,"state"),backup=join(root,"backup");
  if(withDatabase){mkdirSync(data,{mode:0o700});const db=new Database(join(data,"state.sqlite3"));try{db.exec(readFileSync(resolve("src/server/infrastructure/sqlite/fixtures/schema-v12.sql"),"utf8"));}finally{db.close();}}
  const args=["--data-dir",data,"--state-dir",state];
  const env={NODE_ENV:"test" as const,HOME:root,PATH:process.env.PATH,LANG:"C.UTF-8",XDG_CONFIG_HOME:join(root,"config")};
  return {root,data,state,backup,args,env,database:join(data,"state.sqlite3")};
}
async function run(f:ReturnType<typeof fixture>,args:string[]){return exec(process.execPath,[cli,...args,...f.args],{env:f.env,timeout:15000});}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,"exit");child.kill("SIGTERM");await ended;}
async function port():Promise<number>{return new Promise((accept,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string")throw Error("No fixture port");server.close(error=>error?reject(error):accept(address.port));});});}

describe("built SQLite safety CLI",()=>{
  it("restores over interrupted initialization and starts the recovered database through offline CLI", async () => {
    const source = fixture(false);
    await run(source, ["auth", "status"]);
    await run(source, ["backup", "create", source.backup]);
    const target = fixture(false);
    // Isolated state at the initialization boundary; only the built CLI consumes it.
    mkdirSync(target.data, {mode:0o700});
    writeFileSync(target.database, "", {mode:0o600});
    const {dev, ino} = lstatSync(target.database);
    writeFileSync(`${target.database}.initializing`, JSON.stringify({format:1,device:dev,inode:ino}), {mode:0o600});
    writeFileSync(`${target.database}-journal`, Buffer.alloc(512), {mode:0o600});
    expect((await run(target, ["backup", "restore", source.backup])).stdout).toContain("Backup restored.");
    for (const suffix of [".initializing", "-journal", ".owner.lock"]) expect(existsSync(`${target.database}${suffix}`)).toBe(false);
    // The restored store is fenced: nothing resumes it except the protected offline ceremony.
    await expect(run(target, ["auth", "status"])).rejects.toMatchObject({ stderr: expect.stringContaining("security_fence_recovery_required") });
    const inspection = JSON.parse((await run(target, ["auth", "fence", "inspect"])).stdout) as { code: string; trusted: boolean; preflight: string; establishmentAllowed: boolean };
    expect(inspection).toMatchObject({ code: "security_fence_recovery_required", trusted: false, establishmentAllowed: false });
    expect(inspection.preflight).toMatch(/^[0-9a-f]{64}$/);
    // Establishment is not a recovery path; it is refused on a restored store.
    await expect(run(target, ["auth", "fence", "establish", "--expect", inspection.preflight])).rejects.toMatchObject({ stderr: expect.stringContaining("security_fence_recovery_required") });
    const receipt = JSON.parse((await run(target, ["auth", "fence", "resume", "--expect", inspection.preflight, "--mode", "token"])).stdout) as { trusted: boolean; quarantined: boolean };
    expect(receipt).toMatchObject({ trusted: true, quarantined: true });
    expect((await run(target, ["auth", "status"])).stdout).toContain('"mode": "token"');
  });
  it("offline CLI creates private data and copies under umask 000",async()=>{
    const f=fixture(false);
    const broad=async(args:string[])=>exec(process.execPath,["--input-type=module","-e",
      "const args=JSON.parse(process.argv[1]); const module=process.argv[2]; process.umask(0); process.argv=[process.execPath,...args]; await import(module);",
      JSON.stringify([cli,...args,...f.args]),new URL(`file://${cli}`).href],{env:f.env,timeout:15000});
    await broad(["auth","status"]);
    await broad(["backup","create",f.backup]);
    for(const file of [f.database,join(f.backup,"state.sqlite3"),join(f.backup,"manifest.json")]) expect(lstatSync(file).mode&0o777).toBe(0o600);
    for(const dir of [f.data,f.state,f.backup]) expect(lstatSync(dir).mode&0o777).toBe(0o700);
  });
  it("manual backup through built CLI path flags preserves the old schema",async()=>{
    const f=fixture();const before=readFileSync(f.database);
    await run(f,["backup","create",f.backup]);
    expect(readFileSync(f.database)).toEqual(before);
    expect(JSON.parse(readFileSync(join(f.backup,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);
  });
  it.each(["start","service"])("invalid backup flags on %s do not create data or service files",async command=>{
    const f=fixture(false);
    await expect(run(f,[command,...(command==="service"?["install"]:[]),"--backup-before-migration"])).rejects.toMatchObject({stderr:expect.stringContaining("requires --backup-dir")});
    expect(existsSync(f.data)).toBe(false);expect(existsSync(f.state)).toBe(false);expect(existsSync(join(f.root,"config"))).toBe(false);
  });
  it("required backup failure stops the built startup before schema and authentication changes",async()=>{
    const f=fixture();writeFileSync(f.backup,"not a directory");const before=readFileSync(f.database);
    await expect(run(f,["start","--no-open","--no-mcp","--backup-before-migration","--backup-dir",f.backup])).rejects.toThrow();
    expect(readFileSync(f.database)).toEqual(before);
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
    expect(existsSync(join(f.state,"service-access.json"))).toBe(false);
  });
  it.each([false,true])("keeps the configured pre-migration backup when startup refuses an unestablished schema-12 store, then starts after explicit establishment (enabled=%s)",async enabled=>{
    const f=fixture();const backupFlags=enabled?["--backup-before-migration","--backup-dir",f.backup]:[];
    const schemaVersion=()=>{const db=new Database(f.database,{readonly:true});try{return (db.prepare("SELECT max(version) version FROM schema_migrations").get() as {version:number}).version;}finally{db.close();}};
    const backups=()=>existsSync(f.backup)?readdirSync(f.backup):null;
    // First owner: the configured verified backup precedes every migration effect, then the fence refuses adoption.
    const refused=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(await port()),...backupFlags,...f.args],{env:f.env,stdio:["ignore","ignore","pipe"]});
    let stderr="";refused.stderr!.setEncoding("utf8").on("data",chunk=>{stderr+=chunk;});
    const [code]=await Promise.race([once(refused,"exit"),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("Refused startup did not exit")),15000))]);
    expect(code).toBe(1);expect(stderr).toContain("security_fence_establishment_required");
    expect(existsSync(join(f.state,"service-access.json"))).toBe(false);
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
    // Nothing migrated: the refusal happened before any write.
    expect(schemaVersion()).toBe(12);
    if(enabled){const copies=backups()!;expect(copies).toHaveLength(1);expect(copies[0]).toMatch(/^pre-migration-v12-/);expect(JSON.parse(readFileSync(join(f.backup,copies[0],"manifest.json"),"utf8")).database.schemaVersion).toBe(12);}
    else expect(backups()).toBeNull();
    // The explicit protected act; the backup flag never substitutes for it.
    const inspection=JSON.parse((await run(f,["auth","fence","inspect"])).stdout) as {code:string;establishmentAllowed:boolean;preflight:string};
    expect(inspection).toMatchObject({code:"security_fence_establishment_required",establishmentAllowed:true});
    expect(JSON.parse((await run(f,["auth","fence","establish","--expect",inspection.preflight])).stdout)).toMatchObject({trusted:true,quarantined:false});
    const httpPort=await port();
    const child=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(httpPort),...backupFlags,...f.args],{env:f.env,stdio:"ignore"});
    try {
      const deadline=Date.now()+15000;
      while(!existsSync(join(f.state,"service-access.json"))){if(child.exitCode!==null)throw Error(`Fixture exited: ${child.exitCode}`);if(Date.now()>deadline)throw Error("Fixture startup timed out");await new Promise(accept=>setTimeout(accept,30));}
      expect((await fetch(`http://127.0.0.1:${httpPort}/`)).status).toBe(200);
      const access=JSON.parse(readFileSync(join(f.state,"service-access.json"),"utf8"));expect(access.authenticationMode).toBe("legacy");
      // The schema-12 copy is retained; a current store has nothing left to back up.
      if(enabled)expect(backups()).toHaveLength(1);else expect(backups()).toBeNull();
    } finally {await stop(child);}
    expect(schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  });
  it("fences an old store until the protected establishment ceremony, preserving a schema-12 offline backup",async()=>{
    const f=fixture();
    // An old store is fenced: no transport may adopt it before the explicit protected act.
    await expect(run(f,["auth","status"])).rejects.toMatchObject({stderr:expect.stringContaining("security_fence_establishment_required")});
    // The offline backup captures the untouched old schema before any migration runs.
    await run(f,["backup","create",f.backup]);
    expect(JSON.parse(readFileSync(join(f.backup,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);
    const inspection=JSON.parse((await run(f,["auth","fence","inspect"])).stdout) as {code:string;trusted:boolean;preflight:string;establishmentAllowed:boolean};
    expect(inspection).toMatchObject({code:"security_fence_establishment_required",trusted:false,establishmentAllowed:true});
    expect(inspection.preflight).toMatch(/^[0-9a-f]{64}$/);
    // The explicit establishment migrates the old store to the supported schema.
    const established=JSON.parse((await run(f,["auth","fence","establish","--expect",inspection.preflight])).stdout) as {trusted:boolean;quarantined:boolean};
    expect(established).toMatchObject({trusted:true,quarantined:false});
    const httpPort=await port();
    const child=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(httpPort),...f.args],{env:f.env,stdio:"ignore"});
    try {
      const deadline=Date.now()+15000;
      while(!existsSync(join(f.state,"service-access.json"))){if(child.exitCode!==null)throw Error(`Fixture exited: ${child.exitCode}`);if(Date.now()>deadline)throw Error("Fixture startup timed out");await new Promise(accept=>setTimeout(accept,30));}
      expect((await fetch(`http://127.0.0.1:${httpPort}/`)).status).toBe(200);
      const access=JSON.parse(readFileSync(join(f.state,"service-access.json"),"utf8"));expect(access.authenticationMode).toBe("legacy");
      // The pre-establishment offline backup still proves the old schema.
      expect(JSON.parse(readFileSync(join(f.backup,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);
    } finally {await stop(child);}
    const db=new Database(f.database,{readonly:true});try{expect(db.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({version:SUPPORTED_SCHEMA_VERSION});}finally{db.close();}
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  });
});

it("built offline restore retains durable proof and rejects a corrupt journal before auth startup", async () => {
  const f = fixture(); await run(f, ["backup", "create", f.backup]); await run(f, ["backup", "restore", f.backup]);
  const journal = join(`${f.database}.restore`, "journal.json"), receipt = JSON.parse(readFileSync(journal, "utf8"));
  expect(receipt.payload).toMatchObject({ state: "verified", completed: 8, actor: { backupId: "offline-cli" } });
  expect(existsSync(join(`${f.database}.restore`, "previous", "0"))).toBe(true);
  const records = readdirSync(`${f.database}.restore-requests`); expect(records).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(`${f.database}.restore-requests`, records[0]), "utf8")).payload.state).toBe("verified");
  writeFileSync(journal, "{broken", { mode: 0o600 }); const before = readFileSync(f.database);
  await expect(run(f, ["auth", "status"])).rejects.toMatchObject({ stderr: expect.stringContaining("Restore recovery stopped") });
  expect(readFileSync(f.database)).toEqual(before); expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  expect(existsSync(join(`${f.database}.restore`, "previous", "0"))).toBe(true);
});
