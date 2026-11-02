import { afterEach, describe, expect, test, vi } from "vitest";
import type Database from "better-sqlite3";
import { Browser, cleanupFactorRoots, fixtureSql } from "./factor-fixture";
import { COOKIE } from "./factor-provider";
import { OWNER_PASSWORD } from "./fixture";
import { PasskeyAdmission, PASSKEY_BOUNDS } from "./passkey-admission";
import { PasskeyAuthenticator, type AuthenticatorInput, type CeremonyOptions } from "./passkey-authenticator";
import { closePasskey, loadPasskey, observePasskeySession, passkeyFixture, passkeyState, type PasskeyFixture } from "./passkey-fixture";
import { PASSKEY_COOKIE } from "./passkey-provider";

afterEach(()=>{vi.useRealTimers();cleanupFactorRoots();});
const ok=(r:{status:number})=>expect(r.status).toBe(200);
const refused=(r:{status:number;setCookie:string[]})=>{expect(r.status>=400).toBe(true);expect(r.setCookie.length).toBe(0);};
const options=async(b:Browser,kind:"register"|"authenticate"|"confirm")=>{
  const r=await b.post(`/passkey/generate-${kind}-options`,{},{method:"GET"});ok(r);
  return r.json!.options as unknown as CeremonyOptions;
};
const confirm=(b:Browser,response:unknown,signal?:AbortSignal)=>b.post("/passkey/verify-confirmation",{response},{signal});
async function owned(fn:(f:PasskeyFixture)=>Promise<void>,emails:string[]=[]){
  const f=await passkeyFixture(undefined,emails);try{await fn(f);}finally{await closePasskey(f);}
}
async function stage(f:PasskeyFixture,input:AuthenticatorInput={},b=new Browser(f)){
  if(!b.cookies.has(COOKIE.session)) ok(await b.signIn());
  const a=new PasskeyAuthenticator(),o=await options(b,"register");
  const r=await b.post("/passkey/verify-registration",{response:a.register(o,{...input,attestationNone:true})});
  ok(r);expect(r.json).toEqual({outcome:"staged",authorizing:false});expect(r.setCookie.length).toBe(0);
  return {b,a};
}
const charged=(state:Awaited<ReturnType<typeof passkeyState>>)=>state.budgets.reduce((sum,r)=>sum+r.charged,0);
async function pristine(f:PasskeyFixture,before:Awaited<ReturnType<typeof passkeyState>>){
  const after=await passkeyState(f);
  expect(after.trusted.length).toBe(0);expect(after.credentials).toEqual(before.credentials);
  expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);
  return after;
}

