import { describe, expect, it } from "vitest";
import type { ProviderSessionState, VerifiedProviderSession } from "@/server/modules/authentication";
import { FRESH_LOGIN_WINDOW_MS } from "@/shared/contracts/operations";
import { createListenerBoundary, type AuthenticationContext, type CredentialIdentity } from "../authentication-context";
import { OperationError } from "../errors";
import { A, createWorld, presented } from "../operations-fixture";
import { onProject, type OperationRequirement } from "../requirements";
import { OperationRunner } from "../runner";
import { fakeStart, input, projectA, REGISTRATION } from "../runner-fixture";
import { createProviderWorld, PROVIDER_ID, SESSION_MS } from "./provider-session-fixture";
import { ProviderSessionVerifier, type ProviderSessionReader } from "./provider-session-verifier";

/**
 * Slice 2 gate: session freshness from committed provider evidence, through
 * the real listener boundary (`better-auth`, `api`) and the real runner.
 * Sessions and evidence come from the real `AccountProtection`; see
 * `provider-session-fixture.ts` for what is hand-written.
 */
const FRESH: OperationRequirement = { require: onProject("runtime:control", "registration"), freshLogin: true };
const PLAIN: OperationRequirement = { require: onProject("runtime:control", "registration") };
const iso = (time: number) => new Date(time).toISOString();

const notStarted = (category: string, reason: string) => ({ ok: false, error: { category, reason, effect: "not_started" } });
const STALE = notStarted("login_stale", "fresh_login_required");
const GONE = { ok: false, error: { category: "unauthenticated", status: 401, reason: "credential_no_longer_valid", retry: "reauthenticate", effect: "not_started" } };

function setup(options: { reader?: (store: ProviderSessionReader) => ProviderSessionReader; runnerSkewMs?: number } = {}) {
  const world = createWorld();
  world.resolver.addProject(projectA).put(REGISTRATION, projectA);
  const provider = createProviderWorld(world.clock);
  const reader = options.reader ? options.reader(provider.store) : provider.store;
  const verifier = new ProviderSessionVerifier({ providerId: PROVIDER_ID, reader, now: () => world.clock.now, stagedCapacity: 8, stagedTtlMs: 5_000 });
  const boundary = createListenerBoundary({ mode: "better-auth", listener: "api", verifier, open: () => true });
  const skew = options.runnerSkewMs ?? 0;
  const runner = new OperationRunner({ ...world.runtime(), now: () => world.clock.now + skew });

  /** A human account with `operator` on project A. */
  const person = (name = "alice") => {
    const subject = provider.account(name);
    world.grants.account(A(name), "human");
    world.grants.grant({ accountId: A(name), role: "operator", scope: { kind: "project", projectId: projectA } });
    return subject;
  };
  /** What a transport would do with a session the provider resolved: stage it, present the handle. */
  const mint = (session: VerifiedProviderSession): AuthenticationContext => {
    const handle = verifier.stage(session);
    if (!handle) throw new Error("stage refused");
    return boundary.mint(presented({ providerSession: { secret: handle }, browserHeaders: true }));
  };
  const mintFailure = (session: VerifiedProviderSession): string => {
    try { mint(session); return "minted"; } catch (error) {
      return error instanceof OperationError ? `${error.category}:${error.reason}` : `other:${String(error)}`;
    }
  };
  const run = async (context: AuthenticationContext, requirement = FRESH, hooks: Parameters<typeof fakeStart>[1] = {}) => {
    const { operation, log } = fakeStart(world, { ...hooks, requirement });
    const result = await runner.run(operation, context, input);
    return { result, log };
  };
  /** Runs `change` when the runner re-admits for the effect (the admission after the initial one). */
  const beforeEffect = (change: () => void) => {
    const start = world.admission.events.length;
    world.admission.onAdmit = event => { if (event.n === start + 2) change(); };
  };
  const evidenceTime = (session: VerifiedProviderSession) => Date.parse(provider.store.evidenceRows.get(session.sessionId)!.authenticatedAt);
  return { world, provider, verifier, boundary, runner, person, mint, mintFailure, run, beforeEffect, evidenceTime };
}

