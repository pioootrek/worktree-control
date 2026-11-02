import { timingSafeEqual } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";

/**
 * Post-native TOTP step observer for an optional provider. It is not a
 * verifier: native verification stays necessary, and this code may only refuse
 * a success native already granted. Native returns a boolean and exposes neither
 * its matched step nor its clock sample, so a match here is a policy witness
 * inside a bounded interval, never a statement of what native matched.
 */

/** Pass this exact object to native `totpOptions` so both sides share one setting. */
export const TOTP_SETTINGS = Object.freeze({ period: 30, digits: 6 } as const);

const PERIOD_MS = TOTP_SETTINGS.period * 1000;
/** Native window of +/-1 around at most one observed period boundary: four counters. */
const MAX_STEP_SPAN = 3;
/** Native `generateRandomString` output. A `base32:` imported secret needs other bytes. */
const NATIVE_GENERATED_SECRET = /^[A-Za-z0-9_-]+$/;

export type TotpStepRefusal = "invalid_code" | "invalid_time" | "reversed_time" | "span_exceeded" | "no_match";
export type TotpStepBracket = { ok: true; lower: number; upper: number } | { ok: false; reason: TotpStepRefusal };
export type TotpStepObservation = { ok: true; step: number; matches: readonly number[] } | { ok: false; reason: TotpStepRefusal };
export interface TotpStepInput {
  /** Decoded with `readNativeTotpSecret`, so these are the bytes native verifies with. */
  secret: string;
  code: string;
  /** Sampled immediately before the native verification entry. */
  startedAt: number;
  /** Sampled after native returns, inside the same success transaction. */
  finishedAt: number;
}
type SecretKey = Parameters<typeof symmetricDecrypt>[0]["key"];

export const isTotpCode = (code: string): boolean => code.length === TOTP_SETTINGS.digits && !/[^0-9]/.test(code);

/**
 * Every counter the native window can reach while its clock sample stays between
 * the two observed instants. Clock movement that was never observed is outside
 * this claim: it can only lead to `no_match` or the guarded consumption failing.
 */
export function totpStepBracket(startedAt: number, finishedAt: number): TotpStepBracket {
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(finishedAt) || startedAt < 0) return { ok: false, reason: "invalid_time" };
  if (finishedAt < startedAt) return { ok: false, reason: "reversed_time" };
  const lower = Math.floor(startedAt / PERIOD_MS) - 1;
  const upper = Math.floor(finishedAt / PERIOD_MS) + 1;
  if (lower < 0 || !Number.isSafeInteger(lower) || !Number.isSafeInteger(upper)) return { ok: false, reason: "invalid_time" };
  if (upper < lower || upper - lower > MAX_STEP_SPAN) return { ok: false, reason: "span_exceeded" };
  return { ok: true, lower, upper };
}

/**
 * Evaluates at most four counters and never stops early. The caller consumes
 * `step`, the highest match, so one digit string cannot be spent twice inside a
 * window where it matches two counters.
 */
export async function observeTotpStep({ secret, code, startedAt, finishedAt }: TotpStepInput): Promise<TotpStepObservation> {
  if (!isTotpCode(code)) return { ok: false, reason: "invalid_code" };
  const bracket = totpStepBracket(startedAt, finishedAt);
  if (!bracket.ok) return bracket;
  const otp = createOTP(secret, TOTP_SETTINGS);
  const presented = Buffer.from(code, "ascii");
  const matches: number[] = [];
  for (let step = bracket.lower; step <= bracket.upper; step++) {
    if (timingSafeEqual(presented, Buffer.from(await otp.hotp(step), "ascii"))) matches.push(step);
  }
  const step = matches.at(-1);
  return step === undefined ? { ok: false, reason: "no_match" } : { ok: true, step, matches };
}

/**
 * Decrypts with the library's `secretConfig`, so versioned secrets keep working,
 * and refuses anything but native-generated text. Imported `base32:` values
 * decode to other bytes in native code and are unsupported here.
 */
export async function readNativeTotpSecret(key: SecretKey, ciphertext: string): Promise<string> {
  const secret = await symmetricDecrypt({ key, data: ciphertext });
  if (!NATIVE_GENERATED_SECRET.test(secret)) throw new Error("Unsupported TOTP secret encoding.");
  return secret;
}
