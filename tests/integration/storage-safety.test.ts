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
    // Establishment is not a recovery path; it is refused on a restored store (with its backup directory, so the refusal is the fence's).
    await expect(run(target, ["auth", "fence", "establish", "--expect", inspection.preflight, "--backup-dir", join(target.root, "refused")])).rejects.toMatchObject({ stderr: expect.stringContaining("security_fence_recovery_required") });
    expect(existsSync(join(target.root, "refused"))).toBe(false);
    const receipt = JSON.parse((await run(target, ["auth", "fence", "resume", "--expect", inspection.preflight, "--mode", "token"])).stdout) as { trusted: boolean; quarantined: boolean; nextStep: string };
    expect(receipt).toMatchObject({ trusted: true, quarantined: true, nextStep: "upgrade inspect" });
    // The resumed store needs the explicit upgrade before any ordinary access.
    await expect(run(target, ["auth", "status"])).rejects.toMatchObject({ stderr: expect.stringContaining('"code":"upgrade_required"') });
    const upgrade = JSON.parse((await run(target, ["upgrade", "inspect"])).stdout) as { state: string; planHash: string };
    expect(upgrade.state).toBe("upgrade_needed");
    expect(JSON.parse((await run(target, ["upgrade", "apply", "--expect", upgrade.planHash, "--backup-dir", join(target.root, "maintenance")])).stdout)).toMatchObject({ state: "current" });
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
  it("the deprecated pre-migration flag takes no copy, and startup refuses an unestablished store before schema and authentication changes",async()=>{
    const f=fixture();const before=readFileSync(f.database);
    await expect(run(f,["start","--no-open","--no-mcp","--backup-before-migration","--backup-dir",f.backup])).rejects.toMatchObject({stderr:expect.stringContaining("--backup-before-migration is deprecated and takes no copy")});
    expect(existsSync(f.backup)).toBe(false);
    expect(readFileSync(f.database)).toEqual(before);
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
    expect(existsSync(join(f.state,"service-access.json"))).toBe(false);
  });
  it.each([false,true])("refuses an unestablished schema-12 store without any copy, establishes it with a pre-establishment backup, refuses it as upgrade_required, then starts after the explicit upgrade (deprecated flag=%s)",async deprecated=>{
    const f=fixture();const flags=deprecated?["--backup-before-migration","--backup-dir",f.backup]:[];
    const maintenance=join(f.root,"maintenance");
    const schemaVersion=()=>{const db=new Database(f.database,{readonly:true});try{return (db.prepare("SELECT max(version) version FROM schema_migrations").get() as {version:number}).version;}finally{db.close();}};
    const refusedStart=async(expected:string)=>{
      const refused=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(await port()),...flags,...f.args],{env:f.env,stdio:["ignore","ignore","pipe"]});
      let stderr="";refused.stderr!.setEncoding("utf8").on("data",chunk=>{stderr+=chunk;});
      const [code]=await Promise.race([once(refused,"exit"),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error("Refused startup did not exit")),15000))]);
      expect(code).toBe(1);expect(stderr).toContain(expected);
      expect(stderr.includes("--backup-before-migration is deprecated")).toBe(deprecated);
      expect(existsSync(join(f.state,"service-access.json"))).toBe(false);
      expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
      // The flag takes no copy.
      expect(existsSync(f.backup)).toBe(false);
    };
    // A pre-fence store: refused before any write.
    const before=readFileSync(f.database);
    await refusedStart("security_fence_establishment_required");
    expect(readFileSync(f.database)).toEqual(before);expect(schemaVersion()).toBe(12);
    // The explicit protected act, with its backup of the untouched schema 12.
    const inspection=JSON.parse((await run(f,["auth","fence","inspect"])).stdout) as {code:string;establishmentAllowed:boolean;preflight:string};
    expect(inspection).toMatchObject({code:"security_fence_establishment_required",establishmentAllowed:true});
    const established=JSON.parse((await run(f,["auth","fence","establish","--expect",inspection.preflight,"--backup-dir",maintenance])).stdout) as {backup:string};
    expect(established).toMatchObject({trusted:true,quarantined:false,schemaVersion:SUPPORTED_SCHEMA_VERSION,nextStep:"upgrade inspect"});
    expect(JSON.parse(readFileSync(join(established.backup,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);
    // Established but not upgraded: refused with upgrade_required, nothing written.
    const establishedBytes=readFileSync(f.database);
    await refusedStart('"code":"upgrade_required"');
    expect(readFileSync(f.database)).toEqual(establishedBytes);
    const upgrade=JSON.parse((await run(f,["upgrade","inspect"])).stdout) as {state:string;planHash:string};
    expect(upgrade.state).toBe("upgrade_needed");
    const applied=JSON.parse((await run(f,["upgrade","apply","--expect",upgrade.planHash,"--backup-dir",maintenance])).stdout) as {backup:string};
    expect(applied).toMatchObject({state:"current",planHash:upgrade.planHash});
    expect(readdirSync(maintenance).sort()).toEqual([expect.stringMatching(/^pre-establishment-v12-/),expect.stringMatching(new RegExp(`^pre-upgrade-v${SUPPORTED_SCHEMA_VERSION}-`))].sort());
    const httpPort=await port();
    const child=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(httpPort),...flags,...f.args],{env:f.env,stdio:"ignore"});
    try {
      const deadline=Date.now()+15000;
      while(!existsSync(join(f.state,"service-access.json"))){if(child.exitCode!==null)throw Error(`Fixture exited: ${child.exitCode}`);if(Date.now()>deadline)throw Error("Fixture startup timed out");await new Promise(accept=>setTimeout(accept,30));}
      expect((await fetch(`http://127.0.0.1:${httpPort}/`)).status).toBe(200);
      // The upgrade keeps the mode.
      const access=JSON.parse(readFileSync(join(f.state,"service-access.json"),"utf8"));expect(access.authenticationMode).toBe("legacy");
      expect(existsSync(f.backup)).toBe(false);
    } finally {await stop(child);}
    expect(schemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  });
  it("fences an old store until the protected establishment and the upgrade, preserving a schema-12 offline backup",async()=>{
    const f=fixture();
    // An old store is fenced: no transport may adopt it before the explicit protected act.
    await expect(run(f,["auth","status"])).rejects.toMatchObject({stderr:expect.stringContaining("security_fence_establishment_required")});
    // The offline backup captures the untouched old schema before any migration runs.
    await run(f,["backup","create",f.backup]);
    expect(JSON.parse(readFileSync(join(f.backup,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);
    const inspection=JSON.parse((await run(f,["auth","fence","inspect"])).stdout) as {code:string;trusted:boolean;preflight:string;establishmentAllowed:boolean};
    expect(inspection).toMatchObject({code:"security_fence_establishment_required",trusted:false,establishmentAllowed:true});
    expect(inspection.preflight).toMatch(/^[0-9a-f]{64}$/);
    // The explicit establishment migrates the old store's structure to the supported schema, marker pending; the upgrade completes it.
    const established=JSON.parse((await run(f,["auth","fence","establish","--expect",inspection.preflight,"--backup-dir",join(f.root,"maintenance")])).stdout) as {trusted:boolean;quarantined:boolean};
    expect(established).toMatchObject({trusted:true,quarantined:false,nextStep:"upgrade inspect"});
    const upgrade=JSON.parse((await run(f,["upgrade","inspect"])).stdout) as {planHash:string};
    await run(f,["upgrade","apply","--expect",upgrade.planHash,"--backup-dir",join(f.root,"maintenance")]);
    const httpPort=await port();
    const child=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(httpPort),...f.args],{env:f.env,stdio:"ignore"});
    try {
      const deadline=Date.now()+15000;
      while(!existsSync(join(f.state,"service-access.json"))){if(child.exitCode!==null)throw Error(`Fixture exited: ${child.exitCode}`);if(Date.now()>deadline)throw Error("Fixture startup timed out");await new Promise(accept=>setTimeout(accept,30));}
      expect((await fetch(`http://127.0.0.1:${httpPort}/`)).status).toBe(200);
      const access=JSON.parse(readFileSync(join(f.state,"service-access.json"),"utf8"));expect(access.authenticationMode).toBe("legacy");
      // The offline backup still proves the old schema.
      expect(JSON.parse(readFileSync(join(f.backup,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);
    } finally {await stop(child);}
    const db=new Database(f.database,{readonly:true});try{expect(db.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({version:SUPPORTED_SCHEMA_VERSION});}finally{db.close();}
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  });
});
