import { createHash } from "node:crypto";
import { createControllerAuthentication } from "@/server/bootstrap/authentication";
import { acquireControllerLock } from "@/server/controller-lock";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { KnowledgeService } from "@/server/modules/knowledge";
import { runtimeMutateSchema } from "@/shared/contracts/runtime-mutate";
import { ORIGIN } from "./fixture";
import { describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { BrowserClient } from "./browser-authentication-fixture";
import { runtimeReaderFixture, EXISTING_OWNER, SECRET } from "./runtime-reader-fixture";
import { OWNER_PASSWORD, readCommitted } from "./fixture";
import { gate } from "./strict-fixture";

const route = "/api/runtime/mutate";
const all = ["projects:read", "claims:manage", "runtime:control"];
type F = Awaited<ReturnType<typeof runtimeReaderFixture>>;
async function assign(f: F, principalId = f.human, permissions = all, expectedRevision = 0, projectId = f.a.id) {
  return f.run(["runtime-access", "set", ...f.input({principalId,scope:{kind:"runtime-project",id:projectId},role:"operator",permissions,expectedRevision})]);
}
async function fixture() {
  const f = await runtimeReaderFixture({mutations:true});
  await f.core(() => f.store.releaseReservation(f.a.id, "local-user", true));
  await f.enroll(); const http = await f.listen();
  expect((await http.owner.login()).status).toBe(200);
  expect((await http.human.login(OWNER_PASSWORD,"runtime-human@fixture.invalid")).status).toBe(200);
  const second = new BrowserClient(http.human.socketPath);
  expect((await second.login(OWNER_PASSWORD,"runtime-human@fixture.invalid")).status).toBe(200);
  return {...f,http,second};
}
const claim = (f:F, key = "claim", extra = {}) => ({operation:"claim",projectId:f.a.id,worktreePath:"/code/a",reason:"Finite fixture",idempotencyKey:key,...extra});
const body = (operation:string, f:F, reservationId:string, idempotencyKey=operation, extra={}) => ({operation,projectId:f.a.id,reservationId,idempotencyKey,...extra});
async function take(f:Awaited<ReturnType<typeof fixture>>, extra={}) {
  const r = await f.http.human.call(route,{body:claim(f,"claim",extra)});
  expect(r).toMatchObject({status:200,body:{operation:"claim",startRequested:false}});
  return (r.body.claim as {reservationId:string}).reservationId;
}
describe("real provider human runtime mutations", () => {
  it("assigns an operator without provider load and without jobs, profiles, ENV or implicit role actions", async () => {
    const f = await runtimeReaderFixture({mutations:true});
    try {
      await assign(f,f.human,["claims:manage"]);
      expect(f.load).not.toHaveBeenCalled();
      await f.enroll(); const http=await f.listen(); await http.human.login(OWNER_PASSWORD,"runtime-human@fixture.invalid");
      const actor=await f.actor(http.human);
      expect((await f.core(()=>f.composition.identity.describeIdentity(actor))).runtimeAccess).toEqual([{projectId:f.a.id,actions:["claims:manage"],expiresAt:null}]);
      for(const action of ["projects:read","runtime:control","profiles:select","config:write","tests:run"] as const) {
        await expect(f.core(()=>f.composition.identity.authorizeRuntime(actor,f.a.id,action))).rejects.toMatchObject({code:"runtime_forbidden"});
      }
      expect((await http.human.call(route,{body:claim(f,"explicit-start",{start:true})})).status).toBe(403);
      for(const permissions of [[],["config:write"],["env:use"],["claims:manage","claims:manage"]]) {
        await expect(assign(f,f.human,permissions,1)).rejects.toThrow();
      }
      expect((await http.human.call("/api/runtime/read",{body:{operation:"list-projects"}})).body.projects).toEqual([]);
    } finally {await f.close();}
  });
  it("claims without starting, proves exact own status, controls and renews a finite lease, then releases idempotently", async () => {
    const f=await fixture();
    try {
      await assign(f); await assign(f,EXISTING_OWNER,all,0,f.b.id);
      const id=await take(f); expect(f.start).not.toHaveBeenCalled();
      const status=await f.http.human.call("/api/runtime/read",{body:{operation:"project-status",projectId:f.a.id}});
      expect(status).toMatchObject({status:200,body:{status:{claim:"own",ownClaim:{reservationId:id}}}});
      expect(await f.second.call("/api/runtime/read",{body:{operation:"project-status",projectId:f.a.id}})).toMatchObject({status:200,body:{status:{claim:"other",ownClaim:null}}});
      const lease=await f.core(()=>f.store.getActiveReservation(f.a.id));
      expect(Date.parse(lease!.expiresAt!)-Date.now()).toBeGreaterThan(1700_000);
      expect(Date.parse(lease!.maximumExpiresAt!)-Date.now()).toBeLessThanOrEqual(8*3600_000);
      expect((await f.http.human.call(route,{body:claim(f)})).body.replayed).toBe(true);
      expect((await f.http.human.call(route,{body:claim(f,"claim",{start:true})}))).toMatchObject({status:409,body:{code:"idempotency_conflict"}});
      for(const operation of ["start","restart","stop"]) expect(await f.http.human.call(route,{body:body(operation,f,id)})).toMatchObject({status:200,body:{receipt:{outcome:"completed",leaseHeld:true}}});
      expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).toHaveBeenCalledTimes(2);
      expect(await f.http.human.call(route,{body:body("restart",f,id)})).toMatchObject({status:200,body:{replayed:true,receipt:{replayed:true}}});
      expect(f.start).toHaveBeenCalledTimes(2);
      expect(await f.http.human.call(route,{body:body("renew",f,id,"renew",{ttlSeconds:60})})).toMatchObject({status:200,body:{claim:{reservationId:id}}});
      expect(await f.http.human.call(route,{body:body("release",f,id)})).toMatchObject({status:200,body:{released:true}});
      expect(await f.http.human.call(route,{body:body("release",f,id)})).toMatchObject({status:200,body:{released:true,replayed:true}});
      expect(await f.core(()=>f.store.getActiveReservation(f.a.id))).toBeNull();
      expect(await f.http.owner.call(route,{body:claim(f,"owner-b",{projectId:f.b.id,worktreePath:"/code/b"})})).toMatchObject({status:200});
      expect(await f.core(()=>f.store.getPrincipal(EXISTING_OWNER))).toEqual({id:EXISTING_OWNER,kind:"owner",status:"active"});
      expect(JSON.stringify([status.body,lease])).not.toContain(SECRET);
    } finally {await f.close();}
  });
  it("requires control captured at claim as well as current authority; a changed revision never attaches backward", async () => {
    const f=await fixture();
    try {
      await assign(f,f.human,["claims:manage"]);const id=await take(f);
      expect((await f.http.human.call(route,{body:body("start",f,id)})).status).toBe(403);
      await assign(f,f.human,all,1);
      for(const operation of ["renew","release","start","restart","stop"]) expect((await f.http.human.call(route,{body:body(operation,f,id)})).status).toBe(409);
      expect((await f.http.human.call(route,{body:claim(f)})).status).toBe(403);
      expect(f.start).not.toHaveBeenCalled();
    } finally {await f.close();}
  });
  it("refuses clone/foreign/missing authority, other sessions/humans/agent, and legacy owner/hash paths", async () => {
    const f=await fixture(),foreign=await runtimeReaderFixture({mutations:true});
    try {
      await assign(f); const id=await take(f),actor=await f.actor(f.http.human);
      await expect(f.service.mutateHumanRuntime({...actor} as ProviderSessionActor,body("start",f,id))).rejects.toMatchObject({code:"invalid_credential"});
      await expect(foreign.service.mutateHumanRuntime(actor,body("start",f,id))).rejects.toMatchObject({code:"invalid_credential"});
      const missing=new IdentityService(f.store,undefined,undefined,undefined,undefined,f.store,undefined,f.store.runtimeMemberships());
      await expect(f.core(()=>missing.resolveHumanRuntimeAuthority(actor,f.a.id,["claims:manage"]))).rejects.toMatchObject({code:"invalid_credential"});
      for(const operation of ["renew","release","start","restart","stop"]) expect((await f.second.call(route,{body:body(operation,f,id)})).status).toBe(409);
      await expect(f.service.mutateHumanRuntime(f.agentActor as never,body("start",f,id))).rejects.toMatchObject({code:"invalid_credential"});
      const human2=(await f.composition.execute({command:"auth-provider",action:"human-create"}) as {principal:{id:string}}).principal.id;
      await f.composition.execute({command:"auth-provider",action:"enroll",principalId:human2,input:{email:"other@fixture.invalid",name:"Other",password:OWNER_PASSWORD}});
      await assign(f,human2);const other=new BrowserClient(f.http.human.socketPath);await other.login(OWNER_PASSWORD,"other@fixture.invalid");
      expect((await other.call(route,{body:body("stop",f,id)})).status).toBe(409);
      const own=await f.core(()=>f.store.getActiveReservation(f.a.id));
      for(const binding of [undefined,{principalId:f.human,credentialId:"supplied"}]) await expect(f.core(()=>f.store.authorizeReservation(f.a.id,own!.owner,"a".repeat(64),binding))).rejects.toMatchObject({code:"claim_stale"});
      await expect(f.core(()=>f.store.releaseReservation(f.a.id,own!.owner))).rejects.toMatchObject({code:"claim_stale"});
      await expect(f.core(()=>f.store.renewAgentReservation(f.a.id,id,own!.owner,"a".repeat(64),60))).rejects.toThrow();
      await expect(f.core(()=>f.store.releaseAgentReservation(f.a.id,id,own!.owner,"a".repeat(64)))).rejects.toThrow();
      expect((await other.call(route,{body:claim(f,"foreign-conflict")}))).toMatchObject({status:409,body:{code:"claim_conflict"}});
      expect(f.start).not.toHaveBeenCalled();
    } finally {await foreign.close();await f.close();}
  });
  it("keeps operation rights independent of projects:read and sanitizes all successful receipts", async () => {
    const f=await fixture();
    try {
      await assign(f,f.human,["claims:manage","runtime:control"]);const id=await take(f);
      expect((await f.http.human.call("/api/runtime/read",{body:{operation:"project-status",projectId:f.a.id}})).status).toBe(403);
      const r=await f.http.human.call(route,{body:body("start",f,id)});expect(r.status).toBe(200);
      const text=JSON.stringify(r.body);for(const secret of [SECRET,"sessionKey","evidenceKey","generation","membershipRevision","capacity","commands","environment","owner","token","credential"]) expect(text).not.toContain(secret);
      expect(r.headers["set-cookie"]).toBeUndefined();expect(r.headers["cache-control"]).toBe("no-store");
      expect((await f.http.human.call(route,{body:body("stop",f,id)})).status).toBe(200);
    } finally {await f.close();}
  });
  it.each(["revoke","disable","logout","recovery","expiry","generation","permissions","regrant"] as const)("rechecks original authority after Git wait: %s",async reason=>{
    const f=await fixture(),entered=gate(),resume=gate();let pending:Promise<unknown>|undefined;
    try {
      const principalId=reason==="recovery"?EXISTING_OWNER:f.human;
      const client=reason==="recovery"?f.http.owner:f.http.human;
      await assign(f,principalId);const claimed=await client.call(route,{body:claim(f)});expect(claimed.status).toBe(200);
      const id=(claimed.body.claim as {reservationId:string}).reservationId;
      f.hooks.git=async()=>{entered.open();await resume.opened;};
      pending=client.call(route,{body:body("restart",f,id)});await entered.opened;
      expect(f.store.admissionSnapshot().coreActive).toBe(0);
      if(reason==="revoke"||reason==="regrant") {await f.revoke(f.human);if(reason==="regrant")await assign(f,f.human,all,2);}
      if(reason==="disable")await f.run(["human","disable","--principal-id",f.human]);
      if(reason==="logout")await f.http.human.call("/api/auth/sign-out",{body:{}});
      if(reason==="recovery")await f.run(["recover","--principal-id",EXISTING_OWNER,...f.input({newPassword:"replacement-runtime-password-1"})]);
      if(reason==="expiry")await f.sql('UPDATE authentication_ba_session SET "expiresAt"=?',[new Date(Date.now()-60_000).toISOString()]);
      if(reason==="generation")await f.sql("UPDATE authentication_account_policies SET generation=generation+1");
      if(reason==="permissions")await f.sql(`UPDATE runtime_human_memberships SET permissions_json='["claims:manage"]' WHERE principal_id=?`,[f.human]);
      resume.open();expect([401,403,409]).toContain((await pending as {status:number}).status);expect(f.start).not.toHaveBeenCalled();
      expect((await client.call(route,{body:body("restart",f,id)})).status).not.toBe(200);
    } finally {resume.open();await pending?.catch(()=>{});await f.close();}
  });
  it.each(["pre-spawn","delivery","project-lock"] as const)("rechecks current authority at %s without leaking retained results",async phase=>{
    const f=await fixture(),entered=gate(),resume=gate();let pending:Promise<unknown>|undefined;
    try {
      await assign(f);const id=await take(f);
      if(phase==="pre-spawn")f.hooks.beforeSpawn=async()=>{entered.open();await resume.opened;};
      if(phase==="delivery")f.hooks.afterSpawn=async()=>{entered.open();await resume.opened;};
      if(phase==="project-lock")f.hooks.git=async()=>{entered.open();await resume.opened;};
      pending=f.http.human.call(route,{body:body("restart",f,id)});await entered.opened;
      const queued=phase==="project-lock"?f.http.human.call(route,{body:body("stop",f,id,"queued-stop")}):undefined;
      await f.revoke(f.human);resume.open();
      expect([401,403,409]).toContain((await pending as {status:number}).status);
      if(queued)expect([401,403,409]).toContain((await queued).status);
      if(phase==="delivery")expect(f.start).toHaveBeenCalledOnce();
      else if(phase==="pre-spawn")expect(f.start).toHaveBeenCalledOnce(); // called verifier refuses before effect
      else expect(f.start).not.toHaveBeenCalled();
      expect((await f.http.human.call(route,{body:body("restart",f,id)})).status).not.toBe(200);
    } finally {resume.open();await pending?.catch(()=>{});await f.close();}
  });
  it("retains intent across disconnect, concurrent retry and application reconstruction without duplicating restart",async()=>{
    const f=await fixture(),entered=gate(),resume=gate();
    try {
      await assign(f);const id=await take(f);f.hooks.afterSpawn=async()=>{entered.open();await resume.opened;};
      const request=f.http.human.start(route),outcome=request.completed.catch(error=>error);request.send(JSON.stringify(body("restart",f,id)));await entered.opened;
      request.abort();await outcome;
      expect(await f.http.human.call(route,{body:body("restart",f,id)})).toMatchObject({status:409,body:{code:"outcome_unknown"}});
      expect(f.start).toHaveBeenCalledOnce();resume.open();
      await vi.waitFor(async()=>expect((await f.http.human.call(route,{body:body("restart",f,id)})).status).toBe(200));
      expect(f.start).toHaveBeenCalledOnce();
      const a=await f.actor(f.http.human);
      // Rebuilding application resources cannot forget durable intent/receipt.
      const rebuilt=new ControlService(f.store,f.git,{} as never,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,f.composition.identity);
      expect(await rebuilt.mutateHumanRuntime(a,body("restart",f,id))).toMatchObject({replayed:true});expect(f.start).toHaveBeenCalledOnce();
      f.hooks.afterSpawn=undefined;
      expect((await f.http.human.call(route,{body:body("release",f,id)})).status).toBe(200);
      expect((await f.http.human.call(route,{body:claim(f,"replacement")})).status).toBe(200);
      expect((await f.http.human.call(route,{body:body("restart",f,id)})).status).toBe(409);
    } finally {resume.open();await f.close();}
  });
  it("reopens the sole database and real provider with the same cookie, preserving completed and interrupted intents",async()=>{
    const f=await fixture();let reopened:SqliteStateStore|undefined,composition:ReturnType<typeof createControllerAuthentication>|undefined;
    let lock:ReturnType<typeof acquireControllerLock>|undefined;
    try{
      await assign(f);const id=await take(f),cookie=f.http.human.cookie;
      expect((await f.http.human.call(route,{body:body("start",f,id)})).status).toBe(200);
      const actor=await f.actor(f.http.human);
      const original=await f.core(()=>f.composition.identity.resolveHumanRuntimeAuthority(actor,f.a.id,["runtime:control"]));
      const interrupted=runtimeMutateSchema.parse(body("restart",f,id,"interrupted"));
      await f.core(()=>{const q=f.store.humanRuntime();q.begin(original,f.a.id,"interrupted",createHash("sha256").update(JSON.stringify(interrupted)).digest("hex"));q.attach(original,"interrupted",id);});
      await f.detach();
      lock=acquireControllerLock(f.paths.controllerLockPath);reopened=new SqliteStateStore(f.paths.databasePath);
      const store=reopened,authentication=new AuthenticationService(store);store.requireAdmission();
      let loaded:AuthenticationProviderRuntime|undefined;
      composition=createControllerAuthentication({store,dataDirectory:f.paths.dataDirectory,authentication,actor:"local-admin",loadProvider:async input=>{loaded=await loadAuthenticationProvider(input);return loaded;}});
      const effects=vi.fn();
      const service=new ControlService(store,f.git,{snapshot:()=>({phase:"stopped",pid:null,worktreePath:null,startedAt:null}),start:effects,stop:effects} as never,
        undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,composition.identity);
      await composition.prepareBrowserAuthentication({origin:ORIGIN,knowledge:new KnowledgeService(store,composition.identity),runtimeReads:service,runtimeMutations:service});
      const current=await loaded!.authenticate(new Headers({cookie}));expect(current).not.toBeNull();
      const authority=await store.admission.run(()=>composition!.identity.resolveHumanRuntimeAuthority(current!,f.a.id,["runtime:control"]));
      expect(authority).toEqual(original);
      expect(await service.mutateHumanRuntime(current!,body("start",f,id))).toMatchObject({replayed:true});
      await expect(service.mutateHumanRuntime(current!,interrupted)).rejects.toMatchObject({code:"outcome_unknown"});
      await expect(service.mutateHumanRuntime(current!,{...interrupted,operation:"stop"})).rejects.toMatchObject({code:"idempotency_conflict"});
      expect(effects).not.toHaveBeenCalled();
    }finally{await composition?.dispose();await reopened?.closeAfterDrain();lock?.release();await f.close();}
  });
  it("rechecks a claim after actual provider borrowing and queued revocation before readmission",async()=>{
    const f=await fixture(),entered=gate(),resume=gate(),borrowed=gate(),release=gate();
    let pending:Promise<unknown>|undefined,borrow:Promise<unknown>|undefined,revoke:Promise<unknown>|undefined;
    try{
      await assign(f);f.hooks.git=async()=>{entered.open();await resume.opened;};
      pending=f.http.human.call(route,{body:claim(f)});await entered.opened;
      borrow=f.store.authenticationProviderStorage().borrow(async()=>{borrowed.open();await release.opened;});await borrowed.opened;
      revoke=f.composition.execute({command:"auth-provider",action:"runtime-access-revoke",input:{principalId:f.human,scope:{kind:"runtime-project",id:f.a.id},expectedRevision:1}});
      await vi.waitFor(()=>expect(f.store.admissionSnapshot().queuedCore).toBe(1));resume.open();
      await vi.waitFor(()=>expect(f.store.admissionSnapshot().queuedCore).toBe(2));release.open();await borrow;await revoke;
      expect(await pending).toMatchObject({status:403});expect(await f.core(()=>f.store.getActiveReservation(f.a.id))).toBeNull();
    }finally{resume.open();release.open();await Promise.allSettled([pending,borrow,revoke]);await f.close();}
  });
  it("explicitly starts at claim, bounds deadlines by the original provider session, and expires without stopping the process",async()=>{
    const f=await fixture();
    try{
      await assign(f);
      // Native refresh may move expiresAt, but cannot extend committed original evidence.
      const deadline = async (seconds:number) => {
        const value=new Date(Date.now()+seconds*1000).toISOString();
        await f.sql('UPDATE authentication_ba_session SET "expiresAt"=?',[value]);
        await f.sql("UPDATE authentication_session_evidence SET original_deadline=?",[value]);
        await f.sql("UPDATE authentication_session_issuance SET original_deadline=?",[value]);
      };
      await deadline(20);
      expect((await f.http.human.call(route,{body:claim(f,"too-short")})).status).toBe(409);
      await deadline(120);
      const response=await f.http.human.call(route,{body:claim(f,"explicit",{start:true})});
      expect(response).toMatchObject({status:200,body:{startRequested:true}});expect(f.start).toHaveBeenCalledOnce();
      const c=response.body.claim as {reservationId:string;expiresAt:string;maximumExpiresAt:string};
      expect(Date.parse(c.maximumExpiresAt)-Date.now()).toBeLessThan(120_000);expect(c.expiresAt).toBe(c.maximumExpiresAt);
      await f.sql("UPDATE human_runtime_leases SET expires_at=? WHERE reservation_id=?",[new Date(Date.now()-1).toISOString(),c.reservationId]);
      expect(await f.core(()=>f.store.getActiveReservation(f.a.id))).toBeNull();expect(f.stop).not.toHaveBeenCalled();
      expect((await f.http.human.call(route,{body:body("renew",f,c.reservationId)})).status).toBe(409);
    }finally{await f.close();}
  });
  it("retains failed runtime receipts and requires current rights before replay",async()=>{
    const f=await fixture();
    try{
      await assign(f);const id=await take(f);
      f.commands.resolve.mockImplementationOnce(()=>{throw new Error(SECRET);});
      const request=body("restart",f,id),failed=await f.http.human.call(route,{body:request});
      expect(failed).toMatchObject({status:200,body:{receipt:{outcome:"failed",error:{code:"runtime_operation_failed"}}}});
      expect(JSON.stringify(failed.body)).not.toContain(SECRET);
      const calls=f.commands.resolve.mock.calls.length;
      expect(await f.http.human.call(route,{body:request})).toMatchObject({status:200,body:{replayed:true,receipt:{outcome:"failed"}}});
      expect(f.commands.resolve).toHaveBeenCalledTimes(calls);expect(f.start).not.toHaveBeenCalled();
      await f.revoke(f.human);expect((await f.http.human.call(route,{body:request})).status).toBe(403);
    }finally{await f.close();}
  });
  it("keeps a disconnected mutation's HTTP slot until its real work settles",async()=>{
    const f=await fixture(),entered=gate(),resume=gate();
    const slow:Array<{abort():void;completed:Promise<unknown>}>=[];
    try{
      await assign(f);const id=await take(f);f.hooks.afterSpawn=async()=>{entered.open();await resume.opened;};
      const request=f.http.human.start(route),cancelled=request.completed.catch(error=>error);request.send(JSON.stringify(body("restart",f,id)));await entered.opened;
      for(let i=0;i<15;i++){const call=f.http.human.start(route);slow.push({abort:call.abort,completed:call.completed.catch(error=>error)});call.write('{"operation":');}
      const status=()=>f.http.human.call("/api/runtime/read",{body:{operation:"list-projects"}});
      await vi.waitFor(async()=>expect((await status()).status).toBe(503));request.abort();await cancelled;
      expect((await status()).status).toBe(503);for(const call of slow)call.abort();await Promise.all(slow.map(call=>call.completed));
      // Accepted work remains tracked after the response is closed, even though other slots are free.
      expect(f.start).toHaveBeenCalledOnce();resume.open();await vi.waitFor(async()=>expect((await status()).status).toBe(200));
      expect(await f.http.human.call(route,{body:body("restart",f,id)})).toMatchObject({status:200,body:{replayed:true}});expect(f.start).toHaveBeenCalledOnce();
    }finally{for(const call of slow)call.abort();resume.open();await Promise.allSettled(slow.map(call=>call.completed));await f.close();}
  });
  it("denies an old lease after a new login even with the same principal and idempotency key",async()=>{
    const f=await fixture();
    try {await assign(f);const id=await take(f);await f.http.human.call(route,{body:body("start",f,id)});
      await f.http.human.call("/api/auth/sign-out",{body:{}});expect((await f.http.human.login(OWNER_PASSWORD,"runtime-human@fixture.invalid")).status).toBe(200);
      for(const operation of ["renew","release","start","restart","stop"])expect((await f.http.human.call(route,{body:body(operation,f,id)})).status).toBe(409);
      expect(f.start).toHaveBeenCalledOnce();
    }finally{await f.close();}
  });
  it("strictly bounds HTTP input and fails closed for every unconverted workflow",async()=>{
    const f=await fixture();
    try {await assign(f);
      for(const extra of [{actor:{}},{owner:"human"},{sessionKey:"fake"},{generation:0},{force:true},{leaseToken:"fake"}])expect((await f.http.human.call(route,{body:claim(f,"bad",extra)})).status).toBe(400);
      for(const ttlSeconds of [0,29,1801,1.5])expect((await f.http.human.call(route,{body:claim(f,"bad",{ttlSeconds})})).status).toBe(400);
      expect((await f.http.human.call(route,{raw:JSON.stringify(claim(f,"large",{reason:"x".repeat(5000)}))})).status).toBe(413);
      expect((await f.http.human.call(route,{raw:'{"operation":"claim","operation":"stop"}'})).status).toBe(400);
      for(const [headers,status] of [[{origin:"https://other.invalid"},403],[{host:"other.invalid"},421],[{"sec-fetch-site":"cross-site"},403]] as const)expect((await f.http.human.call(route,{body:claim(f),headers})).status).toBe(status);
      expect((await f.http.human.call(route,{body:claim(f),omitOrigin:true})).status).toBe(403);
      expect((await f.http.human.call(route,{method:"GET"})).status).toBe(405);
      expect((await f.http.human.call(route,{body:claim(f),cookie:"",headers:{authorization:`Bearer ${f.installationToken}`}})).status).toBe(401);
      const missing=await f.http.human.call(route,{body:claim(f,"missing",{projectId:"missing"})}),forbidden=await f.http.human.call(route,{body:claim(f,"forbidden",{projectId:f.b.id})});expect(missing.body).toEqual(forbidden.body);
      for(const path of ["/api/tests","/api/runtime/unknown","/api/runtime/claim","/api/capacity","/api/logs","/api/projects","/api/admin"])expect((await f.http.human.call(path,{body:{}})).status).toBe(401);
      const actor=await f.actor(f.http.human);
      for(const method of [()=>f.service.scopedTestPresets(actor,{projectId:f.a.id,worktreePath:"/code/a"}),()=>f.service.scopedProjectConfiguration(actor,{projectId:f.a.id})])await expect(f.core<unknown>(method)).rejects.toThrow();
      const raw=readCommitted(f.paths.databasePath,db=>db.prepare("SELECT * FROM principal_credentials WHERE principal_id=?").all(f.human));expect(raw).toEqual([]);
    }finally{await f.close();}
  });
});
