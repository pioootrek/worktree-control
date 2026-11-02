import { z } from "zod";

/** Public browser DTOs. Private CLI status and provider-native records stay server-only. */
export interface BrowserAuthenticationStatus { mode: "legacy" | "open" | "token" | "better-auth"; loginAvailable: boolean }
export type BrowserSession = { authenticated: false } | {
  authenticated: true;
  principal: { id: string; kind: "owner" | "human" };
  expiresAt: string;
  /** What the session proved. Authentication strength never grants authority. */
  authentication: { method: "password"; factors: 1 } | { method: "password_totp"; factors: 2 } | { method: "passkey_uv"; factors: 2 };
};
export const browserSignInSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict();
export const browserSignOutSchema = z.object({}).strict();
export const browserChangePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256) }).strict();
export const browserTotpEnableSchema = z.object({ password: z.string().min(1).max(256) }).strict();
/** Exact ASCII digits. Leading zeros survive; nothing is trimmed or normalized. */
export const browserTotpVerifySchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict();

/**
 * Explicit WebAuthn field bounds. Nothing here has a default: the caller supplies
 * them with its factor limits, and they are decoded byte counts unless named.
 */
export interface BrowserWebAuthnBounds {
  credentialIdBytes: number;
  clientDataBytes: number;
  attestationBytes: number;
  authenticatorDataBytes: number;
  publicKeyBytes: number;
  signatureBytes: number;
  userHandleBytes: number;
  challengeBytes: number;
  transports: number;
  /** Listed credentials in one set of generated options. */
  credentials: number;
  /** Serialized UTF-8 size of any provider result or safe response. */
  responseBytes: number;
}

/** Decoded size of canonical unpadded base64url, or null. Needs no Node API and allocates nothing. */
export function base64UrlBytes(value: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const tail = value.length % 4;
  if (tail) {
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(value[value.length - 1]!);
    // Unused trailing bits must be zero, or two strings would decode to the same bytes.
    if (last & (tail === 2 ? 0b1111 : 0b11)) return null;
  }
  return Math.floor(value.length * 3 / 4);
}
const base64Url = (bytes: number) => z.string().max(Math.ceil(bytes * 4 / 3)).refine(value => {
  const decoded = base64UrlBytes(value);
  return decoded !== null && decoded >= 1 && decoded <= bytes;
});

/** The installed SimpleWebAuthn 13.3.3 `AuthenticatorTransportFuture` union. */
const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
const label = z.string().min(1).max(256);

/** Closed request bodies and generated-option shapes for one explicit set of bounds. */
export function browserFactorSchemas(bounds: BrowserWebAuthnBounds) {
  const transports = z.array(z.enum(TRANSPORTS)).max(bounds.transports).refine(values => new Set(values).size === values.length);
  // No extension is requested except the pinned library's credProps, which grants nothing.
  const extensionResults = z.object({ credProps: z.object({ rk: z.boolean() }).strict().optional() }).strict();
  const credential = {
    id: base64Url(bounds.credentialIdBytes), rawId: base64Url(bounds.credentialIdBytes), type: z.literal("public-key"),
    clientExtensionResults: extensionResults, authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  };
  // Canonical encodings, so equal strings are exactly equal bytes.
  const sameIdentity = (value: { id: string; rawId: string }) => value.id === value.rawId;
  const registration = z.object({ ...credential, response: z.object({
    clientDataJSON: base64Url(bounds.clientDataBytes), attestationObject: base64Url(bounds.attestationBytes), transports: transports.optional(),
    authenticatorData: base64Url(bounds.authenticatorDataBytes).optional(), publicKey: base64Url(bounds.publicKeyBytes).optional(),
    publicKeyAlgorithm: z.number().int().refine(Number.isSafeInteger).optional(),
  }).strict() }).strict().refine(sameIdentity);
  // A missing or null user handle refuses: trust binds the handle that was issued.
  const assertion = z.object({ ...credential, response: z.object({
    clientDataJSON: base64Url(bounds.clientDataBytes), authenticatorData: base64Url(bounds.authenticatorDataBytes),
    signature: base64Url(bounds.signatureBytes), userHandle: base64Url(bounds.userHandleBytes),
  }).strict() }).strict().refine(sameIdentity);
  const listed = z.object({ id: base64Url(bounds.credentialIdBytes), type: z.literal("public-key"), transports: transports.optional() }).strict();
  return {
    registration: z.object({ response: registration }).strict(),
    assertion: z.object({ response: assertion }).strict(),
    creationOptions: z.object({
      rp: z.object({ id: label, name: label }).strict(),
      user: z.object({ id: base64Url(bounds.userHandleBytes), name: label, displayName: label }).strict(),
      challenge: base64Url(bounds.challengeBytes),
      pubKeyCredParams: z.array(z.object({ type: z.literal("public-key"), alg: z.number().int() }).strict()).min(1).max(8),
      timeout: z.number().int().positive().optional(),
      excludeCredentials: z.array(listed).max(bounds.credentials),
      authenticatorSelection: z.object({
        residentKey: z.literal("required"), requireResidentKey: z.literal(true), userVerification: z.literal("required"),
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
      }).strict(),
      attestation: z.literal("none"),
      extensions: z.object({ credProps: z.literal(true) }).strict().optional(),
    }).strict(),
    requestOptions: z.object({
      challenge: base64Url(bounds.challengeBytes), rpId: label, timeout: z.number().int().positive().optional(),
      allowCredentials: z.array(listed).max(bounds.credentials).optional(), userVerification: z.literal("required"),
    }).strict(),
  };
}
export type BrowserCreationOptions = z.infer<ReturnType<typeof browserFactorSchemas>["creationOptions"]>;
export type BrowserRequestOptions = z.infer<ReturnType<typeof browserFactorSchemas>["requestOptions"]>;
/** Every safe success a factor or password route can return. A cookie is never in here. */
export type BrowserFactorResult =
  | { authenticated: true }
  | { authenticated: false; outcome: "challenge"; method: "totp" }
  | { outcome: "enrollment"; totpURI: string; authorizing: false }
  | { outcome: "enrolled"; authorizing: false }
  | { outcome: "staged"; authorizing: false }
  | { outcome: "options"; options: BrowserCreationOptions | BrowserRequestOptions };

/** Provider cookies never identify an installation caller on unconverted transports. */
export function containsProviderCookie(cookie: string | undefined): boolean {
  return /(?:^|;\s*)(?:__Secure-)?wtc\.[^=;]+=/i.test(cookie ?? "");
}
