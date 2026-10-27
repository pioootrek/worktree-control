import { afterEach, describe, expect, it } from "vitest";
import { FAKE_DOTENV, vaultFixture } from "@/server/modules/dev-vault/test-fixture";
import { devVaultFailure, executeDevVault } from "@/server/transports/dev-vault";
import type { AuthenticatedPrincipal } from "@/server/modules/identity";
import { OwnerVaultSession } from "./owner-session";
import { listAgentCredentials } from "./vault-client";
import {
  grantState, requestState, VaultClientError, vaultGrantSchema, vaultInspectSchema, vaultListSchema, vaultProfileSchema, vaultReadSchema, vaultRequestSchema, vaultRequestsSchema,
} from "./vault-model";

/** Fake, fixture-only values. No real credential or key material is used. */
const FAKE_VALUE = "FAKE_DEV_ONLY_VALUE_987654321";
const FAKE_PATCH = "FAKE_DEV_PATCH_NAME=FAKE_DEV_PATCH_VALUE_123";
let fixture: ReturnType<typeof vaultFixture> | null = null;
afterEach(() => { fixture?.close(); fixture = null; });

/** Routes the browser client's requests to the real controller service, as the HTTP route does. */
function controllerFetch(f: ReturnType<typeof vaultFixture>) {
  const calls: Array<{ path: string; authorization: string; body: string }> = [];
  let dropNextResponse: "headers" | "body" | null = null;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", Date: new Date(f.now).toUTCString() } });
  const send: typeof fetch = async (input, init) => {
    const path = new URL(String(input), "http://127.0.0.1:3410").pathname;
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ path, authorization, body });
    let actor: AuthenticatedPrincipal;
    try { actor = f.identity.authenticateBearer(authorization.replace(/^Bearer /, "")); } catch { return json(401, { error: "invalid" }); }
    if (path === "/api/identity") return json(200, f.identity.describeIdentity(actor));
    if (path === "/api/identity/admin") return json(200, { credentials: f.identity.listAgentCredentials(JSON.parse(body).principalId, actor) });
    let response: Response;
    try { response = json(200, executeDevVault(f.vault, JSON.parse(body), actor)); }
    catch (error) { const failure = devVaultFailure(error); response = json(failure.status, failure.body); }
    if (dropNextResponse) {
      const mode = dropNextResponse; dropNextResponse = null;
      if (mode === "headers") throw new TypeError("connection reset after commit");
      return new Response(new ReadableStream({ start(stream) { stream.error(new TypeError("body connection reset after commit")); } }), { status: response.status });
    }
    return response;
  };
  return { send, calls, dropNextResponse: (mode: "headers" | "body" = "headers") => { dropNextResponse = mode; } };
}

async function connected(browserOffset = 0, serverMillis = 0) {
  const f = fixture = vaultFixture();
  f.advance(serverMillis);
  const controller = controllerFetch(f);
  const session = new OwnerVaultSession({ fetch: controller.send, now: () => Date.parse(f.now) + browserOffset });
  const pem = f.pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await session.connect(f.ownerToken, pem);
  const run = (intent: string, operation: Parameters<OwnerVaultSession["run"]>[2]) => session.run(f.project.id, intent, operation);
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => error instanceof VaultClientError ? error.code : "other");
  return { f, controller, session, pem, run, code };
}