describe("slice 2 gate 1: three login methods", () => {
  it("password: authenticates a human and carries the evidence's authentication time", async () => {
    const { world, person, provider, mint, run, evidenceTime } = setup();
    const session = provider.passwordLogin(person());
    const context = mint(session);
    expect(context.revalidate()).toMatchObject({ actor: { kind: "human", accountId: "alice" }, mode: "better-auth", listener: "api", evidence: { authenticatedAt: world.clock.now } });
    expect(context.revalidate().evidence?.authenticatedAt).toBe(evidenceTime(session));
    expect(provider.store.evidenceRows.get(session.sessionId)?.method).toBe("password");
    expect((await run(context)).result).toMatchObject({ ok: true });
  });

  it("password_totp: carries the password stage's time, not the session's creation", async () => {
    const { world, person, provider, mint, run, evidenceTime } = setup();
    const subject = person();
    provider.enrollTotp(subject, provider.passwordLogin(subject));
    world.clock.now += 60_000;
    const passwordAt = world.clock.now;
    const session = provider.totpLogin(subject, 2_000);
    expect(provider.store.evidenceRows.get(session.sessionId)).toMatchObject({ method: "password_totp", authenticatedAt: iso(passwordAt) });
    expect(session.createdAt).toBe(iso(passwordAt + 2_000));
    const context = mint(session);
    expect(context.revalidate().evidence?.authenticatedAt).toBe(passwordAt);
    expect(evidenceTime(session)).toBe(passwordAt);
    expect((await run(context)).result).toMatchObject({ ok: true });
  });

  it("password_totp: a TOTP code completed ten minutes after the password is already stale", async () => {
    const { world, person, provider, mint, run } = setup();
    const subject = person();
    provider.enrollTotp(subject, provider.passwordLogin(subject));
    world.clock.now += 60_000;
    const passwordAt = world.clock.now;
    const session = provider.totpLogin(subject, FRESH_LOGIN_WINDOW_MS);
    const context = mint(session);
    expect(context.revalidate().evidence?.authenticatedAt).toBe(passwordAt);
    const stale = await run(context);
    expect(stale.result).toMatchObject(STALE);
    expect(stale.log.effects).toEqual([]);
    // The session itself is valid: an operation without fresh login runs.
    expect((await run(context, PLAIN)).result).toMatchObject({ ok: true });
  });

  it("passkey_uv: authenticates with the passkey login's time", async () => {
    const { world, person, provider, mint, run, evidenceTime } = setup();
    const subject = person();
    const credential = provider.enrollPasskey(subject, provider.passwordLogin(subject));
    world.clock.now += 120_000;
    const session = provider.passkeyLogin(credential);
    expect(provider.store.evidenceRows.get(session.sessionId)).toMatchObject({ method: "passkey_uv", credential });
    const context = mint(session);
    expect(context.revalidate()).toMatchObject({ actor: { kind: "human", accountId: "alice" }, evidence: { authenticatedAt: world.clock.now } });
    expect(evidenceTime(session)).toBe(world.clock.now);
    expect((await run(context)).result).toMatchObject({ ok: true });
  });

  it("an owner principal is a human actor too", () => {
    const { provider, world, mint } = setup();
    const subject = provider.account("root", "owner");
    world.grants.account(A("root"), "human");
    expect(mint(provider.passwordLogin(subject)).revalidate().actor).toEqual({ kind: "human", accountId: "root" });
  });
});

