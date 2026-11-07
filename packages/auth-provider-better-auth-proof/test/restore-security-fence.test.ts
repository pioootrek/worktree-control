import { resolveAppPaths } from "@/server/paths";
import { integrated, enrollTotp, enrollPasskey, pendingLogin, passkeyOptions, factorOptions } from "./integrated-fixture";
import { Browser } from "./factor-fixture";
import { cleanupStrictRoots, closeStrictProof } from "./strict-fixture";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { maintainSecurityFence } from "@/server/bootstrap/security-maintenance";
import { createControllerAuthentication } from "@/server/bootstrap/authentication-provider-lifetime";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { IdentityService, HumanAccountService } from "@/server/modules/identity";
import { cliFixture } from "./cli-provider-fixture";
import { Client, loadProof, OWNER_EMAIL, OWNER_PASSWORD, readCommitted } from "./fixture";

let address=180;
const ip=()=>`203.0.113.${address++}`;
const cleanup:Array<()=>void>=[];
afterEach(()=>{vi.useRealTimers();cleanupStrictRoots();for(const remove of cleanup.splice(0))remove();});
async function fixture() {
  const f=cliFixture();cleanup.push(f.remove);await f.configure();const principalId=await f.create();
  await f.run(["enroll","--principal-id",principalId,...f.input({email:OWNER_EMAIL,name:"Owner",password:OWNER_PASSWORD})]);
  const open=()=>{
    const store=new SqliteStateStore(f.paths.databasePath);let runtime:AuthenticationProviderRuntime|undefined;
    const administration=createControllerAuthentication({store,dataDirectory:f.paths.dataDirectory,authentication:new AuthenticationService(store),actor:"local-cli",
      loadProvider:async input=>{runtime=await loadAuthenticationProvider(input);return runtime;}});
    const recover=async(password="fixture-restored-password-2")=>{await administration.execute({command:"auth-provider",action:"recover",principalId,input:{newPassword:password}});return runtime!;};
    return {store,administration,recover,runtime:()=>runtime!,close:async()=>{await administration.dispose();await store.closeAfterDrain();}};
  };
  return {...f,principalId,open};
}

