import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";

export interface ControllerBackupManifest {
  formatVersion: 1;
  applicationVersion: string;
  createdAt: string;
  database: { file: "state.sqlite3"; size: number; sha256: string; schemaVersion: number };
  attachments: Array<{ file: string; size: number; sha256: string }>;
}
interface BackupSource { backup(destination: string): Promise<void>; schemaVersion(): number }
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function safe(root: string, file: string): string {
  const target=resolve(root,file); if (!file || file.startsWith(sep) || target===resolve(root) || !target.startsWith(resolve(root)+sep)) throw new Error("Backup manifest contains an unsafe path."); return target;
}

export async function createControllerBackup(source: BackupSource, destination: string, options: {applicationVersion:string;attachmentDirectory:string;clock?:()=>string}): Promise<ControllerBackupManifest> {
  if (existsSync(destination)) throw new Error("Backup destination already exists.");
  mkdirSync(dirname(destination),{recursive:true}); const staging=mkdtempSync(join(dirname(destination),`.${basename(destination)}.partial-`)); mkdirSync(join(staging,"attachments"),{recursive:true});
  try {
    const databaseFile=join(staging,"state.sqlite3"); await source.backup(databaseFile);
    const snapshot=new Database(databaseFile,{readonly:true}); const required=(snapshot.prepare("SELECT DISTINCT sha256, size FROM knowledge_attachments ORDER BY sha256").all() as Array<{sha256:string;size:number}>); snapshot.close();
    const attachments=required.map(({sha256,size})=>{ const file=join(sha256.slice(0,2),sha256);
      const from=safe(options.attachmentDirectory,file), to=safe(join(staging,"attachments"),file); mkdirSync(dirname(to),{recursive:true}); copyFileSync(from,to);
      if(lstatSync(to).size!==size||hash(to)!==sha256) throw new Error("Attachment storage does not match database metadata.");
      return {file,size,sha256};
    });
    const manifest: ControllerBackupManifest={formatVersion:1,applicationVersion:options.applicationVersion,createdAt:(options.clock??(()=>new Date().toISOString()))(),database:{file:"state.sqlite3",size:lstatSync(databaseFile).size,sha256:hash(databaseFile),schemaVersion:source.schemaVersion()},attachments};
    writeFileSync(join(staging,"manifest.json"),JSON.stringify(manifest,null,2),{mode:0o600}); renameSync(staging,destination); return manifest;
  } catch(error) { rmSync(staging,{recursive:true,force:true}); throw error; }
}

export function restoreControllerBackup(source: string, databasePath: string, attachmentDirectory?: string): void {
  const manifest=JSON.parse(readFileSync(join(source,"manifest.json"),"utf8")) as ControllerBackupManifest;
  if (manifest.formatVersion!==1) throw new Error("Unsupported backup format version.");
  const databaseFile=safe(source,manifest.database.file);
  if (lstatSync(databaseFile).size!==manifest.database.size || hash(databaseFile)!==manifest.database.sha256) throw new Error("Backup database integrity check failed.");
  for (const entry of manifest.attachments) { const file=safe(join(source,"attachments"),entry.file); if (!existsSync(file)||lstatSync(file).isSymbolicLink()||lstatSync(file).size!==entry.size||hash(file)!==entry.sha256) throw new Error("Backup attachment integrity check failed."); }
  const check=new Database(databaseFile,{readonly:true,fileMustExist:true}); try {
    if (check.pragma("integrity_check",{simple:true})!=="ok") throw new Error("SQLite integrity check failed.");
    const actual=(check.prepare("SELECT max(version) version FROM schema_migrations").get() as {version:number}).version;
    if(actual!==manifest.database.schemaVersion||actual>27) throw new Error("Unsupported or inconsistent database schema version.");
    const required=check.prepare("SELECT DISTINCT sha256, size FROM knowledge_attachments ORDER BY sha256").all() as Array<{sha256:string;size:number}>;
    if(JSON.stringify(required)!==JSON.stringify(manifest.attachments.map(x=>({sha256:x.sha256,size:x.size})).sort((a,b)=>a.sha256.localeCompare(b.sha256)))) throw new Error("Backup attachment manifest is incomplete.");
  } finally { check.close(); }
  mkdirSync(dirname(databasePath),{recursive:true}); const stageRoot=mkdtempSync(join(dirname(databasePath),`.restore-`)); const stagedDatabase=join(stageRoot,"state.sqlite3"); copyFileSync(databaseFile,stagedDatabase);
  const stagedAttachments=join(stageRoot,"attachments"); mkdirSync(stagedAttachments); for(const entry of manifest.attachments){const target=safe(stagedAttachments,entry.file);mkdirSync(dirname(target),{recursive:true});copyFileSync(safe(join(source,"attachments"),entry.file),target);}
  const quarantine=join(stageRoot,"previous"); mkdirSync(quarantine); const moved:Array<[string,string]>=[];
  try {
    for(const current of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`,...(attachmentDirectory?[attachmentDirectory]:[])]) if(existsSync(current)){const old=join(quarantine,basename(current));renameSync(current,old);moved.push([old,current]);}
    renameSync(stagedDatabase,databasePath); if(attachmentDirectory) renameSync(stagedAttachments,attachmentDirectory);
    try { rmSync(stageRoot,{recursive:true,force:true}); } catch { /* Restored state is committed; retained quarantine is recoverable. */ }
  } catch(error) { if(existsSync(databasePath)) rmSync(databasePath,{force:true}); if(attachmentDirectory&&existsSync(attachmentDirectory)) rmSync(attachmentDirectory,{recursive:true,force:true}); for(const [old,current] of moved.reverse()) if(existsSync(old)) renameSync(old,current); rmSync(stageRoot,{recursive:true,force:true}); throw error; }
}
