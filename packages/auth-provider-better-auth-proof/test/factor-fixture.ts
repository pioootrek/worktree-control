import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { Kysely, SqliteDialect } from "kysely";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import type { ExclusiveConnectionOptions } from "@/server/infrastructure/sqlite/exclusive-connection";
import { loadAuthenticationProvider } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { BASE_URL, IP_HEADER, loadProof, ORIGIN, OWNER_EMAIL, OWNER_PASSWORD, SECRET, type ProviderEvidence } from "./fixture";
import { EVIDENCE_TABLE, factorLibraryOptions, FACTOR_MODEL, newFactorControl, type FactorControl, type FactorMode } from "./factor-provider";
import { ADMISSION_DDL } from "./factor-admission";

const FACTOR_ENTRY = fileURLToPath(new URL("./factor-provider.ts", import.meta.url));
const SETTINGS = { baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER };

const roots: string[] = [];
export function cleanupFactorRoots() { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }

/** A normal store at the recognized schema, with one account provisioned by the real password proof. */
export async function factorStore(connectionOptions: ExclusiveConnectionOptions = {}, additionalEmails: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "auth-provider-factor-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path, undefined, connectionOptions);
  const identity = new IdentityService(store);
  const owner = await store.admission.run(() => identity.bootstrapOwnerSession());
  store.requireAdmission();
  try {
    const password = await loadProof(store);
    try {
      const { subject } = await password.runtime.provisionLocal({
        principalId: owner.principalId, email: OWNER_EMAIL, name: "Owner",
        password: OWNER_PASSWORD, actor: "local-bootstrap",
      });
      const subjects = [subject];
      for (const email of additionalEmails) {
        // Fixture-only second owner. Public multi-user provisioning is outside A3-I13.
        const principalId = randomUUID();
        const storage = store.authenticationProviderStorage();
        await storage.borrow(async () => {
          const connection = storage.createProviderConnection();
          try { connection.prepare("INSERT INTO remote_principals (id, kind, status) VALUES (?, 'owner', 'active')").run([principalId]); } finally { connection.close(); }
        });
        subjects.push((await password.runtime.provisionLocal({ principalId, email, name: "Additional fixture subject", password: OWNER_PASSWORD, actor: "local-bootstrap" })).subject);
      }
      return { root, path, store, owner, subject, subjects, storage: store.authenticationProviderStorage() };
    } finally { await password.runtime.dispose(); }
  } catch (error) { await store.closeAfterDrain(); throw error; }
}
export type FactorStore = Awaited<ReturnType<typeof factorStore>>;

/** Runs one fixture statement inside its own exclusive borrow, on a connection closed right after. */
export function fixtureSql({ storage }: FactorStore, sql: string, parameters: readonly unknown[] = []): Promise<void> {
  return storage.borrow(async () => {
    const connection = storage.createProviderConnection();
    try { connection.prepare(sql).run(parameters); } finally { connection.close(); }
  });
}

/**
 * The temporary owner, never a provider, generates and applies candidate DDL
 * inside one exclusive borrow. Nothing here changes migrations or the inspector,
 * and this database must not be reopened as a recognized store.
 */
export async function applyFactorDdl({ storage }: FactorStore, admitted = false) {
  return storage.borrow(async () => {
    const connection = storage.createProviderConnection();
    const database = new Kysely<never>({ dialect: new SqliteDialect({ database: connection }) });
    try {
      const options = factorLibraryOptions(SETTINGS, database);
      const plan = await getMigrations(options);
      const compiled = await plan.compileMigrations();
      const statements = compiled.split(/;\s*(?:\n\n|$)/).map(statement => statement.trim()).filter(Boolean);
      const transaction = (sql: string) => { connection.prepare(sql).run([]); };
      transaction("BEGIN");
      try {
        for (const statement of statements) connection.prepare(statement).run([]);
        // Fixture stand-in for controller-owned evidence; no such table is proposed here.
        connection.prepare(`CREATE TABLE "${EVIDENCE_TABLE}" ("sessionId" text not null primary key references "authentication_ba_session" ("id") on delete cascade, "method" text not null, "restricted" integer not null, "verifiedAt" text not null)`).run([]);
        if (admitted) for (const statement of ADMISSION_DDL) connection.prepare(statement).run([]);
        transaction("COMMIT");
      } catch (error) { transaction("ROLLBACK"); throw error; }
      const after = await getMigrations(options);
      return {
        statements,
        created: plan.toBeCreated.map(table => table.table),
        added: plan.toBeAdded.map(table => ({ table: table.table, fields: Object.keys(table.fields) })),
        outstanding: { created: after.toBeCreated.length, added: after.toBeAdded.length, indexes: after.toBeAddedIndexes.length, problems: after.schemaProblems.length },
      };
    } finally { await database.destroy(); }
  });
}

