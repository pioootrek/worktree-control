import { randomUUID } from "node:crypto";
import { ServerResponse } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationProtectionQueries } from "@/server/infrastructure/sqlite/authentication-protection-queries";
import type { ProviderFactorLimits } from "@/server/modules/authentication";
import type { ProofFaultInjection } from "../src/index";
import { browserFixture, TRANSPORT_LIMITS, write, type BrowserClient, type BrowserFixture } from "./browser-authentication-fixture";
import { betweenResultAndRelease, deleted, enableTotp, enrollPasskey, enrollTotp, get, live, options, P, passkeyLogin, post, refused, S, signIn, stage, strength, T, totpLogin, unauthenticated } from "./browser-factor-helpers";
import { count, ORIGIN, OWNER_PASSWORD } from "./fixture";
import { advance, factorOptions, LIMITS, protectionState, select, sql, STEP } from "./integrated-fixture";
import { PasskeyAuthenticator, type AuthenticatorInput } from "./passkey-authenticator";
import { cleanupStrictRoots, closeStrictProof, gate, sleep } from "./strict-fixture";

const OTHER_EMAIL = "second@fixture.invalid";
const opened: BrowserFixture[] = [];
interface Setup { faults?: ProofFaultInjection; connection?: object; maxInFlight?: number; limits?: Partial<ProviderFactorLimits>; transport?: Partial<typeof TRANSPORT_LIMITS> }
const create = async ({ faults = {}, connection = {}, maxInFlight = 8, limits = {}, transport = {} }: Setup = {}) => {
  const f = await browserFixture(faults, connection, maxInFlight, factorOptions({ ...LIMITS, ...limits }), { ...TRANSPORT_LIMITS, ...transport });
  opened.push(f);
  return f;
};
/** The real test of "ended": the old client's actual cookie no longer resolves. */
const allSessionsEnded = async (f: BrowserFixture) => { expect((await protectionState(f)).sessions).toEqual([]); };
const addOwner = async (f: BrowserFixture) => {
  const principalId = randomUUID();
  await sql(f, "INSERT INTO remote_principals (id, kind, status) VALUES (?, 'owner', 'active')", [principalId]);
  const { subject } = await f.runtime.provisionLocal({ principalId, email: OTHER_EMAIL, name: "Second", password: OWNER_PASSWORD, actor: "test" });
  return { principalId, subject };
};
/** Bytes Node's client would refuse to send, written straight to the actual listener. */
const rawRequest = (socketPath: string, text: string) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [], socket = connect(socketPath, () => socket.write(text));
  socket.on("data", chunk => chunks.push(Buffer.from(chunk))); socket.on("error", reject);
  socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
});
const secretFree = (f: BrowserFixture, ...values: unknown[]) => {
  const text = JSON.stringify({ values, logs: f.evidence.logs });
  for (const secret of [OWNER_PASSWORD, "owner@fixture.invalid", f.root]) expect(text).not.toContain(secret);
};

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-02T12:00:05Z")); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of opened.splice(0)) await f.close();
  cleanupStrictRoots();
});

