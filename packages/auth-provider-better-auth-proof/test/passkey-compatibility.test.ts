import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { cleanupFactorRoots, Browser, fixtureSql, Authenticator, loadFactorProvider } from "./factor-fixture";
import { newFactorControl, COOKIE } from "./factor-provider";
import { OWNER_PASSWORD, SECRET } from "./fixture";
import { gate } from "./strict-fixture";
import { PasskeyAuthenticator, type CeremonyOptions, type AuthenticatorInput } from "./passkey-authenticator";
import { closePasskey, loadPasskey, observePasskeySession, passkeyFixture, passkeyState, type PasskeyFixture } from "./passkey-fixture";
import { PASSKEY_COOKIE, PASSKEY_IMPLEMENTATION } from "./passkey-provider";


afterEach(() => {vi.useRealTimers();cleanupFactorRoots();});
const success = (result:{status:number}) => expect(result.status).toBe(200);
const denial = (result:{status:number}) => expect(result.status >= 400).toBe(true);
const options = async (browser:Browser,kind:"register"|"authenticate") => {
  const result = await browser.post(`/passkey/generate-${kind}-options`,{}, {method:"GET"});
  success(result);
  return result.json!.options as unknown as CeremonyOptions;
};
async function enroll(f:PasskeyFixture,browser = new Browser(f),authenticator = new PasskeyAuthenticator()) {
  success(await browser.signIn());
  const challenge = await options(browser,"register");
  success(await browser.post("/passkey/verify-registration",{response:authenticator.register(challenge)}));
  return {browser,authenticator};
}
async function assertion(f:PasskeyFixture,authenticator:PasskeyAuthenticator,input:AuthenticatorInput = {}) {
  const browser = new Browser(f),challenge = await options(browser,"authenticate");
  return {browser,challenge,response:authenticator.assert(challenge,input)};
}
const complete = (browser:Browser,response:unknown,signal?:AbortSignal) => browser.post("/passkey/verify-authentication",{response},{signal});
async function owned(fn:(f:PasskeyFixture)=>Promise<void>, additionalEmails:string[] = []) {
  const f = await passkeyFixture(undefined,additionalEmails);
  try {await fn(f);} finally {await closePasskey(f);}
}

