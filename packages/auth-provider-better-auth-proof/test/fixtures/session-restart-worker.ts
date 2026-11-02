/**
 * One real owner process for the session-restart proof. Built privately by
 * scripts/auth-provider-session-restart.mjs, outside every Community output; it is
 * never a product entry point. It composes the shared owner, HTTP and provider
 * code. Cuts hook only SQL statements and two runtime methods, in this process,
 * and they stop at the real boundary rather than writing any state of their own.
 * IPC carries counts and IDs. Cookies and passwords never pass through it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createControllerShutdown } from "@/server/bootstrap/controller-shutdown";
import { composeIsolatedBrowserAuthentication } from "@/server/bootstrap/authentication";
import { createControllerBackup, restoreControllerBackup } from "@/server/controller-backup";
import { acquireControllerLock, type ControllerLock } from "@/server/controller-lock";
import { openControllerStore } from "@/server/controller-storage";
import type { ControlService } from "@/server/control-service";
import type { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
import { createControllerServer } from "@/server/http-server";
import { OwnedSqliteDatabase, SqliteStateStore } from "@/server/infrastructure/sqlite";
import { AuthenticationService, loadAuthenticationProvider, type AuthenticationProviderRuntime, type ProviderFactorLimits } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";

/** Everything the parent chooses, and nothing secret: secrets stay in the private file. */
interface Boot {
  root: string;
  mode: "owner" | "seed" | "seed-v40" | "challenger" | "restore";
  nonce: string;
  clockOffsetMs: number;
  unreleasedSessions: number;
  sessionRows: number;
  sessionReconcileBatch: number;
  cut?: Cut;
  fault?: "poison";
  backup?: string;
  provider?: string;
}
type Cut =
  | { kind: "sql"; point: string; at: string; when: "before" | "after"; armedBy?: string; nth?: number; effect?: "hold" | "throw" }
  | { kind: "before-publication" | "after-publication" | "after-write" | "held-result"; point: string };
interface Secrets { secret: string; password: string; email: string; schema40?: string }

const boot = JSON.parse(process.argv[2]!) as Boot;
const secrets = JSON.parse(readFileSync(join(boot.root, "private.json"), "utf8")) as Secrets;
const ORIGIN = "https://controller.test", IP_HEADER = "x-worktree-control-client-ip";
const databasePath = join(boot.root, "data/state.sqlite3"), attachmentDirectory = join(boot.root, "data/attachments");
const controllerLockPath = join(boot.root, "state/controller.lock"), socketPath = join(boot.root, "s.sock");
const send = (message: Record<string, unknown>) => process.send?.({ ...message, nonce: boot.nonce, pid: process.pid });

// One private time source for native creation, core evaluation and expiry, reset by each boot.
const realNow = Date.now.bind(Date), RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...input: unknown[]) {
    if (input.length === 0) super(realNow() + boot.clockOffsetMs);
    else super(...(input as [string]));
  }
  static now() { return realNow() + boot.clockOffsetMs; }
} as DateConstructor;