describe("optional factors through the actual HTTP controller", () => {
  it("keeps ordinary password login with nothing selected", async () => {
    const f = await create(), client = await f.client().authenticated();
    await strength(client, "password");
    await f.grant();
    expect(await client.call("/api/knowledge", { body: write(f) })).toMatchObject({ status: 200, body: { replayed: false } });
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 0, passkey_selected: 0 });
  });

  it("selects TOTP, ends every old session, and logs in through a pending challenge", async () => {
    const f = await create(), client = await f.client().authenticated(), other = await f.client().authenticated();
    await f.grant();
    const authenticator = await enrollTotp(client);
    await allSessionsEnded(f);
    expect(client.cookie).toBe(""); await unauthenticated(other);
    advance(STEP * 2);
    const challenge = await signIn(client);
    expect(challenge).toMatchObject({ status: 200, body: { authenticated: false, outcome: "challenge", method: "totp" } });
    expect(live(challenge).map(line => line.split("=")[0])).toEqual([T]);
    expect(client.jar.has(S)).toBe(false);
    await unauthenticated(client);
    refused(await post(client, "two-factor/verify-totp", { code: authenticator.wrong() }));
    const login = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    expect(login).toMatchObject({ status: 200, body: { authenticated: true } });
    expect(Object.keys(login.body)).toEqual(["authenticated"]);
    expect(live(login).map(line => line.split("=")[0])).toEqual([S]);
    expect(deleted(login)).toContain(T);
    expect(client.jar.has(T)).toBe(false);
    await strength(client, "password_totp");
    expect(await client.call("/api/knowledge", { body: write(f, "totp-write") })).toMatchObject({ status: 200, body: { replayed: false } });
    secretFree(f, challenge.body, login.body);
  });

  it("gives the setup URI only to the enrolling account, with no contact data, and never logs it", async () => {
    const f = await create(), client = await f.client().authenticated();
    const started = await post(client, "two-factor/enable", { password: OWNER_PASSWORD }), uri = new URL(started.body.totpURI as string);
    expect(uri.protocol).toBe("otpauth:");
    expect(decodeURIComponent(uri.pathname)).toBe("/Worktree Control:account");
    expect([...uri.searchParams.keys()].sort()).toEqual(["digits", "issuer", "period", "secret"]);
    expect(started.body.totpURI).not.toContain("fixture.invalid");
    expect(started.headers["set-cookie"]).toBeUndefined();
    expect(JSON.stringify(f.evidence.logs)).not.toContain(uri.searchParams.get("secret"));
    refused(await post(f.client(), "two-factor/enable", { password: OWNER_PASSWORD }));
    refused(await post(client, "two-factor/enable", { password: "fixture-wrong-password" }));
    await strength(client, "password");
  });

  it.each([["none", { attestationNone: true }], ["packed", {}]] as const)("selects a passkey with %s attestation, with no session, then logs in without a password", async (_, input) => {
    const f = await create(), client = await f.client().authenticated(), old = client.cookie;
    await f.grant();
    const authenticator = await stage(client, input);
    await strength(client, "password");
    expect(client.jar.has(P)).toBe(true);
    const finished = await post(client, "passkey/verify-confirmation", { response: authenticator.assert(await options(client, "confirm"), { counter: 0 }) });
    expect(finished.status).toBe(200);
    expect(live(finished)).toEqual([]);
    expect(deleted(finished)).toEqual(expect.arrayContaining([S, P]));
    await allSessionsEnded(f);
    expect(client.jar.size).toBe(0);
    await unauthenticated(client);
    expect((await client.call("/api/auth/get-session", { method: "GET", cookie: old })).body).toEqual({ authenticated: false });
    refused(await signIn(client));
    const login = await passkeyLogin(client, authenticator, { counter: 1 });
    expect(login).toMatchObject({ status: 200, body: { authenticated: true } });
    expect(deleted(login)).toContain(P);
    await strength(client, "passkey_uv");
    expect(await client.call("/api/knowledge", { body: write(f, "passkey-write") })).toMatchObject({ status: 200 });
  });

  it("projects generated options to named safe fields with the random handle and a fixed label", async () => {
    const f = await create(), client = await f.client().authenticated();
    const created = await options(client, "register") as unknown as Record<string, unknown> & { user: { id: string; name: string; displayName: string } };
    expect(Object.keys(created).sort()).toEqual(["attestation", "authenticatorSelection", "challenge", "excludeCredentials", "extensions", "pubKeyCredParams", "rp", "timeout", "user"]);
    expect(created).toMatchObject({ attestation: "none", authenticatorSelection: { userVerification: "required", residentKey: "required" }, rp: { id: "controller.test" } });
    expect(created.user.name).toBe("Worktree Control account"); expect(created.user.displayName).toBe(created.user.name);
    expect(created.user.id).not.toBe(Buffer.from(f.subject).toString("base64url"));
    expect(JSON.stringify(created)).not.toContain(f.subject);
    const anonymous = await options(f.client(), "authenticate") as unknown as Record<string, unknown>;
    expect(Object.keys(anonymous).sort()).toEqual(["challenge", "rpId", "timeout", "userVerification"]);
    expect(anonymous.userVerification).toBe("required");
    const authenticator = await stage(client);
    const confirm = await options(client, "confirm") as unknown as { allowCredentials: Array<{ id: string }> };
    expect(confirm.allowCredentials.map(item => item.id)).toEqual([authenticator.id]);
  });

  it("accepts standard optional registration metadata, which proves nothing", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = new PasskeyAuthenticator();
    const registered = authenticator.register(await options(client, "register"), { attestationNone: true });
    const result = await post(client, "passkey/verify-registration", { response: { ...registered, authenticatorAttachment: "platform", clientExtensionResults: { credProps: { rk: true } },
      response: { ...registered.response, publicKeyAlgorithm: -7, publicKey: Buffer.from("forged-metadata").toString("base64url"), authenticatorData: Buffer.from("forged-metadata").toString("base64url") } } });
    expect(result.status).toBe(200);
    expect((await protectionState(f)).trusted).toBe(0);
    await strength(client, "password");
  });

  it("adds TOTP to a passkey account from a strong session, and both then work alone", async () => {
    const f = await create(), client = await f.client().authenticated();
    const passkey = await enrollPasskey(client);
    expect((await passkeyLogin(client, passkey, { counter: 1 })).status).toBe(200);
    const totp = await enrollTotp(client);
    await allSessionsEnded(f);
    await totpLogin(client, totp);
    await strength(client, "password_totp");
    expect((await client.call("/api/auth/sign-out", { body: {} })).status).toBe(200);
    expect((await passkeyLogin(client, passkey, { counter: 2 })).status).toBe(200);
    await strength(client, "passkey_uv");
  });

  it("adds a passkey to a TOTP account from a strong session, and both then work alone", async () => {
    const f = await create(), client = await f.client().authenticated();
    const totp = await enrollTotp(client);
    await totpLogin(client, totp);
    const passkey = await enrollPasskey(client);
    await allSessionsEnded(f);
    expect((await passkeyLogin(client, passkey, { counter: 1 })).status).toBe(200);
    await strength(client, "passkey_uv");
    expect((await client.call("/api/auth/sign-out", { body: {} })).status).toBe(200);
    await totpLogin(client, totp);
    await strength(client, "password_totp");
  });

  it("refuses a second passkey, a repeat TOTP setup and every management or recovery route", async () => {
    const f = await create(), client = await f.client().authenticated();
    const passkey = await enrollPasskey(client);
    expect((await passkeyLogin(client, passkey, { counter: 1 })).status).toBe(200);
    refused(await get(client, "passkey/generate-register-options"));
    for (const path of ["two-factor/disable", "two-factor/verify-backup-code", "two-factor/generate-backup-codes", "two-factor/send-otp", "two-factor/verify-otp", "two-factor/get-totp-uri", "passkey/delete-passkey", "passkey/update-passkey", "passkey/list-user-passkeys"]) {
      expect(await post(client, path, {})).toMatchObject({ status: 401, body: { code: "invalid_credential" } });
    }
  });
});

describe("signed WebAuthn evidence over HTTP", () => {
  const staged = async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await stage(client);
    return { f, client, authenticator };
  };
  it.each<[string, AuthenticatorInput]>([
    ["missing signed UV", { uv: false }], ["missing signed UP", { up: false }], ["a wrong RP", { rp: "other.test" }], ["a wrong origin", { origin: "https://other.test" }],
    ["a wrong challenge", { challenge: "d3Jvbmc" }], ["a wrong handle", { userHandle: "d3Jvbmc" }], ["a bad signature", { tamper: true, counter: 0 }],
  ])("confirmation refuses %s and trusts nothing", async (_, input) => {
    const { f, client, authenticator } = await staged();
    refused(await post(client, "passkey/verify-confirmation", { response: authenticator.assert(await options(client, "confirm"), { counter: 0, ...input }) }));
    expect(await protectionState(f)).toMatchObject({ trusted: 0, policy: { passkey_selected: 0 } });
    await strength(client, "password");
  });

  it("refuses unverified registration and a staged key at login", async () => {
    const f = await create(), client = await f.client().authenticated(), other = new PasskeyAuthenticator();
    refused(await post(client, "passkey/verify-registration", { response: other.register(await options(client, "register"), { attestationNone: true, uv: false, up: false }) }));
    const authenticator = await stage(client);
    refused(await passkeyLogin(f.client(), authenticator, { counter: 1 }));
    expect((await protectionState(f)).sessions).toHaveLength(1);
  });

  it("refuses a changed key or native row after staging", async () => {
    const { f, client, authenticator } = await staged();
    await sql(f, 'UPDATE "authentication_ba_passkey" SET "publicKey" = ?', ["changed"]);
    refused(await get(client, "passkey/generate-confirm-options"));
    expect((await protectionState(f)).trusted).toBe(0);
    void authenticator;
  });

  it("refuses replay and a nonincreasing nonzero counter, and accepts a legitimate zero counter", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollPasskey(client);
    const replayed = f.client(), challenge = await options(replayed, "authenticate"), assertion = authenticator.assert(challenge, { counter: 5 });
    expect((await post(replayed, "passkey/verify-authentication", { response: assertion })).status).toBe(200);
    refused(await post(replayed, "passkey/verify-authentication", { response: assertion }));
    refused(await passkeyLogin(f.client(), authenticator, { counter: 5 }));
    refused(await passkeyLogin(f.client(), authenticator, { counter: 4 }));
    expect((await passkeyLogin(f.client(), authenticator, { counter: 6 })).status).toBe(200);
    const zero = await create(), first = await zero.client().authenticated(), key = await enrollPasskey(first);
    expect((await passkeyLogin(zero.client(), key, { counter: 0 })).status).toBe(200);
    expect((await passkeyLogin(zero.client(), key, { counter: 0 })).status).toBe(200);
  });

  it("refuses swapped credentials and cookies between two accounts", async () => {
    const f = await create(); await addOwner(f);
    const one = await f.client().authenticated(), two = f.client();
    expect((await two.login(OWNER_PASSWORD, OTHER_EMAIL)).status).toBe(200);
    const firstKey = await stage(one), secondKey = await stage(two);
    const oneOptions = await options(one, "confirm");
    refused(await post(two, "passkey/verify-confirmation", { response: firstKey.assert(oneOptions, { counter: 0 }) }));
    // Second account's session with the first account's staged source.
    const swapped = f.client();
    swapped.jar.set(S, two.jar.get(S)!); swapped.jar.set(P, one.jar.get(P)!);
    refused(await post(swapped, "passkey/verify-confirmation", { response: firstKey.assert(oneOptions, { counter: 0 }) }));
    refused(await get(swapped, "passkey/generate-confirm-options"));
    expect((await protectionState(f)).trusted).toBe(0);
    void secondKey;
  });
});

