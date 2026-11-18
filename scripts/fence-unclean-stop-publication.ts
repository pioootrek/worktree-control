/** Observation only. All database effects are confined to a marked synthetic fixture. */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { TestRun } from "../src/shared/contracts";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const Database = require("better-sqlite3") as typeof import("better-sqlite3");
const [mode, inputRoot, operation = "bearer", phase = "pending", step = "write-temp", errno = "ENOSPC", persistence = "once"] = process.argv.slice(2);
const root = resolve(inputRoot ?? "");
const evidenceRoot = join(homedir(), ".local/state/worktree-control-auth-unification/fence-13e00db3");
if (!inputRoot || ![tmpdir(), join(evidenceRoot, "disk-fixtures")].some(base => root.startsWith(resolve(base) + sep))
  || !fs.existsSync(join(root, "synthetic-only"))) throw new Error("Requires a marked synthetic fixture in an approved test directory");
const path = join(root, "state.sqlite3"), witness = `${path}.security/witness.json`;
const original = { open: fs.openSync, write: fs.writeFileSync, fsync: fs.fsyncSync, close: fs.closeSync, rename: fs.renameSync };
let armed = false, pendingAt = 0n, commitAt = 0n, confirmedAt = 0n, commitSeen = false, fallback = false;
let publication: "pending" | "confirmed" = "pending", directoryReady = false;
let hits = 0;
const injections: Array<{ publication: string; step: string; code: string }> = [];
const descriptors = new Map<number, "temp" | "directory">();
const segments: Array<{ aMs: number; bMs: number; totalMs: number; aShare: number }> = [];
function fail(at: string) {
  const fallbackOpen = persistence === "fallback-open" && hits > 0 && at === "open-temp";
  if (mode !== "fault" || !armed || (at !== step && !fallbackOpen)
    || (publication !== phase && !(persistence === "all-publications" && hits) && !fallbackOpen)
    || (persistence === "once" && hits)) return;
  hits++;
  injections.push({ publication, step: at, code: errno });
  if (publication === "confirmed") fallback = true;
  throw Object.assign(new Error(`Synthetic ${errno} at ${publication}/${at}`), { code: errno });
}
fs.openSync = ((file, ...args) => {
  const name = String(file), temporary = dirname(name) === dirname(witness) && name.split(sep).at(-1)!.startsWith(".journal-");
  if (armed && temporary) {
    publication = commitSeen && !fallback ? "confirmed" : "pending";
    directoryReady = false;
    fail("open-temp");
  }
  const directory = armed && name === dirname(witness) && directoryReady;
  if (directory) fail("open-directory");
  const fd = original.open(file, ...args);
  if (armed && (temporary || directory)) descriptors.set(fd, temporary ? "temp" : "directory");
  return fd;
}) as typeof fs.openSync;
fs.writeFileSync = ((file, ...args) => {
  if (typeof file === "number" && descriptors.get(file) === "temp") fail("write-temp");
  return original.write(file, ...args);
}) as typeof fs.writeFileSync;
fs.fsyncSync = fd => {
  const kind = descriptors.get(fd);
  if (kind) fail(kind === "temp" ? "fsync-temp" : "fsync-directory");
  original.fsync(fd);
};
fs.closeSync = fd => {
  const kind = descriptors.get(fd);
  // Model a reported close failure after releasing the descriptor. No test-induced descriptor leaks.
  original.close(fd);
  descriptors.delete(fd);
  if (kind) fail(kind === "temp" ? "close-temp" : "close-directory");
};
fs.renameSync = (from, to) => {
  const isWitness = armed && String(to) === witness;
  const state = isWitness ? JSON.parse(fs.readFileSync(from, "utf8")).payload.state as "pending" | "confirmed" : undefined;
  if (state) { publication = state; fail("rename"); }
  original.rename(from, to);
  if (state) {
    const now = process.hrtime.bigint();
    directoryReady = true;
    if (state === "pending") pendingAt = now;
    else {
      confirmedAt = now;
      if (mode === "measure") {
        if (!commitAt || commitAt < pendingAt || confirmedAt < commitAt) throw new Error("Missing native commit-return timestamp");
        const aMs = Number(commitAt - pendingAt) / 1e6, bMs = Number(confirmedAt - commitAt) / 1e6;
        segments.push({ aMs, bMs, totalMs: aMs + bMs, aShare: aMs / (aMs + bMs) });
      }
    }
  }
};
syncBuiltinESMExports();
// The native Statement prototype sees COMMIT inside better-sqlite3's transaction
// wrapper as well as autocommit .run(). Timestamp immediately on native return,
// before ExclusiveSqliteConnection/SecurityFence can confirm the witness.
const scratch = new Database(":memory:");
const statementPrototype = Object.getPrototypeOf(scratch.prepare("SELECT 1")) as { run: (...args: unknown[]) => unknown };
const nativeRun = statementPrototype.run;
scratch.close();
statementPrototype.run = function(this: import("better-sqlite3").Statement, ...args: unknown[]) {
  const watched = armed && this.database.name === path;
  if (watched && mode === "commit-fail" && this.source === "COMMIT" && (!hits || persistence !== "once")) {
    hits++;
    injections.push({ publication: "sqlite", step: "before-native-COMMIT", code: "SQLITE_FULL" });
    throw new Database.SqliteError("Synthetic SQLITE_FULL before native COMMIT", "SQLITE_FULL");
  }
  const result = nativeRun.apply(this, args);
  if (watched && pendingAt && !this.database.inTransaction && (this.source === "COMMIT" || !this.readonly)) {
    commitAt = process.hrtime.bigint();
    commitSeen = true;
  }
  return result;
};
const { SqliteStateStore } = await import("../src/server/infrastructure/sqlite/sqlite-state-store");
const { SecurityFence } = await import("../src/server/infrastructure/sqlite/security-fence");
const { IdentityService } = await import("../src/server/modules/identity");
const { legacySourceEvidence } = await import("../src/server/test-source-attribution");
const emit = (value: unknown) => fs.writeSync(1, JSON.stringify(value) + "\n");
function errorRecord(error: unknown) {
  const e = error as Error & { code?: string; committed?: boolean };
  return { name: e.name, code: e.code ?? null, committed: e.committed === true, message: e.message };
}
function disk() {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const checkpoint = db.prepare("SELECT epoch FROM security_checkpoint").get() as { epoch: string };
    // Hash only the affected bookkeeping columns. Never serialize credentials or tokens.
    const row = operation === "bearer" ? db.prepare("SELECT last_used_at FROM principal_credentials ORDER BY id").all()
      : db.prepare("SELECT logs_json FROM test_runs WHERE id='run'").all();
    const payload = JSON.parse(fs.readFileSync(witness, "utf8")).payload;
    return { epoch: checkpoint.epoch, rowHash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
      witness: { state: payload.state as string, epoch: payload.epoch as string },
      temporaries: fs.readdirSync(dirname(witness)).filter(name => name !== "witness.json") };
  } finally { db.close(); }
}
if (mode === "inspect") {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  let inspect;
  try { SecurityFence.inspect(path, db, false); inspect = { accepted: true }; }
  catch (error) { inspect = { accepted: false, error: errorRecord(error) }; }
  finally { db.close(); }
  let openWhileOwnerAlive;
  try { const other = new SqliteStateStore(path); other.close(); openWhileOwnerAlive = { opened: true }; }
  catch (error) { openWhileOwnerAlive = { opened: false, error: errorRecord(error) }; }
  emit({ inspect, openWhileOwnerAlive });
} else if (mode === "open") {
  try { const store = new SqliteStateStore(path); store.close(); emit({ opened: true }); }
  catch (error) { emit({ opened: false, error: errorRecord(error) }); }
} else {
  const store = new SqliteStateStore(path);
  const project = store.addProject({ name: "Synthetic", repositoryPath: root, port: 3901, executable: "node", args: [] });
  let tick = 0;
  const identity = new IdentityService(store, () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000).toISOString());
  const owner = identity.bootstrapOwnerSession();
  const now = new Date().toISOString();
  const run: TestRun = { id: "run", projectId: project.id, worktreePath: root, worktreeHead: "a", worktreeBranch: "main", worktreeDirty: false,
    presetId: "node:test", presetName: "test", adapter: "node", actor: "fixture", phase: "queued", queuePosition: null,
    executable: "node", args: [], cwd: root, queuedAt: now, startedAt: null, finishedAt: null, exitCode: null, signal: null, error: null, logs: [],
    environmentMode: "clean", environmentProfile: "unit", inheritedServerProfile: null, environmentVariableNames: [], source: legacySourceEvidence() };
  store.saveTestRun(run);
  const write = (i: number) => operation === "bearer" ? identity.authenticateBearer(owner.token) : store.saveTestRun({ ...run, logs: [`iteration ${i}`] });
  const attempt = (i: number) => {
    pendingAt = 0n; commitAt = 0n; confirmedAt = 0n; commitSeen = false; fallback = false;
    try { write(i); return { success: true, error: null }; }
    catch (error) { return { success: false, error: errorRecord(error) }; }
  };
  const probe = (probeMode: string) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/fence-unclean-stop-publication.ts"), probeMode, root, operation], { encoding: "utf8", timeout: 30_000 });
    if (child.status !== 0 || child.stderr) throw new Error(`Probe failed: ${child.status}, ${child.stderr}`);
    return JSON.parse(child.stdout.trim());
  };
  if (mode === "measure") {
    armed = true;
    for (let i = 0; i < 220; i++) {
      const outcome = attempt(i);
      if (!outcome.success) throw new Error(JSON.stringify(outcome));
    }
    armed = false;
    const samples = segments.slice(20);
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { n: sorted.length, median: (sorted[99]! + sorted[100]!) / 2, p95: sorted[189]!, max: sorted.at(-1)!, mean: values.reduce((a, b) => a + b, 0) / values.length };
    };
    const sumA = samples.reduce((sum, value) => sum + value.aMs, 0), sumB = samples.reduce((sum, value) => sum + value.bMs, 0);
    emit({ measurement: operation, directory: root, filesystem: fs.statfsSync(root),
      aMs: stats(samples.map(s => s.aMs)), bMs: stats(samples.map(s => s.bMs)), totalMs: stats(samples.map(s => s.totalMs)),
      aShare: sumA / (sumA + sumB), bShare: sumB / (sumA + sumB), perSampleAShare: stats(samples.map(s => s.aShare)), samples });
    store.close();
  } else if (mode === "fault" || mode === "commit-fail") {
    const before = disk();
    armed = true;
    const first = attempt(0);
    armed = false;
    const after = disk();
    const newProcessAfterFailure = probe("inspect");
    const attempts = [{ outcome: first, disk: after }];
    if (persistence !== "once") {
      armed = true;
      for (let i = 1; i < 4; i++) {
        const outcome = attempt(i);
        armed = false;
        attempts.push({ outcome, disk: disk() });
        armed = true;
      }
      armed = false;
    }
    let read;
    try { store.getProject(project.id); read = { success: true, error: null }; }
    catch (error) { read = { success: false, error: errorRecord(error) }; }
    const retry = attempt(99), afterRetry = disk();
    const newProcessAfterRetry = probe("inspect");
    let close;
    try { store.close(); close = { success: true, error: null }; }
    catch (error) { close = { success: false, error: errorRecord(error) }; }
    const newProcessAfterClose = probe("open");
    emit({ operation, phase, step, errno, persistence, before, first, after, injections, attempts, read, retry, afterRetry,
      newProcessAfterFailure, newProcessAfterRetry, close, newProcessAfterClose });
  } else { store.close(); throw new Error(`Unknown mode: ${mode}`); }
}
