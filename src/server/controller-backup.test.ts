import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStateStore } from "./sqlite-store";
import { createControllerBackup, restoreControllerBackup } from "./controller-backup";

const cleanups: Array<() => void> = []; afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function root() { const value=mkdtempSync(join(tmpdir(),"controller-backup-")); cleanups.push(()=>rmSync(value,{recursive:true,force:true})); return value; }

describe("controller backup", () => {
  it("creates a verified SQLite snapshot and restores it only after validating the manifest", async () => {
    const directory=root(), databasePath=join(directory,"state.sqlite3"), backupPath=join(directory,"backup");
    const store=new SqliteStateStore(databasePath); store.addProject({name:"Before",repositoryPath:join(directory,"repo"),port:3456,executable:"pnpm",args:["dev"]});
    const manifest=await createControllerBackup(store, backupPath, { applicationVersion:"test-version", attachmentDirectory:join(directory,"attachments") });
    expect(manifest).toMatchObject({formatVersion:1,applicationVersion:"test-version",database:{file:"state.sqlite3",schemaVersion:28}});
    expect(existsSync(join(backupPath,"state.sqlite3"))).toBe(true); store.close();
    const changed=new SqliteStateStore(databasePath); changed.addProject({name:"After",repositoryPath:join(directory,"repo-2"),port:3457,executable:"pnpm",args:["dev"]}); changed.close();
    restoreControllerBackup(backupPath,databasePath);
    const restored=new SqliteStateStore(databasePath); expect(restored.listProjects().map(p=>p.name)).toEqual(["Before"]); restored.close();
    const manifestPath=join(backupPath,"manifest.json"); const source=readFileSync(manifestPath,"utf8"); writeFileSync(manifestPath,source.replace(/"sha256":\s*"[a-f0-9]+"/, '"sha256":"'+"0".repeat(64)+'"'));
    expect(()=>restoreControllerBackup(backupPath,databasePath)).toThrow(/integrity/i);
  });
});
