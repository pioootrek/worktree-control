import { describe, expect, it } from "vitest";

import type { BrowserCreationOptions, BrowserRequestOptions } from "@/shared/contracts/authentication";
import {
  base64UrlToBytes, bytesToBase64Url, serializeAssertion, serializeRegistration,
  toCredentialCreationOptions, toCredentialRequestOptions,
} from "./webauthn";

describe("base64url conversion", () => {
  it("round-trips arbitrary bytes without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 66]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...base64UrlToBytes(encoded)]).toEqual([...bytes]);
  });

  it("decodes padded lengths of one, two and three modulo four", () => {
    for (const bytes of [[1], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
      const source = new Uint8Array(bytes);
      expect([...base64UrlToBytes(bytesToBase64Url(source))]).toEqual(bytes);
    }
  });
});

const creationOptions: BrowserCreationOptions = {
  rp: { id: "switcher.localhost", name: "Worktree Control" },
  user: { id: "dXNlcg", name: "user@example.com", displayName: "User" },
  challenge: "Y2hhbGxlbmdl",
  pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
  timeout: 60_000,
  excludeCredentials: [{ id: "Y3JlZA", type: "public-key", transports: ["usb", "cable", "smart-card"] }],
  authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required", authenticatorAttachment: "platform" },
  attestation: "none",
  extensions: { credProps: true },
};

describe("toCredentialCreationOptions", () => {
  it("decodes binary fields and forces resident user-verified keys", () => {
    const converted = toCredentialCreationOptions(creationOptions);
    expect(new TextDecoder().decode(converted.challenge as ArrayBuffer)).toBe("challenge");
    expect(new TextDecoder().decode(converted.user.id as ArrayBuffer)).toBe("user");
    expect(converted.rp).toEqual({ id: "switcher.localhost", name: "Worktree Control" });
    expect(converted.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]);
    expect(converted.authenticatorSelection).toMatchObject({ residentKey: "required", requireResidentKey: true, userVerification: "required", authenticatorAttachment: "platform" });
    expect(converted.attestation).toBe("none");
    expect(converted.extensions).toEqual({ credProps: true });
  });

  it("keeps only transports the platform credential API accepts", () => {
    const converted = toCredentialCreationOptions(creationOptions);
    expect(converted.excludeCredentials?.[0]?.transports).toEqual(["usb"]);
  });
});

describe("toCredentialRequestOptions", () => {
  it("decodes the challenge and listed credentials", () => {
    const options: BrowserRequestOptions = {
      rpId: "switcher.localhost",
      challenge: "Y2hhbGxlbmdl",
      timeout: 30_000,
      allowCredentials: [{ id: "Y3JlZA", type: "public-key", transports: ["internal"] }],
      userVerification: "required",
    };
    const converted = toCredentialRequestOptions(options);
    expect(new TextDecoder().decode(converted.challenge as ArrayBuffer)).toBe("challenge");
    expect(converted.rpId).toBe("switcher.localhost");
    expect(converted.userVerification).toBe("required");
    expect(converted.allowCredentials).toHaveLength(1);
  });
});

function fakeCredential(response: object, overrides: object = {}): PublicKeyCredential {
  return {
    id: "Y3JlZA",
    rawId: new Uint8Array([99, 114, 101, 100]).buffer,
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({ credProps: { rk: true } }),
    response,
    ...overrides,
  } as unknown as PublicKeyCredential;
}

describe("serializeAssertion", () => {
  it("serializes every field as base64url and keeps only credProps", () => {
    const assertion = serializeAssertion(fakeCredential({
      clientDataJSON: new Uint8Array([1, 2, 3]).buffer,
      authenticatorData: new Uint8Array([4, 5]).buffer,
      signature: new Uint8Array([6]).buffer,
      userHandle: new Uint8Array([117, 115, 101, 114]).buffer,
    }));
    expect(assertion.response.userHandle).toBe("dXNlcg");
    expect(assertion.response.signature).toBe("Bg");
    expect(assertion.clientExtensionResults).toEqual({ credProps: { rk: true } });
    expect(assertion.authenticatorAttachment).toBe("platform");
  });

  it("refuses an assertion without a user handle instead of guessing one", () => {
    expect(() => serializeAssertion(fakeCredential({
      clientDataJSON: new Uint8Array([1]).buffer,
      authenticatorData: new Uint8Array([2]).buffer,
      signature: new Uint8Array([3]).buffer,
      userHandle: null,
    }))).toThrow(/user handle/);
  });
});

describe("serializeRegistration", () => {
  it("serializes the attestation response with optional fields", () => {
    const registration = serializeRegistration(fakeCredential({
      clientDataJSON: new Uint8Array([1]).buffer,
      attestationObject: new Uint8Array([2]).buffer,
      getTransports: () => ["internal"],
      getPublicKey: () => new Uint8Array([9]).buffer,
      getPublicKeyAlgorithm: () => -7,
      getAuthenticatorData: () => new Uint8Array([8]).buffer,
    }));
    expect(registration.response.attestationObject).toBe("Ag");
    expect(registration.response.transports).toEqual(["internal"]);
    expect(registration.response.publicKey).toBe("CQ");
    expect(registration.response.publicKeyAlgorithm).toBe(-7);
    expect(registration.response.authenticatorData).toBe("CA");
  });
});
