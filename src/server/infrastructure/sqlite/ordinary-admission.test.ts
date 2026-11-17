import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppPaths, type AppPaths } from "../../paths";
import { ownedFixtureDatabase, unmanagedFixtureDatabase } from "../../unmanaged-sqlite-fixture";
import { createControllerBackup, restoreControllerBackup } from "../../controller-backup";
import { acknowledgeRecoveredBackupHandoff, preflightSecurityRecoveryHandoff } from "../../modules/backups";
import { AuthenticationService } from "../../modules/authentication";
import { SqliteStateStore } from "./sqlite-state-store";
import { OwnedSqliteDatabase } from "./owned-database";
import { SecurityFence, securityFenceRoot } from "./security-fence";
import { maintainSqliteSecurityFence } from "./security-maintenance";
import { SUPPORTED_SCHEMA_VERSION } from "./migration-registry";
import { applySqliteUpgrade, inspectSqliteUpgrade, type UpgradeBackup } from "./upgrade-maintenance";
import { upgradePlanPath } from "./upgrade-plan";
import type { UpgradeError } from "./upgrade-contract";
import { assertOrdinaryAdmission } from "./ordinary-admission";
import { AccountGrantsQueries } from "./account-grants-queries";
import { createFencedAt49, createFencedDatabase, openStoreAt49, RELEASED_SCHEMA_VERSION } from "./fixtures/released-schema";
import { openRemoteRecoveryInspection } from "./remote-connection-inspection";
import { openControllerStore, openCurrentControllerStore } from "../../controller-storage";

/**
 * The ordinary-admission check. The first suites call the function directly on
 * an owner opened without it (ordinary ownership, read-only inspection
 * connection, ceiling at the target); the last one goes through every ordinary
 * entry point that mounts it (the store, both controller-storage factories and
 * the read-only remote recovery inspection), which run it inside
 * `OwnedSqliteDatabase` opened with `ordinary: true`. The CLI families are in
 * `src/cli/ordinary-admission.test.ts`.
 */
const TARGET = 52;
const HANDOFF = { preflight: (database: string) => { preflightSecurityRecoveryHandoff(database); }, acknowledge: acknowledgeRecoveredBackupHandoff };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const installationPaths = () => { const root = mkdtempSync(join(tmpdir(), "ordinary-admission-")); roots.push(root); return resolveAppPaths(join(root, "data")); };
const canonical = (paths: AppPaths) => join(realpathSync(paths.dataDirectory), "state.sqlite3");
const witnessPath = (paths: AppPaths) => join(securityFenceRoot(canonical(paths)), "witness.json");

/** The check as the activation runs it: the store's ordinary ownership, then the check, then close. */
function admit(paths: AppPaths, target: number): void {
  const owner = new OwnedSqliteDatabase(paths.databasePath, true, target);
  try { assertOrdinaryAdmission(owner, target); } finally { owner.close(); }
}
/** "admitted", or the refusal's name, code, next step, state and whether it claims a commit. */
function verdict(operation: () => void): unknown {
  try { operation(); return "admitted"; } catch (error) {
    const { name, code, nextStep, state, committed, message } = error as UpgradeError;
    return { name, code, ...(nextStep === undefined ? {} : { nextStep }), ...(state === undefined ? {} : { state }), committed: committed ?? false, message };
  }
}
const UPGRADE_REQUIRED = {
  name: "UpgradeError", code: "upgrade_required", nextStep: "upgrade inspect", state: "upgrade_needed", committed: false,
  message: "upgrade_required: This database requires an explicit offline upgrade before ordinary access. Next step: upgrade inspect.",
};
const fence = (code: string) => ({ name: "SecurityFenceError", code, committed: false, message: expect.stringMatching(new RegExp(`^${code}: `)) });

/**
 * Committed frames in a non-empty WAL that the main file lacks (an audit row,
 * which no fence trigger covers), as a writer that has not checkpointed leaves
 * them: the files are taken while the writer is open and written back in place
 * (the same main file) after it closed.
 */
