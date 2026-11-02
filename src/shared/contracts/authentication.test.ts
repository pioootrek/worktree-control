import { describe, expect, it } from "vitest";
import { base64UrlBytes, browserFactorSchemas, browserTotpVerifySchema, type BrowserWebAuthnBounds } from "./authentication";

const bounds: BrowserWebAuthnBounds = { credentialIdBytes: 2048, clientDataBytes: 2048, attestationBytes: 16_384, authenticatorDataBytes: 8192, publicKeyBytes: 2048,
  signatureBytes: 2048, userHandleBytes: 64, challengeBytes: 64, transports: 8, credentials: 16, responseBytes: 65_536 };
const schemas = browserFactorSchemas(bounds);
const encoded = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64url");
const assertion = (response: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ response: { id: "AAAA", rawId: "AAAA", type: "public-key", clientExtensionResults: {},
  response: { clientDataJSON: "AAAA", authenticatorData: "AAAA", signature: "AAAA", userHandle: "AAAA", ...response }, ...top } });
const registration = (response: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ response: { id: "AAAA", rawId: "AAAA", type: "public-key", clientExtensionResults: {},
  response: { clientDataJSON: "AAAA", attestationObject: "AAAA", ...response }, ...top } });

describe("canonical base64url", () => {
  it.each([["AA", 1], ["AAA", 2], ["AAAA", 3], ["_-_-", 3], [encoded(2048), 2048]])("measures %s", (value, bytes) => { expect(base64UrlBytes(value as string)).toBe(bytes); });
  it.each(["", "A", "AB", "AAB", "AA==", "AA+A", "AA/A", "AA A", "é"])("refuses %j", value => { expect(base64UrlBytes(value)).toBeNull(); });
  it("agrees with Node's own decoder and re-encoder", () => {
    for (let size = 1; size < 64; size++) {
      const value = encoded(size);
      expect(base64UrlBytes(value)).toBe(size);
      expect(Buffer.from(value, "base64url").toString("base64url")).toBe(value);
    }
  });
});

describe("closed WebAuthn requests", () => {
  it.each([
    ["clientDataJSON", 2048], ["authenticatorData", 8192], ["signature", 2048], ["userHandle", 64],
  ])("accepts %s at its exact decoded bound and refuses one byte more", (field, bytes) => {
    expect(schemas.assertion.safeParse(assertion({ [field]: encoded(bytes) })).success).toBe(true);
    expect(schemas.assertion.safeParse(assertion({ [field]: encoded(bytes + 1) })).success).toBe(false);
  });
  it.each([["attestationObject", 16_384], ["publicKey", 2048], ["authenticatorData", 8192]])("bounds registration %s exactly", (field, bytes) => {
    expect(schemas.registration.safeParse(registration({ [field]: encoded(bytes) })).success).toBe(true);
    expect(schemas.registration.safeParse(registration({ [field]: encoded(bytes + 1) })).success).toBe(false);
  });
  it("bounds the credential ID and requires id and rawId to be the same bytes", () => {
    const id = encoded(2048), over = encoded(2049);
    expect(schemas.assertion.safeParse(assertion({}, { id, rawId: id })).success).toBe(true);
    expect(schemas.assertion.safeParse(assertion({}, { id: over, rawId: over })).success).toBe(false);
    expect(schemas.assertion.safeParse(assertion({}, { rawId: "AAAB" })).success).toBe(false);
  });
  it("requires a user handle", () => {
    for (const userHandle of [null, undefined, ""]) expect(schemas.assertion.safeParse(assertion({ userHandle })).success).toBe(false);
  });
  it("accepts only distinct installed transports up to the bound", () => {
    const all = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"];
    expect(schemas.registration.safeParse(registration({ transports: all })).success).toBe(true);
    expect(schemas.registration.safeParse(registration({ transports: ["usb", "usb"] })).success).toBe(false);
    expect(schemas.registration.safeParse(registration({ transports: ["carrier-pigeon"] })).success).toBe(false);
    const narrow = browserFactorSchemas({ ...bounds, transports: 1 });
    expect(narrow.registration.safeParse(registration({ transports: ["usb", "nfc"] })).success).toBe(false);
  });
  it("accepts credProps and refuses any other extension, attachment or field", () => {
    expect(schemas.registration.safeParse(registration({}, { clientExtensionResults: { credProps: { rk: true } } })).success).toBe(true);
    expect(schemas.registration.safeParse(registration({}, { authenticatorAttachment: "platform" })).success).toBe(true);
    for (const top of [{ clientExtensionResults: { prf: { enabled: true } } }, { clientExtensionResults: { credProps: { rk: 1 } } }, { authenticatorAttachment: "other" }, { extra: 1 }, { clientExtensionResults: null }]) {
      expect(schemas.registration.safeParse(registration({}, top)).success).toBe(false);
    }
    for (const publicKeyAlgorithm of [1.5, Number.MAX_SAFE_INTEGER + 2, "7"]) expect(schemas.registration.safeParse(registration({ publicKeyAlgorithm })).success).toBe(false);
  });
  it("keeps exact TOTP digits, including leading zeros", () => {
    expect(browserTotpVerifySchema.parse({ code: "000123" })).toEqual({ code: "000123" });
    for (const code of ["٠١٢٣٤٥", "12345", "1234567", 123456]) expect(browserTotpVerifySchema.safeParse({ code }).success).toBe(false);
  });
});
