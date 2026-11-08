import type { BrowserCreationOptions, BrowserRequestOptions } from "@/shared/contracts/authentication";

/**
 * WebAuthn conversion between the closed base64url DTOs and the browser
 * credential API. Hand-rolled so the dashboard needs no new dependency; every
 * field is copied explicitly, never spread from an untrusted value.
 */
export function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Obsolete transports ("cable", "smart-card") are dropped: current DOM typings no longer accept them and authenticators ignore them. */
const TRANSPORTS = ["ble", "hybrid", "internal", "nfc", "usb"] as const;
type Transport = (typeof TRANSPORTS)[number];
function transportsOf(values: string[] | undefined): Transport[] | undefined {
  if (!values) return undefined;
  return values.filter((value): value is Transport => (TRANSPORTS as readonly string[]).includes(value));
}

function toDescriptor(descriptor: { id: string; type: "public-key"; transports?: string[] }): PublicKeyCredentialDescriptor {
  return { id: base64UrlToBytes(descriptor.id) as BufferSource, type: "public-key", ...(descriptor.transports ? { transports: transportsOf(descriptor.transports) } : {}) };
}

export function toCredentialCreationOptions(options: BrowserCreationOptions): PublicKeyCredentialCreationOptions {
  return {
    rp: { id: options.rp.id, name: options.rp.name },
    user: { id: base64UrlToBytes(options.user.id) as BufferSource, name: options.user.name, displayName: options.user.displayName },
    challenge: base64UrlToBytes(options.challenge) as BufferSource,
    pubKeyCredParams: options.pubKeyCredParams.map(parameter => ({ type: "public-key", alg: parameter.alg })),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    excludeCredentials: options.excludeCredentials.map(toDescriptor),
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
      ...(options.authenticatorSelection.authenticatorAttachment ? { authenticatorAttachment: options.authenticatorSelection.authenticatorAttachment } : {}),
    },
    attestation: "none",
    ...(options.extensions ? { extensions: { credProps: true } } : {}),
  };
}

export function toCredentialRequestOptions(options: BrowserRequestOptions): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToBytes(options.challenge) as BufferSource,
    rpId: options.rpId,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.allowCredentials ? { allowCredentials: options.allowCredentials.map(toDescriptor) } : {}),
    userVerification: "required",
  };
}

interface SerializedBase {
  id: string;
  rawId: string;
  type: "public-key";
  clientExtensionResults: { credProps?: { rk: boolean } };
  authenticatorAttachment?: "platform" | "cross-platform";
}
export interface SerializedRegistration extends SerializedBase {
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
    authenticatorData?: string;
    publicKey?: string;
    publicKeyAlgorithm?: number;
  };
}
export interface SerializedAssertion extends SerializedBase {
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
  };
}

function baseOf(credential: PublicKeyCredential): SerializedBase {
  const extensions = credential.getClientExtensionResults();
  const rk = extensions.credProps && typeof extensions.credProps.rk === "boolean" ? extensions.credProps.rk : undefined;
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: rk === undefined ? {} : { credProps: { rk } },
    ...(credential.authenticatorAttachment === "platform" || credential.authenticatorAttachment === "cross-platform"
      ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
}

export function serializeRegistration(credential: PublicKeyCredential): SerializedRegistration {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    ...baseOf(credential),
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject),
      ...(typeof response.getTransports === "function" ? { transports: response.getTransports() } : {}),
      ...(typeof response.getAuthenticatorData === "function" && response.getAuthenticatorData() ? { authenticatorData: bytesToBase64Url(response.getAuthenticatorData()) } : {}),
      ...(typeof response.getPublicKey === "function" && response.getPublicKey() ? { publicKey: bytesToBase64Url(response.getPublicKey()!) } : {}),
      ...(typeof response.getPublicKeyAlgorithm === "function" ? { publicKeyAlgorithm: response.getPublicKeyAlgorithm() } : {}),
    },
  };
}

export function serializeAssertion(credential: PublicKeyCredential): SerializedAssertion {
  const response = credential.response as AuthenticatorAssertionResponse;
  if (!response.userHandle) throw new Error("The authenticator returned no user handle.");
  return {
    ...baseOf(credential),
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      signature: bytesToBase64Url(response.signature),
      userHandle: bytesToBase64Url(response.userHandle),
    },
  };
}

/** Passkeys are only offered with a real platform API on a secure origin. */
export function webAuthnAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true
    && typeof navigator.credentials?.create === "function" && typeof navigator.credentials?.get === "function"
    && typeof window.PublicKeyCredential === "function";
}
