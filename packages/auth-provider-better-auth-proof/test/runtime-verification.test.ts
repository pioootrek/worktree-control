import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ControlService } from "@/server/control-service";
import { IdentityService, type ProviderSessionActor } from "@/server/modules/identity";
import { createControllerAuthentication } from "@/server/bootstrap/authentication";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime } from "@/server/modules/authentication";
import { SqliteStateStore } from "@/server/sqlite-store";
import { TestJobManager } from "@/server/test-job-manager";
import { nullLogWriter } from "@/server/log-writer";
import { KnowledgeService } from "@/server/modules/knowledge";
import { acquireControllerLock } from "@/server/controller-lock";
import type { ScopedTestRunStatus } from "@/shared/contracts/scoped-verification";
import type { CompactEnvelope } from "@/server/modules/status";
import { runtimeReaderFixture, EXISTING_OWNER } from "./runtime-reader-fixture";
import { BrowserClient } from "./browser-authentication-fixture";
import { gate } from "./strict-fixture";
import type { ProcessManager } from "@/server/process-manager";
import type { ProjectTestCommandResolver } from "@/server/test-command";
import { OWNER_PASSWORD, ORIGIN } from "./fixture";

const route = "/api/runtime/tests";
type F = Awaited<ReturnType<typeof fixture>>;
const rights = ["tests:run", "claims:manage", "projects:read", "runtime:control"];
async function assign(f: Awaited<ReturnType<typeof runtimeReaderFixture>>, permissions = ["tests:run"], revision = 0, principal = f.human) {
  await f.run(["runtime-access","set",...f.input({principalId:principal,scope:{kind:"runtime-project",id:f.a.id},role:"operator",permissions,expectedRevision:revision})]);
}
async function fixture() {
  const f = await runtimeReaderFixture({verification:true,mutations:true});
  await f.core(() => f.store.releaseReservation(f.a.id,"local-user",true));
  await f.enroll(); const http = await f.listen();
  expect((await http.human.login(OWNER_PASSWORD,"runtime-human@fixture.invalid")).status).toBe(200);
  expect((await http.owner.login()).status).toBe(200);
  const second = new BrowserClient(http.human.socketPath);
  expect((await second.login(OWNER_PASSWORD,"runtime-human@fixture.invalid")).status).toBe(200);
  const enqueueInput = {operation:"enqueue",projectId:f.a.id,worktreePath:f.a.repositoryPath,presetId:"node:test",idempotencyKey:"enqueue"};
  const terminal = async (id:string) => { await vi.waitFor(async()=>expect((await f.core(()=>f.store.getTestRun(id)))?.telemetry?.finalizedAt).toBeTruthy());return f.core(()=>f.store.getTestRun(id)!); };
  const block = async () => {
    const barrier = gate();
    const run = await f.core(()=>f.manager!.enqueue({projectId:f.b.id,worktree:{path:f.b.repositoryPath,head:"a".repeat(40),shortHead:"aaaaaaa",branch:"main",dirty:false,statusError:undefined,detached:false,locked:false,prunable:false},
      command:{preset:{id:"node:test",name:"test",adapter:"node",timeoutMs:5000},executable:process.execPath,args:["-e",""],cwd:f.b.repositoryPath},
      environment:{environment:{},mode:"clean",profile:"unit",inheritedServerProfile:null,variableNames:[]},actor:"local-user",sourceObservation:f.observation(),observe:async()=>{await barrier.opened;return f.observation();}}));
    await vi.waitFor(async()=>expect((await f.core(()=>f.manager!.status())).running).toBe(1));
    return {release:()=>barrier.open(),run};
  };
  const call=(body:unknown, client=http.human)=>client.call(route,{body});
  const enqueue=async(extra={})=>{const r=await call({...enqueueInput,...extra});expect(r.status).toBe(200);return r.body as unknown as CompactEnvelope<ScopedTestRunStatus>;};
  return {...f,http,second,enqueueInput,call,enqueue,terminal,block};
}
function safe(value:unknown) {
  expect(JSON.stringify(value)).not.toMatch(/sentinel|sessionKey|evidenceKey|nativeSessionId|generation|membershipRevision|principalId|credentialId|sessionOwner|reference|authority|capacity|queuePosition|logs|environment|executable|args|profile/);
}
async function invalidate(f:F, reason:string) {
  if(reason==="revoke"||reason==="regrant") {await f.revoke(f.human);if(reason==="regrant")await assign(f,["tests:run"],2);}
  if(reason==="disable")await f.run(["human","disable","--principal-id",f.human]);
  if(reason==="logout")await f.http.human.call("/api/auth/sign-out",{body:{}});
  if(reason==="expiry")await f.sql('UPDATE authentication_ba_session SET "expiresAt"=?',[new Date(Date.now()-60_000).toISOString()]);
  if(reason==="generation")await f.sql("UPDATE authentication_account_policies SET generation=generation+1");
  if(reason==="policy")await f.sql("UPDATE authentication_account_policies SET policy_revision=policy_revision+1");
  if(reason==="permissions")await f.sql(`UPDATE runtime_human_memberships SET permissions_json='["projects:read"]' WHERE principal_id=?`,[f.human]);
  if(reason==="remap")await f.sql("UPDATE authentication_provider_subjects SET linked_at=? WHERE principal_id=?",[new Date(Date.now()+1000).toISOString(),f.human]);
}
const invalidations=["revoke","regrant","disable","logout","expiry","generation","policy","permissions","remap"];
describe("real provider human finite verification",()=>{
  it("grants tests-only explicitly through protected CLI without loading provider or granting other actions",async()=>{
    const f=await runtimeReaderFixture({verification:true});
    try {
      await assign(f);expect(f.load).not.toHaveBeenCalled();
      const listed=await f.run(["runtime-access","list","--principal-id",f.human]);expect(JSON.stringify(listed)).toContain("tests:run");
      await f.enroll();const http=await f.listen();await http.human.login(OWNER_PASSWORD,"runtime-human@fixture.invalid");const actor=await f.actor(http.human);
      expect((await f.core(()=>f.composition.identity.describeIdentity(actor))).runtimeAccess).toEqual([{projectId:f.a.id,actions:["tests:run"],expiresAt:null}]);
      for(const action of ["projects:read","claims:manage","runtime:control","profiles:select","config:write"] as const) await expect(f.core(()=>f.composition.identity.authorizeRuntime(actor,f.a.id,action))).rejects.toMatchObject({code:"runtime_forbidden"});
      await expect(f.run(["runtime-access","set",...f.input({principalId:f.human,scope:{kind:"runtime-project",id:f.b.id},role:"operator",expectedRevision:0})])).rejects.toThrow();
    } finally {await f.close();}
  });
  it("discovers safely, runs tests-only without claim, replays once, reads and cancels with original session",async()=>{
    const f=await fixture();try{
      await assign(f);const discovery=await f.call({operation:"presets",projectId:f.a.id});expect(discovery).toMatchObject({status:200});
      expect(discovery.body).toEqual([{worktreePath:f.a.repositoryPath,presets:[{id:"node:test",timeoutMs:5000}]}]);safe(discovery.body);
      const queued=await f.enqueue();safe(queued);const id=queued.status.runId;await f.terminal(id);
      const status=await f.call({operation:"status",runId:id});expect(status).toMatchObject({status:200,body:{status:{phase:"passed",source:{attribution:"observed_match"}}}});safe(status.body);
      expect((await f.enqueue()).status.runId).toBe(id);expect(readFileSync(f.marker,"utf8").match(/spawn/g)).toHaveLength(1);
      expect(await f.core(()=>f.store.getTestRunRequester(id))).toBeNull();expect(await f.core(()=>f.store.getHumanTestRunRequester(id))).toMatchObject({kind:"human",authority:{principalId:f.human},reservationId:null});
      expect(await f.call({operation:"cancel",runId:id})).toMatchObject({status:200,body:{status:{runId:id}}});
      expect(f.start).not.toHaveBeenCalled();expect(f.stop).not.toHaveBeenCalled();
      expect(status.headers["cache-control"]).toBe("no-store");expect(status.headers["set-cookie"]).toBeUndefined();
    }finally{await f.close();}
  });
  it("denies reader/control roles without tests, two sessions, another human, owner, agent and copied/foreign actors uniformly",async()=>{
    const f=await fixture(),foreign=await runtimeReaderFixture({verification:true});try{
      for(const permissions of [["projects:read"],["claims:manage","runtime:control"]]) {
        await assign(f,permissions,permissions.length===1?0:1);
        expect((await f.call({operation:"presets",projectId:f.a.id})).status).toBe(403);
      }
      await assign(f,["tests:run"],2);const queued=await f.enqueue(),id=queued.status.runId;await f.terminal(id);
      await assign(f,["tests:run"],0,EXISTING_OWNER);
      for(const client of [f.second,f.http.owner]) for(const operation of ["status","cancel","wait"]) {
        const body={operation,runId:id,...(operation==="wait"?{cursor:queued.cursor,timeoutMs:1}:{})};
        const denied=await f.call(body,client);expect(denied).toMatchObject({status:403,body:{code:"project_access_denied"}});
        expect((await f.call({...body,runId:randomUUID()},client)).body).toEqual(denied.body);
      }
      const actor=await f.actor(f.http.human);
      for(const caller of [{...actor},f.agentActor,f.oldOwner])await expect(f.service.humanVerificationOperation(caller as ProviderSessionActor,{operation:"status",runId:id})).rejects.toThrow();
      await expect(foreign.service.humanVerificationOperation(actor,{operation:"presets",projectId:foreign.a.id})).rejects.toThrow();
      const missing=new IdentityService(f.store,undefined,undefined,undefined,undefined,f.store,undefined,f.store.runtimeMemberships());
      await expect(f.core(()=>missing.captureHumanVerificationAuthority(actor,f.a.id))).rejects.toThrow();
      expect((await f.call({...f.enqueueInput},f.second)).status).toBe(403); // same durable key cannot duplicate old session work
      expect(readFileSync(f.marker,"utf8").match(/spawn/g)).toHaveLength(1);
      expect((await f.call({...f.enqueueInput,presetId:"node:other"})).status).not.toBe(200);
      const other=(await f.composition.execute({command:"auth-provider",action:"human-create"}) as {principal:{id:string}}).principal.id;
      await f.composition.execute({command:"auth-provider",action:"enroll",principalId:other,input:{email:"jobs-other@fixture.invalid",name:"Other",password:OWNER_PASSWORD}});await assign(f,["tests:run"],0,other);
      const client=new BrowserClient(f.http.human.socketPath);await client.login(OWNER_PASSWORD,"jobs-other@fixture.invalid");expect((await f.call({operation:"status",runId:id},client)).status).toBe(403);
    }finally{await foreign.close();await f.close();}
  });
  it("rejects raw authority/commands/duplicate fields, wrong host/origin/content type and legacy token bypass",async()=>{
    const f=await fixture();try{
      await assign(f);
      for(const extra of [{actor:"owner"},{sessionOwner:"agent:mcp:forged"},{principalId:f.human},{authority:{}},{args:[]},{environment:{}}])expect((await f.call({...f.enqueueInput,...extra})).status).toBe(400);
      for(const init of [{raw:'{"operation":"presets","operation":"presets","projectId":"'+f.a.id+'"}'},{method:"GET",body:undefined},{headers:{origin:"https://foreign.invalid"}},{headers:{host:"other.test"}},{headers:{"content-type":"text/plain"}},{raw:"x".repeat(4097)}])expect((await f.http.human.call(route,{body:f.enqueueInput,...init})).status).not.toBe(200);
      expect((await f.http.human.call(route,{body:f.enqueueInput,cookie:"",headers:{authorization:`Bearer ${f.installationToken}`}})).status).toBe(401);
      expect((await f.http.human.call(route+"?x=1",{body:f.enqueueInput})).status).toBe(400);
    }finally{await f.close();}
  });
  it.each(invalidations)("rechecks original session/evidence/membership after enqueue Git wait: %s",async reason=>{
    const f=await fixture(),entered=gate(),resume=gate();let pending:Promise<unknown>|undefined;try{
      await assign(f);f.hooks.git=async()=>{entered.open();await resume.opened;};pending=f.call(f.enqueueInput);await entered.opened;
      expect(f.store.admissionSnapshot().coreActive).toBe(0);await invalidate(f,reason);resume.open();
      expect([401,403,409]).toContain((await pending as {status:number}).status);expect(existsSync(f.marker)).toBe(false);
      expect(await f.core(()=>f.store.listTestRuns().length)).toBe(0);
    }finally{resume.open();await pending?.catch(()=>{});await f.close();}
  });
  it.each(invalidations)("dispatch checks current original native session without an HTTP actor: %s",async reason=>{
    const f=await fixture();const blocker=await f.block();try{
      await assign(f);const queued=await f.enqueue();await invalidate(f,reason);blocker.release();
      const run=await f.terminal(queued.status.runId);expect(run.phase).toBe("failed");expect(existsSync(f.marker)).toBe(false);
    }finally{blocker.release();await f.close();}
  });
  it.each(["new-claim","replacement","release","expiry"])("never attaches claim authority backward at dispatch/replay: %s",async mode=>{
    const f=await fixture(),blocker=await f.block();try{
      await assign(f,rights);
      const take=async(key:string)=>{const r=await f.http.human.call("/api/runtime/mutate",{body:{operation:"claim",projectId:f.a.id,worktreePath:f.a.repositoryPath,reason:"test",idempotencyKey:key}});expect(r.status).toBe(200);return(r.body.claim as {reservationId:string}).reservationId;};
      const id=mode==="new-claim"?undefined:await take("first");
      const queued=await f.enqueue(id?{reservationId:id}:{});
      if(mode==="new-claim")await take("second");
      else if(mode==="expiry")await f.sql("UPDATE human_runtime_leases SET expires_at=? WHERE reservation_id=?",[new Date(Date.now()-1000).toISOString(),id]);
      else {expect((await f.http.human.call("/api/runtime/mutate",{body:{operation:"release",projectId:f.a.id,reservationId:id,idempotencyKey:"release"}})).status).toBe(200);if(mode==="replacement")await take("second");}
      expect((await f.call({...f.enqueueInput,...(id?{reservationId:id}:{})})).status).toBe(409);
      blocker.release();expect((await f.terminal(queued.status.runId)).phase).toBe("failed");expect(existsSync(f.marker)).toBe(false);
    }finally{blocker.release();await f.close();}
  });
  it("accepts only the original session-bound human claim and keeps agent/human owners separate",async()=>{
    const f=await fixture();try{
      await assign(f,rights);const r=await f.http.human.call("/api/runtime/mutate",{body:{operation:"claim",projectId:f.a.id,worktreePath:f.a.repositoryPath,reason:"test",idempotencyKey:"claim"}});expect(r.status).toBe(200);
      const reservationId=(r.body.claim as {reservationId:string}).reservationId;
      expect((await f.call({...f.enqueueInput,idempotencyKey:"other",reservationId},f.second)).status).toBe(409);
      const run=await f.enqueue({reservationId});expect((await f.terminal(run.status.runId)).phase).toBe("passed");
    }finally{await f.close();}
  });
  it("rechecks immediately after source preflight before spawn",async()=>{
    const f=await fixture(),blocker=await f.block(),entered=gate(),resume=gate();try{
      await assign(f);const queued=await f.enqueue();f.hooks.observe=async()=>{entered.open();await resume.opened;};blocker.release();await entered.opened;
      expect(f.store.admissionSnapshot().coreActive).toBe(0);await f.revoke(f.human);resume.open();
      expect((await f.terminal(queued.status.runId)).phase).toBe("failed");expect(existsSync(f.marker)).toBe(false);
    }finally{resume.open();blocker.release();await f.close();}
  });
  it.each(invalidations)("wait rechecks current authority and cleans shared waiter budgets: %s",async reason=>{
    const f=await fixture(),blocker=await f.block();let pending:Promise<unknown>|undefined;try{
      await assign(f);const queued=await f.enqueue();pending=f.call({operation:"wait",runId:queued.status.runId,cursor:queued.cursor,timeoutMs:20000});
      await vi.waitFor(()=>expect(f.service.statusWaitDiagnostics().waiters).toBe(1));expect(f.store.admissionSnapshot().coreActive).toBe(0);
      await invalidate(f,reason);expect([401,403]).toContain((await pending as {status:number}).status);
      expect(f.service.statusWaitDiagnostics()).toMatchObject({waiters:0,targets:0,samplerTimers:0});
    }finally{blocker.release();await pending?.catch(()=>{});await f.close();}
  });
  it("shares sampler/budgets, scopes cursors by session/resource, cancels disconnects, and times out cleanly",async()=>{
    const f=await fixture(),blocker=await f.block();const requests:ReturnType<BrowserClient["start"]>[]=[];try{
      await assign(f);const queued=await f.enqueue();
      for(let i=0;i<4;i++){const req=f.http.human.start(route);req.send(JSON.stringify({operation:"wait",runId:queued.status.runId,cursor:queued.cursor,timeoutMs:20000}));req.completed.catch(()=>{});requests.push(req);}
      await vi.waitFor(()=>expect(f.service.statusWaitDiagnostics().waiters).toBe(4));
      expect(await f.call({operation:"wait",runId:queued.status.runId,cursor:queued.cursor,timeoutMs:20000})).toMatchObject({status:200,body:{errorCode:"status_wait_busy"}});
      for(const req of requests)req.abort();await Promise.allSettled(requests.map(r=>r.completed));
      await vi.waitFor(()=>expect(f.service.statusWaitDiagnostics()).toMatchObject({waiters:0,targets:0,samplerTimers:0}));
      expect(await f.call({operation:"wait",runId:queued.status.runId,cursor:queued.cursor,timeoutMs:10})).toMatchObject({status:200,body:{changed:false}});
      expect(await f.call({operation:"wait",runId:queued.status.runId,cursor:"foreign",timeoutMs:10})).toMatchObject({status:200,body:{changed:true}});
      expect((await f.call({operation:"wait",runId:queued.status.runId,cursor:queued.cursor},f.second)).status).toBe(403);
      expect(f.service.statusWaitDiagnostics().waiters).toBe(0);
    }finally{for(const req of requests)req.abort();blocker.release();await f.close();}
  });
  it.each(["missing","corrupt","missing-intent"])("marked human attribution cannot fall through to legacy at read/replay/dispatch: %s",async mode=>{
    const f=await fixture(),blocker=await f.block();try{
      await assign(f);const queued=await f.enqueue(),id=queued.status.runId;
      await f.sql(mode==="missing"?"DELETE FROM human_test_run_requesters WHERE run_id=?":mode==="missing-intent"?"DELETE FROM human_test_run_intents WHERE run_id=?":"UPDATE human_test_run_requesters SET reference_json='{}' WHERE run_id=?",[id]);
      expect((await f.call({operation:"status",runId:id})).status).toBe(403);expect((await f.call(f.enqueueInput)).status).not.toBe(200);
      blocker.release();expect((await f.terminal(id)).phase).toBe("failed");expect(existsSync(f.marker)).toBe(false);
    }finally{blocker.release();await f.close();}
  });
  it("keeps completed runs bound to original session/revision after regrant and does not duplicate durable retries",async()=>{
    const f=await fixture();try{
      await assign(f);const queued=await f.enqueue();await f.terminal(queued.status.runId);
      await f.revoke(f.human);await assign(f,["tests:run"],2);
      for(const operation of ["status","cancel","wait"])expect((await f.call({operation,runId:queued.status.runId,...(operation==="wait"?{cursor:queued.cursor}:{})})).status).toBe(403);
      expect((await f.call(f.enqueueInput)).status).toBe(403);expect(readFileSync(f.marker,"utf8").match(/spawn/g)).toHaveLength(1);
    }finally{await f.close();}
  });
  it("reopens the real store/provider with original authority, preserving history and interrupting stale queue without rerun",async()=>{
    const f=await fixture();let release:(()=>void)|undefined;let store:SqliteStateStore|undefined;let composition:ReturnType<typeof createControllerAuthentication>|undefined;let manager:TestJobManager|undefined;
    try{
      await assign(f);const queued=await f.enqueue();const saved=await f.terminal(queued.status.runId),cookie=f.http.human.cookie;
      await f.detach();const lock=acquireControllerLock(f.paths.controllerLockPath);release=()=>lock.release();store=new SqliteStateStore(f.paths.databasePath);
      // A durable queued checkpoint represents a process loss, not authority to rerun it.
      store.saveTestRun({...saved,phase:"queued",finishedAt:null});
      const authentication=new AuthenticationService(store);store.requireAdmission();
      let runtime:AuthenticationProviderRuntime|undefined;
      composition=createControllerAuthentication({store,dataDirectory:f.paths.dataDirectory,authentication,actor:"local-admin",loadProvider:async input=>{runtime=await loadAuthenticationProvider(input);return runtime;}});
      manager=await store.admission.run(()=>new TestJobManager(store!,nullLogWriter));
      const service=new ControlService(store,f.git,{snapshot:()=>({phase:"stopped",pid:null,logs:[]}),statusSummary:()=>({phase:"stopped",worktreePath:null,startedAt:null,ownsProcess:false,failureCode:null})} as unknown as ProcessManager,
        undefined,undefined,undefined,undefined,f.testCommands as unknown as ProjectTestCommandResolver,manager,undefined,undefined,undefined,composition.identity);
      await composition.prepareBrowserAuthentication({origin:ORIGIN,knowledge:new KnowledgeService(store,composition.identity),verification:service,trustedFixturePeer:"198.19.5.1"});
      const actor=await runtime!.authenticate(new Headers({cookie}));expect(actor).toBeTruthy();
      expect(await service.humanVerificationOperation(actor!,{operation:"status",runId:saved.id})).toMatchObject({status:{phase:"interrupted"}});
      expect(await service.humanVerificationOperation(actor!,f.enqueueInput)).toMatchObject({status:{runId:saved.id,phase:"interrupted"}});
      expect(readFileSync(f.marker,"utf8").match(/spawn/g)).toHaveLength(1);expect((await store.admission.run(()=>store!.listPendingTestRuns()))).toEqual([]);
    }finally{await manager?.shutdown();await composition?.dispose();await store?.closeAfterDrain();release?.();await f.close();}
  });
  it("suppresses a retained wait after a real provider borrow and queued membership revocation before readmission",async()=>{
    const f=await fixture(),blocker=await f.block(),entered=gate(),resume=gate();let waiting:Promise<unknown>|undefined,borrowed:Promise<unknown>|undefined;
    try{
      await assign(f);const queued=await f.enqueue(),actor=await f.actor(f.http.human);
      waiting=f.service.humanVerificationOperation(actor,{operation:"wait",runId:queued.status.runId,cursor:queued.cursor,timeoutMs:100});waiting.catch(()=>{});
      await vi.waitFor(()=>expect(f.service.statusWaitDiagnostics().waiters).toBe(1));
      borrowed=f.store.authenticationProviderStorage().borrow(async()=>{entered.open();await resume.opened;});await entered.opened;
      const revoke=f.store.admission.detached(()=>f.store.runtimeMemberships().saveRuntimeMembership({principalId:f.human,scope:{kind:"runtime-project",id:f.a.id},expectedRevision:1},"local-admin",new Date().toISOString()));
      await vi.waitFor(()=>expect(f.service.statusWaitDiagnostics().waiters).toBe(0));resume.open();await borrowed;await revoke;
      await expect(waiting).rejects.toThrow();expect(f.service.statusWaitDiagnostics()).toMatchObject({waiters:0,targets:0,samplerTimers:0});
    }finally{resume.open();blocker.release();await borrowed?.catch(()=>{});await waiting?.catch(()=>{});await f.close();}
  });
  it.each(["configuration","disposal"])("fails closed at dispatch when the shared provider has lost %s authority",async mode=>{
    const f=await fixture(),blocker=await f.block();try{
      await assign(f);const queued=await f.enqueue(),actor=await f.actor(f.http.human);
      if(mode==="configuration")await f.composition.execute({command:"auth-provider",action:"configure",input:{module:join(f.root,"runtime-provider.mjs"),origin:"https://next-controller.test",signingSecret:{kind:"preserve"}}});
      else await f.composition.dispose();
      await expect(f.service.humanVerificationOperation(actor,{operation:"status",runId:queued.status.runId})).rejects.toThrow();
      blocker.release();expect((await f.terminal(queued.status.runId)).phase).toBe("failed");expect(existsSync(f.marker)).toBe(false);expect(f.load).toHaveBeenCalledOnce();
    }finally{blocker.release();await f.close();}
  });
  it("cancels only its original session's active process and retains normal confirmed cleanup",async()=>{
    const f=await fixture();try{
      await assign(f);f.setDelay(4000);const queued=await f.enqueue(),id=queued.status.runId;
      await vi.waitFor(()=>expect(existsSync(f.marker)).toBe(true));
      expect((await f.call({operation:"cancel",runId:id},f.second)).status).toBe(403);
      expect((await f.call({operation:"cancel",runId:id})).status).toBe(200);
      expect(await f.terminal(id)).toMatchObject({phase:"cancelled",telemetry:{cleanup:"confirmed"}});
      safe((await f.call({operation:"status",runId:id})).body);
    }finally{await f.close();}
  });
  it("retains live idempotency keys after run-detail retention without duplicate execution or new-session adoption",async()=>{
    const f=await fixture();try{
      await assign(f);const queued=await f.enqueue(),id=queued.status.runId;await f.terminal(id);
      await f.sql("DELETE FROM test_runs WHERE id=?",[id]);
      expect((await f.call(f.enqueueInput)).status).not.toBe(200);expect((await f.call(f.enqueueInput,f.second)).status).not.toBe(200);
      expect(await f.core(()=>f.store.listTestRuns())).toEqual([]);expect(readFileSync(f.marker,"utf8").match(/spawn/g)).toHaveLength(1);
    }finally{await f.close();}
  });
  it("owner password recovery invalidates the queued original provider session, and a new login cannot adopt its key",async()=>{
    const f=await fixture(),blocker=await f.block();try{
      await assign(f,["tests:run"],0,EXISTING_OWNER);const r=await f.call(f.enqueueInput,f.http.owner);expect(r.status).toBe(200);const id=(r.body.status as ScopedTestRunStatus).runId;
      await f.run(["recover","--principal-id",EXISTING_OWNER,...f.input({newPassword:"replacement-jobs-password-123"})]);
      blocker.release();expect((await f.terminal(id)).phase).toBe("failed");
      expect((await f.http.owner.login("replacement-jobs-password-123")).status).toBe(200);expect((await f.call(f.enqueueInput,f.http.owner)).status).toBe(403);
      expect(existsSync(f.marker)).toBe(false);
    }finally{blocker.release();await f.close();}
  });
  it("human factor-loss reset fences queued jobs and a new login cannot adopt the old key",async()=>{
    const f=await fixture(),blocker=await f.block();try{
      await assign(f);const r=await f.call(f.enqueueInput);expect(r.status).toBe(200);const id=(r.body.status as ScopedTestRunStatus).runId;
      await f.run(["recover","--principal-id",f.human,...f.input({newPassword:"replacement-human-jobs-password-123",factors:"reset"})]);
      blocker.release();expect((await f.terminal(id)).phase).toBe("failed");
      expect((await f.http.human.login("replacement-human-jobs-password-123","runtime-human@fixture.invalid")).status).toBe(200);
      expect((await f.call(f.enqueueInput)).status).toBe(403);expect(existsSync(f.marker)).toBe(false);
    }finally{blocker.release();await f.close();}
  });
  it("uses only clean declared test profiles and does not resolve vault/server environment authority",async()=>{
    const f=await fixture();try{
      await assign(f);
      await f.core(()=>{ f.store.saveProjectTestEnvironmentProfile(f.a.id,{name:"inherited",policy:{mode:"inherit-server-profile",serverProfile:"default"},environment:{},nodeEnv:null,requiredVariables:[]},"fixture"); f.store.assignProjectTestPresetProfile(f.a.id,"node:test","inherited","fixture"); });
      expect((await f.call({operation:"presets",projectId:f.a.id})).body).toEqual([{worktreePath:f.a.repositoryPath,presets:[]}]);
      expect((await f.call(f.enqueueInput)).status).not.toBe(200);expect(existsSync(f.marker)).toBe(false);
    }finally{await f.close();}
  });
});
