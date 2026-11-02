import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricEncrypt } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTotpCode, observeTotpStep, readNativeTotpSecret, TOTP_SETTINGS, totpStepBracket } from "../src/totp-step";

const counted = vi.hoisted(() => ({ hotp: [] as number[] }));
vi.mock("@better-auth/utils/otp", async original => {
  const actual = await original<typeof import("@better-auth/utils/otp")>();
  return { ...actual, createOTP: ((secret, options) => {
    const otp = actual.createOTP(secret, options);
    return { ...otp, hotp: counter => { counted.hotp.push(counter); return otp.hotp(counter); } };
  }) as typeof actual.createOTP };
});

/** Public RFC 4226 Appendix D key, ASCII, as used by the RFC 6238 SHA-1 vectors. */
const RFC_KEY = "12345678901234567890";
const PERIOD_MS = 30_000;
/** Independent of the code under test and of the library. */
const clientHotp = (counter: number) => {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", RFC_KEY).update(message).digest();
  return String((hash.readUInt32BE(hash[hash.length - 1]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
};
const atStep = (step: number, offset = 5_000) => step * PERIOD_MS + offset;
const observe = (code: string, startedAt: number, finishedAt = startedAt) => observeTotpStep({ secret: RFC_KEY, code, startedAt, finishedAt });

afterEach(() => { counted.hotp.length = 0; });

describe("A3-I17 reusable TOTP step helper", () => {
  it("pins the exact settings the native plugin receives", () => {
    expect(TOTP_SETTINGS).toEqual({ period: 30, digits: 6 });
    expect(Object.isFrozen(TOTP_SETTINGS)).toBe(true);
  });

  it("reaches the provider only through its ceremonies; importing the package activates nothing", () => {
    expect(readFileSync(new URL("../src/factor-ceremonies.ts", import.meta.url), "utf8").includes("totp-step")).toBe(true);
  });

  it.each([[1, "287082"], [2, "359152"], [3, "969429"], [4, "338314"], [5, "254676"], [6, "287922"], [7, "162583"], [8, "399871"], [9, "520489"]])("finds the RFC 4226 vector at counter %i", async (counter, code) => {
    expect(clientHotp(counter)).toBe(code);
    expect(await observe(code, atStep(counter))).toEqual({ ok: true, step: counter, matches: [counter] });
  });

  it.each([-1, 0, 1])("covers the %i native window step at the 29.999 boundary and one millisecond later", async offset => {
    const step = 59_788_416, last = step * PERIOD_MS + 29_999;
    expect((await observe(clientHotp(step + offset), last)).ok).toBe(true);
    const next = await observe(clientHotp(step + 1 + offset), last + 1);
    expect(next).toMatchObject({ ok: true, step: step + 1 + offset });
  });

  it("uses exactly the observed interval, with three counters in one period and four across one boundary", () => {
    expect(totpStepBracket(atStep(100), atStep(100, 29_999))).toEqual({ ok: true, lower: 99, upper: 101 });
    expect(totpStepBracket(atStep(100), atStep(101))).toEqual({ ok: true, lower: 99, upper: 102 });
    expect(totpStepBracket(atStep(100), atStep(102))).toEqual({ ok: false, reason: "span_exceeded" });
  });

  it("never enumerates more than four counters and enumerates none for a refused interval", async () => {
    await observe("000000", atStep(100));
    expect(counted.hotp).toEqual([99, 100, 101]);
    counted.hotp.length = 0;
    await observe("000000", atStep(100), atStep(101));
    expect(counted.hotp).toEqual([99, 100, 101, 102]);
    counted.hotp.length = 0;
    expect(await observe("000000", atStep(100), atStep(1_000_000))).toEqual({ ok: false, reason: "span_exceeded" });
    expect(await observe("000000", atStep(100), Number.MAX_SAFE_INTEGER)).toEqual({ ok: false, reason: "span_exceeded" });
    expect(counted.hotp).toEqual([]);
  });

  it.each([
    ["NaN start", Number.NaN, atStep(100), "invalid_time"],
    ["NaN finish", atStep(100), Number.NaN, "invalid_time"],
    ["infinite finish", atStep(100), Number.POSITIVE_INFINITY, "invalid_time"],
    ["negative infinity", Number.NEGATIVE_INFINITY, atStep(100), "invalid_time"],
    ["unsafe start", 2 ** 53, 2 ** 53, "invalid_time"],
    ["unsafe finish", atStep(100), 2 ** 53, "invalid_time"],
    ["fractional start", atStep(100) + 0.5, atStep(100) + 1, "invalid_time"],
    ["negative time", -1, 0, "invalid_time"],
    ["negative counter from the first period", 1_000, 1_000, "invalid_time"],
    ["reversal inside one period", atStep(100, 5_000), atStep(100, 4_999), "reversed_time"],
    ["reversal across a period", atStep(100), atStep(99), "reversed_time"],
  ] as const)("refuses %s", async (_name, startedAt, finishedAt, reason) => {
    expect(totpStepBracket(startedAt, finishedAt)).toEqual({ ok: false, reason });
    expect(await observe(clientHotp(100), startedAt, finishedAt)).toEqual({ ok: false, reason });
    expect(counted.hotp).toEqual([]);
  });

  it("refuses an empty observation rather than guessing a step", async () => {
    const outside = clientHotp(103);
    expect([99, 100, 101].map(clientHotp)).not.toContain(outside);
    expect(await observe(outside, atStep(100))).toEqual({ ok: false, reason: "no_match" });
  });

  it.each(["", "12345", "1234567", " 123456", "123456\n", "１２３４５６", "١٢٣٤٥٦", "12e345", "12\u0000345"])("refuses non-exact digit input case %# without evaluating", async code => {
    expect(isTotpCode(code)).toBe(false);
    expect(await observe(code, atStep(100))).toEqual({ ok: false, reason: "invalid_code" });
    expect(counted.hotp).toEqual([]);
  });

  it("preserves leading zeros as fixed ASCII digits", async () => {
    let counter = 59_788_416;
    while (!clientHotp(counter).startsWith("0")) counter++;
    const code = clientHotp(counter);
    expect(await observe(code, atStep(counter))).toMatchObject({ ok: true, step: counter });
    expect(await observe(String(Number(code)), atStep(counter))).toEqual({ ok: false, reason: "invalid_code" });
  });

  it("keeps evaluating after a match: both counters of one digit string are observed and the highest is the step", async () => {
    // Found by scanning this public key. 61331809 and 61331811 fit one native window.
    expect(clientHotp(61_331_809)).toBe("768734"); expect(clientHotp(61_331_811)).toBe("768734");
    expect(await observe("768734", atStep(61_331_810))).toEqual({ ok: true, step: 61_331_811, matches: [61_331_809, 61_331_811] });
    expect(counted.hotp).toEqual([61_331_809, 61_331_810, 61_331_811]);
  });

  it("sees both ends of a gap-three collision only when the observed call crossed a boundary", async () => {
    expect(clientHotp(60_138_748)).toBe("217436"); expect(clientHotp(60_138_751)).toBe("217436");
    expect(await observe("217436", atStep(60_138_749), atStep(60_138_750))).toEqual({ ok: true, step: 60_138_751, matches: [60_138_748, 60_138_751] });
    expect(await observe("217436", atStep(60_138_750))).toEqual({ ok: true, step: 60_138_751, matches: [60_138_751] });
  });

  it("a later equal decimal string is a different counter, not the same one", async () => {
    expect(clientHotp(59_788_416)).toBe("393421"); expect(clientHotp(59_788_440)).toBe("393421");
    expect(await observe("393421", atStep(59_788_416))).toMatchObject({ step: 59_788_416 });
    expect(await observe("393421", atStep(59_788_440))).toMatchObject({ step: 59_788_440 });
  });

  it.each([-1, 0, 1])("agrees with the native utility wherever its clock sample stays inside the interval (offset %i)", async offset => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const time = atStep(59_788_416);
      vi.setSystemTime(time);
      const code = clientHotp(59_788_416 + offset);
      expect(await createOTP(RFC_KEY, TOTP_SETTINGS).verify(code)).toBe(true);
      expect((await observe(code, time)).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  describe("native secret decoding", () => {
    const secret = "AbC-dEf_0123456789abcdefghijklmn";
    it("reads a plain native secret with the library secret string", async () => {
      expect(await readNativeTotpSecret("fixture-secret", await symmetricEncrypt({ key: "fixture-secret", data: secret }))).toBe(secret);
    });
    it("reads a versioned envelope with a versioned secret configuration, including a retired current version", async () => {
      const current = { keys: new Map([[1, "old-secret"], [2, "new-secret"]]), currentVersion: 2, legacySecret: undefined };
      const encrypted = await symmetricEncrypt({ key: { ...current, currentVersion: 1 }, data: secret });
      expect(encrypted.startsWith("$ba$1$")).toBe(true);
      expect(await readNativeTotpSecret(current, encrypted)).toBe(secret);
    });
    it.each(["base32:GEZDGNBV", "with space", "line\nbreak", "non-ascii-é", ""])("refuses an unsupported secret encoding without echoing it (%#)", async value => {
      const data = await symmetricEncrypt({ key: "fixture-secret", data: value });
      await expect(readNativeTotpSecret("fixture-secret", data)).rejects.toThrow("Unsupported TOTP secret encoding.");
    });
    it("fails closed on a wrong key", async () => {
      const data = await symmetricEncrypt({ key: "fixture-secret", data: secret });
      await expect(readNativeTotpSecret("another-secret", data)).rejects.toThrow();
    });
  });
});
