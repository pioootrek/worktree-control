import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteStateStore } from "@/server/sqlite-store";
import { AuthenticationService } from "@/server/modules/authentication";
import { IdentityService } from "@/server/modules/identity";
import { BackupOperations, RestoreOperations, backupPolicySchema } from "@/server/modules/backups";
import { createControllerServer } from "@/server/http-server";
import { ControlService } from "@/server/control-service";
import { DirectoryBrowser } from "@/server/directory-browser";
import { EventStream } from "@/server/events";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(actions: Array<"create" | "restore"> = []) {
  const root = mkdtempSync(join(tmpdir(), "backup-http-")), database = join(root, "state.sqlite3"), store = new SqliteStateStore(database), auth = new AuthenticationService(store);
  const token = auth.generateToken("fixture").token;
  const identity = new IdentityService(store, undefined, undefined, undefined, auth);
  let maintenance = false;
  const backups = new BackupOperations(backupPolicySchema.parse({ directory: join(root, "copies"), uiActions: actions }), { databasePath: database, attachmentDirectory: join(root, "attachments"), applicationVersion: "test", source: store, estimateBytes: () => store.backupEstimateBytes(), authorize: actor => auth.isCurrentInstallationActor(actor), maintenance: () => maintenance });
  const restart = vi.fn(async () => {}), restores = new RestoreOperations(backups, database, join(root, "attachments"), { authentication: () => store.getAuthenticationPolicy(), enterMaintenance: () => { maintenance = true; }, restart, failure: vi.fn() });
  const server = createControllerServer({ service: {} as ControlService, webRoot: root, directoryBrowser: {} as DirectoryBrowser, events: new EventStream(), mcpStatus: () => ({ phase: "disabled", activeSessions: 0, endpoint: null, transport: "streamable-http", network: "loopback", authentication: "none" }), host: "127.0.0.1", port: 0, accessToken: "legacy-pairing", identity, authentication: auth, backups, restores, maintenance: () => maintenance });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => store.close(), () => backups.close(), () => server.close());
  const request = (method = "GET", body?: unknown, credential = token, origin = base) => fetch(`${base}/api/backups`, { method, headers: { "X-Worktree-Switcher-Token": credential, "Content-Type": "application/json", origin }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { root, store, auth, identity, token, request, backups, restart, base };
}
it("denies actions by default and refuses all attempts to edit service policy or supply paths", async () => {
  const f = await fixture();
  expect((await f.request()).status).toBe(200);
  expect((await f.request("POST", { action: "create", idempotencyKey: "denied" })).status).toBe(403);
  for (const method of ["PUT", "PATCH", "DELETE"]) expect((await f.request(method, { intervalSeconds: 60 })).status).toBe(405);
  expect((await f.request("POST", { action: "create", idempotencyKey: "bad", directory: "/private" })).status).toBe(400);
  expect(f.backups.policy.intervalSeconds).toBeNull();
});
it("requires a current installation token and exposes no infrastructure paths, secrets or commands", async () => {
  const f = await fixture(["create"]);
  expect((await f.request("GET", undefined, "legacy-pairing")).status).toBe(403);
  const owner = f.identity.bootstrapOwnerSession();
  expect((await f.request("GET", undefined, owner.token)).status).toBe(403);
  f.auth.setMode("open", "fixture");
  expect((await f.request()).status).toBe(403);
  f.auth.setMode("token", "fixture");
  const data = await (await f.request()).text();
  expect(data).not.toContain(f.root); expect(data).not.toContain(f.token); expect(data).not.toContain("verifierHash");
  f.auth.rotateToken("fixture"); expect((await f.request()).status).toBe(403);
});
it("coalesces double clicks/lost responses and rejects foreign origins", async () => {
  const f = await fixture(["create"]), input = { action: "create", idempotencyKey: "double" };
  const a = await (await f.request("POST", input)).json(), b = await (await f.request("POST", input)).json();
  expect(b.operationId).toBe(a.operationId); await f.backups.drain();
  expect(f.backups.overview("local-admin").copies).toHaveLength(1);
  const status = await (await f.request("POST", { action: "status", idempotencyKey: "double" })).json();
  expect(status.state).toBe("succeeded");
  expect((await f.request("POST", input, f.token, "https://foreign.test")).status).toBe(403);
});
it("returns the same safe not-found for unknown create and restore keys and still reauthorizes", async () => {
  const f = await fixture(["create", "restore"]);
  const missing = { action: "status", backupId: "backup-00000000-0000-4000-8000-000000000000", idempotencyKey: "unknown" };
  for (const input of [{ action: "status", idempotencyKey: "unknown" }, missing]) {
    const response = await f.request("POST", input);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "backup_invalid", error: "backup_invalid" });
  }
  const created = await (await f.request("POST", { action: "create", idempotencyKey: "copy" })).json();
  await f.backups.drain();
  const accepted = await f.request("POST", { action: "restore", backupId: created.backupId, idempotencyKey: "accepted", confirmation: "replace-entire-installation" });
  expect(accepted.status).toBe(202);
  expect((await f.request("POST", { ...missing, backupId: created.backupId })).status).toBe(404);
  expect((await f.request("POST", missing, "legacy-pairing")).status).toBe(403);
  f.auth.rotateToken("fixture");
  expect((await f.request("POST", missing)).status).toBe(403);
});
it("requires explicit whole-installation confirmation and gates new writes during maintenance", async () => {
  const f = await fixture(["create", "restore"]);
  const result = await (await f.request("POST", { action: "create", idempotencyKey: "create" })).json(); await f.backups.drain();
  const input = { action: "restore", backupId: result.backupId, idempotencyKey: "restore", confirmation: "replace-entire-installation" };
  expect((await f.request("POST", { ...input, confirmation: "yes" })).status).toBe(400);
  const response = await f.request("POST", input); expect(response.status).toBe(202);
  const accepted = await response.json();
  expect((await (await f.request("POST", input)).json()).operationId).toBe(accepted.operationId);
  expect((await f.request("POST", { action: "create", idempotencyKey: "blocked" })).status).toBe(503);
  const write = await fetch(`${f.base}/api/knowledge`, { method: "POST", body: "{}" }); expect(write.status).toBe(503);
  expect(f.store.listProjects()).toEqual([]);
});
it("keeps HTTP responsive during preview and denies an overlapping validation", async () => {
  const f = await fixture(["create", "restore"]);
  const created = f.backups.create("local-admin", "responsive"); await f.backups.drain();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verify = f.backups.catalog.verifyAsync.bind(f.backups.catalog);
  const validation = vi.spyOn(f.backups.catalog, "verifyAsync").mockImplementation(async id => { await gate; return verify(id); });
  const pending = f.request("POST", { action: "preview", backupId: created.backupId });
  await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
  expect((await f.request()).status).toBe(200);
  expect((await f.request("POST", { action: "preview", backupId: created.backupId })).status).toBe(503);
  release(); expect((await pending).status).toBe(200);
});
it("launches durable restore even when the client disconnects during validation", async () => {
  const f = await fixture(["create", "restore"]);
  const created = f.backups.create("local-admin", "disconnect"); await f.backups.drain();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const verify = f.backups.catalog.verifyAsync.bind(f.backups.catalog);
  const validation = vi.spyOn(f.backups.catalog, "verifyAsync").mockImplementation(async id => { await gate; return verify(id); });
  const abort = new AbortController();
  const pending = fetch(`${f.base}/api/backups`, { method: "POST", signal: abort.signal, headers: { "X-Worktree-Switcher-Token": f.token, origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", backupId: created.backupId, idempotencyKey: "lost-during-validation", confirmation: "replace-entire-installation" }) }).catch(error => error);
  await vi.waitFor(() => expect(validation).toHaveBeenCalledOnce());
  abort.abort(); await pending; release();
  await vi.waitFor(() => expect(f.restart).toHaveBeenCalledOnce(), { timeout: 3000 });
  const status = await (await f.request("POST", { action: "status", backupId: created.backupId, idempotencyKey: "lost-during-validation" })).json();
  expect(status.state).toBe("maintenance");
});