describe("slice 2 gate 2: refresh and inheritance do not renew freshness", () => {
  it("a refreshed session keeps its original authentication time", async () => {
    const { world, person, provider, mint, run } = setup();
    const loginAt = world.clock.now;
    const session = provider.passwordLogin(person());
    const before = mint(session);
    world.clock.now += FRESH_LOGIN_WINDOW_MS - 1_000;
    const refreshed = provider.refresh(session);
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(Date.parse(session.expiresAt));
    const after = mint(refreshed);
    expect(after.revalidate().evidence?.authenticatedAt).toBe(loginAt);
    expect((await run(after)).result).toMatchObject({ ok: true });
    world.clock.now += 1_000;
    for (const context of [before, after]) {
      expect(context.revalidate().evidence?.authenticatedAt).toBe(loginAt);
      expect((await run(context)).result).toMatchObject(STALE);
      expect((await run(context, PLAIN)).result).toMatchObject({ ok: true });
    }
  });

  it("a session exchanged on password change inherits the old time and deadline", async () => {
    const { world, person, provider, mint, run } = setup();
    const loginAt = world.clock.now;
    const original = provider.passwordLogin(person());
    const old = mint(original);
    const deadline = provider.store.evidenceRows.get(original.sessionId)!.originalDeadline;
    world.clock.now += 300_000;
    const exchanged = provider.changePassword(original);
    expect(exchanged.sessionId).not.toBe(original.sessionId);
    expect(provider.store.evidenceRows.get(exchanged.sessionId)).toMatchObject({ authenticatedAt: iso(loginAt), originalDeadline: deadline });
    expect(exchanged.expiresAt).toBe(deadline);
    const context = mint(exchanged);
    expect(context.revalidate().evidence?.authenticatedAt).toBe(loginAt);
    expect((await run(context)).result).toMatchObject({ ok: true });
    world.clock.now = loginAt + FRESH_LOGIN_WINDOW_MS;
    expect((await run(context)).result).toMatchObject(STALE);
    // The exchanged-out session was revoked with the change.
    expect((await run(old, PLAIN)).result).toMatchObject(GONE);
  });
});

describe("slice 2 gate 3: re-login", () => {
  it("a new login is fresh; a context minted from the old session is not upgraded", async () => {
    const { world, person, provider, mint, run, verifier } = setup();
    const subject = person();
    const firstAt = world.clock.now;
    const first = provider.passwordLogin(subject);
    const old = mint(first);
    world.clock.now += FRESH_LOGIN_WINDOW_MS;
    expect((await run(old)).result).toMatchObject(STALE);
    const second = provider.passwordLogin(subject);
    const renewed = mint(second);
    expect(renewed.revalidate().evidence?.authenticatedAt).toBe(world.clock.now);
    expect((await run(renewed)).result).toMatchObject({ ok: true });
    // Both sessions are current; each context still reads only its own.
    expect(old.revalidate().evidence?.authenticatedAt).toBe(firstAt);
    expect((await run(old)).result).toMatchObject(STALE);
    // The verifier answers each session's identity with that session's own time.
    const answers = [first, second].map(session => verifier.verify("provider_session", verifier.stage(session)));
    expect(answers.map(answer => answer?.evidence?.authenticatedAt)).toEqual([firstAt, world.clock.now]);
    expect(answers[0]!.identity.credentialId).toBe(first.sessionId);
    expect(verifier.current(answers[0]!.identity)?.evidence?.authenticatedAt).toBe(firstAt);
  });
});

