import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, SqliteDialect } from "kysely";
import { loadAuthenticationProvider } from "@/server/modules/authentication";
import type { ExclusiveConnectionOptions } from "@/server/infrastructure/sqlite/exclusive-connection";
import { BASE_URL, IP_HEADER, SECRET, type ProviderEvidence } from "./fixture";
import { applyFactorDdl, factorStore, type FactorStore } from "./factor-fixture";
import { PASSKEY_DDL,PasskeyAdmission } from "./passkey-admission";
import { newPasskeyControl, passkeyLibraryOptions, type PasskeyControl } from "./passkey-provider";

const SETTINGS = { baseURL:BASE_URL,secret:SECRET,clientIpHeader:IP_HEADER };
export async function loadPasskey(base: FactorStore,control: PasskeyControl) {
  const evidence: ProviderEvidence = {events:[],logs:[],resets:[],failInvalidation:false};
  const runtime = await loadAuthenticationProvider({
    entry:fileURLToPath(new URL("./passkey-provider.ts",import.meta.url)),providerId:"better-auth",storage:base.storage,
    options:{...SETTINGS,passkeyControl:control} as Parameters<typeof loadAuthenticationProvider>[0]["options"],
    onInvalidation(event) { if (evidence.failInvalidation) throw new Error("Fixture listener failed."); evidence.events.push(event); },
    log(level,message) { evidence.logs.push(`${level}: ${message}`); },
  });
  return {runtime,evidence};
}
export async function passkeyFixture(connectionOptions: ExclusiveConnectionOptions = {admission:"strict"},additionalEmails: string[] = []) {
  const base = await factorStore(connectionOptions,additionalEmails);
  try {
    await applyFactorDdl(base); // Existing public fixture; keeps TOTP interop isolated.
    const ddl = await base.storage.borrow(async () => {
      const connection = base.storage.createProviderConnection();
      const database = new Kysely<never>({dialect:new SqliteDialect({database:connection})});
      try {
        const options = passkeyLibraryOptions(SETTINGS,database);
        const plan = await getMigrations(options);
        const statements = (await plan.compileMigrations()).split(/;\s*(?:\n\n|$)/).map(s => s.trim()).filter(Boolean);
        connection.prepare("BEGIN").run([]);
        try {
          for (const sql of [...statements,...PASSKEY_DDL]) connection.prepare(sql).run([]);
          connection.prepare("COMMIT").run([]);
        } catch(error) {connection.prepare("ROLLBACK").run([]);throw error;}
        const after = await getMigrations(options);
        return {statements,created:plan.toBeCreated.map(t => t.table),outstanding:after.toBeCreated.length+after.toBeAdded.length+after.toBeAddedIndexes.length+after.schemaProblems.length};
      } finally {await database.destroy();}
    });
    const control = newPasskeyControl();
    return {...base,ddl,control,...await loadPasskey(base,control)};
  } catch(error) {await base.store.closeAfterDrain();throw error;}
}
export type PasskeyFixture = Awaited<ReturnType<typeof passkeyFixture>>;
export async function closePasskey(f: PasskeyFixture) {
  await f.runtime.dispose();await f.store.closeAfterDrain();
  const snapshot = f.store.admissionSnapshot();
  if (snapshot.state !== "closed" || snapshot.providerExecutions !== 0 || existsSync(`${f.path}.owner.lock`)) throw new Error("Passkey fixture cleanup unconfirmed.");
}
/** Safe projections only. No token, raw capability, response, private key or password. */
export async function passkeyState(f: FactorStore) {
  return f.storage.borrow(async () => {
    const db = f.storage.createProviderConnection();
    try {
      const rows = <T>(sql:string) => db.prepare(sql).all([]) as T[];
      return {
        credentials:rows<{id:string;userId:string;counter:number}>('SELECT id,"userId",counter FROM authentication_ba_passkey ORDER BY id'),
        sessions:rows<{id:string;userId:string;expiresAt:number}>('SELECT id,"userId","expiresAt" FROM authentication_ba_session ORDER BY id'),
        evidence:rows<{method:string;authorizing:number;originalDeadline:number;authenticatedAt:number}>('SELECT method,authorizing,originalDeadline,authenticatedAt FROM passkey_fixture_evidence ORDER BY sessionId'),
        receipts:rows<{state:string;attemptId:string;sessionId:string|null}>('SELECT state,attemptId,sessionId FROM passkey_fixture_receipt ORDER BY rowid'),
        contexts:rows<{purpose:string;used:number;deadline:number}>('SELECT purpose,used,deadline FROM passkey_fixture_context ORDER BY rowid'),
        budgets:rows<{charged:number}>('SELECT charged FROM passkey_fixture_budget'),
        trusted:rows<{verifiedUv:number}>('SELECT verifiedUv FROM passkey_fixture_trust'),
        schema:rows<{version:number}>('SELECT max(version) version FROM schema_migrations')[0]!.version,
      };
    } finally {db.close();}
  });
}

/** Real native session liveness, projected through current fixture evidence. Never a controller actor. */
export async function observePasskeySession(f:FactorStore,cookie:string) {
  return f.storage.borrow(async()=>{
    const db=f.storage.createProviderConnection(),database=new Kysely<never>({dialect:new SqliteDialect({database:db})});
    try {
      const auth=betterAuth(passkeyLibraryOptions(SETTINGS,database));
      await (await auth.$context).checkSchema!();
      const current=await auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true,disableRefresh:true}});
      return current ? new PasskeyAdmission(db).session(current.session.id,current.user.id,Date.now()) : null;
    } finally {await database.destroy();}
  });
}
