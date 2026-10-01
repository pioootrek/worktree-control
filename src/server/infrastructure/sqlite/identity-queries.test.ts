import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { IdentityService, type CredentialAuthenticationRecord } from "@/server/modules/identity";
import { SqliteStateStore } from "./index";

const directories: string[] = [];
const NOW = "2026-09-13T12:00:00.000Z";
const OWNER_CREDENTIAL_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_TOKEN = `wts_${OWNER_CREDENTIAL_ID}_${"a".repeat(64)}`;

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "worktree-switcher-identity-"));
  directories.push(directory);
  return join(directory, "state.sqlite3");
}

function ownerCredential(): CredentialAuthenticationRecord {
  return {
    id: OWNER_CREDENTIAL_ID,
    principalId: "owner-1",
    kind: "owner_session",
    label: "Owner session",
    tokenPrefix: "wts_owner",
    verifierHash: createHash("sha256").update(OWNER_TOKEN).digest("hex"),
    status: "active",
    expiresAt: null,
    createdAt: NOW,
    revokedAt: null,
    lastUsedAt: null,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("identity and knowledge access SQLite persistence", () => {
  it("applies the K1 migration to an existing controller database without replacing principals", () => {
    const path = databasePath();
    const initial = new SqliteStateStore(path);
    initial.saveRemotePrincipal({ id: "agent-before-k1", kind: "agent", status: "active" }, "bootstrap");
    initial.close();

    const legacy = new Database(path);
    legacy.exec(`
      DROP TABLE knowledge_project_runtime_links;
      DROP TABLE knowledge_project_grants;
      DROP TABLE knowledge_projects;
      DROP TABLE principal_credentials;
      DELETE FROM schema_migrations WHERE version >= 17;
    `);
    legacy.close();

    const migrated = new SqliteStateStore(path);
    expect(migrated.getPrincipal("agent-before-k1")).toEqual({
      id: "agent-before-k1", kind: "agent", status: "active",
    });
    migrated.saveKnowledgeProject({
      id: "knowledge-after-k1", name: "Migrated", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW,
    }, "bootstrap");
    expect(migrated.getKnowledgeProject("knowledge-after-k1")?.name).toBe("Migrated");
    migrated.close();
  });

  it("scrubs legacy display prefixes that contained token secret bytes", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    store.savePrincipal({ id: "owner-1", kind: "owner", status: "active" }, "bootstrap");
    store.saveCredential({ ...ownerCredential(), tokenPrefix: `wts_${OWNER_CREDENTIAL_ID}_aaaaaaaa` }, "bootstrap");
    store.close();

    const legacy = new Database(path);
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= 18").run();
    legacy.close();

    const migrated = new SqliteStateStore(path);
    expect(migrated.listPrincipalCredentials("owner-1")[0]?.tokenPrefix).toBe(`wts_${OWNER_CREDENTIAL_ID}`);
    migrated.close();
  });

  it("persists principals, credentials and project-scoped grants without returning verifiers", () => {
    const path = databasePath();
    const store = new SqliteStateStore(path);
    store.savePrincipal({ id: "owner-1", kind: "owner", status: "active" }, "bootstrap");
    store.savePrincipal({ id: "agent-1", kind: "agent", status: "active" }, "owner-1");
    store.saveCredential(ownerCredential(), "bootstrap");
    store.saveKnowledgeProject({
      id: "knowledge-a", name: "Knowledge A", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW,
    }, "owner-1");
    store.saveKnowledgeProjectGrant({
      principalId: "agent-1", projectId: "knowledge-a", permissions: ["knowledge:write", "knowledge:read"], revokedAt: null,
    }, "owner-1");

    expect(store.getRemotePrincipal("agent-1")).toEqual(store.getPrincipal("agent-1"));
    expect(store.getOwnerPrincipal()).toEqual({ id: "owner-1", kind: "owner", status: "active" });
    expect(store.listPrincipals("agent")).toEqual([{ id: "agent-1", kind: "agent", status: "active" }]);
    expect(store.listPrincipalCredentials("owner-1")).toEqual([expect.not.objectContaining({ verifierHash: expect.anything() })]);
    expect(store.getKnowledgeProjectGrant("agent-1", "knowledge-a")?.permissions)
      .toEqual(["knowledge:read", "knowledge:write"]);
    expect(store.listKnowledgeProjectGrants("agent-1")).toEqual([{
      principalId: "agent-1",
      projectId: "knowledge-a",
      permissions: ["knowledge:read", "knowledge:write"],
      revokedAt: null,
    }]);
    store.close();

    const database = new Database(path, { readonly: true });
    const serialized = JSON.stringify(database.prepare("SELECT * FROM principal_credentials").all())
      + JSON.stringify(database.prepare("SELECT * FROM controller_audit_events").all());
    expect(serialized).not.toContain(OWNER_TOKEN);
    expect(serialized).not.toContain("a".repeat(64));
    database.close();
  });

  it("revokes an already authenticated credential without restarting", () => {
    const store = new SqliteStateStore(databasePath());
    store.savePrincipal({ id: "owner-1", kind: "owner", status: "active" }, "bootstrap");
    store.saveCredential(ownerCredential(), "bootstrap");
    store.saveKnowledgeProject({
      id: "knowledge-a", name: "Knowledge A", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW,
    }, "owner-1");
    store.saveKnowledgeProjectGrant({
      principalId: "owner-1", projectId: "knowledge-a", permissions: ["knowledge:read"], revokedAt: null,
    }, "owner-1");
    const service = new IdentityService(store, () => NOW);
    const actor = service.authenticateBearer(OWNER_TOKEN);
    service.authorizeKnowledge(actor, "knowledge-a", "knowledge:read");

    expect(store.revokeCredential(OWNER_CREDENTIAL_ID, NOW, "owner-1")).toBe(true);
    expect(() => service.authorizeKnowledge(actor, "knowledge-a", "knowledge:read"))
      .toThrowError(expect.objectContaining({ code: "invalid_credential" }));
    store.close();
  });

  it("keeps a knowledge project and records detachment when its runtime project is removed", () => {
    const store = new SqliteStateStore(databasePath());
    const runtime = store.addProject({
      name: "Runtime", repositoryPath: "/code/runtime", port: 3210, executable: "pnpm", args: ["run", "dev"],
    });
    store.saveKnowledgeProject({
      id: "knowledge-a", name: "Knowledge A", status: "active", revision: 1, createdAt: NOW, updatedAt: NOW,
    }, "owner-1");
    store.saveKnowledgeProjectRuntimeLink({
      projectId: "knowledge-a", runtimeProjectId: runtime.id, linkedAt: NOW, unlinkedAt: null,
    }, "owner-1");

    store.removeProject(runtime.id, "owner-1");
    expect(store.getKnowledgeProject("knowledge-a")).toMatchObject({ id: "knowledge-a", revision: 1 });
    expect(store.getKnowledgeProjectRuntimeLink("knowledge-a")).toEqual({
      projectId: "knowledge-a", runtimeProjectId: null, linkedAt: NOW, unlinkedAt: expect.any(String),
    });
    store.close();
  });
});
