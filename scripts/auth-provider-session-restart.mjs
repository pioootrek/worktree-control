import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupRestartFixture, trackFixtureChild } from "./auth-provider-restart-cleanup.mjs";

// Finite private proof. Real owner processes over one retained installation: built
// from shared composition, killed only through their own ChildProcess handle after
// an identity handshake, and reopened by the normal owner path. Software TOTP and
// passkey over a Unix socket with a trusted test peer. No browser, hardware, TLS,
// proxy or service restart is covered, and nothing here is installed anywhere.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "session-restart-"));
const workerSource = "packages/auth-provider-better-auth-proof/test/fixtures/session-restart-worker.ts";
const authenticatorSource = "packages/auth-provider-better-auth-proof/test/passkey-authenticator.ts";
/** Fixture inputs named in the accepted contract. They approve no deployment policy. */
const BOUNDS = { unreleasedSessions: 2, sessionRows: 4, sessionReconcileBatch: 1 };
const LIMIT_OUTPUT = 65_536, BOOT_MS = 30_000, STEP_MS = 31_000, HOUR_MS = 3_600_000;
const SECRET = randomBytes(32).toString("hex"), PASSWORD = `restart-password-${randomBytes(12).toString("hex")}`, EMAIL = "owner@fixture.invalid";
const ORIGIN = "https://controller.test";
const SESSION_COOKIE = "__Secure-wtc.session_token";
const children = new Map();
const output = [], cookiesSeen = new Set();
const counts = { boots: 0, killed: 0, graceful: 0 };
const cases = [];
const record = (id, evidence) => { cases.push({ id, ...evidence }); };

function run(args, label) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  trackFixtureChild(children, child);
  let text = "";
  const collect = bytes => { if (text.length < LIMIT_OUTPUT) text += bytes; };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${label} timed out.`)); }, 120_000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); children.delete(child); if (code === 0) accept(); else reject(new Error(`${label} failed: ${text.slice(-2000)}`)); });
  });
}
async function emit() {
  const emitted = join(temporary, "worker"), provider = join(temporary, "provider");
  mkdirSync(emitted, { mode: 0o700 }); mkdirSync(provider, { mode: 0o700 });
  for (const [directory, modules] of [[emitted, "node_modules"], [provider, "packages/auth-provider-better-auth-proof/node_modules"]]) {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    symlinkSync(join(root, modules), join(directory, "node_modules"), "dir");
  }
  const tsup = ["node_modules/tsup/dist/cli-default.js", "--format", "esm", "--platform", "node", "--target", "node22"];
  await run([...tsup, workerSource, authenticatorSource, "--out-dir", emitted, "--external", "better-sqlite3"], "worker build");
  await run([...tsup, "packages/auth-provider-better-auth-proof/src/index.ts", "--out-dir", provider,
    "--external", "better-auth", "--external", "@better-auth/core", "--external", "kysely", "--external", "@better-auth/passkey", "--external", "@better-auth/utils"], "provider build");
  const worker = join(emitted, "fixtures/session-restart-worker.js"), authenticator = join(emitted, "passkey-authenticator.js"), entry = join(provider, "index.js");
  const sha = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  return { worker, authenticator, entry, hashes: { workerSha256: sha(worker), providerSha256: sha(entry), authenticatorSha256: sha(authenticator) } };
}

/** One spawned process. Its identity comes from the handshake, never from a lock file. */
class Process {
  constructor(boot, workerPath) {
    this.nonce = randomUUID();
    this.boot = { ...boot, nonce: this.nonce };
    this.child = spawn(process.execPath, [workerPath, JSON.stringify(this.boot)], { cwd: temporary, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    assert(!this.child.spawnargs.some(value => value.includes(PASSWORD) || value.includes(SECRET)), "secrets never reach argv");
    this.exited = trackFixtureChild(children, this.child);
    this.messages = []; this.waiting = [];
    this.pid = this.child.pid;
    for (const stream of [this.child.stdout, this.child.stderr]) stream.on("data", bytes => {
      const text = String(bytes);
      output.push(text.slice(0, 4096));
      if (output.join("").length > LIMIT_OUTPUT) { this.child.kill("SIGKILL"); throw new Error("Fixture output exceeded its bound."); }
    });
    this.child.on("message", message => {
      assert.equal(message.nonce, this.nonce); assert.equal(message.pid, this.child.pid);
      this.confirmed = true;
      this.messages.push(message);
      for (const waiter of [...this.waiting]) if (waiter.match(message)) { this.waiting.splice(this.waiting.indexOf(waiter), 1); waiter.accept(message); }
    });
    this.child.once("error", () => undefined);
  }
  waitFor(...types) {
    const found = this.messages.find(message => types.includes(message.type));
    if (found) { this.messages.splice(this.messages.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture process did not report ${types.join("/")}: ${output.join("").slice(-1500)}`)), BOOT_MS);
      const waiter = { match: message => types.includes(message.type), accept: message => { clearTimeout(timer); this.messages.splice(this.messages.indexOf(message), 1); accept(message); } };
      this.waiting.push(waiter);
      this.exited.then(() => { if (this.waiting.includes(waiter) && !this.messages.some(waiter.match)) { clearTimeout(timer); reject(new Error(`Fixture process exited before ${types.join("/")}: ${output.join("").slice(-1500)}`)); } });
    });
  }
  async command(message, reply) { this.child.send(message); return this.waitFor(reply); }
  async arm(cut) { await this.command({ command: "arm", cut }, "armed"); }
  async snapshot() { return (await this.command({ command: "snapshot" }, "snapshot")).snapshot; }
  /** Only this confirmed child, by handle, and only while it is still that child. */
  async kill() {
    assert(this.confirmed, "a process is signalled only after its identity handshake");
    assert.equal(this.child.exitCode, null);
    assert(this.child.kill("SIGKILL"));
    const result = await this.exited;
    assert.equal(result.signal, "SIGKILL");
    counts.killed++;
  }
  async shutdown() {
    await this.command({ command: "shutdown" }, "closed");
    const result = await this.exited;
    assert.deepEqual(result, { code: 0, signal: null });
    counts.graceful++;
  }
}