let cut = boot.cut, armed = cut?.kind !== "sql" || !cut.armedBy, seen = 0, raw: Database.Database | undefined;
/** Sole connection, read while this process is stopped or inside admission. Never a second reader. */
const rows = <T>(sql: string) => (prepare.call(raw!, sql) as unknown as { all(): T[] }).all();
const digest = (value: unknown) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
function snapshot() {
  const issuance = rows<{ id: string; state: string; deadline: string }>("SELECT session_id AS id, state, original_deadline AS deadline FROM authentication_session_issuance ORDER BY session_id LIMIT 64");
  return {
    sessions: rows<{ id: string }>('SELECT "id" AS id FROM "authentication_ba_session" ORDER BY "id" LIMIT 64').map(row => row.id),
    evidence: rows<{ id: string; deadline: string }>("SELECT session_id AS id, original_deadline AS deadline FROM authentication_session_evidence ORDER BY session_id LIMIT 64"),
    issuance,
    pending: issuance.filter(row => row.state === "pending").map(row => row.id),
    password: rows<{ password: string | null }>('SELECT "password" AS password FROM "authentication_ba_account" ORDER BY "id"').map(row => digest(row.password)),
    policy: rows("SELECT generation, policy_revision AS revision, totp_selected AS totp, passkey_selected AS passkey FROM authentication_account_policies"),
    mappings: rows("SELECT subject, status, revoked_at AS revokedAt FROM authentication_provider_subjects"),
    step: rows<{ step: number }>("SELECT last_step AS step FROM authentication_totp_steps")[0]?.step ?? null,
    counter: rows<{ counter: number }>('SELECT "counter" AS counter FROM "authentication_ba_passkey" LIMIT 1')[0]?.counter ?? null,
    trust: rows<{ n: number }>("SELECT count(*) n FROM authentication_passkey_trust")[0]!.n,
    receipts: rows("SELECT state, count(*) n FROM authentication_factor_receipts GROUP BY state ORDER BY state"),
    charges: rows<{ n: number | null }>("SELECT sum(charged) n FROM authentication_factor_budgets")[0]!.n ?? 0,
    schema: rows<{ n: number }>("SELECT count(*) n FROM schema_migrations")[0]!.n,
  };
}
/** The same bounded wait the restore crash worker uses, so a parent reads the point before SIGKILL. */
function hold(point: string): never {
  send({ type: "cut", point, snapshot: snapshot() });
  const deadline = realNow() + 100;
  while (realNow() < deadline) { /* Let the IPC message leave before stopping for good. */ }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Unreachable fixture hold.");
}
const { prepare } = Database.prototype;
/** Ownership inspects read-only first, then reopens writable. Follow the live writable handle. */
const follow = (database: Database.Database) => { if (!raw?.open || !database.readonly) raw = database; };
function sqlBoundary(sql: string, when: "before" | "after"): void {
  if (cut?.kind !== "sql") return;
  if (cut.armedBy && !armed && when === "after" && new RegExp(cut.armedBy, "i").test(sql)) { armed = true; return; }
  if (!armed || cut.when !== when || !new RegExp(cut.at, "i").test(sql)) return;
  if (++seen !== (cut.nth ?? 1)) return;
  if (cut.effect === "throw") { cut = undefined; throw new Error("Fixture SQL boundary."); }
  hold(cut.point);
}
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  follow(this);
  const statement = prepare.call(this, sql) as unknown as Record<string, (...input: unknown[]) => unknown>;
  if (cut?.kind !== "sql") return statement as never;
  for (const name of ["run", "all", "get"]) {
    const method = statement[name]!;
    statement[name] = function (this: unknown, ...input: unknown[]) {
      sqlBoundary(sql, "before");
      const result = method.apply(this, input);
      sqlBoundary(sql, "after");
      return result;
    };
  }
  return statement as never;
} as typeof Database.prototype.prepare;

/** Finite proof inputs, chosen so no budget interferes. None is a product value. */
const LIMITS: ProviderFactorLimits = {
  totp: { attempts: 32, windowMs: 60_000 }, passkey: { attempts: 32, windowMs: 60_000 }, ticketMs: 15_000, stagingMs: 600_000, capacity: 256, pruneBatch: 16,
  issuance: { perPeer: { attempts: 64, windowMs: 60_000 }, global: { attempts: 128, windowMs: 60_000 }, peers: 32, nativeChallenges: 256, reservedContexts: 8 },
  webauthn: { credentialIdBytes: 2048, clientDataBytes: 2048, attestationBytes: 16_384, authenticatorDataBytes: 8192, publicKeyBytes: 2048, signatureBytes: 2048,
    userHandleBytes: 64, challengeBytes: 64, transports: 8, credentials: 16, responseBytes: 65_536 },
};
const TRANSPORT = { passwordBodyBytes: 4096, webAuthnBodyBytes: 32_768, knowledgeBodyBytes: 65_536, cookieBytes: 8192, bodyTimeoutMs: 10_000,
  json: { maxDepth: 8, maxFields: 64 }, knowledgeJson: { maxDepth: 16, maxFields: 1024 }, reservedCompletionSlots: 0 };

