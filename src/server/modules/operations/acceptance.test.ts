import { describe, expect, it } from "vitest";
import { authenticationModes, listenerKinds, type AuthenticationMode, type ListenerKind } from "@/shared/contracts/operations";
import { acceptanceTable, credentialClasses, resolveAcceptance, unregisteredRouteClasses, type CredentialClass, type PresentedCredentials } from "./acceptance";
import { createListenerBoundary, mintOfflineContext, type CredentialVerifier, type VerifiedCredential } from "./authentication-context";
import { OperationError } from "./errors";
import { A, createWorld, FakeVerifier, presented } from "./operations-fixture";

/** Independently written: every accepted mode/listener/credential combination and its path. */
const ACCEPTED = new Map<string, string>([
  ["open/api/none", "anonymous_installation"], ["open/mcp/none", "anonymous_installation"], ["open/worker/none", "anonymous_installation"],
  ["token/api/installation_token", "installation_token"], ["token/mcp/installation_token", "installation_token"],
  ["token/worker/installation_token", "installation_token"],
  ["better-auth/api/provider_session", "provider_session"],
  ["better-auth/api/agent_token", "agent_token"], ["better-auth/mcp/agent_token", "agent_token"], ["better-auth/worker/agent_token", "agent_token"],
  ["open/unix/none", "operator_unix"], ["token/unix/none", "operator_unix"], ["better-auth/unix/none", "operator_unix"],
  ["open/offline/none", "operator_offline"], ["token/offline/none", "operator_offline"], ["better-auth/offline/none", "operator_offline"],
]);

function credentials(credential: CredentialClass, browserHeaders = false): PresentedCredentials {
  if (credential === "none") return presented({ browserHeaders });
  if (credential === "provider_session") return presented({ providerSession: { secret: "cookie" }, browserHeaders });
  if (credential === "legacy_secret") return presented({ legacySecret: true, browserHeaders });
  return presented({ bearers: [{ class: credential, secret: "secret" }], browserHeaders });
}

describe("mode x listener x credential acceptance", () => {
  it("accepts exactly the expected combinations and rejects every other one", () => {
    const observed = new Map<string, string>();
    for (const mode of authenticationModes) for (const listener of listenerKinds) for (const credential of credentialClasses) {
      const result = resolveAcceptance(mode, listener, credentials(credential), true);
      if (result.accepted) observed.set(`${mode}/${listener}/${credential}`, result.path);
    }
    expect(Object.fromEntries(observed)).toEqual(Object.fromEntries(ACCEPTED));
    expect(acceptanceTable).toHaveLength(ACCEPTED.size);
  });

  it.each<[AuthenticationMode, ListenerKind, CredentialClass, string]>([
    ["better-auth", "api", "installation_token", "installation_token_in_account_mode"],
    ["better-auth", "mcp", "installation_token", "installation_token_in_account_mode"],
    ["better-auth", "mcp", "provider_session", "credential_not_accepted_here"],
    ["better-auth", "worker", "provider_session", "credential_not_accepted_here"],
    ["better-auth", "api", "none", "credential_required"],
    ["token", "api", "none", "credential_required"],
    ["token", "api", "agent_token", "credential_not_accepted_here"],
    ["token", "api", "provider_session", "credential_not_accepted_here"],
    ["token", "worker", "legacy_worker_token", "legacy_credential"],
    ["token", "api", "legacy_owner_token", "legacy_credential"],
    ["open", "mcp", "legacy_secret", "legacy_credential"],
    ["open", "api", "installation_token", "credential_in_open_mode"],
    ["open", "api", "provider_session", "credential_in_open_mode"],
    ["better-auth", "api", "unrecognized", "unrecognized_credential"],
    ["token", "unix", "installation_token", "credential_on_local_listener"],
    ["better-auth", "offline", "agent_token", "credential_on_local_listener"],
  ])("%s/%s rejects %s with %s", (mode, listener, credential, reason) => {
    expect(resolveAcceptance(mode, listener, credentials(credential), true)).toEqual({ accepted: false, reason });
  });

  it("rejects mixed credentials before anything else", () => {
    const mixed = [
      presented({ bearers: [{ class: "agent_token", secret: "a" }], providerSession: { secret: "c" } }),
      presented({ bearers: [{ class: "installation_token", secret: "a" }, { class: "installation_token", secret: "b" }] }),
      presented({ bearers: [{ class: "installation_token", secret: "a" }], legacySecret: true }),
    ];
    for (const mode of authenticationModes) for (const listener of listenerKinds) for (const value of mixed) {
      expect(resolveAcceptance(mode, listener, value, true)).toEqual({ accepted: false, reason: "mixed_credentials" });
    }
  });

  it("rejects browser headers on the unix listener and requires the lock offline", () => {
    for (const mode of authenticationModes) {
      expect(resolveAcceptance(mode, "unix", credentials("none", true))).toEqual({ accepted: false, reason: "browser_headers_on_unix" });
      expect(resolveAcceptance(mode, "offline", credentials("none"), false)).toEqual({ accepted: false, reason: "offline_lock_not_held" });
    }
    // Browser headers are expected on the TCP API (dashboard).
    expect(resolveAcceptance("open", "api", credentials("none", true))).toMatchObject({ accepted: true });
  });

  it("rejects modes and listeners outside the contract, including the former legacy mode", () => {
    expect(resolveAcceptance("legacy", "api", credentials("legacy_secret"))).toEqual({ accepted: false, reason: "unknown_mode" });
    expect(resolveAcceptance("open", "public_status", credentials("none"))).toEqual({ accepted: false, reason: "unknown_listener" });
    for (const route of unregisteredRouteClasses) expect((listenerKinds as readonly string[]).includes(route)).toBe(false);
  });
});