describe("slice 2 gate 4: the ten-minute boundary", () => {
  it("allows 599999 ms and refuses 600000 ms", async () => {
    for (const [age, expected] of [[FRESH_LOGIN_WINDOW_MS - 1, { ok: true }], [FRESH_LOGIN_WINDOW_MS, STALE]] as const) {
      const { world, person, provider, mint, run } = setup();
      const loginAt = world.clock.now;
      const context = mint(provider.passwordLogin(person()));
      world.clock.now = loginAt + age;
      const { result, log } = await run(context);
      expect(result).toMatchObject(expected);
      expect(log.effects).toEqual(age < FRESH_LOGIN_WINDOW_MS ? ["start project-a"] : []);
    }
  });

  it("refuses authentication after now: the provider rule refuses the session itself", async () => {
    const { world, person, provider, mint, mintFailure, run } = setup();
    const subject = person();
    const loginAt = world.clock.now;
    const session = provider.passwordLogin(subject);
    const context = mint(session);
    world.clock.now = loginAt - 1;
    expect(mintFailure(provider.claim(session.sessionId))).toBe("unauthenticated:invalid_credential");
    expect((await run(context)).result).toMatchObject(GONE);
  });

  it("refuses authentication after now: the contract's rule, when only the runner's clock is behind", async () => {
    const { world, person, provider, mint, run } = setup({ runnerSkewMs: -1 });
    const context = mint(provider.passwordLogin(person()));
    expect(context.revalidate().evidence?.authenticatedAt).toBe(world.clock.now);
    expect((await run(context)).result).toMatchObject(STALE);
    expect((await run(context, PLAIN)).result).toMatchObject({ ok: true });
  });

  it("a session that becomes stale between admission and the effect is denied before the effect", async () => {
    const { world, person, provider, mint, run, beforeEffect } = setup();
    const loginAt = world.clock.now;
    const context = mint(provider.passwordLogin(person()));
    world.clock.now = loginAt + FRESH_LOGIN_WINDOW_MS - 1;
    beforeEffect(() => { world.clock.now += 1; });
    const { result, log } = await run(context);
    expect(result).toMatchObject(STALE);
    expect(log).toMatchObject({ effects: [], audit: [], lockHeld: false, lockReleases: 1 });
  });
});

type Provider = ReturnType<typeof setup>["provider"];
interface Change { name: string; login: (provider: Provider, subject: string, clock: { now: number }) => VerifiedProviderSession; change: (provider: Provider, session: VerifiedProviderSession, clock: { now: number }) => void }

/**
 * Each change, and only that change. Hand-written row edits, except where a
 * real provider operation exists for exactly that change (refresh). The
 * sessions themselves come from the real protection code.
 */
const CHANGES: readonly Change[] = [
  { name: "session removed", login: (provider, subject) => provider.passwordLogin(subject),
    change: (provider, session) => { provider.store.sessions.delete(session.sessionId); } },
  { name: "session expired", login: (provider, subject) => provider.passwordLogin(subject),
    change: (provider, session, clock) => { clock.now += 1_000; provider.store.sessions.get(session.sessionId)!.expiresAt = iso(clock.now); } },
  { name: "original deadline passed",
    login: (provider, subject, clock) => { const session = provider.passwordLogin(subject); clock.now += 86_400_000; return provider.refresh(session); },
    change: (provider, session, clock) => {
      const deadline = Date.parse(provider.store.evidenceRows.get(session.sessionId)!.originalDeadline);
      expect(Date.parse(provider.store.sessions.get(session.sessionId)!.expiresAt)).toBeGreaterThan(deadline);
      clock.now = deadline;
    } },
  { name: "account generation advanced", login: (provider, subject) => provider.passwordLogin(subject),
    change: (provider, session) => { provider.store.accounts.get(session.subject)!.generation++; } },
  { name: "policy revision advanced", login: (provider, subject) => provider.passwordLogin(subject),
    change: (provider, session) => { provider.store.accounts.get(session.subject)!.policyRevision++; } },
  { name: "factor binding changed",
    login: (provider, subject, clock) => { provider.enrollTotp(subject, provider.passwordLogin(subject)); clock.now += 1_000; return provider.totpLogin(subject, 1_000); },
    change: (provider, session) => { provider.store.users.get(session.subject)!.totp!.secret = "re-encrypted-ciphertext"; } },
  { name: "account inconsistent", login: (provider, subject) => provider.passwordLogin(subject),
    change: (provider, session) => { provider.store.users.set(session.subject, { twoFactorEnabled: true, totp: { id: "native-only", secret: "s", verified: true } }); } },
  { name: "subject mapping revoked", login: (provider, subject) => provider.passwordLogin(subject),
    change: (provider, session) => { provider.store.mappings.get(session.subject)!.status = "revoked"; } },
];

