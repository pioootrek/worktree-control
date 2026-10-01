import { stripMigrationProvenance } from "./fixtures/legacy-registry";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  RemoteVerificationAttemptError,
  RemoteVerificationAttemptService,
  RemoteVerificationError,
  RemoteVerificationService,
  type RemoteVerificationRequest,
} from "@/server/modules/remote-verification";
import { SqliteStateStore } from "./index";
import { RemoteVerificationQueries } from "./remote-verification-queries";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-remote-verification-"));
  directories.push(directory);
  return join(directory, "state.sqlite3");
}

function provision(store: SqliteStateStore): string {
  const localProject = store.addProject({
    name: "Local checkout",
    repositoryPath: "/code/project",
    port: 3210,
    executable: "pnpm",
    args: ["run", "dev"],
  });
  store.saveRemotePrincipal({ id: "owner-1", kind: "owner", status: "active" }, "local-user");
  store.saveRemotePrincipal({ id: "worker-principal-1", kind: "worker", status: "active" }, "local-user");
  store.saveRemoteProjectIdentity(
    { id: "project-1", name: "Project", sourceRemote: "origin", status: "active" },
    "local-user",
  );
  store.saveRemoteWorker({
    id: "worker-1",
    principalId: "worker-principal-1",
    name: "Worker",
    status: "active",
    lastContactAt: null,
  }, "local-user");
  store.saveRemotePrincipalProjectGrant({
    principalId: "owner-1",
    projectId: "project-1",
    permissions: ["submit", "read"],
    revokedAt: null,
  }, "local-user");
  store.saveRemoteWorkerProjectGrant({
    workerId: "worker-1",
    projectId: "project-1",
    localProjectId: localProject.id,
    presetIds: ["node:test"],
    revokedAt: null,
  }, "local-user");
  return localProject.id;
}

function request(id: string, commitSha = SHA): RemoteVerificationRequest {
  return {
    id,
    projectId: "project-1",
    workerId: "worker-1",
    requestedBy: "owner-1",
    commitSha,
    presetId: "node:test",
    idempotencyKey: "submission-1",
    phase: "pending",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
  };
}

function submit(store: SqliteStateStore, id = "request-1", commitSha = SHA): RemoteVerificationRequest {
  return new RemoteVerificationService(store, () => "2026-09-11T00:00:00.000Z", () => id).submit({
    projectId: "project-1",
    workerId: "worker-1",
    commitSha,
    presetId: "node:test",
    idempotencyKey: id,
  }, { principalId: "owner-1" });
}

function attemptService(store: ConstructorParameters<typeof RemoteVerificationAttemptService>[0], times: string[], ids: string[] = ["attempt-1"]) {
  let timeIndex = 0;
  let idIndex = 0;
  const service = new RemoteVerificationAttemptService(
    store,
    () => times[Math.min(timeIndex++, times.length - 1)]!,
    () => ids[Math.min(idIndex++, ids.length - 1)]!,
  );
  return {
    assign: (input: Parameters<RemoteVerificationAttemptService["assign"]>[0]) => (
      service.assign(input, { principalId: "worker-principal-1" })
    ),
    assignAs: (input: Parameters<RemoteVerificationAttemptService["assign"]>[0], principalId: string) => (
      service.assign(input, { principalId })
    ),
    report: (input: Parameters<RemoteVerificationAttemptService["report"]>[0]) => (
      service.report(input, { principalId: "worker-principal-1" })
    ),
    reportAs: (input: Parameters<RemoteVerificationAttemptService["report"]>[0], principalId: string) => (
      service.report(input, { principalId })
    ),
    recoverInterruptedAttempts: service.recoverInterruptedAttempts.bind(service),
  };
}

