import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { acquireControllerLock } from "../server/controller-lock";
import { resolveAppPaths } from "../server/paths";
import { runAuthCommand } from "./auth-management";
import { runIdentityCommand } from "./identity-management";
import { writeServiceAccess } from "./service-access";

const directories: string[] = [];

function paths() {
  const root = mkdtempSync(join(tmpdir(), "worktree-switcher-identity-cli-"));
  directories.push(root);
  return resolveAppPaths(join(root, "data"), join(root, "state"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("identity management CLI", () => {
  it("prints the first owner token once and never persists the raw value", async () => {
    const appPaths = paths();
    const output: string[] = [];
    await runIdentityCommand(["bootstrap-owner", "--label", "Local owner", "--lifetime-seconds", "300"], appPaths, {
      write: (line) => output.push(line),
    });

    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0]!) as { principalId: string; credential: { expiresAt: string }; token: string };
    expect(result.token).toMatch(/^wts_[0-9a-f-]{36}_[0-9a-f]{64}$/);
    expect(Date.parse(result.credential.expiresAt)).toBeGreaterThan(Date.now());

    const database = new Database(appPaths.databasePath, { readonly: true });
    const persisted = JSON.stringify(database.prepare("SELECT * FROM principal_credentials").all())
      + JSON.stringify(database.prepare("SELECT * FROM controller_audit_events").all());
    expect(persisted).not.toContain(result.token);
    database.close();
    await expect(runIdentityCommand(["bootstrap-owner"], appPaths)).rejects.toThrow("Właściciel został już zainicjalizowany");
  });

  it("lets the installation token administer identity offline in token mode", async () => {
    const appPaths = paths();
    const generated: string[] = [];
    await runAuthCommand(["token", "generate"], appPaths, { write: (line) => generated.push(line) });
    const { token } = JSON.parse(generated[0]!) as { token: string };
    const output: string[] = [];
    await runIdentityCommand(["create-knowledge-project", "--name", "Installation"], appPaths, {
      write: (line) => output.push(line),
      environment: { WORKTREE_SWITCHER_TOKEN: token },
    });
    expect((JSON.parse(output[0]!) as { project: { name: string } }).project.name).toBe("Installation");
    await expect(runIdentityCommand(["list-agents"], appPaths, { environment: {} })).rejects.toThrow("WORKTREE_SWITCHER_TOKEN");
  });

  it("administers identity offline in open mode without token variables and rejects again in token mode", async () => {
    const appPaths = paths();
    const status: string[] = [];
    await runAuthCommand(["token", "generate"], appPaths, { write: (line) => status.push(line) });
    const { token } = JSON.parse(status[0]!) as { token: string };
    await runAuthCommand(["mode", "set", "open"], appPaths, { write: () => {} });
    const output: string[] = [];
    const anonymous = { environment: {}, write: (line: string) => output.push(line) };
    await runIdentityCommand(["create-agent"], appPaths, anonymous);
    const agent = (JSON.parse(output.pop()!) as { principal: { id: string } }).principal;
    await runIdentityCommand(["create-knowledge-project", "--name", "Open"], appPaths, anonymous);
    const project = (JSON.parse(output.pop()!) as { project: { id: string } }).project;
    await runIdentityCommand(["grant-knowledge", "--principal-id", agent.id, "--project-id", project.id, "--permissions", "knowledge:read"], appPaths, anonymous);
    await runIdentityCommand(["issue-agent-token", "--principal-id", agent.id, "--label", "Open"], appPaths, anonymous);
    const issued = JSON.parse(output.pop()!) as { credential: { id: string }; token: string };

    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      await expect(runIdentityCommand(["list-agents"], appPaths, anonymous)).rejects.toThrow("already running");
    } finally {
      lock.release();
    }

    await runAuthCommand(["mode", "set", "token"], appPaths, { write: () => {} });
    await expect(runIdentityCommand(["list-agents"], appPaths, { environment: {} })).rejects.toThrow("WORKTREE_SWITCHER_OWNER_TOKEN");
    await expect(runIdentityCommand(["list-agents"], appPaths, { environment: { WORKTREE_SWITCHER_TOKEN: `${token}0` } })).rejects.toThrow("Nieprawidłowe lub nieaktywne");
    await expect(runIdentityCommand(["list-agents"], appPaths, { environment: { WORKTREE_SWITCHER_OWNER_TOKEN: issued.token } })).rejects.toThrow("sesji właściciela");
    await runIdentityCommand(["list-agents"], appPaths, { environment: { WORKTREE_SWITCHER_TOKEN: token }, write: (line) => output.push(line) });
    expect(JSON.parse(output.pop()!)).toEqual({ principals: [expect.objectContaining({ id: agent.id })] });
    await runAuthCommand(["token", "rotate"], appPaths, { write: () => {} });
    await expect(runIdentityCommand(["list-agents"], appPaths, { environment: { WORKTREE_SWITCHER_TOKEN: token } })).rejects.toThrow("Nieprawidłowe lub nieaktywne");
  });

  it("respects the singleton lock instead of opening an offline database beside the controller", async () => {
    const appPaths = paths();
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      await expect(runIdentityCommand(["bootstrap-owner"], appPaths)).rejects.toThrow("already running");
    } finally {
      lock.release();
    }
  });

  it("recovers owner access and manages agents, tokens and grants without command-line secrets", async () => {
    const appPaths = paths();
    const output: string[] = [];
    const write = (line: string) => output.push(line);
    await runIdentityCommand(["bootstrap-owner", "--lifetime-seconds", "60"], appPaths, { write });
    const bootstrap = JSON.parse(output.pop()!) as { token: string };
    await runIdentityCommand(["recover-owner", "--label", "Recovered owner", "--lifetime-seconds", "300"], appPaths, { write });
    const recovery = JSON.parse(output.pop()!) as { principalId: string; token: string };
    expect(recovery.token).not.toBe(bootstrap.token);

    const authenticated = { write, environment: { WORKTREE_SWITCHER_OWNER_TOKEN: recovery.token } };
    await runIdentityCommand(["create-agent"], appPaths, authenticated);
    const agent = (JSON.parse(output.pop()!) as { principal: { id: string } }).principal;
    await runIdentityCommand(["create-knowledge-project", "--name", "Shared knowledge"], appPaths, authenticated);
    const project = (JSON.parse(output.pop()!) as { project: { id: string } }).project;
    await runIdentityCommand([
      "grant-knowledge", "--principal-id", agent.id, "--project-id", project.id,
      "--permissions", "knowledge:read,knowledge:write",
    ], appPaths, authenticated);
    expect(JSON.parse(output.pop()!)).toMatchObject({
      grant: { principalId: agent.id, projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] },
    });

    await runIdentityCommand(["issue-agent-token", "--principal-id", agent.id, "--label", "Codex"], appPaths, authenticated);
    const issued = JSON.parse(output.pop()!) as { credential: { id: string }; token: string };
    expect(issued.token).toMatch(/^wts_[0-9a-f-]{36}_[0-9a-f]{64}$/);
    await runIdentityCommand(["list-agent-tokens", "--principal-id", agent.id], appPaths, authenticated);
    const listed = output.pop()!;
    expect(listed).toContain(issued.credential.id);
    expect(listed).not.toContain(issued.token);
    expect(listed).not.toContain("verifierHash");

    await runIdentityCommand(["revoke-token", "--credential-id", issued.credential.id], appPaths, authenticated);
    expect(JSON.parse(output.pop()!)).toEqual({ revoked: true });
    await runIdentityCommand([
      "revoke-knowledge-grant", "--principal-id", agent.id, "--project-id", project.id,
    ], appPaths, authenticated);
    expect(JSON.parse(output.pop()!)).toMatchObject({ grant: { revokedAt: expect.any(String) } });
    await runIdentityCommand(["revoke-agent", "--principal-id", agent.id], appPaths, authenticated);
    expect(JSON.parse(output.pop()!)).toMatchObject({ principal: { id: agent.id, status: "revoked" } });
  });

  it("revokes access through a running controller without acquiring the offline lock", async () => {
    const appPaths = paths();
    const requests: Array<{ authorization?: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ revoked: true }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeServiceAccess(appPaths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: endpoint,
      localDashboardEndpoint: endpoint,
      mcpEndpoint: null,
      accessUrl: `${endpoint}/#token=pairing-token`,
      logDirectory: appPaths.logDirectory,
    });
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      const output: string[] = [];
      await runIdentityCommand(["revoke-token", "--credential-id", "credential-1"], appPaths, {
        environment: { WORKTREE_SWITCHER_OWNER_TOKEN: "owner-token" },
        write: (line) => output.push(line),
      });
      expect(JSON.parse(output[0]!)).toEqual({ revoked: true });
      expect(requests).toEqual([{
        authorization: "Bearer owner-token",
        body: { action: "revoke-token", credentialId: "credential-1" },
      }]);
    } finally {
      lock.release();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bootstraps and renews owner access through a running controller", async () => {
    const appPaths = paths();
    const requests: Array<{ url?: string; authorization?: string; pairing?: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          pairing: request.headers["x-worktree-switcher-token"] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ principalId: "owner-1", token: "new-owner-token" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeServiceAccess(appPaths.serviceAccessPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.0.1",
      dashboardEndpoint: endpoint,
      localDashboardEndpoint: endpoint,
      mcpEndpoint: null,
      accessUrl: `${endpoint}/#token=pairing-token`,
      logDirectory: appPaths.logDirectory,
    });
    const lock = acquireControllerLock(appPaths.controllerLockPath);
    try {
      const output: string[] = [];
      await runIdentityCommand(["bootstrap-owner"], appPaths, { write: (line) => output.push(line) });
      await runIdentityCommand(["renew-owner", "--label", "Rotated"], appPaths, {
        environment: { WORKTREE_SWITCHER_OWNER_TOKEN: "owner-token" },
        write: (line) => output.push(line),
      });
      expect(output).toHaveLength(2);
      expect(requests).toEqual([
        {
          url: "/api/identity/bootstrap", authorization: undefined, pairing: "pairing-token",
          body: {},
        },
        {
          url: "/api/identity/admin", authorization: "Bearer owner-token", pairing: undefined,
          body: { action: "renew-owner", label: "Rotated" },
        },
      ]);
    } finally {
      lock.release();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