export async function loadFactorProvider(base: FactorStore, control: FactorControl) {
  const evidence: ProviderEvidence = { events: [], logs: [], resets: [], failInvalidation: false };
  const runtime = await loadAuthenticationProvider({
    entry: FACTOR_ENTRY,
    providerId: "better-auth",
    storage: base.storage,
    options: { ...SETTINGS, factorControl: control } as Parameters<typeof loadAuthenticationProvider>[0]["options"],
    onInvalidation: event => {
      if (evidence.failInvalidation) throw new Error("listener failure");
      evidence.events.push(event);
    },
    log: (level, message) => { evidence.logs.push(`${level}: ${message}`); },
  });
  return { runtime, evidence };
}

export async function factorFixture(mode: FactorMode = "native", connectionOptions: ExclusiveConnectionOptions = { admission: "strict" }, additionalEmails: string[] = []) {
  const base = await factorStore(connectionOptions, additionalEmails);
  try {
    const ddl = await applyFactorDdl(base, mode === "admitted");
    const control = newFactorControl(mode);
    const { runtime, evidence } = await loadFactorProvider(base, control);
    return { ...base, ddl, control, runtime, evidence };
  } catch (error) { await base.store.closeAfterDrain(); throw error; }
}
export type FactorFixture = Awaited<ReturnType<typeof factorFixture>>;

export async function closeFactor(f: FactorFixture) {
  await f.runtime.dispose();
  await f.store.closeAfterDrain();
  const snapshot = f.store.admissionSnapshot();
  if (snapshot.state !== "closed" || snapshot.providerExecutions !== 0 || existsSync(`${f.path}.owner.lock`)) {
    throw new Error("Factor fixture cleanup did not release its sole owner.");
  }
}

/**
 * Arms a real SQLite failure for `act`. A TEMP trigger lives only on this
 * connection, is never written to the database file and is removed afterwards.
 */
export async function withFault<T>(f: FactorStore, trigger: string, act: () => Promise<T>): Promise<T> {
  await fixtureSql(f, `CREATE TEMP TRIGGER fixture_fault ${trigger} BEGIN SELECT RAISE(ABORT, 'fixture fault'); END`);
  try { return await act(); } finally { await fixtureSql(f, "DROP TRIGGER temp.fixture_fault"); }
}

const digest = (value: unknown) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/** Committed rows. Credential columns appear as digests, so a failed assertion cannot print them. */
export async function factorState(f: FactorStore) {
  return f.storage.borrow(async () => {
    const database = f.storage.createProviderConnection();
    const query = (sql: string) => database.prepare(sql).all([]);
    try {
      const user = query('SELECT "twoFactorEnabled" enabled FROM "authentication_ba_user"')[0] as { enabled: number | null } | undefined;
      const factor = query(`SELECT "verified" verified, "failedVerificationCount" failed, "lockedUntil" locked, "backupCodes" codes, "secret" secret FROM "${FACTOR_MODEL}"`)[0] as { verified: number | null; failed: number | null; locked: string | null; codes: string; secret: string } | undefined;
      const sessions = query('SELECT "id" FROM "authentication_ba_session" ORDER BY "id"').map(row => (row as { id: string }).id);
      const verificationRows = query('SELECT "value" FROM "authentication_ba_verification"') as Array<{ value: string }>;
      const verifications = verificationRows.length;
      const attempts = verificationRows.filter(row => /^\d+$/.test(row.value)).map(row => Number(row.value)).sort();
      const schemaVersion = (query('SELECT max(version) version FROM "schema_migrations"')[0] as { version: number }).version;
      const sessionColumns = query('PRAGMA table_info("authentication_ba_session")').map(row => (row as { name: string }).name);
      const evidence = query(`SELECT "method", "restricted" FROM "${EVIDENCE_TABLE}"`) as Array<{ method: string; restricted: number }>;
      return {
        enabled: user?.enabled ?? null, verified: factor?.verified ?? null, failed: factor?.failed ?? null, locked: factor?.locked ?? null,
        codes: factor ? digest(factor.codes) : null, secret: factor ? digest(factor.secret) : null, sessions, verifications, attempts, evidence, schemaVersion, sessionColumns,
      };
    } finally { database.close(); }
  });
}
export type FactorState = Awaited<ReturnType<typeof factorState>>;

