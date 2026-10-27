import { describe, expect, it } from "vitest";
import { clockSkew, grantState, proofTimestamp, requestState, vaultErrorCode, type VaultGrant, type VaultProfile, type VaultRequest } from "./vault-model";

const now = Date.parse("2026-10-27T12:00:00.000Z");
const profile: VaultProfile = { profileId: "p", revision: 2, createdAt: "2026-10-27T11:00:00.000Z", updatedAt: "2026-10-27T11:30:00.000Z" };
const request = (input: Partial<VaultRequest> = {}): VaultRequest => ({
  id: "r", agentId: "a", credentialId: "c", profileId: "p", revision: 2, permission: "read", status: "pending",
  createdAt: "2026-10-27T11:59:00.000Z", expiresAt: "2026-10-27T12:14:00.000Z", ...input,
});
const grant = (input: Partial<VaultGrant> = {}): VaultGrant => ({
  id: "g", requestId: "r", lifetime: "once", createdAt: "2026-10-27T11:59:30.000Z", expiresAt: "2026-10-28T11:59:30.000Z", revokedAt: null, consumedBy: null, ...input,
});

describe("DEV vault view model", () => {
  it("never presents an expired, stale or missing-profile request as approvable", () => {
    expect(requestState(request(), [profile], now)).toBe("pending");
    expect(requestState(request({ expiresAt: "2026-10-27T12:00:00.000Z" }), [profile], now)).toBe("expired");
    expect(requestState(request({ revision: 1 }), [profile], now)).toBe("stale");
    expect(requestState(request(), [], now)).toBe("missing_profile");
    expect(requestState(request({ status: "rejected" }), [profile], now)).toBe("rejected");
  });

  it("distinguishes used, expired, stale and applied grants from active ones", () => {
    expect(grantState(grant(), request(), [profile], now)).toBe("active");
    expect(grantState(grant({ consumedBy: "op" }), request(), [profile], now)).toBe("consumed");
    expect(grantState(grant({ lifetime: "15-minutes", consumedBy: "op" }), request(), [profile], now)).toBe("active");
    expect(grantState(grant({ expiresAt: "2026-10-27T11:59:59.000Z" }), request(), [profile], now)).toBe("expired");
    expect(grantState(grant({ lifetime: "until-revoked", expiresAt: null }), request({ revision: 1 }), [profile], now)).toBe("stale");
    expect(grantState(grant({ lifetime: "until-revoked", expiresAt: null }), request({ revision: 1, permission: "write" }), [profile], now)).toBe("stale");
  });

  it("requires recorded once consumption before reporting a write as applied", () => {
    const write = request({ revision: 1, permission: "write" });
    for (const lifetime of ["once", "15-minutes", "until-revoked"] as const) {
      expect(grantState(grant({ lifetime }), write, [profile], now)).toBe("stale");
    }
    expect(grantState(grant({ consumedBy: "successful-write" }), write, [profile], now)).toBe("applied");
  });

  it("maps only known server codes and dates proofs safely in the controller's past", () => {
    expect(vaultErrorCode("vault_conflict")).toBe("vault_conflict");
    expect(vaultErrorCode("SQLITE_BUSY: FAKE_DEV_VALUE")).toBe("vault_unavailable");
    expect(vaultErrorCode(undefined)).toBe("vault_unavailable");
    expect(clockSkew("Tue, 27 Oct 2026 12:00:00 GMT", now - 100, now + 100)).toBe(0);
    expect(clockSkew("Tue, 27 Oct 2026 11:59:00 GMT", now - 100, now + 100)).toBe(-59_500);
    expect(clockSkew(null, now, now)).toBe(0);
    expect(proofTimestamp(now, 0)).toBe("2026-10-27T11:59:59.000Z");
    expect(proofTimestamp(now, -59_500)).toBe("2026-10-27T11:58:59.500Z");
  });
});
