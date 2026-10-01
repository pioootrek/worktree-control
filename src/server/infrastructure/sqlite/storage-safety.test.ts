import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths } from "@/server/paths";
import { runBackupCommand } from "@/cli/backup-management";
import { runAuthCommand } from "@/cli/auth-management";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { openControllerStore } from "@/server/controller-storage";
import { acquireControllerLock } from "@/server/controller-lock";
import { OwnedSqliteDatabase, SqliteStateStore, inspectSchema } from "./index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function fixture(version: 12 | 24 | 26 = 24) {
  const root = mkdtempSync(join(tmpdir(), "sqlite-safety-")); roots.push(root);
  const paths = resolveAppPaths(join(root,"data"), join(root,"state"));
  mkdirSync(paths.dataDirectory, {mode:0o700});
  const db = new Database(paths.databasePath);
  db.exec(readFileSync(new URL(`./fixtures/schema-v${version}.sql`, import.meta.url), "utf8"));
  db.exec(`INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
    VALUES('kept','Kept','/isolated/repo',3456,'pnpm','["dev"]','/',30000,'then','then');`);
  let sha256: string | undefined;
  if (version >= 21) {
    sha256 = createHash("sha256").update("fixture attachment").digest("hex");
    db.exec(`INSERT INTO remote_principals(id,kind,status) VALUES('owner','owner','active');
      INSERT INTO knowledge_projects(id,name,status,revision,created_at,updated_at) VALUES('knowledge','Knowledge','active',1,'then','then');
      INSERT INTO knowledge_tasks(id,project_id,title,description,status,priority,revision,created_by,created_at,updated_at)
      VALUES('task','knowledge','Kept task','Content','open','next',1,'owner','then','then');`);
    db.prepare(`INSERT INTO knowledge_attachments(id,project_id,record_kind,record_id,filename,media_type,size,sha256,created_by,created_at)
      VALUES('attachment','knowledge','task','task','file.txt','text/plain',18,?,'owner','then')`).run(sha256);
    mkdirSync(join(paths.knowledgeAttachmentDirectory,sha256.slice(0,2)),{recursive:true,mode:0o700});
    writeFileSync(join(paths.knowledgeAttachmentDirectory,sha256.slice(0,2),sha256),"fixture attachment",{mode:0o600});
  }
  db.close();
  return {root,paths,sha256};
}
function raw(path: string, fn: (db: Database.Database) => void) {
  const db=new Database(path); try { fn(db); } finally { db.close(); }
}
const options = (attachmentDirectory: string, backupDirectory?: string) => ({
  attachmentDirectory, applicationVersion:"isolated-test", backupBeforeMigration:Boolean(backupDirectory), backupDirectory,
});

async function crashWalWriter(path: string, removeIndex: boolean, future = false) {
  const worker = fileURLToPath(new URL("./fixtures/wal-crash-worker.ts", import.meta.url));
  const child = fork(worker, [path, future ? "future" : "supported"], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  try {
    const [message] = await once(child, "message", { signal: abort.signal });
    expect(message).toEqual({ committed: true });
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      const [, signal] = await exited;
      expect(signal).toBe("SIGKILL");
    }
  }
  expect(lstatSync(`${path}-wal`).size).toBeGreaterThan(32);
  expect(existsSync(`${path}-shm`)).toBe(true);
  if (removeIndex) rmSync(`${path}-shm`);
}