function expectAttemptCode(operation: () => unknown, code: RemoteVerificationAttemptError["code"]): void {
  expect(operation).toThrowError(expect.objectContaining<Partial<RemoteVerificationAttemptError>>({ code }));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("remote verification SQLite persistence", () => {
  it("persists identities and grants, then replays a request after restart", () => {
    const path = databasePath();
    const first = new SqliteStateStore(path);
    provision(first);

    const service = new RemoteVerificationService(first, () => "2026-09-11T00:00:00.000Z", () => "request-1");
    const accepted = service.submit({
      projectId: "project-1",
      workerId: "worker-1",
      commitSha: SHA,
      presetId: "node:test",
      idempotencyKey: "submission-1",
    }, { principalId: "owner-1" });
    expect(accepted.id).toBe("request-1");
    first.close();

    const reopened = new SqliteStateStore(path);
    expect(reopened.getRemotePrincipal("owner-1")).toEqual({ id: "owner-1", kind: "owner", status: "active" });
    expect(reopened.getRemoteProjectIdentity("project-1")).toEqual({
      id: "project-1", name: "Project", sourceRemote: "origin", status: "active",
    });
    expect(reopened.getRemoteWorker("worker-1")).toMatchObject({
      principalId: "worker-principal-1", status: "active", lastContactAt: null,
    });
    expect(reopened.getRemotePrincipalProjectGrant("owner-1", "project-1")?.permissions).toEqual(["submit", "read"]);
    expect(reopened.getRemoteWorkerProjectGrant("worker-1", "project-1")).toMatchObject({
      presetIds: ["node:test"], revokedAt: null,
    });

    const replay = new RemoteVerificationService(reopened, () => "2026-09-11T00:01:00.000Z", () => "request-2")
      .submit({
        projectId: "project-1",
        workerId: "worker-1",
        commitSha: SHA,
        presetId: "node:test",
        idempotencyKey: "submission-1",
      }, { principalId: "owner-1" });
    expect(replay).toEqual(accepted);
    reopened.close();
  });

  it("scopes one idempotency winner per principal across raw persistence connections", () => {
    const path = databasePath();
    const first = new SqliteStateStore(path);
    provision(first);
    first.saveRemotePrincipal({ id: "owner-2", kind: "owner", status: "active" }, "local-user");
    first.saveRemotePrincipalProjectGrant({
      principalId: "owner-2",
      projectId: "project-1",
      permissions: ["submit"],
      revokedAt: null,
    }, "local-user");
    expect(() => new SqliteStateStore(path)).toThrow("already running");
    const secondConnection = new Database(path);
    const second = new RemoteVerificationQueries(secondConnection);

    expect(first.createOrReplayRemoteVerificationRequest(request("request-1"))).toEqual(request("request-1"));
    expect(second.createOrReplayRemoteVerificationRequest(request("request-2"))).toEqual(request("request-1"));
    expect(second.createOrReplayRemoteVerificationRequest(request("request-3", "a".repeat(40)))).toEqual(request("request-1"));
    const otherPrincipalRequest = { ...request("request-4"), requestedBy: "owner-2" };
    expect(second.createOrReplayRemoteVerificationRequest(otherPrincipalRequest)).toEqual(otherPrincipalRequest);

    first.close();
    secondConnection.close();
    const database = new Database(path, { readonly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_verification_requests").get()).toEqual({ count: 2 });
    database.close();
  });

  it("persists revocation and lets the service return a stable authorization error", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    store.saveRemotePrincipalProjectGrant({
      principalId: "owner-1",
      projectId: "project-1",
      permissions: ["read"],
      revokedAt: "2026-09-11T00:02:00.000Z",
    }, "agent:admin");

    const service = new RemoteVerificationService(store);
    expect(() => service.submit({
      projectId: "project-1",
      workerId: "worker-1",
      commitSha: SHA,
      presetId: "node:test",
      idempotencyKey: "submission-1",
    }, { principalId: "owner-1" })).toThrowError(expect.objectContaining<Partial<RemoteVerificationError>>({
      code: "project_forbidden",
    }));
    expect(store.getRemotePrincipalProjectGrant("owner-1", "project-1")?.revokedAt).toBe("2026-09-11T00:02:00.000Z");
    store.close();

    const database = new Database(path, { readonly: true });
    const audit = database.prepare(`
      SELECT actor, details_json FROM controller_audit_events
      WHERE event_type = 'remote.principal_project_grant_saved'
      ORDER BY id DESC LIMIT 1
    `).get() as { actor: string; details_json: string };
    expect(audit.actor).toBe("agent:admin");
    expect(JSON.parse(audit.details_json)).toMatchObject({
      principalId: "owner-1",
      projectId: "project-1",
      revokedAt: "2026-09-11T00:02:00.000Z",
    });
    database.close();
  });

  it("keeps security-sensitive identity bindings immutable", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    store.saveRemotePrincipal(
      { id: "other-worker-principal", kind: "worker", status: "active" },
      "local-user",
    );

    expect(() => store.saveRemotePrincipal({ id: "owner-1", kind: "agent", status: "active" }, "local-user"))
      .toThrow("Nie można zmienić rodzaju istniejącej tożsamości zdalnej.");
    expect(() => store.saveRemoteProjectIdentity({
      id: "project-1", name: "Project", sourceRemote: "upstream", status: "active",
    }, "local-user")).toThrow("Nie można zmienić źródłowego remote istniejącego projektu zdalnego.");
    expect(() => store.saveRemoteWorker({
      id: "worker-1",
      principalId: "other-worker-principal",
      name: "Worker",
      status: "active",
      lastContactAt: null,
    }, "local-user")).toThrow("Nie można zmienić tożsamości istniejącego workera zdalnego.");
    expect(() => store.saveRemoteWorker({
      id: "worker-2",
      principalId: "worker-principal-1",
      name: "Other worker",
      status: "active",
      lastContactAt: null,
    }, "local-user")).toThrow("Tożsamość zdalna jest już przypisana do innego workera.");

    expect(store.getRemotePrincipal("owner-1")?.kind).toBe("owner");
    expect(store.getRemoteProjectIdentity("project-1")?.sourceRemote).toBe("origin");
    expect(store.getRemoteWorker("worker-1")?.principalId).toBe("worker-principal-1");
    store.close();
  });

  it("cancels admitted work before removing its local worker mapping", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    const localProjectId = provision(store);
    const accepted = new RemoteVerificationService(store, () => "2026-09-11T00:00:00.000Z", () => "request-1")
      .submit({
        projectId: "project-1",
        workerId: "worker-1",
        commitSha: SHA,
        presetId: "node:test",
        idempotencyKey: "submission-1",
      }, { principalId: "owner-1" });

    store.removeProject(localProjectId, "local-user");

    expect(store.getRemoteWorkerProjectGrant("worker-1", "project-1")).toBeNull();
    expect(store.getRemoteProjectIdentity("project-1")).not.toBeNull();
    expect(store.findRemoteVerificationRequestByIdempotency("owner-1", "submission-1")).toEqual({
      ...accepted,
      phase: "cancelled",
      updatedAt: expect.any(String),
    });
    store.close();
  });

  it("atomically replays one assignment across raw persistence connections", () => {
    const path = databasePath();
    const first = new SqliteStateStore(path);
    provision(first);
    const accepted = submit(first);
    expect(() => new SqliteStateStore(path)).toThrow("already running");
    const secondConnection = new Database(path);
    const second = new RemoteVerificationQueries(secondConnection);
    const firstService = attemptService(first, ["2026-09-11T00:01:00.000Z"], ["attempt-1"]);
    const secondService = attemptService(second, ["2026-09-11T00:02:00.000Z"], ["attempt-2"]);

    const assigned = firstService.assign({ requestId: accepted.id, workerId: "worker-1" });
    expect(secondService.assign({ requestId: accepted.id, workerId: "worker-1" })).toEqual(assigned);
    expect(first.getRemoteVerificationRequest(accepted.id)?.phase).toBe("assigned");

    first.close();
    secondConnection.close();
    const database = new Database(path, { readonly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_verification_attempts").get()).toEqual({ count: 1 });
    database.close();
  });

  it("rejects stale reports and keeps immutable execution evidence", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const accepted = submit(store);
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
      "2026-09-11T00:04:00.000Z",
    ]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });
    const preparing = service.report({ attemptId: assigned.id, expectedVersion: 1, phase: "preparing" });
    const running = service.report({
      attemptId: assigned.id,
      expectedVersion: preparing.version,
      phase: "running",
      localRunId: "local-run-1",
      executedCommitSha: SHA,
    });

    expectAttemptCode(
      () => service.report({ attemptId: assigned.id, expectedVersion: 1, phase: "cancel_requested" }),
      "stale_attempt",
    );
    expectAttemptCode(() => service.report({
      attemptId: assigned.id,
      expectedVersion: running.version,
      phase: "succeeded",
      localRunId: "other-run",
    }), "invalid_evidence");
    expect(store.getRemoteVerificationAttempt(assigned.id)).toEqual(running);
    store.close();
  });

  it("rejects a report from an authenticated non-owning worker", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    store.saveRemotePrincipal({ id: "worker-principal-2", kind: "worker", status: "active" }, "local-user");
    store.saveRemoteWorker({
      id: "worker-2",
      principalId: "worker-principal-2",
      name: "Other worker",
      status: "active",
      lastContactAt: null,
    }, "local-user");
    const accepted = submit(store);
    const service = attemptService(store, ["2026-09-11T00:01:00.000Z"]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });

    expectAttemptCode(() => service.reportAs({
      attemptId: assigned.id,
      expectedVersion: assigned.version,
      phase: "preparing",
    }, "worker-principal-2"), "worker_forbidden");
    expect(store.getRemoteVerificationAttempt(assigned.id)).toEqual(assigned);
    store.close();
  });

  it("rejects assignment by an authenticated non-owning worker", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    store.saveRemotePrincipal({ id: "worker-principal-2", kind: "worker", status: "active" }, "local-user");
    store.saveRemoteWorker({
      id: "worker-2",
      principalId: "worker-principal-2",
      name: "Other worker",
      status: "active",
      lastContactAt: null,
    }, "local-user");
    const accepted = submit(store);
    const service = attemptService(store, ["2026-09-11T00:01:00.000Z"]);

    expectAttemptCode(() => service.assignAs({
      requestId: accepted.id,
      workerId: "worker-1",
    }, "worker-principal-2"), "worker_forbidden");
    expect(store.findRemoteVerificationAttemptForRequest(accepted.id)).toBeNull();
    expect(store.getRemoteVerificationRequest(accepted.id)?.phase).toBe("pending");
    store.close();
  });

  it("rejects mismatched commit evidence before it becomes immutable", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const accepted = submit(store);
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
      "2026-09-11T00:04:00.000Z",
    ]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });
    const preparing = service.report({ attemptId: assigned.id, expectedVersion: 1, phase: "preparing" });
    expectAttemptCode(
      () => service.report({
        attemptId: assigned.id,
        expectedVersion: preparing.version,
        phase: "running",
        localRunId: "local-run-1",
        executedCommitSha: "a".repeat(40),
      }),
      "invalid_evidence",
    );
    expect(store.getRemoteVerificationAttempt(assigned.id)).toEqual(preparing);

    const running = service.report({
      attemptId: assigned.id,
      expectedVersion: preparing.version,
      phase: "running",
      localRunId: "local-run-1",
      executedCommitSha: accepted.commitSha,
    });
    const succeeded = service.report({ attemptId: assigned.id, expectedVersion: running.version, phase: "succeeded" });
    expect(succeeded.phase).toBe("succeeded");
    expect(store.getRemoteVerificationRequest(accepted.id)?.phase).toBe("completed");
    store.close();
  });

  it("completes a request whose exact commit uses a 64-character object id", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const sha256 = "b".repeat(64);
    const accepted = submit(store, "request-sha256", sha256);
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
      "2026-09-11T00:04:00.000Z",
    ]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });
    const preparing = service.report({ attemptId: assigned.id, expectedVersion: 1, phase: "preparing" });
    const running = service.report({
      attemptId: assigned.id,
      expectedVersion: preparing.version,
      phase: "running",
      localRunId: "local-run-sha256",
      executedCommitSha: sha256,
    });
    const succeeded = service.report({ attemptId: assigned.id, expectedVersion: running.version, phase: "succeeded" });

    expect(succeeded).toMatchObject({ phase: "succeeded", executedCommitSha: sha256 });
    expect(store.getRemoteVerificationRequest(accepted.id)?.phase).toBe("completed");
    store.close();
  });

  it("does not treat a cancellation request as confirmed termination", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const accepted = submit(store);
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
    ]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });
    const requested = service.report({ attemptId: assigned.id, expectedVersion: 1, phase: "cancel_requested" });
    expect(store.getRemoteVerificationRequest(accepted.id)?.phase).toBe("assigned");
    expect(requested.finishedAt).toBeNull();
    store.close();

    const reopened = new SqliteStateStore(path);
    const recovery = attemptService(reopened, ["2026-09-11T00:03:00.000Z"]);
    expect(recovery.recoverInterruptedAttempts()).toBe(0);
    expect(reopened.getRemoteVerificationAttempt(assigned.id)).toEqual(requested);

    const cancelled = recovery.report({ attemptId: assigned.id, expectedVersion: requested.version, phase: "cancelled" });
    expect(cancelled.finishedAt).toBe("2026-09-11T00:03:00.000Z");
    expect(reopened.getRemoteVerificationRequest(accepted.id)?.phase).toBe("cancelled");
    reopened.close();
  });

  it("preserves a cancellation path when an uncertain project's local mapping is removed", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    const localProjectId = provision(store);
    const accepted = submit(store);
    const service = attemptService(store, ["2026-09-11T00:01:00.000Z", "2026-09-11T00:02:00.000Z"]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });
    service.report({ attemptId: assigned.id, expectedVersion: assigned.version, phase: "preparing" });
    store.close();

    const reopened = new SqliteStateStore(path);
    const recovery = attemptService(reopened, ["2026-09-11T00:03:00.000Z"]);
    expect(recovery.recoverInterruptedAttempts()).toBe(1);
    expect(reopened.getRemoteVerificationAttempt(assigned.id)?.phase).toBe("uncertain");
    reopened.removeProject(localProjectId, "local-user");

    expect(reopened.getRemoteVerificationAttempt(assigned.id)).toMatchObject({
      phase: "cancel_requested",
      version: 4,
      finishedAt: null,
    });
    expect(reopened.getRemoteVerificationRequest(accepted.id)?.phase).toBe("assigned");
    reopened.close();
  });

  it("keeps terminal attempts immutable", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const accepted = submit(store);
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
    ]);
    const assigned = service.assign({ requestId: accepted.id, workerId: "worker-1" });
    const preparing = service.report({ attemptId: assigned.id, expectedVersion: 1, phase: "preparing" });
    const failed = service.report({
      attemptId: assigned.id,
      expectedVersion: preparing.version,
      phase: "failed",
      failureKind: "setup",
      errorCode: "fetch_failed",
    });

    expectAttemptCode(
      () => service.report({ attemptId: failed.id, expectedVersion: failed.version, phase: "preparing" }),
      "invalid_transition",
    );
    expect(store.getRemoteVerificationAttempt(failed.id)).toEqual(failed);
    store.close();
  });

  it("persists setup and execution failure kinds separately", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const firstRequest = submit(store, "request-setup");
    const secondRequest = submit(store, "request-execution");
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
      "2026-09-11T00:04:00.000Z",
      "2026-09-11T00:05:00.000Z",
      "2026-09-11T00:06:00.000Z",
      "2026-09-11T00:07:00.000Z",
    ], ["attempt-setup", "attempt-execution"]);

    const setupAssigned = service.assign({ requestId: firstRequest.id, workerId: "worker-1" });
    const setupPreparing = service.report({ attemptId: setupAssigned.id, expectedVersion: 1, phase: "preparing" });
    const setupFailed = service.report({
      attemptId: setupAssigned.id,
      expectedVersion: setupPreparing.version,
      phase: "failed",
      failureKind: "setup",
      errorCode: "fetch_failed",
    });
    const executionAssigned = service.assign({ requestId: secondRequest.id, workerId: "worker-1" });
    const executionPreparing = service.report({ attemptId: executionAssigned.id, expectedVersion: 1, phase: "preparing" });
    const executionRunning = service.report({
      attemptId: executionAssigned.id,
      expectedVersion: executionPreparing.version,
      phase: "running",
      localRunId: "local-run-2",
      executedCommitSha: SHA,
    });
    const executionFailed = service.report({
      attemptId: executionAssigned.id,
      expectedVersion: executionRunning.version,
      phase: "failed",
      failureKind: "execution",
      errorCode: "test_failed",
    });

    expect(setupFailed).toMatchObject({ failureKind: "setup", errorCode: "fetch_failed" });
    expect(executionFailed).toMatchObject({ failureKind: "execution", errorCode: "test_failed" });
    expect(store.getRemoteVerificationRequest(firstRequest.id)?.phase).toBe("completed");
    expect(store.getRemoteVerificationRequest(secondRequest.id)?.phase).toBe("completed");
    store.close();
  });

  it("marks interrupted work uncertain on explicit restart recovery without changing terminal attempts", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const activeRequest = submit(store, "request-active");
    const terminalRequest = submit(store, "request-terminal");
    const service = attemptService(store, [
      "2026-09-11T00:01:00.000Z",
      "2026-09-11T00:02:00.000Z",
      "2026-09-11T00:03:00.000Z",
      "2026-09-11T00:04:00.000Z",
      "2026-09-11T00:05:00.000Z",
    ], ["attempt-active", "attempt-terminal"]);
    const active = service.assign({ requestId: activeRequest.id, workerId: "worker-1" });
    service.report({ attemptId: active.id, expectedVersion: 1, phase: "preparing" });
    const terminal = service.assign({ requestId: terminalRequest.id, workerId: "worker-1" });
    const terminalPreparing = service.report({ attemptId: terminal.id, expectedVersion: 1, phase: "preparing" });
    service.report({
      attemptId: terminal.id,
      expectedVersion: terminalPreparing.version,
      phase: "failed",
      failureKind: "setup",
      errorCode: "clone_failed",
    });
    store.close();

    const reopened = new SqliteStateStore(path);
    const recovery = attemptService(reopened, ["2026-09-11T00:10:00.000Z"]);
    expect(recovery.recoverInterruptedAttempts()).toBe(1);
    const uncertain = reopened.getRemoteVerificationAttempt(active.id)!;
    expect(uncertain).toMatchObject({
      phase: "uncertain",
      version: 3,
      lastReportedAt: "2026-09-11T00:10:00.000Z",
      finishedAt: null,
    });
    expectAttemptCode(() => recovery.report({
      attemptId: active.id,
      expectedVersion: 2,
      phase: "running",
      localRunId: "local-run-active",
      executedCommitSha: SHA,
    }), "stale_attempt");
    expect(recovery.report({
      attemptId: active.id,
      expectedVersion: uncertain.version,
      phase: "running",
      localRunId: "local-run-active",
      executedCommitSha: SHA,
    })).toMatchObject({ phase: "running", version: 4 });
    expect(reopened.getRemoteVerificationAttempt(terminal.id)).toMatchObject({
      phase: "failed",
      failureKind: "setup",
    });
    expect(reopened.getRemoteVerificationRequest(activeRequest.id)?.phase).toBe("assigned");
    expect(reopened.getRemoteVerificationRequest(terminalRequest.id)?.phase).toBe("completed");
    reopened.close();
  });

  it("revalidates worker grants while assigning an attempt", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    provision(store);
    const accepted = submit(store);
    store.saveRemoteWorkerProjectGrant({
      ...store.getRemoteWorkerProjectGrant("worker-1", "project-1")!,
      revokedAt: "2026-09-11T00:01:00.000Z",
    }, "local-user");
    const service = attemptService(store, ["2026-09-11T00:02:00.000Z"]);

    expectAttemptCode(() => service.assign({ requestId: accepted.id, workerId: "worker-1" }), "worker_forbidden");
    expect(store.findRemoteVerificationAttemptForRequest(accepted.id)).toBeNull();
    store.close();
  });

  it("repairs the launch preset when upgrading a database from the pre-merge remote branch", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    const projectId = provision(store);
    store.close();

    const branchDatabase = new Database(path);
    stripMigrationProvenance(branchDatabase);
    branchDatabase.exec(`
      DELETE FROM schema_migrations WHERE version >= 15;
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (13, 'now'), (14, 'now');
      ALTER TABLE projects DROP COLUMN launch_preset;
    `);
    branchDatabase.close();

    const upgraded = new SqliteStateStore(path);
    expect(upgraded.getProject(projectId)?.launchPreset).toBe("auto");
    upgraded.close();

    const inspected = new Database(path, { readonly: true });
    expect(inspected.prepare("SELECT 1 FROM schema_migrations WHERE version = 15").get()).toBeTruthy();
    inspected.close();
  });

  it("records and safely replays remote verification migrations", () => {
    const path = databasePath();
    new SqliteStateStore(path).close();
    const first = new Database(path);
    expect(first.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").get()).toBeTruthy();
    expect(first.prepare("SELECT 1 FROM schema_migrations WHERE version = 14").get()).toBeTruthy();
    expect(first.prepare("SELECT 1 FROM schema_migrations WHERE version = 15").get()).toBeTruthy();
    stripMigrationProvenance(first);
    first.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
    first.close();

    new SqliteStateStore(path).close();
    const replayed = new Database(path, { readonly: true });
    expect(replayed.prepare("SELECT version FROM schema_migrations WHERE version IN (14, 15) ORDER BY version").all())
      .toEqual([{ version: 14 }, { version: 15 }]);
    expect(replayed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'remote_verification_requests'").get())
      .toEqual({ name: "remote_verification_requests" });
    expect(replayed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'remote_verification_attempts'").get())
      .toEqual({ name: "remote_verification_attempts" });
    replayed.close();
  });
});