class Jar {
  cookies = new Map();
  constructor(socketPath) { this.socketPath = socketPath; }
  retarget(socketPath) { this.socketPath = socketPath; return this; }
  call(path, { method = "POST", body } = {}) {
    return new Promise((accept, reject) => {
      const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const headers = { host: "controller.test", "content-type": "application/json", connection: "close", origin: ORIGIN, ...(cookie ? { cookie } : {}) };
      const call = httpRequest({ socketPath: this.socketPath, path: `/api/auth/${path}`, method, headers }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          for (const line of response.headers["set-cookie"] ?? []) {
            const pair = line.split(";")[0], index = pair.indexOf("="), name = pair.slice(0, index), value = pair.slice(index + 1);
            if (!value || /max-age=0/i.test(line)) this.cookies.delete(name); else { this.cookies.set(name, value); cookiesSeen.add(value); }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          accept({ status: response.statusCode, body: text ? JSON.parse(text) : {}, cookies: response.headers["set-cookie"] ?? [] });
        });
      });
      call.on("error", reject);
      call.end(body === undefined ? "" : JSON.stringify(body));
    });
  }
  login(password = PASSWORD) { return this.call("sign-in/email", { body: { email: EMAIL, password } }); }
  session() { return this.call("get-session", { method: "GET" }); }
}
async function until(read) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value) return value;
    assert(Date.now() < deadline, "Bounded wait expired.");
    await pause(25);
  }
}
const dropped = pending => pending.then(result => result, () => ({ dropped: true }));
const noCookie = result => { assert.deepEqual((result.cookies ?? []).filter(line => !/max-age=0/i.test(line)), []); };

function base32(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", bits = [...text.replace(/=+$/, "")].map(character => alphabet.indexOf(character).toString(2).padStart(5, "0")).join("");
  return Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
}
function totp(uri, now) {
  const secret = new URL(uri.replace("otpauth://", "http://")).searchParams.get("secret");
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac("sha1", base32(secret)).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function installation(name, bounds, secrets = {}) {
  const directory = join(temporary, name);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "private.json"), JSON.stringify({ secret: SECRET, password: PASSWORD, email: EMAIL, ...secrets }), { mode: 0o600 });
  return { root: directory, bounds, clockOffsetMs: 0, socketPath: join(directory, "s.sock") };
}
const locks = inst => [join(inst.root, "state/controller.lock"), join(inst.root, "data/state.sqlite3.owner.lock")];
const lockPid = path => JSON.parse(readFileSync(path, "utf8")).pid;

