import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Kysely, SqliteDialect } from "kysely";
import type { AuthenticationProviderHost, AuthenticationProviderInstance, AuthenticationProviderModule, AuthenticationProviderOptions, ProviderInvalidation, ProviderSqliteConnection } from "../../../src/server/modules/authentication/provider-contract";
import { BASE_URL, IP_HEADER, ORIGIN } from "./fixture";
import { COOKIE, factorLibraryOptions, type TracedStatement } from "./factor-provider";
import { PasskeyAdmission, PASSKEY_MODEL, type PasskeyContext, type PasskeyTicket } from "./passkey-admission";

export const PASSKEY_IMPLEMENTATION = "0.0.0-proof.passkey";
export const PASSKEY_COOKIE = "__Secure-wtc.passkey_challenge";
export const PASSKEY_RP = "controller.test";
export interface PasskeyControl {
  trace: TracedStatement[];
  observations: Array<{ kind: string; userVerified: boolean; inTransaction: boolean }>;
  entries: Array<{ charged: boolean; inTransaction: boolean }>;
  fault?: { sql: RegExp; when: "before" | "after"; remaining: number; afterSql?: RegExp; armed?: boolean };
  pause?: (stage: "after-admission" | "native-entry" | "after-native", db: ProviderSqliteConnection) => Promise<void>;
  attemptId?: string;
  lastAttemptId?: string;
  failCookie: boolean;
  failEvidence: boolean;
  vetoSession: boolean;
}
export const newPasskeyControl = (): PasskeyControl => ({ trace: [], observations: [], entries: [], failCookie: false, failEvidence: false, vetoSession: false });
type Options = AuthenticationProviderOptions & { passkeyControl: PasskeyControl };
interface Operation { kind: string; context?: PasskeyContext; ticket?: PasskeyTicket; verified: boolean; registrationFormat?: "packed" | "none"; nativeSubject?: string; request: Request }
const refuse = () => { throw new APIError("FORBIDDEN", { message: "Fixture verification refused." }); };

/** Supported callbacks only. No verifier replacement, native adapter mutation or library patches. */
export function passkeyLibraryOptions(options: AuthenticationProviderOptions, database: Kysely<never>, callbacks?: {
  registration: NonNullable<NonNullable<Parameters<typeof passkey>[0]>["registration"]>["afterVerification"];
  authentication: NonNullable<NonNullable<Parameters<typeof passkey>[0]>["authentication"]>["afterVerification"];
}, transaction = true) {
  if (options.baseURL !== BASE_URL) throw new Error("Fixture origin is immutable.");
  const base = factorLibraryOptions(options, database, {}, transaction);
  return { ...base, plugins: [...base.plugins, passkey({
    rpID: PASSKEY_RP, rpName: "Worktree Control fixture", origin: ORIGIN,
    advanced: { webAuthnChallengeCookie: "passkey_challenge" },
    schema: { passkey: { modelName: PASSKEY_MODEL } },
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    registration: { requireSession: true, afterVerification: callbacks?.registration ?? refuse },
    authentication: { afterVerification: callbacks?.authentication ?? refuse },
  })] };
}
const safe = (status: number, outcome: string, extra: Record<string, unknown> = {}, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const line of cookies) headers.append("set-cookie", line);
  return new Response(JSON.stringify({ outcome, ...extra }), { status, headers });
};
class Refused extends Error { constructor(readonly status = 403) { super("Fixture operation refused."); } }
const opaqueCookie = (lines: string[], name: string) => lines.find(line => line.startsWith(`${name}=`) && !/max-age=0/i.test(line))?.split(";")[0]?.slice(name.length + 1);
const unsigned = (opaque: string) => decodeURIComponent(opaque).split(".")[0]!;
function cookies(header: string | null) {
  const parsed = new Map<string,string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("="); if (at < 0) continue;
    const name = part.slice(0,at).trim();
    if (parsed.has(name)) throw new Refused(400);
    parsed.set(name,part.slice(at+1).trim());
  }
  return parsed;
}
function traceConnection(db: ProviderSqliteConnection, control: PasskeyControl, state: { open: boolean }): ProviderSqliteConnection {
  const execute = <T>(sql: string, work: () => T): T => {
    const fault = control.fault;
    if (fault?.afterSql?.test(sql)) fault.armed = true;
    const matches = fault && fault.remaining > 0 && (!fault.afterSql || fault.armed) && fault.sql.test(sql);
    const fail = () => { fault!.remaining--; throw new Error("Fixture SQL boundary."); };
    if (matches && fault.when === "before") fail();
    const result = work();
    const verb = sql.trim().toLowerCase();
    if (verb === "begin") state.open = true;
    if (control.trace.length >= 1024) control.trace.shift();
    control.trace.push({ sql, inTransaction: state.open });
    if (verb === "commit" || verb === "rollback") state.open = false;
    if (matches && fault.when === "after") fail();
    return result;
  };
  return { prepare(sql) { const s = db.prepare(sql); return { reader: s.reader, all: p => execute(sql, () => s.all(p)), run: p => execute(sql, () => s.run(p)), iterate: p => execute(sql, () => s.iterate(p)) }; }, close() { db.close(); } };
}

