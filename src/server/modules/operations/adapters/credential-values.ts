import { z } from "zod";
import { absorb, isThenable } from "../synchronous";

/** A synchronous reader or clock answer only. Callers guard throws as well. */
export function settled<T>(value: T): T | null {
  if (isThenable(value)) { absorb(value); return null; }
  return value;
}

export const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const isTokenId = (value: unknown): value is string => typeof value === "string" && value.length === 36 && /^[0-9a-f-]{36}$/.test(value);
export const isVerifierHash = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);

// Stored policies and issuance inputs use UTC ISO datetimes, including valid
// values without millisecond digits. Do not silently repair malformed times.
const instant = z.iso.datetime();
export const isInstant = (value: unknown): value is string => instant.safeParse(value).success;
const uuid = z.uuid();
export const isInstallationTokenId = (value: unknown): value is string => uuid.safeParse(value).success;
