import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CredentialIdentity } from "../authentication-context";
import { failure, GONE, hash, installationWorld, INVALID, iso, NOW, token } from "./credential-verifier-fixture";
import { InstallationVerifier } from "./installation-verifier";

describe("installation verifier through the real boundary and composite", () => {
  it("mints in token mode with token ID and a fingerprint generation", () => {
    const w = installationWorld();
    expect(w.mint().revalidate()).toEqual({ actor: { kind: "installation" }, mode: "token", listener: "api", evidence: null, coordinationSession: null });
    const identity = w.installation.verify("installation_token", w.secret)!.identity;
    expect(identity).toEqual({ path: "installation_token", credentialId: w.policy.token!.id, generation: expect.any(Number) });
  });

  it("refuses wrong secrets and forged IDs", () => {
    const w = installationWorld();
    expect(failure(() => w.mint(token("wsi", w.policy.token!.id)))).toBe(INVALID);
    expect(failure(() => w.mint(token("wsi")))).toBe(INVALID);
  });

  it.each(["token", "open", "better-auth", "legacy"] as const)("active token mode ignores stored selection %s at mint and revalidation", mode => {
    const w = installationWorld(), context = w.mint(), baseline = context.revalidate();
    const identity = w.installation.verify("installation_token", w.secret)!.identity;
    w.policy.mode = mode;
    expect(w.mint().revalidate()).toEqual(baseline);
    expect(context.revalidate()).toEqual(baseline);
    expect(w.installation.current(identity)!.identity).toEqual(identity);
  });

  it.each(["id", "generation", "removed token"])("rotation (%s) ends the context", change => {
    const w = installationWorld(), context = w.mint();
    if (change === "id") {
      const id = randomUUID(); w.policy.token = { ...w.policy.token!, id, prefix: `wsi_${id}` };
    } else if (change === "generation") w.policy.generation++; else w.policy.token = null;
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it("same-ID hash replacement without a generation change ends the context", () => {
    const w = installationWorld(), context = w.mint();
    const original = w.installation.verify("installation_token", w.secret)!.identity;
    const replacement = token("wsi", w.policy.token!.id);
    w.policy.token = { ...w.policy.token!, verifierHash: hash(replacement) };
    const current = w.installation.current(original)!;
    expect(current).not.toBeNull();
    expect(current.identity.generation === original.generation).toBe(false);
    expect(failure(() => context.revalidate())).toBe(GONE);
    expect(failure(() => w.mint())).toBe(INVALID);
    expect(w.mint(replacement).revalidate().actor.kind).toBe("installation");
  });

  it("a changed token creation time ends the context", () => {
    const w = installationWorld(), context = w.mint();
    w.policy.token = { ...w.policy.token!, createdAt: iso(NOW - 1000) };
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it("pins the token fingerprint version, field order and 48-bit encoding", () => {
    const w = installationWorld(), p = w.policy, t = p.token!;
    p.mode = "better-auth";
    const encoding = JSON.stringify(["wtc-installation-credential-v2", "token", p.generation, t.id, t.prefix, t.verifierHash, t.createdAt]);
    const expected = createHash("sha256").update(encoding, "utf8").digest().readUIntBE(0, 6);
    const generation = w.installation.verify("installation_token", w.secret)!.identity.generation;
    expect(generation).toBe(expected);
    expect(generation).toBeGreaterThanOrEqual(0); expect(generation).toBeLessThan(2 ** 48);
  });

  it("pins the anonymous fingerprint version and fields, excluding token facts", () => {
    const w = installationWorld();
    const encoding = JSON.stringify(["wtc-installation-credential-v2", "open", w.policy.generation]);
    const expected = createHash("sha256").update(encoding, "utf8").digest().readUIntBE(0, 6);
    expect(w.openInstallation.verify("anonymous_installation", null)!.identity.generation).toBe(expected);
    const context = w.anonymous(); w.policy.token = null;
    expect(context.revalidate().actor.kind).toBe("installation");
    expect(w.openInstallation.verify("anonymous_installation", null)!.identity.generation).toBe(expected);
  });

  it("anonymous mints only in open mode, without a secret, and uses a non-token ID", () => {
    const w = installationWorld();
    const context = w.anonymous();
    expect(context.revalidate().actor.kind).toBe("installation");
    const identity = w.openInstallation.verify("anonymous_installation", null)!.identity;
    expect(identity).toEqual({ path: "anonymous_installation", credentialId: "anonymous-installation", generation: expect.any(Number) });
    expect(/^[0-9a-f-]{36}$/.test(identity.credentialId)).toBe(false);
    expect(w.openInstallation.verify("anonymous_installation", "")).toBeNull();
    expect(w.openInstallation.verify("anonymous_installation", w.secret)).toBeNull();
    expect(w.openInstallation.current({ ...identity, credentialId: w.policy.token!.id })).toBeNull();
    w.policy.generation++;
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it("anonymous needs no stored token", () => {
    const w = installationWorld(); w.policy.token = null;
    expect(w.anonymous().revalidate().actor.kind).toBe("installation");
  });

  it.each(["open", "token", "better-auth", "legacy"] as const)("active open mode ignores stored selection %s at mint and revalidation", mode => {
    const w = installationWorld(); w.policy.mode = "open";
    const context = w.anonymous(), baseline = context.revalidate();
    const identity = w.openInstallation.verify("anonymous_installation", null)!.identity;
    w.policy.mode = mode;
    expect(w.anonymous().revalidate()).toEqual(baseline);
    expect(context.revalidate()).toEqual(baseline);
    expect(w.openInstallation.current(identity)!.identity).toEqual(identity);
  });

  it.each(["open", "token", "better-auth", "legacy"] as const)("active better-auth refuses both installation paths with stored selection %s", mode => {
    const w = installationWorld(); w.policy.mode = mode;
    const verifier = new InstallationVerifier({ mode: "better-auth", reader: { getAuthenticationPolicy: () => w.policy } });
    const tokenIdentity = w.installation.verify("installation_token", w.secret)!.identity;
    const anonymousIdentity = w.openInstallation.verify("anonymous_installation", null)!.identity;
    expect(verifier.verify("installation_token", w.secret)).toBeNull();
    expect(verifier.verify("anonymous_installation", null)).toBeNull();
    expect(verifier.current(tokenIdentity)).toBeNull();
    expect(verifier.current(anonymousIdentity)).toBeNull();
  });

  it.each(["open", "token", "better-auth", "legacy"] as const)("refuses paths outside the active mode with stored selection %s", mode => {
    const w = installationWorld(); w.policy.mode = mode;
    const tokenIdentity = w.installation.verify("installation_token", w.secret)!.identity;
    const anonymousIdentity = w.openInstallation.verify("anonymous_installation", null)!.identity;
    expect(w.openInstallation.verify("installation_token", w.secret)).toBeNull();
    expect(w.openInstallation.current(tokenIdentity)).toBeNull();
    expect(w.installation.verify("anonymous_installation", null)).toBeNull();
    expect(w.installation.current(anonymousIdentity)).toBeNull();
  });

  const malformed: [string, (policy: ReturnType<typeof installationWorld>["policy"]) => unknown][] = [
    ["throw", () => { throw new Error("policy failed"); }],
    ["promise", policy => Promise.resolve(policy)], ["rejection", () => Promise.reject(new Error("policy failed"))],
    ["thenable", policy => ({ ...policy, then: () => undefined })], ["null", () => null], ["empty", () => ({})],
    ["unknown mode", policy => ({ ...policy, mode: "future" })],
    ["unsafe generation", policy => ({ ...policy, generation: Number.MAX_SAFE_INTEGER + 1 })],
    ["negative generation", policy => ({ ...policy, generation: -1 })],
    ["fractional generation", policy => ({ ...policy, generation: 1.5 })],
    ["infinite generation", policy => ({ ...policy, generation: Infinity })],
    ["missing token", policy => ({ ...policy, token: undefined })],
    ["thenable token", policy => ({ ...policy, token: Promise.resolve(policy.token) })],
    ["bad hash", policy => ({ ...policy, token: { ...policy.token, verifierHash: "bad" } })],
    ["bad ID", policy => ({ ...policy, token: { ...policy.token, id: "bad" } })],
    ["bad prefix", policy => ({ ...policy, token: { ...policy.token, prefix: "bad" } })],
    ["bad creation time", policy => ({ ...policy, token: { ...policy.token, createdAt: NOW } })],
    ["throwing field", policy => ({ ...policy, get mode(): never { throw new Error("field failed"); } })],
  ];
  it.each(malformed)("a policy reader returning %s gives no answer", (_name, read) => {
    const w = installationWorld(), context = w.mint(), anonymousContext = w.anonymous();
    w.reader.read = () => read(w.policy);
    expect(failure(() => w.mint())).toBe(INVALID);
    expect(failure(() => context.revalidate())).toBe(GONE);
    expect(failure(() => w.anonymous())).toBe(INVALID);
    expect(failure(() => anonymousContext.revalidate())).toBe(GONE);
    expect(w.openInstallation.verify("anonymous_installation", null)).toBeNull();
  });

  it("refuses missing secrets, wrong paths and malformed identities", () => {
    const w = installationWorld();
    expect(w.installation.verify("installation_token", null)).toBeNull();
    expect(w.installation.verify("agent_token", w.secret)).toBeNull();
    for (const identity of [null, {}, { path: "installation_token", credentialId: w.policy.token!.id, generation: NaN },
      { path: "agent_token", credentialId: w.policy.token!.id, generation: 7 }]) expect(w.installation.current(identity as CredentialIdentity)).toBeNull();
    expect(() => new InstallationVerifier({} as never)).toThrow(TypeError);
  });

  it("requires an explicit active mode and a policy reader", () => {
    const w = installationWorld(), reader = { getAuthenticationPolicy: () => w.policy };
    expect(() => new InstallationVerifier({ reader } as never)).toThrow(TypeError);
    expect(() => new InstallationVerifier({ mode: "token" } as never)).toThrow(TypeError);
  });

  it.each([{ mode: "legacy" }, { mode: "future" }, { mode: "" }, { mode: null }, { mode: undefined }, { mode: 0 }, { mode: {} }, { mode: [] }])(
    "refuses invalid active mode $mode at construction", ({ mode }) => {
      const w = installationWorld();
      expect(() => new InstallationVerifier({ mode, reader: { getAuthenticationPolicy: () => w.policy } } as never)).toThrow(TypeError);
    },
  );
});