async function challenger(): Promise<void> {
  const outcome = (attempt: () => void) => { try { attempt(); return "acquired"; } catch { return "refused"; } };
  const controller = outcome(() => { acquireControllerLock(controllerLockPath).release(); });
  const database = outcome(() => { new OwnedSqliteDatabase(databasePath).close(); });
  send({ type: "challenge", controller, database });
}

function seedSchema40(): void {
  mkdirSync(join(boot.root, "data"), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath, { fileMustExist: false });
  try {
    raw = database;
    database.exec(readFileSync(secrets.schema40!, "utf8"));
    database.prepare(`INSERT INTO "authentication_ba_user"("id","name","email","emailVerified","createdAt","updatedAt") VALUES('legacy-subject','Legacy','legacy@fixture.invalid',0,?,?)`).run("2026-10-28T00:00:00.000Z", "2026-10-28T00:00:00.000Z");
    database.prepare(`INSERT INTO "authentication_ba_session"("id","expiresAt","token","createdAt","updatedAt","userId") VALUES('legacy-unmarked',?,'legacy-token',?,?,'legacy-subject')`).run("2026-10-28T08:00:00.000Z", "2026-10-28T00:00:00.000Z", "2026-10-28T00:00:00.000Z");
  } finally { database.close(); }
  send({ type: "done", mode: boot.mode });
}

function restore(): void {
  restoreControllerBackup(boot.backup!, databasePath, attachmentDirectory);
  send({ type: "done", mode: boot.mode });
}