describe("native failures after passkey verification", () => {
  it("reports a session creation veto as a provider fault and rolls back the valid assertion", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated();
    const authenticator = await enrollPasskey(client);
    const pending = await options(client, "authenticate"), before = await protectionState(f);
    faults.vetoSession = true;
    const result = await post(client, "passkey/verify-authentication", { response: authenticator.assert(pending, { counter: 1 }) });
    faults.vetoSession = false;
    refused(result, 502, "provider_failed");
    const after = await protectionState(f);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.evidence).toEqual(before.evidence);
    expect(after.credentials).toEqual(before.credentials);
    expect(after.charged).toBe(before.charged + 1);
    secretFree(f, result.body);
  });

  it("reports registration persistence failure after verification as a provider fault", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated();
    const authenticator = new PasskeyAuthenticator(), pending = await options(client, "register"), before = await protectionState(f);
    faults.sqlFault = { sql: /insert into "authentication_ba_passkey"/i, when: "before", remaining: 1 };
    const result = await post(client, "passkey/verify-registration", { response: authenticator.register(pending, { attestationNone: true }) });
    expect(faults.sqlFault.remaining).toBe(0);
    faults.sqlFault = undefined;
    refused(result, 502, "provider_failed");
    const after = await protectionState(f);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.credentials).toEqual(before.credentials);
    expect(after.staged).toBe(before.staged);
    expect(after.trusted).toBe(before.trusted);
    expect(after.charged).toBe(before.charged + 1);
    secretFree(f, result.body);
  });
});

describe("final release against current state", () => {
  const revoke = (f: BrowserFixture) => () => f.runtime.revokeSubject({ principalId: f.owner.principalId, actor: "test" });
  it("withholds a challenge whose mapping ended before release", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    betweenResultAndRelease(f, "sign-in", revoke(f));
    refused(await signIn(client));
    expect(client.jar.has(T)).toBe(false);
    void authenticator;
  });
  it("withholds a TOTP setup and registration options once their session ended", async () => {
    const f = await create(), client = await f.client().authenticated();
    betweenResultAndRelease(f, "totp-enable", () => f.runtime.revokePrincipalSessions(f.owner.principalId));
    const result = await post(client, "two-factor/enable", { password: OWNER_PASSWORD });
    refused(result); expect(JSON.stringify(result.body)).not.toContain("otpauth");
    const second = await create(), other = await second.client().authenticated();
    betweenResultAndRelease(second, "passkey-register-options", () => second.runtime.revokePrincipalSessions(second.owner.principalId));
    refused(await get(other, "passkey/generate-register-options"));
    expect(other.jar.has(P)).toBe(false);
  });
  it("withholds staging once its original session ended, and confirmation cannot use that stage", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = new PasskeyAuthenticator();
    const created = await options(client, "register");
    betweenResultAndRelease(f, "passkey-registration", () => f.runtime.revokePrincipalSessions(f.owner.principalId));
    refused(await post(client, "passkey/verify-registration", { response: authenticator.register(created, { attestationNone: true }) }));
    refused(await get(client, "passkey/generate-confirm-options"));
  });
  it("withholds generic options whose context expired, without inventing a subject", async () => {
    const f = await create(), client = f.client();
    betweenResultAndRelease(f, "passkey-authenticate-options", async () => { advance(10 * 60_000); });
    refused(await get(client, "passkey/generate-authenticate-options"));
    expect(client.jar.has(P)).toBe(false);
  });
  it("reports a committed selection honestly when current state changed before release", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enableTotp(client);
    betweenResultAndRelease(f, "totp-verify", revoke(f));
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed", committed: true } });
    expect(live(result)).toEqual([]);
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 1 });
  });
  it("denies a retained Knowledge actor, cookie and idempotent result once authority is gone", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    await f.grant();
    await totpLogin(client, authenticator);
    expect((await client.call("/api/knowledge", { body: write(f) })).status).toBe(200);
    await f.runtime.revokePrincipalSessions(f.owner.principalId);
    expect(await client.call("/api/knowledge", { body: write(f) })).toMatchObject({ status: 401, body: { code: "invalid_credential" } });
    expect((await f.run(() => f.store.listTasks(f.project.id, 10, 0))).items).toHaveLength(1);
  });
  it("treats a contradicted selection as no authority for retained strong sessions", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    await totpLogin(client, authenticator);
    await sql(f, 'UPDATE "authentication_ba_two_factor" SET "secret" = ?', ["changed"]);
    await unauthenticated(client);
    expect((await client.call("/api/knowledge", { body: write(f) })).status).toBe(401);
  });
});

describe("authority ceilings", () => {
  it("a strong session gains no grant, role, project, owner, runtime, vault or token authority", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    await totpLogin(client, authenticator);
    expect(await client.call("/api/knowledge", { body: write(f) })).toMatchObject({ status: 403, body: { code: "knowledge_forbidden" } });
    await f.grant();
    const foreign = await f.run(() => f.identity.createKnowledgeProject({ name: "Other" }, f.ownerActor));
    const input = write(f, "foreign"); input.input.projectId = foreign.id;
    expect(await client.call("/api/knowledge", { body: input })).toMatchObject({ status: 403, body: { code: "knowledge_forbidden" } });
    await f.run(() => f.identity.revokeKnowledgeGrant(f.owner.principalId, f.project.id, f.ownerActor));
    expect((await client.call("/api/knowledge", { body: write(f, "after") })).status).toBe(403);
    for (const path of ["/api/dashboard", "/api/projects/x/start", "/api/identity", "/api/identity/admin", "/api/dev-vault", "/api/backups", "/mcp"]) {
      expect(await client.call(path, { body: {} })).toMatchObject({ status: 401, body: { code: "invalid_credential" } });
    }
    expect(await client.call("/api/auth/status", { method: "GET" })).toMatchObject({ status: 200, body: { mode: "open", loginAvailable: true } });
    expect(Object.keys((await client.call("/api/auth/status", { method: "GET" })).body).sort()).toEqual(["loginAvailable", "mode"]);
  });
  it("an actor from another runtime, or a copy, cannot carry a request", async () => {
    const f = await create(), client = await f.client().authenticated(), other = await create();
    const headers = new Headers({ cookie: client.cookie, origin: ORIGIN });
    const actor = (await f.runtime.authenticate(headers))!;
    const request = (path: string) => new Request(`${ORIGIN}/api/auth/${path}`, { method: "POST", headers, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    await expect(other.runtime.browser("totp-enable", request("two-factor/enable"), { actor }).result).rejects.toMatchObject({ code: "invalid_session" });
    await expect(f.runtime.browser("totp-enable", request("two-factor/enable"), { actor: Object.freeze({ ...actor }) as typeof actor }).result).rejects.toMatchObject({ code: "invalid_session" });
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 0 });
  });
  it("releases cannot be forged, copied or finished twice", async () => {
    const f = await create(), other = await create(), client = await f.client().authenticated();
    const headers = new Headers({ cookie: client.cookie, origin: ORIGIN, "content-type": "application/json", "x-worktree-control-client-ip": "198.18.1.1" });
    const release = await f.runtime.browser("session", new Request(`${ORIGIN}/api/auth/get-session`, { headers })).result;
    expect(() => f.runtime.finishBrowserRelease({ ...release })).toThrow();
    await f.run(() => { expect(() => other.runtime.finishBrowserRelease(release)).toThrow(); });
    await f.run(() => { expect(f.runtime.finishBrowserRelease(release)).toMatchObject({ authenticated: true }); });
    await f.run(() => { expect(() => f.runtime.finishBrowserRelease(release)).toThrow(); });
  });
});

