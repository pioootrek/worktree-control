import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createListenerBoundary, type CredentialIdentity } from "../authentication-context";
import { AgentTokenVerifier } from "./agent-token-verifier";
import { agentWorld, failure, GONE, hash, INVALID, iso, NOW, presentedBearer, token, type MutableCredential } from "./credential-verifier-fixture";

// Every authentication assertion below goes through the real boundary and composite.
describe("agent token verification", () => {
  it("mints and revalidates an agent, with no evidence or coordination session", () => {
    const w = agentWorld();
    expect(w.mint().revalidate()).toEqual({ actor: { kind: "agent", accountId: w.row.principalId }, mode: "better-auth", listener: "api", evidence: null, coordinationSession: null });
    expect(Number.isSafeInteger(w.agent.verify("agent_token", w.secret)!.identity.generation)).toBe(true);
  });

  it.each([
    ["owner_session", "agent"], ["agent_token", "owner"], ["owner_session", "owner"],
    ["worker_token", "agent"], ["agent_token", "worker"], ["worker_token", "worker"], ["agent_token", "human"],
  ] as const)("refuses credential kind %s and principal kind %s despite a correct secret", (kind, principalKind) => {
    const w = agentWorld(); w.row.kind = kind; w.row.principal.kind = principalKind;
    expect(failure(() => w.mint())).toBe(INVALID);
  });

  it("refuses forged IDs and wrong secrets for real IDs", () => {
    const w = agentWorld();
    expect(failure(() => w.mint(token("wts")))).toBe(INVALID);
    expect(failure(() => w.mint(token("wts", w.row.id)))).toBe(INVALID);
  });

  it.each([-1, 0, 1])("expiry at now %+d ms has an exclusive deadline", delta => {
    const w = agentWorld(); w.row.expiresAt = iso(NOW + delta);
    expect(failure(() => w.mint())).toBe(delta > 0 ? "succeeded" : INVALID);
  });

  it("accepts a credential with no expiry", () => {
    const w = agentWorld(); w.row.expiresAt = null;
    expect(w.mint().revalidate().actor.kind).toBe("agent");
  });

  const deniedChanges: [string, (row: MutableCredential) => void][] = [
    ["credential disabled", row => { row.status = "revoked"; }],
    ["revocation timestamp alone", row => { row.revokedAt = iso(NOW); }],
    ["principal disabled", row => { row.principal.status = "revoked"; }],
    ["expired", row => { row.expiresAt = iso(NOW); }],
  ];
  it.each(deniedChanges)("refuses %s at mint", (_name, change) => {
    const w = agentWorld(); change(w.row);
    expect(failure(() => w.mint())).toBe(INVALID);
  });

  const faults: [string, (row: MutableCredential) => unknown][] = [
    ["throw", () => { throw new Error("reader failed"); }],
    ["promise", row => Promise.resolve(row)],
    ["rejected promise", () => Promise.reject(new Error("reader failed"))],
    ["thenable", row => ({ ...row, then: () => undefined })],
    ["throwing then getter", row => ({ ...row, get then(): never { throw new Error("then failed"); } })],
    ["null", () => null], ["empty row", () => ({})],
    ["wrong credential ID", row => ({ ...row, id: randomUUID() })],
    ["principal mismatch", row => ({ ...row, principalId: "another-agent" })],
    ["malformed principal", row => ({ ...row, principal: {} })],
    ["thenable principal", row => ({ ...row, principal: Promise.resolve(row.principal) })],
    ["bad account ID", row => ({ ...row, principalId: "bad/id", principal: { ...row.principal, id: "bad/id" } })],
    ["missing revocation fact", row => ({ ...row, revokedAt: undefined })],
    ["bad createdAt", row => ({ ...row, createdAt: "invalid" })],
    ["bad expiresAt", row => ({ ...row, expiresAt: "invalid" })],
    ["bad hash", row => ({ ...row, verifierHash: "invalid" })],
    ["field getter throw", row => ({ ...row, get status(): never { throw new Error("field failed"); } })],
  ];
  it.each(faults)("a reader returning %s gives no answer at mint or revalidation", (_name, read) => {
    const w = agentWorld(); const context = w.mint();
    w.reader.read = () => read(w.row);
    expect(failure(() => w.mint())).toBe(INVALID);
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it.each<[string, () => unknown]>([
    ["NaN", () => NaN], ["infinity", () => Infinity], ["negative infinity", () => -Infinity], ["string", () => "now"],
    ["throw", () => { throw new Error("clock failed"); }], ["promise", () => Promise.resolve(NOW)],
    ["rejection", () => Promise.reject(new Error("clock failed"))], ["thenable", () => ({ then: () => undefined })],
  ])("a clock returning %s gives no answer at mint or revalidation", (_name, read) => {
    const w = agentWorld(); const context = w.mint(); w.clock.read = read;
    expect(failure(() => w.mint())).toBe(INVALID);
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it("a mixed invalid cookie and valid bearer refuses before the agent reader", () => {
    const w = agentWorld(); w.reader.read = () => { throw new Error("must not read"); };
    const boundary = createListenerBoundary({ mode: "better-auth", listener: "api", verifier: w.composite, open: () => true });
    expect(failure(() => boundary.mint({ ...presentedBearer(w.secret), providerSession: { secret: "invalid-cookie" } }))).toBe("unauthenticated:mixed_credentials");
  });
});

describe("agent request revalidation", () => {
  const changes: [string, (row: MutableCredential) => void][] = [
    ["id", row => { row.id = randomUUID(); }],
    ["principalId", row => { row.principalId = "new-agent"; row.principal.id = "new-agent"; }],
    ["kind", row => { row.kind = "worker_token"; }],
    ["verifierHash", row => { row.verifierHash = hash(token("wts", row.id)); }],
    ["status", row => { row.status = "revoked"; }],
    ["expiresAt", row => { row.expiresAt = iso(NOW + 2000); }],
    ["createdAt", row => { row.createdAt = iso(NOW - 2000); }],
    ["revokedAt", row => { row.revokedAt = iso(NOW); }],
    ["principal.id", row => { row.principal.id = "mismatch"; }],
    ["principal.kind", row => { row.principal.kind = "owner"; }],
    ["principal.status", row => { row.principal.status = "revoked"; }],
    ["expiry reached", row => { row.expiresAt = iso(NOW); }],
  ];
  it.each(changes)("a change to %s ends the context", (_name, change) => {
    const w = agentWorld(), context = w.mint(); change(w.row);
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it("crossing expiry by the clock ends the context", () => {
    const w = agentWorld(), context = w.mint(); w.clock.read = () => NOW + 1000;
    expect(failure(() => context.revalidate())).toBe(GONE);
  });

  it.each(["lastUsedAt", "label", "tokenPrefix"] as const)("a change to %s preserves the context", key => {
    const w = agentWorld(), context = w.mint(); w.row[key] = key === "lastUsedAt" ? iso(NOW) : "changed";
    expect(context.revalidate().actor.kind).toBe("agent");
  });

  it.each(["credential", "principal"] as const)("disabling and re-enabling the %s with identical facts restores this request", target => {
    const w = agentWorld(), context = w.mint(), row = target === "credential" ? w.row : w.row.principal;
    row.status = "revoked"; expect(failure(() => context.revalidate())).toBe(GONE);
    row.status = "active"; expect(context.revalidate().actor.kind).toBe("agent");
    expect(w.mint().revalidate().actor.kind).toBe("agent");
  });

  it("same-ID secret replacement returns a changed identity; the boundary, not current, rejects it", () => {
    const w = agentWorld(), context = w.mint(), original = w.agent.verify("agent_token", w.secret)!.identity;
    const replacement = token("wts", w.row.id); w.row.verifierHash = hash(replacement);
    const current = w.agent.current(original)!;
    expect(current).not.toBeNull();
    expect(current.identity.generation === original.generation).toBe(false);
    expect(failure(() => context.revalidate())).toBe(GONE);
    expect(failure(() => w.mint())).toBe(INVALID);
    expect(w.mint(replacement).revalidate().actor.kind).toBe("agent");
  });

  it("pins the version and exact ordered fingerprint field list", () => {
    const w = agentWorld(), r = w.row;
    // Independent expected encoding: any field-list or version edit requires
    // this contract fixture to be reviewed too. Never assert or print secrets.
    const encoding = JSON.stringify(["wtc-agent-token-credential-v1", r.id, r.principalId, r.kind, r.verifierHash, r.status,
      r.expiresAt, r.createdAt, r.revokedAt, r.principal.id, r.principal.kind, r.principal.status]);
    const expected = createHash("sha256").update(encoding, "utf8").digest().readUIntBE(0, 6);
    const generation = w.agent.verify("agent_token", w.secret)!.identity.generation;
    expect(generation).toBe(expected);
    expect(generation).toBeGreaterThanOrEqual(0); expect(generation).toBeLessThan(2 ** 48);
  });

  it("wrong paths or malformed identities give no answer", () => {
    const w = agentWorld();
    expect(w.agent.verify("installation_token", w.secret)).toBeNull();
    for (const identity of [null, {}, { path: "agent_token", credentialId: w.row.id, generation: Infinity },
      { path: "provider_session", credentialId: w.row.id, generation: 1 }]) expect(w.agent.current(identity as CredentialIdentity)).toBeNull();
    expect(() => new AgentTokenVerifier({} as never)).toThrow(TypeError);
  });
});