function withFrames(paths: AppPaths): void {
  const path = canonical(paths), writer = new Database(path, { fileMustExist: true });
  let main: Buffer, wal: Buffer;
  try {
    writer.pragma("journal_mode = WAL"); writer.pragma("wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO controller_audit_events(event_type,actor,details_json,created_at) VALUES('fixture.frames','fixture',?,?)").run(JSON.stringify({ marker: randomUUID() }), new Date().toISOString());
    main = readFileSync(path); wal = readFileSync(`${path}-wal`);
  } finally { writer.close(); }
  writeFileSync(path, main); writeFileSync(`${path}-wal`, wal, { mode: 0o600 }); chmodSync(`${path}-wal`, 0o600);
  rmSync(`${path}-shm`, { force: true });
  expect(lstatSync(`${path}-wal`).size).toBeGreaterThan(0);
}
/** What a refusal must leave byte for byte: the database file, its non-empty WAL, the witness and the plan file. */
function files(paths: AppPaths) {
  const path = canonical(paths), wal = `${path}-wal`, optional = (file: string) => existsSync(file) ? readFileSync(file) : null;
  expect(existsSync(wal) && lstatSync(wal).size > 0, "the WAL holds frames").toBe(true);
  return { database: sha(readFileSync(path)), wal: sha(readFileSync(wal)), witness: optional(witnessPath(paths))?.toString("utf8") ?? "missing",
    plan: optional(upgradePlanPath(path))?.toString("utf8") ?? "missing" };
}
/** Runs the check at `target` and asserts that it refused as `expected` and left every file as it was. */
function refusedUnchanged(paths: AppPaths, target: number, expected: unknown): void {
  withFrames(paths);
  const before = files(paths);
  expect(verdict(() => admit(paths, target))).toEqual(expected);
  expect(files(paths)).toEqual(before);
}
function rewriteWitness(paths: AppPaths, mutate: (payload: Record<string, unknown>) => void): void {
  const { payload } = JSON.parse(readFileSync(witnessPath(paths), "utf8")) as { payload: Record<string, unknown> };
  mutate(payload);
  writeFileSync(witnessPath(paths), JSON.stringify({ payload, sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") }));
}

/** Fixtures: each returns the paths of a new installation. */
const fenced49 = () => { const paths = installationPaths(); createFencedAt49(paths.databasePath); return paths; };
const freshAt = (target: number) => { const paths = installationPaths(); createFencedDatabase(paths.databasePath, target); return paths; };
/** Schema 52 with the marker pending, as an operator reaches it: `auth fence resume` at 52 over a schema-49 database. */
function pending52() {
  const paths = fenced49();
  rmSync(witnessPath(paths));
  const inspect = maintainSqliteSecurityFence(paths, { action: "inspect" }, HANDOFF, TARGET);
  expect(maintainSqliteSecurityFence(paths, { action: "resume", expect: inspect.preflight, mode: "token" }, HANDOFF, TARGET)).toMatchObject({ trusted: true, schemaVersion: 52 });
  return paths;
}
/** A schema-40 installation that never had a fence. */
function preFence() {
  const paths = installationPaths(); mkdirSync(paths.dataDirectory, { mode: 0o700 });
  const database = unmanagedFixtureDatabase(paths.databasePath);
  try { database.exec(readFileSync(new URL("./fixtures/schema-v40.sql", import.meta.url), "utf8")); } finally { database.close(); }
  chmodSync(paths.databasePath, 0o600);
  return paths;
}
/** A supported restore of a schema-49 backup, not yet acknowledged by `auth fence resume`. */
async function restored() {
  const paths = fenced49(), backup = join(paths.dataDirectory, "..", "restore-source");
  const store = openStoreAt49(paths.databasePath);
  try {
    await createControllerBackup(store, backup, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory });
    new AuthenticationService(store).generateToken("local-cli");
  } finally { store.close(); }
  restoreControllerBackup(backup, paths.databasePath);
  return paths;
}
/** The pre-upgrade backup, as the composition writes it, at the target's ceiling. */
const backups = (paths: AppPaths): UpgradeBackup => async source => {
  const destination = join(paths.dataDirectory, "..", `backup-${randomUUID()}`);
  return { root: destination, manifest: await createControllerBackup(source, destination, { applicationVersion: "test", attachmentDirectory: paths.knowledgeAttachmentDirectory, schemaCeiling: TARGET }) };
};
/** The whole upgrade from a schema-49 database to 52; returns the bytes of the database and its WAL before it ran. */
async function upgraded(paths: AppPaths) {
  const path = canonical(paths), wal = `${path}-wal`;
  const before = { database: readFileSync(path), wal: existsSync(wal) && lstatSync(wal).size > 0 ? readFileSync(wal) : null };
  const plan = inspectSqliteUpgrade(paths, TARGET);
  expect(plan).toMatchObject({ state: "upgrade_needed", schemaVersion: 49 });
  expect(await applySqliteUpgrade(paths, { expect: plan.planHash! }, backups(paths), TARGET)).toMatchObject({ state: "current", schemaVersion: 52 });
  return before;
}
/** Writes earlier bytes back into the same database file (same device and inode), with their WAL or none. */
function rollBack(paths: AppPaths, earlier: { database: Buffer; wal: Buffer | null }): void {
  const path = canonical(paths), inode = lstatSync(path).ino;
  writeFileSync(path, earlier.database);
  rmSync(`${path}-shm`, { force: true });
  if (earlier.wal) { writeFileSync(`${path}-wal`, earlier.wal, { mode: 0o600 }); chmodSync(`${path}-wal`, 0o600); } else rmSync(`${path}-wal`, { force: true });
  expect(lstatSync(path).ino).toBe(inode);
}

describe("ordinary admission at target 52", () => {
  it("admits a fresh database created at the target with the marker complete, and a new empty one the store would create", () => {
    const paths = freshAt(TARGET);
    expect(verdict(() => admit(paths, TARGET))).toBe("admitted");
    withFrames(paths);
    expect(verdict(() => admit(paths, TARGET))).toBe("admitted");
    const empty = installationPaths();
    expect(verdict(() => admit(empty, TARGET))).toBe("admitted");
    const owner = new OwnedSqliteDatabase(empty.databasePath, true, TARGET);
    try { expect(owner.inspection.fresh).toBe(true); } finally { owner.close(); }
  });

  it("requires the upgrade for a fenced schema-49 database, and leaves its plan file as it was", () => {
    const paths = fenced49();
    refusedUnchanged(paths, TARGET, UPGRADE_REQUIRED);
    expect(inspectSqliteUpgrade(paths, TARGET)).toMatchObject({ state: "upgrade_needed", schemaVersion: 49 });
    expect(existsSync(upgradePlanPath(canonical(paths)))).toBe(true);
    refusedUnchanged(paths, TARGET, UPGRADE_REQUIRED);
  });

  it.each([50, 51])("requires the upgrade for schema %i with the marker complete", version => {
    const paths = freshAt(version);
    const owner = new OwnedSqliteDatabase(paths.databasePath, false, version, { inspectOnly: true });
    try { expect(owner.database.prepare("SELECT state FROM upgrade_marker").pluck().all()).toEqual(["complete"]); } finally { owner.close(); }
    refusedUnchanged(paths, TARGET, UPGRADE_REQUIRED);
    // At its own version the same database is admitted.
    expect(verdict(() => admit(paths, version))).toBe("admitted");
  });

  it("requires the upgrade for schema 52 with the marker pending", () => {
    const paths = pending52();
    refusedUnchanged(paths, TARGET, UPGRADE_REQUIRED);
  }, 30_000);

  it("refuses schema 52 without a marker row as corrupt, by the database validation, never as needing the upgrade", () => {
    const paths = freshAt(TARGET), path = canonical(paths);
    // The row is deleted outside the owner, then the epoch its trigger moved is put back, so the fence still trusts the file.
    const writer = unmanagedFixtureDatabase(path);
    try {
      writer.function("worktree_security_pending", () => 0);
      const epoch = writer.prepare("SELECT epoch FROM security_checkpoint").pluck().get();
      writer.exec("DELETE FROM upgrade_marker");
      writer.prepare("UPDATE security_checkpoint SET epoch=? WHERE singleton=1").run(epoch);
    } finally { writer.close(); }
    const reader = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(() => SecurityFence.inspect(path, reader, false)).not.toThrow();
      expect(reader.prepare("SELECT count(*) FROM upgrade_marker").pluck().get()).toBe(0);
    } finally { reader.close(); }
    const corrupt = { name: "Error", code: undefined, committed: false, message: "SQLite application invariant failed (upgrade marker); startup stopped." };
    // Ownership refuses it before the check can run, as it does today.
    refusedUnchanged(paths, TARGET, corrupt);
    // The check alone, on a read-only connection that skipped the validation, gives the same refusal.
    const before = files(paths);
    const connection = new Database(path, { readonly: true, fileMustExist: true });
    try { expect(verdict(() => assertOrdinaryAdmission({ canonicalPath: path, database: connection, inspection: { version: 52, fresh: false } }, TARGET))).toEqual(corrupt); }
    finally { connection.close(); }
    expect(files(paths)).toEqual(before);
  });

  it("sends a pre-fence database to establishment", () => {
    refusedUnchanged(preFence(), TARGET, fence("security_fence_establishment_required"));
  });

  it.each([
    ["a pending witness", (payload: Record<string, unknown>) => { payload.state = "pending"; }],
    ["a witness of another epoch", (payload: Record<string, unknown>) => { payload.epoch = randomBytes(32).toString("hex"); }],
    ["a witness of another installation", (payload: Record<string, unknown>) => { payload.installation = randomBytes(32).toString("hex"); }],
  ])("sends a schema-49 database with %s to recovery, not to the upgrade", (_name, mutate) => {
    const paths = fenced49();
    rewriteWitness(paths, mutate);
    refusedUnchanged(paths, TARGET, fence("security_fence_recovery_required"));
  });

  it("sends an unacknowledged restore to recovery, not to the upgrade", async () => {
    refusedUnchanged(await restored(), TARGET, fence("security_fence_recovery_required"));
  }, 30_000);

  it("admits the upgraded database, and sends it to recovery once its main file is rolled back in place", async () => {
    const paths = fenced49(), earlier = await upgraded(paths);
    expect(earlier.wal).toBeNull();
    expect(verdict(() => admit(paths, TARGET))).toBe("admitted");
    rollBack(paths, earlier);
    refusedUnchanged(paths, TARGET, fence("security_fence_recovery_required"));
  }, 30_000);

  it("sends a database rolled back in place through its WAL to recovery", async () => {
    const paths = fenced49();
    withFrames(paths);
    const earlier = await upgraded(paths);
    expect(earlier.wal).not.toBeNull();
    expect(verdict(() => admit(paths, TARGET))).toBe("admitted");
    rollBack(paths, earlier);
    // The restored WAL itself holds the frames: compared as it is, without new ones.
    const before = files(paths);
    expect(verdict(() => admit(paths, TARGET))).toEqual(fence("security_fence_recovery_required"));
    expect(files(paths)).toEqual(before);
  }, 30_000);

  it("refuses an unsupported target before any lock or file, as every target does", () => {
    const paths = fenced49(), path = canonical(paths);
    const connection = new Database(path, { readonly: true, fileMustExist: true });
    try {
      for (const target of [48, 53]) expect(verdict(() => assertOrdinaryAdmission({ canonicalPath: path, database: connection, inspection: { version: 49, fresh: false } }, target)))
        .toEqual({ name: "Error", code: undefined, committed: false, message: "Unsupported schema target." });
    } finally { connection.close(); }
  });
});

describe("ordinary admission at the released target 49", () => {
  it("admits a fenced schema-49 database, and refuses what ordinary startup refuses today with the same fence refusals", async () => {
    expect(verdict(() => admit(fenced49(), RELEASED_SCHEMA_VERSION))).toBe("admitted");
    expect(verdict(() => admit(installationPaths(), RELEASED_SCHEMA_VERSION))).toBe("admitted");
    const pending = fenced49(); rewriteWitness(pending, payload => { payload.state = "pending"; });
    refusedUnchanged(pending, RELEASED_SCHEMA_VERSION, fence("security_fence_recovery_required"));
    refusedUnchanged(preFence(), RELEASED_SCHEMA_VERSION, fence("security_fence_establishment_required"));
    refusedUnchanged(await restored(), RELEASED_SCHEMA_VERSION, fence("security_fence_recovery_required"));
  }, 30_000);

  it("gives, at the supported version, the verdict the store's own opening gives", async () => {
    const cases: Array<[string, () => AppPaths | Promise<AppPaths>]> = [
      ["new", installationPaths], ["fenced 49", fenced49], ["pre-fence", preFence], ["restored", restored],
      ["pending witness", () => { const paths = fenced49(); rewriteWitness(paths, payload => { payload.state = "pending"; }); return paths; }],
    ];
    for (const [name, build] of cases) {
      const checked = await build(), opened = await build();
      const store = verdict(() => new SqliteStateStore(opened.databasePath).close());
      expect(verdict(() => admit(checked, SUPPORTED_SCHEMA_VERSION)), name).toEqual(store);
    }
  }, 30_000);
});

describe("the admission at every ordinary entry point", () => {
  /** Every file beside the database other than its sidecars and lock: witness, plan, handoff, restore evidence, backups. */
  const neighbours = (paths: AppPaths) => {
    const data = realpathSync(paths.dataDirectory), parent = join(data, "..");
    const allowed = new Set(["state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm", "state.sqlite3.owner.lock"]);
    return { data: readdirSync(data).filter(name => !allowed.has(name)).sort(), parent: readdirSync(parent).sort() };
  };
  const ENTRIES: Array<[string, (paths: AppPaths) => void]> = [
    ["the store constructor", paths => new SqliteStateStore(paths.databasePath).close()],
    ["openControllerStore (controller start)", paths => openControllerStore(paths.databasePath).close()],
    ["openCurrentControllerStore (service install's pre-bootstrap)", paths => openCurrentControllerStore(paths.databasePath).close()],
    ["the read-only remote recovery inspection", paths => openRemoteRecoveryInspection(paths.databasePath).close()],
  ];
  it.each([
    ["a fenced schema-49 database", fenced49],
    ["schema 50 with the marker complete", () => freshAt(50)],
    ["schema 51 with the marker complete", () => freshAt(51)],
    ["schema 52 with the marker pending", pending52],
  ] as Array<[string, () => AppPaths]>)("refuses %s with upgrade_required at every entry, before anything is written", (_name, build) => {
    for (const [entry, open] of ENTRIES) {
      const paths = build();
      withFrames(paths);
      const before = files(paths), around = neighbours(paths);
      expect(verdict(() => open(paths)), entry).toEqual(UPGRADE_REQUIRED);
      // The database, its non-empty WAL, the witness and the plan file are byte-identical; no plan,
      // backup, handoff or restore evidence appeared. Lock files, an empty WAL and the SHM may.
      expect(files(paths), entry).toEqual(before);
      expect(neighbours(paths), entry).toEqual(around);
    }
  }, 30_000);

  it("sends a rolled-back, a restored and a pending-witness database to recovery at every entry", async () => {
    const builds: Array<[string, () => AppPaths | Promise<AppPaths>]> = [
      ["restored", restored],
      ["pending witness", () => { const paths = fenced49(); rewriteWitness(paths, payload => { payload.state = "pending"; }); return paths; }],
    ];
    for (const [name, build] of builds) {
      for (const [entry, open] of ENTRIES) {
        const paths = await build();
        withFrames(paths);
        const before = files(paths);
        expect(verdict(() => open(paths)), `${name}: ${entry}`).toEqual(fence("security_fence_recovery_required"));
        expect(files(paths), `${name}: ${entry}`).toEqual(before);
      }
    }
  }, 30_000);

  it("admits a current database at every entry: a fresh one and an upgraded one", async () => {
    const upgradedPaths = fenced49();
    await upgraded(upgradedPaths);
    for (const [entry, open] of ENTRIES) {
      for (const paths of [freshAt(TARGET), upgradedPaths]) expect(verdict(() => open(paths)), entry).toBe("admitted");
    }
  }, 30_000);
});

describe("an admitted current database at the store's opening", () => {
  /** Every row of `table` with every column SQLite-quoted, so a changed type, value or row shows. */
  const rows = (path: string, table: string): string[] => {
    const reader = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const columns = (reader.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(({ name }) => `quote("${name}")`);
      return reader.prepare(`SELECT ${columns.join("||'|'||")} FROM "${table}" ORDER BY rowid`).pluck().all() as string[];
    } finally { reader.close(); }
  };
  const indexSql = (path: string, name: string) => {
    const reader = new Database(path, { readonly: true, fileMustExist: true });
    try { return reader.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").pluck().get(name) as string | undefined; }
    finally { reader.close(); }
  };

  it("restores the bootstrap's idempotency index that a current database lost, and the uniqueness it enforces holds", () => {
    const paths = freshAt(TARGET), path = canonical(paths);
    const definition = indexSql(path, "test_runs_actor_idempotency");
    expect(definition).toMatch(/CREATE UNIQUE INDEX test_runs_actor_idempotency/);
    // DDL outside the owner: no row changes, so no fence trigger fires and the witness still matches.
    const dropper = unmanagedFixtureDatabase(path);
    try { dropper.exec("DROP INDEX test_runs_actor_idempotency"); } finally { dropper.close(); }
    expect(indexSql(path, "test_runs_actor_idempotency")).toBeUndefined();

    new SqliteStateStore(paths.databasePath).close();
    expect(indexSql(path, "test_runs_actor_idempotency")).toBe(definition);

    // The constraint itself: a second run of the same actor with the same key is refused.
    const writer = unmanagedFixtureDatabase(path);
    try {
      writer.pragma("foreign_keys = OFF");
      const insert = (id: string) => writer.prepare(`INSERT INTO test_runs(id,project_id,worktree_path,worktree_head,worktree_dirty,preset_id,preset_name,adapter,actor,phase,executable,args_json,cwd,queued_at,idempotency_key)
        VALUES(?,'project','/code/project','head',0,'node:test','test','node','local-cli','queued','pnpm','["test"]','/code/project',?,'same-key')`).run(id, new Date().toISOString());
      writer.exec("BEGIN");
      try {
        insert("first");
        expect(() => insert("second")).toThrow(/UNIQUE constraint failed: test_runs\.actor, test_runs\.idempotency_key/);
      } finally { writer.exec("ROLLBACK"); }
    } finally { writer.close(); }
  });

  it("leaves schema_migrations and the upgrade marker as they were, for a fresh and an upgraded database", async () => {
    const upgradedPaths = fenced49();
    await upgraded(upgradedPaths);
    for (const paths of [freshAt(TARGET), upgradedPaths]) {
      const path = canonical(paths);
      const before = { migrations: rows(path, "schema_migrations"), marker: rows(path, "upgrade_marker") };
      expect(before.migrations).toHaveLength(TARGET);
      expect(before.marker).toHaveLength(1);
      new SqliteStateStore(paths.databasePath).close();
      expect({ migrations: rows(path, "schema_migrations"), marker: rows(path, "upgrade_marker") }).toEqual(before);
    }
  }, 30_000);
});

/**
 * Gate row 5 of slice 3: revoke a grant, then roll the database file back in
 * place; startup is refused. Revocation of a grant is deletion, so an older
 * copy of the file holds the deleted row. The copy must never be admitted: it
 * would bring the revoked grant back. The earlier tests of this file roll back
 * the upgrade itself; this one rolls back a write of the new `account_grants`
 * table on a schema-52 database, with the writes made on the store's own
 * guarded handle (so the table's fence trigger moves the checkpoint epoch and
 * the store publishes the matching witness), as production writes them.
 */
describe("a revoked grant and a database file put back in place at target 52", () => {
  const AT = "2026-11-17T00:00:00.000Z";
  const GRANT = "INSERT INTO account_grants(account_id,role,scope_kind,project_id,granted_at) VALUES('human-a','operator','project','project-a',?)";
  const REVOKE = "DELETE FROM account_grants WHERE account_id='human-a' AND role='operator' AND project_id='project-a'";
  const GRANTED = [{ role: "operator", scopeKind: "project", projectId: "project-a" }];
  type Image = { database: Buffer; wal: Buffer | null };
  const ENTRY_POINTS: Array<[string, (paths: AppPaths) => void]> = [
    ["the ordinary admission check", paths => admit(paths, TARGET)],
    ["the store constructor", paths => new SqliteStateStore(paths.databasePath).close()],
    ["openControllerStore (controller start)", paths => openControllerStore(paths.databasePath).close()],
    ["the read-only remote recovery inspection", paths => openRemoteRecoveryInspection(paths.databasePath).close()],
  ];
  /** The main file and its WAL as they are now (the WAL is null when it holds no frames). */
  const image = (paths: AppPaths): Image => {
    const path = canonical(paths), wal = `${path}-wal`;
    return { database: readFileSync(path), wal: existsSync(wal) && lstatSync(wal).size > 0 ? readFileSync(wal) : null };
  };
  /** What a refusal must leave: the database file, its non-empty WAL and the witness, byte for byte. */
  const snapshot = (paths: AppPaths) => {
    const now = image(paths);
    return { database: sha(now.database), wal: now.wal === null ? "none" : sha(now.wal), witness: readFileSync(witnessPath(paths), "utf8") };
  };
  /** The account's grants as the grants reader (the one the operations adapter uses) reads them. */
  const grantsOf = (store: SqliteStateStore) => new AccountGrantsQueries(ownedFixtureDatabase(store)).accountGrants("human-a")?.grants;
  /** The grants an image holds, read from a scratch copy so the installation's own files stay as they are. */
  function grantsInImage(earlier: Image): unknown[] {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-admission-image-")); roots.push(directory);
    const path = join(directory, "state.sqlite3");
    writeFileSync(path, earlier.database, { mode: 0o600 });
    if (earlier.wal) writeFileSync(`${path}-wal`, earlier.wal, { mode: 0o600 });
    const reader = unmanagedFixtureDatabase(path);
    try { return reader.prepare("SELECT account_id AS account,role,scope_kind AS scopeKind,project_id AS projectId FROM account_grants ORDER BY rowid").all(); }
    finally { reader.close(); }
  }

  it.each([
    ["the main file alone", false],
    ["the main file and its WAL", true],
  ])("opens the database normally after the revocation, and refuses the same database put back to before it (%s)", async (_name, withWal) => {
    const paths = fenced49();
    await upgraded(paths);
    // 1. Grant a role, as production writes it, and take the copy that holds the grant.
    let earlier!: Image;
    let store: SqliteStateStore | undefined = new SqliteStateStore(paths.databasePath);
    try {
      store.humanAccounts().createHumanPrincipal({ id: "human-a", kind: "human", status: "active" }, "fixture");
      store.saveKnowledgeProject({ id: "project-a", name: "project-a", status: "active", revision: 1, createdAt: AT, updatedAt: AT }, "fixture");
      expect(ownedFixtureDatabase(store).prepare(GRANT).run(AT).changes).toBe(1);
      expect(grantsOf(store)).toEqual(GRANTED);
      if (withWal) earlier = image(paths);
      else { store.close(); store = undefined; earlier = image(paths); store = new SqliteStateStore(paths.databasePath); }
      expect(earlier.wal !== null, "the copy carries a WAL exactly in the WAL variant").toBe(withWal);
      // 2. Revoke it: deletion, through the same guarded handle.
      expect(ownedFixtureDatabase(store).prepare(REVOKE).run().changes).toBe(1);
      expect(grantsOf(store)).toEqual([]);
    } finally { store?.close(); }
    // The copy does hold the grant that was revoked (so admitting it would bring the grant back).
    expect(grantsInImage(earlier)).toEqual([{ account: "human-a", role: "operator", scopeKind: "project", projectId: "project-a" }]);

    // 3. Control: without the roll-back every ordinary opening admits the database and the grant is gone.
    for (const [entry, open] of ENTRY_POINTS) expect(verdict(() => open(paths)), entry).toBe("admitted");
    const reopened = new SqliteStateStore(paths.databasePath);
    try { expect(grantsOf(reopened), "the revoked grant stays revoked").toEqual([]); } finally { reopened.close(); }

    // 4. Put the older copy back in place (same file, same inode): every ordinary opening refuses it, twice, and changes nothing.
    rollBack(paths, earlier);
    const before = snapshot(paths);
    for (let attempt = 1; attempt <= 2; attempt++) {
      for (const [entry, open] of ENTRY_POINTS) expect(verdict(() => open(paths)), `${entry}, attempt ${attempt}`).toEqual(fence("security_fence_recovery_required"));
      expect(snapshot(paths), `attempt ${attempt}`).toEqual(before);
    }
  }, 30_000);
});