function start(emitted, inst, mode = "owner", extra = {}) {
  inst.clockOffsetMs += STEP_MS;
  counts.boots++;
  return new Process({ root: inst.root, mode, clockOffsetMs: inst.clockOffsetMs, provider: emitted.entry, ...inst.bounds, ...extra }, emitted.worker);
}
async function owner(emitted, inst, mode = "owner", extra = {}) {
  const worker = start(emitted, inst, mode, extra);
  worker.opened = (await worker.waitFor("opened")).snapshot;
  worker.recovered = (await worker.waitFor("recovered")).snapshot;
  await worker.waitFor("ready");
  // The normal path replaced any stale record. Nothing here removed a lock.
  for (const path of locks(inst)) assert.equal(lockPid(path), worker.pid);
  return worker;
}
async function offline(emitted, inst, mode, extra = {}) {
  const worker = start(emitted, inst, mode, extra);
  const done = await worker.waitFor("done");
  assert.deepEqual(await worker.exited, { code: 0, signal: null });
  return done;
}
/** A real challenger process against the live owner, while that owner is stopped at its cut. */
async function challenge(emitted, inst) {
  const worker = start(emitted, inst, "challenger");
  const { controller, database } = await worker.waitFor("challenge");
  await worker.exited;
  assert.deepEqual({ controller, database }, { controller: "refused", database: "refused" });
}
function staleLocks(inst, pid) {
  for (const path of locks(inst)) { assert(existsSync(path), "a killed owner leaves its lock"); assert.equal(lockPid(path), pid); }
}
const CUT = {
  beforePublication: { kind: "before-publication", point: "after-native-commit-before-publication" },
  afterPublication: { kind: "after-publication", point: "after-marker-commit-before-write" },
  afterWrite: { kind: "after-write", point: "after-write-before-handler-completion" },
  heldResult: { kind: "held-result", point: "held-result" },
  beforeEvidence: { kind: "sql", point: "native-insert-before-evidence", at: "^INSERT INTO authentication_session_evidence", when: "before" },
  beforeMarker: { kind: "sql", point: "evidence-before-marker", at: "^INSERT INTO authentication_session_issuance", when: "before" },
  beforeCommit: { kind: "sql", point: "before-native-commit", armedBy: '^insert into "authentication_ba_session"', at: "^commit$", when: "before" },
  afterCommit: { kind: "sql", point: "after-native-commit-before-acknowledgment", armedBy: '^insert into "authentication_ba_session"', at: "^commit$", when: "after" },
  insideMark: { kind: "sql", point: "inside-uncommitted-publication", at: "^UPDATE authentication_session_issuance", when: "after" },
  lostAcknowledgment: { kind: "sql", point: "commit-acknowledgment-lost", armedBy: '^insert into "authentication_ba_session"', at: "^commit$", when: "after", effect: "throw" },
  recoveryBatch: { kind: "sql", point: "inside-recovery-batch", at: '^DELETE FROM "authentication_ba_session"', when: "after" },
  betweenBatches: { kind: "sql", point: "between-recovery-batches", at: '^DELETE FROM "authentication_ba_session"', when: "before", nth: 2 },
};

/** Stops a live owner at a cut, proves the locks, kills it and leaves stale locks for the next boot. */
async function crashAt(emitted, inst, worker, cut, act, { contested = false } = {}) {
  await worker.arm(cut);
  const pending = dropped(act());
  const message = await worker.waitFor("cut");
  assert.equal(message.point, cut.point);
  if (contested) await challenge(emitted, inst);
  await worker.kill();
  staleLocks(inst, worker.pid);
  return { held: message.snapshot, response: await pending };
}
const added = (after, before) => after.filter(id => !before.includes(id));
const without = (snapshot, ...keys) => { const copy = structuredClone(snapshot); for (const key of keys) delete copy[key]; return copy; };

