import { resumeFixtureSecurity } from "./infrastructure/sqlite/fixtures/protected-security";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "./sqlite-store";
import { OwnedSqliteDatabase } from "./infrastructure/sqlite";
import { createControllerBackup, restoreControllerBackup } from "./controller-backup";
import Database from "better-sqlite3";
import { enableProvisionalSchema } from "./infrastructure/sqlite/provisional-schema-gate";
import { initializeSchema } from "./infrastructure/sqlite/migrations";
import { inspectSchema } from "./infrastructure/sqlite/schema-inspection";
import { configureDurability } from "./infrastructure/sqlite/database-validation";
import { parseManifest, validateBackup } from "./infrastructure/sqlite/backup-validation";

const cleanups: Array<() => void> = []; afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function root() { const value=mkdtempSync(join(tmpdir(),"controller-backup-")); cleanups.push(()=>rmSync(value,{recursive:true,force:true})); return value; }

async function interruptedRestoreFixture(committed: boolean) {
  const directory = root(), backupPath = join(directory, "backup"), databasePath = join(directory, "restored.sqlite3");
  const source = new SqliteStateStore(join(directory, "source.sqlite3"));
  try {
    source.addProject({name:"Recovered",repositoryPath:join(directory,"repo"),port:3456,executable:"pnpm",args:["dev"]});
    await createControllerBackup(source, backupPath, {applicationVersion:"test",attachmentDirectory:join(directory,"source-attachments")});
  } finally { source.close(); }
  const interrupted = new OwnedSqliteDatabase(databasePath, true);
  const marker = readFileSync(`${databasePath}.initializing`);
  interrupted.close();
  if (committed) {
    new SqliteStateStore(databasePath).close();
    // Recreate the same-inode marker left by interruption between COMMIT and cleanup.
    writeFileSync(`${databasePath}.initializing`, marker, {mode:0o600});
  }
  // A cold rollback journal still belongs to the database being replaced.
  writeFileSync(`${databasePath}-journal`, Buffer.alloc(512), {mode:0o600});
  return {directory, backupPath, databasePath, marker};
}

describe("controller backup", () => {
  it.each([false, true])("restores over interrupted initialization and reopens without stale sidecars (committed=%s)", async committed => {
    const {backupPath, databasePath} = await interruptedRestoreFixture(committed);
    restoreControllerBackup(backupPath, databasePath);
    expect(existsSync(`${databasePath}.initializing`)).toBe(false);
    expect(existsSync(`${databasePath}-journal`)).toBe(false);
    resumeFixtureSecurity(databasePath);
    const restored = new SqliteStateStore(databasePath);
    try {
      expect(restored.listProjects().map(project => project.name)).toEqual(["Recovered"]);
      expect(restored.getAuthenticationPolicy().mode).toBe("token");
    } finally { restored.close(); }
    expect(existsSync(`${databasePath}.owner.lock`)).toBe(false);
  });

  it("preserves the original initialization marker and journal if target preflight fails", async () => {
    const {directory, backupPath, databasePath, marker} = await interruptedRestoreFixture(false);
    const original = readFileSync(databasePath), journal = readFileSync(`${databasePath}-journal`);
    writeFileSync(join(directory,"missing-parent"), "not a directory", {mode:0o600});
    expect(() => restoreControllerBackup(backupPath, databasePath, join(directory,"missing-parent","attachments"))).toThrow();
    expect(readFileSync(databasePath)).toEqual(original);
    expect(readFileSync(`${databasePath}.initializing`)).toEqual(marker);
    expect(readFileSync(`${databasePath}-journal`)).toEqual(journal);
    expect(existsSync(`${databasePath}.owner.lock`)).toBe(false);
    const retried = new SqliteStateStore(databasePath);
    try { expect(retried.getAuthenticationPolicy().mode).toBe("token"); }
    finally { retried.close(); }
  });

  it("creates a verified SQLite snapshot and restores it only after validating the manifest", async () => {
    const directory=root(), databasePath=join(directory,"state.sqlite3"), backupPath=join(directory,"backup");
    const store=new SqliteStateStore(databasePath); store.addProject({name:"Before",repositoryPath:join(directory,"repo"),port:3456,executable:"pnpm",args:["dev"]});
    const manifest=await createControllerBackup(store, backupPath, { applicationVersion:"test-version", attachmentDirectory:join(directory,"attachments") });
    expect(manifest).toMatchObject({formatVersion:1,applicationVersion:"test-version",database:{file:"state.sqlite3",schemaVersion:49}});
    expect(existsSync(join(backupPath,"state.sqlite3"))).toBe(true); store.close();
    const changed=new SqliteStateStore(databasePath); changed.addProject({name:"After",repositoryPath:join(directory,"repo-2"),port:3457,executable:"pnpm",args:["dev"]}); changed.close();
    restoreControllerBackup(backupPath,databasePath);
    resumeFixtureSecurity(databasePath); const restored=new SqliteStateStore(databasePath); expect(restored.listProjects().map(p=>p.name)).toEqual(["Before"]); restored.close();
    const manifestPath=join(backupPath,"manifest.json"); const source=readFileSync(manifestPath,"utf8"); writeFileSync(manifestPath,source.replace(/"sha256":\s*"[a-f0-9]+"/, '"sha256":"'+"0".repeat(64)+'"'));
    expect(()=>restoreControllerBackup(backupPath,databasePath)).toThrow(/integrity/i);
  });

  it("refuses a snapshot above the supported schema without schemaCeiling, and accepts it at the ceiling it names", async () => {
    // Schema 52 is provisional: the switch is on only for this test, so the default ceiling stays the supported 49.
    const restoreGate = enableProvisionalSchema(); cleanups.push(restoreGate);
    const directory=root(), databasePath=join(directory,"state.sqlite3");
    const source=new Database(databasePath); cleanups.push(()=>source.close());
    chmodSync(databasePath,0o600); configureDurability(source);
    initializeSchema(source,true,current=>{inspectSchema(current,52);},{target:52});
    const snapshots={backup:async(destination:string)=>{await source.backup(destination);}};
    const options={applicationVersion:"test-version",attachmentDirectory:join(directory,"attachments")};
    // Without the option: refused at the snapshot's inspection, and the staging tree is removed.
    await expect(createControllerBackup(snapshots,join(directory,"default"),options)).rejects.toThrow();
    expect(readdirSync(directory).filter(name=>name.includes("default"))).toEqual([]);
    // At 52 it is accepted and validates at that ceiling only.
    const manifest=await createControllerBackup(snapshots,join(directory,"provisional"),{...options,schemaCeiling:52});
    expect(manifest).toMatchObject({formatVersion:1,database:{file:"state.sqlite3",schemaVersion:52}});
    expect(()=>validateBackup(join(directory,"provisional"),parseManifest(manifest,52),true,52)).not.toThrow();
    expect(()=>parseManifest(manifest)).toThrow(/Unsupported or invalid backup manifest/);
    // A supported-schema source is unaffected by naming the ceiling.
    const supported=new SqliteStateStore(join(directory,"supported.sqlite3")); cleanups.push(()=>supported.close());
    expect(await createControllerBackup(supported,join(directory,"supported"),{...options,schemaCeiling:52})).toMatchObject({database:{schemaVersion:49}});
  });
});