describe("A3-I15 staged fmt:none enrollment, real native signed UV confirmation",()=>{
  for(const uv of [true,false]) test(`unsigned registration UV=${uv} is only staged; signed confirmation promotes without a login`,async()=>owned(async f=>{
    const {b,a}=await stage(f,{uv});const before=await passkeyState(f),originalCookie=b.cookies.get(COOKIE.session);
    expect(before.trusted.length).toBe(0);expect(before.staged.length).toBe(1);
    expect(f.control.observations.at(-1)?.userVerified).toBe(false);
    const normal=new Browser(f),login=await options(normal,"authenticate");
    refused(await normal.post("/passkey/verify-authentication",{response:a.assert(login)}));
    const c=await options(b,"confirm") as CeremonyOptions & {allowCredentials:Array<{id:string}>;userVerification:string};
    expect(c.allowCredentials.length).toBe(1);expect(c.allowCredentials[0]?.id===a.id).toBe(true);expect(c.userVerification).toBe("required");
    const response=a.assert(c,{counter:0}),result=await confirm(b,response);ok(result);
    expect(result.json).toEqual({outcome:"enrolled",authorizing:false});expect(result.setCookie.length).toBe(0);
    expect(b.cookies.get(COOKIE.session)===originalCookie).toBe(true);
    const after=await passkeyState(f);expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);
    expect(after.staged.length).toBe(0);expect(after.trusted).toEqual([{verifiedUv:1}]);expect(after.receipts.at(-1)?.sessionId).toBeNull();
    expect(after.credentials[0]?.counter).toBe(0);
    expect(f.evidence.events.length).toBe(1);expect(f.evidence.events[0]?.kind).toBe("session");
    expect("sessionId" in f.evidence.events[0]! && f.evidence.events[0].sessionId===before.sessions[0]?.id).toBe(false);
    expect((await observePasskeySession(f,b.cookieHeader()))?.method).toBe("password");
    const entries=f.control.entries.length;refused(await confirm(b,response));expect(f.control.entries.length).toBe(entries);
    refused(await new Browser(f).signIn());
    const later=new Browser(f),o=await options(later,"authenticate");ok(await later.post("/passkey/verify-authentication",{response:a.assert(o,{counter:0})}));
    expect((await observePasskeySession(f,later.cookieHeader()))?.method).toBe("passkey_uv");
    expect(f.control.entries.every(e=>e.charged&&e.inTransaction)).toBe(true);
  }));
  for(const [name,input] of Object.entries({"UP only":{uv:false},"no UP":{up:false},"bad signature":{tamper:true},"wrong RP":{rp:"evil.test"},"wrong origin":{origin:"https://evil.test"},"wrong challenge":{challenge:"wrong"},"wrong handle":{userHandle:"d3Jvbmc"}}) as Array<[string,AuthenticatorInput]>) test(`confirmation refuses ${name} with durable charge and no success effects`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f);
    refused(await confirm(b,a.assert(o,input)));const after=await pristine(f,before);
    expect(after.receipts.at(-1)?.state).toBe("failed");expect(charged(after)).toBe(charged(before)+1);expect(f.evidence.events.length).toBe(0);
  }));
  for(const forgedBit of [false,true]) test(`unsigned UV extensions / changed signed UV bit (${forgedBit}) cannot confirm`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f);
    const r=a.assert(o,{uv:false});
    if(forgedBit){const bytes=Buffer.from(r.response.authenticatorData,"base64url");bytes[32]|=4;r.response.authenticatorData=bytes.toString("base64url");}
    refused(await confirm(b,{...r,clientExtensionResults:{uv:true,userVerified:true}}));await pristine(f,before);
  }));
  test("another real signing key cannot confirm the selected native credential",async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f),other=new PasskeyAuthenticator();
    refused(await confirm(b,{...other.assert(o),id:a.id,rawId:a.id}));await pristine(f,before);
  }));
  for(const sameSubject of [true,false]) test(`confirmation requires exact original session, same subject=${sameSubject}`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),other=new Browser(f);
    ok(sameSubject?await other.signIn():await other.post("/sign-in/email",{email:"second@fixture.invalid",password:OWNER_PASSWORD}));
    other.cookies.set(PASSKEY_COOKIE,b.cookies.get(PASSKEY_COOKIE)!);const before=await passkeyState(f),entries=f.control.entries.length;
    refused(await confirm(other,a.assert(o)));await pristine(f,before);expect(f.control.entries.length).toBe(entries);
    refused(await other.post("/passkey/generate-confirm-options",{},{method:"GET"}));
  },["second@fixture.invalid"]));
  test("unknown capabilities, client credential selectors and login challenges cannot select enrollment authority",async()=>owned(async f=>{
    const {b,a}=await stage(f),before=await passkeyState(f),normal=new Browser(f),o=await options(normal,"authenticate");
    refused(await confirm(normal,a.assert(o)));
    refused(await b.post("/passkey/generate-confirm-options?credential=client",{},{method:"GET"}));
    refused(await b.post("/passkey/verify-confirmation",{response:a.assert(o),credential:a.id}));
    b.cookies.set(PASSKEY_COOKIE,"unknown-client-capability");refused(await b.post("/passkey/generate-confirm-options",{},{method:"GET"}));
    expect((await passkeyState(f)).trusted).toEqual(before.trusted);
  }));
  const changes={
    mapping:"UPDATE authentication_provider_subjects SET status='revoked',revoked_at='2026-11-02T00:00:00Z'",
    principal:"UPDATE remote_principals SET status='revoked'",
    generation:"UPDATE passkey_fixture_generation SET generation=generation+1",
    session:"DELETE FROM authentication_ba_session",
    deadline:"UPDATE passkey_fixture_evidence SET originalDeadline=0",
    handle:"UPDATE passkey_fixture_staged SET handle='replaced'",
    key:'UPDATE authentication_ba_passkey SET "publicKey"=\'replacement\'',
    subject:"UPDATE passkey_fixture_staged SET subject='unknown'",
    protection:'UPDATE authentication_ba_user SET "twoFactorEnabled"=1',
  };
  for(const phase of ["before-admission","after-admission","native-entry","after-native"] as const) for(const [name,sql] of Object.entries(changes)) test(`${name} change at ${phase} refuses confirmation and trust`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f);
    if(phase==="before-admission") await fixtureSql(f,sql);
    else f.control.pause=async(point,db)=>{if(point===phase) db.prepare(sql).run([]);};
    refused(await confirm(b,a.assert(o)));f.control.pause=undefined;
    const after=await passkeyState(f);expect(after.trusted.length).toBe(0);expect(after.staged.length).toBe(1);
    expect(after.evidence.some(e=>e.method==="passkey_uv")).toBe(false);expect(after.sessions.length<=before.sessions.length).toBe(true);expect(after.credentials[0]?.counter).toBe(0);expect(f.evidence.events.length).toBe(0);
  }));
  test("two staged contexts cannot mix credentials, and a second pending candidate cannot bypass newly selected protection",async()=>owned(async f=>{
    const first=await stage(f),one=first.b.clone(),second=await stage(f,{},first.b);
    const c1=await options(one,"confirm"),c2=await options(second.b,"confirm");
    refused(await confirm(one,second.a.assert(c1)));
    ok(await confirm(second.b,second.a.assert(c2)));
    refused(await one.post("/passkey/generate-confirm-options",{},{method:"GET"}));
    const state=await passkeyState(f);expect(state.trusted.length).toBe(1);expect(state.staged.length).toBe(1);expect(state.sessions.length).toBe(1);
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(state.staged[0]!.deadline+1);
    await options(new Browser(f),"authenticate");const cleaned=await passkeyState(f);
    expect(cleaned.trusted.length).toBe(1);expect(cleaned.credentials.length).toBe(1);expect(cleaned.staged.length).toBe(0);refused(await new Browser(f).signIn());
  }));
  test("concurrent confirmation and later replay yield one promotion and only the original session",async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),copy=b.clone(),response=a.assert(o,{counter:0});
    const results=await Promise.all([confirm(b,response),confirm(copy,response)]);
    expect(results.map(r=>r.status===200).sort()).toEqual([false,true]);expect(results.every(r=>r.setCookie.length===0)).toBe(true);
    const state=await passkeyState(f);expect(state.trusted.length).toBe(1);expect(state.staged.length).toBe(0);expect(state.sessions.length).toBe(1);expect(charged(state)).toBe(2);
    refused(await confirm(copy,response));expect(f.evidence.events.length).toBe(1);
  }));
  for(const failure of ["cookie","evidence","session-veto","insert","delete","promotion"] as const) test(`${failure} failure rolls back confirmation but native-restored challenge remains spent`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f),response=a.assert(o);
    f.control.failCookie=failure==="cookie";f.control.failEvidence=failure==="evidence";f.control.vetoSession=failure==="session-veto";
    const faults={insert:/insert into "authentication_ba_session"/i,delete:/delete from "authentication_ba_session"/i,promotion:/insert into passkey_fixture_trust/i};
    if(failure in faults) f.control.fault={sql:faults[failure as keyof typeof faults],when:"after",remaining:1};
    refused(await confirm(b,response));const after=await pristine(f,before);expect(after.receipts.at(-1)?.state).toBe("failed");expect(charged(after)).toBe(charged(before)+1);expect(f.evidence.events.length).toBe(0);
    f.control.failCookie=false;f.control.failEvidence=false;f.control.vetoSession=false;f.control.fault=undefined;
    const entries=f.control.entries.length;refused(await confirm(b,response));expect(f.control.entries.length).toBe(entries);
    // Native verification consumption rolled back; wrapper admission did not.
    await f.storage.borrow(async()=>{const db=f.storage.createProviderConnection();try{const p=new PasskeyAdmission(db),ctx=p.context(b.cookies.get(PASSKEY_COOKIE)!)!;expect(p.rows('SELECT 1 FROM authentication_ba_verification WHERE id=?',[ctx.nativeId]).length).toBe(1);}finally{db.close();}});
    ok(await confirm(b,a.assert(await options(b,"confirm"))));expect((await passkeyState(f)).trusted.length).toBe(1);
  }));
  for(const phase of ["admission","success"] as const) for(const when of ["before","after"] as const) test(`confirmation ${phase} ${when} COMMIT preserves exact durable outcome`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f),response=a.assert(o);
    f.control.attemptId="staged-commit-attempt";f.control.fault={sql:/^commit$/i,when,remaining:1,...(phase==="success"?{afterSql:/insert into passkey_fixture_trust/i}:{})};
    const result=await confirm(b,response);refused(result);const after=await passkeyState(f),committed=phase==="success"&&when==="after";
    expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);expect(after.trusted.length).toBe(committed?1:0);expect(after.staged.length).toBe(committed?0:1);expect(after.credentials[0]?.counter).toBe(committed?1:0);
    expect(after.receipts.at(-1)?.state).toBe(phase==="admission"?(when==="before"?"succeeded":"charged"):committed?"succeeded":"failed");
    expect(f.evidence.events.length).toBe(committed?1:0);
    if(committed) expect(result.json).toEqual({outcome:"completion_receipt",committed:true});
    if(!(phase==="admission"&&when==="before")){const entries=f.control.entries.length;refused(await confirm(b,response));expect(f.control.entries.length).toBe(entries);}
  }));
  test("receipt read failure after committed promotion returns no authority and does not repeat effects",async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),response=a.assert(o);
    f.control.pause=async point=>{if(point==="after-native") f.control.fault={sql:/^commit$|^SELECT \* FROM passkey_fixture_receipt/i,when:"after",remaining:3,afterSql:/^commit$/i};};
    const result=await confirm(b,response);refused(result);expect(result.json?.outcome).toBe("outcome_unconfirmed");expect(f.evidence.events.length).toBe(0);
    f.control.fault=undefined;f.control.pause=undefined;
    const state=await passkeyState(f);expect(state.trusted.length).toBe(1);expect(state.sessions.length).toBe(1);expect(state.receipts.at(-1)?.state).toBe("succeeded");
    await f.runtime.dispose();Object.assign(f,await loadPasskey(f,f.control));const entries=f.control.entries.length;
    refused(await confirm(b,response));expect(f.control.entries.length).toBe(entries);expect((await passkeyState(f)).trusted.length).toBe(1);
  }));
  test("failed COMMIT and ROLLBACK cannot expose uncommitted promotion or ephemeral-session notification",async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f);
    f.control.fault={sql:/^(commit|rollback)$/i,when:"before",remaining:2,afterSql:/insert into passkey_fixture_trust/i};
    await confirm(b,a.assert(o)).catch(()=>undefined);expect(f.evidence.events.length).toBe(0);expect(f.store.admissionSnapshot().state).toBe("provider_closed");
    const actual=await f.store.admission.run(()=>{const db=(f.store as unknown as {database:Database.Database}).database;return {trust:db.prepare('SELECT count(*) n FROM passkey_fixture_trust').get() as {n:number},sessions:db.prepare('SELECT count(*) n FROM authentication_ba_session').get() as {n:number},receipt:db.prepare('SELECT state FROM passkey_fixture_receipt ORDER BY rowid DESC LIMIT 1').get() as {state:string}};});
    expect(actual.trust.n).toBe(0);expect(actual.sessions.n).toBe(before.sessions.length);expect(actual.receipt.state).toBe("charged");
  }));
  for(const phase of ["after-admission","native-entry","after-native"] as const) test(`confirmation cancellation at ${phase} cannot promote`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f),abort=new AbortController();
    f.control.pause=async point=>{if(point===phase) abort.abort();};refused(await confirm(b,a.assert(o),abort.signal));f.control.pause=undefined;
    await pristine(f,before);expect((await passkeyState(f)).receipts.at(-1)?.state).toBe("failed");
  }));
  test("staged key and context survive actual provider reload on the same owner",async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),before=await passkeyState(f);
    await f.runtime.dispose();Object.assign(f,await loadPasskey(f,f.control));expect((await passkeyState(f)).staged).toEqual(before.staged);
    ok(await confirm(b,a.assert(o)));const after=await passkeyState(f);expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);expect(after.trusted.length).toBe(1);
  }));
  test("a lost successful output remains one-use across reload, with no new session or password upgrade",async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm"),response=a.assert(o),before=await passkeyState(f);
    await confirm(b,response); // Deliberately discard all response data.
    await f.runtime.dispose();Object.assign(f,await loadPasskey(f,f.control));refused(await confirm(b,response));
    const after=await passkeyState(f);expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);expect(after.trusted.length).toBe(1);expect(charged(after)).toBe(charged(before)+1);
  }));
  test("original password deadline caps confirmation even if native expiry is refreshed",async()=>owned(async f=>{
    const b=new Browser(f);ok(await b.signIn());const deadline=Date.now()+2_000;
    await fixtureSql(f,"UPDATE passkey_fixture_evidence SET originalDeadline=?",[deadline]);
    const {a}=await stage(f,{},b),o=await options(b,"confirm");await fixtureSql(f,'UPDATE authentication_ba_session SET "expiresAt"="expiresAt"+86400000');
    const state=await passkeyState(f);expect(state.staged[0]?.originalDeadline).toBe(deadline);expect(state.staged[0]?.deadline).toBe(deadline);
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(deadline);
    refused(await confirm(b,a.assert(o)));expect((await passkeyState(f)).trusted.length).toBe(0);expect((await passkeyState(f)).evidence[0]?.originalDeadline).toBe(deadline);
  }));
  test("expired staged key is removed in bounded cleanup; password-only policy remains usable",async()=>owned(async f=>{
    const {b}=await stage(f),state=await passkeyState(f);
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(state.staged[0]!.deadline+1);
    await options(new Browser(f),"authenticate");const after=await passkeyState(f);expect(after.staged.length).toBe(0);expect(after.credentials.length).toBe(0);expect(after.trusted.length).toBe(0);
    ok(await new Browser(f).signIn());refused(await b.post("/passkey/generate-confirm-options",{},{method:"GET"}));
  }));
  for(const preserve of ["trusted","replacement","charged"] as const) test(`staged cleanup preserves ${preserve} state`,async()=>owned(async f=>{
    const {b,a}=await stage(f),o=await options(b,"confirm");
    if(preserve==="trusted") await fixtureSql(f,"INSERT INTO passkey_fixture_trust SELECT credential,subject,handle,fingerprint,generation,1 FROM passkey_fixture_staged");
    if(preserve==="replacement") await fixtureSql(f,'UPDATE authentication_ba_passkey SET "publicKey"=\'replacement\'');
    if(preserve==="charged") {f.control.fault={sql:/^commit$/i,when:"after",remaining:1};refused(await confirm(b,a.assert(o)));}
    const state=await passkeyState(f);vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(state.staged[0]!.deadline+1);
    await options(new Browser(f),"authenticate");const after=await passkeyState(f);expect(after.credentials.length).toBe(1);expect(after.staged.length).toBe(preserve==="charged"?1:0);
    expect(after.trusted.length).toBe(preserve==="trusted"?1:0);
    if(preserve==="trusted") refused(await new Browser(f).signIn());
    if(preserve==="charged") expect(after.receipts.some(r=>r.state==="charged")).toBe(true);
  }));
  test("staged capacity refuses a new native row without evicting candidates or denial history",async()=>owned(async f=>{
    const {b}=await stage(f);
    for(let i=1;i<PASSKEY_BOUNDS.capacity;i++) await fixtureSql(f,"INSERT INTO passkey_fixture_staged SELECT ?,?,subject,handle,fingerprint,generation,sessionId,originalDeadline,deadline,purpose FROM passkey_fixture_staged LIMIT 1",[`capacity-${i}`,`capacity-context-${i}`]);
    const o=await options(b,"register"),before=await passkeyState(f);
    refused(await b.post("/passkey/verify-registration",{response:new PasskeyAuthenticator().register(o,{attestationNone:true})}));
    const after=await pristine(f,before);expect(after.staged.length).toBe(PASSKEY_BOUNDS.capacity);expect(charged(after)).toBe(charged(before)+1);expect(after.receipts.at(-1)?.state).toBe("failed");
  }));
  test("confirmation cannot extend native enrollment freshness past the original password authentication",async()=>owned(async f=>{
    const b=new Browser(f);ok(await b.signIn());const before=await passkeyState(f),authenticatedAt=before.evidence[0]!.authenticatedAt;
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(authenticatedAt+9*60_000);
    const {a}=await stage(f,{},b),o=await options(b,"confirm"),staged=await passkeyState(f);
    expect(staged.staged[0]?.deadline).toBe(authenticatedAt+10*60_000);expect(staged.staged[0]?.originalDeadline).toBe(before.evidence[0]!.originalDeadline);
    vi.setSystemTime(authenticatedAt+10*60_000);refused(await confirm(b,a.assert(o)));expect((await passkeyState(f)).trusted.length).toBe(0);
  }));
  for(const phase of ["admission","success"] as const) for(const when of ["before","after"] as const) test(`fmt:none staging ${phase} ${when} COMMIT never confers trust`,async()=>owned(async f=>{
    const b=new Browser(f);ok(await b.signIn());const o=await options(b,"register"),a=new PasskeyAuthenticator(),before=await passkeyState(f);
    f.control.fault={sql:/^commit$/i,when,remaining:1,...(phase==="success"?{afterSql:/insert into passkey_fixture_staged/i}:{})};
    refused(await b.post("/passkey/verify-registration",{response:a.register(o,{attestationNone:true})}));
    const after=await passkeyState(f),committed=phase==="success"&&when==="after";
    expect(after.credentials.length).toBe(committed?1:0);expect(after.staged.length).toBe(committed?1:0);expect(after.trusted.length).toBe(0);
    expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);expect(f.evidence.events.length).toBe(0);
    expect(charged(after)).toBe(charged(before)+(phase==="admission"&&when==="before"?0:1));
  }));

  test("native freshness cannot create an already expired staged candidate from older password evidence",async()=>owned(async f=>{
    const b=new Browser(f);ok(await b.signIn());
    await fixtureSql(f,"UPDATE passkey_fixture_evidence SET authenticatedAt=?",[Date.now()-11*60_000]);
    const o=await options(b,"register"),before=await passkeyState(f);
    refused(await b.post("/passkey/verify-registration",{response:new PasskeyAuthenticator().register(o,{attestationNone:true})}));
    const after=await pristine(f,before);expect(after.staged.length).toBe(0);expect(charged(after)).toBe(charged(before)+1);
  }));

});