/** R1, R2, R7: the session is exactly what disappears, and nothing else moves. */
async function pendingCycles(emitted, inst, first, label, times, { prepare, act, expect }) {
  let worker = first;
  const ids = [];
  for (let index = 0; index < times; index++) {
    const context = await prepare?.(worker, index);
    const before = await worker.snapshot();
    const { held, response } = await crashAt(emitted, inst, worker, CUT.beforePublication, () => act(worker, context), { contested: index === 0 });
    assert.equal(response.dropped, true, "no response leaves before publication");
    const [id, ...rest] = added(held.pending, before.pending);
    assert.equal(rest.length, 0); assert(id, `${label} left a pending session`);
    assert(held.sessions.includes(id) && held.evidence.some(row => row.id === id));
    worker = await owner(emitted, inst);
    // The fresh owner found the committed triple, then removed exactly that row.
    assert(worker.opened.pending.includes(id));
    assert(!worker.recovered.sessions.includes(id) && !worker.recovered.evidence.some(row => row.id === id) && !worker.recovered.issuance.some(row => row.id === id));
    assert.deepEqual(worker.recovered.sessions, worker.opened.sessions.filter(value => value !== id));
    await expect?.(worker, { before, held, id, context });
    ids.push(id);
  }
  record(`${label}-pending`, { cycles: times, distinctSessions: new Set(ids).size, sessionsAfter: worker.recovered.sessions.length, issuanceAfter: worker.recovered.issuance.length });
  return worker;
}