describe("request boundary", () => {
  const padded = (value: unknown, bytes: number) => { const text = JSON.stringify(value); return text + " ".repeat(bytes - Buffer.byteLength(text)); };
  it("accepts exact body limits and refuses one byte more before the provider", async () => {
    const f = await create(), client = await f.client().authenticated(), browser = vi.spyOn(f.runtime, "browser");
    expect((await client.call("/api/auth/two-factor/verify-totp", { raw: padded({ code: "000000" }, 4096) })).status).not.toBe(413);
    browser.mockClear();
    expect(await client.call("/api/auth/two-factor/verify-totp", { raw: padded({ code: "000000" }, 4097) })).toMatchObject({ status: 413, body: { code: "request_too_large" } });
    const assertion = { response: { id: "AA", rawId: "AA", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "AA", authenticatorData: "AA", signature: "AA", userHandle: "AA" } } };
    expect(await client.call("/api/auth/passkey/verify-authentication", { raw: padded(assertion, 32_769), cookie: `${P}=fixture` })).toMatchObject({ status: 413 });
    expect(browser).not.toHaveBeenCalled();
    expect((await client.call("/api/auth/passkey/verify-authentication", { raw: padded(assertion, 32_768), cookie: `${P}=fixture` })).status).toBe(401);
    expect(browser).toHaveBeenCalledOnce();
  });
  it("counts bytes, not characters, across split multibyte chunks with no Content-Length", async () => {
    const f = await create(), client = f.client();
    const text = Buffer.from(JSON.stringify({ email: "owner@fixture.invalid", password: "ż".repeat(100) }));
    const call = client.start("/api/auth/sign-in/email");
    const split = text.indexOf(Buffer.from("ż")) + 1;
    call.write(text.subarray(0, split)); await sleep(5); call.write(text.subarray(split));
    call.send("");
    refused(await call.completed);
    const oversized = client.start("/api/auth/sign-in/email");
    oversized.send(JSON.stringify({ email: "owner@fixture.invalid", password: "ż".repeat(2100) }));
    expect((await oversized.completed).status).toBe(413);
  });
  it("refuses malformed UTF-8, compressed bodies, lying lengths, duplicate JSON and excess nesting before the provider", async () => {
    const f = await create(), client = await f.client().authenticated(), browser = vi.spyOn(f.runtime, "browser");
    const invalid = client.start("/api/auth/sign-in/email");
    invalid.write(Buffer.from([0x7b, 0xc3])); invalid.send("");
    expect((await invalid.completed).status).toBe(400);
    expect((await client.call("/api/auth/sign-in/email", { raw: "{}", headers: { "content-encoding": "gzip" } })).status).toBe(400);
    expect((await client.call("/api/auth/sign-in/email", { raw: "{}", headers: { "content-length": "9999999" } })).status).toBe(413);
    expect((await client.call("/api/auth/two-factor/enable", { raw: `{"password":"a","password":"${OWNER_PASSWORD}"}` })).status).toBe(400);
    expect((await client.call("/api/auth/two-factor/enable", { raw: `{"password":"a","p\\u0061ssword":"b"}` })).status).toBe(400);
    expect((await client.call("/api/auth/sign-in/email", { raw: `${"[".repeat(9)}${"]".repeat(9)}` })).status).toBe(400);
    expect((await client.call("/api/auth/sign-in/email", { raw: "not-json" })).status).toBe(400);
    expect(browser).not.toHaveBeenCalled();
  });
  it("refuses extra fields, wrong types, aliases, methods and malformed WebAuthn before the provider", async () => {
    const f = await create(), client = await f.client().authenticated(), browser = vi.spyOn(f.runtime, "browser");
    const enrolled = f.client(); enrolled.jar.set(S, client.jar.get(S)!); enrolled.jar.set(P, "fixture");
    for (const body of [{ password: OWNER_PASSWORD, method: "totp" }, { password: 1 }, [], null, { password: "" }]) expect((await post(client, "two-factor/enable", body)).status).toBe(400);
    for (const code of ["12345", "1234567", "12a456", " 123456", "１２３４５６"]) expect((await post(client, "two-factor/verify-totp", { code })).status).toBe(400);
    for (const extra of [{ trustDevice: true }, { method: "totp" }]) expect((await post(client, "two-factor/verify-totp", { code: "123456", ...extra })).status).toBe(400);
    const base = { id: "AAAA", rawId: "AAAA", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA", userHandle: "AAAA" } };
    for (const change of [{ id: "AAA=" }, { id: "AA+A" }, { id: "AB" }, { rawId: "BBBB" }, { type: "password" }, { extra: 1 }, { clientExtensionResults: { prf: {} } },
      { response: { ...base.response, userHandle: null } }, { response: { ...base.response, signature: "A" } }, { response: { ...base.response, clientDataJSON: "A".repeat(4000) } }, { response: { ...base.response, extra: "x" } }]) {
      expect((await post(enrolled, "passkey/verify-confirmation", { response: { ...base, ...change } })).status).toBe(400);
    }
    for (const path of ["two-factor/enable/", "two-factor//enable", "%74wo-factor/enable", "two-factor/enable?x=1", "passkey/verify-registration/extra"]) expect((await post(client, path, {})).status).toBeGreaterThanOrEqual(400);
    expect((await client.call("/api/auth/two-factor/enable", { method: "GET" })).status).toBe(405);
    expect((await client.call("/api/auth/passkey/generate-register-options", { method: "POST", body: {} })).status).toBe(405);
    expect(browser).not.toHaveBeenCalled();
  });
  it("requires Origin on allocating GETs and refuses bodies, duplicate headers and foreign fetch metadata", async () => {
    const f = await create(), client = await f.client().authenticated(), browser = vi.spyOn(f.runtime, "browser");
    const path = "/api/auth/passkey/generate-authenticate-options";
    expect((await client.call(path, { method: "GET", omitOrigin: true })).status).toBe(403);
    expect((await client.call(path, { method: "GET", headers: { origin: "null" } })).status).toBe(403);
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-mode": "navigate" }, { "sec-fetch-dest": "document" }]) {
      expect((await client.call(path, { method: "GET", headers })).status).toBe(403);
    }
    const repeated = (header: string) => rawRequest(client.socketPath, `GET ${path} HTTP/1.1\r\nHost: controller.test\r\nOrigin: ${ORIGIN}\r\n${header}Connection: close\r\n\r\n`);
    expect(await repeated("Sec-Fetch-Site: same-origin\r\nSec-Fetch-Site: same-origin\r\n")).toMatch(/^HTTP\/1\.1 403 /);
    expect(await repeated(`Origin: ${ORIGIN}\r\n`)).toMatch(/^HTTP\/1\.1 403 /);
    const response = await rawRequest(client.socketPath, `GET ${path} HTTP/1.1\r\nHost: controller.test\r\nHost: controller.test\r\nOrigin: ${ORIGIN}\r\nConnection: close\r\n\r\n`);
    expect(response).toMatch(/^HTTP\/1\.1 4(00|21) /);
    expect((await client.call(path, { method: "GET", raw: "{}", headers: { "content-length": "2" } })).status).toBe(400);
    expect(browser).not.toHaveBeenCalled();
    expect((await client.call(path, { method: "GET", headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status).toBe(200);
  });
  it("refuses duplicate, aliased and oversized cookies, and forwards only the operation's allowlist", async () => {
    const f = await create(), client = await f.client().authenticated(), browser = vi.spyOn(f.runtime, "browser");
    const session = client.cookie;
    for (const cookie of [`${session}; ${session}`, `${session}; ${T}=a; ${T}=b`, `${P}=a; ${P}=b`, `wtc.session_token=x; ${session}`, `__secure-wtc.session_token=x`, `${"x".repeat(8193)}=1; ${session}`]) {
      expect((await client.call("/api/auth/get-session", { method: "GET", cookie })).status).toBe(400);
    }
    expect((await client.call("/api/auth/get-session", { method: "GET", headers: { cookie: [session, session] } })).status).toBe(400);
    expect(browser).not.toHaveBeenCalled();
    await client.call("/api/auth/get-session", { method: "GET", cookie: `theme=dark; __Secure-wtc.trust_device=forged; ${T}=stale; ${P}=stale; ${session}` });
    expect(browser.mock.calls[0]![1].headers.get("cookie")).toBe(session);
    browser.mockClear();
    await client.call("/api/auth/sign-in/email", { body: { email: "owner@fixture.invalid", password: "fixture-wrong-password" }, cookie: `${session}; ${T}=stale; __Secure-wtc.trust_device=forged` });
    expect(browser.mock.calls[0]![1].headers.has("cookie")).toBe(false);
    browser.mockClear();
    const mixed = await client.call("/api/auth/two-factor/verify-totp", { body: { code: "123456" }, cookie: `${session}; ${T}=fixture` });
    expect(mixed.status).toBe(400);
    expect(browser).not.toHaveBeenCalled();
  });
});

describe("deadlines", () => {
  it("times out a stalled body, and refuses authority that expired while one arrived", async () => {
    const f = await create({ transport: { bodyTimeoutMs: 40 } }), client = await f.client().authenticated(), browser = vi.spyOn(f.runtime, "browser");
    const stalled = client.start("/api/auth/two-factor/enable");
    stalled.write('{"password":');
    expect(await stalled.completed).toMatchObject({ status: 408, body: { code: "request_timeout" } });
    expect(browser).not.toHaveBeenCalled();
    const slow = await create(), other = await slow.client().authenticated(), dispatch = vi.spyOn(slow.adapter, "handle");
    const held = other.start("/api/auth/two-factor/enable");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    advance(8 * 60 * 60_000 + 1);
    held.send(JSON.stringify({ password: OWNER_PASSWORD }));
    refused(await held.completed);
    expect((await protectionState(slow)).policy).toMatchObject({ totp_selected: 0 });
  });
  it("refuses a challenge that expired while its code body was queued, keeping the step", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const before = await protectionState(f);
    advance(11 * 60_000);
    refused(await post(client, "two-factor/verify-totp", { code: authenticator.code() }));
    expect(await protectionState(f)).toMatchObject({ step: before.step, sessions: [] });
  });
});

describe("current state during provider work", () => {
  it("rechecks the exact actor inside a queued borrow, before any native enrollment effect", async () => {
    const f = await create(), client = await f.client().authenticated(), entered = gate(), release = gate(), original = f.runtime.browser.bind(f.runtime);
    let hold: Promise<unknown> | undefined, revoke: Promise<void> | undefined;
    vi.spyOn(f.runtime, "browser").mockImplementation((...args) => aroundBrowser(async () => {
      hold = f.run(async () => { entered.open(); await release.opened; });
      await entered.opened;
      revoke = f.runtime.revokePrincipalSessions(f.owner.principalId);
      return original(...args);
    }));
    const pending = post(client, "two-factor/enable", { password: OWNER_PASSWORD });
    await entered.opened;
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(2));
    release.open(); await hold; await revoke;
    refused(await pending);
    expect(await select(f, 'SELECT 1 FROM "authentication_ba_two_factor"')).toEqual([]);
  });
  // At before-commit the ticket is already settled; the login evidence is what is rechecked.
  it.each(["after-native", "observer-pending"] as const)("refuses a TOTP ticket that expired at %s and keeps only the charge", async stage => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const before = await protectionState(f), code = authenticator.code();
    faults.factorPause = async current => { if (current === stage) advance(LIMITS.ticketMs + 1); };
    const result = await post(client, "two-factor/verify-totp", { code });
    faults.factorPause = undefined;
    refused(result);
    expect(await protectionState(f)).toMatchObject({ step: before.step, sessions: [], evidence: [] });
    expect((await protectionState(f)).charged).toBe(before.charged + 1);
  });
  it("refuses staging that expired during native work, leaving no credential staged", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = new PasskeyAuthenticator();
    const created = await options(client, "register");
    faults.factorPause = async stage => { if (stage === "after-native") advance(LIMITS.ticketMs + 1); };
    refused(await post(client, "passkey/verify-registration", { response: authenticator.register(created, { attestationNone: true }) }));
    faults.factorPause = undefined;
    expect(await protectionState(f)).toMatchObject({ staged: 0, trusted: 0 });
  });
});

