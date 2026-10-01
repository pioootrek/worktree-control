import { fork } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControllerBackup } from "@/server/controller-backup";
import { OwnedSqliteDatabase, SqliteStateStore } from "./index";
import { assertDurability } from "./database-validation";
import { registryChecksum, registryMigration } from "./migration-registry";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(version?: 12 | 24 | 26) {
  const root = mkdtempSync(join(tmpdir(), "sqlite-durability-")); roots.push(root);
  const path = join(root, "data", "state.sqlite3");
  if (version) {
    mkdirSync(join(root, "data"), { mode: 0o700 });
    const db = new Database(path);
    try { db.exec(readFileSync(new URL(`./fixtures/schema-v${version}.sql`, import.meta.url), "utf8")); }
    finally { db.close(); }
  }
  return { root, path };
}
function raw(path: string, operation: (db: Database.Database) => void) {
  const db = new Database(path); try { operation(db); } finally { db.close(); }
}
function released(path: string) { expect(existsSync(`${path}.owner.lock`)).toBe(false); }

describe("durable SQLite initialization and migration", () => {
  it.each([undefined, 12, 24, 26] as const)("initializes/upgrades %s with verified FULL and honest provenance", version => {
    const f = fixture(version);
    const owned = new OwnedSqliteDatabase(f.path, true);
    const store = new SqliteStateStore(f.path, owned);
    try {
      assertDurability(owned.database);
      expect(store.schemaVersion()).toBe(28);
      expect(store.getAuthenticationPolicy().mode).toBe(version && version < 25 ? "legacy" : "token");
      expect(owned.database.prepare("SELECT name,checksum FROM schema_migrations WHERE version<28").all()).toEqual(Array.from({length:27},()=>({name:null,checksum:null})));
      expect(owned.database.prepare("SELECT name,checksum FROM schema_migrations WHERE version=28").get()).toEqual({name:registryMigration.name,checksum:registryChecksum});
    } finally { store.close(); }
    expect(existsSync(`${f.path}.initializing`)).toBe(false);
    new SqliteStateStore(f.path).close();
    released(f.path);
  });

  it.each(["checksum", "name", "gap", "legacy-provenance", "missing-policy"])("rejects inconsistent %s without resetting auth or data", variant => {
    const f=fixture(); new SqliteStateStore(f.path).close();
    raw(f.path,db=>{
      if(variant==="checksum") db.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=28");
      if(variant==="name") db.exec("UPDATE schema_migrations SET name='wrong' WHERE version=28");
      if(variant==="gap") db.exec("DELETE FROM schema_migrations WHERE version=7");
      if(variant==="legacy-provenance") db.exec("UPDATE schema_migrations SET checksum='invented' WHERE version=27");
      if(variant==="missing-policy") db.exec("DELETE FROM controller_settings WHERE key='authentication'");
    });
    const before=readFileSync(f.path);
    expect(()=>new SqliteStateStore(f.path)).toThrow();
    expect(readFileSync(f.path)).toEqual(before); released(f.path);
  });

  it("rejects an unmarked empty file and partial DDL, preserving them",()=>{
    const f=fixture();mkdirSync(join(f.root,"data"),{mode:0o700});writeFileSync(f.path,"",{mode:0o600});
    expect(()=>new SqliteStateStore(f.path)).toThrow(/empty database/);
    raw(f.path,db=>db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)"));
    const before=readFileSync(f.path);expect(()=>new SqliteStateStore(f.path)).toThrow(/unrecognized/);
    expect(readFileSync(f.path)).toEqual(before);released(f.path);
  });

  it.each([false,true])("rolls back all DDL and migration records after a late failure (fresh=%s) and retries",fresh=>{
    const f=fixture(fresh?undefined:26),owned=new OwnedSqliteDatabase(f.path,true);
    const original=Database.prototype.exec;
    const spy=vi.spyOn(Database.prototype,"exec").mockImplementation(function(this: Database.Database, sql){
      const result=original.call(this,sql);if(sql.includes("ADD COLUMN checksum"))throw Error("injected failure after new DDL");return result;
    });
    expect(()=>new SqliteStateStore(f.path,owned)).toThrow(/injected failure/);
    spy.mockRestore();released(f.path);
    raw(f.path,db=>{
      if(fresh) expect(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([]);
      else {expect(db.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({version:26});expect(db.prepare("PRAGMA table_info(schema_migrations)").all()).toHaveLength(2);}
    });
    const retried=new SqliteStateStore(f.path);expect(retried.getAuthenticationPolicy().mode).toBe("token");retried.close();
  });

  it.each(["fresh","migration"])("recovers a real SIGKILL during uncommitted %s without auth downgrade",async stage=>{
    const f=fixture(stage==="fresh"?undefined:26);
    const child=fork(fileURLToPath(new URL("./fixtures/initialization-crash-worker.ts",import.meta.url)),[f.path,stage],{execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]});
    try {
      const [message]=await once(child,"message",{signal:AbortSignal.timeout(5000)});expect(message).toEqual({interrupted:true});
    } finally { const ended=once(child,"exit");child.kill("SIGKILL");await ended; }
    const retry=new SqliteStateStore(f.path);try{expect(retry.schemaVersion()).toBe(28);expect(retry.getAuthenticationPolicy().mode).toBe("token");}finally{retry.close();}
    released(f.path);
  },10000);

  it.each(["fk","integrity","policy","reply-project"])("rejects %s failures and releases resources",kind=>{
    const f=fixture();new SqliteStateStore(f.path).close();
    raw(f.path,db=>{
      if(kind==="fk") db.exec("PRAGMA foreign_keys=OFF; INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at) VALUES('bad','missing','agent_token','x','x',printf('%064d',0),'active','now')");
      if(kind==="integrity") db.exec("PRAGMA ignore_check_constraints=ON; UPDATE remote_principals SET status='broken'");
      if(kind==="policy") db.exec("UPDATE controller_settings SET value_json='{}' WHERE key='authentication'");
      if(kind==="reply-project") db.exec("INSERT INTO knowledge_projects VALUES('k','K','active',1,'now','now'); INSERT INTO knowledge_projects VALUES('other','Other','active',1,'now','now'); INSERT INTO knowledge_threads VALUES('t','other','T','B',1,'installation','now','now'); INSERT INTO knowledge_replies VALUES('r','k','t','B',1,'installation','now','now')");
    });
    const before=readFileSync(f.path);expect(()=>new SqliteStateStore(f.path)).toThrow();expect(readFileSync(f.path)).toEqual(before);released(f.path);
    raw(f.path,db=>{db.exec("DELETE FROM principal_credentials; DELETE FROM knowledge_relations; DELETE FROM knowledge_replies; UPDATE remote_principals SET status='active'; UPDATE controller_settings SET value_json='{\"mode\":\"token\",\"token\":null,\"generation\":0}' WHERE key='authentication'");});
    new SqliteStateStore(f.path).close();
  });

  it.each(["foreign-key", "integrity"])("rolls back a %s failure detected after migration DDL", kind => {
    const f = fixture(26), owned = new OwnedSqliteDatabase(f.path);
    const original = Database.prototype.exec;
    const spy = vi.spyOn(Database.prototype, "exec").mockImplementation(function(this: Database.Database, sql) {
      const result = original.call(this, sql);
      if (sql.includes("ADD COLUMN checksum")) {
        if (kind === "foreign-key") original.call(this, "INSERT INTO principal_credentials(id,principal_id,kind,label,token_prefix,verifier_hash,status,created_at) VALUES('bad','missing','agent_token','x','x',printf('%064d',0),'active','now')");
        else original.call(this, "PRAGMA ignore_check_constraints=ON; UPDATE remote_principals SET status='broken'; PRAGMA ignore_check_constraints=OFF");
      }
      return result;
    });
    expect(() => new SqliteStateStore(f.path, owned)).toThrow(/check failed/);
    spy.mockRestore();
    expect(owned.database.open).toBe(false);
    released(f.path);
    raw(f.path, db => expect(db.prepare("SELECT max(version) version FROM schema_migrations").get()).toEqual({version:26}));
    new SqliteStateStore(f.path).close();
  });

  it("refuses mismatched effective PRAGMA settings and closes the connection", () => {
    const f=fixture(26), owned=new OwnedSqliteDatabase(f.path);
    const pragma=Database.prototype.pragma;
    vi.spyOn(Database.prototype,"pragma").mockImplementation(function(this: Database.Database, source, options) {
      if(source==="synchronous" && options?.simple) return 1;
      return pragma.call(this,source,options);
    });
    expect(()=>new SqliteStateStore(f.path,owned)).toThrow(/effective durability settings/);
    expect(owned.database.open).toBe(false);released(f.path);
  });

  it.each(["invalid", "inode", "partial"])("preserves a failed creation with %s marker/state for operator inspection", kind => {
    const f=fixture(), owned=new OwnedSqliteDatabase(f.path,true);owned.close();
    if(kind==="invalid")writeFileSync(`${f.path}.initializing`,"incomplete");
    if(kind==="inode")writeFileSync(`${f.path}.initializing`,JSON.stringify({format:1,device:0,inode:0}));
    if(kind==="partial")raw(f.path,db=>db.exec("CREATE TABLE unknown(id TEXT)"));
    const before=readFileSync(f.path), marker=readFileSync(`${f.path}.initializing`);
    expect(()=>new SqliteStateStore(f.path)).toThrow();released(f.path);
    expect(readFileSync(f.path)).toEqual(before);expect(readFileSync(`${f.path}.initializing`)).toEqual(marker);
  });

  it("recognizes a committed initialization if marker cleanup failed",()=>{
    const f=fixture();
    const cleanup=vi.spyOn(OwnedSqliteDatabase.prototype,"completeInitialization").mockImplementation(()=>{throw Error("injected marker cleanup failure");});
    expect(()=>new SqliteStateStore(f.path)).toThrow(/marker cleanup/);released(f.path);
    cleanup.mockRestore();
    const retry=new SqliteStateStore(f.path);expect(retry.getAuthenticationPolicy().mode).toBe("token");retry.close();
    expect(existsSync(`${f.path}.initializing`)).toBe(false);
  });

  it("does not change data permissions while another owner holds the database",()=>{
    const f=fixture(26), owner=new OwnedSqliteDatabase(f.path);
    try {
      chmodSync(f.path,0o644);
      expect(()=>new OwnedSqliteDatabase(f.path)).toThrow(/already running/);
      expect(lstatSync(f.path).mode&0o777).toBe(0o644);
    } finally {owner.close();}
  });

  it("refuses foreign ownership without changing permissions",()=>{
    if(!process.getuid)return;
    const f=fixture(26), uid=process.getuid();
    const before=lstatSync(f.path).mode;
    vi.spyOn(process,"getuid").mockReturnValue(uid+1);
    expect(()=>new SqliteStateStore(f.path)).toThrow(/Unsafe/);
    expect(lstatSync(f.path).mode).toBe(before);released(f.path);
  });

  it("creates database, WAL/SHM and backup privately with umask 000 without changing unrelated files",async()=>{
    const f=fixture();const other=join(f.root,"unrelated");writeFileSync(other,"keep",{mode:0o644});chmodSync(other,0o644);const mask=process.umask(0);
    let store:SqliteStateStore|undefined;
    try {
      store=new SqliteStateStore(f.path);
      for(const path of [f.path,`${f.path}-wal`,`${f.path}-shm`]) expect(lstatSync(path).mode&0o777).toBe(0o600);
      expect(lstatSync(join(f.root,"data")).mode&0o777).toBe(0o700);
      const backup=join(f.root,"copies","copy");await createControllerBackup(store,backup,{applicationVersion:"test",attachmentDirectory:join(f.root,"attachments")});
      for(const path of [join(backup,"state.sqlite3"),join(backup,"manifest.json")]) expect(lstatSync(path).mode&0o777).toBe(0o600);
      expect(lstatSync(join(f.root,"copies")).mode&0o777).toBe(0o700);expect(lstatSync(other).mode&0o777).toBe(0o644);
    } finally {store?.close();process.umask(mask);}
  });

  it.each(["wal-link","shm-hardlink","public-directory","untrusted-ancestor"])("rejects unsafe %s before accessing the database",kind=>{
    const f=fixture(26);const other=join(f.root,"other");writeFileSync(other,"keep",{mode:0o644});chmodSync(other,0o644);
    if(kind==="wal-link")symlinkSync(other,`${f.path}-wal`);
    if(kind==="shm-hardlink")linkSync(other,`${f.path}-shm`);
    if(kind==="public-directory")chmodSync(join(f.root,"data"),0o755);
    if(kind==="untrusted-ancestor")chmodSync(f.root,0o777);
    expect(()=>new SqliteStateStore(f.path)).toThrow(/Unsafe|aliases/);expect(readFileSync(other,"utf8")).toBe("keep");expect(lstatSync(other).mode&0o777).toBe(0o644);released(f.path);
  });
});