describe("SQLite storage safety", () => {
  it.each([false, true])("inspects, backs up and migrates a committed WAL after SIGKILL (remove index=%s)", async removeIndex => {
    const f = fixture(12);
    await crashWalWriter(f.paths.databasePath, removeIndex);
    const before = readFileSync(f.paths.databasePath);
    const walBefore = readFileSync(`${f.paths.databasePath}-wal`);
    // The record must come from WAL; reading only the main file still sees its old value.
    const mainOnlyPath = join(f.root, "main-only.sqlite3");
    writeFileSync(mainOnlyPath, before);
    const mainOnly = new Database(mainOnlyPath, { readonly: true });
    try { expect(mainOnly.prepare("SELECT name FROM projects").get()).toEqual({ name: "Kept" }); }
    finally { mainOnly.close(); }

    const inspected = new OwnedSqliteDatabase(f.paths.databasePath);
    try {
      expect(inspected.database.readonly).toBe(true);
      expect(inspected.schemaVersion()).toBe(12);
      expect(inspected.database.prepare("SELECT name FROM projects").get()).toEqual({ name: "Committed in WAL" });
    } finally { inspected.close(); }
    const backup = join(f.root, "backup");
    await runBackupCommand(["create", backup], f.paths, "test", () => {});
    expect(readFileSync(f.paths.databasePath)).toEqual(before);
    expect(readFileSync(`${f.paths.databasePath}-wal`)).toEqual(walBefore);
    const snapshot = new Database(join(backup, "state.sqlite3"), { readonly: true });
    try {
      expect(inspectSchema(snapshot).version).toBe(12);
      expect(snapshot.prepare("SELECT name FROM projects").get()).toEqual({ name: "Committed in WAL" });
    } finally { snapshot.close(); }
    const store = await openControllerStore(f.paths.databasePath, options(f.paths.knowledgeAttachmentDirectory, join(f.root, "pre-migration")));
    try {
      expect(store.schemaVersion()).toBe(27);
      expect(store.getProject("kept")?.name).toBe("Committed in WAL");
    } finally { store.close(); }
    expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  }, 10000);

  it.each([false, true])("rejects a future schema committed only in WAL without changing the main file or WAL (remove index=%s)", async removeIndex => {
    const f = fixture(12);
    await crashWalWriter(f.paths.databasePath, removeIndex, true);
    const before = readFileSync(f.paths.databasePath);
    const walBefore = readFileSync(`${f.paths.databasePath}-wal`);
    expect(() => new SqliteStateStore(f.paths.databasePath)).toThrow(/Unsupported/);
    await expect(openControllerStore(f.paths.databasePath, options(f.paths.knowledgeAttachmentDirectory))).rejects.toThrow(/Unsupported/);
    await expect(runAuthCommand(["mode", "set", "open"], f.paths, { write: () => {} })).rejects.toThrow(/Unsupported/);
    await expect(runBackupCommand(["create", join(f.root, "backup")], f.paths, "test", () => {})).rejects.toThrow(/Unsupported/);
    expect(readFileSync(f.paths.databasePath)).toEqual(before);
    expect(readFileSync(`${f.paths.databasePath}-wal`)).toEqual(walBefore);
    expect(existsSync(join(f.root, "backup"))).toBe(false);
    expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);
  }, 10000);

  it.each([12,24,26] as const)("manual backup preserves raw schema v%s, rows and referenced attachments", async version => {
    const f=fixture(version); const before=readFileSync(f.paths.databasePath);
    const destination=join(f.root,"backup");
    await runBackupCommand(["create",destination],f.paths,"isolated-test",()=>{});
    expect(readFileSync(f.paths.databasePath)).toEqual(before);
    const snapshot=new Database(join(destination,"state.sqlite3"),{readonly:true});
    try {
      expect(inspectSchema(snapshot).version).toBe(version);
      expect(snapshot.prepare("SELECT name FROM projects").all()).toEqual([{name:"Kept"}]);
      if (f.sha256) {
        expect(snapshot.prepare("SELECT title FROM knowledge_tasks").all()).toEqual([{title:"Kept task"}]);
        expect(readFileSync(join(destination,"attachments",f.sha256.slice(0,2),f.sha256),"utf8")).toBe("fixture attachment");
      }
    } finally { snapshot.close(); }
    const manifest=JSON.parse(readFileSync(join(destination,"manifest.json"),"utf8"));
    expect(manifest.database.schemaVersion).toBe(version);
    expect(manifest.attachments).toHaveLength(version===12?0:1);
    expect(lstatSync(destination).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(destination,"state.sqlite3")).mode & 0o777).toBe(0o600);
    if(f.sha256) expect(lstatSync(join(destination,"attachments",f.sha256.slice(0,2),f.sha256)).mode & 0o777).toBe(0o600);
  });

  it("verifies the old snapshot before migrating and preserves its authentication and attachments", async () => {
    const f=fixture(); const target=join(f.root,"backups");
    const store=await openControllerStore(f.paths.databasePath,options(f.paths.knowledgeAttachmentDirectory,target));
    try { expect(store.schemaVersion()).toBe(27); expect(store.getProject("kept")?.name).toBe("Kept"); expect(store.getAuthenticationPolicy().mode).toBe("legacy"); } finally { store.close(); }
    const [backup]=readdirSync(target);
    expect(backup).toMatch(/^pre-migration-v24-/);
    const snapshot=new Database(join(target,backup,"state.sqlite3"),{readonly:true});
    try { expect(inspectSchema(snapshot).version).toBe(24); expect(snapshot.prepare("SELECT 1 FROM controller_settings WHERE key='authentication'").get()).toBeUndefined(); } finally { snapshot.close(); }
    const reopened=await openControllerStore(f.paths.databasePath,options(f.paths.knowledgeAttachmentDirectory,target)); reopened.close();
    expect(readdirSync(target)).toHaveLength(1);
  });

  it.each(["destination","attachment"])("required backup failure (%s) leaves schema and data unchanged and releases ownership", async failure => {
    const f=fixture(); const target=join(f.root,"target");
    if(failure==="destination") writeFileSync(target,"occupied");
    else rmSync(f.paths.knowledgeAttachmentDirectory,{recursive:true});
    const before=readFileSync(f.paths.databasePath);
    await expect(openControllerStore(f.paths.databasePath,options(f.paths.knowledgeAttachmentDirectory,target))).rejects.toThrow();
    expect(readFileSync(f.paths.databasePath)).toEqual(before);
    expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    const inspected=new OwnedSqliteDatabase(f.paths.databasePath); expect(inspected.schemaVersion()).toBe(24); inspected.close();
    if(failure==="attachment") expect(readdirSync(target)).toEqual([]);
  });

  it("migrates with backups disabled without requiring a destination or attachment storage", async () => {
    const f=fixture(); rmSync(f.paths.knowledgeAttachmentDirectory,{recursive:true});
    const store=await openControllerStore(f.paths.databasePath,options(f.paths.knowledgeAttachmentDirectory));
    try { expect(store.schemaVersion()).toBe(27); expect(store.getProject("kept")?.name).toBe("Kept"); } finally {store.close();}
    expect(readdirSync(f.root).sort()).toEqual(["data"]);
  });

  it.each(["future","foreign","gap","partial","shape","constraint"])("rejects %s schema before changing the database, journal or authentication through normal start and offline CLI",async variant => {
    const f=fixture();
    raw(f.paths.databasePath,db=>{
      if(variant==="future") db.exec("INSERT INTO schema_migrations(version,applied_at) VALUES (25,'future'),(26,'future'),(27,'future'),(28,'future')");
      if(variant==="foreign") db.exec("CREATE TABLE foreign_data(id TEXT)");
      if(variant==="gap") db.exec("DELETE FROM schema_migrations WHERE version=5");
      if(variant==="partial") db.exec("DELETE FROM schema_migrations");
      if(variant==="shape") db.exec("ALTER TABLE projects RENAME COLUMN name TO unknown_name");
      if(variant==="constraint") db.exec("DROP INDEX one_active_reservation_per_project");
    });
    const before=readFileSync(f.paths.databasePath);
    expect(()=>new SqliteStateStore(f.paths.databasePath)).toThrow(/Unsupported|unrecognized/);
    await expect(openControllerStore(f.paths.databasePath,options(f.paths.knowledgeAttachmentDirectory,join(f.root,"backups")))).rejects.toThrow(/Unsupported|unrecognized/);
    await expect(runAuthCommand(["mode","set","open"],f.paths,{write:()=>{}})).rejects.toThrow(/Unsupported|unrecognized/);
    await expect(runBackupCommand(["create",join(f.root,"backup")],f.paths,"test",()=>{})).rejects.toThrow(/Unsupported|unrecognized/);
    expect(readFileSync(f.paths.databasePath)).toEqual(before);
    expect(existsSync(`${f.paths.databasePath}-wal`)).toBe(false);
    expect(existsSync(join(f.root,"backups"))).toBe(false);
    expect(existsSync(f.paths.controllerLockPath)).toBe(false);
    expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
  });

  it("reads manifest metadata from the completed snapshot, never from the live source",async()=>{
    const f=fixture(12); const source=new OwnedSqliteDatabase(f.paths.databasePath);
    try { const manifest=await createControllerBackup({backup:path=>source.backup(path),schemaVersion:()=>{throw Error("must not read source version");}},join(f.root,"backup"),options(f.paths.knowledgeAttachmentDirectory)); expect(manifest.database.schemaVersion).toBe(12); } finally {source.close();}
  });

  it("restores a supported pre-knowledge schema and refuses a future snapshot before replacing the target",async()=>{
    const f=fixture(12); const backup=join(f.root,"backup"); await runBackupCommand(["create",backup],f.paths,"test",()=>{});
    const target=join(f.root,"restored.sqlite3"); restoreControllerBackup(backup,target);
    const inspected=new OwnedSqliteDatabase(target); expect(inspected.schemaVersion()).toBe(12); inspected.close();
    raw(join(backup,"state.sqlite3"),db=>db.exec("INSERT INTO schema_migrations(version,applied_at) VALUES(28,'future')"));
    const manifest=JSON.parse(readFileSync(join(backup,"manifest.json"),"utf8"));
    manifest.database.size=lstatSync(join(backup,"state.sqlite3")).size;
    manifest.database.sha256=createHash("sha256").update(readFileSync(join(backup,"state.sqlite3"))).digest("hex");manifest.database.schemaVersion=28;
    writeFileSync(join(backup,"manifest.json"),JSON.stringify(manifest));
    const before=readFileSync(target);
    expect(()=>restoreControllerBackup(backup,target)).toThrow(/Unsupported/);
    expect(readFileSync(target)).toEqual(before);
  });

  it("preserves another owner's database lock and releases only the failed CLI's state lock",async()=>{
    const f=fixture(); const owner=new OwnedSqliteDatabase(f.paths.databasePath);
    const before=readFileSync(`${f.paths.databasePath}.owner.lock`);
    try {
      await expect(runBackupCommand(["create",join(f.root,"backup")],f.paths,"test",()=>{})).rejects.toThrow("already running");
      expect(readFileSync(`${f.paths.databasePath}.owner.lock`)).toEqual(before);
      expect(existsSync(f.paths.controllerLockPath)).toBe(false);
      expect(()=>restoreControllerBackup(join(f.root,"missing"),f.paths.databasePath)).toThrow("already running");
    } finally {owner.close();}
  });

  it("rejects file aliases and uses canonical directory ownership",()=>{
    const f=fixture(); const alias=join(f.root,"alias"); symlinkSync(f.paths.dataDirectory,alias,"dir");
    const owner=new OwnedSqliteDatabase(f.paths.databasePath);
    try { expect(()=>new OwnedSqliteDatabase(join(alias,"state.sqlite3"))).toThrow("already running"); } finally {owner.close();}
    const hard=join(f.root,"hard.sqlite3");linkSync(f.paths.databasePath,hard);
    expect(()=>new OwnedSqliteDatabase(hard)).toThrow("aliases");
    expect(()=>new OwnedSqliteDatabase(f.paths.databasePath)).toThrow("aliases");
    const link=join(f.root,"file-link.sqlite3");symlinkSync(f.paths.databasePath,link);
    expect(()=>new OwnedSqliteDatabase(link)).toThrow("aliases");
  });

  it("releases state and database ownership when opening or manual backup fails",async()=>{
    const f=fixture(); await expect(runBackupCommand(["create",join(f.root,"missing-parent","backup")],f.paths,"test",()=>{})).resolves.toBeUndefined();
    rmSync(f.paths.knowledgeAttachmentDirectory,{recursive:true});
    await expect(runBackupCommand(["create",join(f.root,"failed")],f.paths,"test",()=>{})).rejects.toThrow();
    expect(existsSync(f.paths.controllerLockPath)).toBe(false); expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
    const other=join(f.root,"missing.sqlite3");expect(()=>new OwnedSqliteDatabase(other)).toThrow();expect(existsSync(`${other}.owner.lock`)).toBe(false);
    const state=acquireControllerLock(f.paths.controllerLockPath); state.release();
  });
  it("admits one of two simultaneous real processes using different state directories and directory aliases",async()=>{
    const f=fixture(12); const alias=join(f.root,"alias"); symlinkSync(f.paths.dataDirectory,alias,"dir");
    const worker=fileURLToPath(new URL("./fixtures/ownership-worker.ts",import.meta.url));
    const children=[
      fork(worker,[f.paths.databasePath,join(f.root,"state-a","controller.lock")],{execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]}),
      fork(worker,[join(alias,"state.sqlite3"),join(f.root,"state-b","controller.lock")],{execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]}),
    ];
    try {
      await Promise.all(children.map(child=>once(child,"message")));
      const results=children.map(child=>once(child,"message"));
      children.forEach(child=>child.send("acquire"));
      const outcomes=(await Promise.all(results)).map(([result])=>result as {acquired:boolean;error?:string});
      expect(outcomes.filter(x=>x.acquired)).toHaveLength(1);
      expect(outcomes.find(x=>!x.acquired)?.error).toMatch(/already running|acquisition/);
      const winner=children[outcomes.findIndex(x=>x.acquired)];
      const ended=once(winner,"exit");winner.send("release");await ended;
      const reopened=new OwnedSqliteDatabase(f.paths.databasePath);reopened.close();
    } finally {
      await Promise.all(children.map(async child=>{
        if(child.exitCode!==null || child.signalCode!==null) return;
        const ended=once(child,"exit"); child.kill("SIGKILL");await ended;
      }));
    }
  },10000);

});