describe("cookie state", () => {
  it("replaces an old session with a challenge-only jar, without ending other sessions", async () => {
    const f = await create(), old = await f.client().authenticated(), authenticator = await enrollTotp(old);
    advance(STEP * 2);
    const first = f.client();
    await totpLogin(first, authenticator);
    const other = first.cookie;
    advance(STEP * 2);
    const again = await signIn(first);
    expect(again.body).toEqual({ authenticated: false, outcome: "challenge", method: "totp" });
    expect(deleted(again)).toContain(S); expect(first.jar.has(S)).toBe(false); expect(first.jar.has(T)).toBe(true);
    expect((await first.call("/api/auth/get-session", { method: "GET", cookie: other })).body).toMatchObject({ authenticated: true });
    expect((await post(first, "two-factor/verify-totp", { code: authenticator.code() })).status).toBe(200);
    expect(first.jar.has(T)).toBe(false);
  });
  it("keeps the registration source until confirmation, then replaces and removes it", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await stage(client);
    const source = client.jar.get(P);
    const confirm = await options(client, "confirm");
    expect(client.jar.get(P)).not.toBe(source);
    expect((await post(client, "passkey/verify-confirmation", { response: authenticator.assert(confirm, { counter: 0 }) })).status).toBe(200);
    expect(client.jar.has(P)).toBe(false);
  });
  it("releases exactly one final session cookie on a refresh-due password change from a strong session", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    await totpLogin(client, authenticator);
    const before = await client.session(), old = client.cookie;
    advance(2 * 60 * 60_000);
    const changed = await client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } });
    expect(changed).toMatchObject({ status: 200, body: { changed: true } });
    expect(changed.headers["set-cookie"]!.filter(line => line.startsWith(`${S}=`))).toHaveLength(1);
    expect(client.cookie).not.toBe(old);
    const session = await client.session();
    expect(session.body).toMatchObject({ authenticated: true, authentication: { method: "password_totp" }, expiresAt: before.body.expiresAt });
  });
  it.each([
    ["an unexpected live cookie", "__Secure-wtc.trust_device=forged; Path=/; HttpOnly; Secure; SameSite=Strict"],
    ["a loose attribute", `${S}=forged; Path=/; Secure; SameSite=None; HttpOnly`],
    ["a Domain", `${S}=forged; Path=/; HttpOnly; Secure; SameSite=Strict; Domain=controller.test`],
    ["a duplicate", `${S}=forged; Path=/; HttpOnly; Secure; SameSite=Strict`],
    ["a challenge beside a session", `${T}=forged; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60`],
  ])("fails the whole cookie set on %s, releases none and discards the new session", async (_, line) => {
    const f = await create(), client = f.client(), original = f.runtime.browserReleaseHeaders.bind(f.runtime);
    vi.spyOn(f.runtime, "browserReleaseHeaders").mockImplementation(release => {
      const headers = new Headers(original(release));
      headers.append("set-cookie", line);
      return headers;
    });
    const result = await signIn(client);
    expect(result).toMatchObject({ status: 502, body: { code: "provider_failed" } });
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(client.jar.size).toBe(0);
    expect((await protectionState(f)).sessions).toEqual([]);
  });
});

