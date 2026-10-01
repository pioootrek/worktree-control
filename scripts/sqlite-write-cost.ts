import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { strict as assert } from "node:assert";
import { OwnedSqliteDatabase, SqliteStateStore } from "../src/server/infrastructure/sqlite";

function measureWriteCost(): void {
  const results: Array<{ mode: string; operation: string; n: number; p50Ms: number; p95Ms: number; totalMs: number }> = [];
  let sqliteVersion = "";
  for (const mode of ["NORMAL", "FULL", "FULL", "NORMAL", "NORMAL", "FULL"]) {
    const root = mkdtempSync(join(dirname(process.cwd()), "sqlite-cost-"));
    const owned = new OwnedSqliteDatabase(join(root,"state.sqlite3"), true);
    const store = new SqliteStateStore(join(root,"state.sqlite3"), owned);
    try {
      // Only this disposable benchmark connection changes mode. Application opens always require FULL.
      owned.database.pragma(`synchronous = ${mode}`);
      assert.equal(owned.database.pragma("synchronous", { simple: true }), mode === "FULL" ? 2 : 1);
      sqliteVersion = (owned.database.prepare("SELECT sqlite_version() version").get() as {version:string}).version;
      for (const operation of ["project registration", "auth policy and audit transaction"]) {
        const samples: number[] = [];
        for(let i=0;i<220;i++) {
          const start=performance.now();
          if(operation==="project registration") store.addProject({name:`Project ${i}`, repositoryPath:join(root,`repo-${i}`), port:30000+i, executable:"pnpm", args:["dev"]});
          else store.saveAuthenticationPolicy({mode:"token",token:null,generation:i},"benchmark","isolated");
          if(i>=20) samples.push(performance.now()-start);
        }
        samples.sort((a,b)=>a-b);
        results.push({mode,operation,n:samples.length,p50Ms:samples[100],p95Ms:samples[190],totalMs:samples.reduce((a,b)=>a+b,0)});
      }
    } finally {store.close();rmSync(root,{recursive:true,force:true});}
  }
  console.log("SQLITE_WRITE_COST "+JSON.stringify({sqliteVersion,nodeVersion:process.version,directory:"repository parent filesystem (not OS tmpfs)",results}));
}

measureWriteCost();