describe("slice 2 gate 5: revocation and change", () => {
  for (const { name, login, change } of CHANGES) {
    it(`${name}: unauthenticated at admission, before the effect and at release`, async () => {
      for (const point of ["admission", "before effect", "release"] as const) {
        const { world, person, provider, mint, run, beforeEffect } = setup();
        const session = login(provider, person(), world.clock);
        const context = mint(session);
        expect(context.revalidate().actor).toEqual({ kind: "human", accountId: "alice" });
        const apply = () => change(provider, session, world.clock);
        if (point === "admission") apply();
        if (point === "before effect") beforeEffect(apply);
        const { result, log } = await run(context, PLAIN, point === "release" ? { duringEffect: apply } : {});
        if (point === "release") {
          expect(result).toMatchObject({ ok: false, error: { category: "unauthenticated", reason: "credential_no_longer_valid", effect: "committed" } });
          expect(log.effects).toEqual(["start project-a"]);
          expect(JSON.stringify(result)).not.toMatch(/4242|project-a/);
        } else {
          expect(result).toEqual(GONE);
          expect(log.effects).toEqual([]);
        }
        expect(log.lockHeld).toBe(false);
        expect(() => context.revalidate()).toThrow(OperationError);
      }
    });
  }

  it("a relinked mapping, which the provider rule does not see, is another credential", () => {
    const { world, person, provider, mint, verifier } = setup();
    const session = provider.passwordLogin(person());
    const context = mint(session);
    const identity: CredentialIdentity = verifier.verify("provider_session", verifier.stage(session))!.identity;
    provider.store.mappings.get(session.subject)!.linkedAt = iso(world.clock.now - 1);
    // The committed session still authorizes under the provider rule...
    expect(verifier.verify("provider_session", verifier.stage(session))?.actor).toEqual({ kind: "human", accountId: "alice" });
    // ...but the fingerprint generation changed, so the old identity answers nothing.
    expect(verifier.current(identity)).toBeNull();
    expect(() => context.revalidate()).toThrow("unauthenticated: credential_no_longer_valid");
  });
});

describe("slice 2 gate 6: no evidence", () => {
  const withoutEvidence = (provider: Provider, subject: string, now: number): VerifiedProviderSession => {
    // Hand-written: a native session row the protection code never recorded evidence for.
    provider.store.sessions.set("session-bare", { subject, createdAt: iso(now), expiresAt: iso(now + SESSION_MS) });
    return { providerId: PROVIDER_ID, sessionId: "session-bare", subject, createdAt: iso(now), expiresAt: iso(now + SESSION_MS), authentication: { method: "password", factors: 1 } };
  };

  it("refuses a session without evidence", () => {
    const { world, person, provider, mintFailure } = setup();
    expect(mintFailure(withoutEvidence(provider, person(), world.clock.now))).toBe("unauthenticated:invalid_credential");
  });

  it("refuses a session whose evidence disappears after mint", async () => {
    const { person, provider, mint, run } = setup();
    const session = provider.passwordLogin(person());
    const context = mint(session);
    provider.store.evidenceRows.delete(session.sessionId);
    expect((await run(context, PLAIN)).result).toEqual(GONE);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a non-canonical authentication time", { authenticatedAt: "2026-11-13T12:00:00Z" }],
    ["an unparseable authentication time", { authenticatedAt: "yesterday" }],
    ["a missing authentication time", { authenticatedAt: undefined }],
    ["an unknown method", { method: "sms" }],
    ["evidence of another session", { sessionId: "session-other" }],
    ["evidence of another subject", { subject: "subject-mallory" }],
    ["a generation of the wrong type", { generation: "1" }],
    ["a deadline before the authentication", { originalDeadline: "2026-11-13T11:00:00.000Z" }],
  ])("refuses malformed evidence: %s", (_, change) => {
    const { person, provider, mintFailure } = setup();
    const session = provider.passwordLogin(person());
    Object.assign(provider.store.evidenceRows.get(session.sessionId)!, change);
    expect(mintFailure(session)).toBe("unauthenticated:invalid_credential");
  });
});

