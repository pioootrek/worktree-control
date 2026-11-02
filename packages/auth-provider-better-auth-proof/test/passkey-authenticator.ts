import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { ORIGIN } from "./fixture";

/** Test authenticator only. Ephemeral keys never leave this object or reach disk. */
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest();
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
// Small independent test-data encoder, not a WebAuthn verifier or production protocol.
function cbor(value: number | string | Uint8Array | Map<number | string, unknown>): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([major * 32 + n])
    : n < 256 ? Buffer.from([major * 32 + 24, n]) : Buffer.from([major * 32 + 25, n >> 8, n & 255]);
  if (typeof value === "number") return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v as Parameters<typeof cbor>[0])])]);
}
export interface CeremonyOptions { challenge: string; user?: { id: string }; rp?: { id: string }; rpId?: string }
export interface AuthenticatorInput { uv?: boolean; up?: boolean; origin?: string; rp?: string; challenge?: string; counter?: number; userHandle?: string; tamper?: boolean; attestationNone?: boolean }
export class PasskeyAuthenticator {
  readonly #pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  readonly id = b64(randomBytes(32));
  #handle = "";
  #counter = 0;
  #data(options: CeremonyOptions, type: string, input: AuthenticatorInput) {
    return Buffer.from(JSON.stringify({ type, challenge: input.challenge ?? options.challenge, origin: input.origin ?? ORIGIN, crossOrigin: false }));
  }
  #authData(rp: string, flags: number, counter: number) {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    return Buffer.concat([hash(rp), Buffer.from([flags]), count]);
  }
  register(options: CeremonyOptions, input: AuthenticatorInput = {}) {
    this.#handle = options.user!.id;
    const key = this.#pair.publicKey.export({ format: "jwk" });
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(key.x!, "base64url")], [-3, Buffer.from(key.y!, "base64url")]]));
    const id = Buffer.from(this.id, "base64url"), size = Buffer.alloc(2); size.writeUInt16BE(id.length);
    const authData = Buffer.concat([this.#authData(input.rp ?? options.rp!.id, 64 | (input.up === false ? 0 : 1) | (input.uv === false ? 0 : 4), input.counter ?? 0), Buffer.alloc(16), size, id, cose]);
    const client = this.#data(options, "webauthn.create", input);
    const signature = sign("sha256", Buffer.concat([authData, hash(client)]), this.#pair.privateKey);
    if (input.tamper) signature[0] ^= 1;
    const attestation = cbor(new Map<string, unknown>([["fmt", input.attestationNone ? "none" : "packed"], ["authData", authData], ["attStmt", input.attestationNone ? new Map() : new Map<string, unknown>([["alg", -7], ["sig", signature]])]]));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64(client), attestationObject: b64(attestation), transports: ["internal"] }, clientExtensionResults: {} };
  }
  assert(options: CeremonyOptions, input: AuthenticatorInput = {}) {
    const client = this.#data(options, "webauthn.get", input);
    const authData = this.#authData(input.rp ?? options.rpId!, (input.up === false ? 0 : 1) | (input.uv === false ? 0 : 4), input.counter ?? ++this.#counter);
    const signature = sign("sha256", Buffer.concat([authData, hash(client)]), this.#pair.privateKey);
    if (input.tamper) signature[0] ^= 1;
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64(client), authenticatorData: b64(authData), signature: b64(signature), userHandle: input.userHandle ?? this.#handle }, clientExtensionResults: {} };
  }
}