describe("authentication context", () => {
  const failure = (mint: () => unknown) => {
    try { mint(); } catch (error) { return error instanceof OperationError ? `${error.category}:${error.reason}` : String(error); }
    return "minted";
  };

  it("mints the actor fixed by the accepted path and revalidates without substitution", () => {
    const world = createWorld();
    const alice = world.human("alice");
    expect(alice.context.revalidate().actor).toEqual({ kind: "human", accountId: alice.id });
    world.verifier.update("provider_session", alice.credentialId, current => ({ ...current, actor: { kind: "human", accountId: A("mallory") } }));
    expect(failure(() => alice.context.revalidate())).toBe("unauthenticated:credential_no_longer_valid");
  });

  it("fails after revocation, rotation, a changed coordination session or a closed listener", () => {
    const world = createWorld();
    const bot = world.agent("bot");
    world.verifier.revoke("agent_token", bot.credentialId);
    expect(failure(() => bot.context.revalidate())).toBe("unauthenticated:credential_no_longer_valid");

    const installation = world.installation();
    world.verifier.update("installation_token", installation.credentialId, current => ({ ...current, identity: { ...current.identity, generation: 2 } }));
    expect(failure(() => installation.context.revalidate())).toBe("unauthenticated:credential_no_longer_valid");

    const other = world.agent("other");
    world.verifier.update("agent_token", other.credentialId, current => ({ ...current, coordinationSession: { ...current.coordinationSession!, id: "adopted" } }));
    expect(failure(() => other.context.revalidate())).toBe("unauthenticated:coordination_session_changed");

    const operator = world.operator();
    expect(operator.revalidate().actor).toEqual({ kind: "operator", via: "unix" });
    world.listenerOpen.value = false;
    expect(failure(() => operator.revalidate())).toBe("unauthenticated:listener_closed");
  });

  it("refuses a verifier answer whose actor does not fit the path", () => {
    const verifier = new FakeVerifier();
    verifier.register("token", "agent_token", "c", { kind: "installation" });
    verifier.register("cookie", "provider_session", "h", { kind: "agent", accountId: A("bot") });
    verifier.register("token2", "agent_token", "e", { kind: "agent", accountId: A("bot") }, { evidence: { authenticatedAt: 1 } });
    verifier.register("token3", "agent_token", "s", { kind: "agent", accountId: A("bot") }, { session: { id: "x", generation: 1, credentialId: "someone-else" } });
    const boundary = createListenerBoundary({ mode: "better-auth", listener: "api", verifier, open: () => true });
    expect(failure(() => boundary.mint(presented({ bearers: [{ class: "agent_token", secret: "token" }] })))).toBe("unauthenticated:invalid_credential");
    expect(failure(() => boundary.mint(presented({ providerSession: { secret: "cookie" } })))).toBe("unauthenticated:invalid_credential");
    expect(failure(() => boundary.mint(presented({ bearers: [{ class: "agent_token", secret: "token2" }] })))).toBe("unauthenticated:invalid_credential");
    expect(failure(() => boundary.mint(presented({ bearers: [{ class: "agent_token", secret: "token3" }] })))).toBe("unauthenticated:invalid_credential");
    expect(failure(() => boundary.mint(presented({ bearers: [{ class: "agent_token", secret: "wrong" }] })))).toBe("unauthenticated:invalid_credential");
    expect(failure(() => boundary.mint(presented({ bearers: [{ class: "installation_token", secret: "token" }] })))).toBe("unauthenticated:installation_token_in_account_mode");
  });

  it("is never serialized", () => {
    const world = createWorld();
    const context = world.human("alice").context;
    expect(() => JSON.stringify({ context })).toThrow(TypeError);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("grants offline operator authority only while the lock is held", () => {
    const lock = { held: true };
    const context = mintOfflineContext({ mode: "token", lockHeld: () => lock.held });
    expect(context.revalidate().actor).toEqual({ kind: "operator", via: "offline" });
    lock.held = false;
    expect(failure(() => context.revalidate())).toBe("unauthenticated:offline_lock_not_held");
    expect(failure(() => mintOfflineContext({ mode: "token", lockHeld: () => false }))).toBe("unauthenticated:offline_lock_not_held");
  });
});

describe("authority values are immutable copies", () => {
  const failure = (call: () => unknown) => {
    try { call(); } catch (error) { return error instanceof OperationError ? `${error.category}:${error.reason}` : String(error); }
    return "ok";
  };
  /** A verifier that hands out the same mutable objects it keeps, as a careless adapter would. */
  function sharingVerifier() {
    const stored = {
      identity: { path: "provider_session" as const, credentialId: "c-alice", generation: 1 },
      actor: { kind: "human" as const, accountId: A("alice") },
      evidence: { authenticatedAt: 1_000 },
      coordinationSession: { id: "s-1", generation: 1, credentialId: "c-alice" },
    };
    const verifier: CredentialVerifier = { verify: () => stored, current: () => stored };
    const context = createListenerBoundary({ mode: "better-auth", listener: "api", verifier, open: () => true })
      .mint(presented({ providerSession: { secret: "cookie" } }));
    return { stored, context };
  }

  it("returns a fresh deeply frozen copy on every revalidation", () => {
    const { context } = sharingVerifier();
    const first = context.revalidate();
    for (const value of [first, first.actor, first.evidence, first.coordinationSession]) expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(first.actor, "accountId", "mallory")).toBe(false);
    expect(Reflect.set(first.coordinationSession!, "id", "adopted")).toBe(false);
    expect(Reflect.set(first.evidence!, "authenticatedAt", 999_999)).toBe(false);
    const second = context.revalidate();
    expect(second).not.toBe(first);
    expect(second.actor).not.toBe(first.actor);
    expect(second).toEqual({ actor: { kind: "human", accountId: "alice" }, mode: "better-auth", listener: "api",
      evidence: { authenticatedAt: 1_000 }, coordinationSession: { id: "s-1", generation: 1, credentialId: "c-alice" } });
  });

  it("keeps the baseline when the verifier mutates the objects it returned", () => {
    for (const change of ["actor", "generation", "session", "credential"] as const) {
      const { stored, context } = sharingVerifier();
      if (change === "actor") stored.actor.accountId = A("mallory");
      if (change === "generation") stored.identity.generation = 2;
      if (change === "session") stored.coordinationSession.id = "adopted";
      if (change === "credential") stored.identity.credentialId = "c-mallory";
      // In place, on the very objects returned at mint: the baseline must not follow.
      expect(failure(() => context.revalidate())).toBe(change === "session" ? "unauthenticated:coordination_session_changed" : "unauthenticated:credential_no_longer_valid");
    }
  });

  it("does not let a verifier that mutates the identity it is given change the baseline", () => {
    let calls = 0;
    const credential = (): VerifiedCredential => ({
      identity: { path: "agent_token", credentialId: "c-bot", generation: 1 }, actor: { kind: "agent", accountId: A("bot") },
      evidence: null, coordinationSession: null,
    });
    const verifier: CredentialVerifier = {
      verify: credential,
      current: identity => { calls++; (identity as { generation: number }).generation = 7; return calls === 1 ? credential() : { ...credential(), identity: { ...credential().identity, generation: 7 } }; },
    };
    const context = createListenerBoundary({ mode: "better-auth", listener: "mcp", verifier, open: () => true })
      .mint(presented({ bearers: [{ class: "agent_token", secret: "t" }] }));
    expect(context.revalidate().actor).toEqual({ kind: "agent", accountId: "bot" });
    expect(failure(() => context.revalidate())).toBe("unauthenticated:credential_no_longer_valid");
  });
});