describe("slice 2 gate 7: no substitution", () => {
  it("current answers only for the same session and account", () => {
    const { world, provider, verifier, mint } = setup();
    for (const name of ["alice", "bob"]) { provider.account(name); world.grants.account(A(name), "human"); }
    const alice = provider.passwordLogin("subject-alice"), bob = provider.passwordLogin("subject-bob");
    const aliceContext = mint(alice), bobContext = mint(bob);
    const aliceAnswer = verifier.verify("provider_session", verifier.stage(alice));
    const bobAnswer = verifier.verify("provider_session", verifier.stage(bob));
    expect(aliceAnswer?.actor).toEqual({ kind: "human", accountId: "alice" });
    expect(bobAnswer?.actor).toEqual({ kind: "human", accountId: "bob" });
    // Alice's session ID with Bob's generation, and the reverse, answer nothing.
    expect(verifier.current({ path: "provider_session", credentialId: alice.sessionId, generation: bobAnswer!.identity.generation })).toBeNull();
    expect(verifier.current({ path: "provider_session", credentialId: bob.sessionId, generation: aliceAnswer!.identity.generation })).toBeNull();
    for (const path of ["agent_token", "installation_token", "anonymous_installation", "operator_unix", "operator_offline"] as const) {
      expect(verifier.current({ ...aliceAnswer!.identity, path })).toBeNull();
    }
    // Alice's session relinked to Bob's principal is not Bob's credential, nor still Alice's.
    provider.store.mappings.set(alice.subject, { ...provider.store.mappings.get(bob.subject)! });
    expect(verifier.current(aliceAnswer!.identity)).toBeNull();
    expect(() => aliceContext.revalidate()).toThrow("unauthenticated: credential_no_longer_valid");
    expect(bobContext.revalidate().actor).toEqual({ kind: "human", accountId: "bob" });
  });

  it("mutating anything the adapter returned or was given changes no later decision", async () => {
    const { world, person, provider, verifier, mint, run, boundary } = setup();
    const loginAt = world.clock.now;
    const session = provider.passwordLogin(person());
    const context = mint(session);
    const answer = verifier.verify("provider_session", verifier.stage(session))!;
    const { generation } = answer.identity;
    const current = verifier.current(answer.identity)!;
    for (const value of [answer, current]) {
      (value.actor as { accountId: string }).accountId = "mallory";
      (value.evidence as { authenticatedAt: number }).authenticatedAt = world.clock.now + 10 * FRESH_LOGIN_WINDOW_MS;
      Object.assign(value.identity, { credentialId: "session-other", generation: 0 });
    }
    world.clock.now += FRESH_LOGIN_WINDOW_MS;
    expect(context.revalidate()).toMatchObject({ actor: { kind: "human", accountId: "alice" }, evidence: { authenticatedAt: loginAt } });
    expect((await run(context)).result).toMatchObject(STALE);
    expect(verifier.current({ path: "provider_session", credentialId: session.sessionId, generation })).toMatchObject({
      actor: { kind: "human", accountId: "alice" }, evidence: { authenticatedAt: loginAt } });
    // A claim changed after staging is not what verify compares: the staged copy is.
    const staged = provider.claim(session.sessionId);
    const handle = verifier.stage(staged)!;
    staged.subject = "subject-mallory";
    staged.sessionId = "session-other";
    expect(boundary.mint(presented({ providerSession: { secret: handle }, browserHeaders: true })).revalidate().actor).toEqual({ kind: "human", accountId: "alice" });
  });
});

