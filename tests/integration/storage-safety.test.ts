import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const exec=promisify(execFile);
const cli=resolve("dist/cli/index.js");
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(withDatabase=true) {
  const root=mkdtempSync(join(tmpdir(),"built-sqlite-safety-"));roots.push(root);
  const data=join(root,"data"),state=join(root,"state"),backup=join(root,"backup");
  if(withDatabase){mkdirSync(data,{mode:0o700});const db=new Database(join(data,"state.sqlite3"));try{db.exec(readFileSync(resolve("src/server/infrastructure/sqlite/fixtures/schema-v12.sql"),"utf8"));}finally{db.close();}}
  const args=["--data-dir",data,"--state-dir",state];
  const env={HOME:root,PATH:process.env.PATH,LANG:"C.UTF-8",XDG_CONFIG_HOME:join(root,"config")};
  return {root,data,state,backup,args,env,database:join(data,"state.sqlite3")};
}
async function run(f:ReturnType<typeof fixture>,args:string[]){return exec(process.execPath,[cli,...args,...f.args],{env:f.env,timeout:15000});}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,"exit");child.kill("SIGTERM");await ended;}
async function port():Promise<number>{return new Promise((accept,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const address=server.address();if(!address||typeof address==="string")throw Error("No fixture port");server.close(error=>error?reject(error):accept(address.port));});});}

describe("built SQLite safety CLI",()=>{
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
  it.each([false,true])("starts and stops an isolated migrated controller with pre-migration backup enabled=%s",async enabled=>{
    const f=fixture();const httpPort=await port();
    const child=spawn(process.execPath,[cli,"start","--service-mode","--no-open","--no-mcp","--host","127.0.0.1","--port",String(httpPort),...f.args,...(enabled?["--backup-before-migration","--backup-dir",f.backup]:[])],{env:f.env,stdio:"ignore"});
    try {
      const deadline=Date.now()+15000;
      while(!existsSync(join(f.state,"service-access.json"))){if(child.exitCode!==null)throw Error(`Fixture exited: ${child.exitCode}`);if(Date.now()>deadline)throw Error("Fixture startup timed out");await new Promise(accept=>setTimeout(accept,30));}
      expect((await fetch(`http://127.0.0.1:${httpPort}/`)).status).toBe(200);
      const access=JSON.parse(readFileSync(join(f.state,"service-access.json"),"utf8"));expect(access.authenticationMode).toBe("legacy");
      if(enabled){const [copy]=readdirSync(f.backup);expect(JSON.parse(readFileSync(join(f.backup,copy,"manifest.json"),"utf8")).database.schemaVersion).toBe(12);}else expect(existsSync(f.backup)).toBe(false);
    } finally {await stop(child);}
    const db=new Database(f.database,{readonly:true});try{expect(db.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({version:27});}finally{db.close();}
    expect(existsSync(join(f.state,"controller.lock"))).toBe(false);expect(existsSync(`${f.database}.owner.lock`)).toBe(false);
  });
});