describe("owner GUI vault flow against the controller service", () => {
  it("requires a real owner session and its matching key before signing anything", async () => {
    const f = fixture = vaultFixture();
    const controller = controllerFetch(f);
    const session = new OwnerVaultSession({ fetch: controller.send, now: () => Date.parse(f.now) });
    const pem = f.pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const reason = (promise: Promise<unknown>) => promise.then(() => "ok", (error: unknown) => error instanceof VaultClientError ? error.code : "other");
    expect(await reason(session.connect(f.first.token, pem))).toBe("not_owner_session");
    expect(await reason(session.connect("wts_not-a-real-token", pem))).toBe("session_invalid");
    expect(session.connected).toBe(false);
    expect(await reason(session.run(f.project.id, "list", { operation: "list" }))).toBe("locked");
    // A key that does not match the controller's verifier connects locally but every operation is denied.
    const wrongKey = (await import("node:crypto")).generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await session.connect(f.ownerToken, wrongKey);
    expect(await reason(session.run(f.project.id, "list", { operation: "list" }))).toBe("vault_denied");
    expect(controller.calls.filter(call => call.path === "/api/dev-vault")).toHaveLength(1);
  });

  it("imports fake DEV values, lists metadata only, and returns values only for an explicit signed read", async () => {
    const { f, controller, run, pem } = await connected();
    const imported = vaultProfileSchema.parse(await run("import", { operation: "import", dotenv: "FAKE_GUI_NAME=FAKE_GUI_VALUE_42" }));
    expect(imported.revision).toBe(1);
    const list = await run("list", { operation: "list" });
    expect(JSON.stringify(list)).not.toContain("FAKE_GUI_VALUE_42");
    expect(JSON.stringify(list)).not.toContain(FAKE_VALUE);
    expect(vaultListSchema.parse(list).profiles.map(profile => profile.profileId).sort()).toEqual([f.imported.profileId, imported.profileId].sort());
    const read = vaultReadSchema.parse(await run(`read:${imported.profileId}:1`, { operation: "read", profileId: imported.profileId, revision: 1 }));
    expect(read.environment).toEqual({ FAKE_GUI_NAME: "FAKE_GUI_VALUE_42" });
    // The private key never leaves the browser; only the owner session is a bearer.
    const pemBody = pem.split("\n").slice(1, -2).join("");
    for (const call of controller.calls) {
      expect(call.body).not.toContain("PRIVATE KEY");
      expect(call.body).not.toContain(pemBody);
      expect(call.authorization).toBe(`Bearer ${f.ownerToken}`);
    }
    // Server parse failures surface only as a fixed code; no line, name or value text.
    const failure = await run("import", { operation: "import", dotenv: "export FAKE_BAD=FAKE_BAD_VALUE" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VaultClientError);
    expect((failure as VaultClientError).code).toBe("vault_invalid_request");
    expect(String((failure as Error).message)).toBe("vault_invalid_request");
  });

  it("inspects a write patch and conservatively marks its timed grant stale after the revision advances", async () => {
    const { f, run, code } = await connected();
    const request = f.request("write", { dotenv: FAKE_PATCH, source: "inline-dotenv" });
    const listed = vaultRequestsSchema.parse(await run("requests", { operation: "requests" }));
    expect(JSON.stringify(listed)).not.toContain("FAKE_DEV_PATCH");
    const pending = listed.requests.find(item => item.id === request.id)!;
    expect(requestState(pending, [{ ...f.imported, createdAt: f.now, updatedAt: f.now }], Date.parse(f.now))).toBe("pending");
    const inspected = vaultInspectSchema.parse(await run(`inspect:${request.id}`, { operation: "inspect-request", requestId: request.id }));
    expect(inspected.proposal).toEqual({ FAKE_DEV_PATCH_NAME: "FAKE_DEV_PATCH_VALUE_123" });
    const grant = vaultGrantSchema.parse(await run("approve", { operation: "approve", requestId: request.id, revision: request.revision, lifetime: "15-minutes" }));
    expect(grant.lifetime).toBe("15-minutes");
    // The agent applies the immutable patch; the second write, even within 15 minutes, conflicts.
    f.execute({ operation: "write", grantId: grant.id }, f.first.actor);
    expect(() => f.execute({ operation: "write", grantId: grant.id }, f.first.actor)).toThrow("vault_conflict");
    const after = vaultRequestsSchema.parse(await run("requests", { operation: "requests" }));
    const profiles = vaultListSchema.parse(await run("list", { operation: "list" })).profiles;
    expect(profiles.find(profile => profile.profileId === f.imported.profileId)!.revision).toBe(2);
    expect(grantState(after.grants.find(item => item.id === grant.id)!, after.requests.find(item => item.id === request.id), profiles, Date.parse(f.now))).toBe("stale");
    // A request whose revision was overtaken by an owner update is stale; approval conflicts.
    const late = vaultRequestSchema.parse(f.request("read", { revision: 2 }));
    await run("update", { operation: "update", profileId: f.imported.profileId, revision: 2, dotenv: "FAKE_OWNER_UPDATE=FAKE_OWNER_VALUE" });
    const updated = vaultListSchema.parse(await run("list", { operation: "list" })).profiles;
    expect(requestState(late, updated, Date.parse(f.now))).toBe("stale");
    expect(await code(run("approve-late", { operation: "approve", requestId: late.id, revision: 2, lifetime: "once" }))).toBe("vault_conflict");
  });

  it.each(["once", "15-minutes", "until-revoked"] as const)("does not claim an unused %s write was applied after an owner update", async lifetime => {
    const { f, run } = await connected();
    const request = f.request("write", { dotenv: FAKE_PATCH, source: "inline-dotenv" });
    const grant = f.approve(request, lifetime);
    await run("update", { operation: "update", ...f.imported, dotenv: "FAKE_OWNER_UPDATE=FAKE_OWNER_VALUE" });
    const after = vaultRequestsSchema.parse(await run("requests", { operation: "requests" }));
    const profiles = vaultListSchema.parse(await run("list", { operation: "list" })).profiles;
    const currentGrant = after.grants.find(item => item.id === grant.id)!;
    expect(currentGrant.consumedBy).toBeNull();
    expect(grantState(currentGrant, after.requests.find(item => item.id === request.id), profiles, Date.parse(f.now))).toBe("stale");
  });

  it("keeps read, write and use independent, and rejects, revokes and expires safely", async () => {
    const { f, run, code, controller, session } = await connected();
    const read = f.request("read"), use = f.request("use", { binding: { commit: "a".repeat(40), presetId: "node:test", commandDigest: "b".repeat(64), workerId: "00000000-0000-4000-8000-0000000000aa" } });
    const rejected = f.request("write", { dotenv: FAKE_PATCH, source: "inline-dotenv" });
    const readGrant = vaultGrantSchema.parse(await run("approve-read", { operation: "approve", requestId: read.id, revision: 1, lifetime: "until-revoked" }));
    const useGrant = vaultGrantSchema.parse(await run("approve-use", { operation: "approve", requestId: use.id, revision: 1, lifetime: "once" }));
    expect(await code(run("reject", { operation: "reject", requestId: rejected.id }))).toBe("ok");
    // A read grant cannot write or use; a use grant never delivers values.
    expect(() => f.execute({ operation: "write", grantId: readGrant.id }, f.first.actor)).toThrow("vault_denied");
    expect(() => f.execute({ operation: "use", ...f.imported, grantId: useGrant.id, binding: (use as unknown as { binding: unknown }).binding }, f.first.actor)).toThrow("vault_use_unavailable");
    expect((f.execute({ operation: "read", ...f.imported, grantId: readGrant.id }, f.first.actor) as { environment: Record<string, string> }).environment).toEqual({ FAKE_DEV_KEY_NAME: FAKE_VALUE });
    // Another credential of a different agent cannot use the grant.
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: readGrant.id }, f.second.actor)).toThrow("vault_denied");
    expect(await code(run("revoke", { operation: "revoke", grantId: readGrant.id }))).toBe("ok");
    expect(() => f.execute({ operation: "read", ...f.imported, grantId: readGrant.id }, f.first.actor)).toThrow("vault_denied");
    // Rejected requests cannot be approved later; expired ones are denied.
    expect(await code(run("approve-rejected", { operation: "approve", requestId: rejected.id, revision: 1, lifetime: "once" }))).toBe("vault_denied");
    const expiring = vaultRequestSchema.parse(f.request("read"));
    f.advance(16 * 60_000);
    expect(requestState(expiring, [{ ...f.imported, createdAt: f.now, updatedAt: f.now }], Date.parse(f.now))).toBe("expired");
    expect(await code(run("approve-expired", { operation: "approve", requestId: expiring.id, revision: 1, lifetime: "once" }))).toBe("vault_denied");
    // Agent identity labels are read-only owner context.
    expect((await listAgentCredentials(f.ownerToken, f.first.actor.principalId, controller.send))?.map(item => item.label)).toEqual(["Fake fixture token"]);
    expect(await listAgentCredentials(f.first.token, f.first.actor.principalId, controller.send)).toBeNull();
    session.lock();
    expect(session.ownerToken()).toBeNull();
    expect(await code(run("list", { operation: "list" }))).toBe("locked");
  });

  it.each([[2000, 0], [2000, 999], [-2000, 0], [0, 500], [2999, 500]])("signs acceptable proofs with browser offset %i ms and server fraction %i ms", async (offset, fraction) => {
    const { f, run, controller } = await connected(offset, fraction);
    expect(vaultListSchema.parse(await run("list", { operation: "list" })).profiles).toHaveLength(1);
    const call = controller.calls.find(call => call.path === "/api/dev-vault")!;
    const age = Date.parse(f.now) - Date.parse(JSON.parse(call.body).proof.issuedAt);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThanOrEqual(2000);
  });

  it.each(["headers", "body"] as const)("retries an import interrupted during %s with the same operation ID", async mode => {
    const { f, run, controller } = await connected();
    controller.dropNextResponse(mode);
    const first = await run("import", { operation: "import", dotenv: FAKE_DOTENV }).catch((error: unknown) => error);
    expect((first as VaultClientError).code).toBe("transport");
    const retried = vaultProfileSchema.parse(await run("import", { operation: "import", dotenv: FAKE_DOTENV }));
    const sent = controller.calls.filter(call => call.path === "/api/dev-vault" && call.body.includes("\"import\"")).map(call => JSON.parse(call.body).command.operationId);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(vaultListSchema.parse(await run("list", { operation: "list" })).profiles).toHaveLength(2);
    expect(retried.profileId).not.toBe(f.imported.profileId);
    // A different draft is a new operation.
    await run("import", { operation: "import", dotenv: "FAKE_OTHER=FAKE_OTHER_VALUE" });
    const ids = controller.calls.filter(call => call.path === "/api/dev-vault" && call.body.includes("\"import\"")).map(call => JSON.parse(call.body).command.operationId);
    expect(new Set(ids).size).toBe(2);
  });
});