describe("actual socket abort", () => {
  const pause = (faults: ProofFaultInjection, stage: string) => {
    const entered = gate(), release = gate();
    faults.factorPause = async current => { if (current === stage) { entered.open(); await release.opened; } };
    return { entered, release };
  };
  const slotHeld = async (client: BrowserClient) => (await client.call("/api/auth/sign-in/email", { raw: "{}" })).status === 503;
  it("cancels an incomplete body with no provider call or later write, and frees its slot", async () => {
    const f = await create({ maxInFlight: 1 }), client = f.client(), browser = vi.spyOn(f.runtime, "browser");
    const handle = vi.spyOn(f.adapter, "handle"), writes = vi.spyOn(ServerResponse.prototype, "writeHead");
    const call = client.start("/api/auth/sign-in/email");
    call.completed.catch(() => undefined);
    call.write('{"email":');
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
    expect(await slotHeld(client)).toBe(true);
    writes.mockClear();
    call.abort();
    await handle.mock.results[0]!.value;
    expect(writes).not.toHaveBeenCalled();
    const [request] = handle.mock.calls[0]!;
    expect(request.listenerCount("aborted") + request.listenerCount("data")).toBe(0);
    expect(browser).not.toHaveBeenCalled();
    expect(await slotHeld(client)).toBe(false);
  });
  it("never runs a request cancelled while its borrow was queued", async () => {
    const f = await create(), client = f.client(), entered = gate(), release = gate();
    const hold = f.run(async () => { entered.open(); await release.opened; });
    await entered.opened;
    const call = client.start("/api/auth/sign-in/email");
    call.completed.catch(() => undefined);
    call.send(JSON.stringify({ email: "owner@fixture.invalid", password: OWNER_PASSWORD }));
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(1));
    call.abort();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(0));
    release.open(); await hold;
    expect(count(f.path, "authentication_ba_session")).toBe(0);
  });
  it("rolls back a password change cancelled during native work and holds the slot until it really ends", async () => {
    const entered = gate(), release = gate(), faults: ProofFaultInjection = {};
    const f = await create({ faults, maxInFlight: 1 }), client = await f.client().authenticated(), before = await protectionState(f);
    faults.beforePasswordWrite = async () => { entered.open(); await release.opened; };
    const probe = f.client(), call = client.start("/api/auth/change-password"), writes = vi.spyOn(ServerResponse.prototype, "writeHead");
    call.completed.catch(() => undefined);
    call.send(JSON.stringify({ currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" }));
    await entered.opened;
    call.abort();
    await sleep(30);
    expect(await slotHeld(probe)).toBe(true);
    writes.mockClear();
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    delete faults.beforePasswordWrite;
    await vi.waitFor(async () => expect(await slotHeld(probe)).toBe(false));
    expect((await protectionState(f)).sessions).toEqual(before.sessions);
    expect((await f.client().login("fixture-new-password-2")).status).toBe(401);
    expect((await f.client().login()).status).toBe(200);
  });
  it.each(["after-native", "observer-pending", "before-commit"] as const)("TOTP login cancelled at %s keeps only its charge", async stage => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const before = await protectionState(f), { entered, release } = pause(faults, stage);
    const call = client.start("/api/auth/two-factor/verify-totp");
    call.completed.catch(() => undefined);
    call.send(JSON.stringify({ code: authenticator.code() }));
    await entered.opened;
    call.abort();
    await sleep(30);
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    faults.factorPause = undefined;
    const after = await protectionState(f);
    expect(after).toMatchObject({ step: before.step, sessions: [], evidence: [], charged: before.charged + 1 });
    expect(after.receipts.at(-1)?.state).toBe("failed");
  });
  it("cancels a passkey confirmation before COMMIT: nothing is selected and no session changes", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await stage(client);
    const response = authenticator.assert(await options(client, "confirm"), { counter: 0 }), { entered, release } = pause(faults, "before-commit");
    const call = client.start("/api/auth/passkey/verify-confirmation");
    call.completed.catch(() => undefined);
    call.send(JSON.stringify({ response }));
    await entered.opened;
    call.abort();
    await sleep(30);
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    faults.factorPause = undefined;
    expect(await protectionState(f)).toMatchObject({ trusted: 0, staged: 1, policy: { passkey_selected: 0 } });
    await strength(client, "password");
  });
  it("after a known COMMIT, a lost login response is discarded and its step stays spent", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const before = await protectionState(f), call = client.start("/api/auth/two-factor/verify-totp");
    call.completed.catch(() => undefined);
    betweenResultAndRelease(f, "totp-verify", async () => { call.abort(); await sleep(30); });
    call.send(JSON.stringify({ code: authenticator.code() }));
    await vi.waitFor(async () => expect((await protectionState(f)).step).toBeGreaterThan(before.step ?? 0));
    await vi.waitFor(async () => expect((await protectionState(f)).sessions).toEqual([]));
    expect(client.jar.has(S)).toBe(false);
  });
  it("after a known COMMIT, a lost password response keeps the new password and removes only its unreleased session", async () => {
    const f = await create(), client = await f.client().authenticated(), call = client.start("/api/auth/change-password");
    call.completed.catch(() => undefined);
    betweenResultAndRelease(f, "password", async () => { call.abort(); await sleep(30); });
    call.send(JSON.stringify({ currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" }));
    await vi.waitFor(async () => { expect((await protectionState(f)).evidence).toEqual([]); });
    advance(61_000);
    expect((await f.client().login(OWNER_PASSWORD)).status).toBe(401);
    expect((await f.client().login("fixture-new-password-2")).status).toBe(200);
  });
  it("after a known COMMIT, a lost enrollment response keeps the selection", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enableTotp(client), call = client.start("/api/auth/two-factor/verify-totp");
    call.completed.catch(() => undefined);
    betweenResultAndRelease(f, "totp-verify", async () => { call.abort(); await sleep(30); });
    call.send(JSON.stringify({ code: authenticator.code() }));
    await vi.waitFor(async () => expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 1 }));
    await allSessionsEnded(f);
  });
  it("cancels while final admission waits, with no late write", async () => {
    const f = await create(), client = f.client(), call = client.start("/api/auth/sign-in/email"), held = gate(), release = gate();
    call.completed.catch(() => undefined);
    let hold: Promise<unknown> | undefined;
    let queued: Promise<unknown> | undefined;
    betweenResultAndRelease(f, "sign-in", async () => {
      hold = f.run(async () => { held.open(); await release.opened; });
      await held.opened;
      // Core admission is shared. Only a queued provider makes the final phase really wait.
      queued = f.runtime.resolve(new Headers());
      await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedProviders).toBe(1));
    });
    const writes = vi.spyOn(ServerResponse.prototype, "writeHead");
    call.send(JSON.stringify({ email: "owner@fixture.invalid", password: OWNER_PASSWORD }));
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(1));
    expect(count(f.path, "authentication_ba_session")).toBe(1);
    call.abort();
    // Reserved cleanup queues behind the same fence rather than bypassing it.
    await vi.waitFor(() => expect(f.store.admissionSnapshot().queuedCore).toBe(0));
    release.open(); await hold; await queued;
    await vi.waitFor(() => expect(count(f.path, "authentication_ba_session")).toBe(0));
    expect(writes).not.toHaveBeenCalled();
  });
  it("holds the slot past a timed-out borrow until its execution really ends, and reports the outcome as unknown", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults, connection: { borrowTimeoutMs: 1000 }, maxInFlight: 1 });
    const client = await f.client().authenticated(), probe = f.client(), entered = gate(), release = gate();
    faults.beforePasswordWrite = async () => { entered.open(); await release.opened; };
    const pending = client.call("/api/auth/change-password", { body: { currentPassword: OWNER_PASSWORD, newPassword: "fixture-new-password-2" } });
    await entered.opened;
    const result = await pending;
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
    expect(result.body).not.toHaveProperty("committed");
    expect(live(result)).toEqual([]);
    expect(await slotHeld(probe)).toBe(true);
    release.open();
    await vi.waitFor(() => expect(f.store.admissionSnapshot().providerExecutions).toBe(0));
    await vi.waitFor(async () => expect(await slotHeld(probe)).toBe(false));
    opened.splice(opened.indexOf(f), 1);
    await f.http.close();
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
  });
});

