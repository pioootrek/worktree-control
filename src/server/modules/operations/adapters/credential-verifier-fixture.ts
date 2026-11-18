import { createHash, randomBytes, randomUUID } from "node:crypto";
import { classifyBearer, type PresentedCredentials } from "../acceptance";
import { createListenerBoundary } from "../authentication-context";
import { OperationError } from "../errors";
import { AgentTokenVerifier, type AgentCredentialRecord } from "./agent-token-verifier";
import { CompositeCredentialVerifier } from "./composite-credential-verifier";
import { InstallationVerifier, type InstallationPolicy } from "./installation-verifier";

export const NOW = Date.parse("2026-11-18T12:00:00.000Z");
export const iso = (time: number) => new Date(time).toISOString();
export const hash = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");
export const token = (prefix: "wts" | "wsi", id: string = randomUUID()) => `${prefix}_${id}_${randomBytes(32).toString("hex")}`;
export const presentedBearer = (secret: string): PresentedCredentials => ({
  bearers: [{ class: classifyBearer(secret), secret }], providerSession: null, legacySecret: false, browserHeaders: false,
});
export const none = (): PresentedCredentials => ({ bearers: [], providerSession: null, legacySecret: false, browserHeaders: false });
export const failure = (call: () => unknown): string => {
  try { call(); return "succeeded"; } catch (error) { return error instanceof OperationError ? `${error.category}:${error.reason}` : "unexpected_error"; }
};
export const INVALID = "unauthenticated:invalid_credential";
export const GONE = "unauthenticated:credential_no_longer_valid";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type MutableCredential = Mutable<Omit<AgentCredentialRecord, "principal">> & {
  principal: Mutable<AgentCredentialRecord["principal"]>;
  label: string;
  lastUsedAt: string | null;
  tokenPrefix: string;
};

export function agentWorld() {
  const id = randomUUID(), secret = token("wts", id);
  const row: MutableCredential = { id, principalId: "test-agent", kind: "agent_token", verifierHash: hash(secret), status: "active",
    expiresAt: iso(NOW + 1000), createdAt: iso(NOW - 1000), revokedAt: null,
    principal: { id: "test-agent", kind: "agent", status: "active" }, label: "Test", lastUsedAt: null, tokenPrefix: "unused" };
  const clock: { read: () => unknown } = { read: () => NOW };
  const reader: { read: (id: string) => unknown } = { read: key => key === id ? row : null };
  const agent = new AgentTokenVerifier({ reader: { credential: key => reader.read(key) as AgentCredentialRecord | null }, now: () => clock.read() as number });
  const composite = new CompositeCredentialVerifier({ installation: null, agent, providerSession: null });
  const boundary = createListenerBoundary({ mode: "better-auth", listener: "api", verifier: composite, open: () => true });
  return { row, secret, reader, clock, agent, composite, mint: (wire = secret) => boundary.mint(presentedBearer(wire)) };
}

export function installationWorld() {
  const id = randomUUID(), secret = token("wsi", id);
  const policy: Mutable<InstallationPolicy> = { mode: "token", generation: 7,
    token: { id, prefix: `wsi_${id}`, verifierHash: hash(secret), createdAt: iso(NOW) } };
  const reader: { read: () => unknown } = { read: () => policy };
  const policyReader = { getAuthenticationPolicy: () => reader.read() as InstallationPolicy };
  const installation = new InstallationVerifier({ mode: "token", reader: policyReader });
  const openInstallation = new InstallationVerifier({ mode: "open", reader: policyReader });
  const boundary = (mode: "open" | "token", verifier: InstallationVerifier) => createListenerBoundary({ mode, listener: "api",
    verifier: new CompositeCredentialVerifier({ installation: verifier, agent: null, providerSession: null }), open: () => true });
  const tokenBoundary = boundary("token", installation), openBoundary = boundary("open", openInstallation);
  return { policy, reader, secret, installation, openInstallation,
    mint: (wire = secret) => tokenBoundary.mint(presentedBearer(wire)), anonymous: () => openBoundary.mint(none()) };
}