async function writers(emitted) {
  const { PasskeyAuthenticator } = await import(pathToFileURL(emitted.authenticator).href);
  const inst = installation("writers", BOUNDS);
  let worker = await owner(emitted, inst, "seed"), password = PASSWORD;
  const jar = () => new Jar(inst.socketPath);
  const kept = jar();
  assert.equal((await kept.login()).status, 200);
  const unrelated = (await worker.snapshot()).sessions;
  assert.equal(unrelated.length, 1);
  const samePlainState = (now, before) => assert.deepEqual(without(now, "pending"), without(before, "pending"));

  // R1 + R2: plain password, more than B times with fresh PIDs.
  worker = await pendingCycles(emitted, inst, worker, "plain-password", BOUNDS.sessionRows + 2, {
    act: () => jar().login(),
    expect: (next, { before }) => { samePlainState(next.recovered, before); },
  });

  // R5: transactions the process died inside. SQLite's own recovery decides, no fixture rows.
  for (const cut of [CUT.beforeEvidence, CUT.beforeMarker, CUT.beforeCommit]) {
    const before = await worker.snapshot();
    const { response } = await crashAt(emitted, inst, worker, cut, () => jar().login());
    assert.equal(response.dropped, true);
    worker = await owner(emitted, inst);
    samePlainState(worker.opened, before);
    record(`mint-${cut.point}`, { rowsAfterFreshOpen: worker.opened.sessions.length, markers: worker.opened.issuance.length });
  }
  {
    const before = await worker.snapshot();
    const { held, response } = await crashAt(emitted, inst, worker, CUT.insideMark, () => jar().login());
    assert.equal(response.dropped, true);
    const [id] = added(held.sessions, before.sessions);
    assert.equal(held.issuance.find(row => row.id === id).state, "may_publish", "the cut really is after the UPDATE, inside its transaction");
    worker = await owner(emitted, inst);
    assert.equal(worker.opened.issuance.find(row => row.id === id).state, "pending", "SQLite rolled the marker back");
    samePlainState(worker.recovered, before);
    record("publication-before-commit", { uncommitted: "may_publish", afterCrash: "pending", cleaned: true });
  }
  {
    const before = await worker.snapshot();
    const { held } = await crashAt(emitted, inst, worker, CUT.afterCommit, () => jar().login());
    const [id] = added(held.pending, before.pending);
    worker = await owner(emitted, inst);
    assert(worker.opened.pending.includes(id));
    samePlainState(worker.recovered, before);
    record("native-commit-before-acknowledgment", { pendingFound: true, cleaned: true });
  }
  // R6: the same acknowledgment lost while the process lives, then killed: a known commit, no cookie.
  {
    const before = await worker.snapshot();
    await worker.arm(CUT.lostAcknowledgment);
    const refused = await jar().login();
    assert.equal(refused.status, 503); assert.equal(refused.body.code, "completion_unconfirmed"); noCookie(refused);
    // Cleanup ends after the answer: the slot waits for it, the client does not.
    const cleaned = await until(async () => { const now = await worker.snapshot(); return now.pending.length === 0 ? now : null; });
    samePlainState(cleaned, before);
    await worker.kill();
    worker = await owner(emitted, inst);
    samePlainState(worker.opened, before);
    record("lost-acknowledgment-live", { status: refused.status, cleanedLive: true });
  }
  // R6: a failed COMMIT whose ROLLBACK also fails poisons the owner. Only a fresh owner can classify it.
  {
    const before = await worker.snapshot();
    await worker.shutdown();
    worker = await owner(emitted, inst, "owner", { fault: "poison" });
    const refused = await jar().login();
    assert.equal(refused.status, 503); noCookie(refused);
    await worker.kill();
    staleLocks(inst, worker.pid);
    worker = await owner(emitted, inst);
    samePlainState(worker.opened, before);
    record("poisoned-owner", { status: refused.status, code: refused.body.code, freshOwnerRows: worker.opened.sessions.length });
  }

  // R2 + R7: password replacement. The new password and the revocation stay. Only the new session goes.
  worker = await pendingCycles(emitted, inst, worker, "password-replacement", BOUNDS.sessionRows + 2, {
    prepare: async (_, index) => {
      const client = jar();
      assert.equal((await client.login(password)).status, 200);
      return { client, next: `restart-replacement-${index}-${randomBytes(8).toString("hex")}`, was: password };
    },
    act: (_, { client, was, next }) => client.call("change-password", { body: { currentPassword: was, newPassword: next } }),
    expect: async (next, { before, context }) => {
      assert.notDeepEqual(next.recovered.password, before.password, "the committed password stays");
      assert.deepEqual(next.recovered.sessions, [], "revoked sessions stay revoked and the unreleased one is gone");
      assert.deepEqual((await context.client.session()).body, { authenticated: false });
      assert.equal((await jar().login(context.was)).status, 401);
      password = context.next;
      assert.equal((await jar().login(password)).status, 200);
    },
  });
  // Each replacement cycle's follow-up login leaves one session. The next replacement revokes it, so reset by revocation here.
  const reset = jar();
  assert.equal((await reset.login(password)).status, 200);
  const fresh = `restart-reset-${randomBytes(8).toString("hex")}`;
  assert.equal((await reset.call("change-password", { body: { currentPassword: password, newPassword: fresh } })).status, 200);
  password = fresh;

  // R4: the parent really holds this cookie when the owner dies, before its handler finished.
  const received = jar();
  const before = await worker.snapshot();
  await worker.arm(CUT.afterWrite);
  const pendingResponse = dropped(received.login(password));
  const message = await worker.waitFor("cut");
  assert.equal(message.point, CUT.afterWrite.point);
  const held = message.snapshot;
  let receiptTimer;
  try {
    const response = await Promise.race([
      pendingResponse,
      new Promise((_, reject) => { receiptTimer = setTimeout(() => reject(new Error("Client did not receive the response before the crash.")), BOOT_MS); }),
    ]);
    assert.equal(response.status, 200);
    assert(received.cookies.has(SESSION_COOKIE), "the parent received the cookie first");
    assert.equal(worker.child.exitCode, null);
    assert.equal(worker.child.signalCode, null);
    await challenge(emitted, inst);
    await worker.kill();
    staleLocks(inst, worker.pid);
  } finally { clearTimeout(receiptTimer); }
  const [receivedId] = added(held.sessions, before.sessions);
  const receivedDeadline = held.issuance.find(row => row.id === receivedId).deadline;
  assert.equal(held.issuance.find(row => row.id === receivedId).state, "may_publish");
  worker = await owner(emitted, inst);
  assert(worker.recovered.sessions.includes(receivedId), "a possibly received session survives");
  const current = await received.retarget(inst.socketPath).session();
  assert.equal(current.body.authenticated, true); assert.equal(current.body.expiresAt, receivedDeadline);
  assert.equal(worker.recovered.issuance.find(row => row.id === receivedId).deadline, receivedDeadline);
  record("cookie-received-before-kill", { authenticatedAfterRestart: true, deadlineUnchanged: true, unrelatedKept: worker.recovered.sessions.includes(before.sessions[0]) });

  // R3: marked, nothing written, killed. Every boot keeps counting them, until the next issuer is refused.
  const retained = [receivedId];
  while ((await worker.snapshot()).sessions.length < BOUNDS.sessionRows) {
    const prior = await worker.snapshot();
    const crash = await crashAt(emitted, inst, worker, CUT.afterPublication, () => jar().login(password));
    assert.equal(crash.response.dropped, true, "nothing was written");
    const [id] = added(crash.held.sessions, prior.sessions);
    assert.equal(crash.held.issuance.find(row => row.id === id).state, "may_publish");
    worker = await owner(emitted, inst);
    assert(worker.recovered.sessions.includes(id), "may_publish survives an ordinary restart");
    retained.push(id);
  }
  const full = await worker.snapshot();
  const refused = await jar().login(password);
  assert.equal(refused.status, 503); assert.equal(refused.body.code, "database_busy"); noCookie(refused);
  const replacement = await received.call("change-password", { body: { currentPassword: password, newPassword: `restart-refused-${randomBytes(8).toString("hex")}` } });
  assert.equal(replacement.status, 503); noCookie(replacement);
  assert.deepEqual(without(await worker.snapshot(), "pending"), without(full, "pending"), "no native mint and no password write");
  for (let index = 0; index < 2; index++) {
    await worker.kill();
    worker = await owner(emitted, inst);
    assert.deepEqual(worker.recovered.sessions, full.sessions);
    const again = await jar().login(password);
    assert.equal(again.status, 503); noCookie(again);
  }
  record("may-publish-saturates-across-boots", { rows: full.sessions.length, bound: BOUNDS.sessionRows, refusedAcrossBoots: 3, replacementRefused: true });

  // R10: one private clock, moved only between boots, against deadlines stored on earlier boots.
  const deadlines = full.issuance.map(row => Date.parse(row.deadline)).sort((a, b) => a - b);
  await worker.kill();
  inst.clockOffsetMs = deadlines[0] - Date.now() - 2 * 60_000 - STEP_MS;
  worker = await owner(emitted, inst);
  assert.deepEqual(worker.recovered.sessions, full.sessions, "nothing expires before its original deadline");
  await worker.kill();
  inst.clockOffsetMs = deadlines.at(-1) - Date.now() + HOUR_MS / 60;
  worker = await owner(emitted, inst);
  assert.deepEqual(worker.recovered.sessions, [], "all expired rows pruned at boot, one per batch");
  assert.deepEqual(worker.recovered.issuance, []);
  assert.equal(worker.opened.sessions.length, BOUNDS.sessionRows);
  assert.equal((await jar().login(password)).status, 200);
  record("expiry-private-clock", { survivedBeforeDeadline: true, prunedAtDeadline: BOUNDS.sessionRows, batch: BOUNDS.sessionReconcileBatch, roomFreed: true });

  // R9: two held flights at U, killed. Q=1 recovery killed inside and between batches, then resumed.
  {
    const standing = await worker.snapshot();
    await worker.arm(CUT.heldResult);
    const logins = [jar(), jar()].map(client => dropped(client.login(password)));
    const heldStates = [(await worker.waitFor("held")).snapshot, (await worker.waitFor("held")).snapshot];
    assert.equal(heldStates[1].pending.length, 2);
    const third = await jar().login(password);
    assert.equal(third.status, 503, "U refuses a third issuer while B still has room");
    assert.equal((await worker.snapshot()).pending.length, 2);
    await worker.kill();
    await Promise.all(logins);
    const inside = start(emitted, inst, "owner", { cut: CUT.recoveryBatch });
    assert.equal((await inside.waitFor("opened")).snapshot.pending.length, 2);
    await inside.waitFor("cut");
    assert(!existsSync(inst.socketPath), "no issuer can reach an owner still recovering");
    await inside.kill();
    const between = start(emitted, inst, "owner", { cut: CUT.betweenBatches });
    assert.equal((await between.waitFor("opened")).snapshot.pending.length, 2, "the killed batch rolled back");
    await between.waitFor("cut");
    await between.kill();
    worker = start(emitted, inst);
    assert.equal((await worker.waitFor("opened")).snapshot.pending.length, 1, "the committed batch stayed");
    worker.recovered = (await worker.waitFor("recovered")).snapshot;
    await worker.waitFor("ready");
    assert.deepEqual(worker.recovered.pending, []);
    assert.deepEqual(worker.recovered.sessions, standing.sessions);
    record("recovery-batches", { heldPending: 2, afterKillInside: 2, afterKillBetween: 1, resumed: 0, batch: BOUNDS.sessionReconcileBatch, thirdIssuerRefused: true });
  }

  // Selection replaces every prior session, so start the factor writers from real enrollment.
  const enrollee = jar();
  if (!(await enrollee.session()).body.authenticated) assert.equal((await enrollee.login(password)).status, 200);
  const started = await enrollee.call("two-factor/enable", { body: { password } });
  assert.equal(started.status, 200);
  const uri = started.body.totpURI;
  const now = () => Date.now() + inst.clockOffsetMs;
  assert.equal((await enrollee.call("two-factor/verify-totp", { body: { code: totp(uri, now()) } })).body.outcome, "enrolled");
  await worker.kill();
  worker = await owner(emitted, inst);
  const stable = snapshot => without(snapshot, "pending", "step", "receipts", "charges");

  // R2 + R7: TOTP. The step and the charge stay committed. The code cannot be replayed.
  worker = await pendingCycles(emitted, inst, worker, "totp-login", BOUNDS.sessionRows + 2, {
    prepare: async () => {
      const client = jar();
      assert.equal((await client.login(password)).body.outcome, "challenge");
      return { client, code: totp(uri, now()) };
    },
    act: (_, { client, code }) => client.call("two-factor/verify-totp", { body: { code } }),
    expect: async (next, { before, held, context }) => {
      assert.deepEqual(stable(next.recovered), stable(before));
      assert.equal(next.recovered.step, held.step); assert(held.step > (before.step ?? 0), "the step advanced");
      assert.deepEqual(next.recovered.receipts, held.receipts);
      const replay = await context.client.retarget(inst.socketPath).call("two-factor/verify-totp", { body: { code: context.code } });
      assert(replay.status >= 400); noCookie(replay);
    },
  });

  // R2 + R7: passkey, alongside TOTP as an alternative.
  const enrolling = jar(), authenticator = new PasskeyAuthenticator();
  assert.equal((await enrolling.login(password)).body.outcome, "challenge");
  assert.equal((await enrolling.call("two-factor/verify-totp", { body: { code: totp(uri, now()) } })).status, 200);
  const options = async (client, kind) => (await client.call(`passkey/generate-${kind}-options`, { method: "GET" })).body.options;
  const registered = await enrolling.call("passkey/verify-registration", { body: { response: authenticator.register(await options(enrolling, "register"), { attestationNone: true }) } });
  assert.equal(registered.body.outcome, "staged");
  const confirmed = await enrolling.call("passkey/verify-confirmation", { body: { response: authenticator.assert(await options(enrolling, "confirm"), { counter: 0 }) } });
  assert.equal(confirmed.body.outcome, "enrolled");
  await worker.kill();
  worker = await owner(emitted, inst);
  worker = await pendingCycles(emitted, inst, worker, "passkey-login", BOUNDS.sessionRows + 2, {
    prepare: async () => {
      const client = jar();
      return { client, response: authenticator.assert(await options(client, "authenticate")) };
    },
    act: (_, { client, response }) => client.call("passkey/verify-authentication", { body: { response } }),
    expect: (next, { before, held }) => {
      assert.deepEqual(without(next.recovered, "pending", "counter", "receipts", "charges"), without(before, "pending", "counter", "receipts", "charges"));
      assert.equal(next.recovered.counter, held.counter); assert(held.counter > (before.counter ?? 0), "the counter advanced");
      assert.deepEqual(next.recovered.receipts, held.receipts);
    },
  });

  // Orderly shutdown of an owner holding valid may_publish sessions is a clean handoff.
  const last = jar();
  assert.equal((await last.login(password)).body.outcome, "challenge");
  assert.equal((await last.call("two-factor/verify-totp", { body: { code: totp(uri, now()) } })).status, 200);
  const marked = await worker.snapshot();
  assert(marked.issuance.some(row => row.state === "may_publish"));
  await worker.shutdown();
  for (const path of locks(inst)) assert(!existsSync(path), "orderly shutdown releases both owners");
  worker = await owner(emitted, inst);
  assert.deepEqual(worker.recovered.issuance, marked.issuance);
  assert.equal((await last.session()).body.authenticated, true);
  await worker.shutdown();
  record("orderly-shutdown-retention", { retained: marked.issuance.length, exitCode: 0, sessionStillCurrent: true });
}