class PasskeyProvider implements AuthenticationProviderInstance {
  readonly #operation = new AsyncLocalStorage<Operation>();
  readonly #notifications = new AsyncLocalStorage<ProviderInvalidation[]>();
  readonly #transaction = { open: false };
  #database?: Kysely<never>;
  #connection?: ProviderSqliteConnection;
  #auth?: ReturnType<PasskeyProvider["library"]>;
  constructor(readonly host: AuthenticationProviderHost, readonly options: Options) {}
  get control() { return this.options.passkeyControl; }
  policy() { return new PasskeyAdmission(this.#connection!); }
  async initialize() {
    this.#connection = traceConnection(this.host.connection,this.control,this.#transaction);
    this.#database = new Kysely<never>({ dialect: new SqliteDialect({ database: this.#connection }) });
    this.#auth = this.library(this.#database);
    await (await this.#auth.$context).checkSchema!();
    return { providerId: "better-auth", implementationVersion: PASSKEY_IMPLEMENTATION, library: { name: "better-auth", version: "1.7.14" }, schema: "verified" as const };
  }
  library(database: Kysely<never>, transaction = true) {
    const record = (kind: string, userVerified: boolean) => {
      if (this.control.observations.length >= 256) throw new Error("Fixture trace capacity.");
      this.control.observations.push({ kind,userVerified,inTransaction:this.#transaction.open });
    };
    const opts = passkeyLibraryOptions(this.options,database,{
      registration: async ({ verification,user }) => {
        const op = this.#operation.getStore();
        const fmt = verification.registrationInfo?.fmt;
        const uv = verification.verified && fmt === "packed" && verification.registrationInfo?.userVerified === true;
        record("registration", uv);
        // Native fmt:none proves structure only. Its unsigned UV bit is ignored.
        if (!verification.verified || (fmt !== "none" && !uv) || !op?.ticket || op.ticket.subject !== user.id || !this.policy().usable(op.ticket,Date.now())) refuse();
        op!.registrationFormat = fmt as "packed" | "none";
        op!.verified = uv;
      },
      authentication: async ({ verification,clientData }) => {
        const op = this.#operation.getStore(), policy = this.policy();
        const trust = op?.kind === "confirmation" && op.context ? policy.boundStage(op.context,Date.now()) : policy.trust(clientData.id);
        const uv = verification.verified && verification.authenticationInfo.userVerified === true;
        record("authentication",uv);
        // Native verification validates the signature. The callback binds its
        // user handle to the exact random handle issued at UV enrollment.
        if (!uv || !op?.ticket || clientData.id !== op.ticket.credential || !trust || trust.subject !== op.ticket.subject || clientData.response.userHandle !== trust.handle || !policy.usable(op.ticket,Date.now())) refuse();
        op!.verified = true;
      },
    },transaction);
    return betterAuth({ ...opts,
      databaseHooks: { session: {
        create: { before: async (session: {userId:string}) => {
          const op=this.#operation.getStore();if(op) op.nativeSubject=session.userId;
          return this.control.vetoSession ? false : undefined;
        } },
        delete: { after: async (session: { id: string; userId: string }) => {
          const event: ProviderInvalidation = { kind: "session", providerId: "better-auth", sessionId: session.id, subject: session.userId };
          this.#notifications.getStore()?.push(event);
        } },
      } },
      hooks: { before: createAuthMiddleware(async ctx => {
        const op = this.#operation.getStore();
        if (!op?.ticket || !["/passkey/verify-registration","/passkey/verify-authentication"].includes(ctx.path)) return;
        if (this.control.entries.length >= 256) throw new Error("Fixture trace capacity.");
        this.control.entries.push({ charged: this.policy().receipt(op.ticket.attemptId)?.state === "charged", inTransaction: this.#transaction.open });
        await this.control.pause?.("native-entry",this.#connection!);
        if (op.request.signal.aborted || !this.policy().usable(op.ticket,Date.now())) refuse();
      }) },
    });
  }
  async handle(request: Request) {
    try { return await this.handleBounded(request); }
    catch (error) {
      if (typeof error === "object" && error && "committed" in error && error.committed === true) throw error;
      return safe(error instanceof Refused ? error.status : 503,"refused");
    }
  }
  async handleBounded(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || request.headers.get("origin") !== ORIGIN || url.search) throw new Refused();
    const path = url.pathname.slice(new URL(BASE_URL).pathname.length);
    const kind = path === "/sign-in/email" ? "password"
      : path === "/passkey/generate-register-options" ? "register-options"
      : path === "/passkey/generate-authenticate-options" ? "authenticate-options"
      : path === "/passkey/generate-confirm-options" ? "confirm-options"
      : path === "/passkey/verify-registration" ? "registration"
      : path === "/passkey/verify-authentication" ? "authentication"
      : path === "/passkey/verify-confirmation" ? "confirmation" : "";
    if (!kind || url.pathname !== new URL(BASE_URL).pathname + path || request.method !== (kind.endsWith("options") ? "GET" : "POST")) throw new Refused(404);
    const confirming = kind === "confirm-options" || kind === "confirmation";
    const complete = kind === "registration" || kind === "authentication" || kind === "confirmation";
    const text = request.method === "GET" ? "" : await request.text();
    if (text.length > 32_768) throw new Refused(413);
    const body = text ? JSON.parse(text) as Record<string,unknown> : {};
    const keys = Object.keys(body).sort().join();
    if (kind === "password" ? keys !== "email,password" || typeof body.email !== "string" || typeof body.password !== "string" : complete ? keys !== "response" || !body.response || typeof body.response !== "object" : keys !== "") throw new Refused(400);
    const jar = cookies(request.headers.get("cookie"));
    const headers = new Headers({ origin: ORIGIN, "content-type": "application/json" });
    const peer = request.headers.get(IP_HEADER); if (peer) headers.set(IP_HEADER,peer);
    const allowed = kind === "register-options" || kind === "registration" || confirming ? [COOKIE.session,PASSKEY_COOKIE] : kind === "authentication" ? [PASSKEY_COOKIE] : [];
    const selected = [...jar].filter(([name]) => allowed.includes(name));
    if (selected.length) headers.set("cookie", selected.map(([n,v]) => `${n}=${v}`).join("; "));
    const nativeHeaders = new Headers(headers);
    if (confirming) nativeHeaders.set("cookie",selected.filter(([name])=>name===PASSKEY_COOKIE).map(([n,v])=>`${n}=${v}`).join("; "));
    const nativePath = kind === "confirm-options" ? "/passkey/generate-authenticate-options" : kind === "confirmation" ? "/passkey/verify-authentication" : path;
    const sanitized = new Request(BASE_URL+nativePath,{ method:request.method,headers:nativeHeaders,signal:request.signal,...(text ? { body:JSON.stringify(body) } : {}) });
    const policy = this.policy();
    let context: PasskeyContext | undefined;
    let ticket: PasskeyTicket | undefined;
    const attemptId = this.control.attemptId ?? randomUUID(); this.control.lastAttemptId = attemptId;
    const old = policy.receipt(attemptId);
    if (old) return safe(409,"receipt",{ state:old.state,committed:old.state === "succeeded" });
    if (complete) {
      const opaque = jar.get(PASSKEY_COOKIE);
      context = opaque ? policy.context(opaque) : undefined;
      if (!context || context.purpose !== (kind === "confirmation" ? "enrollment-confirmation" : kind) || !policy.valid(context,Date.now())) throw new Refused();
      let subject = context.subject;
      let credential: string | null = null;
      if (kind === "authentication" || kind === "confirmation") {
        const response = body.response as { id?: unknown };
        if (typeof response.id !== "string") throw new Refused(400);
        credential = response.id;
        subject = policy.credential(credential)?.userId ?? null;
      }
      if (kind !== "authentication") {
        const current = await this.#auth!.api.getSession({ headers,query:{ disableCookieCache:true,disableRefresh:true } });
        if (!current || current.user.id !== subject || current.session.id !== context.sessionId) throw new Refused();
      }
      if (!subject || request.signal.aborted) throw new Refused();
      try {
        ticket = await this.#database!.transaction().execute(async () => policy.admit(context!,attemptId,subject!,credential,Date.now()));
        if (this.#transaction.open || policy.receipt(attemptId)?.state !== "charged") throw new Error("Admission unconfirmed.");
      } catch {
        if (this.#transaction.open) return safe(503,"outcome_unconfirmed");
        try {
          const receipt = policy.receipt(attemptId);
          return safe(503,"admission_refused",{ charged:!!receipt,committed:!!receipt });
        } catch { return safe(503,"outcome_unconfirmed"); }
      }
      await this.control.pause?.("after-admission",this.#connection!);
    }
    const notifications: ProviderInvalidation[] = [];
    const operation: Operation = { kind,context,ticket,verified:false,request };
    let result: Response;
    try {
      result = await this.#notifications.run(notifications,() => this.#database!.transaction().execute(async trx => {
        const auth = this.library(trx,false);
        await (await auth.$context).checkSchema!();
        return this.#operation.run(operation, async () => {
          if (request.signal.aborted || (ticket && !policy.usable(ticket,Date.now()))) throw new Refused(409);
          let current: { user: { id: string }; session: { id: string } } | null = null;
          let staged: ReturnType<PasskeyAdmission["staged"]> | undefined;
          if (kind === "register-options") {
            current = await auth.api.getSession({ headers,query:{ disableCookieCache:true,disableRefresh:true } });
            if (!current || !policy.origin(current.session.id,current.user.id,Date.now()) || policy.protected(current.user.id)) throw new Refused();
          }
          if (kind === "confirm-options") {
            const opaque = jar.get(PASSKEY_COOKIE), source = opaque && policy.context(opaque);
            staged = source ? policy.candidate(source) : undefined;
            current = await auth.api.getSession({headers,query:{disableCookieCache:true,disableRefresh:true}});
            if (!staged || !current || current.session.id !== staged.sessionId || current.user.id !== staged.subject || !policy.stageUsable(staged,Date.now())) throw new Refused();
          }
          const native = await auth.handler(sanitized);
          await this.control.pause?.("after-native",this.#connection!);
          if (request.signal.aborted || !native.ok) throw new Refused(native.ok ? 409 : native.status);
          const raw = await native.text(); if (raw.length > 65_536) throw new Refused(500);
          const parsed = JSON.parse(raw) as Record<string,unknown>;
          const lines = native.headers.getSetCookie();
          if (this.control.failCookie || lines.some(line => line.startsWith(`${COOKIE.trust}=`) && !/max-age=0/i.test(line))) throw new Refused(500);
          if (kind.endsWith("options")) {
            const opaque = opaqueCookie(lines,PASSKEY_COOKIE);
            const pending = opaque && await (await auth.$context).internalAdapter.findVerificationValue(unsigned(opaque));
            if (!opaque || !pending) throw new Refused(500);
            const issued = JSON.parse(pending.value) as { type:string; expectedChallenge:string; userData:{id:string} };
            const expectedKind = kind === "register-options" ? "registration" : "authentication";
            if (issued.type !== expectedKind || issued.expectedChallenge !== parsed.challenge || (current && !staged && issued.userData.id !== current.user.id)) throw new Refused(500);
            const origin = current && policy.origin(current.session.id,current.user.id,Date.now());
            if (current && !origin) throw new Refused();
            if (staged && !policy.stageUsable(staged,Date.now())) throw new Refused();
            policy.issue(opaque,{ purpose:staged ? "enrollment-confirmation" : expectedKind,subject:current?.user.id ?? null,sessionId:current?.session.id ?? null,
              handle:staged?.handle ?? (current ? (parsed.user as {id:string}).id : null),nativeId:pending.id,credential:staged?.credential,
              deadline:Math.min(new Date(pending.expiresAt).getTime(),origin?.originalDeadline ?? Infinity,staged?.deadline ?? Infinity),originalDeadline:staged?.originalDeadline ?? origin?.originalDeadline ?? new Date(pending.expiresAt).getTime(),generation:current ? policy.generation(current.user.id) : null });
            // Native authentication hard-codes preferred. Browser instructions are
            // tightened here; the callback independently requires verified UV.
            if (kind === "authenticate-options" || staged) parsed.userVerification = "required";
            else parsed.attestation = "none"; // Privacy-preserving default; packed remains supported.
            if (staged) parsed.allowCredentials = [{id:staged.credential,type:"public-key"}];
            policy.operationReceipt(attemptId,current?.user.id ?? null,new Date(pending.expiresAt).getTime());
            return safe(200,"options",{ options:parsed },lines.filter(line => line.startsWith(`${PASSKEY_COOKIE}=`)));
          }
          if (kind === "registration") {
            if (!ticket || !operation.registrationFormat || parsed.userId !== ticket.subject || typeof parsed.credentialID !== "string") throw new Refused(500);
            const row = policy.credential(parsed.credentialID);
            if (!row || row.userId !== ticket.subject || !context?.handle) throw new Refused(500);
            if (this.control.failEvidence) throw new Refused(500);
            policy.settle(ticket,null,Date.now());
            if (operation.registrationFormat === "none") {
              policy.stage(row,context);
              return safe(200,"staged",{authorizing:false});
            }
            if (!operation.verified) throw new Refused(500);
            policy.capacity("passkey_fixture_trust");
            policy.run("INSERT INTO passkey_fixture_trust VALUES (?,?,?,?,?,1)",[row.credentialID,row.userId,context.handle,policy.fingerprint(row),ticket.generation]);
            return safe(200,"enrolled",{ authorizing:false });
          }
          if (kind === "password" && parsed.twoFactorRedirect === true) {
            const pendingCookie=opaqueCookie(lines,COOKIE.challenge);
            const pending=pendingCookie && await (await auth.$context).internalAdapter.findVerificationValue(unsigned(pendingCookie));
            if (!pending || !operation.nativeSubject || pending.value!==operation.nativeSubject || !policy.current(operation.nativeSubject)) throw new Refused();
            policy.operationReceipt(attemptId,operation.nativeSubject,new Date(pending.expiresAt).getTime());
            return safe(200,"challenge",{},lines.filter(line => line.startsWith(`${COOKIE.challenge}=`) || /max-age=0/i.test(line)));
          }
          const opaque = opaqueCookie(lines,COOKIE.session);
          const session = opaque && await auth.api.getSession({headers:new Headers({cookie:`${COOKIE.session}=${opaque}`}),query:{disableCookieCache:true,disableRefresh:true}});
          if (!session || !policy.current(session.user.id) || (ticket && (session.user.id !== ticket.subject || !operation.verified))) throw new Refused(500);
          // Optional enrollment does not turn the unprotected password path into
          // a bypass. TOTP's native pending path above remains an alternative.
          if (kind === "password" && policy.enrolled(session.user.id)) throw new Refused();
          if (this.control.failEvidence) throw new Refused(500);
          if (kind === "confirmation") {
            if (!ticket || session.session.id === context?.sessionId || session.user.id !== ticket.subject) throw new Refused(500);
            // Native always creates a session. Delete only that exact new token
            // through its public internal adapter, in this same transaction.
            await (await auth.$context).internalAdapter.deleteSession(session.session.token);
            if (policy.rows('SELECT 1 FROM authentication_ba_session WHERE id=?',[session.session.id]).length) throw new Refused(500);
            policy.promote(ticket,Date.now());
            return safe(200,"enrolled",{authorizing:false});
          }
          const method = kind === "password" ? "password" : "passkey_uv";
          policy.evidence(session.session.id,session.user.id,method,new Date(session.session.createdAt).getTime(),new Date(session.session.expiresAt).getTime(),ticket?.credential ?? null);
          if (ticket) policy.settle(ticket,session.session.id,Date.now());
          else policy.operationReceipt(attemptId,session.user.id,new Date(session.session.expiresAt).getTime(),session.session.id);
          return safe(200,"observation",{ method,authorizing:false },lines.filter(line => line.startsWith(`${COOKIE.session}=`)));
        });
      }));
    } catch (error) {
      // R13 rule: never read an uncommitted receipt or publish its effects.
      if (this.#transaction.open) return safe(503,"outcome_unconfirmed");
      let committed=false;
      try {
        committed=policy.receipt(attemptId)?.state === "succeeded";
        if (!committed && ticket) policy.fail(attemptId);
      } catch { return safe(503,"outcome_unconfirmed"); }
      if (committed) {
        for (const event of notifications) this.host.invalidated(event);
        return safe(503,"completion_receipt",{committed:true});
      }
      return safe(error instanceof Refused ? error.status : 503,"refused",{committed:false});
    }
    for (const event of notifications) this.host.invalidated(event);
    return result;
  }
  async resolveSession(): Promise<null> { return null; } // Contract 2 cannot describe passkey evidence.
  async signOut(): Promise<Response> { return safe(404,"unsupported"); }
  async provisionLocal(): Promise<{subject:string}> { throw new Error("Fixture provisioning disabled."); }
  async recoverLocal(): Promise<void> { throw new Error("Fixture recovery disabled."); }
  async revokeSession(): Promise<void> { throw new Error("Fixture management disabled."); }
  async revokeSubjectSessions(): Promise<void> { throw new Error("Fixture management disabled."); }
  async dispose() { this.#auth = undefined; const db = this.#database; this.#database = undefined; await db?.destroy(); }
}
export const authenticationProvider: AuthenticationProviderModule = {
  contractVersion:2,providerId:"better-auth",implementationVersion:PASSKEY_IMPLEMENTATION,storageRevision:1,
  create(host,options) { return new PasskeyProvider(host,options as Options); },
};