describe("provider session verifier: handoff and failures", () => {
  it("accepts only a staged handle, once, before it expires", () => {
    const { world, person, provider, verifier, mintFailure, boundary } = setup();
    const session = provider.passwordLogin(person());
    const mintWith = (secret: string) => {
      try { boundary.mint(presented({ providerSession: { secret }, browserHeaders: true })); return "minted"; } catch (error) { return (error as OperationError).reason; }
    };
    for (const secret of [session.sessionId, "cookie-value", ""]) expect(mintWith(secret)).toBe("invalid_credential");
    const handle = verifier.stage(session)!;
    expect(verifier.verify("agent_token", handle)).toBeNull();
    expect(mintWith(handle)).toBe("minted");
    expect(mintWith(handle)).toBe("invalid_credential");
    const late = verifier.stage(session)!;
    world.clock.now += 5_000;
    expect(mintWith(late)).toBe("invalid_credential");
    expect(mintFailure(session)).toBe("minted");
  });

  it("refuses a claim that disagrees with committed state, another provider and a full registry", () => {
    const { world, person, provider, verifier, mintFailure } = setup();
    const session = provider.passwordLogin(person());
    expect(mintFailure({ ...session, createdAt: iso(world.clock.now - 1) })).toBe("unauthenticated:invalid_credential");
    expect(mintFailure({ ...session, subject: "subject-mallory" })).toBe("unauthenticated:invalid_credential");
    expect(mintFailure({ ...session, authentication: { method: "passkey_uv", factors: 2 } })).toBe("unauthenticated:invalid_credential");
    expect(verifier.stage({ ...session, providerId: "other" })).toBeNull();
    expect(verifier.stage({ ...session, createdAt: "now" })).toBeNull();
    for (let index = 0; index < 8; index++) expect(verifier.stage(session)).not.toBeNull();
    expect(verifier.stage(session)).toBeNull();
    expect(verifier.staged).toBe(8);
    world.clock.now += 5_000;
    expect(verifier.stage(session)).not.toBeNull();
    expect(verifier.staged).toBe(1);
  });

  it("answers null without passing on a reader's throw or promise, and for a broken clock", () => {
    let mode: "ok" | "throw" | "promise" = "ok";
    const { world, person, provider, verifier, mint } = setup({
      reader: store => ({
        currentSession: (providerId, sessionId): ProviderSessionState | null => {
          if (mode === "throw") throw new Error("SQLITE_BUSY /var/lib/secret.sqlite3 token=abc");
          if (mode === "promise") return Promise.reject(new Error("async /secret")) as unknown as ProviderSessionState;
          return store.currentSession(providerId, sessionId);
        },
      }),
    });
    const session = provider.passwordLogin(person());
    const context = mint(session);
    for (const failing of ["throw", "promise"] as const) {
      mode = failing;
      expect(verifier.verify("provider_session", verifier.stage(session))).toBeNull();
      let message = "";
      try { context.revalidate(); } catch (error) { message = `${(error as Error).message} ${String((error as Error).cause ?? "")}`; }
      expect(message).toBe("unauthenticated: credential_no_longer_valid ");
    }
    mode = "ok";
    expect(context.revalidate().actor).toEqual({ kind: "human", accountId: "alice" });
    world.clock.now = Number.NaN;
    expect(() => context.revalidate()).toThrow("unauthenticated: credential_no_longer_valid");
  });

  it("validates its options and has no defaults", () => {
    const reader: ProviderSessionReader = { currentSession: () => null };
    const valid = { providerId: PROVIDER_ID, reader, now: () => 0, stagedCapacity: 1, stagedTtlMs: 1 };
    expect(() => new ProviderSessionVerifier(valid)).not.toThrow();
    for (const change of [{ providerId: "" }, { reader: {} }, { now: 0 }, { stagedCapacity: 0 }, { stagedTtlMs: 1.5 }, { stagedCapacity: undefined }]) {
      expect(() => new ProviderSessionVerifier({ ...valid, ...change } as never)).toThrow(TypeError);
    }
  });
});