describe("A3-I14 pinned real passkey proof, nonauthorizing",() => {
  test("finds the frozen plugin storage and readiness verifies it",async () => owned(async f => {
    expect(f.ddl.created).toEqual([]);expect(f.ddl.outstanding).toBe(0);
    expect(f.runtime.implementationVersion).toBe(PASSKEY_IMPLEMENTATION);
    expect((await passkeyState(f)).schema).toBe(40);
    success(await new Browser(f).signIn());
    expect((await passkeyState(f)).evidence.map(e=>e.method)).toEqual(["password"]);
  }));
  test("real packed ES256 self-attestation and signed assertion require verified UV, never invent a password factor",async () => owned(async f => {
    const {authenticator,browser} = await enroll(f);
    const registration = f.control.observations[0]!;
    expect(registration).toEqual({kind:"registration",userVerified:true,inTransaction:true});
    const state = await passkeyState(f);expect(state.credentials[0]!.userId).toBe(f.subject);expect(state.trusted).toEqual([{verifiedUv:1}]);
    const a = await assertion(f,authenticator);
    const result = await complete(a.browser,a.response);success(result);
    expect(result.json).toEqual({outcome:"observation",method:"passkey_uv",authorizing:false});
    expect((await passkeyState(f)).evidence.map(e=>e.method).sort()).toEqual(["passkey_uv","password"]);
    expect(f.control.observations[1]).toEqual({kind:"authentication",userVerified:true,inTransaction:true});
    expect(await a.browser.resolve()).toBeNull();expect(await browser.resolve()).toBeNull();
    await expect(f.runtime.authenticate(new Headers({cookie:a.browser.cookieHeader()}))).rejects.toMatchObject({ code:"provider_unavailable" });
    expect(f.control.entries.every(e=>e.charged && e.inTransaction)).toBe(true);
    const trace = f.control.trace.map(e=>e.sql.toLowerCase());
    const charge = trace.findIndex(sql=>sql.startsWith("insert into passkey_fixture_receipt"));
    expect(trace.slice(charge).some(sql=>sql==="commit")).toBe(true);
    expect((await passkeyState(f)).sessions.length).toBe(2);
  }));
  test("browser registration and assertion requests both ask for required UV, with immutable fixture RP/origin",async () => owned(async f => {
    const b = new Browser(f);success(await b.signIn());
    const r = await options(b,"register") as CeremonyOptions & {authenticatorSelection:{userVerification:string}};
    expect(r.authenticatorSelection.userVerification).toBe("required");expect(r.attestation).toBe("none");expect(r.rp?.id).toBe("controller.test");
    const a = await options(new Browser(f),"authenticate") as CeremonyOptions & {userVerification:string};
    expect(a.userVerification).toBe("required");expect(a.rpId).toBe("controller.test");
    denial(await b.post("/passkey/generate-register-options?rpID=evil.test",{},{method:"GET"}));
  }));
  for (const [name,input] of Object.entries({"presence only":{uv:false},"no presence":{up:false},"bad self-attestation":{tamper:true},"wrong origin":{origin:"https://evil.test"},"wrong RP":{rp:"evil.test"},"wrong challenge":{challenge:"wrong"}}) as Array<[string,AuthenticatorInput]>) {
    test(`registration rejects ${name} before credential/session persistence`,async () => owned(async f => {
      const b = new Browser(f);success(await b.signIn());const o = await options(b,"register");
      const a = new PasskeyAuthenticator();
      denial(await b.post("/passkey/verify-registration",{response:a.register(o,input)}));
      const state = await passkeyState(f);expect(state.credentials.length).toBe(0);expect(state.trusted.length).toBe(0);expect(state.sessions.length).toBe(1);
      expect(state.receipts.at(-1)?.state).toBe("failed");expect(state.budgets[0]?.charged).toBe(1);
    }));
  }
  test("unsigned fmt:none UV cannot confer trust without a separate signed confirmation",async()=>owned(async f=>{
    const b=new Browser(f);success(await b.signIn());const o=await options(b,"register"),a=new PasskeyAuthenticator();
    const staged=await b.post("/passkey/verify-registration",{response:a.register(o,{attestationNone:true})});
    success(staged);expect(staged.json).toEqual({outcome:"staged",authorizing:false});expect(staged.setCookie.length).toBe(0);
    const state=await passkeyState(f);expect(state.credentials.length).toBe(1);expect(state.staged.length).toBe(1);expect(state.trusted.length).toBe(0);expect(state.sessions.length).toBe(1);
    expect(f.control.observations.at(-1)?.userVerified).toBe(false);
    const normal=await assertion(f,a);denial(await complete(normal.browser,normal.response));
    const c=await b.post("/passkey/generate-confirm-options",{},{method:"GET"});success(c);
    const confirmed=await b.post("/passkey/verify-confirmation",{response:a.assert(c.json!.options as unknown as CeremonyOptions)});success(confirmed);expect(confirmed.setCookie.length).toBe(0);
    const after=await passkeyState(f);expect(after.trusted).toEqual([{verifiedUv:1}]);expect(after.staged.length).toBe(0);expect(after.sessions).toEqual(state.sessions);expect(after.evidence).toEqual(state.evidence);
  }));
  test("client extension claims cannot replace signed registration UV",async () => owned(async f => {
    const b = new Browser(f);success(await b.signIn());const o = await options(b,"register");
    const response = {...new PasskeyAuthenticator().register(o,{uv:false}),clientExtensionResults:{uv:true,userVerified:true}};
    denial(await b.post("/passkey/verify-registration",{response}));
    expect(f.control.observations.at(-1)?.userVerified).toBe(false);expect((await passkeyState(f)).credentials.length).toBe(0);
  }));
  test("registration is bound to exact current session and mapped opaque subject",async () => owned(async f => {
    const b = new Browser(f);success(await b.signIn());const o = await options(b,"register"), a = new PasskeyAuthenticator();
    const other = new Browser(f);success(await other.post("/sign-in/email",{email:"second@fixture.invalid",password:OWNER_PASSWORD}));
    other.cookies.set(PASSKEY_COOKIE,b.cookies.get(PASSKEY_COOKIE)!);
    denial(await other.post("/passkey/verify-registration",{response:a.register(o)}));
    expect((await passkeyState(f)).credentials.length).toBe(0);expect(f.control.observations.length).toBe(0);
  },["second@fixture.invalid"]));
  for (const [name,input] of Object.entries({"presence only":{uv:false},"no presence":{up:false},"tampered signature":{tamper:true},"wrong RP":{rp:"evil.test"},"wrong origin":{origin:"https://evil.test"},"wrong challenge":{challenge:"wrong"},"wrong user handle":{userHandle:"d3Jvbmc"}}) as Array<[string,AuthenticatorInput]>) {
    test(`assertion rejects ${name} without a session, evidence or counter write`,async () => owned(async f => {
      const {authenticator} = await enroll(f), before = await passkeyState(f), a = await assertion(f,authenticator,input);
      denial(await complete(a.browser,a.response));const after = await passkeyState(f);
      expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);expect(after.credentials).toEqual(before.credentials);
      expect(after.receipts.at(-1)?.state).toBe("failed");
    }));
  }
  test("unsigned client UV claims and a changed signed UV bit cannot authenticate",async () => owned(async f => {
    const {authenticator} = await enroll(f), a = await assertion(f,authenticator,{uv:false});
    const forged = {...a.response,clientExtensionResults:{userVerified:true,uv:true}};
    denial(await complete(a.browser,forged));expect(f.control.observations.at(-1)?.userVerified).toBe(false);
    const next = await assertion(f,authenticator,{uv:false});
    const bytes = Buffer.from(next.response.response.authenticatorData,"base64url");bytes[32] |= 4;
    denial(await complete(next.browser,{...next.response,response:{...next.response.response,authenticatorData:bytes.toString("base64url")}}));
    expect((await passkeyState(f)).sessions.length).toBe(1);
  }));
  test("unknown credential and untrusted native credential cannot use a session",async () => owned(async f => {
    const {authenticator} = await enroll(f), a = await assertion(f,new PasskeyAuthenticator());
    denial(await complete(a.browser,a.response));
    await fixtureSql(f,"DELETE FROM passkey_fixture_trust");
    const b = await assertion(f,authenticator);denial(await complete(b.browser,b.response));
    expect((await passkeyState(f)).sessions.length).toBe(1);
  }));
  test("real counter increase succeeds; equal or decreasing nonzero counter denies",async () => owned(async f => {
    const {authenticator} = await enroll(f);
    const first = await assertion(f,authenticator,{counter:5});success(await complete(first.browser,first.response));
    for (const counter of [5,4,0]) {const a = await assertion(f,authenticator,{counter});denial(await complete(a.browser,a.response));}
    const state = await passkeyState(f);expect(state.credentials[0]?.counter).toBe(5);expect(state.sessions.length).toBe(2);
  }));
  test("registration replay and concurrently queued assertion completion each have one effect",async () => owned(async f => {
    const b = new Browser(f);success(await b.signIn());const o = await options(b,"register"), a = new PasskeyAuthenticator(), r = a.register(o), copy = b.clone();
    const results = await Promise.all([b.post("/passkey/verify-registration",{response:r}),copy.post("/passkey/verify-registration",{response:r})]);
    expect(results.map(x=>x.status===200).sort()).toEqual([false,true]);expect((await passkeyState(f)).credentials.length).toBe(1);
    const next = await assertion(f,a), clone = next.browser.clone();
    const auth = await Promise.all([complete(next.browser,next.response),complete(clone,next.response)]);
    expect(auth.map(x=>x.status===200).sort()).toEqual([false,true]);expect((await passkeyState(f)).sessions.length).toBe(2);
    denial(await complete(clone,next.response));
  }));
  for (const kind of ["registration","authentication"] as const) test(`${kind} expiry rejects before native evaluation`,async () => owned(async f => {
    const b = new Browser(f);success(await b.signIn());const a = new PasskeyAuthenticator();
    if(kind==="authentication") success(await b.post("/passkey/verify-registration",{response:a.register(await options(b,"register"))}));
    const client = kind==="registration" ? b : new Browser(f), o = await options(client,kind==="registration" ? "register":"authenticate");
    const response = kind==="registration" ? a.register(o) : a.assert(o);
    const before = f.control.observations.length;
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.now()+301_000);
    denial(await client.post(`/passkey/verify-${kind}`,{response}));expect(f.control.observations.length).toBe(before);
    expect((await passkeyState(f)).sessions.length).toBe(1);
  }));
  for(const mutation of ["mapping","principal","credential","trust","generation","replacement"] as const) test(`current ${mutation} revocation/replacement denies native assertion entry`,async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator),entries=f.control.entries.length;
    const changes={mapping:"UPDATE authentication_provider_subjects SET status='revoked',revoked_at='2026-11-02T00:00:00Z'",principal:"UPDATE remote_principals SET status='revoked'",credential:"DELETE FROM authentication_ba_passkey",trust:"DELETE FROM passkey_fixture_trust",generation:"UPDATE passkey_fixture_generation SET generation=generation+1",replacement:'UPDATE authentication_ba_passkey SET "publicKey"=\'untrusted replacement\''};
    await fixtureSql(f,changes[mutation]);denial(await complete(a.browser,a.response));expect(f.control.entries.length).toBe(entries);
    expect((await passkeyState(f)).sessions.length).toBe(1);
  }));
  test("unmapped email/name cannot create an account and no management/trusted-device path is exposed",async()=>owned(async f=>{
    const b=new Browser(f);
    for(const path of ["/sign-up/email","/passkey/delete-passkey","/passkey/update-passkey","/two-factor/disable","/two-factor/verify-backup-code"]) expect((await b.post(path,{})).status).toBe(404);
    denial(await b.post("/passkey/generate-register-options",{},{method:"GET"}));
    denial(await b.post("/sign-in/email",{email:"unknown@fixture.invalid",password:OWNER_PASSWORD}));
    expect((await passkeyState(f)).sessions.length).toBe(0);
  }));
  test("optional methods leave unprotected password accounts usable; enrolled protection cannot be bypassed by password or trust cookie",async()=>owned(async f=>{
    const b=new Browser(f);success(await b.signIn());expect((await passkeyState(f)).evidence[0]?.method).toBe("password");
    const {authenticator}=await enroll(f,b);
    const next=new Browser(f);next.cookies.set(COOKIE.trust,"forged-trust-sentinel");denial(await next.signIn());
    expect((await passkeyState(f)).sessions.length).toBe(2);
    const a=await assertion(f,authenticator);success(await complete(a.browser,a.response));
    denial(await b.post("/passkey/generate-register-options",{},{method:"GET"})); // Replacement needs a separately reviewed management proof.
  }));
  test("real TOTP-enabled password login remains pending while UV passkey is an alternative",async()=>owned(async f=>{
    const {authenticator}=await enroll(f);await f.runtime.dispose();
    const factor=await loadFactorProvider(f,newFactorControl("bounded"));
    try {
      const b=new Browser(factor);success(await b.signIn());
      const enabled=await b.post("/two-factor/enable",{password:OWNER_PASSWORD});success(enabled);
      const app=new Authenticator(String(enabled.json!.totpURI));
      success(await b.post("/two-factor/verify-totp",{code:app.code()}));
    } finally {await factor.runtime.dispose();}
    const loaded=await loadPasskey(f,f.control);f.runtime=loaded.runtime;f.evidence=loaded.evidence;
    const b=new Browser(f);const pending=await b.signIn();success(pending);expect(pending.json).toEqual({outcome:"challenge"});
    expect(b.cookies.has(COOKIE.session)).toBe(false);expect(b.cookies.has(COOKIE.challenge)).toBe(true);
    const before=(await passkeyState(f)).sessions.length;
    const a=await assertion(f,authenticator);success(await complete(a.browser,a.response));expect((await passkeyState(f)).sessions.length).toBe(before+1);
    expect((await passkeyState(f)).evidence.some(e=>e.method==="passkey_uv")).toBe(true);
  }));
  for(const kind of ["registration","authentication"] as const) for(const failure of ["cookie","evidence","session-veto","insert-fault"] as const) {
    if(kind==="registration" && failure==="session-veto") continue;
    test(`${kind} ${failure} rolls back every success effect while retaining admission`,async()=>owned(async f=>{
      const b=new Browser(f),a=new PasskeyAuthenticator();success(await b.signIn());
      if(kind==="authentication") success(await b.post("/passkey/verify-registration",{response:a.register(await options(b,"register"))}));
      const client=kind==="registration"?b:new Browser(f),o=await options(client,kind==="registration"?"register":"authenticate"),response=kind==="registration"?a.register(o):a.assert(o);
      const before=await passkeyState(f);
      f.control.failCookie=failure==="cookie";f.control.failEvidence=failure==="evidence";f.control.vetoSession=failure==="session-veto";
      if(failure==="insert-fault") f.control.fault={sql:kind==="registration"?/insert into "authentication_ba_passkey"/i:/insert into "authentication_ba_session"/i,when:"after",remaining:1};
      const result=await client.post(`/passkey/verify-${kind}`,{response});denial(result);expect(result.setCookie.length).toBe(0);
      const after=await passkeyState(f);expect(after.sessions).toEqual(before.sessions);expect(after.credentials).toEqual(before.credentials);expect(after.evidence).toEqual(before.evidence);expect(after.trusted).toEqual(before.trusted);
      expect(after.receipts.at(-1)?.state).toBe("failed");expect(after.budgets.reduce((s,x)=>s+x.charged,0)).toBe(before.budgets.reduce((s,x)=>s+x.charged,0)+1);
      expect(f.evidence.events.length).toBe(0);
    }));
  }
  for(const phase of ["admission","success"] as const) for(const when of ["before","after"] as const) test(`${phase} ${when} COMMIT resolves actual effects without rerunning verification`,async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator),before=await passkeyState(f);
    f.control.attemptId="fixture-internal-commit-attempt";
    f.control.fault={sql:/^commit$/i,when,remaining:1,...(phase==="success"?{afterSql:/insert into passkey_fixture_evidence/i}:{})};
    const result=await complete(a.browser,a.response);denial(result);expect(result.setCookie.length).toBe(0);
    const after=await passkeyState(f),committed=phase==="success" && when==="after";
    expect(after.sessions.length).toBe(before.sessions.length+(committed?1:0));expect(after.evidence.length).toBe(before.evidence.length+(committed?1:0));
    const receipt=after.receipts.find(r=>r.attemptId===f.control.attemptId);
    expect(receipt?.state ?? "absent").toBe(phase==="admission"?(when==="before"?"absent":"charged"):committed?"succeeded":"failed");
    if(phase==="admission") expect(f.control.entries.length).toBe(1); // Enrollment only.
    if(committed) expect(result.json).toEqual({outcome:"completion_receipt",committed:true});
    if(!(phase==="admission" && when==="before")) { const entries=f.control.entries.length;await complete(a.browser,a.response);expect(f.control.entries.length).toBe(entries); }
  }));
  test("failed reconciliation after real success COMMIT withholds authority and preserves durable completion",async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator),before=await passkeyState(f);
    // First force a throw AFTER the actual COMMIT; then fail receipt reads.
    f.control.pause=async stage=>{if(stage==="after-native") f.control.fault={sql:/^commit$|^SELECT \* FROM passkey_fixture_receipt/i,when:"after",remaining:3,afterSql:/^commit$/i};};
    const result=await complete(a.browser,a.response);expect(result.json?.outcome).toBe("outcome_unconfirmed");expect(result.setCookie.length).toBe(0);
    f.control.fault=undefined;f.control.pause=undefined;
    const after=await passkeyState(f);expect(after.sessions.length).toBe(before.sessions.length+1);expect(after.receipts.at(-1)?.state).toBe("succeeded");
    const entries=f.control.entries.length;denial(await complete(a.browser,a.response));expect(f.control.entries.length).toBe(entries);
  }));
  test("open transaction after COMMIT/ROLLBACK refusal never reconciles an uncommitted success",async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator),before=await passkeyState(f);
    f.control.fault={sql:/^(commit|rollback)$/i,when:"before",remaining:2,afterSql:/insert into passkey_fixture_evidence/i};
    // The owner gate detects and rolls back the transaction abandoned by Kysely.
    await complete(a.browser,a.response).catch(()=>undefined);
    expect(f.evidence.events.length).toBe(0);
    const snapshot=f.store.admissionSnapshot();expect(snapshot.state).toBe("provider_closed");
    const after=await f.store.admission.run(()=>({sessions:(f.store as unknown as {database:Database.Database}).database.prepare('SELECT id FROM authentication_ba_session').all().length,receipts:(f.store as unknown as {database:Database.Database}).database.prepare('SELECT state FROM passkey_fixture_receipt ORDER BY rowid').all() as Array<{state:string}>}));
    expect(after.sessions).toBe(before.sessions.length);expect(after.receipts.at(-1)?.state).toBe("charged");
  }));
  for(const stage of ["after-admission","native-entry","after-native"] as const) test(`cancellation at ${stage} cannot commit or mint on retry`,async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator),before=await passkeyState(f),abort=new AbortController();
    f.control.pause=async point=>{if(point===stage) abort.abort();};
    denial(await complete(a.browser,a.response,abort.signal));
    f.control.pause=undefined;denial(await complete(a.browser,a.response));
    const after=await passkeyState(f);expect(after.sessions).toEqual(before.sessions);expect(after.evidence).toEqual(before.evidence);expect(after.receipts.at(-1)?.state).toBe("failed");
  }));
  test("one owner retains admission while verifier waits; disposal drains execution before closing",async()=>{
    const f=await passkeyFixture({admission:"strict",borrowTimeoutMs:30_000});const entered=gate(),resume=gate();
    try {
      const {authenticator}=await enroll(f),a=await assertion(f,authenticator);
      f.control.pause=async stage=>{if(stage==="after-native"){entered.open();await resume.opened;}};
      const pending=complete(a.browser,a.response);await entered.opened;
      expect(f.store.admissionSnapshot().providerExecutions).toBe(1);
      let disposed=false;const closing=f.runtime.dispose().then(()=>{disposed=true;});
      await Promise.resolve();expect(disposed).toBe(false);expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      resume.open();await pending;await closing;expect(disposed).toBe(true);
    } finally {resume.open();await closePasskey(f);}
  });
  test("actual borrow timeout retains sole owner until late execution drains and forbids late effects",async()=>{
    const f=await passkeyFixture({admission:"strict",borrowTimeoutMs:1000});const entered=gate(),resume=gate();
    try {
      const {authenticator}=await enroll(f),a=await assertion(f,authenticator);
      f.control.pause=async stage=>{if(stage==="after-native"){entered.open();await resume.opened;}};
      const pending=complete(a.browser,a.response).then(()=>"returned",(error:unknown)=>(error as {code?:string}).code);
      await entered.opened;expect(await pending).toBe("expired");
      expect(f.store.admissionSnapshot().providerExecutions).toBe(1);expect(existsSync(`${f.path}.owner.lock`)).toBe(true);
      resume.open();await f.runtime.dispose();
      const after=await f.store.admission.run(()=>({sessions:(f.store as unknown as {database:Database.Database}).database.prepare('SELECT id FROM authentication_ba_session').all().length,receipt:(f.store as unknown as {database:Database.Database}).database.prepare('SELECT state FROM passkey_fixture_receipt ORDER BY rowid DESC LIMIT 1').get() as {state:string}}));
      expect(after.sessions).toBe(1);expect(after.receipt.state).toBe("charged");expect(f.evidence.events.length).toBe(0);
    } finally {resume.open();await closePasskey(f);}
  });
  test("native freshness rejects delayed enrollment instead of refreshing an old password proof",async()=>owned(async f=>{
    const b=new Browser(f);success(await b.signIn());const before=(await passkeyState(f)).evidence[0]!;
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(Date.now()+61*60_000);
    denial(await b.post("/passkey/generate-register-options",{},{method:"GET"}));
    expect((await passkeyState(f)).evidence[0]!.originalDeadline).toBe(before.originalDeadline);
    expect((await passkeyState(f)).credentials.length).toBe(0);
  }));
  for(const mutation of ["expired","missing","generation"] as const) test(`enrollment refuses ${mutation} original password evidence despite live native session`,async()=>owned(async f=>{
    const b=new Browser(f);success(await b.signIn());const o=await options(b,"register");
    if(mutation==="expired") await fixtureSql(f,"UPDATE passkey_fixture_evidence SET originalDeadline=0");
    if(mutation==="missing") await fixtureSql(f,"DELETE FROM passkey_fixture_evidence");
    if(mutation==="generation") await fixtureSql(f,"UPDATE passkey_fixture_generation SET generation=generation+1");
    denial(await b.post("/passkey/verify-registration",{response:new PasskeyAuthenticator().register(o)}));
    expect((await passkeyState(f)).credentials.length).toBe(0);
  }));
  test("assertion evidence retains actual session lifetime and current generation across provider reload",async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator);success(await complete(a.browser,a.response));
    const before=await passkeyState(f);await f.runtime.dispose();const loaded=await loadPasskey(f,f.control);f.runtime=loaded.runtime;f.evidence=loaded.evidence;
    expect((await passkeyState(f)).evidence).toEqual(before.evidence);
    const proof=before.evidence.find(e=>e.method==="passkey_uv")!;
    expect(proof.originalDeadline-proof.authenticatedAt).toBe(8*60*60_000);
    const entries=f.control.entries.length;denial(await complete(new Browser(f),a.response));expect(f.control.entries.length).toBe(entries);
    expect(await observePasskeySession(f,a.browser.cookieHeader())).toEqual({method:"passkey_uv",originalDeadline:proof.originalDeadline,authorizing:false});
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(proof.originalDeadline);
    expect(await observePasskeySession(f,a.browser.cookieHeader())).toBeNull();
  }));
  test("bounded diagnostics contain no private cookies/tokens/passwords or client sentinels",async()=>owned(async f=>{
    const {authenticator,browser}=await enroll(f),a=await assertion(f,authenticator),opaque=a.browser.cookies.get(PASSKEY_COOKIE)!;
    const sentinel="I14-credential-sentinel-do-not-log";
    const response={...a.response,response:{...a.response.response,signature:Buffer.from(sentinel).toString("base64url")}};
    const result=await complete(a.browser,response);
    const serialized=JSON.stringify({dto:result.json,state:await passkeyState(f),trace:f.control.trace,observations:f.control.observations,events:f.evidence.events,logs:f.evidence.logs});
    for(const value of [sentinel,Buffer.from(sentinel).toString("base64url"),opaque,browser.cookies.get(COOKIE.session)!,OWNER_PASSWORD,SECRET]) expect(serialized.includes(value)).toBe(false);
    expect(result.setCookie.length).toBe(0);expect(f.control.trace.length<=1024).toBe(true);
    const original=JSON.stringify({dto:result.json,trace:f.control.trace});
    // Even intentional assertion diagnostics include only this safe projection.
    try {expect(result.status===200).toBe(true);}catch(error){expect(String(error).includes(sentinel)).toBe(false);}
    expect(original.includes(opaque)).toBe(false);
  }));
  for(const mutation of ["session","mapping","principal","credential","generation"] as const) test(`already issued native session loses passkey observation after ${mutation} revocation`,async()=>owned(async f=>{
    const {authenticator}=await enroll(f),a=await assertion(f,authenticator);success(await complete(a.browser,a.response));
    expect((await observePasskeySession(f,a.browser.cookieHeader()))?.method).toBe("passkey_uv");
    const changes={session:"DELETE FROM authentication_ba_session",mapping:"UPDATE authentication_provider_subjects SET status='revoked',revoked_at='2026-11-02T00:00:00Z'",principal:"UPDATE remote_principals SET status='revoked'",credential:"DELETE FROM authentication_ba_passkey",generation:"UPDATE passkey_fixture_generation SET generation=generation+1"};
    await fixtureSql(f,changes[mutation]);expect(await observePasskeySession(f,a.browser.cookieHeader())).toBeNull();
  }));
  for(const operation of ["password","register-options","authenticate-options"] as const) for(const when of ["before","after"] as const) test(`${operation} ${when} actual COMMIT never falsely claims rollback`,async()=>owned(async f=>{
    const b=new Browser(f);if(operation==="register-options") success(await b.signIn());
    const before=await passkeyState(f);f.control.attemptId="internal-operation-attempt";
    f.control.fault={sql:/^commit$/i,when,remaining:1};
    const result=operation==="password"?await b.signIn():await b.post(`/passkey/generate-${operation==="register-options"?"register":"authenticate"}-options`,{},{method:"GET"});
    denial(result);expect(result.setCookie.length).toBe(0);
    const after=await passkeyState(f);
    expect(after.sessions.length-before.sessions.length).toBe(operation==="password" && when==="after"?1:0);
    expect(after.contexts.length-before.contexts.length).toBe(operation!=="password" && when==="after"?1:0);
    expect(result.json?.committed).toBe(when==="after");
    if(when==="after") {const count=after.sessions.length;denial(await b.signIn());expect((await passkeyState(f)).sessions.length).toBe(count);}
  }));
  test("zero-only authenticator counters are natively supported, while challenge replay remains denied",async()=>owned(async f=>{
    const {authenticator}=await enroll(f);
    for(let i=0;i<2;i++){const a=await assertion(f,authenticator,{counter:0});success(await complete(a.browser,a.response));denial(await complete(a.browser,a.response));}
    expect((await passkeyState(f)).credentials[0]?.counter).toBe(0);
  }));
  test("spent subject budget survives fresh challenges and reload; another subject remains isolated",async()=>owned(async f=>{
    const {authenticator}=await enroll(f);
    // Enrollment already charged one slot. Seven fresh signed but wrong-handle
    // responses spend the rest without persisting native counter/session writes.
    for(let i=0;i<7;i++){const a=await assertion(f,authenticator,{userHandle:"d3Jvbmc"});denial(await complete(a.browser,a.response));}
    await f.runtime.dispose();Object.assign(f,await loadPasskey(f,f.control));
    const before=f.control.entries.length,a=await assertion(f,authenticator);denial(await complete(a.browser,a.response));expect(f.control.entries.length).toBe(before);
    const b=new Browser(f);success(await b.post("/sign-in/email",{email:"second@fixture.invalid",password:OWNER_PASSWORD}));
    const other=new PasskeyAuthenticator(),o=await options(b,"register");success(await b.post("/passkey/verify-registration",{response:other.register(o)}));
    expect((await passkeyState(f)).credentials.length).toBe(2);
  },["second@fixture.invalid"]));

});
