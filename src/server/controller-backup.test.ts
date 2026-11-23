// test-tier: heavy (durable SQLite backups)
import { resumeFixtureSecurity } from "./infrastructure/sqlite/fixtures/protected-security";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "./sqlite-store";
import { OwnedSqliteDatabase } from "./infrastructure/sqlite";
import { createControllerBackup, restoreControllerBackup } from "./controller-backup";
import Database from "better-sqlite3";
import { initializeSchema } from "./infrastructure/sqlite/migrations";
import { inspectSchema } from "./infrastructure/sqlite/schema-inspection";
import { configureDurability } from "./infrastructure/sqlite/database-validation";
import { parseManifest, validateBackup, validateSnapshot } from "./infrastructure/sqlite/backup-validation";
import { applyRegistryMigration } from "./infrastructure/sqlite/migration-registry";
import { unmanagedFixtureDatabase } from "./unmanaged-sqlite-fixture";

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
    await resumeFixtureSecurity(databasePath);
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
    expect(manifest).toMatchObject({formatVersion:1,applicationVersion:"test-version",database:{file:"state.sqlite3",schemaVersion:53}});
    expect(existsSync(join(backupPath,"state.sqlite3"))).toBe(true); store.close();
    const changed=new SqliteStateStore(databasePath); changed.addProject({name:"After",repositoryPath:join(directory,"repo-2"),port:3457,executable:"pnpm",args:["dev"]}); changed.close();
    restoreControllerBackup(backupPath,databasePath);
    await resumeFixtureSecurity(databasePath); const restored=new SqliteStateStore(databasePath); expect(restored.listProjects().map(p=>p.name)).toEqual(["Before"]); restored.close();
    const manifestPath=join(backupPath,"manifest.json"); const source=readFileSync(manifestPath,"utf8"); writeFileSync(manifestPath,source.replace(/"sha256":\s*"[a-f0-9]+"/, '"sha256":"'+"0".repeat(64)+'"'));
    expect(()=>restoreControllerBackup(backupPath,databasePath)).toThrow(/integrity/i);
  });

  it("refuses a snapshot above the ceiling it names, and accepts it at the default ceiling, the supported schema", async () => {
    const directory=root(), databasePath=join(directory,"state.sqlite3");
    const source=new Database(databasePath); cleanups.push(()=>source.close());
    chmodSync(databasePath,0o600); configureDurability(source);
    initializeSchema(source,true,current=>{inspectSchema(current,53);},{target:53});
    const snapshots={backup:async(destination:string)=>{await source.backup(destination);}};
    const options={applicationVersion:"test-version",attachmentDirectory:join(directory,"attachments")};
    // At ceiling 49: refused at the snapshot's inspection, and the staging tree is removed.
    await expect(createControllerBackup(snapshots,join(directory,"at-49"),{...options,schemaCeiling:49})).rejects.toThrow();
    expect(readdirSync(directory).filter(name=>name.includes("at-49"))).toEqual([]);
    // At the default ceiling (53) it is accepted and validates; a lower ceiling refuses its manifest.
    const manifest=await createControllerBackup(snapshots,join(directory,"default"),options);
    expect(manifest).toMatchObject({formatVersion:1,database:{file:"state.sqlite3",schemaVersion:53}});
    expect(()=>validateBackup(join(directory,"default"),parseManifest(manifest),true)).not.toThrow();
    expect(()=>parseManifest(manifest,51)).toThrow(/Unsupported or invalid backup manifest/);
    // A store of this release backs up at 53 whether or not the ceiling is named.
    const supported=new SqliteStateStore(join(directory,"supported.sqlite3")); cleanups.push(()=>supported.close());
    expect(await createControllerBackup(supported,join(directory,"supported"),{...options,schemaCeiling:53})).toMatchObject({database:{schemaVersion:53}});
  }, 30_000);

  /** A database at `version`: the public 0.1.1 baseline (28), the released 49, or 50 to 53 migrated from 49 with the marker pending. */
  function versioned(path: string, version: number): void {
    const database = unmanagedFixtureDatabase(path);
    try {
      if (version === 28) {
        database.exec(readFileSync(new URL("./infrastructure/sqlite/fixtures/schema-v26.sql", import.meta.url), "utf8"));
        database.exec(`CREATE INDEX IF NOT EXISTS knowledge_import_sources_target ON knowledge_import_sources(project_id,target_kind,target_id);
          INSERT INTO schema_migrations(version,applied_at) VALUES(27,'2026-11-01T00:00:00.000Z')`);
        applyRegistryMigration(database);
      } else {
        initializeSchema(database, true, current => { inspectSchema(current, 49); }, { target: 49 });
        if (version > 49) initializeSchema(database, false, current => { inspectSchema(current, version); }, { target: version });
      }
    } finally { database.close(); }
    chmodSync(path, 0o600);
  }
  it.each([28, 49, 50, 51, 52, 53])("verifies and restores a schema-%i snapshot at the default ceiling, without requiring a witness or a complete marker", async version => {
    const directory = root(), source = join(directory, "source.sqlite3"), backup = join(directory, "backup"), target = join(directory, "restored", "state.sqlite3");
    versioned(source, version);
    const reader = new Database(source, { readonly: true, fileMustExist: true }); cleanups.push(() => reader.close());
    const manifest = await createControllerBackup({ backup: async destination => { await reader.backup(destination); } }, backup, { applicationVersion: "test", attachmentDirectory: join(directory, "attachments") });
    expect(manifest.database.schemaVersion).toBe(version);
    expect(() => validateBackup(backup, parseManifest(manifest), true)).not.toThrow();
    if (version >= 50) {
      const copy = new Database(join(backup, "state.sqlite3"), { readonly: true, fileMustExist: true });
      try { expect(copy.prepare("SELECT state FROM upgrade_marker").pluck().get()).toBe("pending"); } finally { copy.close(); }
    }
    restoreControllerBackup(backup, target);
    const restored = new Database(target, { readonly: true, fileMustExist: true });
    try { expect(inspectSchema(restored).version).toBe(version); } finally { restored.close(); }
  }, 30_000);
  it("refuses a schema-54 manifest and snapshot at the default ceiling", async () => {
    const directory = root(), source = join(directory, "source.sqlite3"), backup = join(directory, "backup");
    versioned(source, 53);
    const reader = new Database(source, { readonly: true, fileMustExist: true }); cleanups.push(() => reader.close());
    const manifest = await createControllerBackup({ backup: async destination => { await reader.backup(destination); } }, backup, { applicationVersion: "test", attachmentDirectory: join(directory, "attachments") });
    expect(() => parseManifest({ ...manifest, database: { ...manifest.database, schemaVersion: 54 } })).toThrow(/Unsupported or invalid backup manifest/);
    const snapshot = unmanagedFixtureDatabase(join(backup, "state.sqlite3"));
    try { snapshot.prepare("INSERT INTO schema_migrations(version,applied_at,name,checksum) VALUES(54,'2026-11-16T00:00:00.000Z','future','future')").run(); } finally { snapshot.close(); }
    expect(() => validateSnapshot(join(backup, "state.sqlite3"), { ...manifest, database: { ...manifest.database } })).toThrow(/Unsupported or unrecognized database schema/);
    expect(() => restoreControllerBackup(backup, join(directory, "restored", "state.sqlite3"))).toThrow();
  }, 30_000);
});