/** R12 + R13 with a genuine schema-40 row: restore refuses, and a later publication stays possible. */
async function restored(emitted) {
  const schema40 = join(root, "src/server/infrastructure/sqlite/fixtures/schema-v40.sql");
  const bounds = { ...BOUNDS, sessionRows: 6 };
  const inst = installation("restored", bounds, { schema40 });
  await offline(emitted, inst, "seed-v40");
  const premigration = join(inst.root, "premigration");
  mkdirSync(premigration, { mode: 0o700 });
  let worker = await owner(emitted, inst, "seed", { backup: premigration });
  assert(worker.opened.sessions.includes("legacy-unmarked"), "the upgrade preserved the expired unmarked row");
  assert.deepEqual(worker.opened.issuance, [], "nothing was backfilled");
  assert(worker.recovered.sessions.includes("legacy-unmarked"), "recovery and expiry never touch an unmarked row");
  const released = new Jar(inst.socketPath), later = new Jar(inst.socketPath);
  assert.equal((await released.login()).status, 200);
  await worker.arm(CUT.heldResult);
  const pendingLogin = later.login();
  const { snapshot: atBackup } = await worker.waitFor("held");
  assert.equal(atBackup.pending.length, 1);
  const snapshotDirectory = join(inst.root, "snapshot");
  await worker.command({ command: "backup", backup: snapshotDirectory }, "backed-up");
  await worker.arm(undefined);
  await worker.command({ command: "release-held" }, "released");
  assert.equal((await pendingLogin).status, 200, "this session was published after the snapshot");
  assert(later.cookies.has(SESSION_COOKIE));
  await worker.shutdown();
  await offline(emitted, inst, "restore", { backup: snapshotDirectory });

  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = start(emitted, inst);
    const opened = await refused.waitFor("opened");
    assert.equal(opened.provenance, "restored");
    assert.deepEqual(opened.snapshot.issuance, atBackup.issuance);
    assert.deepEqual(opened.snapshot.sessions, atBackup.sessions);
    const { snapshot, listening: bound } = await refused.waitFor("refused");
    assert.deepEqual(snapshot, opened.snapshot, "the refusal changed nothing, including the pending snapshot row");
    assert.equal(bound, false);
    assert.deepEqual(await refused.exited, { code: 0, signal: null });
  }
  record("restored-snapshot-refused", { pending: atBackup.pending.length, publishedAfterSnapshot: true, unmarkedKept: true, refusedBoots: 2, rowsChanged: 0 });
}

let primaryFailure;
try {
  const emitted = await emit();
  await writers(emitted);
  await restored(emitted);
  // One line per record: a run log keeps whole lines, and evidence must not end mid-case.
  const report = [...cases.map(entry => JSON.stringify(entry)), JSON.stringify({ result: "passed", source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).length > 0, ...emitted.hashes, bounds: BOUNDS, ...counts, cases: cases.length })];
  const everything = `${output.join("")}${report.join("")}`;
  for (const secret of [PASSWORD, SECRET, ...cookiesSeen]) assert(!everything.includes(secret), "no credential reaches a report or a process stream");
  console.log(report.join("\n"));
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  try {
    await cleanupRestartFixture(children, () => rmSync(temporary, { recursive: true, force: true }));
  } catch (cleanupFailure) {
    if (primaryFailure) throw new AggregateError([primaryFailure, cleanupFailure], "Fixture failed and cleanup was not successful.");
    throw cleanupFailure;
  }
}
