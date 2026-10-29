import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadAuthenticationProvider, type AuthenticationProviderRuntime, type ProviderInvalidation } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import type { ProofFaultInjection } from "../src/index";

export const PROVIDER_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
export const ORIGIN = "https://controller.test";
export const BASE_URL = `${ORIGIN}/api/auth`;
/** Fixture-only secret; never an installation credential. */
export const SECRET = "fixture-only-better-auth-proof-secret-0123456789";
export const IP_HEADER = "x-worktree-control-client-ip";
export const OWNER_EMAIL = "owner@fixture.invalid";
export const OWNER_PASSWORD = "fixture-owner-password-1";

const roots: string[] = [];
export function cleanupRoots(): void { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }

export function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "auth-provider-proof-")); roots.push(root);
  const path = join(root, "state.sqlite3");
  const store = new SqliteStateStore(path);
  const identity = new IdentityService(store);
  const owner = identity.bootstrapOwnerSession();
  return { root, path, store, identity, owner, ownerActor: identity.authenticateBearer(owner.token) };
}

export interface ProviderEvidence { events: ProviderInvalidation[]; logs: string[]; resets: Array<{ subject: string; token: string }>; failInvalidation: boolean }

export async function loadProof(store: SqliteStateStore, faultInjection?: ProofFaultInjection, entry = PROVIDER_ENTRY) {
  const evidence: ProviderEvidence = { events: [], logs: [], resets: [], failInvalidation: false };
  const runtime = await loadAuthenticationProvider({
    entry,
    providerId: "better-auth",
    storage: store.authenticationProviderStorage(),
    options: {
      baseURL: BASE_URL, secret: SECRET, clientIpHeader: IP_HEADER,
      passwordResetDelivery: async delivery => { evidence.resets.push(delivery); },
      ...(faultInjection ? { faultInjection } : {}),
    } as Parameters<typeof loadAuthenticationProvider>[0]["options"],
    onInvalidation: event => {
      if (evidence.failInvalidation) throw new Error("listener failure");
      evidence.events.push(event);
    },
    log: (level, message) => { evidence.logs.push(`${level}: ${message}`); },
  });
  return { runtime, evidence };
}

export async function proofFixture(faultInjection?: ProofFaultInjection) {
  const base = storeFixture();
  const { runtime, evidence } = await loadProof(base.store, faultInjection);
  return { ...base, runtime, evidence };
}

/** Committed state only, through a short-lived read-only test connection. */
export function readCommitted<T>(path: string, read: (database: Database.Database) => T): T {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try { return read(database); } finally { database.close(); }
}
export const count = (path: string, table: string) => readCommitted(path, database => (database.prepare(`SELECT count(*) n FROM "${table}"`).get() as { n: number }).n);

/** Fetch-style client with a cookie jar; no sockets. */
export class Client {
  readonly cookies = new Map<string, string>();
  constructor(private readonly runtime: AuthenticationProviderRuntime, readonly ip = "203.0.113.10") {}

  cookieHeader(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "); }

  async call(path: string, init: { method?: string; body?: unknown; origin?: string | null; headers?: Record<string, string>; url?: string; cookie?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(IP_HEADER, this.ip);
    if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
    const cookie = init.cookie ?? this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const request = new Request(init.url ?? `${BASE_URL}${path}`, { method: init.method ?? "POST", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const response = await this.runtime.handle(request);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair!.indexOf("=");
      const name = pair!.slice(0, index), value = pair!.slice(index + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }

  signIn(password = OWNER_PASSWORD, email = OWNER_EMAIL) { return this.call("/sign-in/email", { body: { email, password } }); }

  resolve(cookie = this.cookieHeader()) { return this.runtime.resolve(new Headers(cookie ? { cookie } : {})); }
}
