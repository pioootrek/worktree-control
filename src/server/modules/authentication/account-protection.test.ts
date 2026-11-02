import { describe, expect, it } from "vitest";
import { evaluateSessionAuthority, validateFactorLimits, type ProviderSessionState } from "./account-protection";

const now = "2026-11-02T12:00:00.000Z";
const state = (change: { [K in keyof ProviderSessionState]?: unknown } = {}, evidence: Record<string, unknown> = {}, account: Record<string, unknown> = {}) => ({
  subject: "s", principalId: "p", createdAt: "2026-11-02T11:00:00.000Z", expiresAt: "2026-11-02T19:00:00.000Z",
  evidence: { sessionId: "x", subject: "s", method: "password", authenticatedAt: "2026-11-02T11:00:00.000Z", originalDeadline: "2026-11-02T18:00:00.000Z",
    generation: 2, policyRevision: 3, credential: null, credentialBinding: null, attemptId: "a", ...evidence },
  account: { generation: 2, policyRevision: 3, totpSelected: false, passkeySelected: false, consistent: true, ...account },
  currentBinding: null, ...change,
}) as ProviderSessionState;
const totp = { method: "password_totp", credential: "f", credentialBinding: "b" };
const passkey = { method: "passkey_uv", credential: "c", credentialBinding: "b" };

describe("evaluateSessionAuthority", () => {
  it("reports what the evidence proved and caps at the original deadline", () => {
    expect(evaluateSessionAuthority(state(), now)).toMatchObject({ authentication: { method: "password", factors: 1 }, deadline: "2026-11-02T18:00:00.000Z" });
    expect(evaluateSessionAuthority(state({ currentBinding: "b" }, totp, { totpSelected: true }), now)?.authentication).toEqual({ method: "password_totp", factors: 2 });
    expect(evaluateSessionAuthority(state({ currentBinding: "b" }, passkey, { passkeySelected: true, totpSelected: true }), now)?.authentication).toEqual({ method: "passkey_uv", factors: 2 });
    expect(evaluateSessionAuthority(state({ expiresAt: "2026-11-02T13:00:00.000Z" }), now)?.deadline).toBe("2026-11-02T13:00:00.000Z");
  });

  it.each<[string, ProviderSessionState]>([
    ["missing evidence", state({ evidence: null })],
    ["missing account", state({ account: null })],
    ["inconsistent account", state({}, {}, { consistent: false })],
    ["other subject", state({}, { subject: "t" })],
    ["stale generation", state({}, { generation: 1 })],
    ["stale policy", state({}, { policyRevision: 2 })],
    ["password after TOTP selection", state({}, {}, { totpSelected: true })],
    ["password after passkey selection", state({}, {}, { passkeySelected: true })],
    ["unselected TOTP evidence", state({ currentBinding: "b" }, totp)],
    ["unselected passkey evidence", state({ currentBinding: "b" }, passkey, { totpSelected: true })],
    ["changed credential", state({ currentBinding: "other" }, totp, { totpSelected: true })],
    ["removed credential", state({ currentBinding: null }, totp, { totpSelected: true })],
    ["binding on password evidence", state({}, { credentialBinding: "b" })],
    ["expired deadline", state({}, { originalDeadline: now })],
    ["expired native row", state({ expiresAt: now })],
    ["future authentication", state({}, { authenticatedAt: "2026-11-02T12:00:00.001Z" })],
    ["future session", state({ createdAt: "2026-11-02T12:00:00.001Z" })],
    ["inverted evidence", state({}, { authenticatedAt: "2026-11-02T18:00:00.000Z" })],
    ["malformed date", state({}, { originalDeadline: "2026-11-02" })],
    ["unknown method", state({ currentBinding: "b" }, { method: "recovery_code", credential: "c", credentialBinding: "b" }, { passkeySelected: true })],
  ])("refuses %s", (_, input) => { expect(evaluateSessionAuthority(input, now)).toBeNull(); });
  it("refuses a malformed clock", () => { expect(evaluateSessionAuthority(state(), "now")).toBeNull(); });
});

describe("validateFactorLimits", () => {
  const limits = { totp: { attempts: 1, windowMs: 1 }, passkey: { attempts: 1, windowMs: 1 }, ticketMs: 1, stagingMs: 1, capacity: 2, pruneBatch: 1,
    issuance: { perPeer: { attempts: 1, windowMs: 1 }, global: { attempts: 1, windowMs: 1 }, peers: 1, nativeChallenges: 2, reservedContexts: 1 },
    webauthn: { credentialIdBytes: 1, clientDataBytes: 1, attestationBytes: 1, authenticatorDataBytes: 1, publicKeyBytes: 1, signatureBytes: 1, userHandleBytes: 1, challengeBytes: 1, transports: 1, credentials: 1, responseBytes: 1 } };
  it("freezes valid limits without changing them", () => {
    const valid = validateFactorLimits(limits);
    expect(valid).toEqual(limits);
    expect(Object.isFrozen(valid.totp)).toBe(true);
  });
  it.each([undefined, {}, { ...limits, capacity: 0 }, { ...limits, ticketMs: 1.5 }, { ...limits, stagingMs: -1 }, { ...limits, totp: { attempts: 1 } },
    { ...limits, issuance: undefined }, { ...limits, webauthn: undefined }, { ...limits, webauthn: { ...limits.webauthn, responseBytes: 0 } },
    { ...limits, issuance: { ...limits.issuance, peers: 0 } }, { ...limits, issuance: { ...limits.issuance, global: { attempts: 1 } } },
    // Reservation must leave capacity to reserve from, or anonymous options could never run.
    { ...limits, issuance: { ...limits.issuance, reservedContexts: 2 } },
    { ...limits, issuance: { ...limits.issuance, reservedContexts: 0 } }])("has no defaults for %j", value => {
    expect(() => validateFactorLimits(value)).toThrow("Invalid factor limits.");
  });
});
