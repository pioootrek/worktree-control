import { stripMigrationProvenance } from "./fixtures/legacy-registry";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { TestRun } from "@/shared/contracts";
import { legacySourceEvidence } from "@/server/test-source-attribution";
import { ProjectLaunchCommandResolver } from "@/server/launch-command";
import { SqliteStateStore } from "./index";

const directories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-"));
  directories.push(directory);
  return new SqliteStateStore(join(directory, "state.sqlite3"));
}

function projectInput(name: string, repositoryPath: string, port: number) {
  return { name, repositoryPath, port, executable: "pnpm", args: ["run", "dev"] };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteStateStore", () => {
  it("retains launch evidence across reopen and isolates projects and failed operations", () => {
    const store = createStore();
    const project = store.addProject(projectInput("Launches", "/code/launches", 3301));
    const other = store.addProject(projectInput("Other", "/code/other", 3302));
    store.recordProjectEvent(project.id, "worktree.launched", "controller", { worktreePath: "/code/branch" });
    store.recordProjectEvent(project.id, "agent.runtime_failed", "controller", { worktreePath: "/code/failed" });
    store.recordProjectEvent(other.id, "worktree.launched", "controller", { worktreePath: "/code/other" });
    const launches = store.listWorktreeLaunches(project.id);
    expect(Object.keys(launches)).toEqual(["/code/branch"]);
    for (let index = 0; index < 2001; index++) {
      store.recordProjectEvent(other.id, "worktree.launched", "controller", { worktreePath: "/code/other" });
      store.recordProjectEvent(project.id, "agent.runtime_completed", "controller", {});
    }
    expect(store.listWorktreeLaunches(project.id)).toEqual(launches);
    store.close();
    const reopened = new SqliteStateStore(join(directories.at(-1)!, "state.sqlite3"));
    expect(reopened.listWorktreeLaunches(project.id)).toEqual(launches);
    reopened.close();
  });
  it("repairs a legacy database whose recorded migration 7 omitted the launch preset column", () => {
    const directory = mkdtempSync(join(tmpdir(), "switcher-preset-repair-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite3");
    const initial = new SqliteStateStore(path);
    const project = initial.addProject(projectInput("Legacy", "/code/legacy", 3218));
    initial.close();
    const legacy = new Database(path);
    stripMigrationProvenance(legacy);
    legacy.exec("ALTER TABLE knowledge_import_batches DROP COLUMN authentication_method; ALTER TABLE projects DROP COLUMN launch_preset; DELETE FROM schema_migrations WHERE version > 12;");
    legacy.close();
    const repaired = new SqliteStateStore(path);
    expect(repaired.getProject(project.id)?.launchPreset).toBe("auto");
    expect(repaired.listProjects()[0].launchPreset).toBe("auto");
    writeFileSync(join(directory, "manage.py"), "");
    const resolver = new ProjectLaunchCommandResolver();
    expect(resolver.resolve(directory, 3218, repaired.getProject(project.id)?.launchPreset))
      .toEqual(resolver.resolve(directory, 3218, undefined));
    const django = repaired.addProject({ ...projectInput("Django", "/code/django", 3217), launchPreset: "django" });
    repaired.close();
    const reopened = new SqliteStateStore(path);
    expect(reopened.getProject(django.id)?.launchPreset).toBe("django");
    reopened.close();
  });

  it("preserves existing launch presets when applying the repair migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "switcher-preset-existing-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite3");
    const initial = new SqliteStateStore(path);
    const auto = initial.addProject({ ...projectInput("Auto", "/code/auto", 3216), launchPreset: "auto" });
    const django = initial.addProject({ ...projectInput("Django", "/code/django", 3217), launchPreset: "django" });
    initial.close();
    const legacy = new Database(path);
    stripMigrationProvenance(legacy);
    legacy.exec("DELETE FROM schema_migrations WHERE version >= 13");
    legacy.close();
    const repaired = new SqliteStateStore(path);
    expect(repaired.getProject(auto.id)?.launchPreset).toBe("auto");
    expect(repaired.getProject(django.id)?.launchPreset).toBe("django");
    repaired.close();
  });

  it("persists test queue settings, run output, and interruption recovery", () => {
    const store = createStore();
    const project = store.addProject(projectInput("Tests", "/code/tests", 3219));
    const run: TestRun = {
      id: "run-1", projectId: project.id, worktreePath: "/code/tests", worktreeHead: "abc123",
      worktreeBranch: "main", worktreeDirty: true, presetId: "node:test", presetName: "test",
      adapter: "node", actor: "agent:mcp:test", phase: "running", queuePosition: null,
      executable: "pnpm", args: ["run", "test"], cwd: "/code/tests",
      queuedAt: "2026-09-02T10:00:00.000Z", startedAt: "2026-09-02T10:00:01.000Z",
      finishedAt: null, exitCode: null, signal: null, error: null, logs: ["starting"],
      environmentMode: "clean", environmentProfile: "unit", inheritedServerProfile: null,
      environmentVariableNames: ["NODE_ENV", "PATH"], source: legacySourceEvidence(),
    };
    store.setTestQueueSettings({ limit: 3 });
    store.saveTestRun(run, "attempt-1");
    expect(store.getTestQueueSettings()).toEqual({ limit: 3 });
    expect(store.countTestRuns(["running"])).toBe(1);
    expect(store.countTestRuns(["queued"], project.id)).toBe(0);
    expect(store.countTestRuns(["running"], project.id, "/another/worktree")).toBe(0);
    expect(store.listPendingTestRuns()).toEqual([{
      id: run.id,
      projectId: project.id,
      worktreePath: run.worktreePath,
      phase: "running",
      queuePosition: null,
      queuedAt: run.queuedAt,
    }]);
    expect(store.findTestRunByIdempotency("agent:mcp:test", "attempt-1")).toEqual(run);
    expect(store.getTestRunStatus(run.id)).toEqual({
      id: run.id, projectId: run.projectId, worktreePath: run.worktreePath,
      worktreeHead: run.worktreeHead, worktreeBranch: run.worktreeBranch,
      worktreeDirty: true, presetId: run.presetId, phase: "running", queuePosition: null,
      queuedAt: run.queuedAt, startedAt: run.startedAt, finishedAt: null,
      exitCode: null, signal: null, error: null,
      source: run.source,
    });
    store.markInterruptedTestRuns();
    expect(store.getTestRun(run.id)).toMatchObject({ phase: "interrupted", queuePosition: null });
    store.close();
  });

  it("migrates legacy test runs to explicit unknown source evidence and replays migration 12", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-source-migration-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const store = new SqliteStateStore(databasePath);
    const project = store.addProject(projectInput("Legacy", "/code/legacy", 3220));
    const run: TestRun = {
      id: "legacy-run", projectId: project.id, worktreePath: "/code/legacy", worktreeHead: "abc123",
      worktreeBranch: "main", worktreeDirty: false, presetId: "node:test", presetName: "test",
      adapter: "node", actor: "local-user", phase: "passed", queuePosition: null,
      executable: "pnpm", args: ["test"], cwd: "/code/legacy", queuedAt: "2026-09-01T00:00:00.000Z",
      startedAt: "2026-09-01T00:00:01.000Z", finishedAt: "2026-09-01T00:00:02.000Z", exitCode: 0,
      signal: null, error: null, logs: [], environmentMode: "clean", environmentProfile: "unit",
      inheritedServerProfile: null, environmentVariableNames: [], source: legacySourceEvidence(),
    };
    store.saveTestRun(run);
    store.close();

    const database = new Database(databasePath);
    database.exec("ALTER TABLE test_runs DROP COLUMN source_json");
    stripMigrationProvenance(database);
    database.prepare("DELETE FROM schema_migrations WHERE version >= 12").run();
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    expect(migrated.getTestRun(run.id)?.source).toMatchObject({ attribution: "legacy_unknown", enqueue: null, processOutcome: null });
    migrated.close();
    const replay = new SqliteStateStore(databasePath);
    expect(replay.getTestRun(run.id)?.source.attribution).toBe("legacy_unknown");
    replay.close();
  });

  it("removes a project, releases its port, and preserves a controller audit event", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-remove-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const store = new SqliteStateStore(databasePath);
    const project = store.addProject(projectInput("Old App", "/code/old-app", 3210));

    store.removeProject(project.id, "local-user");
    expect(store.getProject(project.id)).toBeNull();
    expect(() => store.removeProject(project.id, "local-user")).toThrow("Nie znaleziono projektu");
    expect(store.addProject(projectInput("New App", "/code/new-app", 3210)).port).toBe(3210);

    const database = new Database(databasePath);
    const event = database.prepare("SELECT actor, details_json FROM controller_audit_events WHERE event_type = 'project.removed'").get() as { actor: string; details_json: string };
    expect(event.actor).toBe("local-user");
    expect(JSON.parse(event.details_json)).toMatchObject({ projectId: project.id, name: "Old App", port: 3210 });
    database.close();
    store.close();
  });

  it("allows only one active reservation per project and permits release by its owner", () => {
    const store = createStore();
    const project = store.addProject(projectInput("App", "/code/app", 3210));

    const first = store.acquireReservation({
      projectId: project.id,
      worktreePath: "/code/app",
      kind: "human",
      owner: "alice",
    });

    expect(store.getActiveReservation(project.id)).toEqual(first);
    expect(() => store.acquireReservation({
      projectId: project.id,
      worktreePath: "/code/app-feature",
      kind: "human",
      owner: "bob",
    })).toThrow("alice");
    expect(() => store.releaseReservation(project.id, "bob")).toThrow("właściciel");

    store.releaseReservation(project.id, "alice");
    expect(store.getActiveReservation(project.id)).toBeNull();
    store.close();
  });

  it("requires expiring agent leases", () => {
    const store = createStore();
    const project = store.addProject(projectInput("API", "/code/api", 3211));
    expect(() => store.acquireReservation({
      projectId: project.id,
      worktreePath: "/code/api",
      kind: "agent",
      owner: "agent:test",
    })).toThrow("co najmniej");
    store.close();
  });

  it("renews and releases an idempotent agent lease only with its token hash", () => {
    const store = createStore();
    const project = store.addProject(projectInput("Agent API", "/code/agent-api", 3215));
    const leaseTokenHash = createHash("sha256").update("lease-secret").digest("hex");
    const request = {
      projectId: project.id,
      worktreePath: "/code/agent-api",
      kind: "agent" as const,
      owner: "agent:mcp:session-1",
      reason: "Run integration checks",
      ttlSeconds: 60,
      maximumLifetimeSeconds: 3600,
      leaseTokenHash,
      idempotencyKey: "run-1",
    };
    const lease = store.acquireReservation(request);
    expect(store.acquireReservation(request).id).toBe(lease.id);
    expect(() => store.authorizeReservation(project.id, request.owner, "wrong"))
      .toThrow("token");
    expect(store.authorizeReservation(project.id, request.owner, leaseTokenHash)?.id).toBe(lease.id);

    const renewed = store.renewAgentReservation(project.id, lease.id, request.owner, leaseTokenHash, 120);
    expect(new Date(renewed.expiresAt!).getTime()).toBeGreaterThan(new Date(lease.expiresAt!).getTime());
    expect(() => store.releaseAgentReservation(project.id, lease.id, request.owner, "wrong"))
      .toThrow("token");
    store.releaseAgentReservation(project.id, lease.id, request.owner, leaseTokenHash);
    expect(store.getActiveReservation(project.id)).toBeNull();
    store.close();
  });

  it("migrates the legacy pnpm command that passed --port after a separator", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const store = new SqliteStateStore(databasePath);
    const project = store.addProject(projectInput("Web", "/code/web", 3212));
    store.close();

    const database = new Database(databasePath);
    database.prepare("UPDATE projects SET args_json = ? WHERE id = ?")
      .run(JSON.stringify(["dev", "--", "--port", "3212"]), project.id);
    stripMigrationProvenance(database);
    database.prepare("DELETE FROM schema_migrations WHERE version >= 2").run();
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    expect(migrated.getProject(project.id)?.args).toEqual(["run", "dev"]);
    migrated.close();
  });

  it("persists generated Next.js TLS settings with the launch command", () => {
    const store = createStore();
    const project = store.addProject(projectInput("Secure", "/code/secure", 3213));
    store.updateProjectLaunch(project.id, {
      tlsMode: "generated",
      tlsKeyPath: null,
      tlsCertPath: null,
      tlsCaPath: null,
      executable: "pnpm",
      args: ["run", "dev", "--experimental-https"],
    });
    expect(store.getProject(project.id)).toMatchObject({
      tlsMode: "generated",
      args: ["run", "dev", "--experimental-https"],
    });
    store.close();
  });

  it("persists project environment profiles without values in audit details", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-env-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const store = new SqliteStateStore(databasePath);
    const project = store.addProject(projectInput("E2E", "/code/e2e", 3216));
    store.saveProjectEnvironmentProfile(project.id, { name: "e2e", environment: { PLAYWRIGHT_E2E: "1" } }, "agent:mcp:test");
    store.selectProjectEnvironmentProfile(project.id, "e2e", "agent:mcp:test");
    expect(store.getProject(project.id)).toMatchObject({
      selectedEnvironmentProfile: "e2e",
      environment: { PLAYWRIGHT_E2E: "1" },
      environmentProfiles: expect.arrayContaining([{ name: "e2e", environment: { PLAYWRIGHT_E2E: "1" } }]),
    });
    store.deleteProjectEnvironmentProfile(project.id, "default", "agent:mcp:test");
    expect(store.getProject(project.id)?.environmentProfiles).toEqual([{ name: "e2e", environment: { PLAYWRIGHT_E2E: "1" } }]);
    store.close();
    const database = new Database(databasePath);
    const audit = database.prepare("SELECT actor, details_json FROM audit_events WHERE event_type = 'project.environment_profile_saved'").get() as { actor: string; details_json: string };
    expect(audit.actor).toBe("agent:mcp:test");
    expect(JSON.parse(audit.details_json)).toEqual({ profileName: "e2e", variableNames: ["PLAYWRIGHT_E2E"] });
    database.close();
  });

  it("does not overwrite profiles when replaying migration 9 against an existing column", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-env-replay-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const store = new SqliteStateStore(databasePath);
    const project = store.addProject(projectInput("Replay", "/code/replay", 3218));
    store.saveProjectEnvironmentProfile(project.id, { name: "staging", environment: { FEATURE_MODE: "staging" } }, "local-user");
    store.close();

    const database = new Database(databasePath);
    stripMigrationProvenance(database);
    database.prepare("DELETE FROM schema_migrations WHERE version >= 9").run();
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    expect(migrated.getProject(project.id)?.environmentProfiles).toEqual([
      { name: "default", environment: {} },
      { name: "staging", environment: { FEATURE_MODE: "staging" } },
    ]);
    migrated.close();
  });

  it("persists controller-wide server capacity settings", () => {
    const store = createStore();
    expect(store.getServerCapacitySettings()).toEqual({ enabled: false, limit: 2 });
    store.setServerCapacitySettings({ enabled: true, limit: 3 });
    expect(store.getServerCapacitySettings()).toEqual({ enabled: true, limit: 3 });
    store.close();
  });

  it("persists bounded worktree storage history and the latest breakdown", () => {
    const store = createStore();
    const project = store.addProject(projectInput("Storage", "/code/storage", 3220));
    for (let index = 0; index < 181; index += 1) {
      store.saveWorktreeStorage({
        projectId: project.id,
        worktreePath: "/code/storage",
        totalBytes: 1_000 + index,
        nextBytes: 400,
        nextCacheBytes: 300,
        nodeModulesBytes: 200,
        topDirectories: [{ name: ".next", bytes: 400 }],
        measuredAt: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
      });
    }

    const snapshot = store.getWorktreeStorage(project.id, "/code/storage");
    expect(snapshot).toMatchObject({
      status: "available",
      totalBytes: 1_180,
      nextBytes: 400,
      nextCacheBytes: 300,
      nodeModulesBytes: 200,
      otherBytes: 580,
      topDirectories: [{ name: ".next", bytes: 400 }],
    });
    expect(snapshot?.history).toHaveLength(180);
    expect(snapshot?.history[0].totalBytes).toBe(1_000);
    expect(snapshot?.history[1].totalBytes).toBe(1_002);
    store.close();
  });

  it("adds TLS columns to a version 2 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-v2-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const database = new Database(databasePath);
    database.exec(readFileSync(new URL("./fixtures/schema-v12.sql", import.meta.url), "utf8"));
    database.exec(`
      DELETE FROM schema_migrations WHERE version > 2;
      ALTER TABLE projects DROP COLUMN tls_mode;
      ALTER TABLE projects DROP COLUMN tls_key_path;
      ALTER TABLE projects DROP COLUMN tls_cert_path;
      ALTER TABLE projects DROP COLUMN tls_ca_path;
      INSERT INTO projects(id,name,repository_path,port,executable,args_json,healthcheck_path,startup_timeout_ms,created_at,updated_at)
      VALUES('legacy','Legacy','/code/legacy',3214,'pnpm','["run","dev"]','/',45000,'now','now');
    `);
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    expect(migrated.getProject("legacy")).toMatchObject({ tlsMode: "off", tlsKeyPath: null, launchPreset: "node" });
    migrated.close();
  });

  it("adds agent lease columns to a version 3 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-control-store-v3-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const database = new Database(databasePath);
    database.exec(readFileSync(new URL("./fixtures/schema-v12.sql", import.meta.url), "utf8"));
    database.exec(`
      DELETE FROM schema_migrations WHERE version > 3;
      DROP INDEX active_agent_idempotency_key;
      DROP TABLE reservations;
      CREATE TABLE reservations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        worktree_path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
        owner TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, expires_at TEXT,
        released_at TEXT, released_by TEXT
      );
      CREATE UNIQUE INDEX one_active_reservation_per_project ON reservations(project_id) WHERE released_at IS NULL;
    `);
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    migrated.close();
    new SqliteStateStore(databasePath).close();
    const inspected = new Database(databasePath);
    const columns = inspected.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "maximum_expires_at",
      "token_hash",
      "idempotency_key",
    ]));
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get()).toBeTruthy();
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get()).toBeTruthy();
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get()).toBeTruthy();
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get()).toBeTruthy();
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get()).toBeTruthy();
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get()).toBeTruthy();
    inspected.close();
  });
});