async function owner(): Promise<void> {
  mkdirSync(join(boot.root, "data"), { recursive: true, mode: 0o700 });
  const lock: ControllerLock = acquireControllerLock(controllerLockPath);
  // A killed listener leaves its socket file. Only this owner may replace it, before anyone can connect.
  rmSync(socketPath, { force: true });
  const store: SqliteStateStore = boot.fault === "poison"
    ? new SqliteStateStore(databasePath, undefined, { rollback: () => { throw new Error("Fixture rollback failure."); } })
    : await openControllerStore(databasePath, { backupBeforeMigration: boot.backup !== undefined, backupDirectory: boot.backup,
      applicationVersion: "0.0.0-session-restart", attachmentDirectory });
  const seeding = boot.mode === "seed", identity = new IdentityService(store, undefined, undefined, undefined, undefined, store);
  const ownerSession = seeding ? identity.bootstrapOwnerSession() : null;
  store.requireAdmission();
  // Reading through the store proves it can be inspected whatever recovery decides.
  send({ type: "opened", snapshot: await store.admission.run(() => snapshot()), provenance: store.databaseProvenance });
  const policy = { sessionRows: boot.sessionRows, sessionReconcileBatch: boot.sessionReconcileBatch };
  try { await store.recoverIssuedSessions(policy); } catch {
    // Refusal keeps every row and never starts a listener. The parent reads this, then stops us.
    send({ type: "refused", snapshot: await store.admission.run(() => snapshot()), listening: existsSync(socketPath) });
    await store.closeAfterDrain(); lock.release();
    return;
  }
  send({ type: "recovered", snapshot: await store.admission.run(() => snapshot()), listening: existsSync(socketPath) });
  const events = { invalidations: 0 };
  const runtime: AuthenticationProviderRuntime = await loadAuthenticationProvider({
    entry: boot.provider!, providerId: "better-auth", storage: store.authenticationProviderStorage(),
    unreleasedSessions: boot.unreleasedSessions, ...policy,
    options: { baseURL: `${ORIGIN}/api/auth`, secret: secrets.secret, clientIpHeader: IP_HEADER, factors: { rpId: "controller.test", rpName: "Worktree Control proof", limits: LIMITS },
      ...(boot.fault === "poison" ? { faultInjection: { sqlFault: { sql: /^(commit|rollback)$/i, when: "before", remaining: 2, afterSql: /^insert into "authentication_ba_session"/i } } } : {}) } as Parameters<typeof loadAuthenticationProvider>[0]["options"],
    onInvalidation: () => { events.invalidations++; },
  });
  if (seeding) {
    await runtime.provisionLocal({ principalId: ownerSession!.principalId, email: secrets.email, name: "Owner", password: secrets.password, actor: "fixture" });
    await store.admission.run(() => { new AuthenticationService(store).setMode("open", "local-cli"); });
  }
  const authentication = await store.admission.run(() => new AuthenticationService(store));
  let maintenance = false;
  const { identity: composed, browserAuthentication } = composeIsolatedBrowserAuthentication({ store, authentication, origin: ORIGIN, runtime, admission: store.admission,
    trustedFixturePeer: "198.18.0.1", maintenance: () => maintenance, limits: TRANSPORT, maxInFlight: 8 });
  const released: Array<() => void> = [];
  const finish = runtime.finishBrowserRelease.bind(runtime), browser = runtime.browser.bind(runtime);
  runtime.finishBrowserRelease = release => {
    if (cut?.kind === "before-publication" && release.outcome !== "challenge") hold(cut.point);
    const body = finish(release);
    if (cut?.kind === "after-publication" && release.outcome !== "challenge") hold(cut.point);
    if (cut?.kind === "after-write" && release.outcome !== "challenge") {
      // The caller writes synchronously after this returns. Its handler then waits below, unfinished.
      const point = cut.point;
      setImmediate(() => { send({ type: "cut", point, snapshot: snapshot() }); });
    }
    return body;
  };
  runtime.browser = (operation, request, options) => {
    const lifetime = browser(operation, request, options);
    if (cut?.kind === "after-write" && operation !== "session") {
      return { result: lifetime.result, settled: lifetime.settled.then(() => new Promise<void>(() => undefined)) };
    }
    if (cut?.kind === "held-result" && operation === "sign-in") {
      const held = lifetime.result.then(async value => { send({ type: "held", snapshot: await store.admission.run(() => snapshot()) }); await new Promise<void>(open => { released.push(open); }); return value; });
      held.catch(() => undefined);
      return { result: held, settled: lifetime.settled };
    }
    return lifetime;
  };
  const service = { dashboard: () => { throw new Error("unconverted provider route reached installation authority"); } } as unknown as ControlService;
  const http = createControllerServer({ service, identity: composed, authentication, admission: store.admission, browserAuthentication, directoryBrowser: {} as DirectoryBrowser,
    events: new EventStream(store.admission), mcpStatus: () => ({ phase: "disabled" as const, endpoint: null, transport: "streamable-http" as const, network: "loopback" as const, authentication: "bearer" as const, activeSessions: 0 }),
    webRoot: boot.root, host: "127.0.0.1", port: 0, accessToken: "fixture" });
  await new Promise<void>((resolve, reject) => { http.server.once("error", reject); http.server.listen(socketPath, resolve); });
  const shutdown = createControllerShutdown({ service: { closeAdmission: () => { maintenance = true; }, shutdown: () => store.closeAfterDrain() },
    stopping: () => undefined, userSchedules: undefined, backups: { close() {} }, remoteVerification: null, mcp: null, controller: http, adminSocket: { close() {} },
    authenticationProvider: runtime, removeServiceAccess: () => undefined, controllerLock: lock });
  process.on("message", (message: { command: string; cut?: Cut; backup?: string }) => {
    void (async () => {
      try {
        if (message.command === "arm") { cut = message.cut; seen = 0; armed = cut?.kind !== "sql" || !cut.armedBy; send({ type: "armed" }); }
        else if (message.command === "snapshot") send({ type: "snapshot", snapshot: await store.admission.run(() => snapshot()) });
        else if (message.command === "release-held") { for (const open of released.splice(0)) open(); send({ type: "released" }); }
        else if (message.command === "backup") { await store.admission.run(() => createControllerBackup(store, message.backup!, { applicationVersion: "0.0.0-session-restart", attachmentDirectory })); send({ type: "backed-up" }); }
        else if (message.command === "shutdown") { await shutdown(); send({ type: "closed", invalidations: events.invalidations }); process.disconnect?.(); }
      } catch { send({ type: "command-failed", command: message.command }); }
    })();
  });
  send({ type: "ready", socketPath, invalidations: events.invalidations });
}

const modes = { challenger, "seed-v40": seedSchema40, restore, owner, seed: owner };
Promise.resolve().then(() => modes[boot.mode]()).then(() => undefined, () => { send({ type: "failed", mode: boot.mode }); process.exitCode = 1; });
