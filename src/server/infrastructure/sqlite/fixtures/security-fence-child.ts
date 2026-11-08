import { createRequire, syncBuiltinESMExports } from "node:module";
const require=createRequire(import.meta.url), fs=require("node:fs") as typeof import("node:fs");
const [path,edge]=process.argv.slice(2);
const original=fs.renameSync;
if(edge?.startsWith("resume-")) {
  if(edge==="resume-transaction") {
    const Database=require("better-sqlite3") as typeof import("better-sqlite3");
    const exec=Database.prototype.exec;
    Database.prototype.exec=function(source:string){const result=exec.call(this,source);if(source.includes("UPDATE principal_credentials SET status='revoked'")){fs.writeSync(1,"crash-boundary\n");process.kill(process.pid,"SIGKILL");}return result;};
  }
  fs.renameSync=((from:string,to:string)=>{
    const record=to===`${path}.security/witness.json`?JSON.parse(fs.readFileSync(from,"utf8")).payload:null;
    if(edge==="resume-committed"&&record?.state==="confirmed"){fs.writeSync(1,"crash-boundary\n");process.kill(process.pid,"SIGKILL");}
    original(from,to);
    if(edge==="resume-pending"&&record?.state==="pending"){fs.writeSync(1,"crash-boundary\n");process.kill(process.pid,"SIGKILL");}
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  const {maintainSecurityFence}=await import("../../../bootstrap/security-maintenance");
  const {resolveAppPaths}=await import("../../../paths");
  const {dirname}=await import("node:path");
  const paths={...resolveAppPaths(dirname(path!)),databasePath:path!};
  const status=maintainSecurityFence(paths,{action:"inspect"});
  maintainSecurityFence(paths,{action:"resume",expect:status.preflight,mode:"token"});
  fs.writeSync(1,"crash-boundary\n");process.kill(process.pid,"SIGKILL");
}

if(edge==="committed") {
  fs.renameSync=((from: string,to:string)=>{
    if(to===`${path}.security/witness.json` && JSON.parse(fs.readFileSync(from,"utf8")).payload.state==="confirmed") {
      fs.writeSync(1,"crash-boundary\n"); process.kill(process.pid,"SIGKILL");
    }
    return original(from,to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
}
const {SqliteStateStore}=await import("../sqlite-state-store");
const store=new SqliteStateStore(path!);
const s=store.authenticationProviderStorage();
await s.borrow(async()=>{
  const c=s.createProviderConnection();
  c.prepare("BEGIN IMMEDIATE").run([]);
  c.prepare("INSERT INTO remote_principals VALUES('child-revoked','agent','revoked')").run([]);
  if(edge==="transaction")process.stdout.write("crash-boundary\n",()=>process.kill(process.pid,"SIGKILL"));
  if(edge==="transaction")await new Promise(()=>{setInterval(()=>{},1000);});
  c.prepare("COMMIT").run([]);
  c.close();
});
process.stdout.write("crash-boundary\n",()=>process.kill(process.pid,"SIGKILL"));
setInterval(()=>{},1000);
