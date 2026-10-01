import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMigrationBackupOptions } from "./migration-backup-options";
import { buildServiceStartArguments } from "./service-install";
import { UserServiceManager, type ServiceCommandRunner } from "./service-manager";

const base={host:"127.0.0.1",port:47831,mcpPort:47832,browseRoot:"/isolated/repo",dataDirectory:"/isolated/data",stateDirectory:"/isolated/state",webRoot:"/isolated/out",noMcp:true,memoryWarningMiB:null};
describe("migration backup startup options",()=>{
  it("defaults off and selecting a directory does not enable backups",()=>{
    expect(parseMigrationBackupOptions([])).toEqual({backupBeforeMigration:false});
    expect(parseMigrationBackupOptions(["--backup-dir","./backups"])).toEqual({backupBeforeMigration:false,backupDirectory:resolve("backups")});
    expect(buildServiceStartArguments(base).join(" ")).not.toContain("--backup");
  });
  it.each([
    ["--backup-before-migration"], ["--backup-dir"], ["--backup-dir","--no-open"], ["--backup-dir",""],
    ["--backup-before-migration","false","--backup-dir","/tmp/copy"],
    ["--backup-before-migration","--backup-before-migration","--backup-dir","/tmp/copy"],
    ["--backup-dir","/tmp/a","--backup-dir","/tmp/b"],
    ["--backup-before-migration=false"], ["--backup-interval","1h"], ["--backup-before-import"],
  ])("rejects malformed or unsupported arguments %j", (...args)=>{
    expect(()=>parseMigrationBackupOptions(args)).toThrow();
  });
  it("rejects startup options on an unrelated CLI action",()=>{
    expect(()=>parseMigrationBackupOptions(["auth","--backup-dir","/tmp/copy"],false)).toThrow("only to start");
  });
  it("carries validated flags into a privately isolated service installation without calling the host manager",()=>{
    const root=mkdtempSync(join(tmpdir(),"backup-service-install-"));
    const runner:ServiceCommandRunner={run:()=>({status:0,stdout:"",stderr:""})};
    try {
      const startArguments=buildServiceStartArguments({...base,...parseMigrationBackupOptions(["service","install","--backup-before-migration","--backup-dir",join(root,"copies")])});
      const manager=new UserServiceManager({platform:"linux",homeDirectory:root,environment:{NODE_ENV:"test"},runner});
      mkdirSync(join(root,"state","logs"),{recursive:true});
      const installed=manager.install({nodePath:process.execPath,entrypointPath:join(root,"isolated.js"),workingDirectory:root,startArguments,stateDirectory:join(root,"state"),refresh:false});
      const definition=readFileSync(installed.definitionPath,"utf8");
      expect(definition).toContain('"--backup-before-migration"');
      expect(definition).toContain(`"--backup-dir" "${join(root,"copies")}"`);
      expect(startArguments).toEqual(expect.arrayContaining(["--backup-before-migration","--backup-dir",join(root,"copies")]));
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
