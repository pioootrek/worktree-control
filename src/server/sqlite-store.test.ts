import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { SqliteStateStore } from "./sqlite-store";

const directories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-store-"));
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
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-store-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const store = new SqliteStateStore(databasePath);
    const project = store.addProject(projectInput("Web", "/code/web", 3212));
    store.close();

    const database = new Database(databasePath);
    database.prepare("UPDATE projects SET args_json = ? WHERE id = ?")
      .run(JSON.stringify(["dev", "--", "--port", "3212"]), project.id);
    database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
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
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-store-env-"));
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
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-store-v2-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'now'), (2, 'now');
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repository_path TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL UNIQUE, executable TEXT NOT NULL, args_json TEXT NOT NULL,
        healthcheck_path TEXT NOT NULL, startup_timeout_ms INTEGER NOT NULL,
        selected_worktree_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO projects VALUES (
        'legacy', 'Legacy', '/code/legacy', 3214, 'pnpm', '["run","dev"]',
        '/', 45000, NULL, 'now', 'now'
      );
    `);
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    expect(migrated.getProject("legacy")).toMatchObject({ tlsMode: "off", tlsKeyPath: null });
    migrated.close();
  });

  it("adds agent lease columns to a version 3 database", () => {
    const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-store-v3-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite3");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, 'now'), (2, 'now'), (3, 'now');
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repository_path TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL UNIQUE, tls_mode TEXT NOT NULL DEFAULT 'off',
        tls_key_path TEXT, tls_cert_path TEXT, tls_ca_path TEXT,
        executable TEXT NOT NULL, args_json TEXT NOT NULL, healthcheck_path TEXT NOT NULL,
        startup_timeout_ms INTEGER NOT NULL, selected_worktree_path TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE reservations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
        kind TEXT NOT NULL, owner TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
        expires_at TEXT, released_at TEXT, released_by TEXT
      );
    `);
    database.close();

    const migrated = new SqliteStateStore(databasePath);
    migrated.close();
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
    inspected.close();
  });
});