describe("real protected provider restore quarantine",()=>{
  it.each(["totp","passkey"])("raw rollback cannot restore a real revoked %s or its pending ceremony",async kind=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-07T12:00:05Z"));
    const f=await integrated();let closed=false;let current:SqliteStateStore|undefined,runtime:AuthenticationProviderRuntime|undefined;
    try {
      const b=f.browser();await b.signIn();
      const totp=kind==="totp"?await enrollTotp(f,b):undefined;
      const key=kind==="passkey"?await enrollPasskey(f,b):undefined;
      const pending=totp?await pendingLogin(f):undefined;
      const options=key?await passkeyOptions(f.browser(),"authenticate"):undefined;
      const snapshot=join(f.root,"factor-snapshot.sqlite3");await f.run(()=>f.store.backup(snapshot));
      await f.runtime.recoverLocal({principalId:f.owner.principalId,newPassword:"fixture-factor-revoked-1",actor:"local-cli",factors:"reset"});
      await closeStrictProof(f);closed=true;copyFileSync(snapshot,f.path);
      expect(()=>new SqliteStateStore(f.path)).toThrow(/security_fence/);
      const paths=resolveAppPaths(f.root),status=maintainSecurityFence(paths,{action:"inspect"});
      expect(maintainSecurityFence(paths,{action:"resume",expect:status.preflight,mode:"token"})).toMatchObject({trusted:true,quarantined:true});
      current=new SqliteStateStore(f.path);runtime=(await loadProof(current,undefined,undefined,factorOptions())).runtime;
      const old=new Browser({runtime});expect((await old.signIn()).status).toBe(401);expect(await runtime.resolve(new Headers({cookie:b.cookieHeader()}))).toBeNull();
      if(totp)expect((await old.post("/two-factor/verify-totp",{code:totp.authenticator.code()},{cookie:pending!.cookieHeader()})).status).toBeGreaterThanOrEqual(400);
      if(key)expect((await old.post("/passkey/verify-authentication",{response:key.assert(options!)})).status).toBeGreaterThanOrEqual(400);
      await runtime.recoverLocal({principalId:f.owner.principalId,newPassword:"fixture-factor-resumed-2",actor:"local-cli"});
      const fresh=new Browser({runtime});expect((await fresh.signIn("fixture-factor-resumed-2")).status).toBe(200);expect((await fresh.resolve())?.principalId).toBe(f.owner.principalId);
      expect(readCommitted(f.path,db=>db.prepare("SELECT count(*) n FROM authentication_ba_passkey").get())).toEqual({n:0});
      expect(readCommitted(f.path,db=>db.prepare("SELECT count(*) n FROM authentication_ba_two_factor").get())).toEqual({n:0});
    } finally {await runtime?.dispose();await current?.closeAfterDrain();if(!closed)await closeStrictProof(f);}
  });
  it.each(["password","logout","disable","grant","machine","mode"])("snapshot, %s revocation, raw rollback, protected resume and same-owner password recovery",async edge=>{
    const f=await fixture();let current=f.open();
    const runtime=await current.recover(), browser=new Client(runtime,ip());expect((await browser.signIn("fixture-restored-password-2")).status).toBe(200);
    const cookie=browser.cookieHeader(), snapshot=join(f.root,"snapshot.sqlite3");
    const humans=new HumanAccountService(current.store.humanAccounts(),"local-cli"), human=await current.store.admission.run(()=>humans.create());
    const local=new IdentityService(current.store), admin=local.authenticateBearer(local.recoverOwnerSession().token);
    const agent=local.createAgent(admin), machine=local.issueAgentToken({principalId:agent.id,label:"restore fixture"},admin);
    const project=local.createKnowledgeProject({name:"Restore fixture"},admin);
    local.setKnowledgeGrant({principalId:agent.id,projectId:project.id,permissions:["knowledge:read"]},admin);
    await current.store.backup(snapshot);
    if(edge==="password")await current.administration.execute({command:"auth-provider",action:"recover",principalId:f.principalId,input:{newPassword:"fixture-revoked-password-3",factors:"reset"}});
    if(edge==="logout")expect((await browser.call("/sign-out",{body:{}})).status).toBe(200);
    if(edge==="disable")await current.store.admission.run(()=>humans.disable(human.id));
    if(edge==="grant")local.revokeKnowledgeGrant(agent.id,project.id,admin);
    if(edge==="machine")current.store.revokeCredential(machine.credential.id,new Date().toISOString(),"local-cli");
    if(edge==="mode")await current.store.admission.run(()=>new AuthenticationService(current.store).setMode("open","local-cli"));
    await current.close();copyFileSync(snapshot,f.paths.databasePath);
    expect(()=>f.open()).toThrow(/security_fence/);
    const preflight=maintainSecurityFence(f.paths,{action:"inspect"});
    const result=maintainSecurityFence(f.paths,{action:"resume",expect:preflight.preflight,mode:"token"});expect(result).toMatchObject({trusted:true,quarantined:true});
    expect(readCommitted(f.paths.databasePath,db=>db.prepare("SELECT id,kind,status FROM remote_principals WHERE kind='owner'").all())).toEqual([{id:f.principalId,kind:"owner",status:"active"}]);
    expect(readCommitted(f.paths.databasePath,db=>db.prepare("SELECT password FROM authentication_ba_account").all())).toEqual([{password:null}]);
    current=f.open();try{
      // This is the actual P1 lifetime and P3a protected recovery, after the durable receipt.
      expect(()=>new IdentityService(current.store).authenticateBearer(machine.token)).toThrow();
      expect(current.store.getKnowledgeProjectGrant(agent.id,project.id)?.revokedAt).not.toBeNull();
      const recovered=await current.recover("fixture-post-restore-password-4"), old=new Client(recovered,ip());
      expect(await recovered.resolve(new Headers({cookie}))).toBeNull();
      expect((await old.signIn(OWNER_PASSWORD)).status).toBe(401);
      expect((await old.signIn("fixture-restored-password-2")).status).toBe(401);
      const fresh=new Client(recovered,ip());expect((await fresh.signIn("fixture-post-restore-password-4")).status).toBe(200);
      expect((await fresh.resolve())?.principalId).toBe(f.principalId);
      const grants=readCommitted(f.paths.databasePath,db=>db.prepare("SELECT * FROM runtime_human_memberships WHERE revoked_at IS NULL").all());expect(grants).toEqual([]);
      expect(readFileSync(join(f.paths.dataDirectory,"authentication-provider.json"),"utf8")).not.toContain("fixture-restored-password");
    }finally{await current.close();}
  });
});
