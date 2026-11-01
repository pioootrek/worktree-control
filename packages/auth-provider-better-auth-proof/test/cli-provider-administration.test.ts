import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthCommand } from "@/cli/auth-management";
import { AdminRequestError } from "@/server/admin-socket";
import { FileProviderConfiguration } from "@/server/authentication-provider-configuration";
import { SqliteStateStore } from "@/server/infrastructure/sqlite";
import { loadAuthenticationProvider, ProviderKnowledgeApplication } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { KnowledgeService } from "@/server/modules/knowledge";
import { Client, count, OWNER_EMAIL, OWNER_PASSWORD, readCommitted } from "./fixture";
import { cliFixture, onlineCliFixture } from "./cli-provider-fixture";
import { gate } from "./strict-fixture";
import type { ProofFaultInjection } from "../src/index";

afterEach(() => vi.restoreAllMocks());
const enrollment = { email: OWNER_EMAIL, name: "Owner", password: OWNER_PASSWORD };
const nextPassword = "fixture-new-cli-password-2";
const rows = (path: string, table: string) => readCommitted(path, db => db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all());
let peer = 1;
const client = (f: Awaited<ReturnType<typeof onlineCliFixture>>) => new Client(f.runtime(), `198.19.0.${peer++}`);

describe("protected CLI provider administration against actual SQLite/Better Auth", () => {
  it("runs offline without listeners, creates only a stable principal, enrolls, recovers and reopens preserved material", async () => {
    const f = cliFixture();
    try {
      await f.configure(); const principalId = await f.create();
      const material = readFileSync(join(f.paths.dataDirectory, "authentication-provider.json"));
      for (const table of ["principal_credentials", "knowledge_project_grants", "knowledge_role_bindings", "authentication_ba_user"]) expect(count(f.paths.databasePath, table)).toBe(0);
      expect(await f.run(["status", "--principal-id", principalId])).toMatchObject({ maintenance: "not_loaded", principal: { id: principalId, enrollment: "absent" } });
      await expect(f.create()).rejects.toMatchObject({ code: "owner_already_initialized" });
      await f.run(["enroll", "--principal-id", principalId, ...f.input(enrollment)]);
      const user = rows(f.paths.databasePath, "authentication_ba_user"), account = rows(f.paths.databasePath, "authentication_ba_account");
      await f.run(["recover", "--principal-id", principalId, ...f.input({ newPassword: nextPassword })]);
      expect(rows(f.paths.databasePath, "authentication_ba_user")).toEqual(user);
      expect(rows(f.paths.databasePath, "authentication_ba_account").map(row => (row as { id: string }).id)).toEqual(account.map(row => (row as { id: string }).id));
      expect(readFileSync(join(f.paths.dataDirectory, "authentication-provider.json"))).toEqual(material);
      expect(existsSync(f.paths.adminSocketPath)).toBe(false); expect(existsSync(f.paths.controllerLockPath)).toBe(false);
      expect(existsSync(`${f.paths.databasePath}.owner.lock`)).toBe(false);
      const store = new SqliteStateStore(f.paths.databasePath), config = new FileProviderConfiguration(join(f.paths.dataDirectory, "authentication-provider.json")).read()!;
      const runtime = await loadAuthenticationProvider({ entry: config.entry, providerId: "better-auth", storage: store.authenticationProviderStorage(),
        options: { baseURL: config.baseURL, secret: config.secret, clientIpHeader: "x-worktree-control-client-ip" } });
      try {
        expect((await new Client(runtime, "198.19.1.1").signIn()).status).toBe(401);
        expect((await new Client(runtime, "198.19.1.2").signIn(nextPassword)).status).toBe(200);
      } finally { await runtime.dispose(); await store.closeAfterDrain(); }
    } finally { f.remove(); }
  });

  it.each(["open", "token"] as const)("uses the online owner, shares lazy initialization and leaves active/pending %s authority unchanged", async mode => {
    const held = gate();
    const f = await onlineCliFixture({ mode, beforeLoad: () => held.opened });
    try {
      const initial = await f.runCore(() => f.authentication.status());
      await f.runCore(() => f.authentication.setMode(mode === "open" ? "token" : "open", "fixture"));
      const pending = await f.runCore(() => f.authentication.status());
      expect((await f.run(["status"])).maintenance).toBe("not_loaded"); expect(f.loads()).toBe(0);
      const enrollmentCall = f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      await vi.waitFor(() => expect(f.loads()).toBe(1));
      const second = f.run(["recover", "--principal-id", "missing-owner", ...f.input({ newPassword: nextPassword })]).catch(error => error);
      held.open(); await enrollmentCall; expect(await second).toMatchObject({ code: "not_linked" });
      expect(f.loads()).toBe(1); expect(await f.runCore(() => f.authentication.status())).toEqual(pending);
      expect(initial.activeMode).toBe(mode);
      if (mode === "token") expect(await f.runCore(() => f.authentication.authenticateInstallation(f.token))).not.toBeNull();
      expect((await f.run(["status", "--principal-id", f.principalId])).principal).toEqual({ id: f.principalId, kind: "owner", status: "active", enrollment: "active" });
      expect(() => new SqliteStateStore(f.paths.databasePath)).toThrow();
      await expect(f.runCore(() => f.authentication.setMode("better-auth", "fixture"))).rejects.toMatchObject({ code: "auth_provider_unavailable" });
      await f.configure("https://next.test", "preserve");
      expect(await f.run(["status"])).toMatchObject({ maintenance: "ready", configurationRestartRequired: true });
      await expect(f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword })])).rejects.toMatchObject({ code: "provider_configuration_restart_required" });
      expect(f.loads()).toBe(1);
    } finally { held.open(); await f.close(); }
  });

  it("rolls back real enrollment after a user write, preserves principal, then permits an explicit healthy retry", async () => {
    const faults: ProofFaultInjection = { afterProvisionedUser: async () => { throw new Error("sentinel-private-password"); } }, f = await onlineCliFixture({ faults });
    try {
      const before = rows(f.paths.databasePath, "controller_audit_events");
      await expect(f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)])).rejects.toMatchObject({ code: "provider_failed" });
      expect(count(f.paths.databasePath, "authentication_ba_user")).toBe(0); expect(count(f.paths.databasePath, "authentication_ba_account")).toBe(0);
      expect(count(f.paths.databasePath, "authentication_provider_subjects")).toBe(0);
      expect(rows(f.paths.databasePath, "controller_audit_events")).toEqual(before);
      expect(await f.runCore(() => f.store.getPrincipal(f.principalId))).toMatchObject({ status: "active" });
      faults.afterProvisionedUser = undefined;
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      await expect(f.run(["enroll", "--principal-id", f.principalId, ...f.input({ ...enrollment, password: nextPassword })])).rejects.toMatchObject({ code: "subject_conflict" });
      await f.runtime().revokeSubject({ principalId: f.principalId, actor: "fixture" });
      expect(await f.run(["status", "--principal-id", f.principalId])).toMatchObject({ principal: { enrollment: "revoked" } });
      await expect(f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)])).rejects.toMatchObject({ code: "subject_conflict" });
      await expect(f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword })])).rejects.toMatchObject({ code: "not_linked" });
      expect(f.loads()).toBe(1);
    } finally { await f.close(); }
  });

  it("recovers >100 actual sessions immediately, preserves IDs/grants/tombstones and keeps provider actors unprivileged", async () => {
    const f = await onlineCliFixture();
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      const credentials = [];
      for (let index = 0; index < 101; index++) {
        const c = client(f); expect((await c.signIn()).status).toBe(200); credentials.push(c.cookieHeader());
      }
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(101);
      const identity = new IdentityService(f.store, undefined, undefined, undefined, undefined, f.store, f.runtime());
      const project = await f.runCore(() => {
        const p = { id: "cli-grant", name: "CLI grant", status: "active" as const, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        f.store.saveKnowledgeProject(p, "fixture");
        f.store.saveKnowledgeProjectGrant({ principalId: f.principalId, projectId: p.id, permissions: ["knowledge:read", "knowledge:write"], revokedAt: null }, "fixture");
        return p;
      });
      const before = Object.fromEntries(["remote_principals", "knowledge_project_grants", "knowledge_role_bindings", "principal_credentials", "authentication_provider_subjects"].map(table => [table, rows(f.paths.databasePath, table)]));
      const users = rows(f.paths.databasePath, "authentication_ba_user");
      await f.runCore(() => f.authentication.setMode("token", "fixture"));
      await f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword })]);
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(0);
      for (const cookie of credentials) expect(await client(f).resolve(cookie)).toBeNull();
      expect((await client(f).signIn()).status).toBe(401);
      const current = client(f); expect((await current.signIn(nextPassword)).status).toBe(200);
      const actor = await f.runtime().authenticate(new Headers({ cookie: current.cookieHeader() }));
      expect(actor).toMatchObject({ principalId: f.principalId, credentialId: null, authenticationMethod: "provider_session" });
      const app = new ProviderKnowledgeApplication(f.store.admission, identity, new KnowledgeService(f.store, identity));
      expect((await app.describeIdentity(actor!)).knowledgeGrants).toEqual([{ projectId: project.id, permissions: ["knowledge:read", "knowledge:write"] }]);
      await expect(f.runCore(() => identity.issueAgentToken({ principalId: "agent", label: "denied" }, actor!))).rejects.toMatchObject({ code: "owner_authentication_required" });
      for (const [table, snapshot] of Object.entries(before)) expect(rows(f.paths.databasePath, table)).toEqual(snapshot);
      expect(rows(f.paths.databasePath, "authentication_ba_user")).toEqual(users);
      await f.runCore(() => f.store.saveKnowledgeRoleBinding({ principalId: f.principalId, projectId: project.id, role: "reader", revision: 1,
        updatedAt: new Date().toISOString(), revokedAt: new Date().toISOString() }, 0, "fixture"));
      await f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: OWNER_PASSWORD })]);
      const relogin = client(f); await relogin.signIn(); const denied = await f.runtime().authenticate(new Headers({ cookie: relogin.cookieHeader() }));
      expect((await app.describeIdentity(denied!)).knowledgeGrants).toEqual([]);
      await expect(app.execute({ operation: "tasks", input: { projectId: project.id } }, denied!)).rejects.toMatchObject({ code: "knowledge_forbidden" });
    } finally { await f.close(); }
  });

  it("rolls back recovery atomically and refuses revoked principals/mappings without reactivation", async () => {
    const faults: ProofFaultInjection = {}, f = await onlineCliFixture({ faults });
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      const c = client(f); await c.signIn(); const before = rows(f.paths.databasePath, "controller_audit_events");
      faults.beforeRecoveryCommit = async () => { throw new Error("sentinel-recovery-password"); };
      await expect(f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword })])).rejects.toMatchObject({ code: "provider_failed" });
      expect(await c.resolve()).not.toBeNull(); expect((await client(f).signIn()).status).toBe(200);
      expect(rows(f.paths.databasePath, "controller_audit_events")).toEqual(before);
      faults.beforeRecoveryCommit = undefined;
      await f.runCore(() => f.store.savePrincipal({ id: f.principalId, kind: "owner", status: "revoked" }, "fixture"));
      const accounts = rows(f.paths.databasePath, "authentication_ba_account"), sessions = rows(f.paths.databasePath, "authentication_ba_session");
      await expect(f.run(["recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword })])).rejects.toMatchObject({ code: "principal_unavailable" });
      expect(rows(f.paths.databasePath, "authentication_ba_account")).toEqual(accounts); expect(rows(f.paths.databasePath, "authentication_ba_session")).toEqual(sessions);
      await expect(f.create()).rejects.toMatchObject({ code: "owner_already_initialized" });
    } finally { await f.close(); }
  });

  it("transports committed notifier failure through actual socket and CLI without replay or sentinel disclosure", async () => {
    let invalidationCalls = 0;
    const f = await onlineCliFixture({ onInvalidation: () => { invalidationCalls++; throw new Error("sentinel-signing-secret"); } });
    try {
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      const c = client(f); await c.signIn();
      const writes: string[] = [];
      const error = await runAuthCommand(["provider", "recover", "--principal-id", f.principalId, ...f.input({ newPassword: nextPassword })], f.paths,
        { write: value => writes.push(value) }).catch(error => error);
      expect(error).toBeInstanceOf(AdminRequestError); expect(error).toMatchObject({ code: "invalidation_failed", committed: true });
      expect(String(error)).not.toContain("sentinel"); expect(writes).toEqual([]);
      expect(count(f.paths.databasePath, "authentication_ba_session")).toBe(0); expect(await c.resolve()).toBeNull();
      expect(invalidationCalls).toBeGreaterThan(0);
      expect(rows(f.paths.databasePath, "controller_audit_events").filter(row => (row as { event_type: string }).event_type === "authentication.provider.password_recovered")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("does not regenerate absent configuration when an installation already has provider data", async () => {
    const f = cliFixture();
    try {
      await f.configure(); const id = await f.create(); await f.run(["enroll", "--principal-id", id, ...f.input(enrollment)]);
      rmSync(join(f.paths.dataDirectory, "authentication-provider.json"));
      await expect(f.configure()).rejects.toMatchObject({ code: "configuration_restore_required" });
      await expect(f.run(["recover", "--principal-id", id, ...f.input({ newPassword: nextPassword })])).rejects.toMatchObject({ code: "configuration_missing" });
      expect(existsSync(join(f.paths.dataDirectory, "authentication-provider.json"))).toBe(false);
    } finally { f.remove(); }
  });

  it("reports ambiguous historical owners honestly, refuses wrong principal kinds and never maps duplicate email", async () => {
    const f = await onlineCliFixture();
    try {
      await f.runCore(() => {
        f.store.savePrincipal({ id: "historical-owner", kind: "owner", status: "active" }, "fixture");
        f.store.savePrincipal({ id: "machine-agent", kind: "agent", status: "active" }, "fixture");
      });
      expect(await f.run(["status"])).toMatchObject({ owner: { state: "ambiguous" } });
      expect((await f.run(["status"])).owner).not.toHaveProperty("principal");
      await expect(f.run(["enroll", "--principal-id", "machine-agent", ...f.input(enrollment)])).rejects.toMatchObject({ code: "principal_unavailable" });
      await f.run(["enroll", "--principal-id", f.principalId, ...f.input(enrollment)]);
      await expect(f.run(["enroll", "--principal-id", "historical-owner", ...f.input(enrollment)])).rejects.toMatchObject({ code: "provider_failed" });
      expect(await f.run(["status", "--principal-id", "historical-owner"])).toMatchObject({ principal: { enrollment: "absent" } });
      expect(count(f.paths.databasePath, "authentication_ba_user")).toBe(1); expect(count(f.paths.databasePath, "authentication_provider_subjects")).toBe(1);
      await expect(f.create()).rejects.toMatchObject({ code: "owner_already_initialized" });
    } finally { await f.close(); }
  });
});