describe("anonymous options capacity", () => {
  const issuance = LIMITS.issuance;
  it("refuses a peer past its window before any allocation, and recovers after it", async () => {
    const f = await create({ limits: { issuance: { ...issuance, perPeer: { attempts: 3, windowMs: 60_000 } } } }), client = f.client();
    for (let index = 0; index < 3; index++) await options(client, "authenticate");
    const verifications = count(f.path, "authentication_ba_verification");
    expect(await get(client, "passkey/generate-authenticate-options")).toMatchObject({ status: 429, body: { code: "rate_limited" }, headers: { "retry-after": "60" } });
    expect(count(f.path, "authentication_ba_verification")).toBe(verifications);
    advance(60_000);
    await options(client, "authenticate");
  });
  it("bounds native challenge rows and contexts, prunes only its own expired rows, and leaves completions room", async () => {
    const limits = { capacity: 12, issuance: { ...issuance, nativeChallenges: 12, reservedContexts: 4 } };
    const f = await create({ limits }), client = await f.client().authenticated(), authenticator = await enrollPasskey(client);
    expect((await passkeyLogin(f.client(), authenticator, { counter: 1 })).status).toBe(200);
    const kept = f.client(), pending = await options(kept, "authenticate");
    await sql(f, `INSERT INTO "authentication_ba_verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ('unrelated-reset', 'reset-password:fixture', 'x', ?, ?, ?)`, [new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString(), new Date().toISOString()]);
    const before = count(f.path, "authentication_factor_contexts");
    let refusedAt = 0;
    for (let index = 0; index < 16 && !refusedAt; index++) {
      const result = await get(f.client(), "passkey/generate-authenticate-options");
      if (result.status !== 200) { refused(result, 503, "database_busy"); refusedAt = index; }
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(count(f.path, "authentication_ba_verification")).toBeLessThanOrEqual(limits.issuance.nativeChallenges);
    expect(count(f.path, "authentication_factor_contexts")).toBeLessThanOrEqual(limits.capacity - limits.issuance.reservedContexts);
    expect(count(f.path, "authentication_factor_contexts")).toBeGreaterThanOrEqual(before);
    // Accepted ceremonies still work, including one that needs a new context.
    expect((await post(kept, "passkey/verify-authentication", { response: authenticator.assert(pending, { counter: 2 }) })).status).toBe(200);
    advance(10 * 60_000);
    await options(f.client(), "authenticate");
    expect(count(f.path, "authentication_ba_verification")).toBeLessThan(limits.issuance.nativeChallenges);
    expect((await select(f, `SELECT 1 FROM "authentication_ba_verification" WHERE "id" = 'unrelated-reset'`)).length).toBe(1);
  });
  it("keeps in-flight slots for completions while initiating requests flood", async () => {
    const f = await create({ maxInFlight: 3, transport: { reservedCompletionSlots: 1 } });
    const client = await f.client().authenticated(), authenticator = await enrollPasskey(client);
    const completing = f.client(), pending = await options(completing, "authenticate");
    const held = [f.client().start("/api/auth/sign-in/email"), f.client().start("/api/auth/sign-in/email")];
    for (const call of held) call.completed.catch(() => undefined);
    const handle = vi.spyOn(f.adapter, "handle");
    await vi.waitFor(async () => expect(await get(f.client(), "passkey/generate-authenticate-options")).toMatchObject({ status: 503, body: { code: "database_busy" } }));
    expect((await post(completing, "passkey/verify-authentication", { response: authenticator.assert(pending, { counter: 1 }) })).status).toBe(200);
    for (const call of held) call.abort();
    void handle;
  });
});

describe("commit, notification and cleanup outcomes", () => {
  // Armed by a write inside the settling transaction, so it never hits the separate charge COMMIT.
  const commitFault = (faults: ProofFaultInjection, when: "before" | "after") => { faults.sqlFault = { sql: /^commit$/i, when, remaining: 1, afterSql: /^insert into "authentication_ba_session"/i }; };
  it("a COMMIT that rolled back is a failure, with no cookie, no committed claim and no effect", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    commitFault(faults, "before");
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    faults.sqlFault = undefined;
    expect(result.status).toBeGreaterThanOrEqual(500);
    expect(result.body).not.toHaveProperty("committed"); expect(live(result)).toEqual([]);
    expect((await protectionState(f)).evidence).toEqual([]);
  });
  it("a known COMMIT with a lost acknowledgment says so, with no cookie and no verifier replay", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    advance(STEP * 2);
    expect((await signIn(client)).status).toBe(200);
    const code = authenticator.code();
    commitFault(faults, "after");
    const result = await post(client, "two-factor/verify-totp", { code });
    faults.sqlFault = undefined;
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed", committed: true }, headers: { "retry-after": "1" } });
    expect(live(result)).toEqual([]); expect(client.jar.has(S)).toBe(false);
    refused(await post(client, "two-factor/verify-totp", { code }));
  });
  it("an unreadable receipt after the separate charge COMMIT stays unknown", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enableTotp(client);
    const original = AuthenticationProtectionQueries.prototype.receipt;
    faults.sqlFault = { sql: /^commit$/i, when: "after", remaining: 1 };
    vi.spyOn(AuthenticationProtectionQueries.prototype, "receipt").mockImplementation(function (this: AuthenticationProtectionQueries, attemptId) {
      if (faults.sqlFault?.remaining === 0) throw new Error("fixture receipt fault");
      return original.call(this, attemptId);
    });
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    faults.sqlFault = undefined;
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
    expect(result.body).not.toHaveProperty("committed"); expect(live(result)).toEqual([]);
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 0 });
  });
  it("an unreadable receipt after COMMIT stays unknown", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enableTotp(client);
    const original = AuthenticationProtectionQueries.prototype.receipt;
    commitFault(faults, "after");
    vi.spyOn(AuthenticationProtectionQueries.prototype, "receipt").mockImplementation(function (this: AuthenticationProtectionQueries, attemptId) {
      if (faults.sqlFault?.remaining === 0) throw new Error("fixture receipt fault");
      return original.call(this, attemptId);
    });
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    faults.sqlFault = undefined;
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
    expect(result.body).not.toHaveProperty("committed"); expect(live(result)).toEqual([]);
  });
  it("a failed COMMIT and failed ROLLBACK withhold everything and close provider admission", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults }), client = await f.client().authenticated(), authenticator = await enableTotp(client);
    faults.sqlFault = { sql: /^(commit|rollback)$/i, when: "before", remaining: 2, afterSql: /authentication_account_policies|authentication_ba_session/ };
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    faults.sqlFault = undefined;
    expect(result).toMatchObject({ status: 503, body: { code: "completion_unconfirmed" } });
    expect(result.body).not.toHaveProperty("committed"); expect(live(result)).toEqual([]);
    expect(f.store.admissionSnapshot().state).toBe("provider_closed");
  });
  it("a committed enrollment whose notification failed keeps its fixed classification", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enableTotp(client);
    f.evidence.failInvalidation = true;
    const result = await post(client, "two-factor/verify-totp", { code: authenticator.code() });
    f.evidence.failInvalidation = false;
    expect(result).toMatchObject({ status: 500, body: { code: "committed_notification_failed", committed: true } });
    expect(live(result)).toEqual([]);
    expect((await protectionState(f)).policy).toMatchObject({ totp_selected: 1 });
  });
  it("disposal itself ends a session whose response never finished", async () => {
    const f = await create(), headers = new Headers({ origin: ORIGIN, "content-type": "application/json", "x-worktree-control-client-ip": "198.18.2.3" });
    await f.runtime.browser("sign-in", new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST", headers,
      body: JSON.stringify({ email: "owner@fixture.invalid", password: OWNER_PASSWORD }) })).result;
    expect(count(f.path, "authentication_ba_session")).toBe(1);
    opened.splice(opened.indexOf(f), 1);
    await f.http.close();
    await expect(f.runtime.dispose()).resolves.toBeUndefined();
    await f.store.closeAfterDrain();
    expect(count(f.path, "authentication_ba_session")).toBe(0);
  });
  it("disposal cannot be confirmed while an unreleased session could not be cleaned up", async () => {
    const faults: ProofFaultInjection = {}, f = await create({ faults });
    const headers = new Headers({ origin: ORIGIN, "content-type": "application/json", "x-worktree-control-client-ip": "198.18.2.2" });
    const release = await f.runtime.browser("sign-in", new Request(`${ORIGIN}/api/auth/sign-in/email`, { method: "POST", headers,
      body: JSON.stringify({ email: "owner@fixture.invalid", password: OWNER_PASSWORD }) })).result;
    expect(release.outcome).toBe("session");
    faults.beforeSessionDelete = async () => { throw new Error("fixture cleanup failure"); };
    opened.splice(opened.indexOf(f), 1);
    await f.http.close();
    await expect(f.runtime.dispose()).rejects.toMatchObject({ code: "disposal_unconfirmed" });
    delete faults.beforeSessionDelete;
    await f.store.closeAfterDrain();
  });
});

describe("store reopen", () => {
  it("retains current evidence and the spent step across an in-process close and reopen", async () => {
    const f = await create(), client = await f.client().authenticated(), authenticator = await enrollTotp(client);
    await totpLogin(client, authenticator);
    const before = await protectionState(f);
    expect(before.step).toBeGreaterThan(0);
    expect(before.evidence).toMatchObject([{ method: "password_totp" }]);
    opened.splice(opened.indexOf(f), 1);
    await f.http.close();
    await closeStrictProof(f);
    const { SqliteStateStore } = await import("@/server/infrastructure/sqlite");
    const store = new SqliteStateStore(f.path);
    try {
      const storage = store.authenticationProviderStorage();
      expect((await protectionState({ storage }))).toMatchObject({ step: before.step, evidence: [{ method: "password_totp" }], policy: before.policy });
    } finally { await store.closeAfterDrain(); }
  });
});