/** A real authenticator app: reads only the issued URI and implements RFC 6238 independently of the library. */
export class Authenticator {
  readonly #key: Buffer;
  readonly #digits: number;
  readonly #period: number;
  constructor(uri: string) {
    const url = new URL(uri);
    if (url.protocol !== "otpauth:") throw new Error("Not an authenticator URI.");
    const secret = url.searchParams.get("secret");
    if (!secret) throw new Error("The URI has no secret.");
    this.#key = base32Decode(secret);
    this.#digits = Number(url.searchParams.get("digits") ?? 6);
    this.#period = Number(url.searchParams.get("period") ?? 30);
  }
  /** The code for the step `offset` periods away from now. */
  code(offset = 0): string { return this.codeAt(Date.now() + offset * this.#period * 1000); }
  /** Client-side generation at a known time; never used by the provider to verify. */
  codeAt(milliseconds: number): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(milliseconds / 1000 / this.#period)));
    const hash = createHmac("sha1", this.#key).update(counter).digest();
    const start = hash[hash.length - 1]! & 15;
    return String((hash.readUInt32BE(start) & 0x7fffffff) % 10 ** this.#digits).padStart(this.#digits, "0");
  }
  /** Deterministically wrong: differs from every code in the accepted window. */
  wrong(): string {
    const accepted = new Set([-1, 0, 1].map(offset => this.code(offset)));
    for (let value = 0; ; value++) {
      const candidate = String(value).padStart(this.#digits, "0");
      if (!accepted.has(candidate)) return candidate;
    }
  }
}
function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of value.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g)!.map(byte => Number.parseInt(byte, 2)));
}

let nextAddress = 0;
/** A distinct peer per request, so unrelated limiter buckets never decide a security result. */
const freshIp = () => { nextAddress++; return `10.${(nextAddress >> 16) & 255}.${(nextAddress >> 8) & 255}.${nextAddress & 255}`; };

export interface BrowserResult { status: number; json: Record<string, unknown> | null; setCookie: string[] }

/** A cookie jar over the real runtime and handler. Fixture credentials stay in memory. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly f: Pick<FactorFixture, "runtime">) {}

  cookieHeader(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "); }

  /** Another browser presenting exactly this one's cookies, e.g. a replayed or concurrent request. */
  clone(): Browser { const copy = new Browser(this.f); for (const [name, value] of this.cookies) copy.cookies.set(name, value); return copy; }

  async post(path: string, body: unknown = {}, init: { ip?: string; origin?: string | null; cookie?: string; method?: string; signal?: AbortSignal } = {}): Promise<BrowserResult> {
    const headers = new Headers({ [IP_HEADER]: init.ip ?? freshIp() });
    if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
    const cookie = init.cookie ?? this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);
    if (init.method !== "GET") headers.set("content-type", "application/json");
    const response = await this.f.runtime.handle(new Request(`${BASE_URL}${path}`, {
      method: init.method ?? "POST", headers, signal: init.signal, ...(init.method === "GET" ? {} : { body: JSON.stringify(body) }),
    }));
    const setCookie = response.headers.getSetCookie();
    for (const line of setCookie) {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index), value = pair!.slice(index + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try { json = text ? JSON.parse(text) as Record<string, unknown> : null; } catch { /* a failed native body is not JSON */ }
    return { status: response.status, json, setCookie };
  }

  signIn(password = OWNER_PASSWORD) { return this.post("/sign-in/email", { email: OWNER_EMAIL, password }); }

  resolve(cookie = this.cookieHeader()) { return this.f.runtime.resolve(new Headers(cookie ? { cookie } : {})); }
}
