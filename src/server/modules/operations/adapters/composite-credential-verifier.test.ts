import { describe, expect, it, vi } from "vitest";
import { accountId } from "@/shared/contracts/operations";
import type { AcceptedPath } from "../acceptance";
import { createListenerBoundary, type CredentialIdentity, type CredentialVerifier, type VerifiedCredential } from "../authentication-context";
import { createWorld, presented } from "../operations-fixture";
import { CompositeCredentialVerifier } from "./composite-credential-verifier";
import { failure, INVALID } from "./credential-verifier-fixture";
import { createProviderWorld } from "./provider-session-fixture";
import { ProviderSessionVerifier } from "./provider-session-verifier";

const paths: AcceptedPath[] = ["anonymous_installation", "installation_token", "agent_token", "provider_session", "operator_unix", "operator_offline"];
const identity = (path: AcceptedPath): CredentialIdentity => ({ path, credentialId: "test-credential", generation: 1 });
const answer = (path: AcceptedPath): VerifiedCredential => ({ identity: identity(path),
  actor: path === "agent_token" ? { kind: "agent", accountId: accountId("test-agent") }
    : path === "provider_session" ? { kind: "human", accountId: accountId("test-human") } : { kind: "installation" },
  evidence: null, coordinationSession: null });
const half = () => ({ verify: vi.fn((path: AcceptedPath) => answer(path)), current: vi.fn((id: CredentialIdentity) => answer(id.path)) });

describe("composite credential verifier", () => {
  it.each(paths)("%s reaches exactly its half for verify and current", path => {
    const installation = half(), agent = half(), providerSession = half();
    const composite = new CompositeCredentialVerifier({ installation, agent, providerSession });
    const selected = path === "anonymous_installation" || path === "installation_token" ? installation
      : path === "agent_token" ? agent : path === "provider_session" ? providerSession : null;
    expect(composite.verify(path, "synthetic-secret")?.identity.path ?? null).toBe(selected ? path : null);
    expect(composite.current(identity(path))?.identity.path ?? null).toBe(selected ? path : null);
    for (const candidate of [installation, agent, providerSession]) {
      expect(candidate.verify).toHaveBeenCalledTimes(candidate === selected ? 1 : 0);
      expect(candidate.current).toHaveBeenCalledTimes(candidate === selected ? 1 : 0);
    }
    if (selected) {
      expect(selected.verify).toHaveBeenCalledWith(path, "synthetic-secret");
      expect(selected.current).toHaveBeenCalledWith(identity(path));
    }
  });

  it.each(paths)("%s with a missing half is null", path => {
    const composite = new CompositeCredentialVerifier({ installation: null, agent: null, providerSession: null });
    expect(composite.verify(path, null)).toBeNull(); expect(composite.current(identity(path))).toBeNull();
  });

  it.each<[string, () => unknown]>([
    ["null", () => null], ["throw", () => { throw new Error("half failed"); }],
    ["promise", () => Promise.resolve(answer("agent_token"))], ["rejection", () => Promise.reject(new Error("half failed"))],
    ["thenable", () => ({ ...answer("agent_token"), then: () => undefined })],
    ["another path", () => answer("provider_session")], ["malformed", () => ({})],
  ])("a half returning %s cannot fall back", (_name, call) => {
    const installation = half(), providerSession = half();
    const agent = { verify: call, current: call } as CredentialVerifier;
    const composite = new CompositeCredentialVerifier({ installation, providerSession, agent });
    expect(composite.verify("agent_token", "synthetic-secret")).toBeNull(); expect(composite.current(identity("agent_token"))).toBeNull();
    expect(installation.verify).not.toHaveBeenCalled(); expect(providerSession.verify).not.toHaveBeenCalled();
    expect(installation.current).not.toHaveBeenCalled(); expect(providerSession.current).not.toHaveBeenCalled();
  });

  it("passes a real staged provider session to the existing human verifier", () => {
    const world = createWorld(), provider = createProviderWorld(world.clock);
    const subject = provider.account("test-human"), session = provider.passwordLogin(subject);
    const human = new ProviderSessionVerifier({ providerId: session.providerId, reader: provider.store, now: () => world.clock.now,
      stagedCapacity: 4, stagedTtlMs: 1000, eligible: () => true });
    const composite = new CompositeCredentialVerifier({ installation: null, agent: null, providerSession: human });
    const boundary = createListenerBoundary({ mode: "better-auth", listener: "api", verifier: composite, open: () => true });
    const handle = human.stage(session)!;
    expect(boundary.mint(presented({ providerSession: { secret: handle } })).revalidate().actor.kind).toBe("human");
    expect(failure(() => boundary.mint(presented({ providerSession: { secret: handle } })))).toBe(INVALID);
  });

  it("requires explicit options, including null for missing halves", () => {
    expect(() => new CompositeCredentialVerifier({} as never)).toThrow(TypeError);
    expect(() => new CompositeCredentialVerifier({ installation: null, agent: null } as never)).toThrow(TypeError);
  });
});
